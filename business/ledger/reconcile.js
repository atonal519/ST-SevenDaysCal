// 刻度来源校对：只做确定性来源匹配，不访问 API、不解释日期。
function stableSourceBody(signature) {
    return String(signature || '')
        .replace(/<!--\s*SDC-(?:start|end)\b[^>]*-->/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function legacySourceFingerprint(token, signature) {
    const side = String(token || '').trim().endsWith('E') ? 'E' : 'S';
    const text = `${side}\n${String(signature || '')}`;
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return `lfp-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function ledgerSourceFingerprint(token, signature, identity = {}) {
    const raw = String(token || '').trim();
    const side = raw.endsWith('E') ? 'E' : 'S';
    const tokenFloor = raw.match(/^F(\d+)[SE]$/i)?.[1];
    const dateMatch = String(signature || '').match(/(\d+)月(\d+)日/);
    const date = identity?.date && Number.isFinite(+identity.date.month) && Number.isFinite(+identity.date.day)
        ? `${identity.date.month}/${identity.date.day}` : dateMatch ? `${dateMatch[1]}/${dateMatch[2]}` : '';
    const floor = Number.isInteger(+identity?.floor) ? String(identity.floor) : tokenFloor || '';
    return `sfp-${legacySourceFingerprint(side, `${floor}|${date}|${stableSourceBody(signature)}`).slice(4)}`;
}

export function legacyLedgerSourceFingerprint(token, signature) {
    return legacySourceFingerprint(token, signature);
}

const validFloor = floor => Number.isInteger(floor) && floor >= 0;
const clone = value => JSON.parse(JSON.stringify(value));

export function reconcileLedgerEntries(entries, sources = [], chatLength = 0) {
    const sourceList = Array.isArray(sources) ? sources : [];
    const byFingerprint = new Map(), byLegacyFingerprint = new Map();
    sourceList.filter(s => s?.fingerprint).forEach(source => { const list = byFingerprint.get(source.fingerprint) || []; list.push(source); byFingerprint.set(source.fingerprint, list); });
    sourceList.filter(s => s?.legacyFingerprint).forEach(source => { const list = byLegacyFingerprint.get(source.legacyFingerprint) || []; list.push(source); byLegacyFingerprint.set(source.legacyFingerprint, list); });
    const out = clone(Array.isArray(entries) ? entries : []);
    const summary = { cleaned: 0, remapped: 0, lockedMissing: 0, pending: 0, changed: false, dispositions: {} };
    const originalAnchors = new Map(out.map(entry => [entry?.id, clone(entry?.起始锚)]));
    for (const entry of out) {
        const anchor = entry?.起始锚;
        if (!anchor || typeof anchor !== 'object') continue;
        const fingerprint = String(anchor.来源指纹 || '').trim();
        if (fingerprint) {
            let candidates = byFingerprint.get(fingerprint) || [];
            let legacyResign = false;
            if (!candidates.length && validFloor(Number(anchor.楼层)) && anchor.历日期) {
                const stableCandidates = sourceList.filter(source => {
                    const token = String(source?.token || '').replace(/^F\d+([SE])$/i, `F${anchor.楼层}$1`);
                    return token !== source?.token && ledgerSourceFingerprint(token, source.signature, { floor: Number(anchor.楼层), date: source.date }) === fingerprint
                        && source.date && Number(source.date.month) === Number(anchor.历日期.month) && Number(source.date.day) === Number(anchor.历日期.day);
                });
                candidates = stableCandidates.length ? stableCandidates : /^lfp-/i.test(fingerprint) ? sourceList.filter(source => {
                    return Number(source?.floor) === Number(anchor.楼层)
                        && source.date && Number(source.date.month) === Number(anchor.历日期.month) && Number(source.date.day) === Number(anchor.历日期.day);
                }) : [];
                legacyResign = /^lfp-/i.test(fingerprint) && !stableCandidates.length && candidates.length > 0;
            }
            if (!candidates.length) {
                candidates = byLegacyFingerprint.get(fingerprint) || [];
                legacyResign = candidates.length > 0;
            }
            if (candidates.length) {
                const source = candidates.length === 1 ? candidates[0] : candidates.find(candidate => candidate.floor === anchor.楼层);
                const sameDate = source && anchor.历日期 && source.date && Number(anchor.历日期.month) === Number(source.date.month) && Number(anchor.历日期.day) === Number(source.date.day);
                if (!source || (legacyResign && (!sameDate || candidates.length !== 1 || source.floor !== anchor.楼层))) { if (entry.来源状态 !== '待确认') { entry.来源状态 = '待确认'; summary.pending++; summary.changed = true; } continue; }
                if (anchor.楼层 !== source.floor) { anchor.楼层 = source.floor; summary.remapped++; summary.changed = true; }
                if ((legacyResign || anchor.来源指纹 !== source.fingerprint) && source.fingerprint && anchor.来源指纹 !== source.fingerprint) { anchor.来源指纹 = source.fingerprint; summary.resigned = (summary.resigned || 0) + 1; summary.changed = true; }
                if (entry.来源状态) { delete entry.来源状态; summary.changed = true; }
                continue;
            }
            if (entry.锁 === '用户锁') {
                const changed = anchor.楼层 !== null || entry.来源状态 !== '来源已删除';
                anchor.楼层 = null; entry.来源状态 = '来源已删除'; if (changed) { summary.lockedMissing++; summary.changed = true; }
            } else if (validFloor(Number(anchor.楼层)) && Number(anchor.楼层) >= Number(chatLength || 0)) {
                entry.__reconcileDelete = true; summary.cleaned++; summary.changed = true;
            } else if (entry.来源状态 !== '待确认') { entry.来源状态 = '待确认'; summary.pending++; summary.changed = true; }
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
    const keptIds = new Set(kept.map(entry => entry?.id));
    for (const entry of out) {
        const id = entry?.id;
        if (!id) continue;
        if (!keptIds.has(id)) summary.dispositions[id] = 'delete';
        else if (entry.来源状态 === '待确认') summary.dispositions[id] = 'pending';
        else if (entry.来源状态 === '来源已删除') summary.dispositions[id] = 'keep';
        else if (Number(originalAnchors.get(id)?.楼层) !== Number(entry?.起始锚?.楼层)) summary.dispositions[id] = 'remap';
        else summary.dispositions[id] = 'keep';
    }
    return { entries: kept, summary };
}

export function buildLedgerSources(records = []) {
    return (records || []).flatMap(record => (record.sources || []).map(source => ({
        ...source,
        fingerprint: source.fingerprint || ledgerSourceFingerprint(source.token, source.signature || record.signature, { floor: source.floor ?? record.floor, date: source.date }),
        legacyFingerprint: source.legacyFingerprint || legacySourceFingerprint(source.token, source.signature || record.signature),
    })));
}
