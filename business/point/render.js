// ─── 点（日程）域 · 渲染层 ────────────────────────────────────────────────────
// 从 index.js 机械搬移 renderSchedule / renderEvent / scheduleDayCtx / scheduleDayLabel，
// 以及 TYPE_META / SP_JUMP_HINT_POINT 两个常量。仍滞留在 index.js 的轴域函数
// almTodayAnchor / almWeekdayRef / almWeekdayFor 与共享 makeInjectBtn 通过 bindPointRender(env)
// 注入，避免反向 import index.js 造成循环依赖（其余依赖——store / axisState / 历法数据 /
// escape / weatherChipHtml——均为已拆模块，直接 import）。
import { parseCalendar, buildPointInjectText } from './parse.js';
import { axisState } from '../axis/state.js';
import { ALM_WEEKDAYS, almDayOfYear, almMonthDayFromDoy, loadCalDesc, DEFAULT_CAL } from '../axis/data.js';
import { escapeHtml, escapeAttr } from '../../utils/dom.js';
import { weatherChipHtml } from '../../utils/format.js';
import * as store from '../../store.js';

let env = null;
export function bindPointRender(e) { env = e; }

// 点类型元数据（icon 只用 FA 免费版实心/半透明图标；label 中文；cls 对应样式）
export const TYPE_META = {
    main  : { icon: 'fa-bolt',      label: '明线', cls: 'sp-type-world'     },
    hidden: { icon: 'fa-eye-slash', label: '暗线', cls: 'sp-type-major'     },
    bond  : { icon: 'fa-heart',     label: '红线', cls: 'sp-type-character' },
};

export const SP_JUMP_HINT_POINT = `<div class="sp-jump-hint">想调整这些点？<button type="button" class="sp-jump-link">和「间」聊聊 →</button></div>`;

// 点条第 0..n-1 天的日期上下文（供点面板/楼内点条取 月/日/周几 用，与「历」同锚同源）
export function scheduleDayCtx() {
    const cal = loadCalDesc();
    const ref = env.almWeekdayRef(cal);   // 点周几改走年-free 锚（与历同源）；default 分支也要 ref
    if (cal === DEFAULT_CAL) return { cal, ref };
    const anchor = env.almTodayAnchor();
    return { cal, ref, anchorDoy: almDayOfYear(anchor.month, anchor.day, cal) };
}
// 点条第 i 天 → {month, day, wd(0..6,周日索引)}。公历分支与旧 `new Date(startDate)+i` 逐字节等价；
// 自定义历法从共享今天锚点 seed、逐日在本历法内步进，令点条与历/今头同源同锚。
export function scheduleDayLabel(i, startDate, ctx) {
    if (ctx.cal === DEFAULT_CAL) {
        // 月/日仍按公历步进（跨月/闰日正确）；但周几改用年-free 锚 almWeekdayFor，不用 startDate.getDay()——
        // startDate 的年份是 forceStartDate 钉的 POINT_ANCHOR_YEAR（固定闰年、纯为拿月日），其 getDay() 是假年
        // 周几，会和用户设定的现实周几错位（bug：2021/8/20 周五显示成 2024 的周二）。历也走同一锚，两者一致。
        const d = new Date(startDate); d.setDate(d.getDate() + i);
        const month = d.getMonth() + 1, day = d.getDate();
        return { month, day, wd: env.almWeekdayFor(month, day, ctx.ref, ctx.cal) };
    }
    const { month, day } = almMonthDayFromDoy(ctx.anchorDoy + i, ctx.cal);
    return { month, day, wd: env.almWeekdayFor(month, day, ctx.ref, ctx.cal) };
}

function renderEvent(ev, dayKey = null, evIdx = null, weather = '', temp = '', dateLabel = '') {
    const meta = TYPE_META[ev.type] || TYPE_META.main;
    const injectBtn = env.makeInjectBtn(buildPointInjectText(ev, weather, temp, dateLabel));
    // F5 锁点：仅面板内渲染（有定位 dayKey）且事件有标题时给锁钮；注入卡/无定位场景不显示
    const pinBtn = (dayKey !== null && ev.title && ev.title.trim())
        ? `<button class="sp-point-pin-toggle" data-day="${escapeAttr(String(dayKey))}" data-ev="${evIdx}" title="${ev.pin ? '解锁' : '锁定'}"><i class="fa-solid fa-${ev.pin ? 'lock' : 'lock-open'}"></i></button>`
        : '';
    // 删除钮：仅面板内渲染（有定位 dayKey）才给；注入卡/无定位场景不显示。走 .sp-sch-del-one，
    // 与楼内块抽屉同类、共用 handler（#sp-body/#chat 委托）与 triggerDeletePointEvent（同刷主面板+楼内块）。
    const delBtn = (dayKey !== null)
        ? `<button class="sp-sch-del-one" data-day="${escapeAttr(String(dayKey))}" data-ev="${evIdx}" title="删除这个点"><i class="fa-solid fa-xmark"></i></button>`
        : '';
    return `<div class="sp-event ${meta.cls}${ev.pin ? ' sp-event-pinned' : ''}">
        <div class="sp-event-head">
            <span class="sp-type-badge"><i class="fa-solid ${meta.icon}"></i>${escapeHtml(meta.label)}</span>
            ${ev.time ? `<span class="sp-event-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(ev.time)}</span>` : ''}
            ${injectBtn}${pinBtn}${delBtn}
        </div>
        <div class="sp-event-title">${escapeHtml(ev.title)}</div>
        ${ev.desc ? `<p class="sp-event-desc">${escapeHtml(ev.desc)}</p>` : ''}
        <div class="sp-event-meta">
            ${ev.location  ? `<span class="sp-event-loc"><i class="fa-solid fa-location-dot"></i>${escapeHtml(ev.location)}</span>` : ''}
            ${ev.npcAction ? `<span class="sp-event-npc"><i class="fa-solid fa-link"></i>${escapeHtml(ev.npcAction)}</span>` : ''}
        </div>
    </div>`;
}

export function renderSchedule(raw, userName, perspective = 'user') {
    const { days, future, startDate } = parseCalendar(raw);
    const hasFuture = future && future.events.length > 0;

    const totalTabs = days.length + (hasFuture ? 1 : 0);
    const chipCls   = perspective === 'char' ? 'sp-char-chip' : 'sp-user-chip';

    // 历「同步到点」在飞时，点刷新圆圈置灰禁点（同步会后台重写点，此刻手动刷新会跟它抢 store）
    const refreshBusy = axisState._almSyncingPoint ? ' sp-refresh-busy' : '';
    // char 视角头部多一个 📌：把当前 char 固定/取消固定到 TA▾ 抽屉（查看与固定解耦，此为唯一固定动作）。
    const isPinned = perspective === 'char' && store.isPinnedChar(String(userName || '').trim());
    // 固定态只用**颜色**区分，图标恒 fa-solid fa-thumbtack：FA 免费版无 fa-regular fa-thumbtack，
    // 用 regular 会静默回落到 solid → 固定/未固定长得一模一样（老 bug「图标没变化」）。照 .sp-alm-today-pin 套路。
    const pinBtn = perspective === 'char'
        ? `<button class="sp-panel-refresh sp-point-pin-char${isPinned ? ' sp-pinned' : ''}" data-name="${escapeAttr(String(userName || '').trim())}" title="${isPinned ? '已固定·点击取消固定' : '固定 TA 到 TA▾ 抽屉'}"><i class="fa-solid fa-thumbtack"></i></button>`
        : '';
    const header = `<div class="sp-schedule-header">
        <span class="${chipCls}">${escapeHtml(userName)}</span>
        <span class="sp-schedule-label">的点</span>
        ${pinBtn}
        <button class="sp-panel-refresh sp-refresh-schedule${refreshBusy}" title="${axisState._almSyncingPoint ? '点正在同步中，稍候…' : '重新生成点'}"><i class="fa-solid fa-rotate-right"></i></button>
    </div>` + SP_JUMP_HINT_POINT;

    // Parse failed (AI leaked prompt / malformed output) — still render header
    // so the user has a refresh button to reroll. Otherwise they get stuck
    // staring at raw garbage with no way to try again.
    if (days.length === 0 && !hasFuture) {
        return header + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    }

    const ctx = scheduleDayCtx();
    const tabs = days.map((_, i) => {
        let numLabel = String(i + 1);
        let wdLabel = '';
        if (startDate) {
            const { month, day, wd } = scheduleDayLabel(i, startDate, ctx);
            wdLabel  = ALM_WEEKDAYS[wd];
            numLabel = `${month}/${day}`;
        }
        return `<button class="sp-tab${i === 0 ? ' sp-tab-active' : ''}" data-day="${i}">
            <span class="sp-tab-num">${numLabel}</span>
            ${wdLabel ? `<span class="sp-tab-wd">${wdLabel}</span>` : ''}
        </button>`;
    });
    if (hasFuture) tabs.push(`<button class="sp-tab${days.length === 0 ? ' sp-tab-active' : ''}" data-day="future">
        <span class="sp-tab-num">未来</span>
    </button>`);

    const panels = days.map((day, di) => {
        let dateLabel = `第${di + 1}天`;
        if (startDate) {
            const { month, day: dd, wd } = scheduleDayLabel(di, startDate, ctx);
            dateLabel = `${month}月${dd}日 · ${ALM_WEEKDAYS[wd]}`;
        }
        return `<div class="sp-day-panel" style="width:calc(100%/${totalTabs})">${weatherChipHtml(day.weather, day.temp)}${day.events.map((ev, ei) => renderEvent(ev, di, ei, day.weather, day.temp, dateLabel)).join('')}</div>`;
    });
    if (hasFuture) panels.push(
        `<div class="sp-day-panel sp-future-panel" style="width:calc(100%/${totalTabs})">${future.events.map((ev, ei) => renderEvent(ev, 'future', ei, '', '', '未来')).join('')}</div>`
    );

    const debug = days.length < 3 ? `
        <details class="sp-debug"><summary>⚠ 仅解析到 ${days.length} 天</summary>
        <pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>` : '';

    return `${header}<div class="sp-tab-bar" data-total="${totalTabs}">${tabs.join('')}</div>
        <div class="sp-days-wrap"><div class="sp-days-track" data-total="${totalTabs}" style="width:${totalTabs * 100}%">${panels.join('')}</div></div>${debug}`;
}
