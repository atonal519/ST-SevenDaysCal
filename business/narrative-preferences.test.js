import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt as buildPointPrompt } from './point/prompt.js';
import { buildLinesPrompt } from './lines/prompt.js';
import { buildOutlineCreationContract, buildOutlineInjectionText, buildOutlineJudgePrompt, buildOutlinePrompt } from './outline/prompts.js';
import { buildSpaceChatSystemPrompt } from './space/prompts.js';
import { classifySpaceIntent, createSpaceContext } from './space/context.js';
import { createOutlineInjection } from './outline/injection.js';
import { createLinesInjectionController } from './lines/injection.js';
import { createOutlineFeature } from './outline/feature.js';
import { buildCreativeChatSystemPrompt } from '../state.js';

const scales = ['auto', 'macro', 'meso', 'micro'];
const preferences = scale => ({ scale, direction: 'tragic' });

test('every narrative scale reaches point, line, outline, outline chat, and outline injection prompts', () => {
    for (const scale of scales) {
        const prefs = preferences(scale);
        const point = buildPointPrompt('用户', '角色', 'user', null, null, null, prefs);
        const line = buildLinesPrompt('用户', '角色', 'user', '', scale, {}, 'off', 'tragic');
        const outline = buildOutlinePrompt('用户', '角色', 'user', prefs);
        const chat = buildCreativeChatSystemPrompt({ userName: '用户', charName: '角色', preferences: prefs });
        const injection = buildOutlineInjectionText([{ title: '当前', scene: '现状' }, { title: '后续', scene: '方向' }], 1, undefined, prefs);
        for (const prompt of [point, line, outline, chat, injection]) {
            assert.match(prompt, new RegExp(`叙事尺度·观察焦点】.*${scale === 'auto' ? '自动' : scale === 'macro' ? '宏观' : scale === 'meso' ? '中观' : '微观'}`));
            assert.match(prompt, /悲剧倾向/);
            assert.match(prompt, /不得扭曲既有事实/);
            assert.match(prompt, /不决定冲突强度或故事时间速度/);
        }
    }
});

test('meso names organization and group level, while outline remains stage based', () => {
    const meso = buildOutlineCreationContract(preferences('meso'));
    assert.match(meso, /中观：观察已有组织、家族、职场、学派或群体/);
    assert.match(meso, /长线阶段大纲/);
    assert.match(meso, /不是凭空增加冲突、阴谋或灾难的理由/);
    assert.doesNotMatch(meso, /数周至数月/);
});

test('space adds preferences only to point and line creation, not calendar or ordinary discussion', () => {
    const base = { userName: '用户', charName: '角色', preferences: preferences('meso') };
    const point = buildSpaceChatSystemPrompt({ ...base, intent: { action: 'write', kind: 'schedule_widget' } });
    const line = buildSpaceChatSystemPrompt({ ...base, intent: { action: 'write', kind: 'line_widget' } });
    const almanac = buildSpaceChatSystemPrompt({ ...base, intent: { action: 'write', kind: 'almanac_widget' } });
    const discussion = buildSpaceChatSystemPrompt({ ...base, intent: { action: 'discuss', kind: null } });
    assert.match(point, /叙事尺度·观察焦点/);
    assert.match(line, /叙事尺度·观察焦点/);
    assert.doesNotMatch(almanac, /叙事尺度·观察焦点|剧情倾向·优先级/);
    assert.doesNotMatch(discussion, /叙事尺度·观察焦点|剧情倾向·优先级/);
});

test('outline mechanical judge remains independent of narrative preferences', () => {
    const prompt = buildOutlineJudgePrompt('当前阶段', '下一阶段', '', '');
    assert.doesNotMatch(prompt, /叙事尺度|剧情倾向/);
});

test('space card generation reads the current character preference through its context callback', async () => {
    const byCharacter = { 'card-a': preferences('micro'), 'card-b': preferences('macro') };
    const ctx = { name1: '用户', name2: '角色', characterId: 'card-a' };
    const feature = createSpaceContext({
        context: () => ctx,
        preferences: current => byCharacter[current.characterId],
    });
    const messages = await feature.buildMessages({
        target: {},
        userMsg: '给我做个点卡片',
        historySnapshot: [],
    });
    assert.match(messages[0].content, /微观：观察人物当下的行动/);
    ctx.characterId = 'card-b';
    const nextMessages = await feature.buildMessages({
        target: {},
        userMsg: '给我做个点卡片',
        historySnapshot: [],
    });
    assert.match(nextMessages[0].content, /宏观：观察已有势力/);
});

test('semantic-route applies point/line preferences only if it chooses those cards', async () => {
    const preferencesByCharacter = { card: { ...preferences('meso'), narrativePace: 'fast' } };
    const ctx = { name1: '用户', name2: '角色', characterId: 'card' };
    const feature = createSpaceContext({
        context: () => ctx,
        preferences: current => preferencesByCharacter[current.characterId],
    });
    const build = async userMsg => feature.buildMessages({ target: {}, userMsg, historySnapshot: [] });

    const ambiguous = '我想看线的未来可能性';
    assert.equal(classifySpaceIntent(ambiguous).action, 'semantic-route');
    const routed = (await build(ambiguous))[0].content;
    assert.match(routed, /若你选择普通讨论或解释/);
    assert.match(routed, /不要把偏好当作回答立场/);
    assert.match(routed, /轴／历法卡片与刻度内容不套用这些偏好/);
    assert.match(routed, /剧情推进幅度仅在本轮确实输出或修改线卡时适用；其他卡与普通讨论不套用此幅度/);
    assert.match(routed, /快：压缩无关键变化的过渡，让有据事件实质推进，过渡可自然跨日或数日/);
    assert.equal(routed.split('【剧情推进幅度】').length - 1, 1);
    for (const kind of ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget']) assert.match(routed, new RegExp(`<${kind}>`));
    assert.match(routed, /中观：观察已有组织/);
    assert.match(routed, /剧情倾向·优先级/);

    const discussion = '我只是想了解线的未来可能性，不要输出卡片';
    assert.equal(classifySpaceIntent(discussion).action, 'discuss');
    const discussed = (await build(discussion))[0].content;
    assert.match(discussed, /普通讨论或只读查询/);
    assert.doesNotMatch(discussed, /剧情倾向·优先级|叙事尺度·观察焦点/);

    for (const [request, kind] of [['给我做一个点卡片', 'schedule_widget'], ['给我生成一条线卡片', 'line_widget']]) {
        assert.equal(classifySpaceIntent(request).kind, kind);
        const explicit = (await build(request))[0].content;
        assert.match(explicit, /叙事尺度·观察焦点/);
        assert.match(explicit, /剧情倾向·优先级/);
        assert.doesNotMatch(explicit, /若你选择普通讨论或解释/);
    }

    const almanac = (await build('给我出个轴卡片'))[0].content;
    assert.doesNotMatch(almanac, /叙事尺度·观察焦点|剧情倾向·优先级/);
});

test('outline hidden injection refreshes preferences only while both injection switches are enabled', () => {
    let enabled = true;
    let prefs = preferences('meso');
    const injected = [];
    const ctx = { setExtensionPrompt: (_key, text) => injected.push(text) };
    const target = {};
    const repository = {
        capture: () => target,
        isCurrent: candidate => candidate === target,
        readOutline: () => ({ raw: '<outline_widget>Beat: 当下|当前|阶段|主线|继续\nScene: 组织内部协作\nSubtext: 题记\nThink: 阶段缘由</outline_widget>' }),
        cursor: () => 1,
    };
    const injection = createOutlineInjection({
        repository,
        context: () => ctx,
        settings: () => ({ outlineInject: enabled }),
        injectEnabled: () => true,
        preferences: () => prefs,
    });
    injection.refresh();
    assert.match(injected.at(-1), /中观：观察已有组织/);
    prefs = preferences('micro');
    injection.refresh();
    assert.match(injected.at(-1), /微观：观察人物当下的行动/);
    enabled = false;
    injection.refresh();
    assert.equal(injected.at(-1), '');
});

test('line hidden injection refreshes the shared scale/direction contract and respects its switch', () => {
    let prefs = preferences('macro');
    let enabled = true;
    const injected = [];
    const ctx = { setExtensionPrompt: (_key, text) => injected.push(text) };
    const controller = createLinesInjectionController({
        context: () => ctx,
        settings: () => ({ linesEnabled: true, linesInject: enabled }),
        enabled: () => true,
        readRaw: () => '<storylines_widget>\nLine: 当前线|延展|近日|world|false|false\nDesc: 既有背景\nNext: 下一步\n</storylines_widget>',
        direction: () => prefs.direction,
        scale: () => prefs.scale,
    });
    controller.refresh();
    assert.match(injected.at(-1), /宏观：观察已有势力/);
    assert.match(injected.at(-1), /悲剧倾向/);
    prefs = preferences('meso');
    controller.refresh();
    assert.match(injected.at(-1), /中观：观察已有组织/);
    enabled = false;
    controller.refresh();
    assert.equal(injected.at(-1), '');
});

test('outline feature passes the current character preferences into the generation API prompt', async () => {
    const saved = new Map();
    const ctx = { chatId: 'outline-chat', characterId: 'character-a', name1: '用户', name2: '角色' };
    const output = '<outline_widget>\nBeat: 阶段|结果|关系|关系线|互相理解\nScene: 既有人物在既有事实内推进关系\nSubtext: 一句题记\nThink: 已知动机支撑\n</outline_widget>';
    let generationPrompt = '';
    let preferenceLookups = 0;
    const feature = createOutlineFeature({
        context: () => ctx,
        keyDesc: kind => kind,
        readStore: key => saved.get(key.kind),
        writeStore: (key, value) => { saved.set(key.kind, value); return true; },
        settings: () => ({ outlineInject: false }),
        injectEnabled: () => false,
        pluginEnabled: () => true,
        loadConfig: () => ({ url: 'https://example.invalid', key: 'test-key' }),
        loadUtilityConfig: () => ({ url: 'https://example.invalid', key: 'test-key' }),
        precheck: async () => true,
        preferences: current => {
            preferenceLookups += 1;
            assert.equal(current.characterId, 'character-a');
            return preferences('meso');
        },
        callApi: async ({ prompt }) => { generationPrompt = prompt; return output; },
        cleanText: value => String(value ?? ''),
        escapeHtml: value => String(value ?? ''),
        ui: { setOutline() {}, loading: () => '', toast() {}, isOutlineMode: () => false },
    });
    const result = await feature.generation.trigger();
    assert.equal(result.status, 'updated');
    assert.equal(preferenceLookups, 1);
    assert.match(generationPrompt, /中观：观察已有组织、家族、职场、学派或群体/);
    assert.match(generationPrompt, /当前剧情倾向为「悲剧倾向」/);
});
