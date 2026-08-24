export function createCoordinateUI({ root = null, onDestroy = null } = {}) {
    const route = { level: 'chars', charName: null, chatId: null, itemId: null, filter: null, fullTagEdit: false, tagEditId: null, tagEditColor: 'slate' };
    let destroyed = false; let interactionItemId = null; const cleanups = new Set();
    const listen = (target, event, handler, options) => { target?.addEventListener?.(event, handler, options); const off = () => target?.removeEventListener?.(event, handler, options); cleanups.add(off); return off; };
    return {
        bind(target = root, event, handler, options) { return listen(target, event, handler, options); },
        setRoute(next, id = null, extra = {}) { if (destroyed) return; const value = typeof next === 'object' ? next : { level: next, ...(extra || {}) }; route.level = String(value.level || 'chars'); if ('charName' in value) route.charName = value.charName == null ? null : String(value.charName); if ('chatId' in value) route.chatId = value.chatId == null ? null : String(value.chatId); if ('itemId' in value) route.itemId = value.itemId == null ? null : String(value.itemId); else if (id != null) { if (route.level === 'full') route.itemId = String(id); else if (route.level === 'chats') route.charName = String(id); else route.chatId = String(id); } else if (route.level === 'chars' || route.level === 'tags') { route.chatId = route.itemId = null; } if ('filter' in value) route.filter = value.filter || null; if ('fullTagEdit' in value) route.fullTagEdit = !!value.fullTagEdit; if ('tagEditId' in value) route.tagEditId = value.tagEditId == null ? null : String(value.tagEditId); if ('tagEditColor' in value) route.tagEditColor = String(value.tagEditColor || 'olive'); },
        state: () => ({ ...route, route: route.level }),
        setFilter(next) { const value = next || null; route.filter = route.filter === value ? null : value; },
        setFullTagEdit(next) { route.fullTagEdit = !!next; },
        setTagEdit(id, color = 'slate') { route.tagEditId = id == null ? null : String(id); route.tagEditColor = String(color || 'slate'); },
        setTagEditColor(color) { route.tagEditColor = String(color || 'slate'); },
        fullTagEdit: () => route.fullTagEdit,
        route: () => route.level, itemId: () => interactionItemId ?? route.itemId,
        freezeInteraction: () => { interactionItemId = route.itemId; return interactionItemId; },
        clearInteraction: () => { interactionItemId = null; },
        open(next = 'chars') { this.setRoute(next); root?.classList?.add('sp-coordinate-open'); },
        close() { this.setRoute('chars'); root?.classList?.remove('sp-coordinate-open'); },
        destroy() { if (destroyed) return; destroyed = true; for (const off of cleanups) off(); cleanups.clear(); this.close(); onDestroy?.(); },
        isDestroyed: () => destroyed,
    };
}
