import { outlineBaseline, outlineCursor, parseOutline, clampOutlineCursor, sameOutlineBaseline } from './schema.js';

export function createOutlineRepository({ captureIdentity, isCurrent, readStore, writeStore, writeStoreConfirmed, removeStore } = {}) {
    const current = target => !!target && isCurrent?.(target);
    const keyFor = target => target?.outlineKey;
    const readKind = target => current(target) ? readStore?.(keyFor(target)) ?? null : null;
    const writeKind = (target, value) => current(target) && !!writeStore?.(keyFor(target), value);
    const writeKindConfirmed = async (target, value, options = {}) => {
        if (!current(target)) return false;
        if (typeof writeStoreConfirmed !== 'function') return writeKind(target, value);
        const stored = await writeStoreConfirmed(keyFor(target), value, options);
        return stored === true ? true : stored;
    };
    const removeKind = target => {
        if (!current(target)) return false;
        removeStore?.(keyFor(target));
        return true;
    };
    const readOutline = target => readKind(target);
    const baseline = target => outlineBaseline(readOutline(target));
    const matches = (target, expected) => current(target) && sameOutlineBaseline(readOutline(target), expected);
    const commitOutline = (target, patch, expected = null) => {
        if (!current(target)) return false;
        const saved = readOutline(target);
        if (expected && !sameOutlineBaseline(saved, expected)) return false;
        return writeKind(target, { ...(saved || {}), ...patch });
    };
    const commitOutlineConfirmed = async (target, patch, expected = null, options = {}) => {
        if (!current(target)) return false;
        const saved = readOutline(target);
        if (expected && !sameOutlineBaseline(saved, expected)) return false;
        return writeKindConfirmed(target, { ...(saved || {}), ...patch }, options);
    };
    const setCursor = (target, cursor, expected = null) => {
        const saved = readOutline(target);
        if (!saved?.raw || (expected && !sameOutlineBaseline(saved, expected))) return false;
        const count = parseOutline(saved.raw).length || 1;
        return writeKind(target, { ...saved, cursor: clampOutlineCursor(cursor, count) });
    };
    const setCursorConfirmed = async (target, cursor, expected = null, options = {}) => {
        const saved = readOutline(target);
        if (!saved?.raw || (expected && !sameOutlineBaseline(saved, expected))) return false;
        const count = parseOutline(saved.raw).length || 1;
        return writeKindConfirmed(target, { ...saved, cursor: clampOutlineCursor(cursor, count) }, options);
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
        commitOutlineConfirmed,
        setCursor,
        setCursorConfirmed,
        removeOutline: (target, expected = null) => {
            if (expected && !matches(target, expected)) return false;
            return removeKind(target, 'outline');
        },
    });
}
