export const DATE_ANCHOR_SCHEMA = 1;
export const DATE_ANCHOR_STORE_KEY = 'date-anchor-user';
export const CALENDAR_FALLBACK_SCHEMA = 1;
export const CALENDAR_FALLBACK_MARKER = 'calendar-fallback-v1';
import { validateCalendarDescriptor as formalCalendarValidator } from '../business/calendar/validator.js';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

export function makeChatAnchor(chatId, month, day, source = 'explicit') {
    if (!String(chatId || '').trim() || !Number.isInteger(+month) || !Number.isInteger(+day)) return null;
    return { schemaVersion: DATE_ANCHOR_SCHEMA, chatId: String(chatId), month: +month, day: +day, source: source === 'auto' || source === 'detected' ? source : 'explicit' };
}
export function normalizeChatAnchor(value, chatId) {
    if (!value || value.schemaVersion !== DATE_ANCHOR_SCHEMA || String(value.chatId) !== String(chatId || '')) return null;
    const a = value.anchor && typeof value.anchor === 'object' ? value.anchor : value;
    return Number.isInteger(+a.month) && Number.isInteger(+a.day) ? { month: +a.month, day: +a.day, source: a.source || value.source || 'unknown' } : null;
}
export function unresolvedLegacyAnchor(identity = null) { return { status: 'unresolved', reason: 'legacy-global-anchor-needs-explicit-claim', identity }; }

export function createChatAnchorRepository({ chatId, read, write, legacy = null, claimMarkerRead = null, claimMarkerWrite = null } = {}) {
    const id = () => String(typeof chatId === 'function' ? chatId() || '' : chatId || '');
    const localRecord = () => { try { return read?.() || null; } catch { return null; } };
    const local = () => { const r = localRecord(); if (r?.state === 'auto') return null; return r?.state === 'set' ? normalizeChatAnchor(r, id()) : normalizeChatAnchor(r?.anchor ? r : null, id()); };
    const legacyValue = () => { try { return typeof legacy === 'function' ? legacy() : legacy; } catch { return null; } };
    const legacyPending = () => {
        if (localRecord()?.state === 'auto' || local()) return null;
        const v = legacyValue(); if (!v || !Number.isInteger(+v.month) || !Number.isInteger(+v.day)) return null;
        const identity = String(v.identity || v.key || `${v.month}/${v.day}`); const marker = claimMarkerRead?.() || localRecord()?.claimMarker;
        if (marker && marker.identity === identity) return null;
        return { status: 'pending', identity, month: +v.month, day: +v.day, source: 'legacy' };
    };
    const persist = record => { try { return write?.(record) === true; } catch { return false; } };
    const set = (month, day, source = 'explicit') => { const a = makeChatAnchor(id(), month, day, source); if (!a) return { ok: false, reason: 'invalid-anchor' }; return persist({ schemaVersion: DATE_ANCHOR_SCHEMA, state: 'set', chatId: id(), anchor: a }) ? { ok: true, anchor: a } : { ok: false, reason: 'write-failed' }; };
    const clear = () => { if (!id()) return { ok: false, reason: 'missing-chat' }; return persist({ schemaVersion: DATE_ANCHOR_SCHEMA, state: 'auto', chatId: id(), anchor: null }) ? { ok: true, tombstone: true } : { ok: false, reason: 'write-failed' }; };
    const claim = (month, day, options = {}) => {
        const p = legacyPending(); if (!p) return { ok: false, reason: 'no-pending-legacy' };
        if (options.confirmed === false) return { ok: false, reason: 'cancelled', wrote: false };
        const a = makeChatAnchor(id(), month ?? p.month, day ?? p.day, 'explicit'); if (!a) return { ok: false, reason: 'invalid-anchor' };
        const before = localRecord(); const record = { schemaVersion: DATE_ANCHOR_SCHEMA, state: 'set', chatId: id(), anchor: a, claimMarker: { schemaVersion: 1, identity: p.identity, ownerChatId: id(), claimedAt: Date.now() } };
        if (!persist(record)) return { ok: false, reason: 'write-failed' };
        return { ok: true, anchor: a, claimed: true, identity: p.identity, marker: record.claimMarker, memoryUpdated: true, durability: 'unconfirmed' };
    };
    return { get: () => local() || legacyPending() || null, pending: legacyPending, set, auto: (m, d) => set(m, d, 'auto'), clear, claim, cancel: () => ({ ok: true, wrote: false }) };
}

export function isValidCalendarDescriptor(c) {
    return !formalCalendarValidator(c).error;
}
export function writeOnceCalendarFallback(read, write, calendar, { establishedAt = Date.now(), compatibilityPolicy = 'first-valid' } = {}) {
    const current = read?.();
    if (current != null) { if (current.marker !== CALENDAR_FALLBACK_MARKER || !isValidCalendarDescriptor(current.calendar)) return { ok: false, reason: 'invalid-existing-fallback' }; return { ok: true, value: clone(current.calendar), record: clone(current), wrote: false }; }
    if (!isValidCalendarDescriptor(calendar)) return { ok: false, reason: 'invalid-calendar' };
    const record = { schemaVersion: CALENDAR_FALLBACK_SCHEMA, marker: CALENDAR_FALLBACK_MARKER, generation: 1, establishedAt, compatibilityPolicy, calendar: clone(calendar) }; let ok = false; try { ok = write?.(record) === true; } catch { ok = false; }
    return ok ? { ok: true, value: clone(calendar), record, wrote: true } : { ok: false, reason: 'write-failed' };
}
export function resolveSnapshotCalendar(snapshot, { fallback = null, marker = false, current = null } = {}) {
    const v = Number(snapshot?.v ?? snapshot?.schemaVersion ?? 0);
    if (v >= 2) return isValidCalendarDescriptor(snapshot.calendar) ? { resolved: true, calendar: clone(snapshot.calendar), source: 'snapshot-v2' } : { resolved: false, calendar: null, source: 'invalid-v2', reason: 'invalid-calendar' };
    const f = fallback?.calendar ? fallback.calendar : fallback;
    if (marker) return isValidCalendarDescriptor(f) ? { resolved: true, calendar: clone(f), source: 'write-once-fallback' } : { resolved: false, calendar: null, source: 'invalid-fallback', reason: 'marker-without-valid-calendar' };
    return isValidCalendarDescriptor(current) ? { resolved: true, calendar: clone(current), source: 'never-migrated-current' } : { resolved: false, calendar: null, source: 'unresolved' };
}
