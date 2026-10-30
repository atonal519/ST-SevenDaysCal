import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createSpaceChat } from './chat.js';
import { createSpaceContext } from './context.js';
import { createSpaceRepository } from './repository.js';
import { createSpaceIdentity } from './identity.js';
import { createSpaceRenderer } from './render.js';
import { parseCompleteOutline } from '../outline/schema.js';

test('面口语请求经实际发送保存和渲染只应用完整节点，格式重发沿用面合同', async () => {
    let stored = null;
    const registrations = [], requests = [];
    const target = createSpaceIdentity({ chatId: 'outline-flow', historyKey: { kind: 'space-chat', view: 'user', charName: '' } });
    const repository = createSpaceRepository({
        captureIdentity: () => target, isCurrent: () => true,
        readStore: () => stored,
        writeStore: (_key, value) => { stored = value; return true; },
    });
    repository.load();
    const context = createSpaceContext({
        context: () => ({ name1: '用户', name2: '角色' }),
        readMemory: async () => '【关系卡】\n关系阶段：观察期',
        readOutlineDraftSnapshot: () => ({ raw: '' }), rawToken: () => 'outline-empty-baseline',
    });
    const renderer = createSpaceRenderer();
    const chat = createSpaceChat({
        repository, loadConfig: () => ({ url: 'fixture', key: 'fixture' }),
        buildMessages: context.buildMessages,
        postCompletion: async ({ messages }) => {
            requests.push(messages);
            assert.equal(messages.expectedWidgetKind, undefined);
            assert.deepEqual(messages.allowedWidgetKinds, ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget']);
            assert.match(messages[0].content, /每个节点都要有 Beat 与 Scene/);
            return `<outline_widget>\nBeat: 明日|残稿|事件|支线|待确认\n</outline_widget>
<outline_widget>\nBeat: 后日|核对来信|调查|主线|来源待核实\nScene: 两人核对信件来源，保留尚未作出的选择\n【关系卡】\n关系阶段：观察期\n</outline_widget>\n额外的结束说明`;
        },
        ui: {
            appendMessage(role, content, index, policy) {
                if (role !== 'ai') return;
                const rendered = renderer.message(role, content, index, widget => { registrations.push(widget); return 'outline'; }, policy);
                assert.match(rendered.widgetCards, /应用到面/);
                assert.doesNotMatch(rendered.widgetCards, /无法应用|额外的结束说明|观察期|残稿/);
            },
        },
    });
    for (const question of ['面卡 生大纲卡', '再生一次格式错了']) {
        assert.equal((await chat.send(question)).status, 'updated');
        const saved = stored.messages.at(-1);
        assert.equal(saved.expectedWidgetKind, 'outline_widget');
        assert.equal(parseCompleteOutline(saved.content).length, 1);
        assert.equal(parseCompleteOutline(saved.content)[0].title, '核对来信');
        assert.doesNotMatch(saved.content, /观察期|结束说明|残稿/);
    }
    assert.equal(requests.length, 2);
    assert.equal(registrations.length, 2);
    assert.equal(registrations[0].body, stored.messages[1].content);
    assert.equal(registrations[1].body, stored.messages[3].content);
});

test('间超过20条历史完整保存并经正式上下文与客户端发送，本轮只追加一次回复', async t => {
    const host = 'data:text/javascript,' + encodeURIComponent(`
        export const extension_settings = { 'schedule-planner': { pluginEnabled: true } };
        export const getContext = () => ({ name1: '用户', name2: '角色', chatMetadata: {}, getRequestHeaders: () => ({}) });
        export const saveSettingsDebounced = () => {};
        export const substituteParams = value => String(value);
    `);
    const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier.endsWith('/extensions.js') || specifier.endsWith('/script.js')) return { url: host, shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
    t.after(() => hooks.deregister());
    const { bindApiClient, postChatCompletion } = await import('../../api/client.js');
    bindApiClient({ enabled: () => true });
    const original = Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant', content: `早期讨论${index + 1}`,
    }));
    original[0].content = '最早备忘：下次讨论先核对旧约定。';
    original[1] = {
        role: 'assistant', content: '收到备忘。<line_widget>旧候选正文</line_widget>',
        pointBaselines: [{ view: 'user', charName: '', rawToken: 'point-baseline', ts: 1 }],
        lineBaselines: [{ name: '旧线', occurrence: 0 }],
        expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'],
    };
    let stored = structuredClone(original);
    const writes = [], requests = [], rendered = [], redraws = [];
    const target = createSpaceIdentity({ chatId: 'A', historyKey: { kind: 'space-chat', view: 'user', charName: '' } });
    const repository = createSpaceRepository({
        captureIdentity: () => target, isCurrent: () => true,
        readStore: () => stored,
        writeStore: (_key, value) => { stored = value; writes.push(structuredClone(value)); return true; },
    });
    repository.load();
    const context = createSpaceContext({ context: () => ({ name1: '用户', name2: '角色' }) });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/generate');
        requests.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: '已核对早期备忘。' } }] }), {
            headers: { 'content-type': 'application/json' },
        });
    });
    const chat = createSpaceChat({
        repository, loadConfig: () => ({ url: 'https://model.fixture/v1', key: 'fixture', model: 'fixture-model' }),
        buildMessages: context.buildMessages,
        postCompletion: ({ config, ...options }) => postChatCompletion({ cfg: config, ...options }),
        ui: {
            appendMessage: (...args) => rendered.push(args), renderHistory: history => redraws.push(history),
            beginThinking: () => ({}), endThinking() {},
        },
    });
    const question = '请回顾最早的备忘，再回应这次问题。';
    assert.equal((await chat.send(question)).status, 'updated');
    assert.equal(requests.length, 1);
    assert.equal(writes.length, 2);
    assert.deepEqual({ savedOnSend: writes[0].messages.length, sentHistoryMessages: requests[0].messages.length - 1, savedAfterReply: stored.messages.length }, {
        savedOnSend: 25, sentHistoryMessages: 25, savedAfterReply: 26,
    });
    assert.deepEqual(writes[0].messages.slice(0, 24), original);
    assert.deepEqual(stored.messages.slice(0, 24), original);
    assert.deepEqual(stored.messages.slice(24).map(({ role, content }) => ({ role, content })), [
        { role: 'user', content: question }, { role: 'assistant', content: '已核对早期备忘。' },
    ]);
    const sent = requests[0].messages.slice(1);
    const expected = original.map(({ role, content }) => ({ role, content }));
    expected[1].content = '【历史卡片候选｜应用状态以当前正式资料为准】\n收到备忘。<line_widget>旧候选正文</line_widget>';
    assert.deepEqual(sent, [...expected, { role: 'user', content: question }]);
    assert.deepEqual(rendered.map(([role, , index]) => [role, index]), [['user', 24], ['ai', 25]]);
    assert.equal(redraws.length, 0);
});

test('间正常发送只捕获一次目标，用户与回复保留在同一历史', async () => {
    let release; let captures = 0;
    const roots = new Map([['A', [{ role: 'user', content: '已有问题' }, { role: 'assistant', content: '已有回复' }]]]);
    const rendered = [], writes = [];
    const target = createSpaceIdentity({ chatId: 'A', historyKey: { kind: 'space-chat', view: 'user', charName: '' } });
    const repository = createSpaceRepository({
        captureIdentity: () => { captures++; return target; }, isCurrent: () => true,
        readStore: key => roots.get(key.chatId),
        writeStore: (key, value) => { writes.push(key.chatId); roots.set(key.chatId, value); return true; },
    });
    repository.load(target);
    const chat = createSpaceChat({
        repository, loadConfig: () => ({ url: 'u', key: 'k' }),
        buildMessages: async ({ userMsg }) => [{ role: 'user', content: userMsg }],
        postCompletion: () => new Promise(resolve => { release = resolve; }),
        ui: { appendMessage: (...args) => rendered.push(args), beginThinking: () => ({}), endThinking() {} },
    });
    const pending = chat.send('讨论一下');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release('讨论结论');
    assert.equal((await pending).status, 'updated');
    assert.equal(captures, 1);
    assert.deepEqual(writes, ['A', 'A']);
    assert.deepEqual(roots.get('A').messages.map(item => [item.role, item.content]), [
        ['user', '已有问题'], ['assistant', '已有回复'], ['user', '讨论一下'], ['assistant', '讨论结论'],
    ]);
    assert.ok(rendered.some(item => item[0] === 'ai'));
});

test('间讨论的呈现异常保留已本地应用的回复', async () => {
    const roots = new Map([['A', []]]);
    const repository = createSpaceRepository({
        captureIdentity: () => createSpaceIdentity({ chatId: 'A', historyKey: { kind: 'space-chat', view: 'user', charName: '' } }),
        isCurrent: () => true, readStore: () => roots.get('A'), writeStore: (_key, value) => { roots.set('A', value); return true; },
    });
    const chat = createSpaceChat({
        repository, loadConfig: () => ({ url: 'u', key: 'k' }), buildMessages: async () => [], postCompletion: async () => '已生成回复',
        ui: { appendMessage: role => { if (role === 'ai') throw new Error('render failed'); }, beginThinking: () => ({}), endThinking() {} },
    });
    const result = await chat.send('继续');
    assert.equal(result.status, 'updated');
    assert.equal(result.reply, '已生成回复');
    assert.match(result.uiError.message, /render failed/);
    assert.equal(roots.get('A').messages.at(-1).content, '已生成回复');
});

test('间在历史和首次显示中沿用实际卡片类型白名单', async () => {
    const roots = new Map([['A', []]]);
    const rendered = [];
    const repository = createSpaceRepository({
        captureIdentity: () => createSpaceIdentity({ chatId: 'A', historyKey: { kind: 'space-chat', view: 'user', charName: '' } }),
        isCurrent: () => true, readStore: () => roots.get('A'), writeStore: (_key, value) => { roots.set('A', value); return true; },
    });
    const messages = [];
    Object.defineProperty(messages, 'allowedWidgetKinds', { value: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'], enumerable: false });
    Object.defineProperty(messages, 'outlineRawToken', { value: 'formal-token', enumerable: false });
    const chat = createSpaceChat({
        repository, loadConfig: () => ({ url: 'u', key: 'k' }), buildMessages: async () => messages,
        postCompletion: async () => '<outline_widget>Beat: 明日|候选|关系|主线|结果\nScene: 候选场景</outline_widget>',
        ui: { appendMessage: (...args) => rendered.push(args), beginThinking: () => ({}), endThinking() {} },
    });
    assert.equal((await chat.send('帮我整理当前面')).status, 'updated');
    const stored = roots.get('A').messages.at(-1);
    assert.deepEqual(stored.allowedWidgetKinds, ['outline_widget']);
    assert.equal(stored.expectedWidgetKind, 'outline_widget');
    assert.equal(stored.outlineRawToken, 'formal-token');
    const aiRender = rendered.find(args => args[0] === 'ai');
    assert.deepEqual(aiRender[3].allowedWidgetKinds, ['outline_widget']);
    assert.equal(aiRender[3].outlineRawToken, 'formal-token');
});

test('间删除、清空和重发遇到保存拒绝时提示失败并保留原历史', async () => {
    const stored = [{ role: 'user', content: '保留' }]; const notices = []; const renders = [];
    const repository = createSpaceRepository({
        captureIdentity: () => createSpaceIdentity({ chatId: 'A', historyKey: { kind: 'space-chat', view: 'user', charName: '' } }),
        isCurrent: () => true, readStore: () => stored, writeStore: () => false,
    });
    repository.load();
    const chat = createSpaceChat({ repository, ui: { toast: (...args) => notices.push(args), renderHistory: value => renders.push(value), emptyMessages: () => renders.push([]) } });
    assert.equal(chat.remove(0), false);
    assert.equal(chat.clear(), false);
    assert.equal((await chat.resendFrom(0, '改写')).status, 'stale');
    assert.equal(repository.history()[0]?.content, '保留');
    assert.equal(notices.length, 3);
    assert.equal(renders.length, 0);
});
