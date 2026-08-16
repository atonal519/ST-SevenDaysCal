// ─── 台账（ledger）域 · 检索前置选择器 ────────────────────────────────────────
// 从 index.js 机械搬移「注入前挑哪几条」的纯逻辑三件套：
//   scoreLedgerEntry（打分器·RAG 可换点）/ isLedgerSalient（相关度布尔闸）/
//   selectLedgerForInject（选注入集）。
// 三者本身是纯函数（只依赖入参 + 彼此），唯一外部依赖是到期/距今口径
//   ledgerDaysSince / ledgerDueInfo —— 这两个函数仍滞留 index.js（它们另经
// almTodayAnchor/almDaysUntil 触达历法，且在 5 处非选择器场景另有调用），故不搬，
// 改用 bindLedgerSelect(env) 注入，避免把历法依赖拖进本模块、也避免反向 import
// index.js 造成循环依赖。行为与原 index.js 逐字节一致。

let env = null;
// env: { ledgerDaysSince(entry)->number|null, ledgerDueInfo(entry)->{天数,过期}|null }
export function bindLedgerSelect(e) { env = e; }

// 单条打分（RAG 可换钩子·整体可替换）：基础权重 + 场景加权。分越高越该注入。
//   基础：用户锁（用户在意）> 临近/过期到期 > 近期登记 > 持续状态活跃底分。
//   场景：牵扯∪标签 任一命中最近正文 → 显著加分（正文正谈到 → 此刻最相关）。
export function scoreLedgerEntry(entry, sceneText, _today) {
    let score = 1;                                   // 活跃即有底分
    if (entry.锁 === '用户锁') score += 6;           // 用户手动在意的，优先带上
    const du = env.ledgerDueInfo(entry);
    if (du) {
        if (du.过期) score += 8;                     // 已过期没兑现，最该提醒
        else if (du.天数 <= 1) score += 7;           // 今天/明天到期
        else if (du.天数 <= 3) score += 4;
        else if (du.天数 <= 7) score += 2;
    }
    const since = env.ledgerDaysSince(entry);
    if (since != null) {
        if (since <= 2) score += 3;                  // 刚登记，热
        else if (since <= 7) score += 1;
    }
    if (entry.类型 === '周期') score += 1;           // 周期事项易被忽略，略抬
    if (sceneText) {
        const keys = [...(entry.牵扯 || []), ...(entry.标签 || [])].filter(Boolean);
        if (keys.some(k => sceneText.includes(k))) score += 6;   // 正文正谈到 → 场景命中
    }
    return score;
}

// 相关度门槛：此刻是否「确有理由被想起」。任一命中即可注入；全不中＝当下静默条，这轮不埋（仍活跃、仍在池里）。
// 与 scoreLedgerEntry 分工：这里是「注不注入」的布尔闸；score 只在相关条超上限时用来排序取前 N。
// 判据：① 用户锁（手动在意·等于「始终纳入」）② 正文点到名（牵扯/标签命中近景）③ 有临近/过期死线（≤7 天或已过）④ 刚登记（≤2 天还热）。
export function isLedgerSalient(entry, sceneText) {
    if (entry.锁 === '用户锁') return true;                       // 用户手动锁的 → 一定带（想常驻注入就锁它）
    if (sceneText) {
        const keys = [...(entry.牵扯 || []), ...(entry.标签 || [])].filter(Boolean);
        if (keys.some(k => sceneText.includes(k))) return true;   // 正文正谈到 → 此刻最相关
    }
    const du = env.ledgerDueInfo(entry);
    if (du && (du.过期 || du.天数 <= 7)) return true;             // 临近/过期死线 → 该惦记
    const since = env.ledgerDaysSince(entry);
    if (since != null && since >= 0 && since <= 2) return true;   // 刚登记还热
    return false;
}

// 选注入集：先过相关度门槛（isLedgerSalient）→ 只留「此刻确有理由被提起」的条，绝不为凑数硬塞。
// 相关条 ≤ limit 全带（有几条埋几条·凑不满就不凑）；超 limit 才按 score 降序截前 limit（取最相关的）。空进空出。
// 静音（暂停埋入）条一律排除：不进注入集 → 连带不进召回（_ledgerInjectEcho 从 picked 派生）。仍是活跃、仍显示在标注池。
// 【为何要门槛】楼越高活跃越多，旧「无门槛凑满 limit」会把不相干的静默条硬顶进来充数，且静音一条即被第 N+1 名补位——门槛正治这个。
// RAG 口子：将来换外部检索，替换排序来源即可（打分器 scoreLedgerEntry / 门槛 isLedgerSalient 单点可换）。
export function selectLedgerForInject(entries, sceneText, today, limit = 8) {
    const active  = (entries || []).filter(e => e && e.状态 !== '已了结' && e.静音 !== true);
    const salient = active.filter(e => isLedgerSalient(e, sceneText));
    if (salient.length <= limit) return salient;
    return salient
        .map(e => ({ e, s: scoreLedgerEntry(e, sceneText, today) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(x => x.e);
}
