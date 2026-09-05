import { serializeVectorCue } from './vectors/codec.js';
import { stripRecordWrappers } from '../utils/record-wrappers.js';
export const TERMINAL_LINE_STAGES = new Set(['收束', '淡出']);
export const LINE_STAGES = new Set(['起线', '延展', '成形', '收束', '淡出']);
function bool(value) { return /^(?:true|1|yes|y|是|对|开启|停滞|暂停|锁定)$/i.test(String(value ?? '').trim()); }
const cleanLabel = value => {
    let text = String(value || '').trim();
    if (/^[|｜].*[|｜]$/.test(text)) text = text.slice(1, -1).trim();
    return text.replace(/^[>#*\-\s]+/, '').replace(/\*+/g, '').trim();
};
const splitFields = value => String(value || '').split(/[|｜]/).map(field => field.trim());
const fieldValue = (text, name) => text.replace(new RegExp(`^${name}\\s*[:：]\\s*`, 'i'), '').trim();
export const normalizeLineStage = value => {
    const text = String(value || '').trim();
    if (LINE_STAGES.has(text)) return text;
    const legacy = {
        萌芽: '起线', 筹备: '起线',
        发酵: '延展', 执行: '延展',
        逼近: '成形', 关键: '成形',
        已爆发: '收束', 已完成: '收束',
        已消散: '淡出', 已失败: '淡出',
    };
    if (legacy[text]) return legacy[text];
    const aliases = [
        [/萌生|初始|开始|新生|准备|预备/, '起线'], [/酝酿|发展|升温|进行|推进中/, '延展'],
        [/临近|迫近|关键|高潮|影响明确/, '成形'], [/爆发|发生|完成|结束|成功|解决|和解|落定|新平衡/, '收束'],
        [/消散|消失|失败|不再追踪/, '淡出'],
    ];
    return aliases.find(([rx]) => rx.test(text))?.[1] || '起线';
};
export const isTerminalLineStage = value => TERMINAL_LINE_STAGES.has(normalizeLineStage(value));
const normalizeAgency = value => /^(?:player|user|用户|玩家|主角)$/i.test(String(value || '').trim()) ? 'player' : 'world';
const isAgencyField = value => /^(?:player|world|user|用户|玩家|主角|世界|环境|自行|自演化)$/i.test(String(value || '').trim());
const isBoolField = value => /^(?:true|false|1|0|yes|no|y|n|是|否|对|错|开启|关闭|停滞|暂停|锁定|未锁)$/i.test(String(value || '').trim());
const isLegacyLevel = value => /^(?:[1-4]|[一二三四](?:级)?)$/.test(String(value || '').trim());
export function parseLineRow(value) {
    const text = cleanLabel(value);
    const fields = splitFields(/^Line\s*[:：]/i.test(text) ? fieldValue(text, 'Line') : text);
    if (fields.length === 6) {
        const [name, stage, when, agency, stall, pin] = fields;
        return { fieldCount: fields.length, name, stage, when, agency, stall, pin, format: 'canonical-v3' };
    }
    if (fields.length === 7) {
        const oldCanonicalShape = isAgencyField(fields[4]) && isBoolField(fields[5]) && isBoolField(fields[6]);
        const legacyLevelShape = isLegacyLevel(fields[3]) && isAgencyField(fields[5]) && isBoolField(fields[6]);
        if (legacyLevelShape && !oldCanonicalShape) {
            return { fieldCount: fields.length, name: fields[0], stage: fields[2], when: fields[4], agency: fields[5], stall: fields[6], pin: false, format: 'legacy-level' };
        }
        return { fieldCount: fields.length, name: fields[0], stage: fields[2], when: fields[3], agency: fields[4], stall: fields[5], pin: fields[6], format: 'canonical-v2' };
    }
    if (fields.length === 8) {
        const oldCanonicalShape = isAgencyField(fields[4]) && isBoolField(fields[5]) && isBoolField(fields[6]);
        const legacyLevelShape = isLegacyLevel(fields[3]) && isAgencyField(fields[5]) && isBoolField(fields[6]) && isBoolField(fields[7]);
        if (legacyLevelShape || !oldCanonicalShape) {
            return { fieldCount: fields.length, name: fields[0], stage: fields[2], when: fields[4], agency: fields[5], stall: fields[6], pin: fields[7], format: 'legacy-level' };
        }
        return { fieldCount: fields.length, name: fields[0], stage: fields[2], when: fields[3], agency: fields[4], stall: fields[5], pin: fields[6], format: 'canonical-v2-extra' };
    }
    return { fieldCount: fields.length, name: fields[0], stage: fields[1], when: fields[2], agency: fields[3], stall: fields[4], pin: fields[5], format: 'unknown' };
}
export function normalizeLine(record = {}) { return { name: String(record.name ?? '').trim(), stage: normalizeLineStage(record.stage), when: String(record.when ?? '').trim(), agency: String(record.agency ?? '').trim().toLowerCase() === 'player' ? 'player' : 'world', stall: record.stall === true || bool(record.stall), pin: record.pin === true || bool(record.pin), adult: record.adult === true, desc: String(record.desc ?? '').trim(), next: String(record.next ?? '').trim(), cue: serializeVectorCue(record.cue) }; }
const lineAnchorKind = value => {
    const text = cleanLabel(value);
    if (/^Line\s*[:：]/i.test(text)) return 'line';
    if (/^Desc\s*[:：]/i.test(text)) return 'desc';
    if (/^Next\s*[:：]/i.test(text)) return 'next';
    return /^(?:Ticket|Cue|Adult|Pin|说明|备注|Reason|Analysis)\s*[:：]/i.test(text) ? 'field' : null;
};
const completeLineStructure = kinds => ['line', 'desc', 'next'].every(kind => kinds.includes(kind));
function parseLegacyInner(content) {
    const lines = []; let current = null;
    for (const source of stripRecordWrappers(content, lineAnchorKind, completeLineStructure).split(/\r?\n/)) { const text = cleanLabel(source); if (!text) continue;
        if (/^Line\s*[:：]/i.test(text)) { if (current) lines.push(normalizeLine(current)); const parsed = parseLineRow(text); if (parsed.fieldCount < 6) { current = null; continue; } current = { name: parsed.name, stage: normalizeLineStage(parsed.stage), when: parsed.when, agency: normalizeAgency(parsed.agency), stall: bool(parsed.stall), pin: bool(parsed.pin), desc: '', next: '' }; }
        else if (current && /^Desc\s*[:：]/i.test(text)) current.desc = fieldValue(text, 'Desc'); else if (current && /^Next\s*[:：]/i.test(text)) current.next = fieldValue(text, 'Next'); else if (current && /^Cue\s*[:：]/i.test(text)) current.cue = fieldValue(text, 'Cue'); else if (current && /^Adult\s*[:：]/i.test(text)) current.adult = bool(fieldValue(text, 'Adult'));
    }
    if (current) lines.push(normalizeLine(current)); return lines;
}
export function parseLines(raw, { legacy = true } = {}) { if (typeof raw !== 'string' || !raw.trim()) return []; const match = raw.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i); return match ? parseLegacyInner(match[1]) : (legacy ? parseLegacyInner(raw) : []); }
export function serializeLines(model, { includeCue = true, includeAdult = true } = {}) { const blocks = (Array.isArray(model) ? model : []).map(item => { const l = normalizeLine(item); const row = [`Line: ${l.name}`, l.stage, l.when, l.agency, l.stall ? 'true' : 'false', l.pin ? 'true' : 'false'].join('|'); return [row, l.desc ? `Desc: ${l.desc}` : '', l.next ? `Next: ${l.next}` : '', includeCue && l.cue ? `Cue: ${l.cue}` : '', includeAdult && l.adult ? 'Adult: true' : ''].filter(Boolean).join('\n'); }); return `<storylines_widget>\n${blocks.join('\n\n')}\n</storylines_widget>`; }
function tolerantBlocks(inner) {
    const blocks = []; let block = null;
    const flush = () => { if (block) blocks.push(block); block = null; };
    for (const raw of stripRecordWrappers(inner, lineAnchorKind, completeLineStructure).split(/\r?\n/)) {
        const text = cleanLabel(raw); if (!text || /^```/.test(text)) continue;
        if (/^Line\s*[:：]/i.test(text)) { flush(); block = { line: text, ticketId: null, ticketSeen: false, desc: '', next: '', adultSeen: false, lastText: null }; continue; }
        if (!block) continue;
        if (/^Ticket\s*[:：]/i.test(text)) { block.ticketSeen = true; block.ticketId = fieldValue(text, 'Ticket').toUpperCase(); block.lastText = null; continue; }
        if (/^Desc\s*[:：]/i.test(text)) { block.desc = fieldValue(text, 'Desc'); block.lastText = 'desc'; continue; }
        if (/^Next\s*[:：]/i.test(text)) { block.next = fieldValue(text, 'Next'); block.lastText = 'next'; continue; }
        if (/^Adult\s*[:：]/i.test(text)) { block.adultSeen = true; block.lastText = null; continue; }
        if (/^(?:Cue|Pin|说明|备注|Reason|Analysis)\s*[:：]/i.test(text)) { block.lastText = null; continue; }
        if (block.lastText) block[block.lastText] = `${block[block.lastText]} ${text}`.trim();
    }
    flush(); return blocks;
}
function extractLinesWidget(source) {
    const open = /<storylines_widget\b[^>]*>/i.exec(String(source));
    if (!open) return null;
    const start = open.index + open[0].length;
    const close = /<\/storylines_widget\s*>/i.exec(String(source).slice(start));
    if (!close) return null;
    const inner = String(source).slice(start, start + close.index);
    return /<\/?storylines_widget\b/i.test(inner) ? null : inner;
}
export function parseLineCard(body) {
    const block = tolerantBlocks(body)[0];
    if (!block) return null;
    const parsed = parseLineRow(block.line);
    if (parsed.fieldCount < 6 || !parsed.name || !parsed.when || !block.desc || !block.next) return null;
    return normalizeLine({ name: parsed.name, stage: normalizeLineStage(parsed.stage), when: parsed.when, agency: normalizeAgency(parsed.agency), stall: bool(parsed.stall), pin: false, desc: block.desc, next: block.next });
}
export function validateLinesResponse(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' }; let source = raw.trim();
    source = source.replace(/^```(?:text|markdown|xml)?\s*[\r\n]/i, '').replace(/[\r\n]\s*```\s*$/i, '').trim();
    const inner = extractLinesWidget(source); if (inner === null) return { ok: false, reason: 'incomplete-or-extraneous' };
    const blocks = tolerantBlocks(inner); if (!blocks.length) return { ok: false, reason: 'no-lines' };
    const model = []; const rejected = [];
    for (const [index, block] of blocks.entries()) {
        const parsed = parseLineRow(block.line);
        const ticketId = block.ticketSeen && /^TICKET-\d+$/i.test(block.ticketId || '') ? block.ticketId.toUpperCase() : null;
        const reason = block.ticketSeen && !ticketId ? 'invalid-ticket'
                : parsed.fieldCount < 6 || !parsed.name || !parsed.when || !block.desc || !block.next ? 'missing-business-field'
                    : null;
        if (reason) { rejected.push({ index, reason }); continue; }
        model.push({ ...normalizeLine({ name: parsed.name, stage: normalizeLineStage(parsed.stage), when: parsed.when, agency: normalizeAgency(parsed.agency), stall: bool(parsed.stall), pin: false, desc: block.desc, next: block.next }), ...(ticketId ? { ticketId } : {}) });
    }
    return model.length ? { ok: true, model, raw: serializeLines(model), rejected } : { ok: false, reason: rejected[0]?.reason || 'no-lines', rejected };
}
