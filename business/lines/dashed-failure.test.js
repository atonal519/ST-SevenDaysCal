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
