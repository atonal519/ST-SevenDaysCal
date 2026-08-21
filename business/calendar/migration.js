import { calendarDate, dateFromOrdinal, formatCalendarDate, ordinalOf, parseCalendarDate, validateCalendarDate, validateCalendarDescriptor } from './date.js';

function migrateDate(value, oldCalendar, nextCalendar, diagnostics) {
    if (value == null) return null;
    if (typeof value !== 'object' || !Number.isInteger(+value.month) || !Number.isInteger(+value.day)) { diagnostics.push({ type: 'invalid-date', path: 'date', reason: 'expected month/day object' }); return null; }
    const source = calendarDate(value.year ?? null, +value.month, +value.day);
    const ordinal = ordinalOf(source, oldCalendar);
    if (ordinal == null) { diagnostics.push({ type: 'unresolved-date', path: 'date', reason: 'date is outside source calendar' }); return value; }
    const next = dateFromOrdinal(ordinal, nextCalendar, source.year);
    if (!next) { diagnostics.push({ type: 'unresolved-date', path: 'date', reason: 'date is outside target calendar' }); return value; }
    return { ...value, ...(next.year == null ? {} : { year: next.year }), month: next.month, day: next.day };
}

function migrateScheduleEntry(entry, oldCalendar, nextCalendar, diagnostics, index) {
    const copy = JSON.parse(JSON.stringify(entry));
    const raw = copy?.value?.raw;
    if (typeof raw !== 'string') return copy;
    const match = raw.match(/(^|\n)\s*StartDate:\s*((?:\d{4}|null)-\d{2}-\d{2})/i);
    if (!match) return copy;
    const source = parseCalendarDate(match[2], oldCalendar);
    if (!source) { diagnostics.push({ type: 'invalid-date', path: `schedules.${index}.value.raw.StartDate`, reason: 'invalid source date' }); return copy; }
    const absolute = ordinalOf(source, oldCalendar);
    const migrated = dateFromOrdinal(absolute, nextCalendar, source.year);
    if (!migrated) { diagnostics.push({ type: 'unresolved-date', path: `schedules.${index}.value.raw.StartDate`, reason: 'date conversion unknown' }); return copy; }
    copy.value.raw = raw.replace(match[2], formatCalendarDate(migrated));
    return copy;
}

export function planCalendarMigration({ oldCalendar, nextCalendar, anchor = null, ledgers = [], ledgerState = null, schedules = [], storeEntries = [], fallbackPolicy = null, fallbackExisting = null } = {}) {
    const diagnostics = [];
    if (!validateCalendarDescriptor(oldCalendar) || !validateCalendarDescriptor(nextCalendar)) return { ok: false, diagnostics: [{ type: 'invalid-calendar', path: 'calendar' }] };
    const nextAnchor = migrateDate(anchor, oldCalendar, nextCalendar, diagnostics);
    // ledgerState 是唯一权威来源；ledgers 仅为旧调用方兼容且在有 state 时忽略。
    const sourceLedgerEntries = Array.isArray(ledgerState?.entries) ? ledgerState.entries : ledgers;
    const nextLedgers = sourceLedgerEntries.map(entry => {
        const copy = JSON.parse(JSON.stringify(entry));
        for (const field of ['起始锚', '现状锚', '到期锚']) {
            if (copy[field] != null && typeof copy[field] !== 'object') diagnostics.push({ type: 'invalid-date', path: `ledgers.${entry.id || '?'}.${field}`, reason: 'anchor must be object' });
            else if (copy[field]?.历日期 != null) copy[field].历日期 = migrateDate(copy[field].历日期, oldCalendar, nextCalendar, diagnostics);
        }
        return copy;
    });
    const sourceSchedules = storeEntries.length ? storeEntries : schedules;
    const nextSchedules = sourceSchedules.map((entry, index) => migrateScheduleEntry(entry, oldCalendar, nextCalendar, diagnostics, index));
    const nextStoreEntries = nextSchedules.map(entry => JSON.parse(JSON.stringify(entry)));
    // 仅在用户已确认迁移 policy 且尚不存在 fallback 时，向候选 metadata 计划追加首次 write-once 记录；
    // planner 不直接写盘，commit 仍由上层事务决定。
    if (fallbackPolicy && !fallbackExisting) {
        nextStoreEntries.push({ kind: 'caldesc-fallback', view: 'user', charName: '', value: {
            schemaVersion: 1, marker: 'calendar-fallback-v1', generation: 1, establishedAt: Date.now(),
            compatibilityPolicy: fallbackPolicy, calendar: JSON.parse(JSON.stringify(oldCalendar)),
        } });
    }
    const nextLedgerState = ledgerState
        ? { ...JSON.parse(JSON.stringify(ledgerState)), entries: nextLedgers }
        : { version: 1, entries: nextLedgers, seq: nextLedgers.reduce((max, e) => Math.max(max, Number(String(e?.id || '').replace(/^L/, '')) || 0), 0) };
    const ok = diagnostics.length === 0;
    if (nextAnchor && !validateCalendarDate(calendarDate(nextAnchor.year ?? null, nextAnchor.month, nextAnchor.day), nextCalendar)) diagnostics.push({ type: 'invalid-anchor' });
    return { ok: ok && diagnostics.every(d => d.type !== 'invalid-anchor'), nextCalendar, nextAnchor, nextLedgerState, nextStoreEntries, nextSchedules, diagnostics };
}
