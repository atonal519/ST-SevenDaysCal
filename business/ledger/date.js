// 刻度日期纯逻辑：当前日期由刻度截止范围提供，不读取宿主状态。
let deps = { today: () => null, daysUntil: () => null, daysUntilFull: null, listEntries: () => [] };
const hasYear = value => value != null && value !== '' && Number.isFinite(Number(value));

export function bindLedgerDate(next = {}) {
    deps = { ...deps, ...next };
}

export function ledgerEntryWithinCutoff(entry, maxFloor = Infinity) {
    if (maxFloor === undefined || maxFloor === Infinity) return true;
    if (!Number.isInteger(maxFloor)) return false;
    return [entry?.起始锚, entry?.现状锚].every(anchor => {
        const floor = anchor?.楼层;
        return floor == null || String(floor).trim() === '' || !Number.isInteger(Number(floor)) || Number(floor) <= maxFloor;
    });
}

export function ledgerDaysSince(entry, today = deps.today(), maxFloor = deps.floor?.()) {
    if (!today || !ledgerEntryWithinCutoff(entry, maxFloor)) return null;
    const a = entry?.起始锚?.历日期;
    if (!a || !Number.isFinite(+a.month) || !Number.isFinite(+a.day)) return null;
    return deps.daysUntil(today.month, today.day, a);
}

export function ledgerDueInfo(entry, today = deps.today(), maxFloor = deps.floor?.()) {
    if (!today || !ledgerEntryWithinCutoff(entry, maxFloor)) return null;
    const d = entry?.到期锚?.历日期;
    if (!d || !Number.isFinite(+d.month) || !Number.isFinite(+d.day)) return null;
    // 一次性事项没有年份/周期时无法判断它属于哪一轮，保持 unknown，禁止猜未来或过期；
    // 周期事项则按历法差值计算下一次正向发生日。
    if (entry?.类型 !== '周期' && entry?.周期长度 == null && (!hasYear(d.year) || !hasYear(today?.year))) return null;
    if (entry?.类型 !== '周期' && hasYear(d.year) && hasYear(today?.year)) {
        if (typeof deps.daysUntilFull !== 'function') return null;
        const delta = deps.daysUntilFull(today, d);
        if (!Number.isFinite(delta)) return null;
        return delta === 0 ? { 天数: 0, 过期: false } : (delta > 0 ? { 天数: delta, 过期: false } : { 天数: Math.abs(delta), 过期: true });
    }
    const to = deps.daysUntil(d.month, d.day, today);
    const since = deps.daysUntil(today.month, today.day, d);
    if (to === 0) return { 天数: 0, 过期: false };
    return to <= since ? { 天数: to, 过期: false } : { 天数: since, 过期: true };
}

export function listJudgeableLedger({ includePending = false } = {}) {
    return deps.listEntries().filter(entry => entry.锁 !== '用户锁'
        && (includePending || entry.来源状态 !== '待确认')
        && entry.来源状态 !== '来源已删除');
}

export function fmtLedgerForJudge(entry, today = deps.today(), maxFloor = deps.floor?.()) {
    const since = ledgerDaysSince(entry, today, maxFloor);
    const sinceText = !ledgerEntryWithinCutoff(entry, maxFloor) ? '登记时点尚未纳入当前范围' : since == null ? '起始不明' : (since === 0 ? '今天登记' : `距登记 ${since} 天`);
    const due = ledgerDueInfo(entry, today, maxFloor);
    const dueAnchor = entry?.到期锚?.历日期;
    const unresolvedDueDate = !due && dueAnchor && Number.isFinite(+dueAnchor.month) && Number.isFinite(+dueAnchor.day)
        && entry?.类型 !== '周期' && entry?.周期长度 == null
        && (!hasYear(dueAnchor.year) || !hasYear(today?.year));
    const dueDateText = unresolvedDueDate
        ? `${hasYear(dueAnchor.year) ? `${dueAnchor.year}年` : ''}${dueAnchor.month}月${dueAnchor.day}日（年份信息不全，不推算剩余天数）`
        : '';
    const dueText = due
        ? (due.天数 === 0 ? '·今天到期' : (due.过期 ? `·已过期 ${due.天数} 天` : `·还有 ${due.天数} 天到期`))
        : dueDateText ? `·到期 ${dueDateText}` : '';
    const cycle = entry.周期长度 ? `·周期 ${entry.周期长度} 天` : '';
    const who = entry.牵扯?.length ? `·涉及 ${entry.牵扯.join('、')}` : '';
    const pending = entry.来源状态 === '待确认' ? '·来源待确认，请以最新可见正文校对' : '';
    return `[${entry.id}] ${entry.事由}（${entry.类型}）：现状「${entry.现状 || '—'}」｜${sinceText}${dueText}${cycle}${who}${pending}`;
}
