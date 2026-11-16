import test from 'node:test';
import assert from 'node:assert/strict';
import { createInlineFeature } from './feature.js';
import { createLinesFeature } from '../lines/feature.js';
import { createDashedModule } from '../lines/dashed.js';

class Node {
    constructor(className = '', attrs = {}, tag = 'div') {
        this.className = className;
        this.attrs = attrs;
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this._innerHTML = '';
        if (this.tagName === 'DETAILS') this.open = false;
    }
    getAttribute(key) { return this.attrs[key] ?? null; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    matches(selector) {
        if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this.className.split(' ').includes(name));
        return this.tagName === selector.toUpperCase();
    }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest?.(selector) || null; }
    getRootNode() { return this.parentNode?.getRootNode?.() || this; }
    attachShadow({ mode }) {
        this.shadowRoot = new Node('', {}, '#shadow-root');
        this.shadowRoot.host = this;
        this.shadowRoot.mode = mode;
        return this.shadowRoot;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        if (selector.startsWith(':scope > ')) return this.children.filter(child => child.matches(selector.slice(9)));
        return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        children.forEach(child => this.appendChild(child));
    }
    addEventListener() {}
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    set innerHTML(value) {
        this._innerHTML = value;
        const tag = value.match(/^\s*<([a-z]+)/)?.[1] || 'div';
        const child = new Node(value.match(/class="([^"]*sp-inline-box[^"]*)"/)?.[1] || 'sp-inline-box', {}, tag);
        child._innerHTML = value;
        this.children = [];
        this.appendChild(child);
    }
    get firstElementChild() { return this.children[0] || null; }
}
const createElement = tag => new Node('', {}, tag);
const renderedBox = message => message.querySelector('.mes_text').firstElementChild?.shadowRoot?.querySelector('.sp-inline-box');

function userHarness(extra = {}) {
    const message = new Node('mes', { mesid: '7', is_user: 'true' });
    message.appendChild(new Node('mes_text'));
    let body = '已保存内容';
    const feature = createInlineFeature({
        documentRef: { createElement }, windowRef: {}, getContext: () => ({ chatId: 'shadow-floor' }),
        pluginEnabled: () => true, getSettings: () => ({ inlineRenderEnabled: true }),
        stylesheetUrl: '/style.css?v=inline-test',
        readSnapshot: () => ({}),
        buildUserRecall: () => `<details class="sp-inline-box sp-inline-box-ro">${body}</details>`,
        ...extra,
    });
    return { feature, message, changeBody(value) { body = value; } };
}

test('mount isolates floor content in an open shadow root with the shared stylesheet', () => {
    const { feature, message } = userHarness();
    feature.mount(message, true);
    const host = message.querySelector('.mes_text').firstElementChild;
    assert.equal(host.tagName, 'DIV');
    assert.equal(host.getAttribute('data-sp-inline-host'), '');
    assert.equal(host.shadowRoot.mode, 'open');
    assert.equal(host.children.length, 0, 'rendered content belongs to the shadow tree');
    assert.equal(host.shadowRoot.querySelector('link').href, '/style.css?v=inline-test');
    assert.match(renderedBox(message)._innerHTML, /已保存内容/);
    assert.deepEqual(feature.getRoots(), [host.shadowRoot]);
});

test('root binders apply once per root and replace registrations by key', () => {
    const { feature, message, changeBody } = userHarness();
    const first = [], replacement = [];
    feature.bindRoots('actions', root => first.push(root));
    feature.mount(message, true);
    feature.mount(message, true);
    assert.equal(first.length, 1);
    feature.bindRoots('actions', root => replacement.push(root));
    assert.equal(replacement.length, 1);
    changeBody('更新后的内容');
    feature.mount(message, true);
    assert.equal(first.length, 1);
    assert.equal(replacement.length, 1, 'content updates retain the existing delegation container');
    feature.unmount(message);
    feature.mount(message, true);
    assert.equal(replacement.length, 2, 'a new root receives the registered bindings');
    assert.equal(replacement[1].className, 'sp-inline-surface');
    assert.equal(feature.getRoots().length, 1);
});

test('updates retain the styled root, and remount restores the details state', () => {
    const { feature, message, changeBody } = userHarness();
    feature.mount(message, true);
    const originalHost = message.querySelector('.mes_text').firstElementChild;
    const originalStylesheet = originalHost.shadowRoot.querySelector('link');
    renderedBox(message).open = true;
    changeBody('改变后的正文');
    feature.mount(message, true);
    assert.equal(message.querySelector('.mes_text').firstElementChild, originalHost);
    assert.equal(originalHost.shadowRoot.querySelector('link'), originalStylesheet);
    assert.equal(renderedBox(message).open, true);
    feature.unmount(message);
    assert.equal(feature.getRoots().length, 0);
    feature.mount(message, true);
    assert.equal(renderedBox(message).open, true);
});

test('scrolling away retains the mounted root until its floor leaves the render-depth window', () => {
    const originalObserver = globalThis.IntersectionObserver;
    let notifyVisibility;
    globalThis.IntersectionObserver = class {
        constructor(callback) { notifyVisibility = callback; }
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    const { feature, message } = userHarness();
    const window = { renderFloors: [message], currentEl: null, winSet: new Set([message]) };
    try {
        feature.refresh(true, { window });
        const host = message.querySelector('.mes_text').firstElementChild;
        renderedBox(message).open = true;
        notifyVisibility([{ target: message, isIntersecting: false }]);
        assert.equal(message.querySelector('.mes_text').firstElementChild, host, 'scrolling away must retain the expanded layout');
        notifyVisibility([{ target: message, isIntersecting: true }]);
        assert.equal(message.querySelector('.mes_text').firstElementChild, host, 'scrolling back must retain the styled root');
        assert.equal(renderedBox(message).open, true);
        feature.refresh(true, { window: { ...window, winSet: new Set() } });
        assert.equal(message.querySelector('.mes_text').children.length, 0, 'leaving the depth window still releases the floor');
        assert.equal(feature.getRoots().length, 0);
    } finally {
        feature.destroy();
        globalThis.IntersectionObserver = originalObserver;
    }
});

test('historical strip context resolves its message through the shadow host', () => {
    const saved = { point: '历史点', weekdayRef: null };
    const calendar = { months: [{ days: 30 }] };
    const reads = [];
    let stripContext;
    const { feature, message } = userHarness({
        $: () => ({ on() { return this; }, off() { return this; } }),
        pointInlineRenderer: { bindScheduleStripDelegation({ inlineTapContext }) { stripContext = inlineTapContext; } },
        readSnapshot: floor => { reads.push(floor); return saved; },
        loadCalDesc: () => calendar, keyDesc: () => 'fallback', readStore: () => null,
        snapshot: { readSnapshot: floor => { reads.push(floor); return saved; },
            resolveSnapshotCalendar: snap => { assert.equal(snap, saved); return { resolved: true, calendar }; } },
        createWeekdayConsumerContext: () => ({ weekdayRef: null }), storyWeekdayRefPure: () => null,
    });
    feature.mount(message, false);
    const button = renderedBox(message).appendChild(new Node('sp-sch-scell'));
    const context = stripContext(button);
    assert.equal(context.readOnly, true);
    assert.equal(context.snap, saved);
    assert.equal(context.resolvedCalendar, calendar);
    assert.deepEqual(reads, [7, 7]);
});

test('read-only refresh mounts restored content while business refresh still freezes the latest floor', () => {
    let freezes = 0;
    const current = new Node('mes', { mesid: '1', is_user: 'true' });
    current.appendChild(new Node('mes_text'));
    const feature = createInlineFeature({
        documentRef: { createElement }, windowRef: {},
        pluginEnabled: () => true, getContext: () => ({ chatId: 'restored-inline-test' }),
        getSettings: () => ({ inlineRenderEnabled: true }),
        freezeSnapshot: () => { freezes++; return {}; }, readSnapshot: () => ({}),
        buildUserRecall: () => '<div class="sp-inline-box">已恢复内容</div>',
    });
    const shared = { window: { renderFloors: [current], currentEl: current, winSet: new Set([current]) } };

    feature.refresh(true, { ...shared, freezeSnapshots: false });
    assert.equal(freezes, 0);
    assert.match(renderedBox(current)._innerHTML, /已恢复内容/);

    feature.refresh(true, shared);
    assert.equal(freezes, 1);
});

test('historical mount renders its saved cold texts without reading current inventory', () => {
    let inventoryReads = 0;
    const savedCold = ['历史楼冷知识甲', '历史楼冷知识乙'];
    const calendar = { months: [{ name: '一月', days: 30 }] };
    let dashedEnabled = true;
    const dashed = createDashedModule({
        keyDesc: () => 'dashed',
        readStore: () => { inventoryReads++; return { items: [{ text: '当前冷知识' }] }; },
        getSettings: () => ({ dashedEnabled }), escapeHtml: String,
    });
    let historicalSnapshot = { line: '历史线raw', cold: savedCold };
    const ai = new Node('mes', { mesid: '0', is_user: 'false' });
    ai.appendChild(new Node('mes_text'));
    const feature = createInlineFeature({
        documentRef: { createElement }, windowRef: {},
        pluginEnabled: () => true, getContext: () => ({ chatId: 'history-cold-test' }),
        getSettings: () => ({ inlineRenderEnabled: true, linesInlineEnabled: true }),
        readSnapshot: () => historicalSnapshot,
        snapshot: { resolveSnapshotCalendar: () => ({ resolved: true, calendar }) }, loadCalDesc: () => calendar,
        loadAlmanac: () => [], almTodayAnchor: () => ({ month: 1, day: 2 }),
        almWeekdayRef: () => null, getDateAnchor: () => null, charStableKey: () => 'char',
        readCacheRaw: () => '', getCacheKey: () => 'point', readStore: () => null, keyDesc: () => 'fallback',
        createWeekdayConsumerContext: () => ({ weekdayRef: null }), storyWeekdayRefPure: () => null, ALM_CHAT_SCAN_LIMIT: 1,
        axisInlineRenderer: { buildAlmanacBlock: () => null, buildAlmanacDay: () => '' },
        pointInlineRenderer: { buildScheduleBlock: () => '', bindScheduleStripDelegation() {} },
        _buildLedgerBlockHtml: () => '',
        linesFeature: createLinesFeature({
            getSettings: () => ({ linesInlineEnabled: true, dashedEnabled }),
            readRaw: () => '', escapeHtml: String, escapeAttr: String, dashed,
        }),
    });

    feature.mount(ai, false);
    const box = renderedBox(ai);
    assert.match(box._innerHTML, /历史楼冷知识甲/);
    assert.match(box._innerHTML, /历史楼冷知识乙/);
    assert.doesNotMatch(box._innerHTML, /当前冷知识|sp-inline-refresh-dashed/);
    assert.equal(inventoryReads, 0);

    dashedEnabled = false;
    feature.mount(ai, false);
    const disabledBox = renderedBox(ai);
    assert.doesNotMatch(disabledBox._innerHTML, /sp-dashed-inline-sub|历史楼冷知识/);
    dashedEnabled = true;
    feature.mount(ai, false);
    const reopenedBox = renderedBox(ai);
    assert.match(reopenedBox._innerHTML, /历史楼冷知识甲/);

    historicalSnapshot = { line: '旧线raw' };
    feature.mount(ai, false);
    const oldBox = renderedBox(ai);
    assert.doesNotMatch(oldBox._innerHTML, /sp-dashed-inline-sub|当前冷知识/);
    assert.equal(inventoryReads, 0, '旧快照没有冷知识字段时不补造过去的内容');
});

test('轴组合保历史历法及外层独有纪年，不再重复今日大头或日格，点单开同样去重',()=>{
    const calendar={kind:'custom',era:'旧历纪年',months:[{name:'旧月',days:30}]};
    const snap={anchor:{month:1,day:2},almanac:[{id:'a',name:'历史事项'}],point:'历史点'};
    let axisOn=true,pointOn=true,rawStamp='';const calendars=[];
    const ai=new Node('mes',{mesid:'0',is_user:'false'});ai.appendChild(new Node('mes_text'));
    const feature=createInlineFeature({documentRef:{createElement},windowRef:{},pluginEnabled:()=>true,getContext:()=>({chatId:'axis-compose'}),getSettings:()=>({inlineRenderEnabled:true}),
        readSnapshot:()=>snap,snapshot:{resolveSnapshotCalendar:()=>({resolved:true,calendar})},loadCalDesc:()=>({kind:'custom',era:'活态年号',months:[{name:'活月',days:40}]}),
        loadAlmanac:()=>{throw Error('历史不可读活事项');},almTodayAnchor:()=>({month:1,day:1}),almWeekdayRef:()=>null,almDayOfYear:()=>2,almWeekdayFor:()=>null,ALM_WEEKDAYS:[],
        escapeHtml:String,calMonthName:(cal,m)=>cal.months[m-1].name,calHasEra:cal=>!!cal.era,getDateAnchor:()=>null,charStableKey:()=>'',readCacheRaw:()=>'',getCacheKey:()=>'',readStore:()=>null,keyDesc:()=>'',
        createWeekdayConsumerContext:()=>({weekdayRef:null}),storyWeekdayRefPure:()=>null,storyClockEnabled:()=>!!rawStamp,parseStoryClock:()=>({start:rawStamp}),
        formatStoryClockHeadParts:({rawStamp})=>({todayHtml:`<span class="sp-dash-sum-today">${rawStamp||'外层日期'}</span>`,timeHtml:''}),parseCalendar:()=>({days:[],future:null}),
        axisInlineRenderer:{buildAlmanacBlock:(_items,_anchor,cal)=>{calendars.push(cal);return axisOn?{summary:'<summary class="sp-inline-summary">轴1件事</summary>',itemsHtml:'<div class="sp-alm-events">历史事项</div>'}:null;}},
        pointInlineRenderer:{buildScheduleBlock:()=>pointOn?'<summary>点</summary><div>历史点内容</div>':'',bindScheduleStripDelegation(){}},linesFeature:{inlineHtml:()=>''},_buildLedgerBlockHtml:()=>''});
    const html=()=>renderedBox(ai)._innerHTML;
    feature.mount(ai,false);assert.match(html(),/历史事项/);assert.equal((html().match(/旧历纪年/g)||[]).length,1);assert.doesNotMatch(html(),/sp-dash-today|sp-dash-top|sp-alm-strip|活态年号/);assert.equal(calendars[0],calendar);
    axisOn=false;feature.mount(ai,false);assert.match(html(),/历史点内容/);assert.doesNotMatch(html(),/sp-dash-today|sp-dash-top/);
    pointOn=false;feature.mount(ai,false);assert.match(html(),/sp-dash-flat/);assert.match(html(),/旧历纪年/);
    calendar.kind='gregorian';calendar.displayStyle='numeric';calendar.era='民国';rawStamp='民国初春';
    feature.mount(ai,false);assert.match(html(),/民国初春/);assert.equal((html().match(/民国/g)||[]).length,1);
    rawStamp='初春';feature.mount(ai,false);assert.match(html(),/初春/);assert.equal((html().match(/民国/g)||[]).length,1);
});

test('多模块时内层默认收起，单模块时唯一模块默认展开', () => {
    const calendar = { months: [{ name: '一月', days: 30 }] };
    const ai = new Node('mes', { mesid: '0', is_user: 'false' });
    ai.appendChild(new Node('mes_text'));
    let schedule = true;
    const feature = createInlineFeature({
        documentRef: { createElement }, windowRef: {},
        pluginEnabled: () => true, getContext: () => ({ chatId: 'region-defaults' }),
        getSettings: () => ({ inlineRenderEnabled: true }), readSnapshot: () => ({ anchor: { month: 1, day: 2 } }),
        snapshot: { resolveSnapshotCalendar: () => ({ resolved: true, calendar }) }, loadCalDesc: () => calendar,
        loadAlmanac: () => [], almTodayAnchor: () => ({ month: 1, day: 2 }), almWeekdayRef: () => null,
        almWeekdayFor: () => null, ALM_WEEKDAYS: [], escapeHtml: String, calMonthName: () => '一月',
        calHasEra: () => false, getDateAnchor: () => null, charStableKey: () => '', readCacheRaw: () => '',
        getCacheKey: () => '', readStore: () => null, keyDesc: () => '', createWeekdayConsumerContext: () => ({ weekdayRef: null }),
        storyWeekdayRefPure: () => null, ALM_CHAT_SCAN_LIMIT: 1, parseCalendar: () => ({ days: [], future: null }),
        formatStoryClockHeadParts: () => ({ todayHtml: '', timeHtml: '' }), storyClockEnabled: () => false,
        axisInlineRenderer: { buildAlmanacBlock: () => ({ summary: '<summary>轴</summary>', itemsHtml: '<div>轴内容</div>' }) },
        pointInlineRenderer: { buildScheduleBlock: () => schedule ? '<div>点内容</div>' : '', bindScheduleStripDelegation() {} },
        linesFeature: { inlineHtml: () => '' }, _buildLedgerBlockHtml: () => '',
    });

    const html = () => renderedBox(ai)._innerHTML;
    feature.mount(ai, false);
    assert.match(html(), /data-seg="almanac"(?![^>]*\bopen)/);
    assert.match(html(), /data-seg="schedule"(?![^>]*\bopen)/);

    schedule = false;
    feature.mount(ai, false);
    assert.match(html(), /<details class="sp-almanac-inline sp-dash-region" data-seg="almanac" open>/);
});
