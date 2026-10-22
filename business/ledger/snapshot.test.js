import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerSnapshotBridge } from './snapshot.js';

test('AI floor capture returns and writes only the current two cold-knowledge texts', () => {
    const cold = ['当楼冷知识甲', '当楼冷知识乙', '不应冻结的第三条'];
    let saved = null, coldReads = 0;
    const bridge = createLedgerSnapshotBridge({
        context: () => ({ chat: [{ is_user: false }] }),
        readCold: () => { coldReads++; return cold; },
        today: () => ({ month: 1, day: 2 }),
        cloneCalendar: () => ({ kind: 'test' }),
        write: (_id, value) => { saved = value; return true; },
    });

    const frozen = bridge.freeze(0);
    assert.equal(coldReads, 1);
    assert.deepEqual(saved.cold, cold.slice(0, 2));
    assert.deepEqual(frozen.cold, cold.slice(0, 2));

    const hiddenBridge = createLedgerSnapshotBridge({});
    assert.equal(Object.hasOwn(hiddenBridge.capture(), 'cold'), false, 'when the display is disabled, capture leaves the field untouched');
});
