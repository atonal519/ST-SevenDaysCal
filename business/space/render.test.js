import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceRenderer } from './render.js';
import { firstPointEventBlock, parsePointEventRecord, isCompletePointEvent } from '../point/parse.js';
import { parseLineCard } from '../lines/schema.js';

test('完整裸字段回收成卡片后不再重复显示原始字段文本', () => {
    const renderer = createSpaceRenderer();
    const policy = { allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] };
    for (const raw of [
        'Event: main|核对旧信|核对已有线索|明天下午|书店|',
        '<outline_widget>Beat: 坏||||</outline_widget>\nEvent: main|核对旧信|核对已有线索|明天下午|书店|',
    ]) {
        const registrations = [];
        const result = renderer.message('ai', raw, 1, widget => { registrations.push(widget); return 'point'; }, policy);
        assert.equal(registrations.length, 1);
        assert.equal(result.contentHtml, '');
        assert.match(result.widgetCards, /选择人物并应用/);
    }
});

const pointBody = '<schedule_widget>Event: main|约定|双方交换信息|周五||||</schedule_widget>';
const lineBody = '<line_widget>Line: 暗号|延展|近日|world|false|false\nDesc: 旧信号再次出现\nNext: 两人核对发送者</line_widget>';

test('间只为本轮允许且通过业务解析器的点线卡注册应用动作', () => {
    const registrations = [];
    const renderer = createSpaceRenderer();
    const parse = raw => {
        const first = firstPointEventBlock(raw);
        const event = first && parsePointEventRecord(first);
        return event && isCompletePointEvent(event) ? event : null;
    };
    const validPoint = renderer.message('ai', pointBody, 0, widget => { registrations.push(widget); return 'p'; }, {
        expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'],
    });
    assert.match(validPoint.widgetCards, /应用/);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].kind, 'schedule_widget');

    registrations.length = 0;
    const invalidPoint = renderer.message('ai', '<schedule_widget>Event: main|缺时间|有说明||||</schedule_widget>', 1,
        widget => { registrations.push(widget); return 'bad'; }, {
            expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'],
        });
    assert.doesNotMatch(invalidPoint.widgetCards, /class="sp-space-widget-apply"/);
    assert.equal(registrations.length, 0);

    const validLine = renderer.message('ai', lineBody, 2, () => 'l', {
        expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'],
    });
    assert.match(validLine.widgetCards, /应用到线/);
    const invalidLine = renderer.message('ai', '<line_widget>Line: 缺描述|延展|近日|world|false|false</line_widget>', 3,
        () => { throw new Error('invalid line registered'); }, {
            expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'],
        });
    assert.doesNotMatch(invalidLine.widgetCards, /class="sp-space-widget-apply"/);

    const wrongKind = renderer.message('ai', lineBody, 4, () => { throw new Error('wrong kind registered'); }, {
        expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'],
    });
    assert.match(wrongKind.widgetCards, /未开放应用/);
});

test('普通文字追问保留原回复并给中性状态，讨论白名单不注册模型擅自返回的卡', () => {
    let registrations = 0;
    const renderer = createSpaceRenderer({ formatAi: value => `<p>${value}</p>` });
    const question = renderer.message('ai', '你希望这条安排落到谁的点里？', 1, () => { registrations += 1; return 'w'; }, {
        expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'],
    });
    assert.match(question.contentHtml, /你希望这条安排落到谁的点里/);
    assert.match(question.widgetCards, /本次回复没有可应用卡片/);
    assert.doesNotMatch(question.widgetCards, /无法应用/);

    const discussion = renderer.message('ai', lineBody, 2, () => { registrations += 1; return 'w'; }, {
        allowedWidgetKinds: [],
    });
    assert.doesNotMatch(discussion.widgetCards, /class="sp-space-widget-apply"/);
    assert.equal(registrations, 0);
});

test('点线预览字段沿用生产解析器的别名归一结果', () => {
    const renderer = createSpaceRenderer();
    const point = renderer.message('ai', '<schedule_widget>Event: 伏笔|暗号|旧信号再次出现|明早|港口|继续观察</schedule_widget>', 1,
        () => 'p', { expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'] });
    assert.match(point.widgetCards, /暗线/);
    assert.doesNotMatch(point.widgetCards, /伏笔/);

    const line = renderer.message('ai', '<line_widget>Line: 当事人|延展|近日|用户|false|false\nDesc: 双方核对消息来源\nNext: 确认发送者</line_widget>', 2,
        () => 'l', { expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'] });
    assert.match(line.widgetCards, /需推动/);
    assert.doesNotMatch(line.widgetCards, /自演化/);
});

test('普通讨论没有卡片白名单时不增加空状态卡片', () => {
    const renderer = createSpaceRenderer({ formatAi: value => `<p>${value}</p>` });
    const discussion = renderer.message('ai', '这段关系的发展看起来合理。', 1, () => 'unused', { allowedWidgetKinds: [] });
    assert.match(discussion.contentHtml, /这段关系的发展看起来合理/);
    assert.equal(discussion.widgetCards, '');
});

test('all5 自然路由只注册唯一合法卡型，混合合法卡型不注册', () => {
    const registrations = [];
    const renderer = createSpaceRenderer();
    const policy = { allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] };
    const single = renderer.message('ai', `${pointBody}\n<schedule_widget>Event: main|坏|说明||||</schedule_widget>\n<line_widget>Line: 额外|延展|近日|world|false|false</line_widget>`, 0, widget => { registrations.push(widget); return 'p'; }, policy);
    assert.equal(registrations.length, 1);
    assert.match(single.widgetCards, /应用时选择人物/);

    registrations.length = 0;
    const mixed = renderer.message('ai', `${pointBody}\n${lineBody}`, 1, widget => { registrations.push(widget); return 'x'; }, policy);
    assert.equal(registrations.length, 0);
    assert.match(mixed.widgetCards, /多种可应用卡片/);
});

test('all5 全坏结构保留原文反馈但不注册，普通文字不增加状态卡', () => {
    let registrations = 0;
    const renderer = createSpaceRenderer();
    const policy = { allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] };
    const bad = renderer.message('ai', '<schedule_widget>Event: main|缺时间|说明||||</schedule_widget>', 0, () => { registrations += 1; return 'x'; }, policy);
    assert.equal(registrations, 0);
    assert.match(bad.widgetCards, /结构化内容/);
    assert.match(bad.widgetCards, /缺时间/);
    const plain = renderer.message('ai', '这只是普通讨论。', 1, () => { registrations += 1; return 'y'; }, policy);
    assert.equal(plain.widgetCards, '');
});

test('面草稿预览使用原生列表编号，不重复输出编号文字', () => {
    const renderer = createSpaceRenderer();
    const raw = `<outline_widget>
Beat: 明日|港口交涉|main|暗线|达成共识
Scene: 两人在港口碰面并交换情报
Subtext: 彼此试探
Think: 保留余地
Beat: 后日|回到住处|main|暗线|留下线索
Scene: 角色整理带回的文件
Subtext: 发现异常
Think: 暂不声张
</outline_widget>`;
    const result = renderer.message('ai', raw, 0, () => 'outline', {
        expectedWidgetKind: 'outline_widget', allowedWidgetKinds: ['outline_widget'],
    });
    assert.match(result.widgetCards, /<ol class="sp-space-outline-preview">/);
    assert.match(result.widgetCards, /<strong>港口交涉<\/strong>/);
    assert.doesNotMatch(result.widgetCards, /<strong>1\.\s*港口交涉<\/strong>/);
});
