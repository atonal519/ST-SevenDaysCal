// 剧情倾向按稳定角色键保存在全局 settings；未知值回落 natural。线生成和开启后的潜伏注入
// 共用同一合同：只在同样有剧情证据的候选间调整优先级，不改变线 schema，也不强制结果。
export const LINE_DIRECTION_VALUES = Object.freeze(['natural', 'positive', 'conflict', 'tragic']);

export const LINE_DIRECTION_LABELS = Object.freeze({
    natural: '自然发展（按剧情证据决定）',
    positive: '温暖向好（和解 / 成长 / 互信 / 转机）',
    conflict: '冲突增强（碰撞 / 压力 / 两难）',
    tragic: '悲剧倾向（失败 / 失去 / 关系破裂）',
});

export function normalizeLineDirection(value) {
    return LINE_DIRECTION_VALUES.includes(value) ? value : 'natural';
}

export function lineDirectionGuidance(value) {
    switch (normalizeLineDirection(value)) {
        case 'positive':
            return '当前剧情倾向为「温暖向好」：在事实允许的多种合理走向中，优先和解、成长、互信与转机；不强行大团圆，也不抹掉合理代价。';
        case 'conflict':
            return '当前剧情倾向为「冲突增强」：在事实允许的多种合理走向中，优先立场碰撞、压力与两难；不得依靠角色降智、无依据误会或突然的极端伤害。';
        case 'tragic':
            return '当前剧情倾向为「悲剧倾向」：允许失败、失去与关系破裂逐步累积；必须有伏笔、动机与因果，不得突然施虐或凭空制造惨剧。';
        default:
            return '当前剧情倾向为「自然发展」：只按已有剧情证据、人物动机与因果选择走向，不预设向好、冲突或悲剧结果。';
    }
}

export function lineDirectionContract(value) {
    return `【剧情倾向·优先级而非强制结果】${lineDirectionGuidance(value)}倾向只能在同样有依据的候选走向之间调整优先级，不得扭曲既有事实、人物动机、时间条件与因果。`;
}
