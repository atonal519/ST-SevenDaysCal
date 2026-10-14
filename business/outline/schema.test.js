import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOutlineResponse, parseCompleteOutline, parseOutline, parseOutlineAdvanceDecision } from './schema.js';
import { formatOutlinePlanningProjection, projectOutlineBeats } from './injection.js';
import { buildOutlineInjectionText } from './prompts.js';
import { buildTravelPlanningContext } from '../../time-travel.js';

const validBeat = `Beat: 两周后|资料汇合|调查|主线|证据形成\nScene: 调查者汇总现场记录，下一步安排仍待证据确认\nSubtext: 留出观察余地\nThink: 证据累积使行动方向逐渐清晰`;

test('正式块允许辅助字段缺失并保留明确多行，规范化往返稳定', () => {
    const source = `<outline_widget>\nBeat: 两周后|资料汇合|调查|主线|证据形成\nScene: 调查者汇总现场记录，下一步安排仍待证据确认\n继续核对来源。\nThink: 证据累积使行动方向逐渐清晰\n判断仍待复核。\n</outline_widget>`;
    const parsed = parseCompleteOutline(source);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].scene, '调查者汇总现场记录，下一步安排仍待证据确认\n继续核对来源。');
    assert.equal(parsed[0].think, '证据累积使行动方向逐渐清晰\n判断仍待复核。');
    assert.equal(parsed[0].subtext, '');
    const normalized = normalizeOutlineResponse(source);
    assert.ok(normalized);
    assert.deepEqual(parseOutline(normalized), parseOutline(normalizeOutlineResponse(normalized)));
});

test('确定的外层记录包装兼容缺少辅助字段的节点', () => {
    const wrapped = `<result>\nBeat: 两周后|资料汇合|调查|主线|证据形成\nScene: 调查者汇总现场记录\n</result>`;
    const normalized = normalizeOutlineResponse(wrapped);
    assert.ok(normalized);
    assert.equal(parseCompleteOutline(normalized).length, 1);
});

test('缺少 Beat 关键值或 Scene 的节点不进入可应用结果', () => {
    const source = `<outline_widget>\n${validBeat}\nBeat: 一个月后|遗漏类型||主线|结果\nScene: 不完整\nBeat: 下月|遗漏场景|调查|主线|仍需材料\nThink: 可保留为原始草稿\n</outline_widget>`;
    assert.equal(parseCompleteOutline(source).length, 1);
    assert.match(normalizeOutlineResponse(source), /资料汇合/);
    assert.doesNotMatch(normalizeOutlineResponse(source), /遗漏类型|遗漏场景/);
    assert.equal(normalizeOutlineResponse('这里是普通分析文字，没有正式节点'), '');
});

test('规划投影只给完整节点且保留原始游标槽位', () => {
    const beats = parseOutline(`<outline_widget>\n${validBeat}\nBeat: 下月|缺少场景|调查|主线|材料尚未齐\nBeat: 明年|远期安排|关系|支线|关系更稳定\nScene: 双方逐渐建立信任\n</outline_widget>`);
    const projection = projectOutlineBeats(beats, 2);
    assert.equal(projection.current, null);
    assert.equal(projection.next, null);
    assert.equal(projection.cursor, 0);
    assert.equal(projection.beats.length, 0);
    const text = formatOutlinePlanningProjection(projection);
    assert.equal(text, '');
    const travel = buildTravelPlanningContext({ outline: projection.beats, outlineCursor: projection.cursor });
    assert.equal(travel, '');

    const previous = projectOutlineBeats(beats, 1);
    assert.equal(previous.current, beats[0]);
    assert.equal(previous.next, null);
    assert.equal(previous.cursor, 1);
    assert.equal(previous.beats.length, 2, '残缺 next 的原槽位保留，不提升第三节点');
    assert.equal(previous.beats[0], beats[0]);
    assert.equal(previous.beats[1], null);
    const withIncompleteNext = buildOutlineInjectionText(previous.beats, previous.cursor);
    assert.match(withIncompleteNext, /当前节点：/);
    assert.doesNotMatch(withIncompleteNext, /已是大纲最后一个节点/);
    const last = projectOutlineBeats(beats, 3);
    assert.match(buildOutlineInjectionText(last.beats, last.cursor), /已是大纲最后一个节点/);
    assert.equal(projectOutlineBeats(beats, 0).beats.length, 0);
});

test('字段块之外的解释文字不会并入多行字段', () => {
    const source = `这是说明，不是大纲字段\n${validBeat}\n这段块外评论不应变成 Scene 内容`;
    const parsed = parseOutline(source);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].scene, '调查者汇总现场记录，下一步安排仍待证据确认');
    assert.doesNotMatch(normalizeOutlineResponse(source), /块外评论/);
});

test('推进判断只接受唯一明确值及确定包装', () => {
    for (const positive of ['推进', '  推 进。', '结论：推进。', '```text\n未推进\n```']) {
        assert.ok(parseOutlineAdvanceDecision(positive), positive);
    }
    assert.equal(parseOutlineAdvanceDecision('没推进'), '没推进');
    assert.equal(parseOutlineAdvanceDecision('{"decision":"不推进"}'), '不推进');
    for (const ambiguous of ['这段推进了，但也可能没有', '推进还是未推进', '推进\n说明', '```\n推进\n```\n结论：未推进', '{"decision":"推进","结论":"未推进"}', '可能推进']) {
        assert.equal(parseOutlineAdvanceDecision(ambiguous), null, ambiguous);
    }
});
