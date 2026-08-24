import { reconcileLedgerEntries } from './reconcile.js';

const clone = value => JSON.parse(JSON.stringify(value));
const numericPlanSummary = summary => Object.freeze({
    cleaned: Number(summary?.cleaned) || 0, remapped: Number(summary?.remapped) || 0,
    pending: Number(summary?.pending) || 0, lockedMissing: Number(summary?.lockedMissing) || 0,
    kept: Number(summary?.kept) || 0, deleted: Number(summary?.deleted ?? summary?.cleaned) || 0,
});
function validateLedgerIdentity(entries, seq, beforeIds = null) {
    const list = Array.isArray(entries) ? entries : [];
    const ids = list.map(entry => String(entry?.id || ''));
    if (ids.some(id => !/^L\d+$/.test(id)) || new Set(ids).size !== ids.length) return false;
    const max = ids.reduce((n, id) => Math.max(n, Number(id.slice(1))), 0);
    if (seq !== undefined && (!Number.isInteger(seq) || seq < max)) return false;
    // 删除是合法 disposition；调用方在计划阶段另行熔断非空→空，不能要求所有原 ID 都保留。
    return true;
}
export async function handleUnknownPersistence(saved, restore, compensate) {
    if (saved?.commitState !== 'unknown') return saved;
    const confirmation = await saved.confirm?.();
    restore();
    if (confirmation?.submitted === false) {
        throw Object.assign(new Error('persistence-not-committed'), { phase: 'persistence-not-committed', confirmed: false, submitted: false });
    }
    if (confirmation?.submitted === true || confirmation?.confirmed === true) {
        try { const rollback = await compensate?.(); if (rollback?.ok === false || rollback?.commitState === 'unknown') throw Object.assign(new Error('rollback-save-failed'), { phase: 'rollback-save-failed' }); }
        catch (error) { error.phase = 'rollback-save-failed'; throw error; }
        throw Object.assign(new Error('persistence-unknown'), { phase: 'persistence-unknown', confirmed: true });
    }
    if (confirmation?.available === false || !confirmation) throw Object.assign(new Error('persistence-unknown'), { phase: 'persistence-unknown', submitted: null });
    throw Object.assign(new Error('persistence-unknown'), { phase: 'persistence-unknown', submitted: null });
}

async function compensateAndThrow(original, restore, compensate) {
    restore();
    try {
        const rollback = await compensate?.();
        if (rollback?.ok === false || rollback?.commitState === 'unknown') throw Object.assign(new Error('rollback-save-failed'), { phase: 'rollback-save-failed' });
    } catch (error) { error.phase = 'rollback-save-failed'; throw error; }
    throw original;
}
export async function reconcileStateAtomic(state, sources, chatLength, save, normalize = value => value, guard = () => true) {
    if (!guard()) throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' });
    const before = clone(state.entries);
    const beforeSeq = state.seq;
    const beforeIds = before.map(entry => String(entry?.id || ''));
    if (!validateLedgerIdentity(before, beforeSeq)) throw Object.assign(new Error('source-state-invalid'), { phase: 'source-state-invalid' });
    const result = reconcileLedgerEntries(state.entries, sources, chatLength);
    const planSummary = numericPlanSummary({ ...result.summary, kept: result.entries.length });
    const fail = (message, phase) => Object.assign(new Error(message), { phase, planSummary });
    if (!result.summary.changed) return result;
    if (before.length > 0 && result.entries.length === 0) throw fail('source-plan-empty-fuse', 'source-state-invalid');
    const dispositions = result.summary.dispositions || {};
    if (new Set(Object.keys(dispositions)).size !== before.length || before.some(entry => !['keep', 'remap', 'pending', 'delete'].includes(dispositions[entry?.id]))) throw fail('source-plan-disposition-invalid', 'source-state-invalid');
    if (!guard()) { state.entries = before; throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' }); }
    const planned = clone({ entries: result.entries.map((entry, i) => normalize(entry, entry.id || `L${i + 1}`)), seq: state.seq });
    try {
        state.entries = clone(planned.entries);
        if (!validateLedgerIdentity(state.entries, state.seq)) throw fail('source-plan-invalid', 'source-state-invalid');
        if (!guard()) { state.entries = before; throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' }); }
        const saved = await save?.(guard);
        if (saved?.commitState === 'unknown') await handleUnknownPersistence(saved, () => { state.entries = before; state.seq = beforeSeq; }, () => save?.(() => true, { compensate: true }));
        if (saved && saved.ok === false) throw Object.assign(new Error(saved.reason || 'source-save-failed'), { phase: 'source-save-failed', saveResult: saved });
        const postSaveError = !validateLedgerIdentity(state.entries, state.seq)
            ? fail('source-state-invalid', 'source-state-invalid')
            : JSON.stringify({ entries: state.entries, seq: state.seq }) !== JSON.stringify(planned)
                ? fail('source-plan-invalid', 'source-state-invalid') : null;
        if (postSaveError) await compensateAndThrow(postSaveError, () => { state.entries = before; state.seq = beforeSeq; }, () => save?.(() => true, { compensate: true }));
        if (!guard()) {
            if (saved?.commitState === 'legacy-unconfirmed') {
                state.entries = before; state.seq = beforeSeq;
                throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat', saveResult: saved });
            }
            await compensateAndThrow(fail('source-stale-chat', 'source-stale-chat'), () => { state.entries = before; state.seq = beforeSeq; }, () => save?.(() => true, { compensate: true }));
        }
        return result;
    }
    catch (error) { state.entries = before; state.seq = beforeSeq; error.phase ||= 'source-save-failed'; error.planSummary ||= planSummary; throw error; }
}
