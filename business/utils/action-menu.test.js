import test from 'node:test';
import assert from 'node:assert/strict';
import * as actions from './action-menu.js';

function fixture({ anchor = { left: 158, top: 80, width: 32, height: 32 }, width = 170, height = 120, up = false, left = false, bounds = { left: 96, top: 50, width: 244, height: 600 }, visualViewport = null } = {}) {
    const rect = value => ({ ...value, right: value.left + value.width, bottom: value.top + value.height });
    const clip = { computed: { overflowX: 'hidden', overflowY: 'hidden' }, clientLeft: 2, clientTop: 2, clientWidth: bounds.width, clientHeight: bounds.height, getBoundingClientRect: () => rect({ left: bounds.left - 2, top: bounds.top - 2, width: bounds.width + 4, height: bounds.height + 4 }) };
    const view = { innerWidth: 390, innerHeight: 844, visualViewport, getComputedStyle: node => node.computed };
    const menu = { ownerDocument: { defaultView: view }, parentElement: clip, offsetWidth: anchor.width, offsetHeight: anchor.height, getBoundingClientRect: () => rect(anchor) };
    const limit = (value, fallback) => Number.isFinite(parseFloat(value)) ? parseFloat(value) : fallback;
    const list = {
        style: {}, hidden: false,
        computed: { top: up ? 'auto' : '37px', bottom: up ? '38px' : 'auto', left: left ? '0px' : 'auto', right: left ? 'auto' : '0px' },
        getBoundingClientRect() {
            const w = Math.min(width, limit(this.style.maxWidth, Infinity)), h = Math.min(height, limit(this.style.maxHeight, Infinity));
            const x = anchor.left + limit(this.style.left, left ? 0 : anchor.width - w);
            const y = anchor.top + limit(this.style.top, up ? -6 - h : anchor.height + 5);
            return rect({ left: x, top: y, width: w, height: h });
        },
    };
    menu.querySelector = () => list;
    const place = () => { assert.equal(typeof actions.positionActionMenu, 'function'); actions.positionActionMenu(menu); return list.getBoundingClientRect(); };
    return { menu, list, clip, view, place };
}

test('axis menu clamps to the content clip edge rather than covering the sidebar', () => {
    const f = fixture();
    const bounds = f.place();
    assert.equal(bounds.left, 96);
    assert.ok(bounds.right <= 340);
    assert.equal(bounds.top, 117);
});

test('a last-card menu opens above and limits height to the scroll container', () => {
    const f = fixture({ anchor: { left: 260, top: 260, width: 32, height: 32 }, height: 160, bounds: { left: 96, top: 100, width: 244, height: 220 } });
    const bounds = f.place();
    assert.equal(bounds.top, 100);
    assert.equal(bounds.bottom, 255);
    assert.equal(f.list.style.overflowY, 'auto');
    assert.equal(parseFloat(f.list.style.maxHeight), 155);
});

test('space keeps its upward left-aligned preference and flips only when the other side fits better', () => {
    const enough = fixture({ anchor: { left: 110, top: 440, width: 32, height: 32 }, width: 150, height: 100, up: true, left: true });
    enough.list.computed = { top: '-106px', bottom: '38px', left: '0px', right: '-118px' };
    assert.deepEqual(enough.place(), { left: 110, top: 334, width: 150, height: 100, right: 260, bottom: 434 });
    const constrained = fixture({ anchor: { left: 110, top: 62, width: 32, height: 32 }, width: 150, height: 100, up: true, left: true });
    assert.equal(constrained.place().top, 100);
});

test('visual viewport and nested shadow clip bounds constrain both menu axes', () => {
    const f = fixture({ anchor: { left: 120, top: 120, width: 32, height: 32 }, width: 500, height: 400, bounds: { left: 96, top: 100, width: 244, height: 200 }, visualViewport: { offsetLeft: 100, offsetTop: 110, width: 180, height: 120 } });
    f.menu.parentElement = null;
    f.menu.parentNode = { host: f.clip };
    const bounds = f.place();
    assert.equal(bounds.left, 100);
    assert.equal(bounds.right, 280);
    assert.ok(bounds.top >= 110 && bounds.bottom <= 230);
    assert.ok(bounds.height < 400);
});

test('clearing placement restores CSS preferences and reopening measures the new anchor', () => {
    const anchor = { left: 158, top: 80, width: 32, height: 32 };
    const f = fixture({ anchor }); f.place();
    assert.equal(typeof actions.clearActionMenuPlacement, 'function');
    actions.clearActionMenuPlacement(f.menu);
    for (const key of ['top', 'right', 'bottom', 'left', 'maxWidth', 'maxHeight', 'overflowY']) assert.equal(f.list.style[key], '');
    anchor.left = 280;
    assert.equal(f.place().left, 142);
});

test('fractional control sizes use CSS geometry rather than integer offset rounding', () => {
    const f = fixture({ anchor: { left: 170.2, top: 80, width: 41.6, height: 41.6 }, width: 190, bounds: { left: 96.3, top: 50, width: 220.7, height: 600 } });
    f.menu.offsetWidth = 42; f.menu.offsetHeight = 42;
    f.menu.computed = { width: '41.6px', height: '41.6px' };
    assert.ok(Math.abs(f.place().left - 96.3) < 0.001);
});
