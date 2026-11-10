import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import * as layout from '../ui/panel-window.js';
const rect = (left, top, width, height) => ({ left, top, width, height });
const fixture = nodes => ({ getElementById: id => nodes[id] && { getBoundingClientRect: () => nodes[id] } });

test('390 and 320 mobile use the visual viewport independently of chat and composer', () => {
  for (const width of [390, 320]) {
    const nodes = { chat: rect(10, 70, width - 20, 650), sheld: rect(0, 0, width, 844) };
    const win = { innerWidth: width, innerHeight: 844, document: fixture(nodes) };
    assert.deepEqual(layout.readPanelViewport(win), rect(0, 0, width, 844));
    nodes.chat = rect(100, 300, 100, 50);
    nodes.form_sheld = rect(100, 350, 100, 400);
    assert.deepEqual(layout.readPanelViewport(win), rect(0, 0, width, 844));
    win.visualViewport = { offsetLeft: 10, offsetTop: 100, width: width - 20, height: 400 };
    assert.deepEqual(layout.readPanelViewport(win), rect(10, 100, width - 20, 400));
  }
});

class Target {
  listeners = new Map();
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type) { this.listeners.delete(type); }
  emit(type, values = {}) { this.listeners.get(type)?.({ button: 0, pointerId: 1, clientX: 5, clientY: 5, target: this, composedPath: () => [this], ...values }); }
}

test('outside dismissal requires a plain complete outside click and respects child dialogs', () => {
  const target = new Target(), panel = {}, inside = { composedPath: () => [panel, target] };
  let closes = 0, child = false;
  const dispose = layout.bindOutsideClose({ target, panel, close: () => closes++, canClose: () => !child });
  const click = () => { target.emit('pointerdown'); target.emit('pointerup'); target.emit('click'); };
  click(); assert.equal(closes, 1);
  target.emit('pointerdown', inside); target.emit('pointerup'); target.emit('click'); assert.equal(closes, 1);
  target.emit('pointerdown'); target.emit('pointerup', inside); target.emit('click', inside); assert.equal(closes, 1);
  target.emit('pointerdown'); target.emit('pointermove', { clientY: 50 }); target.emit('pointerup'); target.emit('click'); assert.equal(closes, 1);
  target.emit('pointerdown'); target.emit('pointercancel'); target.emit('pointerup'); target.emit('click'); assert.equal(closes, 1);
  child = true; click(); assert.equal(closes, 1);
  child = false; click(); assert.equal(closes, 2);
  dispose(); assert.equal(target.listeners.size, 0);
});

test('native dialog backdrop uses coordinates so dialog padding remains internal', () => {
  const target = new Target(); target.getBoundingClientRect = () => rect(30, 40, 300, 500);
  let closes = 0;
  layout.bindOutsideClose({ target, panel: target, nativeDialog: true, close: () => closes++ });
  const click = (x, y) => { for (const type of ['pointerdown', 'pointerup', 'click']) target.emit(type, { clientX: x, clientY: y }); };
  click(35, 45); assert.equal(closes, 0);
  click(5, 5); assert.equal(closes, 1);
});

test('desktop fit clamps saved size and position within a short browser viewport', () => {
  assert.equal(typeof layout.fitDesktopPanel, 'function');
  assert.deepEqual(layout.fitDesktopPanel(rect(200, 100, 500, 600), { width: 700, height: 900 }, { left: -40, top: 500 }), { left: 210, top: 110, width: 480, height: 580 });
  assert.deepEqual(layout.fitDesktopPanel(rect(250, 200, 310, 200)), { left: 260, top: 210, width: 290, height: 180 });
  assert.deepEqual(layout.fitDesktopPanel(rect(100, 80, 1000, 800), { width: 410, height: 620 }, { left: 150, top: 130 }), { left: 150, top: 130, width: 410, height: 620 });
});


test('desktop uses the full visual viewport independently of chat or composer size', () => {
  const nodes = { chat: rect(500, 300, 400, 400), form_sheld: rect(500, 700, 400, 200) };
  const win = { document: fixture(nodes), innerWidth: 1400, innerHeight: 1000, visualViewport: { offsetLeft: 40, offsetTop: 30, width: 1300, height: 900 } };
  assert.deepEqual(layout.readPanelViewport(win), rect(40, 30, 1300, 900));
  nodes.chat = rect(650, 450, 100, 50);
  nodes.form_sheld = rect(650, 500, 100, 400);
  assert.deepEqual(layout.readPanelViewport(win), rect(40, 30, 1300, 900));
  for (const position of [{ left: 50, top: 40 }, { left: 970, top: 40 }, { left: 50, top: 320 }]) {
    assert.deepEqual(layout.fitDesktopPanel(layout.readPanelViewport(win), null, position), { ...position, width: 360, height: 600 });
  }
  const savedSize = { width: 1010, height: 750 }, savedPosition = { left: 50, top: 40 };
  assert.deepEqual(layout.fitDesktopPanel(layout.readPanelViewport(win), savedSize, savedPosition), { ...savedPosition, ...savedSize });
  win.visualViewport.width = 650; win.visualViewport.height = 400;
  assert.deepEqual(layout.fitDesktopPanel(layout.readPanelViewport(win), savedSize, savedPosition), { left: 50, top: 40, width: 630, height: 380 });
  assert.deepEqual(savedSize, { width: 1010, height: 750 });
});

test('desktop default height is 600 until the browser viewport requires a clamp', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.sp-sheet\s*\{[^}]*top\s*:\s*70px/);
  assert.deepEqual(layout.fitDesktopPanel(rect(0, 0, 1200, 700)), { left: 820, top: 70, width: 360, height: 600 });
  assert.deepEqual(layout.fitDesktopPanel(rect(0, 0, 1200, 500)), { left: 820, top: 10, width: 360, height: 480 });
  assert.deepEqual(layout.fitDesktopPanel(rect(0, 30, 1200, 700)), { left: 820, top: 100, width: 360, height: 600 });
});

test('main panel no longer observes chat dimensions', () => {
  assert.equal(layout.observeChatBounds, undefined);
});


test('normal mobile sync keeps viewport margins with one safe-area inset and ignores chat size', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.sp-sheet\s*\{[^}]*top\s*:\s*max\(20px, env\(safe-area-inset-top, 0px\)\)/);
  const start = source.indexOf('function syncPanelViewport() {');
  const end = source.indexOf('// ─── Toast (top)', start);
  for (const width of [390, 320]) {
    const sheet = { style: {} }, root = { style: {}, getBoundingClientRect: () => rect(0, -500, width, 844) };
    const nodes = { chat: rect(10, 50, width - 20, 700) };
    const win = { innerWidth: width, innerHeight: 844 };
    let safeTop = 0, safeBottom = 0;
    const document = { ...fixture(nodes), getElementById: id => id === 'panel' ? root : fixture(nodes).getElementById(id),
      createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} } };
    const context = { document, window: win, MODAL_ID: 'panel', DIALOG_HOST_ID: 'dialog', syncDialogViewport: layout.syncDialogViewport, settingsOpen: false, inEl: () => sheet,
      isMobile: () => true, readPanelViewport: layout.readPanelViewport,
      getComputedStyle: () => ({ top: `${safeTop}px`, bottom: `${safeBottom}px` }) };
    runInNewContext(source.slice(start, end), context);
    context.syncPanelViewport();
    assert.equal(sheet.style.width, `${width - 20}px`);
    assert.equal(sheet.style.height, '764px');
    assert.equal(sheet.style.top, '20px');
    assert.equal(sheet.style.left, `${width / 2}px`);
    assert.equal(root.style.transform, 'translate(0px, 500px)', '主宿主补到视口原点，原手机坐标不变');
    const original = { ...sheet.style };
    nodes.chat = rect(100, 300, 100, 50);
    nodes.form_sheld = rect(100, 350, 100, 400);
    context.syncPanelViewport();
    assert.deepEqual(sheet.style, original);
    win.visualViewport = { offsetLeft: 10, offsetTop: 30, width: width - 20, height: 400 };
    safeTop = 10; safeBottom = 5;
    context.syncPanelViewport();
    assert.equal(sheet.style.width, `${width - 40}px`);
    assert.equal(sheet.style.height, '320px');
    assert.equal(sheet.style.top, '50px');
    safeTop = 50; safeBottom = 45;
    context.syncPanelViewport();
    assert.equal(sheet.style.height, '305px');
    assert.equal(sheet.style.top, '80px');
  }
});


test('document capture consumes only a completed dismissing click and never handles wheel', () => {
  const target = new Target(), panel = {}; let open = true, child = false, closes = 0, prevented = 0, stopped = 0;
  const capture = [];
  const add = target.addEventListener.bind(target);
  target.addEventListener = (type, listener, options) => { capture.push([type, options]); add(type, listener); };
  layout.bindOutsideClose({ target, panel, close() { closes += 1; open = false; }, canClose: () => open && !child });
  const click = () => { target.emit('pointerdown'); target.emit('pointerup'); target.emit('click', { preventDefault() { prevented += 1; }, stopImmediatePropagation() { stopped += 1; } }); };
  assert.ok(capture.every(([, options]) => options === true));
  assert.equal(target.listeners.has('wheel'), false);
  child = true; click(); assert.equal(prevented, 0); assert.equal(closes, 0);
  child = false; click(); assert.equal(closes, 1); assert.equal(prevented, 1); assert.equal(stopped, 1);
  click(); assert.equal(closes, 1); assert.equal(prevented, 1);
});

test('main desktop layer passes hit testing while sheet and mobile backdrop retain their interaction', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(source, /host\.style\.cssText = '[^']*pointer-events:none;z-index:2000001'/);
  assert.match(source, /bindOutsideClose\(\{ target: document,/);
  assert.match(css, /\.sp-backdrop\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.sp-sheet\s*\{[^}]*pointer-events\s*:\s*auto/);
  assert.match(css, /@media \(max-width: 640px\) \{[^@]*\.sp-backdrop\s*\{[^}]*pointer-events\s*:\s*none/);
});


test('foreign fixed shadow window remains interactive while outside blank dismisses', () => {
  const target = new Target(), ownHost = {}, foreignHost = {}, foreignRoot = { nodeType: 11, host: foreignHost };
  const panel = { getRootNode: () => ({ host: ownHost }), ownerDocument: { defaultView: { getComputedStyle: () => ({ position: 'fixed' }) } } };
  let closes = 0; layout.bindOutsideClose({ target, panel, close: () => closes++ });
  for (const type of ['pointerdown', 'pointerup', 'click']) target.emit(type, { composedPath: () => [foreignRoot, foreignHost, target] });
  assert.equal(closes, 0);
  for (const type of ['pointerdown', 'pointerup', 'click']) target.emit(type);
  assert.equal(closes, 1);
});


test('production main panel outside-close follows current640 breakpoint without affecting shared dialogs', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const mobile = source.match(/^const isMobile = .*;$/m)[0];
  const binding = source.match(/    bindOutsideClose\(\{ target: document, panel: inEl\('\.sp-sheet'\), close: closePanel,[\s\S]*?\n    \}\);/)[0];
  const target = new Target(), panel = {}, host = { style: { display: 'block' } }, win = { innerWidth: 1280 };
  let closes = 0, consumed = 0;
  runInNewContext(mobile + '\n' + binding, { document: target, window: win, host, inEl: () => panel,
    _spDialogShadow: null, bindOutsideClose: layout.bindOutsideClose,
    closePanel() { closes++; host.style.display = 'none'; } });
  const click = () => { target.emit('pointerdown'); target.emit('pointerup'); target.emit('click', { preventDefault() { consumed++; } }); };
  for (const width of [1280, 641]) { win.innerWidth = width; click(); assert.equal(closes, 0); assert.equal(consumed, 0); }
  win.innerWidth = 390; target.emit('pointerdown');
  win.innerWidth = 641; target.emit('pointerup'); target.emit('click');
  assert.equal(closes, 0, 'mobile-down then desktop-click stays open');
  target.emit('pointerdown'); win.innerWidth = 390; target.emit('pointerup'); target.emit('click');
  assert.equal(closes, 0, 'desktop-down does not become a mobile close');
  for (const width of [640, 390]) { host.style.display = 'block'; win.innerWidth = width; click(); }
  assert.equal(closes, 2); assert.equal(consumed, 2);
});

test('dialog viewport sizing compensates transformed roots and document scroll independently of the main panel', () => {
  assert.equal(typeof layout.syncDialogViewport, 'function');
  for (const origin of [{ left: 0, top: 0 }, { left: -90, top: -700 }]) {
    const host = { style: {}, getBoundingClientRect() {
      return { left: origin.left + parseFloat(this.style.left), top: origin.top + parseFloat(this.style.top) };
    } };
    const win = { innerWidth: 820, innerHeight: 1180 };
    layout.syncDialogViewport(host, win);
    assert.equal(host.style.width, '820px');
    assert.equal(host.style.height, '1180px');
    assert.deepEqual(host.getBoundingClientRect(), { left: 0, top: 0 });
    win.visualViewport = { offsetLeft: 220, offsetTop: 140, width: 410, height: 350 };
    layout.syncDialogViewport(host, win);
    assert.equal(host.style.width, '410px');
    assert.equal(host.style.height, '350px');
    assert.deepEqual(host.getBoundingClientRect(), { left: 220, top: 140 });
  }
});


test('production viewport sync updates an independent dialog while the main panel is hidden', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function syncPanelViewport() {');
  const end = source.indexOf('// ─── Toast (top)', start);
  const host = { style: {}, getBoundingClientRect: () => rect(0, -400, 820, 0) };
  const root = { style: { display: 'none' } };
  const context = { document: { getElementById: id => id === 'dialog' ? host : root },
    DIALOG_HOST_ID: 'dialog', MODAL_ID: 'panel', inEl: () => null,
    syncDialogViewport: node => layout.syncDialogViewport(node, { innerWidth: 820, innerHeight: 1180 }) };
  runInNewContext(source.slice(start, end), context);
  context.syncPanelViewport();
  assert.equal(host.style.width, '820px');
  assert.equal(host.style.height, '1180px');
  assert.equal(host.style.top, '400px');
});


test('foreign standard dialogs and popup semantics retain clicks while fixed-body blank still dismisses', () => {
  const target = new Target(), panel = { contains: () => false };
  let closes = 0, blocked = 0;
  layout.bindOutsideClose({ target, panel, close: () => closes++ });
  const click = path => {
    for (const type of ['pointerdown', 'pointerup', 'click']) target.emit(type, { composedPath: () => path,
      preventDefault: () => blocked++, stopImmediatePropagation: () => blocked++ });
  };
  for (const selector of ['button', 'input', 'textarea', 'a[href]', 'label', 'summary', '[role~="button"]', '[tabindex]:not([tabindex="-1"])', 'dialog', 'select', 'input[list]', '[role~="dialog"]', '[role~="alertdialog"]', '[role~="menu"]', '[role~="listbox"]', '[role~="combobox"]', '[aria-haspopup]', '[popover]']) {
    const popup = selector === '[popover]' ? { popover: 'auto', matches: value => value === ':popover-open' }
      : selector === '[aria-haspopup]' ? { getAttribute: name => name === 'aria-haspopup' ? 'menu' : null }
        : { matches: selectors => selectors.split(',').map(value => value.trim()).includes(selector === 'input[list]' ? 'input' : selector) };
    click([{}, popup, target]);
    assert.equal(closes, 0, selector); assert.equal(blocked, 0, selector);
  }
  const fixedBody = { matches: () => false, style: { position: 'fixed' } };
  click([panel, fixedBody, target]); assert.equal(closes, 0, 'own panel remains internal');
  click([fixedBody, target]); assert.equal(closes, 1, 'ordinary fixed ancestors are not foreign popups');
});
