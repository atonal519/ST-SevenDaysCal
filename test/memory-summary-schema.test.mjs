import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMemorySummary } from '../business/memory/summary-schema.js';

test('L0 接受正式字段别名、包装和合法无事实值', () => {
    assert.equal(normalizeMemorySummary('```json\n{"time":"未提及","scene":"未提及","event":"无","people":"无"}\n```', 'L0'),
        '时间锚点: 未提及\n场景: 未提及\n事件: 无\n人物: 无');
    assert.equal(normalizeMemorySummary('<事件>无新事件</事件>\n人物: 无', 'L0'), '事件: 无新事件\n人物: 无');
    assert.equal(normalizeMemorySummary('**主要事件：**\n  两人约定下次见面。', 'L0'), '事件: 两人约定下次见面。');
    assert.equal(normalizeMemorySummary('<summary>\n事件: 两人约定下次见面。\n人物: 无\n</summary>', 'L0'), '事件: 两人约定下次见面。\n人物: 无');
});

test('摘要只在关键字段明确归属时通过，不以长文本或日期地点代替结构', () => {
    assert.equal(normalizeMemorySummary(`2026-04-01\n${'这是一段很长但没有摘要字段的回答。'.repeat(20)}`, 'L0'), null);
    assert.equal(normalizeMemorySummary('时间锚点: 2026-04-01\n场景: 房间', 'L0'), null);
    assert.equal(normalizeMemorySummary('时间跨度: 未提及\n主要事件: 无\n关系变化: 无明显变化', 'L1'),
        '时间跨度: 未提及\n主要事件: 无\n关系变化: 无明显变化');
    assert.equal(normalizeMemorySummary('{"event":"A","main events":"B"}', 'L0'), '事件: A\nB');
});

test('同一摘要重复字段折叠相同值并按顺序保留不同片段', () => {
    assert.equal(normalizeMemorySummary('事件: 开门\n事件: 交谈\n人物: 无\n人物: 无', 'L0'),
        '事件: 开门\n交谈\n人物: 无');
    assert.equal(normalizeMemorySummary('{"event":"开门","main events":"交谈","people":"无","characters":"无"}', 'L0'),
        '事件: 开门\n交谈\n人物: 无');
    assert.equal(normalizeMemorySummary('<summary>\n事件: A\n人物: B\n</summary>\n<summary>\n事件: C\n人物: D\n</summary>', 'L0'),
        '事件: A\nC\n人物: B\nD');
});
