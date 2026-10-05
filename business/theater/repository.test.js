import test from 'node:test';
import assert from 'node:assert/strict';
import { createTheaterRepository } from './repository.js';

const piece = id => ({ id, prompt: `scene ${id}`, ts: 1 });

test('ordinary permanent theater edits apply live and return without waiting for host save', async () => {
    const metadata = { saved: [piece('old')], version: 1 };
    let saves = 0;
    const repository = createTheaterRepository({
        metadata: () => metadata,
        persist: () => { saves++; return new Promise(() => {}); },
        keyForChat: id => `draft:${id}`,
        storage: { getItem: () => '[]', setItem() {} },
    });

    const result = await Promise.race([
        repository.promoteToSaved({ chatId: 'A', metadata, persist: () => { saves++; return new Promise(() => {}); } }, piece('new')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ordinary theater save waited for host promise')), 100)),
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.commitState, 'local-applied');
    assert.deepEqual(metadata.saved.map(item => item.id), ['old', 'new']);
    assert.equal(saves, 1);
});

test('ordinary theater keeps true same-piece baseline conflicts', async () => {
    const metadata = { saved: [piece('kept')], version: 1 };
    let saves = 0;
    const repository = createTheaterRepository({ metadata: () => metadata, persist: () => { saves++; } });
    const result = await repository.deleteSaved({ chatId: 'A', metadata }, 'kept', { baseline: 'stale-baseline' });
    assert.equal(result.conflict, true);
    assert.deepEqual(metadata.saved.map(item => item.id), ['kept']);
    assert.equal(saves, 0);
});

test('ordinary theater does not roll back a live edit when host save throws', async () => {
    const metadata = { saved: [piece('remove')], version: 1 };
    const repository = createTheaterRepository({ metadata: () => metadata, persist: () => { throw new Error('host save failed'); } });
    const result = await repository.deleteSaved({ chatId: 'A', metadata, persist: () => { throw new Error('host save failed'); } }, 'remove');
    assert.equal(result.ok, true);
    assert.equal(result.commitState, 'local-applied');
    assert.deepEqual(metadata.saved, []);
});

test('permanent theater title edit changes only the saved title under its same-piece baseline', async () => {
    const original = { id: 'piece-A', title: 'A', prompt: 'scene', html: '<p>body</p>', templateSource: { uid: 't1' }, ts: 7 };
    const metadata = { saved: [original, piece('other')], version: 1 };
    const repository = createTheaterRepository({ metadata: () => metadata, persist: () => {} });
    const baseline = repository.savedBaseline({ chatId: 'A', metadata }, 'piece-A');
    const result = await repository.updateSavedTitle({ chatId: 'A', metadata }, 'piece-A', 'B', { savedBaseline: baseline });
    assert.equal(result.ok, true);
    assert.equal(metadata.saved[0].title, 'B');
    assert.equal(metadata.saved[0].prompt, original.prompt);
    assert.equal(metadata.saved[0].html, original.html);
    assert.deepEqual(metadata.saved[0].templateSource, original.templateSource);
    assert.equal(metadata.saved[1].id, 'other');
    const conflict = await repository.updateSavedTitle({ chatId: 'A', metadata }, 'piece-A', 'C', { savedBaseline: baseline });
    assert.equal(conflict.conflict, true);
    assert.equal(metadata.saved[0].title, 'B');
});

test('permanent theater title can be edited after its draft has been removed', async () => {
    const metadata = { saved: [piece('only-saved')], version: 1 };
    const repository = createTheaterRepository({ metadata: () => metadata, persist: () => {} });
    const baseline = repository.savedBaseline({ chatId: 'A', metadata }, 'only-saved');
    assert.equal(repository.loadDrafts('A').length, 0);
    assert.equal((await repository.updateSavedTitle({ chatId: 'A', metadata }, 'only-saved', 'Renamed', { savedBaseline: baseline })).ok, true);
    assert.equal(metadata.saved[0].title, 'Renamed');
});

test('external theater persistence still dispatches through its record saver', async () => {
    const metadata = { saved: [], version: 1 };
    const calls = [];
    const metadataSaver = {
        capture: (target, after) => ({ target, after }),
        dispatch: async (captured, options) => { calls.push({ captured, options }); return { ok: true, commitState: 'confirmed' }; },
    };
    const repository = createTheaterRepository({
        metadata: () => metadata,
        metadataSaver,
        requireFixedSaver: true,
    });
    const result = await repository.promoteToSaved({
        chatId: 'A', external: true, metadata, target: { recordId: 'record-A' }, metadataSnapshot: {}, isCurrent: () => true,
    }, piece('external'));
    assert.equal(result.ok, true);
    assert.equal(result.commitState, 'confirmed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].captured.target.recordId, 'record-A');
    assert.equal(calls[0].captured.after['sp-theater'].saved[0].id, 'external');
});
