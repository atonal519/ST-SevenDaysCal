import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySpaceIntent, createSpaceContext, requestedSpaceMaterials } from './context.js';
import { buildSpaceHelpText } from './prompts.js';
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

test('间仅在线卡选中时加入同源事实与待展开指导', async () => {
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const [linePrompt] = await context.buildMessages({ target: {}, userMsg: '生成一条线卡', historySnapshot: [] });
    assert.match(linePrompt.content, /Next 是待发生方向/);
    assert.match(linePrompt.content, /无新依据的未展开线维持当前状态和入口/);
    assert.match(linePrompt.content, /<line_widget>/);
    assert.match(linePrompt.content, /Desc: 事件线当前状态、背景与有关各方位置/);
    assert.match(linePrompt.content, /Next: 有依据的下一变化或恢复条件/);
    assert.equal((linePrompt.content.match(/【线索事实与待展开进展】/g) || []).length, 1);

    const [ordinaryPrompt] = await context.buildMessages({ target: {}, userMsg: '这条关系线的节奏自然吗？', historySnapshot: [] });
    assert.doesNotMatch(ordinaryPrompt.content, /【线索事实与待展开进展】/);
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
    for (const message of ['给我来一版大纲', '给我出一版面', '给我来个面', '帮我出一版面', '把他们的背景写进面大纲，张三和李四']) {
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

test('间本轮明确目标优先于背景模块与最近卡型', () => {
    const faceHistory = [{
        role: 'assistant',
        content: '<outline_widget>Beat: 未来|旧面节点|关系|主线|结果\nScene: 旧面正文</outline_widget>',
    }];
    for (const message of ['生成到点', '面用不了，生成到点', '把刚才的面改成点', '不要面，生成到点']) {
        const intent = classifySpaceIntent(message, faceHistory);
        assert.deepEqual([intent.action, intent.kind], ['write', 'schedule_widget'], message);
    }
    assert.deepEqual(
        [classifySpaceIntent('生成点和线', []).action, classifySpaceIntent('生成点和线', []).reason],
        ['clarify', 'ambiguous-widget-kind'],
    );
    assert.equal(classifySpaceIntent('创建一条事件线，再插个点', []).reason, 'ambiguous-widget-kind');
    assert.equal(classifySpaceIntent('解释“生成到点”是什么意思', faceHistory).action, 'discuss');
    assert.equal(classifySpaceIntent('别给我写一条线', faceHistory).action, 'discuss');
    assert.equal(classifySpaceIntent('不要生成点卡', faceHistory).action, 'discuss');
    assert.equal(classifySpaceIntent('请解释“生成到点”这句话', faceHistory).action, 'discuss');
    assert.equal(classifySpaceIntent('只讨论，不生成卡片', faceHistory).action, 'discuss');
    assert.equal(classifySpaceIntent('如何生成到点？', faceHistory).action, 'discuss');
    assert.equal(classifySpaceIntent('怎么生成到点？', faceHistory).action, 'discuss');
    const faultBackground = classifySpaceIntent('面模块没生效，生成到点', faceHistory);
    assert.deepEqual([faultBackground.action, faultBackground.kind, faultBackground.faq], ['write', 'schedule_widget', false]);
    assert.deepEqual(
        [classifySpaceIntent('把刚才的思路再短些', faceHistory).action, classifySpaceIntent('把刚才的思路再短些', faceHistory).kind],
        ['revise-recent', 'outline_widget'],
    );
});

test('从旧面转换为点只注入旧卡正文素材并使用新点合同', async () => {
    const faceHistory = [{
        role: 'assistant',
        content: '<outline_widget>Beat: 未来|旧面节点|关系|主线|结果\nScene: 转换素材正文</outline_widget>',
    }];
    const calls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutlineDraftSnapshot: () => { calls.push('full-outline'); return { raw: '不可额外读取的正式面' }; },
        readOutline: () => { calls.push('outline-projection'); return '面摘要'; },
        readPointScopes: () => [{ view: 'user', charName: '', raw: 'CURRENT_POINT' }],
        numberedPoints: raw => `#1 旧点\n#2 ${raw}`,
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const messages = await context.buildMessages({
        target: {}, userMsg: '把刚才的面改成点', historySnapshot: faceHistory,
    });
    assert.equal(messages.expectedWidgetKind, 'schedule_widget');
    assert.deepEqual(calls, []);
    assert.match(messages[0].content, /转换素材正文/);
    assert.doesNotMatch(messages[0].content, /<outline_widget>|本轮面编辑草稿|不要新增/);
    assert.match(messages[0].content, /<schedule_widget>/);
    assert.match(messages[0].content, /CURRENT_POINT/);
});

test('点线转面沿用旧卡正文来源，普通新点不把目标卡片误作回指', async () => {
    const pointHistory = [{ role: 'assistant', content: '<schedule_widget>Event: main|点源标题|点源正文|明早|港口|关系进展</schedule_widget>' }];
    const lineHistory = [{ role: 'assistant', content: '<line_widget>Line: 线源标题|延展|近日|world|false|false\nDesc: 旧线正文\nNext: 后续处理</line_widget>' }];
    const calls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutlineDraftSnapshot: () => { calls.push('formal-outline'); return { raw: '<outline_widget>当前正式面基准</outline_widget>' }; },
        readPointScopes: () => [], readLineRaw: () => '',
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const pointToOutline = await context.buildMessages({ target: {}, userMsg: '把刚才的点改成面', historySnapshot: pointHistory });
    assert.equal(pointToOutline.expectedWidgetKind, 'outline_widget');
    assert.match(pointToOutline[0].content, /点源正文/);
    assert.match(pointToOutline[0].content, /当前正式面基准/);
    assert.match(pointToOutline[0].content, /仅作本轮转换素材/);
    const lineToOutline = await context.buildMessages({ target: {}, userMsg: '把刚才的线改成面', historySnapshot: lineHistory });
    assert.equal(lineToOutline.expectedWidgetKind, 'outline_widget');
    assert.match(lineToOutline[0].content, /旧线正文/);
    assert.deepEqual(calls, ['formal-outline', 'formal-outline']);

    const newPoint = await context.buildMessages({
        target: {}, userMsg: '生成一张点卡片',
        historySnapshot: [{ role: 'assistant', content: '<outline_widget>不应带入的旧面正文</outline_widget>' }],
    });
    assert.equal(newPoint.expectedWidgetKind, 'schedule_widget');
    assert.doesNotMatch(newPoint[0].content, /不应带入的旧面正文|旧面卡片正文/);
});

test('点目标动作优先于前置面模块故障，生成用法问句仍按帮助回答', async () => {
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readPointScopes: () => [], readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const failureThenGenerate = await context.buildMessages({
        target: {}, userMsg: '面模块没生效，生成到点', historySnapshot: [],
    });
    assert.equal(failureThenGenerate.expectedWidgetKind, 'schedule_widget');
    assert.match(failureThenGenerate[0].content, /<schedule_widget>/);
    assert.doesNotMatch(failureThenGenerate[0].content, /构画·功能与设置速查/);

    const howTo = await context.buildMessages({ target: {}, userMsg: '如何生成到点？', historySnapshot: [] });
    assert.equal(howTo.expectedWidgetKind, undefined);
    assert.doesNotMatch(howTo[0].content, /<schedule_widget>/);
});

test('明确来源类型从历史中选择同类卡，无来源类型才用最近卡', async () => {
    const mixedHistory = [
        { role: 'assistant', content: '<outline_widget>Beat: 面源|正式面|关系|主线|面源正文\nScene: 面节点场景</outline_widget>' },
        { role: 'assistant', content: '<line_widget>Line: 线源|延展|近日|world|false|false\nDesc: 线源正文\nNext: 线节点后续</line_widget>' },
    ];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutlineDraftSnapshot: () => ({ raw: '正式面基准' }),
        readPointScopes: () => [], readLineRaw: () => '',
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const faceToPoint = await context.buildMessages({
        target: {}, userMsg: '把刚才的面改成点', historySnapshot: mixedHistory,
    });
    assert.equal(faceToPoint.expectedWidgetKind, 'schedule_widget');
    assert.match(faceToPoint[0].content, /面源正文/);
    assert.doesNotMatch(faceToPoint[0].content, /线源正文/);

    const faceNoBa = await context.buildMessages({
        target: {}, userMsg: '刚才那张面改成点', historySnapshot: mixedHistory,
    });
    assert.equal(faceNoBa.expectedWidgetKind, 'schedule_widget');
    assert.match(faceNoBa[0].content, /面源正文/);
    assert.doesNotMatch(faceNoBa[0].content, /线源正文/);

    const missingSource = await context.buildMessages({
        target: {}, userMsg: '把刚才的面改成点',
        historySnapshot: [{ role: 'assistant', content: '<line_widget>线源正文</line_widget>' }],
    });
    assert.equal(missingSource.expectedWidgetKind, undefined);
    assert.match(missingSource[0].content, /没有该类型的卡片|提供那张卡的内容/);
    assert.doesNotMatch(missingSource[0].content, /线源正文|<schedule_widget>/);

    const untyped = await context.buildMessages({
        target: {}, userMsg: '把刚才那张改成点', historySnapshot: mixedHistory,
    });
    assert.equal(untyped.expectedWidgetKind, 'schedule_widget');
    assert.match(untyped[0].content, /线源正文/);
    assert.doesNotMatch(untyped[0].content, /面源正文/);
});

test('当前点线列表只在明确编辑现有同类条目时附加禁止新增合同', async () => {
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readPointScopes: () => [{ view: 'user', charName: '', raw: 'CURRENT_POINT' }],
        readLineRaw: () => 'CURRENT_LINE', parseLines: raw => [{ name: raw, stage: '延展', desc: '旧线' }],
        numberedPoints: raw => `#1 旧点\n#2 ${raw}`,
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const point = await context.buildMessages({ target: {}, userMsg: '生成一条点卡', historySnapshot: [] });
    assert.match(point[0].content, /CURRENT_POINT/);
    assert.doesNotMatch(point[0].content, /不要新增/);
    const line = await context.buildMessages({ target: {}, userMsg: '生成一条线卡', historySnapshot: [] });
    assert.match(line[0].content, /CURRENT_LINE/);
    assert.doesNotMatch(line[0].content, /不要新增/);
    const edited = await context.buildMessages({ target: {}, userMsg: '把第2条点改为周五', historySnapshot: [] });
    assert.match(edited[0].content, /不要新增/);
    assert.match(edited[0].content, /#2 CURRENT_POINT/);
    const editedLine = await context.buildMessages({ target: {}, userMsg: '把第1条线改为周五', historySnapshot: [] });
    assert.match(editedLine[0].content, /不要新增/);
    assert.match(editedLine[0].content, /CURRENT_LINE/);
});

test('当前点线共用编辑动作读取现值并保持解释、否定与转换目标', async () => {
    const cases = [
        ['丰富当前点第1条', 'schedule_widget'],
        ['把当前点第1条扩写一下', 'schedule_widget'],
        ['补充当前线第1条', 'line_widget'],
        ['把当前线第1条扩写一下', 'line_widget'],
    ];
    for (const [message, kind] of cases) {
        const intent = classifySpaceIntent(message, []);
        assert.deepEqual([intent.action, intent.kind, intent.editExisting], ['write', kind, true], message);
    }

    for (const message of [
        '不要丰富当前点第1条',
        '请解释如何补充当前线第1条',
        '当前点第1条已经丰富好了，你看看',
    ]) {
        const intent = classifySpaceIntent(message, []);
        assert.notEqual(intent.action, 'write', message);
        assert.deepEqual(intent.allowedWidgetKinds || [], [], message);
    }

    const converted = classifySpaceIntent('丰富当前点第1条并生成一张线卡', []);
    assert.deepEqual([converted.action, converted.kind], ['write', 'line_widget']);
    assert.equal(converted.editExisting, undefined);
    const convertedBack = classifySpaceIntent('补充当前线第1条并生成一张点卡', []);
    assert.deepEqual([convertedBack.action, convertedBack.kind], ['write', 'schedule_widget']);
    assert.equal(convertedBack.editExisting, undefined);

    const reads = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readPointScopes: () => { reads.push('point'); return [
            { view: 'user', charName: '', raw: 'USER_POINT_SOURCE' },
            { view: 'char', charName: 'TA', raw: 'CHAR_POINT_SOURCE' },
        ]; },
        numberedPoints: raw => `#1 ${raw}`,
        readLineRaw: () => { reads.push('line'); return 'LINE_SOURCE'; },
        parseLines: raw => [{ name: '当前线', stage: '延展', desc: raw }],
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const oldPointHistory = appendSpaceAssistant([], '<schedule_widget>Event: main|OLD_PERSON_ITEM|OLD_POINT_BODY|明早|港口|旧关系</schedule_widget>', {
        expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'],
    });
    const pointIntent = classifySpaceIntent('把当前点第1条扩写一下', oldPointHistory);
    assert.equal(pointIntent.recentWidget, null);
    const point = await context.buildMessages({ target: {}, userMsg: '把当前点第1条扩写一下', historySnapshot: oldPointHistory });
    assert.equal(point.expectedWidgetKind, 'schedule_widget');
    assert.match(point[0].content, /USER_POINT_SOURCE/);
    assert.match(point[0].content, /CHAR_POINT_SOURCE/);
    assert.doesNotMatch(point[0].content, /OLD_PERSON_ITEM|OLD_POINT_BODY/);
    assert.match(point[0].content, /不要新增/);
    const oldLineHistory = appendSpaceAssistant([], '<line_widget>Line: 旧线|延展|近日|world|false|false\nDesc: OLD_LINE_BODY\nNext: 旧后续</line_widget>', {
        expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'],
    });
    const lineIntent = classifySpaceIntent('把当前线第1条扩写一下', oldLineHistory);
    assert.equal(lineIntent.recentWidget, null);
    const line = await context.buildMessages({ target: {}, userMsg: '把当前线第1条扩写一下', historySnapshot: oldLineHistory });
    assert.equal(line.expectedWidgetKind, 'line_widget');
    assert.match(line[0].content, /LINE_SOURCE/);
    assert.doesNotMatch(line[0].content, /OLD_LINE_BODY/);
    assert.match(line[0].content, /不要新增/);
    assert.deepEqual(reads, ['point', 'line']);
});

test('间内仅线卡提示复用关系自主校准，普通讨论与点面提示不受影响', async () => {
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readPointScopes: () => [], readLineRaw: () => '', numberedPoints: () => '',
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const line = await context.buildMessages({ target: {}, userMsg: '生成一条线卡', historySnapshot: [] });
    assert.match(line[0].content, /【人物自主与相互回应】/);
    assert.match(line[0].content, /未发生的回应不写成事实/);
    assert.match(line[0].content, /【输出前复核】/);
    assert.match(line[0].content, /只输出约定结构，不展示复核过程/);

    for (const userMsg of ['生成一个点卡', '生成一个面方案', '这段关系里两个人怎么理解彼此？']) {
        const messages = await context.buildMessages({ target: {}, userMsg, historySnapshot: [] });
        assert.doesNotMatch(messages[0].content, /【人物自主与相互回应】/, userMsg);
        assert.doesNotMatch(messages[0].content, /【输出前复核】/, userMsg);
    }
});

test('语义路由只允许单一可识别卡型，并包含该类型的业务提示', async () => {
    const userMsg = '给这条线索一些后续';
    assert.equal(classifySpaceIntent(userMsg, []).action, 'semantic-route');
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readPointScopes: () => [], readLineRaw: () => '', numberedPoints: () => '',
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const messages = await context.buildMessages({ target: {}, userMsg, historySnapshot: [] });
    assert.deepEqual(messages.allowedWidgetKinds, ['line_widget']);
    assert.match(messages[0].content, /本轮只允许选择以下唯一卡型：线/);
    assert.match(messages[0].content, /【人物自主与相互回应】/);
    assert.match(messages[0].content, /【输出前复核】/);
});

test('间格式纠错沿用可信预期卡型和原请求，并为明确第 N 条线重发提供当前编辑合同', async () => {
    const kinds = [
        ['schedule_widget', '生成一张点卡', '<schedule_widget>', 'CURRENT_POINT'],
        ['line_widget', '生成一条线卡', '<line_widget>', 'CURRENT_LINE'],
        ['almanac_widget', '生成一个历卡', '<almanac_widget>', 'CURRENT_ALMANAC'],
        ['era_widget', '生成一张历法卡', '<era_widget>', 'CURRENT_CALENDAR'],
        ['outline_widget', '生成一份面方案', '<outline_widget>', 'CURRENT_OUTLINE'],
    ];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readPointScopes: () => [{ view: 'user', raw: 'CURRENT_POINT' }],
        numberedPoints: raw => `#1 ${raw}`,
        readLineRaw: () => 'CURRENT_LINE', parseLines: () => Array.from({ length: 9 }, (_, index) => ({ name: index === 8 ? 'CURRENT_LINE' : `旧线${index + 1}`, stage: '延展', desc: '当前线' })),
        readAlmanacText: () => 'CURRENT_ALMANAC', readCalendarText: () => 'CURRENT_CALENDAR',
        readOutlineDraftSnapshot: () => ({ raw: 'CURRENT_OUTLINE' }),
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    for (const [kind, originalRequest, tag, current] of kinds) {
        let history = [{ role: 'user', content: originalRequest }];
        history = appendSpaceAssistant(history, '{"operation":"upsert_character_state"}', { expectedWidgetKind: kind });
        history.push(
            { role: 'user', content: '卡片格式还是不对' },
            { role: 'assistant', content: '请把模板发给我。' },
        );
        const messages = await context.buildMessages({
            target: {}, userMsg: '你直接去看点和线的替换还不行吗', historySnapshot: history,
        });
        assert.equal(messages.expectedWidgetKind, kind, originalRequest);
        assert.match(messages[0].content, new RegExp(tag.replace(/[<>]/g, '\\$&')), originalRequest);
        assert.match(messages[0].content, new RegExp(current), originalRequest);
        assert.match(messages[0].content, /不要要求用户提供内部模板/, originalRequest);
        assert.doesNotMatch(messages[0].content, /不要新增/, originalRequest);
        if (kind === 'almanac_widget') assert.match(messages[0].content, /CURRENT_CALENDAR/);
    }

    const lineHistory = [{ role: 'assistant', content: '当前有九条线。' }];
    const line = await context.buildMessages({
        target: {}, userMsg: '把第9条线按正确卡片格式重新输出', historySnapshot: lineHistory,
    });
    assert.equal(classifySpaceIntent('把第9条线按正确卡片格式重新输出', lineHistory).action, 'write');
    assert.equal(line.expectedWidgetKind, 'line_widget');
    assert.match(line[0].content, /#9 CURRENT_LINE/);
    assert.match(line[0].content, /不要新增/);
    assert.match(line[0].content, /序号取对应列表里 #N 的数字 N/);

    const editedHistory = [{ role: 'user', content: '把第2条线改成周五' }];
    editedHistory.splice(1, 0, ...appendSpaceAssistant(editedHistory, '{"bad":true}', { expectedWidgetKind: 'line_widget' }).slice(1));
    const correctedEdit = await context.buildMessages({
        target: {}, userMsg: '卡片格式还是不对', historySnapshot: editedHistory,
    });
    assert.match(correctedEdit[0].content, /不要新增/);
    assert.match(correctedEdit[0].content, /#9 CURRENT_LINE/);

    const explicitSwitch = classifySpaceIntent('把上一张点卡改成线卡格式重新输出', [
        { role: 'assistant', content: '{"bad":true}', expectedWidgetKind: 'schedule_widget' },
    ]);
    assert.deepEqual([explicitSwitch.action, explicitSwitch.kind], ['write', 'line_widget']);
    assert.equal(classifySpaceIntent('卡片格式还是不对', []).action, 'clarify');
    assert.equal(classifySpaceIntent('这段关系为什么会这样？', [
        { role: 'assistant', content: '{"bad":true}', expectedWidgetKind: 'line_widget' },
    ]).action, 'discuss');
});

test('间连续格式纠错保留最初编辑性质，且本轮新建、解释和换型请求优先', () => {
    const originalRequest = '把第2条线改成周五';
    let history = [{ role: 'user', content: originalRequest }];
    const originalIntent = classifySpaceIntent(originalRequest, history);
    assert.equal(originalIntent.editExisting, true);
    history = appendSpaceAssistant(history, '{"operation":"upsert_character_state"}', {
        expectedWidgetKind: originalIntent.kind,
    });

    const firstCorrection = classifySpaceIntent('卡片格式还是不对', history);
    assert.equal(firstCorrection.editExisting, true);
    history = appendSpaceAssistant(history, '请把模板发给我。', {
        expectedWidgetKind: firstCorrection.kind,
    });
    const secondCorrection = classifySpaceIntent('你直接去看点和线的替换还不行吗', history);
    assert.equal(secondCorrection.kind, 'line_widget');
    assert.equal(secondCorrection.editExisting, true);

    const explicitNew = classifySpaceIntent('新建一条线按正确卡片格式重新输出', history);
    assert.equal(explicitNew.kind, 'line_widget');
    assert.equal(explicitNew.editExisting, undefined);

    const explanation = classifySpaceIntent('解释一下为什么卡片格式不对', history);
    assert.equal(explanation.action, 'discuss');

    const changedTarget = classifySpaceIntent('点卡格式不对，改成线卡重新输出', history);
    assert.equal(changedTarget.kind, 'line_widget');
    assert.equal(changedTarget.editExisting, undefined);

    const ambiguousTarget = classifySpaceIntent('把点卡和线卡按正确格式重新输出', [
        { role: 'assistant', content: '{"bad":true}', expectedWidgetKind: 'schedule_widget' },
    ]);
    assert.deepEqual([ambiguousTarget.action, ambiguousTarget.reason], ['clarify', 'ambiguous-widget-kind']);
});

test('间历史裁掉原用户消息后仍复用assistant保存的预期卡型', () => {
    const intent = classifySpaceIntent('卡片格式还是不对', [
        { role: 'assistant', content: '{"bad":true}', expectedWidgetKind: 'line_widget' },
    ]);
    assert.equal(intent.action, 'write');
    assert.equal(intent.kind, 'line_widget');
    assert.equal(intent.editExisting, undefined);
});

test('间角色卡人格模式限定普通文字聊天并保持顾问模式兼容', async () => {
    const characterData = '群聊卡资料：用户操控的人物林澈；AI角色乔安沉稳，AI角色周言善于观察。';
    const makeContext = (settings, counters = {}) => createSpaceContext({
        context: () => ({ name1: '林澈', name2: '多人角色卡' }),
        settings: () => settings,
        readCharacterData: () => { counters.characterReads = (counters.characterReads || 0) + 1; return characterData; },
        readMemory: async () => '', readRecent: async () => '',
        readWorldInfo: async (_ctx, _message, _history, supplement) => { counters.titleSupplement = supplement; return ''; },
    });

    const defaultPrompt = await makeContext({ spacePersona: 'CUSTOM_ADVISOR_VOICE' })
        .buildMessages({ target: {}, userMsg: '乔安，你怎么看这件事？', historySnapshot: [] });
    assert.match(defaultPrompt[0].content, /故事外的创作顾问/);
    assert.match(defaultPrompt[0].content, /CUSTOM_ADVISOR_VOICE/);
    assert.doesNotMatch(defaultPrompt[0].content, /多人卡.*点名优先/);

    const counters = {};
    const activeSettings = { spacePersona: 'CUSTOM_ADVISOR_VOICE', spaceUseCharacterPersona: true };
    const context = makeContext(activeSettings, counters);
    const discussion = await context.buildMessages({ target: {}, userMsg: '乔安，你怎么看这件事？', historySnapshot: [] });
    assert.equal(counters.characterReads, 1);
    assert.equal(discussion[0].content.split(characterData).length - 1, 1);
    assert.match(discussion[0].content, /角色卡人格模式】只借当前卡中AI人物的性格、说话习惯与思考方式作为聊天人格/);
    assert.match(discussion[0].content, /直接用普通文字回答林澈（用户）/);
    assert.match(discussion[0].content, /林澈是用户角色，不作为AI人格来源/);
    assert.match(discussion[0].content, /多人卡按点名或话题选用AI人物口吻，可像普通群聊一样换人并以“人物名：”标明/);
    assert.match(discussion[0].content, /普通聊天只写直接回复，不插入发言者的动作、神态描写或场景\/心理旁白/);
    assert.match(discussion[0].content, /不演绎故事或身体互动/);
    assert.match(discussion[0].content, /结构化卡片仍按本轮目标与原字段输出，不受上述聊天形式限制/);
    assert.doesNotMatch(discussion[0].content, /你是当前角色卡中的AI角色/);
    assert.doesNotMatch(discussion[0].content, /创作顾问|不扮演角色/);
    assert.doesNotMatch(discussion[0].content, /CUSTOM_ADVISOR_VOICE/);
    assert.doesNotMatch(counters.titleSupplement, /CUSTOM_ADVISOR_VOICE/);

    for (const [userMsg, expectedKind, outputTag, field] of [
        ['生成一个点卡', 'schedule_widget', '<schedule_widget>', /Event: type\|title\|description/],
        ['生成一条线卡', 'line_widget', '<line_widget>', /Desc:.*Next:/s],
        ['生成一个面方案', 'outline_widget', '<outline_widget>', /Scene: 场景描述/],
    ]) {
        const messages = await context.buildMessages({ target: {}, userMsg, historySnapshot: [] });
        assert.equal(messages.expectedWidgetKind, expectedKind, userMsg);
        assert.match(messages[0].content, new RegExp(outputTag.replace(/[<>]/g, '\\$&')), userMsg);
        assert.match(messages[0].content, field, userMsg);
        assert.match(messages[0].content, /结构化卡片仍按本轮目标与原字段输出，不受上述聊天形式限制/, userMsg);
        assert.doesNotMatch(messages[0].content, /CUSTOM_ADVISOR_VOICE/, userMsg);
    }
    assert.equal(counters.characterReads, 4);

    const semantic = await context.buildMessages({ target: {}, userMsg: '帮我处理一下这件事', historySnapshot: [] });
    assert.equal(semantic.expectedWidgetKind, undefined);
    assert.deepEqual(semantic.allowedWidgetKinds, []);
    assert.match(semantic[0].content, /本轮输出模式：语义路由/);
    assert.match(semantic[0].content, /当前没有可信的卡片目标/);
    assert.doesNotMatch(semantic[0].content, /<schedule_widget>|<line_widget>/);
    assert.match(semantic[0].content, /角色卡人格模式】只借当前卡中AI人物的性格、说话习惯与思考方式作为聊天人格/);
    assert.doesNotMatch(semantic[0].content, /CUSTOM_ADVISOR_VOICE/);

    for (const userMsg of ['把这个伤势保存到刻度', '给我生成人物状态卡']) {
        const unsupported = await context.buildMessages({ target: {}, userMsg, historySnapshot: [] });
        assert.deepEqual(unsupported.allowedWidgetKinds, [], userMsg);
        assert.match(unsupported[0].content, /对应模块入口处理/);
        assert.match(unsupported[0].content, /不要追问无关卡型/);
        assert.doesNotMatch(unsupported[0].content, /询问用户想要哪一类/);
    }

    activeSettings.spaceUseCharacterPersona = false;
    const advisorAgain = await context.buildMessages({ target: {}, userMsg: '回到顾问方式', historySnapshot: [] });
    assert.match(advisorAgain[0].content, /故事外的创作顾问/);
    assert.match(advisorAgain[0].content, /CUSTOM_ADVISOR_VOICE/);
    assert.match(counters.titleSupplement, /CUSTOM_ADVISOR_VOICE/);
    assert.equal(counters.characterReads, 8);

    const help = buildSpaceHelpText({});
    assert.match(help, /提示词与标签.*间·人格 \/ 说话风格/);
    assert.match(help, /默认使用顾问.*使用当前角色人设/);
    assert.match(help, /自定义语气文本保留但暂停使用，关闭后恢复/);
});

test('本轮卡片范围与目标一致，轴日期写作只读取轴日期和现行历法', async () => {
    const calls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readAlmanacText: () => { calls.push('almanac'); return '已有日期'; },
        readCalendarText: () => { calls.push('calendar'); return '现行历法'; },
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const axis = await context.buildMessages({ target: {}, userMsg: '生成一张轴日期卡', historySnapshot: [] });
    assert.deepEqual(calls, ['almanac', 'calendar']);
    assert.equal(axis.expectedWidgetKind, 'almanac_widget');
    assert.deepEqual(axis.allowedWidgetKinds, ['almanac_widget']);
    assert.match(axis[0].content, /已有日期/);
    assert.match(axis[0].content, /现行历法/);

    const semantic = await context.buildMessages({ target: {}, userMsg: '帮我处理一下这件事', historySnapshot: [] });
    assert.equal(semantic.expectedWidgetKind, undefined);
    assert.deepEqual(semantic.allowedWidgetKinds, []);
    const discussion = await context.buildMessages({ target: {}, userMsg: '这段关系合理吗？', historySnapshot: [] });
    assert.deepEqual(discussion.allowedWidgetKinds, []);
    const stored = appendSpaceAssistant([], '正常说明', { allowedWidgetKinds: semantic.allowedWidgetKinds }).at(-1);
    assert.deepEqual(stored.allowedWidgetKinds, []);
    const apiHistory = (await import('./schema.js')).stripWidgetsForApi([stored]);
    assert.equal(Object.hasOwn(apiHistory[0], 'allowedWidgetKinds'), false);
});

test('按钮或面节点纠错继承上一份可信目标与候选正文', async () => {
    const outline = 'Beat: 第一周|建立联系|关系|主线|开始合作\nScene: 两人交换联络方式\nBeat: 第二周|共同调查|关系|主线|发现线索\nScene: 双方核实记录';
    const history = appendSpaceAssistant([{ role: 'user', content: '生成一份面方案' }], outline, {
        expectedWidgetKind: 'outline_widget', outlineRawToken: pointRawToken('正式面'),
        allowedWidgetKinds: ['outline_widget'],
    });
    for (const message of ['应用按钮点不了', '没输出应用按钮，格式是不是有问题']) {
        const intent = classifySpaceIntent(message, history);
        assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget'], message);
        assert.match(intent.recentWidget.body, /共同调查/);
    }
    const nodeEdit = classifySpaceIntent('在第二个节点后插入一个转折节点', history);
    assert.deepEqual([nodeEdit.action, nodeEdit.kind], ['revise-recent', 'outline_widget']);
    assert.equal(classifySpaceIntent('在第二个节点后插入一个转折节点', []).reason, 'missing-recent-widget');
    const reads = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutlineDraftSnapshot: () => { reads.push('formal'); return { raw: '正式面' }; },
        rawToken: pointRawToken,
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const messages = await context.buildMessages({ target: {}, userMsg: '在第二个节点后插入一个转折节点', historySnapshot: history });
    assert.equal(messages.expectedWidgetKind, 'outline_widget');
    assert.match(messages[0].content, /共同调查/);
    assert.match(messages[0].content, /正式面/);
    assert.deepEqual(reads, ['formal']);
});

test('纠错只回取通过生产解析的候选，坏的最新卡不遮住上一张有效卡', () => {
    const validLine = '<line_widget>Line: 暗号|延展|近日|world|false|false\nDesc: 旧信号再次出现\nNext: 两人核对发送者</line_widget>';
    const history = [
        { role: 'user', content: '生成一条线卡片' },
        appendSpaceAssistant([], validLine, { expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'] }).at(-1),
        { role: 'user', content: '生成一条线卡片' },
        appendSpaceAssistant([], '<line_widget>Line: 暗号|延展|近日|world|false|false</line_widget>', {
            expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'],
        }).at(-1),
    ];
    const intent = classifySpaceIntent('这条线卡片按钮点不了，请重新给一版', history);
    assert.deepEqual([intent.action, intent.kind], ['write', 'line_widget']);
    assert.match(intent.recentWidget.body, /旧信号再次出现/);
});

test('语义路由包含面目标时首次展示、历史候选与 API 投影保留同一应用依据', async () => {
    const current = '<outline_widget>Beat: 当前|正式面|关系|主线|保留\nScene: 当前正文</outline_widget>';
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutlineDraftSnapshot: () => ({ raw: current }), rawToken: pointRawToken,
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const userMsg = '请帮我处理这个大纲';
    const messages = await context.buildMessages({ target: {}, userMsg, historySnapshot: [] });
    assert.equal(classifySpaceIntent(userMsg).action, 'semantic-route');
    assert.deepEqual(messages.allowedWidgetKinds, ['outline_widget']);
    assert.equal(messages.expectedWidgetKind, undefined);
    assert.equal(messages.outlineRawToken, pointRawToken(current));
    assert.match(messages[0].content, /<outline_widget>/);
    const { appendSpaceAssistant, stripWidgetsForApi, latestSpaceWidget } = await import('./schema.js');
    const stored = appendSpaceAssistant([], '<outline_widget>Beat: 更新|候选|关系|主线|调整\nScene: 新正文</outline_widget>', {
        allowedWidgetKinds: messages.allowedWidgetKinds, outlineRawToken: messages.outlineRawToken,
    }).at(-1);
    assert.equal(stored.outlineRawToken, pointRawToken(current));
    assert.equal(latestSpaceWidget([stored], 'outline_widget').outlineRawToken, pointRawToken(current));
    assert.match(stripWidgetsForApi([stored])[0].content, /面草稿候选（不代表已应用）/);
    assert.equal(Object.hasOwn(stripWidgetsForApi([stored])[0], 'outlineRawToken'), false);
});

test('明确的面节点编辑在没有历史候选时以正式面为依据', async () => {
    const reads = [];
    const original = '<outline_widget>Beat: 当前|正式节点|关系|主线|保留\nScene: 正式正文</outline_widget>';
    const message = '在面节点4和5之间插入一个节点';
    const intent = classifySpaceIntent(message, []);
    assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget']);
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutlineDraftSnapshot: () => { reads.push('formal'); return { raw: original }; },
        rawToken: pointRawToken,
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const messages = await context.buildMessages({ target: {}, userMsg: message, historySnapshot: [] });
    assert.equal(messages.expectedWidgetKind, 'outline_widget');
    assert.match(messages[0].content, /正式正文/);
    assert.deepEqual(reads, ['formal']);
});

test('面方案按钮无法应用时补回最近候选并保留原编辑性质', async () => {
    const candidate = '<outline_widget>Beat: 一周后|候选节点|关系|主线|新方向\nScene: 候选正文</outline_widget>';
    const history = [{ role: 'user', content: '把当前面改得更自然' }];
    history.push(...appendSpaceAssistant(history, candidate, {
        expectedWidgetKind: 'outline_widget', allowedWidgetKinds: ['outline_widget'],
        outlineRawToken: pointRawToken('正式稿'),
    }).slice(1));
    for (const message of ['面方案无法应用，内容不完整，你处理一下', '你刚才的面方案按钮点不了，请重新给一版']) {
        const intent = classifySpaceIntent(message, history);
        assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget'], message);
        assert.equal(intent.editExisting, undefined, message);
    }
    for (const message of ['面方案无法应用，内容不完整，你处理一下', '你刚才的面方案按钮点不了，请重新给一版']) {
        const context = createSpaceContext({
            context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
            readOutlineDraftSnapshot: () => ({ raw: '正式稿' }), rawToken: pointRawToken,
            readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
        });
        const messages = await context.buildMessages({ target: {}, userMsg: message, historySnapshot: history });
        assert.match(messages[0].content, /候选正文/, message);
        assert.match(messages[0].content, /正式稿/, message);
        assert.match(messages[0].content, /不要沿用历史里的错误格式/, message);
    }
});

test('明确编辑当前正式面的节点优先于删除叙述和旧候选', async () => {
    const formal = '<outline_widget>Beat: 当前|FORMAL_CURRENT_NODE|关系|主线|正式结果\nScene: 正式节点现状</outline_widget>';
    const oldCandidate = '<outline_widget>Beat: 旧版|OLD_CANDIDATE_NODE|关系|主线|旧稿结果\nScene: DELETED_NODE_CONTENT</outline_widget>';
    const message = '我把多余的节点删除了，你把现在面里的节点1丰富一下';
    const historyCases = [
        ['没有历史候选', [{ role: 'user', content: message }]],
        ['存在旧草稿候选', [
            { role: 'user', content: '生成一份面方案' },
            appendSpaceAssistant([], oldCandidate, {
                expectedWidgetKind: 'outline_widget', allowedWidgetKinds: ['outline_widget'],
                outlineRawToken: pointRawToken('旧正式稿'),
            }).at(-1),
            { role: 'user', content: message },
        ]],
    ];
    for (const [label, historySnapshot] of historyCases) {
        const reads = [];
        const intent = classifySpaceIntent(message, historySnapshot);
        assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget'], label);
        assert.equal(intent.recentWidget, null, label);
        const context = createSpaceContext({
            context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
            readOutlineDraftSnapshot: () => { reads.push('formal'); return { raw: formal }; },
            rawToken: pointRawToken,
            readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
        });
        const messages = await context.buildMessages({ target: {}, userMsg: message, historySnapshot });
        assert.equal(messages.expectedWidgetKind, 'outline_widget', label);
        assert.equal(messages.outlineRawToken, pointRawToken(formal), label);
        assert.match(messages[0].content, /FORMAL_CURRENT_NODE/, label);
        assert.doesNotMatch(messages[0].content, /OLD_CANDIDATE_NODE|DELETED_NODE_CONTENT/, label);
        assert.deepEqual(reads, ['formal'], label);
    }

    const previousDraftMessage = '把刚才的面草稿丰富一下';
    const oldHistory = [
        { role: 'user', content: '生成一份面方案' },
        appendSpaceAssistant([], oldCandidate, {
            expectedWidgetKind: 'outline_widget', allowedWidgetKinds: ['outline_widget'],
            outlineRawToken: pointRawToken('旧正式稿'),
        }).at(-1),
    ];
    const previousDraft = classifySpaceIntent(previousDraftMessage, oldHistory);
    assert.deepEqual([previousDraft.action, previousDraft.kind], ['revise-recent', 'outline_widget']);
    assert.match(previousDraft.recentWidget.body, /OLD_CANDIDATE_NODE/);
});

test('当前正式面编辑不沿用历史中的旧候选', () => {
    const oldCandidate = '<outline_widget>Beat: 旧版|OLD_CANDIDATE_NODE|关系|主线|旧稿结果\nScene: DELETED_NODE_CONTENT</outline_widget>';
    const history = [
        { role: 'user', content: '生成一份面方案' },
        appendSpaceAssistant([], oldCandidate, {
            expectedWidgetKind: 'outline_widget', allowedWidgetKinds: ['outline_widget'],
            outlineRawToken: pointRawToken('旧正式稿'),
        }).at(-1),
        { role: 'user', content: '我把多余的节点删除了，你把现在面里的节点1丰富一下' },
    ];
    const intent = classifySpaceIntent('我把多余的节点删除了，你把现在面里的节点1丰富一下', history);
    assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget']);
    assert.equal(intent.recentWidget, null);
});

test('“面里面的格式，再生成让我应用”仍以正式稿为本轮基准', async () => {
    const original = '<outline_widget>Beat: 当前|FORMAL_FORMAT_NODE|关系|主线|保留\nScene: 正式正文</outline_widget>';
    const message = '你注意面里面的格式，然后给我生成面让我应用，就像你之前生成的可以应用的一样';
    const candidate = '<outline_widget>Beat: 旧版|OLD_CANDIDATE_NODE|关系|主线|旧稿\nScene: 旧正文</outline_widget>';
    const histories = [
        [],
        [
            { role: 'user', content: '生成一份面方案' },
            appendSpaceAssistant([], candidate, { expectedWidgetKind: 'outline_widget', allowedWidgetKinds: ['outline_widget'] }).at(-1),
        ],
    ];
    for (const history of histories) {
        const intent = classifySpaceIntent(message, history);
        assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget']);
        const context = createSpaceContext({
            context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
            readOutlineDraftSnapshot: () => ({ raw: original }), rawToken: pointRawToken,
            readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
        });
        const messages = await context.buildMessages({ target: {}, userMsg: message, historySnapshot: history });
        assert.equal(messages.outlineRawToken, pointRawToken(original));
        assert.match(messages[0].content, /FORMAL_FORMAT_NODE/);
        assert.doesNotMatch(messages[0].content, /OLD_CANDIDATE_NODE/);
    }
});

test('当前正式面或大纲节点的明确编辑只用正式稿来源', async () => {
    const formal = '<outline_widget>Beat: 当前|FORMAL_CURRENT_NODE|关系|主线|正式结果\nScene: 正式节点现状</outline_widget>';
    const oldCandidate = '<outline_widget>Beat: 旧版|OLD_CANDIDATE_NODE|关系|主线|旧稿结果\nScene: DELETED_NODE_CONTENT</outline_widget>';
    const history = [
        { role: 'assistant', content: oldCandidate, expectedWidgetKind: 'outline_widget', allowedWidgetKinds: ['outline_widget'] },
    ];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readOutlineDraftSnapshot: () => ({ raw: formal }), rawToken: pointRawToken,
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    for (const message of [
        '我把多余的节点删除了，你把现在面里的节点1丰富一下',
        '把当前大纲的第1个节点补充一下',
        '把当前剧情大纲的第1个节点补充一下',
        '现有大纲节点1细化一下',
        '把正式大纲节点1扩写一下',
    ]) {
        const intent = classifySpaceIntent(message, history);
        assert.deepEqual([intent.action, intent.kind], ['write', 'outline_widget'], message);
        assert.equal(intent.recentWidget, null, message);
        const messages = await context.buildMessages({ target: {}, userMsg: message, historySnapshot: history });
        assert.match(messages[0].content, /FORMAL_CURRENT_NODE/, message);
        assert.doesNotMatch(messages[0].content, /OLD_CANDIDATE_NODE|DELETED_NODE_CONTENT/, message);
    }
});

test('提到节点的问句、解释、否定和已完成叙述不触发编辑或应用卡', () => {
    for (const message of [
        '怎么丰富当前面节点1？',
        '请解释如何扩写当前面节点1',
        '不要丰富当前面节点1',
        '当前面节点1已经补充好了，你看看',
    ]) {
        const intent = classifySpaceIntent(message, []);
        assert.notDeepEqual([intent.action, intent.kind], ['write', 'outline_widget'], message);
        assert.notEqual(intent.action, 'revise-recent', message);
        assert.deepEqual(intent.allowedWidgetKinds || [], [], message);
    }
});

test('正式面来源不覆盖本轮明确转换成点或线的目标', () => {
    for (const [message, kind] of [
        ['把当前面里的节点1丰富一下，再生成到点', 'schedule_widget'],
        ['丰富当前面节点1并生成一张点卡', 'schedule_widget'],
        ['请把当前面节点1扩写后转换成线卡', 'line_widget'],
    ]) {
        const intent = classifySpaceIntent(message, []);
        assert.deepEqual([intent.action, intent.kind], ['write', kind], message);
    }
});
