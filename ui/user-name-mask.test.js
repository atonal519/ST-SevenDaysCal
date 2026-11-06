import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserNameMask, findUserNameRanges } from './user-name-mask.js';

const matched = (text, names) => findUserNameRanges(text, names).map(({ start, end }) => text.slice(start, end));

test('literal names include one-character Chinese names and prefer the longest overlap', () => {
    assert.deepEqual(findUserNameRanges('林与林林', ['林', '林林']), [{ start: 0, end: 1 }, { start: 2, end: 4 }]);
    assert.deepEqual(matched('小明明和小明', ['明', '小明', '小明明']), ['小明明', '小明']);
});

test('emoji and joined emoji keep complete UTF-16 ranges for DOM text offsets', () => {
    assert.deepEqual(findUserNameRanges('A👩‍🚀B👩', ['👩', '👩‍🚀']), [{ start: 1, end: 6 }, { start: 7, end: 9 }]);
});

test('regular-expression characters are literal, including brackets and backslashes', () => {
    const names = ['A+B', '[x]', '(name)?', '$name\\end'];
    assert.deepEqual(matched(names.join(' / '), names), names);
    assert.deepEqual(matched('AAAB ax name', names), []);
});

test('duplicates and empty names do not create extra ranges or alter the input', () => {
    const names = ['', 'Alice', 'Alice', 'Bob'], text = 'AliceBob Alice';
    assert.deepEqual(findUserNameRanges(text, names), [{ start: 0, end: 5 }, { start: 5, end: 8 }, { start: 9, end: 14 }]);
    assert.deepEqual(names, ['', 'Alice', 'Alice', 'Bob']);
    assert.equal(text, 'AliceBob Alice');
});

test('matching is case-sensitive and may span text fragments of the same inline flow', () => {
    assert.deepEqual(matched('alice Alice ALICE', ['Alice']), ['Alice']);
    assert.deepEqual(findUserNameRanges(['阿', '明', '与阿明'].join(''), ['阿明']), [{ start: 0, end: 2 }, { start: 3, end: 5 }]);
});

test('the controller starts disabled and does not inspect the page until enabled', () => {
    let reads = 0;
    const mask = createUserNameMask({ documentRef: {}, getRoots: () => { reads++; return []; }, getNames: () => { reads++; return ['林']; } });
    mask.refresh(); mask.sync(false); mask.dispose();
    assert.equal(reads, 0);
});

function emptySurfaces() {
    const styles = [], discoveries = [];
    const node = (tagName = 'DIV', children = []) => ({
        nodeType: 1, tagName, childNodes: children, isConnected: true,
        getAttribute: () => null, addEventListener() {}, removeEventListener() {},
        contains(other) { return this === other || this.childNodes.some(child => child === other || child.contains?.(other)); },
        querySelectorAll() { discoveries.push(this); return this.childNodes; },
    });
    const children = Array.from({ length: 8 }, () => node('P'));
    const root = node('SECTION', children);
    for (const child of children) child.parentElement = root;
    const doc = { defaultView: { getComputedStyle(element) { styles.push(element); return { display: 'block' }; } } };
    let names = ['林']; const roots = [root];
    const mask = createUserNameMask({ documentRef: doc, getRoots: () => roots, getNames: () => names });
    return { mask, root, roots, children, styles, discoveries, node, rename: value => { names = value; } };
}

test('same-name sync avoids rediscovery and body scans while renamed users still get full coverage', () => {
    const f = emptySurfaces(); f.mask.sync(true);
    f.styles.length = 0; f.discoveries.length = 0;
    f.mask.sync(true);
    assert.equal(f.styles.length, 0);
    assert.equal(f.discoveries.length, 0);
    f.rename(['新名字']); f.mask.sync(true);
    assert.ok(f.styles.includes(f.root));
    assert.ok(f.children.every(child => f.styles.includes(child)));
    f.styles.length = 0;
    f.rename(['显式刷新时的新名字']); f.mask.refresh(f.children[0]);
    assert.ok(f.styles.includes(f.root));
    assert.ok(f.children.every(child => f.styles.includes(child)));
    f.mask.dispose();
});

test('a text directly inside an owned ShadowRoot can be refreshed without a parentElement', () => {
    const f = emptySurfaces(), shadow = f.node(); shadow.nodeType = 11;
    const text = { nodeType: 3, data: 'ordinary text', parentElement: null, parentNode: shadow, isConnected: true };
    shadow.childNodes.push(text); f.roots.push(shadow); f.mask.sync(true);
    f.discoveries.length = 0;
    assert.doesNotThrow(() => f.mask.refresh(text));
    assert.ok(f.discoveries.includes(shadow));
    f.mask.dispose();
});

test('explicit local refresh leaves unrelated surfaces alone and a new root only scans itself', () => {
    const f = emptySurfaces(); f.mask.sync(true);
    f.styles.length = 0; f.discoveries.length = 0;
    f.mask.refresh(f.children[0]);
    assert.ok(f.styles.includes(f.children[0]));
    assert.ok(f.styles.every(node => node === f.children[0]));
    assert.ok(!f.discoveries.includes(f.root));
    const added = f.node('ASIDE'); f.roots.push(added);
    f.styles.length = 0; f.discoveries.length = 0;
    f.mask.sync(true);
    assert.deepEqual(f.styles, [added]);
    f.mask.dispose();
});
