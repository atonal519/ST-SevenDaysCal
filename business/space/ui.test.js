import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceUi } from './ui.js';
import { createSpaceRenderer } from './render.js';
import { appendSpaceAssistant } from './schema.js';
import { createAxisWidgetActions } from '../axis/widget.js';
import { createSpaceRepository } from './repository.js';

function pageUiFixture(pages = ['1', '2'], options = {}) {
    const target = { chatId: 'page-ui', historyKey: 'page-ui-history' };
    let saved = { version: 1, pages, messages: pages.map(id => ({ role: 'user', content: `窗口${id}记录`, pageId: id })) };
    let writable = true, confirm = true, busy = false;
    const writes = [], confirmations = [], handlers = new Map(), nodes = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, {
            length: 1, attrs: {}, props: {}, value: '', scrollTop: 0, scrollHeight: 400,
            attr(key, value) { if (arguments.length > 1) { this.attrs[key] = value; return this; } return this.attrs[key]; },
            prop(key, value) { if (arguments.length > 1) { this.props[key] = value; return this; } return this.props[key]; },
            val(value) { if (arguments.length) { this.value = value; return this; } return this.value; },
            on(event, selector, handler) { handlers.set(`${event} ${selector}`, handler); return this; },
            off() { return this; }, empty() { this.scrollTop = 0; return this; },
            addClass() { return this; }, html() { return this; }, append() { return this; }, appendTo() { return this; }, focus() {},
        });
        return nodes.get(selector);
    };
    const repository = createSpaceRepository({
        captureIdentity: () => target, isCurrent: value => value === target, readStore: () => saved,
        writeStore: (_key, value) => { if (!writable) return false; saved = structuredClone(value); writes.push(saved); return true; },
    });
    repository.load();
    const ui = createSpaceUi({
        query: node, element: node, $: value => typeof value === 'string' ? node(Symbol()) : value,
        confirm: async options => { confirmations.push(options); return confirm; },
        saveSpaceNote: options.saveSpaceNote,
        hasSpaceNote: options.hasSpaceNote,
        toast: options.toast,
    });
    ui.bindControllers({ repository, chat: { history: repository.history, get busy() { return busy; } }, renderer: createSpaceRenderer() });
    ui.bind(); ui.renderHistory(repository.history());
    return {
        ui, repository, writes, confirmations, node,
        close: id => handlers.get('click.spSpaceFeature [data-space-close-page]').call(node(`close-${id}`).attr('data-space-close-page', id), { stopPropagation() {} }),
        favorite: index => {
            const button = node(`favorite-${index}`);
            button.closest = () => node(`message-${index}`).attr('data-idx', String(index));
            return handlers.get('click.spSpaceFeature .sp-chat-msg-actions > button.sp-chat-msg-favorite').call(button);
        },
        add: () => handlers.get('click.spSpaceFeature #sp-space-add-page')({ stopPropagation() {} }),
        key: key => handlers.get('keydown.spSpaceFeature [data-space-page]')({ key, preventDefault() {} }),
        setConfirm: value => { confirm = value; }, setWritable: value => { writable = value; }, setBusy: value => { busy = value; },
    };
}

test('the Space bubble bookmarks its complete text once while the write is pending', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const requests = [], toasts = [];
    const f = pageUiFixture(['1', '2'], {
        saveSpaceNote: note => { requests.push(note); return pending; },
        toast: (...args) => toasts.push(args),
    });
    f.ui.switchPage('2');
    const save = f.favorite(1);
    assert.equal(f.node('favorite-1').attr('data-favorite-state'), 'pending');
    await f.favorite(1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, '窗口2记录');
    assert.ok(requests[0].id);
    assert.equal(toasts.length, 0);
    finish(requests[0]);
    await save;
    assert.equal(toasts[0][0], '已收藏到坐标');
    assert.equal(f.node('favorite-1').attr('data-favorite-state'), 'saved');
    assert.equal(f.node('favorite-1').attr('aria-label'), '已收藏到坐标');
    const id = requests[0].id;
    assert.deepEqual(f.repository.history()[1].coordinateNote, { id, chatId: 'page-ui' });
    assert.equal(f.writes[0].messages[1].coordinateNote.id, id);
    f.repository.load();
    f.ui.switchPage('1');
    f.ui.switchPage('2');
    assert.equal(await f.close('2'), true);
    assert.deepEqual(f.repository.history().map(message => message.pageId), ['1']);
    assert.equal(requests[0].text, '窗口2记录');
});

test('a failed bookmark returns to the unfilled state and can retry', async () => {
    const requests = [];
    const f = pageUiFixture(['1'], {
        saveSpaceNote: note => {
            requests.push(note.id);
            return requests.length === 1 ? Promise.reject(new Error('save failed')) : Promise.resolve(note);
        },
    });
    await f.favorite(0);
    assert.equal(f.node('favorite-0').attr('data-favorite-state'), 'idle');
    assert.equal(f.node('favorite-0').prop('disabled'), false);
    assert.equal(f.writes.length, 0);
    await f.favorite(0);
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    assert.equal(f.node('favorite-0').attr('data-favorite-state'), 'saved');
});

test('关闭当前窗口切回另一页并还原草稿和滚动，重新新增的页没有旧草稿', async () => {
    const f = pageUiFixture();
    f.node('#sp-space-input').val('第一页草稿');
    f.node('#sp-space-msgs').scrollTop = 41;
    f.ui.switchPage('2');
    f.node('#sp-space-input').val('第二页草稿');
    assert.equal(await f.close('2'), true);
    assert.equal(f.ui.activePageId(), '1');
    assert.equal(f.node('#sp-space-input').val(), '第一页草稿');
    assert.equal(f.node('#sp-space-msgs').scrollTop, 41);
    assert.deepEqual(f.repository.history().map(message => message.pageId), ['1']);
    assert.match(f.confirmations[0].body, /窗口2/);
    f.add();
    assert.equal(f.ui.activePageId(), '2');
    assert.equal(f.node('#sp-space-input').val(), '');
});

test('关闭另一窗口不切页、不挪滚动，窗口2单独保留时键盘和重置仍选中它', async () => {
    const f = pageUiFixture();
    f.ui.switchPage('2');
    f.node('#sp-space-input').val('继续窗口2');
    f.node('#sp-space-msgs').scrollTop = 73;
    assert.equal(await f.close('1'), true);
    assert.equal(f.ui.activePageId(), '2');
    assert.equal(f.node('#sp-space-input').val(), '继续窗口2');
    assert.equal(f.node('#sp-space-msgs').scrollTop, 73);
    assert.deepEqual(f.repository.pages(), ['2']);
    f.key('Home'); assert.equal(f.ui.activePageId(), '2');
    f.ui.resetPages(); assert.equal(f.ui.activePageId(), '2');
    assert.equal(f.node('[data-space-page="2"]').attr('aria-selected'), 'true');
});

test('取消关闭、生成中、保存失败及最后一个窗口都不删除记录', async () => {
    const f = pageUiFixture();
    const before = structuredClone(f.repository.history());
    f.setConfirm(false); assert.equal(await f.close('1'), false);
    f.setConfirm(true); f.setBusy(true); assert.equal(await f.close('1'), false);
    assert.equal(f.confirmations.length, 1);
    f.setBusy(false); f.setWritable(false); assert.equal(await f.close('1'), false);
    assert.deepEqual(f.repository.pages(), ['1', '2']);
    assert.deepEqual(f.repository.history(), before);
    assert.equal(f.writes.length, 0);
    const single = pageUiFixture(['2']);
    assert.equal(single.ui.activePageId(), '2');
    assert.equal(await single.close('2'), false);
    assert.equal(single.confirmations.length, 0);
    assert.equal(single.writes.length, 0);
    assert.equal(single.node('#sp-space-pages').prop('hidden'), true);
});

test('空窗口也先弹确认，等待或取消期间保留窗口和另一页草稿', async () => {
    const f = pageUiFixture();
    f.repository.replace(f.repository.capture(), f.repository.history().filter(message => message.pageId === '1'));
    f.node('#sp-space-input').val('窗口1未发送草稿');
    const beforeWrites = f.writes.length;
    let answer;
    f.setConfirm(new Promise(resolve => { answer = resolve; }));
    const pending = f.close('2');
    assert.equal(f.confirmations.length, 1);
    assert.deepEqual(f.repository.pages(), ['1', '2']);
    assert.equal(f.writes.length, beforeWrites);
    answer(false);
    assert.equal(await pending, false);
    assert.deepEqual(f.repository.pages(), ['1', '2']);
    assert.equal(f.node('#sp-space-input').val(), '窗口1未发送草稿');
    f.setConfirm(true);
    assert.equal(await f.close('2'), true);
    assert.equal(f.confirmations.length, 2);
    assert.deepEqual(f.repository.pages(), ['1']);
});

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
