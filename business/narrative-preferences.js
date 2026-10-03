import { lineDirectionContract } from './lines/direction.js';

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
