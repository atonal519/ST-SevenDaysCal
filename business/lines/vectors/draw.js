import { POOLS, POOL_IDS, RELATION_POOL_ID } from './pools.js';

const VERSION = 'lines-vector-v1';
const HIGH_INTENSITY = 2;
const TONE_WEIGHTS = Object.freeze({ neutral: 0.6, warm: 0.2, tense: 0.2 });
// 合法空间会剔除多高强度/全紧张组合；对紧张项作透明补偿，避免约束把目标比例压低。
const CONSTRAINT_COMPENSATION = Object.freeze({ neutral: 1, warm: 1, tense: 2.5 });
function hashSeed(seed, nonce) { let h = 2166136261; for (const char of `${String(seed)}:${String(nonce)}`) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) || 1; }
function seededRandom(seed, nonce) { let state = hashSeed(seed, nonce); return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }; }
function checkedRandom(random) { const value = random(); if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('random 必须返回 number 类型的有限 [0, 1) 数值'); return value; }
function pickIndex(length, random) { return Math.min(length - 1, Math.floor(checkedRandom(random) * length)); }
function validParts(parts) { const high = parts.filter(tag => tag.intensity >= HIGH_INTENSITY).length; return high <= 1 && !parts.every(tag => tag.tone === 'tense'); }
function keyOf(parts) { return parts.map(({ poolId, tagId }) => `${poolId}:${tagId}`).sort().join('|'); }
function toneWeight(parts) { return parts.reduce((weight, tag) => weight * (TONE_WEIGHTS[tag.tone] ?? (1 / 3)) * (CONSTRAINT_COMPENSATION[tag.tone] ?? 1), 1); }
function makeTicket(parts, index) { const ordered = parts.slice().sort((a, b) => { const rank = id => id === RELATION_POOL_ID ? -1 : POOL_IDS.indexOf(id); return rank(a.poolId) - rank(b.poolId); }); const key = keyOf(ordered); return Object.freeze({ version: VERSION, id: `${VERSION}:${ordered.map(item => `${item.poolId}:${item.tagId}`).join('|')}`, index, pools: Object.freeze(ordered.map(item => item.poolId)), tags: Object.freeze(ordered.map(item => item.tagId)), selections: Object.freeze(ordered.map(item => Object.freeze({ poolId: item.poolId, poolLabel: POOLS[item.poolId].label, tagId: item.tagId, label: item.label, prompt: item.prompt, tone: item.tone, intensity: item.intensity }))), snapshot: Object.freeze(ordered.map(item => `${POOLS[item.poolId].label}：${item.label}`).join('；')) }); }
function tagRecord(poolId, tag) { return { poolId, tagId: tag.id, label: tag.label, prompt: tag.prompt, tone: tag.tone, intensity: tag.intensity }; }
function enumerateLegalCombinations() { const optional = POOL_IDS.filter(id => id !== RELATION_POOL_ID); const combinations = []; for (let first = 0; first < optional.length; first++) for (let second = first + 1; second < optional.length; second++) for (const relation of POOLS[RELATION_POOL_ID].tags) for (const left of POOLS[optional[first]].tags) for (const right of POOLS[optional[second]].tags) { const parts = [tagRecord(RELATION_POOL_ID, relation), tagRecord(optional[first], left), tagRecord(optional[second], right)]; if (validParts(parts)) combinations.push(Object.freeze({ parts: Object.freeze(parts), weight: toneWeight(parts) })); } return Object.freeze(combinations); }
const LEGAL_COMBINATIONS = enumerateLegalCombinations();
export const LEGAL_TICKET_CAPACITY = LEGAL_COMBINATIONS.length;
function calibrateMarginalWeights(combinations) {
    const weights = combinations.map(item => item.weight);
    for (let round = 0; round < 80; round++) {
        const totals = { neutral: 0, warm: 0, tense: 0 };
        combinations.forEach((item, index) => item.parts.forEach(tag => { totals[tag.tone] += weights[index]; }));
        const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
        combinations.forEach((item, index) => { for (const tag of item.parts) weights[index] *= (TONE_WEIGHTS[tag.tone] * total) / totals[tag.tone]; });
    }
    return Object.freeze(combinations.map((item, index) => Object.freeze({ ...item, weight: weights[index] })));
}
const CALIBRATED_COMBINATIONS = calibrateMarginalWeights(LEGAL_COMBINATIONS);
function takeWeighted(combinations, random) { let total = combinations.reduce((sum, item) => sum + item.weight, 0); if (!(total > 0)) return combinations.splice(pickIndex(combinations.length, random), 1)[0]; let target = checkedRandom(random) * total; for (let index = 0; index < combinations.length; index++) { target -= combinations[index].weight; if (target < 0 || index === combinations.length - 1) return combinations.splice(index, 1)[0]; } return null; }
export function drawTickets(count, { seed = 0, nonce = 0, random } = {}) { if (!Number.isInteger(count) || count < 1) throw new RangeError('count 必须是正整数'); if (count > LEGAL_TICKET_CAPACITY) throw new RangeError(`请求数量超过合法组合空间（${LEGAL_TICKET_CAPACITY}）`); const roll = typeof random === 'function' ? random : seededRandom(seed, nonce); const available = CALIBRATED_COMBINATIONS.slice(); const result = []; for (let index = 0; index < count; index++) result.push(makeTicket(takeWeighted(available, roll).parts, index)); return Object.freeze(result); }
export const drawVectorTickets = drawTickets;
export function drawTicket(options = {}) { return drawTickets(1, options)[0]; }
