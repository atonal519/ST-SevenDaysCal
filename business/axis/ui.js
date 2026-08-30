import { calMonthCount, calMonthDays, calYearLen } from './data.js';
import { renderActionMenu } from '../utils/action-menu.js';

function displayMonthName(calendar, month, monthName) {
    const label = monthName?.(calendar, month);
    return String(label || `${month}月`);
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function classicalNumber(value) {
    const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 9999) return String(value ?? '');
    if (n < 10) return CN_DIGITS[n];
    const units = ['', '十', '百', '千']; const digits = String(n).split('').map(Number); let out = '';
    digits.forEach((digit, index) => {
        const pos = digits.length - index - 1;
        if (!digit) { if (out && digits.slice(index + 1).some(Boolean) && !out.endsWith('零')) out += '零'; return; }
        if (digit === 1 && pos === 1 && !out) out += '十';
        else out += `${CN_DIGITS[digit]}${units[pos]}`;
    });
    return out.replace(/零+/g, '零').replace(/零$/g, '');
}
function classicalDay(day) { const n = Number(day); if (n >= 1 && n <= 10) return `初${classicalNumber(n)}`; if (n >= 21 && n <= 29) return `廿${classicalNumber(n - 20)}`; return classicalNumber(n); }
export function formatCalendarDate({ year = null, eraLabel = '', month, day } = {}, calendar = null, monthName = (_cal, m) => `${m}月`, part = 'full') {
    const classical = calendar?.displayStyle === 'classical';
    const era = String(eraLabel || (classical ? calendar?.era || '' : '')).trim();
    const y = year == null ? '' : `${classical ? classicalNumber(year) : year}年`;
    const m = displayMonthName(calendar, month, monthName);
    const d = classical ? classicalDay(day) : `${day}`;
    if (part === 'year') return `${era}${y}`;
    if (part === 'monthDay') return `${m}${d}日`;
    return `${era}${y}${m}${d}日`;
}

// 纯显示格式化：轴面板只展示人类可读值，不把 date=/time= 等机器字段泄漏给用户。
// 无法确认结构化值时回退到已转义 raw，保证旧存档仍可读且不会注入 HTML。
export function formatStoryClockMeta(meta, escape = value => String(value ?? ''), calendar = null, monthName = (_cal, month) => `${month}月`) {
    const m = meta && typeof meta === 'object' ? meta : null;
    if (!m?.valid) return escape(m?.raw || '');
    const date = m.month != null && m.day != null ? formatCalendarDate(m, calendar, monthName) : '';
    const weekday = m.weekdayText || '';
    const time = m.time || '';
    const human = [date, weekday, time].filter(Boolean).join(' ');
    return escape(human || m.raw || '');
}

// 楼内小时间条的纯组装 seam：index.js 仍负责挑最新楼/解析旧 stamp，本函数只统一最终月名显示。
export function formatStoryClockHeadParts({ anchor, anchorWeekday, clockMeta = null, stampDate = null, rawStamp = '', calendar = null, monthName = (_cal, month) => `${month}月`, escapeHtml = value => String(value ?? ''), tip = '' } = {}) {
    const today = (dateText, weekday = '', title = '') => `<span class="sp-dash-sum-today"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(dateText)}${weekday ? ` ${escapeHtml(weekday)}` : ''}</span>`;
    const dateText = value => formatCalendarDate(value, calendar, monthName);
    const fallbackWeekday = anchorWeekday || '星期未记录';
    const fallback = { todayHtml: today(dateText(anchor), fallbackWeekday), timeHtml: '' };
    if (clockMeta?.valid && clockMeta.month != null && clockMeta.day != null) {
        const weekday = clockMeta.weekdayText || fallbackWeekday;
        const timeHtml = clockMeta.time ? `<span class="sp-dash-sum-time">${escapeHtml(clockMeta.time)}</span>` : '';
        return { todayHtml: today(dateText(clockMeta), weekday, tip), timeHtml };
    }
    if (stampDate?.month != null && stampDate?.day != null) {
        const timeHtml = stampDate.time ? `<span class="sp-dash-sum-time">${escapeHtml(stampDate.time)}</span>` : '';
        return { todayHtml: today(dateText(stampDate), '星期未记录', tip), timeHtml };
    }
    if (rawStamp) return { todayHtml: today(String(rawStamp), '', tip), timeHtml: '' };
    return fallback;
}

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
        return renderActionMenu(menuId, items, env.escapeHtml, env.escapeAttr);
    };
    const todayBarHtml = () => {
        const key = env.charKey?.(), cal = env.calendar?.(), today = env.today?.();
        const wdIndex = env.weekday?.(today.month, today.day, null, cal);
        const wd = wdIndex == null ? '星期未记录' : env.weekdays?.[wdIndex];
        const todayText = formatCalendarDate(today, cal, env.monthName);
        if (!key) return `<div class="sp-alm-today"><span class="sp-alm-today-lbl">今天</span><span class="sp-alm-today-date">${env.escapeHtml(todayText)}·${wd}</span><span class="sp-alm-today-hint">无角色卡，无法钉</span></div>`;
        if (env.editing?.()) {
            const maxDim = Math.max(...cal.months.map(month => month.days));
            const selected = env.storyCalibration?.()?.weekday;
            const monthOptions = Array.from({ length: env.monthCount(cal) }, (_, index) => {
                const month = index + 1;
                return `<option value="${month}" ${month === today.month ? 'selected' : ''}>${env.escapeHtml(displayMonthName(cal, month, env.monthName))}</option>`;
            }).join('');
            const weekdays = (env.weekdays || []).map((label, index) => `<option value="${index}" ${index === selected ? 'selected' : ''}>${label}</option>`).join('');
            return `<div class="sp-alm-today sp-alm-today-editing"><span class="sp-alm-today-lbl sp-alm-today-calibration-title">校准故事时间</span><select id="sp-alm-today-month" class="sp-input sp-alm-today-input sp-alm-today-month" aria-label="故事月份">${monthOptions}</select><input id="sp-alm-today-day" class="sp-input sp-alm-today-input" type="number" min="1" max="${maxDim}" placeholder="日" value="${today.day}"><span class="sp-alm-today-lbl">日</span><select id="sp-alm-today-weekday" class="sp-input sp-alm-today-weekday">${weekdays}</select><span class="sp-alm-today-acts"><button class="sp-icon-btn sp-alm-today-save" title="保存校准"><i class="fa-solid fa-check"></i></button><button class="sp-icon-btn sp-alm-today-cancel" title="取消"><i class="fa-solid fa-xmark"></i></button></span></div>`;
        }
        const pinned = env.anchor?.(key), calibration = env.storyCalibration?.(), pinTag = calibration ? '<span class="sp-alm-today-pin" title="人工故事时间校准"><i class="fa-solid fa-compass"></i></span>' : pinned ? '<span class="sp-alm-today-pin" title="兼容旧版日期锚点"><i class="fa-solid fa-thumbtack"></i></span>' : '';
        const autoBtn = pinned || calibration ? '<button class="sp-icon-btn sp-alm-today-clear" title="恢复自动"><i class="fa-solid fa-rotate"></i></button>' : '';
        return `<div class="sp-alm-today"><span class="sp-alm-today-lbl">今天</span><span class="sp-alm-today-date">${env.escapeHtml(todayText)}·${wd}</span>${pinTag}<span class="sp-alm-today-acts"><button class="sp-icon-btn sp-alm-today-prev" title="往前一天（−1 天）"><i class="fa-solid fa-chevron-left"></i></button><button class="sp-icon-btn sp-alm-today-next" title="往后一天（+1 天）"><i class="fa-solid fa-chevron-right"></i></button><button class="sp-icon-btn sp-alm-today-edit" title="校准故事时间"><i class="fa-solid fa-pen"></i></button>${autoBtn}</span></div>`;
    };
    const storyClockBarHtml = () => {
        if (!env.storyClockEnabled?.()) return '';
        const clock = env.latestClock?.();
        let value;
        if (!clock || (!clock.start && !clock.end)) value = '<span class="sp-alm-clock-wait">等待主楼 AI 打点…（发几楼后自动出现）</span>';
        else if (clock.start && clock.end && clock.start !== clock.end) value = `${formatStoryClockMeta(clock.startMeta, env.escapeHtml, env.calendar?.(), env.monthName)} <span class="sp-alm-clock-arrow">→</span> ${formatStoryClockMeta(clock.endMeta, env.escapeHtml, env.calendar?.(), env.monthName)}`;
        else value = formatStoryClockMeta(clock.endMeta || clock.startMeta, env.escapeHtml, env.calendar?.(), env.monthName);
        return `<div class="sp-alm-clock" title="由主楼 AI 每楼打的隐形时间戳读回，精确到小时"><span class="sp-alm-clock-lbl">当下时间</span><span class="sp-alm-clock-val">${value}</span></div>`;
    };
    return { actionMenuHtml, todayBarHtml, storyClockBarHtml };
}
