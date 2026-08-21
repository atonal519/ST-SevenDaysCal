import { addCalendarDays, calendarDate, isGregorian, weekdayFor } from '../calendar/date.js';

export function asCalendarDate(value, calendar = null) {
    if (isGregorian(calendar) && value instanceof Date) return calendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    return value && typeof value === 'object' ? calendarDate(value.year ?? null, value.month, value.day) : null;
}

export function buildScheduleDateContext(calendar, startDate, weekdayReference = { ordinal: 1, weekday: 0 }) {
    const seed = asCalendarDate(startDate, calendar);
    const normalizedReference = Number.isInteger(weekdayReference?.refDoy)
        ? { ordinal: weekdayReference.refDoy, weekday: Number(weekdayReference.refWd) }
        : { ordinal: Number(weekdayReference?.ordinal ?? 1), weekday: Number(weekdayReference?.weekday ?? 0), ...(Number.isInteger(weekdayReference?.epochYear) ? { epochYear: weekdayReference.epochYear } : {}) };
    return { calendar, seed, weekdayReference: normalizedReference };
}

export function scheduleDateAtOffset(context, offset = 0) {
    if (!context?.seed || !Number.isInteger(offset)) return null;
    return addCalendarDays(context.seed, offset, context.calendar);
}

export function scheduleWeekdayAtOffset(context, offset = 0) {
    const date = scheduleDateAtOffset(context, offset);
    return date ? weekdayFor(date, context.calendar, context.weekdayReference) : null;
}
