function normalizeScopePart(value, fallback = 'default') {
    const text = String(value ?? '').trim();
    return text ? encodeURIComponent(text) : fallback;
}

export function buildScheduleCacheKey(chatId, view = 'user', charName = '') {
    if (!chatId) return null;
    if (view === 'char' && charName) return `sp-cache-${chatId}-char-${normalizeScopePart(charName)}`;
    return `sp-cache-${chatId}-user`;
}

export function buildOutlineCacheKey(chatId, view = 'user', charName = '') {
    if (!chatId) return null;
    if (view === 'char' && charName) return `sp-cache-${chatId}-outline-char-${normalizeScopePart(charName)}`;
    return `sp-cache-${chatId}-outline-user`;
}

export function buildCreativeChatHistoryKey(chatId, view = 'user', charName = '') {
    if (!chatId) return null;
    if (view === 'char' && charName) return `sp-cache-${chatId}-creative-chat-char-${normalizeScopePart(charName)}`;
    return `sp-cache-${chatId}-creative-chat-user`;
}

export function getCreativeChatPlaceholder() {
    return '和 AI 讨论剧情、大纲或设定…';
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
