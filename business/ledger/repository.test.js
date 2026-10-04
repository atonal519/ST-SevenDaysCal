import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCapturePlanAtomic, applyJudgePatchesAtomic, normalizeEntry } from './repository.js';

test('ledger atomic operations preserve the persistence commit state', async () => {
    const state = { entries: [], seq: 0 };
    const local = await applyCapturePlanAtomic({ additions: [{ 事由: 'local event', 现状: 'local status' }] }, null, {
        state, context: {}, save: async () => ({ ok: true, commitState: 'local-applied' }),
    });
    assert.equal(local.commitState, 'local-applied');
    assert.equal(local.added.length, 1);

    const entry = normalizeEntry({ id: 'L1', 事由: 'external event', 现状: 'before' }, 'L1');
    const externalState = { entries: [entry], seq: 1 };
    const confirmed = await applyJudgePatchesAtomic([{ id: 'L1', patch: { 现状: 'after' } }], null, {
        state: externalState, context: {}, save: async () => ({ ok: true, commitState: 'confirmed' }),
    });
    assert.equal(confirmed.commitState, 'confirmed');
});
