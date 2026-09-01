import { buildOutlineCreationContract } from './business/outline/prompts.js';

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

// 棱（小剧场）草稿层：per-chat，不分我/TA 视角（view 恒 'user'）。
export function buildTheaterDraftKey(chatId) {
    return buildCacheKey(chatId, 'theater-draft', 'user');
}

export function getCreativeChatPlaceholder() {
    return '和 AI 讨论剧情、面或设定…';
}

// 面创作顾问的「表达分寸」——正面基调（柔和客观·公平公正·含蓄内敛）为主，末句留软口子：
// 默认如此，用户明确要求某种风格、或剧情设定确需时以用户/设定为准（创作工具，不一刀切禁激烈剧情）。
// 四条各对应一类要收敛的引导：情绪平稳←极端情绪 / 立场中允←冲突偏向 / 表达得体←油腻发言 / 语气真诚←阴阳口吻。
const ADVISOR_TONE_GUIDE = [
    `\n【表达分寸】作为创作顾问，默认保持柔和客观、公平公正、含蓄内敛：`,
    `- 情绪平稳：与用户讨论时语气平和理性，不用煽动性表达替用户放大情绪。`,
    `- 立场中允：分析角色关系或剧情冲突时兼顾各方动机，不预设偏袒某一方、不替用户下评判。`,
    `- 表达得体：措辞含蓄克制，不刻意煽情、不油腻谄媚、不堆砌暧昧辞藻。`,
    `- 语气真诚：就事论事、坦诚直接，不阴阳怪气、不夹枪带棒。`,
    `这些规则只约束与用户讨论时的顾问口吻，不限制所创作的大纲内容；合理的强烈情绪、冲突、危机或大开大合应按剧情需要充分呈现。当用户明确要求某种表达风格时，以用户要求为准。`,
].join('\n');

export function buildCreativeChatSystemPrompt({ userName, charName, personaDesc = '', authorNote = '', outlineRaw = '', wiContext = '', recentCtx = '', almanacText = '', calDescText = '' }) {
    const outlineSection = outlineRaw
        ? `\n当前大纲：\n${outlineRaw}\n`
        : '\n当前还没有既定大纲，可先从灵感、剧情走向、角色关系、人物设定或世界观想法开始讨论。\n';

    // 已有大纲时：改大纲走增量修改，避免用户只改一个细节却整份重刷。
    const editRule = outlineRaw
        ? `\n【修改已有大纲时（重要）】上方"当前大纲"已存在。当用户要求修改、调整、补充或改某个细节时，必须在它的基础上做**增量修改**：只改动用户明确指出的部分，其余节点**逐字原样保留**（Beat/Scene/Subtext/Think 一字不动、顺序不变、数量不变），不得擅自重写或润色未提及的节点。输出时仍给出**完整的** <outline_widget>（含所有未改动节点、每个节点四行写满），供面板整体解析；不要只回改动的那一节、不要用省略号带过未改节点。`
        : '';

    return [
        `你是一位故事创作顾问，正在帮助用户和 ${charName} 讨论 ${userName} 与 ${charName} 的故事发展。${outlineSection}`,
        personaDesc ? `【${userName} 的人物设定】\n${personaDesc}` : '',
        authorNote  ? `【作者注释（当前聊天）】\n${authorNote}` : '',
        wiContext,
        almanacText ? `【本世界观·重要日期（历）】一年之中的既定节日、生日、纪念日（按月日排序）：\n${almanacText}\n讨论剧情走向或排布大纲时间线时，若临近或涉及这些日子，应自然纳入考量，使故事与该世界的历法自洽。` : '',
        calDescText ? `【本世界观·现行历法（纪年）】${calDescText}\n排布大纲时间线、给节点推演时间时，以此历法为准（月份数、每月天数、纪年名），不要默认套用公历。` : '',
        recentCtx,
        `请以创作顾问身份回答，不要扮演任何角色。默认优先围绕剧情发展、设定补完、角色关系与灵感发散来回应。只有当用户明确要求你"写大纲"、明确要求输出大纲，或使用“生成面”“写面”“给一版面”“输出面”等同义的明确指令时，才输出完整大纲，并使用 <outline_widget>...</outline_widget> 包裹；普通讨论、比较、构思或询问方案时，不强制输出大纲；其他时间不要输出 <outline_widget> 标签。`,
        `【这只是供讨论对比的草稿】你在对话框里给出的大纲**不会自动生效**，是否覆盖上层的正式大纲，由用户自行点击"应用此面"按钮决定。因此：不要在回复里声称大纲"已更新/已应用/已保存"，也不要因为"怕覆盖"就偷工减料、只给片段——正常完整地输出即可，应用与否交给用户。`,
        editRule,
        ADVISOR_TONE_GUIDE,
        buildOutlineCreationContract(),
    ].filter(Boolean).join('\n');
}
