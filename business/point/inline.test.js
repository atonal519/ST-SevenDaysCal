import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

test('schedule strip delegates inside its supplied root and opens the selected historical day', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'inline.js'), 'utf8');
    const start = source.indexOf('    function bindScheduleStripDelegation(');
    const end = source.indexOf('\n    return { buildScheduleBlock', start);
    assert.ok(start >= 0 && end > start);
    const root = {}, document = {}, handlers = new Map(), reads = [];
    let boundTarget;
    const context = { readOnly: true, snap: { point: '历史点' }, resolution: { resolved: true } };
    const bind = runInNewContext(`${source.slice(start, end)}\nbindScheduleStripDelegation`, {
        document,
        buildScheduleDay() {},
        buildPointDetailFromContext(input) { reads.push(input); return '历史当天内容'; },
    });
    const target = {
        off() { handlers.clear(); return this; },
        on(event, selector, handler) { handlers.set(`${event}:${selector}`, handler); return this; },
    };
    const $ = value => { boundTarget = value; return target; };
    bind({ $, target: root, inlineTapContext: () => context });
    bind({ $, target: root, inlineTapContext: () => context });
    assert.equal(boundTarget, root);
    assert.equal(handlers.size, 1);

    const day = { hidden: true, innerHTML: '' }, classes = new Set();
    const wrap = { querySelector: () => day, querySelectorAll: () => [] };
    const cell = {
        dataset: { day: 'future' }, closest: () => wrap,
        classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) },
    };
    let stopped = 0;
    const event = { preventDefault() {}, stopPropagation() { stopped++; } };
    const click = [...handlers.values()][0];
    click.call(cell, event);
    assert.equal(day.hidden, false);
    assert.equal(day.innerHTML, '历史当天内容');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].dayKey, 'future');
    assert.equal(reads[0].context, context);
    click.call(cell, event);
    assert.equal(day.hidden, true);
    assert.equal(day.innerHTML, '');
    assert.equal(reads.length, 1);
    assert.equal(stopped, 2);
});
