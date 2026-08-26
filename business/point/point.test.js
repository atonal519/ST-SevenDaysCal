import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAbortController } from './controller.js';
import { editPointDescription, editPointFields } from './mutations.js';

test('point description edit normalizes, clears, rejects ASCII pipe, and preserves surrounding raw text', () => {
    const raw = '前言\n<calendar_widget>\nDay: 1\nEvent: main|标题|旧描述|早晨|地点|动态|true\nUnknown: keep\nDay: 2\nEvent: char|另一个|二号|夜晚|房间|线头|false\n</calendar_widget>\n尾注';
    const edited = editPointDescription(raw, 1, 0, ' 新描述\n  多空白 ');
    assert.equal(edited.ok, true); assert.match(edited.raw, /Event: char\|另一个\|新描述 多空白\|夜晚\|房间\|线头\|false/); assert.match(edited.raw, /Unknown: keep/); assert.match(edited.raw, /前言/); assert.match(edited.raw, /尾注/);
    const cleared = editPointDescription(edited.raw, 1, 0, ''); assert.equal(cleared.ok, true); assert.match(cleared.raw, /Event: char\|另一个\|\|夜晚/);
    assert.equal(editPointDescription(raw, 0, 0, '坏|值').reason, 'pipe');
});

test('point generation separates AbortController state from native AbortSignal API input', () => {
    const controller = new AbortController();
    const { controller: saved, signal } = splitAbortController(controller);
    assert.equal(saved, controller);
    assert.equal(signal, controller.signal);
    assert.equal(typeof signal.addEventListener, 'function');
    let aborted = false;
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    controller.abort();
    assert.equal(aborted, true);
    assert.equal(signal.aborted, true);
});

test('point controller rejects a controller-shaped signal before API invocation', () => {
    assert.throws(() => splitAbortController({ abort() {}, signal: {} }), /原生 AbortController/);
});

test('point combined edit updates desc and npcAction atomically', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|标题|旧描述|早晨|地点|旧动态|true\n</calendar_widget>';
    const result = editPointFields(raw, 0, 0, { desc: ' 新描述 ', npcAction: ' 新动态 ' });
    assert.equal(result.ok, true); assert.match(result.raw, /Event: main\|标题\|新描述\|早晨\|地点\|新动态\|true/);
});
