import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutlineFeature } from './feature.js';

test('缺少 Beat 关键列或 Scene 的生成回复不覆盖旧面', async () => {
    const original = '<outline_widget>\nBeat: 一周后|原面|调查|主线|阶段一\nScene: 已保存的有效场景\n</outline_widget>';
    const record = { raw: original, cursor: 1, ts: 10 };
    const memorySnapshot = Object.freeze({ source: 'database', status: 'read-required' });
    let passedOptions;
    const feature = createOutlineFeature({
        context: () => ({ chatId: 'A', name1: '用户', name2: '角色', chat: [] }),
        keyDesc: kind => ({ kind }),
        readStore: key => key?.kind === 'outline' ? record : null,
        writeStore: (key, value) => { if (key?.kind !== 'outline') return false; Object.assign(record, value); return true; },
        settings: () => ({ notifyMode: 'off', outlineInject: false }),
        loadConfig: () => ({ url: 'local-test', key: 'fixture' }),
        precheck: async () => ({ proceed: true, memorySnapshot }),
        callApi: async request => { passedOptions = request.options; return '<outline_widget>\nBeat: 两周后|缺列|||\nScene: 不完整候选\nBeat: 下月|缺场景|调查|主线|未确认\n</outline_widget>'; },
        ui: { setLoading() {}, toast() {}, isOutlineMode: () => false },
    });

    const result = await feature.generation.trigger();
    assert.equal(result.status, 'failed');
    assert.equal(passedOptions.memorySnapshot, memorySnapshot);
    assert.equal(record.raw, original);
    assert.equal(record.cursor, 1);
});
