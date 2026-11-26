import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceFeature } from './feature.js';
import { buildPortableChatPackage, markImportedSpaceHistory } from '../../runtime/portable-chat-data.js';

function fixture({ globalSelected = false } = {}) {
    const identity = { hostChatId: 'chat-a', qqjChatId: 'qqj-a', characterLocator: 'card.png', personaLocator: 'persona.png' };
    let host = { chatId: identity.hostChatId, name1: '访客', name2: '顾舟', characterId: 0, characters: [{ avatar: 'card.png' }], userAvatar: 'persona.png' };
    const stores = new Map(), calls = [], requests = [];
    const after = { text: '钟楼铃响时忧虑', visibility: 'private', reason: '听见脚步', sourceFloorId: 'floor-18', sourceAssistantSeq: 3, quantification: { expression: 0, emotions: { 担忧: 70 } } };
    const snapshot = {
        status: 'ready', identity,
        memory: { status: 'ready', floors: [
            { floorId: 'floor-18', messageIndex: 18, assistantSeq: 3, summary: '顾舟在钟楼借走旧地图。\n守门人记下了约定。', summarySource: 'user' },
            { floorId: 'floor-unknown', messageIndex: null, assistantSeq: 99, summary: '顾舟在钟楼见过黄纸印。' },
        ] },
        cse: { ready: false, currentSubjects: [{ subjectEntityId: 'gu', displayName: '顾舟', situational: [after] }], floors: [{
            floorId: 'floor-18', messageIndex: 18, assistantSeq: 3, changesKnown: true,
            changes: [{ subjectEntityId: 'gu', displayName: '顾舟', changes: [{ category: 'situational', action: 'update', before: { ...after, quantification: { expression: 12 } }, after }] }],
        }] },
        people: { status: 'ready', items: [
            { entityId: 'gu', displayName: '顾舟', aliases: ['阿舟'], profile: { birthplace: '落川', occupation: '书记官', languages: '海岸语', notes: '', manualFields: ['notes'], rawModelOutput: '不可传的内部字段' } },
            { entityId: 'other', displayName: '路人丙', profile: { occupation: '与查询无关资料' } },
        ] },
    };
    const affairs = {
        status: 'ready', identity: { qqjChatId: identity.qqjChatId },
        events: [
            { id: 'borrow', matterId: 'map', title: '钟楼借走旧地图', description: '顾舟向守门人借图，约好雾散前归还。', sourceMessageIndex: 18, sourceAssistantSeq: 3, status: 'inProgress' },
            { id: 'return', matterId: 'map', title: '地图还给守门人', description: '顾舟把地图按约交回。', sourceMessageIndex: 32, sourceAssistantSeq: 6, status: 'completed' },
            { id: 'bell', matterId: 'bell-matter', title: '修好钟楼木梯', description: '顾舟还没有修好木梯。', sourceMessageIndex: 45, sourceAssistantSeq: 8, status: 'planned' },
        ],
        matters: [
            { matterId: 'map', title: '归还旧地图', currentEventId: 'return', origin: { eventId: 'borrow' }, recordIds: ['borrow', 'return'], status: 'completed', following: false },
            { matterId: 'bell-matter', title: '修好钟楼木梯', currentEventId: 'bell', origin: { eventId: 'bell' }, recordIds: ['bell'], status: 'planned', following: true },
        ],
        relations: [{ id: 'confirmed', type: 'progress', fromEventId: 'borrow', toEventId: 'return', certainty: 'explicit' }],
    };
    const globals = {
        qqj_v3_public_bridge_v1: {
            schemaVersion: 1, kind: 'qqj-public-memory-bridge',
            getStatus: () => ({ status: 'ready', identity }),
            getSnapshot: () => { calls.push('snapshot'); return snapshot; },
            readContext: async options => {
                calls.push(options);
                return { status: 'ready', identity, actors: [{ entityId: 'gu', displayName: '顾舟', memoryText: '- 本人私密想法（AI #3；记忆 m1）：暗自怀疑守门人认出了他。' }] };
            },
            getPromptSnapshot: () => { calls.push('prompt'); return { status: 'ready', identity, recall: { text: '上次正文召回的事实' }, prequel: { text: '上次正文准备的前情' } }; },
            getPeopleAvatars: () => { calls.push('avatar'); return { status: 'ready', identity, avatarsByEntityId: { gu: 'data:image/png;base64,SECRET' } }; },
            readWorldInfo: () => { calls.push('worldbook'); return { status: 'ready', identity, worldbook: [{ uid: 42, comment: '顾舟身份', content: '顾舟原为钟楼守门人的学生。' }] }; },
            readMemory: () => { calls.push('long-memory'); return { status: 'ready', identity,
                text: '[长期剧情记忆]\n- AI #3（雾季三年四月初一）：顾舟借了地图。\n  - 未结事项（相关人物：顾舟）：还没查出钟声的来历。\n\n[当前人物状态]\n不用读这一区' }; },
        },
        qqj_qianshi_backend_v1: {
            schemaVersion: 1, kind: 'qqj-qianshi-backend-bridge',
            getSnapshot: () => { calls.push('affairs'); return affairs; },
        },
    };
    const open = () => {
        const space = createSpaceFeature({
            context: () => host,
            readStore: key => structuredClone(stores.get(key.chatId)),
            writeStore: (key, value) => { stores.set(key.chatId, structuredClone(value)); return true; },
            loadConfig: () => ({ url: 'https://fixture.invalid/v1', key: 'fixture' }),
            contextEnv: {
                context: () => host,
                settings: () => ({ useQianQianJie: globalSelected }),
                readMemory: (_ctx, question) => { calls.push(['ordinary', question]); return '普通来源可继续使用'; },
                readRecent: () => '近期聊天正文可继续使用',
                qianQianJieGlobals: globals,
            },
            postCompletion: async ({ messages }) => { requests.push(messages); return '模拟的局外回答。'; },
        });
        space.repository.load();
        return space;
    };
    return { open, globals, identity, snapshot, affairs, calls, requests, stores, switchHost: (chatId, fields) => { host = { ...host, chatId, ...fields }; } };
}

test('ordinary conversation, plugin questions and explicitly declined lookup never access QQJ', async () => {
    const h = fixture({ globalSelected: true });
    const space = h.open();
    for (const question of ['随便聊聊故事怎么开头', '侦探正在调查失踪案，给他想个动机', '帮我检查这段有没有错别字', '千千结这个插件怎么用？', '不用查千结，想个钟楼开场', '上次正文写了他用过钥匙，你觉得怎样续写？', '一千人里选他当主角']) {
        assert.equal((await space.chat.send(question)).status, 'updated');
        assert.doesNotMatch(h.requests.at(-1)[0].content, /本轮按需查询|普通来源可继续使用/);
    }
    assert.deepEqual(h.calls, []);
});

test('explicit lookup selects the three saved sources and keeps host floor, AI order and private attribution distinct', async () => {
    const h = fixture();
    const question = '请查千结、千人和千事：顾舟在钟楼借地图时私下想什么，状态如何变化，他哪里出生，地图还了吗？';
    assert.equal((await h.open().chat.send(question)).status, 'updated');
    const prompt = h.requests[0][0].content;
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.calls.filter(call => typeof call === 'string'), ['snapshot', 'affairs']);
    assert.deepEqual(h.calls.find(call => call?.focusQuery)?.entityIds, ['gu']);
    for (const marker of ['人工摘要｜宿主第 18 楼（AI #3）', '旧地图。\n守门人', '本人私密想法（宿主第 18 楼（AI #3）', '外露程度：12', '外露程度：0',
        '落川', '使用语言：海岸语', '备注（人工）：已明确清空', '宿主第 32 楼（AI #6）', '整线状态：已完成', '已存事件关系', '普通来源可继续使用']) assert.ok(prompt.includes(marker), marker);
    assert.match(prompt, /宿主楼号未知（AI #99）/);
    assert.doesNotMatch(prompt, /与查询无关资料|不可传的内部字段|宿主第 99 楼/);
});

test('citation follows the saved reply across reopen, new details refresh the query, and an unrelated turn drops the material', async () => {
    const h = fixture({ globalSelected: true });
    const question = '查千结：顾舟在钟楼借走了什么？';
    await h.open().chat.send(question);
    const saved = h.stores.get('chat-a').messages[1].qqjEvidence;
    assert.ok(saved?.id && saved.material.length <= 7000);
    const bridge = h.globals.qqj_v3_public_bridge_v1;
    delete h.globals.qqj_v3_public_bridge_v1;
    const reopened = h.open();
    await reopened.chat.send('这个在几楼？');
    assert.match(h.requests[1][0].content, /上次查到的来源[\s\S]*宿主第 18 楼/);
    const quote = h.stores.get('chat-a').messages[3];
    assert.equal(quote.qqjEvidenceRef, saved.id);
    assert.equal(quote.qqjEvidence, undefined);

    h.globals.qqj_v3_public_bridge_v1 = bridge;
    await reopened.chat.send('后来顾舟又答应了什么？');
    const fresh = h.calls.findLast(call => call?.focusQuery);
    assert.equal(fresh.focusQuery, '后来顾舟又答应了什么？');
    assert.ok(fresh.query.includes(question));
    const before = h.calls.length;
    await reopened.chat.send('我们聊聊服装配色');
    assert.equal(h.calls.length, before);
    assert.doesNotMatch(h.requests[3][0].content, /本轮按需查询|黄纸印/);
    assert.ok(h.requests[3].slice(1).every(message => !Object.hasOwn(message, 'qqjEvidence')));

    const stored = h.stores.get('chat-a');
    const exported = buildPortableChatPackage({ selectedModules: ['space'], roots: { 'sp-store': { version: 1, data: { 'space-chat-user': stored } } } });
    for (const value of [exported.package.modules.space.entries['space-chat-user'], markImportedSpaceHistory(stored)]) {
        assert.ok(value.messages.every(message => !message.qqjEvidence && !message.qqjEvidenceRef));
    }
    assert.equal((await reopened.chat.resendFrom(0, '改聊服装配色')).status, 'updated');
    assert.ok(h.stores.get('chat-a').messages.every(message => !message.qqjEvidence && !message.qqjEvidenceRef));
    await reopened.chat.send(question);
    reopened.chat.clear();
    await reopened.chat.send('这个在几楼？');
    assert.doesNotMatch(h.requests.at(-1)[0].content, /上次查到的来源/);
});

test('query uses authoritative follow state, last prompt snapshot and avatar presence only on those requests', async () => {
    const h = fixture();
    const space = h.open();
    await space.chat.send('换个话题，帮我查千事：都有哪些还在跟进？');
    assert.match(h.requests[0][0].content, /修好钟楼木梯[\s\S]*仍在跟进/);
    assert.doesNotMatch(h.requests[0][0].content, /地图还给守门人/);
    await space.chat.send('上一轮正文实际用了哪些召回和前情？');
    assert.match(h.requests[1][0].content, /上次正文召回的事实[\s\S]*上次正文准备的前情/);
    await space.chat.send('查千人：顾舟有保存的头像吗？');
    assert.match(h.requests[2][0].content, /顾舟的头像[\s\S]*有已保存头像/);
    assert.doesNotMatch(JSON.stringify(h.requests), /base64|SECRET/);
    assert.deepEqual(h.calls.filter(call => typeof call === 'string'), ['affairs', 'prompt', 'snapshot', 'avatar']);
    await space.chat.send('看看顾舟的头像是什么样');
    assert.deepEqual(h.requests[3].at(-1).content.at(-1), { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET' } });
    assert.doesNotMatch(JSON.stringify(h.stores.get('chat-a')), /base64|SECRET/);
    await space.chat.send('去千人帮我看一下顾舟有没有档案？');
    assert.match(h.requests[4][0].content, /出生地：落川/);
});

test('specialized worldbook and long-memory questions select only the requested read-only material', async () => {
    const h = fixture({ globalSelected: true });
    const space = h.open();
    await space.chat.send('用千千结世界书辨认一下顾舟这个角色');
    assert.match(h.requests[0][0].content, /顾舟原为钟楼守门人的学生/);
    assert.deepEqual(h.calls, ['worldbook']);
    await space.chat.send('查千结：顾舟有哪些未结线索，还记了什么时间锚？');
    assert.match(h.requests[1][0].content, /雾季三年四月初一/);
    assert.match(h.requests[1][0].content, /还没查出钟声的来历/);
    assert.doesNotMatch(h.requests[1][0].content, /不用读这一区/);
});

test('mismatched reader identity does not leak evidence and a chat switch stops a pending lookup before dispatch', async () => {
    const h = fixture({ globalSelected: true });
    const space = h.open();
    h.affairs.identity.qqjChatId = 'other-qqj';
    assert.equal((await space.chat.send('查千事：顾舟在钟楼干了什么？')).status, 'updated');
    assert.doesNotMatch(h.requests[0][0].content, /地图还给守门人/);
    assert.match(h.requests[0][0].content, /千事资料不可用/);

    let readStarted, release;
    const started = new Promise(resolve => { readStarted = resolve; });
    const delayed = new Promise(resolve => { release = resolve; });
    h.globals.qqj_v3_public_bridge_v1.readContext = () => { readStarted(); return delayed; };
    const pending = space.chat.send('查千结：顾舟真正的想法是什么？');
    await started;
    h.switchHost('chat-b');
    space.onChatChanged();
    release({ status: 'ready', identity: h.identity, actors: [{ entityId: 'gu', memoryText: '上个聊天的私密资料' }] });
    assert.equal((await pending).status, 'cancelled');
    assert.equal(h.requests.length, 1);
    assert.equal(h.stores.has('chat-b'), false);
    assert.equal((await space.chat.send('新的聊天继续正常讨论')).status, 'updated');
    assert.doesNotMatch(h.requests[1][0].content, /上个聊天的私密资料/);
});
