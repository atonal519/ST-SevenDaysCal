import { replySourceSignature, replySignature } from './reply-identity.js';
// Chat-owned roots, cache encoding and bounded request diagnostics.
import { safeSaveDiagnosticFields, sanitizeDiagnosticRecord } from './diagnostic-trace.js';
import { decodeStoreEntry, decodeStoreRoot, encodeStoreData, encodeStoreEntry } from './store-codec.js';
import { hasLegacyMarker } from './legacy-chat-return.js';
export const CHAT_ROOT_KEYS = Object.freeze(['sp-store', 'sp-memory', 'sp-theater', 'sp-ledger']);
export const DIAGNOSTICS_DATA_KEY = 'diagnostics-v1';
const SNAPSHOT_POINTER_KEY = 'gouhua_snapshot';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
let getContext = () => null;
export function registerChatStorageContext(getter) { if (typeof getter === 'function') getContext = getter; }
function context() { try { return getContext?.() || null; } catch { return null; } }
export function hasLegacyChatStorage(ctx = context()) { return hasLegacyMarker(ctx?.chatMetadata); }
function normalRoot(key, create, factory) {
    const ctx = context(); if (!ctx?.chatId || !ctx.chatMetadata || hasLegacyChatStorage(ctx)) return null;
    let root = ctx.chatMetadata[key];
    if ((!root || typeof root !== 'object') && create) root = ctx.chatMetadata[key] = factory();
    return root && typeof root === 'object' ? root : null;
}
export function getChatRoot(key, { create = false, factory = () => ({}) } = {}) { return CHAT_ROOT_KEYS.includes(key) ? normalRoot(key, create, factory) : null; }
export function deleteChatRoot(key) {
    const ctx = context(); if (!CHAT_ROOT_KEYS.includes(key) || hasLegacyChatStorage(ctx) || ctx?.chatMetadata?.[key] == null) return false;
    delete ctx.chatMetadata[key]; return true;
}
export function getChatDiagnostics() {
    const physical = normalRoot('sp-store', false, () => ({}))?.data?.[DIAGNOSTICS_DATA_KEY];
    const diagnostics = decodeStoreEntry(DIAGNOSTICS_DATA_KEY, physical);
    if (diagnostics == null) return [];
    return diagnostics.floors || [];
}

// Keep expired diagnostic request bodies attached to the next ordinary business save.
export function prepareNormalChatStoreForSave(targetContext = null) {
    if (hasLegacyChatStorage(targetContext || context())) return;
    const root = targetContext
        ? targetContext.chatMetadata?.['sp-store']
        : normalRoot('sp-store', false, () => ({}));
    const data = root?.data;
    if (!data || typeof data !== 'object') return;
    retainDiagnosticInputsBeforeSave(data, Date.now());
    encodeStoreData(data);
}

function retainDiagnosticInputsBeforeSave(data, now) {
    if (Object.hasOwn(data, DIAGNOSTICS_DATA_KEY)) {
        try {
            const diagnostics = decodeStoreEntry(DIAGNOSTICS_DATA_KEY, data[DIAGNOSTICS_DATA_KEY]);
            // Leave the physical wrapper in place on a no-op save; only TTL edits need a fresh encoded value.
            if (Array.isArray(diagnostics?.floors) && retainDiagnosticInputs(diagnostics.floors, diagnostics.floors, now)) data[DIAGNOSTICS_DATA_KEY] = diagnostics;
        } catch { /* A damaged diagnostic value remains intact until an explicit repair. */ }
    }
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

export function replyIdentity(message, swipeId = Number(message?.swipe_id) || 0) { return `reply-${replySignature(message, swipeId)}`; }

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

const SUCCESS_DIAGNOSTIC_INPUT_TTL = 10 * 60 * 1000;
const FAILURE_DIAGNOSTIC_INPUT_TTL = 24 * 60 * 60 * 1000;
const ACCEPTED_ONLY_DIAGNOSTIC_SUCCESS = Object.freeze({
    'outline-judge': new Set(['no-advance']),
    'ledger-judge': new Set(['judge-explicit-none', 'judge-protected']),
    'ledger-capture': new Set(['capture-explicit-none', 'capture-duplicate']),
    'ledger-provenance': new Set(['provenance-explicit-none', 'provenance-valid']),
    'axis-date': new Set(['date-explicit-unknown']),
    'axis-generation': new Set(['supplement-empty']),
});

function diagnosticInputOutcome(attempt, module) {
    const result = attempt?.result || {};
    if (attempt?.transport?.status === 'failed' || result.processing === 'rejected' || result.ui === 'failed') return 'failure';
    if (result.commit === 'failed') {
        const latestSaveRejection = [...(Array.isArray(result.events) ? result.events : [])].reverse()
            .find(event => event?.event === 'generation-rejected' && event?.phase === 'save');
        // An unknown save result is unresolved, so keep its input until a later event resolves it.
        if (latestSaveRejection?.commitState === 'unknown') return null;
        return 'failure';
    }
    if (result.ui === 'displayed' || result.commit === 'committed' || result.commit === 'local-applied') return 'success';
    if (result.processing === 'accepted') {
        const accepted = [...(Array.isArray(result.events) ? result.events : [])].reverse()
            .find(event => event?.event === 'generation-accepted');
        const reasons = Object.hasOwn(ACCEPTED_ONLY_DIAGNOSTIC_SUCCESS, module) ? ACCEPTED_ONLY_DIAGNOSTIC_SUCCESS[module] : null;
        if (reasons?.has(accepted?.reasonCode)) return 'success';
    }
    return null;
}

// Trim only old request bodies from the normal diagnostic snapshot; raw/output state remains available.
function retainDiagnosticInputs(floors, previousFloors, now) {
    let changed = false;
    const priorByReply = new Map((Array.isArray(previousFloors) ? previousFloors : []).map(floor => [floor.replyId, floor]));
    for (const floor of Array.isArray(floors) ? floors : []) {
        for (const [module, attempt] of Object.entries(floor.attempts || {})) {
            const outcome = diagnosticInputOutcome(attempt, module);
            if (!outcome) continue;
            const previous = priorByReply.get(floor.replyId)?.attempts?.[module];
            const sameRequest = previous?.requestId === attempt.requestId;
            const priorOutcome = sameRequest ? diagnosticInputOutcome(previous, module) : null;
            const priorFinishedAt = attempt.finishedAt == null ? NaN : Number(attempt.finishedAt);
            // Older snapshots had no end time; start their TTL when first observed by a normal update.
            // A change from success/failure through unresolved and back starts a fresh outcome window once.
            if (!Number.isFinite(priorFinishedAt) || (sameRequest && priorOutcome !== outcome)) { attempt.finishedAt = now; changed = true; }
            const ttl = outcome === 'failure' ? FAILURE_DIAGNOSTIC_INPUT_TTL : SUCCESS_DIAGNOSTIC_INPUT_TTL;
            if (Array.isArray(attempt.messages) && now - Number(attempt.finishedAt) >= ttl) { delete attempt.messages; changed = true; }
        }
    }
    return changed;
}

function updateDiagnostics(mutator) {
    if (hasLegacyChatStorage()) return false;
    const current = normalizeDiagnosticFloors(getChatDiagnostics());
    const next = mutator(clone(current)) || current;
    retainDiagnosticInputs(next, current, Date.now());
    const root = normalRoot('sp-store', true, () => ({ version: 1, data: {} }));
    if (!root) return false;
    root.data ||= {};
    root.data[DIAGNOSTICS_DATA_KEY] = encodeStoreEntry(DIAGNOSTICS_DATA_KEY, { schemaVersion: 1, floors: normalizeDiagnosticFloors(next) });
    return true;
}

export function refreshDiagnosticRetention(ctx = context()) {
    return updateDiagnostics(floors => normalizeDiagnosticFloors(floors, ctx));
}

export function recordDiagnosticAttempt({ requestId, module, model, messages, parameters } = {}) {
    const latest = latestVisibleAi().at(-1);
    if (!requestId || !module) return false;
    if (!latest) return false;
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

export function recordDiagnosticResult({ requestId, module, event, status, phase, reasonCode, errorClass, privateDetails = {}, saveReason, commitState, httpStatus, savePath } = {}) {
    const detail = { event: String(event || ''), status: String(status || event || 'unknown'), ...(phase ? { phase: String(phase) } : {}), ...(reasonCode ? { reasonCode: String(reasonCode) } : {}), ...(errorClass ? { errorClass: String(errorClass) } : {}), ...safeSaveDiagnosticFields({ reason: saveReason, commitState, httpStatus, savePath }) };
    return updateDiagnostics(floors => {
        for (const floor of floors) {
            const attempt = floor.attempts?.[String(module)];
            if (attempt?.requestId !== requestId) continue;
            const result = attempt.result && typeof attempt.result === 'object' ? attempt.result : { processing: 'pending', commit: 'pending', ui: 'pending', events: [] };
            result.events = [...(Array.isArray(result.events) ? result.events : []), detail].slice(-8);
            if (event === 'generation-accepted') result.processing = 'accepted';
            else if (event === 'generation-rejected') {
                if (phase === 'save') result.commit = 'failed';
                else result.processing = 'rejected';
            } else if (event === 'generation-committed') result.commit = 'committed';
            else if (event === 'generation-locally-applied') result.commit = 'local-applied';
            else if (event === 'generation-ui-failed') result.ui = 'failed';
            else if (event === 'generation-ui-displayed' && result.ui !== 'failed') result.ui = 'displayed';
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

export async function buildCurrentChatDiagnosticPackage({ includeNarrative = false, safeTrace = [] } = {}) {
    const ctx = context(); if (!ctx?.chatId) throw new Error('当前没有聊天');
    if (hasLegacyChatStorage(ctx)) throw new Error('请先在存储管理中迁回当前聊天的旧构画数据');
    const roots = {};
    for (const key of CHAT_ROOT_KEYS) { const value = getChatRoot(key); if (value) roots[key] = clone(key === 'sp-store' ? decodeStoreRoot(value) : value); }
    const snapshots = [];
    for (const item of snapshotEntries(ctx.chat)) {
        const snapshot = item.value;
        if (snapshot) snapshots.push({ floor: item.floor, replyId: item.replyId, swipeId: item.swipeId, snapshot: clone(snapshot) });
    }
    const messages = includeNarrative ? ctx.chat.map((message, floor) => ({ floor, role: message?.is_user ? 'user' : message?.is_system ? 'system' : 'assistant', text: String(message?.mes || '') })) : undefined;
    return {
        format: 'st-sevendayscal-diagnostic-package', version: 1, exportedAt: new Date().toISOString(),
        warning: '此文件包含当前聊天的构画诊断数据，可能包含剧情；它不是完整可导入备份。',
        storage: { mode: 'chat' },
        business: roots, snapshots, diagnostics: clone(getChatDiagnostics()),
        safeLogs: clone((Array.isArray(safeTrace) ? safeTrace : [])
            .filter(record => String(record?.chatId || record?.currentChatId || '') === String(ctx.chatId))
            .map(record => sanitizeDiagnosticRecord(record))),
        ...(includeNarrative ? { narrative: messages } : {}),
    };
}

export const __chatStorageTestSeams = Object.freeze({ normalizeDiagnosticFloors, latestVisibleAi, replySourceSignature, replySignature, retainDiagnosticInputsBeforeSave });
