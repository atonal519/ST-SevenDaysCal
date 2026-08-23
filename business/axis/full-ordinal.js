// 完整纪年 ordinal，纯函数、无宿主依赖。
function gregorianOrdinal(date) {
    const year = +date.year, month = +date.month, day = +date.day;
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return null;
    const value = new Date(0);
    value.setUTCHours(0, 0, 0, 0);
    value.setUTCFullYear(year, month - 1, day);
    if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
    return Math.floor(value.getTime() / 86400000);
}

export function calendarDayOrdinal(date, cal) {
    if (!date || !cal || !Number.isFinite(+date.year) || !Number.isFinite(+date.month) || !Number.isFinite(+date.day)) return null;
    if (cal.kind === 'gregorian') return gregorianOrdinal(date);
    const months = Array.isArray(cal.months) ? cal.months : [];
    if (!months.length || date.month < 1 || date.month > months.length) return null;
    const days = Number(months[date.month - 1]?.days);
    if (!Number.isFinite(days) || date.day < 1 || date.day > days) return null;
    const before = months.slice(0, date.month - 1).reduce((sum, month) => sum + Number(month.days || 0), 0);
    const yearLen = months.reduce((sum, month) => sum + Number(month.days || 0), 0);
    return (+date.year * yearLen) + before + (+date.day - 1);
}
export function daysBetweenCalendarDates(from, to, cal) {
    const a = calendarDayOrdinal(from, cal), b = calendarDayOrdinal(to, cal);
    return a == null || b == null ? null : b - a;
}
