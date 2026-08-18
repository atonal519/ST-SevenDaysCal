// theater.js — 棱（小剧场）for ST-SevenDaysCal
//
// 棱 = 构画几何体系第五元素：点(日程)/线(伏笔)/面(大纲)/间(局外聊天)/棱(小剧场)。
// 定位「if 线 / 番外 / 可能性」——一问一答式单轮小剧场生成器：
//   用户填场景+字数 → 写作 agent 出文本(raw) → 美化 agent 出 HTML → DOMPurify 渲染
//   → 可重生成/改输入 → 满意后填标题打标 → 存草稿(localStorage) / 升永久(chat_metadata)。
//
// 存储三层：
//   · 草稿层  localStorage，per-chat，sliding window（THEATER_DRAFT_CAP）
//   · 永久层  chat_metadata['sp-theater']，随 chat 文件走
//   · 模板库  专用世界书 TEMPLATE_BOOK（全局、独立 JSON、不进 settings.json、绝不注入 AI）
//
// 依赖注入（initTheater）：getSettings / callWriteApi / callBeautifyApi / getStoryContext。
// 世界书 CRUD 与 chat_metadata 直接走 getContext()，跟 memory.js 同款。

import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { buildTheaterDraftKey } from './state.js';

const THEATER_KEY   = 'sp-theater';     // chat_metadata 永久层 key
const SCHEMA_VERSION = 1;
const THEATER_DRAFT_CAP = 10;           // 草稿 sliding window 上限
const TEMPLATE_BOOK = '构画-棱-小剧场模板';   // 专用世界书名（横杠命名，避开文件名 sanitize）

// ─── 依赖注入 ─────────────────────────────────────────────────────────────────
let _getSettings = () => ({
    theaterStylePrompt   : '',
    theaterBeautifyPrompt: '',
});
let _callWriteApi    = null;   // (messages, {maxTokens, signal}) => Promise<string>
let _callBeautifyApi = null;   // (messages, {maxTokens, signal}) => Promise<string>
let _getStoryContext = null;   // () => { sysBlocks:[], userName, charName }

// ─── 生成状态（供 index.js 查询 in-flight）─────────────────────────────────────
let _generating = false;
export function isTheaterGenerating() { return _generating; }
// 用户中止时同步复位：abort 信号传到 fetch → promise 链解开 → finally 复位是异步的，
// 中间若立刻再点生成，守卫会误报"正在生成中"。给个同步入口让 index.js 中止时立即清标志。
export function resetTheaterGenerating() { _generating = false; }

// ═══════════════════════════════════════════════════════════════════════════
//  草稿层（localStorage，per-chat）
// ═══════════════════════════════════════════════════════════════════════════

function draftKey() {
    const chatId = getContext().chatId;
    return buildTheaterDraftKey(chatId);
}

export function loadDrafts() {
    const key = draftKey();
    if (!key) return [];
    try {
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(arr) ? arr.filter(p => p && p.id) : [];
    } catch { return []; }
}

function saveDrafts(list) {
    const key = draftKey();
    if (!key) return;
    // sliding window：新挤旧，只留最近 CAP 条
    const trimmed = list.slice(-THEATER_DRAFT_CAP);
    try { localStorage.setItem(key, JSON.stringify(trimmed)); }
    catch (err) { console.warn('[SP theater] 草稿写入失败（可能超配额）:', err); }
}

// 生成后自动落草稿（sliding window）
function pushDraft(piece) {
    const list = loadDrafts();
    list.push(piece);
    saveDrafts(list);
}

export function deleteDraft(id) {
    saveDrafts(loadDrafts().filter(p => p.id !== id));
}

// ═══════════════════════════════════════════════════════════════════════════
//  永久层（chat_metadata['sp-theater']）—— 照抄 memory.js meta()/persist()
// ═══════════════════════════════════════════════════════════════════════════

function freshMeta() {
    return { version: SCHEMA_VERSION, saved: [] };
}

function meta() {
    const ctx = getContext();
    if (!ctx.chatMetadata[THEATER_KEY]) {
        ctx.chatMetadata[THEATER_KEY] = freshMeta();
    }
    const m = ctx.chatMetadata[THEATER_KEY];
    if (m.version !== SCHEMA_VERSION) {
        // v1 是初版，没有历史结构要迁移；未来 bump 时在此处理。直接补齐字段。
        if (!Array.isArray(m.saved)) m.saved = [];
        m.version = SCHEMA_VERSION;
        persist();
    }
    return ctx.chatMetadata[THEATER_KEY];
}

function persist() {
    // 立即落盘（同 store.js persist）：避免切档取消防抖导致棱永久层丢失。
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.saveMetadata) ctx.saveMetadata();
    else ctx.saveMetadataDebounced?.();
}

export function loadSaved() {
    return meta().saved.slice();
}

// 升永久：把一条草稿（或当前渲染结果）落进 chat_metadata。带上用户填的标题/标签。
export function promoteToSaved(piece) {
    const m = meta();
    if (m.saved.some(p => p.id === piece.id)) return; // 幂等，避免重复升
    m.saved.push({ ...piece });
    persist();
}

export function deleteSaved(id) {
    const m = meta();
    const before = m.saved.length;
    m.saved = m.saved.filter(p => p.id !== id);
    if (m.saved.length !== before) persist();
}

// ═══════════════════════════════════════════════════════════════════════════
//  模板库（专用世界书，全局，绝不注入 AI）
// ═══════════════════════════════════════════════════════════════════════════
//
// 一条模板 = 一条 WI entry：comment=标题、content=正文、disable=true（双保险）。
// 对外暴露为 { uid, title, text }。该书永不加进 selected_world_info / 角色卡 link /
// chat lore —— ST 只扫被选中的书，故绝不会进任何生成上下文。

// 确保专用书存在并返回其 data（{ entries:{uid:entry} }）。不用 createNewWorldInfo
// （它会 trigger('change') 强切 ST 世界书编辑器 UI）；改为空书直存 + 刷新列表。
//
// 「书是否存在」以 loadWorldInfo 的实际返回为准（读服务端/缓存，按书名直取），
// **绝不**信任内存名单 getWorldInfoNames()/world_names——用户在 ST 里删过本书再重建后，
// 该名单可能与磁盘失同步。一旦据此误判「书不存在」，下面就会用空书覆盖掉磁盘上的真书，
// 把已存的模板全顶掉（正是用户报的 bug）。loadWorldInfo 内部对认不出的名字会退回原样
// 按名取（resolveWorldInfoName 找不到就 fallback 到原名），故名单失同步也能读到真书。
async function ensureBook() {
    const ctx = getContext();
    const data = await ctx.loadWorldInfo(TEMPLATE_BOOK);
    if (data) return data.entries ? data : { entries: {} };
    // loadWorldInfo 返回空 = 服务端确实没有这本书 → 建一本空书（顺带刷新名单，best-effort）。
    await ctx.saveWorldInfo(TEMPLATE_BOOK, { entries: {} }, true);
    await ctx.updateWorldInfoList?.();
    return { entries: {} };
}

function entryToTemplate(uid, entry) {
    return {
        uid   : String(uid),
        title : String(entry.comment || '').trim() || '(无标题)',
        text  : String(entry.content || ''),
    };
}

export async function listTemplates() {
    const ctx = getContext();
    // 同 ensureBook：以 loadWorldInfo 实际返回为准，不因内存名单缺名就误报「暂无模板」。
    // 只读不建——书真没有时 loadWorldInfo 返回空，直接返回 []，不主动创建。
    const data = await ctx.loadWorldInfo(TEMPLATE_BOOK);
    if (!data || !data.entries) return [];
    return Object.entries(data.entries)
        .map(([uid, entry]) => entryToTemplate(uid, entry))
        .sort((a, b) => Number(a.uid) - Number(b.uid));
}

// 新建一条模板 WI 条目。优先用 context 的 worldInfoEntry.create；老版 ST 的 context
// 上没有 worldInfoEntry 对象（旧版会报 "reading 'create' of undefined"），退回手动
// 分配 uid + 最小条目模板。本书为构画私有、永不注入，字段够读写即可。
function createTemplateEntry(ctx, data) {
    if (ctx.worldInfoEntry?.create) return ctx.worldInfoEntry.create(TEMPLATE_BOOK, data);
    let uid = 0;
    while (uid in data.entries) uid++;
    const entry = {
        uid, key: [], keysecondary: [], comment: '', content: '',
        constant: false, vectorized: false, selective: true, selectiveLogic: 0,
        order: 100, position: 0, disable: true, excludeRecursion: false,
        preventRecursion: false, probability: 100, useProbability: true, depth: 4,
    };
    data.entries[uid] = entry;
    return entry;
}

export async function addTemplate(title, text) {
    const ctx = getContext();
    const data = await ensureBook();
    const entry = createTemplateEntry(ctx, data);
    if (!entry) throw new Error('无法创建模板条目');
    entry.comment = String(title || '').trim();
    entry.content = String(text || '');
    entry.disable = true;   // 双保险：即便该书被误选中，条目也不激活
    entry.key = [];
    entry.constant = false;
    await ctx.saveWorldInfo(TEMPLATE_BOOK, data, true);
    return entryToTemplate(entry.uid, entry);
}

// 批量新增：一次 ensureBook + 循环 create（复用同一 data 对象，uid 分配互不冲突）+ **一次** saveWorldInfo。
// 上千条时逐条 addTemplate 会触发上千次 load/save，必卡；批量把磁盘 I/O 收敛成一次。
// items: [{ title, text }]。返回成功入库条数。
export async function addTemplatesBatch(items) {
    const list = (Array.isArray(items) ? items : []).filter(it => it && (String(it.title || '').trim() || String(it.text || '').trim()));
    if (!list.length) return 0;
    const ctx = getContext();
    const data = await ensureBook();
    for (const it of list) {
        const entry = createTemplateEntry(ctx, data);
        if (!entry) continue;
        entry.comment  = String(it.title || '').trim();
        entry.content  = String(it.text || '');
        entry.disable  = true;
        entry.key      = [];
        entry.constant = false;
    }
    await ctx.saveWorldInfo(TEMPLATE_BOOK, data, true);
    return list.length;
}

export async function updateTemplate(uid, title, text) {
    const ctx = getContext();
    const data = await ctx.loadWorldInfo(TEMPLATE_BOOK);
    if (!data || !data.entries || !data.entries[uid]) return;
    data.entries[uid].comment = String(title || '').trim();
    data.entries[uid].content = String(text || '');
    data.entries[uid].disable = true;
    await ctx.saveWorldInfo(TEMPLATE_BOOK, data, true);
}

export async function deleteTemplate(uid) {
    const ctx = getContext();
    const data = await ctx.loadWorldInfo(TEMPLATE_BOOK);
    if (!data || !data.entries || !data.entries[uid]) return;
    delete data.entries[uid];
    await ctx.saveWorldInfo(TEMPLATE_BOOK, data, true);
}

// ═══════════════════════════════════════════════════════════════════════════
//  本机缓存治理（localStorage 里的「设备相关」键：界面位置 + 棱草稿）
// ═══════════════════════════════════════════════════════════════════════════
//
// 2.0.0 起点/线/面/间产物已迁进 chat_metadata，localStorage 只该留设备相关的东西：
//   · 界面位置    sp-fab-pos / sp-outline-chat-h / sp-pos / sp-size
//   · 棱草稿      sp-cache-{chatId}-theater-draft-user（滑窗草稿，不跨设备）
// **绝不能**再无脑清所有 sp- 键：老用户没访问过的聊天，其点/线/面/间还以
// sp-cache-{chatId}-{kind}-{scope} 的形态躺在 localStorage 里、等 CHAT_CHANGED 懒迁移；
// 若在此被清就是数据丢失。故 isDeviceLocalKey 精确圈定「界面位置 + 棱草稿」，其余一律不碰。

const UI_LOCAL_KEYS = ['sp-fab-pos', 'sp-outline-chat-h', 'sp-pos', 'sp-size'];

function isDeviceLocalKey(k) {
    if (!k) return false;
    if (UI_LOCAL_KEYS.includes(k)) return true;
    // 棱草稿：sp-cache-{chatId}-theater-draft-user（唯一带 theater-draft 段的 sp-cache 键）
    return k.startsWith('sp-cache-') && /-theater-draft(-|$)/.test(k);
}

export function pluginCacheBytes() {
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!isDeviceLocalKey(k)) continue;
        const v = localStorage.getItem(k) || '';
        bytes += (k.length + v.length) * 2; // UTF-16
    }
    return bytes;
}

export function clearPluginCache() {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (isDeviceLocalKey(k)) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
    return doomed.length;
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  生成管线（两段式 agent，对齐真实 API postChatCompletion）
// ═══════════════════════════════════════════════════════════════════════════

function buildWriteMessages(userInput) {
    const s = _getSettings();
    const story = _getStoryContext ? _getStoryContext() : { sysBlocks: [], userName: '用户', charName: '角色' };

    const sysParts = [
        `你是一位小说家，正在为 ${story.userName} 与 ${story.charName} 的故事创作一段独立小剧场（if 线 / 番外 / 可能性）。`,
        // 写作提示词（文风 + 范文合并为一栏，方便整段粘贴预设）
        s.theaterStylePrompt ? String(s.theaterStylePrompt).trim() : '',
        ...(Array.isArray(story.sysBlocks) ? story.sysBlocks : []),
        `【写作要求】`,
        `- 直接写正文，不要解释、不要前言后语、不要写标题`,
        `- 具象的感官与动作描写，避免概括与套路化开头结尾`,
        `- 篇幅按需求或模板中的说明来；未指定则自然收束，不必强行拉长`,
    ].filter(Boolean);

    return [
        { role: 'system', content: sysParts.join('\n\n') },
        { role: 'user',   content: String(userInput || '').trim() },
    ];
}

function buildBeautifyMessages(raw) {
    const s = _getSettings();
    const defaultBeautify =
`你是一个 HTML 排版师。把用户给的小说文本转成一段**克制、适合阅读的 HTML 片段**用于网页展示。
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
    const sys = s.theaterBeautifyPrompt ? String(s.theaterBeautifyPrompt).trim() : defaultBeautify;
    return [
        { role: 'system', content: sys },
        { role: 'user',   content: String(raw || '') },
    ];
}

// DOMPurify 净化：FORBID_TAGS:['style'] 剥掉 <style> 块（美化限 inline style），
// 默认已禁 <script>/on* 事件，从根上杜绝样式泄漏与脚本注入。
function sanitizeHtml(htmlRaw) {
    const purifier = globalThis.DOMPurify;
    if (purifier && typeof purifier.sanitize === 'function') {
        return purifier.sanitize(String(htmlRaw || ''), { FORBID_TAGS: ['style'] });
    }
    // DOMPurify 不可用（理论不会）——退回纯文本转义，绝不放行裸 HTML
    console.warn('[SP theater] DOMPurify 不可用，退回纯文本');
    const div = document.createElement('div');
    div.textContent = String(htmlRaw || '');
    return div.innerHTML;
}

// 生成一段小剧场。返回 { piece } 或抛错。piece 已自动落草稿。
// onStage(stageText) 供 UI 更新 loading 文案（'写作' / '美化'）。
export async function generate(userInput, { signal, onStage, templateSource = null } = {}) {
    if (_generating) throw new Error('正在生成中，请稍候');
    if (!String(userInput || '').trim()) throw new Error('请先填写小剧场需求');
    if (!_callWriteApi || !_callBeautifyApi) throw new Error('棱未正确初始化');

    _generating = true;
    // 字数交给需求/模板提示词约束；这里给足生成预算（30000），推理模型也不易被思维链挤空
    const writeMaxTokens = 30000;

    try {
        // ── Agent 1：写作（棱=折射）──
        onStage?.('折射');
        const raw = await _callWriteApi(buildWriteMessages(userInput), {
            maxTokens: writeMaxTokens,
            signal,
        });
        if (!String(raw || '').trim()) throw new Error('写作 agent 返回为空，请重试或改输入');

        // ── Agent 2：美化（渲染）──
        onStage?.('渲染');
        let htmlRaw = '';
        try {
            htmlRaw = await _callBeautifyApi(buildBeautifyMessages(raw), {
                maxTokens: writeMaxTokens,
                signal,
            });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            console.warn('[SP theater] 美化 agent 失败，退回纯文本渲染:', err);
        }
        // 美化空/异常 → fallback：交给 index.js 的 renderAiMessageHtml（注入为兜底渲染器）
        const html = String(htmlRaw || '').trim()
            ? sanitizeHtml(htmlRaw)
            : sanitizeHtml(_fallbackRender ? _fallbackRender(raw) : raw);

        const piece = {
            id   : (crypto?.randomUUID?.() || `t-${Date.now()}-${Math.floor(performance.now())}`),
            title: '',
            raw  : String(raw),
            html,
            ts   : Date.now(),
            // 保存生成当刻实际输入；模板改名/删除或用户二次编辑后，回看仍准确。
            templateSource: templateSource?.input
                ? { uid: String(templateSource.uid || ''), title: String(templateSource.title || '(无标题)'), input: String(templateSource.input) }
                : undefined,
        };
        pushDraft(piece);   // 自动落草稿（sliding window）
        return { piece };
    } finally {
        _generating = false;
    }
}

// 兜底渲染器（美化失败时把 raw 走 ST messageFormatting），由 index.js 注入
let _fallbackRender = null;

// ═══════════════════════════════════════════════════════════════════════════
//  init
// ═══════════════════════════════════════════════════════════════════════════

let _listeners = { chat: null };

export function initTheater({ getSettings, callWriteApi, callBeautifyApi, getStoryContext, fallbackRender } = {}) {
    if (getSettings)     _getSettings = getSettings;
    if (callWriteApi)    _callWriteApi = callWriteApi;
    if (callBeautifyApi) _callBeautifyApi = callBeautifyApi;
    if (getStoryContext) _getStoryContext = getStoryContext;
    if (fallbackRender)  _fallbackRender = fallbackRender;

    // 切 chat 时清生成标志（in-flight fetch 的 abort 由 index.js 的 controller 负责）
    const off = (evt, fn) => { if (fn) eventSource.removeListener?.(evt, fn); };
    off(event_types.CHAT_CHANGED, _listeners.chat);
    _listeners.chat = () => { _generating = false; };
    eventSource.on(event_types.CHAT_CHANGED, _listeners.chat);
}

export { TEMPLATE_BOOK, THEATER_DRAFT_CAP };
