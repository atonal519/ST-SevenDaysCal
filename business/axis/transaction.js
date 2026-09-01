import { axisState } from './state.js';

export function createAxisTransactionController(env = {}) {
    const participantCurrent = participant => !participant || env.sameParticipantIdentity?.(participant, env.captureParticipantIdentity?.()) !== false;
    const itemIdentity = item => JSON.stringify(['id', 'name', 'type', 'month', 'day', 'days', 'displayDate', 'note', 'pin', 'source'].map(key => item?.[key] ?? null));
    const commit = async cal => {
        const chatId = env.chatId?.(), participant = env.captureParticipantIdentity?.() || null;
        const boundaryCurrent = () => env.chatId?.() === chatId && participantCurrent(participant);
        const items = env.items?.() || [], conflicts = env.conflicts?.(items, cal) || [], key = env.charKey?.(), raw = key ? env.anchor?.(key) : null;
        const anchorConflict = raw && !(Number(raw.month) >= 1 && Number(raw.month) <= env.monthCount(cal) && Number(raw.day) >= 1 && Number(raw.day) <= env.monthDays(cal, Number(raw.month)));
        const targets = conflicts.map(conflict => ({ id: conflict.item?.id, identity: itemIdentity(conflict.item), fixed: conflict.fixed }));
        const targetIds = new Set(targets.map(target => target.id));
        if (targets.some(target => target.id == null || items.filter(item => item?.id === target.id).length !== 1) || targetIds.size !== targets.length) return { ok: false, cancelled: true, reason: 'ambiguous-conflict-target' };
        let action = 'keep';
        if (conflicts.length || anchorConflict) {
            const shown = conflicts.slice(0, 12).map(c => `• ${c.item.name}：${c.item.month}/${c.item.day} → ${c.fixed.month}/${c.fixed.day}`);
            if (conflicts.length > shown.length) shown.push(`• 另有 ${conflicts.length - shown.length} 条`);
            if (anchorConflict) { const fm = Math.min(Math.max(Number(raw.month) || 1, 1), env.monthCount(cal)); const fd = Math.min(Math.max(Number(raw.day) || 1, 1), env.monthDays(cal, fm)); shown.push(`• 当前剧情日期：${raw.month}/${raw.day} → ${fm}/${fd}`); }
            action = await env.choose?.({ title: '有日期不适用于新历法', body: shown.join('\n'), note: '自动修改会保留条目并夹取到有效日期；删除只删除上面列出的日期。', choices: [{ value: 'cancel', label: '取消' }, { value: 'delete', label: '删除这些日期' }, { value: 'fix', label: '自动修改', primary: true }] });
            if (!action || action === 'cancel' || !boundaryCurrent()) return { ok: false, cancelled: true };
        }
        const latestItems = env.items?.() || [];
        const located = [];
        for (const target of targets) {
            const matches = latestItems.map((item, index) => item?.id === target.id && itemIdentity(item) === target.identity ? index : -1).filter(index => index >= 0);
            if (matches.length !== 1) return { ok: false, cancelled: true, reason: 'stale-conflict-target' };
            located.push({ ...target, index: matches[0] });
        }
        if (new Set(located.map(target => target.index)).size !== located.length) return { ok: false, cancelled: true, reason: 'ambiguous-conflict-target' };
        const locatedByIndex = new Map(located.map(target => [target.index, target]));
        const nextItems = action === 'delete'
            ? latestItems.filter((_item, index) => !locatedByIndex.has(index))
            : latestItems.map((item, index) => locatedByIndex.get(index)?.fixed || item);
        const latestAnchor = key ? env.anchor?.(key) : null;
        const anchorUnchanged = JSON.stringify(latestAnchor ?? null) === JSON.stringify(raw ?? null);
        if (!boundaryCurrent()) return { ok: false, cancelled: true };
        const ts = Date.now(); if (!env.writeBatch?.([{ kind: 'caldesc', view: 'user', charName: '', value: { ...cal, ts } }, { kind: 'almanac', view: 'user', charName: '', value: { items: nextItems, ts } }])) return { ok: false, error: '当前聊天无法写入历法' };
        if (!boundaryCurrent()) return { ok: false, cancelled: true };
        if (anchorConflict && key && latestAnchor && anchorUnchanged) { const fixedMonth = Math.min(Math.max(Number(latestAnchor.month) || 1, 1), env.monthCount(cal)); const fixedDay = Math.min(Math.max(Number(latestAnchor.day) || 1, 1), env.monthDays(cal, fixedMonth)); const result = action === 'delete' ? env.setAnchor?.(key, null) : env.setAnchor?.(key, fixedMonth, fixedDay); if (!result?.ok) return { ok: false, error: '当前聊天无法写入日期锚点' }; }
        if (!boundaryCurrent()) return { ok: false, cancelled: true };
        axisState._almanacCalMonth = null; axisState._almanacCalDay = null; axisState._almTodayEditing = false; env.syncAlmanac?.(); env.syncSchedule?.(); return { ok: true, cal };
    };
    const applyBound = async ({ notify = true, render = true } = {}) => {
        if (env.pluginEnabled?.() !== true || !env.chatId?.()) return false;
        const key = env.charKey?.(); if (!key || env.readCal?.() != null) return false;
        const existing = env.readItems?.(); if (Array.isArray(existing) && existing.length) return false;
        const bindings = env.bindings?.() || {}, templateId = bindings[env.bindingKey?.(bindings, key, env.cards?.())] || ''; if (!templateId) return false;
        const template = (env.templates?.() || []).find(item => item.id === templateId); if (!template) { delete bindings[env.bindingKey?.(bindings, key, env.cards?.())]; env.saveSettings?.(); return false; }
        const chatId = env.chatId?.(); if (env.chatId?.() !== chatId || !env.saveCal?.(env.clone?.(template))) throw new Error('当前聊天无法写入角色默认历法');
        axisState._almanacCalMonth = null; axisState._almanacCalDay = null; env.syncAlmanac?.(chatId); env.syncSchedule?.(chatId); if (render) env.render?.(); if (notify && env.notifyMode?.() === 'full') env.toast?.(`已采用角色默认历法：${template.name}`); return true;
    };
    return { commit, applyBound };
}
