import { loadAlmanac, loadCalDesc, almDayOfYear } from './data.js';
import { almTodayAnchor, almWeekdayRef, sortAlmanacUpcoming } from './anchor.js';
import { axisState } from './state.js';

export function renderAxisUpcoming(env) {
    const items = loadAlmanac();
    if (!items.length) return env.renderAlmanacEmpty();
    const anchor = almTodayAnchor();
    const cal = loadCalDesc();
    const ctx = { cal, wkRef: almWeekdayRef(cal), todayDoy: almDayOfYear(anchor.month, anchor.day, cal) };
    const sorted = sortAlmanacUpcoming(items, cal);
    return env.batchBarHtml('almanac', sorted.length, '批量删除', true)
        + `<div class="sp-alm-list">${sorted.map(it => env.almRowHtml(it, ctx)).join('')}</div>`;
}
