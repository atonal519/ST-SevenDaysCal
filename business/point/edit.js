import { normalizeEditableText, validatePointDescription } from '../utils/text-edit.js';

function eventBlocks(raw) {
    const source = String(raw || ''); const lines = source.split('\n'); const blocks = []; let current = null; let day = null; let future = false; let dayIndex = -1;
    const flush = end => { if (current) { current.end = end; blocks.push({ ...current, day, future }); current = null; } };
    lines.forEach((line, index) => {
        const text = line.trim();
        const dayMatch = /^(?:Day\s*:?\s*(\d+)|第([一二三四五六七\d]+)天)/i.exec(text);
        if (dayMatch) { flush(index); dayIndex++; day = dayIndex; future = false; return; }
        if (/^(?:Future\s*:|未来\s*:)/i.test(text)) { flush(index); day = 'future'; future = true; return; }
        if (/^Event\s*:/i.test(text)) { flush(index); current = { start: index, end: index + 1 }; return; }
        if (/^<\/(?:calendar|schedule)_widget>/i.test(text)) { flush(index); return; }
        if (current) current.end = index + 1;
    });
    flush(lines.length);
    const activeDays = new Map();
    for (const block of blocks) {
        if (block.day === 'future' || activeDays.has(block.day)) continue;
        activeDays.set(block.day, activeDays.size);
    }
    return { lines, blocks: blocks.map(block => ({ ...block, day: block.day === 'future' ? 'future' : activeDays.get(block.day) })) };
}

export function editPointDescription(raw, dayKey, eventIndex, value) {
    return editPointFields(raw, dayKey, eventIndex, { desc: value });
}

export function editPointFields(raw, dayKey, eventIndex, values = {}) {
    const desc = normalizeEditableText(values.desc ?? '');
    const parsed = eventBlocks(raw); const targetDay = dayKey === 'future' ? 'future' : Number(dayKey);
    const block = parsed.blocks.filter(item => item.day === targetDay)[Number(eventIndex)]; if (!block) return { ok: false, reason: 'not-found', raw };
    const first = parsed.lines[block.start]; const indent = first.match(/^\s*/)?.[0] || ''; const fields = first.trim().replace(/^Event\s*:\s*/i, '').split('|');
    if (fields.length < 4) return { ok: false, reason: 'malformed', raw };
    const npcAction = Object.prototype.hasOwnProperty.call(values, 'npcAction') ? normalizeEditableText(values.npcAction) : (fields[5] || ''); if (validatePointDescription(`${desc}${npcAction}`)) return { ok: false, reason: 'pipe', raw };
    fields[2] = desc; if (fields.length >= 6) fields[5] = npcAction;
    parsed.lines[block.start] = `${indent}Event: ${fields.join('|')}`;
    return { ok: true, raw: parsed.lines.join('\n'), value: desc, values: { desc, npcAction } };
}
