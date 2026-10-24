import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const host = 'data:text/javascript,' + encodeURIComponent(`
export const extension_settings = globalThis.promptTestSettings;
export const getContext = () => globalThis.promptTestContext;
export const saveSettingsDebounced = () => {};
export const substituteParams = value => String(value);
`);
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/extensions.js') || specifier.endsWith('/script.js')) return { url: ${JSON.stringify(host)}, shortCircuit: true };
    return nextResolve(specifier, context);
}
`));
globalThis.promptTestSettings = { 'schedule-planner': { apiUrl: 'https://model.fixture/v1', apiKey: 'fixture', apiModel: 'fixture-model', customPrompt: 'LEGACY_WRITING_RULE' } };
globalThis.promptTestContext = { name1: 'User', name2: 'Character', chatMetadata: {}, getRequestHeaders: () => ({}) };
const client = await import('./client.js');
const apiSettings = await import('../runtime/settings.js');
const { updateSharedProcessingPrompt } = await import('../utils/shared-processing-prompt.js');
const settings = globalThis.promptTestSettings['schedule-planner'];
const requests = [];
let completion = 'fixture reply';
globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/backends/chat-completions/generate');
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"fixture reply"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: completion } }] }), { headers: { 'content-type': 'application/json' } });
};
const cfg = { url: 'https://model.fixture/v1', key: 'fixture', model: 'fixture-model' };
client.bindApiClient({ enabled: () => true, buildMessages: (_ctx, prompt) => [{ role: 'system', content: 'TASK {{char}}' }, { role: 'user', content: prompt }] });

test('first text dispatch inherits the QQJ effective prompt once and ignores former GouHua local fields', async () => {
    delete settings.processingPrompt;
    settings.jailbreakPrompt = 'LEGACY_LOCAL_RULE';
    globalThis.promptTestSettings.qianqianjie = { processingPrompt: '  INHERITED_RULE\n' };
    await client.postChatCompletion({ cfg, messages: [{ role: 'user', content: 'task' }] });
    assert.equal(settings.processingPrompt, '  INHERITED_RULE\n');
    assert.equal(requests.at(-1).messages[0].content, '  INHERITED_RULE\n');
    globalThis.promptTestSettings.qianqianjie.processingPrompt = 'LATER_QQJ_LEGACY_RULE';
    await client.postChatCompletion({ cfg, messages: [{ role: 'user', content: 'task' }] });
    assert.equal(requests.at(-1).messages[0].content, '  INHERITED_RULE\n');
    assert.ok(!JSON.stringify(requests.at(-1)).includes('LEGACY_LOCAL_RULE'));
    assert.ok(!JSON.stringify(requests.at(-1)).includes('LEGACY_WRITING_RULE'));
    assert.equal(settings.customPrompt, 'LEGACY_WRITING_RULE');
    delete settings.processingPrompt;
    delete globalThis.promptTestSettings.qianqianjie;
    await client.postChatCompletion({ cfg, messages: [{ role: 'user', content: 'task' }] });
    assert.equal(settings.processingPrompt, client.BASE_PROCESSING_PROMPT);
    assert.deepEqual(requests.at(-1).messages, [{ role: 'system', content: client.BASE_PROCESSING_PROMPT }, { role: 'user', content: 'task' }]);
});

test('empty or whitespace shared prompt uses the common default without restoring either legacy custom prompt', async () => {
    globalThis.promptTestSettings.qianqianjie = { processingPrompt: 'OLD_QQJ_RULE' };
    settings.jailbreakPrompt = 'OLD_LOCAL_RULE';
    for (const value of ['', ' \n ']) {
        apiSettings.setProcessingPrompt(value);
        apiSettings.getSettings();
        assert.equal(settings.processingPrompt, value);
        await client.postChatCompletion({ cfg, messages: [{ role: 'user', content: 'task' }] });
        assert.deepEqual(requests.at(-1).messages, [{ role: 'system', content: client.BASE_PROCESSING_PROMPT }, { role: 'user', content: 'task' }]);
        await client.postChatCompletion({ cfg, messages: [{ role: 'system', content: 'BUSINESS_RULE' }, { role: 'user', content: 'task' }] });
        assert.deepEqual(requests.at(-1).messages, [{ role: 'system', content: client.BASE_PROCESSING_PROMPT + '\n\nBUSINESS_RULE' }, { role: 'user', content: 'task' }]);
    }
});

test('direct, custom, memory and theater requests prepend the current shared prompt once', async () => {
    apiSettings.setProcessingPrompt('SHARED_RULE {{user}} / {{char}}');
    const messages = [{ role: 'system', content: 'TASK {{char}}' }, { role: 'user', content: 'ask {{user}}' }];
    const callers = [
        () => client.postChatCompletion({ cfg, messages, userName: 'User', charName: 'Character' }),
        () => client.callCustomApi(globalThis.promptTestContext, 'ask {{user}}', cfg, 'User', 'Character'),
        () => client.callMemoryApi(messages),
        () => client.callTheaterApi(messages),
    ];
    for (const call of callers) {
        const before = requests.length;
        assert.equal(await call(), 'fixture reply');
        assert.equal(requests.length, before + 1);
        const sent = requests.at(-1).messages;
        assert.equal(sent.length, 2);
        assert.equal(sent[0].content, 'SHARED_RULE User / Character\n\nTASK Character');
        assert.equal(sent[1].content, 'ask User');
        assert.ok(!JSON.stringify(sent).includes('LEGACY_WRITING_RULE'));
        assert.ok(!JSON.stringify(sent).includes('sanctuary_override_directive'));
    }
    assert.equal(messages[0].content, 'TASK {{char}}');
    const parts = [{ type: 'text', text: 'unchanged {{user}}' }];
    await client.postChatCompletion({ cfg, messages: [{ role: 'system', content: 'FIRST' }, { role: 'system', content: 'SECOND' }, { role: 'user', content: parts }] });
    const sent = requests.at(-1).messages;
    assert.equal(sent[0].content, 'SHARED_RULE User / Character\n\nFIRST');
    assert.equal(sent[1].content, 'SECOND');
    assert.deepEqual(sent[2].content, parts);
});

test('a requester assembling messages uses the shared setting in effect at its actual dispatch', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    client.bindApiClient({ buildMessages: async () => { await gate; return [{ role: 'user', content: 'task' }]; } });
    apiSettings.setProcessingPrompt('EARLIER_RULE');
    const pending = client.callCustomApi(globalThis.promptTestContext, 'task', cfg, 'User', 'Character');
    updateSharedProcessingPrompt(globalThis.promptTestSettings, 'LATEST_RULE');
    release();
    await pending;
    assert.equal(requests.at(-1).messages[0].content, 'LATEST_RULE');
});

const { createTheaterGeneration } = await import('../business/theater/generation.js');
const { buildWriteMessages, buildBeautifyMessages } = await import('../business/theater/prompts.js');
const theaterMessages = [{ role: 'user', content: '独立短篇' }];
function resetRoutes() {
    Object.assign(settings, { apiUrl: 'https://content.fixture/v1', apiKey: 'content-key', apiModel: 'content-model', apiAdditionalParams: '', apiExcludeParams: [], apiTimeoutSec: 180, apiStream: false, apiPresets: [], theaterPresetId: '', utilityPresetId: '' });
}

test('theater defaults to the saved content route and leaves the utility route independent', async () => {
    resetRoutes();
    const id = apiSettings.upsertApiPreset('机械', { url: 'https://utility.fixture/v1', key: 'utility-key', model: 'utility-model' });
    settings.utilityPresetId = id;
    await client.callTheaterApi(theaterMessages);
    assert.equal(requests.at(-1).reverse_proxy, 'https://content.fixture/v1');
    assert.equal(requests.at(-1).model, 'content-model');
    await client.callMemoryApi(theaterMessages);
    assert.equal(requests.at(-1).reverse_proxy, 'https://utility.fixture/v1');
    assert.equal(requests.at(-1).model, 'utility-model');
});

test('theater selected preset reaches final transport with its additional, excluded, streaming and timeout parameters', async t => {
    resetRoutes();
    const preset = { url: 'https://theater.fixture/v1', key: 'theater-key', model: 'theater-model', spAdditionalParams: '{"temperature":0,"max_tokens":987,"top_p":0.8}', excludeParams: ['frequency_penalty', 'top_p'], timeoutSec: 27, stream: true };
    settings.theaterPresetId = apiSettings.upsertApiPreset('小剧场', preset);
    const timeouts = [];
    const originalTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { timeouts.push(ms); return originalTimeout(fn, ms, ...args); });
    assert.equal(await client.callTheaterApi(theaterMessages), 'fixture reply');
    const sent = requests.at(-1);
    assert.equal(sent.chat_completion_source, 'custom');
    assert.equal(sent.custom_url, 'https://theater.fixture/v1');
    assert.deepEqual(JSON.parse(sent.custom_include_headers), { Authorization: 'Bearer theater-key' });
    assert.equal(sent.model, 'theater-model');
    assert.deepEqual(JSON.parse(sent.custom_include_body), { temperature: 0, max_tokens: 987 });
    assert.equal(sent.stream, true);
    assert.equal('frequency_penalty' in sent, false);
    assert.ok(timeouts.includes(27000));
    assert.equal(settings.apiModel, 'content-model');
});

test('theater reads saved preset changes on the next dispatch and follows content after deletion or invalid selection', async () => {
    resetRoutes();
    const id = apiSettings.upsertApiPreset('小剧场', { url: 'https://first.fixture/v1', key: 'first-key', model: 'first-model' });
    settings.theaterPresetId = id;
    await client.callTheaterApi(theaterMessages);
    assert.equal(requests.at(-1).model, 'first-model');
    apiSettings.upsertApiPreset('改名后', { url: 'https://second.fixture/v1', key: 'second-key', model: 'second-model' }, id);
    await client.callTheaterApi(theaterMessages);
    assert.equal(requests.at(-1).reverse_proxy, 'https://second.fixture/v1');
    assert.equal(requests.at(-1).model, 'second-model');
    apiSettings.deleteApiPreset(id);
    assert.equal(settings.theaterPresetId, '');
    await client.callTheaterApi(theaterMessages);
    assert.equal(requests.at(-1).model, 'content-model');
    for (const invalid of ['missing', apiSettings.upsertApiPreset('缺密钥', { url: 'https://invalid.fixture/v1', key: '', model: 'invalid-model' })]) {
        settings.theaterPresetId = invalid;
        await client.callTheaterApi(theaterMessages);
        assert.equal(requests.at(-1).model, 'content-model');
    }
});

test('valid theater preset works without a content API connection', async () => {
    resetRoutes();
    settings.apiUrl = ''; settings.apiKey = '';
    settings.theaterPresetId = apiSettings.upsertApiPreset('独立', { url: 'https://independent.fixture/v1', key: 'independent-key', model: 'independent-model' });
    assert.equal(await client.callTheaterApi(theaterMessages), 'fixture reply');
    assert.equal(requests.at(-1).reverse_proxy, 'https://independent.fixture/v1');
    assert.equal(requests.at(-1).model, 'independent-model');
});

test('theater generation and regeneration read the current route separately for writing and beautifying', async () => {
    resetRoutes();
    const id = apiSettings.upsertApiPreset('写作', { url: 'https://write.fixture/v1', key: 'write-key', model: 'write-model' });
    settings.theaterPresetId = id;
    const generate = createTheaterGeneration({ write: client.callTheaterApi, beautify: client.callTheaterApi, buildWriteMessages, buildBeautifyMessages, sanitize: value => value, plainTextFallback: value => value });
    for (const input of ['初次要求', '沿用要求重新生成']) {
        completion = '离线正文';
        apiSettings.upsertApiPreset('写作', { url: 'https://write.fixture/v1', key: 'write-key', model: 'write-model' }, id);
        const start = requests.length;
        const result = await generate(input, { userName: '用户', charName: '角色', onStage(stage) {
            if (stage === '渲染') {
                completion = '<div class="sp-theater-prose"><p>离线正文</p></div>';
                apiSettings.upsertApiPreset('美化', { url: 'https://beautify.fixture/v1', key: 'beautify-key', model: 'beautify-model' }, id);
            }
        } });
        assert.equal(requests.length, start + 2);
        assert.equal(requests[start].model, 'write-model');
        assert.equal(requests[start + 1].model, 'beautify-model');
        assert.equal(result.request, input);
        assert.equal(result.html, '<div class="sp-theater-prose"><p>离线正文</p></div>');
    }
    completion = 'fixture reply';
});
