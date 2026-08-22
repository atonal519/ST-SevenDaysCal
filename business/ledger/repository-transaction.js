import { reconcileLedgerEntries } from './reconcile.js';

const clone = value => JSON.parse(JSON.stringify(value));
export async function reconcileStateAtomic(state, sources, chatLength, save, normalize = value => value, guard = () => true) {
    if (!guard()) throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' });
    const before = clone(state.entries);
    const result = reconcileLedgerEntries(state.entries, sources, chatLength);
    if (!result.summary.changed) return result;
    if (!guard()) { state.entries = before; throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' }); }
    try {
        state.entries = result.entries.map((entry, i) => normalize(entry, entry.id || `L${i + 1}`));
        if (!guard()) { state.entries = before; throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' }); }
        await save?.(guard);
        if (!guard()) {
            state.entries = before;
            try { await save?.(() => true, { compensate: true }); } catch (rollbackError) { rollbackError.phase = 'rollback-save-failed'; throw rollbackError; }
            throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' });
        }
        return result;
    }
    catch (error) { state.entries = before; error.phase ||= 'source-save-failed'; throw error; }
}
