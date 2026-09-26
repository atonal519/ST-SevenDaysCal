// memory.js — 构画内置故事记忆。
// L0 按 N 个 assistant 楼压缩，L1 再按 M 个 L0 合并；包含最新 assistant 楼的组延后一楼，
// 避免 swipe 尚未稳定时过早摘要。每组保存净化正文的 hash，编辑、重生成或切 swipe 后会失效重排。
// 逻辑根 `sp-memory` 随当前聊天保存，实际可承载于聊天 metadata 或外置后端，不使用 localStorage。

import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { LITERAL_DOUBLE_BRACKET_RULE, normalizeTagRules, TAG_NAME_SOURCE } from './utils/tag-names.js';
import { diagnosticMessage, safeDiagnosticLog } from './api/diagnostics.js';
import { getChatRoot, persistExternalRoots, registerExternalStorageContext } from './runtime/external-chat-storage.js';
import { ledgerHistoricalNarrativeMessage } from './business/ledger/capture.js';

registerExternalStorageContext(getContext);

const MEMORY_KEY = 'sp-memory';
const SCHEMA_VERSION = 3;

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
let _onPause = null;

// ─── State ───────────────────────────────────────────────────────────────────
let _queue = [];
let _running = false;
let _abortController = null;      // 手动补齐/重构的用户中止信号
let _jobAbortController = null;   // 当前聊天任务信号，切聊天时中止
let _lifecycleEpoch = 0;          // invalidates late completions even when upstream ignores AbortSignal
let _aiFloorSnapshot = [];
let _activeRebuild = null;
let _stableGroupBaseline = new Set();
let _autoEligibleGroups = new Set();
const _legacySourcePolicies = new WeakMap();

function builtInMemoryEnabled() {
    const settings = _getSettings();
    return settings.pluginEnabled !== false
        && settings.memoryEnabled !== false
        && !settings.useBaiBaiBook
        && !settings.useAnima
        && !settings.useDatabase
        && !settings.useQianQianJie;
}

// 请求同时受聊天生命周期和手动补齐/重构控制；切聊天或用户中止任一发生都必须立刻 Abort。
// 手动组合信号以兼容没有 AbortSignal.any 的宿主。
function jobSignal() {
    const a = _jobAbortController?.signal;
    const b = _abortController?.signal;
    if (!a && !b) return undefined;
    if (a && !b) return a;
    if (b && !a) return b;
    if (a.aborted || b.aborted) return a.aborted ? a : b;
    const combined = new AbortController();
    const relayA = () => combined.abort(a.reason ?? 'external-abort');
    const relayB = () => combined.abort(b.reason ?? 'external-abort');
    a.addEventListener('abort', relayA, { once: true });
    b.addEventListener('abort', relayB, { once: true });
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
    const existing = getChatRoot(MEMORY_KEY);
    const root = existing || getChatRoot(MEMORY_KEY, { create: true, factory: freshMeta });
    if (!root) return null;
    // Version mismatch: wipe (hash algorithm changed with content sanitizer,
    // so old summaries can't be validated) but stash a migration notice for
    // the UI to surface once. Users see a toast on next chat switch / panel
    // open explaining why their summaries are reset.
    const m = root;
    if (!existing) m.sourcePolicy = 'current';
    if (m.version !== SCHEMA_VERSION) {
        const l0Count = m.L0 ? Object.keys(m.L0).length : 0;
        const l1Count = Array.isArray(m.L1) ? m.L1.length : 0;
        const fresh = freshMeta();
        // Only surface a notice if the previous chat actually had summaries
        // built up; brand-new chats shouldn't trigger a "migration" popup.
        if (l0Count > 0 || l1Count > 0) {
            fresh._migration = { fromVersion: m.version ?? 1, l0Count, l1Count, ts: Date.now() };
        }
        for (const key of Object.keys(m)) delete m[key];
        Object.assign(m, fresh);
        persist();
    }
    return m;
}

function sourcePolicy(m) {
    if (m?.sourcePolicy) return m.sourcePolicy;
    if (_legacySourcePolicies.has(m)) return _legacySourcePolicies.get(m);
    const hasSourceLists = Array.isArray(m?.L1) && m.L1.length > 0
        && m.L1.every(entry => Array.isArray(entry?.sources) && entry.sources.length > 0);
    const policy = Array.isArray(m?.L1) && m.L1.length && !hasSourceLists
        ? 'legacy-needs-rebuild'
        : 'legacy-l0';
    if (m && typeof m === 'object') _legacySourcePolicies.set(m, policy);
    return policy;
}

function freshMeta() {
    return {
        version: SCHEMA_VERSION,
        sourcePolicy: 'current',
        L0: {},          // groupKey (e.g. "5-9") → { range: [startMid, endMid], text, hash, ts, failCount }
        L1: [],          // array of { range: [startMid, endMid], text, ts }
        failed: {},      // groupKey → { count, lastErr }
        system: { paused: false, consecutiveFails: 0, lastError: null },
    };
}

function persist() {
    // 后台队列采用即时保存；切档会取消宿主防抖并替换 metadata，不能把多组结果只挂在末次防抖上。
    const external = persistExternalRoots();
    if (external !== null) return external;
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.saveMetadata) ctx.saveMetadata();
    else ctx.saveMetadataDebounced?.();
}

// 手动补齐/重构使用确认式保存：外置后端要求 confirmed，宿主保存至少要完成调用；owner 在提交前后
// 都必须仍指向同一聊天和记忆源。派发后无法确认的失败按 unknown 处理，不能冒充未写入。
async function persistConfirmed(ownerGuard) {
    if (!ownerGuard()) throw Object.assign(new Error('当前聊天或记忆源已变化，未保存本次记忆'), {
        code: 'stale-memory-owner',
        result: { ok: false, stale: true, dispatched: false, commitState: 'not-dispatched' },
    });
    const external = persistExternalRoots({ confirmed: true, ownerGuard });
    if (external !== null) {
        let result;
        try { result = await external; }
        catch (cause) {
            const conflict = Number(cause?.status) === 409;
            throw Object.assign(new Error(`外置记忆写入失败（${cause?.message || 'unknown'}）`), {
                code: 'memory-save-rejected', diagnosticCode: 'save', externalStorage: true, cause,
                result: { ok: false, dispatched: conflict, commitState: conflict ? 'conflict' : 'not-dispatched' },
            });
        }
        if (!result?.ok || result.commitState !== 'confirmed' || result.stale || !ownerGuard()) {
            const reason = result?.reason || result?.commitState || 'unknown';
            throw Object.assign(new Error(`外置记忆写入未确认（${reason}）`), { code: 'memory-save-unconfirmed', diagnosticCode: 'save', externalStorage: true, result });
        }
        return result;
    }
    const ctx = getContext();
    if (!ctx) throw Object.assign(new Error('当前聊天不可用，未保存本次记忆'), { diagnosticCode: 'save', externalStorage: false });
    const save = typeof ctx.saveMetadata === 'function' ? ctx.saveMetadata.bind(ctx) : ctx.saveMetadataDebounced?.bind(ctx);
    if (typeof save !== 'function') throw Object.assign(new Error('宿主没有可用的聊天保存接口'), { diagnosticCode: 'save', externalStorage: false });
    let result;
    try { result = await save(); }
    catch (cause) {
        throw Object.assign(new Error(`聊天记忆保存失败（${cause?.message || 'unknown'}）`), {
            code: 'memory-save-rejected', diagnosticCode: 'save', externalStorage: false, cause,
            result: { ok: false, dispatched: true, commitState: 'unknown' },
        });
    }
    if (result === false || result?.ok === false) {
        throw Object.assign(new Error(result?.reason || '聊天记忆保存失败'), { code: 'memory-save-rejected', diagnosticCode: 'save', externalStorage: false, result });
    }
    if (!ownerGuard()) throw Object.assign(new Error('保存期间当前聊天或记忆源已变化'), {
        code: 'stale-memory-owner', externalStorage: false,
        result: { ok: true, stale: true, dispatched: true, commitState: 'host-save-complete' },
    });
    return { ok: true, commitState: 'host-save-complete' };
}

function cloneMemoryRoot(root) {
    return JSON.parse(JSON.stringify(root));
}

function restoreMemoryRoot(root, snapshot) {
    for (const key of Object.keys(root)) delete root[key];
    Object.assign(root, snapshot);
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
export function normalizeTagList(csv) {
    return normalizeTagRules(csv);
}
const parseTagList = normalizeTagList;

function parseSanitizerTree(text, keepSet, extraSet) {
    const root = { kind: 'root', children: [] };
    const stack = [root];
    const tokenRx = new RegExp(`<\\/?${TAG_NAME_SOURCE}(?:\\s[^>]*)?\\/?>|\\[\\[([\\s\\S]*?)\\]\\]`, 'gu');
    const pairedCloseRx = new RegExp(`^<\\/${TAG_NAME_SOURCE}\\s*>$`, 'u');
    let cursor = 0;
    let match;
    while ((match = tokenRx.exec(text))) {
        const parent = stack[stack.length - 1];
        if (match.index > cursor) parent.children.push(text.slice(cursor, match.index));
        const token = match[0];
        if (token.startsWith('[[')) {
            parent.children.push({
                kind: 'bracket',
                name: LITERAL_DOUBLE_BRACKET_RULE,
                closed: true,
                children: parseSanitizerTree(match[1], keepSet, extraSet).children,
            });
        } else {
            const closing = token.startsWith('</');
            const name = new RegExp(`^<\\/?(${TAG_NAME_SOURCE})`, 'u').exec(token)?.[1] || '';
            if (!closing && !/\/\s*>$/u.test(token)) {
                const node = { kind: 'xml', name, normalized: name.toLowerCase(), closed: false, children: [] };
                parent.children.push(node);
                stack.push(node);
            } else if (closing && pairedCloseRx.test(token) && stack.length > 1) {
                const normalized = name.toLowerCase();
                for (let i = stack.length - 1; i > 0; i--) {
                    const node = stack[i];
                    const caseInsensitive = keepSet.has(node.normalized) || extraSet.has(node.normalized);
                    if ((caseInsensitive && node.normalized === normalized) || (!caseInsensitive && node.name === name)) {
                        node.closed = true;
                        stack.length = i;
                        break;
                    }
                }
            }
        }
        cursor = tokenRx.lastIndex;
    }
    stack[stack.length - 1].children.push(text.slice(cursor));
    return root;
}

function renderSanitizerChildren(children, keepSet, extraSet, rescueOnly = false) {
    let out = '';
    for (const child of children) {
        if (typeof child === 'string') {
            if (!rescueOnly) out += child;
            continue;
        }
        const kept = child.closed && keepSet.has(child.normalized ?? child.name);
        if (kept) {
            out += renderSanitizerChildren(child.children, keepSet, extraSet);
        } else if (!child.closed) {
            out += renderSanitizerChildren(child.children, keepSet, extraSet, rescueOnly);
        } else if (child.kind === 'bracket' && !extraSet.has(child.name) && !rescueOnly) {
            out += `[[${renderSanitizerChildren(child.children, keepSet, extraSet)}]]`;
        } else {
            out += renderSanitizerChildren(child.children, keepSet, extraSet, true);
        }
    }
    return out;
}

export function stripTags(raw, opts = {}) {
    if (!raw) return '';
    const keep  = parseTagList(opts.keepTags  ?? 'content');
    const extra = parseTagList(opts.extraTags ?? '');
    let s = String(raw);
    // 1. HTML/XML comments
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    // 2. Parse paired wrappers as a hierarchy. Explicitly kept descendants are
    //    rescued through stripped ancestors, while noise inside kept text still
    //    follows the same recursive cleaning rules. Keep-list order is irrelevant.
    const keepSet = new Set(keep);
    const extraSet = new Set(extra);
    s = renderSanitizerChildren(parseSanitizerTree(s, keepSet, extraSet).children, keepSet, extraSet);
    // 3. Collapse the whitespace left behind by removed blocks
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    return s;
}

// ─── Chat helpers ────────────────────────────────────────────────────────────
function getChat() { return getContext().chat || []; }

// 长期记忆沿用历史剧情判别，因此包含 /hide 隐藏的角色楼；常规生成仍只读可见 AI 窗口。
function getAiFloors() {
    const chat = getChat();
    const settings = _getSettings();
    const stripOpts = { keepTags: settings.keepTags, extraTags: settings.extraTags };
    const out = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (m && !m.is_user && m.role !== 'user' && m.role !== 'system' && ledgerHistoricalNarrativeMessage(m)) {
            const raw = m.mes || '';
            out.push({ mesid: String(i), text: stripTags(raw, stripOpts), rawLen: raw.length });
        }
    }
    return out;
}

function captureAiFloorSnapshot() {
    return getAiFloors().map(floor => ({ mesid: floor.mesid, hash: hashStr(floor.text) }));
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

function validL0(group, m) {
    const entry = m?.L0?.[group.key];
    const hash = groupHash(group);
    return !!entry && entry.hash === hash
        && (!entry.source || (entry.source.groupKey === group.key && entry.source.groupHash === hash));
}

function l0TextHash(entry) { return hashStr(String(entry?.text || '')); }

function canonicalL1Chunks(groups = getStableGroups()) {
    const size = Math.max(2, +_getSettings().memoryL1Group || 10);
    const chunks = [];
    for (let i = 0; i + size <= groups.length; i += size) chunks.push(groups.slice(i, i + size));
    return chunks;
}

function validL1Entries(m, groups = getStableGroups()) {
    const byKey = new Map(groups.map(group => [group.key, group]));
    const chunks = canonicalL1Chunks(groups);
    const valid = [];
    for (const l1 of m?.L1 || []) {
        const sources = l1?.sources;
        if (!Array.isArray(sources) || !sources.length) continue;
        const matchingChunk = chunks.find(chunk => chunk.length === sources.length
            && chunk.every((group, index) => sources[index]?.groupKey === group.key));
        if (!matchingChunk) continue;
        const current = sources.every((source, index) => {
            const group = byKey.get(source.groupKey);
            const l0 = m.L0?.[source.groupKey];
            return !!group && validL0(group, m)
                && source.groupHash === groupHash(group)
                && source.l0Hash === l0TextHash(l0)
                && String(l0?.text || '').trim();
        });
        if (!current) continue;
        const range = [matchingChunk[0].floors[0].mesid, matchingChunk.at(-1).floors.at(-1).mesid];
        if (String(l1.range?.[0]) !== range[0] || String(l1.range?.[1]) !== range[1]) continue;
        valid.push(l1);
    }
    return valid;
}

function isCoveredByL1(group, m) {
    return validL1Entries(m).some(l1 => l1.sources.some(source => source.groupKey === group.key));
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

function hasSummarizableFloor(group) {
    const configuredSkipShort = Number(_getSettings().memorySkipShort);
    const skipShort = Number.isFinite(configuredSkipShort) ? configuredSkipShort : 50;
    return group.floors.some(floor => {
        const length = String(floor.text || '').trim().length;
        return length > 0 && length >= skipShort;
    });
}

// ─── Prompts ─────────────────────────────────────────────────────────────────
function buildL0Prompt(prevSummary, groupFloors) {
    const configuredSkipShort = Number(_getSettings().memorySkipShort);
    const skipShort = Number.isFinite(configuredSkipShort) ? configuredSkipShort : 50;
    const body = groupFloors
        .filter(f => {
            const length = String(f.text || '').trim().length;
            return length > 0 && length >= skipShort;
        })
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
    if (!builtInMemoryEnabled()) return;
    const m = meta();
    if (!m || sourcePolicy(m) !== 'current') return;
    if (job.type === 'L0' && !_autoEligibleGroups.has(job.groupKey)) return;
    if (job.type === 'L1' && !(job.groupKeys || []).some(key => _autoEligibleGroups.has(key))) return;
    const key = memoryJobKey(job);
    if (_queue.some(queued => memoryJobKey(queued) === key)) return;
    _queue.push(job);
    if (!_running) processQueue();
}

function memoryJobKey(job) {
    const scope = job.groupKey || job.groupKeys?.join(',') || job.range?.join('-') || '';
    return `${job.type}:${scope}`;
}

async function processQueue() {
    if (_running) return;
    _running = true;
    while (_queue.length) {
        const job = _queue.shift();
        try { await handleJob(job); }
        catch (err) { console.warn('[SP memory] job failed', safeDiagnosticLog('memory', 'request', err, { background: true })); }
    }
    _running = false;
}

async function handleJob(job) {
    if (!_callApi || !builtInMemoryEnabled()) return;
    const current = meta();
    if (!current || sourcePolicy(current) !== 'current') return;
    const lifecycleEpoch = _lifecycleEpoch;
    if (job.type === 'L0') {
        if (!_autoEligibleGroups.has(job.groupKey)) return;
        await runL0(job.groupKey);
    } else if (job.type === 'L1') {
        if (!(job.groupKeys || []).some(key => _autoEligibleGroups.has(key))) return;
        await runL1(job.groupKeys);
    }
    if (_lifecycleEpoch === lifecycleEpoch && builtInMemoryEnabled()) persist();
}

// ─── L0 generation ───────────────────────────────────────────────────────────
async function runL0(groupKey, { queueL1 = true, memory = null } = {}) {
    if (!builtInMemoryEnabled()) return false;
    const lifecycleEpoch = _lifecycleEpoch;
    const m = memory || meta();
    if (!m) return false;
    const groups = getStableGroups();
    const group = groups.find(g => g.key === groupKey);
    if (!group) return false;

    const hash = groupHash(group);
    if (validL0(group, m)) return true;

    // 净化后正文几乎为空：确定性结果，不调模型、不算模型失败。标记后直接返回，
    // 面板据此提示用户去查「保留标签」设置（多半正文被裹在自定义标签里）。
    if (isStrippedEmpty(group)) {
        recordStrippedEmpty(groupKey, m);
        if (m.L0[groupKey]) delete m.L0[groupKey];
        return true;   // 确定性「无可总结正文」是有效重建结果，不触发整次回滚
    }
    if (!hasSummarizableFloor(group)) {
        m.failed[groupKey] = { count: 3, lastErr: '本组楼层均低于摘要长度设置，没有调用模型', short: true, hash };
        return true;
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
        recordFailure(groupKey, err, 'request', m);
        return false;
    }

    // Guard: don't write results into a different chat's metadata
    const liveGroup = getStableGroups().find(item => item.key === groupKey);
    if (_lifecycleEpoch !== lifecycleEpoch || !builtInMemoryEnabled() || getContext().chatId !== chatIdSnap || !liveGroup || groupHash(liveGroup) !== hash) return false;

    if (!response || response.length < 10) {
        recordFailure(groupKey, new Error('响应为空或过短'), 'request', m);
        return false;
    }

    m.L0[groupKey] = {
        range: [group.floors[0].mesid, group.floors[group.floors.length - 1].mesid],
        text : response.trim(),
        hash,
        source: { groupKey, groupHash: hash },
        ts   : Date.now(),
    };
    delete m.failed[groupKey];
    m.system.consecutiveFails = 0;
    if (m.system.paused) m.system.paused = false;

    if (queueL1) maybeQueueL1(m, groupKey);
    return true;
}

function recordFailure(groupKey, err, phase = 'request', memory = null) {
    const m = memory || meta();
    if (!m) return;
    const rec = m.failed[groupKey] || { count: 0 };
    rec.count += 1;
    const group = getStableGroups().find(item => item.key === groupKey);
    if (group) rec.hash = groupHash(group);
    rec.lastErr = diagnosticMessage(err, { phase });
    rec.diagnostic = safeDiagnosticLog('memory', phase, err, { background: true });
    delete rec.stripped;                 // 这次是真·模型失败，清掉可能残留的净化空标记
    m.failed[groupKey] = rec;
    m.system.consecutiveFails += 1;
    m.system.lastError = rec.lastErr;
    if (rec.count >= 3 || m.system.consecutiveFails >= 3) {
        const wasPaused = m.system.paused;
        m.system.paused = true;
        if (!wasPaused) _onPause?.(safeDiagnosticLog('memory', phase, err, { background: true }));
    }
}

// 净化后正文几乎为空：直接标成 permaFailed（count=3，不再重试），但打 stripped 标记与
// 模型失败区分，且**不触发全局暂停/consecutiveFails**——它不是模型的错，别让用户去调模型。
function recordStrippedEmpty(groupKey, memory = null) {
    const m = memory || meta();
    if (!m) return;
    m.failed[groupKey] = { count: 3, lastErr: '净化后正文几乎为空，请重查标签设置', stripped: true, hash: groupHash(getStableGroups().find(group => group.key === groupKey) || { floors: [] }) };
    m.system.lastError = '净化后正文几乎为空，请重查标签设置';
}

// ─── L1 compression ──────────────────────────────────────────────────────────
function maybeQueueL1(memory = null, changedGroupKey = null) {
    const m = memory || meta();
    if (!m || sourcePolicy(m) !== 'current') return;
    const groups = getStableGroups();
    const chunk = canonicalL1Chunks(groups).find(items => items.some(group => group.key === changedGroupKey));
    if (!chunk || !chunk.every(group => validL0(group, m))) return;
    const groupKeys = chunk.map(group => group.key);
    const existing = validL1Entries(m, groups).some(l1 => l1.sources.every((source, index) => source.groupKey === groupKeys[index]));
    if (!existing) enqueue({ type: 'L1', groupKeys });
}

async function runL1(groupKeys, memory = null) {
    if (!builtInMemoryEnabled()) return false;
    const lifecycleEpoch = _lifecycleEpoch;
    const m = memory || meta();
    if (!m) return false;
    const groups = getStableGroups();
    const chunk = groups.filter(group => groupKeys.includes(group.key));
    if (chunk.length !== groupKeys.length || !chunk.every((group, index) => group.key === groupKeys[index]) || !chunk.every(group => validL0(group, m))) return false;
    if (validL1Entries(m, groups).some(l1 => l1.sources.length === groupKeys.length && l1.sources.every((source, index) => source.groupKey === groupKeys[index]))) return true;
    const entries = chunk.map(group => m.L0[group.key]);
    if (entries.length < 2) return true;
    const sources = chunk.map((group, index) => ({ groupKey: group.key, groupHash: groupHash(group), l0Hash: l0TextHash(entries[index]) }));
    const range = [chunk[0].floors[0].mesid, chunk.at(-1).floors.at(-1).mesid];

    const chatIdSnap = getContext().chatId;
    const messages = buildL1Prompt(entries);
    let response = '';
    try {
        response = await _callApi(messages, jobSignal());
    } catch (err) {
        if (err?.name === 'AbortError') return false;
        m.system.lastError = diagnosticMessage(err, { phase: 'request' });
        m.system.lastDiagnostic = safeDiagnosticLog('memory', 'request', err, { background: true });
        return false;
    }
    const liveGroups = getStableGroups();
    const liveChunk = liveGroups.filter(group => groupKeys.includes(group.key));
    const sourcesStillCurrent = liveChunk.length === sources.length && sources.every((source, index) => {
        const group = liveChunk[index]; const l0 = m.L0[source.groupKey];
        return group?.key === source.groupKey && groupHash(group) === source.groupHash
            && l0TextHash(l0) === source.l0Hash && validL0(group, m);
    });
    if (_lifecycleEpoch !== lifecycleEpoch || !builtInMemoryEnabled() || getContext().chatId !== chatIdSnap || !sourcesStillCurrent) return false;
    if (!response || response.length < 20) return false;

    const next = { range, text: response.trim(), ts: Date.now(), builtFrom: entries.length, sources };
    m.L1 = (m.L1 || []).filter(l1 => !(Array.isArray(l1.sources) && l1.sources.length === groupKeys.length && l1.sources.every((source, index) => source.groupKey === groupKeys[index])));
    m.L1.push(next);
    m.L1.sort((a, b) => parseInt(a.range[0], 10) - parseInt(b.range[0], 10));
    return true;
}

// ─── Health report ───────────────────────────────────────────────────────────
export function getHealthReport() {
    const m = meta();
    if (!m) return { totalAi: 0, totalGroups: 0, withL0: 0, pending: 0, permaFailed: 0, strippedEmpty: 0, l1Chapters: 0, latestFloorPending: false, paused: true, lastError: '当前聊天的外置构画数据不可用', busy: false, unavailable: true };
    const groups = getStableGroups();
    const floors = getAiFloors();
    const totalGroups = groups.length;
    const effectiveL1 = validL1Entries(m, groups);

    let withL0 = 0, permaFailed = 0, pending = 0, strippedEmpty = 0, shortGroups = 0;
    for (const g of groups) {
        const failure = m.failed[g.key];
        const failureCurrent = !failure?.hash || failure.hash === groupHash(g);
        if (validL0(g, m)) withL0++;
        else if (isCoveredByL1(g, m)) withL0++;   // 已被 L1 章节吸收 = 已记忆，别再算 pending（否则老楼被反复判「待总结」）
        else if (failureCurrent && failure?.stripped) strippedEmpty++;
        else if (failureCurrent && failure?.short) shortGroups++;
        else if (failureCurrent && failure?.count >= 3) permaFailed++;
        else pending++;
    }

    return {
        totalAi     : floors.length,
        totalGroups : totalGroups,
        withL0      : withL0,
        pending     : pending,
        permaFailed : permaFailed,
        strippedEmpty: strippedEmpty,
        shortGroups,
        l1Chapters  : effectiveL1.length,
        legacyNeedsRebuild: sourcePolicy(m) === 'legacy-needs-rebuild',
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
    if (!m) return null;
    const notice = m._migration || null;
    if (notice) {
        delete m._migration;
        persist();
    }
    return notice;
}

// ─── Memory context for injection ────────────────────────────────────────────
export function getMemoryContext() {
    if (_getSettings().useBaiBaiBook || _getSettings().useAnima || _getSettings().useDatabase || _getSettings().useQianQianJie) return '';
    const m = meta();
    if (!m) return '';
    const parts = [];
    const groups = getStableGroups();
    const legacy = sourcePolicy(m) === 'legacy-needs-rebuild';
    const l1Entries = legacy ? (m.L1 || []) : validL1Entries(m, groups);
    if (l1Entries.length) {
        parts.push('━ 早期章节 ━');
        for (const l1 of l1Entries) {
            parts.push(`【第 ${l1.range[0]} - ${l1.range[1]} 楼】\n${l1.text}`);
        }
    }
    const covered = legacy ? null : new Set(l1Entries.flatMap(l1 => l1.sources.map(source => source.groupKey)));
    const lastL1End = legacy && l1Entries.length ? Math.max(...l1Entries.map(l1 => parseInt(l1.range[1], 10))) : -1;
    const recent = groups
        .filter(g => legacy ? parseInt(g.floors[0].mesid, 10) > lastL1End : !covered.has(g.key))
        .filter(g => legacy ? !!m.L0[g.key] : validL0(g, m))
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
    if (!builtInMemoryEnabled()) return { aborted: true, current: 0, total: 0 };
    // 循环固定读取本轮 controller；切聊天会清空模块引用，但仍会中止这个对象。
    const ctrl = _abortController = new AbortController();
    const lifecycleEpoch = _lifecycleEpoch;
    const chatIdSnap = getContext().chatId;
    const ownerGuard = () => !ctrl.signal.aborted
        && _lifecycleEpoch === lifecycleEpoch
        && getContext().chatId === chatIdSnap
        && builtInMemoryEnabled();
    let m = meta();
    if (!m) throw new Error('当前聊天的外置构画数据不可用');
    if (sourcePolicy(m) === 'legacy-needs-rebuild') {
        if (_abortController === ctrl) _abortController = null;
        return { aborted: false, current: 0, total: 0, legacyNeedsRebuild: true };
    }
    const initial = cloneMemoryRoot(m);
    m.system.paused = false;
    m.system.consecutiveFails = 0;

    const groups = getStableGroups();
    const targets = [];
    for (const g of groups) {
        if (validL0(g, m)) continue;
        if (isCoveredByL1(g, m)) continue;   // 已滚进 L1 的老楼别再补总结（切档/重启冗余调用的根因）
        const failure = m.failed[g.key];
        if (failure?.hash === groupHash(g) && (failure.stripped || (failure.short && !hasSummarizableFloor(g)))) continue;
        if (failure?.count >= 3) delete m.failed[g.key];
        targets.push(g.key);
    }

    const aborted = current => {
        onProgress?.({ current, total: targets.length, aborted: true });
        return { aborted: true, current, total: targets.length };
    };
    try {
        if (!targets.length) {
            try { await persistConfirmed(ownerGuard); }
            catch (error) {
                if (ctrl.signal.aborted || !ownerGuard()) return aborted(0);
                if (error?.externalStorage === false) restoreMemoryRoot(m, initial);
                throw error;
            }
            m = meta();
            if (!m) throw new Error('保存后无法重新读取当前聊天记忆');
        }
        for (let i = 0; i < targets.length; i++) {
            if (ctrl.signal.aborted || !ownerGuard()) return aborted(i);
            const beforeStep = i === 0 ? initial : cloneMemoryRoot(m);
            const succeeded = await runL0(targets[i], { queueL1: false, memory: m });
            if (ctrl.signal.aborted || !ownerGuard()) return aborted(i);
            if (!succeeded) {
                try { await persistConfirmed(ownerGuard); }
                catch (error) {
                    if (ctrl.signal.aborted || !ownerGuard()) return aborted(i);
                    if (error?.externalStorage === false) restoreMemoryRoot(m, beforeStep);
                    throw error;
                }
                const detail = m.failed[targets[i]]?.lastErr || '未生成有效摘要';
                throw new Error(`L0 补齐失败：${targets[i]}（${detail}）`);
            }
            // 每组只有在确认落盘后才计入成功进度，避免 UI 把仅存在于内存的摘要报成完成。
            try { await persistConfirmed(ownerGuard); }
            catch (error) {
                if (ctrl.signal.aborted || !ownerGuard()) return aborted(i);
                if (error?.externalStorage === false) restoreMemoryRoot(m, beforeStep);
                throw error;
            }
            m = meta();
            if (!m) throw new Error('保存后无法重新读取当前聊天记忆');
            onProgress?.({ current: i + 1, total: targets.length, done: false });
        }
        let l1Generated = 0;
        const groupsAfterFill = getStableGroups();
        for (const chunk of canonicalL1Chunks(groupsAfterFill)) {
            if (ctrl.signal.aborted || !ownerGuard()) return aborted(targets.length);
            if (!chunk.every(group => validL0(group, m))) continue;
            const groupKeys = chunk.map(group => group.key);
            if (validL1Entries(m, groupsAfterFill).some(l1 => l1.sources.every((source, index) => source.groupKey === groupKeys[index]))) continue;
            const beforeStep = cloneMemoryRoot(m);
            const succeeded = await runL1(groupKeys, m);
            if (ctrl.signal.aborted || !ownerGuard()) return aborted(targets.length);
            if (!succeeded) throw new Error(`L1 补齐失败：${chunk[0].key}（${m.system.lastError || '来源发生变化或未生成有效摘要'}）`);
            try { await persistConfirmed(ownerGuard); }
            catch (error) {
                if (ctrl.signal.aborted || !ownerGuard()) return aborted(targets.length);
                if (error?.externalStorage === false) restoreMemoryRoot(m, beforeStep);
                throw error;
            }
            m = meta();
            if (!m) throw new Error('保存后无法重新读取当前聊天记忆');
            l1Generated++;
        }
        const unresolvedGroups = getStableGroups().filter(group => !validL0(group, m) && !isCoveredByL1(group, m)).length;
        onProgress?.({ current: targets.length, total: targets.length, done: true });
        return { aborted: false, current: targets.length, total: targets.length, l1Generated, unresolvedGroups };
    } finally {
        if (_abortController === ctrl) _abortController = null;
    }
}

// ─── Rebuild all ─────────────────────────────────────────────────────────────
export async function rebuildAll(onProgress) {
    if (!builtInMemoryEnabled()) return { aborted: true, current: 0, total: 0 };
    const ctrl = _abortController = new AbortController();   // 本地引用，防切聊天置空后 null 解引用（同 fillMissing）
    const lifecycleEpoch = _lifecycleEpoch;
    const chatIdSnap = getContext().chatId;
    const ownerGuard = () => !ctrl.signal.aborted
        && _lifecycleEpoch === lifecycleEpoch
        && getContext().chatId === chatIdSnap
        && builtInMemoryEnabled();
    const m = meta();
    if (!m) throw new Error('当前聊天的外置构画数据不可用');
    // 生成期只写私有副本，正式 root 继续供其它模块读取；完整生成后才进入一次性提交。
    const working = freshMeta();
    try {
        const groups = getStableGroups();
        const totalSteps = groups.length + 1;   // 最后一步专门表示 confirmed 保存完成
        const aborted = (current, { phase = 'generating', saveState = 'not-started', restored = true } = {}) => {
            const result = { aborted: true, current, total: totalSteps, phase, saveState, restored };
            onProgress?.(result);
            return result;
        };
        _activeRebuild = { ctrl, sources: new Map(groups.flatMap(group => group.floors.map(floor => [Number(floor.mesid), hashStr(floor.text)]))) };
        for (let i = 0; i < groups.length; i++) {
            if (ctrl.signal.aborted || !ownerGuard()) return aborted(i);
            const succeeded = await runL0(groups[i].key, { queueL1: false, memory: working });
            if (ctrl.signal.aborted || !ownerGuard()) return aborted(i);
            if (!succeeded) throw new Error(`L0 重建失败：${groups[i].key}（${working.failed[groups[i].key]?.lastErr || '未生成有效摘要'}）`);
            onProgress?.({ current: i + 1, total: totalSteps, phase: 'generating' });
        }
        // L1 使用规范组序列切块；任何缺口都保留，不能跨洞拼章节。
        for (const chunk of canonicalL1Chunks(groups)) {
            if (!chunk.every(group => validL0(group, working))) continue;
            if (ctrl.signal.aborted || !ownerGuard()) return aborted(groups.length);
            const groupKeys = chunk.map(group => group.key);
            const range = [chunk[0].floors[0].mesid, chunk.at(-1).floors.at(-1).mesid];
            const succeeded = await runL1(groupKeys, working);
            if (ctrl.signal.aborted || !ownerGuard()) return aborted(groups.length);
            if (!succeeded) throw new Error(`L1 重建失败：${range.join('-')}（${working.system.lastError || '未生成有效摘要'}）`);
        }
        const unresolvedGroups = groups.filter(group => !validL0(group, working) && !isCoveredByL1(group, working)).length;
        if (ctrl.signal.aborted || !ownerGuard()) return aborted(groups.length);
        const previous = cloneMemoryRoot(m);
        for (const key of Object.keys(m)) delete m[key];
        Object.assign(m, working);
        onProgress?.({ current: groups.length, total: totalSteps, phase: 'saving' });
        try { await persistConfirmed(ownerGuard); }
        catch (error) {
            if (ctrl.signal.aborted || !ownerGuard()) {
                const commitState = error?.result?.commitState;
                if (commitState === 'confirmed' || commitState === 'host-save-complete') {
                    return aborted(totalSteps, { phase: 'saving', saveState: 'confirmed', restored: false });
                }
                if (commitState === 'unknown' || commitState === 'conflict') {
                    return aborted(groups.length, { phase: 'saving', saveState: 'unknown', restored: false });
                }
                restoreMemoryRoot(m, previous);
                return aborted(groups.length, { phase: 'saving', saveState: 'not-dispatched', restored: true });
            }
            if (error?.externalStorage === false) restoreMemoryRoot(m, previous);
            throw error;
        }
        onProgress?.({ current: totalSteps, total: totalSteps, done: true, phase: 'complete', saveState: 'confirmed' });
        return { aborted: false, current: totalSteps, total: totalSteps, phase: 'complete', saveState: 'confirmed', restored: false, unresolvedGroups };
    } finally {
        // 保存期按最终提交状态决定保留候选或恢复旧 root；unknown 不能按“确定未写入”回滚。
        if (_activeRebuild?.ctrl === ctrl) _activeRebuild = null;
        if (_abortController === ctrl) _abortController = null;
    }
}

export function abortRebuild() { _abortController?.abort('manual-abort'); }

export function abortAll(reason = 'reset') {
    _lifecycleEpoch += 1;
    _queue = [];
    try { _abortController?.abort(reason); } catch {}
    try { _jobAbortController?.abort(reason); } catch {}
    _abortController = null;
    _jobAbortController = new AbortController();
}

// ─── Event handlers ──────────────────────────────────────────────────────────
function onCharacterMessageRendered() {
    if (!builtInMemoryEnabled()) return;
    const current = meta();
    const groups = getStableGroups();
    if (!current) return;
    const previous = _stableGroupBaseline;
    _stableGroupBaseline = new Set(groups.map(group => group.key));
    if (sourcePolicy(current) === 'current' && !current.system.paused) {
        for (const group of groups) {
            if (previous.has(group.key)) continue;
            _autoEligibleGroups.add(group.key);
            const failure = current.failed[group.key];
            const shortFailureNowEligible = failure?.short && hasSummarizableFloor(group);
            if (validL0(group, current) || isCoveredByL1(group, current)
                || (failure?.count >= 3 && (!failure.hash || failure.hash === groupHash(group)) && !shortFailureNowEligible)) continue;
            enqueue({ type: 'L0', groupKey: group.key });
        }
    }
    _aiFloorSnapshot = captureAiFloorSnapshot();
}

function onMessageMutated(mesId) {
    if (!builtInMemoryEnabled()) return;
    const m = meta();
    if (!m) return;
    const midNum = parseInt(String(mesId?.messageId ?? mesId?.mesId ?? mesId?.mesid ?? mesId), 10);
    const previousAi = _aiFloorSnapshot.find(floor => Number(floor.mesid) === midNum);
    const currentAi = getAiFloors().find(floor => Number(floor.mesid) === midNum);
    const aiSourceChanged = !!previousAi !== !!currentAi || previousAi?.hash !== currentAi?.hash;
    if (_activeRebuild?.sources.has(midNum)) {
        const current = getAiFloors().find(floor => Number(floor.mesid) === midNum);
        if (!current || hashStr(current.text) !== _activeRebuild.sources.get(midNum)) _activeRebuild.ctrl.abort('memory-source-mutated');
    }
    const liveGroups = getStableGroups();
    let dirty = false;
    for (const [key, l0] of Object.entries(m.L0 || {})) {
        const group = liveGroups.find(item => item.key === key);
        const start = Number(l0?.range?.[0]), end = Number(l0?.range?.[1]);
        if (aiSourceChanged && midNum >= start && midNum <= end) { delete m.L0[key]; dirty = true; }
        else if (group && !validL0(group, m) && aiSourceChanged) { delete m.L0[key]; dirty = true; }
    }
    if (dirty && sourcePolicy(m) === 'current') {
        const valid = new Set(validL1Entries(m, liveGroups));
        m.L1 = (m.L1 || []).filter(l1 => valid.has(l1));
    }
    if (aiSourceChanged && sourcePolicy(m) === 'legacy-needs-rebuild') {
        const before = m.L1.length;
        m.L1 = (m.L1 || []).filter(l1 => !(midNum >= Number(l1?.range?.[0]) && midNum <= Number(l1?.range?.[1])));
        dirty ||= m.L1.length !== before;
    }
    if (dirty) {
        persist();
    }
    _autoEligibleGroups.clear();
    _stableGroupBaseline = new Set(liveGroups.map(group => group.key));
    _aiFloorSnapshot = captureAiFloorSnapshot();
}

function onChatChanged() {
    abortAll('chat-boundary');
    _aiFloorSnapshot = captureAiFloorSnapshot();
    _stableGroupBaseline = new Set(getStableGroups().map(group => group.key));
    _autoEligibleGroups.clear();
}

function onMessageDeleted() {
    if (!builtInMemoryEnabled()) return;
    const m = meta();
    if (!m) return;
    const before = _aiFloorSnapshot;
    const after = captureAiFloorSnapshot();
    _aiFloorSnapshot = after;
    let offset = 0;
    while (offset < before.length && offset < after.length
        && before[offset].mesid === after[offset].mesid && before[offset].hash === after[offset].hash) offset++;
    if (offset === before.length && offset === after.length) return;
    const earliestAffected = Math.min(
        Number(before[offset]?.mesid ?? Number.POSITIVE_INFINITY),
        Number(after[offset]?.mesid ?? Number.POSITIVE_INFINITY),
    );
    if (!Number.isFinite(earliestAffected)) return;
    if ([...(_activeRebuild?.sources?.keys() || [])].some(mesid => mesid >= earliestAffected)) {
        _activeRebuild.ctrl.abort('memory-source-deleted');
    }

    const groupsByHash = new Map();
    for (const group of getStableGroups()) {
        const hash = groupHash(group);
        const list = groupsByHash.get(hash) || [];
        list.push(group); groupsByHash.set(hash, list);
    }
    const used = new Set();
    const nextL0 = {};
    for (const [key, l0] of Object.entries(m.L0)) {
        const end = Number(l0?.range?.[1]);
        if (Number.isFinite(end) && end < earliestAffected) {
            nextL0[key] = l0; used.add(key); continue;
        }
        const matches = (groupsByHash.get(l0?.hash) || []).filter(group => !used.has(group.key));
        if (matches.length !== 1) continue;
        const group = matches[0];
        nextL0[group.key] = { ...l0, range: [group.floors[0].mesid, group.floors.at(-1).mesid] };
        used.add(group.key);
    }
    m.L0 = nextL0;
    m.L1 = m.L1.filter(l1 => Number(l1?.range?.[1]) < earliestAffected);
    m.failed = Object.fromEntries(Object.entries(m.failed || {}).filter(([key]) => {
        const end = Number(String(key).split('-').at(-1));
        return Number.isFinite(end) && end < earliestAffected;
    }));
    persist();
    _autoEligibleGroups.clear();
    _stableGroupBaseline = new Set(getStableGroups().map(group => group.key));
}

// ─── Public init ─────────────────────────────────────────────────────────────
// Handles for idempotent (un)registration
const _listeners = { char: null, swipe: null, edit: null, del: null, chat: null };

export function initMemory({ getSettings, callApi, onPause }) {
    _getSettings = getSettings || _getSettings;
    _callApi = callApi;
    _onPause = typeof onPause === 'function' ? onPause : null;
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
    _listeners.del = onMessageDeleted;
    _listeners.chat = onChatChanged;

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _listeners.char);
    eventSource.on(event_types.MESSAGE_SWIPED, _listeners.swipe);
    eventSource.on(event_types.MESSAGE_EDITED, _listeners.edit);
    eventSource.on(event_types.MESSAGE_DELETED, _listeners.del);
    eventSource.on(event_types.CHAT_CHANGED, _listeners.chat);
    _aiFloorSnapshot = captureAiFloorSnapshot();
    _stableGroupBaseline = new Set(getStableGroups().map(group => group.key));
    _autoEligibleGroups.clear();
}

export function resumeSystem() {
    const m = meta();
    if (!m) return false;
    m.system.paused = false;
    m.system.consecutiveFails = 0;
    m.system.lastError = null;
    persist();
}
