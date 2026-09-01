import { TERMINAL_LINE_STAGES } from './schema.js';

export const AUTO_LINE_CAPACITY = 8;
// 每轮签发完整自动池容量的票据，允许旧线集中进入终态后由新线补满空位。
export const AUTO_LINE_SEED_CAPACITY = AUTO_LINE_CAPACITY;

// 在完整校验、票据绑定和锁线合并之后收敛自动池；不接触尚未验证的 AI 输出。
// 同名线使用队列逐一匹配，避免用名称 Set 把重复身份错误合并。
export function enforceLineCapacity({ previousLines = [], mergedLines = [], max = AUTO_LINE_CAPACITY } = {}) {
    const limit = Number.isInteger(max) && max >= 0 ? max : AUTO_LINE_CAPACITY;
    const candidates = Array.isArray(mergedLines) ? mergedLines : [];
    const used = new Set();
    const retained = [];
    const isActiveAuto = line => line?.pin !== true && !TERMINAL_LINE_STAGES.has(line?.stage);
    const oldAuto = (Array.isArray(previousLines) ? previousLines : []).filter(isActiveAuto);
    const queues = new Map();
    for (let index = 0; index < candidates.length; index++) {
        const line = candidates[index];
        if (!isActiveAuto(line)) continue;
        const queue = queues.get(line?.name) || [];
        queue.push(index);
        queues.set(line?.name, queue);
    }
    for (const old of oldAuto) {
        if (retained.length >= limit) break;
        const queue = queues.get(old?.name);
        const index = queue?.find(index => !used.has(index));
        if (index == null) continue;
        used.add(index);
        retained.push(candidates[index]);
    }
    for (let index = 0; index < candidates.length && retained.length < limit; index++) {
        const line = candidates[index];
        if (!isActiveAuto(line) || used.has(index)) continue;
        used.add(index);
        retained.push(line);
    }
    // 本轮刚收束的终态线与锁线都不占自动活线池，并维持各自在合并结果中的顺序。
    const settled = candidates.filter(line => line?.pin !== true && TERMINAL_LINE_STAGES.has(line?.stage));
    const pinned = candidates.filter(line => line?.pin === true);
    const model = [...retained, ...settled, ...pinned];
    return { ok: true, model, dropped: Math.max(0, candidates.length - model.length), rawCount: model.length };
}
