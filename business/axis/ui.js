import { calMonthCount, calMonthDays, calYearLen } from './data.js';

export function calendarSummary(cal) { return `一年 ${calMonthCount(cal)} 个月、共 ${calYearLen(cal)} 天`; }
export function calendarConflicts(items, cal) {
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

export function createAxisUi(env = {}) {
    const actionMenuHtml = menuId => {
        const items = env.actionMenus?.[menuId] || [];
        const rows = items.map(item => `<button type="button" class="sp-action-menu-item" data-action="${env.escapeAttr(item.action)}" title="${env.escapeAttr(item.title)}"><i class="fa-solid ${env.escapeAttr(item.icon)}" aria-hidden="true"></i><span>${env.escapeHtml(item.label)}</span></button>`).join('');
        return `<div class="sp-action-menu" data-menu-id="${env.escapeAttr(menuId)}"><button type="button" class="sp-icon-btn sp-action-menu-toggle" title="更多操作" aria-label="更多操作" aria-expanded="false"><i class="fa-solid fa-ellipsis-vertical"></i></button><div class="sp-action-menu-list" hidden>${rows}</div></div>`;
    };
    const todayBarHtml = () => {
        if (env.storyClockEnabled?.()) return '';
        const key = env.charKey?.(), cal = env.calendar?.(), today = env.today?.();
        const wdIndex = env.weekday?.(today.month, today.day, null, cal);
        const wd = wdIndex == null ? '星期未记录' : env.weekdays?.[wdIndex];
        if (!key) return `<div class="sp-alm-today"><span class="sp-alm-today-lbl">今天</span><span class="sp-alm-today-date">${env.monthName(cal, today.month)}${today.day}日·${wd}</span><span class="sp-alm-today-hint">无角色卡，无法钉</span></div>`;
        if (env.editing?.()) {
            const maxDim = Math.max(...cal.months.map(month => month.days));
            return `<div class="sp-alm-today sp-alm-today-editing"><span class="sp-alm-today-lbl">今天</span><input id="sp-alm-today-month" class="sp-input sp-alm-today-input" type="number" min="1" max="${env.monthCount(cal)}" placeholder="月" value="${today.month}"><span class="sp-alm-today-lbl">月</span><input id="sp-alm-today-day" class="sp-input sp-alm-today-input" type="number" min="1" max="${maxDim}" placeholder="日" value="${today.day}"><span class="sp-alm-today-lbl">日</span><span class="sp-alm-today-acts"><button class="sp-icon-btn sp-alm-today-save" title="确定"><i class="fa-solid fa-check"></i></button><button class="sp-icon-btn sp-alm-today-cancel" title="取消"><i class="fa-solid fa-xmark"></i></button></span></div>`;
        }
        const pinned = env.anchor?.(key), pinTag = pinned ? '<span class="sp-alm-today-pin" title="已手动钉住，压过自动确认"><i class="fa-solid fa-thumbtack"></i></span>' : '';
        const autoBtn = pinned ? '<button class="sp-icon-btn sp-alm-today-clear" title="恢复自动确认"><i class="fa-solid fa-rotate"></i></button>' : '';
        return `<div class="sp-alm-today"><span class="sp-alm-today-lbl">今天</span><span class="sp-alm-today-date">${env.monthName(cal, today.month)}${today.day}日·${wd}</span>${pinTag}<span class="sp-alm-today-acts"><button class="sp-icon-btn sp-alm-today-prev" title="往前一天（−1 天）"><i class="fa-solid fa-chevron-left"></i></button><button class="sp-icon-btn sp-alm-today-next" title="往后一天（+1 天）"><i class="fa-solid fa-chevron-right"></i></button><button class="sp-icon-btn sp-alm-today-edit" title="改日期"><i class="fa-solid fa-pen"></i></button>${autoBtn}</span></div>`;
    };
    const storyClockBarHtml = () => {
        if (!env.storyClockEnabled?.()) return '';
        const clock = env.latestClock?.();
        let value;
        if (!clock || (!clock.start && !clock.end)) value = '<span class="sp-alm-clock-wait">等待主楼 AI 打点…（发几楼后自动出现）</span>';
        else if (clock.start && clock.end && clock.start !== clock.end) value = `${env.escapeHtml(clock.start)} <span class="sp-alm-clock-arrow">→</span> ${env.escapeHtml(clock.end)}`;
        else value = env.escapeHtml(clock.end || clock.start);
        return `<div class="sp-alm-clock" title="由主楼 AI 每楼打的隐形时间戳读回，精确到小时"><span class="sp-alm-clock-lbl"><i class="fa-regular fa-clock"></i>时间戳</span><span class="sp-alm-clock-val">${value}</span></div>`;
    };
    return { actionMenuHtml, todayBarHtml, storyClockBarHtml };
}
