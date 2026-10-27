import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NARRATIVE_PACE_VALUES,
    narrativePaceContract,
    normalizeNarrativePace,
    readNarrativePacePreference,
    saveNarrativePacePreference,
} from './narrative-preferences.js';
import { buildLinesPrompt } from './lines/prompt.js';
import { buildLinesInjection } from './lines/strategy.js';
import { buildOutlinePrompt } from './outline/prompts.js';
import { buildSpaceChatSystemPrompt } from './space/prompts.js';
import { createSpaceContext } from './space/context.js';

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
        assert.doesNotMatch(contract, /成年|成人/);
        for (const other of NARRATIVE_PACE_VALUES.filter(item => item !== value)) {
            assert.doesNotMatch(contract, new RegExp(labels[other]));
        }
    }
});

test('global setting saves the internal generation pace without a host prompt callback', () => {
    const settings = { scale: { card: 'micro' }, lineDirection: { card: 'tragic' } };
    let saves = 0;
    assert.equal(saveNarrativePacePreference(settings, 'fast', {
        save: () => saves++,
    }), 'fast');
    assert.equal(settings.narrativePace, 'fast');
    assert.deepEqual(settings.scale, { card: 'micro' });
    assert.deepEqual(settings.lineDirection, { card: 'tragic' });
    assert.equal(saves, 1);
});

test('the selected global mode reaches line/outline creation and Space outline requests once; point and latent preference contracts exclude it', () => {
    for (const pace of NARRATIVE_PACE_VALUES) {
        const line = buildLinesPrompt('用户', '角色', 'user', '', 'auto', {}, 'off', 'natural', pace);
        const outline = buildOutlinePrompt('用户', '角色', 'user', { narrativePace: pace });
        const spaceOutline = buildSpaceChatSystemPrompt({
            userName: '用户', charName: '角色', preferences: { narrativePace: pace },
            requestedMaterials: { outline: true },
            intent: { action: 'write', kind: 'outline_widget' },
        });
        const spaceLine = buildSpaceChatSystemPrompt({
            userName: '用户', charName: '角色', preferences: { narrativePace: pace },
            intent: { action: 'write', kind: 'line_widget' },
        });
        for (const prompt of [line, outline, spaceLine]) {
            assert.equal(countContract(prompt), 1);
            assert.match(prompt, new RegExp(labels[pace]));
            assert.doesNotMatch(prompt, /成年亲密互动|成人亲密互动/);
        }
        assert.equal(countContract(spaceOutline), 0);
        assert.match(line, /Line: 名称\|阶段\|时间锚点\|player或world\|true或false\|false/);
        assert.match(outline, /Beat: 推演时间\|标题\|类型\|所属故事线\|结果/);
        assert.match(outline, /Scene: 行动与局面变化/);
        assert.match(outline, /Subtext: 文学化题记/);
        assert.match(outline, /Think: 成立依据与叙事作用/);
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
    assert.doesNotMatch(buildLinesInjection([]), /缓慢地顺势推进|剧情推进幅度/);
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
