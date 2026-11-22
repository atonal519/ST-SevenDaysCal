import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogManager } from '../modal.js';
import { createInlineFeature } from '../business/inline/feature.js';

class FakeQuery {
    constructor(selector = '', parent = null) {
        this.selector = selector;
        this.parent = parent;
        this[0] = new EventTarget();
        this.children = new Map();
        this.handlers = new Map();
        this.attributes = {};
        this.htmlValue = '';
    }
    find(selector) {
        if (!this.children.has(selector)) this.children.set(selector, new FakeQuery(selector, this));
        return this.children.get(selector);
    }
    on(event, selector, handler) {
        if (typeof selector === 'function') handler = selector, selector = '';
        this.handlers.set(`${event} ${selector || ''}`.trim(), handler);
        if (!selector) this[0].addEventListener(event, value => handler.call(this[0], value));
        return this;
    }
    handler(event, selector = '') { return this.handlers.get(`${event} ${selector}`.trim()); }
    html(value) { if (value === undefined) return this.htmlValue; this.htmlValue = value; return this; }
    prop() { return this; }
    attr(name, value) { if (value !== undefined) this.attributes[name] = value; return this.attributes[name] ?? this[0]?.attributes?.[name]; }
    empty() { this.htmlValue = ''; return this; }
    remove() { return this; }
    addClass() { return this; }
    last() { return this; }
    trigger() { return this; }
}

function dialogFixture() {
    let overlay;
    const $ = value => {
        if (value instanceof FakeQuery) return value;
        if (typeof value === 'string' && value.startsWith('<div id="sp-addon-dialog"')) return (overlay = new FakeQuery(value));
        if (value && typeof value === 'object') return Object.assign(new FakeQuery(value), { 0: value, attributes: value.attributes || {} });
        return new FakeQuery(String(value ?? ''));
    };
    const manager = createDialogManager({ $, mount: { appendChild() {} }, subscribeContextChange: () => () => {} });
    return { manager, get overlay() { return overlay; } };
}

test('dialog text selection ending on the backdrop does not dismiss the editor', async () => {
    const fixture = dialogFixture();
    const input = { tagName: 'INPUT', value: 'https://fixture.invalid/v1' };
    let closes = 0;
    const pending = fixture.manager.custom({ content: input, submit: () => true, onClose: () => closes++ });
    const backdrop = fixture.overlay[0];
    const panel = fixture.overlay.find('.sp-dialog-sheet')[0];
    const emit = (type, path, clientX) => {
        const event = new Event(type);
        Object.defineProperty(event, 'target', { value: path[0] });
        Object.assign(event, { button: 0, pointerId: 1, clientX, clientY: 20, composedPath: () => path });
        backdrop.dispatchEvent(event);
    };

    emit('pointerdown', [input, panel, backdrop], 120);
    emit('pointerup', [backdrop], 20);
    emit('click', [backdrop], 20);
    assert.equal(closes, 0, 'the common click target is the backdrop even though the press began in an input');

    for (const type of ['pointerdown', 'pointerup', 'click']) emit(type, [backdrop], 20);
    assert.equal(await pending, null);
    assert.equal(closes, 1, 'a separate click entirely on the backdrop still closes');
});

test('async picker separates load failure, legal empty result, and a selectable result', async () => {
    const fixture = dialogFixture();
    const { manager } = fixture;
    const waitForLoad = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

    const failed = manager.selectOneAsync({
        title: '方向', emptyText: '没有得到可用方向，请刷新重试',
        loadErrorText: error => error.code === 'config-missing' ? '请先填写自定义 API 的 URL 和 Key；也可以返回后直接采用。' : '读取 AI 推演方向失败，请重试。',
        loadChoices: async () => { throw Object.assign(new Error('raw secret response body'), { code: 'config-missing' }); },
    });
    await waitForLoad();
    const failedBody = fixture.overlay.find('.sp-dialog-async-body').html();
    assert.match(failedBody, /请先填写自定义 API 的 URL 和 Key/);
    assert.doesNotMatch(failedBody, /没有得到可用方向|raw secret response body/);
    assert.equal(fixture.overlay.find('.sp-dialog-input-error').html(), '');
    fixture.overlay.find('.sp-dialog-cancel').handler('click')();
    assert.equal(await failed, null);

    const empty = manager.selectOneAsync({ emptyText: '没有得到可用方向，请刷新重试', loadChoices: async () => [] });
    await waitForLoad();
    assert.match(fixture.overlay.find('.sp-dialog-async-body').html(), /没有得到可用方向，请刷新重试/);
    fixture.overlay.find('.sp-dialog-cancel').handler('click')();
    assert.equal(await empty, null);

    const valid = manager.selectOneAsync({ loadChoices: async () => [{ value: 'direction-a', label: '方向 A' }] });
    await waitForLoad();
    assert.match(fixture.overlay.find('.sp-dialog-async-body').html(), /方向 A/);
    const choose = fixture.overlay.handler('click', '.sp-dialog-single-option');
    choose.call({ attributes: { 'data-dialog-value': 'direction-a' } });
    fixture.overlay.find('.sp-dialog-submit').handler('click')();
    assert.equal(await valid, 'direction-a');
});

test('mounted inline box keeps a readable ledger-only summary chip and omits it when empty', () => {
    let ledgerHtml = '';
    let scheduleHtml = '';
    const calendar = { kind: 'gregorian', id: 'default-gregorian' };
    const message = {
        children: [],
        querySelectorAll: () => message.children,
        appendChild(node) { message.children.push(node); },
    };
    const floor = {
        getAttribute: name => ({ is_user: 'false', mesid: '2' })[name] ?? null,
        querySelector: selector => selector === '.mes_text' ? message : null,
        querySelectorAll: () => [],
    };
    const chat = { contains: () => true };
    const doc = {
        querySelector: selector => selector === '#chat' ? chat : null,
        querySelectorAll: () => [],
        createElement() {
            const holder = {
                children: [],
                setAttribute() {},
                appendChild(child) { this.children.push(child); return child; },
                attachShadow() { this.shadowRoot = doc.createElement(); this.shadowRoot.host = this; return this.shadowRoot; },
                get firstElementChild() { return this.children[0] || null; },
                remove() { message.children = message.children.filter(node => node !== this); },
            };
            Object.defineProperty(holder, 'innerHTML', { set(value) {
                holder.children = [{
                    producedHtml: value, open: false,
                    querySelectorAll: () => [], addEventListener() {}, remove() { message.children = message.children.filter(node => node !== this); },
                }];
            } });
            return holder;
        },
    };
    const feature = createInlineFeature({
        documentRef: doc, windowRef: { innerHeight: 800 },
        getSettings: () => ({ inlineRenderEnabled: true, ledgerInlineEnabled: true }),
        pluginEnabled: () => true, getContext: () => ({ chatId: 'inline-test' }),
        loadAlmanac: () => [], loadCalDesc: () => calendar, almTodayAnchor: () => ({ month: 1, day: 2 }), almWeekdayRef: () => null,
        almWeekdayFor: () => null, almDayOfYear: () => 1, ALM_WEEKDAYS: [], getDateAnchor: () => null,
        charStableKey: () => 'inline-test', readCacheRaw: () => '', getCacheKey: () => 'point-cache',
        escapeHtml: value => String(value ?? ''),
        parseCalendar: () => ({ days: [{ events: [{ title: 'todo' }] }], future: { events: [] } }),
        calMonthName: () => 'Month', calHasEra: () => false, formatStoryClockHeadParts: () => ({ todayHtml: '', timeHtml: '' }), storyClockEnabled: () => false,
        getLinesCacheKey: () => 'lines-cache', readStore: () => null, keyDesc: () => ({}),
        parseLines: () => [], linesFeature: { inlineHtml: () => '' },
        axisInlineRenderer: { buildAlmanacBlock: () => null },
        pointInlineRenderer: { buildScheduleBlock: () => scheduleHtml },
        _buildLedgerBlockHtml: () => ledgerHtml,
        snapshot: {}, freezeSnapshot() {},
    });

    feature.mount(floor, true);
    assert.equal(message.children.length, 0, 'an empty ledger and empty sibling modules do not mount a box');

    ledgerHtml = '<summary class="sp-inline-summary"><span class="sp-inline-title">标注池</span>实际记录</summary>';
    feature.mount(floor, true);
    assert.equal(message.children.length, 1);
    const ledgerOnlyHtml = message.children[0].shadowRoot.children.at(-1).firstElementChild.producedHtml;
    assert.match(ledgerOnlyHtml, /<span class="sp-dash-sum-chip">标注池<\/span>/);
    assert.match(ledgerOnlyHtml, /实际记录/);
    assert.doesNotMatch(ledgerOnlyHtml, /<span class="sp-dash-sum-chip">点\d+/);

    scheduleHtml = '';
    ledgerHtml = '';
    feature.mount(floor, true);
    assert.equal(message.children.length, 0, 'empty ledger output and empty sibling modules do not mount a box');

    ledgerHtml = '<summary class="sp-inline-summary"><span class="sp-inline-title">标注池</span>实际记录</summary>';
    scheduleHtml = '<summary class="sp-inline-summary"><span class="sp-inline-title">点</span>真实日程</summary>';
    feature.mount(floor, true);
    const mixedHtml = message.children.at(-1).shadowRoot.children.at(-1).firstElementChild.producedHtml;
    assert.match(mixedHtml, /<span class="sp-dash-sum-chip">标注池<\/span>/);
    assert.match(mixedHtml, /点1/);
    assert.match(mixedHtml, /真实日程/);
});
