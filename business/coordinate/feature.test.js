import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinateFeature } from './feature.js';
import { createCoordinateRepository } from './repository.js';
import { INDEX_NAME, fileNameOf, pathOf } from './schema.js';
import { REPLY_MARKER_KEY, writeReplyMarker } from './identity.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function coordinateHarness({ initialIndex = { version: 1, items: [], tags: [{ id: 'tag-1', name: 'research', color: 'slate' }] }, selectMany = null, failUploadAt = 0 } = {}) {
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
