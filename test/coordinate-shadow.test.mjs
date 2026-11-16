import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createCoordinateFeature } from '../business/coordinate/feature.js';
import { readReplyMarker } from '../business/coordinate/identity.js';

// Only the host DOM is simulated; scanning, ownership and favorite actions run production code.
class Element {
    constructor(tagName = 'div') {
        this.tagName = tagName;
        this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.className = '';
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            toggle: (name, on) => {
                const classes = new Set(this.className.split(/\s+/).filter(Boolean));
                on ? classes.add(name) : classes.delete(name); this.className = [...classes].join(' ');
            },
        };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
    insertBefore(child, reference) {
        if (!reference) return this.appendChild(child);
        child.remove(); this.children.splice(this.children.indexOf(reference), 0, child); child.parentElement = this; return child;
    }
    replaceChildren(...children) { [...this.children].forEach(child => child.remove()); children.forEach(child => this.appendChild(child)); }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    attachShadow(options) {
        assert.equal(options.mode, 'open');
        assert.notEqual(this.tagName, 'button', 'native buttons cannot own a Shadow Root');
        this.shadowRoot = { host: this, innerHTML: '' }; return this.shadowRoot;
    }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    click() {
        const event = { prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
        for (const listener of this.listeners.get('click') || []) listener(event);
        return event;
    }
    closest(selector) {
        if (selector === '.mes' && this.classList.contains('mes')) return this;
        return this.parentElement?.closest(selector) || null;
    }
    querySelectorAll(selector) {
        const matches = node => selector === '.sp-anchor-btn' || selector.includes('#chat .sp-anchor-btn') || selector.includes('#chat .mes .sp-anchor-btn')
            ? node.classList.contains('sp-anchor-btn') && (!selector.includes('[data-sp-anchor-entry="menu"]') || node.getAttribute('data-sp-anchor-entry') === 'menu')
            : selector.includes('.mes[is_user="false"]') ? node.classList.contains('mes') && node.getAttribute('is_user') === 'false'
                : selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName === selector;
        return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) {
        for (const candidate of selector.split(',').map(value => value.trim())) {
            const hit = this.querySelectorAll(candidate)[0]; if (hit) return hit;
        }
        return null;
    }
}

function harness({ inline = true, menu = true, selectMany } = {}) {
    const document = new Element('document'); document.createElement = tag => new Element(tag);
    const floor = document.appendChild(new Element()); floor.className = 'mes'; floor.setAttribute('mesid', 0); floor.setAttribute('is_user', false);
    const toolbar = floor.appendChild(new Element()); toolbar.className = 'mes_buttons';
    const edit = toolbar.appendChild(new Element('button')); edit.className = 'mes_edit';
    const extra = floor.appendChild(new Element()); extra.className = 'extraMesButtons';
    const text = floor.appendChild(new Element()); text.className = 'mes_text'; text.innerHTML = '<p>正文</p>';
    const context = { chatId: 'chat-1', name2: '角色', chatMetadata: {}, chat: [{ mes: '正文', send_date: '2026-11-15' }] };
    const settings = { anchorInlineBtn: inline, anchorMenuBtn: menu }, items = new Map(), calls = [];
    let enabled = true;
    const repository = {
        getAllItems: async () => [...items.values()], getTags: async () => [], checkSize: async () => {},
        addItem: async item => { calls.push('save'); items.set(item.id, item); return item; },
        deleteItem: async id => { calls.push('delete'); items.delete(id); },
    };
    const feature = createCoordinateFeature({ repository, host: {
        document, enabled: () => enabled, settings: () => settings, context: () => context,
        capture: () => ({ html: '<p>正文</p>', preview: '正文' }), saveChatDebounced: async () => { calls.push('marker'); }, selectMany,
    } });
    feature.init({ chatId: context.chatId });
    const buttons = () => floor.querySelectorAll('.sp-anchor-btn');
    const iconRoot = button => button.querySelector('sp-anchor-icon')?.shadowRoot;
    return { feature, document, floor, toolbar, extra, edit, buttons, iconRoot, context, items, calls, settings, disable: () => { enabled = false; } };
}

test('both floor entries isolate their SVG while preserving native button placement and accessibility', () => {
    const h = harness(); h.feature.scanButtons();
    const [inline, menu] = h.buttons();
    assert.equal(inline.tagName, 'button'); assert.equal(inline.parentElement, h.toolbar);
    assert.equal(menu.parentElement, h.extra); assert.equal(menu.classList.contains('mes_button'), true);
    for (const button of [inline, menu]) {
        const root = h.iconRoot(button); assert.ok(root);
        assert.match(root.innerHTML, /<svg\b/); assert.match(root.innerHTML, /<style>[\s\S]+<\/style>/);
        assert.doesNotMatch(root.innerHTML, /<link\b/);
        assert.equal(button.querySelector('svg'), null);
        assert.equal(button.querySelector('sp-anchor-icon').getAttribute('aria-hidden'), 'true');
        assert.equal(button.getAttribute('aria-label'), '收藏此楼'); assert.equal(button.getAttribute('aria-pressed'), 'false');
    }
    assert.notEqual(h.iconRoot(inline), h.iconRoot(menu));
});

test('rescanning preserves roots, third party ordering and one click listener per button', () => {
    const h = harness(); h.feature.scanButtons();
    const [inline, menu] = h.buttons(), roots = [h.iconRoot(inline), h.iconRoot(menu)];
    h.toolbar.insertBefore(inline, h.edit);
    h.toolbar.appendChild(menu); // Third party menu placement is already supported by the host adapter.
    h.feature.scanButtons(); h.feature.scanButtons();
    assert.equal(h.toolbar.children[0], inline); assert.equal(menu.parentElement, h.toolbar);
    assert.deepEqual(h.buttons(), [inline, menu]);
    assert.deepEqual([h.iconRoot(inline), h.iconRoot(menu)], roots);
    assert.equal(inline.listeners.get('click').length, 1); assert.equal(menu.listeners.get('click').length, 1);
});

test('favorite and cancellation clicks synchronize both isolated entries and preserve their icon roots', async () => {
    let choose; const choice = new Promise(resolve => { choose = resolve; });
    const h = harness({ selectMany: () => choice }); h.feature.scanButtons();
    const [inline, menu] = h.buttons(), roots = [h.iconRoot(inline), h.iconRoot(menu)];
    assert.ok(roots.every(Boolean));
    const event = inline.click(); await setImmediate();
    assert.equal(event.prevented, 1); assert.equal(event.stopped, 1);
    assert.equal(h.calls.length, 0); assert.equal(inline.classList.contains('sp-anchor-busy'), true); assert.equal(menu.classList.contains('sp-anchor-busy'), true);
    choose(null); await setImmediate();
    assert.equal(h.items.size, 1); assert.deepEqual(h.calls, ['save', 'marker']); assert.ok(readReplyMarker(h.context.chat[0]));
    for (const button of [inline, menu]) {
        assert.equal(button.getAttribute('aria-pressed'), 'true'); assert.equal(button.title, '已收藏 · 点击取消');
        assert.equal(button.classList.contains('sp-anchor-busy'), false);
    }
    menu.click(); await setImmediate();
    assert.equal(h.items.size, 0); assert.deepEqual(h.calls, ['save', 'marker', 'delete', 'marker']); assert.equal(readReplyMarker(h.context.chat[0]), null);
    for (const button of [inline, menu]) assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.deepEqual([h.iconRoot(inline), h.iconRoot(menu)], roots);
});

test('a restored light DOM icon is upgraded without replacing its native button or listeners', () => {
    const h = harness(); h.feature.scanButtons(); const button = h.buttons()[0];
    button.replaceChildren(new Element('svg'));
    h.feature.scanButtons();
    assert.equal(h.buttons()[0], button); assert.ok(h.iconRoot(button));
    assert.equal(button.querySelector('svg'), null); assert.equal(button.listeners.get('click').length, 1);
});

test('Tauri retains its before-edit insertion, and disabling or destroying removes the complete entry', () => {
    const previous = globalThis.__TAURITAVERN__;
    try {
        globalThis.__TAURITAVERN__ = { abiVersion: 1 };
        const h = harness(); h.feature.scanButtons();
        const inline = h.buttons()[0]; assert.ok(h.iconRoot(inline)); assert.equal(h.toolbar.children[0], inline);
        assert.equal(inline.classList.contains('mes_button'), true);
        h.settings.anchorInlineBtn = false; h.feature.scanButtons();
        assert.equal(h.buttons().length, 1); assert.equal(inline.parentElement, null);
        h.feature.destroy(); assert.equal(h.buttons().length, 0);
        h.feature.scanButtons(); h.disable(); h.feature.scanButtons(); assert.equal(h.buttons().length, 0);
    } finally {
        if (previous === undefined) delete globalThis.__TAURITAVERN__; else globalThis.__TAURITAVERN__ = previous;
    }
});

test('isolated icons retain the fixed inline size and native toolbar em size', () => {
    const h = harness(); h.feature.scanButtons();
    const root = h.iconRoot(h.buttons()[0]); assert.ok(root);
    assert.match(root.innerHTML, /width:\s*var\(--sp-anchor-icon-size/);
    assert.match(root.innerHTML, /color:\s*inherit/);
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /\.sp-anchor-btn\s*\{[^}]*--sp-anchor-icon-size:\s*var\(--sp-size-15\)/);
    assert.match(css, /\.sp-anchor-btn\.mes_button\s*\{[^}]*--sp-anchor-icon-size:\s*1em/);
});
