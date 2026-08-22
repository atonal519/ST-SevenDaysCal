const hash = text => { let h = 2166136261; for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return `lr-${(h >>> 0).toString(16)}`; };
export function ledgerOwnerIdentity(ctx = {}) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : []; const last = chat[chat.length - 1];
    const revision = hash(JSON.stringify(chat.map(message => ({ is_user: !!message?.is_user, is_system: !!message?.is_system, swipe_id: message?.swipe_id ?? null, mes_id: message?.mes_id ?? null, mes: message?.mes ?? '' }))));
    return { chatId: ctx.chatId || null, revision, swipe: last?.swipe_id ?? last?.mes_id ?? null };
}
export const sameLedgerOwner = (a, b) => !!a && !!b && String(a.chatId || '') === String(b.chatId || '') && String(a.revision || '') === String(b.revision || '') && String(a.swipe ?? '') === String(b.swipe ?? '');
