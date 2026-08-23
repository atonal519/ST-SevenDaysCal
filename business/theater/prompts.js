export function buildWriteMessages(userInput, story = null, settings = {}) {
    const context = story || { sysBlocks: [], userName: '用户', charName: '角色' };
    const sysParts = [
        `你是一位小说家，正在为 ${context.userName} 与 ${context.charName} 的故事创作一段独立小剧场（if 线 / 番外 / 可能性）。`,
        settings.theaterStylePrompt ? String(settings.theaterStylePrompt).trim() : '',
        ...(Array.isArray(context.sysBlocks) ? context.sysBlocks : []),
        `【写作要求】`,
        `- 直接写正文，不要解释、不要前言后语、不要写标题`,
        `- 具象的感官与动作描写，避免概括与套路化开头结尾`,
        `- 篇幅按需求或模板中的说明来；未指定则自然收束，不必强行拉长`,
    ].filter(Boolean);
    return [{ role: 'system', content: sysParts.join('\n\n') }, { role: 'user', content: String(userInput || '').trim() }];
}

const DEFAULT_BEAUTIFY = `你是一个 HTML 排版师。把用户给的小说文本转成一段**克制、适合阅读的 HTML 片段**用于网页展示。
【硬性约束】
- 绝对不要写 <style> 标签、不要写 <script>、不要引用外部 CSS/字体/图片；根容器及四类固定语义元素的颜色、背景、边框、字号、间距等视觉表现交给页面 CSS，禁止在这些元素上用行内 style 覆盖
- 不要写 <html>/<head>/<body> 外壳，只输出可直接插入的片段
- 最外层请使用一个语义根容器，例如 <div class="sp-theater-prose">；普通正文仍以正常 <p> 段落为主，禁止把每段做成卡片
- 只按原文真实结构、少量使用以下固定语义类，不要自由发明类名：转场/原文分隔处用 .sp-theater-scene-break；原文确实包含信件、聊天记录、便签、广播、档案等文中载体时用 .sp-theater-inset；原文确实存在适合弱化呈现的心声、回忆或旁逸文字时用 .sp-theater-aside；仅包裹少量原文关键短句时用 .sp-theater-emphasis
- 如果原文没有分隔符、但确实需要一个装饰性转场，必须精确输出无任何空格、换行或文本节点的 <div class="sp-theater-scene-break"></div>；如果原文已有 ***、—— 等分隔符，则保留原文并放入该元素，不要新增圆点文本
- 保留原文全部文字内容，不增删情节、不新增标题、标签、说明、图标文字，不改写内容；不得为了排版虚构结构
- **正文字号务必克制、偏小**：正文用约 13px（0.87em 左右），行高 1.6；绝对不要放大正文、不要用超大字号；标题（若有）最多 1.1em
- **不要拉大字间距**：不要设 letter-spacing（或设 0/normal），字与字之间保持正常间距
- 配色淡雅、留白舒适、适合阅读；容器不要设固定宽度，让它自适应面板；转场只用细线/小符号，文中载体只做低对比度轻框，旁逸文字柔和，关键短句少量强调
- 禁止固定宽度、夸张字号、动画、高饱和装饰和自由发明类名；普通结构优先使用正常标签并保持克制，不要重装饰；如确有基础排版需要，优先使用上述固定类
直接输出 HTML，不要用代码块包裹、不要解释。`;

export function buildBeautifyMessages(raw, settings = {}) {
    const system = settings.theaterBeautifyPrompt ? String(settings.theaterBeautifyPrompt).trim() : DEFAULT_BEAUTIFY;
    return [{ role: 'system', content: system }, { role: 'user', content: String(raw || '') }];
}
