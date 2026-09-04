import { ledgerSourceFingerprint, legacyLedgerSourceFingerprint } from './reconcile.js';
import { ledgerOwnerIdentity, sameLedgerOwner } from './owner.js';
import { createGenerationDiagnosticScope, diagnosticMessage, makeDiagnosticError, runGenerationUiEffect } from '../../api/diagnostics.js';
// 刻度捕获纯依赖：只负责正文楼层/来源窗口与稳定性，不执行 API 或落库。
export const LEDGER_EVENT_TYPES = `【什么算刻度事件】会随时间推移改变状态、或到某天该发生的事，典型三类：
- 持续状态：身体伤情 / 病症、怀孕、会持续影响后续行为、关系或状态的情绪／心理影响等——会随天数自然演变（如割伤→结痂→愈合）。单场景的一过性心情不记。
- 约定待办：明确尚未履行、预期后续仍会回收的承诺或待办（哪天见面、答应帮忙），不要求已经定下具体日期。随口客套、临时意向不记。
- 周期：规律反复发生的事（月经、发薪、值班），带大致周期天数。
【主语永远是「人」】每条都登记在某个人物身上——记 TA 的状态，或 TA 牵扯的约定/周期。不要给物品单独立条（如「桌上有把枪」「仓库存着粮」不记）；但物品作用到人身上的状态要记（如「A 中了毒、尚未解」「B 戴着诅咒项链、受其束缚」）。`;
export const LEDGER_FIELD_SPEC = `- 每个事件一行，用全角竖线「｜」分隔 8 个字段，顺序固定：
 事由｜类型｜牵扯｜标签｜现状｜到期｜周期｜来源锚
  · 类型：持续状态 / 约定待办 / 周期（只能三选一，原样写这三个词之一）
  · 牵扯：涉及的人物，多个用顿号「、」分隔；没有就留空
  · 标签：检索关键词，多个用「、」分隔（如：伤、左手、身体）
  · 现状：此刻状态的完整句（如「新伤口，仍在流血。」），必须以合适的终止标点结束；若句末有闭合引号，标点写在引号内
  · 到期：只有这件事有一个「你会特意关心的具体未来日子」才填——约定的赴约日、或周期里你想知道「下次哪天」的（月经、发薪、值班）。纯背景例行、天天都在做、不用盯某天的（每日洗漱更衣、每天喂马、日常晨练）到期留空。填时写大致哪天（如「第3月20日」，本世界观自定义历法请按其月名/月序），说不清也留空
  · 周期：仅周期类填天数（如 30）；其它类型留空
  · 来源锚：只能填正文前的可信 FxxS/FxxE 令牌；角色卡/世界书既定机制填 SET；没有把握时留空`;
let env = { context: () => ({}), parseClock: () => ({}), parseDate: () => null, stripTags: text => text, settings: () => ({}), systemTypes: {}, eventTypes: LEDGER_EVENT_TYPES, fieldSpec: LEDGER_FIELD_SPEC };
export function bindLedgerCapture(next = {}) {
    env = { ...env, ...next };
    NON_NARRATIVE.clear();
    const types = env.systemTypes || {};
    // 保持原实现的排除集合：NARRATOR 仍属于可分析的 AI 正文，不能把所有系统消息类型一锅端。
    for (const key of ['HELP', 'WELCOME', 'EMPTY', 'GENERIC', 'COMMENT', 'SLASH_COMMANDS', 'FORMATTING', 'HOTKEYS', 'MACROS', 'WELCOME_PROMPT', 'ASSISTANT_NOTE']) {
        if (types[key]) NON_NARRATIVE.add(String(types[key]).toLowerCase());
    }
}
export const CAPTURE_FLOORS = 6;
export const CAPTURE_CONTEXT_FLOORS = 3;
const NON_NARRATIVE = new Set();
export function ledgerNarrativeMessage(msg) {
    if (!msg || msg.is_user || !String(msg.mes || '').trim()) return false;
    const type = String(msg.extra?.type || '').trim().toLowerCase();
    if (type && NON_NARRATIVE.has(type)) return false;
    if (msg.extra?.uses_system_ui === true && type !== String(env.systemTypes?.NARRATOR || '').toLowerCase()) return false;
    return true;
}
export function ledgerLatestAiFloorId() {
    const chat = env.context().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) if (ledgerNarrativeMessage(chat[i])) return i;
    return -1;
}
function sideClock(clock, side) {
    const meta = side === 'S' ? clock?.startMeta : clock?.endMeta;
    const stamp = side === 'S' ? clock?.start : clock?.end;
    return { stamp, date: meta?.date || (stamp ? env.parseDate(stamp) : null) };
}
export function ledgerFloorDateContext(floor = null) {
    const chat = env.context().chat || [];
    const floorId = Number.isInteger(floor) ? floor : ledgerLatestAiFloorId();
    const message = floorId >= 0 ? chat[floorId] : null;
    if (!message || !ledgerNarrativeMessage(message)) return { floor: null, date: null };
    const clock = env.parseClock(message.mes || '');
    const date = sideClock(clock, 'E').date || sideClock(clock, 'S').date;
    return { floor: floorId, date: date || null };
}
export function ledgerAiFloorRecords(limit = null) {
    const chat = env.context().chat || [], floors = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i]; if (!ledgerNarrativeMessage(msg)) continue;
        const clock = env.parseClock(msg.mes); const parts = [];
        const start = sideClock(clock, 'S'), end = sideClock(clock, 'E');
        if (start.date) parts.push({ side: 'S', stamp: start.stamp, date: start.date });
        if (end.date) parts.push({ side: 'E', stamp: end.stamp, date: end.date });
    floors.push({ floor: i, signature: String(msg.mes), identity: { is_user: !!msg.is_user, is_system: !!msg.is_system, name: String(msg.name || ''), type: String(msg.extra?.type || '') }, content: env.stripTags(String(msg.mes), env.settings()).trim(), sources: parts.map(part => ({ token: `F${i}${part.side}`, floor: i, date: part.date, stamp: part.stamp, signature: String(msg.mes), fingerprint: ledgerSourceFingerprint(`F${i}${part.side}`, String(msg.mes), { floor: i, date: part.date }), legacyFingerprint: legacyLedgerSourceFingerprint(`F${i}${part.side}`, String(msg.mes)) })) });
    }
    const selected = limit == null ? floors : floors.slice(-Math.max(0, limit));
    return selected.map(item => ({ ...item, sources: item.sources.map(source => ({ ...source, content: item.content })) }));
}
export const ledgerSourceFloors = (limit = null) => ledgerAiFloorRecords(limit).flatMap(item => item.sources);
export function ledgerSourceMap(sources) { return new Map((sources || []).map(source => [String(source.token), source])); }
export function ledgerSourceAnchor(token, sourceMap) {
    const key = String(token || '').trim(); if (key === 'SET') return { 楼层: null, 历日期: null }; const source = sourceMap?.get(key); if (!source) return null;
    const raw = env.context().chat?.[source.floor]?.mes || ''; const clock = env.parseClock(raw); const date = sideClock(clock, source.token.endsWith('S') ? 'S' : 'E').date; return date ? { 楼层: source.floor, 历日期: date } : null;
}
export function ledgerSourcesStable(sources, chatId) { if (env.context().chatId !== chatId) return false; const chat = env.context().chat || []; return (sources || []).every(source => { const msg = chat[source.floor]; return ledgerNarrativeMessage(msg) && String(msg.mes || '') === source.signature; }); }
export function ledgerRecordsStable(records, chatId) {
    if (env.context().chatId !== chatId) return false; const chat = env.context().chat || [];
    return (records || []).every(record => { const msg = chat[record.floor]; if (!ledgerNarrativeMessage(msg) || String(msg.mes || '') !== record.signature) return false; const identity = record.identity || {}; if (!!msg.is_user !== !!identity.is_user || !!msg.is_system !== !!identity.is_system) return false; if (String(msg.name || '') !== String(identity.name || '') || String(msg.extra?.type || '') !== String(identity.type || '')) return false; return (record.sources || []).every(source => { const side = String(source.token || '').endsWith('S') ? 'S' : String(source.token || '').endsWith('E') ? 'E' : ''; if (!side || source.signature !== record.signature) return false; const date = sideClock(env.parseClock(String(msg.mes || '')), side).date; return !!date && date.month === source.date.month && date.day === source.date.day && (date.year == null || source.date.year == null || date.year === source.date.year) && (date.eraLabel == null || source.date.eraLabel == null || date.eraLabel === source.date.eraLabel); }); });
}
export function ledgerRecordCollectionStable(records, chatId, limit = null) {
    if (!ledgerRecordsStable(records, chatId)) return false;
    const expected = Array.isArray(records) ? records : [], current = ledgerAiFloorRecords(limit);
    if (current.length !== expected.length) return false;
    const dateKey = date => JSON.stringify([date?.year ?? null, date?.eraLabel ?? null, date?.month ?? null, date?.day ?? null]);
    return expected.every((record, index) => {
        const live = current[index];
        if (!live || live.floor !== record.floor || live.signature !== record.signature || live.content !== record.content) return false;
        const identity = record.identity || {}, liveIdentity = live.identity || {};
        if (!!liveIdentity.is_user !== !!identity.is_user || !!liveIdentity.is_system !== !!identity.is_system || String(liveIdentity.name || '') !== String(identity.name || '') || String(liveIdentity.type || '') !== String(identity.type || '')) return false;
        const sources = Array.isArray(record.sources) ? record.sources : [], liveSources = Array.isArray(live.sources) ? live.sources : [];
        return liveSources.length === sources.length && sources.every((source, sourceIndex) => {
            const liveSource = liveSources[sourceIndex];
            return !!liveSource && liveSource.token === source.token && liveSource.floor === source.floor && liveSource.stamp === source.stamp && dateKey(liveSource.date) === dateKey(source.date);
        });
    });
}
export function ledgerLegacyAnchor(sourceList) { const dates = new Map(); for (const source of sourceList || []) dates.set(`${source.date.month}/${source.date.day}`, source.date); return dates.size === 1 ? { 楼层: null, 历日期: [...dates.values()][0] } : { 楼层: null, 历日期: null }; }
export function ledgerSourceBatches(sources, size = CAPTURE_FLOORS) { const list = Array.isArray(sources) ? sources : []; const batches = []; for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size)); return batches; }
// 纯捕获计划器：只给活跃、未锁的真实 ID 生成受限 patch；重复候选折叠。
export function planLedgerCapture({ entries = [], candidates = [], sourceMap = new Map(), captureFloor = null, captureDate = null, norm = value => String(value || '').replace(/\s+/g, '') } = {}) {
    const validSource = e => !['来源已删除', '待确认'].includes(String(e?.来源状态 || ''));
    const active = (entries || []).filter(e => e?.状态 !== '已了结' && e?.锁 !== '用户锁' && validSource(e));
    const byId = new Map(active.filter(e => /^L\d+$/i.test(String(e.id || ''))).map(e => [String(e.id), e]));
    const additions = [], patches = [], seen = new Set(), patched = new Set();
    const trusted = token => { const t = String(token || '').trim(); const source = sourceMap?.get?.(t); return !!source && /^F\d+[SE]$/i.test(t) && source.date && source.signature; };
    const eventWords = value => String(value || '').split(/[\s、，,;；/]+/).map(x => x.trim()).filter(x => x.length >= 2 && !['身体', '状态', '事情', '当前', '情况'].includes(x));
    const similar = (old, item) => {
        const a = old?.起始锚?.历日期, b = item?.起始锚?.历日期;
        const sameDate = !!a && !!b && a.month === b.month && a.day === b.day;
        const source = item?._sourceToken ? sourceMap?.get?.(item._sourceToken) : null;
        const sameSource = !!source && Number(old?.起始锚?.楼层) === Number(source.floor);
        const sameType = old?.类型 === item?.类型;
        const people = union(old?.牵扯, item?.牵扯); const personOverlap = people.length < (old?.牵扯?.length || 0) + (item?.牵扯?.length || 0);
        const words = eventWords(`${old?.事由} ${(old?.标签 || []).join(' ')}`); const incoming = eventWords(`${item?.事由} ${(item?.标签 || []).join(' ')}`);
        return sameSource && sameDate && sameType && personOverlap && words.some(x => incoming.includes(x));
    };
    const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter(Boolean))];
    const patchFor = (old, item) => {
        const patch = { 现状锚: { 楼层: captureFloor, 历日期: captureDate }, 牵扯: union(old?.牵扯, item?.牵扯), 标签: union(old?.标签, item?.标签) };
        if (Object.prototype.hasOwnProperty.call(item, '现状') && String(item.现状 || '').trim()) patch.现状 = String(item.现状).trim();
        if (Object.prototype.hasOwnProperty.call(item, '到期锚') && item.到期锚) patch.到期锚 = item.到期锚;
        if (Object.prototype.hasOwnProperty.call(item, '周期长度') && Number.isFinite(+item.周期长度) && +item.周期长度 > 0) patch.周期长度 = +item.周期长度;
        return patch;
    };
    for (const item of (Array.isArray(candidates) ? candidates : [])) {
        const candidateId = String(item?._targetId || item?._candidateId || '').trim();
        const target = /^L\d+$/i.test(candidateId) ? byId.get(candidateId) : null;
        if (target && trusted(item._sourceToken) && !patched.has(target.id)) { patches.push({ id: target.id, patch: patchFor(target, item) }); patched.add(target.id); continue; }
        const gist = norm(item?.事由); if (!gist || seen.has(gist)) continue;
        const exact = trusted(item._sourceToken) ? active.find(e => norm(e.事由) === gist && !patched.has(e.id)) : null;
        if (exact) { patches.push({ id: exact.id, patch: patchFor(exact, item) }); patched.add(exact.id); seen.add(gist); continue; }
        const fuzzy = trusted(item._sourceToken) ? active.find(e => !patched.has(e.id) && similar(e, item)) : null;
        if (fuzzy) { patches.push({ id: fuzzy.id, patch: patchFor(fuzzy, item) }); patched.add(fuzzy.id); seen.add(gist); continue; }
        if ((entries || []).some(e => norm(e?.事由) === gist)) { seen.add(gist); continue; }
        // active 已在上面优先 patch；这里仅防止已了结/锁定/异常来源池换措辞重建。
        if (trusted(item._sourceToken) && (entries || []).some(e => !active.includes(e) && similar(e, item))) { seen.add(gist); continue; }
        additions.push({ ...item, 现状锚: { 楼层: captureFloor, 历日期: captureDate } }); seen.add(gist);
    }
    return { additions, patches };
}
export function resolveLedgerStartAnchor(item, sourceMap, legacySources) {
    const token = String(item?._sourceToken || '').trim(); if (token === 'SET') return { 楼层: null, 历日期: null };
    const trusted = ledgerSourceAnchor(token, sourceMap); if (!trusted) return token ? { 楼层: null, 历日期: null } : ledgerLegacyAnchor(legacySources);
    const anchor = { ...trusted, 来源指纹: sourceMap.get(token)?.fingerprint || ledgerSourceFingerprint(token, sourceMap.get(token)?.signature || '') }; return anchor;
}

function capturePromptParts() {
    const eventTypes = env.eventTypes || '';
    const fieldSpec = env.fieldSpec || '';
    return { eventTypes, fieldSpec };
}
export function buildCapturePrompt(first = false) {
    const { eventTypes, fieldSpec } = capturePromptParts();
    if (first) return `请暂停角色扮演，作为剧情分析助手，只做一件事：这是本故事**第一次**建立「刻度」，请把所有【需要长期按时间追踪】的事项一次性记入刻度，覆盖两个来源：

【来源一·既定机制（最重要，务必别漏）】从【角色卡背景资料 / 场景 / 世界书设定】里，找出开局就存在、需要长期盯着时间的**规则型设定**，尤其：
- 周期性硬规则：如「每 N 天必须做某事，否则触发严重后果」「每逢某日会发生某事」——务必抓出周期天数。
- 死线 / 倒计时：如「X 天内必须完成某事，否则……」。
- 长期状态 / 契约 / 诅咒 / 期限：会随时间推进演变或到期的既定设定。
这类往往是这张卡的核心机制、甚至关乎生死，最该盯——哪怕最近对话还没提到，也要从设定里登记下来。

【来源二·已发生事件】再从最近对话正文里，捞取已经出现、需要追踪的事件（同下三类）。

${eventTypes}

【规则】
- 只记稳定事由与最新现状：准备、过程、事后反应属于同一次因果事件，不要拆成多条；拿不准是否为独立事件时宁可合并，只有明确的新事件、独立长期后果、独立到期事项或下一次新事件才另建。既定机制仍需登记，但不要把普通背景日常扩成刻度。
${fieldSpec}
- 若确实没有任何可登记的，只回一个字：无
不要解释，不要输出表头，不要输出多余文字。`;
    const closed = env.listEntries?.({ includeClosed: true })?.filter(e => e.状态 === '已了结') || [];
    const active = env.listEntries?.() || [];
    const activeText = active.length ? active.map(e => `- ${e.id}｜${e.事由}${e.标签?.length ? `（${e.标签.join('、')}）` : ''}`).join('\n') : '（暂无，本次都是新登记）';
    const closedText = closed.length ? `\n【已了结·别重新登记】\n下面这些已经完结、或被用户手动归档了。默认**一律别再登记**；只有正文里出现了**明确的新进展**（旧事重新启动、或又发生了一次全新的独立事件）才重新记，并在现状里点明「新」在哪：\n${closed.map(e => `- ${e.事由}${e.标签?.length ? `（${e.标签.join('、')}）` : ''}`).join('\n')}\n` : '';
    return `请暂停角色扮演，作为剧情分析助手，只做一件事：从以上最近的对话正文里，捞取「需要按时间追踪」的新事件，记入「刻度」。

${eventTypes}

【已在刻度上的（不要重复登记）】
${activeText}${closedText}
【规则】
- 只登记上面对话里【新出现】的，或【虽同名但明显是另一次独立事件】的；已在刻度上的同一件事跳过。
- 已在刻度上的条目如需更新，必须原样使用真实目标 ID（L1、L2…），并只回写现状、现状锚、人物/标签并集、明确到期/周期；新条目不得伪造 L ID。
  · 新增条：8 字段「事由｜类型｜牵扯｜标签｜现状｜到期｜周期｜来源锚」，不要加 ID。
  · 更新条：9 字段「L目标ID｜事由｜类型｜牵扯｜标签｜现状｜到期｜周期｜来源锚」，目标 ID 必须来自清单。
- **同一件事只记一条**：判断「是不是同一件事」看的是**事情本身**，不是措辞——同一个人的同一桩事，哪怕换了说法、换了角度、详略不同，也算重复。这有两层：① 别登记与上面清单里已有的重复；② 你这一次别把一件事拆成两三条近义的分别登记。
- 只记稳定事由与最新现状：准备、过程、事后反应属于同一次因果事件，不要拆成多条；拿不准是否为独立事件时合并到旧条，只有明确的新事件或独立到期事项才另建。不得把已了结/已归档的条目自动捞回。
${fieldSpec}
- 若没有任何新事件可登记，只回一个字：无
不要解释，不要输出表头，不要输出多余文字。`;
}
export function buildProvenancePrompt(candidates, batchNo, batchTotal) {
    const list = (candidates || []).map(item => `- ${item._candidateId}｜${item.事由}（${item.类型}）${item.标签?.length ? `｜标签：${item.标签.join('、')}` : ''}`).join('\n');
    return `请暂停角色扮演，进行「刻度事件来源溯源」。这是第 ${batchNo}/${batchTotal} 批原始剧情楼；每个 AI 楼正文前的 FxxS/FxxE 是系统可信来源令牌，只能从本批正文中选择，不能自行编造楼号、日期或令牌。\n\n【待溯源事项】\n${list || '（无）'}\n\n请只输出本批正文中能明确找到最早发生/确认依据的事项；同一事项若已有更早批次来源，不要重复输出。每条使用 9 字段格式：候选ID｜事由｜类型｜牵扯｜标签｜现状｜到期｜周期｜来源锚；其中「现状」必须是以合适终止标点结束的完整句，句末有闭合引号时标点写在引号内。候选ID 必须原样抄写（只能是清单给出的 C1、C2…）；来源锚只能填本批实际存在且支撑该事项的 FxxS/FxxE；若本批没有依据，只回一个字：无。不要输出 SET，不要解释。`;
}
export function selectLedgerProvenanceToken(value, batchMap) {
    const tokens = [...String(value || '').matchAll(/F\d+[SE]/gi)].map(match => match[0].toUpperCase());
    const valid = [...new Set(tokens)].map(token => ({ token, source: batchMap?.get?.(token) }))
        .filter(item => item.source && ledgerSourceAnchor(item.token, batchMap));
    valid.sort((a, b) => Number(a.source.floor) - Number(b.source.floor) || Number(!a.token.endsWith('S')) - Number(!b.token.endsWith('S')));
    return valid[0]?.token || '';
}
export function createLedgerCaptureController(options = {}) {
    env = { ...env, ...options };
    let busy = false;
    let progress = null;
    let abortController = null;
    let provenanceCheckpoint = null;
    const isCurrent = (ctrl, chatId, travel) => abortController === ctrl && !ctrl.signal.aborted && !travel?.signal?.aborted && env.context().chatId === chatId;
    const ledgerBaselineEmpty = () => (env.listEntries?.({ includeClosed: true }) || []).length === 0;
    const sameTarget = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const progressCheckpointStable = checkpoint => {
        if (!checkpoint || !ledgerBaselineEmpty()) return false;
        const ctx = env.context();
        if (String(env.charKey?.(ctx) || '') !== checkpoint.charKey) return false;
        return sameLedgerOwner(checkpoint.ownerSnapshot, ledgerOwnerIdentity(ctx)) && ledgerRecordCollectionStable(checkpoint.allRecords, checkpoint.chatId);
    };
    const completedCheckpointStable = (checkpoint, { requireBaseline = true } = {}) => {
        if (!checkpoint || checkpoint.phase !== 'pending-commit' || (requireBaseline && !ledgerBaselineEmpty())) return false;
        const ctx = env.context();
        if (ctx.chatId !== checkpoint.chatId || String(env.charKey?.(ctx) || '') !== checkpoint.charKey) return false;
        if (String(ctx.name1 || '用户') !== checkpoint.userName || String(ctx.name2 || '角色') !== checkpoint.charName) return false;
        if (!sameTarget(env.target?.(), checkpoint.fixedTarget) || !ledgerRecordsStable(checkpoint.sourceRecords, checkpoint.chatId)) return false;
        const selectedMap = ledgerSourceMap((checkpoint.sourceRecords || []).flatMap(record => record.sources || []));
        return (checkpoint.picked || []).every(item => {
            const token = String(item?._sourceToken || '').trim().toUpperCase();
            if (item?._provenanceInvalid && !token) return false;
            return !token || token === 'SET' || (!!selectedMap.get(token) && !!ledgerSourceAnchor(token, selectedMap));
        });
    };
    const checkpointStable = checkpoint => checkpoint?.phase === 'pending-commit' ? completedCheckpointStable(checkpoint) : progressCheckpointStable(checkpoint);
    const selectedSourceRecords = (picked, records) => {
        const tokens = new Set((picked || []).map(item => String(item?._sourceToken || '').trim().toUpperCase()).filter(token => /^F\d+[SE]$/.test(token)));
        return (records || []).map(record => ({ ...record, sources: (record.sources || []).filter(source => tokens.has(String(source.token || '').toUpperCase())) })).filter(record => record.sources.length);
    };
    const makeCheckpoint = (phase, values) => ({ phase, ...values });
    const inspectCheckpoint = () => {
        if (!provenanceCheckpoint) return { checkpoint: null, invalidCompleted: false };
        if (checkpointStable(provenanceCheckpoint)) return { checkpoint: provenanceCheckpoint, invalidCompleted: false };
        const invalidCompleted = provenanceCheckpoint.phase === 'pending-commit';
        provenanceCheckpoint = null;
        return { checkpoint: null, invalidCompleted };
    };
    const clear = ctrl => {
        if (abortController !== ctrl) return false;
        busy = false; progress = null; abortController = null;
        env.setProgress?.(0, 0, ctrl);
        return true;
    };
    const run = async (manual = false, travel = null) => {
        const diagnostic = createGenerationDiagnosticScope('ledger-capture', { background: !manual });
        let generationCommitted = false;
        const markCommitted = options => { diagnostic.committed(options); generationCommitted = true; };
        if (busy) return { status: 'busy', reason: 'busy' };
        const ctx = env.context();
        const charKey = env.charKey?.(ctx);
        if (!charKey) { if (manual) env.toast?.('当前没有角色卡，无法标注', null, true); return { status: 'skipped', reason: 'no-character', feedbackShown: manual }; }
        const inspected = inspectCheckpoint();
        const checkpoint = inspected.checkpoint;
        if (checkpoint?.diagnosticRequestId) diagnostic.sink({ requestId: checkpoint.diagnosticRequestId });
        if (inspected.invalidCompleted) {
            const result = { status: 'failed', reason: 'pending-commit-invalid', feedbackShown: false };
            if (!manual) { env.toast?.('已保留的刻度结果无法安全提交：聊天、角色、刻度池或来源正文已经变化；本次没有写入，也没有重跑 API。', null, true); result.feedbackShown = true; }
            return result;
        }
        if (checkpoint && !manual) {
            if (checkpoint.phase === 'pending-commit') {
                env.toast?.('刻度溯源已全部完成，结果已保留但尚未写入；请再次点「立即标注」安全提交，不会重跑 API。');
                return { status: 'pending-commit', reason: 'completed-pending-commit', totalBatches: checkpoint.provenanceBatches.length, feedbackShown: true };
            }
            env.toast?.(`刻度来源溯源进度已保留（下一批 ${checkpoint.nextBatchIndex + 1}/${checkpoint.provenanceBatches.length}），请点「立即标注」继续。`);
            return { status: 'needs-confirmation', reason: 'provenance-resume-manual', feedbackShown: true };
        }
        const cfg = env.config?.();
        if (!checkpoint && (!cfg?.url || !cfg?.key)) { if (manual) env.toast?.('请先在设置中填写 API', null, true); return { status: 'failed', reason: 'no-api', error: Object.assign(new Error('未配置 API'), { diagnosticCode: 'config-missing' }), feedbackShown: manual }; }
        const fixedTarget = checkpoint?.fixedTarget ?? env.target?.();
        const chatId = checkpoint?.chatId ?? ctx.chatId;
        const ownerSnapshot = checkpoint?.ownerSnapshot ?? ledgerOwnerIdentity(ctx);
        const ctrl = new AbortController(); abortController = ctrl; busy = true;
        const cancellation = (reason = 'cancelled') => {
            const ownerCurrent = sameLedgerOwner(ownerSnapshot, ledgerOwnerIdentity(env.context()));
            const stale = abortController !== ctrl || !ownerCurrent;
            if (checkpoint && (stale || ctrl.signal.aborted || travel?.signal?.aborted)) provenanceCheckpoint = null;
            return { status: 'cancelled', reason: stale ? 'source-stale-chat' : reason, ...(stale ? { stale: true } : {}) };
        };
        const removeBridge = env.bridge?.(travel?.signal, ctrl) || (() => {});
        try {
            const userName = checkpoint?.userName ?? (ctx.name1 || '用户'), charName = checkpoint?.charName ?? (ctx.name2 || '角色');
            const isFirst = checkpoint ? true : ledgerBaselineEmpty();
            const targetDate = checkpoint?.targetDate ?? env.validDate?.(travel?.targetDate, env.calendar?.());
            const floorContext = checkpoint?.floorContext ?? ledgerFloorDateContext();
            const captureFloor = floorContext.floor;
            const captureDate = checkpoint?.captureDate ?? (targetDate || floorContext.date || env.today?.());
            const recentRecords = checkpoint?.recentRecords ?? ledgerAiFloorRecords(CAPTURE_FLOORS);
            const recentSources = recentRecords.flatMap(record => record.sources);
            const recentSourceMap = ledgerSourceMap(recentSources);
            const allRecords = checkpoint?.allRecords ?? (isFirst ? ledgerAiFloorRecords() : null);
            const aiFloorCount = allRecords?.length || 0;
            const historical = isFirst && aiFloorCount > CAPTURE_FLOORS;
            const provenanceBatches = checkpoint?.provenanceBatches ?? (historical ? ledgerSourceBatches(allRecords) : []);
            if (historical && !checkpoint) {
                if (!manual) { clear(ctrl); env.toast?.(`历史较长（${aiFloorCount} 个 AI 楼），自动捕获不会静默启动多批溯源；请点「立即标注」并确认。`); return { status: 'needs-confirmation', reason: 'historical-confirmation', feedbackShown: true }; }
                const ok = await env.confirm?.({ title: '确认完整溯源刻度', body: `当前 ledger 为空，共 ${aiFloorCount} 个 AI 楼。将先提取清单，再按每批最多 ${CAPTURE_FLOORS} 个 AI 回复溯源，最多调用 ${1 + provenanceBatches.length} 次（1 次清单 + ${provenanceBatches.length} 批）。找到全部来源后会提前结束；过程会增加 API 消耗和等待时间，可随时中止；确认后统一落库。`, note: '取消不会发起请求，也不会写入任何刻度。', confirmText: '开始溯源', cancelText: '取消' });
                if (!ok) { clear(ctrl); return { status: 'cancelled', reason: 'confirmation-cancelled' }; }
                if (!isCurrent(ctrl, chatId, travel)) return cancellation(ctrl.signal.aborted || travel?.signal?.aborted ? 'aborted' : 'cancelled');
            }
            let picked = checkpoint?.picked || null;
            if (!picked) {
                const prompt = env.appendTravel?.(buildCapturePrompt(isFirst), travel) || buildCapturePrompt(isFirst);
                const captureOpts = { ...(travel || {}), noAlmanac: true, promptMode: 'mechanical', diagnosticModule: 'ledger-capture', diagnosticSink: diagnostic.sink };
                // 最终常规请求只喂最近 3 个可见 AI 楼；内部 6 楼记录仍完整保留给来源锚、稳定性与溯源批处理。
                const recentVisibleRecords = ledgerAiFloorRecords().filter(record => {
                    const message = ctx.chat?.[record.floor];
                    return !message?.is_user && !message?.is_system && ledgerNarrativeMessage(message);
                });
                if (recentVisibleRecords.length) captureOpts.ledgerSourceFloors = recentVisibleRecords.slice(-CAPTURE_CONTEXT_FLOORS);
                let raw;
                try { raw = await env.callApi(ctx, prompt, cfg, userName, charName, ctrl.signal, CAPTURE_CONTEXT_FLOORS, captureOpts); }
                catch (error) { markLedgerError(error, { phase: 'capture-request' }); throw error; }
                if (!isCurrent(ctrl, chatId, travel)) return cancellation(ctrl.signal.aborted || travel?.signal?.aborted ? 'aborted' : 'cancelled');
                picked = env.parseCapture?.(raw) || [];
                if (!picked.length) {
                    if (/^无[。.！!]?$/u.test(String(raw || '').trim())) { diagnostic.accepted({ phase: 'validation', reasonCode: 'capture-explicit-none' }); markCommitted({ reasonCode: 'capture-no-change' }); if (manual) await runGenerationUiEffect(() => env.toast?.('未发现可登记的新事件'), { diagnostic, reasonCode: 'capture-toast-failed' }); return { status: 'unchanged', reason: 'no-new-event', feedbackShown: manual }; }
                    throw diagnostic.rejected(makeDiagnosticError('parse', { phase: 'parse' }), { phase: 'parse', reasonCode: 'capture-format-unrecognized' });
                }
                picked.forEach((item, index) => { item._candidateId = `C${index + 1}`; });
            }
            let sourceList = recentSources, sourceMap = recentSourceMap, recordsForCommit = recentRecords;
            if (historical) {
                sourceList = allRecords.flatMap(record => record.sources); sourceMap = ledgerSourceMap(sourceList); recordsForCommit = allRecords;
                const candidates = picked.filter(item => String(item._sourceToken || '').trim() !== 'SET');
                if (!checkpoint) candidates.forEach(item => { item._sourceToken = ''; delete item._provenanceInvalid; });
                const sourceTravel = checkpoint?.sourceTravel || (() => { const value = { ...(travel || {}) }; delete value.signal; return value; })();
                const startBatchIndex = checkpoint?.nextBatchIndex || 0;
                progress = { done: startBatchIndex, total: provenanceBatches.length }; env.setProgress?.(startBatchIndex, provenanceBatches.length, ctrl);
                for (let i = startBatchIndex; i < provenanceBatches.length; i++) {
                    if (!isCurrent(ctrl, chatId, travel)) return cancellation(ctrl.signal.aborted || travel?.signal?.aborted ? 'aborted' : 'cancelled');
                    if (!ledgerBaselineEmpty()) { provenanceCheckpoint = null; return { status: 'cancelled', reason: 'ledger-baseline-changed', stale: true }; }
                    const unresolved = candidates.filter(item => !String(item._sourceToken || '').trim());
                    if (!unresolved.length) break;
                    const batch = provenanceBatches[i];
                    const provenanceDiagnostic = createGenerationDiagnosticScope('ledger-provenance', { background: !manual });
                    const retainProvenanceProgress = () => {
                        const checkpointCurrent = abortController === ctrl && !ctrl.signal.aborted && !travel?.signal?.aborted && env.context().chatId === chatId && ledgerBaselineEmpty() && ledgerRecordCollectionStable(allRecords, chatId) && sameLedgerOwner(ownerSnapshot, ledgerOwnerIdentity(env.context()));
                        if (checkpointCurrent) provenanceCheckpoint = makeCheckpoint('provenance', { chatId, charKey: String(charKey), ownerSnapshot, fixedTarget, userName, charName, targetDate, floorContext, captureDate, recentRecords, allRecords, provenanceBatches, picked, sourceTravel, nextBatchIndex: i, diagnosticRequestId: diagnostic.metadata().requestId });
                        else provenanceCheckpoint = null;
                    };
                    let result;
                    try {
                        const provenanceCfg = env.provenanceConfig?.() || cfg;
                        if (!provenanceCfg?.url || !provenanceCfg?.key) throw Object.assign(new Error('未配置 API'), { diagnosticCode: 'config-missing' });
                        result = await env.callApi(ctx, buildProvenancePrompt(unresolved, i + 1, provenanceBatches.length), provenanceCfg, userName, charName, ctrl.signal, 0, { ...sourceTravel, noAlmanac: true, ledgerSourceFloors: batch, temperature: 0.3, promptMode: 'mechanical', diagnosticModule: 'ledger-provenance', diagnosticSink: provenanceDiagnostic.sink });
                    }
                    catch (error) {
                        markLedgerError(error, { phase: 'source-provenance', batchNo: i + 1, batchTotal: provenanceBatches.length });
                        retainProvenanceProgress();
                        throw error;
                    }
                    if (!isCurrent(ctrl, chatId, travel)) return cancellation(ctrl.signal.aborted || travel?.signal?.aborted ? 'aborted' : 'cancelled');
                    if (/^无[。.！!]?$/u.test(String(result || '').trim())) {
                        provenanceDiagnostic.accepted({ phase: 'validation', reasonCode: 'provenance-explicit-none' });
                        provenanceDiagnostic.committed({ reasonCode: 'provenance-no-change' });
                        if (checkpoint) provenanceCheckpoint = { ...checkpoint, picked, nextBatchIndex: i + 1 };
                        progress = { done: i + 1, total: provenanceBatches.length }; env.setProgress?.(i + 1, provenanceBatches.length, ctrl);
                        continue;
                    }
                    const found = env.parseCapture?.(result) || [];
                    if (!found.length) {
                        const error = provenanceDiagnostic.rejected(makeDiagnosticError('parse', { phase: 'parse' }), { phase: 'parse', reasonCode: 'provenance-format-unrecognized' });
                        markLedgerError(error, { phase: 'source-provenance', batchNo: i + 1, batchTotal: provenanceBatches.length }); retainProvenanceProgress(); throw error;
                    }
                    const batchMap = ledgerSourceMap(batch.flatMap(record => record.sources)), hits = [];
                    for (const item of found) {
                        const candidate = candidates.find(x => x._candidateId === item._candidateId && !String(x._sourceToken || '').trim());
                        const token = selectLedgerProvenanceToken(item._sourceToken, batchMap);
                        if (candidate && ledgerSourceAnchor(token, batchMap)) hits.push({ candidate, token, source: batchMap.get(token) });
                        // 坏来源行只丢本行；合法候选仍可继续落地。来源 token 仍须通过 batchMap 验证。
                    }
                    if (!hits.length) {
                        const error = provenanceDiagnostic.rejected(makeDiagnosticError('invalid-fields', { phase: 'validation' }), { phase: 'validation', reasonCode: 'provenance-fields-invalid' });
                        markLedgerError(error, { phase: 'source-provenance', batchNo: i + 1, batchTotal: provenanceBatches.length }); retainProvenanceProgress(); throw error;
                    }
                    hits.sort((a, b) => a.source.floor - b.source.floor || Number(!a.token.endsWith('S')) - Number(!b.token.endsWith('S')));
                    hits.forEach(hit => { if (!String(hit.candidate._sourceToken || '').trim()) hit.candidate._sourceToken = hit.token; });
                    provenanceDiagnostic.accepted({ phase: 'validation', reasonCode: 'provenance-valid' });
                    provenanceDiagnostic.committed({ reasonCode: 'provenance-applied' });
                    if (checkpoint) provenanceCheckpoint = { ...checkpoint, picked, nextBatchIndex: i + 1 };
                    progress = { done: i + 1, total: provenanceBatches.length }; env.setProgress?.(i + 1, provenanceBatches.length, ctrl);
                }
                if (!ledgerBaselineEmpty()) { provenanceCheckpoint = null; return { status: 'cancelled', reason: 'ledger-baseline-changed', stale: true }; }
                const unresolvedCandidates = candidates.filter(item => !String(item._sourceToken || '').trim());
                if (unresolvedCandidates.length) {
                    const unresolved = new Set(unresolvedCandidates);
                    picked = picked.filter(item => !unresolved.has(item));
                }
                if (!picked.some(item => String(item._sourceToken || '').trim() === 'SET' || /^F\d+[SE]$/.test(String(item._sourceToken || '').trim().toUpperCase()))) {
                    provenanceCheckpoint = null;
                    return { status: 'failed', reason: 'completed-source-invalid', totalBatches: provenanceBatches.length, feedbackShown: false };
                }
                provenanceCheckpoint = makeCheckpoint('pending-commit', { chatId, charKey: String(charKey), ownerSnapshot, fixedTarget, userName, charName, targetDate, floorContext, captureDate, recentRecords, allRecords, provenanceBatches, picked, sourceTravel, nextBatchIndex: provenanceBatches.length, sourceRecords: selectedSourceRecords(picked, allRecords), diagnosticRequestId: diagnostic.metadata().requestId });
            }
            const entries = env.listEntries?.({ includeClosed: true }) || [];
            const candidates = picked.map(item => ({ ...item, 起始锚: resolveLedgerStartAnchor(item, sourceMap, sourceList) }));
            const capturePlan = planLedgerCapture({ entries, candidates, sourceMap, captureFloor, captureDate, norm: env.normGist || (value => String(value || '').replace(/\s+/g, '')) });
            if (!capturePlan.additions.length && !capturePlan.patches.length) { diagnostic.accepted({ phase: 'validation', reasonCode: 'capture-duplicate' }); markCommitted({ reasonCode: 'capture-no-change' }); provenanceCheckpoint = null; if (manual) await runGenerationUiEffect(() => env.toast?.('没有新事件（都已在刻度上）'), { diagnostic, reasonCode: 'capture-toast-failed' }); return { status: 'unchanged', reason: 'duplicate', feedbackShown: manual }; }
            if (!isCurrent(ctrl, chatId, travel)) return cancellation(ctrl.signal.aborted || travel?.signal?.aborted ? 'aborted' : 'cancelled');
            const completedRetry = checkpoint?.phase === 'pending-commit';
            const commitRecordLimit = historical ? null : CAPTURE_FLOORS;
            const commitSnapshotStable = completedRetry ? completedCheckpointStable(checkpoint) : ledgerRecordCollectionStable(recordsForCommit, chatId, commitRecordLimit);
            if (!commitSnapshotStable) {
                if (historical && !completedRetry && completedCheckpointStable(provenanceCheckpoint)) return { status: 'pending-commit', reason: 'completed-stale-pending-commit', totalBatches: provenanceBatches.length, feedbackShown: false };
                const completedSourceInvalid = historical && !completedRetry && provenanceCheckpoint?.phase === 'pending-commit' && !ledgerRecordsStable(provenanceCheckpoint.sourceRecords, chatId);
                if (completedSourceInvalid) {
                    provenanceCheckpoint = null;
                    return { status: 'failed', reason: 'completed-source-invalid', totalBatches: provenanceBatches.length, feedbackShown: false };
                }
                provenanceCheckpoint = null;
                return { status: 'cancelled', reason: 'source-stale-chat', stale: true };
            }
            const cleanAdditions = capturePlan.additions.map(plan => { const clean = { ...plan }; delete clean._sourceToken; delete clean._candidateId; delete clean._provenanceInvalid; return clean; });
            // baseline 在进入事务前单独验证；事务内存 staging 后 ledger 已非空，owner guard 不能把本次新增误判成外部改动。
            // 并发 metadata 变更仍由固定目标 saver 的 integrity + owned-path test 拒绝。
            const owner = { chatId, target: fixedTarget, guard: () => isCurrent(ctrl, chatId, travel) && (completedRetry ? completedCheckpointStable(checkpoint, { requireBaseline: false }) : (ledgerRecordCollectionStable(recordsForCommit, chatId, commitRecordLimit) && sameLedgerOwner(ownerSnapshot, ledgerOwnerIdentity(env.context())))) };
            diagnostic.accepted({ phase: 'validation', reasonCode: 'capture-valid' });
            let result;
            try { result = env.applyAtomic ? await env.applyAtomic({ additions: cleanAdditions, patches: capturePlan.patches }, owner) : { added: await env.addAtomic?.(cleanAdditions) || [], patched: [] }; }
            catch (error) {
                const savePhase = error?.phase || 'capture-save-failed';
                const status = Number(error?.saveResult?.status);
                const saveError = makeDiagnosticError('save', { phase: savePhase, ...(Number.isInteger(status) ? { status } : {}) });
                if (error?.saveResult) saveError.saveResult = error.saveResult;
                markLedgerError(saveError, { phase: savePhase });
                throw diagnostic.rejected(saveError, { phase: 'save', reasonCode: savePhase });
            }
            const added = result?.added || [];
            if (!isCurrent(ctrl, chatId, travel)) return cancellation(ctrl.signal.aborted || travel?.signal?.aborted ? 'aborted' : 'cancelled');
            if (!added.length && !(result?.patched || []).length) { markCommitted({ reasonCode: 'capture-no-change' }); provenanceCheckpoint = null; if (manual) await runGenerationUiEffect(() => env.toast?.('没有新事件（都已在刻度上）'), { diagnostic, reasonCode: 'capture-toast-failed' }); return { status: 'unchanged', reason: 'duplicate', feedbackShown: manual }; }
            provenanceCheckpoint = null;
            markCommitted({ reasonCode: 'capture-saved' });
            if (manual || env.settings?.()?.notifyMode === 'full') await runGenerationUiEffect(() => env.toast?.(`刻度标注 ${added.length} 条、更新 ${(result?.patched || []).length} 条${added.length ? `：${added.map(e => e.事由).join('、')}` : ''} · 请注意查看`), { diagnostic, reasonCode: 'capture-toast-failed' });
            await runGenerationUiEffect(() => env.refresh?.(), { diagnostic, reasonCode: 'capture-refresh-failed' });
            await runGenerationUiEffect(() => env.refreshInline?.(true), { diagnostic, reasonCode: 'capture-inline-refresh-failed' });
            await runGenerationUiEffect(() => env.render?.(), { diagnostic, reasonCode: 'capture-render-failed' });
            return { status: 'updated', added: added.length, patched: (result?.patched || []).length, feedbackShown: manual || env.settings?.()?.notifyMode === 'full' };
        } catch (err) {
            const ownerCurrent = sameLedgerOwner(ownerSnapshot, ledgerOwnerIdentity(env.context()));
            if (err?.ledgerPhase === 'rollback-save-failed' || err?.phase === 'rollback-save-failed') {
                logLedgerFailure(err, { ledgerPhase: 'rollback-save-failed' });
                if (ownerCurrent) env.toast?.('刻度保存后状态已过期，且回滚失败，请检查当前聊天数据', null, true);
                return { status: 'failed', reason: 'rollback-save-failed', error: err, feedbackShown: ownerCurrent };
            }
            if (String(err?.phase || '').startsWith('capture-stale-chat')) return { status: 'cancelled', stale: true };
            if (abortController !== ctrl || !ownerCurrent) return { status: 'cancelled', reason: 'source-stale-chat', stale: true, error: err };
            if (err?.name === 'AbortError' || travel?.signal?.aborted) return { status: 'cancelled', reason: 'aborted', error: err };
            if (err?.phase === 'capture-state-invalid') { env.toast?.('标注保存后状态不一致，已撤销', null, true); return { status: 'failed', reason: 'capture-state-invalid', error: err, feedbackShown: true }; }
            if (err?.phase === 'persistence-not-committed') { env.toast?.('保存未提交，已恢复本地状态', null, true); return { status: 'failed', reason: 'persistence-not-committed', error: err, feedbackShown: true }; }
            if (err?.phase === 'persistence-unknown') { env.toast?.('刻度持久状态无法确认，已恢复本地状态', null, true); return { status: 'failed', reason: 'persistence-unknown', error: err, feedbackShown: true }; }
            if (err?.spDisabled) return { status: 'skipped', reason: 'spDisabled' };
            markLedgerError(err, { phase: err?.ledgerPhase || 'capture-request' });
            logLedgerFailure(err, { phase: err?.ledgerPhase || 'capture-request', batchNo: err?.ledgerBatchNo, batchTotal: err?.ledgerBatchTotal });
            const manualFailure = manual || env.settings?.()?.notifyMode === 'full';
            const resumable = err?.ledgerPhase === 'source-provenance' && progressCheckpointStable(provenanceCheckpoint);
            if (manualFailure) { const detail = err?.diagnosticCode === 'parse' ? `刻度标注失败：${diagnosticMessage(err)}` : ledgerFailureText('刻度标注失败', err, { phase: err?.ledgerPhase || 'capture-request', batchNo: err?.ledgerBatchNo, batchTotal: err?.ledgerBatchTotal }); env.toast?.(`${detail}${resumable ? '；进度已保留，再次标注将从本批继续' : ''}`, null, true); }
            return { status: 'failed', reason: err?.ledgerPhase || err?.phase || 'api-failed', error: err, feedbackShown: manualFailure };
        } finally {
            if (generationCommitted) {
                await runGenerationUiEffect(() => clear(ctrl), { diagnostic, reasonCode: 'capture-cleanup-failed' });
                await runGenerationUiEffect(() => removeBridge(), { diagnostic, reasonCode: 'capture-cleanup-failed' });
            } else { clear(ctrl); removeBridge(); }
        }
    };
    return {
        run,
        abort(reason = 'manual-abort') { provenanceCheckpoint = null; abortController?.abort(reason); },
        reset(reason = 'reset') { provenanceCheckpoint = null; abortController?.abort(reason); busy = false; progress = null; abortController = null; },
        get isBusy() { return busy; }, get progress() { return progress; }, get abortController() { return abortController; },
    };
}
import { ledgerFailureText, logLedgerFailure, markLedgerError } from './diagnostics.js';
