import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashedPrompt, createDashedModule, dashedItemsFromRaw } from './dashed.js';

test('dashed parser accepts explicit JSON forms and preserves valid mixed entries', () => {
    assert.deepEqual(dashedItemsFromRaw('"单条冷知识"'), ['单条冷知识']);
    assert.deepEqual(dashedItemsFromRaw('["甲","乙"]'), ['甲', '乙']);
    assert.deepEqual(dashedItemsFromRaw('{"items":["甲",{"text":"乙"},12,{}]}'), ['甲', '乙']);
    assert.deepEqual(dashedItemsFromRaw('{"text":"单条冷知识"}'), ['单条冷知识']);
    assert.deepEqual(dashedItemsFromRaw('说明文字\n```json\n{"items":["围栏冷知识"]}\n```\n结束说明'), ['围栏冷知识']);
    assert.deepEqual(dashedItemsFromRaw('```\n[风俗] 这是一条正常分类知识。\n```'), ['[风俗] 这是一条正常分类知识。']);
    assert.deepEqual(dashedItemsFromRaw('[tradition] This category label is ordinary prose.'), ['[tradition] This category label is ordinary prose.']);
});

test('dashed parser filters headings and distinguishes explicit no-content from malformed output', () => {
    assert.deepEqual(dashedItemsFromRaw('1. 冷知识列表\n2. 真正的条目内容。'), ['真正的条目内容。']);
    assert.deepEqual(dashedItemsFromRaw('```\n无可用冷知识\n```'), []);
    assert.deepEqual(dashedItemsFromRaw('无可用冷知识'), []);
    assert.deepEqual(dashedItemsFromRaw('[]'), []);
    assert.deepEqual(dashedItemsFromRaw('{"items":[]}'), []);
    assert.deepEqual(dashedItemsFromRaw('{"items":["无可用冷知识"]}'), []);
    assert.deepEqual(dashedItemsFromRaw('{"items":["有效条目", 2]}'), ['有效条目']);
    assert.deepEqual(dashedItemsFromRaw('{broken json}'), []);
    assert.deepEqual(dashedItemsFromRaw('{"unknown":true}'), []);
    assert.deepEqual(dashedItemsFromRaw('```json\n[]\n```\n```text\n另一个围栏\n```'), []);
    assert.deepEqual(dashedItemsFromRaw(''), []);
});

test('dashed prompt is concise, uses setting research framing, and retains the recent-item exclusion', () => {
    const prompt = buildDashedPrompt('用户', '角色', ['近期旧知识'], { topics: ['世界观设定'] });
    assert.match(prompt, /世界设定考据者/);
    assert.match(prompt, /50到100个汉字/);
    assert.match(prompt, /无可用冷知识/);
    assert.match(prompt, /近期旧知识/);
    assert.doesNotMatch(prompt, /请无视上文/);
});

test('explicit no-content reroll refreshes without filtering, writing, or removing existing rows', async () => {
    const saved = { ts: 7, items: [
        { id: 'locked', text: '锁定旧条目', createdAt: 1, locked: true },
        { id: 'open', text: '未锁定旧条目', createdAt: 2, locked: false },
    ] };
    const before = structuredClone(saved), toasts = [];
    let writes = 0, removes = 0, rerollFilters = 0, refreshes = 0;
    const dashed = createDashedModule({
        keyDesc: () => 'dashed', readStore: () => saved,
        writeStore: () => { writes++; return true; }, removeStore: () => { removes++; },
        getSettings: () => ({ dashedKeepCount: 15, dashedCleanupEnabled: true, notifyMode: 'full' }),
        context: () => ({ name1: 'User', name2: 'Character' }), chatId: () => 'chat',
        loadConfig: () => ({ url: 'fixture', key: 'fixture' }),
        callApi: async (_ctx, _prompt, _cfg, _user, _char, _signal, _historyLimit, options) => {
            assert.equal(options.diagnosticModule, 'dashed');
            return '{"items":[]}';
        },
        filterRerollItems: items => { rerollFilters++; return items; },
        refreshPanel: () => { refreshes++; }, refreshInline: () => {},
        escapeHtml: String, escapeAttr: String, toast: message => toasts.push(message), logDiagnostic: () => {},
    });
    const result = await dashed.run({ manual: true, topics: ['world'] });
    assert.deepEqual(result, { status: 'updated', added: 0 });
    assert.deepEqual(saved, before);
    assert.equal(writes, 0);
    assert.equal(removes, 0);
    assert.equal(rerollFilters, 0);
    assert.ok(refreshes >= 2);
    assert.ok(toasts.includes('本次没有可用的新冷知识'));
});

test('malformed reroll output fails without changing locked or unlocked rows', async () => {
    const saved = { ts: 9, items: [
        { id: 'locked', text: '锁定旧条目', createdAt: 1, locked: true },
        { id: 'open', text: '未锁定旧条目', createdAt: 2, locked: false },
    ] };
    const before = structuredClone(saved);
    let writes = 0, removes = 0, rerollFilters = 0;
    const dashed = createDashedModule({
        keyDesc: () => 'dashed', readStore: () => saved,
        writeStore: () => { writes++; return true; }, removeStore: () => { removes++; },
        getSettings: () => ({ dashedKeepCount: 15, dashedCleanupEnabled: true, notifyMode: 'full' }),
        context: () => ({ name1: 'User', name2: 'Character' }), chatId: () => 'chat',
        loadConfig: () => ({ url: 'fixture', key: 'fixture' }), callApi: async () => '{broken json}',
        filterRerollItems: items => { rerollFilters++; return items; },
        refreshPanel: () => {}, refreshInline: () => {}, escapeHtml: String, escapeAttr: String,
        toast: () => {}, logDiagnostic: () => {},
    });
    await dashed.run({ manual: true, reroll: true, topics: ['world'] });
    assert.deepEqual(saved, before);
    assert.equal(writes, 0);
    assert.equal(removes, 0);
    assert.equal(rerollFilters, 0);
    assert.match(dashed.state().error, /生成失败/);
});

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
