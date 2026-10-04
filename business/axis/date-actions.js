// 轴日期动作：保存/清除锚点以及“今天 ±1”的宿主无关业务流程。
import { addCalendarDays, validateCalendarDescriptor } from '../calendar/date.js';
export function createAxisDateActions(env = {}) {
    const saveAnchor = (key, month, day, source = 'explicit', options = {}) => {
        if (!key) return { ok: false, reason: 'missing-character' };
        if (month == null) return env.repository?.clear?.() || { ok: false, reason: 'missing-repository' };
        const result = Object.keys(options || {}).length ? env.repository?.set?.(month, day, source, options) : env.repository?.set?.(month, day, source);
        return result || { ok: false, reason: 'missing-repository' };
    };
    const clearAnchor = (key) => {
        if (!key) return { ok: false, reason: 'missing-character' };
        return env.repository?.clear?.(key) || { ok: false, reason: 'missing-repository' };
    };
    const nudgeToday = (delta, { storyClock = false } = {}) => {
        const key = env.charKey?.();
        if (!key) { env.toast?.('当前没有角色卡，无法钉日期', null, true); return { ok: false, reason: 'missing-character' }; }
        const calendar = env.calendar?.();
        const ownerIdentity = { chatId: env.chatId?.(), floor: env.floor?.(), swipe: env.swipe?.() };
        const today = env.today?.();
        const step = Number(delta || 0);
        const fullTarget = validateCalendarDescriptor(calendar)
            ? addCalendarDays({ year: today?.year ?? null, month: today?.month, day: today?.day }, step, calendar)
            : null;
        const startOrdinal = env.dayOfYear?.(today?.month, today?.day, calendar);
        const targetOrdinal = Number(startOrdinal) + step;
        const target = fullTarget || env.monthDayFromDoy?.(targetOrdinal, calendar);
        if (!target) { env.toast?.('日期保存失败，请重试', null, true); return { ok: false, reason: 'invalid-target' }; }
        const yearLength = Array.isArray(calendar?.months)
            ? calendar.months.reduce((sum, month) => sum + Number(month?.days || 0), 0)
            : null;
        const fallbackCrossedYear = !fullTarget && Number.isInteger(startOrdinal) && Number.isInteger(yearLength)
            && yearLength > 0 && (targetOrdinal < 1 || targetOrdinal > yearLength);
        const currentWeekday = env.weekday?.(today.month, today.day, null, calendar);
        if (storyClock && !Number.isInteger(currentWeekday)) { env.toast?.('当前没有可用故事星期，请先校准', null, true); return { ok: false, reason: 'weekday' }; }
        const cycle = Number.isInteger(Number(calendar?.weekdayCycle)) && Number(calendar.weekdayCycle) > 0 ? Number(calendar.weekdayCycle) : 7;
        const weekday = storyClock ? ((currentWeekday + step) % cycle + cycle) % cycle : null;
        const dateFacts = {
            ...(Number.isInteger(target.year) ? { year: target.year } : Number.isInteger(today?.year) && !fallbackCrossedYear ? { year: today.year } : {}),
            ...(typeof today?.eraLabel === 'string' && today.eraLabel.trim() ? { eraLabel: today.eraLabel } : {}),
        };
        const stored = saveAnchor(key, target.month, target.day, storyClock ? 'calibration' : 'explicit', storyClock ? { ...dateFacts, refMonth: target.month, refDay: target.day, weekday, floor: ownerIdentity.floor, sourceFloor: ownerIdentity.floor, swipe: ownerIdentity.swipe } : dateFacts);
        if (!stored.ok) { env.toast?.('日期保存失败，请重试', null, true); return stored; }
        env.aftermath?.();
        return { ok: true, date: target };
    };
    const saveManual = async (month, day, { storyClock = false, weekday = null } = {}) => {
        const key = env.charKey?.(); if (!key) { env.toast?.('当前没有角色卡，无法钉日期', null, true); return { ok: false, reason: 'missing-character' }; }
        const ownerIdentity = { chatId: env.chatId?.(), floor: env.floor?.(), swipe: env.swipe?.() };
        const calendar = env.calendar?.(), count = env.monthCount?.(calendar);
        if (!(month >= 1 && month <= count)) { env.toast?.(`请填 1-${count} 月`, null, true); return { ok: false, reason: 'month' }; }
        const max = env.monthDays?.(calendar, month);
        if (!(day >= 1 && day <= max)) { env.toast?.(`${month} 月只有 1-${max} 日`, null, true); return { ok: false, reason: 'day' }; }
        if (storyClock && (!Number.isInteger(+weekday) || +weekday < 0 || +weekday > 6)) { env.toast?.('请选择故事星期', null, true); return { ok: false, reason: 'weekday' }; }
        let stored;
        if (env.pending?.()) {
            const confirmed = await env.confirm?.({ title: '发现旧版日期锚点', body: '是否将旧版全局日期仅认领到当前聊天？', confirmText: '认领', cancelText: '取消' });
            if (!confirmed) { env.toast?.('已取消认领，未写入日期', null, true); return { ok: false, reason: 'cancelled' }; }
            stored = storyClock ? (env.repository?.claimCalibration?.(month, day, { refMonth: month, refDay: day, weekday: +weekday, floor: ownerIdentity.floor, sourceFloor: ownerIdentity.floor, swipe: ownerIdentity.swipe }) || { ok: false, reason: 'missing-repository' }) : env.repository?.claim?.(month, day);
        } else {
            stored = storyClock ? (env.repository?.set?.(month, day, 'calibration', { refMonth: month, refDay: day, weekday: +weekday, floor: ownerIdentity.floor, sourceFloor: ownerIdentity.floor, swipe: ownerIdentity.swipe }) || { ok: false, reason: 'missing-repository' }) : saveAnchor(key, month, day);
        }
        if (!stored?.ok) { env.toast?.('日期保存失败，请重试', null, true); return stored || { ok: false, reason: 'save' }; }
        const monthLabel = env.monthName?.(calendar, month) || `${month}月`;
        env.aftermath?.(); env.toast?.(storyClock ? `已校准故事时间为 ${monthLabel}${day}日` : `已把今天钉为 ${monthLabel}${day}日`); return { ok: true, date: { month, day } };
    };
    return { saveAnchor, clearAnchor, saveManual, nudgeToday };
}
