import { createCoordinateRuntime } from './runtime.js';
import { captureMesText, sanitizeSnapshot, makePreview } from './capture.js';
import { SIZE_WARN_BYTES } from './schema.js';

let settings = () => ({});
let repository = null;
let initialized = false;
function repo() { return repository || (repository = createCoordinateRuntime().repository); }

export function initAnchor({ getSettings } = {}) { if (getSettings) settings = getSettings; if (!initialized) { initialized = true; repository = createCoordinateRuntime({ warnBytes: SIZE_WARN_BYTES }).repository; repo().loadIndex().then(() => migrateFromIndexedDB()).catch(() => {}); } }
export const addItem = item => repo().addItem(item);
export const getItem = id => repo().getItem(id);
export const getAllItems = () => repo().getAllItems();
export const deleteItem = id => repo().deleteItem(id);
export const countItems = () => repo().countItems();
export const getTags = () => repo().getTags();
export const addTag = (name, color) => repo().addTag(name, color);
export const renameTag = (id, name) => repo().renameTag(id, name);
export const recolorTag = (id, color) => repo().recolorTag(id, color);
export const setItemTags = (id, tags) => repo().setItemTags(id, tags);
export const findItemIdsByFloor = (chatId, floor) => repo().findItemIdsByFloor(chatId, floor);
export const deleteTag = id => repo().deleteTag?.(id) || Promise.resolve(0);
export const renameChatId = (oldId, newId, newName = '', hash = null) => repo().renameChatId?.(oldId, newId, newName, hash) || Promise.resolve(0);
export const healChatByHash = (...args) => repo().healChatByHash(...args);
export const adoptOrphans = (...args) => repo().adoptOrphans(...args);
export async function listByChat() {
    const items = await getAllItems(); const buckets = new Map();
    for (const item of items) { const key = item.chatIdHash != null ? `h:${item.chatIdHash}` : `c:${item.chatId || '(unknown)'}`; const bucket = buckets.get(key) || { chatId: item.chatId, chatIdHash: item.chatIdHash ?? null, chatName: item.chatName || '(未命名聊天)', charName: item.charName || '', items: [], latestTs: 0 }; bucket.items.push(item); if (item.ts >= bucket.latestTs) { bucket.latestTs = item.ts; bucket.chatId = item.chatId ?? bucket.chatId; bucket.chatName = item.chatName || bucket.chatName; bucket.charName = item.charName || bucket.charName; } buckets.set(key, bucket); }
    return [...buckets.values()].map(bucket => ({ ...bucket, count: bucket.items.length, items: bucket.items.sort((a, b) => (b.floorIndex || 0) - (a.floorIndex || 0) || b.ts - a.ts) })).sort((a, b) => b.latestTs - a.latestTs);
}
export async function saveSnapshot(meta = {}, rawInnerHtml = '') {
    const html = sanitizeSnapshot(rawInnerHtml); const context = globalThis.getContext?.() || {};
    const item = { id: globalThis.crypto?.randomUUID?.() || `a-${Date.now()}-${Math.floor(Math.random() * 100000)}`, chatId: meta.chatId ?? context.chatId ?? null, chatIdHash: meta.chatIdHash ?? context.chatMetadata?.chat_id_hash ?? null, chatName: meta.chatName || '', charName: meta.charName || '', messageId: meta.messageId ?? null, floorIndex: Number.isFinite(+meta.floorIndex) ? +meta.floorIndex : null, html, textPreview: makePreview(html), ts: Date.now(), tags: [] };
    await addItem(item); return item;
}
export const estimateBytes = () => repo().estimateBytes();
export const checkSize = () => repo().checkSize();
export const formatBytes = bytes => repo().formatBytes(bytes);
export { sanitizeSnapshot, makePreview, captureMesText };
export function getCoordinateRepository() { return repo(); }

// 旧版 IndexedDB → 文件仓库：只有每一条都成功落盘后才删除源库，失败可安全重试。
export async function migrateFromIndexedDB({ repository: target = repo(), indexedDBRef = globalThis.indexedDB } = {}) {
    if (!indexedDBRef?.open) return { migrated: 0, skipped: true };
    const db = await new Promise(resolve => {
        let request;
        try { request = indexedDBRef.open('sp-anchor'); } catch { resolve(null); return; }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onupgradeneeded = () => {};
    });
    if (!db) return { migrated: 0, skipped: true };
    let rows = [];
    try {
        if (db.objectStoreNames?.contains?.('items')) rows = await new Promise(resolve => {
            try { const request = db.transaction('items', 'readonly').objectStore('items').getAll(); request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []); request.onerror = () => resolve(null); }
            catch { resolve(null); }
        });
    } finally { db.close?.(); }
    if (!Array.isArray(rows)) return { migrated: 0, failed: true };
    if (!rows.length) { try { indexedDBRef.deleteDatabase?.('sp-anchor'); } catch {} return { migrated: 0 }; }
    let migrated = 0;
    for (const item of rows) {
        if (!item?.id) return { migrated, failed: true, error: new Error('legacy item missing id') };
        try { await target.addItem(item); migrated++; } catch (error) { return { migrated, failed: true, error }; }
    }
    try { indexedDBRef.deleteDatabase?.('sp-anchor'); } catch {}
    return { migrated };
}
