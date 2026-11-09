import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = source.indexOf('let activePortableImportOverlayClose = null;');
const end = source.indexOf('async function commitPortableImport(', start);

function harness() {
    const nodes = [];
    const listeners = new Map();
    const document = {
        getElementById: id => nodes.find(node => node.id === id),
        createElement: () => ({
            style: {},
            attachShadow(options) {
                assert.equal(options.mode, 'open');
                this.shadowRoot = { innerHTML: '' };
                return this.shadowRoot;
            },
            contains(target) { return target === this; },
            remove() { const index = nodes.indexOf(this); if (index >= 0) nodes.splice(index, 1); },
        }),
        documentElement: { appendChild: node => nodes.push(node) },
        addEventListener: (name, handler) => listeners.set(name, handler),
        removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); },
    };
    const mount = Function('document', 'getSettings', 'currentTheme', 'STYLESHEET_URL', source.slice(start, end) + '\nreturn mountPortableImportOverlay;')(document, () => ({ themeMode: 'day' }), 'day', 'style.css?v=overlay-test');
    return { mount, nodes, listeners };
}

test('导入进度遮罩阻止外部输入，关闭及重复关闭都清理遮罩与监听', () => {
    const { mount, nodes, listeners } = harness();
    const overlay = mount();
    assert.equal(nodes.length, 1);
    assert.ok(nodes[0].shadowRoot);
    assert.match(nodes[0].style.cssText, /width:100dvw;height:100dvh/);
    assert.match(nodes[0].shadowRoot.innerHTML, /style\.css\?v=overlay-test/);
    assert.match(nodes[0].shadowRoot.innerHTML, /sp-day sp-forced-day/);
    assert.equal(listeners.size, 6);
    let blocked = 0;
    let stopped = 0;
    listeners.get('keydown')({ target: {}, preventDefault() { blocked++; }, stopImmediatePropagation() { stopped++; } });
    listeners.get('click')({ target: nodes[0], preventDefault() { blocked++; }, stopImmediatePropagation() { stopped++; } });
    assert.equal(blocked, 1);
    assert.equal(stopped, 1);
    assert.doesNotThrow(() => overlay.close());
    assert.equal(nodes.length, 0);
    assert.equal(listeners.size, 0);
    assert.doesNotThrow(() => overlay.close());
    assert.equal(nodes.length, 0);
    assert.equal(listeners.size, 0);
});

test('替换进度遮罩关闭旧实例，旧close不会移除新实例监听', () => {
    const { mount, nodes, listeners } = harness();
    const first = mount();
    const second = mount();
    assert.equal(nodes.length, 1);
    assert.equal(listeners.size, 6);
    first.close();
    assert.equal(nodes.length, 1);
    assert.equal(listeners.size, 6);
    second.close();
    assert.equal(nodes.length, 0);
    assert.equal(listeners.size, 0);
});
