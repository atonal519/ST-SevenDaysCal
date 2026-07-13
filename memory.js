// memory.js — Story memory system for ST-SevenDaysCal
//
// Architecture (Plan C: single objective memory + view-tagged injection):
//
//   L0: floor-group summary — every N AI floors → 1 L0 entry (default N=5)
//   L1: chapter summary — every M L0 entries → 1 L1 entry (default M=10)
//
// All storage lives in chat_metadata[MEMORY_KEY]. Persists in the chat file
// server-side — no localStorage, follows the chat.
//
// The most recent group (containing the latest AI floor) is intentionally
// NEVER summarized, to survive rerolls. L0 for group [k*N .. (k+1)*N - 1]
// only fires once at least one AI floor beyond (k+1)*N-1 exists.
//
// Text content of each group is hashed and stored with the L0 entry. If any
// floor in the group changes (reroll / edit / swipe), the hash mismatches and
// the L0 is invalidated + requeued. This covers ST event unreliability.

import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const MEMORY_KEY = 'sp-memory';
const SCHEMA_VERSION = 2;   // v2 = grouped L0 (previous per-floor L0 layouts are migrated)

// ─── Settings (per-plugin, not per-chat) ─────────────────────────────────────
// Stored via caller; memory.js just reads them via a getter injected at init.

let _getSettings = () => ({
    memoryEnabled  : true,
    memoryL0Group  : 5,       // AI floors per L0 entry
    memoryL1Group  : 10,      // L0 entries per L1 chapter
    memorySkipShort: 50,      // skip AI floors shorter than N chars from L0 input
});

// ─── API caller injection ────────────────────────────────────────────────────
let _callApi = null;

// ─── State ───────────────────────────────────────────────────────────────────
let _queue = [];
let _running = false;
let _abortController = null;      // reserved for rebuild flow (see abortRebuild)
let _jobAbortController = null;   // shared signal for per-job fetches; aborted on CHAT_CHANGED

// ─── Utility: fast non-crypto hash ───────────────────────────────────────────
function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

// ─── chat_metadata access ────────────────────────────────────────────────────
function meta() {
    const ctx = getContext();
    if (!ctx.chatMetadata[MEMORY_KEY]) {
        ctx.chatMetadata[MEMORY_KEY] = freshMeta();
    }
    // Simple forward-compat: if a previous version's structure exists, wipe it
    // (users see "reconstruct needed" via the health report + can rebuild).
    const m = ctx.chatMetadata[MEMORY_KEY];
    if (m.version !== SCHEMA_VERSION) {
        ctx.chatMetadata[MEMORY_KEY] = freshMeta();
    }
    return ctx.chatMetadata[MEMORY_KEY];
}

function freshMeta() {
    return {
        version: SCHEMA_VERSION,
        L0: {},          // groupKey (e.g. "5-9") → { range: [startMid, endMid], text, hash, ts, failCount }
        L1: [],          // array of { range: [startMid, endMid], text, ts }
        failed: {},      // groupKey → { count, lastErr }
        system: { paused: false, consecutiveFails: 0, lastError: null },
    };
}

function persist() {
    const ctx = getContext();
    ctx.saveMetadataDebounced?.();
}

// ─── Chat helpers ────────────────────────────────────────────────────────────
function getChat() { return getContext().chat || []; }

// Returns all AI floors (including hidden — is_system=true means hidden in ST).
function getAiFloors() {
    const chat = getChat();
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (m && !m.is_user) out.push({ mesid: String(i), text: m.mes || '' });
    }
    return out;
}

// Group AI floors into fixed-size chunks. Returns array of groups, each:
// { key: "startMid-endMid", floors: [{mesid, text}, ...] }
// Latest group (containing the newest AI floor) is EXCLUDED — never summarized.
function getStableGroups() {
    const settings = _getSettings();
    const N = Math.max(1, +settings.memoryL0Group || 5);
    const floors = getAiFloors();
    const groups = [];
    for (let i = 0; i + N <= floors.length; i += N) {
        const slice = floors.slice(i, i + N);
        groups.push({
            key   : `${slice[0].mesid}-${slice[slice.length - 1].mesid}`,
            floors: slice,
        });
    }
    // If the last group ended exactly at the newest AI floor, drop it (delay-by-one rule)
    if (groups.length && floors.length && groups[groups.length - 1].floors.slice(-1)[0].mesid === floors[floors.length - 1].mesid) {
        groups.pop();
    }
    return groups;
}

// Hash the combined text of a group's floors — invalidates on any reroll/edit
function groupHash(group) {
    return hashStr(group.floors.map(f => f.text).join('\x1f'));
}

// ─── Prompts ─────────────────────────────────────────────────────────────────
function buildL0Prompt(prevSummary, groupFloors) {
    const skipShort = +_getSettings().memorySkipShort || 50;
    const body = groupFloors
        .filter(f => (f.text || '').trim().length >= skipShort || groupFloors.length === 1)
        .map((f, i) => `【楼 ${f.mesid}】\n${String(f.text || '').slice(0, 2000)}`)
        .join('\n\n');
    return [
        {
            role: 'system',
            content: `你是一个客观的第三方叙事记录员，负责将连续 ${groupFloors.length} 楼对话合并为结构化摘要。

【核心原则】
- 客观第三人称，不带感情色彩、不做代入、不做视角判断
- 记录"谁做了什么、谁说了什么、发生了什么"
- 时间描述优先级：① 原文里有具体年月日 → 用"YYYY-MM-DD" 或"YYYY年M月D日" + 时段（如"2024-03-15 上午"）；② 只有相对天数 → "第N天+时段"（如"第三天上午"）；③ 完全没有 → 填"未提及"。绝不做换算或推测。跨段之间不要把"第三天"和"3月15日"混用
- 只提取本组楼真实存在的内容，不脑补或推测
- 意味深长的对白、异常动作、未说完的话、说漏嘴等潜在伏笔，直接写进"事件"字段作为客观描述的一部分（如"李四提到父亲留下一封未开封的信"），不要单独归纳
- 若组内某楼是低价值闲聊或极短，可以在摘要里省略
- NSFW / 亲密内容不记录具体细节，只归纳成一句叙事性事实（如"两人发生关系"），除非其中包含承诺、真实伤害、身份揭示、怀孕、疾病等具有后续影响的重要事件
- 每个字段独立一行，格式严格`,
        },
        {
            role: 'user',
            content: `【前一段摘要（用于理解代词和上下文，可能为空）】
${prevSummary || '（无前文，本段是开始）'}

【本段原文（连续 ${groupFloors.length} 楼）】
${body}

请按以下字段结构提取信息，每字段一行，字段名后跟冒号，不要合并字段：

时间锚点: 本段的时间跨度，格式"起点 → 终点"（**优先使用绝对时间**如"2024-03-15 上午 → 2024-03-16 傍晚"；如果原文只给了相对天数则用"第三天上午 → 第四天黄昏"；两者不要混用，只用一种）；如剧情里出现了关键时间转折点（真正驱动剧情的节点，不是每一楼的时间戳），在跨度后用括号补充（如"...（第三天午夜 XX 发生）"）；如无则填"未提及"
场景: 主要发生地点（可能多个，按顺序），如无则填"未提及"
事件: 本段内真实发生的关键动作与情节，按时间顺序，80-150字（客观陈述，含对白、动作、意味深长的细节；不含内心独白）
人物: 出场角色的立场、关系、情绪的实质变化，40-70字；如无实质变化则填"无"

只输出这四行，不要额外说明。`,
        },
    ];
}

function buildL1Prompt(l0Entries) {
    const body = l0Entries.map(e => `【楼 ${e.range[0]}-${e.range[1]}】\n${e.text}`).join('\n\n');
    return [
        {
            role: 'system',
            content: `你是一个客观的第三方叙事记录员，负责把连续多段 L0 摘要压缩为章节摘要。

【核心原则】
- 时间锚点原样保留，用先后顺序串联（如"第五天上午 → 第七天黄昏"）
- 客观第三人称
- 保留关键事件的具体性，不做泛化
- 意味深长的对白、异常动作、未回收的暗示，作为事件叙述的一部分保留；已回收的伏笔跟着后续事件流走即可
- NSFW / 亲密内容不保留具体细节，只归纳成一句叙事性事实，除非其中包含承诺、真实伤害、身份揭示、怀孕、疾病等具有后续影响的重要事件
- 每个字段独立一行`,
        },
        {
            role: 'user',
            content: `以下是 ${l0Entries.length} 段 L0 摘要，请合并压缩：

${body}

请按以下字段结构输出，每字段一行：

时间跨度: 从本章第一个时间锚点到最后一个（**优先绝对时间** YYYY-MM-DD，无则退回"第N天"，与 L0 保持一致，不要混用）
主要事件: 按时间顺序列出重要事件，事件必须提到具体人物和地点，含关键对白、行动、意味深长的细节，160-260字
关系变化: 人物立场/关系的实质变化，50-90字；如无则填"无明显变化"

只输出这三行，不要额外说明。`,
        },
    ];
}

// ─── Job queue ───────────────────────────────────────────────────────────────
function enqueue(job) {
    const key = `${job.type}:${job.groupKey || job.range?.join('-') || ''}`;
    if (_queue.some(j => `${j.type}:${j.groupKey || j.range?.join('-') || ''}` === key)) return;
    _queue.push(job);
    if (!_running) processQueue();
}

async function processQueue() {
    if (_running) return;
    _running = true;
    while (_queue.length) {
        const job = _queue.shift();
        _currentJob = job;
        try { await handleJob(job); }
        catch (err) { console.warn('[SP memory] job failed:', job, err); }
        _currentJob = null;
    }
    _running = false;
}

async function handleJob(job) {
    if (!_callApi) return;
    if (job.type === 'L0') {
        await runL0(job.groupKey);
    } else if (job.type === 'L1') {
        await runL1(job.range);
    }
    persist();
}

// ─── L0 generation ───────────────────────────────────────────────────────────
async function runL0(groupKey) {
    const m = meta();
    const groups = getStableGroups();
    const group = groups.find(g => g.key === groupKey);
    if (!group) return;

    const hash = groupHash(group);
    const existing = m.L0[groupKey];
    if (existing && existing.hash === hash) return;

    // Find previous group's summary for context
    const idx = groups.findIndex(g => g.key === groupKey);
    let prevSummary = '';
    if (idx > 0) {
        prevSummary = m.L0[groups[idx - 1].key]?.text || '';
    }

    // Snapshot chatId — after the await, we may be in a different chat
    const chatIdSnap = getContext().chatId;
    const messages = buildL0Prompt(prevSummary, group.floors);
    let response = '';
    try {
        response = await _callApi(messages, _jobAbortController?.signal);
    } catch (err) {
        if (err?.name === 'AbortError') return;          // chat switched; drop silently
        recordFailure(groupKey, err);
        return;
    }

    // Guard: don't write results into a different chat's metadata
    if (getContext().chatId !== chatIdSnap) return;

    if (!response || response.length < 10) {
        recordFailure(groupKey, new Error('响应为空或过短'));
        return;
    }

    m.L0[groupKey] = {
        range: [group.floors[0].mesid, group.floors[group.floors.length - 1].mesid],
        text : response.trim(),
        hash,
        ts   : Date.now(),
    };
    delete m.failed[groupKey];
    m.system.consecutiveFails = 0;
    if (m.system.paused) m.system.paused = false;

    maybeQueueL1();
}

function recordFailure(groupKey, err) {
    const m = meta();
    const rec = m.failed[groupKey] || { count: 0 };
    rec.count += 1;
    rec.lastErr = String(err?.message || err);
    m.failed[groupKey] = rec;
    m.system.consecutiveFails += 1;
    m.system.lastError = rec.lastErr;
    if (rec.count >= 3 || m.system.consecutiveFails >= 3) {
        m.system.paused = true;
    }
}

// ─── L1 compression ──────────────────────────────────────────────────────────
function maybeQueueL1() {
    const m = meta();
    const groups = getStableGroups();
    const l0Keys = groups.map(g => g.key).filter(k => m.L0[k]);
    const M = Math.max(2, +_getSettings().memoryL1Group || 10);
    for (let start = 0; start + M <= l0Keys.length; start += M) {
        const chunk = l0Keys.slice(start, start + M);
        const range = [
            m.L0[chunk[0]].range[0],
            m.L0[chunk[chunk.length - 1]].range[1],
        ];
        const already = m.L1.some(l1 => l1.range[0] === range[0] && l1.range[1] === range[1]);
        if (!already) enqueue({ type: 'L1', range });
    }
}

async function runL1(range) {
    const m = meta();
    const [startMid, endMid] = range;
    const startNum = parseInt(startMid, 10);
    const endNum   = parseInt(endMid, 10);
    const entries = [];
    for (const [k, l0] of Object.entries(m.L0)) {
        const s = parseInt(l0.range[0], 10);
        const e = parseInt(l0.range[1], 10);
        if (s >= startNum && e <= endNum) entries.push(l0);
    }
    entries.sort((a, b) => parseInt(a.range[0], 10) - parseInt(b.range[0], 10));
    if (entries.length < 2) return;

    const chatIdSnap = getContext().chatId;
    const messages = buildL1Prompt(entries);
    let response = '';
    try {
        response = await _callApi(messages, _jobAbortController?.signal);
    } catch (err) {
        if (err?.name === 'AbortError') return;
        m.system.lastError = 'L1 压缩失败：' + String(err?.message || err);
        return;
    }
    if (getContext().chatId !== chatIdSnap) return;
    if (!response || response.length < 20) return;

    m.L1.push({ range, text: response.trim(), ts: Date.now(), builtFrom: entries.length });
    m.L1.sort((a, b) => parseInt(a.range[0], 10) - parseInt(b.range[0], 10));
}

// ─── Health report ───────────────────────────────────────────────────────────
export function getHealthReport() {
    const m = meta();
    const groups = getStableGroups();
    const floors = getAiFloors();
    const totalGroups = groups.length;

    let withL0 = 0, permaFailed = 0, pending = 0;
    for (const g of groups) {
        if (m.L0[g.key] && m.L0[g.key].hash === groupHash(g)) withL0++;
        else if (m.failed[g.key]?.count >= 3) permaFailed++;
        else pending++;
    }

    return {
        totalAi     : floors.length,
        totalGroups : totalGroups,
        withL0      : withL0,
        pending     : pending,
        permaFailed : permaFailed,
        l1Chapters  : m.L1.length,
        latestFloorPending: floors.length > 0,   // the very latest AI floor is ALWAYS pending by design
        paused      : m.system.paused,
        lastError   : m.system.lastError,
        busy        : _running || _queue.length > 0,
    };
}

export function isMemoryBusy() { return _running || _queue.length > 0; }

// ─── Memory context for injection ────────────────────────────────────────────
export function getMemoryContext() {
    const m = meta();
    const parts = [];
    if (m.L1.length) {
        parts.push('━ 早期章节 ━');
        for (const l1 of m.L1) {
            parts.push(`【第 ${l1.range[0]} - ${l1.range[1]} 楼】\n${l1.text}`);
        }
    }
    // Recent L0 (not yet compressed into L1)
    const groups = getStableGroups();
    const lastL1End = m.L1.length ? parseInt(m.L1[m.L1.length - 1].range[1], 10) : -1;
    const recent = groups
        .filter(g => parseInt(g.floors[0].mesid, 10) > lastL1End)
        .filter(g => m.L0[g.key])
        .slice(-6);
    if (recent.length) {
        parts.push('━ 最近发展 ━');
        for (const g of recent) {
            const l0 = m.L0[g.key];
            parts.push(`【楼 ${l0.range[0]} - ${l0.range[1]}】\n${l0.text}`);
        }
    }
    return parts.join('\n\n');
}

// ─── Fill missing ────────────────────────────────────────────────────────────
export async function fillMissing(onProgress) {
    const m = meta();
    m.system.paused = false;
    m.system.consecutiveFails = 0;

    const groups = getStableGroups();
    const targets = [];
    for (const g of groups) {
        const cur = m.L0[g.key];
        if (cur && cur.hash === groupHash(g)) continue;
        if (m.failed[g.key]?.count >= 3) delete m.failed[g.key];
        targets.push(g.key);
    }

    if (!targets.length) {
        onProgress?.({ current: 0, total: 0, done: true });
        return;
    }
    for (let i = 0; i < targets.length; i++) {
        if (_abortController?.signal.aborted) break;
        await runL0(targets[i]);
        onProgress?.({ current: i + 1, total: targets.length, done: false });
        persist();
    }
    maybeQueueL1();
    onProgress?.({ current: targets.length, total: targets.length, done: true });
}

// ─── Rebuild all ─────────────────────────────────────────────────────────────
export async function rebuildAll(onProgress) {
    _abortController = new AbortController();
    const m = meta();
    m.L0 = {}; m.L1 = []; m.failed = {};
    m.system = { paused: false, consecutiveFails: 0, lastError: null };
    persist();

    const groups = getStableGroups();
    for (let i = 0; i < groups.length; i++) {
        if (_abortController.signal.aborted) {
            onProgress?.({ current: i, total: groups.length, aborted: true });
            break;
        }
        await runL0(groups[i].key);
        onProgress?.({ current: i + 1, total: groups.length });
        persist();
    }
    // L1
    const l0Keys = getStableGroups().map(g => g.key).filter(k => m.L0[k]);
    const M = Math.max(2, +_getSettings().memoryL1Group || 10);
    for (let s = 0; s + M <= l0Keys.length; s += M) {
        if (_abortController.signal.aborted) break;
        const chunk = l0Keys.slice(s, s + M);
        const range = [m.L0[chunk[0]].range[0], m.L0[chunk[chunk.length - 1]].range[1]];
        await runL1(range);
        persist();
    }
    onProgress?.({ current: groups.length, total: groups.length, done: true });
    _abortController = null;
}

export function abortRebuild() { _abortController?.abort(); }

// ─── Event handlers ──────────────────────────────────────────────────────────
function onCharacterMessageRendered() {
    if (!_getSettings().memoryEnabled) return;
    if (meta().system.paused) return;
    // A new AI floor arrived: any stable group (not the newest) whose L0 is missing
    // gets queued. Delay-by-one is baked into getStableGroups().
    const m = meta();
    const groups = getStableGroups();
    for (const g of groups) {
        const cur = m.L0[g.key];
        if (cur && cur.hash === groupHash(g)) continue;
        if (m.failed[g.key]?.count >= 3) continue;
        enqueue({ type: 'L0', groupKey: g.key });
    }
}

function onMessageMutated(mesId) {
    // Any mutation invalidates any L0 whose range contains this mesid
    const m = meta();
    const midNum = parseInt(String(mesId), 10);
    let dirty = false;
    for (const [k, l0] of Object.entries(m.L0)) {
        const s = parseInt(l0.range[0], 10);
        const e = parseInt(l0.range[1], 10);
        if (midNum >= s && midNum <= e) {
            delete m.L0[k];
            dirty = true;
        }
    }
    if (dirty) {
        // Any L1 whose range contains this mesid is also stale
        m.L1 = m.L1.filter(l1 => {
            const s = parseInt(l1.range[0], 10);
            const e = parseInt(l1.range[1], 10);
            return !(midNum >= s && midNum <= e);
        });
        persist();
    }
}

function onChatChanged() {
    _queue = [];
    _abortController?.abort();
    _abortController = null;
    // Cancel any in-flight summary fetch — result would land in wrong chat's metadata
    _jobAbortController?.abort();
    _jobAbortController = new AbortController();
}

// ─── Public init ─────────────────────────────────────────────────────────────
// Handles for idempotent (un)registration
const _listeners = { char: null, swipe: null, edit: null, del: null, chat: null };

export function initMemory({ getSettings, callApi }) {
    _getSettings = getSettings || _getSettings;
    _callApi = callApi;
    _jobAbortController = new AbortController();

    // Idempotent (un)register — hot reload / double init won't stack handlers
    const off = (evt, fn) => { if (fn) eventSource.removeListener?.(evt, fn); };
    off(event_types.CHARACTER_MESSAGE_RENDERED, _listeners.char);
    off(event_types.MESSAGE_SWIPED, _listeners.swipe);
    off(event_types.MESSAGE_EDITED, _listeners.edit);
    off(event_types.MESSAGE_DELETED, _listeners.del);
    off(event_types.CHAT_CHANGED, _listeners.chat);

    _listeners.char = onCharacterMessageRendered;
    _listeners.swipe = onMessageMutated;
    _listeners.edit = onMessageMutated;
    _listeners.del = () => {
        const m = meta();
        const chat = getChat();
        const validMids = new Set(chat.map((_, i) => String(i)));
        for (const [k, l0] of Object.entries(m.L0)) {
            if (!validMids.has(l0.range[0]) || !validMids.has(l0.range[1])) delete m.L0[k];
        }
        m.L1 = m.L1.filter(l1 => validMids.has(l1.range[0]) && validMids.has(l1.range[1]));
        persist();
    };
    _listeners.chat = onChatChanged;

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _listeners.char);
    eventSource.on(event_types.MESSAGE_SWIPED, _listeners.swipe);
    eventSource.on(event_types.MESSAGE_EDITED, _listeners.edit);
    eventSource.on(event_types.MESSAGE_DELETED, _listeners.del);
    eventSource.on(event_types.CHAT_CHANGED, _listeners.chat);
}

export function resumeSystem() {
    const m = meta();
    m.system.paused = false;
    m.system.consecutiveFails = 0;
    m.system.lastError = null;
    persist();
}
