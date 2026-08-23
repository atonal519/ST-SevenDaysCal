// 刻度注入正文纯函数；日期数值由调用方预先计算，避免模块读取宿主状态。
export function buildLedgerInjectionText(picked = []) {
    const states = picked.filter(entry => entry.类型 === '持续状态');
    const timed = picked.filter(entry => entry.类型 !== '持续状态');
    const dateSince = entry => {
        const value = entry._daysSince;
        return value == null ? '' : (value === 0 ? '（今天）' : `（距今 ${value} 天）`);
    };
    const dueText = entry => {
        const due = entry._dueInfo;
        if (!due) return '（未定期）';
        return due.天数 === 0 ? '（今天到期）' : (due.过期 ? `（已过期 ${due.天数} 天未了）` : `（还有 ${due.天数} 天到期）`);
    };
    const stateLines = states.map(entry => {
        const who = entry.牵扯?.length ? `${entry.牵扯.join('、')}：` : '';
        return `- ${who}${entry.事由}${dateSince(entry)}——当前应为「${entry.现状 || '—'}」`;
    });
    const timedLines = timed.map(entry => {
        const cycle = entry.周期长度 ? `·约 ${entry.周期长度} 天一轮` : '';
        const who = entry.牵扯?.length ? `${entry.牵扯.join('、')}：` : '';
        return `- ${who}${entry.事由}${dueText(entry)}${cycle}——现状「${entry.现状 || '—'}」`;
    });
    const blocks = ['【暗线·时间账·仅供你把握角色此刻的身心与待办，切勿直接念出编号或「系统」字样】', '以下是随剧情时间推移、此刻仍牵动角色的事。请把它们自然融进叙事与角色状态，别生硬罗列、别让角色开口谈论这套记录本身。'];
    if (stateLines.length) blocks.push('◆ 正持续的身心状态（按登记至今的天数，表现出它此刻该有的样子）：\n' + stateLines.join('\n'));
    if (timedLines.length) blocks.push('◆ 临近的约定与周期（按倒计时，该临近就流露惦记、该发生就顺势发生）：\n' + timedLines.join('\n'));
    return blocks.join('\n');
}

export function createLedgerInjectionController(options = {}) {
    const KEY = options.key || 'sp_ledger_remind';
    const DEPTH = options.depth ?? 2;
    let echo = [];
    const sceneText = (n = 4) => {
        const chat = options.context?.().chat || [];
        const parts = [], userParts = [];
        for (let i = chat.length - 1; i >= 0 && userParts.length < 1; i--) {
            const message = chat[i];
            if (!message?.is_user) continue;
            const cleaned = options.stripTags ? options.stripTags(String(message.mes || '')).trim() : String(message.mes || '').trim();
            if (cleaned) userParts.unshift(cleaned);
        }
        for (let i = chat.length - 1; i >= 0 && parts.length < n; i--) {
            const message = chat[i];
            if (!options.narrative?.(message)) continue;
            const raw = String(message.mes || '');
            const cleaned = options.stripTags ? options.stripTags(raw).trim() : raw.trim();
            if (cleaned) parts.unshift(cleaned);
        }
        return [...userParts, ...parts].join('\n');
    };
    const clear = ctx => { ctx.setExtensionPrompt(KEY, ''); echo = []; };
    return {
        refresh() {
            const ctx = options.context?.();
            if (typeof ctx?.setExtensionPrompt !== 'function') return;
            if (!options.enabled?.() || options.settings?.().ledgerInject !== true) { clear(ctx); return; }
            const entries = options.entries?.() || [];
            const picked = options.select?.(entries, sceneText(options.sceneFloors || 4), options.today?.()) || [];
            if (!picked.length) { clear(ctx); return; }
            const pt = ctx.constants?.promptTypes?.IN_CHAT ?? 1;
            const pr = ctx.constants?.promptRoles?.SYSTEM ?? 0;
            const annotated = picked.map(entry => ({ ...entry, _daysSince: options.daysSince?.(entry), _dueInfo: options.dueInfo?.(entry) }));
            ctx.setExtensionPrompt(KEY, buildLedgerInjectionText(annotated), pt, DEPTH, false, pr);
            echo = picked.map(e => ({ id: e.id, 事由: e.事由, 类型: e.类型, 起始锚: e.起始锚, 现状: e.现状 }));
        },
        clear() { const ctx = options.context?.(); if (typeof ctx?.setExtensionPrompt === 'function') clear(ctx); },
        get echo() { return echo; },
    };
}
