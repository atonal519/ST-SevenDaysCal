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

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function isHtmlFragment(value) {
    const text = String(value || '').trim();
    if (!text.startsWith('<') || !text.endsWith('>')) return false;
    const token = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
    const stack = []; let match; let sawElement = false; let end = 0;
    while ((match = token.exec(text))) {
        if (text.slice(end, match.index).includes('<') || text.slice(end, match.index).includes('>')) return false;
        end = token.lastIndex;
        const whole = match[0]; const name = match[1]?.toLowerCase();
        if (!name) continue;
        sawElement = true;
        if (whole.startsWith('</')) {
            if (stack.pop() !== name) return false;
        } else if (!whole.endsWith('/>') && !VOID_ELEMENTS.has(name)) stack.push(name);
    }
    if (text.slice(end).includes('<') || text.slice(end).includes('>')) return false;
    return sawElement && stack.length === 0;
}

export function extractTheaterHtmlResponse(response) {
    const text = String(response || '').trim();
    if (!text) return null;
    const fences = [...text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)];
    if (fences.length) {
        if (fences.length !== 1 || fences[0][1].trim().toLowerCase() !== 'html') return null;
        const candidate = fences[0][2].trim();
        return isHtmlFragment(candidate) ? candidate : null;
    }
    if (text.includes('```')) return null;
    return isHtmlFragment(text) ? text : null;
}
