import { TERMINAL_LINE_STAGES } from './schema.js';

const SEED_LIMIT = 4;

export function auditLineEvolution({ previousLines = [], generatedLines = [], freshTickets = [], intent = 'advance' } = {}) {
    const previous = Array.isArray(previousLines) ? previousLines : [];
    const generated = Array.isArray(generatedLines) ? generatedLines : [];
    const identityQueues = new Map();
    const oldActive = [];
    const activeNames = new Set();
    const pinnedNames = new Set();
    for (const line of previous) {
        if (!line?.name || (line.pin !== true && TERMINAL_LINE_STAGES.has(line.stage))) continue;
        const kind = line.pin === true ? 'pinned' : 'active';
        const queue = identityQueues.get(line.name) || [];
        queue.push({ kind, line });
        identityQueues.set(line.name, queue);
        if (kind === 'active') { oldActive.push(line); activeNames.add(line.name); }
        else pinnedNames.add(line.name);
    }
    for (const queue of identityQueues.values()) queue.sort((a, b) => Number(a.kind === 'pinned') - Number(b.kind === 'pinned'));
    const consumedActive = new Map();
    let terminalExits = 0;
    let newborn = 0;
    for (const line of generated) {
        const name = String(line?.name || '').trim();
        if (!name) return { ok: false, reason: 'evolution-empty-name' };
        const queue = identityQueues.get(name);
        const identity = queue?.shift();
        if (identity?.kind === 'active') {
            consumedActive.set(name, (consumedActive.get(name) || 0) + 1);
            if (line.ticketId != null) return { ok: false, reason: 'evolution-old-line-ticket' };
            if (TERMINAL_LINE_STAGES.has(line.stage)) terminalExits++;
        } else if (identity?.kind === 'pinned') {
            if (TERMINAL_LINE_STAGES.has(line.stage)) return { ok: false, reason: 'evolution-pinned-terminal' };
            if (line.ticketId != null) return { ok: false, reason: 'evolution-pinned-ticket' };
        } else if (activeNames.has(name) || pinnedNames.has(name)) {
            return { ok: false, reason: activeNames.has(name) ? 'evolution-duplicate-old-line' : 'evolution-duplicate-pinned-line' };
        } else {
            if (TERMINAL_LINE_STAGES.has(line.stage)) return { ok: false, reason: 'evolution-newborn-terminal' };
            if (!line.ticketId) return { ok: false, reason: 'evolution-newborn-missing-ticket' };
            newborn++;
        }
    }
    if (intent === 'advance') {
        for (const old of oldActive) {
            const expected = oldActive.filter(line => line.name === old.name).length;
            if ((consumedActive.get(old.name) || 0) !== expected) return { ok: false, reason: 'evolution-old-line-missing' };
        }
        if (newborn > Math.min(SEED_LIMIT, 1 + terminalExits)) return { ok: false, reason: 'evolution-newborn-overflow' };
    } else if (newborn > SEED_LIMIT) return { ok: false, reason: 'evolution-seed-overflow' };
    const ticketIds = new Set((Array.isArray(freshTickets) ? freshTickets : []).map(ticket => ticket?.ticketId).filter(Boolean));
    for (const line of generated) if (!activeNames.has(line.name) && !pinnedNames.has(line.name) && !ticketIds.has(line.ticketId)) return { ok: false, reason: 'evolution-unknown-ticket' };
    return { ok: true, newborn, terminalExits };
}
