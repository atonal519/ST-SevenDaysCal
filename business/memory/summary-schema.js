import { normalizeKnownFieldWrappers, stripRecordWrappers } from '../utils/record-wrappers.js';

const FIELD_ALIASES = Object.freeze({
    L0: [
        ['时间锚点', ['时间锚点', '时间', 'time anchor', 'time']],
        ['场景', ['场景', '地点', 'scene', 'location']],
        ['事件', ['事件', '关键事件', '主要事件', 'event', 'key events', 'main events']],
        ['人物', ['人物', '关系变化', 'character', 'characters', 'people', 'relationship changes']],
    ],
    L1: [
        ['时间跨度', ['时间跨度', '时间锚点', '时间', 'time span', 'timeframe']],
        ['主要事件', ['主要事件', '事件', '关键事件', 'main events', 'key events', 'events']],
        ['关系变化', ['关系变化', '人物变化', 'relationships', 'relationship changes', 'character changes']],
    ],
});

const WRAPPERS = Object.freeze({
    colonFields: [...new Set(Object.values(FIELD_ALIASES).flatMap(fields => fields.flatMap(([, aliases]) => aliases)))],
    bareFields: [...new Set(Object.values(FIELD_ALIASES).flatMap(fields => fields.flatMap(([, aliases]) => aliases)))],
});

function normalizeLabel(value) {
    return String(value ?? '').trim().replace(/^\*{1,3}|\*{1,3}$/g, '').replace(/^#+\s*/, '').trim().toLocaleLowerCase();
}

function parseJson(source, aliases) {
    const candidate = source.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    if (!candidate.startsWith('{')) return null;
    let object;
    try { object = JSON.parse(candidate); } catch { return null; }
    if (!object || Array.isArray(object) || typeof object !== 'object') return null;
    const byAlias = new Map(aliases.flatMap(([canonical, names]) => names.map(name => [normalizeLabel(name), canonical])));
    const fields = new Map();
    for (const [key, value] of Object.entries(object)) {
        const canonical = byAlias.get(normalizeLabel(key));
        if (!canonical) continue;
        if (typeof value !== 'string') continue;
        mergeField(fields, canonical, value.trim());
    }
    return fields.size ? fields : null;
}

function mergeField(fields, canonical, value) {
    const normalized = String(value ?? '').trim();
    if (!fields.has(canonical)) {
        fields.set(canonical, normalized);
        return;
    }
    const existing = String(fields.get(canonical) ?? '').trim();
    if (existing === normalized || !normalized) return;
    if (!existing) {
        fields.set(canonical, normalized);
        return;
    }
    fields.set(canonical, `${existing}\n${normalized}`);
}

function parseLabeled(source, aliases) {
    const byAlias = new Map(aliases.flatMap(([canonical, names]) => names.map(name => [normalizeLabel(name), canonical])));
    const fields = new Map();
    let current = null;
    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim().replace(/^[|｜>#*\-\s]+/, '').replace(/[|｜]\s*$/, '').trim();
        const label = /^(?:<\s*([^<>:：]+)\s*>\s*)?([^:：]+)\s*[:：]\s*(.*?)\s*$/u.exec(line);
        if (label) {
            const canonical = byAlias.get(normalizeLabel(label[1] || label[2]));
            current = canonical || null;
            if (canonical) {
                mergeField(fields, canonical, label[3].trim().replace(/^\*+|\*+$/g, '').trim());
            }
            continue;
        }
        if (current && line) fields.set(current, `${fields.get(current)}\n${line}`.trim());
    }
    return fields.size ? fields : null;
}

function stripSummaryWrappers(source, aliases) {
    const byAlias = new Set(aliases.flatMap(([, names]) => names.map(normalizeLabel)));
    const isSummaryField = line => {
        const match = /^(?:<\s*([^<>:：]+)\s*>\s*)?([^:：]+)\s*[:：]/u.exec(String(line || '').trim());
        return match && byAlias.has(normalizeLabel(match[1] || match[2])) ? 'field' : null;
    };
    return stripRecordWrappers(source, isSummaryField, kinds => kinds.includes('field'));
}

export function normalizeMemorySummary(value, level) {
    const aliases = FIELD_ALIASES[level];
    if (!aliases) return null;
    const wrapped = normalizeKnownFieldWrappers(String(value ?? '').trim(), WRAPPERS);
    const source = stripSummaryWrappers(wrapped, aliases);
    if (source === null) return null;
    const fields = parseJson(source, aliases) || parseLabeled(source, aliases);
    if (!fields) return null;
    const required = level === 'L0' ? ['事件', '人物'] : ['主要事件', '关系变化'];
    if (!required.some(key => String(fields.get(key) ?? '').trim())) return null;
    return aliases
        .filter(([canonical]) => fields.has(canonical))
        .map(([canonical]) => `${canonical}: ${fields.get(canonical)}`)
        .join('\n');
}
