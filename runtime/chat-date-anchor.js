export const DATE_ANCHOR_SCHEMA = 1;
export const DATE_ANCHOR_STORE_KEY = 'date-anchor-user';
import { validateCalendarDescriptor as formalCalendarValidator } from '../business/calendar/validator.js';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

export function makeChatAnchor(chatId, month, day, source = 'explicit') {
    if (!String(chatId || '').trim() || !Number.isInteger(+month) || !Number.isInteger(+day)) return null;
    return { schemaVersion: DATE_ANCHOR_SCHEMA, chatId: String(chatId), month: +month, day: +day, source: source === 'auto' || source === 'detected' || source === 'calibration' ? source : 'explicit' };
}
export function normalizeChatAnchor(value, chatId) {
    if (!value || value.schemaVersion !== DATE_ANCHOR_SCHEMA || String(value.chatId) !== String(chatId || '')) return null;
    const a = value.anchor && typeof value.anchor === 'object' ? value.anchor : value;
    if (!Number.isInteger(+a.month) || !Number.isInteger(+a.day)) return null;
    const calibration = a.calibration && typeof a.calibration === 'object' && Number.isInteger(+a.calibration.weekday)
        ? { refMonth: a.calibration.refMonth != null && Number.isInteger(+a.calibration.refMonth) ? +a.calibration.refMonth : +a.month, refDay: a.calibration.refDay != null && Number.isInteger(+a.calibration.refDay) ? +a.calibration.refDay : +a.day, weekday: +a.calibration.weekday, floor: a.calibration.floor != null && Number.isInteger(+a.calibration.floor) ? +a.calibration.floor : null, sourceFloor: a.calibration.sourceFloor != null && Number.isInteger(+a.calibration.sourceFloor) ? +a.calibration.sourceFloor : null, swipe: a.calibration.swipe == null ? null : String(a.calibration.swipe) }
        : null;
    const year = Number.isInteger(+a.year) && +a.year >= 1 && +a.year <= 9999 ? +a.year : null;
    const eraLabel = typeof a.eraLabel === 'string' && a.eraLabel.trim() ? a.eraLabel.trim() : null;
    return { month: +a.month, day: +a.day, ...(year != null ? { year } : {}), ...(eraLabel ? { eraLabel } : {}), source: a.source || value.source || 'unknown', ...(calibration ? { calibration } : {}) };
}
export function unresolvedLegacyAnchor(identity = null) { return { status: 'unresolved', reason: 'legacy-global-anchor-needs-explicit-claim', identity }; }

export function createChatAnchorRepository({ chatId, read, write, writeConfirmed, legacy = null, claimMarkerRead = null, claimMarkerWrite = null } = {}) {
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
    const setRecord = (month, day, source = 'explicit', options = {}) => {
        const a = makeChatAnchor(id(), month, day, source);
        if (!a) return null;
        if (Number.isInteger(+options.year) && +options.year >= 1 && +options.year <= 9999) a.year = +options.year;
        if (typeof options.eraLabel === 'string' && options.eraLabel.trim()) a.eraLabel = options.eraLabel.trim();
        const calibration = options.calibration || (source === 'calibration' ? options : null);
        if (calibration && Number.isInteger(+calibration.weekday)) a.calibration = { refMonth: calibration.refMonth != null && Number.isInteger(+calibration.refMonth) ? +calibration.refMonth : +month, refDay: calibration.refDay != null && Number.isInteger(+calibration.refDay) ? +calibration.refDay : +day, weekday: calibration.weekday, floor: calibration.floor != null && Number.isInteger(+calibration.floor) ? +calibration.floor : null, sourceFloor: calibration.sourceFloor != null && Number.isInteger(+calibration.sourceFloor) ? +calibration.sourceFloor : null, swipe: calibration.swipe == null ? null : String(calibration.swipe) };
        return { anchor: a, record: { schemaVersion: DATE_ANCHOR_SCHEMA, state: 'set', chatId: id(), anchor: a } };
    };
    const set = (month, day, source = 'explicit', options = {}) => {
        const built = setRecord(month, day, source, options);
        if (!built) return { ok: false, reason: 'invalid-anchor' };
        return persist(built.record) ? { ok: true, anchor: built.anchor } : { ok: false, reason: 'write-failed' };
    };
    const setConfirmed = async (month, day, source = 'explicit', options = {}, persistenceOptions = {}) => {
        const built = setRecord(month, day, source, options);
        if (!built) return { ok: false, reason: 'invalid-anchor' };
        if (typeof writeConfirmed !== 'function') return set(month, day, source, options);
        const stored = await writeConfirmed(built.record, persistenceOptions);
        if (!(stored === true || stored?.ok === true)) return stored || { ok: false, reason: 'write-failed' };
        return stored === true ? { ok: true, anchor: built.anchor } : { ...stored, anchor: built.anchor };
    };
    const clear = () => { if (!id()) return { ok: false, reason: 'missing-chat' }; return persist({ schemaVersion: DATE_ANCHOR_SCHEMA, state: 'auto', chatId: id(), anchor: null }) ? { ok: true, tombstone: true } : { ok: false, reason: 'write-failed' }; };
    const claim = (month, day, options = {}) => {
        const p = legacyPending(); if (!p) return { ok: false, reason: 'no-pending-legacy' };
        if (options.confirmed === false) return { ok: false, reason: 'cancelled', wrote: false };
        const a = makeChatAnchor(id(), month ?? p.month, day ?? p.day, 'explicit'); if (!a) return { ok: false, reason: 'invalid-anchor' };
        const record = { schemaVersion: DATE_ANCHOR_SCHEMA, state: 'set', chatId: id(), anchor: a, claimMarker: { schemaVersion: 1, identity: p.identity, ownerChatId: id(), claimedAt: Date.now() } };
        if (!persist(record)) return { ok: false, reason: 'write-failed' };
        return { ok: true, anchor: a, claimed: true, identity: p.identity, marker: record.claimMarker, memoryUpdated: true, durability: 'unconfirmed' };
    };
    const claimCalibration = (month, day, options = {}) => {
        const p = legacyPending(); if (!p) return { ok: false, reason: 'no-pending-legacy' };
        const a = makeChatAnchor(id(), month ?? p.month, day ?? p.day, 'calibration');
        if (!a || !Number.isInteger(+options.weekday)) return { ok: false, reason: 'invalid-calibration' };
        a.calibration = { refMonth: options.refMonth != null && Number.isInteger(+options.refMonth) ? +options.refMonth : +a.month, refDay: options.refDay != null && Number.isInteger(+options.refDay) ? +options.refDay : +a.day, weekday: +options.weekday, floor: options.floor != null && Number.isInteger(+options.floor) ? +options.floor : null, sourceFloor: options.sourceFloor != null && Number.isInteger(+options.sourceFloor) ? +options.sourceFloor : null, swipe: options.swipe == null ? null : String(options.swipe) };
        const record = { schemaVersion: DATE_ANCHOR_SCHEMA, state: 'set', chatId: id(), anchor: a, claimMarker: { schemaVersion: 1, identity: p.identity, ownerChatId: id(), claimedAt: Date.now() } };
        return persist(record) ? { ok: true, anchor: a, claimed: true, identity: p.identity, marker: record.claimMarker } : { ok: false, reason: 'write-failed' };
    };
    return { get: () => local() || legacyPending() || null, pending: legacyPending, set, setConfirmed, auto: (m, d) => set(m, d, 'auto'), clear, claim, claimCalibration, cancel: () => ({ ok: true, wrote: false }) };
}

export function isValidCalendarDescriptor(c) {
    return !formalCalendarValidator(c).error;
}
export function resolveSnapshotCalendar(snapshot, { fallback = null, marker = false, current = null } = {}) {
    const v = Number(snapshot?.v ?? snapshot?.schemaVersion ?? 0);
    if (v >= 2) return isValidCalendarDescriptor(snapshot.calendar) ? { resolved: true, calendar: clone(snapshot.calendar), source: 'snapshot-v2' } : { resolved: false, calendar: null, source: 'invalid-v2', reason: 'invalid-calendar' };
    const f = fallback?.calendar ? fallback.calendar : fallback;
    if (marker) return isValidCalendarDescriptor(f) ? { resolved: true, calendar: clone(f), source: 'write-once-fallback' } : { resolved: false, calendar: null, source: 'invalid-fallback', reason: 'marker-without-valid-calendar' };
    return isValidCalendarDescriptor(current) ? { resolved: true, calendar: clone(current), source: 'never-migrated-current' } : { resolved: false, calendar: null, source: 'unresolved' };
}
