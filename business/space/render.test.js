import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceRenderer } from './render.js';
import { firstPointEventBlock, parsePointEventRecord, isCompletePointEvent } from '../point/parse.js';
import { parseLineCard } from '../lines/schema.js';

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
