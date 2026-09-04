import { parseLineCard, parseLines, serializeLines } from './schema.js';
import { serializeVectorCue } from './vectors/codec.js';

export function parseLineWidget(body) {
    return parseLineCard(body);
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
    model[Number(index)] = { ...item, adult: model[Number(index)].adult === true, pin: model[Number(index)].pin === true, cue: model[Number(index)].cue ?? null };
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
    const oldAdult = blocks[index].some(line => /^\s*Adult\s*:\s*true\s*$/i.test(line));
    let replacement = String(newBlock || '').split('\n');
    const candidateIndex = replacement.findIndex(line => /^\s*Cue\s*:/i.test(line));
    if (candidateIndex >= 0) {
        const candidate = replacement[candidateIndex].replace(/^\s*Cue\s*:\s*/i, '').trim();
        const valid = serializeVectorCue(candidate);
        replacement = replacement.filter((_, i) => i !== candidateIndex);
        if (valid) replacement.push(`Cue: ${valid}`); else if (oldCue) replacement.push(`Cue: ${oldCue}`);
    } else if (oldCue) replacement.push(`Cue: ${oldCue}`);
    replacement = replacement.filter(line => !/^\s*Adult\s*:/i.test(line));
    if (oldAdult) replacement.push('Adult: true');
    blocks[index] = replacement;
    const next = blocks.map(block => block.join('\n').replace(/\s+$/, '')).join('\n\n');
    return match ? source.replace(match[0], `<storylines_widget>\n${next}\n</storylines_widget>`) : `<storylines_widget>\n${next}\n</storylines_widget>`;
}
