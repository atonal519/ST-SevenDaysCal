import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySpaceIntent, createSpaceContext, numberedSpaceLineList, numberedSpacePointGroups, requestedSpaceMaterials } from './context.js';

const kinds = ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'];

test('间每轮读最新衣橱文本且只读，不扩五类应用卡', async()=>{
    let value='【已存衣橱】老板：灰围裙',reads=0;
    const context=createSpaceContext({context:()=>({name1:'用户',name2:'角色'}),settings:()=>({}),readWardrobe:()=>{reads++;return value;}});
    const first=await context.buildMessages({target:{},userMsg:'聊一下穿搭',historySnapshot:[]});
    assert.match(first[0].content,/老板：灰围裙/);
    value='【已存衣橱】老板：蓝围裙';
    const second=await context.buildMessages({target:{},userMsg:'刚刚的方案呢',historySnapshot:[]});
    assert.equal(reads,2);assert.match(second[0].content,/老板：蓝围裙/);assert.doesNotMatch(second[0].content,/老板：灰围裙/);
    assert.deepEqual(second.allowedWidgetKinds,kinds);
    assert.match(second[0].content,/衣橱.*只读/);
});

test('所有自然语言请求进入同一语义路由并开放五类支持合同', () => {
    for (const message of [
        '这段关系接下来怎么发展？',
        '把刚才的想法整理成可应用方案',
        '修改上一张但保留人物语气',
        '把旧线里的承诺转换成我能应用的内容',
        '我说的“面”是比喻，不是要生成面',
        '不要生成卡片，先解释怎么操作',
    ]) {
        const intent = classifySpaceIntent(message, []);
        assert.equal(intent.action, 'semantic-route', message);
        assert.deepEqual(intent.allowedWidgetKinds, kinds, message);
        assert.equal(intent.kind, null, message);
    }
});

test('资料关键词只作为描述 hint，不决定上下文资料是否读取', () => {
    assert.equal(requestedSpaceMaterials('把这段整理成可应用方案').points, false);
    assert.equal(requestedSpaceMaterials('把这段整理成可应用方案').outline, false);
    assert.equal(requestedSpaceMaterials('待办').points, true);
    assert.equal(requestedSpaceMaterials('待办').ledger, true);
});

test('每轮读取完整基础资料与四类资料 reader，并保留失败/缺失状态', async () => {
    const calls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({}),
        readPointScopes: () => { calls.push('points'); return [{ view: 'user', raw: 'POINTS' }]; },
        numberedPoints: raw => raw,
        readLineRaw: () => { calls.push('lines'); return 'LINES'; },
        parseLines: () => [{ name: '线', stage: '延展', agency: 'world', desc: 'LINES' }],
        readOutlineDraftSnapshot: () => { calls.push('outline'); return { raw: 'OUTLINE' }; },
        rawToken: raw => `TOKEN:${raw}`,
        readLedgerText: () => { calls.push('ledger'); return 'LEDGER'; },
        readStoryDate: () => { calls.push('date'); return 'DATE'; },
        readAlmanacText: () => { calls.push('almanac'); return 'ALMANAC'; },
        readCalendarText: () => { calls.push('calendar'); return 'CALENDAR'; },
        readColdKnowledge: () => { calls.push('cold'); return 'COLD'; },
        readDailyMenu: () => { calls.push('menu'); throw new Error('menu unavailable'); },
        readTheater: () => { calls.push('theater'); return 'THEATER_INDEX'; },
        readCoordinates: () => { calls.push('coordinates'); return ''; },
        readMemory: async () => 'MEMORY', readRecent: async () => 'RECENT', readWorldInfo: async () => '',
    });
    const messages = await context.buildMessages({ target: {}, userMsg: '整理成可以应用的方案', historySnapshot: [] });
    assert.deepEqual(calls, ['outline', 'points', 'lines', 'ledger', 'date', 'almanac', 'calendar', 'cold', 'menu', 'theater', 'coordinates']);
    for (const material of ['POINTS', 'LINES', 'OUTLINE', 'LEDGER', 'DATE', 'ALMANAC', 'CALENDAR', 'COLD', 'THEATER_INDEX', 'MEMORY', 'RECENT']) assert.match(messages[0].content, new RegExp(material));
    assert.match(messages[0].content, /今天吃点啥读取失败/);
    assert.match(messages[0].content, /坐标未提供/);
    assert.match(messages[0].content, /month\/day 必须是数字/);
    assert.equal(messages.expectedWidgetKind, undefined);
    assert.deepEqual(messages.allowedWidgetKinds, kinds);
    assert.equal(messages.outlineRawToken, 'TOKEN:OUTLINE');
});

test('正式面优先使用完整快照，兼容环境缺少快照 reader 时才读取投影', async () => {
    const calls = [];
    const withSnapshot = createSpaceContext({
        context: () => ({}), readOutlineDraftSnapshot: () => { calls.push('snapshot'); return { raw: 'FULL' }; },
        readOutline: () => { calls.push('projection'); return 'PROJECTION'; }, rawToken: raw => raw,
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const messages = await withSnapshot.buildMessages({ target: {}, userMsg: '整理方案', historySnapshot: [] });
    assert.deepEqual(calls, ['snapshot']);
    assert.match(messages[0].content, /FULL/);
    assert.doesNotMatch(messages[0].content, /PROJECTION/);

    const fallbackCalls = [];
    const fallback = createSpaceContext({
        context: () => ({}), readOutline: () => { fallbackCalls.push('projection'); return 'PROJECTION'; },
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    });
    const fallbackMessages = await fallback.buildMessages({ target: {}, userMsg: '整理方案', historySnapshot: [] });
    assert.deepEqual(fallbackCalls, ['projection']);
    assert.match(fallbackMessages[0].content, /PROJECTION/);
});

test('正式面空稿使用真实空 token，读取失败不生成 token', async () => {
    const base = {
        context: () => ({}), rawToken: raw => `TOKEN:${raw}`,
        readMemory: async () => '', readRecent: async () => '', readWorldInfo: async () => '',
    };
    const empty = await createSpaceContext({ ...base, readOutlineDraftSnapshot: () => ({ raw: '' }) })
        .buildMessages({ target: {}, userMsg: '讨论面', historySnapshot: [] });
    assert.equal(empty.outlineRawToken, 'TOKEN:');
    assert.match(empty[0].content, /当前正式面为空/);

    const failed = await createSpaceContext({ ...base, readOutlineDraftSnapshot: () => { throw new Error('read failed'); } })
        .buildMessages({ target: {}, userMsg: '讨论面', historySnapshot: [] });
    assert.equal(failed.outlineRawToken, undefined);
    assert.match(failed[0].content, /正式面读取失败/);
    assert.match(failed[0].content, /month 1-12、day 1-31/);
});

test('点线分组与编号只负责提供真实资料，不替模型决定用户意图', () => {
    assert.match(numberedSpacePointGroups([{ view: 'user', raw: 'P' }], raw => `#1 ${raw}`, '我'), /view="user"/);
    assert.match(numberedSpacePointGroups([{ view: 'char', charName: 'TA', raw: 'P' }], raw => `#1 ${raw}`, '我'), /char="TA"/);
    assert.match(numberedSpaceLineList('raw', () => [{ name: '线', stage: '延展', agency: 'world', desc: 'D' }]), /#1 线/);
});

test('保留人格、worldInfo 召回输入、分页顺序与本轮 user 去重合同', async () => {
    const worldInfoCalls = [];
    const context = createSpaceContext({
        context: () => ({ name1: '我', name2: 'TA' }), settings: () => ({ spacePersona: 'CUSTOM_PERSONA' }),
        readCharacterData: () => 'CHARACTER',
        readCardExtras: () => ({ personaDesc: 'PERSONA_DESC', authorNote: 'AUTHOR_NOTE' }),
        readOutlineDraftSnapshot: () => ({ raw: 'FORMAL' }), rawToken: raw => raw,
        readMemory: async () => 'MEMORY', readRecent: async () => 'RECENT',
        readWorldInfo: async (...args) => { worldInfoCalls.push(args); return 'WORLD_INFO'; },
    });
    const messages = await context.buildMessages({
        target: {}, pageId: '1', pages: ['1', '2'], userMsg: '本轮问题',
        historySnapshot: [
            { role: 'user', content: '前一问', pageId: '1' },
            { role: 'assistant', content: '前一答', pageId: '2' },
            { role: 'user', content: '本轮问题', pageId: '1' },
        ],
    });
    assert.match(messages[0].content, /CUSTOM_PERSONA|PERSONA_DESC|AUTHOR_NOTE|CHARACTER|WORLD_INFO/);
    assert.equal(worldInfoCalls.length, 1);
    assert.match(worldInfoCalls[0][3], /FORMAL|MEMORY|RECENT/);
    assert.deepEqual(messages.slice(1).map(item => item.content), ['【窗口1】\n前一问', '【窗口2】\n前一答', '本轮问题']);
});

test('本轮问题原样传入同一次记忆读取，保留历史细节的查询召回', async () => {
    const ctx = { name1: '用户', name2: '角色' };
    const question = '根据旧港口的那次约定调整面，其他节点保留';
    const calls = [];
    const context = createSpaceContext({ context: () => ctx, settings: () => ({}), readMemory: async (...args) => { calls.push(args); return '旧约定材料'; } });
    const messages = await context.buildMessages({ target: {}, userMsg: question, historySnapshot: [] });
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0][0], ctx);
    assert.equal(calls[0][1], question);
    assert.match(messages[0].content, /旧约定材料/);
});

test('语义路由的历法编辑合同保留所有未提及字段，不依赖预判卡型', async () => {
    const context = createSpaceContext({ context: () => ({}), settings: () => ({}), readCalendarText: () => '旧纪年｜风月30天、雨月31天｜classical' });
    const messages = await context.buildMessages({ target: {}, userMsg: '把雨月改成32天，其他照旧', historySnapshot: [] });
    assert.match(messages[0].content, /编辑已有历法时.*未提及.*月份.*天数.*顺序.*样式.*纪年.*保留.*完整/);
});
