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
    almValidMonthDay, almDateFromChat, monthDayFromDayKey, calExplicitWeekdayRef, calRealWeekdayRef, parseWeekdayToken,
} from './data.js';

let env = null;
// env: { getDateAnchor, charStableKey, getLinesCacheKey, parseLines, TERMINAL_STAGES, getCacheKey }
export function bindAxisAnchor(e) { env = e; }

// 从时间字符串里的 dayKey 派生月/日（依赖 extractDayFromTime + data.monthDayFromDayKey）。
// 注：monthDayFromDayKey/extractDayFromTime 已在上面 import，此处直接用。

// 今天 = 历上的 {month, day}。多源优先级见下方逐条注释。全拿不到 → 1 月 1 日。
export function almTodayAnchor() {
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
    // ③ 线：活跃线 when/desc/next 里的绝对日期
    try {
        const saved = readStore(env.getLinesCacheKey());
        const lines = saved?.raw ? env.parseLines(saved.raw) : [];
        for (const l of lines) {
            if (!l.name || env.TERMINAL_STAGES.has(l.stage)) continue;
            const md = monthDayFromDayKey(extractDayFromTime(l.when))
                    || monthDayFromDayKey(extractDayFromTime(`${l.desc || ''} ${l.next || ''}`));
            if (md) return md;
        }
    } catch { /* 往下走 */ }
    // ④ 点：日程 StartDate（自定义历法不读取现实日期）
    if (loadCalDesc() === DEFAULT_CAL) {
        try {
            const saved = readStore(env.getCacheKey());
            if (saved?.raw) {
                const { startDate } = parseCalendar(saved.raw);
                if (startDate instanceof Date && !isNaN(startDate)) {
                    const md = almValidMonthDay({ month: startDate.getMonth() + 1, day: startDate.getDate() });
                    if (md) return md;
                }
            }
        } catch { /* 往下走 */ }
    }
    // ⑤ 聊天正文里写明的绝对日期
    try {
        const hit = almDateFromChat();
        if (hit) return { month: hit.month, day: hit.day };
    } catch { /* 往下走 */ }
    // ⑥ 全拿不到 → 1 月 1 日
    return { month: 1, day: 1 };
}

// 从锚点「今天」到下一次 (month, day) 还有几天（按年长环形，不涉年）。
export function almDaysUntil(month, day, anchor, cal = loadCalDesc()) {
    const total = calYearLen(cal);
    const a = anchor || almTodayAnchor();
    return (almDayOfYear(month, day, cal) - almDayOfYear(a.month, a.day, cal) + total) % total;
}

// 取「参照日→周几」锚：先扫所有来源的显式星期，再允许真实公历推算。返回 {refDoy, refWd}。
export function almWeekdayRef(cal = loadCalDesc()) {
    // 第一阶段：当前聊天/状态栏中的显式星期最高，不能被其它来源或 getDay 抢先。
    try {
        const hit = almDateFromChat(true);
        if (hit?.wd != null) return { refDoy: almDayOfYear(hit.month, hit.day, cal), refWd: hit.wd };
    } catch { /* 往下走 */ }
    // 其次是柏宝书与记忆中的显式星期。
    try {
        const api = globalThis.STBaiBaiBook;
        if (api && typeof api.getSnapshot === 'function') {
            const msgs = getContext().chat || [];
            let last = -1;
            for (let i = 0; i < msgs.length; i++) if (!msgs[i].is_user) last = i;
            if (last >= 0) {
                const time = api.getSnapshot({ floor: last, at: 'after' })?.state?.time;
                const explicit = calExplicitWeekdayRef(time, cal);
                if (explicit) return explicit;
                const wd = parseWeekdayToken(time);
                if (wd != null) { const a = almTodayAnchor(); return { refDoy: almDayOfYear(a.month, a.day, cal), refWd: wd }; }
            }
        }
    } catch { /* 往下走 */ }
    // ② 记忆库「时间锚点」尾段
    try {
        const memText = typeof memory.getMemoryContext === 'function' ? memory.getMemoryContext() : '';
        const anchors = [...String(memText).matchAll(/时间锚点\s*[:：]\s*([^\n]+)/g)];
        if (anchors.length) {
            const line = anchors[anchors.length - 1][1];
            const explicit = calExplicitWeekdayRef(line, cal);
            if (explicit) return explicit;
            const wd = parseWeekdayToken(line.split(/→|->/).pop()) ?? parseWeekdayToken(line);
            if (wd != null) { const a = almTodayAnchor(); return { refDoy: almDayOfYear(a.month, a.day, cal), refWd: wd }; }
        }
    } catch { /* 往下走 */ }
    // 第二阶段：没有显式星期后，才允许按现有来源计算真实公历周几。
    // ① 柏宝书快照 time：无显式 token 时按真实年计算
    try {
        const api = globalThis.STBaiBaiBook;
        if (api && typeof api.getSnapshot === 'function') {
            const msgs = getContext().chat || [];
            let last = -1;
            for (let i = 0; i < msgs.length; i++) if (!msgs[i].is_user) last = i;
            if (last >= 0) {
                const real = calRealWeekdayRef(api.getSnapshot({ floor: last, at: 'after' })?.state?.time, cal);
                if (real) return real;
            }
        }
    } catch { /* 往下走 */ }
    // ② 记忆库时间锚点：无显式 token 时按真实年计算
    try {
        const memText = typeof memory.getMemoryContext === 'function' ? memory.getMemoryContext() : '';
        const anchors = [...String(memText).matchAll(/时间锚点\s*[:：]\s*([^\n]+)/g)];
        if (anchors.length) {
            const line = anchors[anchors.length - 1][1];
            const real = calRealWeekdayRef(line, cal);
            if (real) return real;
        }
    } catch { /* 往下走 */ }
    // ③ 聊天正文（含状态栏）→ 无显式星期时按真实年 getDay()
    if (cal === DEFAULT_CAL) {
        try {
            const hit = almDateFromChat();
            if (hit) {
                let refWd = null;
                if (hit.date instanceof Date && !isNaN(hit.date)) refWd = hit.date.getDay();
                if (refWd != null) return { refDoy: almDayOfYear(hit.month, hit.day, cal), refWd };
            }
        } catch { /* 往下走 */ }
    }
    // ④ 点 StartDate：最后的真实年份来源
    if (cal === DEFAULT_CAL) {
        try {
            const saved = readStore(env.getCacheKey());
            if (saved?.raw) {
                const { startDate } = parseCalendar(saved.raw);
                if (startDate instanceof Date && !isNaN(startDate)) {
                    return { refDoy: almDayOfYear(startDate.getMonth() + 1, startDate.getDate(), cal), refWd: startDate.getDay() };
                }
            }
        } catch { /* 往下走 */ }
    }
    // ⑤ 默认：1 月 1 日 = 周一
    return { refDoy: 1, refWd: 1 };
}

// 某月日的周几（0..6），纯日序偏移，不涉年。ref 可复用（较重，整轮渲染算一次传进来）。
export function almWeekdayFor(month, day, ref, cal = loadCalDesc()) {
    const r = ref || almWeekdayRef(cal);
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
