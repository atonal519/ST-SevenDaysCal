import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memorySource = fs.readFileSync(path.join(repo, 'memory.js'), 'utf8');
const start = memorySource.indexOf('export function getMemoryContext(');
const end = memorySource.indexOf('// ─── Fill missing ───', start);
assert.ok(start >= 0 && end > start, 'production getMemoryContext source region exists');
const getMemoryContextSource = memorySource.slice(start, end).replace('export function', 'function');

function makeFloors(count) {
    return Array.from({ length: count }, (_, index) => ({ mesid: String(index + 1), text: `BODY_${index + 1}` }));
}

function makeGroups(floors, size) {
    const groups = [];
    for (let i = 0; i + size <= floors.length; i += size) {
        const chunk = floors.slice(i, i + size);
        groups.push({ key: `${chunk[0].mesid}-${chunk.at(-1).mesid}`, floors: chunk });
    }
    if (groups.length && groups.at(-1).floors.at(-1).mesid === floors.at(-1)?.mesid) groups.pop();
    return groups;
}

function runMemoryContext({ floors, groups = makeGroups(floors, 5), meta = {}, groupSize = 5, memoryEnabled = true }, opts = {}) {
    const context = vm.runInNewContext(`${getMemoryContextSource}\ngetMemoryContext`, {
        _getSettings: () => ({ memoryEnabled, memoryL0Group: groupSize, useBaiBaiBook: false, useAnima: false, useDatabase: false, useQianQianJie: false }),
        meta: () => meta,
        getStableGroups: () => groups,
        getAiFloors: () => floors,
        sourcePolicy: current => current.sourcePolicy || 'current',
        validL1Entries: current => current.validL1 || [],
        validL0: (group, current) => current.validL0Keys?.has(group.key) || false,
    });
    return opts === null ? context() : context({ includeRecentRaw: true, ...opts });
}

function addL0Summary(meta, group, text = `SUMMARY_${group.key}`, valid = true) {
    meta.L0 ||= {};
    meta.L0[group.key] = { range: [group.floors[0].mesid, group.floors.at(-1).mesid], text };
    if (valid) {
        meta.validL0Keys ||= new Set();
        meta.validL0Keys.add(group.key);
    }
}

function tailPart(context) {
    return context.split('━ 尚未摘要的近期正文 ━\n')[1] || '';
}

test('valid L0 sources append only uncovered continuous AI floors after the three-floor request window', () => {
    for (const [count, expected] of [[9, [6]], [10, [6, 7]], [11, [6, 7, 8]]]) {
        const floors = makeFloors(count);
        const groups = makeGroups(floors, 5);
        const meta = { sourcePolicy: 'current', L0: {}, L1: [] };
        addL0Summary(meta, groups[0]);
        const context = runMemoryContext({ floors, groups, meta }, { excludeMesIds: floors.slice(-3).map(floor => floor.mesid) });
        assert.match(context, /SUMMARY_1-5/);
        const tail = tailPart(context);
        for (const id of expected) assert.match(tail, new RegExp(`BODY_${id}(?:\\n|$)`));
        for (const floor of floors.slice(-3)) assert.doesNotMatch(tail, new RegExp(`BODY_${floor.mesid}(?:\\n|$)`));
        for (const id of [1, 2, 3, 4, 5]) assert.doesNotMatch(tail, new RegExp(`BODY_${id}(?:\\n|$)`));
    }
});

test('a verified source does not cap a multi-group raw suffix or truncate its floor text', () => {
    const floors = makeFloors(26);
    floors[5].text = `BODY_6_${'x'.repeat(2501)}`;
    const groups = makeGroups(floors, 5);
    const meta = { sourcePolicy: 'current', L0: {}, L1: [] };
    addL0Summary(meta, groups[0]);
    const tail = tailPart(runMemoryContext({ floors, groups, meta }, { excludeMesIds: ['24', '25', '26'] }));
    for (let id = 6; id <= 23; id++) assert.match(tail, new RegExp(`BODY_${id}(?:_|\\n|$)`));
    assert.ok(tail.includes('x'.repeat(2501)), 'valid-coverage suffix has no per-group or per-floor truncation');
    for (const id of [24, 25, 26]) assert.doesNotMatch(tail, new RegExp(`BODY_${id}(?:_|\\n|$)`));
});

test('valid L1 coverage and empty or failed middle groups do not hide recent raw gaps', () => {
    const floors = makeFloors(21);
    const groups = makeGroups(floors, 5);
    const meta = { sourcePolicy: 'current', L0: {}, L1: [] };
    meta.L1 = [{ range: ['1', '5'], text: 'CHAPTER_1-5', sources: [{ groupKey: groups[0].key }] }];
    meta.validL1 = meta.L1;
    addL0Summary(meta, groups[1], '', true); // hash-valid but empty text is not effective coverage
    addL0Summary(meta, groups[2], 'SUMMARY_11-15');
    const context = runMemoryContext({ floors, groups, meta }, { excludeMesIds: floors.slice(-3).map(floor => floor.mesid) });
    assert.match(context, /CHAPTER_1-5/);
    assert.match(context, /SUMMARY_11-15/);
    const tail = tailPart(context);
    for (const id of [6, 7, 8, 9, 10, 16, 17, 18]) assert.match(tail, new RegExp(`BODY_${id}(?:\\n|$)`));
    for (const id of [...[1, 2, 3, 4, 5], ...[11, 12, 13, 14, 15], 19, 20, 21]) {
        assert.doesNotMatch(tail, new RegExp(`BODY_${id}(?:\\n|$)`));
    }
});

test('without any effective summary, fallback is bounded to six L0 group windows and 2000 characters per floor', () => {
    const floors = makeFloors(40);
    floors[10].text = `BODY_11_${'x'.repeat(2001)}`;
    const groups = makeGroups(floors, 5);
    const context = runMemoryContext({ floors, groups, meta: { sourcePolicy: 'current', L0: {}, L1: {}, validL0Keys: new Set() } }, { excludeMesIds: ['38', '39', '40'] });
    const tail = tailPart(context);
    assert.doesNotMatch(tail, /BODY_10(?:\n|$)/);
    assert.match(tail, /BODY_11_x{1990}/);
    assert.doesNotMatch(tail, /x{2001}/);
    for (const id of [38, 39, 40]) assert.doesNotMatch(tail, new RegExp(`BODY_${id}(?:\\n|$)`));
});

test('legacy L1 without verifiable source IDs keeps its old context and does not invent a covered tail', () => {
    const floors = makeFloors(11);
    const groups = makeGroups(floors, 5);
    const meta = { sourcePolicy: 'legacy-needs-rebuild', L0: {}, L1: [{ range: ['1', '5'], text: 'LEGACY_SUMMARY' }] };
    const context = runMemoryContext({ floors, groups, meta });
    assert.match(context, /LEGACY_SUMMARY/);
    assert.doesNotMatch(context, /尚未摘要的近期正文|BODY_6/);
});

test('disabling automatic summaries does not disable read-only memory context', () => {
    const floors = makeFloors(9);
    const groups = makeGroups(floors, 5);
    const meta = { sourcePolicy: 'current', L0: {}, L1: [] };
    addL0Summary(meta, groups[0]);
    const context = runMemoryContext({ floors, groups, meta, memoryEnabled: false }, { excludeMesIds: ['7', '8', '9'] });
    assert.match(context, /SUMMARY_1-5/);
    assert.match(tailPart(context), /BODY_6/);
});

test('summary-only direct consumers keep their existing context unless raw tail is explicitly requested', () => {
    const floors = makeFloors(9);
    floors[5].text = '时间锚点: 2060-01-02';
    const groups = makeGroups(floors, 5);
    const meta = { sourcePolicy: 'current', L0: {}, L1: [] };
    addL0Summary(meta, groups[0], '时间锚点: summary-date');
    const context = runMemoryContext({ floors, groups, meta }, null);
    const anchors = [...context.matchAll(/时间锚点\s*[:：]\s*([^\n]+)/g)];
    assert.equal(anchors.at(-1)?.[1], 'summary-date');
    assert.doesNotMatch(context, /尚未摘要的近期正文|2060-01-02/);
    const generationContext = runMemoryContext({ floors, groups, meta }, { includeRecentRaw: true, excludeMesIds: ['7', '8', '9'] });
    assert.match(generationContext, /2060-01-02/);
});
