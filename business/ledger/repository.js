// ledger.js — 构画·暗账（时间打点 / shadow ledger）存储层
//
// 动机：主楼 AI 记得事件、却算不出「距今多久 / 现在该是什么状态」——伤口一周该结痂却反复喊剧痛，
// 月经上个月来的当成昨天。暗账在点/线/面之外单开一层「时间账」：从正文捞事件 → 打点（此时·此物·此
// 状态）→ 每 N 楼重算时间差刷现状 → 以强提醒注入主楼，让主楼只表达被嚼碎的结论、不自己算。
//
// 本文件只管【存储层】：chat_metadata['sp-ledger'] 的读写与通用 schema。打点/判定/注入/UI/检索
// 都是后续切片，不在这里。存储照 memory.js / store.js：saveMetadata() 同步落盘（切档 clearChat()
// 会取消防抖保存并清空 chat_metadata，防抖那份会永久丢，故必须同步写）。
//
// OWN_KEYS 白名单已含 'sp-ledger' → 存储管理面板经 store.ownKeyBytes / clearOwnKey 自动显示占用/可清，
// 无需本模块再接线（那两个函数按 key 字符串直读 chat_metadata，与本模块是否被 import 无关）。

const { getContext = () => null } = await import('../../../../../extensions.js').catch(() => ({}));

const LEDGER_KEY     = 'sp-ledger';
const SCHEMA_VERSION = 1;

// 通用 schema（蓝图三·一套字段管所有类型）。一次性事件 vs 周期不是两种数据类型，只是了结时
// 「丢弃 vs 滚到下一轮」的结算差异，字段全通用。新字段一律追加末尾 + 可选，别插中间。
//   类型 : '持续状态' | '约定待办' | '周期'
//   状态 : '活跃' | '已了结'（了结只翻标志位、默认筛选排除，不物理删——用户可捞回）
//   锁   : '' | '用户锁'（用户手动改过 → 判定车不许再动，照点/线的锁机制）
//   静音 : false | true（暂停埋入：仍活跃、判定车照刷现状，但不注入主楼、且不许被判定车自动归档
//          ——「现在不想让它每轮反复被提，但没了结」。与「锁」正交：锁冻内容、静音停注入）
//   起始锚/现状锚 : { 楼层, 历日期 }。起始锚=底账·钉死永不改；现状锚=活账·每轮判定刷新。
//     历日期与历 almTodayAnchor() 同源（形状 {month,day}），此处只存不解释。
//   周期长度 : 仅「周期」，天数（如 30）
//   到期锚   : 仅「约定待办/周期」，{ 历日期 }（下次该发生的历日期；约定未定档可留空）
const TYPES  = ['持续状态', '约定待办', '周期'];
const STATES = ['活跃', '已了结'];
let activeWrites = 0;
const cloneState = value => JSON.parse(JSON.stringify(value));
import { reconcileLedgerEntries } from './reconcile.js';
import { reconcileStateAtomic as reconcileStateAtomicCore } from './repository-transaction.js';

// ═══════════════════════════════════════════════════════════════════════════
//  chat_metadata 存取（照 store.js store()/persist() 同款：读路径不实例化空壳）
// ═══════════════════════════════════════════════════════════════════════════

function freshMeta() {
    return { version: SCHEMA_VERSION, entries: [], seq: 0 };
}

// 取当前 chat 的 sp-ledger。无 chat 返回 null。
// create=false（读路径）：不存在就返回 null，**绝不实例化**——否则「读一下」就往 chatMetadata
//   塞空壳、把 chat 存档写脏。create=true（写路径）：按需初始化 + 结构/版本对齐。
// 每次现取 getContext()，不缓存——CHAT_CHANGED 换掉 chatMetadata 引用，缓存会读到旧 chat。
function ledger(create = false) {
    const ctx = getContext?.();
    if (!ctx || !ctx.chatId) return null;
    const cm = ctx.chatMetadata;
    if (!cm) return null;
    let m = cm[LEDGER_KEY];
    if (!m || typeof m !== 'object') {
        if (!create) return null;
        m = cm[LEDGER_KEY] = freshMeta();
    }
    if (!Array.isArray(m.entries)) m.entries = [];
    if (!Number.isFinite(+m.seq))  m.seq = 0;
    if (m.version !== SCHEMA_VERSION) {
        m.version = SCHEMA_VERSION;   // v1 初版，无历史结构要迁移；未来 bump 在此补齐
        if (create) persist();
    }
    return m;
}

function persist() {
    // 立即落盘，别用 saveMetadataDebounced：切档 clearChat() 会 cancelDebouncedMetadataSave()
    // 取消未触发的防抖、紧接着 chat_metadata={}，防抖那份就永不落盘 → 暗账丢。saveMetadata()
    // 同步快照走 diff patch（无变化 no-op），当场写出、切档取消不掉。老版 ST 无此 API 时兜底防抖。
    const ctx = getContext?.();
    if (!ctx) return;
    const result = ctx.saveMetadata ? ctx.saveMetadata() : ctx.saveMetadataDebounced?.();
    if (result?.then) { activeWrites++; Promise.resolve(result).finally(() => { activeWrites = Math.max(0, activeWrites - 1); }); }
    // 旧同步 API 不改变签名；若宿主返回 Promise，吞掉其异步 reject，避免制造未处理 Promise。
    result?.catch?.(() => {});
}

// 批量路径专用：等待官方 saveMetadata 返回的 Promise（若有）。ST 内部吞掉的磁盘错误不在此边界可观测。
function persistAwaitable(boundContext = null) {
    const ctx = boundContext || getContext?.();
    if (!ctx) return Promise.resolve();
    try {
        const result = ctx.saveMetadata ? ctx.saveMetadata() : ctx.saveMetadataDebounced?.();
        if (result?.then) { activeWrites++; return Promise.resolve(result).finally(() => { activeWrites = Math.max(0, activeWrites - 1); }); }
        return Promise.resolve(result);
    } catch (error) {
        return Promise.reject(error);
    }
}

export function readState() {
    const m = ledger(false);
    return m ? cloneState({ version: m.version, entries: m.entries, seq: m.seq }) : { version: SCHEMA_VERSION, entries: [], seq: 0 };
}

export function whenIdle() {
    if (!activeWrites) return Promise.resolve();
    return new Promise(resolve => { const poll = () => activeWrites ? setTimeout(poll, 0) : resolve(); poll(); });
}

export function stageReplaceState(nextState, { expectedChatId } = {}) {
    const ctx = getContext?.(); if (!expectedChatId || ctx?.chatId !== expectedChatId || !nextState) return null;
    const m = ledger(true); if (!m) return null;
    const before = readState(); const next = cloneState(nextState);
    if (!Array.isArray(next.entries) || !Number.isInteger(next.seq)) return null;
    m.version = next.version; m.entries = next.entries; m.seq = next.seq;
    return { token: `ledger-${Date.now()}-${Math.random()}`, chatId: expectedChatId, before, next, staged: true };
}

export function verifyReplace(token) {
    if (!token?.staged || getContext?.()?.chatId !== token.chatId) return false;
    return JSON.stringify(readState()) === JSON.stringify(token.next);
}

export function restoreReplace(token) {
    if (!token?.staged || getContext?.()?.chatId !== token.chatId) return { ok: false, reason: 'chat-mismatch' };
    if (!verifyReplace({ ...token, next: token.next })) return { ok: false, reason: 'content-mismatch' };
    const m = ledger(true); if (!m) return { ok: false, reason: 'no-ledger' };
    m.version = token.before.version; m.entries = cloneState(token.before.entries); m.seq = token.before.seq; return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
//  规范化（入库即补全字段默认值，保证池里每条 schema 齐整）
// ═══════════════════════════════════════════════════════════════════════════

// 锚 → { 楼层, 历日期 }。楼层非有限数留 null；历日期原样透传（{month,day} 或字符串，与历同源）。
function normalizeAnchor(a) {
    if (!a || typeof a !== 'object') return { 楼层: null, 历日期: null };
    const rawFloor = a.楼层;
    const floor = rawFloor === null || rawFloor === undefined || typeof rawFloor === 'boolean' || String(rawFloor).trim() === '' ? null : Number(rawFloor);
    const out = {
        楼层  : Number.isFinite(floor) ? floor : null,
        历日期: a.历日期 ?? null,
    };
    if (typeof a.来源指纹 === 'string' && a.来源指纹.trim()) out.来源指纹 = a.来源指纹.trim();
    return out;
}

function strArr(v) {
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
}

// 把外部传入的松散对象补成齐整条目。id 由 addEntry 分配，此处只在缺失时兜底。
function normalizeEntry(obj, id) {
    const o = (obj && typeof obj === 'object') ? obj : {};
    const entry = {
        id      : id || o.id || '',
        事由    : String(o.事由 || '').trim(),
        类型    : TYPES.includes(o.类型) ? o.类型 : '持续状态',
        牵扯    : strArr(o.牵扯),
        标签    : strArr(o.标签),
        起始锚  : normalizeAnchor(o.起始锚),
        现状    : String(o.现状 || '').trim(),
        现状锚  : normalizeAnchor(o.现状锚),
        周期长度: Number.isFinite(+o.周期长度) ? +o.周期长度 : null,   // 仅「周期」
        到期锚  : o.到期锚 ? normalizeAnchor(o.到期锚) : null,          // 仅「约定待办/周期」
        状态    : o.状态 === '已了结' ? '已了结' : '活跃',
        锁      : o.锁 === '用户锁' ? '用户锁' : '',
        ts      : Number.isFinite(+o.ts) ? +o.ts : Date.now(),         // 打点时间戳（新字段·末尾·可选）
        静音    : o.静音 === true,                                     // 暂停埋入（新字段·末尾·可选）：停注入、判定车不归档，仍活跃
    };
    if (typeof o.来源状态 === 'string' && o.来源状态.trim()) entry.来源状态 = o.来源状态.trim();
    return entry;
}

// ═══════════════════════════════════════════════════════════════════════════
//  读 / 写 / 删（对外主 API）
// ═══════════════════════════════════════════════════════════════════════════

// 列条目。默认只返回「活跃」；includeClosed=true 连已了结一并返回（存储管理/归档池用）。
export function listEntries({ includeClosed = false } = {}) {
    const m = ledger();
    if (!m) return [];
    return m.entries.filter(e => includeClosed || e.状态 !== '已了结');
}

export function getEntry(id) {
    const m = ledger();
    if (!m) return null;
    return m.entries.find(e => e.id === id) || null;
}

// 打点入库。返回补全后的条目（含分配的 id）；无 chat 返回 null。
export function addEntry(obj) {
    const m = ledger(true);
    if (!m) return null;
    const id = `L${++m.seq}`;
    const entry = normalizeEntry(obj, id);
    m.entries.push(entry);
    persist();
    return entry;
}

// 批量原子入库：先在内存准备完整条目，再一次持久化；持久化异常回滚本次内存变更。
// 保留 addEntry 旧 API，供既有单条写入路径继续使用。
export async function addEntriesAtomic(items) {
    const m = ledger(true);
    if (!m) return [];
    const list = Array.isArray(items) ? items : [];
    const oldLen = m.entries.length;
    const oldSeq = m.seq;
    try {
        const prepared = list.map(obj => normalizeEntry(obj, `L${++m.seq}`));
        m.entries.push(...prepared);
        await persistAwaitable();
        return prepared;
    } catch (error) {
        m.entries.length = oldLen;
        m.seq = oldSeq;
        throw error;
    }
}

export async function reconcileEntriesAtomic(sources, chatLength, owner = null, runtime = null) {
    const m = runtime?.state || ledger(true); if (!m) return { changed: false, summary: { cleaned: 0, remapped: 0, lockedMissing: 0, pending: 0 } };
    const ctx = runtime?.context || getContext?.(); const readContext = runtime?.contextReader || getContext; const persist = runtime?.save || (bound => persistAwaitable(bound));
    const guard = () => !owner || (readContext?.()?.chatId === owner.chatId && (owner.guard ? owner.guard() : true));
    const save = async (check, options = {}) => { if (!options.compensate && !check?.()) throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' }); return persist(ctx, options); };
    const result = await reconcileStateAtomicCore(m, sources, chatLength, save, normalizeEntry, guard);
    return result;
}

export async function reconcileStateAtomic(state, sources, chatLength, save) {
    return reconcileStateAtomicCore(state, sources, chatLength, save, normalizeEntry);
}

// 判定车专用：把一轮多条现状/到期/了结修改合并到副本后只保存一次。
// 任意保存失败都恢复原条目，避免出现半轮成功。
export async function applyJudgePatchesAtomic(patches = [], owner = null, runtime = null) {
    const m = runtime?.state || ledger(true); if (!m) return { ok: false, reason: 'no-ledger', applied: [] };
    const ctx = runtime?.context || getContext?.(); const readContext = runtime?.contextReader || getContext; const persist = runtime?.save || (bound => persistAwaitable(bound));
    const guard = () => !owner || (readContext?.()?.chatId === owner.chatId && (owner.guard ? owner.guard() : true));
    if (!guard()) throw Object.assign(new Error('judge-stale-chat'), { phase: 'judge-stale-chat' });
    const before = cloneState(m.entries); const applied = [];
    try {
        for (const change of Array.isArray(patches) ? patches : []) {
            const entry = m.entries.find(item => item.id === change?.id);
            if (!entry) throw Object.assign(new Error('unknown-ledger-id'), { code: 'unknown-ledger-id' });
            Object.assign(entry, change.patch || {});
            if (change.close) entry.状态 = '已了结';
            applied.push(entry.事由);
        }
        if (!guard()) throw Object.assign(new Error('judge-stale-chat'), { phase: 'judge-stale-chat' });
        await persist(ctx);
        if (!guard()) {
            m.entries = before;
            try { await persist(ctx, { compensate: true }); } catch (rollbackError) { rollbackError.phase = 'rollback-save-failed'; throw rollbackError; }
            throw Object.assign(new Error('judge-stale-chat'), { phase: 'judge-stale-chat' });
        }
        return { ok: true, applied };
    } catch (error) { m.entries = before; error.phase ||= 'judge-save-failed'; throw error; }
}

// 测试/宿主注入 seam：复用本 repository 的 normalize 与原子事务，不依赖 ST runtime。
export function createLedgerRepositorySeam({ state = { entries: [], seq: 0 }, save } = {}) {
    return {
        state,
        normalize: value => normalizeEntry(value, value?.id || `L${++state.seq}`),
        reconcile: (sources, chatLength) => reconcileStateAtomicCore(state, sources, chatLength, save, normalizeEntry),
    };
}

// 局部更新（判定车刷现状/现状锚，或用户内联编辑）。只改传入的键。返回是否命中。
// 注意：判定车调用前应自行 gate 掉「锁='用户锁'」的条目（本层不拦，留给上层策略）。
export function updateEntry(id, patch) {
    const m = ledger();
    if (!m || !patch || typeof patch !== 'object') return false;
    const e = m.entries.find(x => x.id === id);
    if (!e) return false;
    Object.assign(e, patch);
    persist();
    return true;
}

// 软了结：状态→已了结（不物理删，默认筛选排除、用户可捞回）。一次性事件兑现/愈合走这个。
export function closeEntry(id) {
    return updateEntry(id, { 状态: '已了结' });
}

// 捞回：已了结 → 活跃（closeEntry 的逆操作；归档区手动复活，判定车重新跟进）。
export function reopenEntry(id) {
    return updateEntry(id, { 状态: '活跃' });
}

// 用户编辑即锁死 AI 判定车（照点/线的锁机制）。
export function lockEntry(id) {
    return updateEntry(id, { 锁: '用户锁' });
}
export function unlockEntry(id) {
    return updateEntry(id, { 锁: '' });
}

// 暂停埋入 / 恢复（与锁正交：锁管「判定车能不能改内容」，静音管「注不注入主楼」）。
// 静音期间：不进注入集、不进召回、判定车不许把它自动归档了结（现状仍随天数刷）。仍是「活跃」，不是了结。
export function muteEntry(id) {
    return updateEntry(id, { 静音: true });
}
export function unmuteEntry(id) {
    return updateEntry(id, { 静音: false });
}

// 物理删除（一般不用——了结走 closeEntry 软标记；仅存储管理里用户明确删单条时用）。
export function removeEntry(id) {
    const m = ledger();
    if (!m) return false;
    const i = m.entries.findIndex(x => x.id === id);
    if (i < 0) return false;
    m.entries.splice(i, 1);
    persist();
    return true;
}

export { LEDGER_KEY, SCHEMA_VERSION, TYPES, STATES, normalizeEntry };
