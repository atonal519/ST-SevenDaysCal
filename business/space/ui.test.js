import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceUi } from './ui.js';
import { createSpaceRenderer } from './render.js';
import { appendSpaceAssistant } from './schema.js';
import { createAxisWidgetActions } from '../axis/widget.js';

test('语义面候选重绘后仍注册同一正式稿依据并执行既有应用动作', async () => {
    const rawToken = 'formal-outline-token';
    const candidate = '<outline_widget>Beat: 两周后|误会澄清|关系|主线|信任增加\nScene: 两人核对消息来源</outline_widget>';
    const history = appendSpaceAssistant([], candidate, {
        allowedWidgetKinds: ['outline_widget'], outlineRawToken: rawToken,
    });
    const normalizedCandidate = history[0].content;
    const handlers = new Map();
    const queryResult = { empty() {}, append() {}, html() {}, text() {} };
    const rootWrapper = {
        length: 1,
        off() { return this; },
        on(event, selector, handler) { handlers.set(`${event} ${selector}`, handler); return this; },
    };
    const element = () => ({ scrollTop: 0, scrollHeight: 0 });
    const fakeNode = () => ({
        addClass() { return this; }, attr() { return this; }, html() { return this; },
        append() { return this; }, appendTo() { return this; }, empty() { return this; },
    });
    let actionCall;
    const ui = createSpaceUi({
        query: selector => selector === '#sp-space-wrap' ? rootWrapper : queryResult,
        element,
        $: value => typeof value === 'string' ? fakeNode() : {
            prop: () => false,
            attr: name => name === 'data-wid' ? value.wid : undefined,
        },
        currentOutlineRaw: () => '<outline_widget>Beat: 当前|正式稿|关系|主线|保留\nScene: 正式正文</outline_widget>',
        widgetActions: () => ({ outline: async (...args) => { actionCall = args; } }),
        toast() {},
    });
    ui.bindControllers({
        renderer: createSpaceRenderer(),
        chat: { history: () => history, busy: false },
    });
    ui.bind();

    for (let pass = 0; pass < 2; pass += 1) {
        ui.renderHistory(history);
        const [wid, stored] = ui.widgetRecords()[0];
        assert.equal(stored.kind, 'outline_widget');
        assert.equal(stored.outlineRawToken, rawToken);
        await handlers.get('click.spSpaceFeature .sp-space-widget-apply').call({ wid });
        assert.equal(actionCall[0], normalizedCandidate);
        assert.equal(actionCall[1], rawToken);
    }
});

test('轴日期每张预览绑定独立原项，历法变化后无效项不会移位应用成下一项', async () => {
    const history = appendSpaceAssistant([], '<almanac_widget>Item: A|festival|12|1|1||十二月项目\nItem: B|festival|1|1|1||一月项目</almanac_widget>', {
        expectedWidgetKind: 'almanac_widget', allowedWidgetKinds: ['almanac_widget'],
    });
    let validMonths = new Set([1, 12]);
    const parseAlmanac = body => {
        const entries = [
            { match: /Item: A\|festival\|12\|1\|1\|\|十二月项目/, item: { name: 'A', type: 'festival', month: 12, day: 1, days: 1, displayDate: '', note: '十二月项目' } },
            { match: /Item: B\|festival\|1\|1\|1\|\|一月项目/, item: { name: 'B', type: 'festival', month: 1, day: 1, days: 1, displayDate: '', note: '一月项目' } },
        ];
        return entries.filter(entry => entry.match.test(body) && validMonths.has(entry.item.month)).map(entry => ({ ...entry.item }));
    };
    const saved = [];
    const errors = [];
    const axis = createAxisWidgetActions({
        parseAlmanac,
        key: () => 'axis-key',
        loadItems: () => [],
        dedupKey: item => item.name,
        saveItems: items => { saved.splice(0, saved.length, ...items); return true; },
        error: message => { errors.push(message); return { ok: false }; },
    });
    const handlers = new Map();
    const queryResult = { empty() {}, append() {}, html() {}, text() {} };
    const rootWrapper = { length: 1, off() { return this; }, on(event, selector, handler) { handlers.set(`${event} ${selector}`, handler); return this; } };
    const fakeNode = () => ({ addClass() { return this; }, attr() { return this; }, html() { return this; }, append() { return this; }, appendTo() { return this; }, empty() { return this; } });
    const ui = createSpaceUi({
        query: selector => selector === '#sp-space-wrap' ? rootWrapper : queryResult,
        element: () => ({ scrollTop: 0, scrollHeight: 0 }),
        $: value => typeof value === 'string' ? fakeNode() : {
            prop: () => false,
            attr: name => name === 'data-wid' ? value.wid : name === 'data-idx' ? '0' : undefined,
        },
        widgetActions: () => ({ almanac: (...args) => axis.applyAlmanacWidget(...args) }),
        toast() {},
    });
    ui.bindControllers({ renderer: createSpaceRenderer({ parseAlmanac }), chat: { history: () => history, busy: false } });
    ui.bind();
    ui.renderHistory(history);
    const cards = ui.widgetRecords().map(([wid, widget]) => ({ wid, body: widget.body }));
    assert.equal(cards.length, 2);
    assert.match(cards[0].body, /Item: A\|festival\|12/);
    assert.match(cards[1].body, /Item: B\|festival\|1/);
    assert.notEqual(cards[0].body, cards[1].body);

    validMonths = new Set([1]);
    const click = handlers.get('click.spSpaceFeature .sp-space-widget-apply');
    await click.call({ wid: cards[0].wid });
    assert.deepEqual(saved, []);
    assert.match(errors.at(-1), /当前无法应用，请按现行历法重新生成/);

    await click.call({ wid: cards[1].wid });
    assert.deepEqual(saved.map(item => item.name), ['B']);
});

test('双页面候选按所属窗口判最新，保留真实公共索引与应用依据', () => {
    const outline = title => `<outline_widget>Beat: 当前|${title}|关系|主线|结果\nScene: 核对消息来源</outline_widget>`;
    const history = [
        { role: 'assistant', content: outline('第一页旧卡'), expectedWidgetKind: 'outline_widget', outlineRawToken: 'formal', pageId: '1' },
        { role: 'assistant', content: outline('第二页卡'), expectedWidgetKind: 'outline_widget', outlineRawToken: 'formal', pageId: '2' },
        { role: 'assistant', content: outline('第一页新卡'), expectedWidgetKind: 'outline_widget', outlineRawToken: 'formal', pageId: '1' },
    ];
    const node = { empty() {}, attr() { return this; }, prop() { return this; }, val() { return ''; } };
    const fakeNode = () => ({ addClass() { return this; }, attr() { return this; }, html() { return this; }, append() { return this; }, appendTo() { return this; } });
    const ui = createSpaceUi({ query: () => node, $: fakeNode, element: () => ({ scrollTop: 0, scrollHeight: 0 }) });
    ui.bindControllers({ chat: { history: () => history }, repository: { pages: () => ['1', '2'] }, renderer: createSpaceRenderer() });
    ui.renderHistory(history);
    assert.deepEqual(ui.widgetEntries().map(({ historyIndex, readOnly }) => [historyIndex, readOnly]), [[0, true], [2, false]]);
    ui.switchPage('2');
    assert.deepEqual(ui.widgetEntries().map(({ historyIndex, readOnly, outlineRawToken }) => [historyIndex, readOnly, outlineRawToken]), [[1, false, 'formal']]);
});

test('历史重绘不会因额外未开放面卡锁住合法点卡', () => {
    const history = [{
        role: 'assistant', pageId: '1', expectedWidgetKind: 'schedule_widget', allowedWidgetKinds: ['schedule_widget'],
        pointBaselines: [], content: '<schedule_widget>Event: main|有效点|说明|明天||||</schedule_widget>\n<outline_widget>Beat: 明日|额外|关系|主线|结果\nScene: 额外面</outline_widget>',
    }];
    const node = { empty() {}, attr() { return this; }, prop() { return this; }, val() { return ''; } };
    const fakeNode = () => ({ addClass() { return this; }, attr() { return this; }, html() { return this; }, append() { return this; }, appendTo() { return this; } });
    const ui = createSpaceUi({ query: () => node, $: fakeNode, element: () => ({ scrollTop: 0, scrollHeight: 0 }) });
    ui.bindControllers({ chat: { history: () => history }, repository: { pages: () => ['1'] }, renderer: createSpaceRenderer() });
    ui.renderHistory(history);
    assert.deepEqual(ui.widgetEntries().map(({ kind, readOnly }) => [kind, readOnly]), [['schedule_widget', false]]);
});


test('点候选沿点页面类型class取色，保留三类标签与应用行为', () => {
    const renderer = createSpaceRenderer();
    for (const [type, cls, label] of [['main', 'sp-type-world', '明线'], ['hidden', 'sp-type-major', '暗线'], ['bond', 'sp-type-character', '红线']]) {
        const html = renderer.widgetCard('schedule_widget', `<schedule_widget>Event: ${type}|候选|说明|明天||||</schedule_widget>`, 'w1');
        assert.match(html, new RegExp(`sp-space-widget-badge ${cls}`));
        assert.match(html, new RegExp(label));
        assert.match(html, /sp-space-widget-apply/);
        assert.doesNotMatch(html, /style="[^"]*(?:color|background)/);
    }
});
