// 构画刻度的存储层。逻辑根 `sp-ledger` 可承载于普通聊天 metadata 或外置后端；本文件只负责
// schema、读写和事务，捕获、判定、选择、注入与渲染由同域模块处理。读路径不得创建空根；
// 批量生成路径必须等待确认式提交并遵守固定聊天 owner，普通交互写入仍保持同步访问合同。

const { getContext = () => null } = await import('../../../../../extensions.js').catch(() => ({}));
import { getChatRoot, persistExternalRoots, registerExternalStorageContext } from '../../runtime/external-chat-storage.js';

registerExternalStorageContext(getContext);

const LEDGER_KEY     = 'sp-ledger';
const SCHEMA_VERSION = 1;

// 通用 schema。一次性事件 vs 周期不是两种数据类型，只是了结时
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
let fixedMetadataPersistence = null;
const cloneState = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
import { reconcileStateAtomic as reconcileStateAtomicCore, handleUnknownPersistence } from './repository-transaction.js';

// ═══════════════════════════════════════════════════════════════════════════
//  chat_metadata 存取（照 store.js store()/persist() 同款：读路径不实例化空壳）
// ═══════════════════════════════════════════════════════════════════════════

function freshMeta() {
    return { version: SCHEMA_VERSION, entries: [], seq: 0 };
}
const ledgerRevision = value => {
    let hash = 2166136261;
    for (const ch of JSON.stringify({ entries: value?.entries || [], seq: Number(value?.seq) || 0 })) {
        hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619);
    }
    return `ls-${(hash >>> 0).toString(16)}`;
};

// 取当前 chat 的 sp-ledger。无 chat 返回 null。
// create=false（读路径）：不存在就返回 null，**绝不实例化**——否则「读一下」就往 chatMetadata
//   塞空壳、把 chat 存档写脏。create=true（写路径）：按需初始化 + 结构/版本对齐。
// 每次现取 getContext()，不缓存——CHAT_CHANGED 换掉 chatMetadata 引用，缓存会读到旧 chat。
function ledger(create = false) {
    const ctx = getContext?.();
    if (!ctx || !ctx.chatId) return null;
    let m = getChatRoot(LEDGER_KEY, { create, factory: freshMeta });
    if (!m || typeof m !== 'object') {
        return null;
    }
    if (!Array.isArray(m.entries)) m.entries = [];
    if (!Number.isFinite(+m.seq))  m.seq = 0;
    if (m.version !== SCHEMA_VERSION) {
        m.version = SCHEMA_VERSION;   // schema 升级时在写路径补齐结构
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
    const external = persistExternalRoots();
    if (external !== null) return external;
    const result = ctx.saveMetadata ? ctx.saveMetadata() : ctx.saveMetadataDebounced?.();
    // 旧同步 API 不改变签名；若宿主返回 Promise，吞掉其异步 reject，避免制造未处理 Promise。
    result?.catch?.(() => {});
}

// 批量路径专用：等待官方 saveMetadata 返回的 Promise（若有）。ST 内部吞掉的磁盘错误不在此边界可观测。
function persistAwaitable(boundContext = null, options = {}) {
    const external = persistExternalRoots({ confirmed: true, ownerGuard: options.ownerGuard });
    if (external !== null) return external;
    if (fixedMetadataPersistence) return fixedMetadataPersistence.commit?.(boundContext, options);
    const ctx = boundContext || getContext?.();
    if (!ctx) return Promise.resolve();
    try {
        const result = ctx.saveMetadata ? ctx.saveMetadata() : ctx.saveMetadataDebounced?.();
        return Promise.resolve(result);
    } catch (error) {
        return Promise.reject(error);
    }
}

// 生产事务由 index.js 绑定固定聊天目标的 integrity/commitState saver；测试可不绑定并注入 runtime.save。
export function bindLedgerMetadataPersistence(adapter = null) {
    fixedMetadataPersistence = adapter && typeof adapter.commit === 'function' ? adapter : null;
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
        周期长度: o.周期长度 === null || o.周期长度 === undefined || String(o.周期长度).trim() === '' ? null : (Number.isFinite(+o.周期长度) && +o.周期长度 > 0 ? +o.周期长度 : null),   // 仅「周期」
        到期锚  : o.到期锚 ? normalizeAnchor(o.到期锚) : null,          // 仅「约定待办/周期」
        状态    : o.状态 === '已了结' ? '已了结' : '活跃',
        锁      : o.锁 === '用户锁' ? '用户锁' : '',
        ts      : Number.isFinite(+o.ts) ? +o.ts : Date.now(),         // 打点时间戳（新字段·末尾·可选）
        静音    : o.静音 === true,                                     // 暂停埋入（新字段·末尾·可选）：停注入、判定车不归档，仍活跃
    };
    if (typeof o.来源状态 === 'string' && o.来源状态.trim()) entry.来源状态 = o.来源状态.trim();
    return entry;
}

function validLedgerIdentity(entries, seq) {
    const ids = (entries || []).map(entry => String(entry?.id || ''));
    const max = ids.reduce((n, id) => /^L\d+$/.test(id) ? Math.max(n, Number(id.slice(1))) : n, 0);
    return ids.every(id => /^L\d+$/.test(id)) && new Set(ids).size === ids.length && (seq === undefined || (Number.isInteger(seq) && seq >= max));
}
async function compensateOrFail(persist, ctx, target, before, restore, original) {
    restore();
    try { const rollback = await persist(ctx, { compensate: true, target }); if (rollback?.ok === false || rollback?.commitState === 'unknown') throw Object.assign(new Error('rollback-save-failed'), { phase: 'rollback-save-failed' }); }
    catch (error) { error.phase = 'rollback-save-failed'; throw error; }
    throw original;
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

// 捕获控制器只读取最小的持久任务状态。老档已有条目或 seq>0 视为曾经初始化过，
// 等下一次合法写入再补 initialized 标记，不为兼容迁移单独写盘。
export function captureStateFromRoot(m) {
    if (!m) return { initialized: false, explicitInitialized: false, checkpoint: null, ledgerRevision: ledgerRevision(null) };
    return {
        initialized: m.initialized === true || m.entries.length > 0 || Number(m.seq) > 0,
        explicitInitialized: m.initialized === true,
        checkpoint: m.provenanceCheckpoint && typeof m.provenanceCheckpoint === 'object' ? cloneState(m.provenanceCheckpoint) : null,
        ledgerRevision: ledgerRevision(m),
    };
}
export function getCaptureState() { return captureStateFromRoot(ledger()); }

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
        const saved = await persistAwaitable();
        if (saved && (saved.ok !== true || saved.commitState !== 'confirmed')) {
            throw Object.assign(new Error(saved.reason || (saved.commitState === 'unknown' ? '外置写入结果未确认，请刷新后核实' : 'ledger-save-unconfirmed')), {
                phase: 'save', commitState: saved.commitState || 'not-dispatched', saveResult: saved,
            });
        }
        return prepared;
    } catch (error) {
        if (error?.saveResult?.commitState !== 'unknown') {
            m.entries.length = oldLen;
            m.seq = oldSeq;
        }
        throw error;
    }
}

// 捕获专用一次保存：新增与现有条目 patch 同事务，任一步失败都恢复内存。
export async function applyCapturePlanAtomic({ additions = [], patches = [], metaPatch = null } = {}, owner = null, runtime = null) {
    const m = runtime?.state || ledger(true); if (!m) return { added: [], patched: [] };
    const ctx = runtime?.context || getContext?.(); const readContext = runtime?.contextReader || getContext; const persist = runtime?.save || ((bound, options) => persistAwaitable(bound, options));
    const guard = () => !owner || (readContext?.()?.chatId === owner.chatId && (owner.guard ? owner.guard() : true));
    if (!guard()) throw Object.assign(new Error('capture-stale-chat'), { phase: 'capture-stale-chat' });
    const before = cloneState(m);
    let planned = null;
    const addedIds = new Set();
    const patchedBefore = new Map();
    const metaBefore = Object.fromEntries(['initialized', 'provenanceCheckpoint'].map(key => [key, { had: Object.prototype.hasOwnProperty.call(before, key), value: cloneState(before[key]) }]));
    const restore = () => {
        // 只撤销仍等于本事务计划值的字段；持久化等待期间用户的新编辑/锁定/新增不得被整根快照吞掉。
        if (!planned) return;
        m.entries = (m.entries || []).filter(entry => {
            if (!addedIds.has(entry?.id)) return true;
            const expected = planned.entries.find(item => item.id === entry.id);
            return JSON.stringify(entry) !== JSON.stringify(expected);
        });
        for (const [id, fields] of patchedBefore) {
            const entry = m.entries.find(item => item.id === id), expected = planned.entries.find(item => item.id === id);
            if (!entry || !expected) continue;
            for (const [key, old] of Object.entries(fields)) {
                if (JSON.stringify(entry[key]) !== JSON.stringify(expected[key])) continue;
                if (old.had) entry[key] = cloneState(old.value); else delete entry[key];
            }
        }
        for (const key of ['initialized', 'provenanceCheckpoint']) {
            if (JSON.stringify(m[key]) !== JSON.stringify(planned[key]) || Object.prototype.hasOwnProperty.call(m, key) !== Object.prototype.hasOwnProperty.call(planned, key)) continue;
            if (metaBefore[key].had) m[key] = cloneState(metaBefore[key].value); else delete m[key];
        }
        if (m.seq === planned.seq && !(m.entries || []).some(entry => /^L\d+$/.test(String(entry?.id || '')) && Number(entry.id.slice(1)) > before.seq)) m.seq = before.seq;
    };
    try {
        if (!validLedgerIdentity(m.entries, m.seq)) throw Object.assign(new Error('capture-state-invalid'), { phase: 'capture-state-invalid' });
        const applied = [];
        const gist = value => String(value || '').replace(/\s+/g, '');
        const sameEpisode = (old, item) => {
            const a = old?.起始锚, b = item?.起始锚;
            const date = a?.历日期 && b?.历日期 && a.历日期.month === b.历日期.month && a.历日期.day === b.历日期.day && (a.历日期.year == null || b.历日期.year == null || a.历日期.year === b.历日期.year) && (a.历日期.eraLabel == null || b.历日期.eraLabel == null || a.历日期.eraLabel === b.历日期.eraLabel);
            const floor = a?.楼层 != null && b?.楼层 != null && Number(a.楼层) === Number(b.楼层);
            const people = (item?.牵扯 || []).some(x => (old?.牵扯 || []).includes(x));
            const words = `${old?.事由 || ''} ${(old?.标签 || []).join(' ')}`.split(/[\s、，,]/).filter(x => x.length >= 2);
            return date && floor && old?.类型 === item?.类型 && people && words.some(x => String(item?.事由 || '').includes(x) || (item?.标签 || []).includes(x));
        };
        const added = (Array.isArray(additions) ? additions : [])
            .filter(item => !['来源已删除', '待确认'].includes(String(item?.来源状态 || '')))
            .filter(item => !m.entries.some(existing => gist(existing.事由) === gist(item.事由) || sameEpisode(existing, item)))
            .map(item => normalizeEntry(item, `L${++m.seq}`));
        for (const change of (Array.isArray(patches) ? patches : [])) {
            const entry = m.entries.find(item => item.id === change?.id);
            if (!entry || entry.状态 === '已了结' || entry.锁 === '用户锁' || ['来源已删除', '待确认'].includes(String(entry.来源状态 || ''))) continue;
            const patch = change.patch || {};
            if (patch._sourceToken && !/^F\d+[SE]$/i.test(String(patch._sourceToken))) continue;
            const old = {};
            for (const key of ['现状', '现状锚', '牵扯', '标签', '到期锚', '周期长度']) if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) { old[key] = { had: Object.prototype.hasOwnProperty.call(entry, key), value: cloneState(entry[key]) }; entry[key] = patch[key]; }
            if (Object.keys(old).length) patchedBefore.set(entry.id, old);
            applied.push(entry.id);
        }
        m.entries.push(...added);
        added.forEach(entry => addedIds.add(entry.id));
        if (metaPatch && typeof metaPatch === 'object') {
            if (Object.prototype.hasOwnProperty.call(metaPatch, 'initialized')) {
                if (metaPatch.initialized === true) m.initialized = true;
                else delete m.initialized;
            }
            if (Object.prototype.hasOwnProperty.call(metaPatch, 'checkpoint')) {
                if (metaPatch.checkpoint && typeof metaPatch.checkpoint === 'object') m.provenanceCheckpoint = cloneState(metaPatch.checkpoint);
                else delete m.provenanceCheckpoint;
            }
        }
        if (m.provenanceCheckpoint?.ledgerRevision === '@after') m.provenanceCheckpoint.ledgerRevision = ledgerRevision(m);
        planned = cloneState(m);
        if (!validLedgerIdentity(m.entries, m.seq) || (before.entries.length > 0 && m.entries.length < before.entries.length)) throw Object.assign(new Error('capture-plan-invalid'), { phase: 'capture-state-invalid' });
        if (!guard()) throw Object.assign(new Error('capture-stale-chat'), { phase: 'capture-stale-chat' });
        const saved = await persist(ctx, { ownerGuard: guard, target: owner?.target });
        if (saved?.commitState === 'unknown') await handleUnknownPersistence(saved, restore, () => persist(ctx, { compensate: true, target: owner?.target }));
        if (saved && saved.ok === false) throw Object.assign(new Error(saved.reason || 'capture-save-failed'), { phase: 'capture-save-failed', saveResult: saved });
        if (!validLedgerIdentity(m.entries, m.seq) || (before.entries.length > 0 && m.entries.length < before.entries.length) || JSON.stringify(m) !== JSON.stringify(planned)) await compensateOrFail(persist, ctx, owner?.target, before, restore, Object.assign(new Error('capture-state-invalid'), { phase: 'capture-state-invalid' }));
        if (!guard()) {
            if (saved?.commitState === 'legacy-unconfirmed') {
                restore();
                throw Object.assign(new Error('capture-stale-chat'), { phase: 'capture-stale-chat', saveResult: saved });
            }
            await compensateOrFail(persist, ctx, owner?.target, before, restore, Object.assign(new Error('capture-stale-chat'), { phase: 'capture-stale-chat' }));
        }
        return { added, patched: applied.map(id => ({ id })), ledgerRevision: ledgerRevision(m) };
    } catch (error) { restore(); throw error; }
}

export async function reconcileEntriesAtomic(sources, chatLength, owner = null, runtime = null) {
    const m = runtime?.state || ledger(true); if (!m) return { changed: false, summary: { cleaned: 0, remapped: 0, lockedMissing: 0, pending: 0 } };
    const ctx = runtime?.context || getContext?.(); const readContext = runtime?.contextReader || getContext; const persist = runtime?.save || ((bound, options) => persistAwaitable(bound, options));
    const guard = () => !owner || (readContext?.()?.chatId === owner.chatId && (owner.guard ? owner.guard() : true));
    const save = async (check, options = {}) => { if (!options.compensate && !check?.()) throw Object.assign(new Error('source-stale-chat'), { phase: 'source-stale-chat' }); return persist(ctx, { ...options, ownerGuard: check, target: owner?.target }); };
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
    const ctx = runtime?.context || getContext?.(); const readContext = runtime?.contextReader || getContext; const persist = runtime?.save || ((bound, options) => persistAwaitable(bound, options));
    const guard = () => !owner || (readContext?.()?.chatId === owner.chatId && (owner.guard ? owner.guard() : true));
    if (!guard()) throw Object.assign(new Error('judge-stale-chat'), { phase: 'judge-stale-chat' });
    const before = cloneState(m.entries); const applied = [];
    try {
        if (!validLedgerIdentity(m.entries, m.seq)) throw Object.assign(new Error('judge-state-invalid'), { phase: 'judge-state-invalid' });
        for (const change of Array.isArray(patches) ? patches : []) {
            const entry = m.entries.find(item => item.id === change?.id);
            if (!entry) throw Object.assign(new Error('unknown-ledger-id'), { code: 'unknown-ledger-id' });
            Object.assign(entry, change.patch || {});
            if (change.close) entry.状态 = '已了结';
            applied.push(entry.事由);
        }
        if (!guard()) throw Object.assign(new Error('judge-stale-chat'), { phase: 'judge-stale-chat' });
        const saved = await persist(ctx, { ownerGuard: guard, target: owner?.target });
        if (saved?.commitState === 'unknown') await handleUnknownPersistence(saved, () => { m.entries = before; }, () => persist(ctx, { compensate: true, target: owner?.target }));
        if (saved && saved.ok === false) throw Object.assign(new Error(saved.reason || 'judge-save-failed'), { phase: 'judge-save-failed', saveResult: saved });
        if (!validLedgerIdentity(m.entries, m.seq)) await compensateOrFail(persist, ctx, owner?.target, { entries: before, seq: m.seq }, () => { m.entries = before; }, Object.assign(new Error('judge-state-invalid'), { phase: 'judge-state-invalid' }));
        if (!guard()) {
            if (saved?.commitState === 'legacy-unconfirmed') {
                m.entries = before;
                throw Object.assign(new Error('judge-stale-chat'), { phase: 'judge-stale-chat', saveResult: saved });
            }
            await compensateOrFail(persist, ctx, owner?.target, { entries: before }, () => { m.entries = before; }, Object.assign(new Error('judge-stale-chat'), { phase: 'judge-stale-chat' }));
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
