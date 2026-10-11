import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeStoreEntry, encodeStoreEntry } from './store-codec.js';
import { gzipSync } from '../vendor/fflate-gzip.mjs';

test('selected store entries round-trip losslessly and reuse only their physical wrapper cache', () => {
    const value = {
        raw: '中英混合剧情 😊 '.repeat(2500),
        history: Array.from({ length: 10 }, (_, index) => ({ raw: `历史版本 ${index}：` + '完整内容。'.repeat(240), locked: index === 2, id: `line-${index}` })),
        manual: { sourceKey: 'source-9', ts: 1710000000000 },
    };
    const encoded = encodeStoreEntry('lines-user', value);
    assert.equal(encoded.codec, 'stsc-gzip-base64');
    const decoded = decodeStoreEntry('lines-user', encoded);
    assert.deepEqual(decoded, value);
    assert.strictEqual(decoded, value, 'the just-encoded write keeps its live object identity for save-error ownership');
    assert.strictEqual(decodeStoreEntry('lines-user', encoded), decoded);
});

test('small values and unrelated keys remain plain, and absent keys are not created', () => {
    const small = { raw: 'short', ts: 1 };
    assert.strictEqual(encodeStoreEntry('lines-user', small), small);
    assert.strictEqual(encodeStoreEntry('outline-user', { raw: 'x'.repeat(3000) }).raw.length, 3000);
    const data = { 'lines-user': small };
    assert.equal(Object.hasOwn(data, 'dashed-user'), false);
    assert.strictEqual(decodeStoreEntry('dashed-user', undefined), undefined);
    assert.strictEqual(encodeStoreEntry('lines-user', null), null);
    assert.deepEqual(encodeStoreEntry('lines-user', ['not a store object']), ['not a store object']);
});

test('damaged and future same-family wrappers fail visibly and cannot be overwritten', () => {
    for (const value of [
        { codec: 'stsc-gzip-base64', version: 2, payload: 'broken' },
        { codec: 'stsc-gzip-base64-v2', version: 2, payload: 'future-format' },
        { codec: 'stsc-gzip-base64', version: 1, payload: 'broken' },
    ]) {
        assert.throws(() => decodeStoreEntry('lines-user', value), /无法识别|损坏/);
        assert.strictEqual(encodeStoreEntry('lines-user', value), value);
    }
});

test('gzip JSON null and arrays are damaged store wrappers rather than empty values', () => {
    for (const value of [null, []]) {
        const bytes = gzipSync(new TextEncoder().encode(JSON.stringify(value)));
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const envelope = { codec: 'stsc-gzip-base64', version: 1, payload: btoa(binary) };
        assert.throws(() => decodeStoreEntry('diagnostics-v1', envelope), /损坏/);
    }
});

test('legacy plain diagnostics without floors remain readable and are not newly wrapped', () => {
    const legacy = { marker: 'older diagnostics '.repeat(1000) };
    assert.strictEqual(encodeStoreEntry('diagnostics-v1', legacy), legacy);
    assert.deepEqual(decodeStoreEntry('diagnostics-v1', legacy), legacy);
    const malformedPacked = {
        codec: 'stsc-gzip-base64',
        version: 1,
        payload: Buffer.from(gzipSync(new TextEncoder().encode(JSON.stringify(legacy)))).toString('base64'),
    };
    assert.throws(() => decodeStoreEntry('diagnostics-v1', malformedPacked), /损坏/);
});
