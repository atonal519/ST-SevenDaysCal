import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const begin = source.indexOf('// ─── Toast (top)');
const end = source.indexOf('// 点行内动作', begin);

function harness({ native = false } = {}) {
    const hosts = [], toasts = [], timers = [], nativeCalls = [], maskRefreshes = [];
    const container = { toasts };
    const document = {
        getElementById: id => hosts.find(host => host.id === id) || null,
        createElement: () => ({
            style: {},
            attachShadow(options) {
                assert.equal(options.mode, 'open');
                this.shadowRoot = { innerHTML: '', querySelector: selector => selector === '#sp-toast-wrap' ? container : null };
                return this.shadowRoot;
            },
        }),
        documentElement: {
            appendChild: host => hosts.push(host),
            insertAdjacentHTML: (position, html) => hosts.push({ id: html.match(/id="([^"]+)"/)[1] }),
        },
    };
    const dollar = target => {
        if (typeof target === 'string') {
            if (!target.startsWith('<')) return { length: hosts.filter(host => `#${host.id}` === target).length, append() { assert.fail('toast append must use its owned Shadow Root'); } };
            const node = { markup: target, classes: new Set(), handlers: {}, removed: false };
            const wrapped = {
                node,
                addClass(name) { node.classes.add(name); return this; },
                removeClass(name) { node.classes.delete(name); return this; },
                css() { return this; },
                on(type, handler) { node.handlers[type] = handler; return this; },
                remove() { node.removed = true; },
            };
            return wrapped;
        }
        return { append(toast) { assert.equal(target, container); toasts.push(toast); } };
    };
    const sandbox = {
        document, currentTheme: 'night', STYLESHEET_URL: 'style.css?v=fixture-revision',
        getSettings: () => ({ themeMode: 'night' }),
        $: dollar, icon: name => `<svg data-icon="${name}"></svg>`,
        escapeHtml: text => String(text).replaceAll('<', '&lt;'),
        requestAnimationFrame: fn => fn(), setTimeout: (fn, ms) => timers.push({ fn, ms }),
        refreshUserNameMask: node => maskRefreshes.push(node),
    };
    if (native) {
        sandbox.__zmerUniversalToastThemeCleanup = () => {};
        sandbox.toastr = Object.fromEntries(['error', 'info', 'success'].map(type => [type, (message, title, options) => {
            const element = { setAttribute() {} };
            nativeCalls.push({ type, message, options });
            return [element];
        }]));
    }
    const api = vm.runInNewContext(source.slice(begin, end) + '\n({ injectToastContainer, showToast })', sandbox);
    return { ...api, hosts, toasts, timers, nativeCalls, maskRefreshes };
}

test('owned toast stack mounts once inside a versioned Shadow Root with the initial forced theme', () => {
    const h = harness();
    h.injectToastContainer(); h.injectToastContainer();
    assert.equal(h.hosts.length, 1);
    assert.ok(h.hosts[0].shadowRoot);
    assert.match(h.hosts[0].shadowRoot.innerHTML, /style\.css\?v=fixture-revision/);
    assert.match(h.hosts[0].shadowRoot.innerHTML, /sp-night sp-forced-night/);
    h.showToast('<用户名字>');
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0].node.markup, /&lt;用户名字>/);
    assert.equal(h.toasts[0].node.classes.has('sp-toast-show'), true);
    assert.equal(h.timers[0].ms, 4000);
});

test('toast callbacks, failure dismissal and expiry retain their original lifetimes', () => {
    const h = harness(); h.injectToastContainer();
    let clicked = 0;
    h.showToast('click', () => clicked++);
    h.toasts[0].node.handlers.click();
    assert.equal(clicked, 1); assert.equal(h.toasts[0].node.removed, true);
    h.showToast('failure', null, true);
    assert.equal(h.timers[1].ms, 10000);
    h.toasts[1].node.handlers.click();
    assert.equal(h.toasts[1].node.classes.has('sp-toast-show'), false);
    h.timers.at(-1).fn(); assert.equal(h.toasts[1].node.removed, true);
    h.showToast('info', null, 'info');
    assert.equal(h.timers.at(-1).ms, 4000);
    h.timers.at(-1).fn(); h.timers.at(-1).fn();
    assert.equal(h.toasts[2].node.removed, true);
});

test('third-party toastr integration uses its existing API and name masking scope', () => {
    const h = harness({ native: true });
    const onClick = () => {};
    h.showToast('success', onClick); h.showToast('error', null, true); h.showToast('info', null, 'info');
    assert.deepEqual(h.nativeCalls.map(call => call.type), ['success', 'error', 'info']);
    assert.equal(h.nativeCalls[0].options.onclick, onClick);
    assert.equal(h.nativeCalls[1].options.timeOut, 10000);
    assert.equal(h.nativeCalls[2].options.timeOut, 4000);
    assert.equal(h.maskRefreshes.length, 3);
    assert.equal(h.hosts.length, 0);
});
