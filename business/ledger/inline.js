import { escapeHtml, escapeAttr } from '../../utils/dom.js';
import { calMonthName } from '../axis/data.js';

export function createLedgerInlineRenderer(options = {}) {
    const fmtDate = (md, cal = options.calendar?.()) => {
        if (!md || !Number.isFinite(+md.month) || !Number.isFinite(+md.day)) return '';
        return `${calMonthName(cal, +md.month)}${+md.day}日`;
    };
    const rowDates = (item, cal) => {
        const start = fmtDate(item.起始锚?.历日期, cal); const due = fmtDate(item.到期锚?.历日期, cal);
        return `${start ? `<span class="sp-ledger-meta">起 ${escapeHtml(start)}</span>` : ''}${item.周期长度 ? `<span class="sp-ledger-meta">周期${escapeHtml(String(item.周期长度))}天</span>` : ''}${due ? `<span class="sp-ledger-meta">终 ${escapeHtml(due)}</span>` : ''}${item.来源状态 ? `<span class="sp-ledger-meta">${escapeHtml(item.来源状态)}</span>` : ''}`;
    };
    const buildPool = (poolArg = null, readOnly = false, calendarOverride = undefined) => {
        if (options.settings?.().ledgerInlineEnabled === false) return '';
        const items = poolArg != null ? (Array.isArray(poolArg) ? poolArg.filter(x => x?.事由) : []) : (options.entries?.() || []).filter(x => x?.事由);
        if (!items.length) return '';
        const cal = calendarOverride === undefined ? options.calendar?.() : calendarOverride;
        const judging = options.judging?.();
        const capturing = options.capturing?.();
        const captureAttrs = capturing ? 'disabled aria-disabled="true" aria-busy="true"' : 'aria-disabled="false" aria-busy="false"';
        const actions = readOnly ? '' : `<span class="sp-inline-summary-actions"><button type="button" class="sp-mini-btn sp-ledger-pill sp-inline-ledger-capture${capturing ? ' sp-ledger-capture-busy' : ''}" title="${capturing ? '正在打捞新标注' : '打捞新标注'}" ${captureAttrs}>${capturing ? '标注中…' : '标注'}</button><button type="button" class="sp-mini-btn sp-ledger-pill sp-inline-ledger-judge" title="按时间更新现状" ${judging ? 'disabled' : ''}>${judging ? '更新中…' : '更新'}</button></span>`;
        const rows = items.map(item => {
            const type = options.typeClass?.(item.类型) || 'state'; const locked = item.锁 === '用户锁'; const paused = item.静音 === true;
            const buttons = readOnly ? '' : `<span class="sp-beat-actions"><button class="sp-inline-ledger-lock${locked ? ' sp-inline-locked' : ''}" data-id="${escapeAttr(item.id)}" title="${locked ? '已锁定 · 点击解锁' : '锁定 · AI 判定不再改动此条'}"><i class="fa-solid fa-${locked ? 'lock' : 'lock-open'}"></i></button><button class="sp-inline-ledger-mute${paused ? ' sp-inline-paused' : ''}" data-id="${escapeAttr(item.id)}" title="${paused ? '已暂停埋入 · 点击恢复' : '暂停埋入 · 暂不注入主楼'}"><i class="fa-solid fa-${paused ? 'bell-slash' : 'bell'}"></i></button><button class="sp-inline-ledger-close" data-id="${escapeAttr(item.id)}" title="归档了结 · 移出活跃、可捞回"><i class="fa-solid fa-box-archive"></i></button></span>`;
            const tags = (item.标签 || []).map(t => `<span class="sp-ledger-tag">${escapeHtml(t)}</span>`).join('');
            return `<div class="sp-ledger-inline-row sp-ledger-${type}${locked ? ' sp-line-pinned' : ''}${paused ? ' sp-ledger-paused' : ''}" data-id="${escapeAttr(item.id)}"><div class="sp-inline-head">${item.类型 ? `<span class="sp-ledger-type">${escapeHtml(item.类型)}</span>` : ''}${buttons}</div><div class="sp-inline-name">${escapeHtml(item.事由)}</div>${rowDates(item, cal) ? `<div class="sp-ledger-dates">${rowDates(item, cal)}</div>` : ''}${tags ? `<div class="sp-ledger-r3">${tags}</div>` : ''}</div>`;
        }).join('');
        return `<summary class="sp-inline-summary"><span class="sp-inline-title">标注池</span><span class="sp-inline-count">${items.length} 条</span>${actions}</summary><div class="sp-inline-body sp-ledger-inline-body">${rows}</div>`;
    };
    const buildRecall = (snap, _isLatest, calendarOverride = undefined) => {
        if (options.settings?.().recallInlineEnabled === false) return '';
        const items = snap ? (snap.recall || []) : (options.echo?.() || []);
        if (!items.length) return '';
        const cal = calendarOverride === undefined ? options.calendar?.() : calendarOverride;
        const rows = items.map(item => {
            const type = options.typeClass?.(item.类型) || 'state'; const start = fmtDate(item.起始锚?.历日期, cal);
            return `<div class="sp-recall-row sp-ledger-${type}"><div class="sp-inline-head">${item.类型 ? `<span class="sp-ledger-type">${escapeHtml(item.类型)}</span>` : ''}${start ? `<span class="sp-inline-when">起 ${escapeHtml(start)}</span>` : ''}</div><div class="sp-inline-name">${escapeHtml(item.事由)}</div>${item.现状 ? `<div class="sp-inline-desc">推测应为「${escapeHtml(item.现状)}」</div>` : ''}</div>`;
        }).join('');
        const cls = `sp-inline-box sp-dash sp-recall-box${_isLatest ? '' : ' sp-inline-box-ro'}`;
        return `<details class="${cls}"><summary class="sp-inline-summary"><span class="sp-inline-title">召回</span><span class="sp-inline-count">${items.length} 条</span></summary><div class="sp-inline-body sp-recall-body">${rows}</div></details>`;
    };
    return { buildPool, buildRecall };
}

export function formatLedgerList(items, { daysSince, dueInfo } = {}) {
    const list = Array.isArray(items) ? items : [];
    return list.map(e => {
        const who = e.牵扯?.length ? `${e.牵扯.join('、')}：` : '';
        if (e.类型 === '持续状态') {
            const since = daysSince?.(e); const s = since == null ? '' : (since === 0 ? '（今天起）' : `（已 ${since} 天）`);
            return `- ${who}${e.事由}${s}——现状「${e.现状 || '—'}」`;
        }
        const du = dueInfo?.(e); const dueStr = !du ? '（未定期）' : (du.天数 === 0 ? '（今天到期）' : (du.过期 ? `（已过期 ${du.天数} 天）` : `（还有 ${du.天数} 天）`));
        const cyc = e.周期长度 ? `·约 ${e.周期长度} 天一轮` : '';
        return `- ${who}${e.事由}${dueStr}${cyc}——现状「${e.现状 || '—'}」`;
    }).join('\n');
}
