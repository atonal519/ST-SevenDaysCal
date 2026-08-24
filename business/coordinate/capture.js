const DANGEROUS_URL = /^(?:javascript|vbscript|data):/i;

function fallbackText(value) {
    const text = String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
    return text;
}

function stripRenderBoxes(root) {
    root?.querySelectorAll?.('.TH-render, iframe, .sp-inline-box, .sp-lines-inline, .sp-dashed-inline')
        ?.forEach(node => node.remove());
    return root;
}

export function captureSnapshotElement(element, { DOMPurify: purifier = globalThis.DOMPurify, documentRef = globalThis.document, messageFormatting } = {}) {
    if (!element) return { html: '', preview: '' };
    if (!documentRef?.createElement || !element.cloneNode) return captureMesText(element, { DOMPurify: purifier });
    const clone = element.cloneNode(true);
    stripRenderBoxes(clone);
    const raw = clone.innerHTML || '';
    const html = sanitizeSnapshot(raw, { DOMPurify: purifier, documentRef });
    return { html, preview: makePreview(html) };
}

export function sanitizeSnapshot(htmlRaw, { DOMPurify: purifier = globalThis.DOMPurify, documentRef = globalThis.document } = {}) {
    const raw = String(htmlRaw ?? '');
    if (!purifier?.sanitize) return fallbackText(raw);
    const html = purifier.sanitize(raw, { ADD_TAGS: ['style'], ADD_ATTR: ['data-*'], FORBID_TAGS: ['script'], FORBID_ATTR: [/^on/i] });
    if (!documentRef?.createElement) return html;
    const box = documentRef.createElement('template');
    box.innerHTML = html;
    stripRenderBoxes(box.content);
    for (const el of box.content.querySelectorAll('*')) {
        for (const attr of [...el.attributes]) {
            if (/^on/i.test(attr.name) || DANGEROUS_URL.test(String(attr.value).trim())) el.removeAttribute(attr.name);
        }
    }
    return box.innerHTML;
}

export function makePreview(html, max = 140) {
    const cleanText = value => String(value ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?:\.[\w-]+\s*)?\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    let text = '';
    const raw = String(html ?? '');
    try {
        const doc = globalThis.document;
        if (doc?.createElement) { const template = doc.createElement('template'); template.innerHTML = raw; template.content?.querySelectorAll?.('style,script')?.forEach(node => node.remove()); text = cleanText(template.content?.textContent || ''); }
    } catch { /* fallback below */ }
    if (!text) text = cleanText(raw.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' '));
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function captureMesText(mesText, options = {}) {
    if (!mesText) return { html: '', preview: '' };
    const html = sanitizeSnapshot(mesText.innerHTML || '', options);
    return { html, preview: makePreview(html, options.previewMax || 140) };
}

export function collectStylesheets(doc = globalThis.document) {
    if (!doc) return [];
    return [...doc.querySelectorAll('style')].map(node => node.textContent || '').filter(css => /\.custom-[\w-]+|\.mes_text\b|\.TH-render\b/.test(css));
}
