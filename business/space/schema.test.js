import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSpaceAssistant, latestSpaceWidget, resolveSpaceWidgets, stripWidgetsForApi } from './schema.js';

test('all5 策略对有效不同卡型不猜测', () => {
    const raw = '<schedule_widget>Event: main|有效|说明|明天||||</schedule_widget>\n<line_widget>Line: 额外|延展|近日|world|false|false\nDesc: 说明\nNext: 下一步</line_widget>';
    const result = resolveSpaceWidgets(raw, { allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] });
    assert.equal(result.ambiguous, true);
    assert.equal(result.widgets.length, 0);
});

test('expected 旧策略只保留目标卡，不因额外卡整回复失效', () => {
    const raw = '<schedule_widget>Event: main|有效|说明|明天||||</schedule_widget>\n<outline_widget>Beat: 明天|面|关系|主线|结果\nScene: 场景</outline_widget>';
    const result = resolveSpaceWidgets(raw, { expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'] });
    assert.equal(result.ambiguous, false);
    assert.deepEqual(result.widgets.map(item => item.kind), ['schedule_widget']);
});

test('同一 schedule widget 中的多条合法 Event 各自保留', () => {
    const raw = '<schedule_widget>Event: main|第一条|说明一|明天||||\nEvent: main|第二条|说明二|后天||||</schedule_widget>';
    const result = resolveSpaceWidgets(raw, { expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'] });
    assert.deepEqual(result.widgets.map(item => item.body.match(/Event: main\|([^|]+)/)?.[1]), ['第一条', '第二条']);
});

test('API 保留候选模式保留真实卡片结构并剥离本地元数据', () => {
    const history = [{ role: 'assistant', pageId: '2', expectedWidgetKind: 'schedule_widget', pointBaselines: [{ rawToken: 'x' }], unknownLocalField: '不能发给模型', content: '<schedule_widget>Event: main|有效|说明|明天||||</schedule_widget>' }];
    const [message] = stripWidgetsForApi(history, { preserveCandidates: true });
    assert.match(message.content, /历史卡片候选｜应用状态以当前正式资料为准/);
    assert.match(message.content, /<schedule_widget>/);
    assert.equal('pageId' in message, false);
    assert.equal('expectedWidgetKind' in message, false);
    assert.equal('unknownLocalField' in message, false);
});

test('裸卡实际类型保存后，历史检索与 API 候选标记继续一致', () => {
    const raw = 'Event: main|核对旧信|确认已有线索|明天下午|书店|';
    const history = appendSpaceAssistant([], raw, { allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] });
    const latest = latestSpaceWidget(history, 'schedule_widget');
    assert.equal(latest?.kind, 'schedule_widget');
    assert.match(latest.body, /核对旧信/);
    const [api] = stripWidgetsForApi(history, { preserveCandidates: true });
    assert.match(api.content, /历史卡片候选/);
});

test('旧目标只受本型合法 wrapper 阻断裸回收，其他类型不能挡住本型合法字段', () => {
    const raw = '<line_widget>Line: 额外线|延展|近日|world|false|false\nDesc: 资料待核对\nNext: 检查来源</line_widget>\nEvent: main|本轮点|确认已有资料|明天|书店|';
    const result = resolveSpaceWidgets(raw, { expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'] });
    assert.deepEqual(result.widgets.map(widget => widget.kind), ['schedule_widget']);
});

test('没有纪年名的裸历法保留明确显示样式', () => {
    const result = resolveSpaceWidgets('Style: classical\nMonth: 孟春|30\nMonth: 仲春|30', { allowedWidgetKinds: ['era_widget'] }, {
        parseEra: body => /Style: classical/.test(body) && (body.match(/Month:/g) || []).length === 2 ? { months: [{ name: '孟春', days: 30 }] } : null,
    });
    assert.equal(result.widgets.length, 1);
    assert.match(result.widgets[0].body, /^Style: classical/);
});

test('all5 混合合法卡保存时保留原文，不降级成可应用单卡', () => {
    const raw = '<schedule_widget>Event: main|点|说明|明天||||</schedule_widget>\n<outline_widget>Beat: 后天|面|关系|主线|结果\nScene: 场景</outline_widget>';
    const [saved] = appendSpaceAssistant([], raw, { pageId: '1', allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] });
    assert.equal(saved.expectedWidgetKind, undefined);
    assert.deepEqual(saved.allowedWidgetKinds, ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget']);
    assert.equal(saved.content, raw);
});

test('all5 唯一卡型落盘实际 expected 与冻结 allowed', () => {
    const raw = '<schedule_widget>Event: main|点|说明|明天||||</schedule_widget>\n<schedule_widget>Event: main|第二点|说明|后天||||</schedule_widget>';
    const [saved] = appendSpaceAssistant([], raw, { allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] });
    assert.equal(saved.expectedWidgetKind, 'schedule_widget');
    assert.deepEqual(saved.allowedWidgetKinds, ['schedule_widget']);
});

test('裸 Event 与裸 Line 仅按正式锚点捞取并校验', () => {
    const point = resolveSpaceWidgets('Event: main|裸点|说明|明天||||', { expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'] });
    assert.equal(point.widgets.length, 1);
    const line = resolveSpaceWidgets('Line: 裸线|延展|近日|world|false|false\nDesc: 说明\nNext: 下一步', { expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'] });
    assert.equal(line.widgets.length, 1);
    const bad = resolveSpaceWidgets('Event: main|缺时间|说明||||', { expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'] });
    assert.equal(bad.widgets.length, 0);
    const badLine = resolveSpaceWidgets('Line: 裸线|延展|近日|world|false|false\nDesc: 缺下一步', { expectedWidgetKind: 'line_widget', allowedWidgetKinds: ['line_widget'] });
    assert.equal(badLine.widgets.length, 0);
});

test('两个完整裸卡型保持歧义，闭合 wrapper 旁的裸字段不串入', () => {
    const mixed = resolveSpaceWidgets('Event: main|点|说明|明天||||\nLine: 线|延展|近日|world|false|false\nDesc: 说明\nNext: 下一步', { allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] });
    assert.equal(mixed.ambiguous, true);
    const wrapped = resolveSpaceWidgets('<schedule_widget>Event: main|点|说明|明天||||</schedule_widget>\nLine: 裸线|延展|近日|world|false|false\nDesc: 说明\nNext: 下一步', { allowedWidgetKinds: ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'] });
    assert.deepEqual(wrapped.widgets.map(widget => widget.kind), ['schedule_widget']);
});

test('裸历法保留 Era 与 Style，裸面整稿保留全部 Beat', () => {
    const era = resolveSpaceWidgets('Era: 青历\nStyle: classical\nMonth: 孟春|30\nMonth: 仲春|30', { expectedWidgetKind: 'era_widget', allowedWidgetKinds: ['era_widget'] }, { parseEra: body => /Era: 青历/.test(body) && /Style: classical/.test(body) && (body.match(/Month:/g) || []).length === 2 ? { months: [] } : null });
    assert.equal(era.widgets.length, 1);
    assert.match(era.widgets[0].body, /Era: 青历/);
    assert.match(era.widgets[0].body, /Style: classical/);
    const outline = resolveSpaceWidgets('Beat: 明日|一|关系|主线|结果\nScene: 场景一\nBeat: 后日|二|关系|主线|结果\nScene: 场景二', { expectedWidgetKind: 'outline_widget', allowedWidgetKinds: ['outline_widget'] });
    assert.equal(outline.widgets.length, 1);
    assert.match(outline.widgets[0].body, /场景一/);
    assert.match(outline.widgets[0].body, /场景二/);
});

test('坏 wrapper 外的合法裸字段仍可回收，合法 wrapper 才阻止裸回收', () => {
    const badWrapped = resolveSpaceWidgets('<schedule_widget>Event: main|坏|缺时间||||</schedule_widget>\nEvent: main|裸好|说明|明天||||', { expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'] });
    assert.equal(badWrapped.widgets.length, 1);
    const goodWrapped = resolveSpaceWidgets('<schedule_widget>Event: main|包装好|说明|明天||||</schedule_widget>\nEvent: main|裸好|说明|明天||||', { expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'] });
    assert.deepEqual(goodWrapped.widgets.map(widget => widget.body.match(/Event: main\|([^|]+)/)?.[1]), ['包装好']);
});
