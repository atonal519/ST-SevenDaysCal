export function createOutlineIdentity({ chatId, chatRevision = 0, outlineKey = null, creativeChatKey = null } = {}) {
    const id = String(typeof chatId === 'function' ? chatId() : chatId ?? '').trim();
    return Object.freeze({
        chatId: id,
        chatRevision: Number(chatRevision) || 0,
        outlineKey: freezeKey(outlineKey, 'outline', id),
        creativeChatKey: freezeKey(creativeChatKey, 'creative-chat', id),
    });
}

function freezeKey(value, kind, chatId) {
    if (!chatId) return null;
    return Object.freeze({ ...(value || {}), kind, chatId });
}

export function sameOutlineIdentity(left, right) {
    return !!left && !!right && left.chatId === right.chatId && left.chatRevision === right.chatRevision;
}
