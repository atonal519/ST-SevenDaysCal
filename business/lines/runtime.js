export function createLinesRuntime({ render = value => value } = {}) {
    let busy = false;
    let controller = null;
    let cachedRaw = '';
    let cachedHtml = '';
    return {
        get busy() { return busy; },
        get controller() { return controller; },
        get raw() { return cachedRaw; },
        get html() { return cachedHtml; },
        start(nextController) { controller = nextController || null; busy = true; return controller; },
        cache(raw) { cachedRaw = String(raw || ''); cachedHtml = render(cachedRaw); return cachedHtml; },
        setHtml(html) { cachedHtml = String(html || ''); return cachedHtml; },
        finish(ownerController = controller) { if (ownerController && controller !== ownerController) return false; controller = null; busy = false; return true; },
        abort() { controller?.abort?.(); controller = null; busy = false; },
        reset() { controller = null; busy = false; cachedRaw = ''; cachedHtml = ''; },
    };
}
