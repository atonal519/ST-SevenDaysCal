import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { icon } from '../utils/icons.js';
import { fileURLToPath } from 'node:url';
import { selectVisibleChatHistory } from '../business/lines/history.js';
import { getSharedBodyWrappers } from '../utils/shared-body-wrappers.js';
import { createQianQianJieMemoryAccess, QIANQIANJIE_BRIDGE_KEY } from '../business/memory/qianqianjie.js';

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
const worldInfoContextRegion = region('async function buildWorldInfoContext(ctx, { triggerText', "// Read Anima's summary layer");

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

function buildHarness({ getMemText, settings = { useDatabase: true, useAnima: false, useBaiBaiBook: false, useQianQianJie: false }, qianQianJieGenerationSnapshotCurrent = () => false }) {
    const historyBuilder = evaluate(indexHistory, 'buildGenerationHistoryContext', {
        getSettings: () => ({ keepTags: '', extraTags: '' }),
        getWrapperSettings: () => getSharedBodyWrappers({}),
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
        getSettings: () => ({ ...settings, keepTags: '', extraTags: '' }),
        getAlmanacInjectText: () => '', resolveAlmanacContextText: () => '', getCalDescInjectText: () => '',
        sanitizeGenerationContextText: value => String(value ?? ''),
        isConfirmedMemoryFallback: snapshot => snapshot?.status === 'fallback-confirmed'
            && ['database', 'anima', 'bai-bai-book'].includes(snapshot.source),
        isMemoryReadSnapshot: snapshot => snapshot?.status === 'read-required'
            && ['database', 'anima', 'bai-bai-book'].includes(snapshot.source),
        qianQianJieGenerationSnapshotCurrent,
        makeDiagnosticError: () => stale,
        getMemText,
    });
}

test('QQJ prequel and recall from the production snapshot reach the final shared message once without a second read', async () => {
    const ctx = { chatId: 'chat-a', characters: [{ avatar: 'character-a.png' }], characterId: 0, userAvatar: 'persona-a.png', chat: [] };
    const participant = { chatId: 'chat-a', characterId: 0, characterKey: 'character-a.png', personaKey: 'persona-a.png', userName: '用户', charName: '角色' };
    const hostIdentity = { hostChatId: 'chat-a', characterLocator: 'character-a.png', personaLocator: 'persona-a.png' };
    const promptParts = {
        prequel: '【用户导入的过去经历资料】\n可信前情边界\n【前情片段 1】过去经历内容',
        recall: '<qqj_recalled_context>\n当前召回内容\n</qqj_recalled_context>',
    };
    let snapshotReads = 0;
    const bridge = {
        schemaVersion: 1, kind: 'qqj-public-memory-bridge',
        getPromptSnapshot() {
            snapshotReads++;
            return { status: 'ready', identity: hostIdentity, prequel: { text: promptParts.prequel }, recall: { text: promptParts.recall } };
        },
    };
    const access = createQianQianJieMemoryAccess({
        globalRef: { [QIANQIANJIE_BRIDGE_KEY]: bridge }, contextProvider: () => ctx,
        participantIdentityProvider: () => participant, isSelected: () => true,
        writeCache: () => ({ ok: true, commitState: 'confirmed' }),
    });
    const titles = [];
    const productionPrecheck = evaluate(memorySetup, '({ memoryPreCheckConfirm, qianQianJieGenerationSnapshotCurrent })', {
        QQJ_MEMORY_SNAPSHOT_VERSION: 1, memorySourceEpoch: 1,
        getSettings: () => ({ useQianQianJie: true }), getContext: () => ctx,
        captureParticipantIdentity: () => participant, sameParticipantIdentity: () => true,
        captureQianQianJieHostIdentity: () => hostIdentity, sameQianQianJieHostIdentity: () => true,
        qianQianJieMemoryAccess: access, qianQianJieMemoryDiagnostic: () => '记忆读取失败',
        spConfirm: async options => { titles.push(options.title); return true; },
    });
    const operationToken = Symbol('generation');
    const preflight = await productionPrecheck.memoryPreCheckConfirm({ operationToken, contextSnapshot: ctx, participantIdentity: participant });
    assert.equal(preflight.proceed, true);
    assert.deepEqual(titles, [], 'usable prequel/recall does not open the empty-material confirmation');
    assert.equal(snapshotReads, 1);

    const build = buildHarness({
        getMemText: async () => { throw new Error('preflight snapshot must prevent a second memory read'); },
        settings: { useQianQianJie: true },
        qianQianJieGenerationSnapshotCurrent: productionPrecheck.qianQianJieGenerationSnapshotCurrent,
    });
    const messages = await build(ctx, '继续创作', '用户', '角色', 3, { memoryOperationToken: operationToken, memorySnapshot: preflight.memorySnapshot });
    const finalInput = messages.map(message => message.content).join('\n');
    assert.equal(finalInput.split(promptParts.prequel).length - 1, 1);
    assert.equal(finalInput.split(promptParts.recall).length - 1, 1);
    assert.equal(snapshotReads, 1, 'final input uses the already-read preflight snapshot');
});

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

test('worldbook query without a trusted person roster keeps the original query', async () => {
    const runQuery = ({ names = [], recognized = true, failRead = false } = {}) => {
        const activations = [];
        const notices = [];
        const build = evaluate(worldInfoContextRegion, 'buildWorldInfoContext', {
            WORLD_INFO_ALL_ROLES: /(?:全部角色|所有人物)/u,
            WORLD_INFO_GROUP_INFO_TOPIC: /(?:背景|人设)/u,
            WORLD_INFO_SCAN_BUDGET: 100,
            getCharBookEntries: async () => {
                if (failRead) throw new Error('worldbook-read-failed');
                return [];
            },
            getWiExcludeSet: () => new Set(), hasWiExcluded: () => false,
            ensureCurrentWiSelection: () => ({}), worldInfoSelectionAllows: () => true,
            resolveWorldInfoGroupReference: () => ({ recognized, names }),
            worldInfoReferenceTriggerText: (query, roster) => `${query} ${roster.join(' ')}`,
            showToast: (...args) => notices.push(args),
            safeDiagnosticLog: () => ({}), console: { warn() {}, info() {} },
            worldInfoCandidateKey: (world, uid) => `${world}::${uid}`,
            resolveWorldInfoActivation: async (_ctx, coreChat, options) => {
                activations.push({ coreChat, options });
                return { failed: false, keys: new Set() };
            },
            worldInfoCore: { world_info_budget_cap: 0, world_info_budget: 100 },
            countWorldInfoTokens: async text => ({ tokens: Math.ceil(String(text).length / 4) }),
            worldInfoTitleMatches: () => false, worldInfoTitleSupplementAllows: () => false,
            worldInfoPersonTitleMatches: () => false, estimateWorldInfoTokens: () => ({ tokens: 0, exact: true }),
            notifyWorldInfoActivationFailure() {},
        });
        return { build, activations, notices };
    };
    const query = async (text, options = {}) => {
        const harness = runQuery(options);
        await harness.build({}, { triggerText: text, triggerMode: 'query', referenceHistory: [] });
        assert.equal(harness.notices.length, 0);
        assert.equal(harness.activations.length, 1);
        return harness.activations[0].coreChat[0].mes;
    };

    const request = '把他们的背景写进面大纲，张三和李四';
    assert.equal(await query(request), request);
    assert.equal(await query('全部角色的背景是什么'), '全部角色的背景是什么');
    assert.equal(await query('这五个的背景是什么'), '这五个的背景是什么');
    assert.equal(await query('他们的背景是什么', { names: ['陆飞星', '林薇'] }), '他们的背景是什么 陆飞星 林薇');
    assert.equal(await query('他们呢', { recognized: false }), '他们呢');

    const failed = runQuery({ failRead: true });
    await assert.rejects(failed.build({}, { triggerText: request, triggerMode: 'query', referenceHistory: [] }), /worldbook-read-failed/);
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
            icon,
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
