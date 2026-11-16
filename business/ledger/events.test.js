import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLedgerEvents, finalizeLedgerCapturePanel, finalizeLedgerJudgePanel } from './events.js';

test('capture consumer render failure uses the short saved-data feedback', () => {
    const failures = [], toasts = [];
    let renders = 0;
    const result = finalizeLedgerCapturePanel({ status: 'updated', added: 1 }, {
        setFailure: message => failures.push(message),
        render: () => { renders++; throw new Error('synthetic post-capture panel render'); },
        toast: message => toasts.push(message),
    });
    assert.equal(result.status, 'updated');
    assert.match(result.uiError.message, /synthetic post-capture panel render/);
    assert.deepEqual(failures, ['内容已更新，界面刷新失败']);
    assert.deepEqual(toasts, ['内容已更新，界面刷新失败']);
    assert.equal(renders, 1);
});

test('judge consumer render failure is UI feedback while business statuses keep their meaning', () => {
    const failures = [], toasts = [];
    const finalize = result => finalizeLedgerJudgePanel(result, {
        formatFailure: (feedback, current) => current?.uiError ? feedback.message : `上次刻度判定失败：${feedback.message}`,
        setFailure: message => failures.push(message), clearFailure: () => failures.push('cleared'),
        render: () => { throw new Error('synthetic judge consumer render failure'); },
        toast: message => toasts.push(message), clearOnSuccess: true,
    });
    const updated = finalize({ status: 'updated', applied: ['L1'] });
    assert.equal(updated.status, 'updated');
    assert.match(updated.uiError.message, /synthetic judge consumer render failure/);
    assert.deepEqual(failures, ['cleared', '内容已更新，界面刷新失败']);
    assert.deepEqual(toasts, ['内容已更新，界面刷新失败']);

    failures.length = 0; toasts.length = 0;
    const priorUiError = { status: 'updated', uiError: new Error('controller UI error') };
    assert.equal(finalizeLedgerJudgePanel(priorUiError, {
        formatFailure: (feedback, current) => current?.uiError ? feedback.message : `上次刻度判定失败：${feedback.message}`,
        setFailure: message => failures.push(message), render: () => {}, toast: message => toasts.push(message),
    }), priorUiError);
    assert.deepEqual(failures, ['内容已更新，界面刷新失败']);
    assert.deepEqual(toasts, []);

    failures.length = 0;
    const failed = finalize({ status: 'failed', reason: 'judge-save-failed', error: new Error('save') });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.uiError, undefined);
    assert.match(failures[0], /^上次刻度判定失败：/);
    const beforeCancel = failures.length;
    const cancelled = finalize({ status: 'cancelled', reason: 'manual-abort' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.uiError, undefined);
    assert.equal(failures.length, beforeCancel);
});

test('manual capture finally refresh errors do not replace updated or emit success feedback', async () => {
    const handlers = new Map(), toasts = [];
    const chain = new Proxy({}, { get: (_target, key) => key === 'length' ? 0 : () => chain });
    const button = {};
    let refreshes = 0, renders = 0;
    const almanac = {
        off() {},
        on(name, selector, handler) { handlers.set(selector, handler); },
    };
    bindLedgerEvents({
        almanac, $: () => chain,
        capture: { run: async () => ({ status: 'updated', added: 1, feedbackShown: true }) },
        judge: { run: async () => ({ status: 'unchanged' }) },
        captureState: () => ({ busy: false }),
        identity: () => ({ chatId: 'capture-chat' }), isCurrentIdentity: () => true,
        refreshInline: () => { refreshes++; throw new Error('synthetic inline refresh failure'); },
        render: () => { renders++; throw new Error('synthetic final panel render failure'); },
        toast: message => toasts.push(message),
        editor: { save() {}, close() {} }, archive: { toggle() {} },
        actions: { toggleLock() {}, toggleMute() {}, close() {}, reopen() {}, remove() {} },
        batch: { scopes: [], selected: () => new Set(), ids: () => [], scope: () => null, setScope() {}, reset() {}, exec() {} },
    });
    const handler = handlers.get('.sp-ledger-capture-now');
    const result = await handler.call(button);
    assert.equal(result.status, 'updated');
    assert.match(result.uiError.message, /synthetic inline refresh failure/);
    assert.equal(refreshes, 1);
    assert.equal(renders, 1);
    assert.deepEqual(toasts, ['内容已更新，界面刷新失败']);
});

test('ledger inline binder can be registered for each shadow root', () => {
    const handlers = new Map();
    const roots = [];
    const makeTarget = name => ({ name, off() {}, on(event, selector, handler) { handlers.set(`${name}:${selector}`, handler); } });
    bindLedgerEvents({
        almanac: makeTarget('panel'), $: () => ({
            off() {}, on() {}, closest() { return { attr: () => 'id' }; }, attr() {},
        }),
        bindInlineRoots: binder => roots.push(binder),
        capture: { run: async () => ({ status: 'unchanged' }) }, judge: { run: async () => ({ status: 'unchanged' }) },
        captureState: () => ({ busy: false }), identity: () => ({}), isCurrentIdentity: () => true,
        actions: { toggleLock() {}, toggleMute() {}, close() {} }, editor: { open() {}, save() {}, close() {} },
        archive: { toggle() {} }, batch: { scopes: [], selected: () => new Set(), ids: () => [], scope: () => null },
    });
    assert.equal(roots.length, 1);
    roots[0](makeTarget('shadow-a'));
    roots[0](makeTarget('shadow-b'));
    assert.ok(handlers.has('shadow-a:.sp-inline-ledger-close'));
    assert.ok(handlers.has('shadow-b:.sp-inline-ledger-close'));
});

test('re-binding one inline root replaces its handlers instead of duplicating actions', () => {
    const active = new Map();
    const target = {
        off() { active.clear(); },
        on(_event, selector, handler) { active.set(selector, handler); },
    };
    let roots;
    bindLedgerEvents({
        almanac: { off() {}, on() {} }, $: () => ({ off() {}, on() {} }),
        bindInlineRoots: binder => { roots = binder; },
        capture: { run: async () => ({ status: 'unchanged' }) }, judge: { run: async () => ({ status: 'unchanged' }) },
        captureState: () => ({ busy: false }), identity: () => ({}), isCurrentIdentity: () => true,
        actions: { toggleLock() {}, toggleMute() {}, close() {} }, editor: { open() {}, save() {}, close() {} },
        archive: { toggle() {} }, batch: { scopes: [], selected: () => new Set(), ids: () => [], scope: () => null },
    });
    roots(target);
    roots(target);
    assert.equal(active.size, 5);
});
