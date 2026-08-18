import {
    loadCalDesc, loadAlmanac, almClampInt, calYearLen, almDayOfYear,
    almMonthDayFromDoy, calMonthDays, calMonthName, almItemCoversDoy,
    almTypeMeta, ALM_WEEKDAYS,
} from './data.js';
import { almTodayAnchor, almWeekdayRef, almWeekdayFor } from './anchor.js';
import { axisState } from './state.js';

export function renderAxisCalendar(env) {
    const cal = loadCalDesc();
    const m0 = Number.isFinite(axisState._almanacCalMonth)
        ? axisState._almanacCalMonth
        : (axisState._almanacCalMonth = almTodayAnchor().month - 1);
    const month1 = m0 + 1;
    const items = loadAlmanac();
    const wkRef = almWeekdayRef(cal);
    const byDay = {};
    for (const it of items) {
        const days = almClampInt(it.days, 1, calYearLen(cal), 1);
        const start = almDayOfYear(it.month, it.day, cal);
        for (let k = 0; k < days; k++) {
            const md = almMonthDayFromDoy(start + k, cal);
            if (md.month === month1) (byDay[md.day] ||= []).push(it);
        }
    }
    const dim = calMonthDays(cal, month1);
    const anchor = almTodayAnchor();
    const ctx = { cal, wkRef, todayDoy: almDayOfYear(anchor.month, anchor.day, cal) };
    const selected = axisState._almanacCalDay;
    const head = ['一', '二', '三', '四', '五', '六', '日']
        .map(w => `<div class="sp-alm-weekhead-cell">${w}</div>`).join('');
    const lead = (almWeekdayFor(month1, 1, wkRef, cal) + 6) % 7;
    const leadCells = Array.from({ length: lead }, () => '<div class="sp-alm-cell-empty"></div>').join('');
    const travelState = axisState.timeTravelState;
    const travelTarget = travelState?.selectedTargetDate;
    const cells = [];
    for (let day = 1; day <= dim; day++) {
        const dayItems = byDay[day] || [];
        const dots = dayItems.length
            ? `<span class="sp-alm-cell-dots">${dayItems.slice(0, 3).map(it => `<i class="sp-alm-dot sp-alm-type-${almTypeMeta(it.type).cls}"></i>`).join('')}</span>`
            : '';
        const isTravelTarget = travelTarget?.month === month1 && travelTarget?.day === day;
        cells.push(`<div class="sp-alm-cell${dayItems.length ? ' sp-alm-cell-has' : ''}${anchor.month === month1 && day === anchor.day ? ' sp-alm-cell-today' : ''}${selected === day ? ' sp-alm-cell-sel' : ''}${isTravelTarget ? ' sp-alm-cell-time-travel' : ''}" data-day="${day}"><span class="sp-alm-cell-num">${day}</span>${dots}</div>`);
    }
    let detailItems;
    let detailHead;
    if (selected != null) {
        const selectedDoy = almDayOfYear(month1, selected, cal);
        detailItems = items.filter(it => almItemCoversDoy(it, selectedDoy, cal)).sort((a, b) => a.month - b.month || a.day - b.day);
        detailHead = `<div class="sp-alm-cal-detail-head"><span>${calMonthName(cal, month1)}${selected}日 · ${ALM_WEEKDAYS[almWeekdayFor(month1, selected, wkRef, cal)]}</span><span class="sp-alm-cal-detail-tools"><button class="sp-alm-add-day sp-mini-btn" data-day="${selected}">＋加到这天</button><button class="sp-alm-cal-clearsel sp-mini-btn">看全月</button></span></div>`;
    } else {
        detailItems = items.filter(it => it.month === month1).sort((a, b) => a.day - b.day);
        detailHead = '<div class="sp-alm-cal-detail-head"><span>本月日期</span></div>';
    }
    const travelControl = travelState
        ? '<button class="sp-alm-time-travel-stop sp-mini-btn">中断时旅</button>'
        : (selected != null && !(anchor.month === month1 && anchor.day === selected)
            ? `<button class="sp-alm-time-travel sp-mini-btn" data-day="${selected}">跳到这天</button>`
            : '');
    const rows = detailItems.length ? `<div class="sp-alm-list">${detailItems.map(it => env.almRowHtml(it, ctx)).join('')}</div>` : `<div class="sp-alm-cal-empty">${selected != null ? '这天没有日期' : '本月暂无日期'}</div>`;
    return `<div class="sp-alm-cal"><div class="sp-alm-cal-head"><button class="sp-icon-btn sp-alm-cal-prev" title="上个月"><i class="fa-solid fa-chevron-left"></i></button><span class="sp-alm-cal-title">${calMonthName(cal, month1)}</span><button class="sp-icon-btn sp-alm-cal-next" title="下个月"><i class="fa-solid fa-chevron-right"></i></button></div><div class="sp-alm-weekhead">${head}</div><div class="sp-alm-grid">${leadCells}${cells.join('')}</div><div class="sp-alm-cal-detail">${detailHead}${travelControl}${rows}</div></div>`;
}
