import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const index = fs.readFileSync(new URL('index.js', root), 'utf8');
const css = fs.readFileSync(new URL('style.css', root), 'utf8');

test('axis toolbar production contract has shared wide/narrow action dispatcher', () => {
    for (const selector of ['.sp-alm-add', '.sp-alm-gen', '.sp-alm-supplement', '.sp-alm-manage', '.sp-action-menu-toggle', '.sp-action-menu-item']) assert.match(index, new RegExp(selector.replaceAll('.', '\\.'), 'g'));
    for (const action of ['openAlmanacEditor', 'triggerGenerateAlmanac', 'triggerSupplementAnniversary', 'openCalendarManager']) assert.match(index, new RegExp(`dispatchAlmanacAction[\\s\\S]{0,1200}${action}`));
    assert.match(index, /\.sp-action-menu-list.*\.attr\('hidden', !open\)/);
    assert.match(index, /\.toggleClass\('sp-action-menu-open', open\)/);
    assert.match(index, /aria-expanded.*String\(open\)/);
});

test('axis CSS keeps editor action and time-travel fixes scoped', () => {
    assert.match(css, /\.sp-alm-editor-actions > button[\s\S]*border-radius:\s*8px/);
    assert.match(css, /\.sp-alm-time-travel,\s*\.sp-alm-time-travel-stop\s*\{\s*white-space:\s*nowrap;/);
});
