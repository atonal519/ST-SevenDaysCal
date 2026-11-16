import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = source.indexOf('function injectExtButton() {');
const end = source.indexOf('// 悬浮球「插件在忙」', start);
assert.ok(start >= 0 && end > start);
const brand = source.match(/^const PEN_MENU_ICON_SVG = .+;$/m)?.[0];
assert.ok(brand);

function harness({ ready = true, preferred = false } = {}) {
    const observers = [], fallback = { children: [{ id: 'another-plugin' }] }, wrapper = { children: [] };
    const entries = new Map();
    let openCount = 0;
    for (const parent of [fallback, wrapper]) parent.insertAdjacentHTML = (_position, html) => {
        const handlers = new Map();
        const entry = {
            id: 'sp_open_wand', lightHtml: html, parentElement: parent,
            attachShadow(options) { assert.equal(options.mode, 'open'); this.shadowRoot = { host: this, innerHTML: '' }; return this.shadowRoot; },
            addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
            click() { for (const handler of handlers.get('click') || []) handler({ target: this }); },
        };
        parent.children.push(entry); entries.set(entry.id, entry);
    };
    const document = {
        body: {},
        getElementById: id => entries.get(id) || (ready && id === 'sp_wand_container' && preferred ? wrapper : ready && id === 'extensionsMenu' ? fallback : null),
    };
    class Observer {
        constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
        observe(target, options) { assert.equal(target, document.body); assert.equal(options.subtree, true); }
        disconnect() { this.disconnected = true; }
    }
    const inject = vm.runInNewContext(`${brand}\n${source.slice(start, end)}\ninjectExtButton`, {
        document, MutationObserver: Observer, openSchedule: () => { openCount++; },
    });
    return { inject, observers, fallback, wrapper, entry: () => entries.get('sp_open_wand'), ready: value => { ready = value; }, opens: () => openCount };
}

test('wand renders its icon and label in an immediately styled Shadow Root while retaining native discovery markup', () => {
    const h = harness(); h.inject();
    const entry = h.entry();
    assert.ok(entry.shadowRoot);
    assert.match(entry.shadowRoot.innerHTML, /<style>[\s\S]+<\/style>/);
    assert.match(entry.shadowRoot.innerHTML, /sp-menu-pen-icon/);
    assert.match(entry.shadowRoot.innerHTML, /构画/);
    assert.doesNotMatch(entry.shadowRoot.innerHTML, /<link\b/);
    assert.match(entry.lightHtml, /extensionsMenuExtensionButton/);
    assert.match(entry.lightHtml, /<span[^>]*>构画<\/span>/);
    assert.match(entry.lightHtml, /list-group-item flex-container flexGap5/);
    assert.deepEqual(h.fallback.children.map(child => child.id), ['another-plugin', 'sp_open_wand']);
});

test('wand mounts once and each native click opens the panel exactly once', () => {
    const h = harness(); h.inject();
    const entry = h.entry(), root = entry.shadowRoot;
    h.inject();
    assert.equal(h.entry(), entry); assert.equal(h.entry().shadowRoot, root);
    assert.equal(h.fallback.children.length, 2);
    assert.equal(h.observers.length, 0);
    entry.click(); assert.equal(h.opens(), 1);
    entry.click(); assert.equal(h.opens(), 2);
});

test('wand retains the existing preferred menu container without moving other entries', () => {
    const h = harness({ preferred: true }); h.inject();
    assert.equal(h.entry().parentElement, h.wrapper);
    assert.ok(h.entry().shadowRoot);
    assert.deepEqual(h.fallback.children.map(child => child.id), ['another-plugin']);
});

test('late native menu creation mounts the isolated entry and releases its bootstrap observer', () => {
    const h = harness({ ready: false }); h.inject();
    assert.equal(h.entry(), undefined); assert.equal(h.observers.length, 1);
    h.ready(true); h.observers[0].callback();
    assert.ok(h.entry().shadowRoot);
    assert.equal(h.observers[0].disconnected, true);
    h.observers[0].callback(); h.entry().click();
    assert.equal(h.fallback.children.length, 2); assert.equal(h.opens(), 1);
});
