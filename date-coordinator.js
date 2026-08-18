const COMPLETED_RESULT_CACHE_LIMIT = 16;

function normalizeRenderKey(value) {
    if (!value || typeof value !== 'object') return null;
    const chatId = String(value.chatId ?? '');
    const messageId = Number(value.messageId);
    const swipeId = Number(value.swipeId ?? 0);
    const contentSignature = String(value.contentSignature ?? '');
    if (!chatId || !Number.isInteger(messageId) || !Number.isFinite(swipeId) || !contentSignature) return null;
    return {
        chatId,
        messageId,
        swipeId,
        contentSignature,
        id: `${chatId}::${messageId}::${swipeId}::${contentSignature}`,
        floorId: `${chatId}::${messageId}`,
    };
}

function cancelledResult() {
    return { status: 'cancelled' };
}

function waitWithSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.resolve(cancelledResult());
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => finish(cancelledResult());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(finish, error => finish({ status: 'failed', error }));
    });
}

function hasResolvedDate(result) {
    return !!result?.date && Number.isFinite(Number(result.date.month)) && Number.isFinite(Number(result.date.day));
}

// 同一版正文的日期任务只执行一次；业务层仍决定何时检测、如何解析及怎样落地日期。
export function createDateCoordinator() {
    const records = new Map();

    // 只保留近期已完成结果，足以覆盖界面重绘，又不会让长聊天无限积累内存记录。
    function pruneCompleted(limit = COMPLETED_RESULT_CACHE_LIMIT) {
        const completed = [...records.entries()].filter(([, record]) => record.result !== null);
        for (const [id] of completed.slice(0, Math.max(0, completed.length - limit))) records.delete(id);
    }

    function retireOlderVersions(key) {
        const predecessors = [];
        for (const [id, record] of records) {
            if (record.key.floorId !== key.floorId || id === key.id) continue;
            if (record.promise) predecessors.push(record.promise);
            record.valid = false;
            record.controller.abort();
            records.delete(id);
        }
        return predecessors;
    }

    function createRecord(key) {
        const predecessors = retireOlderVersions(key);
        const record = {
            key,
            valid: true,
            resolutionRequired: false,
            controller: new AbortController(),
            promise: null,
            result: null,
            resolutionPromise: null,
            predecessors,
        };
        records.set(key.id, record);
        return record;
    }

    function finishRecord(record, result) {
        const normalized = result && typeof result === 'object'
            ? result
            : { status: 'unresolved' };
        if (!record.valid) return cancelledResult();
        record.result = normalized;
        pruneCompleted();
        return normalized;
    }

    function recordResult(renderKey, result) {
        const key = normalizeRenderKey(renderKey);
        if (!key) return null;
        let record = records.get(key.id);
        if (record) {
            record.valid = false;
            record.controller.abort();
            records.delete(key.id);
        }
        record = createRecord(key);
        record.result = result;
        record.promise = Promise.resolve(result);
        pruneCompleted();
        return result;
    }

    function runOnce(renderKey, execute) {
        const key = normalizeRenderKey(renderKey);
        if (!key || typeof execute !== 'function') return Promise.resolve({ status: 'unresolved' });
        let record = records.get(key.id);
        if (record?.promise) return record.promise;
        if (!record) record = createRecord(key);
        record.promise = Promise.resolve()
            .then(() => Promise.allSettled(record.predecessors))
            .then(() => execute({ signal: record.controller.signal }))
            .then(result => finishRecord(record, result), error => finishRecord(record, {
                status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
                error,
            }));
        return record.promise;
    }

    async function ensureResolved(renderKey, { resolve, signal = null, acceptPrevious = hasResolvedDate } = {}) {
        const key = normalizeRenderKey(renderKey);
        if (!key || typeof resolve !== 'function') return cancelledResult();
        let record = records.get(key.id);
        if (!record) record = createRecord(key);
        record.resolutionRequired = true;

        const previous = record.promise ? await waitWithSignal(record.promise, signal) : record.result;
        if (signal?.aborted) return cancelledResult();
        if (typeof acceptPrevious === 'function' && acceptPrevious(previous)) return previous;
        if (record.resolutionPromise) return waitWithSignal(record.resolutionPromise, signal);

        record.resolutionPromise = Promise.resolve()
            .then(() => Promise.allSettled(record.predecessors))
            .then(() => resolve({
                previousResult: previous || null,
                signal: record.controller.signal,
            }))
            .then(result => finishRecord(record, result), error => finishRecord(record, {
                status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
                error,
            }));
        record.promise = record.resolutionPromise;
        return waitWithSignal(record.resolutionPromise, signal);
    }

    function isResolutionRequired(renderKey) {
        const key = normalizeRenderKey(renderKey);
        return !!key && records.get(key.id)?.resolutionRequired === true;
    }

    function clear() {
        for (const record of records.values()) {
            record.valid = false;
            record.controller.abort();
        }
        records.clear();
    }

    return Object.freeze({ recordResult, runOnce, ensureResolved, isResolutionRequired, clear });
}
