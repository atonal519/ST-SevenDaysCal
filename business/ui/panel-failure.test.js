import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelFailureStore, createPanelFailureRecency } from './panel-failure.js';

test('panel failure notes are target-scoped, escaped, and runtime-only', () => {
    const notes = createPanelFailureStore({ escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
    const first = { chatId: 'a', revision: 1 };
    const second = { chatId: 'a', revision: 2 };
    notes.set('point', first, '失败 <详情>');
    assert.equal(notes.html('point', second), '');
    assert.equal(notes.html('point', first), '<div class="sp-panel-failure-hint" role="status">失败 &lt;详情&gt;</div>');
    assert.equal(notes.clear('point', second), false);
    assert.equal(notes.text('point', first), '失败 <详情>');
    assert.equal(notes.clear('point', first), true);
    assert.equal(notes.text('point', first), '');
});

test('panel failure recency renders one latest slot and clearing it does not resurrect older failures', () => {
    const store = createPanelFailureStore();
    const latest = createPanelFailureRecency(store);
    const target = 'chat-A';
    latest.set('axis', 'axis-generation', target, '上次轴生成失败');
    latest.set('axis', 'axis-date', target, '上次日期判定失败');
    assert.match(latest.html('axis', target), /上次日期判定失败/);
    assert.doesNotMatch(latest.html('axis', target), /上次轴生成失败/);
    assert.equal(latest.clear('axis', 'axis-date', target), true);
    assert.equal(latest.html('axis', target), '');
});
