// ─── 轴（axis）域 · 注入文本构造 ──────────────────────────────────────────────
// getAlmanacInjectText：给 buildMessages 反哺点/线/大纲的历文本（历自己不进主楼）。
// 纯函数——只依赖 data.js（历法/条目/标签工具）与 anchor.js（今天锚点/距今），无 index.js 内部依赖，
// 故直接 import、无需 env 注入。行为与原 index.js 逐字节一致。

import {
    loadAlmanac, loadCalDesc, almDayOfYear, almClampInt, calYearLen, almItemCoversDoy,
    almDateLabel, almTypeMeta, calMonthName,
} from './data.js';
import { almTodayAnchor, almDaysUntil } from './anchor.js';

// 供 buildMessages 反哺点/线/大纲的文本（历自己不进主楼）。空则返回 ''。
// 三段式：以「当前剧情日期」为锚 → 近期将至（未来 N 天内 + 进行中，带倒计时，给点/线明确抓手）→ 全年其他（背景）。
// 只有带「今天 + 还有几天」AI 才判得出哪个日子临近；旧版只按月日死序列全年、无锚点，故点/线对临近日子毫无反应。
export function getAlmanacInjectText() {
    const items = loadAlmanac();
    if (!items.length) return '';
    const cal      = loadCalDesc();
    const anchor   = almTodayAnchor();
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
