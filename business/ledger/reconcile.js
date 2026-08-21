// 刻度来源校对：只做确定性来源匹配，不访问 API、不解释日期。
export function ledgerSourceFingerprint(token, signature) {
    const side = String(token || '').trim().endsWith('E') ? 'E' : 'S';
    const text = `${side}\n${String(signature || '')}`;
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return `lfp-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const validFloor = floor => Number.isInteger(floor) && floor >= 0;
const clone = value => JSON.parse(JSON.stringify(value));

export function reconcileLedgerEntries(entries, sources = [], chatLength = 0) {
    const sourceList = Array.isArray(sources) ? sources : [];
    const byFingerprint = new Map();
    sourceList.filter(s => s?.fingerprint).forEach(source => { const list = byFingerprint.get(source.fingerprint) || []; list.push(source); byFingerprint.set(source.fingerprint, list); });
    const out = clone(Array.isArray(entries) ? entries : []);
    const summary = { cleaned: 0, remapped: 0, lockedMissing: 0, pending: 0, changed: false };
    for (const entry of out) {
        const anchor = entry?.起始锚;
        if (!anchor || typeof anchor !== 'object') continue;
        const fingerprint = String(anchor.来源指纹 || '').trim();
        if (fingerprint) {
            const candidates = byFingerprint.get(fingerprint) || [];
            if (candidates.length) {
                const source = candidates.length === 1 ? candidates[0] : candidates.find(candidate => candidate.floor === anchor.楼层);
                if (!source) { if (entry.来源状态 !== '待确认') { entry.来源状态 = '待确认'; summary.pending++; summary.changed = true; } continue; }
                if (anchor.楼层 !== source.floor) { anchor.楼层 = source.floor; summary.remapped++; summary.changed = true; }
                if (entry.来源状态) { delete entry.来源状态; summary.changed = true; }
                continue;
            }
            if (entry.锁 === '用户锁') {
                const changed = anchor.楼层 !== null || entry.来源状态 !== '来源已删除';
                anchor.楼层 = null; entry.来源状态 = '来源已删除'; if (changed) { summary.lockedMissing++; summary.changed = true; }
            } else { entry.__reconcileDelete = true; summary.cleaned++; summary.changed = true; }
            continue;
        }
        const rawFloor = anchor.楼层;
        if (rawFloor === null || rawFloor === undefined || String(rawFloor).trim() === '') continue;
        const floor = Number(rawFloor);
        if (!validFloor(floor) || floor >= Number(chatLength || 0)) {
            if (entry.锁 === '用户锁') {
                const changed = anchor.楼层 !== null || entry.来源状态 !== '来源已删除';
                anchor.楼层 = null; entry.来源状态 = '来源已删除'; if (changed) { summary.lockedMissing++; summary.changed = true; }
            } else { entry.__reconcileDelete = true; summary.cleaned++; summary.changed = true; }
        } else if (floor !== null && Number.isFinite(floor)) {
            if (entry.来源状态 !== '待确认') { entry.来源状态 = '待确认'; summary.changed = true; }
            summary.pending++;
        }
    }
    const kept = out.filter(entry => !entry.__reconcileDelete);
    kept.forEach(entry => { delete entry.__reconcileDelete; });
    return { entries: kept, summary };
}

export function buildLedgerSources(records = []) {
    return (records || []).flatMap(record => (record.sources || []).map(source => ({
        ...source,
        fingerprint: source.fingerprint || ledgerSourceFingerprint(source.token, source.signature || record.signature),
    })));
}
