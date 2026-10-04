import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('new-chat migration still checks its actual storage identity after the backend await', async () => {
    const region = productionFunctions('function storageChatIdentity() {', 'function storageRow(label, bytesText, btnHtml = \'\', extraClass = \'\') {');
    const makeHarness = () => {
        const migration = deferred();
        const context = { chatId: 'new-chat', chatMetadata: {} };
        const calls = { migration: 0, storageUsage: 0, storageMode: 0, toasts: 0 };
        let excluded = false;
        const sandbox = {
            getContext: () => context,
            currentCharacterExcluded: () => excluded,
            storageStatus: () => ({ mode: 'chat' }), isExternalReady: () => false,
            migrateCurrentChat: () => { calls.migration++; return migration.promise; },
            renderStorageUsage: () => { calls.storageUsage++; },
            renderCurrentChatStorageMode: () => { calls.storageMode++; },
            showToast: () => { calls.toasts++; },
        };
        return { calls, context, migration, sandbox, setExcluded: value => { excluded = value; } };
    };

    const unchanged = makeHarness();
    const handle = evaluateFunctionRegion(region, 'handleNewChatStorage', unchanged.sandbox);
    const task = handle();
    unchanged.migration.resolve({ ok: true, commitState: 'confirmed' });
    const result = await task;
    assert.equal(result.mode, 'external');
    assert.equal(unchanged.calls.migration, 1);
    assert.equal(unchanged.calls.storageUsage, 1);

    const changed = makeHarness();
    const handleChanged = evaluateFunctionRegion(region, 'handleNewChatStorage', changed.sandbox);
    const changedTask = handleChanged();
    changed.context.chatId = 'next-chat';
    changed.context.chatMetadata = {};
    changed.migration.resolve({ ok: true, commitState: 'confirmed' });
    const changedResult = await changedTask;
    assert.equal(changedResult.mode, 'blocked');
    assert.equal(changedResult.result.reason, 'chat-changed');
    assert.equal(changed.calls.storageUsage, 0);
});
