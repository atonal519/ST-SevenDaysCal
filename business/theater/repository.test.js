import test from 'node:test';
import assert from 'node:assert/strict';
import { createTheaterRepository } from './repository.js';
import { createTheaterStoryContext } from './context.js';

const piece = id => ({ id, prompt: `scene ${id}`, ts: 1 });

test('theater story context freezes card/recent inputs before launching shared WI and memory readers', async () => {
    const calls = []; const events = [];
    const build = createTheaterStoryContext({
        getContext: () => ({ chatId: 'theater-context', name1: '用户', name2: '角色', characters: [{ description: '角色背景', personality: '角色性格', scenario: '角色场景' }], characterId: 0 }),
        buildWorldInfoContext: async () => { events.push('worldbook-start'); return '世界书'; },
        readCardExtras: () => { events.push('card-read'); return { personaDesc: '人物设定', authorNote: '作者注释' }; },
        buildRecentContext: () => { events.push('recent-read'); return '【最近对话】最近三层'; },
        getRecentMesIds: () => { events.push('recent-ids'); return ['m1', 'm2', 'm3']; },
        getMemText: async options => { events.push('memory-start'); calls.push(options); return '摘要\n【尚未摘要的近期正文】\n近期原文'; },
    });
    const context = await build();
    assert.deepEqual(events, ['card-read', 'recent-read', 'recent-ids', 'worldbook-start', 'memory-start']);
    assert.deepEqual(calls, [{ excludeMesIds: ['m1', 'm2', 'm3'] }]);
    assert.match(context.sysBlocks.join('\n'), /人物设定[\s\S]*角色背景[\s\S]*角色性格[\s\S]*角色场景[\s\S]*作者注释[\s\S]*最近对话[\s\S]*世界书/);
    assert.match(context.sysBlocks.join('\n'), /标注已验证摘要与尚未摘要的近期正文/);
});

test('theater story context does not convert a failed selected memory read into an empty summary', async () => {
    const failure = Object.assign(new Error('selected memory read failed'), { diagnosticCode: 'memory-read' });
    const build = createTheaterStoryContext({
        getContext: () => ({ chatId: 'theater-memory-read', name1: '用户', name2: '角色', characters: [], characterId: 0 }),
        buildWorldInfoContext: async () => '', readCardExtras: () => ({ personaDesc: '', authorNote: '' }),
        buildRecentContext: () => '', getRecentMesIds: () => [], getMemText: async () => { throw failure; },
    });
    await assert.rejects(build(), error => error === failure);
});

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

test('promoting a draft rejects a same-piece edit made after the captured baseline', async () => {
    const metadata = { saved: [], version: 1 };
    const drafts = new Map();
    const storage = { getItem: key => drafts.get(key) ?? null, setItem: (key, value) => drafts.set(key, value) };
    const repository = createTheaterRepository({ metadata: () => metadata, persist: () => {}, keyForChat: id => `draft:${id}`, storage });
    const original = { id: 'same', title: '初稿', raw: '原文', html: '<p>原文</p>' };
    repository.pushDraft('A', original);
    const baseline = repository.draftBaseline('A', 'same');
    repository.updateDraft('A', 'same', { raw: '人工修改' });
    const result = await repository.promoteToSaved({ chatId: 'A', metadata }, original, { draftBaseline: baseline });
    assert.equal(result.conflict, true);
    assert.deepEqual(metadata.saved, []);
    assert.equal(repository.loadDrafts('A')[0].raw, '人工修改');
});

test('promoting a draft allows an unrelated draft edit after the captured baseline', async () => {
    const metadata = { saved: [], version: 1 };
    const drafts = new Map();
    const storage = { getItem: key => drafts.get(key) ?? null, setItem: (key, value) => drafts.set(key, value) };
    const repository = createTheaterRepository({ metadata: () => metadata, persist: () => {}, keyForChat: id => `draft:${id}`, storage });
    const original = { id: 'same', title: '初稿', raw: '原文', html: '<p>原文</p>' };
    repository.pushDraft('A', original);
    repository.pushDraft('A', { id: 'other', raw: '另一条' });
    const baseline = repository.draftBaseline('A', 'same');
    repository.updateDraft('A', 'other', { raw: '另一条的人工修改' });
    const result = await repository.promoteToSaved({ chatId: 'A', metadata }, original, { draftBaseline: baseline });
    assert.equal(result.ok, true);
    assert.equal(metadata.saved[0].id, 'same');
    assert.equal(repository.loadDrafts('A').find(item => item.id === 'other').raw, '另一条的人工修改');
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
