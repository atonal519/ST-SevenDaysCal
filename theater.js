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
// 依赖注入（initTheater）：getSettings / callWriteApi / callBeautifyApi / fallbackRender。
// 本文件只保留旧调用面的兼容透传；具体生成、存储与模板语义由 business/theater 持有。

import { getContext } from '../../../extensions.js';
import { buildTheaterDraftKey } from './state.js';
import { createTheaterGeneration } from './business/theater/generation.js';
import { createTheaterRepository } from './business/theater/repository.js';
import { buildWriteMessages as buildTheaterWriteMessages, buildBeautifyMessages as buildTheaterBeautifyMessages } from './business/theater/prompts.js';
import { sanitizeHtml as sanitizeTheaterHtml, safePlainTextHtml as safeTheaterPlainTextHtml } from './business/theater/html.js';
import { createTheaterTemplates, parseTemplateText } from './business/theater/templates.js';

const THEATER_KEY   = 'sp-theater';     // chat_metadata 永久层 key
const SCHEMA_VERSION = 1;
const THEATER_DRAFT_CAP = 10;           // 草稿 sliding window 上限
const TEMPLATE_BOOK = '构画-棱-小剧场模板';   // 专用世界书名（横杠命名，避开文件名 sanitize）
const repository = createTheaterRepository({
    storage: globalThis.localStorage,
    metadata: () => { const ctx = getContext(); ctx.chatMetadata ||= {}; return ctx.chatMetadata[THEATER_KEY] || (ctx.chatMetadata[THEATER_KEY] = { version: SCHEMA_VERSION, saved: [] }); },
    persist: () => getContext()?.saveMetadata?.(),
    keyForChat: chatId => buildTheaterDraftKey(chatId),
});
const templates = createTheaterTemplates({ context: () => getContext(), bookName: TEMPLATE_BOOK });

// ─── 依赖注入 ─────────────────────────────────────────────────────────────────
let _getSettings = () => ({
    theaterStylePrompt   : '',
    theaterBeautifyPrompt: '',
});
let _callWriteApi    = null;   // (messages, {maxTokens, signal}) => Promise<string>
let _callBeautifyApi = null;   // (messages, {maxTokens, signal}) => Promise<string>
let _pureGeneration = null;

// ─── 兼容 facade helper ───────────────────────────────────────────────────────

// 重新生成只能沿用当前 piece 真实记录的来源；不得读取用户后来点选但尚未用于
// 生成的全局模板状态。返回值同时作为 index.js 的请求输入和来源快照，避免两套决策。
export function resolveTheaterRegen(piece, fallbackInput = '') {
    const input = String(piece?.request || piece?.templateSource?.input || fallbackInput || '').trim();
    const source = piece?.templateSource?.input
        ? { ...piece.templateSource, input: String(piece.templateSource.input).trim() }
        : null;
    return { input, templateSource: source };
}

// ═══════════════════════════════════════════════════════════════════════════
//  草稿层（localStorage，per-chat）
// ═══════════════════════════════════════════════════════════════════════════

export function loadDrafts(chatId) { return repository.loadDrafts(chatId); }
export function updateDraft(chatId, id, patch) { return repository.updateDraft(chatId, id, patch); }
export function deleteDraft(chatId, id) { return repository.deleteDraft(chatId, id); }

// ═══════════════════════════════════════════════════════════════════════════
//  永久层（chat_metadata['sp-theater']）—— 照抄 memory.js meta()/persist()
// ═══════════════════════════════════════════════════════════════════════════

export function loadSaved(target = null) { return repository.loadSaved(target); }
export function captureTheaterTarget(chatId = getContext()?.chatId) {
    const ctx = getContext();
    return { chatId, metadata: ctx?.chatMetadata?.[THEATER_KEY] || (ctx?.chatMetadata ? (ctx.chatMetadata[THEATER_KEY] = { version: SCHEMA_VERSION, saved: [] }) : null), persist: () => getContext()?.saveMetadata?.(), isCurrent: () => getContext()?.chatId === chatId };
}
export function promoteToSaved(chatId, piece, target = captureTheaterTarget(chatId)) { return repository.promoteToSaved({ ...target, chatId }, piece); }
export function deleteSaved(chatId, id, target = captureTheaterTarget(chatId)) { return repository.deleteSaved({ ...target, chatId }, id); }

// ═══════════════════════════════════════════════════════════════════════════
//  模板库（专用世界书，全局，绝不注入 AI）
// ═══════════════════════════════════════════════════════════════════════════
//
// 一条模板 = 一条 WI entry：comment=标题、content=正文、disable=true（双保险）。
// 对外暴露为 { uid, title, text }。该书永不加进 selected_world_info / 角色卡 link /
// chat lore —— ST 只扫被选中的书，故绝不会进任何生成上下文。

export async function listTemplates() {
    return templates.list();
}

export async function addTemplate(title, text) {
    return templates.add(title, text);
}

// 批量新增：一次 ensureBook + 循环 create（复用同一 data 对象，uid 分配互不冲突）+ **一次** saveWorldInfo。
// 上千条时逐条 addTemplate 会触发上千次 load/save，必卡；批量把磁盘 I/O 收敛成一次。
// items: [{ title, text }]。返回成功入库条数。
export async function addTemplatesBatch(items) {
    return templates.addBatch(items);
}
export { parseTemplateText };

export async function updateTemplate(uid, title, text) {
    return templates.update(uid, title, text);
}

export async function deleteTemplate(uid) {
    return templates.remove(uid);
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

// 生成一段小剧场。纯管线只返回 piece 或抛错；owner/controller 校验后才允许落草稿。
export async function generate(userInput, options = {}) {
    if (!_pureGeneration) throw new Error('棱未正确初始化');
    return _pureGeneration(userInput, options);
}

// 兜底渲染器（美化失败时把 raw 走 ST messageFormatting），由 index.js 注入
let _fallbackRender = null;

// ═══════════════════════════════════════════════════════════════════════════
//  init
// ═══════════════════════════════════════════════════════════════════════════

export function initTheater({ getSettings, callWriteApi, callBeautifyApi, fallbackRender } = {}) {
    if (getSettings)     _getSettings = getSettings;
    if (callWriteApi)    _callWriteApi = callWriteApi;
    if (callBeautifyApi) _callBeautifyApi = callBeautifyApi;
    if (fallbackRender)  _fallbackRender = fallbackRender;
    _pureGeneration = createTheaterGeneration({
        write: _callWriteApi,
        beautify: _callBeautifyApi,
        buildWriteMessages: (input, options) => buildTheaterWriteMessages(input, {
            ...(options?.storyContext || {}),
            userName: options?.userName || '用户',
            charName: options?.charName || '角色',
            sysBlocks: Array.isArray(options?.storyContext?.sysBlocks) ? options.storyContext.sysBlocks : [],
        }, _getSettings()),
        buildBeautifyMessages: (raw) => buildTheaterBeautifyMessages(raw, _getSettings()),
        sanitize: sanitizeTheaterHtml,
        fallback: value => _fallbackRender ? _fallbackRender(value) : value,
        plainTextFallback: raw => safeTheaterPlainTextHtml(raw),
    });

}

export { TEMPLATE_BOOK, THEATER_DRAFT_CAP };
