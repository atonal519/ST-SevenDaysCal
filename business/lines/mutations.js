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
    for (const pinned of old.filter(line => line.pin)) {
        const same = fresh.find(line => line.name && line.name === pinned.name);
        if (same) same.pin = true; else fresh.push({ ...pinned });
    }
    if (fresh.length > 6) return { ok: false, reason: 'capacity-exceeded', raw: oldRaw, model: old };
    return { ok: true, raw: serializeLines(fresh), model: fresh };
}
