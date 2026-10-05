import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutlineChat } from './chat.js';
import { createOutlineRepository } from './repository.js';
import { createOutlineIdentity } from './identity.js';

test('面内讨论把合法迟到回复应用到当前聊天并显示完整一轮', async () => {
    let chatId = 'A'; let release; const roots = new Map([['A', {}], ['B', {}]]); const rendered = [];
    const capture = () => createOutlineIdentity({ chatId, outlineKey: { kind: 'outline' }, creativeChatKey: { kind: 'creative-chat' } });
    const repository = createOutlineRepository({
        captureIdentity: capture, isCurrent: () => true,
        readStore: key => roots.get(chatId)?.[key.kind] || null,
        writeStore: (key, value) => { roots.get(chatId)[key.kind] = value; return true; },
    });
    const chat = createOutlineChat({
        repository, loadConfig: () => ({ url: 'u', key: 'k' }),
        buildMessages: async ({ historySnapshot }) => historySnapshot,
        postCompletion: () => new Promise(resolve => { release = resolve; }),
        ui: { appendMessage: (...args) => rendered.push(args), renderHistory: value => rendered.push(['render', value]) },
    });
    const pending = chat.send('继续写');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    chatId = 'B'; chat.onChatChanged(); release('答复');
    assert.equal((await pending).status, 'updated');
    assert.deepEqual(roots.get('B')['creative-chat'], [
        { role: 'user', content: '继续写' }, { role: 'assistant', content: '答复' },
    ]);
    assert.equal(roots.get('A')['creative-chat'].length, 1);
    assert.ok(rendered.some(item => item[0] === 'ai'));
});

test('面内讨论的呈现异常保留已本地应用的回复', async () => {
    const root = {};
    const repository = createOutlineRepository({
        captureIdentity: () => createOutlineIdentity({ chatId: 'A', outlineKey: { kind: 'outline' }, creativeChatKey: { kind: 'creative-chat' } }),
        isCurrent: () => true, readStore: key => root[key.kind] || null, writeStore: (key, value) => { root[key.kind] = value; return true; },
    });
    const chat = createOutlineChat({
        repository, loadConfig: () => ({ url: 'u', key: 'k' }), buildMessages: async () => [], postCompletion: async () => '已生成回复',
        ui: { appendMessage: role => { if (role === 'ai') throw new Error('render failed'); }, beginThinking: () => ({}), endThinking() {} },
    });
    const result = await chat.send('继续');
    assert.equal(result.status, 'updated');
    assert.equal(result.reply, '已生成回复');
    assert.match(result.uiError.message, /render failed/);
    assert.equal(root['creative-chat'].at(-1).content, '已生成回复');
});
