import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceChat } from './chat.js';
import { createSpaceRepository } from './repository.js';
import { createSpaceIdentity } from './identity.js';

test('间讨论把迟到回复应用到当前聊天，并保留其既有历史', async () => {
    let chatId = 'A'; let release; const roots = new Map([['A', []], ['B', [{ role: 'user', content: 'B 的历史' }]]]); const rendered = [];
    const capture = () => createSpaceIdentity({ chatId, historyKey: { kind: 'space-chat', view: 'user', charName: '' } });
    const repository = createSpaceRepository({
        captureIdentity: capture, isCurrent: () => true,
        readStore: () => roots.get(chatId), writeStore: (_key, value) => { roots.set(chatId, value); return true; },
    });
    const chat = createSpaceChat({
        repository, loadConfig: () => ({ url: 'u', key: 'k' }),
        buildMessages: async ({ userMsg }) => [{ role: 'user', content: userMsg }],
        postCompletion: () => new Promise(resolve => { release = resolve; }),
        ui: { appendMessage: (...args) => rendered.push(args), beginThinking: () => ({}), endThinking() {} },
    });
    const pending = chat.send('讨论一下');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    chatId = 'B'; release('讨论结论');
    assert.equal((await pending).status, 'updated');
    assert.deepEqual(roots.get('B').map(item => [item.role, item.content]), [
        ['user', 'B 的历史'], ['user', '讨论一下'], ['assistant', '讨论结论'],
    ]);
    assert.equal(roots.get('A').length, 1);
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
