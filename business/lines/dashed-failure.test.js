import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashedModule } from './dashed.js';

test('dashed abort clears the old failure hint while preserving existing items', async () => {
    let saved = { ts: 1, items: [{ id: 'kept', text: '已有冷知识', createdAt: 1, locked: false }] };
    let refreshes = 0;
    const dashed = createDashedModule({
        keyDesc: () => 'dashed',
        readStore: () => saved,
        writeStore: (_key, value) => { saved = value; return true; },
        removeStore: () => { saved = null; },
        getSettings: () => ({ dashedKeepCount: 10, dashedCleanupEnabled: true, notifyMode: 'off' }),
        context: () => ({ chatId: 'chat-A', name1: 'User', name2: 'Character' }),
        chatId: () => 'chat-A',
        loadConfig: () => ({}),
        callApi: async () => { throw new Error('must not call without config'); },
        refreshPanel: () => { refreshes++; },
        refreshInline: () => {},
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        escapeAttr: value => String(value),
        toast: () => {},
        logDiagnostic: () => {},
    });
    await dashed.run({ manual: true, topics: ['world'] });
    assert.match(dashed.panelHtml(), /sp-panel-failure-hint/);
    assert.match(dashed.panelHtml(), /已有冷知识/);
    const beforeAbortRefreshes = refreshes;
    dashed.abort();
    assert.doesNotMatch(dashed.panelHtml(), /sp-panel-failure-hint/);
    assert.match(dashed.panelHtml(), /已有冷知识/);
    assert.ok(refreshes > beforeAbortRefreshes, 'abort refreshes the visible dashed panel');
});

test('dashed displays locally applied items before the host save settles and retains a current-chat rejection hint', async () => {
    let saved = null; let saveRejected = null; let refreshes = 0;
    const dashed = createDashedModule({
        keyDesc: () => 'dashed',
        readStore: () => saved,
        writeStore: () => true,
        writeStoreConfirmed: (_key, value, options) => {
            saved = value;
            saveRejected = options.onPersistenceError;
            return { ok: true, commitState: 'local-applied' };
        },
        removeStore: () => { saved = null; },
        getSettings: () => ({ dashedKeepCount: 10, dashedCleanupEnabled: true, notifyMode: 'off' }),
        context: () => ({ chatId: 'chat-B', name1: 'User', name2: 'Character' }),
        chatId: () => 'chat-B',
        loadConfig: () => ({ url: 'https://example.invalid', key: 'synthetic' }),
        callApi: async () => '这条冷知识在本地立即可见。',
        refreshPanel: () => { refreshes++; },
        refreshInline: () => {},
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        escapeAttr: value => String(value),
        toast: () => {},
        logDiagnostic: () => {},
    });
    const result = await dashed.run({ manual: true, topics: ['world'] });
    assert.equal(result.status, 'updated');
    assert.match(dashed.panelHtml(), /这条冷知识在本地立即可见/);
    assert.equal(typeof saveRejected, 'function');
    const beforeFailureRefreshes = refreshes;
    saveRejected(new Error('synthetic host save rejection'));
    assert.match(dashed.panelHtml(), /sp-panel-failure-hint/);
    assert.match(dashed.panelHtml(), /仍在本地，请手动刷新核对/);
    assert.match(dashed.panelHtml(), /这条冷知识在本地立即可见/);
    assert.ok(refreshes > beforeFailureRefreshes);
});

test('dashed keeps locally applied content and reports a refresh failure as UI-only', async () => {
    let saved = null, refreshes = 0, apiCalls = 0;
    const toasts = [];
    const dashed = createDashedModule({
        keyDesc: () => 'dashed', readStore: () => saved, writeStoreConfirmed: (_key, value) => { saved = value; return { ok: true, commitState: 'local-applied' }; },
        getSettings: () => ({ dashedKeepCount: 10, dashedCleanupEnabled: true, notifyMode: 'off' }),
        context: () => ({ chatId: 'chat-ui', name1: 'User', name2: 'Character' }), chatId: () => 'chat-ui',
        loadConfig: () => ({ url: 'fixture', key: 'fixture' }), callApi: async () => { apiCalls++; return '新增的冷知识内容。'; },
        refreshPanel: () => { refreshes++; if (saved) throw new Error('synthetic dashed UI failure'); }, refreshInline: () => {},
        escapeHtml: String, escapeAttr: String, toast: message => toasts.push(message), logDiagnostic: () => {},
    });
    const result = await dashed.run({ manual: true, topics: ['world'] });
    assert.equal(result.status, 'updated');
    assert.match(result.uiError.message, /synthetic dashed UI failure/);
    assert.match(dashed.panelHtml(), /新增的冷知识内容/);
    assert.match(dashed.panelHtml(), /内容已更新，界面刷新失败/);
    assert.equal(apiCalls, 1);
    assert.ok(refreshes >= 2);
    assert.ok(toasts.includes('内容已更新，界面刷新失败'));
});
