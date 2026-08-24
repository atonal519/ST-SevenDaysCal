import { INDEX_NAME, emptyIndex, normalizeIndex, fileNameOf, toMeta, itemBytes, formatBytes, SIZE_WARN_BYTES } from './schema.js';
import { uploadJson, readJson, deleteJson, createCoordinateHostPorts } from '../../runtime/coordinate-host-ports.js';

function strHash(input) {
    const s = String(input ?? '');
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function createCoordinateRepository({ ports = createCoordinateHostPorts(), warnBytes = SIZE_WARN_BYTES } = {}) {
    let cache = null;
    let readPromise = null;
    let mutation = Promise.resolve();

    const readIndex = async (force = false) => {
        if (cache && !force) return cache;
        if (readPromise && !force) return readPromise;
        readPromise = (async () => {
            const result = await readJson(ports, INDEX_NAME);
            // 只有明确 404 才认为索引不存在；网络错误、5xx、坏 JSON 直接抛出，禁止空索引覆盖旧数据。
            const next = result.missing ? emptyIndex() : normalizeIndex(result.value);
            if (!next) throw new Error(`invalid coordinate index: ${INDEX_NAME}`);
            cache = next;
            return cache;
        })();
        try { return await readPromise; } finally { readPromise = null; }
    };
    const saveIndex = async () => { if (!cache) throw new Error('coordinate index is not loaded'); await uploadJson(ports, INDEX_NAME, cache); };
    const serial = task => { const next = mutation.then(task, task); mutation = next.catch(() => {}); return next; };

    const api = {
        ports,
        loadIndex: readIndex,
        invalidate() { cache = null; },
        async getItem(id) { if (!id) return null; const result = await readJson(ports, fileNameOf(id)); return result.missing ? null : result.value; },
        getAllItems: async () => (await readIndex()).items.map(item => ({ ...item, html: '' })),
        countItems: async () => (await readIndex()).items.length,
        getTags: async () => [...(await readIndex()).tags],
        estimateBytes: async () => (await readIndex()).items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
        formatBytes,
        checkSize: async () => { const bytes = await api.estimateBytes(); return { bytes, over: bytes > (Number(ports.settings()?.anchorSizeWarnBytes) || warnBytes), warnBytes }; },
        addItem: item => serial(async () => {
            await uploadJson(ports, fileNameOf(item.id), item);
            const idx = await readIndex(); const meta = toMeta(item); const i = idx.items.findIndex(x => x.id === meta.id);
            if (i < 0) idx.items.push(meta); else idx.items[i] = meta;
            await saveIndex(); return item;
        }),
        deleteItem: id => serial(async () => {
            if (!id) return;
            const idx = await readIndex(); const removed = idx.items.find(item => item.id === id);
            await deleteJson(ports, fileNameOf(id));
            const before = idx.items.length; idx.items = idx.items.filter(x => x.id !== id);
            if (before !== idx.items.length) await saveIndex();
            return removed ? { ...removed } : null;
        }),
        addTag: (name, color) => serial(async () => {
            const nm = String(name || '').trim(); if (!nm) return null;
            const idx = await readIndex(); const old = idx.tags.find(tag => tag.name === nm); if (old) return old;
            const id = globalThis.crypto?.randomUUID?.() || `t-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
            const tag = { id, name: nm, color: String(color || '') }; idx.tags.push(tag); await saveIndex(); return tag;
        }),
        renameTag: (id, name) => serial(async () => { const idx = await readIndex(); const tag = idx.tags.find(x => x.id === id); const nm = String(name || '').trim(); if (tag && nm && tag.name !== nm) { tag.name = nm; await saveIndex(); } }),
        recolorTag: (id, color) => serial(async () => { const idx = await readIndex(); const tag = idx.tags.find(x => x.id === id); if (tag) { tag.color = String(color || ''); await saveIndex(); } }),
        setItemTags: (id, tags) => serial(async () => { const item = await api.getItem(id); if (!item) return; item.tags = Array.isArray(tags) ? [...tags] : []; await api._addItemUnlocked(item); }),
        findItemIdsByFloor: async (chatId, floor) => (await readIndex()).items.filter(item => String(item.chatId) === String(chatId) && (Number(item.messageId) === Number(floor) || Number(item.floorIndex) === Number(floor))).map(item => item.id),
        listByChat: async () => { const buckets = new Map(); for (const item of await api.getAllItems()) { const key = item.chatIdHash != null ? `h:${item.chatIdHash}` : `c:${item.chatId || '(unknown)'}`; const bucket = buckets.get(key) || { chatId: item.chatId, chatIdHash: item.chatIdHash ?? null, chatName: item.chatName || '(未命名聊天)', charName: item.charName || '', items: [], latestTs: 0 }; bucket.items.push(item); if ((item.ts || 0) >= bucket.latestTs) { bucket.latestTs = item.ts || 0; bucket.chatId = item.chatId ?? bucket.chatId; bucket.chatName = item.chatName || bucket.chatName; bucket.charName = item.charName || bucket.charName; } buckets.set(key, bucket); } return [...buckets.values()].map(bucket => ({ ...bucket, count: bucket.items.length, items: bucket.items.sort((a, b) => (Number(b.floorIndex) || 0) - (Number(a.floorIndex) || 0) || (Number(b.ts) || 0) - (Number(a.ts) || 0)) })).sort((a, b) => b.latestTs - a.latestTs); },
        deleteTag: id => serial(async () => { const idx = await readIndex(); const oldTags = idx.tags.map(tag => ({ ...tag })); const affected = idx.items.filter(item => item.tags?.includes(id)).map(item => ({ meta: item, tags: [...(item.tags || [])] })); const changedItems = []; try { for (const entry of affected) { const item = await api.getItem(entry.meta.id); if (!item) continue; item.tags = (item.tags || []).filter(tag => tag !== id); await uploadJson(ports, fileNameOf(item.id), item); changedItems.push({ id: item.id, item }); } idx.tags = idx.tags.filter(tag => tag.id !== id); for (const entry of affected) entry.meta.tags = entry.tags.filter(tag => tag !== id); await saveIndex(); return affected.length; } catch (error) { idx.tags = oldTags; for (const entry of affected) entry.meta.tags = entry.tags; throw error; } }),
        renameChatId: (oldId, newId, name = '', hash = null) => serial(async () => { const idx = await readIndex(); const hit = idx.items.filter(item => String(item.chatId) === String(oldId)); if (!hit.length) return 0; for (const meta of hit) { meta.chatId = String(newId); meta.chatName = String(name || newId); if (hash != null) meta.chatIdHash = hash; } await saveIndex(); for (const meta of hit) { const item = await api.getItem(meta.id); if (item) { item.chatId = String(newId); item.chatName = String(name || newId); if (hash != null) item.chatIdHash = hash; await api._addItemUnlocked(item); } } return hit.length; }),
        healChatByHash: (currentId, name, hash) => serial(async () => { if (currentId == null || hash == null) return 0; const want = Number(hash); const idx = await readIndex(); const hit = idx.items.filter(item => (item.chatIdHash != null && Number(item.chatIdHash) === want) || (item.chatIdHash == null && strHash(item.chatId) === want) || String(item.chatId) === String(currentId)); let changed = 0; for (const meta of hit) { if (String(meta.chatId) !== String(currentId) || meta.chatName !== String(name || currentId) || Number(meta.chatIdHash) !== want) { meta.chatId = String(currentId); meta.chatName = String(name || currentId); meta.chatIdHash = hash; changed++; } } if (changed) await saveIndex(); for (const meta of hit) { const item = await api.getItem(meta.id); if (item && (String(item.chatId) !== String(currentId) || Number(item.chatIdHash) !== want)) { item.chatId = String(currentId); item.chatName = String(name || currentId); item.chatIdHash = hash; await api._addItemUnlocked(item); } } return changed; }),
        adoptOrphans: (charName, existingIds, currentId, name, hash = null) => serial(async () => {
            if (!String(charName || '').trim() || !String(currentId || '').trim() || !(existingIds instanceof Set || Array.isArray(existingIds))) return 0;
            const allowed = new Set(Array.from(existingIds, value => String(value || '').replace(/\.jsonl$/i, '')).filter(Boolean));
            if (allowed.size !== 1 || !allowed.has(String(currentId).replace(/\.jsonl$/i, ''))) return 0;
            const idx = await readIndex(); const hit = idx.items.filter(item => String(item.charName || '') === String(charName) && !allowed.has(String(item.chatId)));
            for (const meta of hit) { meta.chatId = String(currentId); meta.chatName = String(name || currentId); if (hash != null) meta.chatIdHash = hash; }
            if (hit.length) await saveIndex();
            for (const meta of hit) { const item = await api.getItem(meta.id); if (item) { item.chatId = String(currentId); item.chatName = String(name || currentId); if (hash != null) item.chatIdHash = hash; await api._addItemUnlocked(item); } }
            return hit.length;
        }),
    };
    // Internal form avoids nesting a second queue while a mutation is already running.
    api._addItemUnlocked = async item => { await uploadJson(ports, fileNameOf(item.id), item); const idx = await readIndex(); const meta = toMeta(item); const i = idx.items.findIndex(x => x.id === meta.id); if (i < 0) idx.items.push(meta); else idx.items[i] = meta; await saveIndex(); return item; };
    return api;
}
