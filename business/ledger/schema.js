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
        if (!t || !/[｜|]/.test(t)) continue;
        const cols = t.split(/[｜|]/).map(x => x.trim());
        if (/^[｜|]/.test(t)) cols.shift();
        if (/[｜|]$/.test(t)) cols.pop();
        if (/^(?:事由|候选ID)$/i.test(cols[0] || '') || (cols.length && cols.every(col => /^:?-{3,}:?$/.test(col)))) continue;
        const candidateId = String(cols[0] || '').trim().toUpperCase();
        const provenance = /^C\d+$/.test(candidateId);
        const targetId = /^L\d+$/.test(candidateId) ? candidateId : null;
        const offset = (provenance || targetId) ? 1 : 0;
        if (cols.length !== (offset ? 9 : 8)) continue;
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
function parseJudgeAction(raw) {
    const text = String(raw || '').replace(/\s+/g, '');
    if (!text) return null;
    const terminal = '(?:[。.!！])?';
    const maintain = new RegExp(`^(?:请)?(?:继续)?(?:维持(?:不变)?|保持不变)(?:即可)?${terminal}$`);
    const roll = new RegExp(`^(?:请|建议|应当|应|可以|选择)?(?:滚周期|顺延|顺延一个周期|顺延一轮周期|续期|续期一个周期|续期一轮周期)(?:即可)?${terminal}$`);
    const close = new RegExp(`^(?:请(?:将其)?|建议|应当|应|可以|标记为|将其标记为)?(?:了结|了断|结束|完结|终结|终止|结案|兑现|愈合|痊愈|康复)(?:即可)?${terminal}$`);
    if (maintain.test(text)) return '维持';
    if (roll.test(text)) return '滚周期';
    if (close.test(text)) return '了结';
    return null;
}
export function normalizeJudgeAction(raw) { return parseJudgeAction(raw); }
export function parseLedgerJudge(raw) {
    const s = String(raw ?? '').trim().replace(/^```[^\n]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const none = s.replace(/[。.!！！？?]+$/u, '').trim();
    if (new Set(['无', '无需更新', '无须更新', '无需变更', '无须变更', '本轮无需更新', '没有需要更新的事件']).has(none)) return { status: 'none', changes: [] };
    if (!s) return { status: 'invalid', changes: [], rejected: [] };
    const out = []; const rejected = [];
    for (const [index, line] of s.split('\n').entries()) {
        const t = line.trim(); if (!t) continue;
        if (/^编号\s*[｜|]/.test(t)) continue;
        const reject = reason => rejected.push({ line: index + 1, reason });
        if (!/[｜|]/.test(t)) { reject('format'); continue; }
        const cols = t.split(/[｜|]/).map(x => x.trim());
        if (cols.length !== 4) { reject('format'); continue; }
        const id = cols[0].replace(/[\[\]【】]/g, '').trim().toUpperCase();
        if (!/^L\d+$/i.test(id)) { reject('id'); continue; }
        if (!cols[1]) { reject('content'); continue; }
        const action = parseJudgeAction(cols[2]);
        if (!action) { reject('action'); continue; }
        const dueText = cols[3] || '';
        const due = parseDate(dueText);
        if (dueText && !due) { reject('date'); continue; }
        const change = { id, 现状: normalizeLedgerSentenceTerminal(cols[1]), 动作: action };
        if (due) change.到期 = due;
        out.push(change);
    }
    return out.length ? { status: 'changes', changes: out, rejected } : { status: 'invalid', changes: [], rejected };
}
