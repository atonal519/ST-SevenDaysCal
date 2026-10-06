import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectVisibleChatHistory } from '../business/lines/history.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');

function productionFunctions(startMarker, endMarker) {
    const start = indexSource.indexOf(startMarker);
    const end = indexSource.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `production source region found: ${startMarker}`);
    return indexSource.slice(start, end);
}

function evaluateFunctionRegion(region, expression, sandbox = {}) {
    return vm.runInNewContext(`${region}\n${expression}`, sandbox);
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('delayed chat UI callback runs against the live view without a boundary reference error', () => {
    const timers = [];
    const schedule = evaluateFunctionRegion(
        productionFunctions('function scheduleForChatBoundary(callback, delay) {', 'function latestFloorBoundaryIdentity() {'),
        'scheduleForChatBoundary',
        { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; } },
    );
    let calls = 0;
    schedule(() => { calls++; }, 300);
    assert.equal(calls, 0);
    assert.equal(timers[0].delay, 300);
    assert.doesNotThrow(() => timers[0].callback());
    assert.equal(calls, 1);
});

test('exclusion restore refreshes the current view after await but still stops if the live character is excluded', async () => {
    const region = productionFunctions('async function restoreCurrentCharacterAfterExclusion() {', 'function getLegacyWiFilter() {');
    const chain = { removeClass() { return this; }, addClass() { return this; }, show() { return this; }, hide() { return this; }, empty() { return this; }, text() { return this; } };
    const makeHarness = () => {
        const load = deferred();
        const calls = { migration: [], bodies: [], load: 0 };
        const context = { chatId: 'before-await', chatMetadata: {} };
        let excluded = false;
        const sandbox = {
            getContext: () => context,
            loadExternalChat: () => { calls.load++; return load.promise; },
            currentCharacterExcluded: () => excluded,
            store: { migrateChatFromLocalStorage: chatId => { calls.migration.push(chatId); return { status: 'none' }; } },
            scheduleForChatBoundary() {}, pointState: {},
            loadCachedForCurrentChat: () => `cache:${context.chatId}`,
            pluginEnabled: () => true, applyPluginEnabled() {},
            coordinateRuntime: { feature: { close() {} } },
            $in: () => chain, $inAll: () => chain,
            closeTaDrawer() {}, updateTaTriggerLabel() {}, setBody: body => calls.bodies.push(body),
            renderMemorySection() {}, renderStorageUsage() {}, renderCurrentChatStorageMode() {},
        };
        return { calls, context, load, sandbox, setExcluded: value => { excluded = value; } };
    };

    const switched = makeHarness();
    const restore = evaluateFunctionRegion(region, 'restoreCurrentCharacterAfterExclusion', switched.sandbox);
    const restoring = restore();
    switched.context.chatId = 'current-after-await';
    switched.context.chatMetadata = {};
    switched.load.resolve();
    assert.equal(await restoring, true);
    assert.deepEqual(switched.calls.migration, ['current-after-await']);
    assert.ok(switched.calls.bodies.some(body => body === 'cache:current-after-await'));

    const excluded = makeHarness();
    const restoreExcluded = evaluateFunctionRegion(region, 'restoreCurrentCharacterAfterExclusion', excluded.sandbox);
    const excludedRestore = restoreExcluded();
    excluded.setExcluded(true);
    excluded.load.resolve();
    assert.equal(await excludedRestore, false);
    assert.deepEqual(excluded.calls.migration, []);
});

test('chat creation events have no automatic backend migration listener; chat-change wiring remains', () => {
    const region = productionFunctions('if (_stListeners.chat) eventSource.removeListener?.(event_types.CHAT_CHANGED, _stListeners.chat);', '// 初始化时当前聊天可能已经 ready');
    const registrations = [];
    const removed = [];
    const eventSource = {
        on: (type, handler) => registrations.push([type, handler]),
        removeListener: (type, handler) => removed.push([type, handler]),
    };
    const sandbox = {
        _stListeners: { chat: null, diagnosticRetention: null, externalSnapshotPrune: null },
        eventSource,
        event_types: { CHAT_CHANGED: 'chat-changed', CHAT_CREATED: 'chat-created', GROUP_CHAT_CREATED: 'group-chat-created', CHARACTER_MESSAGE_RENDERED: 'rendered', MESSAGE_DELETED: 'deleted' },
        refreshNarrativePacePrompt() {}, currentCharacterExcluded: () => false,
        refreshDiagnosticRetention() {}, getContext: () => ({ chat: [] }), isExternalMode: () => false,
        pruneExternalSnapshots() {},
    };
    evaluateFunctionRegion(region, 'undefined', sandbox);
    assert.deepEqual(registrations.map(([type]) => type), ['chat-changed', 'rendered', 'deleted']);
    assert.ok(!registrations.some(([type]) => type === 'chat-created' || type === 'group-chat-created'));
    assert.equal(removed.length, 0);
    assert.equal(indexSource.includes('handleNewChatStorage'), false);
    assert.equal(indexSource.includes('routeChatStorageToAvailableBackend'), false);
});

test('confirmed portable import to an empty normal chat commits through its current storage mode', async () => {
    const region = productionFunctions('async function importPortableFile(file, identity) {', 'async function exportCurrentChatDiagnosticPackage() {');
    const calls = { commit: [], migration: 0, route: 0, abort: 0, refreshed: 0 };
    const sandbox = {
        PORTABLE_CHAT_MAX_BYTES: 1024,
        portableStorageAvailable: () => true,
        parsePortableChatPackage: () => ({ ok: true, package: { selectedModules: ['lines'], modules: { lines: { entries: {} } } } }),
        customDialog: {
            selectMany: async () => ({ values: ['lines'] }),
            choose: async () => 'apply',
        },
        currentPortableRoots: () => ({ 'sp-store': null, 'sp-theater': null }),
        createPortableImportPlan: () => ({ ok: true, existingModules: [] }),
        portableModuleLabel: () => '线', portableModuleSummary: () => '0 项',
        abortPortableImportTasks: () => { calls.abort++; },
        mountPortableImportOverlay: () => ({ close() {}, unknown() { throw new Error('unexpected unknown import state'); } }),
        commitPortableImport: async value => { calls.commit.push(value); return { ok: true, commitState: 'local-applied' }; },
        refreshPortableImportedModules: () => { calls.refreshed++; }, showToast() {},
        storageStatus: () => { calls.route++; throw new Error('import must not probe storage routing'); },
        migrateCurrentChat: () => { calls.migration++; throw new Error('import must not migrate'); },
        routeChatStorageToAvailableBackend: () => { calls.route++; throw new Error('import must not route'); },
    };
    const importFile = evaluateFunctionRegion(region, 'importPortableFile', sandbox);
    await importFile({ size: 10, text: async () => '{}' }, { chatId: 'empty-normal-chat' });
    assert.equal(calls.commit.length, 1);
    assert.equal(calls.commit[0].identity.chatId, 'empty-normal-chat');
    assert.deepEqual(JSON.parse(JSON.stringify(calls.commit[0].originalRoots)), { 'sp-store': null, 'sp-theater': null });
    assert.equal(calls.migration, 0);
    assert.equal(calls.route, 0);
    assert.equal(calls.abort, 1);
    assert.equal(calls.refreshed, 1);
});

test('generation history carries real mesids only for internal memory exclusion, not API messages', () => {
    const region = productionFunctions('function buildRecentGenerationHistory(ctx, historyLimit, opts = {}) {', 'function outlineWorldInfoTriggerText(history) {');
    const context = evaluateFunctionRegion(region, 'buildGenerationHistoryContext', {
        getSettings: () => ({ keepTags: '', extraTags: '' }),
        selectVisibleChatHistory,
        substituteParams: value => value,
        sanitizeGenerationContextText: value => String(value).replace(/<erase>[\s\S]*?<\/erase>/g, ''),
        memory: { stripTags: value => value },
    });
    const chat = [
        { mes: 'older AI' },
        { is_user: true, mes: 'user turn' },
        { mes: 'recent one' },
        { mes: 'recent <erase>hidden</erase>' },
        { mes: 'recent three' },
        { mes: 'hidden AI', is_hidden: true },
        { mes: 'system', role: 'system' },
    ];
    const selected = context({ chat }, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(selected.excludeMesIds)), [2, 3, 4]);
    assert.deepEqual(JSON.parse(JSON.stringify(selected.history)), [
        { role: 'assistant', content: 'recent one' },
        { role: 'assistant', content: 'recent ' },
        { role: 'assistant', content: 'recent three' },
    ]);
    assert.equal(selected.history.some(message => Object.hasOwn(message, 'mesId')), false);
});

test('discussion recent-floor ids are computed from the exact sanitized visible messages', () => {
    const region = productionFunctions('function buildRecentChatEntries(ctx, floorCount = 6, perMessageChars = 2500) {', 'function worldInfoMaxContext(ctx) {');
    const helpers = evaluateFunctionRegion(region, '({ buildRecentChatEntries, getRecentVisibleFloorIds })', {
        getSettings: () => ({ keepTags: '', extraTags: '' }),
        selectVisibleChatHistory,
        memory: { stripTags: value => String(value).replace(/<erase>[\s\S]*?<\/erase>/g, '') },
    });
    const chat = [
        { mes: 'old AI' },
        { is_user: true, mes: 'user' },
        { mes: '<erase>only hidden content</erase>' },
        { mes: 'recent one' },
        { mes: 'recent two' },
        { mes: 'hidden AI', is_hidden: true },
        { mes: 'recent three' },
        { mes: 'system', role: 'system' },
    ];
    const entries = helpers.buildRecentChatEntries({ chat, name2: '角色' }, 4, Infinity);
    assert.deepEqual(JSON.parse(JSON.stringify(entries.map(entry => entry.mesId))), [3, 4, 6]);
    assert.deepEqual(JSON.parse(JSON.stringify(helpers.getRecentVisibleFloorIds({ chat, name2: '角色' }, 4))), [3, 4, 6]);
    assert.deepEqual(JSON.parse(JSON.stringify(entries.map(entry => entry.text))), ['【角色】recent one', '【角色】recent two', '【角色】recent three']);
});

test('built-in memory receives exclusion ids while alternate source options stay unchanged', async () => {
    const region = productionFunctions('async function _getMemTextRaw(opts = {}) {', '// 记忆源先按各自的召回规则选材');
    const builtinCalls = [];
    const readBuiltin = evaluateFunctionRegion(region, '_getMemTextRaw', {
        getSettings: () => ({}),
        memory: { getMemoryContext: opts => { builtinCalls.push(opts); return 'built-in'; } },
    });
    assert.equal(await readBuiltin({ query: 'prompt', excludeMesIds: [3, 4, 5] }), 'built-in');
    assert.deepEqual(JSON.parse(JSON.stringify(builtinCalls)), [{ excludeMesIds: [3, 4, 5], includeRecentRaw: true }]);

    let externalOptions;
    const readExternal = evaluateFunctionRegion(region, '_getMemTextRaw', {
        getSettings: () => ({ useAnima: true }),
        getAnimaMemText: async opts => { externalOptions = opts; return 'external'; },
    });
    assert.equal(await readExternal({ query: 'prompt', excludeMesIds: [3, 4, 5] }), 'external');
    assert.deepEqual(JSON.parse(JSON.stringify(externalOptions)), { query: 'prompt' });
});

test('menu buildMessages with includeMemory false skips the memory reader before any fetch', async () => {
    const region = productionFunctions('async function buildMessages(ctx, prompt, userName, charName, historyLimit = 3, opts = {}) {', '// ─── Inject');
    let reads = 0;
    const build = evaluateFunctionRegion(region, 'buildMessages', {
        buildGenerationHistoryContext: () => ({ history: [], excludeMesIds: [] }),
        buildWorldInfoContext: async () => '',
        readCardExtras: () => ({ personaDesc: '', authorNote: '' }),
        getSettings: () => ({}),
        getAlmanacInjectText: () => '',
        resolveAlmanacContextText: () => '',
        getCalDescInjectText: () => '',
        getMemText: async () => { reads++; throw new Error('memory should be skipped'); },
    });
    const messages = await build({ characters: {}, characterId: 0 }, 'menu prompt', '用户', '角色', 3, { includeMemory: false });
    assert.equal(reads, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
        { role: 'system', content: '你是一位旁观者和叙事分析助手，负责以第三人称视角分析 用户 与 角色 的故事。\n\n不要扮演任何角色，不要使用第一人称。所有输出必须以第三人称叙述。' },
        { role: 'user', content: 'menu prompt' },
    ]);
});

test('buildMessages passes internal recent ids to memory but returns only API role/content fields', async () => {
    const region = productionFunctions('async function buildMessages(ctx, prompt, userName, charName, historyLimit = 3, opts = {}) {', '// ─── Inject');
    let memoryOptions;
    const build = evaluateFunctionRegion(region, 'buildMessages', {
        buildGenerationHistoryContext: () => ({ history: [{ role: 'assistant', content: 'recent floor' }], excludeMesIds: [7, 8, 9] }),
        buildWorldInfoContext: async () => '',
        readCardExtras: () => ({ personaDesc: '', authorNote: '' }),
        getSettings: () => ({}),
        getAlmanacInjectText: () => '',
        resolveAlmanacContextText: () => '',
        getCalDescInjectText: () => '',
        sanitizeGenerationContextText: value => value,
        getMemText: async opts => { memoryOptions = opts; return 'memory'; },
    });
    const messages = await build({ characters: {}, characterId: 0 }, 'prompt', '用户', '角色', 3, {});
    assert.deepEqual(JSON.parse(JSON.stringify(memoryOptions.excludeMesIds)), [7, 8, 9]);
    assert.equal(messages.some(message => Object.hasOwn(message, 'mesId')), false);
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-2))), { role: 'assistant', content: 'recent floor' });
});

test('creative outline memory read uses the matching recent-six visible floor ids', async () => {
    const region = productionFunctions('async function readCreativeChatMemory({ ctx, userMsg, signal, selection, excludeMesIds = [] }) {', 'async function composeCreativeChatMessages(');
    let options;
    const read = evaluateFunctionRegion(region, 'readCreativeChatMemory', {
        memoryPreCheckConfirm: async () => true,
        creativeChatMemorySelectionCurrent: () => true,
        getMemText: async opts => { options = opts; return 'builtin'; },
        outlineChatMemoryError: message => new Error(message),
    });
    const result = await read({ ctx: {}, userMsg: '讨论', selection: { source: 'builtin' }, excludeMesIds: [12, 14, 15, 16, 17, 18] });
    assert.equal(result.text, 'builtin');
    assert.deepEqual(JSON.parse(JSON.stringify(options)), { query: '讨论', excludeMesIds: [12, 14, 15, 16, 17, 18] });
});
