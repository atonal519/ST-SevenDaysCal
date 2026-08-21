import { ledgerSourceFingerprint } from './reconcile.js';
// 刻度捕获纯依赖：只负责正文楼层/来源窗口与稳定性，不执行 API 或落库。
export const LEDGER_EVENT_TYPES = `【什么算刻度事件】会随时间推移改变状态、或到某天该发生的事，典型三类：
- 持续状态：身体伤情 / 病症、怀孕、显著且会延续的情绪等——会随天数自然演变（如割伤→结痂→愈合）。
- 约定待办：约好要做的事（哪天见面、答应帮忙），无论有没有定下具体日期都要记。
- 周期：规律反复发生的事（月经、发薪、值班），带大致周期天数。
【主语永远是「人」】每条都登记在某个人物身上——记 TA 的状态，或 TA 牵扯的约定/周期。不要给物品单独立条（如「桌上有把枪」「仓库存着粮」不记）；但物品作用到人身上的状态要记（如「A 中了毒、尚未解」「B 戴着诅咒项链、受其束缚」）。`;
export const LEDGER_FIELD_SPEC = `- 每个事件一行，用全角竖线「｜」分隔 8 个字段，顺序固定：
 事由｜类型｜牵扯｜标签｜现状｜到期｜周期｜来源锚
  · 类型：持续状态 / 约定待办 / 周期（只能三选一，原样写这三个词之一）
  · 牵扯：涉及的人物，多个用顿号「、」分隔；没有就留空
  · 标签：检索关键词，多个用「、」分隔（如：伤、左手、身体）
  · 现状：此刻状态一句话（如「新伤口，仍在流血」）
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
export function ledgerFloorDateContext(floor = null) {
    const chat = env.context().chat || [];
    const floorId = Number.isInteger(floor) ? floor : ledgerLatestAiFloorId();
    const message = floorId >= 0 ? chat[floorId] : null;
    if (!message || !ledgerNarrativeMessage(message)) return { floor: null, date: null };
    const clock = env.parseClock(message.mes || '');
    const date = env.parseDate(clock.end) || env.parseDate(clock.start);
    return { floor: floorId, date: date || null };
}
export function ledgerAiFloorRecords(limit = null) {
    const chat = env.context().chat || [], floors = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i]; if (!ledgerNarrativeMessage(msg)) continue;
        const clock = env.parseClock(msg.mes); const parts = [];
        if (clock.start && env.parseDate(clock.start)) parts.push({ side: 'S', stamp: clock.start, date: env.parseDate(clock.start) });
        if (clock.end && env.parseDate(clock.end)) parts.push({ side: 'E', stamp: clock.end, date: env.parseDate(clock.end) });
    floors.push({ floor: i, signature: String(msg.mes), identity: { is_user: !!msg.is_user, is_system: !!msg.is_system, name: String(msg.name || ''), type: String(msg.extra?.type || '') }, content: env.stripTags(String(msg.mes), env.settings()).trim(), sources: parts.map(part => ({ token: `F${i}${part.side}`, floor: i, date: part.date, stamp: part.stamp, signature: String(msg.mes), fingerprint: ledgerSourceFingerprint(`F${i}${part.side}`, String(msg.mes)) })) });
    }
    const selected = limit == null ? floors : floors.slice(-Math.max(0, limit));
    return selected.map(item => ({ ...item, sources: item.sources.map(source => ({ ...source, content: item.content })) }));
}
export const ledgerSourceFloors = (limit = null) => ledgerAiFloorRecords(limit).flatMap(item => item.sources);
export function ledgerSourceMap(sources) { return new Map((sources || []).map(source => [String(source.token), source])); }
export function ledgerSourceAnchor(token, sourceMap) {
    const key = String(token || '').trim(); if (key === 'SET') return { 楼层: null, 历日期: null }; const source = sourceMap?.get(key); if (!source) return null;
    const raw = env.context().chat?.[source.floor]?.mes || ''; const clock = env.parseClock(raw); const stamp = source.token.endsWith('S') ? clock.start : clock.end; const date = stamp ? env.parseDate(stamp) : null; return date ? { 楼层: source.floor, 历日期: date } : null;
}
export function ledgerSourcesStable(sources, chatId) { if (env.context().chatId !== chatId) return false; const chat = env.context().chat || []; return (sources || []).every(source => { const msg = chat[source.floor]; return ledgerNarrativeMessage(msg) && String(msg.mes || '') === source.signature; }); }
export function ledgerRecordsStable(records, chatId) {
    if (env.context().chatId !== chatId) return false; const chat = env.context().chat || [];
    return (records || []).every(record => { const msg = chat[record.floor]; if (!ledgerNarrativeMessage(msg) || String(msg.mes || '') !== record.signature) return false; const identity = record.identity || {}; if (!!msg.is_user !== !!identity.is_user || !!msg.is_system !== !!identity.is_system) return false; if (String(msg.name || '') !== String(identity.name || '') || String(msg.extra?.type || '') !== String(identity.type || '')) return false; return (record.sources || []).every(source => { const side = String(source.token || '').endsWith('S') ? 'S' : String(source.token || '').endsWith('E') ? 'E' : ''; if (!side || source.signature !== record.signature) return false; const clock = env.parseClock(String(msg.mes || '')); const stamp = side === 'S' ? clock.start : clock.end; const date = stamp ? env.parseDate(stamp) : null; return !!date && date.month === source.date.month && date.day === source.date.day; }); });
}
export function ledgerLegacyAnchor(sourceList) { const dates = new Map(); for (const source of sourceList || []) dates.set(`${source.date.month}/${source.date.day}`, source.date); return dates.size === 1 ? { 楼层: null, 历日期: [...dates.values()][0] } : { 楼层: null, 历日期: null }; }
export function ledgerSourceBatches(sources, size = CAPTURE_FLOORS) { const list = Array.isArray(sources) ? sources : []; const batches = []; for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size)); return batches; }
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
function buildCapturePrompt(first = false) {
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
- 宁可多记：拿不准也记下，漏记的代价比多记大；既定机制哪怕暂时没触发也要记。
${fieldSpec}
- 若确实没有任何可登记的，只回一个字：无
不要解释，不要输出表头，不要输出多余文字。`;
    const closed = env.listEntries?.({ includeClosed: true })?.filter(e => e.状态 === '已了结') || [];
    const active = env.listEntries?.() || [];
    const activeText = active.length ? active.map(e => `- ${e.事由}${e.标签?.length ? `（${e.标签.join('、')}）` : ''}`).join('\n') : '（暂无，本次都是新登记）';
    const closedText = closed.length ? `\n【已了结·别重新登记】\n下面这些已经完结、或被用户手动归档了。默认**一律别再登记**；只有正文里出现了**明确的新进展**（旧事重新启动、或又发生了一次全新的独立事件）才重新记，并在现状里点明「新」在哪：\n${closed.map(e => `- ${e.事由}${e.标签?.length ? `（${e.标签.join('、')}）` : ''}`).join('\n')}\n` : '';
    return `请暂停角色扮演，作为剧情分析助手，只做一件事：从以上最近的对话正文里，捞取「需要按时间追踪」的新事件，记入「刻度」。

${eventTypes}

【已在刻度上的（不要重复登记）】
${activeText}${closedText}
【规则】
- 只登记上面对话里【新出现】的，或【虽同名但明显是另一次独立事件】的；已在刻度上的同一件事跳过。
- **同一件事只记一条**：判断「是不是同一件事」看的是**事情本身**，不是措辞——同一个人的同一桩事，哪怕换了说法、换了角度、详略不同，也算重复。这有两层：① 别登记与上面清单里已有的重复；② 你这一次别把一件事拆成两三条近义的分别登记。
- 宁可多记，但「多记」指的是多记【确实是新的、不同的】事——拿不准是不是新事就记下；不是把同一件事重复记，也不是把已了结/已归档的翻出来重记。
${fieldSpec}
- 若没有任何新事件可登记，只回一个字：无
不要解释，不要输出表头，不要输出多余文字。`;
}
function buildProvenancePrompt(candidates, batchNo, batchTotal) {
    const list = (candidates || []).map(item => `- ${item._candidateId}｜${item.事由}（${item.类型}）${item.标签?.length ? `｜标签：${item.标签.join('、')}` : ''}`).join('\n');
    return `请暂停角色扮演，进行「刻度事件来源溯源」。这是第 ${batchNo}/${batchTotal} 批原始剧情楼；每个 AI 楼正文前的 FxxS/FxxE 是系统可信来源令牌，只能从本批正文中选择，不能自行编造楼号、日期或令牌。\n\n【待溯源事项】\n${list || '（无）'}\n\n请只输出本批正文中能明确找到最早发生/确认依据的事项；同一事项若已有更早批次来源，不要重复输出。每条使用 9 字段格式：候选ID｜事由｜类型｜牵扯｜标签｜现状｜到期｜周期｜来源锚。候选ID 必须原样抄写；来源锚只能填本批实际存在且支撑该事项的 FxxS/FxxE；若本批没有依据就不要输出。不要输出 SET，不要解释。`;
}
export function createLedgerCaptureController(options = {}) {
    env = { ...env, ...options };
    let busy = false;
    let progress = null;
    let abortController = null;
    const isCurrent = (ctrl, chatId, travel) => abortController === ctrl && !ctrl.signal.aborted && !travel?.signal?.aborted && env.context().chatId === chatId;
    const clear = ctrl => {
        if (abortController !== ctrl) return false;
        busy = false; progress = null; abortController = null;
        env.setProgress?.(0, 0, ctrl);
        return true;
    };
    const run = async (manual = false, travel = null) => {
        if (busy) return { status: 'skipped' };
        const ctx = env.context();
        const charKey = env.charKey?.(ctx);
        if (!charKey) { if (manual) env.toast?.('当前没有角色卡，无法标注', null, true); return { status: 'skipped' }; }
        const cfg = env.config?.();
        if (!cfg?.url || !cfg?.key) { if (manual) env.toast?.('请先在设置中填写 API', null, true); return { status: 'failed', error: new Error('未配置 API') }; }
        const chatId = ctx.chatId;
        const ctrl = new AbortController(); abortController = ctrl; busy = true;
        const removeBridge = env.bridge?.(travel?.signal, ctrl) || (() => {});
        try {
            const userName = ctx.name1 || '用户', charName = ctx.name2 || '角色';
            const isFirst = (env.listEntries?.({ includeClosed: true }) || []).length === 0;
            const prompt = env.appendTravel?.(buildCapturePrompt(isFirst), travel) || buildCapturePrompt(isFirst);
            const targetDate = env.validDate?.(travel?.targetDate, env.calendar?.());
            const floorContext = ledgerFloorDateContext();
            const captureFloor = floorContext.floor;
            const captureDate = targetDate || floorContext.date || env.today?.();
            const recentRecords = ledgerAiFloorRecords(CAPTURE_FLOORS);
            const recentSources = recentRecords.flatMap(record => record.sources);
            const recentSourceMap = ledgerSourceMap(recentSources);
            const allRecords = isFirst ? ledgerAiFloorRecords() : null;
            const aiFloorCount = allRecords?.length || 0;
            const historical = isFirst && aiFloorCount > CAPTURE_FLOORS;
            const provenanceBatches = historical ? ledgerSourceBatches(allRecords) : [];
            if (historical) {
                if (!manual) { clear(ctrl); env.toast?.(`历史较长（${aiFloorCount} 个 AI 楼），自动捕获不会静默启动多批溯源；请点「立即标注」并确认。`); return { status: 'needs-confirmation' }; }
                const ok = await env.confirm?.({ title: '确认完整溯源刻度', body: `当前 ledger 为空，共 ${aiFloorCount} 个 AI 楼。将先提取清单，再按每批最多 ${CAPTURE_FLOORS} 个 AI 回复溯源，最多调用 ${1 + provenanceBatches.length} 次（1 次清单 + ${provenanceBatches.length} 批）。找到全部来源后会提前结束；过程会增加 API 消耗和等待时间，可随时中止；确认后统一落库。`, note: '取消不会发起请求，也不会写入任何刻度。', confirmText: '开始溯源', cancelText: '取消' });
                if (!ok) { clear(ctrl); return { status: 'cancelled' }; }
                if (!isCurrent(ctrl, chatId, travel)) return { status: 'cancelled' };
            }
            const captureOpts = { ...(travel || {}), noAlmanac: true };
            if (recentRecords.length) captureOpts.ledgerSourceFloors = recentRecords;
            const raw = await env.callApi(ctx, prompt, cfg, userName, charName, ctrl.signal, CAPTURE_FLOORS, captureOpts);
            if (!isCurrent(ctrl, chatId, travel)) return { status: 'cancelled' };
            let picked = env.parseCapture?.(raw) || [];
            if (!picked.length) { if (manual) env.toast?.('未发现可登记的新事件'); return { status: 'unchanged' }; }
            picked.forEach((item, index) => { item._candidateId = `C${index + 1}`; });
            let sourceList = recentSources, sourceMap = recentSourceMap, recordsForCommit = recentRecords;
            if (historical) {
                sourceList = allRecords.flatMap(record => record.sources); sourceMap = ledgerSourceMap(sourceList); recordsForCommit = allRecords;
                const candidates = picked.filter(item => String(item._sourceToken || '').trim() !== 'SET');
                candidates.forEach(item => { item._sourceToken = ''; });
                progress = { done: 0, total: provenanceBatches.length }; env.setProgress?.(0, provenanceBatches.length, ctrl);
                for (let i = 0; i < provenanceBatches.length; i++) {
                    if (!isCurrent(ctrl, chatId, travel)) return { status: 'cancelled' };
                    const unresolved = candidates.filter(item => !String(item._sourceToken || '').trim());
                    if (!unresolved.length) break;
                    const batch = provenanceBatches[i];
                    const result = await env.callApi(ctx, buildProvenancePrompt(unresolved, i + 1, provenanceBatches.length), cfg, userName, charName, ctrl.signal, 0, { ...(travel || {}), noAlmanac: true, ledgerSourceFloors: batch });
                    if (!isCurrent(ctrl, chatId, travel)) return { status: 'cancelled' };
                    const found = env.parseCapture?.(result) || [], batchMap = ledgerSourceMap(batch.flatMap(record => record.sources)), hits = [];
                    for (const item of found) {
                        const candidate = candidates.find(x => x._candidateId === item._candidateId && !String(x._sourceToken || '').trim());
                        const token = String(item._sourceToken || '').trim();
                        if (candidate && ledgerSourceAnchor(token, batchMap)) hits.push({ candidate, token, source: batchMap.get(token) });
                    }
                    hits.sort((a, b) => a.source.floor - b.source.floor || Number(!a.token.endsWith('S')) - Number(!b.token.endsWith('S')));
                    hits.forEach(hit => { if (!String(hit.candidate._sourceToken || '').trim()) hit.candidate._sourceToken = hit.token; });
                    progress = { done: i + 1, total: provenanceBatches.length }; env.setProgress?.(i + 1, provenanceBatches.length, ctrl);
                }
            }
            const seen = new Set((env.listEntries?.({ includeClosed: true }) || []).map(e => env.normGist?.(e.事由) || String(e.事由 || '').replace(/\s+/g, '')));
            const plans = [];
            for (const item of picked) {
                const gist = env.normGist?.(item.事由) || String(item.事由 || '').replace(/\s+/g, '');
                if (!gist || seen.has(gist)) continue; seen.add(gist);
                plans.push({ ...item, 起始锚: resolveLedgerStartAnchor(item, sourceMap, sourceList), 现状锚: { 楼层: captureFloor, 历日期: captureDate } });
            }
            if (!plans.length) { if (manual) env.toast?.('没有新事件（都已在刻度上）'); return { status: 'unchanged' }; }
            if (!isCurrent(ctrl, chatId, travel) || !ledgerRecordsStable(recordsForCommit, chatId)) { env.toast?.('原始剧情楼在溯源期间发生变化，已取消本轮刻度落库', null, true); return { status: 'cancelled' }; }
            const added = await env.addAtomic?.(plans.map(plan => { const clean = { ...plan }; delete clean._sourceToken; delete clean._candidateId; return clean; }));
            if (!isCurrent(ctrl, chatId, travel)) return { status: 'cancelled', stale: true };
            if (!added?.length) { if (manual) env.toast?.('没有新事件（都已在刻度上）'); return { status: 'unchanged' }; }
            if (manual || env.settings?.()?.notifyMode === 'full') env.toast?.(`刻度标注 ${added.length} 条：${added.map(e => e.事由).join('、')} · 请注意查看`);
            env.refresh?.(); env.refreshInline?.(true); env.render?.();
            return { status: 'updated' };
        } catch (err) {
            if (abortController !== ctrl) return { status: 'cancelled', stale: true };
            if (err?.name === 'AbortError' || travel?.signal?.aborted) return { status: 'cancelled' };
            if (err?.spDisabled) return { status: 'skipped' };
            if (env.context().chatId !== chatId) return { status: 'cancelled' };
            env.toast?.('刻度标注失败，请检查 API 或网络', null, true); return { status: 'failed', error: err };
        } finally { clear(ctrl); removeBridge(); }
    };
    return {
        run,
        abort() { abortController?.abort(); },
        reset() { abortController?.abort(); busy = false; progress = null; abortController = null; },
        get isBusy() { return busy; }, get progress() { return progress; }, get abortController() { return abortController; },
    };
}
