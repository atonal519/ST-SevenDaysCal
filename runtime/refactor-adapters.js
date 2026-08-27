// 纯适配决策：供运行时代码与 node:test 共用，避免回归测试只验证正则或复制实现。
export function mergeRecallTags(entry) {
    const seen = new Set();
    return [entry?.name, entry?.comment, entry?.strategy?.keys, entry?.key, entry?.keys]
        .flatMap(value => Array.isArray(value) ? value : [value])
        .filter(value => value !== undefined && value !== null && String(value).trim())
        .map(value => String(value).trim())
        .filter(value => !seen.has(value) && seen.add(value))
        .join(' ');
}

const DATABASE_MEMO_NAME = /^TavernDB-ACU-CustomExport-纪要-\d+$/i;
const LEGACY_MEMO_NAME = /^(?:总结条目|小总结条目)[\s_#-]*\d+(?:\s.*)?$/i;

export function databaseEntryName(entry) {
    const name = String(entry?.name || '').trim();
    return name || String(entry?.comment || '').trim();
}

export function isDatabaseMemoEntry(entry) {
    const name = databaseEntryName(entry);
    return DATABASE_MEMO_NAME.test(name) || LEGACY_MEMO_NAME.test(name);
}

export function filterRerollItems(items, reroll) {
    return reroll ? (items || []).filter(item => item?.locked === true) : (items || []);
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
