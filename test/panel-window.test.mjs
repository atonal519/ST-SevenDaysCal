import test from 'node:test';
import assert from 'node:assert/strict';

import * as layout from '../ui/panel-window.js';
const rect = (left, top, width, height) => ({ left, top, width, height });
const fixture = nodes => ({ getElementById: id => nodes[id] && { getBoundingClientRect: () => nodes[id] } });

test('main window uses the visible part of chat including visual viewport offsets', () => {
  assert.equal(typeof layout.readChatBounds, 'function', 'main-window chat geometry is available');
  const doc = fixture({ chat: rect(100, 70, 900, 650), sheld: rect(0, 0, 1200, 900) });
  assert.deepEqual(layout.readChatBounds(doc, { innerWidth: 1200, innerHeight: 900, visualViewport: { offsetLeft: 150, offsetTop: 180, width: 700, height: 420 } }), rect(150, 180, 700, 420));
});

test('missing or hidden chat falls back to sheld above the composer and finally the viewport', () => {
  const doc = fixture({ chat: rect(0, 0, 0, 0), sheld: rect(120, 50, 700, 760), form_sheld: rect(120, 660, 700, 100), send_form: rect(120, 690, 700, 70) });
  assert.deepEqual(layout.readChatBounds(doc, { innerWidth: 1000, innerHeight: 800 }), rect(120, 50, 700, 610));
  assert.deepEqual(layout.readChatBounds(fixture({ chat: rect(0, 1000, 400, 300) }), { innerWidth: 390, innerHeight: 300 }), rect(0, 0, 390, 300));
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

test('desktop fit clamps saved size and position while allowing a short chat area', () => {
  assert.equal(typeof layout.fitDesktopPanel, 'function');
  assert.deepEqual(layout.fitDesktopPanel(rect(200, 100, 500, 600), { width: 700, height: 900 }, { left: -40, top: 500 }), { left: 210, top: 110, width: 480, height: 580 });
  assert.deepEqual(layout.fitDesktopPanel(rect(250, 200, 310, 200)), { left: 260, top: 210, width: 290, height: 180 });
  assert.deepEqual(layout.fitDesktopPanel(rect(100, 80, 1000, 800), { width: 410, height: 620 }, { left: 150, top: 130 }), { left: 150, top: 130, width: 410, height: 620 });
});
