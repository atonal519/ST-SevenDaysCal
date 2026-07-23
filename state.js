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

export function buildCreativeChatSystemPrompt({ userName, charName, outlineRaw = '', wiContext = '', recentCtx = '' }) {
    const outlineSection = outlineRaw
        ? `\n当前大纲：\n${outlineRaw}\n`
        : '\n当前还没有既定大纲，可先从灵感、剧情走向、角色关系、人物设定或世界观想法开始讨论。\n';

    return [
        `你是一位故事创作顾问，正在帮助用户和 ${charName} 讨论 ${userName} 与 ${charName} 的故事发展。${outlineSection}`,
        wiContext,
        recentCtx,
        '请以创作顾问身份回答，不要扮演任何角色。默认优先围绕剧情发展、设定补完、角色关系与灵感发散来回应。只有当用户明确要求你"写大纲"或明确要求输出大纲时，才输出完整的新大纲，并使用 <outline_widget>...</outline_widget> 包裹；其他时间不要输出 <outline_widget> 标签。',
    ].filter(Boolean).join('\n');
}

export function buildSpaceChatSystemPrompt({ userName, charName, outlineRaw = '', wiContext = '', memText = '', recentCtx = '' }) {
    const parts = [
        `你是 ${userName} 与 ${charName} 故事外的创作顾问。不推进剧情、不扮演角色，直接答问。`,
        outlineRaw ? `\n【当前大纲】\n${outlineRaw}` : '',
        wiContext,
        memText ? `\n【故事记忆】\n${memText}` : '',
        recentCtx,
        `\n回答风格：`,
        `- 尽可能用更少的文字阐述更多的内容，确保信息密度`,
        `- 长度由问题决定：一句能说清的绝不写两句；确实需要展开的（如剧情推演、设定考据），才分点铺陈`,
        `- 直接给结论，避免"其实"、"值得注意的是"、"综上所述"这类铺垫与总结`,
        `- 不输出 <outline_widget> 等结构化标签`,

        `\n【落地卡片：仅当用户明确要求把内容"落地"到某个系统时才触发，否则绝不输出卡片】`,
        `有两个系统，凭用户用词严格区分该出哪种卡片：`,
        `- 说"日程 / 日历 / 待办 / 点"（安排到某天某时的具体事项）→ 出【点】卡片，用 <schedule_widget>`,
        `- 说"伏笔 / 线索 / 线 / 事件线"（埋一条待推进的剧情线索）→ 出【线】卡片，用 <line_widget>`,
        `只输出对应的那**一张**卡片，不寒暄、不解释、不要两种都出。用户没提这些词时绝对不要输出卡片。`,
        `\n① 点卡片（日程/日历/待办/点），用 <schedule_widget> 包裹，格式严格如下（一行）：`,
        `<schedule_widget>Event: type|title|description|time|location|线头动态</schedule_widget>`,
        `- type 只能是 main / hidden / bond`,
        `- description：30 字以上，生活化口吻`,
        `- 线头动态：与此事件相关的其他角色同期动态，可为空`,
        `\n② 线卡片（伏笔/线索/线），用 <line_widget> 包裹：`,
        `<line_widget>`,
        `Line: name|type|stage|level|when|agency|stall`,
        `Desc: 事件线整体描述（30 字左右）`,
        `Next: 下一步或恢复条件（20 字左右）`,
        `</line_widget>`,
        `- type: 推进 / 冲突 / 情感 / 悬疑 / 成长 等剧情线类型`,
        `- stage: 冲突类用"萌芽/发酵/逼近/已爆发/已消散"，推进类用"筹备/执行/关键/已完成/已失败"`,
        `- level: 1-4 数字，激烈程度`,
        `- when: 时间锚点（如"近日"、"下周"、"未定"）`,
        `- agency: player（需推动）/ world（自演化）`,
        `- stall: true / false（是否停滞）`,
        `\n若用户觉得刚才生成的卡片不够好并给出修改建议（如"时间挪到晚上"），根据修改再输出一版新卡片，`,
        `不要修改历史卡片、也不要解释，直接给新版本让用户挑选应用哪个。`,
    ];
    return parts.filter(Boolean).join('\n');
}
