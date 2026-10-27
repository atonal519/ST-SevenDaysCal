import test from 'node:test';
import assert from 'node:assert/strict';
import { createInlineFeature } from './feature.js';
import { createLinesFeature } from '../lines/feature.js';
import { createDashedModule } from '../lines/dashed.js';

class Node {
    constructor(className = '', attrs = {}) { this.className = className; this.attrs = attrs; this.children = []; this.parentNode = null; this._innerHTML = ''; }
    getAttribute(key) { return this.attrs[key] ?? null; }
    querySelector(selector) { return (selector === '.mes_text' ? this.children.filter(child => child.className === 'mes_text') : this.querySelectorAll(selector))[0] || null; }
    querySelectorAll(selector) { return selector === ':scope > .sp-inline-box' ? this.children.filter(child => child.className.includes('sp-inline-box')) : []; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    addEventListener() {}
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
    set innerHTML(value) { this._innerHTML = value; const child = new Node(value.match(/class="([^"]*sp-inline-box[^"]*)"/)?.[1] || 'sp-inline-box'); child._innerHTML = value; this.children = [child]; }
    get firstElementChild() { return this.children[0] || null; }
}

test('read-only refresh mounts restored content while business refresh still freezes the latest floor', () => {
    let freezes = 0;
    const current = new Node('mes', { mesid: '1', is_user: 'true' });
    current.appendChild(new Node('mes_text'));
    const feature = createInlineFeature({
        documentRef: { createElement: () => new Node() }, windowRef: {},
        pluginEnabled: () => true, getContext: () => ({ chatId: 'restored-inline-test' }),
        getSettings: () => ({ inlineRenderEnabled: true }),
        freezeSnapshot: () => { freezes++; return {}; }, readSnapshot: () => ({}),
        buildUserRecall: () => '<div class="sp-inline-box">已恢复内容</div>',
    });
    const shared = { window: { renderFloors: [current], currentEl: current, winSet: new Set([current]) } };

    feature.refresh(true, { ...shared, freezeSnapshots: false });
    assert.equal(freezes, 0);
    assert.match(current.querySelector('.mes_text').firstElementChild._innerHTML, /已恢复内容/);

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
        documentRef: { createElement: () => new Node() }, windowRef: {},
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
    const box = ai.querySelector('.mes_text').querySelector(':scope > .sp-inline-box');
    assert.match(box._innerHTML, /历史楼冷知识甲/);
    assert.match(box._innerHTML, /历史楼冷知识乙/);
    assert.doesNotMatch(box._innerHTML, /当前冷知识|sp-inline-refresh-dashed/);
    assert.equal(inventoryReads, 0);

    dashedEnabled = false;
    feature.mount(ai, false);
    const disabledBox = ai.querySelector('.mes_text').querySelector(':scope > .sp-inline-box');
    assert.doesNotMatch(disabledBox._innerHTML, /sp-dashed-inline-sub|历史楼冷知识/);
    dashedEnabled = true;
    feature.mount(ai, false);
    const reopenedBox = ai.querySelector('.mes_text').querySelector(':scope > .sp-inline-box');
    assert.match(reopenedBox._innerHTML, /历史楼冷知识甲/);

    historicalSnapshot = { line: '旧线raw' };
    feature.mount(ai, false);
    const oldBox = ai.querySelector('.mes_text').querySelector(':scope > .sp-inline-box');
    assert.doesNotMatch(oldBox._innerHTML, /sp-dashed-inline-sub|当前冷知识/);
    assert.equal(inventoryReads, 0, '旧快照没有冷知识字段时不补造过去的内容');
});
