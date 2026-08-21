// snapshot.js — 构画·楼内渲染框「每层楼快照」数据层
//
// 背景（2026-08-05 楼内渲染框重构）：点/历/线的楼内块原本只挂最新一层、显示全局最新态，
// 往上翻历史楼看到的是被覆盖后的"假历史"。本模块把**每层 AI 楼生成/推进当时**的点/线/历/锚点
// 状态冻结成一份快照，绑到那条 message 上，随 chat 存档走。往上翻 → 从该楼快照重建 →
// 看到的是那层楼「当时的世界状态」（真历史）。
//
// 为什么存 message.extra 而不是新开 chat_metadata 结构：
//   - 删楼 / 编辑删楼 → ST 把整条 message 连同 extra 一起删掉，快照自动没，「删历史记录」白送；
//   - swipe → extra 天然 per-swipe 隔离（见下方双写），滑到哪条看哪条快照；
//   - 不能用 mesId 当 key 存别处：mesId 是数组下标，删楼会前移错位。
//
// ⚠️ swipe 双写（ST 源码 script.js ~12341 注释）：chat[floor].extra 只是**当前 swipe** 的镜像，
//   真正随 swipe/删楼/分支回滚的是 swipe_info[swipe_id].extra。只写 extra 的话，用户切走再
//   切回会被旧 swipe_info 覆盖、快照丢失。故写入时两处都写、读取只读 extra（ST 切 swipe 时
//   会自己把 swipe_info[i].extra 同步回 extra）。
//
// 快照**不进 prompt**：ST 拼上下文只取 message.mes，extra 是纯元数据（token 数/翻译/图片等
//   扩展都存这），塞快照不污染 AI 上下文。
//
// 持久化用 saveChatDebounced（去抖非阻塞），避开 saveChat 同步 I/O 尖峰（ST 卡顿根因之一）。

import { getContext } from '../../../extensions.js';
import { isValidCalendarDescriptor, resolveSnapshotCalendar } from './runtime/chat-date-anchor.js';

// message.extra 上的键，带 gouhua_ 前缀防和别的扩展撞。
const SNAP_KEY = 'gouhua_snapshot';

// 当前快照 schema 版本。字段只增不改、新字段追加末尾且可选（对齐构画一贯的格式演进纪律），
// 老快照缺字段时读取端按缺省兜底，不强制迁移。
const SNAP_VERSION = 2;

function ctx() {
    try { return getContext?.() || null; } catch { return null; }
}

// 取第 mesId 层的 message 对象（仅 AI 楼有意义，调用方负责筛）。
function messageAt(mesId) {
    const c = ctx();
    const chat = c?.chat;
    if (!Array.isArray(chat)) return null;
    const i = Number(mesId);
    if (!Number.isInteger(i) || i < 0 || i >= chat.length) return null;
    return chat[i] || null;
}

// ── 写 ────────────────────────────────────────────────────────────────────
// snap 形状（全部可空，缺哪块渲染端就不渲哪段）：
//   { v, ts, point, line, almanac, anchor, pool, recall }
//     point   : 点 raw 字符串（<calendar_widget>…）
//     line    : 线 raw 字符串（含 <line_widget>… 或线缓存 raw）
//     almanac : 历条目数组（loadAlmanac() 的归一化结果）
//     anchor  : { month, day } 当时的「今天」锚点
//     pool    : 【AI 楼】当时的暗账「标注池」精简条目 [{id,事由,类型,起始锚,周期长度,到期锚,标签,锁,静音}]（新字段·末尾·可选）
//     recall  : 【用户楼】当轮召回注入回显 [{id,事由,类型,起始锚,现状}]（丰富版；新字段·末尾·可选）
//   （旧字段 ledger＝早期只读回显，已退役；老快照的 ledger 读取端直接忽略，孤立无害。）
//
// 用户楼也存快照：召回框挂在用户楼、需要历史楼看当轮召回，故放开原「只给 AI 楼挂」限制。
// 用户楼的 point/line/almanac 恒空（只有 recall 有料），AI 楼反之只有 pool——两类互斥、同一 schema 承载。
//
// 幂等/省写：与现存快照 JSON 相等则跳过（不 touch extra、不触发保存），
//   避免每次 sync 都把 chat 标脏、debounce 永远够不到落盘。
export function writeSnapshot(mesId, snap) {
    const msg = messageAt(mesId);
    if (!msg) return false;
    const calendar = snap?.calendar;
    if (!isValidCalendarDescriptor(calendar)) return false;

    const payload = {
        v: SNAP_VERSION,
        ts: Date.now(),
        point:   snap?.point   || '',
        line:    snap?.line    || '',
        almanac: Array.isArray(snap?.almanac) ? snap.almanac : [],
        anchor:  (snap?.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
            ? { month: +snap.anchor.month, day: +snap.anchor.day }
            : null,
        pool:    Array.isArray(snap?.pool)   ? snap.pool   : [],
        recall:  Array.isArray(snap?.recall) ? snap.recall : [],
        calendar: JSON.parse(JSON.stringify(calendar)),
    };

    // 幂等：内容没变就不写（ts 不参与比较，否则永远"变了"）。
    const prev = msg.extra?.[SNAP_KEY];
    if (prev && _sameSnapContent(prev, payload)) return false;

    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
    msg.extra[SNAP_KEY] = payload;

    // 双写：镜像到当前 swipe 的 swipe_info[swipe_id].extra，随 swipe/删楼/分支正确回滚。
    _mirrorToCurrentSwipe(msg, payload);

    ctx()?.saveChatDebounced?.();
    return true;
}

// 内容等价（忽略 ts / v 差异——v 升级时另有迁移路径，这里只判实质内容）。
function _sameSnapContent(a, b) {
    if (a.point !== b.point) return false;
    if (a.line !== b.line) return false;
    const am = a.anchor, bm = b.anchor;
    if (!!am !== !!bm) return false;
    if (am && bm && (am.month !== bm.month || am.day !== bm.day)) return false;
    // 历条目：粗比 JSON（数组，量小；顺序由 loadAlmanac 稳定给出）。
    try {
        if (JSON.stringify(a.almanac || []) !== JSON.stringify(b.almanac || [])) return false;
    } catch { return false; }
    // 标注池（AI 楼）/召回（用户楼）：同粗比 JSON（量小、顺序由取数端稳定给出）。
    try {
        if (JSON.stringify(a.pool   || []) !== JSON.stringify(b.pool   || [])) return false;
        if (JSON.stringify(a.recall || []) !== JSON.stringify(b.recall || [])) return false;
        if (JSON.stringify(a.calendar || null) !== JSON.stringify(b.calendar || null)) return false;
    } catch { return false; }
    return true;
}

// 把快照镜像进当前 swipe 槽。ST 的 swipe_info 与 swipes 数组并行、下标即 swipe_id；
// 槽不存在（老消息/单 swipe）时按需补齐到当前 id，只动 extra、不碰 message/swipes 文本。
function _mirrorToCurrentSwipe(msg, payload) {
    const sid = Number(msg.swipe_id);
    if (!Number.isInteger(sid) || sid < 0) return;   // 无 swipe 概念的楼：只靠 extra 足够
    if (!Array.isArray(msg.swipe_info)) return;       // 没有 swipe_info：不主动造，避免打乱 ST 结构
    let slot = msg.swipe_info[sid];
    if (!slot || typeof slot !== 'object') { slot = msg.swipe_info[sid] = {}; }
    if (!slot.extra || typeof slot.extra !== 'object') slot.extra = {};
    slot.extra[SNAP_KEY] = payload;
}

// ── 读 ────────────────────────────────────────────────────────────────────
// 只读 message.extra（ST 切 swipe 时已把 swipe_info[i].extra 同步回 extra）。
// 返回 null = 该楼无快照（重构前的老楼 / 从未生成过）→ 渲染端据此决定不显块。
export function readSnapshot(mesId) {
    const msg = messageAt(mesId);
    const snap = msg?.extra?.[SNAP_KEY];
    if (!snap || typeof snap !== 'object') return null;
    // 容错归一：老/脏快照缺字段时补齐缺省，读取端拿到的形状恒定。
    return {
        v: Number.isFinite(+snap.v) ? +snap.v : 0,
        ts: +snap.ts || 0,
        point:   typeof snap.point === 'string' ? snap.point : '',
        line:    typeof snap.line  === 'string' ? snap.line  : '',
        almanac: Array.isArray(snap.almanac) ? snap.almanac : [],
        anchor:  (snap.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
            ? { month: +snap.anchor.month, day: +snap.anchor.day }
            : null,
        pool:    Array.isArray(snap.pool)   ? snap.pool   : [],
        recall:  Array.isArray(snap.recall) ? snap.recall : [],
        calendar: snap.v >= 2 && isValidCalendarDescriptor(snap.calendar) ? JSON.parse(JSON.stringify(snap.calendar)) : null,
    };
}

export { resolveSnapshotCalendar };

export function scanSnapshotTargets() {
    const c = ctx(); const chat = c?.chat; const out = [];
    if (!Array.isArray(chat)) return out;
    chat.forEach((msg, messageIndex) => {
        if (msg?.extra?.[SNAP_KEY]) out.push({ messageIndex, swipeIndex: null, value: JSON.parse(JSON.stringify(msg.extra[SNAP_KEY])) });
        if (Array.isArray(msg?.swipe_info)) msg.swipe_info.forEach((slot, swipeIndex) => { if (slot?.extra?.[SNAP_KEY]) out.push({ messageIndex, swipeIndex, value: JSON.parse(JSON.stringify(slot.extra[SNAP_KEY])) }); });
    }); return out;
}

function targetValue(target) { const msg = ctx()?.chat?.[target.messageIndex]; return target.swipeIndex == null ? msg?.extra?.[SNAP_KEY] : msg?.swipe_info?.[target.swipeIndex]?.extra?.[SNAP_KEY]; }
function setTargetValue(target, value) { const msg = ctx()?.chat?.[target.messageIndex]; if (!msg) return false; const holder = target.swipeIndex == null ? msg : (msg.swipe_info?.[target.swipeIndex] || null); if (!holder) return false; if (!holder.extra) holder.extra = {}; if (value == null) delete holder.extra[SNAP_KEY]; else holder.extra[SNAP_KEY] = JSON.parse(JSON.stringify(value)); return true; }

export function stageSnapshotPatches(patches, { expectedChatId } = {}) {
    if (!expectedChatId || ctx()?.chatId !== expectedChatId || !Array.isArray(patches)) return null;
    const before = patches.map(p => ({ ...p, existed: targetValue(p) != null, value: targetValue(p) == null ? undefined : JSON.parse(JSON.stringify(targetValue(p))) }));
    for (let i = 0; i < patches.length; i++) {
        if (setTargetValue(patches[i], patches[i].value)) continue;
        for (let j = i - 1; j >= 0; j--) { const old = before[j]; setTargetValue(old, old.existed ? old.value : null); }
        return null;
    }
    return { token: `snapshot-${Date.now()}-${Math.random()}`, chatId: expectedChatId, before, patches, staged: true };
}
export function verifySnapshotPatches(token) { return !!token?.staged && ctx()?.chatId === token.chatId && token.patches.every(p => JSON.stringify(targetValue(p) ?? null) === JSON.stringify(p.value ?? null)); }
export function restoreSnapshotPatches(token) {
    if (!token?.staged || ctx()?.chatId !== token.chatId) return { ok: false, reason: 'chat-mismatch' };
    if (!verifySnapshotPatches(token)) return { ok: false, reason: 'content-mismatch' };
    token.before.forEach(p => setTargetValue(p, p.existed ? p.value : null)); return { ok: true };
}
export async function flushAwaitable({ expectedChatId } = {}) {
    if (!expectedChatId || ctx()?.chatId !== expectedChatId) return { ok: false, reason: 'chat-mismatch', durability: 'unknown' };
    const save = ctx()?.saveChat; if (typeof save !== 'function') return { ok: false, reason: 'saveChat-unavailable', durability: 'unknown' };
    try { const result = save(); if (result?.then) await result; return { ok: ctx()?.chatId === expectedChatId, durability: 'host-returned-unconfirmed' }; }
    catch (error) { return { ok: false, error, durability: 'unknown' }; }
}

export { SNAP_KEY, SNAP_VERSION };
