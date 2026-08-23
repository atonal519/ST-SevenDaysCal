// 轴楼内只读渲染：不读取宿主 DOM/store，所有当前/历史数据与历法均由宿主注入。
export function createAxisInlineRenderer(env = {}) {
    const buildAlmanacBlock = (itemsArg = null, anchorArg = null, calendarOverride = undefined, weekdayRefOverride = undefined) => {
        if (env.settings?.().almanacInlineEnabled === false) return null;
        const items = Array.isArray(itemsArg) ? itemsArg : env.loadItems?.() || [];
        if (!items.length) return null;
        const anchor = anchorArg && Number.isFinite(+anchorArg.month) && Number.isFinite(+anchorArg.day)
            ? { month: +anchorArg.month, day: +anchorArg.day } : env.today?.();
        const cal = calendarOverride === undefined ? env.calendar?.() : calendarOverride;
        if (!cal || !anchor || !Number.isFinite(+anchor.month) || !Number.isFinite(+anchor.day)) return null;
        const ref = weekdayRefOverride !== undefined ? weekdayRefOverride : env.weekdayRef?.(cal);
        const baseDoy = env.dayOfYear(anchor.month, anchor.day, cal);
        const baseWd = env.weekdayFor(anchor.month, anchor.day, ref, cal);
        const total = env.yearLength(cal);
        let hasAny = false;
        const coveredItems = new Set();
        const cells = Array.from({ length: 6 }, (_, k) => {
            const i = k + 1, doy = ((baseDoy - 1 + i) % total) + 1, md = env.monthDayFromDoy(doy, cal);
            const wd = baseWd == null ? '星期未记录' : env.weekdays[(baseWd + i) % 7];
            const cover = items.filter(it => env.itemCoversDoy(it, doy, cal)); const has = cover.length > 0;
            if (has) { hasAny = true; cover.forEach(it => coveredItems.add(it)); }
            const cls = ['sp-alm-scell']; if (has) cls.push('sp-alm-scell-has');
            const dot = has ? `<span class="sp-alm-dot sp-alm-type-${env.typeMeta(cover[0].type).cls}"></span>` : '';
            return `<div class="${cls.join(' ')}" data-doy="${doy}"><span class="sp-alm-scell-wd">${wd}</span><span class="sp-alm-scell-md">${md.month}/${md.day}</span>${dot}</div>`;
        }).join('');
        const summary = `<summary class="sp-inline-summary"><span class="sp-inline-title">轴</span><span class="sp-inline-count">${coveredItems.size}个日程</span></summary>`;
        const upcoming = items.map(it => ({ it, d: env.clamp(it.days, 1, env.yearLength(cal), 1) > 1 && env.itemCoversDoy(it, baseDoy, cal) ? -1 : env.daysUntil(it.month, it.day, anchor, cal) }))
            .sort((a, b) => a.d - b.d || a.it.month - b.it.month || a.it.day - b.it.day).slice(0, 3);
        const upHtml = upcoming.map(({ it, d }) => { const meta = env.typeMeta(it.type); const label = d === -1 ? '进行中' : d === 0 ? '今天' : `还有${d}天`; return `<div class="sp-alm-up-row"><span class="sp-alm-up-dot sp-alm-type-${meta.cls}"></span><span class="sp-alm-up-name">${env.escapeHtml(it.name)}</span><span class="sp-alm-up-when${d <= 0 ? ' sp-alm-up-soon' : ''}">${label}</span></div>`; }).join('');
        const strip = `<div class="sp-alm-strip">${cells}</div>`;
        const stripHtml = hasAny ? `<div class="sp-alm-strip-wrap sp-alm-strip-live">${strip}<div class="sp-alm-sday" hidden></div></div>` : `<div class="sp-alm-strip-wrap sp-alm-strip-flat">${strip}</div>`;
        return { summary, upHtml: upHtml ? `<div class="sp-alm-up">${upHtml}</div>` : '', stripHtml };
    };
    const buildAlmanacDay = (doy, itemsArg = null, calendarOverride = undefined, weekdayRefOverride = undefined) => {
        const cal = calendarOverride === undefined ? env.calendar?.() : calendarOverride;
        const ref = weekdayRefOverride !== undefined ? weekdayRefOverride : env.weekdayRef?.(cal);
        if (!cal) return '<div class="sp-alm-sday-empty">历法未知 / 日期未知</div>';
        const md = env.monthDayFromDoy(doy, cal);
        if (!md) return '<div class="sp-alm-sday-empty">历法未知 / 日期未知</div>';
        const wdIndex = env.weekdayFor(md.month, md.day, ref, cal);
        const wd = wdIndex == null ? '星期未记录' : env.weekdays[wdIndex];
        const head = `<div class="sp-alm-sday-head">${env.monthName(cal, md.month)}${md.day}日 · ${wd}</div>`;
        const src = Array.isArray(itemsArg) ? itemsArg : env.loadItems?.() || [];
        const day = src.filter(it => env.itemCoversDoy(it, doy, cal)).sort((a, b) => a.month - b.month || a.day - b.day);
        if (!day.length) return `${head}<div class="sp-alm-sday-empty">这天没有安排</div>`;
        const rows = day.map(it => { const meta = env.typeMeta(it.type); const days = env.clamp(it.days, 1, env.yearLength(cal), 1); const span = days > 1 ? `<span class="sp-alm-drawer-span">共${days}天</span>` : ''; return `<div class="sp-alm-drawer-item"><i class="fa-solid ${meta.icon} sp-alm-drawer-icon sp-alm-type-${meta.cls}"></i><span class="sp-alm-drawer-name">${env.escapeHtml(it.name)}</span><span class="sp-alm-drawer-type">${meta.label}</span>${span}${it.note ? `<span class="sp-alm-drawer-note">${env.escapeHtml(env.cleanText(it.note))}</span>` : ''}</div>`; }).join('');
        return `${head}<div class="sp-alm-sday-list">${rows}</div>`;
    };
    return { buildAlmanacBlock, buildAlmanacDay };
}
