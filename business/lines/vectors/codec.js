import { POOLS, POOL_IDS, RELATION_POOL_ID } from './pools.js';

const VERSION = 'lines-vector-v1';
const CUE_RE = /^lines-vector-v1:([^:|]+):([^:|]+)\|([^:|]+):([^:|]+)\|([^:|]+):([^:|]+)$/;
const order = [RELATION_POOL_ID, ...POOL_IDS.filter(id => id !== RELATION_POOL_ID)];

export function parseVectorCue(value) {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(CUE_RE); if (!match) return null;
    const pairs = [[match[1], match[2]], [match[3], match[4]], [match[5], match[6]]];
    const seen = new Set();
    for (const [poolId, tagId] of pairs) if (!POOLS[poolId] || seen.has(poolId) || !POOLS[poolId].tags.some(tag => tag.id === tagId)) return null; else seen.add(poolId);
    if (!seen.has(RELATION_POOL_ID)) return null;
    const tags = pairs.map(([poolId, tagId]) => POOLS[poolId].tags.find(tag => tag.id === tagId));
    if (tags.filter(tag => tag.intensity >= 2).length > 1 || tags.every(tag => tag.tone === 'tense')) return null;
    return Object.freeze(pairs.slice().sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([poolId, tagId]) => Object.freeze({ poolId, tagId })));
}

export function serializeVectorCue(ticketOrCue) {
    if (typeof ticketOrCue === 'string') {
        const parsed = parseVectorCue(ticketOrCue); return parsed ? `${VERSION}:${parsed.map(item => `${item.poolId}:${item.tagId}`).join('|')}` : null;
    }
    const pairs = Array.isArray(ticketOrCue) ? ticketOrCue : ticketOrCue?.selections || ticketOrCue?.parts;
    if (!Array.isArray(pairs) || pairs.length !== 3) return null;
    const raw = pairs.map(item => ({ poolId: item.poolId, tagId: item.tagId }));
    const canonical = parseVectorCue(`${VERSION}:${raw.map(item => `${item.poolId}:${item.tagId}`).join('|')}`);
    return canonical ? `${VERSION}:${canonical.map(item => `${item.poolId}:${item.tagId}`).join('|')}` : null;
}

export function ticketFromCue(value) {
    const cue = parseVectorCue(value); if (!cue) return null;
    return Object.freeze({ version: VERSION, id: serializeVectorCue(cue), pools: Object.freeze(cue.map(item => item.poolId)), tags: Object.freeze(cue.map(item => item.tagId)), selections: Object.freeze(cue.map(item => Object.freeze({ ...item, ...POOLS[item.poolId].tags.find(tag => tag.id === item.tagId), poolLabel: POOLS[item.poolId].label }))) });
}

export function stripVectorCueLines(raw) { return String(raw ?? '').split(/\r?\n/).filter(line => !/^\s*Cue\s*:/i.test(line)).join('\n'); }
