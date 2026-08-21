import { addCalendarDays, calendarDate, isGregorian, ordinalOf } from '../calendar/date.js';

export function asCalendarDate(value, calendar = null) {
    if (isGregorian(calendar) && value instanceof Date) return calendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    return value && typeof value === 'object' ? calendarDate(value.year ?? null, value.month, value.day) : null;
}

export function buildScheduleDateContext(calendar, startDate, weekdayReference = { ordinal: 1, weekday: 0 }) {
    const seed = asCalendarDate(startDate, calendar);
    if (!weekdayReference) return { calendar, seed, weekdayReference: { ordinal: null, weekday: null } };
    const normalizedReference = Number.isInteger(weekdayReference?.refDoy) && Number.isInteger(weekdayReference?.refWd)
        ? { ordinal: weekdayReference.refDoy, weekday: Number(weekdayReference.refWd) }
        : { ordinal: Number(weekdayReference?.ordinal ?? 1), weekday: Number(weekdayReference?.weekday ?? 0), ...(Number.isInteger(weekdayReference?.epochYear) ? { epochYear: weekdayReference.epochYear } : {}) };
    return { calendar, seed, weekdayReference: normalizedReference };
}

export function scheduleDateAtOffset(context, offset = 0) {
    if (!context?.seed || !Number.isInteger(offset)) return null;
    return addCalendarDays(context.seed, offset, context.calendar);
}

export function scheduleWeekdayAtOffset(context, offset = 0) {
    if (!context?.seed || !Number.isInteger(offset) || !Number.isInteger(context.weekdayReference?.weekday)) return null;
    const ref = context.weekdayReference;
    const date = scheduleDateAtOffset(context, offset);
    if (!date) return null;
    const ordinal = ordinalOf(date, context.calendar);
    if (ordinal == null || !Number.isInteger(ref.ordinal)) return null;
    return ((ref.weekday + ordinal - ref.ordinal) % 7 + 7) % 7;
}
