import test from 'node:test';
import assert from 'node:assert/strict';
import { bindStoryClock, parseStoryClock, parseJudgedDate } from '../axis/story-clock.js';
import { bindLedgerCapture, createLedgerCaptureController, ledgerFloorDateContext, ledgerHistoricalAiFloorRecords, ledgerSourceMap, planLedgerCapture } from './capture.js';
import { bindLedgerSchema, parseLedgerCaptureDetailed, parseLedgerJudge } from './schema.js';
import { createLedgerJudgeController } from './judge.js';
import { bindLedgerDate, fmtLedgerForJudge, ledgerDaysSince, ledgerDueInfo } from './date.js';
import { bindLedgerSelect, selectLedgerForInject } from './select.js';
import { createLedgerInjectionController } from './inject.js';
import { buildLedgerSources, reconcileLedgerEntries } from './reconcile.js';

const calendar = { kind: 'gregorian' };
const date = day => ({ month: 1, day, year: 2026 });
const ai = (body, day) => ({ name: 'Character', mes: day ? `<!-- SDC-start | date=2026-01-${String(day).padStart(2, '0')} | weekday=周一 | time=08:00 -->${body}<!-- SDC-end | date=2026-01-${String(day).padStart(2, '0')} | weekday=周一 | time=09:00 -->` : body, is_user: false, is_system: false });
const fixtureChat = () => [
    { is_user: true, mes: 'USER_ZERO' }, ai('EARLIER_BODY', 1),
    { ...ai('HIDDEN_OLD_BODY', 1), is_system: true, is_hidden: true },
    { is_system: true, mes: 'HOST_HELP', extra: { type: 'help' } },
    { is_user: true, mes: 'USER_FOUR' }, ai('CONFIRMED_BODY', 2),
    { is_user: true, mes: 'USER_AFTER_CUTOFF' }, ai('LATEST_UNCONFIRMED_BODY', 8),
];

function setup(chat = fixtureChat()) {
    const ctx = { chatId: 'ledger-fixture', characterId: 0, name1: 'User', name2: 'Character', characters: [{ avatar: 'fixture.png' }], chat };
    const requests = [], writes = [], toasts = [], entries = [];
    let onRequest = () => {};
    bindStoryClock({ loadCalendar: () => calendar, defaultCalendar: calendar, validMonthDay: value => value?.month >= 1 && value.month <= 12 && value.day >= 1 && value.day <= 31 ? value : null, validRealDate: () => true });
    bindLedgerSchema({ parseJudgedDate });
    bindLedgerCapture({ context: () => ctx, parseClock: parseStoryClock, parseDate: parseJudgedDate, calendarForFloor: () => calendar, stripTags: value => value.replace(/<!--\s*SDC-(?:start|end)[\s\S]*?-->/g, ''), settings: () => ({ ledgerHistoryScope: 'all' }), systemTypes: { HELP: 'help' } });
    bindLedgerDate({ today: () => date(8), floor: () => ledgerFloorDateContext().floor, daysUntil: (month, day, anchor) => (month - anchor.month) * 31 + day - anchor.day, daysUntilFull: (from, to) => (to.month - from.month) * 31 + to.day - from.day, listEntries: () => [] });
    bindLedgerSelect({ ledgerDaysSince, ledgerDueInfo });
    const state = { initialized: true, checkpoint: null, ledgerRevision: 'fixture-revision' };
    const entry = { id: 'L1', 事由: '左手伤口', 类型: '持续状态', 现状: '仍在流血。', 标签: ['伤口'], 起始锚: { 楼层: 1, 历日期: date(1) } };
    const common = { context: () => ctx, charKey: () => 'fixture-character', target: () => null, config: () => ({ url: 'offline', key: 'offline' }), calendar: () => calendar, validDate: value => value?.month && value?.day ? value : null, today: () => date(8), settings: () => ({ ledgerHistoryScope: 'all', notifyMode: 'off' }), toast: value => toasts.push(value), appendTravel: value => value };
    const capture = createLedgerCaptureController({ ...common, captureState: () => state, parseCaptureDetailed: parseLedgerCaptureDetailed, listEntries: () => entries, callApi: async (...args) => { requests.push(args); onRequest(); return '左手伤口｜持续状态｜Character｜伤口｜伤口仍在流血。｜｜｜F5E'; }, applyAtomic: async plan => { writes.push(plan); return { ok: true, commitState: 'local-applied', added: plan.additions, patched: plan.patches }; } });
    const judge = createLedgerJudgeController({ ...common, floorContext: ledgerFloorDateContext, listJudgeable: () => [entry], fmtLedger: fmtLedgerForJudge, getEntry: () => entry, reconcile: async () => ({ summary: { changed: false } }), callApi: async (...args) => { requests.push(args); onRequest(); return 'L1｜伤口已止血。｜维持｜'; }, parseJudge: parseLedgerJudge, applyAtomic: async changes => { writes.push(changes); return { ok: true, commitState: 'local-applied' }; } });
    return { ctx, requests, writes, toasts, state, entry, entries, capture, judge, onRequest: fn => { onRequest = fn; } };
}

test('persistent capture bounds recent source tokens, request context and saved anchors to the previous eligible AI', async () => {
    const h = setup();
    const result = await h.capture.run(false);
    assert.equal(result.status, 'updated');
    assert.deepEqual(h.requests[0][7].ledgerSourceFloors.map(record => record.floor), [1, 5]);
    assert.equal(h.requests[0][0].chat.length, 6);
    assert.deepEqual(h.writes[0].additions[0].起始锚.历日期, date(2));
    assert.deepEqual(h.writes[0].additions[0].现状锚, { 楼层: 5, 历日期: date(2) });
    assert.deepEqual(ledgerHistoricalAiFloorRecords().map(record => record.floor), [1, 2, 5, 7], 'real historical sources remain available for integrity reconciliation');
});

test('judge uses the previous AI date and history, unaffected by reroll of only the latest AI', async () => {
    const h = setup();
    await h.judge.run(false);
    assert.equal(h.requests[0][0].chat.length, 6);
    assert.match(h.requests[0][1], /距登记 1 天/);
    assert.deepEqual(h.writes[0][0].patch.现状锚, { 楼层: 5, 历日期: date(2) });
    h.ctx.chat[7] = ai('REROLLED_LATEST_BODY', 20);
    await h.judge.run(false);
    assert.equal(h.requests[1][1], h.requests[0][1]);
    assert.deepEqual(h.writes[1][0].patch.现状锚, h.writes[0][0].patch.现状锚);
    h.ctx.chat.push(ai('NEXT_AI_BODY', 21));
    await h.judge.run(false);
    assert.deepEqual(h.writes[2][0].patch.现状锚, { 楼层: 7, 历日期: date(20) });
});

test('one eligible AI is normal waiting with zero capture or judge requests', async () => {
    const h = setup([ai('FIRST_AI_BODY', 8)]);
    for (const controller of [h.capture, h.judge]) {
        const result = await controller.run(true);
        assert.equal(result.status, 'skipped');
    }
    assert.equal(h.requests.length, 0);
    assert.equal(h.writes.length, 0);
});

test('saved provenance progress beyond the current cutoff waits without rewriting its original anchors', async () => {
    const h = setup();
    h.state.checkpoint = { version: 1, stage: 'provenance', captureFloor: 7, captureDate: date(8), candidates: [{ _candidateId: 'C1', 事由: '旧已保存候选' }] };
    const before = structuredClone(h.state);
    const result = await h.capture.run(true);
    assert.equal(result.status, 'skipped');
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.state, before);
});

test('rerolling only the excluded latest AI does not invalidate the actual captured source calculation', async () => {
    for (const kind of ['capture', 'judge']) {
        const h = setup();
        h.onRequest(() => { h.ctx.chat[7] = ai('REROLLED_LATEST_BODY', 20); });
        assert.equal((await h[kind].run(false)).status, 'updated');
        assert.equal(h.writes.length, 1);
    }
});

test('undated cutoff uses only an earlier reliable clock and never the latest global date', async () => {
    const h = setup();
    h.ctx.chat[5] = ai('CONFIRMED_WITHOUT_CLOCK');
    await h.judge.run(false);
    assert.deepEqual(h.writes[0][0].patch.现状锚, { 楼层: 5, 历日期: date(1) });
    h.ctx.chat[1] = ai('EARLIER_WITHOUT_CLOCK');
    h.ctx.chat[2] = { ...ai('HIDDEN_WITHOUT_CLOCK'), is_system: true, is_hidden: true };
    h.requests.length = 0; h.writes.length = 0;
    const result = await h.judge.run(false);
    assert.equal(result.status, 'skipped');
    assert.equal(h.requests.length, 0);
});

test('explicit user travel date retains priority over the cutoff date', async () => {
    const h = setup();
    await h.judge.run(true, { targetDate: date(4) });
    assert.deepEqual(h.writes[0][0].patch.现状锚, { 楼层: 5, 历日期: date(4) });
});

test('a legitimate stored latest-floor entry stays intact until the cutoff reaches both of its anchors', async () => {
    const h = setup();
    const sources = buildLedgerSources(ledgerHistoricalAiFloorRecords());
    const latest = sources.find(source => source.token === 'F7E');
    h.entry.起始锚 = { 楼层: 7, 历日期: date(8), 来源指纹: latest.fingerprint };
    h.entry.现状锚 = { 楼层: 7, 历日期: date(8) };
    h.entry.标签 = ['CONFIRMED_BODY'];
    h.entry.到期锚 = { 历日期: date(9) };
    h.entries.push(h.entry);
    const before = structuredClone(h.entry);
    assert.deepEqual(reconcileLedgerEntries([h.entry], sources, h.ctx.chat.length).entries, [before]);
    assert.equal((await h.judge.run(true)).status, 'skipped');
    assert.equal(h.requests.length, 0);
    assert.equal(ledgerDaysSince(h.entry, date(2)), null);
    assert.equal(ledgerDueInfo(h.entry, date(2)), null);
    assert.doesNotMatch(fmtLedgerForJudge(h.entry, date(2)), /距登记|今天登记|还有 \d+ 天到期/);
    await h.capture.run(false);
    assert.equal(h.writes[0].additions.length, 0, 'excluded old entries remain in duplicate detection');
    assert.equal(h.writes[0].patches.length, 0, 'older capture does not overwrite a later stored state');
    const prompts = [];
    h.ctx.setExtensionPrompt = (_key, text) => prompts.push(text);
    const injection = createLedgerInjectionController({ context: () => h.ctx, floorContext: ledgerFloorDateContext, enabled: () => true, settings: () => ({ ledgerInject: true }), entries: () => [h.entry], select: selectLedgerForInject, daysSince: ledgerDaysSince, dueInfo: ledgerDueInfo, narrative: message => !message.is_user && !message.is_system });
    injection.refresh();
    assert.equal(prompts.at(-1), '');
    assert.deepEqual(h.entry, before);
    h.ctx.chat.push(ai('NEXT_AI', 9));
    assert.equal((await h.judge.run(false)).status, 'updated');
    assert.equal(ledgerDaysSince(h.entry, date(8)), 0);
});

test('ledger injection and salience share the confirmed scene and explicit date', () => {
    const h = setup();
    const entry = { ...h.entry, 事由: '归还借书', 类型: '约定待办', 标签: ['LATEST_UNCONFIRMED_BODY'], 到期锚: { 历日期: date(10) } };
    const prompts = [];
    h.ctx.setExtensionPrompt = (_key, value) => prompts.push(value);
    const injection = createLedgerInjectionController({ context: () => h.ctx, floorContext: ledgerFloorDateContext, enabled: () => true, settings: () => ({ ledgerInject: true }), entries: () => [entry], select: selectLedgerForInject, today: () => date(8), daysSince: ledgerDaysSince, dueInfo: ledgerDueInfo, narrative: message => !message.is_user && !message.is_system, stripTags: value => value });
    injection.refresh();
    assert.equal(prompts.at(-1), '', 'eight days before due is not injected via latest scene or axis date');
    entry.到期锚.历日期 = date(3);
    injection.refresh();
    assert.match(prompts.at(-1), /还有 1 天到期/);
});

test('a nine-field update naming an existing out-of-cutoff ID is not converted into a renamed new event', () => {
    const h = setup();
    h.entry.起始锚 = { 楼层: 7, 历日期: date(8) };
    h.entry.现状锚 = { 楼层: 7, 历日期: date(8) };
    const parsed = parseLedgerCaptureDetailed('L1｜左手包扎后的恢复状态｜持续状态｜Character｜伤口｜伤口仍然疼痛。｜｜｜F5E');
    assert.equal(parsed.records[0]._targetId, 'L1');
    const plan = planLedgerCapture({ entries: [h.entry], candidates: parsed.records, sourceMap: ledgerSourceMap(buildLedgerSources(ledgerHistoricalAiFloorRecords())), captureFloor: 5, captureDate: date(2) });
    assert.equal(plan.additions.length, 0);
    assert.equal(plan.patches.length, 0);
});
