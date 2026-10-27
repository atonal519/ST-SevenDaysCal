import { legacyPointerBelongsToReply } from './reply-identity.js';
// Temporary upgrade reader for chats created by the retired storage provider.
// Normal business storage never reads this endpoint or writes back to it.
const ROOTS = ['sp-store', 'sp-memory', 'sp-theater', 'sp-ledger'];
const SNAPSHOT = 'gouhua_snapshot';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const hasLegacyMarker = metadata => Object.hasOwn(metadata || {}, 'sp-storage');
export function buildLegacyChatReturn({ metadata, messages, records }) {
    const marker = metadata?.['sp-storage'];
    if (marker?.provider !== 'st-bainiaodata' || marker.schemaVersion !== 1 || !marker.collection) throw new Error('旧构画存储标记无法读取，请核对原存档');
    if (!Array.isArray(records)) throw new Error('白鳥返回的数据无法读取，请重试迁回');
    const byId = new Map(records.map(record => [record.recordId, record.data]));
    const current = byId.get(marker.currentRecord || 'current');
    if (current?.schemaVersion !== 1 || !current.roots || typeof current.roots !== 'object') throw new Error('未找到当前构画数据，请保持白鳥可用后重试');
    const diagnostics = byId.get(marker.diagnosticsRecord || 'diagnostics');
    const nextMetadata = { ...metadata };
    for (const key of ROOTS) { delete nextMetadata[key]; if (current.roots[key] != null) nextMetadata[key] = clone(current.roots[key]); }
    nextMetadata['sp-store'] ||= { version: 1, data: {} };
    nextMetadata['sp-store'].data ||= {};
    if (Array.isArray(diagnostics?.floors)) nextMetadata['sp-store'].data['diagnostics-v1'] = clone(diagnostics);
    else nextMetadata['sp-store'].data['diagnostics-v1'] ??= { schemaVersion: 1, floors: [] };
    delete nextMetadata['sp-storage'];
    const nextMessages = clone(messages || []);
    let snapshotSlots = 0;
    const expand = (extra, swipeId, message) => {
        const pointer = extra?.[SNAPSHOT]; if (pointer?.external !== true) return;
        const record = byId.get(pointer.recordId);
        if (!legacyPointerBelongsToReply(pointer, message, swipeId) || !record?.snapshot || typeof record.snapshot !== 'object' || !pointer.replyId || record.replyId !== pointer.replyId || Number(record.swipeId) !== Number(pointer.swipeId) || Number(pointer.swipeId) !== swipeId) throw new Error('历史快照缺失或归属不一致，请检查白鳥数据后重试');
        extra[SNAPSHOT] = clone(record.snapshot); snapshotSlots++;
    };
    for (const message of nextMessages) {
        if (!message) continue;
        expand(message.extra, Number(message.swipe_id) || 0, message);
        for (let i = 0; i < (message.swipe_info?.length || 0); i++) expand(message.swipe_info[i]?.extra, i, message);
    }
    return { metadata: nextMetadata, messages: nextMessages, snapshotSlots };
}
export async function readLegacyChatReturn({ context, fetchImpl = (...args) => globalThis.fetch(...args) }) {
    if (!hasLegacyMarker(context?.chatMetadata)) return null;
    const marker = context.chatMetadata['sp-storage'];
    if (marker?.provider !== 'st-bainiaodata' || marker.schemaVersion !== 1 || typeof marker.collection !== 'string' || !marker.collection) throw new Error('旧构画存储标记无法读取，请核对原存档');
    let response;
    try { response = await fetchImpl(`/api/plugins/st-bainiaodata/v1/records/st-sevendayscal/${encodeURIComponent(marker.collection)}`, { method: 'GET', cache: 'no-store', headers: context.getRequestHeaders?.() || {} }); }
    catch { throw new Error('旧构画数据读取失败，请保持白鳥可用后重试迁回'); }
    if (!response.ok) throw new Error('旧构画数据读取失败，请保持白鳥可用后重试迁回');
    let records;
    try { records = await response.json(); } catch { throw new Error('白鳥返回的数据无法读取，请重试迁回'); }
    return buildLegacyChatReturn({ metadata: context.chatMetadata, messages: context.chat, records });
}
// Preserve host-owned object identities; the host captures the complete chat synchronously when saveChat is invoked.
export function applyLegacyChatReturn(context, plan) {
    for (const key of [...ROOTS, 'sp-storage']) delete context.chatMetadata[key];
    for (const key of ROOTS) if (Object.hasOwn(plan.metadata, key)) context.chatMetadata[key] = plan.metadata[key];
    for (let i = 0; i < plan.messages.length; i++) {
        const from = plan.messages[i], to = context.chat[i]; if (!from || !to) continue;
        if (from.extra?.[SNAPSHOT]) { to.extra ||= {}; to.extra[SNAPSHOT] = from.extra[SNAPSHOT]; }
        for (let n = 0; n < (from.swipe_info?.length || 0); n++) if (from.swipe_info[n]?.extra?.[SNAPSHOT]) {
            to.swipe_info[n].extra ||= {}; to.swipe_info[n].extra[SNAPSHOT] = from.swipe_info[n].extra[SNAPSHOT];
        }
    }
}
