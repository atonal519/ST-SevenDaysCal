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
