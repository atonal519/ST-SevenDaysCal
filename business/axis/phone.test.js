import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLedgerDate, ledgerDaysSince, ledgerDueInfo } from '../ledger/date.js';
import { bindLedgerSelect, selectLedgerForInject } from '../ledger/select.js';
import { daysBetweenCalendarDates } from './full-ordinal.js';
import { getChatRoot, registerChatStorageContext } from '../../runtime/chat-storage.js';

const { createPhoneCalendarApi, createPhoneCalendarSource } = await import('./phone.js').catch(() => ({}));
const gregorian = { kind: 'gregorian', id: 'default-gregorian', months: [31,29,31,30,31,30,31,31,30,31,30,31].map((days, i) => ({ name: `${i + 1}月`, days })) };
function fixture({ today = { year: 2026, month: 12, day: 30, weekday: 3 }, calendar = gregorian, items = [], ledgerEntries = [], ledgerCutoff = { floor: 5, date: today } } = {}) {
  assert.equal(typeof createPhoneCalendarApi, 'function', '只读 Calendar 接口尚未实现');
  const source = structuredClone({ today, calendar, items, ledgerEntries, ledgerCutoff }), before = JSON.stringify(source);
  const ordinal = date => calendar.months.slice(0, date.month - 1).reduce((sum, item) => sum + item.days, date.day);
  bindLedgerDate({ daysUntil: (month, day, anchor) => { const length = calendar.months.reduce((sum, item) => sum + item.days, 0); return (ordinal({ month, day }) - ordinal(anchor) + length) % length; }, daysUntilFull: (from, to) => daysBetweenCalendarDates(from, to, calendar) });
  bindLedgerSelect({ ledgerDaysSince, ledgerDueInfo });
  const api = createPhoneCalendarApi({ read: () => source,
    selectSchedules: (entries, query, cutoff) => selectLedgerForInject(entries, query, cutoff.date, undefined, cutoff.floor),
    dueInfo: (entry, cutoff) => ledgerDueInfo(entry, cutoff.date, cutoff.floor),
    daysSince: (entry, cutoff) => ledgerDaysSince(entry, cutoff.date, cutoff.floor),
  });
  return { api, source, unchanged: () => assert.equal(JSON.stringify(source), before) };
}

test('phone month respects leap years and source weekday, projecting all four annual date types', () => {
  for (const [year, days] of [[2025, 28], [2024, 29]]) {
    const h = fixture({ today: { year, month: 2, day: 1, weekday: 1 }, items: [
      { id: 'a', name: '相识纪念日', type: 'anniversary', month: 2, day: 2, days: 1, note: '一起逛过书店', pin: true, source: 'user' },
      { id: 'b', name: '其他内容', type: 'custom', month: 2, day: 2 },
      { id: 'c', name: '生日', type: 'birthday', month: 2, day: 2 },
    ] });
    const month = h.api.getPhoneCalendar();
    assert.equal(month.days.length, days);
    assert.equal(month.leading, 0, '记录中的周一优先于现实公历');
    assert.deepEqual(month.days[1].items.map(item => item.name), ['相识纪念日', '其他内容', '生日']);
    assert.equal('pin' in month.days[1].items[0], false);
    month.days[1].items[0].note = '只改返回值';
    h.unchanged();
  }
});

test('year-end holidays and ongoing multi-day events remain eligible without including unrelated far dates', () => {
  const h = fixture({ today: { year: 2026, month: 12, day: 31, weekday: 4 }, items: [
    { id: 'new', name: '新年', type: 'festival', month: 1, day: 1, days: 3 },
    { id: 'old', name: '冬日节', type: 'festival', month: 12, day: 30, days: 3 },
    { id: 'far', name: '丰收节', type: 'festival', month: 9, day: 1, days: 1 },
  ] });
  const context = h.api.getPhoneCalendarContext();
  assert.deepEqual(context.events.map(item => item.name), ['冬日节', '新年']);
  assert.equal(context.events[0].when, '进行中');
  assert.equal(context.events[1].when, '1天后');
  assert.ok(h.api.getPhoneCalendarContext({ query: '丰收节是什么时候？' }).events.some(item => item.name === '丰收节'));
  const next = h.api.getPhoneCalendar({ monthOffset: 1 });
  assert.equal(next.year, 2027);
  assert.equal(next.month, 1);
  assert.deepEqual(next.days[0].items.map(item => item.name), ['新年', '冬日节']);
  h.unchanged();
});

test('custom months and multi-day holidays are displayed using their own calendar', () => {
  const h = fixture({ today: { year: 1686, month: 1, day: 19, weekday: 2 }, calendar: { kind: 'custom', title: '王国历', months: [{ name: '雪月', days: 20 }, { name: '芽月', days: 25 }] }, items: [
    { id: 'spring', name: '迎春节', type: 'festival', month: 1, day: 20, days: 3 },
  ] });
  const next = h.api.getPhoneCalendar({ monthOffset: 1 });
  assert.equal(next.monthName, '芽月');
  assert.equal(next.days.length, 25);
  assert.equal(next.days[1].items[0].name, '迎春节');
  assert.equal(next.days[2].items.length, 0);
  assert.equal(h.api.getPhoneCalendarContext().events[0].when, '1天后');
  h.unchanged();
});

test('missing data stays empty and an unknown story date does not invent a real-time countdown', () => {
  assert.equal(typeof createPhoneCalendarApi, 'function');
  const absent = createPhoneCalendarApi({ read: () => null });
  assert.equal(absent.getPhoneCalendar(), null);
  assert.equal(absent.getPhoneCalendarContext(), null);
  const h = fixture({ today: null, items: [{ id: 'x', name: '相识纪念日', type: 'anniversary', month: 3, day: 2 }] });
  assert.equal(h.api.getPhoneCalendar().today, '');
  assert.equal(h.api.getPhoneCalendarContext(), null);
  const explicit = h.api.getPhoneCalendarContext({ query: '相识纪念日是哪天' });
  assert.equal(explicit.events[0].when, '');
  h.unchanged();
});

test('a month/day pin preserves the known year only when it matches the current story date', () => {
  assert.equal(typeof createPhoneCalendarSource, 'function');
  let pinned = { month: 2, day: 1 };
  const source = createPhoneCalendarSource({
    enabled: () => true, context: () => ({ chat: [{ is_user: false, mes: '本楼' }] }),
    calendar: () => gregorian, items: () => [], anchor: () => pinned, calibration: () => null,
    parseClock: () => ({ endMeta: { valid: true, date: { year: 2025, month: 2, day: 1, eraLabel: '城历' }, month: 2, day: 1, weekdayIndex: 1 } }),
  });
  const api = createPhoneCalendarApi({ read: source });
  assert.equal(api.getPhoneCalendar().year, 2025);
  assert.equal(api.getPhoneCalendar().days.length, 28);
  assert.equal(api.getPhoneCalendar().eraLabel, '城历');
  assert.equal(api.getPhoneCalendar().yearLabel, '城历2025年');
  assert.equal(api.getPhoneCalendar().days[0].label, '城历2025年2月1日');
  pinned = { month: 3, day: 1 };
  assert.equal(api.getPhoneCalendar().year, null);
  assert.deepEqual(api.getPhoneCalendar().weekdays, []);
});

test('unknown-year month navigation carries an explicit weekday across the year boundary', () => {
  const h = fixture({ today: { month: 12, day: 31, weekday: 4 } });
  const next = h.api.getPhoneCalendar({ monthOffset: 1 });
  assert.equal(next.year, null);
  assert.equal(next.leading, 4, '12月31日周四之后，1月1日应是周五');
});

test('a known-year pin and matching yearless story stamp use one consistent weekday calendar', () => {
  const source = createPhoneCalendarSource({
    enabled: () => true, context: () => ({ chat: [{ is_user: false, mes: '本楼' }] }), calendar: () => gregorian, items: () => [],
    anchor: () => ({ year: 2026, month: 12, day: 31 }), calibration: () => null,
    parseClock: () => ({ endMeta: { valid: true, date: { month: 12, day: 31 }, month: 12, day: 31, weekdayIndex: 4 } }),
  });
  assert.equal(createPhoneCalendarApi({ read: source }).getPhoneCalendar().leading, 1);
});

const schedule = (id, patch = {}) => ({ id, 事由: `约定${id}`, 类型: '约定待办', 状态: '活跃', 现状: '已约定，尚无新观察。', 静音: false,
  起始锚: { 楼层: 1, 历日期: { year: 2026, month: 12, day: 28 }, 来源指纹: 'source-1' },
  现状锚: { 楼层: 3, 历日期: { year: 2026, month: 12, day: 29 } },
  到期锚: { 楼层: 1, 历日期: { year: 2026, month: 12, day: 31 } }, 牵扯: ['甲'], 标签: [], 周期长度: null, ...patch });

test('schedules filter source validity, settled/muted entries and both cutoff anchors before selecting even locked records', () => {
  const h = fixture({ ledgerEntries: [schedule('ok'),
    schedule('settled', { 状态: '已了结', 锁: '用户锁' }), schedule('muted', { 静音: true, 锁: '用户锁' }),
    schedule('pending', { 来源状态: '待确认', 锁: '用户锁' }), schedule('deleted', { 来源状态: '来源已删除', 锁: '用户锁' }),
    schedule('future-start', { 起始锚: { 楼层: 6 }, 锁: '用户锁' }), schedule('future-state', { 现状锚: { 楼层: 6 }, 锁: '用户锁' }),
    schedule('far', { 到期锚: { 历日期: { year: 2027, month: 5, day: 1 } } }),
  ] });
  const context = h.api.getPhoneCalendarContext({ includeSchedules: true });
  assert.deepEqual(context?.schedules?.map(row => row.id), ['ok']);
  assert.deepEqual(context.scheduleAsOf, { floor: 5, date: { year: 2026, month: 12, day: 30, weekday: 3 } });
  assert.deepEqual(context.schedules[0].dueInfo, { days: 1, overdue: false });
  assert.deepEqual(context.schedules[0].relatedPeople, ['甲']);
  assert.equal('knownToIds' in context.schedules[0], false);
  context.scheduleAsOf.date.day = 1; context.schedules[0].relatedPeople.push('乙'); context.schedules[0].startedAt.date.day = 1;
  h.unchanged();
});

test('schedule due values use the ledger cutoff date and preserve full-year overdue, unknown one-time and anchored cycles', () => {
  const cutoff = { floor: 3, date: { year: 2026, month: 12, day: 30 } };
  const h = fixture({ today: { year: 2027, month: 1, day: 2 }, ledgerCutoff: cutoff, ledgerEntries: [
    schedule('past', { 到期锚: { 历日期: { year: 2026, month: 1, day: 1 } } }),
    schedule('unknown-year', { 到期锚: { 历日期: { month: 12, day: 31 } }, 标签: ['约稿'] }),
    schedule('cycle', { 类型: '周期', 周期长度: 7, 到期锚: { 历日期: { month: 12, day: 31 } } }),
    schedule('cycle-no-date', { 类型: '周期', 周期长度: 7, 到期锚: null, 标签: ['约稿'] }),
    schedule('ongoing', { 类型: '持续状态', 到期锚: null, 标签: ['约稿'] }),
  ] });
  const context = h.api.getPhoneCalendarContext({ query: '约稿', includeSchedules: true }), byId = new Map(context?.schedules?.map(row => [row.id, row]));
  assert.equal(byId.size, 5); assert.deepEqual(context.scheduleAsOf, cutoff);
  assert.deepEqual(byId.get('past').dueInfo, { days: 363, overdue: true });
  assert.equal(byId.get('unknown-year').dueInfo, null);
  assert.deepEqual(byId.get('cycle').dueInfo, { days: 1, overdue: false });
  assert.equal(byId.get('cycle-no-date').dueInfo, null); assert.equal(byId.get('cycle-no-date').dueAt, null);
  assert.equal(byId.get('ongoing').type, '持续状态');
  assert.equal(byId.get('past').observedAt.floor, 3); assert.equal(byId.get('past').startedAt.sourceId, 'source-1');
  h.unchanged();
});

test('yearless custom calendars keep anchored cycles usable but unknown today never invents due values', () => {
  const calendar = { kind: 'custom', months: [{ name: '雪月', days: 20 }, { name: '芽月', days: 25 }] };
  for (const date of [{ month: 1, day: 20 }, null]) {
    const h = fixture({ calendar, today: date, ledgerCutoff: { floor: 5, date }, ledgerEntries: [schedule('cycle', { 类型: '周期', 周期长度: 4, 标签: ['巡查'], 到期锚: { 历日期: { month: 2, day: 1 } } }), schedule('once', { 标签: ['巡查'], 到期锚: { 历日期: { month: 2, day: 1 } } })] });
    const rows = h.api.getPhoneCalendarContext({ query: '巡查', includeSchedules: true })?.schedules;
    assert.equal(rows?.length, 2);
    assert.deepEqual(rows.find(row => row.id === 'cycle').dueInfo, date ? { days: 1, overdue: false } : null);
    assert.equal(rows.find(row => row.id === 'once').dueInfo, null); h.unchanged();
  }
});

test('schedule selection stays bounded and month reads do not run selection or traverse ledger entries', () => {
  const h = fixture({ ledgerEntries: Array.from({ length: 12 }, (_, i) => schedule(`L${i}`)) });
  assert.equal(h.api.getPhoneCalendarContext({ includeSchedules: true })?.schedules?.length, 8);
  let reads = 0;
  const entry = schedule('cold'); Object.defineProperty(entry, '状态', { get() { reads++; return '活跃'; } });
  const api = createPhoneCalendarApi({ read: () => ({ ...h.source, ledgerEntries: [entry] }), selectSchedules: () => { throw new Error('month must not select schedules'); } });
  assert.ok(api.getPhoneCalendar()); assert.equal(reads, 0);
});

test('source can expose ledger-only material without creating or repairing roots and stays empty when disabled or cutoff unavailable', () => {
  let enabled = true;
  const ctx = { chatId: 'synthetic', chatMetadata: {}, chat: [] }, before = structuredClone(ctx.chatMetadata);
  registerChatStorageContext(() => ctx);
  const source = createPhoneCalendarSource({ enabled: () => enabled, context: () => ctx, calendar: () => gregorian, items: () => undefined,
    entries: () => getChatRoot('sp-ledger', { create: false })?.entries, floorContext: () => ({ floor: 5, date: { year: 2026, month: 12, day: 30 } }), anchor: () => null, parseClock: () => ({}) });
  assert.equal(source(), null); assert.deepEqual(ctx.chatMetadata, before);
  ctx.chatMetadata['sp-ledger'] = { entries: [schedule('only')] };
  const h = fixture(), api = createPhoneCalendarApi({ read: source,
    selectSchedules: (entries, query, cutoff) => selectLedgerForInject(entries, query, cutoff.date, undefined, cutoff.floor),
    dueInfo: (entry, cutoff) => ledgerDueInfo(entry, cutoff.date, cutoff.floor), daysSince: (entry, cutoff) => ledgerDaysSince(entry, cutoff.date, cutoff.floor) });
  const saved = structuredClone(ctx.chatMetadata);
  assert.equal(api.getPhoneCalendar(), null, 'ledger-only material does not create a month');
  assert.equal(api.getPhoneCalendarContext({ includeSchedules: true })?.schedules?.[0].id, 'only'); assert.deepEqual(ctx.chatMetadata, saved);
  enabled = false; assert.equal(api.getPhoneCalendarContext({ includeSchedules: true }), null); assert.deepEqual(ctx.chatMetadata, saved);
  const waiting = fixture({ ledgerEntries: [schedule('locked', { 锁: '用户锁' })], ledgerCutoff: { floor: null, date: null } });
  assert.equal(waiting.api.getPhoneCalendarContext({ includeSchedules: true }), null); h.unchanged();
});

test('a mismatched expected chat is rejected before reading almanac or ledger material', () => {
  let reads = 0;
  const source = createPhoneCalendarSource({ enabled: () => true, context: () => ({ chatId: 'current-B', chat: [] }),
    items: () => { reads++; return []; }, entries: () => { reads++; return []; }, calendar: () => gregorian, anchor: () => null, parseClock: () => ({}) });
  const api = createPhoneCalendarApi({ read: source });
  assert.equal(api.getPhoneCalendarContext({ expectedChatId: 'captured-A', includeSchedules: true }), null);
  assert.equal(reads, 0);
});

test('legacy v1 context and month calls never read or expose schedules without an explicit request', () => {
  let ledgerReads = 0, cutoffReads = 0;
  const source = createPhoneCalendarSource({ enabled: () => true, context: () => ({ chatId: 'A', chat: [] }), calendar: () => gregorian,
    items: () => [{ id: 'old', name: '节日', type: 'festival', month: 1, day: 1 }], anchor: () => null, parseClock: () => ({}),
    entries: () => { ledgerReads++; return [schedule('private')]; }, floorContext: () => { cutoffReads++; return { floor: 5, date: null }; } });
  const api = createPhoneCalendarApi({ read: source });
  const legacy = api.getPhoneCalendarContext({ query: '节日' });
  assert.equal(legacy.events[0].name, '节日'); assert.equal('schedules' in legacy, false);
  assert.ok(api.getPhoneCalendar()); assert.equal(ledgerReads, 0); assert.equal(cutoffReads, 0);
});
