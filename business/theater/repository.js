import { cloneTheaterList, cloneTheaterPiece, normalizeTheaterList, theaterPieceBaseline } from './schema.js';

export function createTheaterRepository({ storage, metadata, persist, keyForChat, cap = 10, metadataSaver = null, requireFixedSaver = false } = {}) {
    const operationKey = (operation, chatId, id = '') => [operation, chatId, id].map(value => encodeURIComponent(String(value ?? ''))).join('|');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const rollback = (meta, before, owned) => { if (meta.saved === owned || same(meta.saved, owned)) meta.saved = before; };
    // 入队时绑定 target；切聊天后取消，避免队列出队时把 A 的永久操作落到 B。
    // 永久层所有 mutate + persist 必须串行；失败也要让后续操作继续排队。
    let permanentQueue = Promise.resolve();
    const unknownCommits = new Map();
    const confirmUnknown = async (key, fixed) => {
        const pending = unknownCommits.get(key); if (!pending || !metadataSaver?.confirm) return null;
        const confirmation = await metadataSaver.confirm(pending);
        if (confirmation?.confirmed) { unknownCommits.delete(key); return { ok: true, chatId: fixed.chatId, dispatched: true, commitState: 'confirmed', confirmed: true }; }
        if (confirmation?.available === false) return { ok: false, dispatched: true, commitState: 'unknown', reason: 'confirmation-unavailable' };
        if (confirmation?.submitted !== false) return { ok: false, dispatched: true, commitState: 'unknown', reason: 'confirmation-conflict' };
        const retried = await metadataSaver.dispatch(pending, { isCurrent: fixed.isCurrent });
        if (retried?.commitState === 'unknown') unknownCommits.set(key, pending); else unknownCommits.delete(key);
        return { ...retried, chatId: fixed.chatId };
    };
    const enqueuePermanent = operation => {
        const task = permanentQueue.then(operation, operation);
        permanentQueue = task.catch(() => {});
        return task;
    };
    const readDrafts = chatId => {
        const key = keyForChat?.(chatId); if (!key) return [];
        try { return cloneTheaterList(JSON.parse(storage?.getItem?.(key) || '[]')); } catch { return []; }
    };
    const writeDrafts = (chatId, list) => {
        const key = keyForChat?.(chatId); if (!key) return false;
        try { storage?.setItem?.(key, JSON.stringify(normalizeTheaterList(list).slice(-cap))); return { ok: true }; } catch (error) { return { ok: false, error }; }
    };
    const resolveTarget = target => {
        const fixed = target && typeof target === 'object' ? target : {};
        return {
            chatId: fixed.chatId,
            external: fixed.external === true,
            metadata: fixed.metadata || metadata?.(),
            persist: fixed.persist || persist,
            isCurrent: fixed.isCurrent || (() => true),
            metadataSnapshot: fixed.metadataSnapshot,
            target: fixed.target,
        };
    };
    const readMeta = target => {
        const m = resolveTarget(target).metadata;
        if (!m || typeof m !== 'object') return null;
        if (!Array.isArray(m.saved)) m.saved = [];
        if (m.version !== 1) m.version = 1;
        return m;
    };
    const fixedUnavailable = fixed => fixed.external === true && requireFixedSaver && (!metadataSaver || typeof metadataSaver.capture !== 'function' || typeof metadataSaver.dispatch !== 'function' || !fixed.target);
    const notDispatched = () => ({ ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'fixed-saver-unavailable', error: new Error('theater-fixed-saver-unavailable') });
    const persistLocal = fixed => {
        try {
            const pending = fixed.persist?.();
            pending?.catch?.(error => console.warn('[SP theater] host save rejected after local apply', error));
        } catch (error) { console.warn('[SP theater] host save threw after local apply', error); }
        return { ok: true, dispatched: true, commitState: 'local-applied' };
    };
    return {
        loadDrafts: chatId => readDrafts(chatId),
        pushDraft: (chatId, piece) => { const list = readDrafts(chatId); return writeDrafts(chatId, [...list, cloneTheaterPiece(piece)]); },
        updateDraft: (chatId, id, patch, baseline) => { const list = readDrafts(chatId); const i = list.findIndex(p => String(p.id) === String(id)); if (i < 0) return { ok: false, error: new Error('draft-not-found') }; if (baseline && theaterPieceBaseline(list[i]) !== baseline) return { ok: false, conflict: true, commitState: 'conflict', error: new Error('theater-piece-conflict') }; list[i] = { ...list[i], ...patch, id: list[i].id }; return writeDrafts(chatId, list); },
        deleteDraft: (chatId, id, baseline) => { const list = readDrafts(chatId); const current = list.find(p => String(p.id) === String(id)); if (!current) return { ok: false, missing: true }; if (baseline && theaterPieceBaseline(current) !== baseline) return { ok: false, conflict: true, commitState: 'conflict', error: new Error('theater-piece-conflict') }; return writeDrafts(chatId, list.filter(p => String(p.id) !== String(id))); },
        loadSaved: target => cloneTheaterList(readMeta(target)?.saved || []),
        promoteToSaved: (target, piece, options = {}) => enqueuePermanent(async () => {
            const fixed = resolveTarget(target);
            if (fixedUnavailable(fixed)) return notDispatched();
            if (fixed.external && metadataSaver && !fixed.target) return { ok: false, commitState: 'not-dispatched', reason: 'fixed-target-unavailable', error: new Error('theater-target-unavailable') };
            const m = readMeta(fixed);
            if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            const before = m.saved.slice();
            if (options.draftBaseline && theaterPieceBaseline(readDrafts(fixed.chatId).find(item => item.id === piece?.id)) !== options.draftBaseline) return { ok: false, conflict: true, commitState: 'conflict', error: new Error('theater-piece-conflict') };
            if (options.savedBaseline && theaterPieceBaseline(m.saved.find(item => item.id === piece?.id)) !== options.savedBaseline) return { ok: false, conflict: true, commitState: 'conflict', error: new Error('theater-piece-conflict') };
            const unknownKey = operationKey('promote', fixed.chatId, piece?.id);
            if (fixed.external) { const confirmed = await confirmUnknown(unknownKey, fixed); if (confirmed) return confirmed; }
            if (m.saved.some(p => p.id === piece?.id)) return { ok: true, duplicate: true };
            m.saved = [...before, cloneTheaterPiece(piece)]; const owned = m.saved;
            try {
                let saved;
                if (fixed.external && metadataSaver?.capture && fixed.target) {
                    const after = { ...(fixed.metadataSnapshot || {}), 'sp-theater': m };
                    const captured = metadataSaver.capture(fixed.target, after); if (!captured) { rollback(m, before, owned); return notDispatched(); }
                    saved = await metadataSaver.dispatch(captured, { isCurrent: fixed.isCurrent });
                    if (saved?.commitState === 'unknown') unknownCommits.set(unknownKey, captured);
                } else saved = persistLocal(fixed);
                if (!saved?.ok && saved?.commitState !== 'unknown') { rollback(m, before, owned); return { ...saved, error: saved.error || new Error('theater-persist-failed') }; }
                if (!saved?.ok) return { ...saved, chatId: fixed.chatId };
                return { ok: true, chatId: fixed.chatId, ...saved };
            }
            catch (error) { rollback(m, before, owned); return { ok: false, error }; }
        }),
        updateSavedTitle: (target, id, title, options = {}) => enqueuePermanent(async () => {
            const fixed = resolveTarget(target);
            if (fixedUnavailable(fixed)) return notDispatched();
            if (fixed.external && metadataSaver && !fixed.target) return { ok: false, commitState: 'not-dispatched', reason: 'fixed-target-unavailable', error: new Error('theater-target-unavailable') };
            const m = readMeta(fixed);
            if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            const before = m.saved.slice();
            const index = before.findIndex(item => String(item.id) === String(id));
            if (index < 0) return { ok: false, missing: true, error: new Error('saved-piece-not-found') };
            if (options.savedBaseline && theaterPieceBaseline(before[index]) !== options.savedBaseline) return { ok: false, conflict: true, commitState: 'conflict', error: new Error('theater-piece-conflict') };
            const key = operationKey('title', fixed.chatId, id);
            if (fixed.external) { const confirmed = await confirmUnknown(key, fixed); if (confirmed) return confirmed; }
            // Patch the saved piece so a stale draft can never overwrite its permanent body.
            m.saved = before.map((item, itemIndex) => itemIndex === index ? { ...item, title: String(title ?? '').trim() } : item);
            const owned = m.saved;
            try {
                let saved;
                if (fixed.external && metadataSaver?.capture && fixed.target) {
                    const captured = metadataSaver.capture(fixed.target, { ...(fixed.metadataSnapshot || {}), 'sp-theater': m });
                    if (!captured) { rollback(m, before, owned); return notDispatched(); }
                    saved = await metadataSaver.dispatch(captured, { isCurrent: fixed.isCurrent });
                    if (saved?.commitState === 'unknown') unknownCommits.set(key, captured);
                } else saved = persistLocal(fixed);
                if (!saved?.ok && saved?.commitState !== 'unknown') { rollback(m, before, owned); return { ...saved, error: saved.error || new Error('theater-persist-failed') }; }
                return { ok: true, chatId: fixed.chatId, ...saved };
            } catch (error) { rollback(m, before, owned); return { ok: false, error }; }
        }),
        deleteSaved: (target, id, options = {}) => enqueuePermanent(async () => {
            const fixed = resolveTarget(target);
            if (fixedUnavailable(fixed)) return notDispatched();
            if (fixed.external && metadataSaver && !fixed.target) return { ok: false, commitState: 'not-dispatched', reason: 'fixed-target-unavailable', error: new Error('theater-target-unavailable') };
            const m = readMeta(fixed);
            if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            const before = m.saved.slice();
            const unknownKey = operationKey('delete', fixed.chatId, id);
            if (fixed.external) { const confirmed = await confirmUnknown(unknownKey, fixed); if (confirmed) return confirmed; }
            if (options.baseline && theaterPieceBaseline(before.find(item => item.id === id)) !== options.baseline) return { ok: false, conflict: true, commitState: 'conflict', error: new Error('theater-piece-conflict') };
            const next = before.filter(p => p.id !== id);
            if (next.length === before.length) return { ok: true, missing: true };
            m.saved = next; const owned = m.saved;
            try {
                let saved;
                if (fixed.external && metadataSaver?.capture && fixed.target) {
                    const after = { ...(fixed.metadataSnapshot || {}), 'sp-theater': m };
                    const captured = metadataSaver.capture(fixed.target, after); if (!captured) { rollback(m, before, owned); return notDispatched(); }
                    saved = await metadataSaver.dispatch(captured, { isCurrent: fixed.isCurrent });
                    if (saved?.commitState === 'unknown') unknownCommits.set(unknownKey, captured);
                } else saved = persistLocal(fixed);
                if (!saved?.ok && saved?.commitState !== 'unknown') { rollback(m, before, owned); return { ...saved, error: saved.error || new Error('theater-persist-failed') }; }
                if (!saved?.ok) return { ...saved, chatId: fixed.chatId };
                return { ok: true, chatId: fixed.chatId, ...saved };
            }
            catch (error) { rollback(m, before, owned); return { ok: false, error }; }
        }),
        clearSaved: (target, options = {}) => enqueuePermanent(async () => {
            const fixed = resolveTarget(target);
            if (fixedUnavailable(fixed)) return notDispatched();
            if (fixed.external && metadataSaver && !fixed.target) return { ok: false, commitState: 'not-dispatched', reason: 'fixed-target-unavailable', error: new Error('theater-target-unavailable') };
            const m = readMeta(fixed); if (!m) return { ok: false, error: new Error('metadata-unavailable') };
            const unknownKey = operationKey('clear', fixed.chatId, '');
            if (fixed.external) { const confirmed = await confirmUnknown(unknownKey, fixed); if (confirmed) return confirmed; }
            const before = m.saved.slice(); if (!before.length) return { ok: true, missing: true };
            m.saved = []; const owned = m.saved;
            try {
                const captured = fixed.external && metadataSaver?.capture && fixed.target ? metadataSaver.capture(fixed.target, { ...(fixed.metadataSnapshot || {}), 'sp-theater': m }) : null;
                if (fixed.external && requireFixedSaver && !captured) { rollback(m, before, owned); return notDispatched(); }
                const saved = captured
                    ? await metadataSaver.dispatch(captured, { isCurrent: fixed.isCurrent })
                    : persistLocal(fixed);
                if (saved?.commitState === 'unknown' && captured) unknownCommits.set(unknownKey, captured);
                if (!saved?.ok && saved?.commitState !== 'unknown') { rollback(m, before, owned); return { ...saved, error: saved.error || new Error('theater-persist-failed') }; }
                if (!saved?.ok) return { ...saved, chatId: fixed.chatId };
                return { ok: true, ...saved };
            } catch (error) { rollback(m, before, owned); return { ok: false, error }; }
        }),
        draftBaseline: (chatId, id) => theaterPieceBaseline(readDrafts(chatId).find(piece => piece.id === String(id))),
        savedBaseline: (target, id) => theaterPieceBaseline(readMeta(target)?.saved?.find(piece => String(piece.id) === String(id))),
    };
}
