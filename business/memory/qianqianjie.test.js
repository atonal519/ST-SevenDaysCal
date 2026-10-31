import test from 'node:test';
import assert from 'node:assert/strict';
import { createQianQianJieMemoryAccess, QIANQIANJIE_BRIDGE_KEY, qianQianJieMemoryDiagnostic } from './qianqianjie.js';

const identity = () => ({ hostChatId: 'chat-a', characterLocator: 'character-a.png', personaLocator: 'persona-a.png' });
const material = (overrides = {}) => ({ status: 'ready', identity: identity(), routerText: '旧剧情：我们在灯塔找到钥匙。', actors: [], ...overrides });
const people = () => ({ status: 'ready', identity: identity(), people: { status: 'ready', items: [
    { entityId: 'user-id', displayName: 'User', specialRole: 'user', aliases: ['旧称'] },
    { entityId: 'char-id', displayName: '李明', specialRole: 'char', aliases: ['阿明'] },
    { entityId: 'npc-id', displayName: '林舟', aliases: ['小舟'] },
    { entityId: 'ambiguous-a', displayName: '周末', aliases: ['老周'] },
    { entityId: 'ambiguous-b', displayName: '周末', aliases: ['老周'] },
    { entityId: 'short-name', displayName: '明', aliases: [] },
    { entityId: 'latin-name', displayName: 'Ann', aliases: [] },
] } });
function harness({ value = material(), read, peopleValue = people(), peopleRead, snapshot = { status: 'ready', identity: identity(), memory: { status: 'ready', floors: [] } }, bridge = {} } = {}) {
    const context = { chatId: 'chat-a', characterId: 0, characters: [{ avatar: 'character-a.png' }], userAvatar: 'persona-a.png' };
    const participant = { userName: 'User', charName: '李明', boundaryEpoch: 1 };
    const calls = { people: 0, context: [], snapshot: 0, forbidden: 0 }, forbidden = () => { calls.forbidden++; throw new Error('forbidden legacy/cache/prepare read'); };
    let selected = true, epoch = 0;
    const api = {
        schemaVersion: 1, kind: 'qqj-public-memory-bridge',
        getStatus: () => ({ status: 'ready', identity: identity() }),
        getPeopleSnapshot: () => { calls.people++; return peopleRead ? peopleRead() : peopleValue; },
        readContext: options => { calls.context.push(options); return read ? read(options) : value; },
        getSnapshot: () => { calls.snapshot++; return snapshot; },
        getPromptSnapshot: forbidden, readMemory: forbidden, prepare: forbidden,
        ...bridge,
    };
    const globalRef = { [QIANQIANJIE_BRIDGE_KEY]: api };
    const access = createQianQianJieMemoryAccess({ globalRef, contextProvider: () => context, participantIdentityProvider: () => participant, sourceEpochProvider: () => epoch,
        isSelected: () => selected, readCache: forbidden, writeCache: forbidden });
    return { access, api, calls, context, participant, globalRef, deselect: () => { selected = false; }, changeEpoch: () => { epoch++; } };
}
async function contextStarted(h) { for (let i = 0; !h.calls.context.length && i < 8; i++) await Promise.resolve(); assert.equal(h.calls.context.length, 1); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('status is a read-only readiness check and old history works without a recent prepared recall', async () => {
    const h = harness();
    assert.equal(h.access.status().status, 'ready'); assert.equal(h.calls.people, 0); assert.equal(h.calls.context.length, 0);
    const result = await h.access.result({ query: '以前在灯塔发生了什么？' });
    assert.equal(result.status, 'ready'); assert.match(result.text, /灯塔找到钥匙/);
    assert.equal(result.reader, h.api); assert.equal(h.access.reader(), h.api); assert.equal(result.cached, false); assert.ok(Object.isFrozen(result));
    assert.equal(h.calls.people, 1); assert.equal(h.calls.context.length, 1); assert.equal(h.calls.forbidden, 0);
});

test('different questions are sent to readContext, with stable user/char and unique explicitly named NPCs', async () => {
    const h = harness({ read: ({ query }) => material({ routerText: query.includes('灯塔') ? '灯塔钥匙往事' : '山路寻药往事' }) });
    const first = await h.access.result({ query: '小舟在灯塔做过什么？老周呢？李明呢？Anniversary', recentText: '无关近况' });
    assert.deepEqual(h.calls.context[0].entityIds, ['user-id', 'char-id', 'npc-id']);
    assert.match(first.text, /灯塔钥匙往事/); assert.doesNotMatch(first.text, /山路寻药往事/);
    const second = await h.access.result({ query: '山路和Ann的事情', recentText: '林舟提到药材' });
    assert.deepEqual(h.calls.context[1].entityIds, ['user-id', 'char-id', 'latin-name', 'npc-id']);
    assert.match(second.text, /山路寻药往事/); assert.equal(h.calls.forbidden, 0);
});

test('actors stay in their own named sections and router background never becomes everybody’s knowledge', async () => {
    const h = harness({ value: material({ routerText: '作者知道的秘密', actors: [
        { entityId: 'user-id', profileText: '用户档案', stateText: '用户私密状态', memoryText: '用户本人经历' },
        { entityId: 'char-id', profileText: '角色档案', stateText: '角色私密状态', memoryText: '角色本人经历' },
        { entityId: 'not-requested', memoryText: '未请求人物资料' },
    ] }) });
    const result = await h.access.result({ query: '往事' });
    assert.match(result.text, /作者侧.*不代表人物均已知/);
    assert.match(result.text, /User[\s\S]*用户档案[\s\S]*用户私密状态[\s\S]*用户本人经历/);
    assert.match(result.text, /李明[\s\S]*角色档案[\s\S]*角色私密状态[\s\S]*角色本人经历/);
    assert.doesNotMatch(result.text, /未请求人物资料/);
});

test('an empty people projection does not block topic-based author history or select all people', async () => {
    const h = harness({ peopleValue: { status: 'ready', identity: identity(), people: { status: 'not-ready', items: [] } } });
    assert.equal((await h.access.result({ query: '灯塔' })).status, 'ready');
    assert.deepEqual(h.calls.context[0].entityIds, []);
});

test('query plus sanitized recent text stays within 8000, keeping the current question ahead of long templates', async () => {
    const h = harness(); const question = '最后的真正问题：我们第一次去灯塔是什么时候？';
    await h.access.result({ query: '旧模板'.repeat(4000) + question, recentText: '近况'.repeat(5000) });
    assert.ok(h.calls.context[0].query.length <= 8000); assert.ok(h.calls.context[0].query.includes(question));
    await h.access.result({ query: question, recentText: '过长旧正文'.repeat(2000) + '最新净正文' });
    assert.ok(h.calls.context[1].query.startsWith(question)); assert.ok(h.calls.context[1].query.endsWith('最新净正文')); assert.ok(h.calls.context[1].query.length <= 8000);
});

test('formatted headings and actor sections obey the full character budget', async () => {
    for (const maxCharacters of [0, 1, 100, 333, 12000]) {
        const h = harness({ value: material({ routerText: '旧剧情'.repeat(10000), actors: [{ entityId: 'user-id', profileText: '档案'.repeat(10000), stateText: '状态'.repeat(10000), memoryText: '经历'.repeat(10000) }] }) });
        const result = await h.access.result({ query: '剧情', maxCharacters });
        assert.ok(result.text.length <= maxCharacters, `${result.text.length} > ${maxCharacters}`);
        assert.equal(h.calls.context[0].maxCharacters, maxCharacters);
    }
    const h = harness(); await h.access.result(); assert.equal(h.calls.context[0].maxCharacters, 12000);
});

test('empty material is empty, and non-string material is not coerced or replaced by legacy cache', async () => {
    const noCoercion = { toString() { throw new Error('must not coerce'); } };
    for (const value of [material({ routerText: '', actors: [] }), material({ routerText: noCoercion, actors: [{ entityId: 'user-id', profileText: ['invalid'], stateText: 1, memoryText: false }], text: 'not a public section' })]) {
        const h = harness({ value }); assert.equal((await h.access.result()).status, 'empty'); assert.equal(h.calls.forbidden, 0);
    }
});

test('the direct interface is required even if the prepared prompt interface still exists', async () => {
    const h = harness({ bridge: { readContext: undefined } });
    assert.equal(h.access.status().status, 'api-unavailable'); assert.equal((await h.access.result()).status, 'api-unavailable'); assert.equal(h.calls.forbidden, 0);
});

test('disabled, not-ready, empty, unavailable and error responses keep their real status', async () => {
    for (const status of ['disabled', 'not-ready', 'empty', 'unavailable', 'error']) {
        const h = harness({ value: material({ status, message: '当前不可用' }) });
        const result = await h.access.result(); assert.equal(result.status, status); assert.equal(result.text, ''); assert.equal(h.calls.forbidden, 0);
    }
    const h = harness({ peopleValue: { status: 'not-ready', identity: identity(), people: { items: [] } } });
    assert.equal((await h.access.result()).status, 'not-ready'); assert.equal(h.calls.context.length, 0);
});

test('source identity is checked on both people and context returns', async () => {
    for (const field of ['hostChatId', 'characterLocator', 'personaLocator']) for (const port of ['people', 'context']) {
        const wrong = { ...identity(), [field]: 'different-owner' };
        const h = harness(port === 'people' ? { peopleValue: { ...people(), identity: wrong } } : { value: material({ identity: wrong }) });
        const result = await h.access.result(); assert.equal(result.status, 'stale', `${port}/${field}`); assert.equal(result.text, '');
        if (port === 'people') assert.equal(h.calls.context.length, 0);
    }
});

test('pending context is discarded after chat, character, persona, participant, source epoch, source or bridge changes', async () => {
    const changes = [h => { h.context.chatId = 'chat-b'; }, h => { h.context.characters[0].avatar = 'b.png'; }, h => { h.context.userAvatar = 'b.png'; },
        h => { h.participant.userName = 'another'; }, h => { h.participant.boundaryEpoch++; }, h => h.changeEpoch(), h => h.deselect(), h => { h.globalRef[QIANQIANJIE_BRIDGE_KEY] = { ...h.api }; }];
    for (const change of changes) {
        const pending = deferred(), h = harness({ read: () => pending.promise }); const task = h.access.result(); await contextStarted(h);
        change(h); pending.resolve(material()); const result = await task; assert.equal(result.status, 'stale'); assert.equal(result.text, '');
    }
});

test('deselected or cancelled reads do not start, and cancellation while loading people does not call readContext', async () => {
    const h = harness(); h.deselect(); assert.equal((await h.access.result()).status, 'stale'); assert.equal(h.calls.people, 0);
    const cancelled = harness(), controller = new AbortController(); controller.abort();
    assert.equal((await cancelled.access.result({ signal: controller.signal })).status, 'cancelled'); assert.equal(cancelled.calls.people, 0);
    const peoplePending = deferred(), pending = harness({ peopleRead: () => peoplePending.promise }), active = new AbortController();
    const task = pending.access.result({ signal: active.signal }); active.abort(); assert.equal((await task).status, 'cancelled');
    peoplePending.resolve(people()); await Promise.resolve(); assert.equal(pending.calls.context.length, 0);
});

test('in-flight cancellation and timeout return their own status without cache fallback', async () => {
    const pending = deferred(), h = harness({ read: () => pending.promise }), controller = new AbortController();
    const task = h.access.result({ signal: controller.signal }); await contextStarted(h); controller.abort();
    assert.equal((await task).status, 'cancelled'); pending.resolve(material()); assert.equal(h.calls.forbidden, 0);
    const timed = harness({ read: () => new Promise(() => {}) }); assert.equal((await timed.access.result({ timeoutMs: 5 })).status, 'timed-out'); assert.equal(timed.calls.forbidden, 0);
    const peoplePending = deferred(), latePeople = harness({ peopleRead: () => peoplePending.promise });
    assert.equal((await latePeople.access.result({ timeoutMs: 5 })).status, 'timed-out');
    peoplePending.resolve(people()); await Promise.resolve(); await Promise.resolve();
    assert.equal(latePeople.calls.context.length, 0, 'a timed-out people read must not dispatch a later context read');
});

test('synchronous and asynchronous failures are diagnostic errors with one prefix', async () => {
    for (const read of [() => { throw Error('context-read-failed'); }, () => Promise.reject(Error('context-read-failed'))]) {
        const h = harness({ read }), result = await h.access.result();
        assert.equal(result.status, 'read-failed'); assert.equal(result.text, ''); assert.equal(qianQianJieMemoryDiagnostic(result), '千千结记忆读取失败：context-read-failed'); assert.equal(h.calls.forbidden, 0);
    }
    assert.equal(qianQianJieMemoryDiagnostic({ status: 'error', message: 'raw-failure' }), '千千结记忆读取失败：raw-failure');
});

test('maxFloor reads only public located summaries at or before cutoff, excluding future CSE and profiles', async () => {
    const snapshot = { status: 'ready', identity: identity(), memory: { status: 'ready', floors: [
        { floorId: 'old', messageIndex: 1, assistantSeq: 1, summary: '过去灯塔的钥匙', summarySource: 'user' },
        { floorId: 'cutoff', messageIndex: 5, assistantSeq: 3, summary: '截止楼的伤势', summarySource: 'ai' },
        { floorId: 'future', messageIndex: 7, assistantSeq: 4, summary: '未来新伤已痊愈', summarySource: 'ai' },
        { floorId: 'unknown', assistantSeq: 1, summary: '无法定位的摘要' },
    ] } };
    for (const field of ['cse', 'people']) Object.defineProperty(snapshot, field, { get() { throw Error('future partition must not be read'); } });
    const h = harness({ snapshot }), result = await h.access.result({ query: '伤势', maxFloor: 5 });
    assert.equal(result.status, 'ready'); assert.match(result.text, /过去灯塔的钥匙|截止楼的伤势/); assert.match(result.text, /人工摘要/);
    assert.doesNotMatch(result.text, /未来新伤|无法定位|用户档案|角色档案/); assert.equal(h.calls.snapshot, 1); assert.equal(h.calls.people, 0); assert.equal(h.calls.context.length, 0);
    assert.ok(result.text.length <= 12000); assert.equal(h.calls.forbidden, 0);
});

test('maxFloor handles no eligible history, unavailable snapshots and unready memory without falling back to current context', async () => {
    const empty = harness(); assert.equal((await empty.access.result({ maxFloor: -1 })).status, 'empty');
    const unsupported = harness({ bridge: { getSnapshot: undefined } }); assert.equal((await unsupported.access.result({ maxFloor: 5 })).status, 'api-unavailable');
    const unready = harness({ snapshot: { status: 'ready', identity: identity(), memory: { status: 'not-ready', floors: [] } } }); assert.equal((await unready.access.result({ maxFloor: 5 })).status, 'not-ready');
    for (const h of [empty, unsupported, unready]) { assert.equal(h.calls.context.length, 0); assert.equal(h.calls.forbidden, 0); }
});
