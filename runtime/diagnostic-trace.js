// Lightweight, fail-open diagnostics for request cancellation/timeouts and chat boundaries.
// Only the allow-listed metadata below is retained. Never pass prompts, bodies, URLs, keys,
// model output, world-info text, memory text, or character descriptions into this module.

export const DIAGNOSTIC_TRACE_STORAGE_KEY = 'sp-diagnostic-trace-v1';
export const DIAGNOSTIC_TRACE_LIMIT = 200;
export const DIAGNOSTIC_EXPORT_DEFAULT_COUNT = 30;
const DIAGNOSTIC_REQUEST_ID_PATTERN = /^[0-9a-z]{6}-[0-9a-z]{3,4}$/;
const MOBILE_PRIVATE_FIELDS = new Set(['chatId', 'previousChatId', 'currentChatId']);

const STRING_FIELDS = new Set([
    'event', 'module', 'requestId', 'chatId', 'previousChatId', 'currentChatId',
    'owner', 'channel', 'status', 'errorClass', 'abortReason', 'phase', 'reasonCode', 'finishReason',
]);
const SAVE_REASONS = new Set([
    'stale-before-queue', 'stale-before-fetch', 'stale-after-build', 'stale-before-save',
    'missing-latest-integrity', 'owned-root-conflict', 'owned-conflict', 'invalid-operation',
    'network', 'created-response', 'invalid-success-payload', 'cache-helper-error', 'adapter-error',
    'metadata-capture-failed', 'saveMetadata-rejected', 'store-save-unconfirmed', 'missing-chat',
    'external-not-ready', 'missing-key', 'official-saveMetadata-unavailable', 'target-chat-mismatch',
    'official-saveMetadata-failed', 'unsupported-core-contract', 'tt-target-unavailable',
    'tt-intent-conflict', 'tt-metadata-build-failed', 'tt-queue-failed',
    'tt-transport-rejected', 'tt-transport-failed', 'tt-metadata-saved',
    'put-result-unknown', 'merged-into-pending', 'revision-conflict', 'root-conflict',
    'stale-before-dispatch',
    'stale-before-queue-callback', 'stale-before-rebase', 'patch-build-failed', 'snapshot-read-failed',
    'save-interrupted-before-dispatch', 'cancelled-while-queued', 'save-interrupted-after-dispatch',
    'response-body-unconfirmed', 'put-result-unknown', 'revision-conflict',
    'snapshot-current', 'snapshot-empty', 'snapshot-refreshed', 'snapshot-refresh-empty', 'snapshot-refresh-failed',
    'confirmed-after-owner-stale', 'stale-after-save', 'stale-after-queue-callback', 'stale-before-save',
]);
const COMMIT_STATES = new Set(['confirmed', 'not-dispatched', 'conflict', 'unknown', 'legacy-unconfirmed']);

// 保存诊断只保留协议枚举、HTTP 状态及已知存储位置；角色 scope 和未知异常正文不外泄。
export function safeSaveDiagnosticFields(saved = {}) {
    saved = saved && typeof saved === 'object' ? saved : {};
    const result = {};
    if (saved.reason !== undefined) result.saveReason = SAVE_REASONS.has(saved.reason) || /^http-[1-5][0-9]{2}$/.test(String(saved.reason)) ? String(saved.reason) : 'unknown';
    if (saved.commitState !== undefined) result.commitState = COMMIT_STATES.has(saved.commitState) ? saved.commitState : 'unknown';
    const status = Number(saved.status ?? saved.httpStatus);
    if (Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus = status;
    const path = String(saved.path ?? saved.savePath ?? '');
    const known = path.match(/^\/sp-store\/data\/(lines-user|lines-char-[^/]+|diagnostics-v1)(?:\/.*)?$/);
    if (known) {
        const suffix = path.slice(`/sp-store/data/${known[1]}`.length);
        const safeSuffix = /^\/(?:floors|raw|ts|generatedAt|history|cursor|html)(?:\/[0-9]+)?$/.test(suffix) ? suffix : '';
        result.savePath = `/sp-store/data/${known[1].startsWith('lines-char-') ? 'lines-char-<redacted>' : known[1]}${safeSuffix}`;
    }
    else if (path === '/sp-store' || path === '/sp-ledger') result.savePath = path;
    return result;
}
const INTEGER_FIELDS = new Set([
    'chatRevision', 'previousChatRevision', 'boundaryEpoch', 'previousBoundaryEpoch',
    'floor', 'messageId', 'httpStatus', 'attempt', 'retryDelayMs', 'durationMs', 'timeoutSec',
]);
const BOOLEAN_FIELDS = new Set(['sameChatReload', 'externalSignalAborted', 'background', 'truncated']);
const SAFE_REASON_TOKENS = new Set([
    'chat-boundary', 'plugin-disabled', 'manual-abort', 'store-clear',
    'time-travel-cancel', 'superseded-owner', 'timeout', 'external-abort',
    'destroyed', 'panel-closed', 'reset', 'cleared', 'cancelled', 'user-abort',
]);

function safeInteger(value) {
    if (value == null || typeof value === 'boolean') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    try {
        const number = Number(value);
        return Number.isFinite(number) ? Math.trunc(number) : null;
    } catch { return null; }
}

function redactText(value, maxLength = 120) {
    let text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    text = text
        .replace(/https?:\/\/\S+/gi, '<redacted-url>')
        .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
        .replace(/\b(?:sk|api[_-]?key|key)[_-][A-Za-z0-9._-]{8,}\b/gi, '<redacted-key>');
    return text.slice(0, Math.max(0, maxLength));
}

function safeToken(value, fallback = '') {
    const text = redactText(value, 80).toLowerCase();
    return /^[a-z0-9][a-z0-9._:-]*$/.test(text) ? text : fallback;
}

export function isDiagnosticRequestId(value) {
    return typeof value === 'string' && DIAGNOSTIC_REQUEST_ID_PATTERN.test(value);
}

export function safeAbortReason(reason, fallback = 'external-abort') {
    if (reason == null) return fallback;
    if (typeof reason === 'string') {
        const token = safeToken(reason);
        return SAFE_REASON_TOKENS.has(token) || /^(?:chat|plugin|manual|store|time-travel|superseded|user|external|timeout|reset|clear|cancel)[a-z0-9._:-]*$/.test(token)
            ? token
            : 'string-redacted';
    }
    const name = safeToken(reason?.name, 'error');
    const code = safeToken(reason?.code, '');
    return code ? `${name}:${code}`.slice(0, 80) : name;
}

export function sanitizeDiagnosticRecord(input = {}, now = () => Date.now()) {
    const record = { ts: safeInteger(input.ts) ?? safeInteger(now()) ?? Date.now() };
    for (const key of STRING_FIELDS) {
        if (input[key] == null) continue;
        if (key === 'abortReason') record[key] = safeAbortReason(input[key]);
        else if (key === 'requestId') {
            if (isDiagnosticRequestId(input[key])) record[key] = input[key];
        }
        else if (key === 'chatId' || key === 'previousChatId' || key === 'currentChatId') record[key] = redactText(input[key], 96);
        else record[key] = safeToken(input[key], 'unknown');
    }
    for (const key of INTEGER_FIELDS) {
        const value = safeInteger(input[key]);
        if (value != null) record[key] = value;
    }
    for (const key of BOOLEAN_FIELDS) {
        if (typeof input[key] === 'boolean') record[key] = input[key];
    }
    Object.assign(record, safeSaveDiagnosticFields({ reason: input.saveReason, commitState: input.commitState, httpStatus: input.httpStatus, savePath: input.savePath }));
    if (!record.event) record.event = 'unknown';
    if (!record.module) record.module = 'unknown';
    return Object.freeze(record);
}

function parseStored(storage, storageKey, limit, now) {
    try {
        const parsed = JSON.parse(storage?.getItem?.(storageKey) || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed.slice(-limit).map(item => sanitizeDiagnosticRecord(item, now));
    } catch { return []; }
}

function immutableCopy(records) {
    return Object.freeze(records.map(record => Object.freeze({ ...record })));
}

export function normalizeDiagnosticExportCount(value, maxEntries = DIAGNOSTIC_TRACE_LIMIT) {
    const parsedMax = safeInteger(maxEntries);
    const ceiling = Math.min(DIAGNOSTIC_TRACE_LIMIT, parsedMax != null && parsedMax > 0 ? parsedMax : DIAGNOSTIC_TRACE_LIMIT);
    const fallback = Math.min(DIAGNOSTIC_EXPORT_DEFAULT_COUNT, ceiling);
    if (value == null || typeof value === 'boolean') return fallback;
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    let number;
    try { number = Number(value); } catch { return fallback; }
    if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) return fallback;
    return Math.min(number, ceiling);
}

function sanitizeMobileDiagnosticRecord(input) {
    const sanitized = sanitizeDiagnosticRecord(input && typeof input === 'object' ? input : {});
    const record = {};
    for (const [key, value] of Object.entries(sanitized)) {
        if (!MOBILE_PRIVATE_FIELDS.has(key)) record[key] = value;
    }
    return Object.freeze(record);
}

// 手机分享只从诊断白名单重新收敛字段，并额外移除聊天/卡片标识。
// 这是纯函数，方便在不读取真实 localStorage 的情况下验证导出安全性。
export function buildRecentDiagnosticTraceExport(records, count = DIAGNOSTIC_EXPORT_DEFAULT_COUNT) {
    try {
        const source = Array.isArray(records) ? records : [];
        const limit = normalizeDiagnosticExportCount(count);
        const safeRecords = source.slice(-limit).map(sanitizeMobileDiagnosticRecord);
        return JSON.stringify(safeRecords, null, 2);
    } catch { return '[]'; }
}

export function createDiagnosticTrace({
    storage,
    storageKey = DIAGNOSTIC_TRACE_STORAGE_KEY,
    maxEntries = DIAGNOSTIC_TRACE_LIMIT,
    now = () => Date.now(),
    consoleRef = globalThis.console,
} = {}) {
    const limit = Math.max(1, safeInteger(maxEntries) || DIAGNOSTIC_TRACE_LIMIT);
    let storageRef = storage;
    if (storageRef === undefined) {
        try { storageRef = globalThis.localStorage; } catch { storageRef = null; }
    }
    let records = parseStored(storageRef, storageKey, limit, now);

    const persist = () => {
        try { storageRef?.setItem?.(storageKey, JSON.stringify(records)); }
        catch { /* Diagnostics must never affect business behavior. */ }
    };
    const record = (event, metadata = {}) => {
        try {
            const entry = sanitizeDiagnosticRecord({ ...metadata, event }, now);
            records = [...records, entry].slice(-limit);
            persist();
            try { consoleRef?.info?.('[SP trace]', entry); } catch {}
            return Object.freeze({ ...entry });
        } catch { return null; }
    };
    const read = () => immutableCopy(records);
    const exportJson = () => {
        try { return JSON.stringify(records, null, 2); }
        catch { return '[]'; }
    };
    const exportRecent = count => buildRecentDiagnosticTraceExport(records, normalizeDiagnosticExportCount(count, limit));
    return Object.freeze({ record, read, export: exportJson, exportRecent, storageKey, limit });
}

let requestSequence = 0;
export function createDiagnosticRequestId(now = Date.now()) {
    requestSequence = (requestSequence + 1) % 0x100000;
    const timePart = Math.max(0, safeInteger(now) ?? 0).toString(36).padStart(6, '0').slice(-6);
    const sequencePart = requestSequence.toString(36).padStart(3, '0');
    return `${timePart}-${sequencePart}`;
}

const defaultTrace = createDiagnosticTrace();

export function traceDiagnosticEvent(event, metadata = {}) {
    try { return defaultTrace.record(event, metadata); }
    catch { return null; }
}

export function readDiagnosticTrace() {
    try { return defaultTrace.read(); }
    catch { return Object.freeze([]); }
}

export function exportDiagnosticTrace() {
    try { return defaultTrace.export(); }
    catch { return '[]'; }
}

export function exportRecentDiagnosticTrace(count = DIAGNOSTIC_EXPORT_DEFAULT_COUNT) {
    try { return defaultTrace.exportRecent(count); }
    catch { return '[]'; }
}

// UI 只注入已有的复制、弹窗和提示能力；诊断模块不直接依赖 DOM。
export async function shareRecentDiagnosticTrace({
    count = DIAGNOSTIC_EXPORT_DEFAULT_COUNT,
    exportJson = exportRecentDiagnosticTrace,
    copyText,
    promptTextarea,
    notify,
} = {}) {
    let text = '[]';
    try { text = String(exportJson(count) || '[]'); } catch {}
    let records;
    try { records = JSON.parse(text); } catch { records = []; }
    if (!Array.isArray(records) || records.length === 0) {
        try { notify?.('暂无诊断日志', false); } catch {}
        return Object.freeze({ status: 'empty', count: 0 });
    }
    let copied = false;
    try { copied = await copyText?.(text) === true; } catch {}
    if (copied) {
        try { notify?.('诊断日志已复制', false); } catch {}
        return Object.freeze({ status: 'copied', count: records.length });
    }
    try {
        await promptTextarea?.({
            title: '复制诊断日志',
            body: '自动复制失败，请长按文本复制',
            initialValue: text,
            maxLength: Math.max(1, text.length),
            rows: 12,
            confirmText: '关闭',
            cancelText: '取消',
        });
    } catch {}
    return Object.freeze({ status: 'manual-copy', count: records.length });
}

export function recordChatBoundary({
    previousChatId = null,
    currentChatId = null,
    previousBoundaryEpoch = null,
    boundaryEpoch = null,
    previousChatRevision = null,
    chatRevision = null,
} = {}) {
    return traceDiagnosticEvent('chat-boundary', {
        module: 'runtime',
        previousChatId,
        currentChatId,
        previousBoundaryEpoch,
        boundaryEpoch,
        previousChatRevision,
        chatRevision,
        sameChatReload: previousChatId != null && String(previousChatId) === String(currentChatId),
        status: 'changed',
    });
}

export function installDiagnosticTraceGlobal(target = globalThis) {
    try {
        const api = Object.freeze({ read: readDiagnosticTrace, export: exportDiagnosticTrace });
        Object.defineProperty(target, '__SP_DIAGNOSTIC_TRACE__', {
            value: api,
            configurable: true,
            enumerable: false,
            writable: false,
        });
        return api;
    } catch { return null; }
}

installDiagnosticTraceGlobal();
