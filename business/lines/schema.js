import { serializeVectorCue } from './vectors/codec.js';
import { normalizeKnownFieldWrappers, stripRecordWrappers } from '../utils/record-wrappers.js';
export const TERMINAL_LINE_STAGES = new Set(['收束', '淡出']);
export const LINE_STAGES = new Set(['起线', '延展', '成形', '收束', '淡出']);
const LINE_STAGE_ALIASES = Object.freeze({
    萌芽: '起线', 筹备: '起线', 萌生: '起线', 初始: '起线', 开始: '起线', 新生: '起线', 准备: '起线', 预备: '起线', started: '起线', starting: '起线',
    发酵: '延展', 执行: '延展', 酝酿: '延展', 发展: '延展', 升温: '延展', 进行: '延展', 推进中: '延展', progressing: '延展', developing: '延展', ongoing: '延展', 'in progress': '延展',
    逼近: '成形', 关键: '成形', 临近: '成形', 迫近: '成形', 高潮: '成形', 影响明确: '成形', approaching: '成形', forming: '成形', imminent: '成形',
    已完成: '收束', 已结束: '收束', 已解决: '收束', 已了结: '收束', 完成: '收束', 结束: '收束', 成功: '收束', 解决: '收束', 和解: '收束', 落定: '收束', 新平衡: '收束', completed: '收束', finished: '收束', ended: '收束', resolved: '收束', settled: '收束', concluded: '收束',
    已消散: '淡出', 已失败: '淡出', 消散: '淡出', 消失: '淡出', 失败: '淡出', 不再追踪: '淡出', faded: '淡出', disappeared: '淡出', failed: '淡出',
});
function bool(value) { return /^(?:true|1|yes|y|是|对|开启|停滞|暂停|锁定)$/i.test(String(value ?? '').trim()); }
const cleanLabel = value => {
    let text = String(value || '').trim();
    if (/^[|｜].*[|｜]$/.test(text)) text = text.slice(1, -1).trim();
    return text.replace(/^[>#*\-\s]+/, '').replace(/\*+/g, '').trim();
};
const splitFields = value => String(value || '').split(/[|｜]/).map(field => field.trim());
const fieldValue = (text, name) => text.replace(new RegExp(`^${name}\\s*[:：]\\s*`, 'i'), '').trim();
// Only strip the complete, known display suffix; the local ticket remains the identity/adult source.
function normalizeTicketId(value) {
    const match = /^(TICKET-\d+)(?:\s*(?:\((?:SFW|NSFW)\)|（(?:SFW|NSFW)）))?$/i.exec(String(value ?? '').trim());
    return match ? match[1].toUpperCase() : null;
}
export const normalizeLineStage = value => {
    const text = String(value ?? '').trim();
    if (LINE_STAGES.has(text)) return text;
    const alias = text.toLowerCase();
    if (Object.hasOwn(LINE_STAGE_ALIASES, text)) return LINE_STAGE_ALIASES[text];
    if (Object.hasOwn(LINE_STAGE_ALIASES, alias)) return LINE_STAGE_ALIASES[alias];
    return '延展';
};
export const isTerminalLineStage = value => TERMINAL_LINE_STAGES.has(normalizeLineStage(value));
const normalizeAgency = value => /^(?:player|user|用户|玩家|主角)$/i.test(String(value || '').trim()) ? 'player' : 'world';
const isAgencyField = value => /^(?:player|world|user|用户|玩家|主角|世界|环境|自行|自演化)$/i.test(String(value || '').trim());
const isBoolField = value => /^(?:true|false|1|0|yes|no|y|n|是|否|对|错|开启|关闭|停滞|暂停|锁定|未锁)$/i.test(String(value || '').trim());
const isLegacyLevel = value => /^(?:[1-4]|[一二三四](?:级)?)$/.test(String(value || '').trim());
export function parseLineRow(value) {
    const text = cleanLabel(normalizeKnownFieldWrappers(value, LINE_FIELD_WRAPPERS));
    const sourceFields = splitFields(/^Line\s*[:：]/i.test(text) ? fieldValue(text, 'Line') : text);
    // Accept only the two explicit labelled tuple variants; keep every unknown shape on the existing parser path.
    const fields = normalizeExplicitLineTuple(sourceFields);
    if (fields.length >= 6 && isAgencyField(fields[3]) && isBoolField(fields[4]) && isBoolField(fields[5])) {
        const [name, stage, when, agency, stall, pin] = fields;
        return { fieldCount: fields.length, name, stage, when, agency, stall, pin, format: fields.length === 6 ? 'canonical-v3' : 'canonical-v3-extra' };
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
const LINE_FIELD_WRAPPERS = Object.freeze({
    colonFields: ['Line', 'Ticket', 'Desc', 'Next', 'Cue', 'Adult', 'Pin', '说明', '备注', 'Reason', 'Analysis'],
    bareFields: ['Line', 'Ticket', 'Desc', 'Next', 'Cue', 'Adult', 'Pin'],
});
function normalizeLineFieldWrappers(value) { return normalizeKnownFieldWrappers(value, LINE_FIELD_WRAPPERS); }
function jsonField(record, name) {
    const key = Object.keys(record).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? { found: false, value: undefined } : { found: true, value: record[key] };
}
function parseJsonLineBlocks(value) {
    let records;
    try { records = JSON.parse(String(value ?? '').trim()); } catch { return null; }
    if (!Array.isArray(records)) return null;
    // Keep one block per array slot, including malformed entries, so first-eight selection happens before validation.
    return records.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            return { line: '', ticketId: null, ticketSeen: false, ticketDuplicate: false, desc: '', next: '', cue: '', adultSeen: false, adult: false, pinSeen: false, pin: false, lastText: null };
        }
        const line = jsonField(record, 'Line');
        const ticket = jsonField(record, 'Ticket');
        const desc = jsonField(record, 'Desc');
        const next = jsonField(record, 'Next');
        const cue = jsonField(record, 'Cue');
        const adult = jsonField(record, 'Adult');
        const pin = jsonField(record, 'Pin');
        return {
            line: typeof line.value === 'string' ? line.value : '',
            ticketId: typeof ticket.value === 'string' ? ticket.value : null,
            ticketSeen: ticket.found,
            ticketDuplicate: false,
            desc: typeof desc.value === 'string' ? desc.value : '',
            next: typeof next.value === 'string' ? next.value : '',
            cue: typeof cue.value === 'string' ? cue.value : '',
            adultSeen: adult.found,
            adult: bool(adult.value),
            pinSeen: pin.found,
            pin: bool(pin.value),
            lastText: null,
        };
    });
}
function tupleKey(value, key) { return String(value ?? '').trim().toLowerCase() === key; }
function tupleValue(value, key) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'i').exec(String(value ?? ''));
    return match ? match[1] : null;
}
function normalizeExplicitLineTuple(fields) {
    if (fields.length === 9 && tupleKey(fields[3], 'agency') && isAgencyField(fields[4])
        && tupleKey(fields[5], 'stall') && isBoolField(fields[6])
        && tupleKey(fields[7], 'pin') && isBoolField(fields[8])) {
        return [fields[0], fields[1], fields[2], fields[4], fields[6], fields[8]];
    }
    if (fields.length === 6) {
        const agency = tupleValue(fields[3], 'agency');
        const stall = tupleValue(fields[4], 'stall');
        const pin = tupleValue(fields[5], 'pin');
        if (agency !== null && isAgencyField(agency) && stall !== null && isBoolField(stall) && pin !== null && isBoolField(pin)) {
            return [fields[0], fields[1], fields[2], agency, stall, pin];
        }
    }
    return fields;
}
function prepareLineRecordText(value) {
    return stripRecordWrappers(normalizeLineFieldWrappers(value), lineAnchorKind, completeLineStructure);
}
function parseLegacyInner(content) {
    const jsonBlocks = parseJsonLineBlocks(content);
    if (jsonBlocks !== null) {
        return jsonBlocks.flatMap(block => {
            const parsed = parseLineRow(block.line);
            if (parsed.fieldCount < 6) return [];
            return [normalizeLine({ name: parsed.name, stage: normalizeLineStage(parsed.stage), when: parsed.when, agency: normalizeAgency(parsed.agency), stall: bool(parsed.stall), pin: block.pinSeen ? block.pin : bool(parsed.pin), desc: block.desc, next: block.next, cue: block.cue, adult: block.adult })];
        });
    }
    const lines = []; let current = null;
    for (const source of prepareLineRecordText(content).split(/\r?\n/)) { const text = cleanLabel(source); if (!text) continue;
        if (/^Line\s*[:：]/i.test(text)) { if (current) lines.push(normalizeLine(current)); const parsed = parseLineRow(text); if (parsed.fieldCount < 6) { current = null; continue; } current = { name: parsed.name, stage: normalizeLineStage(parsed.stage), when: parsed.when, agency: normalizeAgency(parsed.agency), stall: bool(parsed.stall), pin: bool(parsed.pin), desc: '', next: '' }; }
        else if (current && /^Desc\s*[:：]/i.test(text)) current.desc = fieldValue(text, 'Desc'); else if (current && /^Next\s*[:：]/i.test(text)) current.next = fieldValue(text, 'Next'); else if (current && /^Cue\s*[:：]/i.test(text)) current.cue = fieldValue(text, 'Cue'); else if (current && /^Adult\s*[:：]/i.test(text)) current.adult = bool(fieldValue(text, 'Adult'));
    }
    if (current) lines.push(normalizeLine(current)); return lines;
}
export function parseLines(raw, { legacy = true } = {}) { if (typeof raw !== 'string' || !raw.trim()) return []; const match = raw.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i); return match ? parseLegacyInner(match[1]) : (legacy ? parseLegacyInner(raw) : []); }
// Canonical storage is line-oriented, so narrative newlines must not become record anchors on reread.
const singleLineNarrative = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, ' ');
export function serializeLines(model, { includeCue = true, includeAdult = true } = {}) { const blocks = (Array.isArray(model) ? model : []).map(item => { const l = normalizeLine(item); const row = [`Line: ${l.name}`, l.stage, l.when, l.agency, l.stall ? 'true' : 'false', l.pin ? 'true' : 'false'].join('|'); return [row, l.desc ? `Desc: ${singleLineNarrative(l.desc)}` : '', l.next ? `Next: ${singleLineNarrative(l.next)}` : '', includeCue && l.cue ? `Cue: ${l.cue}` : '', includeAdult && l.adult ? 'Adult: true' : ''].filter(Boolean).join('\n'); }); return `<storylines_widget>\n${blocks.join('\n\n')}\n</storylines_widget>`; }
function tolerantBlocks(inner) {
    const wrapped = extractLinesWidget(inner);
    const source = wrapped === null ? String(inner ?? '') : wrapped;
    const jsonBlocks = parseJsonLineBlocks(source);
    if (jsonBlocks !== null) return jsonBlocks;
    const blocks = []; let block = null;
    const flush = () => { if (block) blocks.push(block); block = null; };
    for (const raw of prepareLineRecordText(source).split(/\r?\n/)) {
        const text = cleanLabel(raw); if (!text || /^```/.test(text)) continue;
        if (/^Line\s*[:：]/i.test(text)) { flush(); block = { line: text, ticketId: null, ticketSeen: false, ticketDuplicate: false, desc: '', next: '', adultSeen: false, lastText: null }; continue; }
        if (!block) continue;
        if (/^Ticket\s*[:：]/i.test(text)) { if (block.ticketSeen) block.ticketDuplicate = true; block.ticketSeen = true; block.ticketId = fieldValue(text, 'Ticket'); block.lastText = null; continue; }
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
export function validateLinesResponse(raw, { maxCandidates } = {}) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' }; let source = raw.trim();
    source = source.replace(/^```(?:text|markdown|xml)?\s*[\r\n]/i, '').replace(/[\r\n]\s*```\s*$/i, '').trim();
    const inner = extractLinesWidget(source); if (inner === null) return { ok: false, reason: 'incomplete-or-extraneous' };
    if (!inner.trim()) {
        if (!/^\s*<storylines_widget\b[^>]*>\s*<\/storylines_widget\s*>\s*$/i.test(source)) return { ok: false, reason: 'incomplete-or-extraneous' };
        return { ok: true, model: [], raw: '', rejected: [] };
    }
    const jsonBlocks = parseJsonLineBlocks(inner);
    if (jsonBlocks?.length === 0) {
        if (!/^\s*<storylines_widget\b[^>]*>\s*\[\s*\]\s*<\/storylines_widget\s*>\s*$/i.test(source)) return { ok: false, reason: 'incomplete-or-extraneous' };
        return { ok: true, model: [], raw: '', rejected: [] };
    }
    const parsedBlocks = jsonBlocks ?? tolerantBlocks(inner);
    const limit = Number.isInteger(maxCandidates) && maxCandidates >= 0 ? maxCandidates : null;
    const blocks = limit === null ? parsedBlocks : parsedBlocks.slice(0, limit);
    if (!blocks.length) return { ok: false, reason: 'no-lines' };
    const model = []; const rejected = [];
    for (const [index, block] of blocks.entries()) {
        const parsed = parseLineRow(block.line);
        const ticketId = block.ticketSeen ? normalizeTicketId(block.ticketId) : null;
        const reason = block.ticketSeen && (block.ticketDuplicate || !ticketId) ? 'invalid-ticket'
                : parsed.fieldCount < 6 || !parsed.name || !parsed.when || !block.desc || !block.next ? 'missing-business-field'
                    : null;
        if (reason) { rejected.push({ index, reason }); continue; }
        model.push({ ...normalizeLine({ name: parsed.name, stage: normalizeLineStage(parsed.stage), when: parsed.when, agency: normalizeAgency(parsed.agency), stall: bool(parsed.stall), pin: false, desc: block.desc, next: block.next }), ...(ticketId ? { ticketId } : {}) });
    }
    return model.length ? { ok: true, model, raw: serializeLines(model), rejected } : { ok: false, reason: rejected[0]?.reason || 'no-lines', rejected };
}
