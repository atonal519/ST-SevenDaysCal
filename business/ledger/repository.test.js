import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCapturePlanAtomic, applyJudgePatchesAtomic, normalizeEntry } from './repository.js';
import { parseLedgerCaptureDetailed } from './schema.js';

test('刻度“待办”别名归入约定待办类型', () => {
    const parsed = parseLedgerCaptureDetailed('归还借书｜待办｜林｜借书｜已约定明日归还。｜｜｜SET\n未知事项｜其他｜林｜杂项｜待核实。｜｜｜SET');
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].类型, '约定待办');
    assert.equal(parsed.rejected.length, 1, '未知类别只忽略该行，不误归成另一种刻度类型');
});

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
