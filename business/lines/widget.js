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

function locateLineWidgetTarget(raw, locator, body = '') {
    const model = parseLines(raw);
    if (locator && typeof locator === 'object') {
        const cue = serializeVectorCue(locator.cue);
        if (cue) {
            const matches = model.map((line, index) => ({ line, index })).filter(entry => entry.line.cue === cue);
            return { index: matches.length === 1 ? matches[0].index : null, reason: matches.length > 1 ? 'line-target-ambiguous' : 'line-target-not-found' };
        }
        const name = String(locator.name || '').trim();
        const matches = model.map((line, index) => ({ line, index })).filter(entry => entry.line.name === name);
        return { index: matches.length === 1 ? matches[0].index : null, reason: matches.length > 1 ? 'line-target-ambiguous' : 'line-target-not-found' };
    }
    // 旧卡没有定位快照，只在新卡片线名能唯一对应当前线时兼容；不再凭旧序号盲改。
    const candidate = parseLineWidget(body);
    const matches = model.map((line, index) => ({ line, index })).filter(entry => entry.line.name === candidate?.name);
    return { index: matches.length === 1 ? matches[0].index : null, reason: matches.length > 1 ? 'line-target-ambiguous' : 'line-target-not-found' };
}

export function resolveLineWidgetTarget(raw, locator, body = '') { return locateLineWidgetTarget(raw, locator, body).index; }

function matchesCapturedLine(line, locator) {
    const fields = ['name', 'stage', 'when', 'agency', 'stall', 'desc', 'next', 'cue'];
    if (!fields.every(key => Object.prototype.hasOwnProperty.call(locator || {}, key))) return true;
    return fields.every(key => key === 'stall'
        ? (line?.stall === true) === (locator.stall === true)
        : key === 'cue'
            ? serializeVectorCue(line?.cue) === serializeVectorCue(locator.cue)
            : String(line?.[key] ?? '') === String(locator[key] ?? ''));
}

export function commitLineWidget(raw, body, { editIndex = null, pin = true, locator = null } = {}) {
    if (editIndex == null) return addLineWidget(raw, body, { pin });
    const target = locateLineWidgetTarget(raw, locator, body);
    if (target.index == null) return { ok: false, reason: target.reason, raw };
    const model = parseLines(raw);
    if (locator && !matchesCapturedLine(model[target.index], locator)) return { ok: false, reason: 'line-target-changed', raw };
    return editLineWidget(raw, target.index, body);
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
