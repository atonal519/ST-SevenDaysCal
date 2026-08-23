export function createOutlineIdentity({ chatId } = {}) {
    const id = String(typeof chatId === 'function' ? chatId() : chatId ?? '').trim();
    return Object.freeze({ chatId: id, scope: 'user' });
}

export function outlineIdentityKey(identity, kind = 'outline') {
    const chatId = String(identity?.chatId || '').trim();
    if (!chatId) return null;
    return { kind, chatId, scope: 'user' };
}
