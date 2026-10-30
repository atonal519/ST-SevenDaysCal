import { daysInMonth, isGregorian, weekdayFor } from '../calendar/date.js';
import { daysBetweenCalendarDates } from './full-ordinal.js';
import { ledgerEntryWithinCutoff } from '../ledger/date.js';

// 仅读取历条目、历法和本楼日期；同月日才补齐本楼已知纪年，不借现实年份。
export function createPhoneCalendarSource(env) {
    return ({ expectedChatId, includeSchedules = false } = {}) => {
        if (!env.enabled()) return null;
        const context = env.context(), chatId = context.chatId ?? context.getCurrentChatId?.();
        if (expectedChatId !== undefined && expectedChatId !== chatId) return null;
        const items = env.items(), ledgerEntries = includeSchedules ? env.entries?.() : null;
        if (!Array.isArray(items) && !(Array.isArray(ledgerEntries) && ledgerEntries.length)) return null;
        const calendar = env.calendar();
        let meta = null;
        for (let i = context.chat.length - 1; i >= 0; i--) {
            const message = context.chat[i];
            if (!message || message.is_user || message.is_system || message.role === 'system' || !message.mes) continue;
            const clock = env.parseClock(message.mes, calendar);
            meta = clock.endMeta?.valid ? clock.endMeta : clock.startMeta?.valid ? clock.startMeta : null;
            break;
        }
        const pinned = env.anchor(), sameDate = pinned && pinned.month === meta?.month && pinned.day === meta?.day && (pinned.year == null || meta.year == null || pinned.year === meta.year);
        const today = pinned ? { ...(sameDate ? meta.date : {}), ...pinned } : meta?.date || null;
        const calibration = pinned && env.calibration();
        const weekdayReference = calibration
            ? { year: today.year ?? null, month: calibration.refMonth, day: calibration.refDay, weekday: calibration.weekday }
            : (!pinned || sameDate) && meta ? { ...today, weekday: meta.weekdayIndex } : null;
        return { calendar, items, today, weekdayReference,
            ledgerEntries: Array.isArray(ledgerEntries) ? ledgerEntries : [], ledgerCutoff: includeSchedules ? env.floorContext?.() : undefined };
    };
}

// 月历只投影年度日期；短信另取截止范围内的刻度副本，不调用生成与保存入口。
export function createPhoneCalendarApi({ read, formatDate, selectSchedules, dueInfo, daysSince } = {}) {
    const monthDays = (cal, month, year) => year == null ? Number(cal.months[month - 1]?.days || 0) : daysInMonth(cal, month, year);
    const ordinal = (date, cal) => cal.months.slice(0, date.month - 1).reduce((sum, _, i) => sum + monthDays(cal, i + 1, date.year), date.day);
    const yearLength = (cal, year) => cal.months.reduce((sum, _, i) => sum + monthDays(cal, i + 1, year), 0);
    const difference = (from, to, cal) => from.year != null && to.year != null ? daysBetweenCalendarDates(from, to, cal) : ordinal(to, cal) - ordinal(from, cal);
    const validDay = (date, cal) => Number.isInteger(date.month) && Number.isInteger(date.day) && date.month > 0 && date.month <= cal.months.length && date.day > 0 && date.day <= monthDays(cal, date.month, date.year);
    const label = (date, cal, part = 'full') => {
        if (formatDate) return formatDate(date, cal, part);
        const year = `${date.eraLabel || cal.era || ''}${date.year != null ? `${date.year}年` : ''}`;
        return part === 'year' ? year : `${part === 'monthDay' ? '' : year}${cal.months[date.month - 1].name}${date.day}日`;
    };
    function source(options) {
        const state = read?.(options);
        if (!state?.calendar?.months?.length || !Array.isArray(state.items) && !options?.includeSchedules) return null;
        const cal = state.calendar;
        const items = (Array.isArray(state.items) ? state.items : []).filter(item => ['festival', 'birthday', 'anniversary', 'custom'].includes(item?.type) && String(item.name || '').trim() && validDay({ month: item.month, day: item.day, year: null }, cal));
        return { ...state, items, today: state.today && validDay(state.today, cal) ? state.today : null };
    }
    const itemView = (item, cal) => ({ id: String(item.id || `${item.type}:${item.month}:${item.day}:${item.name}`), name: String(item.name), type: item.type, date: String(item.displayDate || label({ month: item.month, day: item.day }, cal, 'monthDay')), days: Math.max(1, Number(item.days) || 1), note: String(item.note || '') });
    const anchorView = anchor => anchor ? { floor: anchor.楼层 ?? null, date: structuredClone(anchor.历日期 ?? null), ...(anchor.来源指纹 ? { sourceId: String(anchor.来源指纹) } : {}) } : null;
    function schedulesFor(state, query) {
        const cutoff = state.ledgerCutoff;
        if (!Number.isInteger(cutoff?.floor)) return [];
        const entries = (state.ledgerEntries || []).filter(entry => entry && ['持续状态', '约定待办', '周期'].includes(entry.类型)
            && entry.状态 === '活跃' && entry.静音 !== true && !['待确认', '来源已删除'].includes(entry.来源状态)
            && ledgerEntryWithinCutoff(entry, cutoff.floor));
        const picked = entries.length ? selectSchedules?.(entries, String(query), cutoff) || [] : [];
        return picked.map(entry => {
            const due = dueInfo?.(entry, cutoff);
            return { id: String(entry.id || ''), reason: String(entry.事由 || ''), type: entry.类型, status: entry.状态, currentState: String(entry.现状 || ''),
                startedAt: anchorView(entry.起始锚), observedAt: anchorView(entry.现状锚), dueAt: anchorView(entry.到期锚),
                cycleDays: entry.周期长度 == null ? null : Number(entry.周期长度), relatedPeople: (entry.牵扯 || []).map(String),
                elapsedDays: daysSince?.(entry, cutoff) ?? null, dueInfo: due ? { days: due.天数, overdue: due.过期 } : null };
        });
    }
    function elapsed(item, date, cal) {
        const start = { year: date.year ?? null, month: item.month, day: item.day };
        if (!validDay(start, cal)) return null;
        let delta = difference(start, date, cal);
        if (delta < 0) {
            if (date.year != null) delta = difference({ ...start, year: date.year - 1 }, date, cal);
            else delta += yearLength(cal, null);
        }
        return delta;
    }
    const covers = (item, date, cal) => { const delta = elapsed(item, date, cal); return delta != null && delta >= 0 && delta < Math.max(1, Number(item.days) || 1); };
    function until(item, date, cal) {
        if (covers(item, date, cal)) return 0;
        let start = { year: date.year ?? null, month: item.month, day: item.day };
        if (!validDay(start, cal)) return null;
        let delta = difference(date, start, cal);
        if (delta < 0) {
            if (date.year != null) { start = { ...start, year: date.year + 1 }; delta = validDay(start, cal) ? difference(date, start, cal) : null; }
            else delta += yearLength(cal, null);
        }
        return delta;
    }
    return Object.freeze({
        apiVersion: 1,
        getPhoneCalendar({ monthOffset = 0 } = {}) {
            const state = source(); if (!state) return null;
            const { calendar: cal, today, items } = state;
            const offset = Number.isInteger(monthOffset) ? monthOffset : 0, count = cal.months.length;
            const absolute = (today?.month || 1) - 1 + offset, turn = Math.floor(absolute / count);
            const month = (absolute % count + count) % count + 1, year = today?.year == null ? null : today.year + turn;
            const first = { year, month, day: 1 }, cycle = Number(cal.weekdayCycle || 7);
            const reference = state.weekdayReference || (Number.isInteger(today?.weekday) ? today : null);
            let weekday = null;
            if (reference && Number.isInteger(reference.weekday)) {
                const delta = difference(reference, first, cal) + (year == null ? turn * yearLength(cal, null) : 0);
                if (delta != null) weekday = ((reference.weekday + delta) % cycle + cycle) % cycle;
            } else if (isGregorian(cal) && year != null) weekday = weekdayFor(first, cal);
            return {
                year, month, monthName: cal.months[month - 1].name, title: String(cal.title || ''), eraLabel: String(today?.eraLabel || cal.era || ''), yearLabel: label({ ...today, year }, cal, 'year'),
                today: today ? label(today, cal) : '',
                weekdays: weekday == null ? [] : cycle === 7 ? ['一', '二', '三', '四', '五', '六', '日'] : Array.from({ length: cycle }, (_, i) => String(i + 1)),
                columns: cycle, leading: weekday == null ? 0 : cycle === 7 ? (weekday + 6) % 7 : weekday,
                days: Array.from({ length: monthDays(cal, month, year) }, (_, i) => {
                    const date = { year, month, day: i + 1, ...(today?.eraLabel ? { eraLabel: today.eraLabel } : {}) };
                    return { day: date.day, label: label(date, cal), isToday: offset === 0 && today?.day === date.day, items: items.filter(item => covers(item, date, cal)).map(item => itemView(item, cal)) };
                }),
            };
        },
        getPhoneCalendarContext({ query = '', expectedChatId, includeSchedules = false } = {}) {
            const state = source({ expectedChatId, includeSchedules: includeSchedules === true }); if (!state) return null;
            const { calendar: cal, today } = state;
            const events = state.items.flatMap(item => {
                const d = today ? until(item, today, cal) : null;
                const mentioned = item.name.length >= 2 && String(query).includes(item.name);
                if (!(d != null && d >= 0 && d <= 7) && !mentioned) return [];
                const ongoing = d === 0 && Math.max(1, Number(item.days) || 1) > 1;
                return [{ ...itemView(item, cal), when: d == null ? '' : ongoing ? '进行中' : d === 0 ? '今天' : `${d}天后`, order: ongoing ? -1 : d ?? Infinity }];
            }).sort((a, b) => a.order - b.order).map(({ order, ...item }) => item);
            const schedules = includeSchedules === true ? schedulesFor(state, query) : [];
            return events.length || schedules.length ? { today: today ? label(today, cal) : '', events,
                ...(schedules.length ? { schedules, scheduleAsOf: { floor: state.ledgerCutoff.floor, date: structuredClone(state.ledgerCutoff.date ?? null) } } : {}) } : null;
        },
    });
}
