import { serializeVectorCue } from './codec.js';
import { TERMINAL_LINE_STAGES } from '../schema.js';

export function bindVectorTickets({ previousLines = [], generatedLines = [], freshTickets = [] } = {}) {
    const queues = new Map();
    for (const line of Array.isArray(previousLines) ? previousLines : []) if (line?.name) { const queue = queues.get(line.name) || []; queue.push(line); queues.set(line.name, queue); }
    for (const queue of queues.values()) queue.sort((a, b) => Number(a.pin === true) - Number(b.pin === true));
    const tickets = new Map();
    for (const ticket of Array.isArray(freshTickets) ? freshTickets : []) { if (!ticket?.ticketId || tickets.has(ticket.ticketId)) throw new Error('invalid-fresh-ticket-id'); tickets.set(ticket.ticketId, ticket); }
    const used = new Set();
    const bound = (Array.isArray(generatedLines) ? generatedLines : []).map(line => {
        const queue = queues.get(line?.name); const old = queue?.shift();
        if (old) { if (line.ticketId != null) throw new Error('old-line-ticket-forbidden'); const { ticketId: _ticketId, ...withoutTicket } = line; return { ...withoutTicket, pin: old.pin === true, adult: old.adult === true, cue: old.cue ?? null }; }
        // A terminal line is only valid when it closes an identity present in this run.
        // Dropping it here also leaves the next fresh ticket untouched.
        if (TERMINAL_LINE_STAGES.has(line?.stage)) { if (line.ticketId != null) throw new Error('terminal-line-ticket-forbidden'); return null; }
        if (!line?.ticketId || used.has(line.ticketId)) throw new Error('missing-or-duplicate-ticket-id');
        const ticket = tickets.get(line.ticketId); if (!ticket) throw new Error('unknown-ticket-id');
        used.add(line.ticketId);
        const { ticketId: _ticketId, ...withoutTicket } = line;
        return { ...withoutTicket, adult: Boolean(ticket.adultSelection), cue: serializeVectorCue(ticket) };
    }).filter(Boolean);
    return bound;
}
