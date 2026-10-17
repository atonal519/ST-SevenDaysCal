import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOutlineGeneration } from '../business/outline/generation.js';
import { createOutlineFeature } from '../business/outline/feature.js';
import { createPointController } from '../business/point/controller.js';
import { createLinesGenerationController } from '../business/lines/controller.js';
import { createTaskOwnerManager } from '../runtime/task-owner.js';
import { drawTickets } from '../business/lines/vectors/draw.js';
import { buildLinesPrompt } from '../business/lines/prompt.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
const startMarker = 'async function buildMessages(ctx, prompt, userName, charName, historyLimit = 3, opts = {}) {';
const start = source.indexOf(startMarker);
const end = source.indexOf('// ─── Inject', start + startMarker.length);
assert.ok(start >= 0 && end > start, 'production buildMessages source region exists');
const region = source.slice(start, end);
const planningOutline = '<outline_widget>\nBeat: 这一周|当前阶段|推进|主线|现有事项继续协商\nScene: 当前节点场景\nBeat: 下周|后续方向|延展|主线|下一阶段方向\nScene: 后续节点场景\n</outline_widget>';

function makePlanningOutlineFeature({ injectEnabled = true, outlineInject = true, cursor = 1 } = {}) {
    let reads = 0;
    const feature = createOutlineFeature({
        context: () => ({ chatId: 'point-outline' }), keyDesc: () => 'outline-user',
        readStore: () => { reads++; return { raw: planningOutline, cursor }; },
        settings: () => ({ outlineInject }), injectEnabled: () => injectEnabled, pluginEnabled: () => true,
        ui: {},
    });
    return { feature, reads: () => reads };
}

function productionStoryClock() {
    const storySource = fs.readFileSync(path.join(repo, 'business/axis/story-clock.js'), 'utf8');
    const begin = storySource.indexOf('const CLOCK_NAMESPACES');
    const finish = storySource.indexOf('export function completeStoryClock', begin);
    assert.ok(begin >= 0 && finish > begin, 'production story-clock parser region exists');
    const parserRegion = storySource.slice(begin, finish).replaceAll('export function ', 'function ').replaceAll('export const ', 'const ');
    const defaultCalendar = { kind: 'gregorian' };
    return vm.runInNewContext(`${parserRegion}\n({ bindStoryClock, latestStoryClock })`, {
        _cnToNumber: () => 0,
        _CN_MONTH_ALIAS: {},
        normalizeCnDateDigits: value => String(value),
        calendar: defaultCalendar,
        validMonthDay: ({ month, day }) => Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= 31 ? { month, day } : null,
        validRealDate: () => true,
        loadCalendar: () => defaultCalendar,
        defaultCalendar,
    });
}

function productionStoryClockFormatter() {
    const uiSource = fs.readFileSync(path.join(repo, 'business/axis/ui.js'), 'utf8');
    const begin = uiSource.indexOf('function displayMonthName');
    const finish = uiSource.indexOf('export function calendarSummary', begin);
    assert.ok(begin >= 0 && finish > begin, 'production story-clock formatter region exists');
    const formatterRegion = uiSource.slice(begin, finish).replaceAll('export function ', 'function ');
    return vm.runInNewContext(`${formatterRegion}\nformatStoryClockMeta`, {});
}

function productionAlmanacText(date) {
    const sourceText = fs.readFileSync(path.join(repo, 'business/axis/inject.js'), 'utf8');
    const begin = sourceText.indexOf('export function getAlmanacInjectText');
    assert.ok(begin >= 0, 'production almanac builder exists');
    const fn = sourceText.slice(begin).replace('export function ', 'function ');
    return vm.runInNewContext(`${fn}\ngetAlmanacInjectText(${JSON.stringify(date)})`, {
        loadAlmanac: () => [{ month: 10, day: 17, days: 1, name: '中性节日', type: 'festival', note: '' }],
        loadCalDesc: () => null,
        almDayOfYear: (month, day) => (month - 1) * 30 + day,
        almClampInt: (value, _min, _max, fallback) => Number.isInteger(Number(value)) ? Number(value) : fallback,
        calYearLen: () => 360,
        almItemCoversDoy: () => false,
        almDaysUntil: (month, day, anchor) => (((month - 1) * 30 + day) - ((anchor.month - 1) * 30 + anchor.day) + 360) % 360,
        almDateLabel: item => `${item.month}月${item.day}日`,
        almTypeMeta: () => ({ label: '节日' }),
        calMonthName: (_cal, month) => `${month}月`,
        almTodayAnchor: () => ({ month: 10, day: 15 }),
    });
}

function buildHarness(ctx) {
    const calls = { clocks: [], almanacDates: [] };
    const storyClock = productionStoryClock();
    storyClock.bindStoryClock({
        loadCalendar: () => ({ kind: 'gregorian' }),
        validMonthDay: ({ month, day }) => Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= 31 ? { month, day } : null,
        validRealDate: () => true,
        defaultCalendar: { kind: 'gregorian' },
        calendarForFloor: () => ({ kind: 'gregorian' }),
    });
    const formatStoryClockMeta = productionStoryClockFormatter();
    const build = vm.runInNewContext(`${region}\nbuildMessages`, {
        buildGenerationHistoryContext: (_context, historyLimit) => ({ history: Number(historyLimit) > 0 ? [{ role: 'assistant', content: '已清洗正文；无时间戳标签' }] : [], excludeMesIds: [] }),
        buildWorldInfoContext: async () => '',
        readCardExtras: () => ({ personaDesc: '', authorNote: '' }),
        getSettings: () => ({}),
        getAlmanacInjectText: date => { calls.almanacDates.push(date); return productionAlmanacText(date); },
        resolveAlmanacContextText: (opts, read) => opts.noAlmanac ? '' : String(read?.() || ''),
        getCalDescInjectText: () => '',
        sanitizeGenerationContextText: value => value,
        getMemText: async () => '',
        latestStoryClockPure: (context, limit) => { calls.clocks.push({ ctx: context, limit }); return storyClock.latestStoryClock(context, limit); },
        ALM_CHAT_SCAN_LIMIT: 100,
        formatStoryClockMeta,
        loadCalDesc: () => null,
        calMonthName: (_cal, month) => `${month}月`,
    });
    return { build, calls };
}

test('planning messages expose the parsed latest story end and reuse its date for the actual almanac countdown', async () => {
    const ctx = { chat: [{ is_user: false, mes: '<!-- SDC-start | date=2026-10-16 | weekday=周五 | time=20:30 -->正文<!-- SDC-end | date=2026-10-16 | weekday=周五 | time=20:50 -->' }] };
    const { build, calls } = buildHarness(ctx);
    const messages = await build(ctx, '规划', '用户', '角色', 3, { includeCurrentStoryTime: true });
    assert.match(messages[0].content, /【当前故事时点】最新正文结束时点：2026年10月16日 周五 20:50/);
    assert.equal(messages[1].content, '已清洗正文；无时间戳标签');
    assert.doesNotMatch(messages[1].content, /SDC-(?:start|end)/);
    assert.match(messages[0].content, /【本世界观·重要日期（历）】/);
    assert.equal(calls.clocks.length, 1);
    assert.equal(calls.clocks[0].ctx, ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.almanacDates[0])), { month: 10, day: 16, year: 2026 });
    assert.match(messages[0].content, /【当前剧情日期】10月16日/);
    assert.match(messages[0].content, /还有 1 天：10月17日/);
});

test('end-only clock is labeled as end-only and missing clock adds no guessed current time', async () => {
    const endCtx = { chat: [{ is_user: false, mes: '<!-- SDC-end | date=2026-10-16 | weekday=周五 | time=20:50 -->正文' }] };
    const endOnly = buildHarness(endCtx);
    const endMessages = await endOnly.build(endCtx, '规划', '用户', '角色', 0, { includeCurrentStoryTime: true });
    assert.match(endMessages[0].content, /最新正文结束时点：2026年10月16日 周五 20:50/);
    assert.deepEqual(JSON.parse(JSON.stringify(endOnly.calls.almanacDates[0])), { month: 10, day: 16, year: 2026 });

    const missingCtx = { chat: [{ is_user: false, mes: '正文没有时间戳' }] };
    const missing = buildHarness(missingCtx);
    const missingMessages = await missing.build(missingCtx, '规划', '用户', '角色', 0, { includeCurrentStoryTime: true });
    assert.doesNotMatch(missingMessages[0].content, /【当前故事时点】/);
    assert.equal(missing.calls.almanacDates[0], null);
});

test('a valid latest date without a time still anchors the almanac without inventing an hour', async () => {
    const ctx = { chat: [{ is_user: false, mes: '<!-- SDC-end | date=2026-10-16 | weekday=周五 -->正文' }] };
    const { build, calls } = buildHarness(ctx);
    const messages = await build(ctx, '规划', '用户', '角色', 0, { includeCurrentStoryTime: true });
    assert.match(messages[0].content, /最新正文结束时点：2026年10月16日 周五/);
    assert.doesNotMatch(messages[0].content, /最新正文结束时点：[^\n]*\d{1,2}:\d{2}/);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.almanacDates[0])), { month: 10, day: 16, year: 2026 });
    assert.match(messages[0].content, /还有 1 天：10月17日/);
});

test('start-only timestamps remain usable and ordinary builders do not enable story-time lookup', async () => {
    const ctx = { chat: [{ is_user: false, mes: '<!-- SDC-start | date=2026-10-16 | weekday=周五 | time=20:30 -->正文' }] };
    const startOnly = buildHarness(ctx);
    const messages = await startOnly.build(ctx, '规划', '用户', '角色', 0, { includeCurrentStoryTime: true });
    assert.match(messages[0].content, /【当前故事时点】最新正文开始时点：2026年10月16日 周五 20:30/);
    assert.deepEqual(JSON.parse(JSON.stringify(startOnly.calls.almanacDates[0])), { month: 10, day: 16, year: 2026 });

    const ordinary = buildHarness(ctx);
    const ordinaryMessages = await ordinary.build(ctx, '普通调用', '用户', '角色', 0, {});
    assert.equal(ordinary.calls.clocks.length, 0);
    assert.doesNotMatch(ordinaryMessages[0].content, /【当前故事时点】/);
    assert.match(ordinaryMessages[0].content, /【当前剧情日期】10月15日/);
});

test('point, lines, and outline production generation entries pass the story-time option', async () => {
    const pointStart = source.indexOf('async function generate(ctx, userName, charName, perspective =');
    const pointEnd = source.indexOf('// ─── World-info entry filter', pointStart);
    assert.ok(pointStart >= 0 && pointEnd > pointStart, 'production point generation function exists');
    const pointRegion = source.slice(pointStart, pointEnd);
    let pointOptions;
    const pointGenerate = vm.runInNewContext(`${pointRegion}\ngenerate`, {
        loadCfg: () => ({ url: 'fixture', key: 'fixture' }), settingsOpen: false,
        toggleSettings() {}, makeDiagnosticError: code => new Error(code), charStableKey: () => 'fixture',
        appendTravelPromptContext: value => value, buildPrompt: () => 'point prompt', loadCalDesc: () => null,
        pointTicketPlan: () => [], getScale: () => 'auto', getLineDirection: () => 'natural',
        callCustomApi: async (...args) => { pointOptions = args.at(-1); return 'ok'; },
    });
    await pointGenerate({}, '用户', '角色');
    assert.equal(pointOptions.includeCurrentStoryTime, true);

    const line = source.split('\n').find(value => value.startsWith('        callApi: (prompt, signal, options, identity, contextSnapshot) => callCustomApi('));
    assert.ok(line, 'production lines callApi adapter exists');
    const expression = line.trim().slice('callApi: '.length).slice(0, -1);
    const lineOptions = [];
    const lineCallApi = vm.runInNewContext(`(${expression})`, {
        callCustomApi: (...args) => { lineOptions.push(args.at(-1)); return '<storylines_widget>\nLine: 新线|起线|今天|world|false|false\nTicket: TICKET-1\nDesc: 当前状态\nNext: 下一步\n</storylines_widget>'; },
        getContext: () => ({}), loadCfg: () => ({}),
    });
    const lineController = createLinesGenerationController({
        owners: createTaskOwnerManager(), chatId: () => 'story-time-lines', cacheKey: () => 'story-time-lines',
        loadConfig: () => ({ url: 'fixture', key: 'fixture' }), readSaved: () => ({ raw: '', ts: 1 }),
        drawTickets: count => drawTickets(count, { seed: 'story-time-lines' }), vectorCapacity: 1,
        buildPrompt: () => 'line prompt', callApi: (...args) => lineCallApi(...args), commit() {},
        runtime: { start() {}, finish() {} },
    });
    assert.equal((await lineController.run()).status, 'updated', 'normal advance reaches the production index adapter');
    assert.equal((await lineController.run(false, { reroll: true, module: 'lines' })).status, 'updated', 'reroll reaches the same production index adapter');
    assert.equal(lineOptions.length, 2);
    assert.equal(lineOptions[0].includeCurrentStoryTime, true);
    assert.equal(lineOptions[0].reroll, undefined);
    assert.equal(lineOptions[1].includeCurrentStoryTime, true);
    assert.equal(lineOptions[1].reroll, true);

    let outlineOptions;
    const outline = createOutlineGeneration({
        repository: {
            capture: () => ({ chatId: 'fixture' }), baseline: () => ({ raw: '' }), isCurrent: () => true,
            readOutline: () => null, cursor: () => 1, matches: () => true,
            commitOutlineConfirmed: () => ({ ok: true, commitState: 'local-applied' }),
        },
        context: () => ({ chatId: 'fixture', name1: '用户', name2: '角色', chat: [] }),
        loadConfig: () => ({ url: 'fixture', key: 'fixture' }), callApi: async request => {
            outlineOptions = request.options;
            return '<outline_widget>\nBeat: 今日|处理事项|继续协商|主线|延展\nScene: 讨论进展\n</outline_widget>';
        },
        precheck: async () => true, renderer: { render: value => value },
        ui: { setLoading() {}, isOutlineMode: () => false, closedSuccess() {}, toast() {} },
        settings: () => ({ notifyMode: 'off' }),
    });
    assert.equal((await outline.trigger()).status, 'updated');
    assert.equal(outlineOptions.includeCurrentStoryTime, true);
    assert.match(buildLinesPrompt('用户', '角色'), /若系统提供最新正文时点，按它重核时间关系/);
});

test('point captures the enabled outline plan for generation and the shared builder receives it', async () => {
    const pointEnvStart = source.indexOf('const pointController = createPointController({');
    const pointEnvEnd = source.indexOf('\n});', pointEnvStart);
    assert.ok(pointEnvStart >= 0 && pointEnvEnd > pointEnvStart, 'production point controller environment exists');
    const pointEnv = source.slice(pointEnvStart, pointEnvEnd);
    const captureMatch = pointEnv.match(/\n\s*captureContext:\s*([^,]+),/);
    assert.ok(captureMatch, 'production point captureContext entry exists');
    const captureStart = source.indexOf('function captureGenerationContext(');
    const captureEnd = source.indexOf('\nfunction captureChatBoundary', captureStart);
    const captureDefinition = source.slice(captureStart, captureEnd);
    const context = { chatId: 'point-outline', chat: [], name1: '用户', name2: '角色' };
    const enabledOutline = makePlanningOutlineFeature();
    const captureContext = vm.runInNewContext(`${captureDefinition}\n(${captureMatch[1]})`, {
        getContext: () => context,
        outlineFeature: enabledOutline.feature,
    });
    const captured = captureContext();
    assert.match(captured.outlinePlan, /当前阶段：这一周/);
    assert.match(captured.outlinePlan, /后续方向：下周/);
    assert.equal(enabledOutline.reads(), 2, 'one planning projection follows the existing readOutline/cursor repository reads');
    assert.notEqual(captured, context, 'generation keeps the existing point context snapshot');

    for (const options of [{ injectEnabled: false }, { outlineInject: false }]) {
        const disabled = makePlanningOutlineFeature(options);
        const disabledCapture = vm.runInNewContext(`${captureDefinition}\n(${captureMatch[1]})`, {
            getContext: () => context, outlineFeature: disabled.feature,
        });
        const disabledSnapshot = disabledCapture();
        assert.equal(disabledSnapshot.outlinePlan, '', 'closed outline gate yields no point planning text');
        assert.equal(disabled.reads(), 0, 'closed outline gate does not read the formal outline draft');
        const disabledMessages = await buildHarness(disabledSnapshot).build(disabledSnapshot, '规划', '用户', '角色', 3, { includeOutlinePlan: true });
        assert.doesNotMatch(disabledMessages[0].content, /【剧情规划参考/);
    }
    const noCurrent = makePlanningOutlineFeature({ cursor: 0 });
    assert.equal(noCurrent.feature.readPlanningText(), '');
    assert.equal(noCurrent.reads(), 2, 'enabled planning reads the repository before the existing empty-current projection');
    const noCurrentCapture = vm.runInNewContext(`${captureDefinition}\n(${captureMatch[1]})`, {
        getContext: () => context, outlineFeature: noCurrent.feature,
    });
    const noCurrentSnapshot = noCurrentCapture();
    const noCurrentMessages = await buildHarness(noCurrentSnapshot).build(noCurrentSnapshot, '规划', '用户', '角色', 3, { includeOutlinePlan: true });
    assert.doesNotMatch(noCurrentMessages[0].content, /【剧情规划参考/);

    async function captureThroughPointEntry(entry) {
        let snapshotSeen;
        const state = { isGenerating: false, scheduleAbortController: null, cachedSchedule: null };
        const saved = { raw: entry === 'automatic' ? '<calendar_widget>old</calendar_widget>' : '', ts: entry === 'automatic' ? 1 : null };
        const owners = {
            create: (_kind, metadata) => ({ ...metadata, controller: new AbortController() }),
            currentChatRevision: () => 0, isOwner: () => true, finish() {}, peekPending: () => null, discardPending() {}, setPending() {},
        };
        const controller = createPointController({
            owners, state, evaluate: () => ({ canCommit: true, canCallback: true, canCleanup: true }),
            chatId: () => context.chatId, enabled: () => true, setButton() {}, syncing: () => false,
            toast() {}, view: () => 'user', char: () => '', context: () => context, captureContext,
            precheck: async () => true,
            key: () => 'schedule-user', read: () => saved,
            write: async (_key, value) => { saved.raw = value.raw; saved.ts = value.ts; return true; },
            parse: () => ({ days: [], future: null }), calendar: () => ({}), generate: async ctx => { snapshotSeen = ctx; return '<calendar_widget>new</calendar_widget>'; },
            adultMode: () => 'off', validate: () => ({ ok: true }), mergePinned: (_old, raw) => raw,
            today: () => ({ month: 10, day: 17 }), forceStart: raw => raw, render: () => '<ok>', sync() {},
            canCommit: () => true, canCallback: () => true, config: () => ({ url: 'fixture', key: 'fixture' }),
            setAuto: value => value, setSyncing() {}, clearBusy() {}, followupState: () => ({ canCleanup: true, canFollowup: false }), shouldFollowup: () => false,
            abortAuto() {}, notify: () => 'off', monthName: () => '十月', setCached() {}, panelVisible: () => false,
            showPanel() {}, setBody() {}, loading: () => 'loading', recordFailure() {}, escape: String,
        });
        if (entry === 'manual') {
            const originalTimeout = globalThis.setTimeout;
            globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 6000 ? 0 : delay, ...args);
            try {
                await controller.triggerGenerate();
                await new Promise(resolve => setImmediate(resolve));
            } finally {
                globalThis.setTimeout = originalTimeout;
            }
        } else {
            await controller.syncPointToToday(true, { targetDate: { month: 10, day: 17 } });
        }
        return snapshotSeen;
    }
    assert.match((await captureThroughPointEntry('manual')).outlinePlan, /当前阶段/);
    assert.match((await captureThroughPointEntry('automatic')).outlinePlan, /后续方向/);

    const pointStart = source.indexOf('async function generate(ctx, userName, charName, perspective =');
    const pointEnd = source.indexOf('// ─── World-info entry filter', pointStart);
    const pointRegion = source.slice(pointStart, pointEnd);
    let pointOptions;
    const pointGenerate = vm.runInNewContext(`${pointRegion}\ngenerate`, {
        loadCfg: () => ({ url: 'fixture', key: 'fixture' }), settingsOpen: false,
        toggleSettings() {}, makeDiagnosticError: code => new Error(code), charStableKey: () => 'fixture',
        appendTravelPromptContext: value => value, buildPrompt: () => 'point prompt', loadCalDesc: () => null,
        pointTicketPlan: () => [], getScale: () => 'auto', getLineDirection: () => 'natural',
        callCustomApi: async (...args) => { pointOptions = args.at(-1); return 'ok'; },
    });
    await pointGenerate(captured, '用户', '角色');
    assert.equal(pointOptions.includeOutlinePlan, true);

    const { build } = buildHarness(captured);
    const messages = await build(captured, '规划', '用户', '角色', 3, pointOptions);
    assert.match(messages[0].content, /【剧情规划参考｜尚未发生的推演/);
    assert.match(messages[0].content, /当前阶段：这一周·《当前阶段》/);
    assert.match(messages[0].content, /后续方向：下周·《后续方向》/);
    assert.equal(messages[1].content, '已清洗正文；无时间戳标签');
});
