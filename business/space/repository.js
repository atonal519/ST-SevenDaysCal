import { normalizeSpaceDocument } from './schema.js';

export function createSpaceRepository({ captureIdentity, isCurrent, readStore, writeStore } = {}) {
    let document = normalizeSpaceDocument(null);
    const capture = () => captureIdentity?.();
    const current = target => !!target && !!isCurrent?.(target);
    const read = target => target?.historyKey ? readStore?.(target.historyKey) : null;
    const load = (target = capture()) => {
        if (current(target)) document = normalizeSpaceDocument(read(target));
        return document.messages;
    };
    const write = (target, next) => {
        if (!current(target) || writeStore?.(target.historyKey, next) === false) return false;
        document = next;
        return true;
    };
    // 消息与页列表同档保存；在途回复只替换消息，不覆盖期间新增的空页。
    const replace = (target, next) => Array.isArray(next) && write(target, { ...document, messages: next });
    const save = (target = capture()) => write(target, document);
    const clearMemory = () => { document = normalizeSpaceDocument(null); return document.messages; };
    const clear = (target = capture()) => write(target, normalizeSpaceDocument(null));
    const addPage = (target = capture()) => {
        if (document.pages.length >= 2) return null;
        return write(target, { ...document, pages: ['1', '2'] }) ? '2' : null;
    };
    const baseline = (target = capture()) => Object.freeze({
        chatId: target?.chatId || '', historyKey: target?.historyKey ?? null, saved: read(target),
    });
    return Object.freeze({ capture, isCurrent: current, read, load, history: () => document.messages,
        pages: () => [...document.pages], replace, save, clear, clearMemory, addPage, baseline });
}
