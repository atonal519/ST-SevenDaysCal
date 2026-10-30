import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteOutlineBeatFromRaw, editOutlineScene, normalizeOutlineResponse, parseCompleteOutline, parseOutline, parseOutlineAdvanceDecision } from './schema.js';
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

test('多个闭合面块按原顺序合并，坏节点槽位保留但规范化只保留合法节点', () => {
    const source = `<outline_widget>\nBeat: 坏节点||||\n</outline_widget>\n<outline_widget>\n${validBeat}\nBeat: 三周后|后续核对|调查|主线|继续观察\nScene: 双方复核新证据\n</outline_widget>`;
    const parsed = parseOutline(source);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].time, '坏节点');
    assert.equal(parseCompleteOutline(source).length, 2);
    const normalized = normalizeOutlineResponse(source);
    assert.match(normalized, /资料汇合/);
    assert.match(normalized, /后续核对/);
    assert.doesNotMatch(normalized, /坏节点/);
});

test('闭合面块不会跨 wrapper 拼接 Beat 与 Scene', () => {
    const source = `<outline_widget>\nBeat: 仅在第一块|完整标题|调查|主线|完整结果\n</outline_widget>\n<outline_widget>\nScene: 仅在第二块\n</outline_widget>`;
    const parsed = parseOutline(source);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].time, '仅在第一块');
    assert.equal(parsed[0].scene, '');
    assert.equal(parseCompleteOutline(source).length, 0);
    assert.equal(normalizeOutlineResponse(source), '');
});

test('明确关系与状态元数据不串入 Scene，普通多行叙事与对话保留', () => {
    const source = `<outline_widget>\nBeat: 两周后|资料汇合|调查|主线|证据形成\nScene: 调查者汇总现场记录，下一步安排仍待证据确认\n记者问：你准备何时出发？\n时间：傍晚\n【关系卡】\n双方仍在观察期\nrelationship_stage: 中等\n</outline_widget>`;
    const parsed = parseOutline(source);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].scene, '调查者汇总现场记录，下一步安排仍待证据确认\n记者问：你准备何时出发？\n时间：傍晚');
    assert.doesNotMatch(parsed[0].scene, /关系卡|观察期|relationship_stage|中等/);
});

test('独立结构标题与技术键的多行内容不串入 Scene，正常正文继续保留', () => {
    const source = `<outline_widget>\nBeat: 两周后|资料汇合|调查|主线|证据形成\nScene: 调查者汇总现场记录\n【关系卡】\n双方仍在观察期\nrelationship_stage: 中等\n【信用卡】被放在桌上\n卡车驶过街角。\n记者问：你准备何时出发？\n时间：傍晚\nScene: 正式字段重新开始\n</outline_widget>`;
    const parsed = parseOutline(source);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].scene, '正式字段重新开始');
    assert.doesNotMatch(parsed[0].scene, /关系卡|观察期|relationship_stage|中等/);
});

test('信用卡与卡车等含卡普通叙事不被误识别为结构标题', () => {
    const source = `<outline_widget>\nBeat: 两周后|资料汇合|调查|主线|证据形成\nScene: 【信用卡】被放在桌上\n卡车驶过街角。\n</outline_widget>`;
    const parsed = parseOutline(source);
    assert.equal(parsed[0].scene, '【信用卡】被放在桌上\n卡车驶过街角。');
});

test('多 wrapper 的编辑与删除按展平槽位定位且保留其他 wrapper 原文', () => {
    const source = `<outline_widget>\nBeat: 第一|甲|调查|主线|结果甲\nScene: 场景甲\n未知甲：保留\n</outline_widget>\n<outline_widget>\nBeat: 第二|乙|调查|支线|结果乙\nScene: 场景乙\n未知乙：保留\n</outline_widget>`;
    const edited = editOutlineScene(source, 1, '修改后的场景乙');
    assert.equal(edited.ok, true);
    assert.match(edited.raw, /场景甲/);
    assert.match(edited.raw, /修改后的场景乙/);
    assert.match(edited.raw, /未知甲：保留/);
    assert.match(edited.raw, /未知乙：保留/);

    const deletedSecond = deleteOutlineBeatFromRaw(source, 1);
    assert.match(deletedSecond, /第一/);
    assert.doesNotMatch(deletedSecond, /第二|场景乙|未知乙/);
    const deletedFirst = deleteOutlineBeatFromRaw(source, 0);
    assert.doesNotMatch(deletedFirst, /第一|场景甲|未知甲/);
    assert.match(deletedFirst, /第二|场景乙|未知乙/);
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

test('粗体字段与普通字段混排时编辑删除按页面节点定位，不误动相邻节点', () => {
    const raw = '<outline_widget>\n**Beat**: 今天|甲|调查|主线|结果甲\n> **Scene**: 场景甲\n未知字段：甲保留\nBeat: 明天|乙|调查|支线|结果乙\nScene: 场景乙\n未知字段：乙保留\n</outline_widget>'.replaceAll('\\n', '\n');
    const before = parseOutline(raw);
    assert.deepEqual(before.map(item => item.title), ['甲', '乙']);
    const edited = editOutlineScene(raw, 0, '新场景甲');
    assert.equal(edited.ok, true);
    assert.match(parseOutline(edited.raw)[0].scene, /^新场景甲/);
    assert.deepEqual(parseOutline(edited.raw)[1], before[1]);
    assert.match(edited.raw, /未知字段：甲保留/);
    assert.deepEqual(parseOutline(deleteOutlineBeatFromRaw(raw, 0)).map(item => item.title), ['乙']);
    assert.deepEqual(parseOutline(deleteOutlineBeatFromRaw(raw, 1)).map(item => item.title), ['甲']);
});
