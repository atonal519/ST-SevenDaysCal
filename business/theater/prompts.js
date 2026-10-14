export function buildWriteMessages(userInput, story = null, settings = {}) {
    const context = story || { sysBlocks: [], userName: '用户', charName: '角色' };
    const sysParts = [
        `为 ${context.userName} 与 ${context.charName} 写独立小剧场（if 线 / 番外），不当作主楼事实。`,
        settings.theaterStylePrompt ? String(settings.theaterStylePrompt).trim() : '',
        ...(Array.isArray(context.sysBlocks) ? context.sysBlocks : []),
        `【写作要求】`,
        `- 遵照需求、模板原文和上方设定；未指定处可合理创作`,
        `- 直接给正文，不加解释、标题或代码围栏；用动作、感官和对话呈现变化。篇幅按需求，未指定则自然收束`,
    ].filter(Boolean);
    return [{ role: 'system', content: sysParts.join('\n\n') }, { role: 'user', content: String(userInput || '').trim() }];
}

const DEFAULT_BEAUTIFY = `将原文排成适合阅读的 HTML 片段，只调整版式，保留全部文字，不增删或改写情节、标题。
用一层 <div class="sp-theater-prose"> 包住正文，段落用 <p>；只在原文确有对应结构时使用 .sp-theater-scene-break、.sp-theater-inset、.sp-theater-aside、.sp-theater-emphasis。
不输出解释、标题、代码围栏或 html/head/body/style/script；不用行内样式、外部资源或其他自造 class。字号、颜色和间距交给页面 CSS。
直接输出 HTML。`;

export function buildBeautifyMessages(raw, settings = {}) {
    const system = settings.theaterBeautifyPrompt ? String(settings.theaterBeautifyPrompt).trim() : DEFAULT_BEAUTIFY;
    return [{ role: 'system', content: system }, { role: 'user', content: String(raw || '') }];
}
