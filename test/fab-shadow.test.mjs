import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { syncUiTheme } from '../utils/ui-theme.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function region(start, end) {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
    assert.ok(begin >= 0 && finish > begin, `production region ${start}`);
    return source.slice(begin, finish);
}

test('FAB bootstrap hides the native button until the later stylesheet supplies its layout', () => {
    const injection = region('function injectFab()', 'function onFabPointerMove');
    const markup = injection.match(/shadow\.innerHTML = `([\s\S]+?)`;/)?.[1];
    assert.ok(markup);
    assert.match(markup, /^<style>\.sp-fab-btn\s*\{\s*display:\s*none;\s*\}<\/style>/);
    assert.ok(markup.indexOf('</style>') < markup.indexOf('<link rel="stylesheet"'));
    const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    const rule = css.match(/\.sp-fab-btn\s*\{([^}]+)\}/)?.[1];
    assert.match(rule, /display\s*:\s*flex/);
});

function harness() {
    const element = (...classes) => {
        const names = new Set(classes);
        return { names, classList: { add: (...values) => values.forEach(value => names.add(value)), remove: (...values) => values.forEach(value => names.delete(value)) } };
    };
    const button = element('sp-fab-btn', 'sp-night'), decoy = element('sp-fab-btn'), toggle = element();
    const roots = [element(), element(), element()], panel = element(), dialog = element();
    let host = { shadowRoot: { querySelector: () => button }, querySelector: () => decoy };
    let mode = 'auto';
    const wrap = target => ({
        toggleClass(name, on) { if (target) on ? target.names.add(name) : target.names.delete(name); return this; },
        removeClass(names) { names.split(' ').forEach(name => target?.names.delete(name)); return this; },
        addClass(name) { target?.names.add(name); return this; },
    });
    const sandbox = {
        FAB_ID: 'sp-fab', MODAL_ID: 'sp-modal-root', currentTheme: 'night', syncUiTheme,
        document: {
            getElementById: id => id === 'sp-fab' ? host : null,
            querySelectorAll: selector => selector.includes('#sp-fab ') ? [...roots, decoy] : roots,
        },
        $: target => wrap(typeof target === 'string' ? host ? decoy : null : target),
        $in: () => wrap(toggle),
        getSettings: () => ({ themeMode: mode }),
        _spShadow: { querySelectorAll: () => [panel] }, _spDialogShadow: { querySelectorAll: () => [dialog] },
        getToastContainer: () => null,
        syncPrimaryTextColor() {}, syncInlineTheme() {}, coordinateRuntime: null, refreshUserNameMask() {},
    };
    const api = vm.runInNewContext(`${region('let _fabBusyCount = 0;', '// ─── FAB ')}
        ${region('function applyTheme(theme)', '// ─── Theme mode toggle')}
        ({ getFabButton: typeof getFabButton === 'function' ? getFabButton : null, setFabBusy, setExtBtnState, applyTheme })`, sandbox);
    return { api, button, decoy, toggle, roots: [...roots, panel, dialog], host: value => { host = value; }, mode: value => { mode = value; } };
}

test('FAB lookup returns the owned shadow button instead of a light DOM namesake', () => {
    const h = harness();
    assert.equal(typeof h.api.getFabButton, 'function');
    assert.equal(h.api.getFabButton(), h.button);
    h.host({ querySelector: () => h.decoy });
    assert.equal(h.api.getFabButton(), null);
    h.host({ shadowRoot: { querySelector: () => null } });
    assert.equal(h.api.getFabButton(), null);
});

test('concurrent busy requests update the shadow button until the last request finishes', () => {
    const h = harness();
    h.api.setFabBusy(true); h.api.setFabBusy(true); h.api.setFabBusy(false);
    assert.equal(h.button.names.has('sp-fab-busy'), true);
    assert.equal(h.decoy.names.has('sp-fab-busy'), false);
    h.api.setFabBusy(false); h.api.setFabBusy(false);
    assert.equal(h.button.names.has('sp-fab-busy'), false);
});

test('generation and completion states target the shadow button and retain perspective locking', () => {
    const h = harness();
    h.api.setFabBusy(true);
    h.api.setExtBtnState('generating');
    assert.equal(h.button.names.has('sp-btn-generating'), true);
    assert.equal(h.toggle.names.has('sp-locked'), true);
    h.api.setExtBtnState('done');
    assert.equal(h.button.names.has('sp-btn-generating'), false);
    assert.equal(h.button.names.has('sp-btn-done'), true);
    assert.equal(h.button.names.has('sp-fab-busy'), true);
    assert.equal(h.toggle.names.has('sp-locked'), false);
    h.api.setExtBtnState(null);
    assert.equal(h.button.names.has('sp-btn-done'), false);
    assert.equal(h.decoy.names.size, 1);
});

test('missing FAB host or shadow button keeps busy and generation updates safe', () => {
    const h = harness();
    assert.equal(typeof h.api.getFabButton, 'function');
    for (const host of [null, {}, { shadowRoot: { querySelector: () => null } }]) {
        h.host(host);
        assert.equal(h.api.getFabButton(), null);
        assert.doesNotThrow(() => { h.api.setFabBusy(true); h.api.setFabBusy(false); h.api.setExtBtnState('generating'); });
        assert.equal(h.toggle.names.has('sp-locked'), true);
        h.api.setExtBtnState(null);
        assert.equal(h.toggle.names.has('sp-locked'), false);
    }
});

test('theme changes reach the owned shadow FAB and every existing UI root', () => {
    const h = harness();
    for (const mode of ['day', 'night', 'auto']) {
        h.mode(mode);
        const theme = mode === 'auto' ? 'day' : mode;
        h.api.applyTheme(theme);
        for (const root of [h.button, ...h.roots]) {
            assert.equal(root.names.has(`sp-${theme}`), true, mode);
            assert.equal(root.names.has(`sp-forced-${theme}`), mode !== 'auto', mode);
        }
        assert.equal(h.decoy.names.size, 1);
    }
});
