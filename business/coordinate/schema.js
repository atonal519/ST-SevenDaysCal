export const INDEX_NAME = 'sp-anchor-index.json';
export const FILE_PREFIX = 'sp-anchor-';
export const SIZE_WARN_BYTES = 8 * 1024 * 1024;
export const SCHEMA_VERSION = 1;

export function emptyIndex() { return { version: SCHEMA_VERSION, items: [], tags: [] }; }

export function normalizeIndex(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return null;
    return {
        ...value,
        version: Number(value.version) || SCHEMA_VERSION,
        items: value.items.filter(item => item && typeof item === 'object').map(normalizeMeta),
        tags: Array.isArray(value.tags) ? value.tags.filter(tag => tag && tag.id).map(tag => ({
            id: String(tag.id), name: String(tag.name || ''), color: String(tag.color || ''),
        })) : [],
    };
}

export function normalizeMeta(item) {
    return {
        id: String(item.id || ''),
        chatId: item.chatId ?? null,
        chatIdHash: item.chatIdHash ?? null,
        chatName: String(item.chatName || ''),
        charName: String(item.charName || ''),
        messageId: item.messageId ?? null,
        floorIndex: item.floorIndex ?? null,
        textPreview: String(item.textPreview || ''),
        ts: Number(item.ts) || 0,
        bytes: Number(item.bytes) || 0,
        tags: Array.isArray(item.tags) ? [...item.tags] : [],
    };
}

export function itemBytes(item) {
    let bytes = 0;
    for (const [key, value] of Object.entries(item || {})) bytes += (key.length + String(value == null ? '' : value).length) * 2;
    return bytes;
}

export function toMeta(item) {
    // 索引只保存轻量白名单；正文 html 永远只存在单条快照文件中。
    return normalizeMeta({
        id: item?.id,
        chatId: item?.chatId,
        chatIdHash: item?.chatIdHash,
        chatName: item?.chatName,
        charName: item?.charName,
        messageId: item?.messageId,
        floorIndex: item?.floorIndex,
        textPreview: item?.textPreview,
        ts: item?.ts,
        bytes: itemBytes(item),
        tags: item?.tags,
    });
}

export function fileNameOf(id) { return `${FILE_PREFIX}${String(id).replace(/[^a-zA-Z0-9_.-]/g, '')}.json`; }
export function pathOf(name) { return `user/files/${name}`; }

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
