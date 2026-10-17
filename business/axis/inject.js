// ─── 轴（axis）域 · 注入文本构造 ──────────────────────────────────────────────
// getAlmanacInjectText：给 buildMessages 反哺点/线/大纲的历文本（历自己不进主楼）。
// 读取轴域已有数据生成上下文；不依赖 index.js 内部接口。

import {
    loadAlmanac, loadCalDesc, almDayOfYear, almClampInt, calYearLen, almItemCoversDoy,
    almDateLabel, almTypeMeta, calMonthName,
} from './data.js';
import { almTodayAnchor, almDaysUntil } from './anchor.js';

// 供 buildMessages 反哺点/线/大纲的文本（历自己不进主楼）。空则返回 ''。
// 规划消息可传入本轮已读出的正文日期，让历日期与倒计时共用该锚；无参调用沿用原锚点。
// 三段式：以「当前剧情日期」为锚 → 近期将至（未来 N 天内 + 进行中，带倒计时，给点/线明确抓手）→ 全年其他（背景）。
// 同时提供“今天”和倒计时，保证消费者能区分临近日期与全年背景。
export function getAlmanacInjectText(storyDate = null) {
    const items = loadAlmanac();
    if (!items.length) return '';
    const cal      = loadCalDesc();
    const anchor   = storyDate || almTodayAnchor();
    const todayDoy = almDayOfYear(anchor.month, anchor.day, cal);
    const NEAR_DAYS = 7;   // 「近期」窗口：未来 7 天内算临近（与楼内七天条同尺度）
    // 逐条算「距今几天」；多日节日今天正落区间内记「进行中」(d=-1) 置顶。与 sortAlmanacUpcoming 同口径。
    const scored = items.map(it => {
        const active = almClampInt(it.days, 1, calYearLen(cal), 1) > 1 && almItemCoversDoy(it, todayDoy, cal);
        return { it, d: active ? -1 : almDaysUntil(it.month, it.day, anchor, cal) };
    });
    const near = scored.filter(x => x.d === -1 || x.d <= NEAR_DAYS)
                       .sort((a, b) => a.d - b.d || a.it.month - b.it.month || a.it.day - b.it.day);
    const rest = scored.filter(x => x.d !== -1 && x.d > NEAR_DAYS)
                       .sort((a, b) => a.it.month - b.it.month || a.it.day - b.it.day);
    const durOf    = it => almClampInt(it.days, 1, calYearLen(cal), 1);
    const fmtItem  = it => { const d = durOf(it); return `${almDateLabel(it, cal)}　${it.name}（${almTypeMeta(it.type).label}${d > 1 ? '·持续 ' + d + ' 天' : ''}）${it.note ? '：' + it.note : ''}`; };
    const nearWhen = x => x.d === -1 ? '进行中' : x.d === 0 ? '就是今天' : `还有 ${x.d} 天`;
    const out = [`【当前剧情日期】${calMonthName(cal, anchor.month)}${anchor.day}日`];
    if (near.length) {
        out.push('【近期将至】\n' + near.map(x => `- ${nearWhen(x)}：${fmtItem(x.it)}`).join('\n'));
    }
    if (rest.length) {
        out.push('【全年其他重要日子】\n' + rest.map(x => `- ${fmtItem(x.it)}`).join('\n'));
    }
    return out.join('\n');
}
