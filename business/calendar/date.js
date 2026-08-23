// 纯 CalendarDate/CalendarEngine：自定义历法绝不经过 JS Date。
export function calendarDate(year, month, day) {
    return { year: year == null ? null : Number(year), month: Number(month), day: Number(day) };
}

export function validateCalendarDescriptor(calendar) {
    if (calendar == null || calendar?.kind === 'gregorian' || calendar?.id === 'default-gregorian') return true;
    if (!Array.isArray(calendar.months) || !calendar.months.length || calendar.months.length > 60) return false;
    if (!calendar.months.every(m => Number.isInteger(Number(m?.days)) && Number(m.days) > 0 && Number(m.days) <= 60)) return false;
    const total = calendar.months.reduce((n, m) => n + Number(m.days), 0);
    return total > 0 && total <= 2000 && (calendar.weekdayCycle == null || (Number.isInteger(Number(calendar.weekdayCycle)) && Number(calendar.weekdayCycle) > 0));
}

export function weekdayFor(date, calendar = null, reference = { ordinal: 1, weekday: 1 }) {
    if (isGregorian(calendar) && Number.isInteger(date?.year)) {
        const d = new Date(0); d.setUTCHours(0, 0, 0, 0); d.setUTCFullYear(date.year, date.month - 1, date.day);
        return d.getUTCDay();
    }
    if (!isGregorian(calendar) && Number.isInteger(date?.year) && !Number.isInteger(calendar?.epochYear) && !Number.isInteger(reference?.epochYear)) return null;
    const ordinal = ordinalOf(date, calendar); if (ordinal == null) return null;
    const cycle = Number(calendar?.weekdayCycle || 7);
    const yearLength = calendar.months.reduce((n, m) => n + Number(m.days), 0);
    if (date.year == null) return ((Number(reference.weekday || 0) + ordinal - Number(reference.ordinal || 1)) % cycle + cycle) % cycle;
    const epochYear = Number.isInteger(calendar?.epochYear) ? calendar.epochYear : reference.epochYear;
    const epochOrdinal = Number.isInteger(calendar?.epochOrdinal) ? calendar.epochOrdinal : Number(reference.ordinal || 1);
    const epochWeekday = Number.isInteger(calendar?.epochWeekday) ? calendar.epochWeekday : Number(reference.weekday || 0);
    const absoluteOrdinal = ordinal - epochOrdinal + (date.year - epochYear) * yearLength;
    return ((epochWeekday + absoluteOrdinal) % cycle + cycle) % cycle;
}

export function isGregorian(calendar) {
    return calendar == null || calendar.kind === 'gregorian' || calendar.id === 'default-gregorian';
}

export function daysInMonth(calendar, month, year = null) {
    if (isGregorian(calendar)) {
        if (month === 2 && Number.isInteger(year)) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
        return [31,28,31,30,31,30,31,31,30,31,30,31][month - 1] || 0;
    }
    return Number(calendar?.months?.[month - 1]?.days || 0);
}

export function validateCalendarDate(date, calendar = null) {
    if (!date || !Number.isInteger(date.month) || !Number.isInteger(date.day) || date.month < 1 || date.day < 1) return false;
    if (isGregorian(calendar)) {
        if (date.month > 12 || !Number.isInteger(date.year) || date.year < 1) return false;
        const d = new Date(0); d.setUTCHours(0, 0, 0, 0); d.setUTCFullYear(date.year, date.month - 1, date.day);
        return d.getUTCFullYear() === date.year && d.getUTCMonth() === date.month - 1 && d.getUTCDate() === date.day;
    }
    if (date.year != null && (!Number.isInteger(date.year) || date.year < 0)) return false;
    return date.month <= calendar.months.length && date.day <= daysInMonth(calendar, date.month, date.year);
}

export function ordinalOf(date, calendar) {
    if (!validateCalendarDate(date, calendar)) return null;
    let n = date.day; for (let m = 1; m < date.month; m++) n += daysInMonth(calendar, m, date.year); return n;
}

export function dateFromOrdinal(ordinal, calendar, year = null) {
    const total = isGregorian(calendar) ? (Number.isInteger(year) && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365) : calendar.months.reduce((n, m) => n + Number(m.days), 0);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > total) return null;
    const months = isGregorian(calendar) ? 12 : calendar.months.length;
    let n = ordinal; for (let m = 1; m <= months; m++) { const d = daysInMonth(calendar, m, year); if (n <= d) return calendarDate(year, m, n); n -= d; }
    return null;
}

export function addCalendarDays(date, delta, calendar) {
    const start = ordinalOf(date, calendar); if (start == null || !Number.isInteger(delta)) return null;
    if (isGregorian(calendar) && Number.isInteger(date.year)) {
        const utc = new Date(0); utc.setUTCHours(0, 0, 0, 0); utc.setUTCFullYear(date.year, date.month - 1, date.day);
        utc.setUTCDate(utc.getUTCDate() + delta);
        return calendarDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
    }
    const total = isGregorian(calendar) ? (Number.isInteger(date.year) && date.year % 4 === 0 && (date.year % 100 !== 0 || date.year % 400 === 0) ? 366 : 365) : calendar.months.reduce((n, m) => n + Number(m.days), 0);
    if (date.year == null && Math.floor((start - 1 + delta) / total) !== 0) return null;
    if (!isGregorian(calendar) && date.year != null && Math.floor((start - 1 + delta) / total) !== 0 && !calendar?.absoluteCycle && !Number.isInteger(calendar?.epochYear)) return null;
    const ordinal = ((start - 1 + delta) % total + total) % total + 1;
    const year = date.year == null ? null : date.year + Math.floor((start - 1 + delta) / total);
    return dateFromOrdinal(ordinal, calendar, year);
}

export function parseCalendarDate(text, calendar = null) {
    const m = /^(\d{4}|null)-(\d{1,2})-(\d{1,2})$/.exec(String(text || '').trim()); if (!m) return null;
    const date = calendarDate(m[1] === 'null' ? null : +m[1], +m[2], +m[3]);
    return validateCalendarDate(date, calendar) ? date : null;
}

export function formatCalendarDate(date) {
    if (!date || !Number.isInteger(date.month) || !Number.isInteger(date.day)) return null;
    const year = date.year == null ? 'null' : String(date.year).padStart(4, '0');
    return `${year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}
