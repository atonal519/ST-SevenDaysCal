import { parseLines, serializeLines } from './schema.js';
import { normalizeEditableText } from '../utils/text-edit.js';

export function editLineDescription(raw, index, value) {
    return editLineFields(raw, index, { desc: value });
}

export function editLineFields(raw, index, values = {}) {
    const source = String(raw || ''); const open = source.search(/<storylines_widget\b[^>]*>/i); if (open < 0) return { ok: false, reason: 'not-found', raw };
    const openEnd = source.indexOf('>', open) + 1; const close = source.search(/<\/storylines_widget\s*>/i); if (close < openEnd) return { ok: false, reason: 'not-found', raw };
    const prefix = source.slice(0, openEnd); const inner = source.slice(openEnd, close); const suffix = source.slice(close); const eol = inner.includes('\r\n') ? '\r\n' : '\n'; const lines = inner.split(/\r?\n/);
    const starts = lines.map((line, lineIndex) => /^\s*Line\s*:/i.test(line) ? lineIndex : -1).filter(lineIndex => lineIndex >= 0); const lineIndex = starts[Number(index)]; if (lineIndex == null) return { ok: false, reason: 'not-found', raw };
    let end = starts[Number(index) + 1] ?? lines.length; const normalized = Object.prototype.hasOwnProperty.call(values, 'desc') ? normalizeEditableText(values.desc) : null; const nextValue = Object.prototype.hasOwnProperty.call(values, 'next') ? normalizeEditableText(values.next) : null; let desc = -1, next = -1;
    for (let i = lineIndex + 1; i < end; i++) { if (/^\s*Desc\s*:/i.test(lines[i])) desc = i; else if (/^\s*Next\s*:/i.test(lines[i])) next = i; }
    const replace = (at, key, value) => { if (value == null) return; if (at >= 0) { if (value) lines[at] = lines[at].replace(new RegExp(`^(\\s*)${key}\\s*:.*`, 'i'), `$1${key}: ${value}`); else lines.splice(at, 1); } else if (value) lines.splice(next >= 0 ? next : end, 0, `${key}: ${value}`); };
    replace(desc, 'Desc', normalized);
    end = lines.findIndex((line, i) => i > lineIndex && /^\s*Line\s*:/i.test(line)); if (end < 0) end = lines.length;
    next = lines.findIndex((line, i) => i > lineIndex && i < end && /^\s*Next\s*:/i.test(line));
    replace(next, 'Next', nextValue);
    return { ok: true, raw: prefix + lines.join(eol) + suffix, value: normalized };
}

export function deleteLine(raw, index) {
    const model = parseLines(raw); if (!Number.isInteger(index) || index < 0 || index >= model.length) return { ok: false, reason: 'not-found', raw };
    model.splice(index, 1); return { ok: true, raw: model.length ? serializeLines(model) : '' , model };
}
export function togglePin(raw, index) {
    const model = parseLines(raw); if (!Number.isInteger(index) || index < 0 || index >= model.length) return { ok: false, reason: 'not-found', raw };
    model[index].pin = !model[index].pin; return { ok: true, raw: serializeLines(model), model };
}
export function mergePinned(oldRaw, aiRaw, options = {}) {
    const old = parseLines(oldRaw), fresh = parseLines(aiRaw);
    const queues = new Map();
    for (const line of fresh) if (line.name) { const queue = queues.get(line.name) || []; queue.push(line); queues.set(line.name, queue); }
    for (const pinned of old.filter(line => line.pin)) {
        const queue = queues.get(pinned.name);
        const pinnedIndex = queue?.findIndex(item => options.preferPinnedSource || item?.pin === true) ?? -1;
        const same = pinnedIndex >= 0 ? queue.splice(pinnedIndex, 1)[0] : undefined;
        if (same) {
            if (options.preferPinnedSource) Object.assign(same, pinned);
            else { same.pin = true; same.adult = pinned.adult === true || same.adult === true; same.cue = pinned.cue ?? null; }
        } else fresh.push({ ...pinned });
    }
    return { ok: true, raw: serializeLines(fresh), model: fresh };
}
