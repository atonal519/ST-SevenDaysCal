export function parseOutline(raw) {
    const source = String(raw || '');
    const widget = /<outline_widget[^>]*>([\s\S]*?)<\/outline_widget>/i.exec(source);
    const content = widget ? widget[1] : source;
    const beats = [];
    let current = null;
    for (const rawLine of content.split('\n')) {
        const text = rawLine.trim().replace(/^[>#*\-\s]+/, '').replace(/\*+/g, '');
        if (!text) continue;
        if (/^Beat\s*[:：]/i.test(text)) {
            if (current) beats.push(current);
            const parts = text.replace(/^Beat\s*[:：]\s*/i, '').split(/[|｜]/);
            current = {
                time: (parts[0] || '').trim(),
                title: (parts[1] || '').trim(),
                type: (parts[2] || '').trim(),
                line: (parts[3] || '').trim(),
                outcome: (parts[4] || '').trim(),
                scene: '',
                subtext: '',
                think: '',
            };
        } else if (/^Scene\s*[:：]/i.test(text) && current) {
            current.scene = text.replace(/^Scene\s*[:：]\s*/i, '').trim();
        } else if (/^Subtext\s*[:：]/i.test(text) && current) {
            current.subtext = text.replace(/^Subtext\s*[:：]\s*/i, '').trim();
        } else if (/^Think\s*[:：]/i.test(text) && current) {
            current.think = text.replace(/^Think\s*[:：]\s*/i, '').trim();
        }
    }
    if (current) beats.push(current);
    return beats;
}

import { normalizeEditableText } from '../utils/text-edit.js';

// 仅替换指定 Beat 的 Scene 行；不重新序列化，因而保留未知字段与原始包装。
export function editOutlineScene(raw, index, value) {
    const source = String(raw || ''); const widget = /<outline_widget\b[^>]*>([\s\S]*?)<\/outline_widget\s*>/i.exec(source); const before = widget ? source.slice(0, widget.index + widget[0].indexOf(widget[1])) : ''; const after = widget ? source.slice(widget.index + widget[0].indexOf(widget[1]) + widget[1].length) : ''; const content = widget ? widget[1] : source; const lines = content.split('\n'); const starts = [];
    lines.forEach((line, lineIndex) => { if (/^\s*(?:[#>*-]\s*)*Beat\s*[:：]/i.test(line)) starts.push(lineIndex); });
    const start = starts[Number(index)], end = starts[Number(index) + 1] ?? lines.length;
    if (start == null) return { ok: false, reason: 'not-found', raw };
    const normalized = normalizeEditableText(value); let scene = -1, insert = end;
    for (let i = start + 1; i < end; i++) {
        if (/^\s*Scene\s*[:：]/i.test(lines[i])) scene = i;
        else if (insert === end && /^\s*(?:Subtext|Think)\s*[:：]/i.test(lines[i])) insert = i;
    }
    if (scene >= 0) { if (normalized) lines[scene] = lines[scene].replace(/^(\s*)Scene\s*[:：].*$/i, `$1Scene: ${normalized}`); else lines.splice(scene, 1); }
    else if (normalized) lines.splice(insert, 0, `Scene: ${normalized}`);
    return { ok: true, raw: widget ? before + lines.join('\n') + after : lines.join('\n'), value: normalized };
}

export function deleteOutlineBeatFromRaw(raw, index) {
    const source = String(raw || '');
    const widget = /<outline_widget[^>]*>([\s\S]*?)<\/outline_widget>/i.exec(source);
    const contentStart = widget ? widget.index + widget[0].indexOf(widget[1]) : 0;
    const content = widget ? widget[1] : source;
    const contentEnd = contentStart + content.length;
    const starts = [];
    let offset = 0;
    for (const match of content.matchAll(/.*(?:\n|$)/g)) {
        const line = match[0];
        if (!line) continue;
        const text = line.replace(/\r?\n$/, '').trim().replace(/^[>#*\-\s]+/, '').replace(/\*+/g, '');
        if (/^Beat\s*[:：]/i.test(text)) starts.push(contentStart + offset);
        offset += line.length;
    }
    if (!Number.isInteger(index) || index < 0 || index >= starts.length) return null;
    const removeStart = starts[index];
    const removeEnd = index + 1 < starts.length ? starts[index + 1] : contentEnd;
    return source.slice(0, removeStart) + source.slice(removeEnd);
}

export function outlineCursor(saved) {
    if (!saved?.raw) return 0;
    const cursor = Number(saved.cursor);
    return Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 1;
}

export function clampOutlineCursor(cursor, beatCount) {
    const count = Math.max(0, Math.floor(Number(beatCount) || 0));
    const value = Math.floor(Number(cursor));
    return Math.max(0, Math.min(count || 1, Number.isFinite(value) ? value : 0));
}

export function cursorAfterBeatDelete(cursor, deletedIndex, remainingCount) {
    const current = Math.max(0, Math.floor(Number(cursor) || 0));
    if (current === 0) return 0;
    return current > deletedIndex + 1 ? current - 1 : Math.min(current, Math.max(0, remainingCount));
}

export function outlineBaseline(saved) {
    return Object.freeze({
        raw: String(saved?.raw || ''),
        ts: saved?.ts ?? null,
        cursor: outlineCursor(saved),
    });
}

export function sameOutlineBaseline(saved, baseline) {
    if (!baseline) return false;
    const current = outlineBaseline(saved);
    return current.raw === baseline.raw && current.ts === baseline.ts && current.cursor === baseline.cursor;
}

export function shouldAdvanceOutline(answer) {
    const text = String(answer || '').trim();
    return /推进/.test(text) && !/(未|没|不|无)\s*推进/.test(text);
}

export function parseOutlineRelocationAnswer(answer, beatCount) {
    const match = String(answer || '').trim().match(/^\s*(\d+)\s*[。.！!?]?\s*$/);
    const value = match ? Number(match[1]) : NaN;
    return Number.isInteger(value) && value >= 1 && value <= beatCount ? value : null;
}
