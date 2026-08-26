import { parseCalendar, serializeCalendar } from './parse.js';
export { editPointDescription, editPointFields } from './edit.js';

function eventsAt(parsed, dayKey) {
    return dayKey === 'future' ? (parsed.future?.events || null) : (parsed.days?.[Number(dayKey)]?.events || null);
}

export function togglePointPinRaw(raw, dayKey, eventIndex, calendar = null) {
    const parsed = parseCalendar(raw, calendar); const events = eventsAt(parsed, dayKey); const ev = events?.[eventIndex];
    if (!ev) return { ok: false, reason: 'event-not-found', raw };
    ev.pin = !ev.pin;
    return { ok: true, pinned: ev.pin, raw: serializeCalendar(parsed.allDays || parsed.days, parsed.future, parsed.startDate, calendar, parsed.startDateToken) };
}

export function deletePointEventRaw(raw, dayKey, eventIndex, calendar = null) {
    const parsed = parseCalendar(raw, calendar); const events = eventsAt(parsed, dayKey);
    if (!events?.[eventIndex]) return { ok: false, reason: 'event-not-found', raw };
    const [event] = events.splice(eventIndex, 1);
    return { ok: true, deleted: event, raw: serializeCalendar(parsed.allDays || parsed.days, parsed.future, parsed.startDate, calendar, parsed.startDateToken) };
}
