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
  assert.deepEqual(layout.fitDesktopPanel(rect(0, 0, 1200, 700)), { left: 820, top: 80, width: 360, height: 600 });
  assert.deepEqual(layout.fitDesktopPanel(rect(0, 0, 1200, 500)), { left: 820, top: 10, width: 360, height: 480 });
});

test('main panel no longer observes chat dimensions', () => {
  assert.equal(layout.observeChatBounds, undefined);
});


test('normal mobile sync keeps viewport margins with one safe-area inset and ignores chat size', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function syncPanelViewport() {');
  const end = source.indexOf('// ─── Toast (top)', start);
  for (const width of [390, 320]) {
    const sheet = { style: {} }, root = { style: {} };
    const nodes = { chat: rect(10, 50, width - 20, 700) };
    const win = { innerWidth: width, innerHeight: 844 };
    let safeTop = 0, safeBottom = 0;
    const document = { ...fixture(nodes), getElementById: id => id === 'panel' ? root : fixture(nodes).getElementById(id),
      createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} } };
    const context = { document, window: win, MODAL_ID: 'panel', settingsOpen: false, inEl: () => sheet,
      isMobile: () => true, readPanelViewport: layout.readPanelViewport,
      getComputedStyle: () => ({ top: `${safeTop}px`, bottom: `${safeBottom}px` }) };
    runInNewContext(source.slice(start, end), context);
    context.syncPanelViewport();
    assert.equal(sheet.style.width, `${width - 20}px`);
    assert.equal(sheet.style.height, '764px');
    assert.equal(sheet.style.top, '40px');
    assert.equal(sheet.style.left, `${width / 2}px`);
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
    assert.equal(sheet.style.top, '70px');
    safeTop = 50; safeBottom = 45;
    context.syncPanelViewport();
    assert.equal(sheet.style.height, '305px');
    assert.equal(sheet.style.top, '80px');
  }
});
