import test from 'node:test';
import assert from 'node:assert/strict';
import { createQianQianJieMemoryAccess, QIANQIANJIE_BRIDGE_KEY } from './qianqianjie.js';

function promptSnapshot(overrides = {}) {
    return {
        status: 'ready',
        scope: 'latest-prepared',
        identity: { hostChatId: 'chat-a', characterLocator: 'character-a.png', personaLocator: 'persona-a.png' },
        prequel: { text: '前情材料' },
        recall: { text: '召回材料' },
        ...overrides,
    };
}

function harness({ snapshot = promptSnapshot(), read, bridge = {} } = {}) {
    const context = { chatId: 'chat-a', characterId: 0, characters: [{ avatar: 'character-a.png' }], userAvatar: 'persona-a.png' };
    const calls = { prompt: 0, full: 0, structured: 0 };
    const api = {
        schemaVersion: 1,
        kind: 'qqj-public-memory-bridge',
        getPromptSnapshot() { calls.prompt += 1; return read ? read() : snapshot; },
        ...bridge,
    };
    const globalRef = { [QIANQIANJIE_BRIDGE_KEY]: api };
    let selected = true;
    const access = createQianQianJieMemoryAccess({ globalRef, contextProvider: () => context, isSelected: () => selected });
    return { access, api, calls, context, globalRef, deselect: () => { selected = false; } };
}

function addLegacyReaders(fixture) {
    fixture.api.readMemory = () => { fixture.calls.full += 1; return { status: 'ready', text: '禁止使用的全量记忆' }; };
    fixture.api.getSnapshot = () => { fixture.calls.structured += 1; return { status: 'ready', people: {}, cse: {} }; };
    return fixture;
}

function assertNoLegacyReads(fixture) {
    assert.equal(fixture.calls.full, 0);
    assert.equal(fixture.calls.structured, 0);
}

test('qianqianjie reads the prepared prompt without requiring legacy interfaces and preserves the reader', async () => {
    const snapshot = promptSnapshot({ prequel: { text: '  前情第一行\n第二行  ' }, recall: { text: '\n  召回材料 \t' } });
    const fixture = harness({ snapshot });
    assert.equal(fixture.access.status().status, 'ready');
    const result = await fixture.access.result();
    assert.equal(result.status, 'ready');
    assert.equal(result.text, '前情第一行\n第二行\n\n召回材料');
    assert.equal(result.reader, fixture.api);
    assert.equal(fixture.access.reader(), fixture.api);
    assert.equal(fixture.calls.prompt, 1);
    assert.ok(Object.isFrozen(result));
});

test('qianqianjie never reads full text, profiles, CSE history, or full-memory metadata', async () => {
    const touched = [];
    const snapshot = promptSnapshot();
    for (const key of ['text', 'people', 'cse', 'anchor', 'coverage']) {
        Object.defineProperty(snapshot, key, { get() { touched.push(key); throw new Error(`forbidden snapshot field: ${key}`); } });
    }
    const fixture = addLegacyReaders(harness({ snapshot }));
    assert.equal(await fixture.access.text({ full: true }), '前情材料\n\n召回材料');
    assert.deepEqual(touched, []);
    assert.equal(fixture.calls.prompt, 1);
    assertNoLegacyReads(fixture);
});

test('qianqianjie accepts either prepared section independently without adding an empty separator', async () => {
    for (const [prequel, recall, expected] of [
        [{ text: ' 前情 ' }, undefined, '前情'],
        [undefined, { text: ' 召回 ' }, '召回'],
        [{ text: '\t ' }, { text: '召回' }, '召回'],
        [{ text: '前情' }, { text: '\n ' }, '前情'],
    ]) {
        const fixture = addLegacyReaders(harness({ snapshot: promptSnapshot({ prequel, recall }) }));
        const result = await fixture.access.result();
        assert.equal(result.status, 'ready');
        assert.equal(result.text, expected);
        assertNoLegacyReads(fixture);
    }
});

test('qianqianjie normalizes ready snapshots with no string material to empty and never falls back', async () => {
    const noCoercion = { toString() { throw new Error('non-string prompt material must not be coerced'); } };
    for (const [prequel, recall] of [
        [undefined, undefined],
        [{ text: ' \n ' }, { text: '\t' }],
        [{ text: 123 }, { text: false }],
        [{ text: noCoercion }, { text: ['not', 'text'] }],
    ]) {
        const fixture = addLegacyReaders(harness({ snapshot: promptSnapshot({ prequel, recall, text: '禁止使用的顶层文本' }) }));
        const result = await fixture.access.result();
        assert.equal(result.status, 'empty');
        assert.equal(result.text, '');
        assertNoLegacyReads(fixture);
    }
});

test('qianqianjie requires getPromptSnapshot even when full-memory interfaces are available', async () => {
    const fixture = addLegacyReaders(harness({ bridge: { getPromptSnapshot: undefined } }));
    assert.equal(fixture.access.status().status, 'api-unavailable');
    const result = await fixture.access.result();
    assert.equal(result.status, 'api-unavailable');
    assert.equal(result.text, '');
    assertNoLegacyReads(fixture);
});

test('qianqianjie keeps non-ready statuses empty even when material or legacy readers exist', async () => {
    for (const status of ['disabled', 'not-ready', 'empty', 'unavailable', 'error']) {
        const fixture = addLegacyReaders(harness({ snapshot: promptSnapshot({ status, message: '当前不可用' }) }));
        const result = await fixture.access.result();
        assert.equal(result.status, status);
        assert.equal(result.text, '');
        assertNoLegacyReads(fixture);
    }
});

test('qianqianjie preserves host identity checks for returned prompt material', async () => {
    for (const field of ['hostChatId', 'characterLocator', 'personaLocator']) {
        const snapshot = promptSnapshot();
        snapshot.identity[field] = 'different-owner';
        const fixture = harness({ snapshot });
        const result = await fixture.access.result();
        assert.equal(result.status, 'stale', field);
        assert.equal(result.text, '', field);
    }
});

test('qianqianjie discards pending material after chat, character, persona, source, or bridge changes', async () => {
    const changes = [
        fixture => { fixture.context.chatId = 'chat-b'; },
        fixture => { fixture.context.characters[0].avatar = 'character-b.png'; },
        fixture => { fixture.context.userAvatar = 'persona-b.png'; },
        fixture => fixture.deselect(),
        fixture => { fixture.globalRef[QIANQIANJIE_BRIDGE_KEY] = { ...fixture.api }; },
    ];
    for (const change of changes) {
        let resolve;
        const pending = new Promise(done => { resolve = done; });
        const fixture = harness({ read: () => pending });
        const task = fixture.access.result();
        assert.equal(fixture.calls.prompt, 1);
        change(fixture);
        resolve(promptSnapshot());
        const result = await task;
        assert.equal(result.status, 'stale');
        assert.equal(result.text, '');
    }
});

test('qianqianjie does not start reading after the source is deselected or the request is cancelled', async () => {
    const deselected = harness();
    deselected.deselect();
    assert.equal((await deselected.access.result()).status, 'stale');
    assert.equal(deselected.calls.prompt, 0);
    const cancelled = harness();
    const controller = new AbortController();
    controller.abort();
    assert.equal((await cancelled.access.result({ signal: controller.signal })).status, 'cancelled');
    assert.equal(cancelled.calls.prompt, 0);
});

test('qianqianjie cancels an in-flight prompt read without falling back', async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const fixture = addLegacyReaders(harness({ read: () => pending }));
    const controller = new AbortController();
    const task = fixture.access.result({ signal: controller.signal });
    controller.abort();
    const result = await task;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.text, '');
    resolve(promptSnapshot());
    assertNoLegacyReads(fixture);
});

test('qianqianjie times out a stalled prompt read without falling back', async () => {
    const fixture = addLegacyReaders(harness({ read: () => new Promise(() => {}) }));
    const result = await fixture.access.result({ timeoutMs: 5 });
    assert.equal(result.status, 'timed-out');
    assert.equal(result.text, '');
    assertNoLegacyReads(fixture);
});

test('qianqianjie reports synchronous and asynchronous prompt failures without falling back', async () => {
    for (const read of [
        () => { throw new Error('prompt-read-failed'); },
        () => Promise.reject(new Error('prompt-read-failed')),
    ]) {
        const fixture = addLegacyReaders(harness({ read }));
        const result = await fixture.access.result();
        assert.equal(result.status, 'read-failed');
        assert.equal(result.text, '');
        assert.equal(result.message, 'prompt-read-failed');
        assertNoLegacyReads(fixture);
    }
});
