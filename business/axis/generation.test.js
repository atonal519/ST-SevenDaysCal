import test from 'node:test';
import assert from 'node:assert/strict';
import { axisState } from './state.js';
import { createAxisGenerationController } from './generation.js';

test('axis generation and calendar supplement retain a local save and surface UI failure', async () => {
    for (const supplement of [false, true]) {
        axisState.almanacAbortController = null;
        axisState.isGeneratingAlmanac = false;
        const writes = [], failures = [], toasts = [];
        let apiCalls = 0;
        const controller = createAxisGenerationController({
            context: () => ({ chatId: 'axis-chat', name1: 'User', name2: 'Character' }),
            config: () => ({ url: 'fixture', key: 'fixture' }),
            callApi: async () => { apiCalls++; return '<almanac_widget>fixture</almanac_widget>'; },
            prompt: () => 'prompt', supplementPrompt: () => 'supplement prompt',
            validate: () => true, parse: () => [{ type: 'anniversary', name: 'fixture' }],
            loadItems: () => [], dedupKey: item => item.name, merge: (_old, next) => next,
            saveItems: async items => { writes.push(items); return { ok: true, commitState: 'local-applied' }; },
            sync: () => {}, render: () => { if (writes.length) throw new Error('synthetic panel render failure'); },
            notify: () => {}, failure: message => failures.push(message), toast: message => toasts.push(message),
        });
        const result = await controller.run(supplement);
        assert.equal(result.status, 'updated');
        assert.match(result.uiError.message, /synthetic panel render failure/);
        assert.equal(apiCalls, 1);
        assert.equal(writes.length, 1);
        assert.equal(failures[0], '内容已更新，界面刷新失败');
        assert.ok(toasts.includes('内容已更新，界面刷新失败'));
    }
    axisState.almanacAbortController = null;
    axisState.isGeneratingAlmanac = false;
});

test('axis clear-failure panel render after local apply stays updated', async () => {
    axisState.almanacAbortController = null;
    axisState.isGeneratingAlmanac = false;
    const writes = [], failures = [], toasts = [];
    let apiCalls = 0;
    const controller = createAxisGenerationController({
        context: () => ({ chatId: 'axis-clear-chat', name1: 'User', name2: 'Character' }),
        config: () => ({ url: 'fixture', key: 'fixture' }),
        callApi: async () => { apiCalls++; return '<almanac_widget>fixture</almanac_widget>'; },
        prompt: () => 'prompt', validate: () => true, parse: () => [{ type: 'holiday', name: 'fixture' }],
        loadItems: () => [], merge: (_old, next) => next,
        saveItems: async items => { writes.push(items); return { ok: true, commitState: 'local-applied' }; },
        sync: () => {}, render: () => {}, notify: () => {},
        clearFailure: () => { if (writes.length) throw new Error('synthetic clear failure panel render'); },
        failure: message => failures.push(message), toast: message => toasts.push(message),
    });
    const result = await controller.run(false);
    assert.equal(result.status, 'updated');
    assert.match(result.uiError.message, /synthetic clear failure panel render/);
    assert.equal(apiCalls, 1);
    assert.equal(writes.length, 1);
    assert.deepEqual(failures, ['内容已更新，界面刷新失败']);
    assert.ok(toasts.includes('内容已更新，界面刷新失败'));
    axisState.almanacAbortController = null;
    axisState.isGeneratingAlmanac = false;
});
