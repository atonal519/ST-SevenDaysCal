export function floorKey(chatId, messageId) { return `${chatId ?? ''}::${messageId ?? ''}`; }
export function normalizeId(value) { return value == null ? '' : String(value); }
export function sameFloor(item, chatId, floorIndex) {
    const floor = Number(floorIndex);
    return normalizeId(item?.chatId) === normalizeId(chatId) && Number.isFinite(floor) &&
        (Number(item?.messageId) === floor || Number(item?.floorIndex) === floor);
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
