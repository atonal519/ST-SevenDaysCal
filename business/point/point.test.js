import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAbortController } from './controller.js';

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
