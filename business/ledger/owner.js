const hash = text => { let h = 2166136261; for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return `lr-${(h >>> 0).toString(16)}`; };
export function ledgerOwnerIdentity(ctx = {}) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const messages = chat.map(message => ({
        kind: message?.is_user ? 'user' : message?.is_system ? 'system' : 'assistant',
        hash: hash(JSON.stringify({ is_user: !!message?.is_user, is_system: !!message?.is_system, hidden: message?.is_hidden === true || message?.extra?.is_hidden === true, name: String(message?.name || ''), type: String(message?.extra?.type || ''), uses_system_ui: message?.extra?.uses_system_ui === true, swipe_id: message?.swipe_id ?? null, mes_id: message?.mes_id ?? null, mes: message?.mes ?? '' })),
    }));
    const last = [...chat].reverse().find(message => message && !message.is_user && !message.is_system);
    const revision = hash(JSON.stringify(messages));
    const character = ctx?.characters?.[ctx?.characterId] || {};
    const participant = hash(JSON.stringify({ characterId: String(ctx?.characterId ?? ''), characterKey: String(character?.avatar || ''), userName: String(ctx?.name1 || '用户'), charName: String(ctx?.name2 || '角色'), persona: String(ctx?.powerUserSettings?.persona_name ?? ctx?.powerUserSettings?.default_persona ?? ctx?.powerUserSettings?.persona_description ?? '') }));
    return { chatId: ctx.chatId || null, revision, messages, swipe: last?.swipe_id ?? last?.mes_id ?? null, participant };
}
export const sameLedgerOwner = (a, b) => {
    // Chat id and participant metadata are diagnostic/index values, not a gate
    // for an already-started result. Keep the captured narrative content and
    // swipe stable so real source edits still invalidate a ledger calculation.
    if (!a || !b || String(a.swipe ?? '') !== String(b.swipe ?? '')) return false;
    if (String(a.revision || '') === String(b.revision || '')) return true;
    const before = Array.isArray(a.messages) ? a.messages : [], after = Array.isArray(b.messages) ? b.messages : [];
    return before.length > 0 && after.length > before.length
        && before.every((item, index) => item?.kind === after[index]?.kind && item?.hash === after[index]?.hash)
        && after.slice(before.length).every(item => item?.kind === 'user');
};
