// Runtime-only status notes belong to the visible panel, never to module data or chat snapshots.
const escapeText = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function createPanelFailureStore({ escapeHtml = escapeText } = {}) {
    const entries = new Map();
    const matches = (entry, target) => entry && Object.is(entry.target, target);
    return Object.freeze({
        set(slot, target, text) {
            if (target == null || !String(text || '').trim()) return false;
            entries.set(String(slot), { target, text: String(text) });
            return true;
        },
        clear(slot, target) {
            const key = String(slot);
            if (target === undefined || matches(entries.get(key), target)) return entries.delete(key);
            return false;
        },
        clearTarget(target) {
            let changed = false;
            for (const [slot, entry] of entries) if (matches(entry, target)) { entries.delete(slot); changed = true; }
            return changed;
        },
        clearAll() { entries.clear(); },
        text(slot, target) {
            const entry = entries.get(String(slot));
            return matches(entry, target) ? entry.text : '';
        },
        html(slot, target, className = 'sp-panel-failure-hint') {
            const text = this.text(slot, target);
            return text ? `<div class="${className}" role="status">${escapeHtml(text)}</div>` : '';
        },
    });
}

export function panelFailureHtml(text, { escapeHtml = escapeText, className = 'sp-panel-failure-hint' } = {}) {
    const value = String(text || '').trim();
    return value ? `<div class="${className}" role="status">${escapeHtml(value)}</div>` : '';
}

// A panel has one visible “last failure”; clearing it must not resurrect an older slot.
export function createPanelFailureRecency(store) {
    const latest = new Map();
    return Object.freeze({
        set(group, slot, target, text) { const saved = store.set(slot, target, text); if (saved) latest.set(String(group), String(slot)); return saved; },
        clear(group, slot, target) {
            const cleared = store.clear(slot, target);
            if (cleared && latest.get(String(group)) === String(slot)) latest.delete(String(group));
            return cleared;
        },
        clearAll() { latest.clear(); store.clearAll(); },
        html(group, target) { const slot = latest.get(String(group)); return slot ? store.html(slot, target) : ''; },
    });
}
