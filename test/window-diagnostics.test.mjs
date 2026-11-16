import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as diagnosticsModule from '../ui/window-diagnostics.js';

class Target {
  handlers = new Map();
  addEventListener(type, handler) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(handler); }
  removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
  emit(type, fields = {}) { for (const handler of [...(this.handlers.get(type) || [])]) handler({ type, ...fields }); }
  get listenerCount() { return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0); }
}

function fixture() {
  const frames = new Map(), timers = new Map(), observers = []; let next = 0, reads = 0, clock = 1000;
  const styles = values => ({ getPropertyValue: key => values[key] || '' });
  const element = (tag, id = '') => Object.assign(new Target(), {
    tagName: tag, id, nodeType: 1, style: styles({}), rect: { left: 0, top: 0, width: 390, height: 844 },
    clientWidth: 390, clientHeight: 844, scrollWidth: 390, scrollHeight: 844, scrollLeft: 0, scrollTop: 0,
    css: { position: 'fixed', display: 'block', visibility: 'visible', opacity: '1', transform: 'none', 'pointer-events': 'auto', 'font-size': '12.464px' },
    getBoundingClientRect() { reads++; return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; },
    getAttribute: () => null, contains(node) { return node === this; },
  });
  const html = element('HTML'), body = element('BODY'), root = element('DIV', 'sp-modal-root'), sheet = element('DIV');
  const input = element('TEXTAREA', 'sp-space-input'), dialogHost = element('DIV', 'sp-dialog-host'), fab = element('DIV', 'sp-fab');
  input.rect = { left: 60, top: 735, width: 280, height: 32 };
  input.readOnly = false; input.disabled = false;
  for (const key of ['value', 'textContent', 'innerHTML', 'outerHTML']) Object.defineProperty(input, key, { get() { throw new Error('PRIVATE_INPUT_SECRET'); } });
  const shadow = Object.assign(new Target(), { host: root, activeElement: null, querySelector: () => null, elementsFromPoint: () => [input, sheet] });
  root.shadowRoot = shadow; root.parentElement = html; sheet.parentElement = null;
  sheet.getRootNode = () => shadow; sheet.contains = node => node === input || node === sheet;
  const document = Object.assign(new Target(), { documentElement: html, body, activeElement: root, scrollingElement: html, visibilityState: 'visible',
    fullscreenElement: null, querySelector: selector => selector.startsWith('meta') ? { content: 'width=device-width,initial-scale=1' } : null,
    elementsFromPoint: () => [root, body], getElementById: () => null });
  Object.defineProperty(document, 'cookie', { get() { throw new Error('PRIVATE_COOKIE_SECRET'); } });
  const win = Object.assign(new Target(), { document, innerWidth: 390, innerHeight: 844, outerWidth: 390, outerHeight: 844, scrollX: 0, scrollY: 0,
    devicePixelRatio: 3, navigator: { userAgent: 'iPhone Version/26.0 Mobile Safari/604.1', platform: 'iPhone', maxTouchPoints: 5, language: 'zh-CN' },
    screen: { width: 390, height: 844, availWidth: 390, availHeight: 844, orientation: { type: 'portrait-primary', angle: 0 } },
    matchMedia: () => ({ matches: false }), getComputedStyle(node) { reads++; return styles(node.css || {}); },
    requestAnimationFrame(fn) { frames.set(++next, fn); return next; }, cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); },
    MutationObserver: class { constructor(fn) { this.fn = fn; this.targets = []; observers.push(this); } observe(node) { this.targets.push(node); } disconnect() { this.targets = []; } },
  });
  for (const key of ['localStorage', 'sessionStorage', 'fetch']) Object.defineProperty(win, key, { get() { throw new Error('FORBIDDEN_STORAGE_OR_NETWORK'); } });
  win.visualViewport = Object.assign(new Target(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1 });
  const nodes = { root, sheet, shadow, input, dialogHost, fab, settingsBody: null, messages: null };
  const options = { windowRef: win, elements: () => { reads++; return nodes; },
    sourceUrl: 'https://PRIVATE_ORIGIN/extensions/gouhua-app.js?v=build-123&key=PRIVATE_URL_SECRET',
    readUiState: () => ({ module: 'space', settingsOpen: false, apiKey: 'PRIVATE_SETTING_SECRET' }), now: () => clock++ };
  const create = extra => { assert.equal(typeof diagnosticsModule.createWindowDiagnostics, 'function'); return diagnosticsModule.createWindowDiagnostics({ ...options, ...extra }); };
  return { create, options, win, document, nodes, frames, timers, observers, get reads() { return reads; },
    flush() { const queued = [...frames.values()]; frames.clear(); queued.forEach(fn => fn()); },
    timeout() { const queued = [...timers.values()]; timers.clear(); queued.forEach(fn => fn()); } };
}

test('disabled diagnostics do not read layout, attach observers or access storage', () => {
  const f = fixture(), recorder = f.create();
  assert.equal(recorder.snapshot(), null); recorder.record('idle');
  assert.equal(f.reads, 0); assert.equal(f.win.listenerCount, 0); assert.equal(f.observers.length, 0); assert.equal(f.timers.size, 0);
});

test('one session captures the environment, shadow focus, viewport and window geometry without content or URLs', () => {
  const f = fixture(), recorder = f.create(); f.nodes.shadow.activeElement = f.nodes.input;
  recorder.start();
  f.win.visualViewport.height = 350; f.win.visualViewport.offsetTop = 420;
  f.nodes.root.rect.top = -420; f.nodes.sheet.rect.top = -400;
  f.win.visualViewport.emit('resize'); f.flush();
  f.nodes.shadow.emit('input', { target: f.nodes.input, data: 'PRIVATE_EVENT_SECRET', inputType: 'insertText', composedPath: () => [f.nodes.input, f.nodes.sheet, f.nodes.shadow, f.nodes.root] }); f.flush();
  recorder.record('sync.preserved', { preserveEditingGeometry: true, mobile: true });
  recorder.record('sync.requested', { preserveEditingGeometry: true });
  recorder.stop('manual'); const report = recorder.snapshot();
  assert.equal(report.kind, 'gouhua-window-diagnostics');
  assert.equal(report.environment.build.file, 'gouhua-app.js'); assert.equal(report.environment.build.cache, 'build-123');
  assert.equal(report.environment.browser.userAgent, f.win.navigator.userAgent);
  assert.ok(report.events.some(event => event.viewport.visual.height === 350 && event.viewport.visual.offsetTop === 420));
  assert.ok(report.events.some(event => event.focus.deepest?.id === 'sp-space-input'));
  assert.ok(report.events.some(event => event.event === 'sync.preserved' && event.decision.preserveEditingGeometry === true));
  assert.deepEqual(report.events.find(event => event.event === 'sync.requested').decision, { preserveEditingGeometry: true }, 'unobserved decisions must remain absent');
  assert.ok(report.events.some(event => event.event === 'visual-viewport.resize'));
  assert.ok(report.events.some(event => event.windows.root?.rect.top === -420));
  const text = JSON.stringify(report); assert.doesNotMatch(text, /PRIVATE_|FORBIDDEN_|https?:\/\//);
  report.events.length = 0; assert.ok(recorder.snapshot().events.length > 0, 'export is independent of retained memory');
});

test('stop and timeout release listeners, observers and queued frames, retaining a bounded report', () => {
  const f = fixture(), recorder = f.create(); recorder.start();
  for (let i = 0; i < 300; i++) recorder.record('sync.applied', { preserveEditingGeometry: false });
  f.win.emit('resize'); assert.ok(f.frames.size > 0);
  f.timeout(); const report = recorder.snapshot();
  assert.equal(recorder.state().recording, false); assert.equal(f.win.listenerCount, 0); assert.equal(f.win.visualViewport.listenerCount, 0);
  assert.equal(f.nodes.shadow.listenerCount, 0); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  assert.ok(f.observers.every(observer => observer.targets.length === 0));
  assert.ok(report.events.length <= 128); assert.ok(report.droppedEvents > 0); assert.ok(report.initial);
  const reads = f.reads; recorder.record('ignored'); recorder.snapshot(); assert.equal(f.reads, reads);
  recorder.start(); assert.equal(recorder.snapshot().droppedEvents, 0); recorder.stop();
});

test('style changes and paint hit tests are collected without leaking CSS resource addresses', () => {
  const f = fixture(), recorder = f.create(); recorder.start();
  f.nodes.sheet.css.opacity = '0'; f.nodes.sheet.css.filter = 'url(https://PRIVATE_FILTER_SECRET/filter.svg)';
  f.observers[0].fn([{ target: f.nodes.sheet, attributeName: 'style' }]); f.flush(); recorder.stop();
  const report = recorder.snapshot();
  assert.ok(report.events.some(event => event.windows.sheet?.css.opacity === '0'));
  assert.ok(report.final.paint?.length > 0); assert.ok(report.initial.ancestors?.length > 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|https?:\/\//);
});

test('a failed diagnostic read never throws into the window flow or exposes the error message', () => {
  const f = fixture(), recorder = f.create({ elements() { throw new Error('PRIVATE_FAILURE_SECRET'); }, onChange() { throw new Error('PRIVATE_CALLBACK_SECRET'); } });
  assert.doesNotThrow(() => recorder.start()); assert.doesNotThrow(() => recorder.record('sync.applied')); assert.doesNotThrow(() => recorder.stop());
  assert.ok(recorder.snapshot()); assert.doesNotMatch(JSON.stringify(recorder.snapshot()), /PRIVATE_/);
});

test('copy stops recording and manual-copy fallback retains the entire report', async () => {
  assert.equal(typeof diagnosticsModule.shareWindowDiagnostics, 'function');
  const f = fixture(), recorder = f.create(); recorder.start();
  let copied = '', fallback;
  const result = await diagnosticsModule.shareWindowDiagnostics({ diagnostics: recorder, copyText: async text => { copied = text; return true; } });
  assert.equal(result.status, 'copied'); assert.equal(recorder.state().recording, false); assert.equal(JSON.parse(copied).kind, 'gouhua-window-diagnostics');
  const manual = await diagnosticsModule.shareWindowDiagnostics({ diagnostics: recorder, copyText: async () => false, promptTextarea: async value => { fallback = value; } });
  assert.equal(manual.status, 'manual-copy'); assert.equal(fallback.initialValue, copied); assert.ok(fallback.maxLength >= copied.length);
});

test('file export stops the session and hands the same safe report to the existing download helper', () => {
  assert.equal(typeof diagnosticsModule.exportWindowDiagnostics, 'function');
  const f = fixture(), recorder = f.create(); recorder.start(); let file;
  const result = diagnosticsModule.exportWindowDiagnostics({ diagnostics: recorder, downloadJson: report => { file = report; } });
  assert.equal(result.status, 'exported'); assert.equal(recorder.state().recording, false);
  assert.equal(file.kind, 'gouhua-window-diagnostics'); assert.equal(file.stopReason, 'export');
  assert.doesNotMatch(JSON.stringify(file), /PRIVATE_|FORBIDDEN_|https?:\/\//);
});

test('diagnostic controls start, stop and copy explicitly, and use no background layout reads while idle', async () => {
  assert.equal(typeof diagnosticsModule.bindWindowDiagnosticControls, 'function');
  const f = fixture(), controls = Object.fromEntries(['start', 'copy', 'export', 'status', 'start-label'].map(key => [key, Object.assign(new Target(), { textContent: '', disabled: false })]));
  const uiRoot = { querySelector: selector => controls[selector.replace('#sp-window-diagnostic-', '')] || null };
  let copied = '';
  const recorder = diagnosticsModule.bindWindowDiagnosticControls({ ...f.options, root: uiRoot, copyText: async text => { copied = text; return true; } });
  assert.equal(controls.copy.disabled, true); assert.equal(controls.export.disabled, true); assert.equal(f.reads, 0);
  controls.start.emit('click'); assert.equal(recorder.state().recording, true); assert.equal(controls.copy.disabled, false);
  assert.equal(controls['start-label'].textContent, '停止记录');
  controls.copy.emit('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorder.state().recording, false); assert.equal(controls['start-label'].textContent, '开始记录'); assert.ok(copied);
});

test('declined manual copy never rejects into the window interface', async () => {
  const f = fixture(), recorder = f.create(); recorder.start();
  const result = await diagnosticsModule.shareWindowDiagnostics({ diagnostics: recorder, copyText: async () => false,
    promptTextarea: async () => { throw new Error('declined'); }, notify() { throw new Error('no toast'); } });
  assert.equal(result.status, 'failed'); assert.equal(recorder.state().recording, false);
});

test('closing the production panel ends diagnostics after the hidden state is recorded', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function closePanel() {'), end = source.indexOf('function ensureExcludedCharacterSettingsOnly()', start);
  const root = { display: 'block' }, events = []; let finish;
  const wrapper = { stop() { return this; }, animate(_properties, _duration, callback) { finish = () => callback.call(root); } };
  const context = { MODAL_ID: 'panel', windowDiagnostics: { record: event => events.push(event), stop: reason => events.push(`stopped:${reason}`) },
    $: target => typeof target === 'string' ? wrapper : { css(key, value) { target[key] = value; } },
    onDragEnd() {}, onResizeEnd() {}, coordinateRuntime: null, theaterFeature: { onPanelClosed() {} },
    _activeSpConfirmCancel: null, _activeStoreConflictFinish: null, removeDialogOverlays() {}, customDialog: { cancelActive() {} } };
  runInNewContext(source.slice(start, end), context); context.closePanel();
  assert.deepEqual(events, ['panel.close-requested']); assert.equal(root.display, 'block');
  finish(); assert.equal(root.display, 'none');
  assert.deepEqual(events.slice(-2), ['panel.closed', 'stopped:panel-closed']);
});
