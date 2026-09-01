// ─── 轴（axis）域 · 锚点 / 周几 / 距今 / 排序 ────────────────────────────────
// 从 index.js 机械搬移「今天是历上哪天、周几、距下一个日子还有几天、将至排序」这套
// 锚点解析核心。逐字节保持原行为。
//
// 依赖分两类：
//  ① 纯数据/历法层 —— 直接从姊妹叶子模块 import（无循环风险）：
//     data.js(历法/月日/条目工具/almDateFromChat 等)、cn-date.js、store.js、point/parse.js、
//     extensions.js(getContext)、memory.js。
//  ② index.js 内部跨域读取器 —— 经 bindAxisAnchor(env) 注入，模块绝不反向 import index.js
//     （沿用 point/render、ledger/select 的 env/bind 解耦模式，破除 axis→index.js 循环依赖）：
//        getDateAnchor, charStableKey, getLinesCacheKey, parseLines, TERMINAL_STAGES, getCacheKey
//  柏宝书 globalThis.STBaiBaiBook 为全局，直接读。

import { getContext } from '../../../../../extensions.js';
import { extractDayFromTime } from '../../utils/cn-date.js';
import { readStore } from '../../store.js';
import { parseCalendar } from '../point/parse.js';
import * as memory from '../../memory.js';
import {
    DEFAULT_CAL, loadCalDesc, calYearLen, almDayOfYear, almClampInt, almItemCoversDoy,
    almValidMonthDay, almDateFromChat,
} from './data.js';
import { storyWeekdayRef, latestStoryClock } from './story-clock.js';
import { automaticWeekdayCanReplaceCalibration } from './weekday-coordinator.js';
import { daysBetweenCalendarDates } from './full-ordinal.js';

let env = null;
// env: { getDateAnchor, charStableKey, getLinesCacheKey, parseLines, TERMINAL_STAGES, getCacheKey }
export function bindAxisAnchor(e) { env = e; }

// 从时间字符串里的 dayKey 派生月/日（依赖 extractDayFromTime + data.monthDayFromDayKey）。
// 注：monthDayFromDayKey/extractDayFromTime 已在上面 import，此处直接用。

// 今天 = 历上的 {month, day}。多源优先级见下方逐条注释。
// 内部证据解析保留 null，避免最终 UI 默认值 1/1 被星期浅兜底误当成真实故事日期。
function almTodayAnchorEvidence() {
    // ①′ 手动/自动确认锚点：最高优先。
    try {
        const pinned = env.getDateAnchor(env.charStableKey(getContext()));
        if (pinned) return pinned;
    } catch { /* 往下走 */ }
    // ① 柏宝书：权威游戏内时间
    try {
        const api = globalThis.STBaiBaiBook;
        if (api && typeof api.getSnapshot === 'function') {
            const msgs = getContext().chat || [];
            let last = -1;
            for (let i = 0; i < msgs.length; i++) if (!msgs[i].is_user) last = i;
            if (last >= 0) {
                const snap = api.getSnapshot({ floor: last, at: 'after' });
                const md = monthDayFromDayKey(extractDayFromTime(snap?.state?.time));
                if (md) return md;
            }
        }
    } catch { /* 往下走 */ }
    // ② 记忆库：摘要「时间锚点」尾段
    try {
        const memText = typeof memory.getMemoryContext === 'function' ? memory.getMemoryContext() : '';
        const anchors = [...String(memText).matchAll(/时间锚点\s*[:：]\s*([^\n]+)/g)];
        if (anchors.length) {
            const line = anchors[anchors.length - 1][1];
            const tail = line.split(/→|->/).pop();
            const md = monthDayFromDayKey(extractDayFromTime(tail)) || monthDayFromDayKey(extractDayFromTime(line));
            if (md) return md;
        }
    } catch { /* 往下走 */ }
    // ③ 点：日程 StartDate（自定义历法不读取现实日期）
    if (loadCalDesc() === DEFAULT_CAL) {
        try {
            const saved = readStore(env.getCacheKey());
            if (saved?.raw) {
                const { startDate } = parseCalendar(saved.raw, loadCalDesc());
                if (startDate instanceof Date && !isNaN(startDate)) {
                    const md = almValidMonthDay({ month: startDate.getMonth() + 1, day: startDate.getDate() });
                    if (md) return { ...md, year: startDate.getFullYear() };
                }
            }
        } catch { /* 往下走 */ }
    }
    // ⑤ 聊天正文里写明的绝对日期
    try {
        const hit = almDateFromChat();
        if (hit) return hit;
    } catch { /* 往下走 */ }
    return null;
}

// ⑥ 全拿不到 → 1 月 1 日（只保留既有 UI/日期消费者的最终默认行为）。
export function almTodayAnchor() { return almTodayAnchorEvidence() || { month: 1, day: 1 }; }

// 从锚点「今天」到下一次 (month, day) 还有几天（按年长环形，不涉年）。
export function almDaysUntil(month, day, anchor, cal = loadCalDesc()) {
    const total = calYearLen(cal);
    const a = anchor || almTodayAnchor();
    return (almDayOfYear(month, day, cal) - almDayOfYear(a.month, a.day, cal) + total) % total;
}

// 完整纪年 ordinal：一次性事项的 year 已知时禁止使用上面的环形月日差。
// 自定义历法每年长度由当前历法描述提供，月日序仍由 almDayOfYear 统一计算。
export function almDaysBetweenFull(from, to, cal = loadCalDesc()) {
    return daysBetweenCalendarDates(from, to, cal);
}

// 取「参照日→周几」锚：完整 SDC、人工校准与保守浅兜底统一在此排序；不做现实公历推算。
export function almWeekdayRef(cal = loadCalDesc()) {
    const automatic = storyWeekdayRef(getContext(), cal, 100, null, almTodayAnchorEvidence());
    const manual = env.getStoryCalibration?.();
    if (manual && automatic && !automaticWeekdayCanReplaceCalibration(automatic, manual)) {
        const refMonth = manual.refMonth ?? manual.month; const refDay = manual.refDay ?? manual.day;
        return { refDoy: almDayOfYear(refMonth, refDay, cal), refWd: manual.weekday, weekdayText: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][manual.weekday], floor: automatic.floor, source: 'manual' };
    }
    if (automatic) return automatic;
    if (!manual || !Number.isInteger(manual.weekday) || !Number.isInteger(manual.month) || !Number.isInteger(manual.day)) return null;
    const manualDoy = almDayOfYear(manual.refMonth ?? manual.month, manual.refDay ?? manual.day, cal);
    const currentClock = latestStoryClock(getContext(), 100);
    const currentMeta = currentClock?.endMeta?.valid ? currentClock.endMeta : (currentClock?.startMeta?.valid ? currentClock.startMeta : null);
    const currentDoy = currentMeta ? almDayOfYear(currentMeta.month, currentMeta.day, cal) : almDayOfYear(manual.month, manual.day, cal);
    const refWd = (manual.weekday + currentDoy - manualDoy + 7000) % 7;
    return Number.isInteger(currentDoy) && Number.isInteger(manualDoy) ? { refDoy: currentDoy, refWd, weekdayText: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][refWd], source: 'manual' } : null;
}

// 某月日的周几（0..6），纯日序偏移，不涉年。ref 可复用（较重，整轮渲染算一次传进来）。
export function almWeekdayFor(month, day, ref, cal = loadCalDesc()) {
    const r = ref || almWeekdayRef(cal);
    if (!r || !Number.isInteger(r.refWd) || !Number.isInteger(r.refDoy)) return null;
    return ((r.refWd + almDayOfYear(month, day, cal) - r.refDoy) % 7 + 7) % 7;
}

// 将至排序：进行中的多日节假日(d=-1)最前，其余按距今升序、月日次之。整轮只算一次锚点复用。
export function sortAlmanacUpcoming(items, cal = loadCalDesc()) {
    const anchor = almTodayAnchor();
    const todayDoy = almDayOfYear(anchor.month, anchor.day, cal);
    return items
        .map(it => {
            const active = almClampInt(it.days, 1, calYearLen(cal), 1) > 1 && almItemCoversDoy(it, todayDoy, cal);
            return { it, d: active ? -1 : almDaysUntil(it.month, it.day, anchor, cal) };
        })
        .sort((a, b) => a.d - b.d || a.it.month - b.it.month || a.it.day - b.it.day)
        .map(x => x.it);
}
