// 轴楼内只读渲染：当前/历史事项、历法与锚点均由组合层明确提供。
export function createAxisInlineRenderer(env = {}) {
    const buildAlmanacBlock = (itemsArg = null, anchorArg = null, calendarOverride = undefined) => {
        if (env.settings?.().almanacInlineEnabled === false) return null;
        const items = Array.isArray(itemsArg) ? itemsArg : env.loadItems?.() || [];
        if (!items.length) return null;
        const anchor = anchorArg && Number.isFinite(+anchorArg.month) && Number.isFinite(+anchorArg.day)
            ? { month: +anchorArg.month, day: +anchorArg.day } : env.today?.();
        const cal = calendarOverride === undefined ? env.calendar?.() : calendarOverride;
        if (!cal || !anchor || !Number.isFinite(+anchor.month) || !Number.isFinite(+anchor.day)) return null;
        const total = env.yearLength(cal);
        const baseDoy = env.dayOfYear(anchor.month, anchor.day, cal);
        const upcoming = items.map(it => ({ it, d: env.clamp(it.days, 1, total, 1) > 1 && env.itemCoversDoy(it, baseDoy, cal) ? -1 : env.daysUntil(it.month, it.day, anchor, cal) }))
            .sort((a, b) => a.d - b.d || a.it.month - b.it.month || a.it.day - b.it.day).slice(0, 5);
        const rows = upcoming.map(({ it, d }) => {
            const meta = env.typeMeta(it.type);
            const days = env.clamp(it.days, 1, total, 1);
            const end = env.endMonthDay(it, cal);
            const startText = env.formatDate({ month: it.month, day: it.day }, cal);
            const wrapsYear = days > 1 && env.dayOfYear(it.month, it.day, cal) + days - 1 > total;
            const date = days > 1 ? `${startText}—${env.formatDate(end, cal)}${wrapsYear ? '（跨年）' : ''}` : startText;
            const when = d === -1 ? '进行中' : d === 0 ? '今天' : `还有${d}天`;
            const displayDate = String(it.displayDate || '').trim();
            const detailDate = displayDate && displayDate !== date ? `<p class="sp-alm-event-displaydate">${env.escapeHtml(displayDate)}</p>` : '';
            return `<details class="sp-alm-event sp-alm-type-${meta.cls}" data-alm-id="${env.escapeHtml(it.id || '')}"><summary class="sp-alm-event-head"><span class="sp-alm-event-label"><span class="sp-alm-event-dot" aria-hidden="true"></span><span class="sp-alm-event-name">${env.escapeHtml(it.name)}</span></span><span class="sp-alm-event-meta"><span class="sp-alm-event-date">${env.escapeHtml(date)}</span><span class="sp-alm-event-when">${when}</span></span></summary><div class="sp-alm-event-detail"><div class="sp-alm-event-detail-meta"><span class="sp-alm-event-kind">${env.escapeHtml(meta.label)}</span>${days > 1 ? `<span class="sp-alm-event-span">共${days}天</span>` : ''}</div>${detailDate}${it.note ? `<p class="sp-alm-event-note">${env.escapeHtml(env.cleanText(it.note))}</p>` : ''}</div></details>`;
        }).join('');
        const summary = `<summary class="sp-inline-summary"><span class="sp-inline-title">轴</span><span class="sp-inline-count">${upcoming.length}件事</span></summary>`;
        return { summary, itemsHtml: `<div class="sp-alm-events">${rows}</div>` };
    };
    return { buildAlmanacBlock };
}
