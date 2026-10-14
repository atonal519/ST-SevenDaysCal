import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySpaceIntent, createSpaceContext, requestedSpaceMaterials } from './context.js';
import { appendSpaceAssistant, pointRawToken } from './schema.js';
import { createSpaceRenderer } from './render.js';
import { markImportedSpaceHistory } from '../../runtime/portable-chat-data.js';
import { normalizeOutlineResponse } from '../outline/schema.js';

test('间只按问题读取相关模块，并在API历史段只剔除本轮末尾用户消息', async () => {
    assert.equal(requestedSpaceMaterials('看看冷知识和今日菜单').cold, true);
    const calls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }),
        settings: () => ({ spacePersona: 'PERSONA' }),
        readOutline: () => { calls.push('outline'); return 'OUTLINE'; },
        readPointScopes: () => { calls.push('points'); return []; },
        readLineRaw: () => { calls.push('lines'); return ''; },
        readLedgerText: () => { calls.push('ledger'); return ''; },
        readColdKnowledge: () => { calls.push('cold'); return 'COLD_FACT'; },
        readDailyMenu: () => { calls.push('menu'); return 'MENU_FACT'; },
        readMemory: async () => { calls.push('memory'); return ''; },
        readRecent: async () => '',
        readCardExtras: () => ({ personaDesc: '', authorNote: '' }),
        readWorldInfo: async () => '',
    });
    const messages = await context.buildMessages({
        target: {}, userMsg: '看看冷知识和今日菜单',
        historySnapshot: [
            { role: 'user', content: '看看冷知识和今日菜单' },
            { role: 'assistant', content: '此前回答' },
            { role: 'user', content: '看看冷知识和今日菜单' },
        ],
    });
    assert.deepEqual(calls, ['cold', 'menu', 'memory']);
    assert.deepEqual(messages.slice(1).map(item => [item.role, item.content]), [
        ['user', '看看冷知识和今日菜单'], ['assistant', '此前回答'], ['user', '看看冷知识和今日菜单'],
    ]);
    assert.match(messages[0].content, /COLD_FACT/);
    assert.match(messages[0].content, /MENU_FACT/);
    assert.doesNotMatch(messages[0].content, /OUTLINE|POINT_TOKEN|LINE_TOKEN/);
});

test('间普通讨论不预读无关模块，故事日期只使用明确提供的证据', async () => {
    const calls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutline: () => { calls.push('outline'); return 'PLAN'; },
        readPointScopes: () => { calls.push('points'); return []; },
        readLineRaw: () => { calls.push('lines'); return ''; },
        readAlmanacText: () => { calls.push('almanac'); return 'ALMANAC'; },
        readCalendarText: () => { calls.push('calendar'); return 'CALENDAR'; },
        readStoryDate: () => { calls.push('date'); return ''; },
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const [system] = await context.buildMessages({ target: {}, userMsg: '这段关系合理吗？', historySnapshot: [] });
    assert.deepEqual(calls, []);
    assert.doesNotMatch(system.content, /PLAN|ALMANAC|CALENDAR|当前故事日期证据/);
});

test('模块取材意图使用明确名称，避免把历法模板或故事时间锚当成模块查询', () => {
    assert.deepEqual(requestedSpaceMaterials('历法模板'), {
        outline: false, points: false, lines: false, ledger: false, date: false,
        calendar: true, cold: false, menu: false, theater: false, coordinate: false,
    });
    assert.equal(requestedSpaceMaterials('故事时间锚').coordinate, false);
    assert.equal(requestedSpaceMaterials('展开第 4 楼坐标正文').coordinate, true);
    assert.equal(requestedSpaceMaterials('展开棱模板“春日”正文').theater, true);
});

test('新模块写意图走讨论提示，明确菜单点卡仍使用点卡合同', async () => {
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readDailyMenu: () => '今日菜单：SPACE_MENU_SOURCE',
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const menu = await context.buildMessages({ target: {}, userMsg: '生成今日菜单', historySnapshot: [] });
    assert.match(menu[0].content, /用户要求处理今日菜单/);
    assert.match(menu[0].content, /不要因此强行生成任何点、线、轴日期、历法或面方案/);
    assert.match(menu[0].content, /SPACE_MENU_SOURCE/);
    assert.doesNotMatch(menu[0].content, /<schedule_widget(?:\s|>)/);
    const point = await context.buildMessages({ target: {}, userMsg: '参考菜单生成点卡', historySnapshot: [] });
    assert.match(point[0].content, /用户要求生成或修改点卡片/);
    assert.match(point[0].content, /<schedule_widget/);
    assert.match(point[0].content, /SPACE_MENU_SOURCE/);
});

test('讨论定稿后自然请求面方案只在本轮读取完整正式稿并保留短正文签名', async () => {
    const original = '<outline_widget>\nBeat: 一周后|会面|关系|主线|决定待定\nScene: 双方先交换信息\n</outline_widget>';
    const calls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutlineDraftSnapshot: () => { calls.push('full-outline'); return { raw: original, ts: 1, cursor: 2 }; },
        readOutline: () => { calls.push('outline-projection'); return '当前与下一节点'; },
        rawToken: pointRawToken,
        readMemory: async (_ctx, query) => { calls.push(`memory:${query || ''}`); return ''; },
        readRecent: async () => '最近剧情正文', readWorldInfo: async () => '',
    });
    const historySnapshot = [
        { role: 'user', content: '先聊人物见面时的误会' },
        { role: 'assistant', content: '可以让双方各自误读一条信息。' },
    ];
    const message = '把刚才的思路整理成可应用到面的完整方案';
    const intent = classifySpaceIntent(message, historySnapshot);
    assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget']);
    const messages = await context.buildMessages({ target: {}, userMsg: message, historySnapshot });
    assert.deepEqual(calls, ['full-outline', `memory:${message}`]);
    assert.equal(messages.expectedWidgetKind, 'outline_widget');
    assert.equal(messages.outlineRawToken, pointRawToken(original));
    assert.equal(JSON.stringify(messages.slice(1)).includes(original), false);
    assert.match(messages[0].content, /本轮面编辑草稿/);
    assert.match(messages[0].content, /尚未应用/);

    const returnedWithoutWrapper = 'Beat: 两周后|误会澄清|关系|主线|信任增加\nScene: 两人核对消息来源并约定下次会面\nBeat: 三周后|残缺||||\nScene:';
    const stored = appendSpaceAssistant(historySnapshot, returnedWithoutWrapper, {
        expectedWidgetKind: messages.expectedWidgetKind,
        outlineRawToken: messages.outlineRawToken,
    }).at(-1);
    assert.equal(stored.content, normalizeOutlineResponse(returnedWithoutWrapper));
    assert.equal(stored.content.includes(returnedWithoutWrapper), false);
    assert.equal(stored.outlineRawToken, pointRawToken(original));
    const savedForApi = (await import('./schema.js')).stripWidgetsForApi([stored]);
    assert.equal(savedForApi[0].content.includes('误会澄清'), false);
    assert.equal(savedForApi[0].content.includes('残缺'), false);
    assert.equal(Object.hasOwn(savedForApi[0], 'outlineRawToken'), false);
    const renderer = createSpaceRenderer();
    const cards = renderer.message('ai', stored.content, 2, () => 'candidate', {
        expectedWidgetKind: 'outline_widget', outlineRawToken: pointRawToken(original), currentOutlineRaw: original,
    });
    assert.match(cards.widgetCards, /应用到面/);
    assert.match(cards.widgetCards, /误会澄清/);
    assert.match(cards.widgetCards, /两人核对消息来源并约定下次会面/);
    assert.doesNotMatch(cards.widgetCards, /残缺|Beat:/);
    assert.doesNotMatch(cards.widgetCards, /与当前面内容一致/);
    const sameContentCard = renderer.message('ai', stored.content, 2, () => 'same', {
        expectedWidgetKind: 'outline_widget', outlineRawToken: pointRawToken(original), currentOutlineRaw: stored.content,
    });
    assert.match(sameContentCard.widgetCards, /与当前面内容一致/);
    const invalidCard = renderer.message('ai', '<outline_widget>Beat: 错稿||||\nScene:</outline_widget>', 3, () => 'invalid', {
        expectedWidgetKind: 'outline_widget', outlineRawToken: pointRawToken(original),
    });
    assert.match(invalidCard.widgetCards, /方案内容不完整，无法应用/);
    assert.match(invalidCard.widgetCards, /<details class="sp-raw"><summary>查看原始回复/);
    const imported = markImportedSpaceHistory([stored]);
    assert.equal(imported[0].portableReadonly, true);
    const legacyUnwrapped = markImportedSpaceHistory([{
        role: 'assistant', content: returnedWithoutWrapper, expectedWidgetKind: 'outline_widget',
    }]);
    assert.equal(legacyUnwrapped[0].portableReadonly, true);
    const readonlyCard = createSpaceRenderer().message('ai', legacyUnwrapped[0].content, 0, () => 'imported', {
        expectedWidgetKind: legacyUnwrapped[0].expectedWidgetKind,
        readOnly: legacyUnwrapped[0].portableReadonly,
    });
    assert.doesNotMatch(readonlyCard.widgetCards, /class="sp-space-widget-apply"/);
    const apiHistory = (await import('./schema.js')).stripWidgetsForApi(legacyUnwrapped);
    assert.equal(apiHistory[0].content.includes('两周后'), false);
    assert.equal(Object.hasOwn(apiHistory[0], 'expectedWidgetKind'), false);
    assert.equal(Object.hasOwn(apiHistory[0], 'outlineRawToken'), false);
});

test('面请求区分“别讨论后直接生成”和“不要生成”，去间预填是分析讨论且语义路由按需带面合同', async () => {
    assert.deepEqual(
        [classifySpaceIntent('别讨论，直接生成面').action, classifySpaceIntent('别讨论，直接生成面').kind],
        ['write', 'outline_widget'],
    );
    assert.equal(classifySpaceIntent('不要生成面').action, 'discuss');

    const prefill = '你觉得当前面的剧情方向有哪些可调整之处？';
    const prefillIntent = classifySpaceIntent(prefill);
    assert.equal(prefillIntent.action, 'discuss');
    const fullReads = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutline: () => '当前面可讨论的摘要',
        readOutlineDraftSnapshot: () => { fullReads.push('full'); return { raw: '<outline_widget>Beat: 现状|正式稿|阶段|主线|现状\nScene: 当前正文</outline_widget>' }; },
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const [prefillPrompt] = await context.buildMessages({ target: {}, userMsg: prefill, historySnapshot: [] });
    assert.doesNotMatch(prefillPrompt.content, /<outline_widget>/);
    assert.deepEqual(fullReads, []);
    const [face] = await context.buildMessages({ target: {}, userMsg: '给我生成一份面方案', historySnapshot: [] });
    assert.match(face.content, /<outline_widget>/);
    assert.deepEqual(fullReads, ['full']);
});

test('明确委托的“来/出”数量请求读取完整正式稿并带面候选合同', async () => {
    const original = '<outline_widget>Beat: 当前|正式稿|阶段|主线|保留\nScene: 当前正文</outline_widget>';
    for (const message of ['给我来一版大纲', '给我出一版面', '给我来个面', '帮我出一版面']) {
        const calls = [];
        const context = createSpaceContext({
            context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
            readOutlineDraftSnapshot: () => { calls.push('full'); return { raw: original, ts: 1, cursor: 1 }; },
            rawToken: pointRawToken,
            readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
        });
        const intent = classifySpaceIntent(message, []);
        assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget'], message);
        const messages = await context.buildMessages({ target: {}, userMsg: message, historySnapshot: [] });
        assert.deepEqual(calls, ['full'], message);
        assert.equal(messages.expectedWidgetKind, 'outline_widget', message);
        assert.equal(messages.outlineRawToken, pointRawToken(original), message);
        assert.match(messages[0].content, /<outline_widget>/, message);
    }
    assert.equal(classifySpaceIntent('不要生成面', []).action, 'discuss');

    for (const message of ['接下来见面怎么安排？', '给我来一个面包']) {
        const intent = classifySpaceIntent(message, []);
        assert.notDeepEqual([intent.action, intent.kind], ['write', 'outline_widget'], message);
        const fullReads = [];
        const context = createSpaceContext({
            context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
            readOutlineDraftSnapshot: () => { fullReads.push('full'); return { raw: original, ts: 1, cursor: 1 }; },
            readOutline: () => '只读面摘要', rawToken: pointRawToken,
            readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
        });
        const messages = await context.buildMessages({ target: {}, userMsg: message, historySnapshot: [] });
        assert.deepEqual(fullReads, [], message);
        assert.equal(messages.expectedWidgetKind, undefined, message);
        assert.equal(messages.outlineRawToken, undefined, message);
        assert.doesNotMatch(messages[0].content, /<outline_widget>|本轮面编辑草稿/, message);
    }
});

test('普通问面不读取完整正式稿，未指定面目标的应用按钮请求仍先确认', async () => {
    const clarify = classifySpaceIntent('给我应用按钮', []);
    assert.deepEqual([clarify.action, clarify.reason], ['clarify', 'missing-widget-kind']);
    const clarifyContext = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const [clarifyPrompt] = await clarifyContext.buildMessages({ target: {}, userMsg: '给我应用按钮', historySnapshot: [] });
    assert.match(clarifyPrompt.content, /点、线、轴日期、历法还是面/);
    const calls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutline: () => { calls.push('projection'); return '有效投影'; },
        readOutlineDraftSnapshot: () => { calls.push('full'); return { raw: 'FULL_RAW' }; },
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    await context.buildMessages({ target: {}, userMsg: '现在面规划到哪？', historySnapshot: [] });
    assert.deepEqual(calls, ['projection']);
});
