import { lineDirectionContract } from './lines/direction.js';

export const NARRATIVE_PACE_VALUES = Object.freeze(['free', 'slow', 'fast']);

export function normalizeNarrativePace(value) {
    return NARRATIVE_PACE_VALUES.includes(value) ? value : 'free';
}

export function readNarrativePacePreference(settings) {
    return normalizeNarrativePace(settings?.narrativePace);
}

// Global story pacing is independent of observation scale and story-clock parsing.
// Point cards deliberately do not call this contract.
export function narrativePaceGuidance(value = 'free') {
    switch (normalizeNarrativePace(value)) {
        case 'slow': return '慢：细写当下互动与可感知变化，采用较小时间步幅，避免重复铺垫或原地空转。';
        case 'fast': return '快：压缩无关键变化的过渡，让有据事件实质推进，过渡可自然跨日或数日。';
        default: return '自由：按场景变速；关键抉择、情绪及成年亲密互动可细写，睡眠、无变化的用餐与旅途可略。';
    }
}

export function narrativePaceContract(value = 'free') {
    return `【剧情推进幅度】遵从本轮要求与关键选择；${narrativePaceGuidance(value)}`;
}

export function saveNarrativePacePreference(settings, value, { save, refresh } = {}) {
    const pace = normalizeNarrativePace(value);
    if (settings && typeof settings === 'object') settings.narrativePace = pace;
    save?.();
    refresh?.(pace);
    return pace;
}

export function updateNarrativePacePrompt({ context, enabled, pace = 'free', key = 'sp_narrative_pace' } = {}) {
    const prompt = enabled ? narrativePaceContract(pace) : '';
    context?.setExtensionPrompt?.(
        key,
        prompt,
        context?.constants?.promptTypes?.IN_CHAT ?? 1,
        4,
        false,
        context?.constants?.promptRoles?.SYSTEM ?? 0,
    );
    return prompt;
}

// 点、线、面共用同一选择边界，避免各入口把尺度误解为剧情升级或时间提速。
export function narrativeScaleGuidance(value = 'auto') {
    switch (value) {
        case 'macro': return '宏观：观察已有势力、制度与世界局势的变化，以及它们对当前人物和事件的具体影响。';
        case 'meso': return '中观：观察已有组织、家族、职场、学派或群体的运作、关系与阶段变化，并落到相关人物和事件。';
        case 'micro': return '微观：观察人物当下的行动、关系、成长与日常，不默认聚焦爱情。';
        default: return '自动：根据当前材料选择合适的观察范围，并随内容自然切换。';
    }
}

export function narrativePreferenceContract({ scale = 'auto', direction = 'natural' } = {}) {
    return [
        lineDirectionContract(direction),
        `【叙事尺度·观察焦点】${narrativeScaleGuidance(scale)}尺度只决定观察焦点，不决定冲突强度或故事时间速度；宏观不等于阴谋或冲突，中观不等于组织对抗，微观不等于恋爱。不得为了匹配尺度创造陌生人物、阴谋、灾难或转折。`,
        '用户本轮明确提出的创作要求优先；所有发展仍须符合既有事实、人物动机、时间条件、因果与用户选择边界。',
    ].join('\n');
}
