import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutlineFeature } from './feature.js';

const rawOutline = `<outline_widget>
Beat: D1|第一面|日常|主线|初识
Scene: 两人初次见面
Subtext: 保持克制
Think: 观察彼此
Beat: D2|第二面|日常|主线|熟悉
Scene: 慢慢建立信任
Subtext: 留有余地
Think: 记住细节
</outline_widget>`;

function makeFeature({ switchChatDuringRefresh = false, memoryFailure = false } = {}) {
    let chatId = 'chat-A';
    const store = new Map();
    let feature;
    let failureHtml = '';
    const identityKey = key => JSON.stringify(key);
    feature = createOutlineFeature({
        context: () => ({ chatId, chat: [{}], name1: 'User', name2: 'Character' }),
        keyDesc: kind => ({ kind }),
        readStore: key => store.get(identityKey(key)),
        writeStore: (key, value) => { store.set(identityKey(key), value); return true; },
        removeStore: key => store.delete(identityKey(key)),
        loadConfig: () => ({ url: 'local-test', key: 'fixture' }),
        loadUtilityConfig: () => ({ url: 'local-test', key: 'fixture' }),
        precheck: async () => { if (memoryFailure) throw new Error('synthetic memory failure'); return true; },
        callApi: async () => '推进',
        settings: () => ({ notifyMode: 'off', outlineInject: true }),
        pluginEnabled: () => true,
        injectEnabled: () => true,
        isAutomationSuppressed: () => false,
        bridgeAbortSignal: () => () => {},
        ui: {
            setFailureHtml: html => { failureHtml = html; },
            setOutline: () => {
                if (memoryFailure) return;
                if (!switchChatDuringRefresh) throw new Error('synthetic view refresh failure');
                chatId = 'chat-B';
                feature.onChatChanged();
                throw new Error('late view refresh failure');
            },
            setLoading: () => {},
            showPreflightError: () => {},
            isOutlineMode: () => true,
            toast: () => {},
        },
    });
    const target = feature.repository.capture();
    assert.equal(feature.repository.commitOutline(target, { raw: rawOutline, cursor: 1 }), true);
    return { feature, getFailureHtml: () => failureHtml, getCursor: () => feature.repository.cursor(feature.repository.capture()) };
}

test('confirmed judge cursor save leaves a saved-but-refresh-failed hint', async () => {
    const fixture = makeFeature();
    const result = await fixture.feature.judge.runAdvance();
    assert.equal(result.status, 'updated');
    assert.equal(fixture.getCursor(), 2, 'the cursor commit remains saved');
    assert.match(fixture.getFailureHtml(), /已保存，但面板刷新失败/);
});

test('chat switch during the old judge refresh prevents a late failure hint', async () => {
    const fixture = makeFeature({ switchChatDuringRefresh: true });
    const result = await fixture.feature.judge.runAdvance();
    assert.equal(result.status, 'updated');
    assert.equal(fixture.getFailureHtml(), '', 'the old chat cannot write a hint into the new chat');
});

test('memory precheck failure is labeled as memory failure rather than model generation failure', async () => {
    const fixture = makeFeature({ memoryFailure: true });
    const result = await fixture.feature.generation.trigger();
    assert.equal(result.status, 'failed');
    assert.match(fixture.getFailureHtml(), /记忆读取失败/);
    assert.doesNotMatch(fixture.getFailureHtml(), /AI生成失败/);
});
