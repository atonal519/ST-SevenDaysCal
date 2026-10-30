import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTheaterReference, selectCoordinateReference } from './material-references.js';

test('作品的唯一准确标题可直接引用，不要求引号或固定动作词', () => {
    const piece = { title: '雨夜长廊', raw: '真实正文' };
    assert.deepEqual(selectTheaterReference('把雨夜长廊改成面方案', [piece], []), { piece, template: null });
    assert.deepEqual(selectTheaterReference('看看“雨夜长廊”', [piece], []), { piece, template: null });
    assert.deepEqual(selectTheaterReference('把刚才那个小剧场改成面方案', [piece], []), { piece: null, template: null });
    assert.deepEqual(selectTheaterReference('把雨夜长廊改成面方案', [piece], [{ title: '雨夜长廊' }]), { piece: null, template: null });
});

test('仅一个明确收藏楼层可读取正文，普通楼层引用与多楼层不猜来源', () => {
    const third = { floorIndex: 3 }, seventh = { floorIndex: 7 };
    assert.equal(selectCoordinateReference('把收藏的第3楼整理成线卡', [third, seventh]), third);
    assert.equal(selectCoordinateReference('坐标第 3 楼的场景可以做面吗', [third]), third);
    assert.equal(selectCoordinateReference('第3楼是什么意思', [third]), null);
    assert.equal(selectCoordinateReference('把收藏的第3楼和第7楼整理一下', [third, seventh]), null);
    assert.equal(selectCoordinateReference('把收藏的第3楼整理成线卡', [third, { messageId: 3 }]), null);
    assert.equal(selectCoordinateReference('把收藏的第9楼整理成线卡', [third]), null);
});

test('坐标楼号支持带第与不带第，保留来源和唯一楼层限制', () => {
    const row = { floorIndex: 3, textPreview: '旧港口约定' };
    assert.strictEqual(selectCoordinateReference('展开3楼坐标正文', [row]), row);
    assert.strictEqual(selectCoordinateReference('展开第3楼坐标正文', [row]), row);
    assert.equal(selectCoordinateReference('展开3楼和4楼坐标正文', [row]), null);
    assert.equal(selectCoordinateReference('展开3楼正文', [row]), null);
});

test('同一棱作品保存后与草稿同ID同正文只算一件，真正重名仍不猜', () => {
    const piece = { id: 'piece-a', title: '旧港来信', raw: '完整作品原文', source: '已保存作品' };
    const draft = { ...piece, source: '本聊天草稿' };
    assert.strictEqual(selectTheaterReference('读一下“旧港来信”', [piece, draft], []).piece, piece);
    assert.equal(selectTheaterReference('读一下“旧港来信”', [piece, { ...draft, raw: '另一版原文' }], []).piece, null);
    assert.equal(selectTheaterReference('读一下“旧港来信”', [piece, { ...draft, id: 'piece-b' }], []).piece, null);
    assert.equal(selectTheaterReference('读一下“旧港来信”', [piece, draft], [{ id: 'template', title: piece.title, text: '模板原文' }]).piece, null);
});
