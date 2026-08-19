// 纯适配决策：供运行时代码与 node:test 共用，避免回归测试只验证正则或复制实现。
export function mergeRecallTags(entry) {
    return [entry?.comment, entry?.key, entry?.keys]
        .flatMap(value => Array.isArray(value) ? value : [value])
        .filter(value => value !== undefined && value !== null && String(value).trim())
        .map(String)
        .join(' ');
}

export function filterRerollItems(items, reroll) {
    return reroll ? (items || []).filter(item => item?.locked === true) : (items || []);
}

export function pickWithoutPrevious(pool, previousUid, random = Math.random) {
    const list = Array.isArray(pool) ? pool : [];
    const choices = list.filter(item => String(item?.uid) !== String(previousUid));
    const source = choices.length ? choices : list;
    return source.length ? source[Math.floor(random() * source.length)] : null;
}

export function shouldRunPendingPointFollowup({ pending, allowPendingFollowup = true, signalAborted = false, chatSame = true, pointGenerating = false, needsSync = true } = {}) {
    return !!(pending && allowPendingFollowup && !signalAborted && chatSame && !pointGenerating && needsSync);
}

export function nonEmptyTemplates(templates) {
    return (Array.isArray(templates) ? templates : []).filter(item => String(item?.text || '').trim());
}

export function snapshotTheaterSource(source, input) {
    return source ? { ...source, input: String(input || '').trim() } : null;
}
