import { reconcileLedgerEntries } from './reconcile.js';

const clone = value => JSON.parse(JSON.stringify(value));
export async function reconcileStateAtomic(state, sources, chatLength, save, normalize = value => value) {
    const before = clone(state.entries);
    const result = reconcileLedgerEntries(state.entries, sources, chatLength);
    if (!result.summary.changed) return result;
    try { state.entries = result.entries.map((entry, i) => normalize(entry, entry.id || `L${i + 1}`)); await save?.(); return result; }
    catch (error) { state.entries = before; throw error; }
}
