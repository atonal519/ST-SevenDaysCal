import { stripRecordWrappers } from '../utils/record-wrappers.js';

const cleanOutlineLine = value => {
    let text = String(value || '').trim();
    if (/^[|｜].*[|｜]$/.test(text)) text = text.slice(1, -1).trim();
    return text.replace(/^[>#*\-\s]+/, '').replace(/\*+/g, '').trim();
};
const outlineAnchorKind = value => {
    const text = cleanOutlineLine(value);
    for (const kind of ['Beat', 'Scene', 'Subtext', 'Think']) if (new RegExp(`^${kind}\\s*[:：]`, 'i').test(text)) return kind.toLowerCase();
    return null;
};
const completeOutlineStructure = kinds => kinds.includes('beat') && kinds.includes('scene');

export function parseOutline(raw) {
    const source = String(raw || '');
    const widget = /<outline_widget[^>]*>([\s\S]*?)<\/outline_widget>/i.exec(source);
    const content = stripRecordWrappers(widget ? widget[1] : source, outlineAnchorKind, completeOutlineStructure);
    const lines = content.split('\n');
    const firstField = lines.find(line => cleanOutlineLine(line));
    const structured = Boolean(widget) || outlineAnchorKind(firstField) === 'beat' && lines.some(line => outlineAnchorKind(line) === 'scene');
    const beats = [];
    let current = null;
    let field = '';
    for (const rawLine of lines) {
        const text = cleanOutlineLine(rawLine);
        if (!text) continue;
        if (/^Beat\s*[:：]/i.test(text)) {
            if (current) beats.push(current);
            const parts = text.replace(/^Beat\s*[:：]\s*/i, '').split(/[|｜]/);
            current = {
                time: (parts[0] || '').trim(),
                title: (parts[1] || '').trim(),
                type: (parts[2] || '').trim(),
                line: (parts[3] || '').trim(),
                outcome: parts.slice(4).join('｜').trim(),
                scene: '',
                subtext: '',
                think: '',
            };
            field = '';
        } else if (/^Scene\s*[:：]/i.test(text) && current) {
            current.scene = text.replace(/^Scene\s*[:：]\s*/i, '').trim();
            field = 'scene';
        } else if (/^Subtext\s*[:：]/i.test(text) && current) {
            current.subtext = text.replace(/^Subtext\s*[:：]\s*/i, '').trim();
            field = 'subtext';
        } else if (/^Think\s*[:：]/i.test(text) && current) {
            current.think = text.replace(/^Think\s*[:：]\s*/i, '').trim();
            field = 'think';
        } else if (structured && current && ['scene', 'subtext', 'think'].includes(field)) {
            current[field] = [current[field], text].filter(Boolean).join('\n');
        }
    }
    if (current) beats.push(current);
    return beats;
}

export function isCompleteOutlineBeat(beat) {
    return !!beat && ['time', 'title', 'type', 'line', 'outcome', 'scene']
        .every(key => String(beat[key] || '').trim());
}

export function parseCompleteOutline(raw) {
    return parseOutline(raw).filter(isCompleteOutlineBeat);
}

export function normalizeOutlineResponse(raw) {
    const beats = parseCompleteOutline(raw);
    if (!beats.length) return '';
    const blocks = beats.map(beat => [
        `Beat: ${beat.time}|${beat.title}|${beat.type}|${beat.line}|${beat.outcome}`,
        `Scene: ${beat.scene}`,
        `Subtext: ${beat.subtext}`,
        `Think: ${beat.think}`,
    ].join('\n'));
    return `<outline_widget>\n${blocks.join('\n')}\n</outline_widget>`;
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

const OUTLINE_ADVANCE_VALUES = new Set(['推进', '未推进', '没推进', '不推进', '无推进']);

function normalizeOutlineAdvanceValue(value) {
    const compact = String(value ?? '').replace(/\s+/gu, '').replace(/[。.!！?？、,，;；:：]+$/u, '');
    return OUTLINE_ADVANCE_VALUES.has(compact) ? compact : null;
}

export function parseOutlineAdvanceDecision(answer) {
    let text = String(answer ?? '').trim();
    if (!text) return null;
    const fences = [...text.matchAll(/```([^`]*)```/gs)];
    if (fences.length) {
        if (fences.length !== 1 || text.slice(0, fences[0].index).trim() || text.slice(fences[0].index + fences[0][0].length).trim()) return null;
        text = fences[0][1].trim().replace(/^(?:json|text)\s*/i, '');
    }
    if (/^[{]/u.test(text)) {
        try {
            const object = JSON.parse(text);
            if (!object || Array.isArray(object) || typeof object !== 'object') return null;
            const keys = Object.keys(object).filter(key => ['decision', '结论'].includes(key.toLowerCase()));
            if (keys.length !== 1 || typeof object[keys[0]] !== 'string') return null;
            return normalizeOutlineAdvanceValue(object[keys[0]]);
        } catch { return null; }
    }
    const field = /^(?:结论|decision)\s*[:：]\s*([\s\S]+)$/iu.exec(text);
    return normalizeOutlineAdvanceValue(field ? field[1] : text);
}

export function parseOutlineRelocationAnswer(answer, beatCount) {
    const text = String(answer || '').trim();
    const count = Math.floor(Number(beatCount));
    if (!text || !Number.isInteger(count) || count < 1) return null;
    const compact = text.replace(/\s+/g, '');
    // 先拒绝整句层面的疑问、反悔、否定与不确定语义；这些语义不能被后面的肯定动词抵消。
    const unsafeDecision = /(?:[?？]|(?:吗|么|嘛|呢|可好)(?:[。.!！])?$|是否|可否|好不好|行不行|反悔|收回|撤回|取消|撤销|作废|算了|放弃|改(?:选|为|变(?:主意|决定))|换成|排除|除了|除去|跳过|[不没未无否非]|请勿|勿|别|待定|可能|也许|或许|大概|如果|假如|若是)/u;
    if (unsafeDecision.test(compact)) return null;
    // 数值形态先于编号语法处理，避免小数、百分比、负数或范围退化成一个普通编号。
    if (/\d+\s*[.．]\s*\d+/u.test(text) || /(?:百分之\s*\d+|\d+\s*[%％])/u.test(text)) return null;
    if (/(?:^|[^\d])(?:负|[-−—–])\s*\d/u.test(text) || /\d\s*(?:[-−—–~～至到/／])\s*\d/u.test(text)) return null;
    const values = [...text.matchAll(/\d+/g)].map(match => Number(match[0]));
    const unique = [...new Set(values)];
    if (unique.length !== 1) return null;
    const value = unique[0];
    if (!Number.isInteger(value) || value < 1 || value > count) return null;
    // 编号槽只允许节点/序号/个/项分类；任何未知单位都会让完整语句匹配失败。
    const ordinal = '(?:(?:节点|序号)(?:第)?\\d+(?:个|项)?|第\\d+(?:个|项)?(?:节点)?|\\d+(?:个|项)?)';
    const answerHead = '(?:答案(?:是|为)|就是|应为)[:：]?';
    const selectHead = '(?:我)?(?:会|决定|明确)?(?:选择|选|采用)[:：]?';
    const moveHead = '(?:请)?(?:定位到|移动到|重定位到|调整到|改到|回到|前往)[:：]?';
    const affirmativeClause = `(?:${answerHead}|${selectHead}|${moveHead})${ordinal}`;
    const standalone = /^(?:第)?\d+(?:个|项)?[。.!！、]?$/u.test(compact);
    const affirmative = new RegExp(`^${affirmativeClause}[。.!！]?$`, 'u').test(compact);
    return standalone || affirmative ? value : null;
}
