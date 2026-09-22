// snapshot.js — 楼内渲染框的逐楼快照数据层。
// 快照绑定生成当时的 message，而不是用会随删楼移动的 mesId 另建索引。内置存储写
// message.extra，并镜像到当前 swipe_info 槽；外置模式保存独立记录与指针。快照属于渲染元数据，
// 不进入 prompt。只有当前最后一条非系统楼可更新，历史楼保持当时状态。

import { getContext } from '../../../extensions.js';
import { isValidCalendarDescriptor, resolveSnapshotCalendar } from './runtime/chat-date-anchor.js';
import { isExternalMode, isExternalReady, readExternalSnapshot, registerExternalStorageContext, writeExternalSnapshot } from './runtime/external-chat-storage.js';

registerExternalStorageContext(getContext);

// message.extra 上的键，带 gouhua_ 前缀防和别的扩展撞。
const SNAP_KEY = 'gouhua_snapshot';

// 字段只增不改并保持可选；旧快照缺字段时由读取端补默认值，不强制迁移。
const SNAP_VERSION = 2;

let snapshotSaveTimer = null;

function ctx() {
    try { return getContext?.() || null; } catch { return null; }
}

function scheduleSnapshotSave() {
    const context = ctx();
    if (typeof context?.saveChatDebounced === 'function') {
        context.saveChatDebounced();
        return;
    }
    if (typeof context?.saveChat !== 'function' || snapshotSaveTimer !== null) return;
    snapshotSaveTimer = setTimeout(() => {
        snapshotSaveTimer = null;
        try { ctx()?.saveChat?.(); } catch { /* official fallback is fire-and-forget */ }
    }, 200);
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

// 只有当前最后一条非系统楼仍处于“本楼生成/召回可更新”窗口。后面一旦出现新楼，旧楼即成为
// 历史楼；此后任何 DOM 重挂、主题刷新或活态业务刷新都不得再用当前缓存改写它。
function isCurrentWritableFloor(mesId) {
    const chat = ctx()?.chat;
    if (!Array.isArray(chat)) return false;
    const target = Number(mesId);
    if (!Number.isInteger(target) || target < 0 || target >= chat.length) return false;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i] || chat[i].is_system) continue;
        return i === target;
    }
    return false;
}

// ── 写 ────────────────────────────────────────────────────────────────────
// snap 形状（全部可空，缺哪块渲染端就不渲哪段）：
//   { v, ts, point, line, almanac, anchor, pool, recall }
//     point   : 点 raw 字符串（<calendar_widget>…）
//     line    : 线 raw 字符串（含 <line_widget>… 或线缓存 raw）
//     almanac : 历条目数组（loadAlmanac() 的归一化结果）
//     anchor  : { month, day, year?, eraLabel? } 当时的「今天」锚点
//     pool    : 【AI 楼】当时的暗账「标注池」精简条目 [{id,事由,类型,起始锚,周期长度,到期锚,标签,锁,静音}]（可选）
//     recall  : 【用户楼】当轮召回注入回显 [{id,事由,类型,起始锚,现状}]（可选）
//   兼容旧快照中的 ledger 字段：读取端忽略它，不影响其它字段。
//
// 用户楼也存快照，因为召回框需要在历史用户楼复现当轮注入。
// 用户楼的 point/line/almanac 恒空（只有 recall 有料），AI 楼反之只有 pool——两类互斥、同一 schema 承载。
//
// 幂等/省写：与现存快照 JSON 相等则跳过（不 touch extra、不触发保存），
//   避免每次 sync 都把 chat 标脏、debounce 永远够不到落盘。
export function writeSnapshot(mesId, snap) {
    const msg = messageAt(mesId);
    if (!msg || !isCurrentWritableFloor(mesId)) return false;
    const calendar = snap?.calendar;
    if (!isValidCalendarDescriptor(calendar)) return false;

    const payload = {
        v: SNAP_VERSION,
        ts: Date.now(),
        point:   snap?.point   || '',
        line:    snap?.line    || '',
        almanac: Array.isArray(snap?.almanac) ? snap.almanac : [],
        anchor:  (snap?.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
            ? { month: +snap.anchor.month, day: +snap.anchor.day,
                ...(Number.isInteger(+snap.anchor.year) && +snap.anchor.year >= 1 && +snap.anchor.year <= 9999 ? { year: +snap.anchor.year } : {}),
                ...(typeof snap.anchor.eraLabel === 'string' && snap.anchor.eraLabel.trim() ? { eraLabel: snap.anchor.eraLabel.trim() } : {}) }
            : null,
        pool:    Array.isArray(snap?.pool)   ? snap.pool   : [],
        recall:  Array.isArray(snap?.recall) ? snap.recall : [],
        calendar: JSON.parse(JSON.stringify(calendar)),
    };
    if (snap?.weekdayRef && Number.isInteger(+snap.weekdayRef.refDoy) && Number.isInteger(+snap.weekdayRef.refWd)) payload.weekdayRef = { refDoy: +snap.weekdayRef.refDoy, refWd: +snap.weekdayRef.refWd };

    // 幂等：内容没变就不写（ts 不参与比较，否则永远"变了"）。
    const prev = isExternalMode() ? readExternalSnapshot(msg) : msg.extra?.[SNAP_KEY];
    if (prev && _sameSnapContent(prev, payload)) return false;

    if (isExternalMode()) {
        if (!isExternalReady()) return false;
        void writeExternalSnapshot(msg, payload);
        return true;
    }

    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
    msg.extra[SNAP_KEY] = payload;

    // 双写：镜像到当前 swipe 的 swipe_info[swipe_id].extra，随 swipe/删楼/分支正确回滚。
    _mirrorToCurrentSwipe(msg, payload);

    scheduleSnapshotSave();
    return true;
}

// 内容等价只比较渲染状态；时间戳和 schema 号不代表业务内容变化。
function _sameSnapContent(a, b) {
    if (a.point !== b.point) return false;
    if (a.line !== b.line) return false;
    const am = a.anchor, bm = b.anchor;
    if (!!am !== !!bm) return false;
    if (am && bm && (am.month !== bm.month || am.day !== bm.day || am.year !== bm.year || am.eraLabel !== bm.eraLabel)) return false;
    // 历条目：粗比 JSON（数组，量小；顺序由 loadAlmanac 稳定给出）。
    try {
        if (JSON.stringify(a.almanac || []) !== JSON.stringify(b.almanac || [])) return false;
    } catch { return false; }
    if (JSON.stringify(a.weekdayRef || null) !== JSON.stringify(b.weekdayRef || null)) return false;
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
// 返回 null 表示该楼没有可用快照；渲染端据此不显示楼内块。
export function readSnapshot(mesId) {
    const msg = messageAt(mesId);
    const snap = isExternalMode() ? readExternalSnapshot(msg) : msg?.extra?.[SNAP_KEY];
    if (!snap || typeof snap !== 'object') return null;
    // 容错归一：老/脏快照缺字段时补齐缺省，读取端拿到的形状恒定。
    const out = {
        v: Number.isFinite(+snap.v) ? +snap.v : 0,
        ts: +snap.ts || 0,
        point:   typeof snap.point === 'string' ? snap.point : '',
        line:    typeof snap.line  === 'string' ? snap.line  : '',
        almanac: Array.isArray(snap.almanac) ? snap.almanac : [],
        anchor:  (snap.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
            ? { month: +snap.anchor.month, day: +snap.anchor.day,
                ...(Number.isInteger(+snap.anchor.year) && +snap.anchor.year >= 1 && +snap.anchor.year <= 9999 ? { year: +snap.anchor.year } : {}),
                ...(typeof snap.anchor.eraLabel === 'string' && snap.anchor.eraLabel.trim() ? { eraLabel: snap.anchor.eraLabel.trim() } : {}) }
            : null,
        pool:    Array.isArray(snap.pool)   ? snap.pool   : [],
        recall:  Array.isArray(snap.recall) ? snap.recall : [],
        calendar: snap.v >= 2 && isValidCalendarDescriptor(snap.calendar) ? JSON.parse(JSON.stringify(snap.calendar)) : null,
    };
    if (snap.weekdayRef && Number.isInteger(+snap.weekdayRef.refDoy) && Number.isInteger(+snap.weekdayRef.refWd)) out.weekdayRef = { refDoy: +snap.weekdayRef.refDoy, refWd: +snap.weekdayRef.refWd };
    return out;
}

export { resolveSnapshotCalendar };

export { SNAP_KEY, SNAP_VERSION };
