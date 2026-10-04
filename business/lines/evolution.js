import { isTerminalLineStage } from './schema.js';

export function auditLineEvolution({ previousLines = [], generatedLines = [], freshTickets = [], intent = 'advance' } = {}) {
    const previous = Array.isArray(previousLines) ? previousLines : [];
    const generated = Array.isArray(generatedLines) ? generatedLines : [];
    const identityQueues = new Map();
    const activeNames = new Set();
    const pinnedNames = new Set();
    for (const line of previous) {
        if (!line?.name || (line.pin !== true && isTerminalLineStage(line.stage))) continue;
        const kind = line.pin === true ? 'pinned' : 'active';
        const queue = identityQueues.get(line.name) || [];
        queue.push({ kind, line });
        identityQueues.set(line.name, queue);
        if (kind === 'active') activeNames.add(line.name);
        else pinnedNames.add(line.name);
    }
    for (const queue of identityQueues.values()) queue.sort((a, b) => Number(a.kind === 'pinned') - Number(b.kind === 'pinned'));
    for (const line of generated) {
        const name = String(line?.name || '').trim();
        if (!name) return { ok: false, reason: 'evolution-empty-name' };
        const queue = identityQueues.get(name);
        const identity = queue?.shift();
        if (identity?.kind === 'active') {
            if (line.ticketId != null) return { ok: false, reason: 'evolution-old-line-ticket' };
        } else if (identity?.kind === 'pinned') {
            if (line.ticketId != null) return { ok: false, reason: 'evolution-pinned-ticket' };
        } else if (activeNames.has(name) || pinnedNames.has(name)) {
            return { ok: false, reason: activeNames.has(name) ? 'evolution-duplicate-old-line' : 'evolution-duplicate-pinned-line' };
        } else {
            if (isTerminalLineStage(line.stage)) return { ok: false, reason: 'evolution-newborn-terminal' };
            if (!line.ticketId) return { ok: false, reason: 'evolution-newborn-missing-ticket' };
        }
    }
    const ticketIds = new Set((Array.isArray(freshTickets) ? freshTickets : []).map(ticket => ticket?.ticketId).filter(Boolean));
    for (const line of generated) if (!activeNames.has(line.name) && !pinnedNames.has(line.name) && !ticketIds.has(line.ticketId)) return { ok: false, reason: 'evolution-unknown-ticket' };
    return { ok: true };
}
