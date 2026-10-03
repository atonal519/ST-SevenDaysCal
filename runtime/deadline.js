export const LINES_TIME_LIMITS = Object.freeze({ totalMs: 240_000, preparationMs: 60_000, saveMs: 30_000, recallCacheMs: 30_000 });

// 让等待在 owner 取消或期限到达时真实 settle；迟到 Promise 仍被接管，避免未处理拒绝。
export function createDeadlineSignal({ signal = null, deadlineAt = Infinity, timeoutMs = Infinity, reason = 'operation-timeout' } = {}) {
    const controller = new AbortController();
    const deadline = Math.min(Number.isFinite(Number(deadlineAt)) ? Number(deadlineAt) : Infinity,
        Number.isFinite(Number(timeoutMs)) ? Date.now() + Math.max(0, Number(timeoutMs)) : Infinity);
    let timer = null;
    const onAbort = () => controller.abort(signal?.reason || new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    if (!controller.signal.aborted && Number.isFinite(deadline)) {
        const delay = Math.max(0, deadline - Date.now());
        timer = setTimeout(() => controller.abort(Object.assign(new Error(reason), { name: 'TimeoutError', code: 'operation-timeout' })), delay);
    }
    return {
        signal: controller.signal,
        deadlineAt: deadline,
        dispose() {
            if (timer !== null) clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
        },
    };
}

export function waitForSignal(value, signal) {
    const pending = Promise.resolve(value);
    if (!signal) return pending;
    if (signal.aborted) {
        pending.catch(() => {});
        return Promise.reject(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, result) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback(result);
        };
        const onAbort = () => finish(reject, signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(result => finish(resolve, result), error => finish(reject, error));
    });
}
