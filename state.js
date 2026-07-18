function normalizeScopePart(value, fallback = 'default') {
    const text = String(value ?? '').trim();
    return text ? encodeURIComponent(text) : fallback;
}

// One shared cache key builder — historical per-kind builders below delegate here.
// Format: sp-cache-{chatId}-{kind}-{user | char-<name>}
function buildCacheKey(chatId, kind, view = 'user', charName = '') {
    if (!chatId) return null;
    const scope = (view === 'char' && charName)
        ? `char-${normalizeScopePart(charName)}`
        : 'user';
    // 'schedule' is the original bare kind ('sp-cache-{chatId}-user'), keep that
    // shape for backward compat with existing localStorage entries.
    return kind === 'schedule'
        ? `sp-cache-${chatId}-${scope}`
        : `sp-cache-${chatId}-${kind}-${scope}`;
}

export function buildScheduleCacheKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'schedule', view, charName);
}

export function buildOutlineCacheKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'outline', view, charName);
}

export function buildStorylinesCacheKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'lines', view, charName);
}

export function buildCreativeChatHistoryKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'creative-chat', view, charName);
}

export function buildSpaceChatHistoryKey(chatId, view = 'user', charName = '') {
    return buildCacheKey(chatId, 'space-chat', view, charName);
}

export function getCreativeChatPlaceholder() {
    return '和 AI 讨论剧情、面或设定…';
}

export function getSpaceChatPlaceholder() {
    return '局外聊聊：剧情、设定、关系、知识…';
}

export function buildCreativeChatSystemPrompt({ userName, charName, outlineRaw = '', wiContext = '' }) {
    const outlineSection = outlineRaw
        ? `\n当前大纲：\n${outlineRaw}\n`
        : '\n当前还没有既定大纲，可先从灵感、剧情走向、角色关系、人物设定或世界观想法开始讨论。\n';

    return [
        `你是一位故事创作顾问，正在帮助用户和 ${charName} 讨论 ${userName} 与 ${charName} 的故事发展。${outlineSection}`,
        wiContext,
        '请以创作顾问身份回答，不要扮演任何角色。默认优先围绕剧情发展、设定补完、角色关系与灵感发散来回应。只有当用户明确要求你“写大纲”或明确要求输出大纲时，才输出完整的新大纲，并使用 <outline_widget>...</outline_widget> 包裹；其他时间不要输出 <outline_widget> 标签。',
    ].filter(Boolean).join('\n');
}

export function buildSpaceChatSystemPrompt({ userName, charName, outlineRaw = '', wiContext = '', memText = '' }) {
    const parts = [
        `你是一位万事屈臣的创作顾问与知识帮手，在 ${userName} 与 ${charName} 的故事之外（"局外聊天"）陪用户讨论。`,
        `当前不推进剧情、不扮演任何角色，只回答用户的问题——包括但不限于剧情走向、设定考据、人物关系推演、发展方向的可行性、创作技巧、以及历史/服饰/地理/风俗/科学等现实世界知识。`,
        outlineRaw ? `\n【当前面（大纲）】\n${outlineRaw}` : '',
        wiContext,
        memText ? `\n【故事记忆】\n${memText}` : '',
        `\n请以顾问口吻直接回答用户的问题。不要输出 <outline_widget> 等结构化标签。`,
    ];
    return parts.filter(Boolean).join('\n');
}
