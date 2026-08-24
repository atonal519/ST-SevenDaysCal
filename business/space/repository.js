import { normalizeSpaceHistory } from './schema.js';

export function createSpaceRepository({ captureIdentity, isCurrent, readStore, writeStore } = {}) {
    let history = [];
    const capture = () => captureIdentity?.();
    const current = target => !!target && !!isCurrent?.(target);
    const read = target => target?.historyKey ? readStore?.(target.historyKey) : null;
    const load = (target = capture()) => {
        if (!current(target)) return history;
        history = normalizeSpaceHistory(read(target));
        return history;
    };
    const replace = (target, next) => {
        if (!current(target) || !Array.isArray(next)) return false;
        history = next;
        return writeStore?.(target.historyKey, history) !== false;
    };
    const save = (target = capture()) => replace(target, history);
    const clearMemory = () => { history = []; return history; };
    const clear = (target = capture()) => replace(target, []);
    const baseline = (target = capture()) => Object.freeze({
        chatId: target?.chatId || '',
        historyKey: target?.historyKey ?? null,
        saved: read(target),
    });
    return Object.freeze({
        capture,
        isCurrent: current,
        read,
        load,
        history: () => history,
        replace,
        save,
        clear,
        clearMemory,
        baseline,
    });
}
