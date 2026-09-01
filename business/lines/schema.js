import { serializeVectorCue } from './vectors/codec.js';
export const TERMINAL_LINE_STAGES = new Set(['已消散', '已完成', '已失败', '已爆发']);
export const LINE_STAGES = new Set(['萌芽', '发酵', '逼近', '已爆发', '已消散', '筹备', '执行', '关键', '已完成', '已失败']);
export const LINE_TYPES = new Set(['冲突', '推进']);
export const LINE_LEVELS = new Set(['1', '2', '3', '4']);
const AGENCIES = new Set(['player', 'world']); const BOOLS = new Set(['true', 'false']);
function bool(value) { return ['true', '1', 'yes'].includes(String(value ?? '').trim().toLowerCase()); }
export function normalizeLine(record = {}) { return { name: String(record.name ?? '').trim(), type: String(record.type ?? '').trim(), stage: String(record.stage ?? '').trim(), level: String(record.level ?? '').trim(), when: String(record.when ?? '').trim(), agency: String(record.agency ?? '').trim().toLowerCase() === 'player' ? 'player' : 'world', stall: record.stall === true || bool(record.stall), pin: record.pin === true || bool(record.pin), adult: record.adult === true, desc: String(record.desc ?? '').trim(), next: String(record.next ?? '').trim(), cue: serializeVectorCue(record.cue) }; }
function parseLegacyInner(content) {
    const lines = []; let current = null;
    for (const source of String(content).split(/\r?\n/)) { const text = source.trim(); if (!text) continue;
        if (/^Line\s*:/i.test(text)) { if (current) lines.push(normalizeLine(current)); const fields = text.replace(/^Line\s*:\s*/i, '').split('|'); if (fields.length < 5 || fields.length > 8) { current = null; continue; } current = { name: fields[0], type: fields[1], stage: fields[2], level: fields[3], when: fields[4], agency: fields[5], stall: fields[6], pin: fields[7], desc: '', next: '' }; }
        else if (current && /^Desc\s*:/i.test(text)) current.desc = text.replace(/^Desc\s*:\s*/i, ''); else if (current && /^Next\s*:/i.test(text)) current.next = text.replace(/^Next\s*:\s*/i, ''); else if (current && /^Cue\s*:/i.test(text)) current.cue = text.replace(/^Cue\s*:\s*/i, '').trim(); else if (current && /^Adult\s*:/i.test(text)) current.adult = /^true$/i.test(text.replace(/^Adult\s*:\s*/i, '').trim());
    }
    if (current) lines.push(normalizeLine(current)); return lines;
}
export function parseLines(raw, { legacy = true } = {}) { if (typeof raw !== 'string' || !raw.trim()) return []; const match = raw.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i); return match ? parseLegacyInner(match[1]) : (legacy ? parseLegacyInner(raw) : []); }
export function serializeLines(model, { includeCue = true, includeAdult = true } = {}) { const blocks = (Array.isArray(model) ? model : []).map(item => { const l = normalizeLine(item); const row = [`Line: ${l.name}`, l.type, l.stage, l.level, l.when, l.agency, l.stall ? 'true' : 'false', l.pin ? 'true' : 'false'].join('|'); return [row, l.desc ? `Desc: ${l.desc}` : '', l.next ? `Next: ${l.next}` : '', includeCue && l.cue ? `Cue: ${l.cue}` : '', includeAdult && l.adult ? 'Adult: true' : ''].filter(Boolean).join('\n'); }); return `<storylines_widget>\n${blocks.join('\n\n')}\n</storylines_widget>`; }
function strictBlocks(inner) { const blocks = []; let block = null; for (const raw of String(inner).split(/\r?\n/)) { const text = raw.trim(); if (!text) continue; if (/^Line\s*:/i.test(text)) { if (block) blocks.push(block); block = { line: text, ticketId: null, desc: null, next: null, invalid: false, last: 'line' }; continue; } if (!block) return { ok: false, reason: 'text-outside-line' }; if (/^Ticket\s*:/i.test(text)) { if (block.ticketId !== null || block.last !== 'line') block.invalid = true; block.ticketId = text.replace(/^Ticket\s*:\s*/i, '').trim(); block.last = 'ticket'; continue; } if (/^Desc\s*:/i.test(text)) { if (block.desc !== null || block.next !== null || !['line', 'ticket'].includes(block.last)) block.invalid = true; block.desc = text.replace(/^Desc\s*:\s*/i, '').trim(); block.last = 'desc'; continue; } if (/^Next\s*:/i.test(text)) { if (block.next !== null || block.desc === null || block.last !== 'desc') block.invalid = true; block.next = text.replace(/^Next\s*:\s*/i, '').trim(); block.last = 'next'; continue; } block.invalid = true; } if (block) blocks.push(block); return { ok: true, blocks }; }
function extractUniqueLinesWidget(source) {
    const markers = [...String(source).matchAll(/<\/?storylines_widget\b/gi)];
    if (markers.length !== 2) return null;
    const open = source.match(/<storylines_widget(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*[ \t]*=[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'))*[ \t]*>/i);
    const close = source.match(/<\/storylines_widget>/i);
    if (!open || !close || open.index !== markers[0].index || close.index !== markers[1].index || open.index + open[0].length > close.index) return null;
    return source.slice(open.index + open[0].length, close.index);
}
export function validateLinesResponse(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' }; let source = raw.trim();
    if (/^```(?:text|markdown|xml)?\s*[\r\n]/i.test(source) && /[\r\n]\s*```$/.test(source)) source = source.replace(/^```(?:text|markdown|xml)?\s*[\r\n]/i, '').replace(/[\r\n]\s*```$/, '').trim();
    const inner = extractUniqueLinesWidget(source); if (inner === null) return { ok: false, reason: 'incomplete-or-extraneous' };
    const scanned = strictBlocks(inner); if (!scanned.ok || !scanned.blocks.length) return { ok: false, reason: scanned.reason || 'no-lines' }; const model = [];
    for (const block of scanned.blocks) { const fields = block.line.replace(/^Line\s*:\s*/i, '').split('|'); if (block.invalid || fields.length !== 8 || block.desc == null || block.next == null || block.desc === '' || block.next === '' || (block.ticketId !== null && block.ticketId === '')) return { ok: false, reason: 'malformed-block' }; const [name, type, stage, level, when, agency, stall, pin] = fields.map(v => v.trim()); if (!name || !type || !stage || !level || !when || !AGENCIES.has(agency) || !BOOLS.has(stall) || !BOOLS.has(pin)) return { ok: false, reason: 'invalid-field' }; if (!LINE_TYPES.has(type) || !LINE_STAGES.has(stage) || !LINE_LEVELS.has(level)) return { ok: false, reason: 'invalid-field' }; if ([name, type, stage, level, when, agency, stall, pin, block.ticketId, block.desc, block.next].some(v => String(v ?? '').includes('|'))) return { ok: false, reason: 'ambiguous-pipe' }; model.push({ ...normalizeLine({ name, type, stage, level, when, agency, stall, pin: false, desc: block.desc, next: block.next }), ticketId: block.ticketId }); }
    return { ok: true, model, raw: serializeLines(model) };
}
