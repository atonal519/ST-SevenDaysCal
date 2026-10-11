import { gunzipSync, gzipSync } from '../vendor/fflate-gzip.mjs';

const CODEC = 'stsc-gzip-base64';
const CODEC_VERSION = 1;
const CODED_KEYS = new Set(['dashed-user', 'lines-user', 'qqj-prompt-cache-user', 'diagnostics-v1']);
const decodedValues = new WeakMap();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function isCodecEnvelope(value) {
    // Keep future versions of this wrapper recognizable so ordinary writes cannot nest or replace them as business data.
    const codec = value?.codec;
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && typeof codec === 'string' && codec.startsWith('stsc-')
        && (Object.hasOwn(value, 'payload') || Object.hasOwn(value, 'version'));
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function decodeStoreEntry(key, value) {
    if (!CODED_KEYS.has(String(key)) || !isCodecEnvelope(value)) return value;
    if (value.codec !== CODEC || value.version !== CODEC_VERSION || typeof value.payload !== 'string') {
        throw new Error(`构画存储编码无法识别：${String(key)}`);
    }
    const cached = decodedValues.get(value);
    if (cached !== undefined) return cached;
    let decoded;
    try {
        decoded = JSON.parse(decoder.decode(gunzipSync(base64ToBytes(value.payload))));
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new TypeError('包装内容必须是对象');
        if (String(key) === 'diagnostics-v1' && !Array.isArray(decoded.floors)) throw new TypeError('诊断内容缺少floors数组');
    } catch (cause) {
        throw new Error(`构画存储编码损坏：${String(key)}`, { cause });
    }
    decodedValues.set(value, decoded);
    return decoded;
}

export function encodeStoreEntry(key, value) {
    if (!CODED_KEYS.has(String(key)) || value == null || typeof value !== 'object' || Array.isArray(value) || isCodecEnvelope(value)) return value;
    if (String(key) === 'diagnostics-v1' && !Array.isArray(value.floors)) return value;
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return value;
    const plainBytes = encoder.encode(json);
    const payload = bytesToBase64(gzipSync(plainBytes));
    const envelope = { codec: CODEC, version: CODEC_VERSION, payload };
    if (encoder.encode(JSON.stringify(envelope)).byteLength >= plainBytes.byteLength) return value;
    decodedValues.set(envelope, value);
    return envelope;
}

export function decodeStoreData(data) {
    if (!data || typeof data !== 'object') return data;
    for (const key of CODED_KEYS) {
        if (Object.hasOwn(data, key)) data[key] = decodeStoreEntry(key, data[key]);
    }
    return data;
}

export function encodeStoreData(data) {
    if (!data || typeof data !== 'object') return data;
    for (const key of CODED_KEYS) {
        if (Object.hasOwn(data, key)) data[key] = encodeStoreEntry(key, data[key]);
    }
    return data;
}

export function decodeStoreRoot(root) {
    if (!root || typeof root !== 'object') return root;
    const copy = { ...root };
    if (root.data && typeof root.data === 'object') copy.data = decodeStoreData({ ...root.data });
    return copy;
}

export const STORE_CODEC_KEYS = CODED_KEYS;
