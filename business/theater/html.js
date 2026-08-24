export function sanitizeHtml(htmlRaw, { purifier = globalThis.DOMPurify, documentRef = globalThis.document } = {}) {
    if (purifier && typeof purifier.sanitize === 'function') return purifier.sanitize(String(htmlRaw || ''), { FORBID_TAGS: ['style'] });
    // DOMPurify 缺失时宁可退化为纯文本，不能把模型返回的原 HTML 直接放行。
    const div = documentRef?.createElement?.('div');
    if (!div) return '';
    div.textContent = String(htmlRaw || '');
    return div.innerHTML;
}

export function safePlainTextHtml(raw) {
    const escaped = String(raw || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    return `<div class="sp-theater-prose"><p>${escaped.replace(/\r?\n/g, '<br>')}</p></div>`;
}

export function ensureTheaterHtml(html, raw) {
    // 兼容旧 UI seam；新的 renderTheaterPieceHtml 在持久化展示时强制二次净化。
    if (!String(html || '').trim() && String(raw || '').trim()) return safePlainTextHtml(raw);
    return html;
}
