// store.js — 构画统一存储层（点/线/面/间 → chat_metadata）
//
// 背景：点(schedule)/线(lines)/面(outline)/面讨论(creative-chat)/间(space-chat) 原本散落在
// localStorage（key = sp-cache-{chatId}-{kind}-{scope}，见 state.js），换浏览器/清缓存就丢，
// 且从不随 chat 文件走、不跨设备。本模块把它们收进 chat_metadata 的单个顶层 key `sp-store`，
// 跟 chat 文件一起被酒馆序列化到服务端 data/ 目录——脱离浏览器、跨设备、只留最新版。
//
// 记忆(sp-memory)、棱永久层(sp-theater) 各自已在 chat_metadata 里独立成 key、各有 schema，
// 本模块不碰它们；锚(收藏)是全局的、走 /api/files，也不在这。
//
// 数据形状（子键 = `{kind}-{scope}`，scope = user | char-<encodeURIComponent(name)>）：
//   chat_metadata['sp-store'] = {
//     version: 1,
//     data: {
//       'schedule-user'      : { raw, userName, ts },
//       'outline-user'       : { raw, ts },
//       'outline-char-Alice' : { raw, ts },
//       'lines-user'         : { raw, ts },
//       'dashed-user'        : { items: [ { id, text, createdAt, locked }, ... ], ts },
//       'creative-chat-user' : [ { role, content }, ... ],
//       'space-chat-user'    : [ ... ],
//     }
//   }
//
// 红线：存储管理面板只能增删构画自己拥有的 chat_metadata key（见 OWN_KEYS）。
// baibai_book / variables / LWB_SNAP 等是别的插件的数据，一律只读、绝不删。

import { getContext } from '../../../extensions.js';

const STORE_KEY      = 'sp-store';
const SCHEMA_VERSION = 1;

// 构画自己拥有的 chat_metadata 顶层 key。面板据此区分"构画 vs 别的插件"，也是 clearOwnKey 的白名单。
export const OWN_KEYS = ['sp-store', 'sp-memory', 'sp-theater', 'sp-ledger'];

// 收进 sp-store 的 7 类数据（theater-draft 是设备相关的草稿，留 localStorage，不在此列）。
// dashed（虚线·冷知识）与 almanac（历）都不分视角，运行时固定走 user scope（子键恒为 dashed-user / almanac-user）。
// 顺序无所谓，但注意没有任何一个是另一个的前缀——子键解析(usageByKind/clearKind)依赖这点。
export const KINDS = ['schedule', 'outline', 'lines', 'creative-chat', 'space-chat', 'dashed', 'almanac', 'caldesc', 'caldesc-fallback', 'date-anchor'];
export const INTERNAL_KINDS = Object.freeze(['caldesc', 'caldesc-fallback', 'date-anchor']);
export const USER_CLEAR_KINDS = Object.freeze(KINDS.filter(kind => !INTERNAL_KINDS.includes(kind)));
const isInternalKind = kind => INTERNAL_KINDS.includes(String(kind || ''));

// ═══════════════════════════════════════════════════════════════════════════
//  scope / 子键
// ═══════════════════════════════════════════════════════════════════════════

// 复用 state.js 的 scope 规则：char 视角且有名字 → char-<enc>，否则 user。
function scopeOf(view, charName) {
    // .trim() 对齐 state.js normalizeScopePart，保证运行时子键与迁移搬过来的子键完全一致。
    return (view === 'char' && charName)
        ? `char-${encodeURIComponent(String(charName).trim())}`
        : 'user';
}

// 子键 = `{kind}-{scope}`。注意 schedule 在这里**也带 kind 前缀**（`schedule-user`），
// 与 localStorage 时代的裸 key（`sp-cache-{chatId}-user`）不同——迁移时由 store 层负责换算。
export function subKey(kind, view = 'user', charName = '') {
    return `${kind}-${scopeOf(view, charName)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  chat_metadata 存取（照 theater.js meta()/persist() 同款）
// ═══════════════════════════════════════════════════════════════════════════

function freshStore() {
    return { version: SCHEMA_VERSION, data: {} };
}

// 取当前 chat 的 sp-store。无 chat 时返回 null。
// create=false（读路径）：sp-store 不存在就返回 null，**绝不实例化**——否则"读一下"就会往
//   chatMetadata 塞个空壳、把 chat 存档写脏，还会让迁移误判"metadata 已有数据"。
// create=true（写路径）：按需初始化 + 版本对齐。
// 每次现取 getContext()，不缓存——CHAT_CHANGED 会换掉 chatMetadata 引用，缓存会读到旧 chat。
function store(create = false) {
    const ctx = getContext?.();
    if (!ctx || !ctx.chatId) return null;
    const cm = ctx.chatMetadata;
    if (!cm) return null;
    let s = cm[STORE_KEY];
    if (!s || typeof s !== 'object') {
        if (!create) return null;
        s = cm[STORE_KEY] = freshStore();
    }
    if (!s.data || typeof s.data !== 'object') s.data = {};
    // 版本对齐只在写路径做：读路径若也把内存 version 拔到最新却不落盘、不迁移，
    // 将来 bump schema 时写路径会误判「已是最新」而跳过迁移，数据停在旧结构却挂新版本号。
    // 故读路径原样返回（version 保持磁盘值），迁移一律推到下一次写路径（在此补迁移逻辑）。
    if (create && s.version !== SCHEMA_VERSION) {
        // v1 是初版，无历史结构要迁移；未来 bump 时在此补齐。
        s.version = SCHEMA_VERSION;
        persist();
    }
    return s;
}

function persist() {
    // 立即落盘，而非 saveMetadataDebounced：切档时 ST 的 clearChat() 会
    // cancelDebouncedMetadataSave() 取消还没触发的防抖保存，紧接着 chat_metadata={}，
    // 防抖那份就永不落盘 → 点线面/记忆丢失。saveMetadata() 同步快照 chat_metadata、
    // 走 diff patch（无变化即 no-op），写完当场发出，切档取消不掉。
    const ctx = getContext?.();
    if (!ctx) return;
    if (ctx.saveMetadata) ctx.saveMetadata();
    else ctx.saveMetadataDebounced?.();   // 兜底：老版本 ST 无 saveMetadata
}

// 清理等破坏性动作使用可等待版本：ST 旧版可能只返回 undefined；若返回 Promise，
// 调用方必须等待其完成后才能刷新 UI。ST 内部吞掉的磁盘错误仍无法从插件侧观测。
async function persistAsync() {
    const ctx = getContext?.();
    if (!ctx) return;
    const result = ctx.saveMetadata ? ctx.saveMetadata() : ctx.saveMetadataDebounced?.();
    if (result && typeof result.then === 'function') await result;
}

// sp-store 顶层 key 是否已存在（不含内容判断，也不实例化）。
export function hasStore() {
    const cm = getContext?.()?.chatMetadata;
    return !!(cm && cm[STORE_KEY] && typeof cm[STORE_KEY] === 'object');
}

// 当前 chat 的 sp-store 是否**含真实点线面间数据**（忽略空壳）。迁移冲突检测用这个，不用 hasStore。
export function hasAnyData() {
    const s = store(false);
    if (!s) return false;
    return Object.keys(s.data).some(sk => kindOfSubKey(sk));
}

// ═══════════════════════════════════════════════════════════════════════════
//  读 / 写 / 删（对外主 API，替换掉散落的 localStorage 调用）
// ═══════════════════════════════════════════════════════════════════════════
//
// value 直接是对象/数组（不再 JSON.stringify）——chat_metadata 存活对象，由酒馆存档时统一序列化。

export function readData(kind, view = 'user', charName = '') {
    const s = store();
    if (!s) return null;
    const v = s.data[subKey(kind, view, charName)];
    return v == null ? null : v;
}

export function writeData(kind, view, charName, value) {
    const s = store(true);
    if (!s) return false;
    if (value == null) { removeData(kind, view, charName); return true; }
    s.data[subKey(kind, view, charName)] = value;
    persist();
    return true;
}

// 同一业务需要同时更新多份子数据时，只改一次内存对象并统一落盘，避免两次 saveMetadata
// 之间切档造成“只写成功一半”。entries: [{ kind, view, charName, value }]。
export function writeBatch(entries) {
    const list = Array.isArray(entries) ? entries.filter(it => it?.kind) : [];
    if (!list.length) return false;
    if (!_applyBatch(list)) return false;
    persist();
    return true;
}

function _clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function _applyBatch(list) {
    const s = store(true); if (!s) return false;
    for (const it of list) { const key = subKey(it.kind, it.view, it.charName); if (it.value == null) delete s.data[key]; else s.data[key] = it.value; }
    return true;
}

export function stageBatch(entries, { expectedChatId } = {}) {
    if (expectedChatId == null || getContext?.()?.chatId !== expectedChatId) return null;
    const list = Array.isArray(entries) ? entries.filter(it => it?.kind) : [];
    const s = store(true); if (!s || !list.length) return null;
    const before = list.map(it => { const key = subKey(it.kind, it.view, it.charName); return { key, existed: Object.prototype.hasOwnProperty.call(s.data, key), value: _clone(s.data[key]) }; });
    if (!_applyBatch(list)) return null;
    return { token: `store-${Date.now()}-${Math.random()}`, chatId: expectedChatId, before, entries: list.map(it => ({ ...it })), staged: true };
}

export function verifyBatch(token) {
    if (!token?.staged || getContext?.()?.chatId !== token.chatId) return false;
    const s = store(false); if (!s) return false;
    return token.entries.every(it => { const key = subKey(it.kind, it.view, it.charName); return JSON.stringify(s.data[key] ?? null) === JSON.stringify(it.value ?? null); });
}

export function restoreBatch(token) {
    if (!token?.staged || getContext?.()?.chatId !== token.chatId) return { ok: false, reason: 'chat-mismatch' };
    const s = store(false); if (!s) return { ok: false, reason: 'no-store' };
    for (const item of token.before) { if (JSON.stringify(s.data[item.key] ?? null) !== JSON.stringify(token.entries.find(it => subKey(it.kind, it.view, it.charName) === item.key)?.value ?? null)) return { ok: false, reason: 'content-mismatch' }; }
    for (const item of token.before) { if (item.existed) s.data[item.key] = _clone(item.value); else delete s.data[item.key]; }
    return { ok: true };
}

export function removeData(kind, view = 'user', charName = '') {
    const s = store();
    if (!s) return;
    const k = subKey(kind, view, charName);
    if (k in s.data) { delete s.data[k]; persist(); }
}

// 按原始子键直接写（迁移时用——迁移已经算好了 `{kind}-{scope}` 子键，不必再拆 view/charName）。
export function writeRaw(subKeyStr, value) {
    const s = store(true);
    if (!s || !subKeyStr) return false;
    s.data[subKeyStr] = value;
    persist();
    return true;
}

// char 视角最近填过的名字（每卡一份：随 sp-store 进 chat_metadata，换卡即换一份）。
// 存原始子键 'charnames-recent'——不属于 6 类 kind，kindOfSubKey 返回 null，故用量统计/按 kind 清理
// 都会跳过它，只在整个 sp-store 被清时一起没（符合"边角便利、跟着聊天走"定位）。
const CHARNAMES_SUBKEY = 'charnames-recent';
export function readRecentCharNames() {
    const s = store();
    if (!s) return [];
    const v = s.data[CHARNAMES_SUBKEY];
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];
}
// 把 name 提到最前、去重（大小写敏感按原样留）、只留最近 max 个。
export function pushRecentCharName(name, max = 3) {
    const n = String(name || '').trim();
    if (!n) return;
    const s = store(true);
    if (!s) return;
    const prev = Array.isArray(s.data[CHARNAMES_SUBKEY]) ? s.data[CHARNAMES_SUBKEY] : [];
    const next = [n, ...prev.filter(x => x !== n)].slice(0, max);
    s.data[CHARNAMES_SUBKEY] = next;
    persist();
}

// char 固定槽（每卡一份，随 sp-store 走）：与上面的「最近填过」语义不同——
//   recent = 自动滚动的历史（新名挤旧名），只当填写框预填快捷 chip；
//   pins   = 用户**手动钉/删**的常驻抽屉槽，绝不自动滚动、绝不因「查看某人」被动增删。
// 查看任意角色（含 NPC/反派）都不占槽；想固定才主动 addPinnedChar，满 PIN_CAP 就拒绝加。
// 同存原始子键 'char-pins'——不属 KINDS，用量统计/按 kind 清理都跳过，只随整份 sp-store 清空。
const CHARPINS_SUBKEY = 'char-pins';
export const PIN_CAP = 3;
export function readPinnedChars() {
    const s = store();
    if (!s) return [];
    const v = s.data[CHARPINS_SUBKEY];
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, PIN_CAP) : [];
}
// 加一个固定槽。已在槽内 → 返回 'exists'（幂等，不重复）；已满 → 返回 'full'（拒绝，调用端提示）；
// 成功追加到末尾（保持钉入顺序，不前移）→ 返回 'ok'。
export function addPinnedChar(name) {
    const n = String(name || '').trim();
    if (!n) return 'full';
    const s = store(true);
    if (!s) return 'full';
    const prev = Array.isArray(s.data[CHARPINS_SUBKEY]) ? s.data[CHARPINS_SUBKEY].filter(x => typeof x === 'string' && x.trim()) : [];
    if (prev.includes(n)) return 'exists';
    if (prev.length >= PIN_CAP) return 'full';
    s.data[CHARPINS_SUBKEY] = [...prev, n];
    persist();
    return 'ok';
}
// 移除一个固定槽（幂等：不在槽内也算成功）。返回是否有实际删除。
export function removePinnedChar(name) {
    const n = String(name || '').trim();
    const s = store();
    if (!s) return false;
    const prev = Array.isArray(s.data[CHARPINS_SUBKEY]) ? s.data[CHARPINS_SUBKEY] : [];
    const next = prev.filter(x => x !== n);
    if (next.length === prev.length) return false;
    s.data[CHARPINS_SUBKEY] = next;
    persist();
    return true;
}
export function isPinnedChar(name) {
    const n = String(name || '').trim();
    return !!n && readPinnedChars().includes(n);
}

// ═══════════════════════════════════════════════════════════════════════════
//  用量统计 / 清理（供存储管理面板）
// ═══════════════════════════════════════════════════════════════════════════

// UTF-16 粗估字节，跟 anchor/theater 的 formatBytes 口径一致。
function valueBytes(v) {
    try { return (JSON.stringify(v) || '').length * 2; }
    catch { return 0; }
}

// 子键 `{kind}-{scope}` → kind。kind 里 creative-chat/space-chat 含连字符，靠已知 KINDS 前缀匹配，
// 且 KINDS 两两互不为前缀，故匹配唯一。
function kindOfSubKey(sk) {
    const value = String(sk || '');
    return [...KINDS].sort((a, b) => b.length - a.length).find(k => value === k || value.startsWith(k + '-')) || null;
}

export function isStorageDataKeyClearable(dataKey) {
    return String(dataKey || '') === 'almanac-user';
}

// 本 chat 各 kind 用量：{ schedule, outline, lines, 'creative-chat', 'space-chat' } → 字节数。
export function usageByKind() {
    const out = {};
    for (const k of KINDS) out[k] = 0;
    const s = store();
    if (!s) return out;
    for (const [sk, v] of Object.entries(s.data)) {
        const kind = kindOfSubKey(sk);
        if (!kind) continue;
        out[kind] += valueBytes(v) + sk.length * 2;
    }
    return out;
}

export function storeTotalBytes() {
    return Object.values(usageByKind()).reduce((a, b) => a + b, 0);
}

// 清掉某 kind 的所有 scope 子键（我/TA 视角全清）。返回删除条数。
export function clearKind(kind) {
    if (!USER_CLEAR_KINDS.includes(kind)) return 0;
    const s = store();
    if (!s) return 0;
    let n = 0;
    for (const sk of Object.keys(s.data)) {
        if (sk === kind || sk.startsWith(kind + '-')) { delete s.data[sk]; n++; }
    }
    if (n) persist();
    return n;
}

// 精确删除一个 sp-store.data 子键；不按前缀扩展，供高风险 UI 清理使用。
export async function clearDataKeyAsync(dataKey) {
    if (typeof dataKey !== 'string' || !dataKey) return false;
    if (!isStorageDataKeyClearable(dataKey)) return false;
    if (isInternalKind(kindOfSubKey(dataKey))) return false;
    const s = store();
    if (!s || !(dataKey in s.data)) return false;
    const previous = s.data[dataKey];
    delete s.data[dataKey];
    try {
        await persistAsync();
        return true;
    } catch (error) {
        if (!(dataKey in s.data)) s.data[dataKey] = previous;
        throw error;
    }
}

export async function clearKindAsync(kind) {
    if (!USER_CLEAR_KINDS.includes(kind)) return 0;
    const s = store();
    if (!s) return 0;
    const removed = Object.entries(s.data).filter(([sk]) => sk === kind || sk.startsWith(kind + '-'));
    if (!removed.length) return 0;
    for (const [sk] of removed) delete s.data[sk];
    try {
        await persistAsync();
        return removed.length;
    } catch (error) {
        for (const [sk, value] of removed) if (!(sk in s.data)) s.data[sk] = value;
        throw error;
    }
}

// 某个构画自有顶层 key（sp-store / sp-memory / sp-theater）当前占用字节。
export function ownKeyBytes(key) {
    const cm = getContext?.()?.chatMetadata;
    if (!cm || cm[key] == null) return 0;
    return valueBytes(cm[key]) + String(key).length * 2;
}

// 整体删掉一个构画自有 key（面板"清空本聊天全部点线面间 / 清空记忆 / 清空棱永久"用）。
// 安全阀：只允许 OWN_KEYS 里的 key，别的插件的数据一律拒删。
export function clearOwnKey(key) {
    if (!OWN_KEYS.includes(key) || key === STORE_KEY) return false;
    const cm = getContext?.()?.chatMetadata;
    if (!cm || cm[key] == null) return false;
    delete cm[key];
    persist();
    return true;
}

export async function clearOwnKeyAsync(key) {
    if (!OWN_KEYS.includes(key) || key === STORE_KEY) return false;
    const cm = getContext?.()?.chatMetadata;
    if (!cm || cm[key] == null) return false;
    const previous = cm[key];
    delete cm[key];
    try {
        await persistAsync();
        return true;
    } catch (error) {
        if (!(key in cm)) cm[key] = previous;
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  一次性迁移：localStorage(sp-cache-*) → chat_metadata['sp-store']
// ═══════════════════════════════════════════════════════════════════════════
//
// 老用户的点/线/面/间散在 localStorage（state.js buildCacheKey：
//   schedule 裸键 `sp-cache-{chatId}-{scope}`，其余 `sp-cache-{chatId}-{kind}-{scope}`，
//   scope = user | char-<enc>）。首次切进某 chat 时把该 chat 的**所有 scope**搬进
//   sp-store，再删 localStorage 副本。theater-draft 是设备相关草稿，明确跳过。
//
// 由 index.js 在 CHAT_CHANGED 里、**早于各视图 load** 同步调用。返回值告诉 index.js
// 发生了什么；唯 'conflict'（云端/本机各一份且不同）需 index.js 事后弹窗决策——
// 迁移函数本身绝不弹窗、绝不在冲突时改动任何一边数据。

const LEGACY_PREFIX = 'sp-cache-';
// 会以「前缀段」出现在裸键之后的非 schedule kind（theater-draft 也列出，用于识别→跳过）。
const LEGACY_KINDS  = ['outline', 'lines', 'creative-chat', 'space-chat'];

function isValidScope(scope) {
    return scope === 'user' || scope.startsWith('char-');
}

// 把 `sp-cache-{chatId}-` 之后的剩余段解析成 { kind, scope }。认不出合法 scope
// （多半是 chatId 撞前缀的别家键）或命中 theater-draft → 返回 null（跳过）。
function parseLegacyRest(rest) {
    for (const k of LEGACY_KINDS) {
        if (rest === k || rest.startsWith(k + '-')) {
            const scope = rest.slice(k.length + 1);
            return isValidScope(scope) ? { kind: k, scope } : null;
        }
    }
    if (rest === 'theater-draft' || rest.startsWith('theater-draft-')) return null; // 设备草稿，不迁
    return isValidScope(rest) ? { kind: 'schedule', scope: rest } : null;           // 裸键 = schedule
}

// 扫出本 chat 的所有 legacy 键：[{ key, subKey, value }]（value 已 JSON.parse）。
function scanLegacy(chatId) {
    const out = [];
    const prefix = `${LEGACY_PREFIX}${chatId}-`;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const parsed = parseLegacyRest(key.slice(prefix.length));
        if (!parsed) continue;
        let value;
        try { value = JSON.parse(localStorage.getItem(key)); }
        catch { continue; } // 损坏 → 跳过（留在 localStorage，不误删）
        if (value == null) continue;
        out.push({ key, subKey: `${parsed.kind}-${parsed.scope}`, value });
    }
    return out;
}

function tsOf(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Number.isFinite(+v.ts)) return +v.ts;
    return 0;
}

// legacy 与云端构画子键集合是否**完全一致**（子键集合 + 各自值 JSON 串都相等）。
function legacyEqualsCloud(legacy, cloudData) {
    const cloudKeys = Object.keys(cloudData).filter(kindOfSubKey);
    if (cloudKeys.length !== legacy.length) return false;
    for (const it of legacy) {
        if (!(it.subKey in cloudData)) return false;
        if (JSON.stringify(cloudData[it.subKey]) !== JSON.stringify(it.value)) return false;
    }
    return true;
}

// 概况（给冲突弹窗）：{ kinds:[kind...], latestTs, count }。中文标签由 index.js 映射。
function summarizeData(dataMap) {
    const kinds = new Set();
    let latestTs = 0, count = 0;
    for (const [sk, v] of Object.entries(dataMap)) {
        const kind = kindOfSubKey(sk);
        if (!kind) continue;
        kinds.add(kind); count++;
        const ts = tsOf(v);
        if (ts > latestTs) latestTs = ts;
    }
    return { kinds: [...kinds], latestTs, count };
}

function summarizeLegacy(legacy) {
    const map = {};
    for (const it of legacy) map[it.subKey] = it.value;
    return summarizeData(map);
}

// 主迁移。**同步**，返回：
//   { status:'none' }                            localStorage 无本 chat 数据
//   { status:'migrated', count }                 云端空 → 搬入 + 清 localStorage
//   { status:'equal', count }                    两边一致 → 静默清 localStorage
//   { status:'conflict', legacy, cloud, local }  两边都有且不同 → **不动数据**，交 index.js 弹窗
export function migrateChatFromLocalStorage(chatId) {
    if (!chatId) return { status: 'none' };
    const legacy = scanLegacy(chatId);
    if (!legacy.length) return { status: 'none' };

    const s = store(true);
    if (!s) return { status: 'none' };

    const cloudHasData = Object.keys(s.data).some(kindOfSubKey);
    if (!cloudHasData) {
        for (const it of legacy) s.data[it.subKey] = it.value;
        persist();
        legacy.forEach(it => localStorage.removeItem(it.key));
        return { status: 'migrated', count: legacy.length };
    }
    if (legacyEqualsCloud(legacy, s.data)) {
        legacy.forEach(it => localStorage.removeItem(it.key));
        return { status: 'equal', count: legacy.length };
    }
    return {
        status: 'conflict',
        legacy,
        cloud: summarizeData(s.data),
        local: summarizeLegacy(legacy),
    };
}

// 冲突决策：用户选「保留本机」→ 清掉云端构画子键、写入 legacy、删 localStorage。
export function applyLegacyOverCloud(legacy) {
    const s = store(true);
    if (!s || !Array.isArray(legacy)) return false;
    for (const sk of Object.keys(s.data)) if (kindOfSubKey(sk)) delete s.data[sk];
    for (const it of legacy) s.data[it.subKey] = it.value;
    persist();
    legacy.forEach(it => localStorage.removeItem(it.key));
    return true;
}

// 冲突决策：用户选「保留云端」→ 云端不动，只丢掉 localStorage 副本。
export function discardLegacy(legacy) {
    if (!Array.isArray(legacy)) return;
    legacy.forEach(it => localStorage.removeItem(it.key));
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export { STORE_KEY, SCHEMA_VERSION };

// ===== 共享 store 访问原语（Phase 2 从 index.js 搬入，原封不动 + 命名空间/闭包机械适配）=====
// keyDesc/readStore/writeStore/removeStore 是全体业务域共用的存取入口；
// keyDesc 的 view/charName 缺省时回退到当前视图/角色，二者仍是 index.js 的视图态，故用 getter 桥注入（同 api/client.js 的 bindApiClient 模式）。
let _getCurrentView = () => 'user';
let _getCharViewName = () => null;
export function bindStoreViewFallback(getCurrentView, getCharViewName) {
    if (getCurrentView) _getCurrentView = getCurrentView;
    if (getCharViewName) _getCharViewName = getCharViewName;
}

// view/charName 在此解析成当前视角默认值；store 层据此算 `{kind}-{scope}` 子键。
export function keyDesc(kind, view, charName) {
    if (!getContext().chatId) return null;
    return { kind, view: view ?? _getCurrentView(), charName: charName ?? _getCharViewName() };
}
export function readStore(desc)         { return desc ? readData(desc.kind, desc.view, desc.charName) : null; }
export function writeStore(desc, value) { return !!(desc && writeData(desc.kind, desc.view, desc.charName, value)); }
export function removeStore(desc)       { if (desc) removeData(desc.kind, desc.view, desc.charName); }
