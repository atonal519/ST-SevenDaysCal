export const TERMINAL_LINE_STAGES = new Set(['已消散', '已完成', '已失败', '已爆发']);
export const LINE_STAGES = new Set(['萌芽', '发酵', '逼近', '已爆发', '已消散', '筹备', '执行', '关键', '已完成', '已失败']);
export const LINE_TYPES = new Set(['冲突', '推进']);
export const LINE_LEVELS = new Set(['1', '2', '3', '4']);
const AGENCIES = new Set(['player', 'world']);
const BOOLS = new Set(['true', 'false']);
function bool(value) { return ['true', '1', 'yes'].includes(String(value ?? '').trim().toLowerCase()); }
export function normalizeLine(record = {}) { return { name: String(record.name ?? '').trim(), type: String(record.type ?? '').trim(), stage: String(record.stage ?? '').trim(), level: String(record.level ?? '').trim(), when: String(record.when ?? '').trim(), agency: String(record.agency ?? '').trim().toLowerCase() === 'player' ? 'player' : 'world', stall: record.stall === true || bool(record.stall), pin: record.pin === true || bool(record.pin), desc: String(record.desc ?? '').trim(), next: String(record.next ?? '').trim() }; }

// Legacy storage reader: intentionally forgiving; it accepts 5/7/8 fields and skips malformed records.
function parseLegacyInner(content) {
    const lines = []; let current = null;
    for (const source of String(content).split(/\r?\n/)) {
        const text = source.trim(); if (!text) continue;
        if (/^Line\s*:/i.test(text)) {
            if (current) lines.push(normalizeLine(current));
            const fields = text.replace(/^Line\s*:\s*/i, '').split('|');
            if (fields.length < 5 || fields.length > 8) { current = null; continue; }
            current = { name: fields[0], type: fields[1], stage: fields[2], level: fields[3], when: fields[4], agency: fields[5], stall: fields[6], pin: fields[7], desc: '', next: '' };
        } else if (current && /^Desc\s*:/i.test(text)) current.desc = text.replace(/^Desc\s*:\s*/i, '');
        else if (current && /^Next\s*:/i.test(text)) current.next = text.replace(/^Next\s*:\s*/i, '');
    }
    if (current) lines.push(normalizeLine(current)); return lines;
}
export function parseLines(raw, { legacy = true } = {}) { if (typeof raw !== 'string' || !raw.trim()) return []; const match = raw.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i); return match ? parseLegacyInner(match[1]) : (legacy ? parseLegacyInner(raw) : []); }
export function serializeLines(model) { const blocks = (Array.isArray(model) ? model : []).map(item => { const l = normalizeLine(item); const row = [`Line: ${l.name}`, l.type, l.stage, l.level, l.when, l.agency, l.stall ? 'true' : 'false', l.pin ? 'true' : 'false'].join('|'); return [row, l.desc ? `Desc: ${l.desc}` : '', l.next ? `Next: ${l.next}` : ''].filter(Boolean).join('\n'); }); return `<storylines_widget>\n${blocks.join('\n\n')}\n</storylines_widget>`; }

function strictBlocks(inner) {
    const blocks = []; let block = null;
    for (const raw of String(inner).split(/\r?\n/)) { const text = raw.trim(); if (!text) continue;
        if (/^Line\s*:/i.test(text)) { if (block) blocks.push(block); block = { line: text, desc: null, next: null, invalid: false }; continue; }
        if (!block) return { ok: false, reason: 'text-outside-line' };
        if (/^Desc\s*:/i.test(text)) { if (block.desc !== null || block.next !== null) block.invalid = true; block.desc = text.replace(/^Desc\s*:\s*/i, '').trim(); continue; }
        if (/^Next\s*:/i.test(text)) { if (block.next !== null || block.desc === null) block.invalid = true; block.next = text.replace(/^Next\s*:\s*/i, '').trim(); continue; }
        block.invalid = true;
    }
    if (block) blocks.push(block); return { ok: true, blocks };
}
export function validateLinesResponse(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
    let source = raw.trim();
    if (/^```(?:text|markdown|xml)?\s*[\r\n]/i.test(source) && /[\r\n]\s*```$/.test(source)) source = source.replace(/^```(?:text|markdown|xml)?\s*[\r\n]/i, '').replace(/[\r\n]\s*```$/, '').trim();
    const match = source.match(/^<storylines_widget[^>]*>[\r\n]*([\s\S]*?)[\r\n]*<\/storylines_widget>$/i);
    if (!match) return { ok: false, reason: 'incomplete-or-extraneous' };
    const scanned = strictBlocks(match[1]); if (!scanned.ok || !scanned.blocks.length) return { ok: false, reason: scanned.reason || 'no-lines' }; if (scanned.blocks.length > 6) return { ok: false, reason: 'too-many-lines' };
    const model = [];
    for (const block of scanned.blocks) {
        const fields = block.line.replace(/^Line\s*:\s*/i, '').split('|');
        if (block.invalid || fields.length !== 8 || block.desc == null || block.next == null || block.desc === '' || block.next === '') return { ok: false, reason: 'malformed-block' };
        const [name, type, stage, level, when, agency, stall, pin] = fields.map(v => v.trim());
        if (!name || !type || !stage || !level || !when || !AGENCIES.has(agency) || !BOOLS.has(stall) || !BOOLS.has(pin)) return { ok: false, reason: 'invalid-field' };
        if (!LINE_TYPES.has(type) || !LINE_STAGES.has(stage) || !LINE_LEVELS.has(level)) return { ok: false, reason: 'invalid-field' };
        if ([name, type, stage, level, when, agency, stall, pin, block.desc, block.next].some(v => String(v ?? '').includes('|'))) return { ok: false, reason: 'ambiguous-pipe' };
        // pin 只允许来自本地旧存储；AI 输出的值仅为兼容格式而读取，不能成为锁。
        model.push(normalizeLine({ name, type, stage, level, when, agency, stall, pin: false, desc: block.desc, next: block.next }));
    }
    // 返回给 merge 的 raw 也必须来自规范化模型，避免调用方绕过 model 让 AI pin 落地。
    return { ok: true, model, raw: serializeLines(model) };
}
