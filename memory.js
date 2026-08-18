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
const SCHEMA_VERSION = 3;   // v3 = tag-stripped floor text (v2 summaries included thinking/widget noise; requires rebuild)

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
let _isRebuilding = false;        // block every persist while rebuildAll holds uncommitted memory

// 把两路中止信号合成一个交给 fetch：_jobAbortController（切聊天时掐，防结果串写别的聊天）
// 与 _abortController（用户点「中止」时掐，重构/补漏用）。历史 bug：fetch 只绑了前者，
// 用户点中止只能在「两组之间」生效，当前那次 LLM 调用掐不断 → 感觉「点了没反应」。
// 不依赖 AbortSignal.any（老移动端浏览器未必有），手动串一个组合 controller，任一 abort 即 abort。
function jobSignal() {
    const a = _jobAbortController?.signal;
    const b = _abortController?.signal;
    if (!a && !b) return undefined;
    if (a && !b) return a;
    if (b && !a) return b;
    if (a.aborted || b.aborted) return a.aborted ? a : b;
    const combined = new AbortController();
    const relay = () => combined.abort();
    a.addEventListener('abort', relay, { once: true });
    b.addEventListener('abort', relay, { once: true });
    return combined.signal;
}

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
    // Version mismatch: wipe (hash algorithm changed with content sanitizer,
    // so old summaries can't be validated) but stash a migration notice for
    // the UI to surface once. Users see a toast on next chat switch / panel
    // open explaining why their summaries are reset.
    const m = ctx.chatMetadata[MEMORY_KEY];
    if (m.version !== SCHEMA_VERSION) {
        const l0Count = m.L0 ? Object.keys(m.L0).length : 0;
        const l1Count = Array.isArray(m.L1) ? m.L1.length : 0;
        const fresh = freshMeta();
        // Only surface a notice if the previous chat actually had summaries
        // built up; brand-new chats shouldn't trigger a "migration" popup.
        if (l0Count > 0 || l1Count > 0) {
            fresh._migration = { fromVersion: m.version ?? 1, l0Count, l1Count, ts: Date.now() };
        }
        ctx.chatMetadata[MEMORY_KEY] = fresh;
        persist();
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
    // 立即落盘（同 store.js persist）：切档 clearChat() 会取消防抖并清空 chat_metadata，
    // 防抖那份记忆就丢——补全过程多次写入、全吊在最后一个防抖上，尤其危险。
    // rebuildAll 的新记忆必须整套完成后才能写入；期间任何路径都不能落盘半成品。
    if (_isRebuilding) return;
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.saveMetadata) ctx.saveMetadata();
    else ctx.saveMetadataDebounced?.();
}

// ─── Content sanitizer ──────────────────────────────────────────────────────
// Strip all tag-wrapped blocks (thinking, reasoning, outline_widget,
// calendar_widget, details/summary, HTML markup, etc.) — the summarizer only
// wants the narrative prose. Both paired blocks and stray tags are removed,
// plus HTML/XML comments. Applied at getAiFloors() so every downstream
// consumer (grouping, hashing, prompt building) sees the same clean text.
//
// Two user-configurable name lists override the default behavior:
//   keepTags  → PROTECT list. Contents inside these tags survive stripping;
//               the tags themselves are removed but their inner text is kept.
//               Default 'content'. Fixes the "AI wraps narrative in <content>
//               and default strip nukes it" edge case some cards hit.
//   extraTags → EXTRA strip list. Explicitly names tags that MUST be removed
//               with their content. Redundant with default behavior but lets
//               users document intent (e.g. write 'think,reasoning').
function parseTagList(csv) {
    return String(csv || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => /^[\p{L}][\p{L}\p{N}_-]*$/u.test(s));
}

export function stripTags(raw, opts = {}) {
    if (!raw) return '';
    const keep  = parseTagList(opts.keepTags  ?? 'content');
    const extra = parseTagList(opts.extraTags ?? '');
    let s = String(raw);
    // 1. HTML/XML comments
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    // 2. Extract keep-list blocks into placeholders BEFORE any stripping runs,
    //    so the default "delete paired tags with content" pass won't nuke them.
    //    Restored (as bare inner text) at the end.
    const keepStash = [];
    for (const name of keep) {
        const rx = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'gi');
        s = s.replace(rx, (_m, inner) => {
            keepStash.push(inner);
            return ` KEEP${keepStash.length - 1} `;
        });
    }
    // 3. Extra strip list — delete these tags + content entirely (redundant with
    //    the default pass but explicit for user clarity + future-proofs if we
    //    ever change the default).
    for (const name of extra) {
        const rx = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}\\s*>`, 'gi');
        let prev;
        do { prev = s; s = s.replace(rx, ''); } while (s !== prev);
    }
    // 4. Default: delete every remaining paired tag WITH its content.
    //    Multi-pass to handle nested same-name tags.
    let prev;
    do {
        prev = s;
        s = s.replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g, '');
    } while (s !== prev);
    // 5. Any remaining self-closing / orphan tags
    s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, '');
    // 6. Restore keep-list inner content (bare, no tags)
    s = s.replace(/ KEEP(\d+) /g, (_m, idx) => keepStash[+idx] ?? '');
    // 7. Second cleaning pass — restored kept content may itself contain
    //    noisy tags (e.g. <content><thinking>...</thinking>正文</content>).
    //    Run the default + orphan strip again. Keep list is NOT re-applied
    //    here (would re-stash then loop); protection is by design outermost-only.
    do {
        prev = s;
        s = s.replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g, '');
    } while (s !== prev);
    s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, '');
    // 8. Collapse the whitespace left behind by removed blocks
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    return s;
}

// ─── Chat helpers ────────────────────────────────────────────────────────────
function getChat() { return getContext().chat || []; }

// Returns all AI floors (including hidden — is_system=true means hidden in ST).
// Text is sanitized: thinking/reasoning/widget/HTML tags all stripped,
// leaving only narrative prose for the summarizer. User can influence which
// tags to keep/strip via keepTags/extraTags settings.
function getAiFloors() {
    const chat = getChat();
    const settings = _getSettings();
    const stripOpts = { keepTags: settings.keepTags, extraTags: settings.extraTags };
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (m && !m.is_user) {
            const raw = m.mes || '';
            out.push({ mesid: String(i), text: stripTags(raw, stripOpts), rawLen: raw.length });
        }
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

// 这组楼的楼层区间是否已被某个 L1 章节完整吸收 = 已在 L1 层记忆。
// 关键：真编辑/重roll/删楼会连带把覆盖该区间的 L1 一并作废（onMessageMutated / del 监听），
// 所以「L1 仍在」就等价于「这段内容自压缩后没变过」。据此可安全跳过重复 L0 总结——
// 这正是切档/重启时几十次冗余总结的根因：L0 一旦滚进 L1，其 hash 在重载时偶发对不上就被判「未记忆」，
// 而检测侧不认 L1、把老楼一律重排。注入侧 getMemoryContext 早已认 L1，此处只是把检测侧拉齐。
function isCoveredByL1(group, m) {
    if (!m.L1 || !m.L1.length) return false;
    const s = parseInt(group.floors[0].mesid, 10);
    const e = parseInt(group.floors[group.floors.length - 1].mesid, 10);
    return m.L1.some(l1 => {
        const ls = parseInt(l1.range[0], 10);
        const le = parseInt(l1.range[1], 10);
        return s >= ls && e <= le;
    });
}

// 判定「这组楼有实打实的原文、但净化后几乎空了」——典型是卡片把正文全裹在自定义标签里
// （如 <gametxt>），而保留标签默认只留 content，导致净化后正文被清空、摘要生不出来。
// 与「模型没返回」区分开：这是确定性的净化结果，不该白白重试/让人去调模型。
// 阈值：原文合计够长（>= 楼数*40 字符，排除本就没内容的空组）但净化后去空白后不足 20 字符。
function isStrippedEmpty(group) {
    const floors = group.floors || [];
    if (!floors.length) return false;
    let rawTotal = 0, netTotal = 0;
    for (const f of floors) {
        rawTotal += Number(f.rawLen) || 0;
        netTotal += String(f.text || '').replace(/\s+/g, '').length;
    }
    return rawTotal >= floors.length * 40 && netTotal < 20;
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
        try { await handleJob(job); }
        catch (err) { console.warn('[SP memory] job failed:', job, err); }
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
async function runL0(groupKey, { queueL1 = true } = {}) {
    const m = meta();
    const groups = getStableGroups();
    const group = groups.find(g => g.key === groupKey);
    if (!group) return false;

    const hash = groupHash(group);
    const existing = m.L0[groupKey];
    if (existing && existing.hash === hash) return true;

    // 净化后正文几乎为空：确定性结果，不调模型、不算模型失败。标记后直接返回，
    // 面板据此提示用户去查「保留标签」设置（多半正文被裹在自定义标签里）。
    if (isStrippedEmpty(group)) {
        recordStrippedEmpty(groupKey);
        if (m.L0[groupKey]) delete m.L0[groupKey];
        return true;   // 确定性「无可总结正文」是有效重建结果，不触发整次回滚
    }

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
        response = await _callApi(messages, jobSignal());
    } catch (err) {
        if (err?.name === 'AbortError') return false;    // chat switched; drop silently
        recordFailure(groupKey, err);
        return false;
    }

    // Guard: don't write results into a different chat's metadata
    if (getContext().chatId !== chatIdSnap) return false;

    if (!response || response.length < 10) {
        recordFailure(groupKey, new Error('响应为空或过短'));
        return false;
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

    if (queueL1) maybeQueueL1();
    return true;
}

function recordFailure(groupKey, err) {
    const m = meta();
    const rec = m.failed[groupKey] || { count: 0 };
    rec.count += 1;
    rec.lastErr = String(err?.message || err);
    delete rec.stripped;                 // 这次是真·模型失败，清掉可能残留的净化空标记
    m.failed[groupKey] = rec;
    m.system.consecutiveFails += 1;
    m.system.lastError = rec.lastErr;
    if (rec.count >= 3 || m.system.consecutiveFails >= 3) {
        m.system.paused = true;
    }
}

// 净化后正文几乎为空：直接标成 permaFailed（count=3，不再重试），但打 stripped 标记与
// 模型失败区分，且**不触发全局暂停/consecutiveFails**——它不是模型的错，别让用户去调模型。
function recordStrippedEmpty(groupKey) {
    const m = meta();
    m.failed[groupKey] = { count: 3, lastErr: '净化后正文几乎为空，请重查标签设置', stripped: true };
    m.system.lastError = '净化后正文几乎为空，请重查标签设置';
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
    if (entries.length < 2) return true;   // 无足够 L0 可压缩 = 合法无操作

    const chatIdSnap = getContext().chatId;
    const messages = buildL1Prompt(entries);
    let response = '';
    try {
        response = await _callApi(messages, jobSignal());
    } catch (err) {
        if (err?.name === 'AbortError') return false;
        m.system.lastError = 'L1 压缩失败：' + String(err?.message || err);
        return false;
    }
    if (getContext().chatId !== chatIdSnap) return false;
    if (!response || response.length < 20) return false;

    m.L1.push({ range, text: response.trim(), ts: Date.now(), builtFrom: entries.length });
    m.L1.sort((a, b) => parseInt(a.range[0], 10) - parseInt(b.range[0], 10));
    return true;
}

// ─── Health report ───────────────────────────────────────────────────────────
export function getHealthReport() {
    const m = meta();
    const groups = getStableGroups();
    const floors = getAiFloors();
    const totalGroups = groups.length;

    let withL0 = 0, permaFailed = 0, pending = 0, strippedEmpty = 0;
    for (const g of groups) {
        if (m.L0[g.key] && m.L0[g.key].hash === groupHash(g)) withL0++;
        else if (isCoveredByL1(g, m)) withL0++;   // 已被 L1 章节吸收 = 已记忆，别再算 pending（否则老楼被反复判「待总结」）
        else if (m.failed[g.key]?.stripped) strippedEmpty++;
        else if (m.failed[g.key]?.count >= 3) permaFailed++;
        else pending++;
    }

    return {
        totalAi     : floors.length,
        totalGroups : totalGroups,
        withL0      : withL0,
        pending     : pending,
        permaFailed : permaFailed,
        strippedEmpty: strippedEmpty,
        l1Chapters  : m.L1.length,
        latestFloorPending: floors.length > 0,   // the very latest AI floor is ALWAYS pending by design
        paused      : m.system.paused,
        lastError   : m.system.lastError,
        busy        : _running || _queue.length > 0,
    };
}

export function isMemoryBusy() { return _running || _queue.length > 0; }

// Returns the migration notice ONCE (then clears it) so callers can surface a
// toast/popup. Shape: { fromVersion, l0Count, l1Count, ts } or null.
// Safe to call repeatedly; only the first call after a schema upgrade returns
// a non-null value.
export function consumeMigrationNotice() {
    const m = meta();
    const notice = m._migration || null;
    if (notice) {
        delete m._migration;
        persist();
    }
    return notice;
}

// ─── Memory context for injection ────────────────────────────────────────────
export function getMemoryContext() {
    if (_getSettings().useBaiBaiBook) return '';
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
    // 捕获本地引用：切聊天时 onChatChanged 会把模块级 _abortController 置空，
    // 若循环里还读模块级会 null 解引用崩掉；读本地 ctrl（同一对象、被 abort 过）稳。
    const ctrl = _abortController = new AbortController();   // 之前漏建 → 中止按钮对补漏完全无效；补上让 abortRebuild 能掐到
    const m = meta();
    m.system.paused = false;
    m.system.consecutiveFails = 0;

    const groups = getStableGroups();
    const targets = [];
    for (const g of groups) {
        const cur = m.L0[g.key];
        if (cur && cur.hash === groupHash(g)) continue;
        if (isCoveredByL1(g, m)) continue;   // 已滚进 L1 的老楼别再补总结（切档/重启冗余调用的根因）
        if (m.failed[g.key]?.count >= 3) delete m.failed[g.key];
        targets.push(g.key);
    }

    if (!targets.length) {
        onProgress?.({ current: 0, total: 0, done: true });
        if (_abortController === ctrl) _abortController = null;
        return;
    }
    try {
        for (let i = 0; i < targets.length; i++) {
            if (ctrl.signal.aborted) {
                onProgress?.({ current: i, total: targets.length, aborted: true });
                break;
            }
            await runL0(targets[i]);
            if (ctrl.signal.aborted) {   // 中止发生在这次 fetch 期间 → 立刻收尾，不再报进度/落盘
                onProgress?.({ current: i, total: targets.length, aborted: true });
                break;
            }
            onProgress?.({ current: i + 1, total: targets.length, done: false });
            persist();
        }
        maybeQueueL1();
        if (!ctrl.signal.aborted) {
            onProgress?.({ current: targets.length, total: targets.length, done: true });
        }
    } finally {
        if (_abortController === ctrl) _abortController = null;
    }
}

// ─── Rebuild all ─────────────────────────────────────────────────────────────
export async function rebuildAll(onProgress) {
    const ctrl = _abortController = new AbortController();   // 本地引用，防切聊天置空后 null 解引用（同 fillMissing）
    const m = meta();
    // 关键：先把旧记忆整体备份，再在**内存里**换成空壳开始重构，此刻**绝不落盘**。
    // 只有完整跑完才让新记忆算数（committed=true）；中途中止 / 异常 → finally 里整体还原旧记忆。
    // 这样"点了推翻重构、立刻中止"绝不会把之前的记忆清空。旧对象在重构期间从不被改动
    //（下面全是把 m.L0/L1/... 重新赋值成新对象），所以 backup 里的引用始终指向完好的旧数据。
    const backup = { L0: m.L0, L1: m.L1, failed: m.failed, system: m.system };
    let committed = false;
    _isRebuilding = true;
    m.L0 = {}; m.L1 = []; m.failed = {};
    m.system = { paused: false, consecutiveFails: 0, lastError: null };

    try {
        const groups = getStableGroups();
        for (let i = 0; i < groups.length; i++) {
            if (ctrl.signal.aborted) { onProgress?.({ current: i, total: groups.length, aborted: true }); return; }
            const succeeded = await runL0(groups[i].key, { queueL1: false });
            if (ctrl.signal.aborted) {   // 中止发生在这次 fetch 期间 → 立刻收尾，交给 finally 还原
                onProgress?.({ current: i, total: groups.length, aborted: true });
                return;
            }
            if (!succeeded) throw new Error(`L0 重建失败：${groups[i].key}`);
            onProgress?.({ current: i + 1, total: groups.length });
        }
        // L1
        const l0Keys = getStableGroups().map(g => g.key).filter(k => m.L0[k]);
        const M = Math.max(2, +_getSettings().memoryL1Group || 10);
        for (let s = 0; s + M <= l0Keys.length; s += M) {
            if (ctrl.signal.aborted) return;
            const chunk = l0Keys.slice(s, s + M);
            const range = [m.L0[chunk[0]].range[0], m.L0[chunk[chunk.length - 1]].range[1]];
            const succeeded = await runL1(range);
            if (ctrl.signal.aborted) return;
            if (!succeeded) throw new Error(`L1 重建失败：${range.join('-')}`);
        }
        committed = true;   // 全流程走完，新记忆算数
        _isRebuilding = false;
        persist();
        onProgress?.({ current: groups.length, total: groups.length, done: true });
    } finally {
        if (!committed) {
            // 中止或异常：整体还原到重构前，绝不留下"清空但没重建"的空记忆
            m.L0 = backup.L0; m.L1 = backup.L1; m.failed = backup.failed; m.system = backup.system;
            _isRebuilding = false;
            persist();
        }
        if (_abortController === ctrl) _abortController = null;
    }
}

export function abortRebuild() { _abortController?.abort(); }

// ─── Event handlers ──────────────────────────────────────────────────────────
function onCharacterMessageRendered() {
    if (_getSettings().useBaiBaiBook) return;
    if (!_getSettings().memoryEnabled) return;
    if (meta().system.paused) return;
    // A new AI floor arrived: any stable group (not the newest) whose L0 is missing
    // gets queued. Delay-by-one is baked into getStableGroups().
    const m = meta();
    const groups = getStableGroups();
    for (const g of groups) {
        const cur = m.L0[g.key];
        if (cur && cur.hash === groupHash(g)) continue;
        if (isCoveredByL1(g, m)) continue;   // 已被 L1 吸收的老楼别重排 L0（切档/重启不再触发几十次冗余总结）
        if (m.failed[g.key]?.count >= 3) continue;
        enqueue({ type: 'L0', groupKey: g.key });
    }
}

function onMessageMutated(mesId) {
    if (_getSettings().useBaiBaiBook) return;
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
    if (_getSettings().useBaiBaiBook) return;
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
        if (_getSettings().useBaiBaiBook) return;
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
