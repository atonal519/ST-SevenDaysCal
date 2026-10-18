import test from 'node:test';
import assert from 'node:assert/strict';

const { createPhoneCalendarApi, createPhoneCalendarSource } = await import('./phone.js').catch(() => ({}));
const gregorian = { kind: 'gregorian', id: 'default-gregorian', months: [31,29,31,30,31,30,31,31,30,31,30,31].map((days, i) => ({ name: `${i + 1}月`, days })) };
function fixture({ today = { year: 2026, month: 12, day: 30, weekday: 3 }, calendar = gregorian, items = [] } = {}) {
  assert.equal(typeof createPhoneCalendarApi, 'function', '只读 Calendar 接口尚未实现');
  const source = structuredClone({ today, calendar, items }), before = JSON.stringify(source);
  const api = createPhoneCalendarApi({ read: () => source });
  return { api, source, unchanged: () => assert.equal(JSON.stringify(source), before) };
}

test('phone month respects real leap years and source weekday, projecting only festival and anniversary data', () => {
  for (const [year, days] of [[2025, 28], [2024, 29]]) {
    const h = fixture({ today: { year, month: 2, day: 1, weekday: 1 }, items: [
      { id: 'a', name: '相识纪念日', type: 'anniversary', month: 2, day: 2, days: 1, note: '一起逛过书店', pin: true, source: 'user' },
      { id: 'b', name: '其他内容', type: 'custom', month: 2, day: 2 },
    ] });
    const month = h.api.getPhoneCalendar();
    assert.equal(month.days.length, days);
    assert.equal(month.leading, 0, '记录中的周一优先于现实公历');
    assert.deepEqual(month.days[1].items.map(item => item.name), ['相识纪念日']);
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
