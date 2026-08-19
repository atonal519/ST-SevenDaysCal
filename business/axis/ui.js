// business/axis/ui.js — Phase 2c-1: axis 视图/数据 helper（纯净、无跨域依赖、无 DOM）
// 本轮仅迁入 calendarSummary / calendarConflicts 两个纯 helper。
// 其余 axis UI/渲染函数因直接或间接依赖跨域污染源（almTodayAnchor / almWeekdayRef /
// almWeekdayFor / currentCharacterCards / charStableKey / getDateAnchor 等）或回调
// renderAlmanacPanel 编排器，硬搬会造成 ui.js ↔ index.js 循环依赖，故暂留 index.js。
import { calMonthCount, calMonthDays, calYearLen } from './data.js';

function calendarSummary(cal) { return `一年 ${calMonthCount(cal)} 个月、共 ${calYearLen(cal)} 天`; }

function calendarConflicts(items, cal) {
    return items.map(item => {
        const month = Number(item.month), day = Number(item.day), days = Number(item.days || 1);
        const invalid = month < 1 || month > calMonthCount(cal) || day < 1 || day > calMonthDays(cal, Math.min(Math.max(month, 1), calMonthCount(cal))) || days < 1 || days > calYearLen(cal);
        if (!invalid) return null;
        const fixedMonth = Math.min(Math.max(Number.isFinite(month) ? month : 1, 1), calMonthCount(cal));
        const fixedDay = Math.min(Math.max(Number.isFinite(day) ? day : 1, 1), calMonthDays(cal, fixedMonth));
        const fixedDays = Math.min(Math.max(Number.isFinite(days) ? days : 1, 1), calYearLen(cal));
        return { item, fixed: { ...item, month: fixedMonth, day: fixedDay, days: fixedDays, displayDate: (fixedMonth !== month || fixedDay !== day) ? '' : item.displayDate } };
    }).filter(Boolean);
}

export {
    calendarSummary,
    calendarConflicts,
};
