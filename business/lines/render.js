export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
export function linesViewModel(lines, max = 6) {
    return (Array.isArray(lines) ? lines : []).slice(0, max).map((line, index) => ({
        ...line, index, name: String(line.name || ''), desc: String(line.desc || ''), next: String(line.next || ''),
        safeName: escapeHtml(line.name), safeDesc: escapeHtml(line.desc), safeNext: escapeHtml(line.next),
    }));
}
export function renderLineText(lines, max = 6) { return linesViewModel(lines, max).map(l => `<article data-line-idx="${l.index}"><h3>${l.safeName}</h3><p>${l.safeDesc}</p><p>${l.safeNext}</p></article>`).join(''); }
