// Per-chat optional BaiNiaoData storage.  Chat metadata keeps only a locator;
// current business roots, bounded diagnostics and historical snapshots stay in
// separate records so ordinary edits never upload the full snapshot history.
import { sanitizeDiagnosticRecord } from './diagnostic-trace.js';
import { createNativeExternalChatHostBridge } from './external-chat-host-bridge.js';

export const EXTERNAL_MARKER_KEY = 'sp-storage';
export const EXTERNAL_NAMESPACE = 'st-sevendayscal';
export const EXTERNAL_SCHEMA_VERSION = 1;
export const EXTERNAL_ROOT_KEYS = Object.freeze(['sp-store', 'sp-memory', 'sp-theater', 'sp-ledger']);
export const DIAGNOSTICS_DATA_KEY = 'diagnostics-v1';
export const SNAPSHOT_POINTER_KEY = 'gouhua_snapshot';

const API_BASE = '/api/plugins/st-bainiaodata/v1';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = value => encodeURIComponent(String(value));

let binding = { getContext: () => null, coreModule: null, fetchImpl: globalThis.fetch, nativeHostBridge: null };
let active = freshActive();
let changeListener = () => {};

function freshActive() {
    return {
        chatId: '', mode: 'chat', status: 'chat', marker: null, target: null,
        current: null, diagnostics: null, records: new Map(), queue: Promise.resolve(), pendingCurrent: null,
        error: null, migration: null, generation: 0,
    };
}

function notify() { try { changeListener(Object.freeze(storageStatus())); } catch {} }
function context() { try { return binding.getContext?.() || null; } catch { return null; } }
function hasMarker(ctx = context()) { return !!ctx?.chatMetadata && Object.prototype.hasOwnProperty.call(ctx.chatMetadata, EXTERNAL_MARKER_KEY); }
function rawMarkerOf(ctx = context()) {
    return hasMarker(ctx) ? ctx.chatMetadata[EXTERNAL_MARKER_KEY] : null;
}
function markerOf(ctx = context()) {
    const marker = rawMarkerOf(ctx);
    return marker?.provider === 'st-bainiaodata' && marker?.schemaVersion === EXTERNAL_SCHEMA_VERSION
        && typeof marker.collection === 'string' && marker.collection
        ? marker : null;
}
function activeMatches(ctx = context()) { return !!ctx?.chatId && String(ctx.chatId) === active.chatId; }
function headers() { return context()?.getRequestHeaders?.() || {}; }

const PATCH_HOST_CONTRACT = Object.freeze([
    'resolveChatStateTarget', 'getChatMetadataSnapshot', 'getChatMessageSnapshot',
    'runSerializedChatWrite', 'buildChatMessagePatchOperations', 'getRequestHeaders',
    'applyIntegrityFromWritePayloadToTarget', 'seedChatMessageSnapshot',
    'seedChatMetadataSnapshot', 'invalidateChatWriteSnapshot',
    'refreshChatWriteSnapshotsFromServer',
]);
function hasPatchHostContract() { return PATCH_HOST_CONTRACT.every(name => typeof binding.coreModule?.[name] === 'function'); }
function captureChatTarget() {
    if (typeof binding.coreModule?.resolveChatStateTarget === 'function') {
        try { return clone(binding.coreModule.resolveChatStateTarget()); } catch { return null; }
    }
    return clone(binding.nativeHostBridge?.captureTarget?.());
}
async function readHostState(target) {
    if (typeof binding.coreModule?.getChatMetadataSnapshot === 'function' && typeof binding.coreModule?.getChatMessageSnapshot === 'function') {
        return {
            metadata: clone(binding.coreModule.getChatMetadataSnapshot(target)),
            messages: clone(binding.coreModule.getChatMessageSnapshot(target)),
        };
    }
    if (typeof binding.coreModule?.getChatMessageSnapshot === 'function' && !target?.native) {
        return { metadata: undefined, messages: clone(binding.coreModule.getChatMessageSnapshot(target)) };
    }
    return binding.nativeHostBridge?.readTarget?.(target);
}

export function bindExternalChatStorage(options = {}) {
    binding = { ...binding, ...options };
    binding.nativeHostBridge = options.nativeHostBridge || createNativeExternalChatHostBridge({
        getContext: binding.getContext,
        fetchImpl: (...args) => binding.fetchImpl(...args),
    });
    if (typeof options.onChange === 'function') changeListener = options.onChange;
}

// Host-aware modules register the getter they already depend on, keeping this
// shared helper importable by pure business modules without loading ST itself.
export function registerExternalStorageContext(getContext) {
    if (typeof getContext === 'function') binding.getContext = getContext;
}

export function storageStatus() {
    const ctx = context(); const markerPresent = hasMarker(ctx); const marker = markerOf(ctx);
    const current = activeMatches(ctx) ? active : null;
    return {
        chatId: String(ctx?.chatId || ''), mode: markerPresent ? 'external' : 'chat',
        status: markerPresent ? (marker ? (current?.status || 'unloaded') : 'invalid') : 'chat',
        available: markerPresent ? !!marker && current?.status === 'ready' : true,
        busy: current?.status === 'migrating',
        error: current?.error || (!marker && markerPresent ? '外置存储标记版本不支持或定位信息损坏' : null),
        collection: marker?.collection || '',
        pendingCurrent: !!current?.pendingCurrent,
    };
}

export function isExternalMode() { return hasMarker(); }
export function isStorageBusy() { return activeMatches() && active.status === 'migrating'; }
export function isExternalReady() { return isExternalMode() && activeMatches() && active.status === 'ready'; }

function normalRoot(key, create, factory) {
    const ctx = context(); if (!ctx?.chatId || !ctx.chatMetadata) return null;
    let root = ctx.chatMetadata[key];
    if ((!root || typeof root !== 'object') && create) root = ctx.chatMetadata[key] = factory();
    return root && typeof root === 'object' ? root : null;
}

export function getChatRoot(key, { create = false, factory = () => ({}) } = {}) {
    if (!EXTERNAL_ROOT_KEYS.includes(key)) return null;
    if (isStorageBusy()) return null;
    if (!isExternalMode()) return normalRoot(key, create, factory);
    if (!activeMatches() || active.status !== 'ready' || isStorageBusy()) return null;
    const roots = active.current?.data?.roots;
    if (!roots || typeof roots !== 'object') return null;
    let root = roots[key];
    if ((!root || typeof root !== 'object') && create) root = roots[key] = factory();
    return root && typeof root === 'object' ? root : null;
}

export function deleteChatRoot(key) {
    if (!EXTERNAL_ROOT_KEYS.includes(key)) return false;
    if (!isExternalMode()) {
        const ctx = context(); if (!ctx?.chatMetadata || ctx.chatMetadata[key] == null) return false;
        delete ctx.chatMetadata[key]; return true;
    }
    if (!isExternalReady() || active.current?.data?.roots?.[key] == null) return false;
    delete active.current.data.roots[key]; return true;
}

// Confirmed clear callers use this only to restore their own in-memory value
// after a failed external CAS. It never writes a root back to chat metadata.
export function restoreDeletedChatRoot(key, value) {
    if (!EXTERNAL_ROOT_KEYS.includes(key) || !isExternalMode() || !activeMatches() || !active.current?.data?.roots) return false;
    active.current.data.roots[key] = value;
    return true;
}

function backendUrl(collection, recordId = '') {
    return `${API_BASE}/records/${enc(EXTERNAL_NAMESPACE)}/${enc(collection)}${recordId ? `/${enc(recordId)}` : ''}`;
}

async function requestJson(url, options = {}) {
    const externalSignal = options.signal;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (externalSignal?.aborted) onAbort();
    else externalSignal?.addEventListener?.('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
        const response = await binding.fetchImpl(url, { cache: 'no-cache', headers: headers(), ...options, signal: controller.signal });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw Object.assign(new Error(payload?.message || `白鳥数据后端 HTTP ${response.status}`), { status: response.status, code: payload?.error || `http-${response.status}`, payload });
        return payload;
    } catch (error) {
        if (externalSignal?.aborted) throw Object.assign(new DOMException('已中断迁移', 'AbortError'), { userAbort: true });
        if (controller.signal.aborted) throw Object.assign(new Error('白鳥数据后端请求超时'), { code: 'timeout', cause: error });
        if (error?.status || error?.code) throw error;
        throw Object.assign(new Error('白鳥数据后端连接失败'), { code: 'network', cause: error });
    } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener?.('abort', onAbort);
    }
}

export async function probeExternalBackend() {
    try {
        const health = await requestJson(`${API_BASE}/health`);
        const caps = health?.capabilities || health;
        const ok = Number(health?.apiVersion ?? health?.api?.current ?? health?.api) === 1
            && caps?.records === true
            && caps?.recordList === true
            && caps?.optimisticRevision === true
            && caps?.atomicReplace === true;
        return { ok, health: ok ? health : null, reason: ok ? '' : 'capability-mismatch' };
    } catch (error) { return { ok: false, error, reason: error.code || 'unavailable' }; }
}

async function getRecord(collection, recordId, signal) { return requestJson(backendUrl(collection, recordId), { signal }); }
async function listRecords(collection) { return requestJson(backendUrl(collection)); }
async function putRecord(collection, recordId, data, expectedRevision, signal) {
    return requestJson(backendUrl(collection, recordId), { method: 'PUT', body: JSON.stringify({ data, expectedRevision }), signal });
}
async function deleteRecord(collection, recordId, expectedRevision) {
    return requestJson(backendUrl(collection, recordId), { method: 'DELETE', body: JSON.stringify({ expectedRevision }) });
}

function cleanCurrentData(value = {}) {
    const roots = {};
    for (const key of EXTERNAL_ROOT_KEYS) if (value?.roots?.[key] && typeof value.roots[key] === 'object') roots[key] = clone(value.roots[key]);
    return { schemaVersion: EXTERNAL_SCHEMA_VERSION, roots };
}
function cleanDiagnosticsData(value = {}) {
    return { schemaVersion: EXTERNAL_SCHEMA_VERSION, floors: Array.isArray(value?.floors) ? clone(value.floors) : [] };
}

export async function loadExternalChat({ force = false } = {}) {
    const ctx = context(); const chatId = String(ctx?.chatId || ''); const markerPresent = hasMarker(ctx); const marker = markerOf(ctx);
    if (!chatId) { active = freshActive(); notify(); return storageStatus(); }
    if (!markerPresent) { active = { ...freshActive(), chatId, mode: 'chat', status: 'chat' }; notify(); return storageStatus(); }
    if (!marker) {
        active = { ...freshActive(), chatId, mode: 'external', status: 'invalid', error: '外置存储标记版本不支持或定位信息损坏' };
        notify(); return storageStatus();
    }
    if (active.chatId === chatId && active.pendingCurrent) {
        await active.queue;
        if (active.chatId !== chatId || !active.pendingCurrent) return storageStatus();
        const pending = active.pendingCurrent;
        const recordId = marker.currentRecord || 'current';
        if (pending.collection !== marker.collection || pending.recordId !== recordId) {
            active.status = 'unavailable';
            active.error = '外置存储定位已变化，待保存修改未重试';
            notify(); return storageStatus();
        }
        await retryPendingCurrent(active);
        return storageStatus();
    }
    if (!force && active.chatId === chatId && ['ready', 'loading'].includes(active.status)) return storageStatus();
    const generation = active.generation + 1;
    active = { ...freshActive(), chatId, mode: 'external', status: 'loading', marker: clone(marker), target: captureChatTarget(), generation };
    notify();
    try {
        const health = await probeExternalBackend(); if (!health.ok) throw health.error || new Error('白鳥数据后端能力不兼容');
        const records = await listRecords(marker.collection);
        if (!activeMatches() || active.generation !== generation) return storageStatus();
        const map = new Map((Array.isArray(records) ? records : []).map(item => [item.recordId, item]));
        const currentEnvelope = map.get(marker.currentRecord || 'current');
        if (!currentEnvelope) throw Object.assign(new Error('外置主记录缺失，未把它当作空数据'), { code: 'missing-current' });
        const diagnosticEnvelope = map.get(marker.diagnosticsRecord || 'diagnostics') || { recordId: marker.diagnosticsRecord || 'diagnostics', revision: 0, data: cleanDiagnosticsData() };
        active.records = map;
        active.current = { ...currentEnvelope, data: cleanCurrentData(currentEnvelope.data) };
        active.diagnostics = { ...diagnosticEnvelope, data: cleanDiagnosticsData(diagnosticEnvelope.data) };
        active.status = 'ready'; active.error = null;
        refreshDiagnosticRetention(ctx);
    } catch (error) {
        if (activeMatches() && active.generation === generation) { active.status = 'unavailable'; active.error = error?.message || '外置存储不可用'; }
    }
    notify(); return storageStatus();
}

function enqueue(task, { mergePending = null } = {}) {
    const state = active;
    const queued = state.queue.then(() => {
        if (active !== state || !activeMatches()) throw Object.assign(new Error('外置存储尚未加载或已切换聊天'), { code: 'external-not-ready' });
        if (state.status !== 'ready') {
            if (state.status === 'unavailable' && state.pendingCurrent && typeof mergePending === 'function') return mergePending(state);
            throw Object.assign(new Error('外置存储尚未加载或已切换聊天'), { code: 'external-not-ready' });
        }
        return task(state);
    });
    state.queue = queued.catch(() => {});
    return queued;
}

function applySavedCurrent(state, envelope, data, saved) {
    if (state.current === envelope && same(envelope.data, data)) state.current = saved;
    else state.current = { ...state.current, revision: saved.revision, generationId: saved.generationId, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
    state.records.set(state.marker.currentRecord || 'current', saved);
    state.error = null;
    if (active === state) notify();
}

async function currentReadBack(pending, { allowList = false } = {}) {
    try {
        return await getRecord(pending.collection, pending.recordId);
    } catch {
        if (!allowList) return null;
        try {
            const records = await listRecords(pending.collection);
            return Array.isArray(records) ? records.find(item => item?.recordId === pending.recordId) || null : null;
        } catch { return null; }
    }
}

async function matchingCurrentReadBack(pending, options) {
    const readBack = await currentReadBack(pending, options);
    return same(readBack?.data, pending.data) ? readBack : null;
}

function applyRetriedCurrent(state, pending, saved) {
    state.current = { ...saved, data: cleanCurrentData(saved?.data ?? pending.data) };
    state.records.set(pending.recordId, saved);
    state.pendingCurrent = null;
    state.status = 'ready'; state.error = null;
    if (active === state) notify();
}

async function retryPendingCurrent(state) {
    const pending = state.pendingCurrent;
    if (!pending) return false;
    if (pending.retry) return await pending.retry;
    const operation = (async () => {
        if (active !== state || !activeMatches() || String(context()?.chatId || '') !== pending.chatId) return false;
        if (pending.ownerGuards.some(guard => !guard())) {
            state.status = 'unavailable'; state.error = '待保存修改所属聊天已变化，未执行重试'; notify();
            return false;
        }
        try {
            const saved = await putRecord(pending.collection, pending.recordId, pending.data, pending.expectedRevision);
            if (active === state && activeMatches() && state.pendingCurrent === pending) applyRetriedCurrent(state, pending, saved);
            return true;
        } catch (error) {
            const readBack = await currentReadBack(pending, { allowList: true });
            if (same(readBack?.data, pending.data)) {
                if (active === state && activeMatches() && state.pendingCurrent === pending) applyRetriedCurrent(state, pending, readBack);
                return true;
            }
            if (error.status === 409 && same(readBack?.data, pending.dispatchedData) && Number.isInteger(Number(readBack?.revision))) {
                pending.expectedRevision = Number(readBack.revision);
                pending.dispatchedData = clone(pending.data);
                try {
                    const saved = await putRecord(pending.collection, pending.recordId, pending.data, pending.expectedRevision);
                    if (active === state && activeMatches() && state.pendingCurrent === pending) applyRetriedCurrent(state, pending, saved);
                    return true;
                } catch (followupError) {
                    const followupReadBack = await matchingCurrentReadBack(pending, { allowList: true });
                    if (followupReadBack) {
                        if (active === state && activeMatches() && state.pendingCurrent === pending) applyRetriedCurrent(state, pending, followupReadBack);
                        return true;
                    }
                    error = followupError;
                }
            }
            if (active === state && activeMatches() && state.pendingCurrent === pending) {
                state.status = 'unavailable';
                state.error = error.status === 409 ? '外置数据发生并发冲突，待保存修改仍保留；请稍后重试' : '外置写入结果仍未确认，待保存修改仍保留';
                notify();
            }
            return false;
        }
    })();
    pending.retry = operation;
    try { return await operation; }
    finally { if (state.pendingCurrent === pending) pending.retry = null; }
}

async function saveCurrentNow(state, data, ownerGuard = () => true) {
    if (!ownerGuard()) return { ok: false, reason: 'stale-before-save', commitState: 'not-dispatched' };
    const envelope = state.current;
    const expectedRevision = Number(envelope?.revision) || 0;
    const recordId = state.marker.currentRecord || 'current';
    try {
        const saved = await putRecord(state.marker.collection, recordId, data, expectedRevision);
        applySavedCurrent(state, envelope, data, saved);
        return { ok: true, stale: !ownerGuard(), dispatched: true, commitState: 'confirmed', revision: saved.revision };
    } catch (error) {
        const pending = { data: clone(data), dispatchedData: clone(data), expectedRevision, ownerGuards: [ownerGuard], chatId: state.chatId, collection: state.marker.collection, recordId, retry: null };
        const readBack = await matchingCurrentReadBack(pending);
        if (readBack) {
            applySavedCurrent(state, envelope, data, readBack);
            return { ok: true, stale: !ownerGuard(), dispatched: true, confirmedAfterUnknown: true, commitState: 'confirmed', revision: readBack.revision };
        }
        if (active === state && activeMatches()) {
            state.pendingCurrent = pending;
            state.error = error.status === 409 ? '外置数据发生并发冲突，已停止写入；请刷新后重试' : '外置写入结果未确认，请刷新后核实';
            state.status = 'unavailable'; notify();
        }
        if (error.status === 409) throw error;
        return { ok: false, reason: 'put-result-unknown', dispatched: true, commitState: 'unknown', error };
    }
}

function mergePendingCurrent(state, data, ownerGuard) {
    const pending = state.pendingCurrent;
    if (!pending || !ownerGuard()) return { ok: false, reason: 'stale-before-save', dispatched: false, commitState: 'not-dispatched' };
    pending.data = clone(data);
    pending.ownerGuards.push(ownerGuard);
    state.error = '外置写入结果未确认，较新的待保存修改仍保留';
    if (active === state) notify();
    return { ok: false, reason: 'merged-into-pending', dispatched: false, commitState: 'unknown' };
}

// Returns null for ordinary chat storage so callers keep their existing save path.
export function persistExternalRoots({ confirmed = false, ownerGuard = () => true } = {}) {
    if (isStorageBusy()) {
        const rejected = Promise.reject(Object.assign(new Error('构画正在迁移，写入已暂停'), { code: 'migration-busy' }));
        rejected.catch(() => {}); return confirmed ? rejected : false;
    }
    if (!isExternalMode()) return null;
    if (!isExternalReady() || isStorageBusy()) {
        const rejected = Promise.reject(Object.assign(new Error(active.error || '外置存储不可用'), { code: 'external-not-ready' }));
        rejected.catch(() => {}); return confirmed ? rejected : false;
    }
    const data = cleanCurrentData(active.current?.data);
    const operation = enqueue(state => saveCurrentNow(state, data, ownerGuard), { mergePending: state => mergePendingCurrent(state, data, ownerGuard) });
    if (!confirmed) operation.catch(() => {});
    return confirmed ? operation : true;
}

// 便携包导入专用：先在独立副本上替换所选 root，再以 current record 的 revision
// 做一次 CAS。调用方不必预先改 active.current；冲突或未知结果也不会把暂存值
// 塞回 live root，更不会进入普通写入的 pending 自动重试队列。
export async function replaceExternalRootsAtomic({ expectedRoots = {}, replacementRoots = {}, ownerGuard = () => true } = {}) {
    if (!isExternalMode() || !isExternalReady() || isStorageBusy()) {
        return { ok: false, reason: 'external-not-ready', dispatched: false, commitState: 'not-dispatched' };
    }
    const keys = Object.keys(replacementRoots).filter(key => EXTERNAL_ROOT_KEYS.includes(key));
    if (!keys.length || keys.length !== Object.keys(replacementRoots).length || keys.some(key => !Object.prototype.hasOwnProperty.call(expectedRoots, key))) {
        return { ok: false, reason: 'invalid-roots', dispatched: false, commitState: 'not-dispatched' };
    }
    try {
        return await enqueue(async state => {
            if (!ownerGuard()) return { ok: false, reason: 'stale-before-save', dispatched: false, commitState: 'not-dispatched' };
            const currentRoots = state.current?.data?.roots || {};
            for (const key of keys) {
                if (!same(currentRoots[key], expectedRoots[key])) return { ok: false, reason: 'root-conflict', path: key, dispatched: false, commitState: 'conflict' };
            }
            const envelope = state.current;
            const data = cleanCurrentData(envelope?.data);
            for (const key of keys) {
                const value = replacementRoots[key];
                if (value === undefined) delete data.roots[key];
                else data.roots[key] = clone(value);
            }
            if (same(data, envelope?.data)) return { ok: true, reason: 'no-change', dispatched: false, commitState: 'confirmed', revision: envelope?.revision };
            if (!ownerGuard()) return { ok: false, reason: 'stale-before-dispatch', dispatched: false, commitState: 'not-dispatched' };
            const expectedRevision = Number(envelope?.revision) || 0;
            const recordId = state.marker.currentRecord || 'current';
            try {
                const saved = await putRecord(state.marker.collection, recordId, data, expectedRevision);
                state.current = { ...saved, data: cleanCurrentData(saved?.data ?? data) };
                state.records.set(recordId, state.current);
                state.error = null;
                if (active === state) notify();
                return { ok: true, stale: !ownerGuard(), dispatched: true, commitState: 'confirmed', revision: saved.revision };
            } catch (error) {
                const pending = { collection: state.marker.collection, recordId, data };
                const readBack = await matchingCurrentReadBack(pending, { allowList: true });
                if (readBack) {
                    state.current = { ...readBack, data: cleanCurrentData(readBack?.data ?? data) };
                    state.records.set(recordId, state.current);
                    state.error = null;
                    if (active === state) notify();
                    return { ok: true, stale: !ownerGuard(), dispatched: true, confirmedAfterUnknown: true, commitState: 'confirmed', revision: readBack.revision };
                }
                if (error?.status === 409) return { ok: false, reason: 'revision-conflict', error, dispatched: true, commitState: 'conflict' };
                return { ok: false, reason: 'put-result-unknown', error, dispatched: true, commitState: 'unknown' };
            }
        });
    } catch (error) {
        return { ok: false, reason: error?.code || 'external-not-ready', error, dispatched: false, commitState: 'not-dispatched' };
    }
}

export function externalOwnKeyBytes(key) {
    if (!isExternalReady()) return null;
    const value = active.current?.data?.roots?.[key];
    if (value == null) return 0;
    try { return (JSON.stringify(value) || '').length * 2 + String(key).length * 2; } catch { return 0; }
}

export function getExternalDiagnostics() {
    if (isExternalMode()) return isExternalReady() ? active.diagnostics?.data?.floors || [] : [];
    return normalRoot('sp-store', false, () => ({}))?.data?.[DIAGNOSTICS_DATA_KEY]?.floors || [];
}

function latestVisibleAi(ctx = context()) {
    const out = [];
    for (let i = 0; i < (ctx?.chat?.length || 0); i++) {
        const message = ctx.chat[i];
        if (!message || message.is_user || message.is_system || message.is_hidden || message?.extra?.is_hidden || !String(message.mes || '').trim()) continue;
        out.push({ floor: i, replyId: replyIdentity(message), message });
    }
    return out.slice(-2);
}

function hashText(value) { let h = 2166136261; for (const ch of String(value || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function replySource(message, swipeId = Number(message?.swipe_id) || 0) {
    const info = Array.isArray(message?.swipe_info) ? message.swipe_info[swipeId] : null;
    const text = Array.isArray(message?.swipes) && typeof message.swipes[swipeId] === 'string' ? message.swipes[swipeId] : message?.mes || '';
    return [info?.send_date || message?.send_date || '', swipeId, text].join('|');
}
function replySourceSignature(message, swipeId = Number(message?.swipe_id) || 0) { return hashText(replySource(message, swipeId)); }
function stableMetadataValue(value) {
    if (value == null) return '';
    if (typeof value?.toJSON === 'function') {
        try { return String(value.toJSON()); } catch { /* fall through */ }
    }
    return String(value);
}
function replyMetadataSignature(message, swipeId = Number(message?.swipe_id) || 0) {
    const activeSwipeId = Number(message?.swipe_id) || 0;
    const info = Array.isArray(message?.swipe_info) ? message.swipe_info[swipeId] : null;
    const current = swipeId === activeSwipeId;
    const sendDate = info?.send_date || (current ? message?.send_date : '');
    const genStarted = info?.gen_started || (current ? message?.gen_started : '');
    const genFinished = info?.gen_finished || (current ? message?.gen_finished : '');
    if (genStarted || sendDate) return `v2-${hashText(JSON.stringify([swipeId, stableMetadataValue(genStarted), stableMetadataValue(sendDate)]))}`;
    if (genFinished) return `v2-${hashText(JSON.stringify([swipeId, '', '', stableMetadataValue(genFinished)]))}`;
    return '';
}
function replySignature(message, swipeId = Number(message?.swipe_id) || 0) {
    return replyMetadataSignature(message, swipeId) || replySourceSignature(message, swipeId);
}
function snapshotPointer(message, swipeId = Number(message?.swipe_id) || 0) {
    return (Array.isArray(message?.swipe_info) ? message.swipe_info[swipeId]?.extra?.[SNAPSHOT_POINTER_KEY] : null)
        || (swipeId === (Number(message?.swipe_id) || 0) ? message?.extra?.[SNAPSHOT_POINTER_KEY] : null);
}
function pointerBelongsToReply(pointer, message, swipeId = Number(message?.swipe_id) || 0) {
    if (pointer?.external !== true || typeof pointer.replyId !== 'string' || Number(pointer.swipeId) !== swipeId) return false;
    if (typeof pointer.replySignature === 'string' && pointer.replySignature) return pointer.replySignature === replySignature(message, swipeId);
    // Legacy pointers had only a body-bound signature.  They are accepted only
    // while that exact source still matches; a later successful write upgrades
    // them with the stable reply signature.  Floor/swipe equality alone is not
    // enough because deleted floors and regenerated replies can reuse both.
    return pointer.sourceSignature === replySourceSignature(message, swipeId);
}
export function replyIdentity(message, swipeId = Number(message?.swipe_id) || 0) {
    const pointer = snapshotPointer(message, swipeId);
    if (pointerBelongsToReply(pointer, message, swipeId)) return pointer.replyId;
    return `reply-${replySignature(message, swipeId)}`;
}

function normalizeDiagnosticFloors(floors, ctx = context()) {
    const keep = latestVisibleAi(ctx);
    const source = Array.isArray(floors) ? floors : [];
    const byId = new Map(source.filter(item => typeof item?.replyId === 'string').map(item => [item.replyId, item]));
    return keep.map(item => {
        const signature = replySignature(item.message);
        const legacyId = `reply-${replySourceSignature(item.message)}`;
        const old = byId.get(item.replyId)
            || source.find(candidate => candidate?.replySignature === signature)
            || byId.get(legacyId);
        return {
            replyId: item.replyId,
            replySignature: signature,
            floor: item.floor,
            attempts: old?.attempts && typeof old.attempts === 'object' ? old.attempts : {},
        };
    });
}

async function persistDiagnosticsNow(state = active, capturedData = null) {
    if (state.mode === 'external') {
        const envelope = state.diagnostics; const data = capturedData || cleanDiagnosticsData(envelope?.data);
        const saved = await putRecord(state.marker.collection, state.marker.diagnosticsRecord || 'diagnostics', data, Number(envelope?.revision) || 0);
        if (state.diagnostics === envelope && same(envelope.data, data)) state.diagnostics = saved;
        else state.diagnostics = { ...state.diagnostics, revision: saved.revision, generationId: saved.generationId, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
        state.records.set(state.marker.diagnosticsRecord || 'diagnostics', saved); return;
    }
    const ctx = context(); const root = normalRoot('sp-store', true, () => ({ version: 1, data: {} }));
    if (!root.data || typeof root.data !== 'object') root.data = {};
    root.data[DIAGNOSTICS_DATA_KEY] = { schemaVersion: 1, floors: clone(active.diagnostics?.data?.floors || getExternalDiagnostics()) };
    // Diagnostics are fail-open and must not add business-commit writes. ST's
    // debounced metadata path persists them during ordinary chat use; minimal
    // unit/legacy hosts without it retain only the in-memory bounded record.
    const result = ctx?.saveMetadataDebounced?.(); result?.catch?.(() => {});
}

function updateDiagnostics(mutator) {
    if (isExternalMode() && !isExternalReady()) return false;
    const current = normalizeDiagnosticFloors(getExternalDiagnostics());
    const next = mutator(clone(current)) || current;
    if (isExternalMode()) active.diagnostics.data.floors = normalizeDiagnosticFloors(next);
    else {
        active.diagnostics ||= { revision: 0, data: cleanDiagnosticsData() };
        active.diagnostics.data.floors = normalizeDiagnosticFloors(next);
    }
    if (isExternalMode()) {
        const state = active; const data = cleanDiagnosticsData(state.diagnostics?.data);
        enqueue(boundState => persistDiagnosticsNow(boundState, data)).catch(error => {
            if (active !== state) return;
            state.error = error.message; state.status = 'unavailable'; notify();
        });
    }
    else persistDiagnosticsNow().catch(() => {});
    return true;
}

export function refreshDiagnosticRetention(ctx = context()) {
    return updateDiagnostics(floors => normalizeDiagnosticFloors(floors, ctx));
}

export function recordDiagnosticAttempt({ requestId, module, model, messages, parameters } = {}) {
    const latest = latestVisibleAi().at(-1); if (!latest || !requestId || !module) return false;
    return updateDiagnostics(floors => {
        let floor = floors.find(item => item.replyId === latest.replyId);
        if (!floor) { floor = { replyId: latest.replyId, floor: latest.floor, attempts: {} }; floors.push(floor); }
        floor.floor = latest.floor;
        floor.attempts[String(module)] = {
            requestId: String(requestId), startedAt: Date.now(), model: String(model || ''),
            messages: clone(Array.isArray(messages) ? messages : []), parameters: clone(parameters || {}),
            transport: { status: 'pending' }, result: { processing: 'pending', commit: 'pending', ui: 'pending', events: [] }, rawResponse: null,
        };
        return floors;
    });
}

export function recordDiagnosticTransport({ requestId, module, ok, rawResponse = null, errorClass = '', httpStatus = null } = {}) {
    return updateDiagnostics(floors => {
        for (const floor of floors) {
            const attempt = floor.attempts?.[String(module)];
            if (attempt?.requestId !== requestId) continue;
            attempt.transport = { status: ok ? 'success' : 'failed', ...(Number.isInteger(Number(httpStatus)) ? { httpStatus: Number(httpStatus) } : {}), ...(errorClass ? { errorClass: String(errorClass) } : {}) };
            if (typeof rawResponse === 'string' && (ok || errorClass === 'upstream-timeout')) attempt.rawResponse = rawResponse;
            return floors;
        }
        return floors;
    });
}

export function recordDiagnosticResult({ requestId, module, event, status, phase, reasonCode, errorClass } = {}) {
    return updateDiagnostics(floors => {
        for (const floor of floors) {
            const attempt = floor.attempts?.[String(module)];
            if (attempt?.requestId !== requestId) continue;
            const result = attempt.result && typeof attempt.result === 'object' ? attempt.result : { processing: 'pending', commit: 'pending', ui: 'pending', events: [] };
            const detail = { event: String(event || ''), status: String(status || event || 'unknown'), ...(phase ? { phase: String(phase) } : {}), ...(reasonCode ? { reasonCode: String(reasonCode) } : {}), ...(errorClass ? { errorClass: String(errorClass) } : {}) };
            result.events = [...(Array.isArray(result.events) ? result.events : []), detail].slice(-8);
            if (event === 'generation-accepted') result.processing = 'accepted';
            else if (event === 'generation-rejected') {
                if (phase === 'save') result.commit = 'failed';
                else result.processing = 'rejected';
            } else if (event === 'generation-committed') result.commit = 'committed';
            else if (event === 'generation-ui-failed') result.ui = 'failed';
            else if (event === 'generation-fallback') result.processing = 'fallback';
            attempt.result = result;
            return floors;
        }
        return floors;
    });
}

function snapshotEntries(messages = context()?.chat || []) {
    const out = [];
    for (let floor = 0; floor < messages.length; floor++) {
        const message = messages[floor]; if (!message) continue;
        const add = (extra, swipeId) => {
            const value = extra?.[SNAPSHOT_POINTER_KEY]; if (!value || typeof value !== 'object') return;
            const resolvedSwipeId = Number.isInteger(swipeId) ? swipeId : (Number(message.swipe_id) || 0);
            out.push({ floor, replyId: replyIdentity(message, resolvedSwipeId), swipeId: resolvedSwipeId, value: clone(value) });
        };
        add(message.extra, Number.isInteger(Number(message.swipe_id)) ? Number(message.swipe_id) : null);
        for (let sid = 0; sid < (message.swipe_info?.length || 0); sid++) add(message.swipe_info[sid]?.extra, sid);
    }
    return out;
}

export function readExternalSnapshot(message) {
    if (!isExternalReady()) return null;
    const swipeId = Number(message?.swipe_id) || 0;
    const pointer = message?.extra?.[SNAPSHOT_POINTER_KEY];
    if (!pointer?.recordId || !pointerBelongsToReply(pointer, message, swipeId)) return null;
    return clone(active.records.get(pointer.recordId)?.data?.snapshot || null);
}

export async function pruneExternalSnapshots(messages = context()?.chat || []) {
    if (!isExternalReady()) return { ok: false, reason: 'external-not-ready', removed: 0 };
    const state = active;
    const referenced = new Set();
    for (const item of snapshotEntries(messages)) if (item.value?.external && item.value.recordId) referenced.add(item.value.recordId);
    const stale = [...active.records.entries()].filter(([recordId]) => recordId !== (active.marker.currentRecord || 'current') && recordId !== (active.marker.diagnosticsRecord || 'diagnostics') && !referenced.has(recordId));
    let removed = 0;
    for (const [recordId, envelope] of stale) {
        if (active !== state) break;
        try {
            await deleteRecord(state.marker.collection, recordId, Number(envelope?.revision) || 0);
            if (active !== state) break;
            state.records.delete(recordId); removed++;
        } catch (error) {
            if (active !== state) break;
            state.error = `历史快照清理失败：${error.message}`; notify();
        }
    }
    return { ok: true, removed };
}

function randomId(prefix = 'snapshot') {
    const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${uuid}`.slice(0, 120);
}

async function publishMessages(target, beforeMessages, nextMessages, metadataPatch = null, ownerGuard = () => true) {
    const api = binding.coreModule;
    if (!hasPatchHostContract()) {
        if (!target || typeof binding.nativeHostBridge?.publish !== 'function') return { ok: false, reason: 'host-patch-unavailable', dispatched: false };
        return binding.nativeHostBridge.publish({
            target,
            beforeMessages,
            nextMessages,
            metadataPatch,
            ownerGuard,
            rootKeys: EXTERNAL_ROOT_KEYS,
            markerKey: EXTERNAL_MARKER_KEY,
        });
    }
    const required = ['runSerializedChatWrite', 'buildChatMessagePatchOperations', 'getRequestHeaders', 'applyIntegrityFromWritePayloadToTarget', 'seedChatMessageSnapshot', 'seedChatMetadataSnapshot', 'invalidateChatWriteSnapshot'];
    if (!target || !required.every(name => typeof api?.[name] === 'function')) return { ok: false, reason: 'host-patch-unavailable', dispatched: false };
    return api.runSerializedChatWrite(async () => {
        if (!ownerGuard()) return { ok: false, reason: 'reply-changed', dispatched: false, commitState: 'not-dispatched' };
        const latestMessages = clone(api.getChatMessageSnapshot?.(target));
        const latestMetadata = clone(api.getChatMetadataSnapshot?.(target));
        if (!Array.isArray(latestMessages) || !latestMetadata?.integrity) return { ok: false, reason: 'host-snapshot-unavailable', dispatched: false };
        if (!same(latestMessages, beforeMessages)) return { ok: false, reason: 'host-message-conflict', dispatched: false, commitState: 'conflict' };
        if (metadataPatch?.expectedRoots && EXTERNAL_ROOT_KEYS.some(key => !same(latestMetadata[key], metadataPatch.expectedRoots[key]))) {
            return { ok: false, reason: 'host-root-conflict', dispatched: false, commitState: 'conflict' };
        }
        if (metadataPatch?.expectedRoots) {
            const live = context();
            if (String(live?.chatId || '') !== String(metadataPatch.expectedChatId || '')
                || EXTERNAL_ROOT_KEYS.some(key => !same(live?.chatMetadata?.[key], metadataPatch.expectedRoots[key]))
                || !same(live?.chat, metadataPatch.expectedMessages)) {
                return { ok: false, reason: 'live-root-conflict', dispatched: false, commitState: 'conflict' };
            }
        }
        const rawOps = await api.buildChatMessagePatchOperations(latestMessages, nextMessages);
        if (!ownerGuard()) return { ok: false, reason: 'reply-changed', dispatched: false, commitState: 'not-dispatched' };
        if (metadataPatch?.expectedRoots) {
            const finalHostMessages = clone(api.getChatMessageSnapshot?.(target));
            const finalHostMetadata = clone(api.getChatMetadataSnapshot?.(target));
            const live = context();
            if (!same(finalHostMessages, beforeMessages)
                || EXTERNAL_ROOT_KEYS.some(key => !same(finalHostMetadata?.[key], metadataPatch.expectedRoots[key]))
                || String(live?.chatId || '') !== String(metadataPatch.expectedChatId || '')
                || EXTERNAL_ROOT_KEYS.some(key => !same(live?.chatMetadata?.[key], metadataPatch.expectedRoots[key]))
                || !same(live?.chat, metadataPatch.expectedMessages)) {
                return { ok: false, reason: 'final-baseline-conflict', dispatched: false, commitState: 'conflict' };
            }
        }
        if (!rawOps.length && !metadataPatch) return { ok: true, commitState: 'confirmed', dispatched: false };
        const headers = api.getRequestHeaders(); const integrity = latestMetadata.integrity;
        let url, body, committedMetadata = { ...latestMetadata };
        if (target.is_group) {
            const messageOps = rawOps.map(op => ({ ...op, path: `/body${op.path || ''}` }));
            const metaOps = [];
            if (metadataPatch) {
                const markerPath = `/header/chat_metadata/${EXTERNAL_MARKER_KEY}`;
                metaOps.push({ op: latestMetadata[EXTERNAL_MARKER_KEY] === undefined ? 'add' : 'replace', path: markerPath, value: clone(metadataPatch.marker) });
                for (const key of EXTERNAL_ROOT_KEYS) if (latestMetadata[key] !== undefined) metaOps.push({ op: 'remove', path: `/header/chat_metadata/${key}` });
            }
            url = '/api/chats/group/patch'; body = { id: target.id, operations: [...metaOps, ...messageOps], integrity, force: false };
            if (metadataPatch) { committedMetadata[EXTERNAL_MARKER_KEY] = clone(metadataPatch.marker); for (const key of EXTERNAL_ROOT_KEYS) delete committedMetadata[key]; }
        } else {
            url = '/api/chats/patch';
            const chat_metadata = metadataPatch ? { [EXTERNAL_MARKER_KEY]: clone(metadataPatch.marker), ...Object.fromEntries(EXTERNAL_ROOT_KEYS.map(key => [key, null])) } : {};
            body = { ch_name: target.char_name, file_name: target.file_name, avatar_url: target.avatar_url, operations: rawOps, chat_metadata, integrity, force: false };
            if (metadataPatch) { committedMetadata = { ...committedMetadata, ...chat_metadata }; }
        }
        if (!body.operations.length) body.operations = [{ op: 'test', path: target.is_group ? '/body' : '', value: latestMessages }];
        let response;
        try { response = await binding.fetchImpl(url, { method: 'POST', cache: 'no-cache', headers, body: JSON.stringify(body) }); }
        catch (error) { api.invalidateChatWriteSnapshot(target); return { ok: false, reason: 'network', dispatched: true, commitState: 'unknown', error }; }
        if (!response.ok) { api.invalidateChatWriteSnapshot(target); return { ok: false, reason: `http-${response.status}`, status: response.status, dispatched: true, commitState: response.status === 409 ? 'not-dispatched' : 'unknown' }; }
        const payload = await response.json().catch(() => null);
        if (payload?.ok !== true || !payload?.integrity) { api.invalidateChatWriteSnapshot(target); return { ok: false, reason: 'invalid-success-payload', dispatched: true, commitState: 'unknown' }; }
        committedMetadata.integrity = payload.integrity;
        api.applyIntegrityFromWritePayloadToTarget(payload, target, committedMetadata);
        api.seedChatMessageSnapshot(target, nextMessages);
        api.seedChatMetadataSnapshot(target, committedMetadata);
        return { ok: true, dispatched: true, commitState: 'confirmed', integrity: payload.integrity };
    });
}

async function confirmPublished(target, marker, nextMessages) {
    const api = binding.coreModule;
    if (!hasPatchHostContract()) {
        return !!await binding.nativeHostBridge?.confirmPublished?.(target, marker, nextMessages, EXTERNAL_ROOT_KEYS, EXTERNAL_MARKER_KEY);
    }
    if (typeof api?.refreshChatWriteSnapshotsFromServer !== 'function') return false;
    try {
        await api.refreshChatWriteSnapshotsFromServer(target);
        const meta = api.getChatMetadataSnapshot?.(target); const messages = api.getChatMessageSnapshot?.(target);
        return same(meta?.[EXTERNAL_MARKER_KEY], marker) && EXTERNAL_ROOT_KEYS.every(key => meta?.[key] == null) && same(messages, nextMessages);
    } catch { return false; }
}

function currentScheduledReply(state, scheduled) {
    if (active !== state || !activeMatches() || state.chatId !== scheduled.chatId) return null;
    const live = context(); const floor = live?.chat?.indexOf(scheduled.message);
    if (!Number.isInteger(floor) || floor < 0 || Number(scheduled.message?.swipe_id || 0) !== scheduled.swipeId) return null;
    return replyIdentity(scheduled.message, scheduled.swipeId) === scheduled.replyId ? { live, floor, message: scheduled.message } : null;
}

function reusableSnapshotRecord(state, replyId, swipeId) {
    for (const [recordId, envelope] of state.records) {
        if (recordId === (state.marker.currentRecord || 'current') || recordId === (state.marker.diagnosticsRecord || 'diagnostics')) continue;
        if (envelope?.data?.replyId === replyId && Number(envelope?.data?.swipeId) === swipeId) return { recordId, envelope };
    }
    return null;
}

async function writeExternalSnapshotNow(state, scheduled) {
    const current = currentScheduledReply(state, scheduled);
    if (!current) return { ok: false, reason: 'reply-changed', dispatched: false };
    const { floor, message } = current; const target = clone(state.target);
    let hostState;
    try { hostState = await readHostState(target); }
    catch (error) { return { ok: false, reason: error?.code || 'message-snapshot-unavailable', dispatched: false, error }; }
    const beforeMessages = clone(hostState?.messages);
    if (!Array.isArray(beforeMessages) || !beforeMessages[floor]
        || replyIdentity(beforeMessages[floor], scheduled.swipeId) !== scheduled.replyId) {
        return { ok: false, reason: 'message-snapshot-unavailable', dispatched: false };
    }
    const sourceSignature = replySourceSignature(message, scheduled.swipeId);
    const stableSignature = replySignature(message, scheduled.swipeId);
    const prior = snapshotPointer(message, scheduled.swipeId);
    const validPrior = prior?.recordId && pointerBelongsToReply(prior, message, scheduled.swipeId);
    const reusable = validPrior ? null : reusableSnapshotRecord(state, scheduled.replyId, scheduled.swipeId);
    const recordId = validPrior ? prior.recordId : (reusable?.recordId || randomId());
    const existing = state.records.get(recordId) || reusable?.envelope;
    const replyId = validPrior ? prior.replyId : scheduled.replyId;
    let saved;
    try { saved = await putRecord(state.marker.collection, recordId, { schemaVersion: 1, replyId, replySignature: stableSignature, swipeId: scheduled.swipeId, snapshot: clone(scheduled.snapshot) }, Number(existing?.revision) || 0); }
    catch (error) {
        if (active === state) { state.error = error.message; notify(); }
        return { ok: false, reason: error.code || 'backend-write', error };
    }
    state.records.set(recordId, saved);
    if (!currentScheduledReply(state, scheduled)) return { ok: false, reason: 'reply-changed', orphaned: true };
    const pointer = { v: 1, external: true, recordId, replyId, replySignature: stableSignature, swipeId: scheduled.swipeId, sourceSignature };
    const nextMessages = clone(beforeMessages); const next = nextMessages[floor];
    next.extra = { ...(next.extra || {}), [SNAPSHOT_POINTER_KEY]: pointer };
    const sid = scheduled.swipeId;
    if (Number.isInteger(sid) && sid >= 0 && Array.isArray(next.swipe_info) && next.swipe_info[sid]) next.swipe_info[sid].extra = { ...(next.swipe_info[sid].extra || {}), [SNAPSHOT_POINTER_KEY]: pointer };
    let published = await publishMessages(target, beforeMessages, nextMessages, null, () => !!currentScheduledReply(state, scheduled));
    if (published.commitState === 'unknown' && await confirmPublished(target, markerOf(), nextMessages)) published = { ok: true, confirmedAfterUnknown: true, commitState: 'confirmed' };
    if (active !== state) return { ok: false, reason: 'chat-changed', orphaned: true };
    if (!published.ok) { state.error = '快照已写入后端，但聊天指针未确认保存，请重试'; notify(); return published; }
    const committed = currentScheduledReply(state, scheduled);
    if (!committed) return { ok: false, reason: 'reply-changed', orphaned: true };
    committed.message.extra = { ...(committed.message.extra || {}), [SNAPSHOT_POINTER_KEY]: pointer };
    if (Number.isInteger(sid) && sid >= 0 && Array.isArray(committed.message.swipe_info) && committed.message.swipe_info[sid]) committed.message.swipe_info[sid].extra = { ...(committed.message.swipe_info[sid].extra || {}), [SNAPSHOT_POINTER_KEY]: pointer };
    return { ok: true };
}

export async function writeExternalSnapshot(message, snapshot) {
    if (!isExternalReady() || isStorageBusy() || !message) return { ok: false, reason: 'external-not-ready' };
    const state = active; const chatId = state.chatId; const swipeId = Number(message.swipe_id) || 0;
    const scheduled = { chatId, message, swipeId, replyId: replyIdentity(message, swipeId), snapshot: clone(snapshot) };
    try { return await enqueue(boundState => writeExternalSnapshotNow(boundState, scheduled)); }
    catch (error) { return { ok: false, reason: error?.code || 'external-not-ready', error }; }
}

async function collectionIdFor(target) {
    const raw = JSON.stringify(target || {}); const bytes = new TextEncoder().encode(raw);
    if (globalThis.crypto?.subtle) {
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
        return `chat-${[...digest].slice(0, 20).map(value => value.toString(16).padStart(2, '0')).join('')}`;
    }
    return `chat-${hashText(raw)}-${bytes.length}`;
}

export function abortMigration() { if (active.migration?.phase === 'copying') active.migration.controller.abort('user-abort'); }

export async function migrateCurrentChat({ onProgress = () => {} } = {}) {
    const ctx = context(); const chatId = String(ctx?.chatId || '');
    if (isStorageBusy()) return { ok: false, reason: 'migration-in-progress' };
    const target = captureChatTarget();
    if (!chatId || !target || hasMarker(ctx)) return { ok: false, reason: hasMarker(ctx) ? 'already-external' : 'missing-chat-target' };
    const controller = new AbortController(); const generation = active.generation + 1;
    active = { ...freshActive(), chatId, mode: 'chat', status: 'migrating', target, generation, migration: { phase: 'copying', controller } }; notify();
    const migrationState = active;
    const failEarly = (reason, error = null, details = {}) => {
        if (active === migrationState) active = { ...freshActive(), chatId, mode: 'chat', status: 'chat', error: error?.message || null, generation: generation + 1 };
        notify(); return { ok: false, reason, ...(error ? { error } : {}), ...details };
    };
    let hostState;
    try { hostState = await readHostState(target); }
    catch (error) { return failEarly('host-patch-unavailable', error); }
    let currentSnapshot = clone(hostState?.metadata);
    let messagesSnapshot = clone(hostState?.messages);
    if (!currentSnapshot?.integrity || !Array.isArray(messagesSnapshot)) return failEarly('host-patch-unavailable');
    const liveRoots = Object.fromEntries(EXTERNAL_ROOT_KEYS.map(key => [key, ctx.chatMetadata?.[key]]));
    const savedRoots = Object.fromEntries(EXTERNAL_ROOT_KEYS.map(key => [key, currentSnapshot?.[key]]));
    const liveMessages = clone(ctx.chat || []);
    if (!same(liveRoots, savedRoots) || !same(liveMessages, messagesSnapshot)) {
        // Flush already-approved local WIP before taking the migration baseline.
        // A non-awaitable legacy save is not sufficient evidence that server truth caught up.
        const save = ctx.saveChat || binding.coreModule?.saveChat;
        if (typeof save !== 'function') return failEarly('live-data-unflushed');
        let saving;
        try { saving = ctx.saveChat ? ctx.saveChat() : binding.coreModule.saveChat(); }
        catch (error) { return failEarly('live-save-failed', error); }
        if (!saving || typeof saving.then !== 'function') return failEarly('live-save-unconfirmed');
        try { await saving; }
        catch (error) { return failEarly('live-save-failed', error); }
        try {
            if (hasPatchHostContract() && typeof binding.coreModule?.refreshChatWriteSnapshotsFromServer === 'function') {
                await binding.coreModule.refreshChatWriteSnapshotsFromServer(target);
            }
            hostState = await readHostState(target);
        } catch (error) { return failEarly('host-refresh-failed', error); }
        currentSnapshot = clone(hostState?.metadata);
        messagesSnapshot = clone(hostState?.messages);
        const refreshedRoots = Object.fromEntries(EXTERNAL_ROOT_KEYS.map(key => [key, currentSnapshot?.[key]]));
        if (!currentSnapshot?.integrity || !Array.isArray(messagesSnapshot) || !same(liveRoots, refreshedRoots) || !same(liveMessages, messagesSnapshot)) return failEarly('live-flush-mismatch');
    }
    const health = await probeExternalBackend(); if (!health.ok) return failEarly(health.reason, health.error, { stage: 'backend-probe' });
    if (active !== migrationState || String(context()?.chatId || '') !== chatId) return failEarly('chat-changed');
    const collection = `${await collectionIdFor(target)}-${randomId('attempt').slice(-12)}`; const created = [];
    const expectedRoots = Object.fromEntries(EXTERNAL_ROOT_KEYS.map(key => [key, clone(currentSnapshot[key])]));
    const roots = {}; for (const key of EXTERNAL_ROOT_KEYS) if (currentSnapshot[key] && typeof currentSnapshot[key] === 'object') roots[key] = clone(currentSnapshot[key]);
    const normalDiagnostics = roots['sp-store']?.data?.[DIAGNOSTICS_DATA_KEY];
    if (roots['sp-store']?.data) delete roots['sp-store'].data[DIAGNOSTICS_DATA_KEY];
    const nextMessages = clone(messagesSnapshot); const migratedSnapshots = [];
    for (let floor = 0; floor < nextMessages.length; floor++) {
        const message = nextMessages[floor]; if (!message) continue;
        const activeSwipeId = Number(message.swipe_id) || 0;
        const activeSwipeSnapshot = message.swipe_info?.[activeSwipeId]?.extra?.[SNAPSHOT_POINTER_KEY];
        const slots = activeSwipeSnapshot ? [] : [{ extra: message.extra, swipeId: activeSwipeId, current: true }];
        for (let sid = 0; sid < (message.swipe_info?.length || 0); sid++) slots.push({ extra: message.swipe_info[sid]?.extra, swipeId: sid, current: false });
        for (const slot of slots) {
            const snapshot = slot.extra?.[SNAPSHOT_POINTER_KEY]; if (!snapshot || snapshot.external === true) continue;
            const recordId = randomId(); const replyId = replyIdentity(message, slot.swipeId); const sourceSignature = replySourceSignature(message, slot.swipeId); const stableSignature = replySignature(message, slot.swipeId);
            migratedSnapshots.push({ floor, slot, snapshot: clone(snapshot), recordId, replyId, stableSignature, sourceSignature });
        }
    }
    try {
        const payloads = [
            { recordId: 'current', data: { schemaVersion: 1, roots } },
            { recordId: 'diagnostics', data: { schemaVersion: 1, floors: clone(normalDiagnostics?.floors || []) } },
            ...migratedSnapshots.map(item => ({ recordId: item.recordId, data: { schemaVersion: 1, replyId: item.replyId, replySignature: item.stableSignature, swipeId: item.slot.swipeId, snapshot: item.snapshot } })),
        ];
        let done = 0;
        for (const item of payloads) {
            if (active !== migrationState || String(context()?.chatId || '') !== chatId) throw Object.assign(new Error('迁移期间已切换聊天'), { phase: 'chat-changed' });
            if (controller.signal.aborted) throw Object.assign(new DOMException('已中断迁移', 'AbortError'), { userAbort: true });
            const saved = await putRecord(collection, item.recordId, item.data, 0, controller.signal); created.push({ recordId: item.recordId, revision: saved.revision });
            const readBack = await getRecord(collection, item.recordId, controller.signal);
            if (!same(readBack?.data, item.data)) throw new Error(`外置记录 ${item.recordId} 回读校验失败`);
            done++; onProgress({ phase: 'copying', done, total: payloads.length });
        }
        for (const item of migratedSnapshots) {
            const pointer = { v: 1, external: true, recordId: item.recordId, replyId: item.replyId, replySignature: item.stableSignature, swipeId: item.slot.swipeId, sourceSignature: item.sourceSignature };
            const targetMessage = nextMessages[item.floor];
            if (item.slot.current) targetMessage.extra = { ...(targetMessage.extra || {}), [SNAPSHOT_POINTER_KEY]: pointer };
            else targetMessage.swipe_info[item.slot.swipeId].extra = { ...(targetMessage.swipe_info[item.slot.swipeId].extra || {}), [SNAPSHOT_POINTER_KEY]: pointer };
        }
        // Current extra must mirror the active swipe pointer.
        for (const message of nextMessages) {
            const sid = Number(message?.swipe_id); const pointer = message?.swipe_info?.[sid]?.extra?.[SNAPSHOT_POINTER_KEY];
            if (pointer?.external) message.extra = { ...(message.extra || {}), [SNAPSHOT_POINTER_KEY]: clone(pointer) };
        }
        const marker = { provider: 'st-bainiaodata', schemaVersion: 1, collection, currentRecord: 'current', diagnosticsRecord: 'diagnostics', migratedAt: Date.now() };
        migrationState.migration.phase = 'committing'; onProgress({ phase: 'committing', done: payloads.length, total: payloads.length });
        let published = await publishMessages(target, messagesSnapshot, nextMessages, { marker, expectedRoots, expectedMessages: messagesSnapshot, expectedChatId: chatId });
        if (published.commitState === 'unknown' && await confirmPublished(target, marker, nextMessages)) published = { ok: true, commitState: 'confirmed', confirmedAfterUnknown: true };
        if (!published.ok) throw Object.assign(new Error(published.commitState === 'unknown' ? '聊天外置提交结果未知；已停止后续写入，请刷新聊天核实' : '聊天外置标记未提交；原聊天仍是权威数据'), { phase: published.commitState === 'unknown' ? 'publish-unknown' : 'publish', publishResult: published });
        if (active !== migrationState || String(context()?.chatId || '') !== chatId) throw Object.assign(new Error('最终提交后聊天已切换，本地状态未改动'), { phase: 'publish-unknown', publishResult: { commitState: 'unknown' } });
        ctx.chatMetadata[EXTERNAL_MARKER_KEY] = marker; for (const key of EXTERNAL_ROOT_KEYS) delete ctx.chatMetadata[key];
        for (let i = 0; i < ctx.chat.length; i++) if (nextMessages[i]) { ctx.chat[i].extra = nextMessages[i].extra; ctx.chat[i].swipe_info = nextMessages[i].swipe_info; }
        await loadExternalChat({ force: true }); onProgress({ phase: 'done', done: payloads.length, total: payloads.length });
        return { ok: true, marker };
    } catch (error) {
        // Known not-dispatched host failures are safe to clean up and retry.
        // Unknown final publishes retain verified copies until reload confirms
        // whether the marker and message pointers committed.
        if (migrationState.migration?.phase === 'copying' || error.phase === 'publish') {
            for (const item of created.reverse()) { try { await deleteRecord(collection, item.recordId, item.revision); } catch {} }
        }
        if (active === migrationState) active = { ...freshActive(), chatId, mode: 'chat', status: 'chat', error: error.message, generation: generation + 1 };
        notify();
        return { ok: false, reason: error.userAbort || error.name === 'AbortError' ? 'aborted' : (error.phase || error.code || 'migration-failed'), error, publishResult: error.publishResult };
    }
}

export async function buildCurrentChatDiagnosticPackage({ includeNarrative = false, safeTrace = [] } = {}) {
    const ctx = context(); if (!ctx?.chatId) throw new Error('当前没有聊天');
    if (isExternalMode() && !isExternalReady()) throw new Error(active.error || '外置存储不可用，不能把未加载误导出为空');
    const roots = {};
    for (const key of EXTERNAL_ROOT_KEYS) { const value = getChatRoot(key); if (value) roots[key] = clone(value); }
    const snapshots = [];
    for (const item of snapshotEntries(ctx.chat)) {
        const snapshot = item.value?.external ? active.records.get(item.value.recordId)?.data?.snapshot : item.value;
        if (snapshot) snapshots.push({ floor: item.floor, replyId: item.replyId, swipeId: item.swipeId, snapshot: clone(snapshot) });
    }
    const messages = includeNarrative ? ctx.chat.map((message, floor) => ({ floor, role: message?.is_user ? 'user' : message?.is_system ? 'system' : 'assistant', text: String(message?.mes || '') })) : undefined;
    return {
        format: 'st-sevendayscal-diagnostic-package', version: 1, exportedAt: new Date().toISOString(),
        warning: '此文件包含当前聊天的构画诊断数据，可能包含剧情；它不是完整可导入备份。',
        storage: { mode: isExternalMode() ? 'external' : 'chat', ...(markerOf() ? { locator: clone(markerOf()) } : {}) },
        business: roots, snapshots, diagnostics: clone(getExternalDiagnostics()),
        safeLogs: clone((Array.isArray(safeTrace) ? safeTrace : [])
            .filter(record => String(record?.chatId || record?.currentChatId || '') === String(ctx.chatId))
            .map(record => sanitizeDiagnosticRecord(record))),
        ...(includeNarrative ? { narrative: messages } : {}),
    };
}

export const __externalStorageTestSeams = Object.freeze({ cleanCurrentData, normalizeDiagnosticFloors, latestVisibleAi, publishMessages, replySourceSignature, replySignature });
