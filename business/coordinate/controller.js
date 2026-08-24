import { currentViewRevision, isCurrentRevision } from './identity.js';

export function createCoordinateController({ repository, capture, ui } = {}) {
    let featureRevision = 0;
    let chat = null;
    let viewRevision = 0;
    const revision = () => { const state = ui?.state?.() || {}; return currentViewRevision({ featureRevision, viewRevision, route: `${state.level || ui?.route?.() || ''}|${state.charName || ''}|${state.chatId || ''}|${state.filter || ''}`, itemId: state.itemId ?? ui?.itemId?.() }); };
    return {
        beginChat(meta = {}) { featureRevision++; viewRevision++; chat = Object.freeze({ ...meta, featureRevision, chatId: meta.chatId ?? null }); return chat; },
        beginView(route = '', itemId = null) { viewRevision++; ui?.setRoute?.(route, itemId); return revision(); },
        snapshotRevision: revision,
        isCurrent(expected) { return isCurrentRevision(expected, revision()); },
        async action(task, expected = revision()) { const value = await task(); return { value, current: isCurrentRevision(expected, revision()) }; },
        async save(meta, source, expected = revision()) { const captured = source && typeof source === 'object' && 'html' in source ? source : (capture?.(source) || { html: source, preview: '' }); const item = { ...meta, html: captured.html, textPreview: captured.preview }; const saved = await repository.addItem(item); if (isCurrentRevision(expected, revision())) ui?.onSaved?.(saved); return saved; },
        async delete(id, expected = revision()) { const removed = await repository.deleteItem(id); if (isCurrentRevision(expected, revision())) ui?.onDeleted?.(id); return removed; },
        chat() { return chat; },
        invalidate() { featureRevision++; viewRevision++; },
    };
}
