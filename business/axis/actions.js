export function createAxisActions(env = {}) {
    const participantCurrent = participant => !participant || env.sameParticipantIdentity?.(participant, env.captureParticipantIdentity?.()) !== false;
    const itemIdentity = item => JSON.stringify(['id', 'name', 'type', 'month', 'day', 'days', 'displayDate', 'note', 'pin', 'source'].map(key => item?.[key] ?? null));
    const togglePin = id => {
        const list = env.load?.() || [], item = list.find(x => x.id === id); if (!item) return null;
        item.pin = !item.pin; env.save?.(list); env.toast?.(item.pin ? '已锁定 · 生成时保留' : '已解锁');
        return { id, pin: item.pin };
    };
    const remove = async id => {
        const chatId = env.chatId?.(); const participant = env.captureParticipantIdentity?.() || null;
        const list = env.load?.() || [], candidates = list.filter(x => x.id === id); if (candidates.length !== 1) return false;
        const item = candidates[0], targetIdentity = itemIdentity(item);
        const ok = await env.confirm?.({ title: '删除日期', body: `确定删除「${item.name}」？`, confirmText: '删除', cancelText: '取消' }); if (!ok) return false;
        if ((env.chatId && env.chatId() !== chatId) || !participantCurrent(participant)) return false;
        const latest = env.load?.() || [];
        const matches = latest.map((candidate, index) => candidate?.id === id && itemIdentity(candidate) === targetIdentity ? index : -1).filter(index => index >= 0);
        if (matches.length !== 1) return false;
        env.save?.(latest.filter((_item, index) => index !== matches[0])); env.render?.(); env.sync?.(); return true;
    };
    const clearHighlight = () => env.clear?.();
    const highlight = item => {
        clearHighlight(); if (!item) return [];
        const cal = env.calendar?.(), month = env.month?.() + 1, days = env.clamp?.(item.days, 1, env.yearLength?.(cal), 1), out = [];
        const start = env.dayOfYear?.(item.month, item.day, cal);
        for (let k = 0; k < days; k++) { const md = env.monthDayFromDoy?.(start + k, cal); if (md?.month === month) out.push(md.day); }
        return out;
    };
    return { togglePin, remove, highlight, clearHighlight };
}
