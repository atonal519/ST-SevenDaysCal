import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerCaptureController, bindLedgerCapture } from './capture.js';
import { createLedgerJudgeController } from './judge.js';

test('刻度 judge local apply survives a renderer exception and returns a UI error', async () => {
    const writes = [], toasts = [];
    const context = () => ({ chatId: 'ledger-chat', name1: 'User', name2: 'Character', chat: [] });
    let applied = false;
    const controller = createLedgerJudgeController({
        context, charKey: () => 'character', listJudgeable: () => [{ id: 'L1', 事由: 'event', 类型: '持续状态', 现状: 'before' }],
        config: () => ({ url: 'fixture', key: 'fixture' }), calendar: () => null, validDate: () => null,
        today: () => ({ month: 1, day: 1 }), floorContext: () => ({ floor: null, date: null }),
        appendTravel: prompt => prompt, callApi: async () => 'fixture',
        parseJudge: () => ({ status: 'ok', changes: [{ id: 'L1', 动作: '维持', 现状: 'after' }] }),
        getEntry: () => ({ id: 'L1', 事由: 'event', 状态: '活跃', 锁: '', 来源状态: '' }),
        applyAtomic: async changes => { writes.push(changes); applied = true; return { ok: true, commitState: 'local-applied' }; },
        reconcile: async () => ({ summary: { changed: false } }), settings: () => ({ notifyMode: 'off' }),
        refreshInject: () => {}, refreshInline: () => {}, render: () => { if (applied) throw new Error('synthetic judge UI failure'); },
        toast: message => toasts.push(message),
    });
    const result = await controller.run(true);
    assert.equal(result.status, 'updated');
    assert.match(result.uiError.message, /synthetic judge UI failure/);
    assert.equal(writes.length, 1);
    assert.ok(toasts.includes('内容已更新，界面刷新失败'));
});

test('刻度 capture local apply survives a refresh exception and does not repeat generation', async () => {
    const context = () => ({ chatId: 'capture-chat', name1: 'User', name2: 'Character', chat: [] });
    bindLedgerCapture({ context, parseClock: () => ({}), parseDate: () => null, stripTags: value => value, settings: () => ({}) });
    const writes = [], toasts = [];
    let refreshes = 0, apiCalls = 0;
    const controller = createLedgerCaptureController({
        context, charKey: () => 'character', target: () => null, config: () => ({ url: 'fixture', key: 'fixture' }),
        appendTravel: prompt => prompt, validDate: () => null, floorContext: () => ({ floor: null, date: null }), today: () => ({ month: 1, day: 1 }),
        ledgerBaselineEmpty: () => true, listEntries: () => [], settings: () => ({ notifyMode: 'off' }),
        callApi: async () => { apiCalls++; return 'fixture'; },
        parseCapture: () => [{ 事由: '归还借书', 类型: '约定待办', 牵扯: ['User'], 标签: ['借书'], 现状: '已约定明日归还。', _sourceToken: 'SET' }],
        addAtomic: async additions => { writes.push(additions); return additions.map((item, index) => ({ ...item, id: `L${index + 1}` })); },
        refresh: () => { refreshes++; throw new Error('synthetic capture refresh failure'); }, refreshInline: () => {}, render: () => {},
        toast: message => toasts.push(message),
    });
    const result = await controller.run(false);
    assert.equal(result.status, 'updated');
    assert.match(result.uiError.message, /synthetic capture refresh failure/);
    assert.equal(apiCalls, 1);
    assert.equal(writes.length, 1);
    assert.ok(toasts.includes('内容已更新，界面刷新失败'));
});
