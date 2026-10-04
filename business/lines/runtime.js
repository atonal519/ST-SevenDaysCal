export function createLinesRuntime({ render = value => value, onBusyChange = () => {} } = {}) {
    let busy = false;
    let controller = null;
    let label = '';
    let cachedRaw = '';
    let cachedHtml = '';
    // The runtime owns one shared busy period, even when preflight hands off to generation.
    const setBusy = value => {
        const next = Boolean(value);
        if (busy === next) return;
        busy = next;
        try { onBusyChange(next); } catch { /* UI feedback must not interrupt line work. */ }
    };
    return {
        get busy() { return busy; },
        get controller() { return controller; },
        get raw() { return cachedRaw; },
        get html() { return cachedHtml; },
        get label() { return label; },
        start(nextController, nextLabel = '') { controller = nextController || null; label = String(nextLabel || ''); setBusy(true); return controller; },
        cache(raw) { cachedRaw = String(raw || ''); cachedHtml = render(cachedRaw); return cachedHtml; },
        setHtml(html) { cachedHtml = String(html || ''); return cachedHtml; },
        finish(ownerController = controller) { if (ownerController && controller !== ownerController) return false; controller = null; label = ''; setBusy(false); return true; },
        abort(reason = 'manual-abort') { controller?.abort?.(reason); controller = null; label = ''; setBusy(false); },
        resetDisplay() { cachedRaw = ''; cachedHtml = ''; },
        reset() { controller = null; label = ''; setBusy(false); cachedRaw = ''; cachedHtml = ''; },
    };
}
