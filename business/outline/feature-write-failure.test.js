import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutlineFeature } from './feature.js';
import { pointRawToken } from '../space/schema.js';

test('手动编辑、设当前和删除在写入被拒时反馈且不伪报成功', async () => {
    const saved = {
        raw: '<outline_widget>\nBeat: 一周后|资料汇合|调查|主线|阶段变化\nScene: 线索得到核实\nBeat: 下月|后续核对|调查|主线|等待结果\nScene: 后续安排尚未决定\n</outline_widget>',
        cursor: 1,
        ts: 1,
    };
    const notices = [];
    const feature = createOutlineFeature({
        context: () => ({ chatId: 'A', chat: [] }),
        keyDesc: kind => ({ kind }),
        readStore: key => key?.kind === 'outline' ? saved : null,
        writeStore: () => false,
        settings: () => ({ outlineInject: false }),
        promptTextarea: async () => '修订后的场景',
        confirm: async () => true,
        ui: { toast: (...args) => notices.push(args) },
    });

    assert.equal(await feature.actions.editScene(0), false);
    assert.equal(feature.actions.toggleCursor(1), false);
    assert.equal(await feature.actions.deleteBeat(0), false);
    assert.deepEqual(notices.map(([message]) => message), [
        '保存失败，面未修改',
        '保存失败，当前节点未修改',
        '保存失败，面未删除',
    ]);
    assert.equal(saved.cursor, 1);
    assert.match(saved.raw, /线索得到核实/);
});

test('间面候选只按正式稿正文冲突；自动时间和当前节点变化不阻止点击应用', async () => {
    let saved = {
        raw: '<outline_widget>\nBeat: 一周后|正式稿|关系|主线|后续待定\nScene: 正式节点\n</outline_widget>',
        cursor: 1, ts: 10,
    };
    const notices = [];
    const commits = [];
    const feature = createOutlineFeature({
        context: () => ({ chatId: 'A', chat: [] }),
        keyDesc: kind => ({ kind }),
        readStore: () => saved,
        writeStore: () => false,
        writeStoreConfirmed: async (_key, value) => { commits.push(value); saved = value; return { ok: true, commitState: 'confirmed' }; },
        settings: () => ({ outlineInject: false }),
        injectEnabled: () => false,
        now: () => 99,
        ui: { toast: (...args) => notices.push(args), isOutlineMode: () => false },
    });
    const expected = pointRawToken(saved.raw);
    saved = { ...saved, ts: 11, cursor: 2 };
    const result = await feature.actions.applyCandidate(
        'Beat: 两周后|误会澄清|关系|主线|信任增加\nScene: 两人核对消息来源并约定下次会面',
        expected,
    );
    assert.equal(result.status, 'applied');
    assert.equal(commits.length, 1);
    assert.match(commits[0].raw, /<outline_widget>/);
    assert.equal(commits[0].cursor, 1);
    assert.equal(commits[0].ts, 99);

    const stale = await feature.actions.applyCandidate(
        'Beat: 三周后|新的方案|关系|主线|影响待定\nScene: 新场景',
        expected,
    );
    assert.equal(stale.status, 'conflict');
    assert.equal(commits.length, 1);
    assert.match(saved.raw, /误会澄清/);
    assert.match(notices.at(-1)[0], /面内容已修改/);
});

test('间面候选遇到存储结果未知时准确反馈，保留正式稿读取结果供用户查看', async () => {
    const original = {
        raw: '<outline_widget>\nBeat: 一周后|正式稿|关系|主线|后续待定\nScene: 正式节点\n</outline_widget>',
        cursor: 2, ts: 10,
    };
    const notices = [];
    const feature = createOutlineFeature({
        context: () => ({ chatId: 'A', chat: [] }),
        keyDesc: kind => ({ kind }),
        readStore: () => original,
        writeStore: () => false,
        writeStoreConfirmed: async () => ({ ok: false, commitState: 'unknown' }),
        settings: () => ({ outlineInject: false }),
        injectEnabled: () => false,
        ui: { toast: (...args) => notices.push(args), isOutlineMode: () => false },
    });
    const result = await feature.actions.applyCandidate(
        'Beat: 两周后|新方案|关系|主线|影响待定\nScene: 新场景', pointRawToken(original.raw),
    );
    assert.equal(result.status, 'unknown');
    assert.equal(feature.readRaw(), original.raw);
    assert.match(notices.at(-1)[0], /保存结果暂时无法确认/);
});
