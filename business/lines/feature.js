import { createLinesLifecycle } from './lifecycle.js';
import { createSwipeLinesStore } from './swipe-store.js';
import { createLinesRuntime } from './runtime.js';
import { createLinesInjectionController } from './injection.js';
import { createLinesGenerationController } from './controller.js';
import { createLinesActions } from './actions.js';
import { commitLineWidget } from './widget.js';
import { createDashedModule } from './dashed.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { parseLines } from './schema.js';
import { stripVectorCueLines } from './vectors/codec.js';
import { vectorGlyphSvg } from './vectors/glyph.js';
import { linesViewModel } from './render.js';
import { inlineState, prefixNext } from './inline.js';
import { classifyRenderedFloor, chooseSwipeLayer, floorToFinalize, markEditedFloor } from './strategy.js';

// 线域组合根：宿主只注入能力与跨域回调；各纯业务子模块不反向读取 index 状态。
export function createLinesFeature(env = {}) {
    const runtime = env.runtime || createLinesRuntime({ render: env.render });
    const owners = env.owners || createTaskOwnerManager();
    const lifecycle = env.lifecycle || createLinesLifecycle();
    const swipeStore = env.swipeStore || createSwipeLinesStore({ storage: env.storage });
    const injection = env.injection || (env.injectionEnv && createLinesInjectionController(env.injectionEnv));
    const dashed = env.dashed || (env.dashedEnv && createDashedModule({ ...env.dashedEnv, refreshPanel: () => refreshPanel?.(true), refreshInline: () => syncInline?.() }));
    const generation = env.generation || (env.generationEnv && createLinesGenerationController({
        ...env.generationEnv,
        owners,
        runtime,
        commit: (...args) => {
            const result = commitGenerationResult(...args);
            if (env.dashedEnabled?.() === true) dashed?.run?.();
            return result;
        },
        onStart: () => { if (env.isPanelActive?.()) refreshPanel?.(); },
        cleanup: (owner, chatId) => cleanupOwner(owner, chatId),
    }));
    const actions = env.actions || (env.actionsEnv && createLinesActions({ ...env.actionsEnv, isBusy: () => runtime.busy, resetCounter: () => { lifecycle.counter = 0; }, render: raw => renderLines(raw), setCached: html => runtime.setHtml(html), refreshPanel: () => refreshPanel?.(), refreshInline: () => syncInline?.(), runGenerate: (...args) => generation?.run?.(...args) }));
    const titleHtml = (className, line) => {
        const name = env.escapeHtml?.(line.name) || '';
        const glyph = vectorGlyphSvg(line.cue);
        return glyph ? `<div class="${className} sp-line-title-with-glyph">${glyph}<span>${name}</span></div>` : `<div class="${className}">${name}</div>`;
    };
    const widget = env.widget || (env.widgetEnv && {
        apply(body, editIdx = null, button = null) {
            const key = env.widgetEnv.key?.();
            if (!key) return env.widgetEnv.fail?.('当前 chat 没有可写入的线缓存');
            const saved = env.widgetEnv.read?.(key);
            const result = commitLineWidget(saved?.raw || '', body, { editIndex: editIdx == null ? null : Number(editIdx) - 1, pin: true });
            if (!result.ok) return env.widgetEnv.fail?.(editIdx != null ? `找不到第 ${editIdx} 条线，请刷新面板后重试` : '卡片格式不完整，无法应用');
            env.widgetEnv.write?.(key, { raw: result.raw, ts: Date.now() });
            runtime.cache(result.raw);
            refreshPanel?.(true);
            syncInline?.();
            env.widgetEnv.button?.(button, editIdx, result);
            return result;
        },
    });
    const renderLines = (raw = '') => {
        const parsed = parseLines(raw);
        const lines = linesViewModel(parsed, Number.POSITIVE_INFINITY);
        if (!lines.length) return `${env.jumpHint?.() || ''}<div class="sp-raw">${env.escapeHtml?.(stripVectorCueLines(raw)).replace(/\n/g, '<br>')}</div>`;
        const colors = env.stageColors || {};
        const cards = lines.map((l, i) => {
            const level = Math.max(1, Math.min(4, Number.parseInt(l.level, 10) || 1));
            const color = colors[l.stage] || '#9aa6b2';
            const beads = Array.from({ length: 4 }, (_, n) => `<span class="sp-bead${n < level ? ' sp-bead-on' : ''}" style="${n < level ? `background:${color}` : ''}"></span>`).join('');
            const parts = [`【线参考】${l.name}（${l.type}·${l.stage}${l.stall ? '·停滞' : ''}）`];
            if (l.desc) parts.push(l.desc);
            if (l.next) parts.push(prefixNext(l.next, l.stall));
            const next = l.next ? `<div class="sp-line-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}"><span class="sp-line-next-tag">${l.stall ? '⏸' : '→'}</span><span class="sp-line-next-text">${env.escapeHtml?.(env.cleanText?.(l.next) || l.next)}</span></div>` : '';
            return `<div class="sp-beat sp-line-card${l.stall ? ' sp-line-stall' : ''}${l.pin ? ' sp-line-pinned' : ''}" data-line-idx="${i}" style="border-left:3px solid ${color}30"><div class="sp-beat-head"><span class="sp-seq-badge">#${i + 1}</span><span class="sp-beat-type" style="color:${color}">${env.escapeHtml?.(l.stage)}</span>${l.type ? `<span class="sp-beat-line">${env.escapeHtml?.(l.type)}</span>` : ''}<span class="sp-beat-time">${beads}</span>${l.stall ? '<span class="sp-line-stall-tag">停滞</span>' : ''}<span class="sp-beat-actions">${env.makeInjectBtn?.(parts.join('\n')) || ''}<button class="sp-line-pin-toggle" data-line-idx="${i}" title="${l.pin ? '解锁' : '锁定'}"><i class="fa-solid fa-${l.pin ? 'lock' : 'lock-open'}"></i></button><button class="sp-line-del-one" data-line-idx="${i}" title="删除这条线"><i class="fa-solid fa-xmark"></i></button></span></div>${l.when ? `<div class="sp-line-when">${env.escapeHtml?.(l.when)}</div>` : ''}${titleHtml('sp-beat-title', l)}${l.desc ? `<div class="sp-beat-scene">${env.escapeHtml?.(env.cleanText?.(l.desc) || l.desc)}</div>` : ''}${next}</div>`;
        }).join('');
        return `${env.jumpHint?.() || ''}${cards}`;
    };
    const inlineHtml = (raw = null, readOnly = false) => {
        if (env.getSettings?.().linesInlineEnabled === false) return '';
        const value = raw == null ? env.readRaw?.() || '' : raw;
        const view = inlineState(value, { readOnly });
        const dashedSub = !readOnly && view.dashed.enabled ? dashed?.inlineHtml?.() || '' : '';
        const body = view.lines.map((line, i) => {
            const level = Math.max(1, Math.min(4, Number.parseInt(line.level, 10) || 1));
            const color = (env.stageColors || {})[line.stage] || '#9aa6b2';
            const beads = Array.from({ length: 4 }, (_, n) => `<span class="sp-bead${n < level ? ' sp-bead-on' : ''}" style="${n < level ? `background:${color}` : ''}"></span>`).join('');
            const actions = view.hasActions ? `<span class="sp-beat-actions">${env.makeInjectBtn?.([`【线参考】${line.name}（${line.type}·${line.stage}${line.stall ? '·停滞' : ''}）`, line.desc, line.nextText].filter(Boolean).join('\n')) || ''}<button class="sp-line-del-one" data-line-idx="${i}" title="删除这条线"><i class="fa-solid fa-xmark"></i></button></span>` : '';
            return `<div class="sp-inline-line${line.stall ? ' sp-line-stall' : ''}" data-line-idx="${i}" style="border-left:3px solid ${color}20"><div class="sp-inline-head"><span class="sp-inline-stage" style="color:${color}">${env.escapeHtml?.(line.stage)}</span>${line.type ? `<span class="sp-inline-type">${env.escapeHtml?.(line.type)}</span>` : ''}<span class="sp-inline-dots">${beads}</span>${line.when ? `<span class="sp-inline-when">${env.escapeHtml?.(line.when)}</span>` : ''}${line.stall ? '<span class="sp-line-stall-tag sp-inline-stall">停滞</span>' : ''}${actions}</div>${titleHtml('sp-inline-name', line)}${line.desc ? `<div class="sp-inline-desc">${env.escapeHtml?.(env.cleanText?.(line.desc) || line.desc)}</div>` : ''}${line.next ? `<div class="sp-line-next sp-inline-next ${line.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}"><span class="sp-line-next-tag">${line.stall ? '⏸' : '→'}</span><span class="sp-line-next-text">${env.escapeHtml?.(env.cleanText?.(line.next) || line.next)}</span></div>` : ''}</div>`;
        }).join('');
        const controls = !readOnly && view.hasActions ? '<span class="sp-inline-summary-actions"><button class="sp-inline-refresh-lines" title="重新生成线"><i class="fa-solid fa-rotate-right"></i></button><button class="sp-inline-advance-lines" title="推进事件线"><i class="fa-solid fa-forward"></i></button></span>' : '';
        const summary = `<summary class="sp-inline-summary"><span class="sp-inline-title">线</span><span class="sp-inline-count${view.empty ? ' sp-inline-empty' : ''}">${view.empty ? '暂无' : `${view.count} 条活跃`}</span>${controls}</summary>`;
        return `${summary}${body || dashedSub ? `<div class="sp-inline-body" data-lines-inject-text="${env.escapeAttr?.(view.injectText) || ''}">${body}${dashedSub}</div>` : ''}`;
    };
    const appendInlineBlock = async (messageId, shouldAdvance) => {
        env.refreshInlineWindow?.(true);
        const cfg = env.loadConfig?.();
        if (shouldAdvance && !runtime.busy && cfg?.url && cfg?.key) {
            const swipeId = Number(env.swipeId?.(messageId) ?? 0);
            await generation?.run?.(true, { mesId: Number(messageId), swipeId });
            env.refreshInlineWindow?.(true);
        }
        env.freezeSnapshot?.(messageId);
    };
    const syncInline = expectedChatId => {
        if (expectedChatId != null && env.chatId?.() !== expectedChatId) return;
        injection?.refresh?.();
        env.refreshInlineWindow?.(true);
    };
    const commitGenerationResult = (raw, { silent, swipeCtx, travelContext, commitBaseline } = {}) => {
        const chatId = env.chatId?.();
        const key = env.cacheKey?.();
        const html = runtime.cache(raw);
        env.writeStore?.(key, { raw, ts: Date.now() });
        if (swipeCtx?.mesId != null) {
            const rec = swipeStore.read(chatId, swipeCtx.mesId) || { baseline: swipeCtx.baselineRaw ?? commitBaseline?.raw ?? '', swipes: {}, view: 'user', charName: '' };
            if (rec.baseline == null) rec.baseline = swipeCtx.baselineRaw ?? commitBaseline?.raw ?? '';
            rec.swipes[String(swipeCtx.swipeId ?? 0)] = raw;
            swipeStore.write(chatId, swipeCtx.mesId, rec);
        }
        if (env.isPanelActive?.()) { refreshPanel(true); if (!silent && env.notifyMode?.() !== 'off') env.toast?.('线已生成'); }
        syncInline(chatId);
        if (!env.isPanelActive?.() && !silent) env.toast?.('线已生成，点击查看');
        return travelContext;
    };
    const cleanupOwner = (owner, chatId) => {
        if (!owners.isCurrent(owner, { chatId })) return false;
        runtime.finish(owner.controller);
        owners.finish(owner);
        if (env.isPanelActive?.()) refreshPanel();
        return true;
    };
    const abortGeneration = ({ restore = true } = {}) => {
        const owner = owners.invalidate('lines-generation');
        runtime.abort();
        if (restore && owner?.baseline && owner.baseline.chatId === env.chatId?.()) env.restoreBaseline?.(owner.baseline);
    };
    const rerunSwipe = async ({ mesId, forceRegen = false } = {}) => {
        const swipe = env.swipeEnv || {};
        const cfg = swipe.loadConfig?.() || {};
        if (!cfg.url || !cfg.key) return;
        const chatId = swipe.chatId?.();
        const swipeId = Number(swipe.swipeId?.(mesId) ?? 0);
        if (!forceRegen && applyStoredSwipe({ chatId, mesId, swipeId, key: swipe.key?.(), writeStore: swipe.writeStore, render: swipe.render, syncInline: swipe.syncInline })) return;
        const rec = swipeStore.read(chatId, mesId);
        let baseline = rec?.baseline;
        if (forceRegen && baseline == null) baseline = swipe.previousBaseline?.(Number(mesId)) || null;
        if (baseline == null) return;
        if (runtime.busy) runtime.abort();
        return generation?.run?.(true, { mesId: Number(mesId), swipeId, baselineRaw: baseline, forceReroll: true });
    };
    const onCharacterRendered = async ({ messageId, type, autoSuppressed = false } = {}) => {
        if (!env.pluginEnabled?.() || env.getSettings?.().linesEnabled === false) return;
        const mid = Number(messageId);
        const pendingReroll = lifecycle.consumePendingReroll();
        const signature = env.floorSignature?.(mid) || '';
        const text = String(env.messageText?.(mid) || '');
        const changed = mid === lifecycle.lastSeenMaxMesId && lifecycle.floorTextSig[mid] !== undefined && signature !== lifecycle.floorTextSig[mid] && text.trim() !== '';
        lifecycle.floorTextSig[mid] = signature;
        const decision = classifyRenderedFloor({ messageId: mid, lastSeen: lifecycle.lastSeenMaxMesId, type, pendingReroll, contentChanged: changed, pendingSwipe: lifecycle.pendingSwipeGen?.mesId === mid });
        let advance = false;
        if (decision.isNewFloor) {
            lifecycle.lastSeenMaxMesId = mid;
            const mode = env.getMode?.();
            if (!autoSuppressed && mode === 'days') advance = lifecycle.detectInGameDayChange();
            else if (!autoSuppressed && mode === 'turns') advance = lifecycle.advanceCounter({ mode, interval: env.getInterval?.() }).shouldAdvance;
        } else if (decision.isReroll || lifecycle.pendingSwipeGen?.mesId === mid) {
            const swipeGeneration = lifecycle.consumePendingSwipe(mid);
            await appendInlineBlock(mid, false);
            if (!swipeGeneration) await rerunSwipe({ mesId: mid, forceRegen: true });
            return;
        }
        await appendInlineBlock(mid, advance);
        if (advance && env.getSettings?.().notifyMode === 'full') env.toast?.('线已随剧情自动推进 · 请注意查看');
    };
    const onSwiped = async ({ mesId, info } = {}) => {
        if (!env.pluginEnabled?.() || env.getSettings?.().linesEnabled === false) return;
        const mid = Number(mesId);
        const swipeId = Number(info?.nextSwipeId ?? env.swipeId?.(mid) ?? 0);
        const decision = chooseSwipeLayer({ pendingGeneration: !!info?.pendingGeneration, swipeId, stored: swipeStore.read(env.chatId?.(), mid), baseline: '' });
        if (decision.action === 'wait') { lifecycle.markPendingSwipe(mid); return; }
        lifecycle.floorTextSig[mid] = env.floorSignature?.(mid) || '';
        if (applyStoredSwipe({ chatId: env.chatId?.(), mesId: mid, swipeId, key: env.cacheKey?.(), writeStore: env.writeStore, syncInline: syncInline })) refreshPanel?.(true);
    };
    const onEdited = ({ mesId } = {}) => {
        if (!env.pluginEnabled?.() || env.getSettings?.().linesEnabled === false) return;
        const mid = Number(mesId); if (!Number.isFinite(mid)) return;
        const edited = markEditedFloor({ messageId: mid, signature: env.floorSignature?.(mid) || '' });
        if (edited) lifecycle.floorTextSig[edited.messageId] = edited.signature;
    };
    const onSent = ({ insertAt } = {}) => {
        if (!env.pluginEnabled?.() || env.getSettings?.().linesEnabled === false) return;
        const floor = floorToFinalize({ chat: env.chat?.(), insertAt });
        if (floor != null) swipeStore.clear(env.chatId?.(), floor);
    };
    const onGenerationStarted = ({ genType, dryRun } = {}) => {
        if (!env.pluginEnabled?.() || dryRun) return;
        lifecycle.markGenerationStarted({ reroll: genType === 'regenerate', excludedAssistant: genType === 'regenerate' ? env.lastAssistant?.() : null });
    };
    const onToken = () => { if (env.pluginEnabled?.()) lifecycle.markToken(); };
    const onGenerationEnded = () => { if (env.pluginEnabled?.()) { lifecycle.endGeneration(); setTimeout(() => env.refreshInlineWindow?.(true), 60); } };
    let sheet = 'events';
    const renderBody = body => {
        env.renderPanelDom?.({ toolbar: dashed?.toolbarHtml?.({ onEvents: sheet === 'events', lineBusy: runtime.busy ? ' sp-refresh-busy' : '', generationBusy: runtime.busy }), body: sheet === 'dashed' ? dashed?.panelHtml?.() : String(body || '') });
    };
    const refreshPanel = (force = false) => {
        const raw = env.readRaw?.() || '';
        const body = runtime.busy && !force ? env.loading?.() : raw ? renderLines(raw) : env.empty?.();
        if (raw && !runtime.busy) runtime.cache(raw);
        renderBody(body);
        return body;
    };
    const applyStoredSwipe = ({ chatId, mesId, swipeId, key, writeStore, render, syncInline } = {}) => {
        const rec = swipeStore.read(chatId, mesId);
        const hit = rec?.swipes?.[String(swipeId)];
        if (hit == null || !key || typeof writeStore !== 'function') return false;
        writeStore(key, { raw: hit, ts: Date.now() });
        runtime.cache(hit);
        render?.(hit);
        syncInline?.(chatId);
        return true;
    };
    return {
        runtime, lifecycle, swipeStore, injection, generation, actions, dashed,
        nextChatRevision: () => owners.nextChatRevision(),
        invalidateGeneration: () => owners.invalidate('lines-generation'),
        isCurrent: (owner, identity) => owners.isOwner(owner, identity),
        finishOwner: owner => owners.finish(owner),
        widget,
        detectInGameDayChange: ({ day = env.dayAnchor?.(), decide = env.dayAdvance } = {}) => lifecycle.detectInGameDayChange({ day, decide }),
        readSwipe: (chatId, mesId) => swipeStore.read(chatId, mesId),
        writeSwipe: (chatId, mesId, data) => swipeStore.write(chatId, mesId, data),
        clearSwipe: (chatId, mesId) => swipeStore.clear(chatId, mesId),
        clearAllSwipe: chatId => swipeStore.clearAll(chatId),
        applyStoredSwipe,
        rerunSwipe,
        generate: (...args) => actions?.reroll?.(...args),
        advance: (...args) => actions?.advance?.(...args),
        reroll: (...args) => actions?.reroll?.(...args),
        deleteLine: (...args) => actions?.delete?.(...args),
        togglePin: (...args) => actions?.pin?.(...args),
        get sheet() { return sheet; },
        setSheet: value => { if (value === 'events' || value === 'dashed') sheet = value; return sheet; },
        renderLines, inlineHtml, appendInlineBlock, syncInline, commitGenerationResult, cleanupOwner, abortGeneration,
        onCharacterRendered, onSwiped, onEdited, onSent, onGenerationStarted, onToken, onGenerationEnded,
        isStreaming: () => Date.now() < lifecycle.streamUntil,
        resetCounter: () => { lifecycle.counter = 0; },
        setLastDay: value => { lifecycle.lastDay = value; },
        onChatChanged: ({ lastSeen = -1 } = {}) => { abortGeneration({ restore: false }); lifecycle.resetChat({ lastSeen }); return env.onChatChanged?.({ lastSeen }); },
        renderBody,
        refreshPanel,
    };
}
