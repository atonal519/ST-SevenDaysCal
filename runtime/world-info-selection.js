export const WORLD_INFO_SELECTION_VERSION = 1;

function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeWorldInfoSelectionBucket(value) {
    if (!isRecord(value) || value.version !== WORLD_INFO_SELECTION_VERSION || !isRecord(value.decisions)) return null;
    const decisions = {};
    for (const [key, allowed] of Object.entries(value.decisions)) {
        if (key && typeof allowed === 'boolean') decisions[key] = allowed;
    }
    return { version: WORLD_INFO_SELECTION_VERSION, decisions };
}

export function initializeWorldInfoSelection({ stored = null, candidates = [], legacyDisabled = [] } = {}) {
    const normalized = normalizeWorldInfoSelectionBucket(stored);
    const migrated = normalized === null;
    const bucket = normalized || { version: WORLD_INFO_SELECTION_VERSION, decisions: {} };
    const decisions = { ...bucket.decisions };
    const legacyValues = Array.isArray(legacyDisabled) ? legacyDisabled : [...(legacyDisabled || [])];
    const disabled = new Set(legacyValues.filter(Boolean));
    let changed = migrated;

    for (const candidate of candidates || []) {
        const key = String(candidate?.key || '').trim();
        if (!key || Object.prototype.hasOwnProperty.call(decisions, key)) continue;
        const hostEnabled = candidate?.hostEnabled === true;
        decisions[key] = migrated ? hostEnabled && !disabled.has(key) : hostEnabled;
        changed = true;
    }

    return {
        bucket: { version: WORLD_INFO_SELECTION_VERSION, decisions },
        changed,
        migrated,
    };
}

export function mergeWorldInfoSelection(bucket, visibleStates = []) {
    const normalized = normalizeWorldInfoSelectionBucket(bucket)
        || { version: WORLD_INFO_SELECTION_VERSION, decisions: {} };
    const decisions = { ...normalized.decisions };
    let changed = false;

    for (const state of visibleStates || []) {
        const key = String(state?.key || '').trim();
        if (!key) continue;
        const allowed = state?.checked === true;
        if (decisions[key] === allowed) continue;
        decisions[key] = allowed;
        changed = true;
    }

    return {
        bucket: { version: WORLD_INFO_SELECTION_VERSION, decisions },
        changed,
    };
}

export function worldInfoSelectionAllows(bucket, key) {
    const normalized = normalizeWorldInfoSelectionBucket(bucket);
    return normalized?.decisions?.[String(key || '')] === true;
}
