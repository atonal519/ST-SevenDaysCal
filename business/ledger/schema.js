// 刻度 AI I/O schema：严格解析，不承担 API、存储或 UI 副作用。
let parseDate = () => null;
let types = ['持续状态', '约定待办', '周期'];
export function bindLedgerSchema({ parseJudgedDate, ledgerTypes } = {}) {
    if (parseJudgedDate) parseDate = parseJudgedDate;
    if (Array.isArray(ledgerTypes)) types = ledgerTypes;
}
export const splitCnList = value => String(value || '').split(/[、,，;；]/).map(x => x.trim()).filter(Boolean);
export const normGist = value => String(value || '').replace(/\s+/g, '');
// 仅供 AI capture/judge 的完整句字段使用；存储 normalize 与用户编辑器不得调用。
export function normalizeLedgerSentenceTerminal(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const closing = text.match(/([”’"'》】）)\]\}〉」』〕〗〙〛]+)$/u)?.[1] || '';
    const body = closing ? text.slice(0, -closing.length).trimEnd() : text;
    if (/[。！？.!?…]$/u.test(body)) return text;
    return closing ? `${body}。${closing}` : `${text}。`;
}
export function parseLedgerCapture(raw) {
    const s = String(raw || '').trim();
    if (!s || /^无[。.！!]?$/.test(s)) return [];
    const out = [];
    for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t || !t.includes('｜') || /^(?:事由|候选ID)\s*｜/.test(t)) continue;
        const cols = t.split('｜').map(x => x.trim());
        const candidateId = String(cols[0] || '').trim().toUpperCase();
        const provenance = /^C\d+$/.test(candidateId);
        const targetId = /^L\d+$/.test(candidateId) ? candidateId : null;
        const offset = (provenance || targetId) ? 1 : 0;
        if (!cols[offset]) continue;
        const entry = { 事由: cols[offset], 类型: types.includes(cols[offset + 1]) ? cols[offset + 1] : '持续状态', 牵扯: splitCnList(cols[offset + 2]), 标签: splitCnList(cols[offset + 3]), 现状: normalizeLedgerSentenceTerminal(cols[offset + 4]) };
        const cycle = parseInt(cols[offset + 6], 10);
        if (Number.isFinite(cycle) && cycle > 0) entry.周期长度 = cycle;
        const due = parseDate(cols[offset + 5] || '');
        if (due) entry.到期锚 = { 历日期: due };
        if (provenance) { entry._candidateId = candidateId; entry._sourceToken = cols[8] || ''; }
        else if (targetId) { entry._targetId = targetId; entry._sourceToken = cols[8] || ''; }
        else if (cols.length >= 8) entry._sourceToken = cols[7] || '';
        out.push(entry);
    }
    return out;
}
export function normalizeJudgeAction(raw) {
    const text = String(raw || '').replace(/\s+/g, '');
    if (/滚|周期|顺延|续期/.test(text)) return '滚周期';
    if (/了结|了断|结束|完结|终结|终止|结案|兑现|愈合|痊愈|康复|已了/.test(text)) return '了结';
    return '维持';
}
export function parseLedgerJudge(raw) {
    const s = String(raw ?? '').trim().replace(/^```[^\n]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const none = s.replace(/[。.!！！？?]+$/u, '').trim();
    if (new Set(['无', '无需更新', '无须更新', '无需变更', '无须变更', '本轮无需更新', '没有需要更新的事件']).has(none)) return { status: 'none', changes: [] };
    if (!s) return { status: 'invalid', changes: [] };
    const out = []; let invalid = false;
    for (const line of s.split('\n')) {
        const t = line.trim(); if (!t) continue;
        if (/^编号\s*[｜|]/.test(t)) continue;
        if (!/[｜|]/.test(t)) { invalid = true; continue; }
        const cols = t.split(/[｜|]/).map(x => x.trim());
        if (cols.length !== 4) { invalid = true; continue; }
        const id = cols[0].replace(/[\[\]【】]/g, '').trim().toUpperCase();
        if (!/^L\d+$/i.test(id) || !cols[1] || !cols[2] || !/(?:维持|滚|周期|顺延|续期|了结|了断|结束|完结|终结|终止|结案|兑现|愈合|痊愈|康复|已了)/.test(cols[2])) { invalid = true; continue; }
        const change = { id, 现状: normalizeLedgerSentenceTerminal(cols[1]), 动作: normalizeJudgeAction(cols[2]) };
        const due = parseDate(cols[3] || ''); if (due) change.到期 = due;
        out.push(change);
    }
    return invalid || !out.length ? { status: 'invalid', changes: [] } : { status: 'changes', changes: out };
}
