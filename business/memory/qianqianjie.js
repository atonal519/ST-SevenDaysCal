import { createDeadlineSignal, LINES_TIME_LIMITS, waitForSignal } from '../../runtime/deadline.js';

export const QIANQIANJIE_BRIDGE_KEY = 'qqj_v3_public_bridge_v1';
export const QIANQIANJIE_READ_TIMEOUT_MS = 15000;
const QIANQIANJIE_RECALL_CACHE_VERSION = 2;

const clean = (value, maximum = 500) => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);

export function captureQianQianJieHostIdentity(context) {
    const characterId = context?.characterId;
    const character = Array.isArray(context?.characters) ? context.characters[characterId] : context?.characters?.[characterId];
    return Object.freeze({
        hostChatId: String(context?.chatId ?? context?.getCurrentChatId?.() ?? '').trim(),
        characterLocator: String(character?.avatar ?? context?.characterAvatar ?? '').trim(),
        personaLocator: String(context?.userAvatar ?? context?.personaAvatar ?? '').trim(),
    });
}

export function sameQianQianJieHostIdentity(left, right) {
    return !!left && !!right
        && left.hostChatId === right.hostChatId
        && left.characterLocator === right.characterLocator
        && (!left.personaLocator || !right.personaLocator || left.personaLocator === right.personaLocator);
}

function emptyResult(status, message, extra = {}) {
    return Object.freeze({ status, text: '', message: clean(message), ...extra });
}

export function createQianQianJieMemoryAccess({ globalRef = globalThis, contextProvider, participantIdentityProvider = () => null, sourceEpochProvider = () => 0, isSelected = () => true, readCache = () => null, writeCache = () => {}, readTimeoutMs = QIANQIANJIE_READ_TIMEOUT_MS } = {}) {
    if (typeof contextProvider !== 'function') throw new TypeError('千千结记忆适配器缺少宿主上下文');
    const selected = () => {
        try { return isSelected() === true; } catch { return false; }
    };
    const currentBridge = () => globalRef?.[QIANQIANJIE_BRIDGE_KEY];
    const currentSourceEpoch = () => {
        try { return sourceEpochProvider(); } catch { return null; }
    };
    const captureIdentity = () => ({
        host: captureQianQianJieHostIdentity(contextProvider()),
        participant: Object.freeze({ ...(participantIdentityProvider() || {}) }),
    });
    const participantKeys = ['chatId', 'characterId', 'characterKey', 'personaKey', 'userName', 'charName'];
    const sameOwner = (left, right) => sameQianQianJieHostIdentity(left?.host, right?.host)
        && participantKeys
            .every(key => String(left?.participant?.[key] ?? '') === String(right?.participant?.[key] ?? ''));
    const sameRequest = (left, right) => sameOwner(left, right)
        && String(left?.participant?.boundaryEpoch ?? '') === String(right?.participant?.boundaryEpoch ?? '');
    let requestSequence = 0;
    let latestSuccessfulSequence = 0;
    let cacheWriteQueue = Promise.resolve();
    let lastReady = null;

    const validCache = (value, identity) => value?.schemaVersion === QIANQIANJIE_RECALL_CACHE_VERSION
        && typeof value.recallText === 'string' && value.recallText.trim()
        && sameOwner(value.ownerIdentity, identity);
    const cachedResult = (value, api, diagnostic) => Object.freeze({
        status: 'ready',
        text: `【千千结上次成功召回】\n${value.recallText}`,
        cached: true,
        cachePersisted: value.cachePersisted !== false,
        message: diagnostic || '本轮没有新的可用召回，正在使用上次成功召回',
        identity: value.sourceIdentity ?? null,
        reader: api,
    });
    const cachedFor = (identity, api, diagnostic, sequence, sourceEpoch) => {
        if (sequence < latestSuccessfulSequence || currentSourceEpoch() !== sourceEpoch) return null;
        if (!selected() || currentBridge() !== api || !sameRequest(identity, captureIdentity())) return null;
        if (lastReady?.api === api && validCache(lastReady, identity)) return cachedResult(lastReady, api, diagnostic);
        let persisted = null;
        try { persisted = readCache(); } catch { /* unreadable cache behaves as absent */ }
        if (!validCache(persisted, identity)) return null;
        lastReady = Object.freeze({ ...persisted, api });
        return cachedResult(lastReady, api, diagnostic);
    };

    function status() {
        const api = currentBridge();
        if (!api || api.schemaVersion !== 1 || api.kind !== 'qqj-public-memory-bridge' || typeof api.getPromptSnapshot !== 'function') {
            return emptyResult('api-unavailable', '检测不到千千结轻量记忆接口');
        }
        if (typeof api.getStatus !== 'function') return emptyResult('ready', '千千结只读接口已就绪');
        try {
            const value = api.getStatus();
            return emptyResult(value?.status || 'not-ready', value?.message || '千千结当前状态未知');
        } catch { return emptyResult('not-ready', '千千结只读接口暂未就绪'); }
    }

    async function result({ signal = null, timeoutMs = readTimeoutMs, cacheWriteTimeoutMs = LINES_TIME_LIMITS.recallCacheMs } = {}) {
        const sequence = ++requestSequence;
        const sourceEpoch = currentSourceEpoch();
        const before = captureIdentity();
        const api = currentBridge();
        if (!api || api.schemaVersion !== 1 || api.kind !== 'qqj-public-memory-bridge' || typeof api.getPromptSnapshot !== 'function') {
            return emptyResult('api-unavailable', '检测不到千千结轻量记忆接口', { identity: before.host, reader: api });
        }
        if (!selected()) return emptyResult('stale', '记忆源已切换');
        if (signal?.aborted) return emptyResult('cancelled', '本次记忆读取已取消');
        let value;
        const deadline = Math.max(1, Number(timeoutMs) || QIANQIANJIE_READ_TIMEOUT_MS);
        try {
            value = await new Promise((resolve, reject) => {
                let settled = false;
                let timer = null;
                const finish = (callback, payload) => {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) clearTimeout(timer);
                    signal?.removeEventListener?.('abort', onAbort);
                    callback(payload);
                };
                const onAbort = () => finish(reject, Object.assign(new Error('qqj-memory-read-cancelled'), { name: 'AbortError' }));
                timer = setTimeout(() => finish(reject, Object.assign(new Error('qqj-memory-read-timeout'), { name: 'TimeoutError' })), deadline);
                signal?.addEventListener?.('abort', onAbort, { once: true });
                let pending;
                try { pending = api.getPromptSnapshot(); }
                catch (error) { finish(reject, error); return; }
                Promise.resolve(pending).then(resultValue => finish(resolve, resultValue), error => finish(reject, error));
            });
        } catch (error) {
            if (error?.name === 'AbortError') return emptyResult('cancelled', '本次记忆读取已取消');
            if (currentSourceEpoch() !== sourceEpoch || !selected() || currentBridge() !== api || !sameRequest(before, captureIdentity())) {
                return emptyResult('stale', '读取期间当前聊天或记忆源已变化');
            }
            const timedOut = error?.name === 'TimeoutError';
            const diagnostic = timedOut ? '等待千千结记忆超时' : `千千结记忆读取失败：${clean(error?.message || '未知错误')}`;
            const fallback = cachedFor(before, api, `${diagnostic}；使用上次成功召回`, sequence, sourceEpoch);
            return fallback || emptyResult(timedOut ? 'timed-out' : 'read-failed', diagnostic, { identity: before.host, reader: api });
        }

        const sourceIdentity = value?.identity;
        const after = captureIdentity();
        if (signal?.aborted) return emptyResult('cancelled', '本次记忆读取已取消');
        if (!selected() || currentBridge() !== api || currentSourceEpoch() !== sourceEpoch || !sameRequest(before, after)) {
            return emptyResult('stale', '读取期间当前聊天或记忆源已变化');
        }
        if (sourceIdentity && (sourceIdentity.hostChatId !== before.host.hostChatId
            || sourceIdentity.characterLocator !== before.host.characterLocator
            || (before.host.personaLocator && sourceIdentity.personaLocator !== before.host.personaLocator))) {
            return emptyResult('stale', '千千结返回的宿主聊天身份已变化');
        }
        if (sequence < latestSuccessfulSequence) return emptyResult('stale', '已有更新的千千结召回结果');

        const recallText = value?.status === 'ready' && typeof value.recall?.text === 'string' ? value.recall.text.trim() : '';
        if (value?.status === 'ready' && recallText) {
            latestSuccessfulSequence = sequence;
            const record = Object.freeze({
                schemaVersion: QIANQIANJIE_RECALL_CACHE_VERSION,
                ownerIdentity: before,
                sourceIdentity: sourceIdentity ?? null,
                recallText,
                savedAt: Date.now(),
            });
            // 正文材料只依赖本轮已读取的内容；缓存持久化排在旁路队列，不延长前台预检。
            const cacheDeadline = createDeadlineSignal({ signal, timeoutMs: cacheWriteTimeoutMs, reason: 'qqj-cache-save-timeout' });
            const cacheOwnerGuard = () => !cacheDeadline.signal.aborted && !signal?.aborted && selected() && currentBridge() === api
                && currentSourceEpoch() === sourceEpoch && sameRequest(before, captureIdentity())
                && sequence === latestSuccessfulSequence;
            lastReady = Object.freeze({ ...record, api, cachePersisted: false });
            const write = cacheWriteQueue.then(async () => {
                if (!cacheOwnerGuard()) return { ok: false, reason: 'cache-write-stale', commitState: 'not-dispatched', dispatched: false };
                return await waitForSignal(writeCache(record, { ownerGuard: cacheOwnerGuard, signal: cacheDeadline.signal, deadlineAt: cacheDeadline.deadlineAt, safeSnapshotRefresh: true }), cacheDeadline.signal);
            });
            cacheWriteQueue = write.then(() => undefined, () => undefined);
            write.then(saved => {
                cacheDeadline.dispose();
                const confirmed = saved?.ok === true && saved?.commitState === 'confirmed';
                if (cacheOwnerGuard()) lastReady = Object.freeze({ ...record, api, cachePersisted: confirmed });
            }, error => {
                cacheDeadline.dispose();
                if (cacheOwnerGuard()) lastReady = Object.freeze({ ...record, api, cachePersisted: false });
            });
            return Object.freeze({
                status: 'ready', text: recallText, cached: false, cachePersisted: false,
                message: '本轮召回可用，缓存保存待确认',
                identity: sourceIdentity ?? null, reader: api,
            });
        }

        if (['disabled', 'api-unavailable'].includes(value?.status)) {
            return emptyResult(value.status, value?.message || '千千结当前不可用', { identity: sourceIdentity ?? null, reader: api });
        }
        const status = value?.status === 'ready' ? 'empty' : value?.status || 'empty';
        if (['empty', 'not-ready', 'unavailable', 'error', 'read-failed', 'timed-out'].includes(status)) {
            const diagnostic = value?.message || (value?.status === 'ready' ? '本轮没有新的可用召回' : '千千结当前尚未准备好召回');
            const fallback = cachedFor(after, api, `${diagnostic}；使用上次成功召回`, sequence, sourceEpoch);
            if (fallback) return fallback;
        }
        return emptyResult(status, value?.message || '当前聊天暂无千千结可用召回', { identity: sourceIdentity ?? null, reader: api });
    }

    return Object.freeze({ status, result, reader: currentBridge, async text(options) { return (await result(options)).text; } });
}

export function qianQianJieMemoryDiagnostic(result) {
    switch (result?.status) {
        case 'ready': return result?.cached ? result.message : '千千结本轮召回已就绪';
        case 'api-unavailable': return '检测不到千千结轻量记忆接口：请确认千千结已启用且支持 getPromptSnapshot';
        case 'disabled': return '千千结当前已关闭';
        case 'not-ready': return result?.message || '千千结尚未准备好当前聊天';
        case 'empty':
        case 'unavailable': return result?.message || '当前聊天暂无千千结可用召回';
        case 'stale': return '当前聊天或记忆源已变化，请重新生成';
        case 'cancelled': return '本次千千结记忆读取已取消';
        case 'timed-out': return '等待千千结记忆超时';
        case 'read-failed':
        case 'error': return result?.message ? `千千结记忆读取失败：${result.message}` : '千千结记忆读取失败';
        default: return result?.message || '千千结记忆状态未知';
    }
}
