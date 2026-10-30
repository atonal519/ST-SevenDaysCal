import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpaceChatSystemPrompt, buildSpaceHelpText } from './prompts.js';

test('关系讨论同样区分正式规划与已经发生的正文事实', () => {
    const prompt = buildSpaceChatSystemPrompt({ userName: '我', charName: 'TA', intent: { action: 'semantic-route' } });
    assert.match(prompt, /关系分析也要区分已发生证据、约定和未来规划/);
    assert.match(prompt, /已保存大纲也不等于节点已经发生/);
});

test('刻度能力说明不提供实际不存在的手工新增或粘贴录入入口', () => {
    const help = buildSpaceHelpText({});
    assert.match(help, /新增只通过「标注」从剧情捞取/);
    assert.match(help, /没有直接手工新建或粘贴文字新增的入口/);
    assert.match(help, /编辑只修改已有条目/);
});
