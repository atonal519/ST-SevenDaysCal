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
