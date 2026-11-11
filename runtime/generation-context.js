// 生成上下文的 reroll 隔离规则。保持为纯函数，供生产消息构建器与仓外动态测试共用。
export function stripRerollModuleArtifacts(text) {
    return String(text || '')
        .replace(/<(?:calendar|schedule|storylines|line|outline|almanac|era)_widget(?:\s[^>]*)?>[\s\S]*?<\/(?:calendar|schedule|storylines|line|outline|almanac|era)_widget>/gi, '')
        .replace(/<\/?(?:calendar|schedule|storylines|line|outline|almanac|era)_widget(?:\s[^>]*)?>/gi, '')
        .trim();
}

export function resolveAlmanacContextText(options = {}, readAlmanac = () => '') {
    return options.noAlmanac ? '' : String(readAlmanac?.() || '');
}

export function buildGenerationMemoryQuery(prompt, options = {}, almanacText = '') {
    if (!options.includeCurrentStoryTime) return String(prompt ?? '');
    // These section labels are produced by the axis context formatter.
    const upcoming = String(almanacText).split('【近期将至】')[1] || '';
    return upcoming.split('【全年其他重要日子】')[0].trim();
}

// reroll 旧模块隔离必须先于通用标签清洗：若用户把 almanac_widget 写进 keepTags，
// stripTags 会保留其中正文并仅剥标签；先删完整 widget 才能保证旧历不会以裸文本泄漏。
export function sanitizeGenerationContextText(text, { reroll = false, stripTags = value => String(value ?? '') } = {}) {
    const isolated = reroll ? stripRerollModuleArtifacts(text) : String(text ?? '');
    return stripTags(isolated);
}
