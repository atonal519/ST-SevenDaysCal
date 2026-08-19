// utils/dom.js — 纯 HTML/文本工具（无状态、无 DOM 依赖）。Phase 0 从 index.js 机械搬移。


export function escapeHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

export function escapeAttr(s)  { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

export function autoGrowTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

export function cleanText(s) {
    return String(s)
        .replace(/<ruby[^>]*>[\s\S]*?<\/ruby>/gi, (m) =>
            m.replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '').replace(/<\/?ruby[^>]*>/gi, ''))
        .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}
