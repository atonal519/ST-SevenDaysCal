import { cloneTheaterList, cloneTheaterPiece, normalizeTheaterList, theaterPieceBaseline } from './schema.js';

export function createTheaterRepository({ storage, metadata, persist, keyForChat, cap = 10 } = {}) {
    let permanentQueue = Promise.resolve();
    const enqueuePermanent = operation => { const task = permanentQueue.then(operation, operation); permanentQueue = task.catch(() => {}); return task; };
    const readDrafts = chatId => {
        const key = keyForChat?.(chatId); if (!key) return [];
        try { return cloneTheaterList(JSON.parse(storage?.getItem?.(key) || '[]')); } catch { return []; }
    };
    const writeDrafts = (chatId, list) => {
        const key = keyForChat?.(chatId); if (!key) return false;
        try { storage?.setItem?.(key, JSON.stringify(normalizeTheaterList(list).slice(-cap))); return { ok: true }; } catch (error) { return { ok: false, error }; }
    };
    const readMeta = target => {
        const m = target?.metadata || metadata?.(); if (!m || typeof m !== 'object') return null;
        if (!Array.isArray(m.saved)) m.saved = []; if (m.version !== 1) m.version = 1;
        return m;
    };
    const changed = () => ({ ok: false, conflict: true, commitState: 'conflict', error: new Error('theater-piece-conflict') });
    const save = target => {
        try { const pending = (target?.persist || persist)?.(); pending?.catch?.(error => console.warn('[SP theater] host save rejected after local apply', error)); }
        catch (error) { console.warn('[SP theater] host save threw after local apply', error); }
        return { ok: true, chatId: target?.chatId, dispatched: true, commitState: 'local-applied' };
    };
    return {
        loadDrafts: readDrafts,
        pushDraft: (chatId, piece) => writeDrafts(chatId, [...readDrafts(chatId), cloneTheaterPiece(piece)]),
        updateDraft(chatId, id, patch, baseline) {
            const list = readDrafts(chatId), i = list.findIndex(p => String(p.id) === String(id));
            if (i < 0) return { ok: false, error: new Error('draft-not-found') };
            if (baseline && theaterPieceBaseline(list[i]) !== baseline) return changed();
            list[i] = { ...list[i], ...patch, id: list[i].id }; return writeDrafts(chatId, list);
        },
        deleteDraft(chatId, id, baseline) {
            const list = readDrafts(chatId), current = list.find(p => String(p.id) === String(id));
            if (!current) return { ok: false, missing: true };
            if (baseline && theaterPieceBaseline(current) !== baseline) return changed();
            return writeDrafts(chatId, list.filter(p => String(p.id) !== String(id)));
        },
        loadSaved: target => cloneTheaterList(readMeta(target)?.saved || []),
        promoteToSaved: (target, piece, options = {}) => enqueuePermanent(async () => {
            const m = readMeta(target); if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            if (options.draftBaseline && theaterPieceBaseline(readDrafts(target?.chatId).find(item => item.id === piece?.id)) !== options.draftBaseline) return changed();
            if (options.savedBaseline && theaterPieceBaseline(m.saved.find(item => item.id === piece?.id)) !== options.savedBaseline) return changed();
            if (m.saved.some(p => p.id === piece?.id)) return { ok: true, duplicate: true };
            m.saved = [...m.saved, cloneTheaterPiece(piece)]; return save(target);
        }),
        updateSavedTitle: (target, id, title, options = {}) => enqueuePermanent(async () => {
            const m = readMeta(target); if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            const index = m.saved.findIndex(item => String(item.id) === String(id));
            if (index < 0) return { ok: false, missing: true, error: new Error('saved-piece-not-found') };
            if (options.savedBaseline && theaterPieceBaseline(m.saved[index]) !== options.savedBaseline) return changed();
            m.saved = m.saved.map((item, i) => i === index ? { ...item, title: String(title ?? '').trim() } : item); return save(target);
        }),
        deleteSaved: (target, id, options = {}) => enqueuePermanent(async () => {
            const m = readMeta(target); if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            if (options.baseline && theaterPieceBaseline(m.saved.find(item => item.id === id)) !== options.baseline) return changed();
            const next = m.saved.filter(p => String(p.id) !== String(id));
            if (next.length === m.saved.length) return { ok: true, missing: true };
            m.saved = next; return save(target);
        }),
        clearSaved: target => enqueuePermanent(async () => {
            const m = readMeta(target); if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            if (!m.saved.length) return { ok: true, missing: true };
            m.saved = []; return save(target);
        }),
        draftBaseline: (chatId, id) => theaterPieceBaseline(readDrafts(chatId).find(piece => piece.id === String(id))),
        savedBaseline: (target, id) => theaterPieceBaseline(readMeta(target)?.saved?.find(piece => String(piece.id) === String(id))),
    };
}
