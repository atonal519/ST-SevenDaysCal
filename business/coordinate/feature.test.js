import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinateFeature } from './feature.js';
import { createCoordinateRenderer } from './render.js';
import { createCoordinateRepository } from './repository.js';
import { INDEX_NAME, fileNameOf, pathOf } from './schema.js';
import { REPLY_MARKER_KEY, writeReplyMarker } from './identity.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function coordinateHarness({ initialIndex = { version: 1, items: [], tags: [{ id: 'tag-1', name: 'research', color: 'slate' }] }, selectMany = null, failUploadAt = 0, loseUploadResponseAt = 0 } = {}) {
    const events = [];
    const toasts = [];
    const files = new Map([[INDEX_NAME, JSON.stringify(initialIndex)]]);
    const uploads = [];
    const context = {
        chatId: 'chat-1', chatMetadata: { chat_id_hash: 'hash-1' }, name2: '角色',
        chat: [{ mes: '楼层正文', send_date: '2026-10-16T10:00:00Z' }],
    };
    const ports = {
        context: () => context,
        fetch: async (url, init = {}) => {
            const method = init.method || 'GET';
            if (method === 'GET') {
                const name = String(url).split('/').at(-1);
                events.push(`read:${name}`);
                const value = files.get(name);
                return value === undefined
                    ? { ok: false, status: 404 }
                    : { ok: true, status: 200, text: async () => value };
            }
            const body = JSON.parse(init.body);
            if (url === '/api/files/upload') {
                const data = JSON.parse(body.data);
                uploads.push({ name: body.name, data });
                events.push(`upload:${body.name}`);
                if (uploads.length === failUploadAt) return { ok: false, status: 500 };
                files.set(body.name, body.data);
                if (uploads.length === loseUploadResponseAt) throw new Error('upload response lost');
                return { ok: true, status: 200, json: async () => ({ path: pathOf(body.name) }) };
            }
            if (url === '/api/files/delete') {
                events.push(`delete:${body.path}`);
                files.delete(String(body.path).split('/').at(-1));
                return { ok: true, status: 200 };
            }
            throw new Error(`unexpected request ${method} ${url}`);
        },
        headers: () => ({}), encode: value => value, pathOf, settings: () => ({}),
    };
    const repository = createCoordinateRepository({ ports });
    const host = {
        context: () => context,
        capture: () => ({ html: '<p>楼层正文</p>', preview: '楼层正文' }),
        saveChatDebounced: async () => { events.push('saveChatDebounced'); },
        selectMany: selectMany || undefined,
        toast: (...args) => toasts.push(args),
        warn() {},
        document: { querySelectorAll: () => [] },
    };
    const feature = createCoordinateFeature({ repository, host });
    feature.init({ chatId: context.chatId, chatIdHash: context.chatMetadata.chat_id_hash });
    const mes = {
        getAttribute: name => name === 'mesid' ? '0' : name === 'ch_name' ? '角色' : null,
        querySelector: selector => selector === '.mes_text' ? { innerHTML: '<p>楼层正文</p>' } : null,
        querySelectorAll: () => [],
    };
    return { feature, repository, context, events, files, uploads, toasts, mes };
}

test('Space favorites save a complete snapshot under the source chat and reuse a single 间 tag', async () => {
    const h = coordinateHarness({ selectMany: () => assert.fail('Space favorites save in one click') });
    const text = '旧港口的约定\n\n守船人只收一枚铜币。';
    const first = h.feature.saveSpaceNote({ id: 'space-first', text });
    h.context.chatId = 'chat-2';
    h.context.chatMetadata = { chat_id_hash: 'hash-2' };
    const second = h.feature.saveSpaceNote({ id: 'space-second', text: '另一个故事的设定' });
    await Promise.all([first, second]);

    const fresh = createCoordinateRepository({ ports: h.repository.ports });
    const notes = await fresh.getAllItems();
    const tags = (await fresh.getTags()).filter(tag => tag.name === '间');
    assert.equal(tags.length, 1);
    assert.deepEqual(notes.map(note => [note.chatId, note.chatIdHash, note.tags]), [
        ['chat-1', 'hash-1', [tags[0].id]],
        ['chat-2', 'hash-2', [tags[0].id]],
    ]);
    assert.equal((await fresh.getItem('space-first')).text, text);
    assert.deepEqual(await fresh.findItemIdsByFloor('chat-1', 0), []);
    assert.equal(await fresh.adoptOrphans('角色', ['chat-2'], 'chat-2', '另一个故事', 'hash-2'), 0);
    assert.equal((await fresh.getItem('space-first')).chatId, 'chat-1');
    assert.deepEqual(h.uploads.map(upload => upload.name), [fileNameOf('space-first'), INDEX_NAME, fileNameOf('space-second'), INDEX_NAME]);
    assert.ok(!h.events.includes('saveChatDebounced'));
});

test('retrying a Space favorite after an index write failure leaves one item and one tag', async () => {
    const h = coordinateHarness({ failUploadAt: 2 });
    const input = { id: 'space-retry', text: '灯塔下的便签' };
    await assert.rejects(h.feature.saveSpaceNote(input), { detailWritten: true });
    assert.equal(await h.repository.countItems(), 0);
    await h.feature.saveSpaceNote(input);
    assert.equal(await h.repository.countItems(), 1);
    assert.equal((await h.repository.getTags()).filter(tag => tag.name === '间').length, 1);
});

test('notes use the actual chat even when a hash appears late or is shared with a branch', async () => {
    const h = coordinateHarness();
    h.context.chatMetadata = {};
    await h.feature.saveSpaceNote({ id: 'before-hash', text: '第一条' });
    h.context.chatMetadata = { chat_id_hash: 42 };
    await h.feature.saveSpaceNote({ id: 'after-hash', text: '第二条' });
    h.context.chatId = 'branch';
    await h.feature.saveSpaceNote({ id: 'branch-note', text: '分支设定' });
    await h.repository.healChatByHash('branch', '分支', 42);
    const buckets = new Map((await h.repository.listByChat()).map(bucket => [bucket.chatId, bucket.items.map(item => item.id).sort()]));
    assert.equal(buckets.size, 2);
    assert.deepEqual(buckets.get('chat-1'), ['after-hash', 'before-hash']);
    assert.deepEqual(buckets.get('branch'), ['branch-note']);
    assert.equal((await h.repository.getItem('after-hash')).chatId, 'chat-1');
});

test('saving a different note after losing the index response preserves the committed note', async () => {
    const h = coordinateHarness({ loseUploadResponseAt: 4 });
    await h.feature.saveSpaceNote({ id: 'first', text: '第一条' });
    await assert.rejects(h.feature.saveSpaceNote({ id: 'response-lost', text: '第二条' }), { detailWritten: true });
    await h.feature.saveSpaceNote({ id: 'third', text: '第三条' });
    assert.deepEqual((await h.repository.getAllItems()).map(item => item.id), ['first', 'response-lost', 'third']);
});

test('bookmarking the same note again keeps any tags added since the original save', async () => {
    const h = coordinateHarness();
    const input = { id: 'space-tagged', text: '有额外标签的设定' };
    const saved = await h.feature.saveSpaceNote(input);
    const tags = [...saved.tags, 'tag-1'];
    await h.repository.setItemTags(saved.id, tags);
    const writes = h.uploads.length;
    await h.feature.saveSpaceNote(input);
    assert.deepEqual((await h.repository.getItem(saved.id)).tags, tags);
    assert.equal(h.uploads.length, writes);
});

test('the collection shows complete short Space notes and a 300-character preview of longer ones', async () => {
    const h = coordinateHarness();
    await h.feature.onFloorButton(h.mes, {});
    const short = '<em>潮汐</em>\n加上这行';
    const initial = '潮'.repeat(299) + '🪶';
    await h.feature.saveSpaceNote({ id: 'short-note', text: short });
    await h.feature.saveSpaceNote({ id: 'at-limit-note', text: initial });
    await h.feature.saveSpaceNote({ id: 'long-note', text: initial + '\n真正的尾巴' });
    let html = '';
    const renderer = createCoordinateRenderer({ repository: h.repository, setBody: value => { html = value; } });
    await renderer.items('chat-1');
    assert.match(html, /&lt;em&gt;潮汐&lt;\/em&gt;\n加上这行/);
    assert.ok(html.includes(initial));
    assert.doesNotMatch(html, /真正的尾巴/);
    assert.equal((html.match(/展开全文/g) || []).length, 1);
    assert.match(html, /sp-anchor-item-floor">#0</);
    assert.match(html, /sp-anchor-tagchip[^>]*>间</);
    assert.equal((await h.repository.getItem('long-note')).text, initial + '\n真正的尾巴');
});

test('Space note previews use the reply formatter for old notes and preserve plain user messages', async () => {
    const h = coordinateHarness();
    const text = '**方案 A**\n\n---';
    await h.feature.saveSpaceNote({ id: 'old-note', text });
    await h.feature.saveSpaceNote({ id: 'user-note', text, role: 'user' });
    let html = '';
    const replies = [];
    const renderer = createCoordinateRenderer({
        repository: h.repository,
        setBody: value => { html = value; },
        formatSpaceReply: value => { replies.push(value); return '<p><strong>方案 A</strong></p><hr>'; },
    });
    await renderer.items('chat-1');
    assert.deepEqual(replies, [text]);
    assert.match(html, /<strong>方案 A<\/strong><\/p><hr>/);
    assert.ok(html.includes(text));
});

test('new floor waits for tag choice and writes selected tags with the first saved item', async () => {
    const selection = deferred();
    const entered = deferred();
    const h = coordinateHarness({
        selectMany: async options => {
            h?.events.push('selectMany');
            entered.resolve(options);
            return selection.promise;
        },
    });
    const operation = h.feature.onFloorButton(h.mes, {});
    const options = await entered.promise;
    try {
        assert.equal(h.uploads.length, 0, 'waiting for a tag choice must precede any detail/index upload');
        assert.equal(options.title, '给这条收藏加标签');
        assert.match(options.body, /跳过.*仍会收藏/);
    } finally {
        selection.resolve({ values: ['tag-1'] });
    }
    await operation;
    const itemUpload = h.uploads.find(upload => upload.name.startsWith('sp-anchor-') && upload.name !== INDEX_NAME);
    assert.deepEqual(itemUpload?.data.tags, ['tag-1']);
    assert.deepEqual(h.uploads.map(upload => upload.name), [itemUpload.name, INDEX_NAME]);
    assert.equal(h.events.filter(event => event.startsWith('upload:')).length, 2);
    assert.equal(h.events.includes('saveChatDebounced'), true);
    assert.equal(h.events.indexOf('selectMany') < h.events.indexOf(`upload:${itemUpload.name}`), true);
    assert.equal(h.toasts.some(([message]) => message === '已收藏此楼'), true);
});

test('skipping the tag dialog still saves a new floor without tags', async () => {
    const h = coordinateHarness({ selectMany: async () => null });
    await h.feature.onFloorButton(h.mes, {});
    const itemUpload = h.uploads.find(upload => upload.name !== INDEX_NAME);
    assert.deepEqual(itemUpload?.data.tags, []);
    assert.deepEqual(h.uploads.map(upload => upload.name), [itemUpload.name, INDEX_NAME]);
    assert.equal(h.toasts.some(([message]) => message === '已收藏此楼'), true);
});

test('when selectMany is unavailable, a new floor saves without tags', async () => {
    const h = coordinateHarness();
    await h.feature.onFloorButton(h.mes, {});
    const itemUpload = h.uploads.find(upload => upload.name !== INDEX_NAME);
    assert.deepEqual(itemUpload?.data.tags, []);
    assert.equal(h.events.includes('selectMany'), false);
    assert.deepEqual(h.uploads.map(upload => upload.name), [itemUpload.name, INDEX_NAME]);
});

test('a custom tag is added before the new item and included in its first detail/index write', async () => {
    const h = coordinateHarness({ selectMany: async () => ({ values: ['__new_tag__'], customValue: 'new idea' }) });
    await h.feature.onFloorButton(h.mes, {});
    assert.deepEqual(h.uploads.map(upload => upload.name), [INDEX_NAME, h.uploads[1].name, INDEX_NAME]);
    assert.equal(h.uploads[0].data.tags.some(tag => tag.name === 'new idea'), true);
    assert.deepEqual(h.uploads[1].data.tags, [h.uploads[0].data.tags.find(tag => tag.name === 'new idea').id]);
    assert.deepEqual(h.uploads[2].data.items[0].tags, h.uploads[1].data.tags);
    assert.equal(h.uploads.length, 3, 'tag index write plus the item detail/index writes; no post-save tag rewrite');
});

test('an index upload failure reports that the item detail was written and does not show success', async () => {
    const h = coordinateHarness({ failUploadAt: 2, selectMany: async () => ({ values: ['tag-1'] }) });
    await h.feature.onFloorButton(h.mes, {});
    assert.equal(h.uploads.length, 2);
    assert.equal(h.files.get(INDEX_NAME), JSON.stringify({ version: 1, items: [], tags: [{ id: 'tag-1', name: 'research', color: 'slate' }] }));
    assert.equal(h.toasts.some(([message, , isError]) => String(message).startsWith('收藏失败：') && isError), true);
    assert.equal(h.toasts.some(([message]) => String(message).includes('收藏详情已写入，但目录更新失败')), true);
    assert.equal(h.toasts.some(([message]) => message === '已收藏此楼'), false);
    assert.equal(h.context.chat[0].extra?.[REPLY_MARKER_KEY], undefined);
});

test('clicking an existing favorite still cancels it without opening the tag dialog', async () => {
    const item = { id: 'saved-1', chatId: 'chat-1', chatIdHash: 'hash-1', messageId: '0', floorIndex: 0, tags: ['tag-1'], html: '<p>楼层正文</p>' };
    const h = coordinateHarness({
        initialIndex: { version: 1, items: [{ ...item, html: undefined }], tags: [{ id: 'tag-1', name: 'research', color: 'slate' }] },
        selectMany: async () => { throw new Error('must not be called for cancellation'); },
    });
    h.files.set(fileNameOf(item.id), JSON.stringify(item));
    writeReplyMarker(h.context.chat[0], item.id);
    await h.feature.refreshSavedKeys();
    h.uploads.length = 0;
    await h.feature.onFloorButton(h.mes, {});
    assert.equal(h.events.includes('selectMany'), false);
    assert.equal(h.files.has(fileNameOf(item.id)), false);
    assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0].name, INDEX_NAME);
    assert.equal(h.context.chat[0].extra?.[REPLY_MARKER_KEY], undefined);
    assert.equal(h.toasts.some(([message]) => message === '已取消收藏'), true);
});
