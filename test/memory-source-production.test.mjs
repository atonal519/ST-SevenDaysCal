import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { selectVisibleChatHistory } from '../business/lines/history.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
function region(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `production region found: ${startMarker}`);
    return source.slice(start, end);
}
function evaluate(text, expression, sandbox = {}) { return vm.runInNewContext(`${text}\n${expression}`, sandbox); }

const memorySetup = region('function createQianQianJieGenerationSnapshot(', 'function spConfirm(');
const indexHistory = region('function buildRecentGenerationHistory(ctx, historyLimit, opts = {}) {', 'function outlineWorldInfoTriggerText(history) {');
const buildMessagesRegion = region('async function buildMessages(ctx, prompt, userName, charName, historyLimit = 3, opts = {}) {', '// ─── Inject');
const externalReadRegion = region('async function _getMemTextRaw(opts = {}) {', '// 记忆源先按各自的召回规则选材');

function precheckHarness(result, { confirmed = true } = {}) {
    const titles = [];
    const funcs = evaluate(memorySetup, '({ memoryPreCheckConfirm, isConfirmedMemoryFallback })', {
        getSettings: () => ({ useDatabase: true, useAnima: false, useBaiBaiBook: false, useQianQianJie: false }),
        memorySourceEpoch: 1,
        databaseMemoryAccess: { result: async () => result },
        databaseMemoryDiagnostic: value => `数据库原因:${value.status}`,
        getDatabasePrimaryWorldbookName: () => '主书',
        spConfirm: async options => { titles.push(options.title); return confirmed; },
        safeDiagnosticLog: () => ({}), showToast() {}, memory: { getHealthReport() { throw new Error('unexpected built-in precheck'); } },
        console: { warn() {} },
    });
    return { ...funcs, titles };
}

function buildHarness({ getMemText }) {
    const historyBuilder = evaluate(indexHistory, 'buildGenerationHistoryContext', {
        getSettings: () => ({ keepTags: '', extraTags: '' }),
        selectVisibleChatHistory,
        substituteParams: value => String(value ?? ''),
        sanitizeGenerationContextText: value => String(value ?? ''),
        memory: { stripTags: value => String(value ?? '') },
    });
    const stale = Object.assign(new Error('stale'), { diagnosticCode: 'memory-stale' });
    return evaluate(buildMessagesRegion, 'buildMessages', {
        buildGenerationHistoryContext: historyBuilder,
        buildWorldInfoContext: async () => '',
        readCardExtras: () => ({ personaDesc: '', authorNote: '' }),
        getSettings: () => ({ useDatabase: true, useAnima: false, useBaiBaiBook: false, useQianQianJie: false, keepTags: '', extraTags: '' }),
        getAlmanacInjectText: () => '', resolveAlmanacContextText: () => '', getCalDescInjectText: () => '',
        sanitizeGenerationContextText: value => String(value ?? ''),
        isConfirmedMemoryFallback: snapshot => snapshot?.status === 'fallback-confirmed'
            && ['database', 'anima', 'bai-bai-book'].includes(snapshot.source),
        isMemoryReadSnapshot: snapshot => snapshot?.status === 'read-required'
            && ['database', 'anima', 'bai-bai-book'].includes(snapshot.source),
        qianQianJieGenerationSnapshotCurrent: () => false,
        makeDiagnosticError: () => stale,
        getMemText,
    });
}

test('database preflight distinguishes confirmed empty fallback from ready-then-read failure', async () => {
    const emptyRead = precheckHarness({ status: 'no-match', text: '' });
    const fallback = await emptyRead.memoryPreCheckConfirm({ operationToken: Symbol('request') });
    assert.equal(fallback.proceed, true);
    assert.equal(emptyRead.titles[0], '数据库记忆为空');
    assert.equal(emptyRead.isConfirmedMemoryFallback(fallback.memorySnapshot), true);

    const failedRead = precheckHarness({ status: 'worldbook-read-failed', text: '' });
    const consented = await failedRead.memoryPreCheckConfirm({});
    assert.equal(consented.proceed, true, '原确认仍允许本次改用最近聊天正文');
    assert.equal(failedRead.titles[0], '数据库记忆读取失败');
});

test('a confirmed external fallback uses six recent visible AI floors without rereading; ready source failure blocks dispatch', async () => {
    const emptyRead = precheckHarness({ status: 'empty-content', text: '' });
    const fallback = await emptyRead.memoryPreCheckConfirm({});
    let sourceReads = 0;
    const fallbackBuild = buildHarness({ getMemText: async () => { sourceReads++; throw new Error('must honor this request confirmation'); } });
    const chat = Array.from({ length: 8 }, (_, index) => ({ mes: `visible-${index}` }));
    const messages = await fallbackBuild({ chat, characters: {}, characterId: 0 }, 'prompt', '用户', '角色', 3, { memorySnapshot: fallback.memorySnapshot });
    assert.equal(sourceReads, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(messages.slice(1, -1).map(message => message.content))), ['visible-2', 'visible-3', 'visible-4', 'visible-5', 'visible-6', 'visible-7']);

    const statuses = [{ status: 'worldbook-read-failed', text: '' }];
    const readyPrecheck = precheckHarness({ status: 'ready', text: '预检时可用' });
    const ready = await readyPrecheck.memoryPreCheckConfirm({});
    assert.equal(ready.proceed, true);
    assert.equal(ready.memorySnapshot.status, 'read-required');
    const externalRead = evaluate(externalReadRegion, '_getMemTextRaw', {
        getSettings: () => ({ useDatabase: true }),
        databaseMemoryAccess: { result: async () => statuses.shift() },
        makeDiagnosticError: code => Object.assign(new Error(code), { diagnosticCode: code }),
        safeDiagnosticLog: () => ({}), console: { warn() {} },
    });
    let apiDispatches = 0;
    let dispatchedSource;
    const generate = async () => {
        await buildHarness({ getMemText: options => { dispatchedSource = options.source; return externalRead(options); } })({ chat, characters: {}, characterId: 0 }, 'prompt', '用户', '角色', 3, { memorySnapshot: ready.memorySnapshot });
        apiDispatches++;
    };
    await assert.rejects(generate(), error => error.diagnosticCode === 'memory-read');
    assert.equal(dispatchedSource, 'database');
    assert.equal(apiDispatches, 0);
});

test('official external success-empty stays empty, while Anima and 柏宝书 read exceptions propagate', async () => {
    const readDatabase = status => evaluate(externalReadRegion, '_getMemTextRaw', {
        getSettings: () => ({ useDatabase: true }), databaseMemoryAccess: { result: async () => status },
        makeDiagnosticError: code => Object.assign(new Error(code), { diagnosticCode: code }),
        safeDiagnosticLog: () => ({}), console: { warn() {} },
    });
    assert.equal(await readDatabase({ status: 'empty-content', text: '' })(), '');
    await assert.rejects(readDatabase({ status: 'invalid-response', text: '' })(), error => error.diagnosticCode === 'memory-read');

    const anima = evaluate(externalReadRegion, '_getMemTextRaw', {
        getSettings: () => ({ useAnima: true }), getAnimaMemText: async () => { throw new Error('read'); },
        makeDiagnosticError: code => Object.assign(new Error(code), { diagnosticCode: code }),
        safeDiagnosticLog: () => ({}), console: { warn() {} },
    });
    await assert.rejects(anima(), error => error.diagnosticCode === 'memory-read');

    const bbb = evaluate(externalReadRegion, '_getMemTextRaw', {
        getSettings: () => ({ useBaiBaiBook: true }),
        globalThis: { STBaiBaiBook: { getInjectedHistory() { throw new Error('read'); } } },
        getMemText() {}, makeDiagnosticError: code => Object.assign(new Error(code), { diagnosticCode: code }),
        safeDiagnosticLog: () => ({}), console: { warn() {} },
    });
    await assert.rejects(bbb(), error => error.diagnosticCode === 'memory-read');
});

test('creative-chat database legal empty uses existing recent history; genuine read failure remains an error', async () => {
    const discussionRegion = region('function outlineChatMemoryError(message) {', 'async function composeCreativeChatMessages(');
    const createReader = result => evaluate(discussionRegion, 'readCreativeChatMemory', {
        creativeChatMemorySelectionCurrent: () => true,
        databaseMemoryAccess: { result: async () => result },
        databaseMemoryDiagnostic: value => `数据库原因:${value.status}`,
    });
    const input = { ctx: {}, userMsg: '继续讨论', selection: { source: 'database' } };
    assert.deepEqual(JSON.parse(JSON.stringify(await createReader({ status: 'no-match', text: '' })(input))), { text: '', recentFallback: true });
    assert.deepEqual(JSON.parse(JSON.stringify(await createReader({ status: 'empty-content', text: '' })(input))), { text: '', recentFallback: true });
    await assert.rejects(createReader({ status: 'worldbook-read-failed', text: '' })(input), /数据库原因:worldbook-read-failed/);
});

test('worldbook read exceptions are reported while successful books remain injectable', async () => {
    const getEntries = evaluate(region('async function getCharBookEntries(ctx, { includeExcluded = false } = {}) {', '// 近期聊天上下文补足'), 'getCharBookEntries', {
        getLinkedWorldNames: () => ['坏书', '好书', '排除书'], getChatWorldNames: () => [], getGlobalWorldNames: () => [],
        getWiExcludeSet: () => new Set(['排除书']), hasWiExcluded: (name, excluded) => excluded.has(name),
    });
    const calls = [];
    const ctx = {
        loadWorldInfo: async name => { calls.push(name); if (name === '坏书') throw new Error('read failed'); if (name === '坏 persona') return { entries: null }; return { entries: { 1: { comment: '可用条目', content: '成功材料' } } }; },
        characters: [], characterId: 0, powerUserSettings: { persona_description_lorebook: '坏 persona' },
    };
    const loaded = await getEntries(ctx);
    assert.deepEqual(calls, ['坏书', '好书', '排除书', '坏 persona']);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].content, '成功材料');
    assert.equal(loaded.loadFailures.length, 2);
    assert.equal(loaded.loadFailures[0].name, '坏书');
    assert.equal(loaded.loadFailures[1].name, '坏 persona');

    const completeRegion = region('async function buildWorldInfoContext(ctx, { triggerText', '// Read Anima\'s summary layer');
    const entries = loaded;
    const notices = [];
    const contextBuilder = evaluate(completeRegion, 'buildWorldInfoContext', {
        reportPhase() {}, WORLD_INFO_ALL_ROLES: /$a/, WORLD_INFO_GROUP_INFO_TOPIC: /$a/,
        WORLD_INFO_SCAN_BUDGET: 100,
        getCharBookEntries: async () => entries, getWiExcludeSet: () => new Set(), hasWiExcluded: () => false,
        ensureCurrentWiSelection: () => ({}), worldInfoSelectionAllows: () => true,
        worldInfoCandidateKey: (world, uid) => `${world}::${uid}`,
        resolveWorldInfoActivation: async () => ({ failed: false, keys: new Set(['好书::1']) }),
        worldInfoCore: { world_info_budget_cap: 0, world_info_budget: 100 },
        showToast: message => notices.push(message), safeDiagnosticLog: () => ({ code: 'worldbook-read-failed' }),
        console: { warn() {}, info() {} }, estimateWorldInfoTokens: () => ({ tokens: 4, exact: false }),
    });
    const context = await contextBuilder(ctx);
    assert.match(context, /成功材料/);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /有世界书未能读取/);
    assert.match(notices[0], /本次材料可能不完整/);
    assert.doesNotMatch(notices[0], /已读取的书仍会参与生成/);
});

test('世界书设置列表在全失败或部分失败时提示异常，并保留本次成功条目', async () => {
    const renderRegion = region('async function renderWiList() {', 'function syncWiSelectAll() {');
    for (const entries of [
        Object.assign([], { loadFailures: [{ name: '坏书', scope: 'char' }] }),
        Object.assign([{ key: '好书::1', scope: 'char', source: '好书', label: '已有条目', preview: '成功正文', content: '成功正文' }], { loadFailures: [{ name: '坏书', scope: 'chat' }] }),
    ]) {
        const list = [{ innerHTML: '' }];
        list.find = () => ({ each() {} });
        list.html = value => { list[0].innerHTML = value; return list; };
        list.off = () => list;
        list.on = () => list;
        let reads = 0;
        const render = evaluate(renderRegion, 'renderWiList', {
            getContext: () => ({}), $in: () => list, _wiListRevision: 0, _wiListIdentity: () => 'same',
            _wiScrollParent: () => null, getCharBookEntries: async () => { reads++; return entries; },
            ensureCurrentWiSelection: () => ({}), worldInfoSelectionAllows: () => true,
            escapeHtml: value => String(value ?? ''), escapeAttr: value => String(value ?? ''),
            _wiEntryCache: new Map(), syncWiSelectAll() {}, $() { return {}; },
        });
        await render();
        assert.equal(reads, 1, '设置列表只消费本次读取结果');
        assert.match(list[0].innerHTML, /有世界书未能读取，当前列表可能不完整/);
        assert.doesNotMatch(list[0].innerHTML, /当前角色没有关联 \/ 全局启用的世界书/);
        if (entries.length) assert.match(list[0].innerHTML, /成功正文|已有条目/);
    }
});
