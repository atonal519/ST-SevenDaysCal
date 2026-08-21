export function baselineFor(saved, { replace = false } = {}) {
    const raw = typeof saved?.raw === 'string' ? saved.raw : '';
    return { raw, ts: Number(saved?.ts) || null };
}

export function decideLinesCommit({ ownerCurrent, validation, baseline, latest } = {}) {
    if (!ownerCurrent) return { ok: false, reason: 'stale-owner' };
    if (!validation?.ok) return { ok: false, reason: validation?.reason || 'invalid-output' };
    if ((latest?.raw || '') !== (baseline?.raw || '') || (Number(latest?.ts) || null) !== (baseline?.ts ?? null)) return { ok: false, reason: 'stale-baseline' };
    return { ok: true };
}
