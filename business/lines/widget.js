import { parseLines, serializeLines } from './schema.js';
import { parseVectorCue, serializeVectorCue } from './vectors/codec.js';

export function parseLineWidget(body) {
    const rows = String(body || '').split('\n').map(line => line.trim()).filter(Boolean);
    const line = rows.find(row => /^Line\s*:/i.test(row));
    if (!line) return null;
    const parts = line.replace(/^Line\s*:\s*/i, '').split('|').map(value => value.trim());
    if (parts.length < 5 || parts.length > 8) return null;
    return {
        name: parts[0], type: parts[1], stage: parts[2], level: parts[3], when: parts[4],
        agency: parts[5] || 'world', stall: /^true$/i.test(parts[6] || ''), pin: /^true$/i.test(parts[7] || ''),
        desc: (rows.find(row => /^Desc\s*:/i.test(row)) || '').replace(/^Desc\s*:\s*/i, '').trim(),
        next: (rows.find(row => /^Next\s*:/i.test(row)) || '').replace(/^Next\s*:\s*/i, '').trim(),
    };
}

export function addLineWidget(raw, body, { pin = true } = {}) {
    const item = parseLineWidget(body);
    if (!item?.name) return { ok: false, reason: 'invalid-widget', raw };
    const model = parseLines(raw);
    model.push({ ...item, pin, cue: null });
    return { ok: true, raw: serializeLines(model), model };
}

export function editLineWidget(raw, index, body) {
    const item = parseLineWidget(body);
    if (!item?.name) return { ok: false, reason: 'invalid-widget', raw };
    const model = parseLines(raw);
    if (!model[Number(index)]) return { ok: false, reason: 'line-not-found', raw };
    model[Number(index)] = { ...item, pin: model[Number(index)].pin === true, cue: model[Number(index)].cue ?? null };
    return { ok: true, raw: serializeLines(model), model };
}

export function commitLineWidget(raw, body, { editIndex = null, pin = true } = {}) {
    return editIndex == null ? addLineWidget(raw, body, { pin }) : editLineWidget(raw, editIndex, body);
}

export function replaceLineBlock(raw, index, newBlock) {
    const source = String(raw || '');
    const match = source.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i);
    const inner = match ? match[1] : source;
    const blocks = [];
    let current = null;
    for (const line of inner.split('\n')) {
        if (/^\s*Line\s*:/i.test(line)) { if (current) blocks.push(current); current = [line]; }
        else if (current) current.push(line);
    }
    if (current) blocks.push(current);
    if (!Number.isInteger(Number(index)) || index < 0 || index >= blocks.length) return null;
    const oldCueRaw = (blocks[index].find(line => /^\s*Cue\s*:/i.test(line)) || '').replace(/^\s*Cue\s*:\s*/i, '').trim();
    const oldCue = serializeVectorCue(oldCueRaw);
    let replacement = String(newBlock || '').split('\n');
    const candidateIndex = replacement.findIndex(line => /^\s*Cue\s*:/i.test(line));
    if (candidateIndex >= 0) {
        const candidate = replacement[candidateIndex].replace(/^\s*Cue\s*:\s*/i, '').trim();
        const valid = serializeVectorCue(candidate);
        replacement = replacement.filter((_, i) => i !== candidateIndex);
        if (valid) replacement.push(`Cue: ${valid}`); else if (oldCue) replacement.push(`Cue: ${oldCue}`);
    } else if (oldCue) replacement.push(`Cue: ${oldCue}`);
    blocks[index] = replacement;
    const next = blocks.map(block => block.join('\n').replace(/\s+$/, '')).join('\n\n');
    return match ? source.replace(match[0], `<storylines_widget>\n${next}\n</storylines_widget>`) : `<storylines_widget>\n${next}\n</storylines_widget>`;
}
