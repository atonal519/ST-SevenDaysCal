import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatAnchorRepository, normalizeChatAnchor } from './chat-date-anchor.js';

function repository() {
    let saved = null;
    const repo = createChatAnchorRepository({ chatId: 'zero-year', read: () => saved, write: value => { saved = value; return true; } });
    return { repo, saved: () => saved };
}

test('chat anchor set and get preserve numeric and string zero years', () => {
    for (const year of [0, '0', '0000', ' 0 ', 1, '2026']) {
        const h = repository();
        const set = h.repo.set(2, 29, 'detected', { year, eraLabel: '天历' });
        assert.equal(set.ok, true);
        assert.equal(set.anchor.year, Number(year));
        assert.equal(h.saved().anchor.year, Number(year));
        assert.equal(h.repo.get().year, Number(year));
        assert.equal(h.repo.get().eraLabel, '天历');
    }
});

test('unknown and invalid anchor years stay omitted in both normalization and writes', () => {
    for (const year of [null, undefined, '', ' ', '\t\n', false, true, -1, '-1', 10000, NaN, Infinity, {}, []]) {
        const normalized = normalizeChatAnchor({ schemaVersion: 1, chatId: 'zero-year', month: 1, day: 1, year }, 'zero-year');
        assert.equal(Object.hasOwn(normalized, 'year'), false, String(year));
        const h = repository();
        h.repo.set(1, 1, 'explicit', { year });
        assert.equal(Object.hasOwn(h.saved().anchor, 'year'), false, String(year));
        assert.equal(Object.hasOwn(h.repo.get(), 'year'), false, String(year));
    }
});
