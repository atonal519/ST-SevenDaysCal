import { serializeVectorCue } from './codec.js';
import { TERMINAL_LINE_STAGES } from '../schema.js';

export function bindVectorTickets({ previousLines = [], generatedLines = [], freshTickets = [] } = {}) {
    const queues = new Map();
    for (const line of Array.isArray(previousLines) ? previousLines : []) if (line?.name) { const queue = queues.get(line.name) || []; queue.push(line); queues.set(line.name, queue); }
    let ticketIndex = 0;
    return (Array.isArray(generatedLines) ? generatedLines : []).map(line => {
        const queue = queues.get(line?.name); const old = queue?.shift();
        if (old) return { ...line, cue: old.cue ?? null };
        // A terminal line is only valid when it closes an identity present in this run.
        // Dropping it here also leaves the next fresh ticket untouched.
        if (TERMINAL_LINE_STAGES.has(line?.stage)) return null;
        const ticket = freshTickets[ticketIndex++];
        return { ...line, cue: serializeVectorCue(ticket) };
    }).filter(Boolean);
}
