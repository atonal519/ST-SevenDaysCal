import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLinesResponse, parseLines } from './schema.js';
import { mergePinned } from './mutations.js';
import { createAdvanceStrategy, classifyRenderedFloor, chooseSwipeLayer, activeLines } from './strategy.js';
import { prefixNext } from './inline.js';
import { createLinesGenerationController } from './controller.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';

const strict = '<storylines_widget>\nLine: 主线|冲突|萌芽|1|今天|world|false|true\nDesc: 当前\nNext: 继续\n</storylines_widget>';
const legacy5 = 'Line: 旧线|冲突|萌芽|1|今天\nDesc: 旧状态\nNext: 旧下一步';
const legacy7 = 'Line: 旧线|冲突|萌芽|1|今天|world|true\nDesc: 旧状态\nNext: 旧下一步';

test('strict output clears AI pin while legacy 5/7/8 fields remain readable', () => {
    assert.equal(validateLinesResponse(strict).ok, true);
    assert.equal(validateLinesResponse(strict).model[0].pin, false);
    assert.equal(parseLines(legacy5).length, 1);
    assert.equal(parseLines(legacy7).length, 1);
    assert.equal(parseLines(strict).length, 1);
});

test('pinned merge retains old lock and rejects over-capacity result', () => {
    const old = parseLines(strict)[0];
    const fresh = Array.from({ length: 6 }, (_, i) => `Line: n${i}|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n`).join('\n');
    const result = mergePinned(strict, `<storylines_widget>\n${fresh}\n</storylines_widget>`);
    assert.equal(result.ok, false);
    assert.equal(old.pin, true);
});

test('advance strategy preserves first observation, accumulation and manual gate', () => {
    assert.deepEqual(createAdvanceStrategy({ mode: 'turns', interval: 2, counter: 0 }), { shouldAdvance: false, counter: 1 });
    assert.deepEqual(createAdvanceStrategy({ mode: 'turns', interval: 2, counter: 1 }), { shouldAdvance: true, counter: 0 });
    assert.equal(createAdvanceStrategy({ mode: 'manual', interval: 1, counter: 0 }).shouldAdvance, false);
    assert.equal(createAdvanceStrategy({ mode: 'days', dayAnchor: '2-3', previousDay: '2-2' }).shouldAdvance, true);
});

test('render strategy distinguishes reroll, swipe and stored layer', () => {
    assert.equal(classifyRenderedFloor({ messageId: 2, lastSeen: 2, contentChanged: true }).shouldRebuild, true);
    assert.deepEqual(chooseSwipeLayer({ pendingGeneration: true, swipeId: 1 }), { action: 'wait', swipeId: 1 });
    assert.deepEqual(chooseSwipeLayer({ swipeId: 1, stored: { swipes: { '1': 'raw' } }, baseline: 'base' }), { action: 'restore', raw: 'raw' });
});

test('active filter and inline prefix preserve terminal and stall semantics', () => {
    assert.equal(activeLines(strict).length, 1);
    assert.equal(prefixNext('**下一步：** 继续', false), '下一步：继续');
    assert.equal(prefixNext('恢复条件：解除', true), '恢复条件：解除');
});

test('generation controller commits success and rejects invalid or missing API without writing', async () => {
    let saved = { raw: strict, ts: 1 };
    let writes = 0;
    const make = (config, response) => createLinesGenerationController({
        owners: createTaskOwnerManager(), chatId: () => 'chat-1', loadConfig: () => config,
        readSaved: () => saved, buildPrompt: () => 'prompt', callApi: async () => response,
        commit: raw => { saved = { raw, ts: 2 }; writes++; }, cleanup: owner => owner.status = 'finished',
    });
    assert.equal((await make({ url: 'u', key: 'k' }, strict).run()).status, 'updated');
    assert.equal(writes, 1);
    assert.equal((await make({ url: 'u', key: 'k' }, 'bad').run()).status, 'failed');
    assert.equal((await make({}, strict).run()).status, 'failed');
    assert.equal(writes, 1);
});
