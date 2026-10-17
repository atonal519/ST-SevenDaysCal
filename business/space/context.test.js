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
    const lineHistory = [{ role: 'assistant', content: '<line_widget>Line: 线源标题|关系变化|筹备|1周|旧线正文|world|false</line_widget>' }];
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
        { role: 'assistant', content: '<outline_widget>面源正文</outline_widget>' },
        { role: 'assistant', content: '<line_widget>Line: 线源|筹备|近日|world|线源正文|false|false</line_widget>' },
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

test('语义路由候选包含仅选中线卡时适用的人物自主与输出复核提示', async () => {
    const userMsg = '帮我处理一下这件事';
    assert.equal(classifySpaceIntent(userMsg, []).action, 'semantic-route');
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readPointScopes: () => [], readLineRaw: () => '', numberedPoints: () => '',
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const messages = await context.buildMessages({ target: {}, userMsg, historySnapshot: [] });
    assert.match(messages[0].content, /仅在线卡是本轮选定输出时适用/);
    assert.match(messages[0].content, /【人物自主与相互回应】/);
    assert.match(messages[0].content, /【输出前复核】/);
});
