import { safePlainTextHtml, sanitizeHtml } from './html.js';

export function renderTheaterPieceHtml(piece, options = {}) {
    const raw = String(piece?.raw || '');
    const html = String(piece?.html || '');
    if (html) {
        let purified = '';
        try { purified = sanitizeHtml(html, options); } catch { purified = ''; }
        return purified || safePlainTextHtml(raw || html);
    }
    return raw ? safePlainTextHtml(raw) : '';
}

export function renderTheaterSource(piece, { escapeHtml = value => String(value ?? '') } = {}) {
    const source = piece?.templateSource;
    if (!source?.input) return '';
    return `<div class="sp-theater-source-wrap"><button type="button" class="sp-theater-source-toggle" aria-expanded="false" title="查看本次实际使用内容"><i class="fa-solid fa-file-lines"></i><span>模板 · ${escapeHtml(source.title || '(无标题)')}</span><i class="fa-solid fa-chevron-down sp-theater-source-chevron"></i></button><div id="sp-theater-source-detail" class="sp-theater-source-detail" style="display:none"><div class="sp-theater-source-caption">本次实际使用内容</div><pre>${escapeHtml(source.input)}</pre></div></div>`;
}
