import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceChat } from './chat.js';
import { createSpaceRepository } from './repository.js';
import { createSpaceIdentity } from './identity.js';

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
    assert.deepEqual(roots.get('A').map(item => [item.role, item.content]), [
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
    assert.equal(roots.get('A').at(-1).content, '已生成回复');
});

test('间在历史和首次显示中沿用本轮卡片白名单', async () => {
    const roots = new Map([['A', []]]);
    const rendered = [];
    const repository = createSpaceRepository({
        captureIdentity: () => createSpaceIdentity({ chatId: 'A', historyKey: { kind: 'space-chat', view: 'user', charName: '' } }),
        isCurrent: () => true, readStore: () => roots.get('A'), writeStore: (_key, value) => { roots.set('A', value); return true; },
    });
    const messages = [];
    Object.defineProperty(messages, 'allowedWidgetKinds', { value: ['outline_widget'], enumerable: false });
    Object.defineProperty(messages, 'outlineRawToken', { value: 'formal-token', enumerable: false });
    const chat = createSpaceChat({
        repository, loadConfig: () => ({ url: 'u', key: 'k' }), buildMessages: async () => messages,
        postCompletion: async () => '<outline_widget>候选</outline_widget>',
        ui: { appendMessage: (...args) => rendered.push(args), beginThinking: () => ({}), endThinking() {} },
    });
    assert.equal((await chat.send('帮我整理当前面')).status, 'updated');
    const stored = roots.get('A').at(-1);
    assert.deepEqual(stored.allowedWidgetKinds, ['outline_widget']);
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
