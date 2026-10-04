// Optional server-local BaiNiao projection. The ignored config contains only
// an enable switch; requests reuse the logged-in host session and never carry
// API credentials or chat metadata into the record.
const CONFIG_URL = new URL('../diagnostics.local.json', import.meta.url).href;
const API_BASE = '/api/plugins/st-bainiaodata/v1';
const NAMESPACE = 'st-sevendayscal';
const COLLECTION = 'private-diagnostics';
const RECORD_ID = 'generation-live';
const MODULE_LIMIT = 20;
const ATTEMPT_LIMIT = 4;
const EVENT_LIMIT = 8;
const RAW_LIMIT = 32_000;
const RETRY_LIMIT = 3;

let configPromise = null;
let revision = null;
let currentData = null;
let timer = null;
let flushing = false;
let dirty = false;
let retries = 0;
let getContext = () => null;

export function bindLocalDiagnosticsContext(getter) {
    if (typeof getter === 'function') getContext = getter;
}

async function config() {
    if (!configPromise) configPromise = fetch(CONFIG_URL, { cache: 'no-store' })
        .then(response => response.ok ? response.json() : null)
        .catch(() => null);
    const value = await configPromise;
    return value?.enabled === true ? value : null;
}

function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function headers() {
    try { return getContext()?.getRequestHeaders?.() || { 'Content-Type': 'application/json' }; }
    catch { return { 'Content-Type': 'application/json' }; }
}

function endpoint() {
    return `${API_BASE}/records/${encodeURIComponent(NAMESPACE)}/${encodeURIComponent(COLLECTION)}/${encodeURIComponent(RECORD_ID)}`;
}

function schedule() {
    dirty = true;
    retries = 0;
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; void flush(); }, 180);
}

export function captureLocalGenerationDiagnostic({ requestId, runId, module, startedAt, runStartedAt, floor, replyId, transport, rawResponse, result, event } = {}) {
    if ((!requestId && !runId) || !module) return;
    const moduleKey = String(module).slice(0, 64);
    currentData ||= { schemaVersion: 1, updatedAt: new Date().toISOString(), attempts: {}, recentAttempts: {} };
    const values = [...(currentData.recentAttempts?.[moduleKey] || []), ...(currentData.attempts[moduleKey] ? [currentData.attempts[moduleKey]] : [])];
    const incoming = {
        ...(requestId ? { requestId: String(requestId).slice(0, 80) } : {}),
        ...(runId ? { runId: String(runId).slice(0, 80) } : {}),
        module: moduleKey,
        startedAt: Number(startedAt) || Date.now(),
        ...(Number(runStartedAt) ? { runStartedAt: Number(runStartedAt) } : {}),
        ...(Number.isInteger(Number(floor)) ? { floor: Number(floor) } : {}),
        ...(replyId ? { replyId: String(replyId).slice(0, 120) } : {}),
        transport: { status: requestId ? 'pending' : 'not-started' },
        result: { processing: requestId ? 'pending' : 'started', commit: 'not-requested', ui: 'not-requested', events: [] },
        rawResponse: null,
    };
    const same = item => requestId
        ? item.requestId === requestId || (!item.requestId && runId && item.runId === runId)
        : (!item.requestId && runId && item.runId === runId);
    let index = values.findIndex(same);
    if (index < 0) {
        const latest = values.reduce((best, item) => !best || Number(item.startedAt) > Number(best.startedAt) ? item : best, null);
        // Only an explicit newer start may advance the latest projection.
        if (latest && (event || transport || result) && Number(incoming.startedAt) < Number(latest.startedAt)) return;
        values.push(incoming);
        index = values.length - 1;
    }
    const old = values[index];
    const attempt = { ...old, ...incoming, startedAt: requestId && !old.requestId ? Number(incoming.startedAt) : Math.min(Number(old.startedAt) || Infinity, Number(incoming.startedAt) || Infinity) };
    if (typeof rawResponse !== 'string') attempt.rawResponse = old.rawResponse || null;
    if (old.runId && requestId) attempt.runStartedAt = Number(old.runStartedAt) || Number(old.startedAt);
    if (!Number.isFinite(attempt.startedAt)) attempt.startedAt = Date.now();
    const mergeResult = next => {
        const prior = old.result || {};
        const merged = { ...prior, ...next };
        const choose = (a, b, order) => order.indexOf(b) > order.indexOf(a) ? b : a;
        merged.processing = choose(prior.processing || 'pending', next.processing || 'pending', ['pending', 'preparing', 'started', 'response-received', 'accepted', 'fallback', 'rejected']);
        merged.commit = choose(prior.commit || 'not-requested', next.commit || 'not-requested', ['not-requested', 'pending', 'committed', 'local-applied', 'failed']);
        merged.ui = choose(prior.ui || 'not-requested', next.ui || 'not-requested', ['not-requested', 'pending', 'displayed', 'failed']);
        merged.events = [...(prior.events || []), ...(next.events || [])].filter((entry, i, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(entry)) === i).slice(-EVENT_LIMIT);
        if (prior.ui === 'failed' || next.ui === 'failed') merged.ui = 'failed';
        if (prior.commit === 'failed' || next.commit === 'failed') merged.commit = 'failed';
        if (prior.processing === 'rejected' || next.processing === 'rejected') merged.processing = 'rejected';
        return merged;
    };
    attempt.result = mergeResult(incoming.result);
    if (old.transport?.status && incoming.transport?.status === 'pending') attempt.transport = old.transport;
    if (transport && typeof transport === 'object') attempt.transport = clone(transport) || attempt.transport;
    if (typeof rawResponse === 'string') attempt.rawResponse = rawResponse.slice(0, RAW_LIMIT);
    if (result && typeof result === 'object') {
        const next = clone(result);
        if (next) attempt.result = mergeResult(next);
    }
    if (event && typeof event === 'object') {
        const detail = clone(event);
        if (detail) {
            const events = Array.isArray(attempt.result?.events) ? attempt.result.events : [];
            attempt.result ||= { processing: 'pending', commit: 'not-requested', ui: 'not-requested', events };
            attempt.result.events = [...events, detail].slice(-EVENT_LIMIT);
            if (detail.event === 'generation-accepted') attempt.result.processing = 'accepted';
            else if (detail.event === 'generation-rejected') {
                if (detail.phase === 'save') attempt.result.commit = 'failed';
                else attempt.result.processing = 'rejected';
            } else if (detail.event === 'generation-locally-applied') attempt.result.commit = 'local-applied';
            else if (detail.event === 'generation-committed') attempt.result.commit = 'committed';
            else if (detail.event === 'generation-ui-failed') attempt.result.ui = 'failed';
            else if (detail.event === 'generation-ui-displayed' && attempt.result.ui !== 'failed') attempt.result.ui = 'displayed';
            else if (detail.event === 'generation-fallback') attempt.result.processing = 'fallback';
        }
    }
    values[index] = attempt;
    values.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
    const attempts = { ...currentData.attempts, [moduleKey]: values[0] };
    const recentAttempts = { ...(currentData.recentAttempts || {}) };
    if (values.length > 1) recentAttempts[moduleKey] = values.slice(1, ATTEMPT_LIMIT); else delete recentAttempts[moduleKey];
    for (const key of Object.keys(attempts).slice(0, Math.max(0, Object.keys(attempts).length - MODULE_LIMIT))) { delete attempts[key]; delete recentAttempts[key]; }
    currentData = { schemaVersion: 1, updatedAt: new Date().toISOString(), attempts, recentAttempts };
    schedule();
}

function mergeAttempts(remote, local) {
    const attempts = {};
    const recentAttempts = {};
    const modules = new Set([...Object.keys(remote?.attempts || {}), ...Object.keys(remote?.recentAttempts || {}), ...Object.keys(local?.attempts || {}), ...Object.keys(local?.recentAttempts || {})]);
    for (const key of modules) {
        const all = [...(remote?.recentAttempts?.[key] || []), ...(remote?.attempts?.[key] ? [remote.attempts[key]] : []), ...(local?.recentAttempts?.[key] || []), ...(local?.attempts?.[key] ? [local.attempts[key]] : [])];
        const unique = [];
        for (const item of all) {
            const index = unique.findIndex(old => item.requestId && old.requestId
                ? old.requestId === item.requestId
                : item.runId && old.runId === item.runId);
            if (index < 0) unique.push(item);
            else {
                const old = unique[index];
                const result = { ...(old.result || {}), ...(item.result || {}) };
                const choose = (a, b, order) => order.indexOf(b) > order.indexOf(a) ? b : a;
                result.processing = choose(old.result?.processing || 'pending', item.result?.processing || 'pending', ['pending', 'preparing', 'started', 'response-received', 'accepted', 'fallback', 'rejected']);
                result.commit = choose(old.result?.commit || 'not-requested', item.result?.commit || 'not-requested', ['not-requested', 'pending', 'committed', 'local-applied', 'failed']);
                result.ui = choose(old.result?.ui || 'not-requested', item.result?.ui || 'not-requested', ['not-requested', 'pending', 'displayed', 'failed']);
                if (old.result?.ui === 'failed' || item.result?.ui === 'failed') result.ui = 'failed';
                if (old.result?.commit === 'failed' || item.result?.commit === 'failed') result.commit = 'failed';
                if (old.result?.processing === 'rejected' || item.result?.processing === 'rejected') result.processing = 'rejected';
                result.events = [...(old.result?.events || []), ...(item.result?.events || [])].filter((entry, i, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(entry)) === i).slice(-EVENT_LIMIT);
                unique[index] = { ...old, ...item, transport: item.transport?.status === 'pending' ? old.transport : (item.transport || old.transport), rawResponse: item.rawResponse || old.rawResponse || null, result };
            }
        }
        unique.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
        if (unique.length) attempts[key] = unique[0];
        if (unique.length > 1) recentAttempts[key] = unique.slice(1, ATTEMPT_LIMIT);
    }
    return { attempts, recentAttempts };
}

async function request(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', headers: headers(), ...options });
    let body = null;
    try { body = await response.json(); } catch {}
    return { ok: response.ok, status: response.status, body };
}

async function flush() {
    if (flushing || !dirty) return;
    flushing = true;
    dirty = false;
    let success = false;
    try {
        if (!await config()) { success = true; return; }
        const url = endpoint();
        let data = currentData;
        if (!data) { success = true; return; }
        if (revision === null) {
            const read = await request(url);
            if (read.ok && Number.isSafeInteger(read.body?.revision)) {
                revision = read.body.revision;
                // Merge the latest per-module projection with the server copy.
                data = { ...data, ...mergeAttempts(read.body?.data || {}, data) };
            } else if (read.status === 404) revision = 0;
            else return;
        }
        let written = await request(url, { method: 'PUT', body: JSON.stringify({ data, expectedRevision: revision }) });
        if (written.status === 409) {
            const read = await request(url);
            if (!read.ok || !Number.isSafeInteger(read.body?.revision)) return;
            revision = read.body.revision;
            data = { ...data, ...mergeAttempts(read.body?.data || {}, data) };
            written = await request(url, { method: 'PUT', body: JSON.stringify({ data, expectedRevision: revision }) });
        }
        if (written.ok && Number.isSafeInteger(written.body?.revision)) {
            revision = written.body.revision;
            success = true;
            if (currentData) {
                const merged = mergeAttempts(data, currentData);
                currentData = { ...currentData, ...merged };
            }
            if (dirty) schedule();
        }
    } catch {
        // Diagnostics are a best-effort side channel and never affect generation.
    } finally {
        flushing = false;
        if (dirty && timer === null) schedule();
        else if (success) retries = 0;
        else if (retries < RETRY_LIMIT) {
            retries += 1;
            dirty = true;
            timer = setTimeout(() => { timer = null; void flush(); }, retries * 500);
        }
    }
}
