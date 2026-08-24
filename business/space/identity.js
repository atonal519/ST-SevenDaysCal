export function createSpaceIdentity({ chatId = '', chatRevision = 0, historyKey = null } = {}) {
    const id = String(chatId ?? '').trim();
    return Object.freeze({
        chatId: id,
        chatRevision: Number(chatRevision) || 0,
        historyKey: id ? Object.freeze({ ...(historyKey || {}), kind: 'space-chat', view: 'user', charName: '', chatId: id }) : null,
    });
}

export function sameSpaceIdentity(left, right) {
    return !!left && !!right
        && left.chatId === right.chatId
        && left.chatRevision === right.chatRevision;
}
