function hashText(value) { let h = 2166136261; for (const ch of String(value || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function replySource(message, swipeId = Number(message?.swipe_id) || 0) {
    const info = Array.isArray(message?.swipe_info) ? message.swipe_info[swipeId] : null;
    const text = Array.isArray(message?.swipes) && typeof message.swipes[swipeId] === 'string' ? message.swipes[swipeId] : message?.mes || '';
    return [info?.send_date || message?.send_date || '', swipeId, text].join('|');
}
export function replySourceSignature(message, swipeId = Number(message?.swipe_id) || 0) { return hashText(replySource(message, swipeId)); }
function stableMetadataValue(value) {
    if (value == null) return '';
    if (typeof value?.toJSON === 'function') {
        try { return String(value.toJSON()); } catch { /* fall through */ }
    }
    return String(value);
}
function replyMetadataSignature(message, swipeId = Number(message?.swipe_id) || 0) {
    const activeSwipeId = Number(message?.swipe_id) || 0;
    const info = Array.isArray(message?.swipe_info) ? message.swipe_info[swipeId] : null;
    const current = swipeId === activeSwipeId;
    const sendDate = info?.send_date || (current ? message?.send_date : '');
    const genStarted = info?.gen_started || (current ? message?.gen_started : '');
    const genFinished = info?.gen_finished || (current ? message?.gen_finished : '');
    if (genStarted || sendDate) return `v2-${hashText(JSON.stringify([swipeId, stableMetadataValue(genStarted), stableMetadataValue(sendDate)]))}`;
    if (genFinished) return `v2-${hashText(JSON.stringify([swipeId, '', '', stableMetadataValue(genFinished)]))}`;
    return '';
}
export function replySignature(message, swipeId = Number(message?.swipe_id) || 0) {
    return replyMetadataSignature(message, swipeId) || replySourceSignature(message, swipeId);
}
export function legacyPointerBelongsToReply(pointer, message, swipeId) {
    if (pointer?.external !== true || typeof pointer.replyId !== 'string' || Number(pointer.swipeId) !== swipeId) return false;
    if (typeof pointer.replySignature === 'string' && pointer.replySignature) return pointer.replySignature === replySignature(message, swipeId);
    return pointer.sourceSignature === replySourceSignature(message, swipeId);
}
