// 点楼内日程条纯渲染：不请求 API、不写 store；宿主注入当前 raw 与公共 HTML helpers。
import { formatPointDate } from './date-context.js';
export function createPointInlineRenderer(env) {
    function buildScheduleBlock(rawArg = null, readOnly = false, calendarOverride = null, weekdayRefOverride = undefined) {
        if (env.settings().scheduleInlineEnabled === false) return '';
        const raw = rawArg != null ? rawArg : env.readRaw(); if (!raw) return '';
        const calendar = calendarOverride === undefined ? env.loadCalendar() : calendarOverride;
        const { days, future, startDate } = env.parseCalendar(raw, calendar); const hasFuture = future && future.events.length > 0;
        if (!days.length && !hasFuture) return '';
        let total = 0; const rel = ['今天', '明天', '后天'];
        const cell = (label, date, weather, count, cls, key) => `<div class="sp-sch-scell${cls}" data-day="${env.escapeAttr(String(key))}"><span class="sp-sch-scell-rel">${env.escapeHtml(label)}</span><span class="sp-sch-scell-line">${date ? `<span class="sp-sch-scell-md">${env.escapeHtml(date)}</span>` : ''}${weather ? `<span class="sp-sch-scell-wx">${weather}</span>` : ''}<span class="sp-sch-scell-n">${count}</span></span></div>`;
        const context = env.scheduleDayCtx(startDate, calendar, weekdayRefOverride);
        const cells = days.map((day, index) => { const count = day.events.length; total += count; let date = `第${index + 1}天`; if (startDate) { const value = env.scheduleDayLabel(index, startDate, context); date = formatPointDate(value.month, value.day, context.cal, true) || '日期未知'; } return cell(rel[index] || `第${index + 1}天`, date, env.weatherGlyph(day.weather), count, (index === 0 ? ' sp-sch-scell-today' : '') + (count ? ' sp-sch-scell-has' : ''), index); });
        if (hasFuture) { const count = future.events.length; cells.push(cell('未来', '', '', count, ' sp-sch-scell-future' + (count ? ' sp-sch-scell-has' : ''), 'future')); }
        return `<summary class="sp-inline-summary"><span class="sp-inline-title">点</span><span class="sp-inline-count">${total}件待办</span></summary><div class="sp-inline-body sp-sch-inline-body"><div class="sp-sch-strip-wrap sp-sch-strip-live"><div class="sp-sch-strip">${cells.join('')}</div><div class="sp-sch-sday" hidden></div></div></div>`;
    }
    function buildScheduleDay(dayKey, rawArg = null, readOnly = false, calendarOverride = null, weekdayRefOverride = undefined) {
        const calendar = calendarOverride === undefined ? env.loadCalendar() : calendarOverride;
        const { days, future, startDate } = env.parseCalendar(rawArg != null ? rawArg : env.readRaw(), calendar);
        let events = [], headLabel = '', dateLabel = '', weather = '', temp = '';
        if (dayKey === 'future') { events = future?.events || []; headLabel = dateLabel = '未来'; }
        else {
            const index = Number(dayKey); const day = days[index]; events = day?.events || []; weather = String(day?.weather || '').trim(); temp = String(day?.temp || '').trim();
            if (startDate) { const context = env.scheduleDayCtx(startDate, calendar, weekdayRefOverride); const value = env.scheduleDayLabel(index, startDate, context); const dateText = formatPointDate(value.month, value.day, context.cal); headLabel = dateText ? `${dateText} · ${value.wd == null ? '星期未记录' : env.weekdays[value.wd]}` : '日期未知'; }
            else headLabel = `第${index + 1}天`;
            dateLabel = headLabel; if (weather || temp) headLabel += ` · ${env.weatherGlyph(weather)}${weather}${temp ? ' ' + temp : ''}`;
        }
        const head = `<div class="sp-sch-sday-head">${env.escapeHtml(headLabel)}</div>`;
        if (!events.length) return `${head}<div class="sp-sch-sday-empty">这天没有安排</div>`;
        const rows = events.map((event, eventIndex) => {
            const meta = env.typeMeta[event.type] || env.typeMeta.main;
            const actions = readOnly ? '' : `<span class="sp-sch-drawer-actions">${env.makeInjectBtn(env.buildPointInjectText(event, weather, temp, dateLabel))}<button class="sp-sch-del-one" data-day="${env.escapeAttr(String(dayKey))}" data-ev="${eventIndex}" title="删除这个点"><i class="fa-solid fa-xmark"></i></button></span>`;
            return `<div class="sp-sch-drawer-item${event.pin ? ' sp-sch-drawer-pinned' : ''}"><div class="sp-sch-drawer-head"><span class="sp-sch-drawer-badge"><i class="fa-solid ${meta.icon}"></i>${env.escapeHtml(meta.label)}</span><span class="sp-sch-drawer-title">${env.escapeHtml(event.title || '')}</span>${event.time ? `<span class="sp-sch-drawer-time"><i class="fa-regular fa-clock"></i> ${env.escapeHtml(event.time)}</span>` : ''}${event.pin ? '<i class="fa-solid fa-lock sp-sch-drawer-lock" title="已锁定"></i>' : ''}${actions}</div>${event.desc ? `<div class="sp-sch-drawer-desc">${env.escapeHtml(env.cleanText(event.desc))}</div>` : ''}${(event.location || event.npcAction) ? `<div class="sp-sch-drawer-meta">${event.location ? `<span class="sp-sch-drawer-loc"><i class="fa-solid fa-location-dot"></i>${env.escapeHtml(event.location)}</span>` : ''}${event.npcAction ? `<span class="sp-sch-drawer-npc"><i class="fa-solid fa-link"></i>${env.escapeHtml(event.npcAction)}</span>` : ''}</div>` : ''}</div>`;
        }).join('');
        return `${head}<div class="sp-sch-sday-list">${rows}</div>`;
    }
    function bindScheduleStripDelegation({ $, inlineTapContext }) {
        $(document).on('click.spschstrip', '.sp-schedule-inline .sp-sch-strip-live .sp-sch-scell', function (event) {
            event.preventDefault(); event.stopPropagation(); const wrap = this.closest('.sp-sch-strip-live'); if (!wrap) return; const day = wrap.querySelector('.sp-sch-sday'); if (!day) return;
            if (this.classList.contains('sp-sch-scell-open')) { this.classList.remove('sp-sch-scell-open'); day.hidden = true; day.innerHTML = ''; return; }
            wrap.querySelectorAll('.sp-sch-scell-open').forEach(cell => cell.classList.remove('sp-sch-scell-open')); this.classList.add('sp-sch-scell-open');
            const context = inlineTapContext(this); if (context.readOnly && !context.resolution?.resolved) { day.innerHTML = '<div class="sp-sch-sday-empty">历法未知 / 日期未知</div>'; day.hidden = false; return; }
            day.innerHTML = buildPointDetailFromContext({ dayKey: this.dataset.day, context, buildScheduleDay }); day.hidden = false;
        });
    }
    return { buildScheduleBlock, buildScheduleDay, bindScheduleStripDelegation };
}
import { weekdayContextForPoint } from '../axis/weekday-coordinator.js';
export function buildPointDetailFromContext({ dayKey, context, buildScheduleDay }) {
    return buildScheduleDay(dayKey, context?.snap ? (context.snap.point || '') : null, context?.readOnly, context?.resolvedCalendar, weekdayContextForPoint(context));
}
