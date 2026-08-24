import { pathOf } from '../business/coordinate/schema.js';

function headers() { return globalThis.getContext?.()?.getRequestHeaders?.() || { 'Content-Type': 'application/json' }; }
function toBase64(value) {
    const bytes = new TextEncoder().encode(String(value ?? ''));
    let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

export function createCoordinateHostPorts(overrides = {}) {
    const context = overrides.context || (() => globalThis.getContext?.());
    return {
        fetch: overrides.fetch || globalThis.fetch,
        headers: overrides.headers || (() => context?.()?.getRequestHeaders?.() || headers()),
        context,
        pathOf: overrides.pathOf || pathOf,
        encode: overrides.encode || toBase64,
        dom: overrides.dom || (() => globalThis.document),
        settings: overrides.settings || (() => ({})),
        now: overrides.now || (() => Date.now()),
        listCharacterChatIds: overrides.listCharacterChatIds || (() => listCharacterChatIds({ context, fetch: overrides.fetch || globalThis.fetch, headers: overrides.headers || (() => context?.()?.getRequestHeaders?.() || headers()) })),
    };
}

export async function listCharacterChatIds({ context, fetch, headers } = {}) {
    const ctx = context?.();
    const character = ctx?.characters?.[ctx?.characterId];
    if (!ctx || ctx.groupId || !character?.avatar || !ctx.chatId) return null;
    const avatar = character.avatar;
    try {
        const res = await fetch('/api/characters/chats', { method: 'POST', headers: headers?.() || { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar_url: avatar, simple: true }) });
        if (!res?.ok || res.status < 200 || res.status >= 300) return null;
        const payload = await res.json(); const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.chats) ? payload.chats : payload && typeof payload === 'object' ? Object.values(payload) : null;
        if (!Array.isArray(rows) || !rows.length) return null;
        const ids = new Set(rows.filter(row => row && typeof row.file_name === 'string' && row.file_name.trim()).map(row => row.file_name.trim().replace(/\.jsonl$/i, '')));
        return ids.size ? ids : null;
    } catch { return null; }
}

export async function uploadJson(ports, name, value) {
    const res = await ports.fetch('/api/files/upload', { method: 'POST', headers: ports.headers(), body: JSON.stringify({ name, data: ports.encode(JSON.stringify(value)) }) });
    if (!res.ok) throw new Error(`upload ${name}: ${res.status}`);
    return (await res.json()).path;
}
export async function readJson(ports, name) {
    const res = await ports.fetch(ports.pathOf(name), { method: 'GET', cache: 'no-cache', headers: ports.headers() });
    if (res.status === 404) return { missing: true, value: null };
    if (!res.ok) throw new Error(`read ${name}: ${res.status}`);
    const value = JSON.parse(await res.text());
    return { missing: false, value };
}
export async function deleteJson(ports, name) {
    const res = await ports.fetch('/api/files/delete', { method: 'POST', headers: ports.headers(), body: JSON.stringify({ path: ports.pathOf(name) }) });
    if (!res.ok && res.status !== 404) throw new Error(`delete ${name}: ${res.status}`);
}
