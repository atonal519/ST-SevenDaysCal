export function captureTheaterIdentity({ chatId, chatRevision = 0, metadata = null, isCurrent = () => true, persist = null } = {}) {
    const id = chatId == null ? '' : String(chatId);
    return Object.freeze({ chatId: id, chatRevision, metadata, persist, isCurrent });
}

export function sameTheaterIdentity(a, b) {
    return !!a && !!b && String(a.chatId) === String(b.chatId) && a.chatRevision === b.chatRevision;
}

export function resolveTheaterRegen(piece, fallbackInput = '') {
    const input = String(piece?.request || piece?.templateSource?.input || fallbackInput || '').trim();
    return { input, templateSource: piece?.templateSource?.input ? { ...piece.templateSource, input: String(piece.templateSource.input).trim() } : null };
}
