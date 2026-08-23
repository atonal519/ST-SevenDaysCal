import { outlineBaseline, outlineCursor, parseOutline, clampOutlineCursor, sameOutlineBaseline } from './schema.js';

const HISTORY_CAP = 20;

export function createOutlineRepository({ captureIdentity, isCurrent, readStore, writeStore, removeStore } = {}) {
    const current = target => !!target && isCurrent?.(target);
    const keyFor = (target, kind) => kind === 'creative-chat' ? target?.creativeChatKey : target?.outlineKey;
    const readKind = (target, kind) => current(target) ? readStore?.(keyFor(target, kind)) ?? null : null;
    const writeKind = (target, kind, value) => current(target) && !!writeStore?.(keyFor(target, kind), value);
    const removeKind = (target, kind) => {
        if (!current(target)) return false;
        removeStore?.(keyFor(target, kind));
        return true;
    };
    const readOutline = target => readKind(target, 'outline');
    const baseline = target => outlineBaseline(readOutline(target));
    const matches = (target, expected) => current(target) && sameOutlineBaseline(readOutline(target), expected);
    const commitOutline = (target, patch, expected = null) => {
        if (!current(target)) return false;
        const saved = readOutline(target);
        if (expected && !sameOutlineBaseline(saved, expected)) return false;
        return writeKind(target, 'outline', { ...(saved || {}), ...patch });
    };
    const setCursor = (target, cursor, expected = null) => {
        const saved = readOutline(target);
        if (!saved?.raw || (expected && !sameOutlineBaseline(saved, expected))) return false;
        const count = parseOutline(saved.raw).length || 1;
        return writeKind(target, 'outline', { ...saved, cursor: clampOutlineCursor(cursor, count) });
    };
    const normalizeHistory = value => (Array.isArray(value) ? value : [])
        .filter(item => item?.role && item?.content)
        .map(item => ({ role: item.role, content: item.content }))
        .slice(-HISTORY_CAP);
    const readHistory = target => normalizeHistory(readKind(target, 'creative-chat'));
    const sameHistory = (target, expected) => current(target)
        && JSON.stringify(readHistory(target)) === JSON.stringify(normalizeHistory(expected));
    const writeHistory = (target, history, expected = null) => {
        if (expected && !sameHistory(target, expected)) return false;
        return writeKind(target, 'creative-chat', normalizeHistory(history));
    };
    return Object.freeze({
        capture: () => captureIdentity?.(),
        isCurrent: current,
        readOutline,
        readRaw: target => readOutline(target)?.raw || '',
        baseline,
        matches,
        cursor: target => outlineCursor(readOutline(target)),
        commitOutline,
        setCursor,
        removeOutline: (target, expected = null) => {
            if (expected && !matches(target, expected)) return false;
            return removeKind(target, 'outline');
        },
        readHistory,
        writeHistory,
        sameHistory,
        clearHistory: target => removeKind(target, 'creative-chat'),
        historyCap: HISTORY_CAP,
    });
}
