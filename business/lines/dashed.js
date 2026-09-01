import { diagnosticMessage, safeDiagnosticLog } from '../../api/diagnostics.js';

// 虚线／冷知识线子模块：宿主只注入平台能力与刷新回调。
export const DASHED_TOPIC_CONFIG = Object.freeze([
    Object.freeze({ value: 'user', label: 'user', prompt: name => `${name} 本人` }),
    Object.freeze({ value: 'char', label: 'char', prompt: name => `${name} 本人` }),
    Object.freeze({ value: 'world', label: '世界观', prompt: () => '世界观设定' }),
    Object.freeze({ value: 'history', label: '历史传说', prompt: () => '历史与传说' }),
    Object.freeze({ value: 'factions', label: '势力组织', prompt: () => '势力与组织' }),
    Object.freeze({ value: 'places', label: '地点风物', prompt: () => '地点与风物' }),
    Object.freeze({ value: 'items', label: '物品特性', prompt: () => '物品或造物的隐藏特性' }),
    Object.freeze({ value: 'rules', label: '规则因果', prompt: () => '未被明说的规则或因果' }),
    Object.freeze({ value: 'customs', label: '习俗禁忌', prompt: () => '习俗与禁忌' }),
]);
export const DASHED_AVOID_COUNT = 12;
export const DASHED_MAX_CODE_POINTS = 300;
const DASHED_END_PUNCTUATION = new Set(['。', '！', '？', '.', '!', '?', '…']);
// 有界身份仅用于去重/碰撞保留，不承担安全用途；长度 + 两个独立 32-bit 摘要避免落盘完整原文。
function dashedSourceKey(value) {
    const text = String(value ?? '').trim();
    let first = 2166136261, second = 0x9e3779b9;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        first ^= code; first = Math.imul(first, 16777619);
        second ^= code + 0x6d2b79f5; second = Math.imul(second, 1597334677);
    }
    return `v1-${String(Array.from(text).length).padStart(6, '0')}-${(first >>> 0).toString(16).padStart(8, '0')}-${(second >>> 0).toString(16).padStart(8, '0')}`;
}
const dashedRecord = (record, sourceText, sourceKey = dashedSourceKey(sourceText)) => ({ ...record, sourceKey });
export function normalizeDashedText(value) {
    const text = String(value ?? '').trim();
    const chars = Array.from(text);
    if (chars.length <= DASHED_MAX_CODE_POINTS) return text;
    let lastPunctuation = -1;
    for (let i = DASHED_MAX_CODE_POINTS - 61; i < DASHED_MAX_CODE_POINTS; i++) {
        if (DASHED_END_PUNCTUATION.has(chars[i])) lastPunctuation = i;
    }
    if (lastPunctuation >= 0) return chars.slice(0, lastPunctuation + 1).join('');
    return `${chars.slice(0, DASHED_MAX_CODE_POINTS - 1).join('')}…`;
}
export function dashedTargetCount(n) { return Math.max(2, Math.floor(Number(n) || 0)); }
export function pickRandomDashedTopics(entries = DASHED_TOPIC_CONFIG, random = Math.random) {
    const pool = [...entries]; for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, 2).map(item => item.value);
}
export function dashedItemsFromRaw(raw) { return String(raw || '').split('\n').map(s => normalizeDashedText(s.replace(/^[\s\-*·•]+/, '').replace(/^\d{1,2}[.、．)）]\s*/, '').trim())).filter(Boolean); }
export function normalizeDashedKeepCount(value) { const n = Math.floor(Number(value)); return Number.isFinite(n) && n >= 2 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 15; }
export function pruneDashedItems(items, keepCount, enabled = true) {
    if (!enabled) return { items: [...(items || [])], removed: [] }; const kept = [], removed = []; let unlocked = 0; const limit = normalizeDashedKeepCount(keepCount);
    for (const item of items || []) { if (item?.locked === true || unlocked < limit) { kept.push(item); if (item?.locked !== true) unlocked++; } else removed.push(item); } return { items: kept, removed };
}
export function mergeDashedItems(newTexts, currentItems, createdAt = Date.now(), idFactory = (ts, i) => `dashed-${ts.toString(36)}-${i}-${Math.random().toString(36).slice(2, 9)}`) {
    const current = (currentItems || []).map(item => {
        const rawText = String(item?.text ?? '').trim();
        return rawText ? dashedRecord({ ...item, text: normalizeDashedText(rawText) }, rawText, item?.sourceKey) : null;
    }).filter(Boolean).filter((item, index, items) => items.findIndex(other => other.sourceKey === item.sourceKey) === index);
    const currentKeys = new Set(current.map(item => item.sourceKey));
    const currentNormalized = new Set(current.map(item => item.text));
    const seenRaw = new Set();
    const fresh = (newTexts || []).map(value => String(value ?? '').trim()).filter(rawText => rawText && !seenRaw.has(rawText) && (seenRaw.add(rawText), true));
    const added = fresh.filter(rawText => !currentKeys.has(dashedSourceKey(rawText)) && !currentNormalized.has(normalizeDashedText(rawText))).map((rawText, i) => dashedRecord({ id: idFactory(createdAt, i), text: normalizeDashedText(rawText), createdAt, locked: false }, rawText));
    return { added, items: [...added, ...current] };
}
export function buildDashedPrompt(userName, charName, avoidItems = [], options = {}) {
    const topics = (options.topics || []).map(String).filter(Boolean);
    const broad = `取材面要开阔——世界观设定、历史与传说、势力/组织、地点/风物、物品/造物的隐藏特性、未被明说的规则或因果、习俗与禁忌都可以写；${userName} 和 ${charName} 只是世界里的成员之一，可以偶尔涉及，但不要每条都围着他们转。`;
    let focus = broad; if (topics.length === 1) focus = `本次只围绕「${topics[0]}」取材，写出若干条角度不同、互不重复的冷知识，数量随有效素材浮动。`; else if (topics.length > 1) focus = `本次依次围绕以下主题取材，每个主题至少考虑一条，数量随有效素材浮动，不要凑数：\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
    let prompt = `请暂停角色扮演，跳出正文叙事，以设定考据者的身份回答。这是设定考据、不是续写正文：不要输出任何剧情场景、对话、动作或第一/第二人称叙述，不要推进故事，也不要复述记忆库/世界书里已发生的事件经过。\n请无视上文里的状态栏、数值面板、表格等格式化内容，绝对不要复述或模仿它们。\n完全遵循当前世界的设定与世界观。${focus}\n优先挖容易被忽略、却让世界更立体的角落；每条都要展开讲清来龙去脉、背景和细节，不要只丢一句结论，绝对禁止 OOC 和脱离当前背景。\n直接从第一条写起，不要开场白或旁白。输出所有非空有效条目即可，数量随素材浮动，不要凑数；每行一条，每条 50 到 100 个汉字；绝对不得超过 300 个 Unicode 字符。纯中文叙述，不要序号、状态栏或任何格式符号。`;
    const avoid = (avoidItems || []).map(x => String(x || '').trim()).filter(Boolean); if (avoid.length) prompt += `\n【以下内容最近已经讲过，务必避开；换全新的素材，改写同一件事也不允许】：\n${avoid.map(x => `- ${x}`).join('\n')}`;
    return prompt.replace(/\{\{user\}\}/g, userName).replace(/\{\{char\}\}/g, charName);
}

export function createDashedModule(env = {}) {
    let busy = false, controller = null, panelError = '';
    const key = () => env.keyDesc('dashed', 'user', '');
    const now = () => env.now?.() ?? Date.now();
    const random = () => env.random?.() ?? Math.random();
    const uuid = () => env.uuid?.() ?? globalThis.crypto?.randomUUID?.();
    const legacyId = (text, i) => { let hash = 2166136261; for (const ch of String(text || '')) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); } return `dashed-legacy-${i}-${(hash >>> 0).toString(36)}`; };
    const normalize = saved => {
        if (!saved || typeof saved !== 'object') return [];
        const ts = Number(saved.ts) || 0;
        if (Array.isArray(saved.items)) {
            const seenKeys = new Set();
            return saved.items.map((x, i) => {
                const rawText = String(x?.text ?? '').trim();
                const sourceKey = String(x?.sourceKey || dashedSourceKey(rawText));
                if (!rawText || seenKeys.has(sourceKey)) return null;
                seenKeys.add(sourceKey);
                const text = normalizeDashedText(rawText);
                return dashedRecord({ id: String(x?.id || legacyId(rawText, i)), text, createdAt: Number(x?.createdAt) || ts, locked: x?.locked === true }, rawText, sourceKey);
            }).filter(Boolean);
        }
        const strip = value => String(value ?? '').replace(/^[\s\-*·•]+/, '').replace(/^\d{1,2}[.、．)）]\s*/, '').trim();
        const seenRaw = new Set();
        return [...String(saved.raw || '').split('\n').map(strip), ...(Array.isArray(saved.recent) ? saved.recent : [])]
            .map(value => String(value ?? '').trim()).filter(rawText => rawText && !seenRaw.has(rawText) && (seenRaw.add(rawText), true))
            .map((rawText, i) => dashedRecord({ id: legacyId(rawText, i), text: normalizeDashedText(rawText), createdAt: ts, locked: false }, rawText));
    };
    const read = () => normalize(env.readStore(key())); const parse = (limit = Infinity) => read().slice(0, limit).map(x => x.text);
    const keep = () => normalizeDashedKeepCount(env.getSettings().dashedKeepCount);
    const commit = (items, ts = now()) => { const result = pruneDashedItems(items, keep(), env.getSettings().dashedCleanupEnabled !== false); if (result.items.length) env.writeStore(key(), { items: result.items.map(item => ({ ...item, sourceKey: item?.sourceKey || dashedSourceKey(item.text) })), ts }); else env.removeStore(key()); return result; };
    const refresh = () => { env.refreshPanel?.(); env.refreshInline?.(); };
    const state = () => ({ busy, error: panelError });
    async function run(options = {}) {
        if (busy) return; const manual = options.manual === true, reroll = manual || options.reroll === true; const selected = Array.isArray(options.topics) && options.topics.length ? options.topics : pickRandomDashedTopics(DASHED_TOPIC_CONFIG, random); const count = dashedTargetCount(options.count || selected.length || 2); const chatId = env.chatId(); const ctrl = controller = new AbortController(); busy = true; panelError = ''; refresh();
        try { const ctx = env.context(), user = ctx.name1 || '用户', char = ctx.name2 || '角色', cfg = env.loadConfig(); if (!cfg.url || !cfg.key) throw new Error('未配置自定义 API'); const topics = selected.map(value => { if (value === 'custom') return String(options.customValue || '').trim(); const item = DASHED_TOPIC_CONFIG.find(x => x.value === value); return item ? item.prompt(value === 'user' ? user : value === 'char' ? char : '') : ''; }).filter(Boolean); const prompt = buildDashedPrompt(user, char, reroll ? [] : parse(DASHED_AVOID_COUNT), { topics, count }); const raw = await env.callApi(ctx, prompt, cfg, user, char, ctrl.signal, 0, { ...(reroll ? { reroll: true, module: 'dashed' } : {}), promptMode: 'creative', diagnosticModule: 'dashed' }); if (controller !== ctrl) return; if (env.chatId() !== chatId) { busy = false; controller = null; return; } const returned = dashedItemsFromRaw(raw); if (!returned.length) throw new Error('模型没有返回可用的冷知识'); const current = env.filterRerollItems ? env.filterRerollItems(read(), reroll) : read(); const timestamp = now(); const merged = mergeDashedItems(returned, current, timestamp, (ts, i) => `dashed-${uuid() || `${ts.toString(36)}-${i}-${random().toString(36).slice(2, 9)}`}`); const committed = merged.added.length ? commit(merged.items, timestamp) : { items: merged.items, removed: [] }; const kept = new Set(committed.items.map(item => item.id)); const addedCount = merged.added.filter(item => kept.has(item.id)).length; busy = false; controller = null; if (manual && env.getSettings().notifyMode !== 'off') { const suffix = addedCount < count ? `（实际有效新增 ${addedCount} 条）` : ''; env.toast(addedCount ? `已新增 ${addedCount} 条冷知识${suffix}` : '本次内容与已有冷知识重复，没有新增'); } refresh(); } catch (err) { if (controller !== ctrl) return; busy = false; controller = null; if (err?.name === 'AbortError' || env.chatId() !== chatId) return; env.logDiagnostic?.(safeDiagnosticLog('dashed', 'request', err, { background: !manual })); panelError = `生成失败：${diagnosticMessage(err)}`; refresh(); if (manual || env.getSettings().notifyMode === 'full') env.toast('冷知识生成失败，请检查 API 或网络', true); }
    }
    async function openDialog() { if (busy) return; const ctx = env.context(), chatId = ctx.chatId, user = ctx.name1 || '用户', char = ctx.name2 || '角色'; const choices = [{ value: 'random', label: '随机抽取主题', exclusive: true }, ...DASHED_TOPIC_CONFIG.map(x => ({ value: x.value, label: x.value === 'user' ? user : x.value === 'char' ? char : x.label })), { value: 'custom', label: '自定义' }]; const result = await env.dialog.selectMany({ title: '新增冷知识', body: '选择想了解的主题，生成数量按有效素材浮动。', choices, initialValues: ['random'], custom: { value: 'custom', placeholder: '填写自定义主题…', maxLength: 200 }, confirmText: '生成', validate: value => !value.values.length ? '请至少选择一个主题' : value.values.includes('custom') && !value.customValue ? '请填写自定义主题' : '' }); if (!result || env.chatId() !== chatId) return; let topics = result.values; if (topics.includes('random')) topics = pickRandomDashedTopics(DASHED_TOPIC_CONFIG, random); return run({ manual: true, topics, customValue: result.customValue, count: dashedTargetCount(topics.length) }); }
    async function remove(id) { const target = read().find(x => x.id === id); if (!target) { env.toast('这条冷知识已不存在', true); refresh(); return; } const chatId = env.chatId(); if (!await env.dialog.confirm({ title: '删除冷知识', body: '确认删除这条冷知识吗？', confirmText: '删除', cancelText: '取消' }) || env.chatId() !== chatId) return; const latest = read(); if (!latest.some(x => x.id === id)) return refresh(); commit(latest.filter(x => x.id !== id)); refresh(); }
    function toggle(id) { const latest = read(), target = latest.find(x => x.id === id); if (!target) { env.toast('这条冷知识已不存在', true); refresh(); return; } const was = target.locked === true, committed = commit(latest.map(x => x.id === id ? { ...x, locked: !was } : x)); const kept = committed.items.some(x => x.id === id); refresh(); if (was && !kept) env.toast('已解锁，并按保留规则清理这条较旧冷知识'); else if (committed.removed.length) env.toast(`${was ? '已解锁' : '已锁定'}；同时清理 ${committed.removed.length} 条较旧冷知识`); else env.toast(was ? '已解锁这条冷知识' : '已锁定这条冷知识'); return committed; }
    function cleanup(notify = false) { if (env.getSettings().dashedCleanupEnabled === false) return 0; const current = read(), preview = pruneDashedItems(current, keep(), true); if (!preview.removed.length) return 0; commit(current); refresh(); if (notify && env.getSettings().notifyMode !== 'off') env.toast(`已清理 ${preview.removed.length} 条较旧冷知识`); return preview.removed.length; }
    function inlineHtml() { if (env.getSettings().dashedEnabled !== true) return ''; const items = parse(2); let inner = busy ? '<div class="sp-dashed-inline-empty"><i class="fa-solid fa-spinner fa-spin"></i> 正在翻找冷知识…</div>' : items.length ? `<ul class="sp-dashed-list">${items.map(t => `<li>${env.escapeHtml(t)}</li>`).join('')}</ul>` : '<div class="sp-dashed-inline-empty">线生成 / 推进时会顺手抽一条冷知识</div>'; return '<div class="sp-dashed-inline-sub"><div class="sp-dashed-inline-hint"><span>世界观补充</span><button class="sp-inline-refresh-dashed' + (busy ? ' sp-refresh-busy' : '') + '" title="换一条冷知识"><i class="fa-solid fa-rotate-right"></i></button></div>' + inner + '</div>'; }
    function panelHtml() { const items = read(), s = busy ? '<div class="sp-lines-dashed-status"><i class="fa-solid fa-spinner fa-spin"></i> 正在翻找冷知识…</div>' : panelError ? `<div class="sp-lines-dashed-error"><i class="fa-solid fa-circle-exclamation"></i> ${env.escapeHtml(panelError)}</div>` : ''; if (!items.length) return `${s}<div class="sp-empty sp-lines-dashed-empty"><i class="fa-solid fa-lightbulb"></i><p>还没有冷知识，可以点击右上角新增</p></div>`; return `${s}<div class="sp-lines-dashed-list">${items.map((item, i) => `<div class="sp-beat sp-lines-dashed-item${item.locked ? ' sp-lines-dashed-pinned' : ''}" data-id="${env.escapeAttr(item.id)}"><div class="sp-beat-head"><span class="sp-seq-badge">#${i + 1}</span><span class="sp-beat-actions"><button type="button" class="sp-lines-dashed-lock" data-id="${env.escapeAttr(item.id)}" title="${item.locked ? '取消锁定这条冷知识' : '锁定这条冷知识'}" aria-label="${item.locked ? '取消锁定这条冷知识' : '锁定这条冷知识'}"><i class="fa-solid ${item.locked ? 'fa-lock' : 'fa-lock-open'}"></i></button><button type="button" class="sp-lines-dashed-delete" data-id="${env.escapeAttr(item.id)}" title="删除这条冷知识" aria-label="删除这条冷知识"><i class="fa-solid fa-xmark"></i></button></span></div><div class="sp-beat-scene">${env.escapeHtml(item.text)}</div></div>`).join('')}</div>`; }
    function toolbarHtml({ onEvents, lineBusy, generationBusy }) {
        const dashedBusy = busy ? ' sp-refresh-busy' : '';
        return `<div class="sp-lines-toolbar-inner"><div class="sp-lines-sheet-toggle"><button type="button" class="sp-lines-sheet-btn${onEvents ? ' sp-lines-sheet-active' : ''}" data-sheet="events">平行事件</button><button type="button" class="sp-lines-sheet-btn${onEvents ? '' : ' sp-lines-sheet-active'}" data-sheet="dashed">冷知识</button></div><div class="sp-lines-tools">${onEvents ? `<button class="sp-panel-refresh sp-refresh-lines${lineBusy}" title="重新生成线" aria-label="重新生成线"${generationBusy ? ' disabled' : ''}><i class="fa-solid fa-rotate-right"></i></button><button class="sp-panel-refresh sp-advance-lines${lineBusy}" title="推进事件线（在已有线基础上继续推演）" aria-label="推进事件线"${generationBusy ? ' disabled' : ''}><i class="fa-solid fa-forward"></i></button>` : `<button class="sp-panel-refresh sp-lines-dashed-add${dashedBusy}" title="新增冷知识" aria-label="新增冷知识"${busy ? ' disabled' : ''}><i class="fa-solid fa-plus"></i></button>`}</div></div>`;
    }
    return { run, openDialog, remove, toggle, cleanup, abort: (reason = 'manual-abort') => { controller?.abort(reason); controller = null; busy = false; }, read, parse, commit, inlineHtml, panelHtml, toolbarHtml, state, isBusy: () => busy, controller: () => controller, resetError: () => { panelError = ''; }, targetCount: dashedTargetCount, normalizeKeepCount: normalizeDashedKeepCount, pickTopics: pickRandomDashedTopics };
}
