import test from 'node:test';
import assert from 'node:assert/strict';
import { captureMetadataIntentBefore, createBestEffortMetadataSaver, createTargetMetadataSaver, createTargetSnapshotRefresher, dispatchTargetMetadataWithRefresh } from '../../runtime/target-metadata-save.js';
import { safeSaveDiagnosticFields, sanitizeDiagnosticRecord, readDiagnosticTrace } from '../../runtime/diagnostic-trace.js';
import { safeDiagnosticLog } from '../../api/diagnostics.js';
import { createLinesGenerationController } from './controller.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { createDeadlineSignal } from '../../runtime/deadline.js';
import { drawTickets } from './vectors/draw.js';
import { bindExternalChatStorage, getChatRoot, loadExternalChat, persistExternalRoots, registerExternalStorageContext, recordDiagnosticAttempt, storageStatus } from '../../runtime/external-chat-storage.js';
import { compare, applyPatch } from '../../../../../util/fast-json-patch.js';

const path = '/sp-store/data/lines-user';
const initial = () => ({ integrity: 'i1', 'sp-store': { version: 1, data: { 'lines-user': { raw: 'old', ts: 1, history: [] }, 'diagnostics-v1': { floors: [{ result: 'pending' }] }, 'outline-user': { raw: 'old outline' } } }, 'sp-ledger': { entries: ['old ledger'] }, variables: { old: true } });
function harness(before = initial(), { mutate = () => {}, response = 'success' } = {}) {
    let snapshot = structuredClone(before), server = structuredClone(before);
    const requests = [];
    const core = {
        resolveChatStateTarget: () => ({ is_group: false, avatar_url: 'fixture', file_name: 'fixture', char_name: 'fixture' }),
        getChatMetadataSnapshot: () => structuredClone(snapshot),
        runSerializedChatWrite: async task => { mutate(snapshot, server); return task(); },
        buildChatMetadataPatchOperationsAsync: async (a, b) => { delete a.integrity; delete b.integrity; return compare(a, b); },
        getRequestHeaders: () => ({}), invalidateChatWriteSnapshot() {}, applyIntegrityFromWritePayloadToTarget() {},
        seedChatMetadataSnapshot: (_target, value) => { snapshot = structuredClone(value); },
    };
    const saver = createTargetMetadataSaver({ coreModule: core, fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        if (response === 'network') throw new Error('synthetic network failure');
        if (response !== 'success') return { ok: false, status: response };
        server = applyPatch(server, body.operations).newDocument; server.integrity = 'i2';
        return { ok: true, json: async () => ({ ok: true, integrity: 'i2' }) };
    } });
    return { saver, requests, server: () => structuredClone(server), setSnapshot: value => { snapshot = structuredClone(value); } };
}
const intent = before => ({ intentPaths: [path], intentBefore: captureMetadataIntentBefore(before, [path]) });
function staged(before) {
    const after = structuredClone(before);
    after['sp-store'].data['lines-user'] = { raw: 'candidate', ts: 2, history: [{ raw: 'old' }] };
    after['sp-store'].data['diagnostics-v1'].floors[0].result = 'accepted';
    after['sp-store'].data['outline-user'].raw = 'incidental live outline';
    after['sp-ledger'].entries = ['incidental live ledger'];
    return after;
}

function boundedSaverFixture(phase) {
    let snapshot = initial(); let tail = Promise.resolve(); let callbacksSettled = 0; let seeds = 0; let invalidations = 0; let fetches = 0;
    let resolveLate;
    const core = {
        resolveChatStateTarget: () => ({ is_group: false, avatar_url: 'fixture', file_name: 'fixture', char_name: 'fixture' }),
        getChatMetadataSnapshot: () => structuredClone(snapshot),
        runSerializedChatWrite(task) {
            const result = tail.then(async () => { try { return await task(); } finally { callbacksSettled++; } });
            tail = result.then(() => undefined, () => undefined);
            return result;
        },
        buildChatMetadataPatchOperationsAsync: async (a, b) => {
            if (phase === 'build') await new Promise(resolve => { resolveLate = resolve; });
            delete a.integrity; delete b.integrity; return compare(a, b);
        },
        getRequestHeaders: () => ({}),
        invalidateChatWriteSnapshot() { invalidations++; },
        applyIntegrityFromWritePayloadToTarget() {},
        seedChatMetadataSnapshot(_target, value) { seeds++; snapshot = structuredClone(value); },
    };
    const saver = createTargetMetadataSaver({ coreModule: core, fetchImpl: async () => {
        fetches++;
        if (phase === 'fetch') return await new Promise(resolve => { resolveLate = resolve; });
        if (phase === 'json') return { ok: true, json: () => new Promise(resolve => { resolveLate = resolve; }) };
        return { ok: true, json: async () => ({ ok: true, integrity: 'i2' }) };
    } });
    return { core, saver, counts: () => ({ callbacksSettled, seeds, invalidations, fetches }), waitQueue: () => tail, releaseLate: value => resolveLate?.(value) };
}

test('line intent rebases on latest diagnostics, other modules and ledger without carrying incidental changes', async () => {
    const before = initial();
    const h = harness(before, { mutate(snapshot, server) {
        for (const value of [snapshot, server]) {
            value.integrity = 'concurrent';
            value['sp-store'].data['diagnostics-v1'].floors[0].otherModule = 'new diagnostic';
            value['sp-store'].data['outline-user'].raw = 'latest outline';
            value['sp-ledger'].entries = ['latest ledger'];
            value.variables.new = true;
        }
    } });
    const result = await dispatchTargetMetadataWithRefresh({ saver: h.saver, target: {}, afterMetadata: staged(before), ...intent(before) });
    assert.equal(result.commitState, 'confirmed'); assert.equal(h.requests.length, 1);
    const saved = h.server();
    assert.equal(saved['sp-store'].data['lines-user'].raw, 'candidate');
    assert.deepEqual(saved['sp-store'].data['diagnostics-v1'], { floors: [{ result: 'pending', otherModule: 'new diagnostic' }] });
    assert.equal(saved['sp-store'].data['outline-user'].raw, 'latest outline');
    assert.deepEqual(saved['sp-ledger'].entries, ['latest ledger']); assert.equal(saved.variables.new, true);
    assert.ok(h.requests[0].operations.every(op => op.path === '/integrity' || op.path === path || op.path.startsWith(path + '/')));
});

test('full line version conflicts remain rejected even if only concurrent history changed', async () => {
    const before = initial();
    const h = harness(before, { mutate(snapshot) { snapshot['sp-store'].data['lines-user'].history.push({ raw: 'manual history' }); } });
    const result = await h.saver.dispatch(h.saver.capture({}, staged(before), intent(before)));
    assert.equal(result.reason, 'owned-conflict'); assert.equal(result.path, path); assert.equal(h.requests.length, 0);
});

test('new line root contains schema foundation and only the requested key', async () => {
    const h = harness({ integrity: 'i1', 'sp-ledger': { entries: [] } });
    const after = { integrity: 'i1', 'sp-store': { version: 1, data: { 'lines-user': { raw: 'candidate' }, 'diagnostics-v1': { private: 'incidental' } } }, 'sp-ledger': { entries: ['incidental'] } };
    const result = await dispatchTargetMetadataWithRefresh({ saver: h.saver, target: {}, afterMetadata: after, ...intent({}) });
    assert.equal(result.ok, true);
    assert.deepEqual(h.server()['sp-store'], { version: 1, data: { 'lines-user': { raw: 'candidate' } } });
    assert.deepEqual(h.server()['sp-ledger'], { entries: [] });
});

test('invalid explicit intent never falls back to broad owned-root capture, including refresh', async () => {
    const h = harness(); let refreshes = 0;
    for (const intentPaths of [[], ['/sp-store'], ['/other/lines-user'], ['invalid'], null]) {
        const result = await dispatchTargetMetadataWithRefresh({ saver: h.saver, target: {}, afterMetadata: staged(initial()), intentPaths, refresh: async () => { refreshes++; } });
        assert.equal(result.ok, false); assert.equal(result.reason, 'metadata-capture-failed');
    }
    assert.equal(h.requests.length, 0); assert.equal(refreshes, 5);
});

test('default saver contract still observes diagnostics conflicts', async () => {
    const before = initial(); const h = harness(before, { mutate(snapshot) { snapshot['sp-store'].data['diagnostics-v1'].floors.push({ other: true }); } });
    const result = await h.saver.dispatch(h.saver.capture({}, staged(before)));
    assert.equal(result.reason, 'owned-conflict'); assert.equal(result.path, '/sp-store/data/diagnostics-v1/floors'); assert.equal(h.requests.length, 0);
});

test('fixed live baseline rejects remote third line with missing or nonempty snapshot', async () => {
    for (const missing of [false, true]) {
        const before = initial(), remote = initial(); remote.integrity = 'remote';
        remote['sp-store'].data['lines-user'] = { raw: 'third', ts: 3, history: [] };
        const h = harness(remote); if (missing) h.setSnapshot(null);
        let refreshed = 0;
        const fixed = intent(before);
        const result = await dispatchTargetMetadataWithRefresh({ saver: h.saver, target: {}, afterMetadata: staged(before), ...fixed, refresh: async () => {
            refreshed++; h.setSnapshot(remote);
            // Caller mutation during await cannot redefine the fixed baseline.
            fixed.intentBefore[path].raw = 'third';
        } });
        assert.equal(refreshed, missing ? 1 : 0);
        assert.equal(result.reason, 'owned-conflict'); assert.equal(result.path, path);
        assert.equal(h.requests.length, 0); assert.equal(h.server()['sp-store'].data['lines-user'].raw, 'third');
    }
});

test('candidate cached snapshot does not refresh and overwrite remote third line', async () => {
    const before = initial(), candidate = staged(before), remote = initial();
    remote.integrity = 'remote'; remote['sp-store'].data['lines-user'].raw = 'third';
    const h = harness(remote); h.setSnapshot(candidate); let refreshed = 0;
    const result = await dispatchTargetMetadataWithRefresh({ saver: h.saver, target: {}, afterMetadata: candidate, ...intent(before), refresh: async () => { refreshed++; h.setSnapshot(remote); } });
    assert.equal(result.ok, false); assert.equal(result.reason, 'invalid-operation');
    assert.equal(refreshed, 0); assert.equal(h.requests.length, 0);
    assert.equal(h.server()['sp-store'].data['lines-user'].raw, 'third');
});

test('idempotent after cache remains unconfirmed and equal baseline still checks third value', async () => {
    const before = initial(), candidate = staged(before);
    const h = harness(candidate);
    const result = await dispatchTargetMetadataWithRefresh({ saver: h.saver, target: {}, afterMetadata: candidate, ...intent(before) });
    assert.equal(result.ok, false); assert.equal(result.commitState, 'not-dispatched'); assert.equal(h.requests.length, 0);
    const third = initial(); third['sp-store'].data['lines-user'].raw = 'third';
    const conflict = harness(third);
    const unchanged = await dispatchTargetMetadataWithRefresh({ saver: conflict.saver, target: {}, afterMetadata: before, ...intent(before) });
    assert.equal(unchanged.reason, 'owned-conflict'); assert.equal(conflict.requests.length, 0);
});

test('intent requires own baseline keys and preserves missing value and deep snapshot', async () => {
    const before = initial(), fixed = captureMetadataIntentBefore(before, [path]);
    before['sp-store'].data['lines-user'].raw = 'changed live';
    assert.equal(fixed[path].raw, 'old');
    const missing = captureMetadataIntentBefore({}, [path]);
    assert.equal(Object.hasOwn(missing, path), true); assert.equal(missing[path], undefined);
    const h = harness();
    for (const intentBefore of [undefined, {}, Object.create({ [path]: initial()['sp-store'].data['lines-user'] })]) {
        assert.equal(h.saver.capture({}, staged(initial()), { intentPaths: [path], intentBefore }), null);
    }
    assert.equal(h.requests.length, 0);
});

test('line owner cancellation after queue or diff and HTTP rejection cannot publish candidate', async () => {
    for (const phase of ['queue', 'build']) {
        let current = true; const h = harness(initial(), { mutate() { if (phase === 'queue') current = false; } });
        const captured = h.saver.capture({}, staged(initial()), intent(initial()));
        if (phase === 'build') {
            // The guard after async patch construction must reject a now-stale owner.
            let checks = 0; const result = await h.saver.dispatch(captured, { isCurrent: () => ++checks < 4 });
            assert.equal(result.reason, 'stale-after-build');
        } else assert.equal((await h.saver.dispatch(captured, { isCurrent: () => current })).reason, 'stale-before-queue-callback');
        assert.equal(h.requests.length, 0); assert.equal(h.server()['sp-store'].data['lines-user'].raw, 'old');
    }
    for (const response of [409, 500, 'network']) {
        const h = harness(initial(), { response });
        const result = await h.saver.dispatch(h.saver.capture({}, staged(initial()), intent(initial())));
        assert.equal(result.ok, false); assert.equal(h.requests.length, 1); assert.equal(h.server()['sp-store'].data['lines-user'].raw, 'old');
        assert.equal(result.reason, response === 'network' ? 'network' : `http-${response}`);
    }
});

test('queued cancellation never fetches when the serialized host callback later starts', async () => {
    let releaseHead; let fetches = 0; let tail = new Promise(resolve => { releaseHead = resolve; });
    const base = boundedSaverFixture('success');
    base.core.runSerializedChatWrite = task => {
        const current = tail.then(task); tail = current.then(() => undefined, () => undefined); return current;
    };
    const saver = createTargetMetadataSaver({ coreModule: base.core, fetchImpl: async () => { fetches++; return { ok: true, json: async () => ({ ok: true, integrity: 'i2' }) }; } });
    const captured = saver.capture({}, staged(initial()), intent(initial()));
    const controller = new AbortController();
    const waiting = saver.dispatch(captured, { signal: controller.signal });
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const result = await waiting;
    assert.equal(result.commitState, 'not-dispatched'); assert.equal(result.dispatched, false);
    releaseHead(); await tail;
    assert.equal(fetches, 0); assert.equal(base.counts().seeds, 0);
});

test('patch-build, fetch and response-body deadlines settle inside the host queue and late work never seeds snapshots', async () => {
    for (const phase of ['build', 'fetch', 'json']) {
        const h = boundedSaverFixture(phase);
        const captured = h.saver.capture({}, staged(initial()), intent(initial()));
        const deadline = createDeadlineSignal({ timeoutMs: 12, reason: `fixture-${phase}-timeout` });
        const result = await dispatchTargetMetadataWithRefresh({ saver: h.saver, target: {}, afterMetadata: staged(initial()), ...intent(initial()), signal: deadline.signal, deadlineAt: deadline.deadlineAt });
        deadline.dispose();
        assert.equal(result.commitState, phase === 'build' ? 'not-dispatched' : 'unknown', phase);
        assert.equal(result.dispatched, phase !== 'build', phase);
        await h.waitQueue();
        assert.equal(h.counts().callbacksSettled, 1, `${phase} releases the real serialized host callback`);
        let nextRan = false; await h.core.runSerializedChatWrite(() => { nextRan = true; });
        assert.equal(nextRan, true, `${phase} permits the next host write`);
        h.releaseLate(phase === 'fetch' ? { ok: true, json: async () => ({ ok: true, integrity: 'late-integrity' }) } : { ok: true, integrity: 'late-integrity' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.counts().seeds, 0, `${phase} late work cannot publish old snapshot`);
        if (phase !== 'build') assert.ok(h.counts().invalidations > 0, phase);
    }
});

test('the absolute generation deadline settles a model call that ignores cancellation', async () => {
    const owners = createTaskOwnerManager(); let resolveApi; let apiSignal; let commits = 0; let failures = 0; let busy = false;
    const controller = createLinesGenerationController({
        owners, timeLimits: { totalMs: 12 }, chatId: () => 'model-timeout', cacheKey: () => 'model-timeout',
        loadConfig: () => ({ url: 'fixture', key: 'fixture' }), readSaved: () => ({ raw: '', ts: 1 }),
        drawTickets: () => drawTickets(1, { seed: 'model-timeout' }), vectorCapacity: 8, buildPrompt: () => 'fixture',
        callApi: (_prompt, signal) => { apiSignal = signal; return new Promise(resolve => { resolveApi = resolve; }); },
        commit: () => { commits++; }, fail: () => { failures++; },
        runtime: { start() { busy = true; }, finish() { busy = false; } },
    });
    const result = await controller.run(true);
    assert.equal(result.status, 'failed'); assert.equal(apiSignal.aborted, true);
    assert.equal(commits, 0); assert.equal(failures, 1); assert.equal(busy, false);
    resolveApi('<storylines_widget></storylines_widget>'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(commits, 0, 'late API success cannot commit after the absolute deadline');
});

test('cancellable target refresh keeps late full-chat reads from seeding the shared snapshot queue', async () => {
    let snapshot = null; let currentTarget = { is_group: false, avatar_url: 'fixture', file_name: 'fixture', char_name: 'Fixture' };
    let tail = Promise.resolve(); let resolveJson; let settled = 0; let fetches = 0;
    const core = {
        resolveChatStateTarget: target => target || currentTarget,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        runSerializedChatWrite(task) { const result = tail.then(async () => { try { return await task(); } finally { settled++; } }); tail = result.then(() => undefined, () => undefined); return result; },
        getChatMetadataSnapshot: () => snapshot && structuredClone(snapshot),
        seedChatMetadataSnapshot: (_target, value) => { snapshot = structuredClone(value); },
        seedChatMessageSnapshot() {},
    };
    const refresh = createTargetSnapshotRefresher({ coreModule: core, fetchImpl: async (url, options) => {
        fetches++; assert.equal(url, '/api/chats/get'); assert.equal(options.signal.aborted, false);
        return { ok: true, json: () => new Promise(resolve => { resolveJson = resolve; }) };
    } });
    const deadline = createDeadlineSignal({ timeoutMs: 10, reason: 'fixture-refresh-timeout' });
    const result = await dispatchTargetMetadataWithRefresh({
        saver: { capture: () => null }, target: currentTarget, afterMetadata: {}, refresh,
        signal: deadline.signal, deadlineAt: deadline.deadlineAt, isCurrent: () => true,
    });
    deadline.dispose();
    assert.equal(result.commitState, 'not-dispatched'); assert.equal(fetches, 1);
    await tail; assert.equal(settled, 1, 'the internal shared-queue task settles at the deadline');
    let nextRan = false; await core.runSerializedChatWrite(() => { nextRan = true; }); assert.equal(nextRan, true);
    resolveJson([{ chat_metadata: { integrity: 'late' } }, { mes: 'late message' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshot, null, 'late JSON cannot seed metadata after cancellation');
});

test('line controller retains safe underlying save diagnostics and rejects unknown save errors', async () => {
    for (const saved of [{ reason: 'owned-conflict', commitState: 'conflict', path }, { reason: 'http-409', commitState: 'not-dispatched', status: 409 }, null]) {
        const requestId = saved?.status ? 'save99-002' : saved ? 'save99-001' : 'save99-003';
        const context = { chatId: requestId, chat: [{ is_user: false, mes: 'diagnostic fixture' }], chatMetadata: {}, saveMetadataDebounced() {} };
        registerExternalStorageContext(() => context);
        const controller = createLinesGenerationController({
            owners: createTaskOwnerManager(), chatId: () => requestId, cacheKey: () => requestId, readSaved: () => ({}), loadConfig: () => ({ url: 'fixture', key: 'fixture' }),
            drawTickets: () => drawTickets(1, { seed: 'save-diagnostics' }), vectorCapacity: 8, buildPrompt: () => 'fixture',
            callApi: async (_prompt, _signal, options) => { options.diagnosticSink({ requestId }); recordDiagnosticAttempt({ requestId, module: 'lines', messages: [] }); return '<storylines_widget>\nLine: candidate|起线|今天|world|false|false\nTicket: TICKET-1\nDesc: fixture\nNext: fixture\n</storylines_widget>'; },
            commit: () => { if (saved) throw Object.assign(new Error('private upstream content'), { saveResult: saved }); throw new Error('private unknown content'); },
            fail: error => { assert.equal(error.diagnosticCode, 'save'); },
        });
        const result = await controller.run(true);
        assert.equal(result.status, 'failed');
        const rejected = readDiagnosticTrace().findLast(item => item.requestId === requestId && item.event === 'generation-rejected');
        assert.equal(rejected.reasonCode, 'lines-commit-failed');
        assert.deepEqual(Object.fromEntries(Object.entries(rejected).filter(([key]) => ['saveReason', 'commitState', 'httpStatus', 'savePath'].includes(key))), safeSaveDiagnosticFields(saved));
        const recorded = context.chatMetadata['sp-store'].data['diagnostics-v1'].floors[0].attempts.lines.result.events.at(-1);
        assert.deepEqual(Object.fromEntries(Object.entries(recorded).filter(([key]) => ['saveReason', 'commitState', 'httpStatus', 'savePath'].includes(key))), safeSaveDiagnosticFields(saved));
        assert.doesNotMatch(JSON.stringify(rejected), /private|upstream content/);
    }
});

test('save diagnostic fields redact unknown reasons and character identity through export sanitization', () => {
    const fields = safeSaveDiagnosticFields({ reason: 'owned-conflict', commitState: 'conflict', status: 409, path: '/sp-store/data/lines-char-private%20name/history/0/raw', metadata: 'never retained' });
    assert.deepEqual(fields, { saveReason: 'owned-conflict', commitState: 'conflict', httpStatus: 409, savePath: '/sp-store/data/lines-char-<redacted>' });
    const record = sanitizeDiagnosticRecord(fields); assert.equal(record.savePath, fields.savePath); assert.equal(record.saveReason, 'owned-conflict');
    assert.equal(safeSaveDiagnosticFields({ path: '/sp-store/data/diagnostics-v1/floors' }).savePath, '/sp-store/data/diagnostics-v1/floors');
    const unknown = safeDiagnosticLog('lines', 'save', { saveResult: { reason: 'private-secret-body', commitState: 'private-state', path: '/private/path' } });
    assert.equal(unknown.saveReason, 'unknown'); assert.equal(unknown.commitState, 'unknown'); assert.equal(unknown.savePath, undefined);
    assert.doesNotMatch(JSON.stringify(unknown), /private|secret|body/);
});

test('bounded confirmed writes fail closed when only the legacy host saver exists', async () => {
    let hostSaves = 0;
    const saver = createBestEffortMetadataSaver({ context: () => ({ chatId: 'legacy', chatMetadata: {}, saveMetadata: async () => { hostSaves++; } }) });
    const deadline = createDeadlineSignal({ timeoutMs: 100, reason: 'legacy-saver-fixture' });
    const result = await saver.commit(null, { signal: deadline.signal, deadlineAt: deadline.deadlineAt });
    deadline.dispose();
    assert.deepEqual(result, { ok: false, reason: 'unsupported-core-contract', commitState: 'not-dispatched', dispatched: false });
    assert.equal(hostSaves, 0, 'bounded work never enters the unbounded legacy host queue');
});

test('external confirmed root writes stage privately and a timed-out PUT/JSON remains unknown without late publish or retry', async () => {
    const currentRecord = { recordId: 'current', revision: 1, data: { schemaVersion: 1, roots: { 'sp-store': { version: 1, data: { 'lines-user': { raw: 'old', ts: 1 }, 'outline-user': { raw: 'outline-old' } } } } } };
    const diagnosticsRecord = { recordId: 'diagnostics', revision: 1, data: { schemaVersion: 1, floors: [] } };
    const context = { chatId: 'external-line-timeout', chat: [{ is_user: false, mes: 'synthetic' }], chatMetadata: { 'sp-storage': { provider: 'st-bainiaodata', schemaVersion: 1, collection: 'fixture' } }, getRequestHeaders: () => ({}) };
    let resolveCurrentJson; let currentPuts = 0; let diagnosticPuts = 0; let serverCurrent = structuredClone(currentRecord);
    const fetchImpl = async (url, options = {}) => {
        if (url.endsWith('/health')) return { ok: true, json: async () => ({ apiVersion: 1, capabilities: { records: true, recordList: true, optimisticRevision: true, atomicReplace: true } }) };
        if (url.endsWith('/records/st-sevendayscal/fixture')) return { ok: true, json: async () => [serverCurrent, diagnosticsRecord] };
        if (url.endsWith('/records/st-sevendayscal/fixture/current') && options.method === 'PUT') {
            currentPuts++; const body = JSON.parse(options.body);
            serverCurrent = { ...serverCurrent, revision: 2, data: body.data };
            return { ok: true, json: () => new Promise(resolve => { resolveCurrentJson = resolve; }) };
        }
        if (url.endsWith('/records/st-sevendayscal/fixture/diagnostics') && options.method === 'PUT') { diagnosticPuts++; return { ok: true, json: async () => ({ recordId: 'diagnostics', revision: 2, data: JSON.parse(options.body).data }) }; }
        throw new Error(`unexpected external fixture request ${url}`);
    };
    registerExternalStorageContext(() => context);
    bindExternalChatStorage({ getContext: () => context, fetchImpl });
    assert.equal((await loadExternalChat({ force: true })).status, 'ready');
    assert.equal(recordDiagnosticAttempt({ requestId: 'diag01-002', module: 'lines', messages: [] }), true);
    assert.equal(diagnosticPuts, 0, 'per-event external diagnostic retention does not enter the business current-record queue');
    const liveRoot = getChatRoot('sp-store');
    const before = structuredClone(liveRoot);
    const deadline = createDeadlineSignal({ timeoutMs: 12, reason: 'fixture-external-save-timeout' });
    const result = await persistExternalRoots({
        confirmed: true, ownerGuard: () => true, signal: deadline.signal, deadlineAt: deadline.deadlineAt,
        intent: { rootKey: 'sp-store', key: 'lines-user', beforeHad: true, beforeValue: { raw: 'old', ts: 1 }, afterHad: true, afterValue: { raw: 'candidate', ts: 2 } },
    });
    deadline.dispose();
    assert.equal(result.commitState, 'unknown'); assert.equal(result.dispatched, true); assert.equal(currentPuts, 1);
    assert.deepEqual(liveRoot, before, 'unconfirmed candidate never appears in live external roots');
    assert.equal(storageStatus().status, 'unavailable');
    resolveCurrentJson?.({ recordId: 'current', revision: 2, data: serverCurrent.data });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(liveRoot, before, 'late JSON cannot publish or auto-retry the old candidate');
    assert.equal(currentPuts, 1);
    assert.equal((await loadExternalChat({ force: true })).status, 'ready', 'a fresh explicit reload can read the server result after the queue settles');
    assert.equal(getChatRoot('sp-store')?.data?.['lines-user']?.raw, 'candidate');
});

test('external confirmed key intent publishes the server record and merges a following ordinary root save without reverting it', async () => {
    const currentRecord = { recordId: 'current', revision: 1, data: { schemaVersion: 1, roots: { 'sp-store': { version: 1, data: { 'lines-user': { raw: 'old', ts: 1 }, 'outline-user': { raw: 'outline-old' } } } } } };
    const diagnosticsRecord = { recordId: 'diagnostics', revision: 1, data: { schemaVersion: 1, floors: [] } };
    const context = { chatId: 'external-line-success', chat: [{ is_user: false, mes: 'synthetic' }], chatMetadata: { 'sp-storage': { provider: 'st-bainiaodata', schemaVersion: 1, collection: 'fixture' } }, getRequestHeaders: () => ({}) };
    let serverCurrent = structuredClone(currentRecord); let puts = 0; let releaseLineJson;
    const fetchImpl = async (url, options = {}) => {
        if (url.endsWith('/health')) return { ok: true, json: async () => ({ apiVersion: 1, capabilities: { records: true, recordList: true, optimisticRevision: true, atomicReplace: true } }) };
        if (url.endsWith('/records/st-sevendayscal/fixture')) return { ok: true, json: async () => [serverCurrent, diagnosticsRecord] };
        if (url.endsWith('/records/st-sevendayscal/fixture/current') && options.method === 'PUT') {
            puts++;
            const body = JSON.parse(options.body); const revision = serverCurrent.revision + 1;
            serverCurrent = { ...serverCurrent, revision, data: body.data };
            if (puts === 1) return { ok: true, json: () => new Promise(resolve => { releaseLineJson = () => resolve({ recordId: 'current', revision, data: serverCurrent.data }); }) };
            return { ok: true, json: async () => ({ recordId: 'current', revision, data: serverCurrent.data }) };
        }
        throw new Error(`unexpected external success fixture request ${url}`);
    };
    registerExternalStorageContext(() => context); bindExternalChatStorage({ getContext: () => context, fetchImpl });
    assert.equal((await loadExternalChat({ force: true })).status, 'ready');
    const intent = { rootKey: 'sp-store', key: 'lines-user', beforeHad: true, beforeValue: { raw: 'old', ts: 1 }, afterHad: true, afterValue: { raw: 'new', ts: 2 } };
    const deadline = createDeadlineSignal({ timeoutMs: 1000, reason: 'fixture-external-save' });
    const lineSave = persistExternalRoots({ confirmed: true, ownerGuard: () => true, signal: deadline.signal, deadlineAt: deadline.deadlineAt, intent });
    while (!releaseLineJson) await new Promise(resolve => setImmediate(resolve));
    getChatRoot('sp-store').data['outline-user'] = { raw: 'outline-new' };
    assert.equal(persistExternalRoots(), true, 'ordinary outline save queues behind the in-flight confirmed line save');
    releaseLineJson();
    const confirmed = await lineSave;
    assert.equal(confirmed.commitState, 'confirmed');
    for (let attempt = 0; puts < 2 && attempt < 20; attempt++) await new Promise(resolve => setImmediate(resolve));
    deadline.dispose();
    assert.equal(puts, 2, 'the queued ordinary save ran after line confirmation');
    assert.equal(serverCurrent.data.roots['sp-store'].data['lines-user'].raw, 'new');
    assert.equal(serverCurrent.data.roots['sp-store'].data['outline-user'].raw, 'outline-new');
    assert.equal(getChatRoot('sp-store').data['lines-user'].raw, 'new');
    assert.equal(getChatRoot('sp-store').data['outline-user'].raw, 'outline-new');
});

test('external confirmed key intent rejects a same-key change made before queue dispatch', async () => {
    const currentRecord = { recordId: 'current', revision: 1, data: { schemaVersion: 1, roots: { 'sp-store': { version: 1, data: { 'lines-user': { raw: 'old', ts: 1 } } } } } };
    const diagnosticsRecord = { recordId: 'diagnostics', revision: 1, data: { schemaVersion: 1, floors: [] } };
    const context = { chatId: 'external-line-conflict', chat: [{ is_user: false, mes: 'synthetic' }], chatMetadata: { 'sp-storage': { provider: 'st-bainiaodata', schemaVersion: 1, collection: 'fixture' } }, getRequestHeaders: () => ({}) };
    let puts = 0; let serverCurrent = structuredClone(currentRecord);
    const fetchImpl = async (url, options = {}) => {
        if (url.endsWith('/health')) return { ok: true, json: async () => ({ apiVersion: 1, capabilities: { records: true, recordList: true, optimisticRevision: true, atomicReplace: true } }) };
        if (url.endsWith('/records/st-sevendayscal/fixture')) return { ok: true, json: async () => [serverCurrent, diagnosticsRecord] };
        if (url.endsWith('/records/st-sevendayscal/fixture/current') && options.method === 'PUT') { puts++; const body = JSON.parse(options.body); serverCurrent = { ...serverCurrent, revision: 2, data: body.data }; return { ok: true, json: async () => ({ recordId: 'current', revision: 2, data: body.data }) }; }
        throw new Error(`unexpected external conflict fixture request ${url}`);
    };
    registerExternalStorageContext(() => context); bindExternalChatStorage({ getContext: () => context, fetchImpl });
    assert.equal((await loadExternalChat({ force: true })).status, 'ready');
    getChatRoot('sp-store').data['lines-user'] = { raw: 'manual', ts: 2 };
    const deadline = createDeadlineSignal({ timeoutMs: 1000, reason: 'fixture-external-same-key-conflict' });
    const result = await persistExternalRoots({ confirmed: true, ownerGuard: () => true, signal: deadline.signal, deadlineAt: deadline.deadlineAt, intent: { rootKey: 'sp-store', key: 'lines-user', beforeHad: true, beforeValue: { raw: 'old', ts: 1 }, afterHad: true, afterValue: { raw: 'candidate', ts: 3 } } });
    deadline.dispose();
    assert.equal(result.commitState, 'conflict'); assert.equal(result.reason, 'owned-conflict'); assert.equal(puts, 0);
    assert.equal(serverCurrent.data.roots['sp-store'].data['lines-user'].raw, 'old');
    assert.equal(getChatRoot('sp-store').data['lines-user'].raw, 'manual');
});

test('chat-mode diagnostic capture does not enqueue an unbounded host metadata debounce', () => {
    let debouncedSaves = 0;
    const context = { chatId: 'diagnostic-no-debounce', chat: [{ is_user: false, mes: 'synthetic' }], chatMetadata: {}, saveMetadataDebounced: () => { debouncedSaves++; } };
    registerExternalStorageContext(() => context);
    assert.equal(recordDiagnosticAttempt({ requestId: 'diag01-001', module: 'lines', messages: [] }), true);
    assert.equal(debouncedSaves, 0);
    assert.ok(context.chatMetadata['sp-store']?.data?.['diagnostics-v1'], 'bounded diagnostics remain available to a later normal save');
});
