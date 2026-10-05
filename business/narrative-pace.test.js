import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NARRATIVE_PACE_VALUES,
    narrativePaceContract,
    normalizeNarrativePace,
    readNarrativePacePreference,
    saveNarrativePacePreference,
    updateNarrativePacePrompt,
} from './narrative-preferences.js';
import { buildLinesPrompt } from './lines/prompt.js';
import { buildLinesInjection } from './lines/strategy.js';
import { buildOutlinePrompt } from './outline/prompts.js';
import { buildSpaceChatSystemPrompt } from './space/prompts.js';
import { createSpaceContext } from './space/context.js';
import { buildCreativeChatSystemPrompt } from '../state.js';

const labels = {
    free: '自由：按场景变速',
    slow: '慢：细写当下互动',
    fast: '快：压缩无关键变化的过渡',
};
const countContract = text => text.split('【剧情推进幅度】').length - 1;

test('pace defaults to free and produces only the selected compact guidance', () => {
    assert.equal(normalizeNarrativePace(undefined), 'free');
    assert.equal(normalizeNarrativePace('invalid'), 'free');
    assert.equal(readNarrativePacePreference({}), 'free');
    assert.equal(readNarrativePacePreference({ narrativePace: 'fast' }), 'fast');
    assert.deepEqual(NARRATIVE_PACE_VALUES, ['free', 'slow', 'fast']);
    for (const value of NARRATIVE_PACE_VALUES) {
        const contract = narrativePaceContract(value);
        assert.equal(countContract(contract), 1);
        assert.match(contract, new RegExp(labels[value]));
        for (const other of NARRATIVE_PACE_VALUES.filter(item => item !== value)) {
            assert.doesNotMatch(contract, new RegExp(labels[other]));
        }
    }
});

test('global setting saves one scalar, persists, and refreshes the host prompt', () => {
    const settings = { scale: { card: 'micro' }, lineDirection: { card: 'tragic' } };
    let saves = 0;
    const refreshed = [];
    assert.equal(saveNarrativePacePreference(settings, 'fast', {
        save: () => saves++,
        refresh: pace => refreshed.push(pace),
    }), 'fast');
    assert.equal(settings.narrativePace, 'fast');
    assert.deepEqual(settings.scale, { card: 'micro' });
    assert.deepEqual(settings.lineDirection, { card: 'tragic' });
    assert.equal(saves, 1);
    assert.deepEqual(refreshed, ['fast']);
});

test('normal main reply slot updates on value changes, has no activity gate, and clears when disabled', () => {
    const calls = [];
    const context = {
        constants: { promptTypes: { IN_CHAT: 17 }, promptRoles: { SYSTEM: 29 } },
        setExtensionPrompt: (...args) => calls.push(args),
    };
    assert.equal(updateNarrativePacePrompt({ context, enabled: true }), narrativePaceContract('free'));
    updateNarrativePacePrompt({ context, enabled: true, pace: 'slow' });
    updateNarrativePacePrompt({ context, enabled: true, pace: 'fast' });
    updateNarrativePacePrompt({ context, enabled: false, pace: 'fast' });
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map(([key, content, type, depth, scan, role]) => [key, content, type, depth, scan, role]), [
        ['sp_narrative_pace', narrativePaceContract('free'), 17, 4, false, 29],
        ['sp_narrative_pace', narrativePaceContract('slow'), 17, 4, false, 29],
        ['sp_narrative_pace', narrativePaceContract('fast'), 17, 4, false, 29],
        ['sp_narrative_pace', '', 17, 4, false, 29],
    ]);
});

test('the selected global mode reaches line/outline creation and outline discussion once; point and latent preference contracts exclude it', () => {
    for (const pace of NARRATIVE_PACE_VALUES) {
        const line = buildLinesPrompt('用户', '角色', 'user', '', 'auto', {}, 'off', 'natural', pace);
        const outline = buildOutlinePrompt('用户', '角色', 'user', { narrativePace: pace });
        const discussion = buildCreativeChatSystemPrompt({ userName: '用户', charName: '角色', preferences: { narrativePace: pace } });
        const spaceLine = buildSpaceChatSystemPrompt({
            userName: '用户', charName: '角色', preferences: { narrativePace: pace },
            intent: { action: 'write', kind: 'line_widget' },
        });
        for (const prompt of [line, outline, discussion, spaceLine]) {
            assert.equal(countContract(prompt), 1);
            assert.match(prompt, new RegExp(labels[pace]));
        }
        assert.match(line, /Line: 名称\|阶段\|时间锚点\|agency\|stall\|pin/);
        assert.match(outline, /Beat: 推演时间\|标题\|类型\|所属故事线\|结果/);
        assert.match(outline, /Scene: 这一阶段发生什么/);
        assert.match(outline, /Subtext: 文学化题记或引言/);
        assert.match(outline, /Think: 节点成立原因/);
        const point = buildSpaceChatSystemPrompt({
            userName: '用户', charName: '角色', preferences: { narrativePace: pace },
            intent: { action: 'write', kind: 'schedule_widget' },
        });
        const discussionSpace = buildSpaceChatSystemPrompt({
            userName: '用户', charName: '角色', preferences: { narrativePace: pace },
            intent: { action: 'discuss', kind: null },
        });
        assert.equal(countContract(point), 0);
        assert.equal(countContract(discussionSpace), 0);
    }
    assert.doesNotMatch(buildLinesInjection([], { scale: 'auto' }), /缓慢地顺势推进|剧情推进幅度/);
});

test('the interval line-card request reads the shared global pace through its existing preference callback', async () => {
    const feature = createSpaceContext({
        context: () => ({ name1: '用户', name2: '角色', characterId: 'card-a' }),
        preferences: () => ({ scale: 'auto', direction: 'natural', narrativePace: 'fast' }),
    });
    const messages = await feature.buildMessages({ target: {}, userMsg: '给我做个线卡片', historySnapshot: [] });
    assert.equal(countContract(messages[0].content), 1);
    assert.match(messages[0].content, /快：压缩无关键变化的过渡/);
});
