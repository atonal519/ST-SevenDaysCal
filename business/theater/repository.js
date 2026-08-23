import { normalizeTheaterList } from './schema.js';

export function createTheaterRepository({ storage, metadata, persist, keyForChat, cap = 10 } = {}) {
    // 入队时绑定 target；切聊天后取消，避免队列出队时把 A 的永久操作落到 B。
    // 永久层所有 mutate + persist 必须串行；失败也要让后续操作继续排队。
    let permanentQueue = Promise.resolve();
    const enqueuePermanent = operation => {
        const task = permanentQueue.then(operation, operation);
        permanentQueue = task.catch(() => {});
        return task;
    };
    const readDrafts = chatId => {
        const key = keyForChat?.(chatId); if (!key) return [];
        try { return normalizeTheaterList(JSON.parse(storage?.getItem?.(key) || '[]')); } catch { return []; }
    };
    const writeDrafts = (chatId, list) => {
        const key = keyForChat?.(chatId); if (!key) return false;
        try { storage?.setItem?.(key, JSON.stringify(normalizeTheaterList(list).slice(-cap))); return { ok: true }; } catch (error) { return { ok: false, error }; }
    };
    const resolveTarget = target => {
        const fixed = target && typeof target === 'object' ? target : {};
        return {
            chatId: fixed.chatId,
            metadata: fixed.metadata || metadata?.(),
            persist: fixed.persist || persist,
            isCurrent: fixed.isCurrent || (() => true),
        };
    };
    const readMeta = target => {
        const m = resolveTarget(target).metadata;
        if (!m || typeof m !== 'object') return null;
        if (!Array.isArray(m.saved)) m.saved = [];
        if (m.version !== 1) m.version = 1;
        return m;
    };
    return {
        loadDrafts: chatId => readDrafts(chatId),
        pushDraft: (chatId, piece) => { const list = readDrafts(chatId); return writeDrafts(chatId, [...list, piece]); },
        updateDraft: (chatId, id, patch) => { const list = readDrafts(chatId); const i = list.findIndex(p => p.id === id); if (i < 0) return { ok: false, error: new Error('draft-not-found') }; list[i] = { ...list[i], ...patch, id: list[i].id }; return writeDrafts(chatId, list); },
        deleteDraft: (chatId, id) => writeDrafts(chatId, readDrafts(chatId).filter(p => p.id !== id)),
        loadSaved: target => readMeta(target)?.saved.slice() || [],
        promoteToSaved: (target, piece) => enqueuePermanent(async () => {
            const fixed = resolveTarget(target);
            if (!fixed.isCurrent()) return { ok: false, cancelled: true, error: new Error('theater-chat-changed') };
            const m = readMeta(fixed);
            if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            const before = m.saved.slice();
            if (m.saved.some(p => p.id === piece?.id)) return { ok: true, duplicate: true };
            if (!fixed.isCurrent()) return { ok: false, cancelled: true, error: new Error('theater-chat-changed') };
            m.saved = [...before, { ...piece }];
            if (!fixed.isCurrent()) { m.saved = before; return { ok: false, cancelled: true, error: new Error('theater-chat-changed') }; }
            // saveMetadata 开始后的切换属于明确不支持边界；这里只保证开始前不跨聊天。
            try { await fixed.persist?.(); return { ok: true, chatId: fixed.chatId }; }
            catch (error) { m.saved = before; return { ok: false, error }; }
        }),
        deleteSaved: (target, id) => enqueuePermanent(async () => {
            const fixed = resolveTarget(target);
            if (!fixed.isCurrent()) return { ok: false, cancelled: true, error: new Error('theater-chat-changed') };
            const m = readMeta(fixed);
            if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            const before = m.saved.slice();
            const next = before.filter(p => p.id !== id);
            if (next.length === before.length) return { ok: true, missing: true };
            if (!fixed.isCurrent()) return { ok: false, cancelled: true, error: new Error('theater-chat-changed') };
            m.saved = next;
            if (!fixed.isCurrent()) { m.saved = before; return { ok: false, cancelled: true, error: new Error('theater-chat-changed') }; }
            try { await fixed.persist?.(); return { ok: true, chatId: fixed.chatId }; }
            catch (error) { m.saved = before; return { ok: false, error }; }
        }),
    };
}
