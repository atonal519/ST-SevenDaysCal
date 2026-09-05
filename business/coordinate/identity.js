export function floorKey(chatId, messageId) { return `${chatId ?? ''}::${messageId ?? ''}`; }
export function normalizeId(value) { return value == null ? '' : String(value); }
export function sameFloor(item, chatId, floorIndex) {
    const floor = Number(floorIndex);
    return normalizeId(item?.chatId) === normalizeId(chatId) && Number.isFinite(floor) &&
        (Number(item?.messageId) === floor || Number(item?.floorIndex) === floor);
}

export const REPLY_MARKER_KEY = 'sp_coordinate_anchor';

function versionValue(value) {
    if (value == null) return '';
    if (typeof value?.toJSON === 'function') {
        try { return String(value.toJSON()); } catch { /* fall through */ }
    }
    return String(value);
}

function hashReply(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function replyVersion(message) {
    if (!message || typeof message !== 'object') return '';
    const source = JSON.stringify([
        versionValue(message.mes),
        versionValue(message.send_date),
        versionValue(message.gen_started),
        versionValue(message.gen_finished),
    ]);
    return `v1-${source.length.toString(36)}-${hashReply(source)}`;
}

function markerFrom(extra, version) {
    const marker = extra?.[REPLY_MARKER_KEY];
    const itemId = normalizeId(marker?.itemId);
    return itemId && marker?.version === version ? { itemId, version } : null;
}

export function readReplyMarker(message) {
    const version = replyVersion(message);
    if (!version) return null;
    const direct = markerFrom(message?.extra, version);
    if (direct) return direct;
    const swipeId = Number(message?.swipe_id);
    if (!Number.isInteger(swipeId) || swipeId < 0) return null;
    return markerFrom(message?.swipe_info?.[swipeId]?.extra, version);
}

export function writeReplyMarker(message, itemId) {
    const normalizedId = normalizeId(itemId);
    const version = replyVersion(message);
    if (!message || !normalizedId || !version) return null;
    const marker = { itemId: normalizedId, version };
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    message.extra[REPLY_MARKER_KEY] = marker;
    const swipeId = Number(message.swipe_id);
    const swipeInfo = Number.isInteger(swipeId) && swipeId >= 0 ? message.swipe_info?.[swipeId] : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        if (!swipeInfo.extra || typeof swipeInfo.extra !== 'object') swipeInfo.extra = {};
        swipeInfo.extra[REPLY_MARKER_KEY] = { ...marker };
    }
    return marker;
}

export function clearReplyMarker(message, itemId) {
    const normalizedId = normalizeId(itemId);
    if (!message || !normalizedId) return false;
    let changed = false;
    const clear = extra => {
        if (normalizeId(extra?.[REPLY_MARKER_KEY]?.itemId) !== normalizedId) return;
        delete extra[REPLY_MARKER_KEY];
        changed = true;
    };
    clear(message.extra);
    const swipeId = Number(message.swipe_id);
    if (Number.isInteger(swipeId) && swipeId >= 0) clear(message.swipe_info?.[swipeId]?.extra);
    return changed;
}

export function currentViewRevision(state = {}) {
    return Object.freeze({
        featureRevision: Number(state.featureRevision) || 0,
        viewRevision: Number(state.viewRevision) || 0,
        route: String(state.route || ''),
        itemId: state.itemId == null ? null : String(state.itemId),
    });
}

export function isCurrentRevision(expected, actual) {
    return !!expected && !!actual && expected.featureRevision === actual.featureRevision &&
        expected.viewRevision === actual.viewRevision && expected.route === actual.route &&
        expected.itemId === actual.itemId;
}
