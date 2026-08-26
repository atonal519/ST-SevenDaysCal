import { parseLines, serializeLines } from './schema.js';

export function deleteLine(raw, index) {
    const model = parseLines(raw); if (!Number.isInteger(index) || index < 0 || index >= model.length) return { ok: false, reason: 'not-found', raw };
    model.splice(index, 1); return { ok: true, raw: model.length ? serializeLines(model) : '' , model };
}
export function togglePin(raw, index) {
    const model = parseLines(raw); if (!Number.isInteger(index) || index < 0 || index >= model.length) return { ok: false, reason: 'not-found', raw };
    model[index].pin = !model[index].pin; return { ok: true, raw: serializeLines(model), model };
}
export function mergePinned(oldRaw, aiRaw) {
    const old = parseLines(oldRaw), fresh = parseLines(aiRaw);
    const queues = new Map();
    for (const line of fresh) if (line.name) { const queue = queues.get(line.name) || []; queue.push(line); queues.set(line.name, queue); }
    for (const pinned of old.filter(line => line.pin)) {
        const same = queues.get(pinned.name)?.shift();
        if (same) { same.pin = true; same.adult = pinned.adult === true || same.adult === true; same.cue = pinned.cue ?? null; } else fresh.push({ ...pinned });
    }
    return { ok: true, raw: serializeLines(fresh), model: fresh };
}
