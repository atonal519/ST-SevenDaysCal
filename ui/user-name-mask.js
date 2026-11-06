const marker = 'data-sp-user-name-mask';
const hiddenAttributes = ['title', 'alt', 'placeholder'];
const editableInputTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'number']);
const skippedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);
const mirrorProperties = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform', 'direction', 'writing-mode', 'tab-size', 'word-break', 'overflow-wrap',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'];
const fieldProperties = ['-webkit-text-fill-color', 'text-shadow', 'caret-color'];
const nameList = names => [...new Set((typeof names === 'string' ? [names] : Array.from(names || [])).filter(name => typeof name === 'string' && name.length))].sort((a, b) => b.length - a.length || a.localeCompare(b));

// UTF-16 offsets deliberately match Text.splitText and DOM Range offsets.
export function findUserNameRanges(text, names) {
    text = String(text ?? '');
    const candidates = nameList(names), ranges = [];
    for (let start = 0; start < text.length;) {
        const name = candidates.find(value => text.startsWith(value, start));
        if (name) { ranges.push({ start, end: start + name.length }); start += name.length; }
        else start += text.codePointAt(start) > 0xffff ? 2 : 1;
    }
    return ranges;
}

export function createUserNameMask({ documentRef = globalThis.document, getRoots = () => [], getNames = () => [] } = {}) {
    const view = documentRef.defaultView || globalThis;
    const observers = new Map(), spans = new Set(), attributes = new Map(), fields = new Map();
    const dirtyScopes = new Set(), dirtyFields = new Set();
    let enabled = false, disposed = false, queued = false, updating = false, names = [], namesKey = '';
    let roots = new Set(), surfaces = [], fullScan = false, checkNames = false, checkRoots = false, allFields = false, pruneNeeded = false;
    const computed = element => view.getComputedStyle(element);
    const contains = (scope, node) => scope === node || scope?.contains?.(node);
    function containsAcrossShadow(scope, node) {
        for (let current = node; current; current = current.getRootNode?.().host) if (contains(scope, current)) return true;
        return false;
    }
    const owns = node => surfaces.some(root => containsAcrossShadow(root, node));
    const schedule = () => {
        if (!enabled || disposed || updating || queued) return;
        queued = true;
        queueMicrotask(() => { queued = false; flush(); });
    };
    const markScope = scope => { if (scope) dirtyScopes.add(scope); };
    function markMirrors(scope) {
        for (const field of fields.keys()) if (!scope || containsAcrossShadow(scope, field) || contains(field, scope)) dirtyFields.add(field);
    }
    function inputField(node) {
        if (node?.nodeType === 3) node = node.parentElement;
        for (const field of fields.keys()) if (contains(field, node)) return field;
        if (!node || !editable(node)) return null;
        while (node.parentElement?.isContentEditable && owns(node.parentElement)) node = node.parentElement;
        return node;
    }
    const inputChanged = event => {
        if (!enabled) return;
        const field = inputField(event.composedPath?.()[0] || event.target);
        if (field && owns(field)) { checkNames = true; dirtyFields.add(field); schedule(); }
    };
    const scrolled = event => {
        if (!enabled) return;
        markMirrors(event.composedPath?.()[0] || event.target); schedule();
    };
    const fontsChanged = () => { if (enabled) { allFields = true; schedule(); } };
    const viewportChanged = () => { if (enabled) { fullScan = true; checkRoots = true; schedule(); } };
    const resizeObserver = view.ResizeObserver ? new view.ResizeObserver(entries => {
        if (!enabled) return;
        for (const entry of entries) markMirrors(entry.target);
        schedule();
    }) : null;
    let resizeTargets = new Set();

    function discover(scope) {
        if (!scope) return [];
        const added = [], visited = new Set();
        const shadow = host => {
            const root = host?.shadowRoot;
            if (!root || roots.has(root) || !owns(root)) return;
            roots.add(root); added.push(root); visit(root);
        };
        const visit = root => {
            if (visited.has(root)) return;
            visited.add(root); shadow(root);
            for (const node of root.querySelectorAll?.('*') || []) shadow(node);
        };
        visit(scope);
        return added;
    }
    function reconcileRoots() {
        surfaces = [...new Set(getRoots() || [])].filter(root => root && root.isConnected !== false);
        for (const root of roots) if (root.isConnected === false || !owns(root)) { roots.delete(root); pruneNeeded = true; }
        for (const root of surfaces) if (!roots.has(root)) {
            roots.add(root); markScope(root);
            for (const added of discover(root)) markScope(added);
        }
    }
    function mutations(records) {
        if (!enabled) return;
        if (records.length) checkNames = true;
        for (const record of records) {
            if (record.type === 'childList') {
                for (const node of record.addedNodes) markScope(node);
                if (record.removedNodes.length) { pruneNeeded = true; markScope(record.target); }
            } else {
                markScope(record.target);
                if (record.type === 'attributes' && record.attributeName === 'class' && surfaces.includes(record.target)) checkRoots = true;
            }
        }
        schedule();
    }
    function pause() {
        // Synchronous field refresh must also process real changes whose callback has not run yet.
        for (const { observer } of observers.values()) {
            if (observer) mutations(observer.takeRecords());
            observer?.disconnect();
        }
    }
    function connect() {
        for (const [root, value] of observers) if (!roots.has(root)) {
            value.observer?.disconnect();
            for (const type of ['input', 'compositionupdate', 'compositionend']) root.removeEventListener(type, inputChanged, true);
            root.removeEventListener('scroll', scrolled, true);
            observers.delete(root);
        }
        for (const root of roots) {
            let value = observers.get(root);
            if (!value) {
                value = { observer: view.MutationObserver ? new view.MutationObserver(mutations) : null };
                observers.set(root, value);
                for (const type of ['input', 'compositionupdate', 'compositionend']) root.addEventListener(type, inputChanged, true);
                root.addEventListener('scroll', scrolled, true);
            }
            value.observer?.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
                attributeFilter: [...hiddenAttributes, 'label', 'class', 'style', 'hidden', 'value', 'type', 'wrap', 'contenteditable', 'open'] });
        }
    }
    function unwrap(span) {
        const parent = span.parentNode;
        if (parent) { while (span.firstChild) parent.insertBefore(span.firstChild, span); span.remove(); }
        spans.delete(span);
    }
    function restoreAttributes(element, saved) {
        for (const [name, value] of saved) if (element.getAttribute(name) === value.applied) {
            if (value.original === null) element.removeAttribute(name); else element.setAttribute(name, value.original);
        }
        attributes.delete(element);
    }
    function restoreFieldStyles(field, saved) {
        for (const [name, original] of saved.styles) {
            const value = field.style.getPropertyValue(name), priority = field.style.getPropertyPriority(name);
            if (original.applied && (value !== original.applied || priority !== 'important')) { original.value = value; original.priority = priority; }
            if (original.value) field.style.setProperty(name, original.value, original.priority); else field.style.removeProperty(name);
        }
    }
    function removeMirror(field, saved) {
        saved.mirror.remove();
        restoreFieldStyles(field, saved);
        fields.delete(field);
    }
    function restoreAll() {
        for (const span of [...spans]) unwrap(span);
        for (const [element, saved] of attributes) restoreAttributes(element, saved);
        for (const [field, saved] of fields) removeMirror(field, saved);
    }
    function glyph(text) {
        const span = documentRef.createElement('span');
        span.setAttribute(marker, 'text');
        // Inline glyphs keep native line wrapping and copy the original text.
        span.style.cssText = 'display:inline!important;-webkit-text-fill-color:transparent!important;text-shadow:0 0 .32em currentColor!important';
        if (text !== undefined) span.textContent = text;
        return span;
    }
    function maskedAttribute(text) {
        const ranges = findUserNameRanges(text, names);
        let result = '', end = 0;
        for (const range of ranges) { result += text.slice(end, range.start) + '•'.repeat(Array.from(text.slice(range.start, range.end)).length); end = range.end; }
        return result + text.slice(end);
    }
    function maskAttributes(element) {
        const saved = attributes.get(element) || new Map();
        const keys = element.tagName === 'OPTION' ? [...hiddenAttributes, 'label'] : hiddenAttributes;
        for (const name of keys) {
            const old = saved.get(name), current = element.getAttribute(name);
            const original = old && current === old.applied ? old.original : current;
            const source = name === 'label' && original === null ? element.textContent : original;
            if (source === null) { saved.delete(name); continue; }
            const applied = maskedAttribute(source);
            if (applied === source) {
                if (old && current === old.applied) { if (original === null) element.removeAttribute(name); else element.setAttribute(name, original); }
                saved.delete(name);
            } else {
                saved.set(name, { original, applied });
                if (current !== applied) element.setAttribute(name, applied);
            }
        }
        if (saved.size) attributes.set(element, saved); else attributes.delete(element);
    }
    function wrapFlow(nodes) {
        let offset = 0;
        const parts = nodes.map(node => { const start = offset; offset += node.data.length; return { node, start, end: offset }; });
        const ranges = findUserNameRanges(nodes.map(node => node.data).join(''), names);
        for (const part of parts.reverse()) {
            if (part.node.parentElement?.closest(`[${marker}="text"]`)) continue;
            const cuts = ranges.filter(range => range.start < part.end && range.end > part.start).reverse();
            for (const range of cuts) {
                const start = Math.max(0, range.start - part.start), end = Math.min(part.end - part.start, range.end - part.start);
                if (end < part.node.data.length) part.node.splitText(end);
                const text = start ? part.node.splitText(start) : part.node;
                const span = glyph(); text.replaceWith(span); span.appendChild(text); spans.add(span);
            }
        }
    }
    const editable = element => element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' && editableInputTypes.has(element.type) || element.isContentEditable;
    function scan(scope, candidates) {
        let flow = [];
        const flush = () => { if (flow.length) wrapFlow(flow); flow = []; };
        function walk(node) {
            if (node.nodeType === 3) { flow.push(node); return; }
            if (node.nodeType !== 1) { for (const child of [...node.childNodes]) walk(child); return; }
            if (node.getAttribute(marker) === 'mirror') { flush(); return; }
            maskAttributes(node);
            if (skippedTags.has(node.tagName) || ['SELECT', 'OPTION'].includes(node.tagName)) {
                flush();
                if (node.tagName === 'SELECT') for (const option of node.querySelectorAll('option')) maskAttributes(option);
                return;
            }
            if (editable(node)) { flush(); candidates.add(node); return; }
            if (node.tagName === 'INPUT' || ['BR', 'HR', 'IMG'].includes(node.tagName)) { flush(); return; }
            const display = computed(node).display;
            if (display === 'none') { flush(); return; }
            const boundary = !['inline', 'contents'].includes(display);
            if (boundary) flush();
            for (const child of [...node.childNodes]) walk(child);
            if (boundary) flush();
        }
        walk(scope); flush();
    }
    function drawMirror(field) {
        const value = field.tagName === 'INPUT' || field.tagName === 'TEXTAREA' ? field.value : field.innerText ?? field.textContent;
        let saved = fields.get(field);
        if (!owns(field) || field.isConnected === false || !editable(field) || !field.getClientRects().length || !findUserNameRanges(value, names).length) {
            if (saved) removeMirror(field, saved);
            return;
        }
        if (saved) restoreFieldStyles(field, saved);
        const css = computed(field);
        if (!saved) {
            const mirror = documentRef.createElement('div'), content = documentRef.createElement('div');
            mirror.setAttribute(marker, 'mirror'); mirror.setAttribute('aria-hidden', 'true');
            mirror.style.cssText = 'position:absolute;box-sizing:border-box;margin:0!important;pointer-events:none!important;user-select:none!important;overflow:hidden;z-index:1;border-style:solid;border-color:transparent;background:transparent';
            content.style.cssText = 'margin:0;padding:0;border:0;min-height:100%';
            mirror.appendChild(content); field.parentNode.appendChild(mirror);
            saved = { mirror, content, value: null, styles: new Map(fieldProperties.map(name => [name, { value: field.style.getPropertyValue(name), priority: field.style.getPropertyPriority(name) }])) };
            fields.set(field, saved);
        }
        const { mirror, content } = saved;
        if (mirror.parentNode !== field.parentNode) field.parentNode.appendChild(mirror);
        for (const property of mirrorProperties) mirror.style.setProperty(property, css.getPropertyValue(property));
        mirror.style.color = css.color; mirror.style.setProperty('-webkit-text-fill-color', css.color);
        mirror.style.textShadow = css.textShadow;
        const fixed = css.position === 'fixed', rect = fixed ? field.getBoundingClientRect() : null;
        mirror.style.position = fixed ? 'fixed' : 'absolute';
        mirror.style.left = `${fixed ? rect.left : field.offsetLeft}px`; mirror.style.top = `${fixed ? rect.top : field.offsetTop}px`;
        mirror.style.width = `${field.offsetWidth}px`; mirror.style.height = `${field.offsetHeight}px`;
        content.style.width = `${Math.max(0, field.clientWidth - parseFloat(css.paddingLeft || 0) - parseFloat(css.paddingRight || 0))}px`;
        content.style.whiteSpace = field.tagName === 'INPUT' || field.wrap === 'off' ? 'pre' : field.tagName === 'TEXTAREA' ? 'pre-wrap' : css.whiteSpace;
        if (saved.value !== value) {
            content.replaceChildren();
            let end = 0;
            for (const range of findUserNameRanges(value, names)) { content.append(documentRef.createTextNode(value.slice(end, range.start)), glyph(value.slice(range.start, range.end))); end = range.end; }
            content.append(documentRef.createTextNode(value.slice(end))); saved.value = value;
        }
        mirror.scrollTop = field.scrollTop; mirror.scrollLeft = field.scrollLeft;
        field.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
        field.style.setProperty('text-shadow', 'none', 'important');
        field.style.setProperty('caret-color', css.caretColor === 'auto' ? css.color : css.caretColor, 'important');
        for (const [name, original] of saved.styles) original.applied = field.style.getPropertyValue(name);
    }
    function flowScope(node) {
        if (node?.nodeType === 3) node = node.parentElement || node.parentNode;
        if (!node || node.nodeType !== 1 || roots.has(node) || editable(node)) return node;
        while (node.parentElement && owns(node.parentElement)) {
            if (!['inline', 'contents'].includes(computed(node).display)) break;
            node = node.parentElement;
            if (roots.has(node) || editable(node)) break;
        }
        return node;
    }
    function cleanup() {
        for (const root of roots) if (root.isConnected === false || !owns(root)) roots.delete(root);
        for (const span of [...spans]) if (span.isConnected === false || !owns(span)) unwrap(span);
        for (const [element, saved] of attributes) if (element.isConnected === false || !owns(element)) restoreAttributes(element, saved);
        for (const [field, saved] of fields) if (field.isConnected === false || !owns(field)) removeMirror(field, saved);
    }
    function flush() {
        if (!enabled || disposed || updating || !(fullScan || checkNames || checkRoots || allFields || pruneNeeded || dirtyScopes.size || dirtyFields.size)) return;
        updating = true; pause();
        try {
            if (checkRoots) { checkRoots = false; reconcileRoots(); }
            if (checkNames) {
                checkNames = false;
                const nextNames = nameList(getNames()), nextKey = JSON.stringify(nextNames);
                if (nextKey !== namesKey) { restoreAll(); names = nextNames; namesKey = nextKey; fullScan = true; }
            }
            if (pruneNeeded || fullScan) { pruneNeeded = false; cleanup(); }
            const requested = fullScan ? [...roots] : [...dirtyScopes];
            fullScan = false; dirtyScopes.clear();
            const targets = new Set();
            const add = target => {
                if (!target || target.isConnected === false) return;
                for (const old of targets) if (contains(old, target)) return;
                for (const old of targets) if (contains(target, old)) targets.delete(old);
                targets.add(target);
            };
            for (const scope of requested) {
                if (scope.isConnected === false) continue;
                const local = owns(scope) ? [flowScope(scope)] : surfaces.filter(root => containsAcrossShadow(scope, root));
                for (const target of local) {
                    add(target);
                    // An already known Shadow must also be scanned when its host is revealed or refreshed.
                    for (const root of roots) if (containsAcrossShadow(target, root)) add(root);
                    for (const root of discover(target)) add(root);
                }
            }
            const candidates = new Set(dirtyFields); dirtyFields.clear();
            if (allFields) { for (const field of fields.keys()) candidates.add(field); allFields = false; }
            for (const target of targets) {
                for (const field of fields.keys()) if (containsAcrossShadow(target, field) || contains(field, target)) candidates.add(field);
                scan(target, candidates);
            }
            for (const field of candidates) drawMirror(field);
            const nextTargets = new Set([...fields.keys()].flatMap(field => [field, field.parentElement]).filter(Boolean));
            for (const target of resizeTargets) if (!nextTargets.has(target)) resizeObserver?.unobserve(target);
            for (const target of nextTargets) if (!resizeTargets.has(target)) resizeObserver?.observe(target);
            resizeTargets = nextTargets;
        } finally { updating = false; if (enabled) connect(); }
    }
    function refresh(scope) {
        if (!enabled || disposed) return;
        checkNames = true;
        if (scope) {
            markScope(scope);
            if (scope.isConnected === false || !owns(scope)) { checkRoots = true; pruneNeeded = true; }
        } else { fullScan = true; checkNames = true; checkRoots = true; }
        flush();
    }
    function sync(value) {
        if (disposed) return;
        if (value === true) {
            if (!enabled) {
                enabled = true; fullScan = true;
                view.addEventListener?.('resize', viewportChanged);
                documentRef.fonts?.addEventListener('loadingdone', fontsChanged);
            }
            checkNames = true; checkRoots = true; flush();
        } else if (enabled) {
            enabled = false; pause(); roots.clear(); surfaces = []; connect(); restoreAll(); names = []; namesKey = '';
            dirtyScopes.clear(); dirtyFields.clear(); fullScan = checkNames = checkRoots = allFields = pruneNeeded = queued = false;
            resizeObserver?.disconnect(); resizeTargets.clear();
            view.removeEventListener?.('resize', viewportChanged); documentRef.fonts?.removeEventListener('loadingdone', fontsChanged);
        }
    }
    function dispose() { sync(false); disposed = true; }
    return { sync, refresh, dispose };
}
