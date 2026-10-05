import { createLinesLifecycle } from './lifecycle.js';
import { createSwipeLinesStore } from './swipe-store.js';
import { createLinesRuntime } from './runtime.js';
import { createLinesInjectionController } from './injection.js';
import { createLinesGenerationController } from './controller.js';
import { createLinesActions } from './actions.js';
import { diagnosticMessage, runGenerationUiEffect, safeDiagnosticLog } from '../../api/diagnostics.js';
import { UI_REFRESH_FAILURE_TEXT } from '../ui/panel-failure.js';
import { commitLineWidget } from './widget.js';
import { createDashedModule } from './dashed.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { traceDiagnosticEvent } from '../../runtime/diagnostic-trace.js';
import { parseLines, serializeLines, TERMINAL_LINE_STAGES } from './schema.js';
import { publicCueChips, stripInternalLineLines } from './vectors/codec.js';
import { vectorGlyphSvg } from './vectors/glyph.js';
import { linesViewModel } from './render.js';
import { buildLineInjectText, inlineState } from './inline.js';
import { chooseSwipeLayer, floorToFinalize, markEditedFloor } from './strategy.js';
import { renderActionMenu } from '../utils/action-menu.js';
import { changeCurrentLineStore, freezeLineStore, generatedLineStore, lineStoreMatches, manualLineStore, normalizeLineGeneratedAt, normalizeLineHistory, restoreLineHistoryVersion, retiredLineStore, snapshotLineStore } from './version-history.js';
import { createDeadlineSignal, LINES_TIME_LIMITS } from '../../runtime/deadline.js';

const LINE_EDGE_COLORS = Object.freeze({
    ordinary: '#6aab8a',
    ordinaryPinned: '#3f765c',
    adult: '#d6b85a',
    adultPinned: '#8d7330',
});

const lineEdgeColor = line => line.adult
    ? (line.pin ? LINE_EDGE_COLORS.adultPinned : LINE_EDGE_COLORS.adult)
    : (line.pin ? LINE_EDGE_COLORS.ordinaryPinned : LINE_EDGE_COLORS.ordinary);

const LINE_STAGE_STEPS = Object.freeze({
    '起线': 1,
    '延展': 2,
    '成形': 3,
    '收束': 4,
});

const escapePanelText = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// 阶段文字已承担可访问的状态语义；四格只是本地视觉刻度，不伪装成百分比进度。
const lineStageMeterHtml = (stage, color) => {
    const faded = stage === '淡出';
    const filled = faded ? 0 : (LINE_STAGE_STEPS[stage] || 0);
    const segments = Array.from({ length: 4 }, (_, index) => `<span class="sp-line-stage-segment${index < filled ? ' sp-line-stage-segment-filled' : ''}"></span>`).join('');
    return `<span class="sp-line-stage-meter${faded ? ' sp-line-stage-meter-faded' : ''}" style="color:${color}" aria-hidden="true">${segments}</span>`;
};

// 线域组合根：宿主只注入能力与跨域回调；各纯业务子模块不反向读取 index 状态。
export function createLinesFeature(env = {}) {
    const runtime = env.runtime || createLinesRuntime({ render: env.render, onBusyChange: env.onBusyChange });
    const owners = env.owners || createTaskOwnerManager();
    const lifecycle = env.lifecycle || createLinesLifecycle();
    if (lifecycle.lastDay == null && typeof env.dayAnchor === 'function') lifecycle.lastDay = env.dayAnchor() ?? null;
    const swipeStore = env.swipeStore || createSwipeLinesStore({ storage: env.storage });
    const injection = env.injection || (env.injectionEnv && createLinesInjectionController(env.injectionEnv));
    const dashed = env.dashed || (env.dashedEnv && createDashedModule({ ...env.dashedEnv, refreshPanel: () => refreshPanel?.(true), refreshInline: () => syncInline?.() }));
    let historyBusy = false;
    let pendingHistoryRestore = null;
    let autoAdvanceQueueEpoch = 0;
    let pendingAutoAdvance = null;
    let autoAdvancePump = null;
    // Failure feedback is session UI state only; its owner/chat identity prevents late work from repainting a newer view.
    let lastGenerationFailure = null;
    const currentGenerationOwner = owner => {
        return owner?.channel === 'lines-generation'
            && runtime.controller === owner.controller
            && (owners.isCurrent(owner)
                || (owner.controller.signal.reason?.code === 'operation-timeout' && owners.isOwner(owner)));
    };
    const clearGenerationFailure = () => { lastGenerationFailure = null; };
    const failureText = (error, reasonCode) => reasonCode === 'evolution-newborn-missing-ticket'
        ? '上次生成失败：模型漏写了新线的来源编号。原有内容未改变，可以重新生成。'
        : `上次生成失败：${diagnosticMessage(error, { phase: error?.phase || 'request' })}`;
    const generation = env.generation || (env.generationEnv && createLinesGenerationController({
        ...env.generationEnv,
        timeLimits: env.timeLimits || env.generationEnv.timeLimits,
        owners,
        runtime,
        commit: async (...args) => {
            const result = await commitGenerationResult(...args);
            if ((result === true || result?.ok === true) && !result?.stale && env.dashedEnabled?.() === true) dashed?.run?.();
            return result;
        },
        onStart: owner => {
            if (!currentGenerationOwner(owner)) return;
            clearGenerationFailure();
            if (env.isPanelActive?.()) refreshPanel?.();
        },
        onPhase: (owner, _phase, label) => {
            // Only the current generation owner may repaint the shared loading label after an async boundary.
            if (!owner?.controller || owner.controller.signal.aborted
                || runtime.controller !== owner.controller
                || !owners.isCurrent(owner, { chatId: env.chatId?.(), chatRevision: owners.currentChatRevision() })) return;
            runtime.start(owner.controller, label);
            if (env.isPanelActive?.()) refreshPanel?.();
        },
        cleanup: (owner, chatId, options) => cleanupOwner(owner, chatId, options),
        fail: (error, options = {}) => {
            const { owner, reasonCode } = options;
            if (currentGenerationOwner(owner)) lastGenerationFailure = { chatId: owner.chatId, chatRevision: owner.chatRevision, text: failureText(error, reasonCode) };
            env.generationEnv.fail?.(error, options);
        },
    }));
    const actions = env.actions || (env.actionsEnv && createLinesActions({
        ...env.actionsEnv,
        timeLimits: env.timeLimits || env.actionsEnv.timeLimits,
        isBusy: () => runtime.busy || historyBusy,
        resetCounter: () => { lifecycle.counter = 0; },
        render: raw => renderLines(raw),
        setCached: html => runtime.setHtml(html),
        refreshPanel: () => refreshPanel?.(),
        refreshInline: () => syncInline?.(),
        beginPreflight: () => {
            clearGenerationFailure();
            const participantIdentity = env.participantIdentity?.() || null;
            const owner = owners.create('lines-preflight', { chatId: env.chatId?.(), chatRevision: owners.currentChatRevision(), participantIdentity });
            owner.deadlineAt = Date.now() + (env.timeLimits?.totalMs ?? LINES_TIME_LIMITS.totalMs);
            owner.preparationDeadlineAt = Math.min(owner.deadlineAt, Date.now() + (env.timeLimits?.preparationMs ?? LINES_TIME_LIMITS.preparationMs));
            owner.deadlineTimer = setTimeout(() => owner.controller.abort(Object.assign(new Error('lines-total-timeout'), { name: 'TimeoutError', code: 'operation-timeout' })), Math.max(0, owner.deadlineAt - Date.now()));
            owner.controller.signal.addEventListener('abort', () => clearTimeout(owner.deadlineTimer), { once: true });
            owner.contextSnapshot = env.contextSnapshot?.() || null;
            runtime.start(owner.controller, '正在读取记忆…');
            if (env.isPanelActive?.()) refreshPanel?.();
            return owner;
        },
            preflightCurrent: owner => owners.isCurrent(owner),
        finishPreflight: (owner, failure = null) => {
            clearTimeout(owner.deadlineTimer);
            owners.finish(owner);
            if (runtime.finish(owner.controller) && env.isPanelActive?.()) {
                if (failure) renderBody(env.preflightError?.(failure) || env.empty?.());
                else refreshPanel?.();
            }
        },
        invalidatePreflight: (reason = 'manual-abort') => owners.invalidate('lines-preflight', reason),
        onBusy: () => env.actionsEnv?.toast?.('线仍在准备或生成中，请稍后再试'),
        runGenerate: (...args) => generation?.run?.(...args),
    }));
    const adultBlurEnabled = () => env.getSettings?.().adultBlurEnabled !== false;
    const sensitive = (html, adult) => adult && adultBlurEnabled() ? `<span class="sp-adult-sensitive" tabindex="0" role="button" aria-label="显示成人内容" title="显示成人内容"><span aria-hidden="true">${html}</span></span>` : html;
    const titleHtml = (className, line) => {
        const name = env.escapeHtml?.(line.name) || '';
        const glyph = vectorGlyphSvg(line.cue);
        const body = name;
        return glyph ? `<div class="${className} sp-line-title-with-glyph">${glyph}${body}</div>` : `<div class="${className}">${body}</div>`;
    };
    const cueLabelsHtml = line => {
        const chips = publicCueChips(line.cue);
        if (!chips.length) return '';
        return `<div class="sp-line-cues"><span class="sp-line-cue-list">${chips.map(chip => `<span class="sp-line-cue-chip sp-line-cue-tone-${chip.colorSlot}">${env.escapeHtml?.(chip.label) ?? String(chip.label)}</span>`).join('')}</span></div>`;
    };
    const widget = env.widget || (env.widgetEnv && {
        apply(body, editIdx = null, button = null, locator = null) {
            const key = env.widgetEnv.key?.();
            if (!key) return env.widgetEnv.fail?.('当前 chat 没有可写入的线缓存');
            const saved = env.widgetEnv.read?.(key);
            const result = commitLineWidget(saved?.raw || '', body, { editIndex: editIdx == null ? null : Number(editIdx) - 1, pin: true, locator });
            if (!result.ok) return env.widgetEnv.fail?.(editIdx != null
                ? result.reason === 'line-target-ambiguous' ? '存在多条无法区分的同名线，请先在「线」中整理后重新生成卡片' : '原线已不存在，请重新生成这张卡片'
                : '卡片格式不完整，无法应用');
            env.widgetEnv.write?.(key, manualLineStore(saved, result.raw).value);
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
        if (!lines.length) return `${env.jumpHint?.() || ''}<div class="sp-raw">${env.escapeHtml?.(stripInternalLineLines(raw)).replace(/\n/g, '<br>')}</div>`;
        const colors = env.stageColors || {};
        const cards = lines.map((l, i) => {
            const adult = l.adult === true;
            const color = colors[l.stage] || '#9aa6b2';
            const edgeColor = lineEdgeColor(l);
            const next = l.next ? `<div class="sp-line-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}"><span class="sp-line-next-tag">${l.stall ? '⏸' : '→'}</span><span class="sp-line-next-text">${env.escapeHtml?.(env.cleanText?.(l.next) || l.next)}</span></div>` : '';
            const inject = env.makeInjectBtn?.(buildLineInjectText(l)) || ''; const iid = inject.match(/data-iid="([^"]+)"/)?.[1] || '';
            const actions = renderActionMenu('line', [
                { action: 'line-edit', icon: 'fa-pen', label: '编辑', title: '编辑这条线' },
                { action: 'line-pin', icon: l.pin ? 'fa-lock-open' : 'fa-lock', label: l.pin ? '解锁' : '锁定', title: l.pin ? '解锁这条线' : '锁定这条线' },
                { action: 'line-inject', icon: 'fa-arrow-right-to-bracket', label: '注入', title: '注入到输入框' },
                { action: 'line-delete', icon: 'fa-trash', label: '删除', title: '删除这条线' },
            ], env.escapeHtml, env.escapeAttr).replace('data-menu-id="line"', `data-menu-id="line" data-line-idx="${i}" data-iid="${iid}"`);
            const desc = l.desc ? `<div class="sp-beat-scene">${env.escapeHtml?.(env.cleanText?.(l.desc) || l.desc)}</div>` : '';
            const nextText = l.next ? `<div class="sp-line-next-text">${env.escapeHtml?.(env.cleanText?.(l.next) || l.next)}</div>` : '';
            const nextHtml = l.next ? `<div class="sp-line-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}"><span class="sp-line-next-tag">${l.stall ? '⏸' : '→'}</span>${sensitive(nextText, adult)}</div>` : '';
            return `<div class="sp-beat sp-line-card${l.stall ? ' sp-line-stall' : ''}${l.pin ? ' sp-line-pinned' : ''}${l.adult ? ' sp-line-adult' : ''}" data-line-idx="${i}" style="border-left:3px solid ${edgeColor}"><div class="sp-beat-head"><span class="sp-seq-badge">#${i + 1}</span><span class="sp-beat-type" style="color:${color}">${env.escapeHtml?.(l.stage)}</span>${lineStageMeterHtml(l.stage, color)}${l.when ? `<span class="sp-line-when">${env.escapeHtml?.(l.when)}</span>` : ''}${l.stall ? '<span class="sp-line-stall-tag">停滞</span>' : ''}<span class="sp-beat-actions">${actions}</span></div>${sensitive(titleHtml('sp-beat-title', l), adult)}${cueLabelsHtml(l)}${sensitive(desc, adult)}${nextHtml}</div>`;
        }).join('');
        return `${env.jumpHint?.() || ''}${cards}`;
    };
    const inlineHtml = (raw = null, readOnly = false) => {
        if (env.getSettings?.().linesInlineEnabled === false) return '';
        const value = raw == null ? env.readRaw?.() || '' : raw;
        const view = inlineState(value, { readOnly });
        const dashedSub = !readOnly && view.dashed.enabled ? dashed?.inlineHtml?.() || '' : '';
        const body = view.lines.map((line, i) => {
            const adult = line.adult === true;
            const color = (env.stageColors || {})[line.stage] || '#9aa6b2';
            const edgeColor = lineEdgeColor(line);
            const actions = view.hasActions ? `<span class="sp-beat-actions">${env.makeInjectBtn?.(buildLineInjectText(line)) || ''}<button class="sp-line-del-one" data-line-idx="${i}" title="删除这条线"><i class="fa-solid fa-xmark"></i></button></span>` : '';
            const desc = line.desc ? `<div class="sp-inline-desc">${env.escapeHtml?.(env.cleanText?.(line.desc) || line.desc)}</div>` : '';
            const next = line.next ? `<div class="sp-line-next sp-inline-next ${line.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}"><span class="sp-line-next-tag">${line.stall ? '⏸' : '→'}</span>${sensitive(`<span class="sp-line-next-text">${env.escapeHtml?.(env.cleanText?.(line.next) || line.next)}</span>`, adult)}</div>` : '';
            return `<div class="sp-inline-line${line.stall ? ' sp-line-stall' : ''}${line.adult ? ' sp-line-adult' : ''}" data-line-idx="${i}" style="border-left:3px solid ${edgeColor}"><div class="sp-inline-head"><span class="sp-inline-stage" style="color:${color}">${env.escapeHtml?.(line.stage)}</span>${lineStageMeterHtml(line.stage, color)}${line.when ? `<span class="sp-inline-when">${env.escapeHtml?.(line.when)}</span>` : ''}${line.stall ? '<span class="sp-line-stall-tag sp-inline-stall">停滞</span>' : ''}${actions}</div>${sensitive(titleHtml('sp-inline-name', line), adult)}${cueLabelsHtml(line)}${sensitive(desc, adult)}${next}</div>`;
        }).join('');
        const controls = !readOnly && view.hasActions ? '<span class="sp-inline-summary-actions"><button class="sp-inline-refresh-lines" title="重新生成线"><i class="fa-solid fa-rotate-right"></i></button><button class="sp-inline-advance-lines" title="推进事件线"><i class="fa-solid fa-forward"></i></button></span>' : '';
        const summaryText = view.empty ? '暂无' : [view.activeCount ? `${view.activeCount} 条活跃` : '', view.settledCount ? `${view.settledCount} 条已结束` : ''].filter(Boolean).join(' · ');
        const summary = `<summary class="sp-inline-summary"><span class="sp-inline-title">线</span><span class="sp-inline-count${view.empty ? ' sp-inline-empty' : ''}">${summaryText}</span>${controls}</summary>`;
        return `${summary}${body || dashedSub ? `<div class="sp-inline-body" data-lines-inject-text="${env.escapeAttr?.(view.injectText) || ''}">${body}${dashedSub}</div>` : ''}`;
    };
    const appendInlineBlock = async (messageId, shouldAdvance, trigger = null) => {
        if (!shouldAdvance) env.refreshInlineWindow?.(true);
        const cfg = env.loadConfig?.();
        let result = { status: 'skipped', reason: shouldAdvance ? 'unavailable' : 'not-requested' };
        if (shouldAdvance && !runtime.busy && cfg?.url && cfg?.key) {
            const swipeId = Number(env.swipeId?.(messageId) ?? 0);
            result = await generation?.run?.(true, { mesId: Number(messageId), swipeId }, null, null, null, trigger) || result;
        } else if (shouldAdvance && runtime.busy) {
            result = { status: 'skipped', reason: 'busy' };
        } else if (shouldAdvance && (!cfg?.url || !cfg?.key)) {
            result = { status: 'skipped', reason: 'no-api' };
        }
        if (shouldAdvance && result?.status !== 'updated') return result;
        if (shouldAdvance) env.refreshInlineWindow?.(true);
        env.freezeSnapshot?.(messageId);
        return result;
    };
    const showAutoAdvanceFailure = (intent, message) => {
        lastGenerationFailure = { chatId: intent.chatId, chatRevision: intent.chatRevision, text: `上次自动推进未完成：${message}` };
        if (env.isPanelActive?.()) refreshPanel();
    };
    const drainAutoAdvances = async () => {
        while (pendingAutoAdvance) {
            const intent = pendingAutoAdvance;
            pendingAutoAdvance = null;
            if (intent.queueEpoch !== autoAdvanceQueueEpoch) continue;
            const stillCurrent = () => intent.queueEpoch === autoAdvanceQueueEpoch;
            if (!stillCurrent()) continue;
            if (Date.now() >= intent.deadlineAt) { showAutoAdvanceFailure(intent, '排队期间已超时，请手动重新生成'); continue; }
            if (runtime.busy || historyBusy || actions?.isPreparing?.()) {
                traceDiagnosticEvent('lines-auto-advance-skipped', { module: 'lines', channel: 'lines', status: 'skipped', reasonCode: 'manual-owner-busy' });
                continue;
            }
            const result = await appendInlineBlock(intent.messageId, true, intent);
            if (intent.queueEpoch !== autoAdvanceQueueEpoch) continue;
            if (!stillCurrent()) continue;
            if (result?.status === 'updated' && env.getSettings?.().notifyMode === 'full') env.toast?.('线已随剧情自动推进 · 请注意查看');
            else if (result?.status === 'failed') {
                if (lastGenerationFailure?.chatId === intent.chatId && lastGenerationFailure?.chatRevision === intent.chatRevision) {
                    if (env.isPanelActive?.()) refreshPanel();
                } else {
                    showAutoAdvanceFailure(intent, '生成或保存未完成，请查看失败提示并手动重试');
                }
            } else if (result?.status === 'cancelled' && result.reason === 'stale-baseline' && stillCurrent()) {
                showAutoAdvanceFailure(intent, '原有线已发生变化，本次结果未保存，请刷新后手动重试');
            } else if (result?.status === 'cancelled' && result.reason === 'committed-but-stale' && stillCurrent()) {
                showAutoAdvanceFailure(intent, '保存已确认，但当前视图归属已变化；请刷新核对最新线');
            }
            else if (result?.status === 'skipped') traceDiagnosticEvent('lines-auto-advance-skipped', { module: 'lines', channel: 'lines', status: 'skipped', reasonCode: result.reason === 'busy' ? 'manual-owner-busy' : 'trigger-unavailable' });
        }
    };
    const enqueueAutoAdvance = (messageId, credential) => {
        const contextSnapshot = credential?.contextSnapshot || env.contextSnapshot?.() || { chat: env.chat?.() || [] };
        const floor = contextSnapshot?.chat?.[Number(messageId)];
        const floorSignature = String(credential?.floorSignature || env.floorSignature?.(messageId) || '');
        const intent = {
            messageId: Number(messageId), swipeId: Number(env.swipeId?.(messageId) ?? 0),
            chatId: credential?.chatId ?? env.chatId?.(),
            chatRevision: credential?.chatRevision ?? owners.currentChatRevision(),
            boundaryEpoch: credential?.boundaryEpoch ?? env.boundaryEpoch?.(),
            floorSignature, contextSnapshot,
            participantIdentity: credential?.participantIdentity || env.participantIdentity?.() || null,
            deadlineAt: credential?.deadlineAt || (Date.now() + (env.timeLimits?.totalMs ?? LINES_TIME_LIMITS.totalMs)),
            preparationDeadlineAt: credential?.preparationDeadlineAt || Math.min(credential?.deadlineAt || Infinity, Date.now() + (env.timeLimits?.preparationMs ?? LINES_TIME_LIMITS.preparationMs)),
            queueEpoch: autoAdvanceQueueEpoch,
        };
        if (!floor || !floorSignature) return { status: 'skipped', reason: 'missing-floor-snapshot' };
        // A pending automatic turn is coalesced to the newest captured floor; its deadline starts at receipt.
        pendingAutoAdvance = intent;
        if (!autoAdvancePump) autoAdvancePump = drainAutoAdvances().catch(error => {
            const diagnostic = safeDiagnosticLog('lines', 'request', error, { background: true });
            console.warn('[SP lines failure]', diagnostic);
        }).finally(() => { autoAdvancePump = null; if (pendingAutoAdvance) enqueuePump(); });
        return { status: 'started' };
    };
    const enqueuePump = () => {
        if (!autoAdvancePump) autoAdvancePump = drainAutoAdvances().catch(error => {
            const diagnostic = safeDiagnosticLog('lines', 'request', error, { background: true });
            console.warn('[SP lines failure]', diagnostic);
        }).finally(() => { autoAdvancePump = null; if (pendingAutoAdvance) enqueuePump(); });
    };
    const syncInline = expectedChatId => {
        if (expectedChatId != null && env.chatId?.() !== expectedChatId) return;
        injection?.refresh?.();
        env.refreshInlineWindow?.(true);
    };
    const commitGenerationResult = async (raw, { silent, owner, swipeCtx, travelContext, commitBaseline } = {}) => {
        const chatId = env.chatId?.();
        const key = env.cacheKey?.();
        const baselineStore = snapshotLineStore(commitBaseline?.store ?? env.readSaved?.() ?? {});
        const next = generatedLineStore(baselineStore, raw, Date.now());
        if (!next.changed) return true;
        const writer = env.writeStoreConfirmed || env.writeStore;
        const saveDeadline = createDeadlineSignal({ signal: owner?.controller?.signal, deadlineAt: owner?.deadlineAt, timeoutMs: env.timeLimits?.saveMs ?? LINES_TIME_LIMITS.saveMs, reason: 'lines-save-timeout' });
        let stored; let saveFailed = false;
        try {
            stored = await writer?.(key, next.value, {
                signal: saveDeadline.signal,
                deadlineAt: saveDeadline.deadlineAt,
                safeSnapshotRefresh: true,
                reportPhase: owner?.reportPhase,
                ownerGuard: () => !saveDeadline.signal.aborted && (!owner || owners.isCurrent(owner)) && (canonicalMatches(baselineStore) || canonicalMatches(next.value)),
                onPersistenceError: () => {
                    saveFailed = true;
                    // The ordinary save may reject after generation returned; keep the visible local result and attach the hint only while it is still the live line.
                    if (!canonicalMatches(next.value)) return;
                    lastGenerationFailure = { chatId, chatRevision: owner.chatRevision, text: '上次生成后未确认云端保存；当前内容仍在本地，请手动刷新核对。' };
                    if (env.isPanelActive?.()) refreshPanel(true);
                },
            });
        } finally { saveDeadline.dispose(); }
        if (!(stored === true || stored?.ok === true)) return stored || false;
        if (stored?.stale) return { ...stored, ok: true };
        const ui = await runGenerationUiEffect(() => {
            runtime.cache(raw);
            if (swipeCtx?.mesId != null) {
                const rec = swipeStore.read(chatId, swipeCtx.mesId) || { baseline: swipeCtx.baselineRaw ?? commitBaseline?.raw ?? '', swipes: {}, view: 'user', charName: '' };
                if (rec.baseline == null) rec.baseline = swipeCtx.baselineRaw ?? commitBaseline?.raw ?? '';
                if (!rec.baselineMeta) rec.baselineMeta = { generatedAt: normalizeLineGeneratedAt(baselineStore.generatedAt) };
                rec.swipes[String(swipeCtx.swipeId ?? 0)] = raw;
                rec.swipeMeta = { ...(rec.swipeMeta || {}), [String(swipeCtx.swipeId ?? 0)]: { generatedAt: next.value.generatedAt } };
                swipeStore.write(chatId, swipeCtx.mesId, rec);
            }
            if (env.isPanelActive?.()) refreshPanel(true);
            syncInline();
        });
        if (!saveFailed && currentGenerationOwner(owner)) {
            if (ui.ok) clearGenerationFailure();
            else {
                lastGenerationFailure = { chatId, chatRevision: owner.chatRevision, text: UI_REFRESH_FAILURE_TEXT };
                try { if (env.isPanelActive?.()) refreshPanel(true); } catch {}
                try { env.toast?.(UI_REFRESH_FAILURE_TEXT, null, true); } catch {}
            }
        }
        if (ui.ok && !silent) {
            try { env.toast?.(env.isPanelActive?.() ? '线已生成' : '线已生成，点击查看'); } catch (error) { /* 成功 toast 不影响已保存的线 */ }
        }
        return stored?.commitState === 'local-applied'
            ? { ...stored, uiApplied: ui.ok, ...(ui.ok ? {} : { uiError: ui.error }) }
            : { ...(stored && typeof stored === 'object' ? stored : { ok: true }), uiApplied: ui.ok, ...(ui.ok ? {} : { uiError: ui.error }) };
    };
    const cleanupOwner = (owner, chatId, { preserveFailureUi = false } = {}) => {
        const timedOutOwner = owner?.controller?.signal?.reason?.code === 'operation-timeout'
            && owners.isOwner(owner, { chatId, chatRevision: owner.chatRevision });
        if (!owners.isCurrent(owner, { chatId }) && !timedOutOwner) return false;
        runtime.finish(owner.controller);
        owners.finish(owner);
        if (env.isPanelActive?.() && !preserveFailureUi) refreshPanel();
        return true;
    };
    const canonicalMatches = baseline => {
        const hasSaved = typeof env.readSaved === 'function';
        const saved = hasSaved ? (env.readSaved() || {}) : { raw: env.readRaw?.() || '' };
        if (!hasSaved && !String(saved.raw || '')) return true;
        const expected = baseline?.store ?? baseline;
        return !!expected && (hasSaved ? lineStoreMatches(saved, expected) : String(saved.raw || '') === String(expected.raw || ''));
    };
    const floorCredentialCurrent = credential => env.chatId?.() === credential?.chatId
        && (credential?.boundaryEpoch === undefined || env.boundaryEpoch?.() === credential.boundaryEpoch);
    const retirePreviousTerminalLines = async credential => {
        const baseline = credential?.linesBaseline;
        if (!baseline || !credential.cacheKey || !floorCredentialCurrent(credential) || !canonicalMatches(baseline)) return false;
        const previous = parseLines(baseline.raw);
        const retained = previous.filter(line => line.pin || !TERMINAL_LINE_STAGES.has(line.stage));
        if (retained.length === previous.length) return false;
        const raw = retained.length ? serializeLines(retained) : '';
        const target = retiredLineStore(baseline, raw, Date.now()).value;
        const writer = env.writeStoreConfirmed || env.writeStore;
        let stored;
        const saveDeadline = createDeadlineSignal({ deadlineAt: credential.deadlineAt, timeoutMs: env.timeLimits?.saveMs ?? LINES_TIME_LIMITS.saveMs, reason: 'lines-terminal-save-timeout' });
        try {
            stored = await writer?.(credential.cacheKey, target, {
                signal: saveDeadline.signal,
                deadlineAt: saveDeadline.deadlineAt,
                safeSnapshotRefresh: true,
                ownerGuard: () => !saveDeadline.signal.aborted && floorCredentialCurrent(credential) && (canonicalMatches(baseline) || canonicalMatches(target)),
            });
        } catch {
            return false;
        } finally { saveDeadline.dispose(); }
        if (!(stored === true || stored?.ok === true) || stored?.stale || !floorCredentialCurrent(credential)) return false;
        runtime.cache(raw);
        if (env.isPanelActive?.()) refreshPanel(true);
        syncInline(credential.chatId);
        return true;
    };
    const abortGeneration = ({ restore = true, reason = 'manual-abort' } = {}) => {
        autoAdvanceQueueEpoch++;
        pendingAutoAdvance = null;
        clearGenerationFailure();
        actions?.invalidatePreflight?.(reason);
        const owner = owners.invalidate('lines-generation', reason);
        runtime.abort(reason);
        if (restore && !env.isEditing?.() && owner?.baseline && owner.baseline.chatId === env.chatId?.() && canonicalMatches(owner.baseline)) env.restoreBaseline?.(owner.baseline);
    };
    const rerunSwipe = async ({ mesId, forceRegen = false } = {}) => {
        const swipe = env.swipeEnv || {};
        const cfg = swipe.loadConfig?.() || {};
        if (!cfg.url || !cfg.key) return;
        const chatId = swipe.chatId?.();
        const swipeId = Number(swipe.swipeId?.(mesId) ?? 0);
        if (env.isEditing?.()) return;
        const expectedSaved = env.readSaved?.() || env.generationEnv?.readSaved?.() || null;
        const expectedCanonical = expectedSaved ? snapshotLineStore(expectedSaved) : (env.readRaw?.() ? { raw: env.readRaw(), ts: null } : null);
        if (!forceRegen && applyStoredSwipe({ chatId, mesId, swipeId, key: swipe.key?.(), writeStore: swipe.writeStore, render: swipe.render, syncInline: swipe.syncInline, expectedCanonical })) return;
        const rec = swipeStore.read(chatId, mesId);
        let baseline = forceRegen ? (env.readSaved?.() || env.generationEnv?.readSaved?.() || (env.readRaw?.() ? { raw: env.readRaw?.(), ts: null } : null)) : rec?.baseline;
        if (forceRegen && baseline && typeof baseline === 'object') baseline = snapshotLineStore(baseline);
        if (forceRegen && !baseline) baseline = null;
        if (baseline == null) return;
        if (runtime.busy) runtime.abort('superseded-owner');
        return generation?.run?.(true, { mesId: Number(mesId), swipeId, baselineRaw: typeof baseline === 'object' ? baseline.raw : baseline, forceReroll: true });
    };
    const onMessageReceived = ({ messageId, type } = {}) => {
        if (!env.pluginEnabled?.() || env.getSettings?.().linesEnabled === false) return false;
        const mid = Number(messageId);
        const chatId = env.chatId?.();
        const chat = env.chat?.() || [];
        const floor = chat[mid];
        if (!Number.isInteger(mid) || mid !== chat.length - 1 || !floor || floor.is_user || floor.is_system || !String(floor.mes || '').trim() || String(type || '') !== 'normal') return false;
        if (mid <= lifecycle.lastSeenMaxMesId) return false;
        if (lifecycle.consumePendingReroll() || lifecycle.pendingSwipeGen?.mesId === mid) {
            lifecycle.consumePendingSwipe(mid);
            return false;
        }
        const saved = freezeLineStore(env.readSaved?.() || { raw: env.readRaw?.() || '', ts: null });
        return lifecycle.registerFloor({
            chatId, messageId: mid, type: 'normal', cacheKey: env.cacheKey?.(), boundaryEpoch: env.boundaryEpoch?.(),
            linesBaseline: saved,
        });
    };
    const onCharacterRendered = async ({ messageId, type, autoSuppressed = false } = {}) => {
        if (!env.pluginEnabled?.() || env.getSettings?.().linesEnabled === false) return;
        const mid = Number(messageId);
        const signature = env.floorSignature?.(mid) || '';
        lifecycle.floorTextSig[mid] = signature;
        if (lifecycle.pendingReroll || lifecycle.pendingSwipeGen?.mesId === mid) {
            lifecycle.consumePendingReroll();
            lifecycle.consumePendingSwipe(mid);
            lifecycle.consumeFloor(mid, env.chatId?.());
            await appendInlineBlock(mid, false);
            return;
        }
        const credential = lifecycle.consumeFloor(mid, env.chatId?.());
        if (!credential) { await appendInlineBlock(mid, false); return; }
        const contextSnapshot = !autoSuppressed && env.getMode?.() === 'turns'
            ? (env.contextSnapshot?.() || { chat: env.chat?.() || [] })
            : null;
        const triggerCredential = contextSnapshot ? {
            ...credential,
            contextSnapshot,
            floorSignature: String(env.floorSignature?.(mid) || ''),
            deadlineAt: Date.now() + (env.timeLimits?.totalMs ?? LINES_TIME_LIMITS.totalMs),
            preparationDeadlineAt: Date.now() + (env.timeLimits?.preparationMs ?? LINES_TIME_LIMITS.preparationMs),
        } : credential;
        if (!autoSuppressed) await retirePreviousTerminalLines(triggerCredential);
        if (!floorCredentialCurrent(triggerCredential)) return;
        lifecycle.lastSeenMaxMesId = mid;
        let advance = false;
        const mode = env.getMode?.();
        if (!autoSuppressed && mode === 'days') lifecycle.holdConfirmedFloor(credential);
        else if (!autoSuppressed && mode === 'turns') advance = lifecycle.advanceCounter({ mode, interval: env.getInterval?.() }).shouldAdvance;
        if (advance) { enqueueAutoAdvance(mid, triggerCredential); return; }
        await appendInlineBlock(mid, false);
    };
    const onDateAftermath = async ({ chatId = env.chatId?.(), messageId, day } = {}) => {
        if (!env.pluginEnabled?.() || env.getSettings?.().linesEnabled === false || env.getMode?.() !== 'days') return false;
        const mid = Number(messageId ?? ((env.chat?.() || []).length - 1));
        const credential = lifecycle.consumeConfirmedFloor(mid, chatId);
        if (!credential || day == null) return false;
        const advance = lifecycle.detectInGameDayChange({ day, decide: env.dayAdvance });
        if (!advance) { await appendInlineBlock(mid, false); return false; }
        const contextSnapshot = env.contextSnapshot?.() || { chat: env.chat?.() || [] };
        const trigger = {
            chatId: credential.chatId,
            chatRevision: owners.currentChatRevision(),
            boundaryEpoch: env.boundaryEpoch?.(),
            participantIdentity: env.participantIdentity?.() || null,
            contextSnapshot,
            floorSignature: String(env.floorSignature?.(mid) || ''),
            deadlineAt: Date.now() + (env.timeLimits?.totalMs ?? LINES_TIME_LIMITS.totalMs),
            preparationDeadlineAt: Date.now() + (env.timeLimits?.preparationMs ?? LINES_TIME_LIMITS.preparationMs),
        };
        enqueueAutoAdvance(mid, trigger);
        return true;
    };
    const onSwiped = async ({ mesId, info } = {}) => {
        if (!env.pluginEnabled?.() || env.getSettings?.().linesEnabled === false) return;
        const mid = Number(mesId);
        const swipeId = Number(info?.nextSwipeId ?? env.swipeId?.(mid) ?? 0);
        const decision = chooseSwipeLayer({ pendingGeneration: !!info?.pendingGeneration, swipeId, stored: swipeStore.read(env.chatId?.(), mid), baseline: '' });
        if (decision.action === 'wait') { lifecycle.markPendingSwipe(mid); return; }
        lifecycle.floorTextSig[mid] = env.floorSignature?.(mid) || '';
        await appendInlineBlock(mid, false);
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
    const onGenerationEnded = ({ stopped = false } = {}) => { if (env.pluginEnabled?.()) { const epoch = env.boundaryEpoch?.(); lifecycle.endGeneration({ stopped }); setTimeout(() => { if (epoch === undefined || env.boundaryEpoch?.() === epoch) env.refreshInlineWindow?.(true); }, 60); } };
    let sheet = 'events';
    const formatGeneratedAt = value => {
        const timestamp = normalizeLineGeneratedAt(value);
        if (timestamp == null) return '生成时间未知';
        const date = new Date(timestamp);
        const pad = part => String(part).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };
    const historySummary = raw => {
        const names = parseLines(raw).map(line => String(line.name || '').trim()).filter(Boolean);
        const suffix = names.length ? ` · ${names.slice(0, 2).join('、')}${names.length > 2 ? '…' : ''}` : '';
        return `${names.length} 条线${suffix}`;
    };
    const historyChoices = baseline => {
        const history = normalizeLineHistory(baseline?.history, { excludeRaw: Object.prototype.hasOwnProperty.call(baseline || {}, 'raw') ? String(baseline.raw ?? '') : undefined });
        const entries = [
            { value: 'current', current: true, raw: String(baseline?.raw ?? ''), generatedAt: normalizeLineGeneratedAt(baseline?.generatedAt), order: 0 },
            ...history.map((version, index) => ({ value: `history:${index}`, current: false, historyIndex: index, ...version, order: index + 1 })),
        ];
        entries.sort((left, right) => {
            const leftKnown = left.generatedAt != null; const rightKnown = right.generatedAt != null;
            if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
            if (leftKnown && left.generatedAt !== right.generatedAt) return right.generatedAt - left.generatedAt;
            return left.order - right.order;
        });
        return entries.map(entry => ({ ...entry, label: `${formatGeneratedAt(entry.generatedAt)} · ${entry.current ? '当前' : '旧版'} · ${historySummary(entry.raw)}` }));
    };
    const historyRead = key => env.readSavedAt?.(key) ?? env.readSaved?.() ?? {};
    const historyBoundaryCurrent = (_chatId, _boundaryEpoch, baseline, key) => lineStoreMatches(historyRead(key), baseline);
    const resyncAfterHistoryFailure = (chatId, _boundaryEpoch, key) => {
        const actual = snapshotLineStore(historyRead(key));
        runtime.cache(String(actual.raw ?? ''));
        if (env.isPanelActive?.()) refreshPanel(true);
        syncInline(chatId);
        return actual;
    };
    const historySaveUncertain = result => {
        if (result?.commitState === 'unknown' || result?.saveResult?.commitState === 'unknown') return true;
        const state = env.storageStatus?.();
        return state?.mode === 'external' && (state.pendingCurrent === true || state.status === 'unavailable');
    };
    const historyCommitCurrent = (attempt, baseline) => {
        if (pendingHistoryRestore !== attempt) return false;
        const state = env.storageStatus?.();
        if (state?.mode === 'external' && (state.pendingCurrent === true || state.status === 'unavailable')) return true;
        const actual = historyRead(attempt.storeKey);
        return lineStoreMatches(actual, baseline) || lineStoreMatches(actual, attempt.value);
    };
    const reconcileHistoryStorage = () => {
        const chatId = env.chatId?.();
        const boundaryEpoch = env.boundaryEpoch?.();
        const actual = snapshotLineStore(historyRead(pendingHistoryRestore?.storeKey));
        const restored = !!pendingHistoryRestore && lineStoreMatches(actual, pendingHistoryRestore.value);
        if (restored) swipeStore.clearAll(chatId);
        pendingHistoryRestore = null;
        runtime.cache(String(actual.raw ?? ''));
        if (env.isPanelActive?.()) refreshPanel(true);
        syncInline(chatId);
        return restored;
    };
    const openHistory = async () => {
        const chatId = env.chatId?.();
        const boundaryEpoch = env.boundaryEpoch?.();
        const storeKey = env.cacheKey?.();
        const baseline = freezeLineStore(env.readSaved?.() || {});
        if (!chatId || historyBusy || runtime.busy || actions?.isPreparing?.() || actions?.isEditing?.()) return false;
        if (!normalizeLineHistory(baseline.history, { excludeRaw: baseline.raw }).length) {
            env.toast?.('暂无历史版本。线更新且内容变化后，会自动保留上一版。');
            return false;
        }
        historyBusy = true;
        if (env.isPanelActive?.()) refreshPanel(true);
        try {
            const choices = historyChoices(baseline);
            for (;;) {
                if (!historyBoundaryCurrent(chatId, boundaryEpoch, baseline, storeKey)) { env.toast?.('线已变化，请重新打开历史版本', true); return false; }
                const selectedValue = await env.dialog?.selectOneAsync?.({
                    title: '线的历史版本',
                    body: '按现实生成时间从新到旧排列。',
                    loadChoices: async () => choices.map(({ value, label }) => ({ value, label })),
                    confirmText: '预览', cancelText: '关闭', emptyText: '暂无可恢复的历史版本',
                });
                if (!selectedValue) return false;
                const selected = choices.find(choice => choice.value === selectedValue);
                if (!selected) return false;
                if (!historyBoundaryCurrent(chatId, boundaryEpoch, baseline, storeKey)) { env.toast?.('线已变化，请重新打开历史版本', true); return false; }
                const publicRaw = stripInternalLineLines(selected.raw);
                const decision = await env.dialog?.choose?.({
                    title: `${selected.current ? '当前版本' : '历史版本'} · ${formatGeneratedAt(selected.generatedAt)}`,
                    body: publicRaw || '此版本没有线',
                    note: historySummary(selected.raw),
                    scrollable: true,
                    choices: selected.current
                        ? [{ value: 'back', label: '返回列表' }, { value: 'close', label: '关闭', primary: true }]
                        : [{ value: 'back', label: '返回列表' }, { value: 'restore', label: '恢复此版', primary: true }],
                });
                if (decision === 'back') continue;
                if (decision !== 'restore' || selected.current) return false;
                abortGeneration({ restore: false, reason: 'history-restore' });
                if (!historyBoundaryCurrent(chatId, boundaryEpoch, baseline, storeKey)) { env.toast?.('线已变化，请重新打开历史版本', true); return false; }
                const restored = restoreLineHistoryVersion(baseline, selected.historyIndex, Date.now());
                if (!restored.ok) { env.toast?.('这个历史版本已不可用，请重新打开', true); return false; }
                const writer = env.writeStoreConfirmed || env.writeStore;
            const attempt = Object.freeze({ chatId, boundaryEpoch, storeKey, value: freezeLineStore(restored.value) });
                pendingHistoryRestore = attempt;
                let stored;
                try {
                    stored = await writer?.(storeKey, restored.value, { ownerGuard: () => historyCommitCurrent(attempt, baseline) });
                } catch (error) {
                    const uncertain = historySaveUncertain(error);
                    if (!uncertain && pendingHistoryRestore === attempt) pendingHistoryRestore = null;
                    const actual = uncertain ? null : resyncAfterHistoryFailure(chatId, boundaryEpoch, storeKey);
                    env.toast?.(uncertain ? '历史版本保存结果未确认，请到存储管理重试并核实当前线' : lineStoreMatches(actual, baseline) ? '历史版本保存失败，当前线没有改变' : '线已变化，历史版本未恢复', true);
                    return false;
                }
                const confirmed = stored === true || (stored?.ok === true && ['confirmed', 'local-applied'].includes(stored?.commitState));
                if (!confirmed || stored?.stale) {
                    const uncertain = historySaveUncertain(stored);
                    if (!uncertain && pendingHistoryRestore === attempt) pendingHistoryRestore = null;
                    const actual = uncertain ? null : resyncAfterHistoryFailure(chatId, boundaryEpoch, storeKey);
                    env.toast?.(uncertain ? '历史版本保存结果未确认，请到存储管理重试并核实当前线' : lineStoreMatches(actual, baseline) ? '历史版本保存失败，当前线没有改变' : '线已变化，历史版本未恢复', true);
                    return false;
                }
                if (pendingHistoryRestore === attempt) pendingHistoryRestore = null;
                swipeStore.clearAll(chatId);
                runtime.cache(restored.value.raw);
                if (env.isPanelActive?.()) refreshPanel(true);
                syncInline(chatId);
                env.toast?.('已恢复线的历史版本');
                return true;
            }
        } finally {
            historyBusy = false;
            if (env.isPanelActive?.() && !historySaveUncertain()) refreshPanel(true);
        }
    };
    const historyToolbarState = () => {
        const hasChat = !!env.chatId?.();
        const current = env.readSaved?.() || {};
        const historyCount = normalizeLineHistory(current.history, { excludeRaw: Object.prototype.hasOwnProperty.call(current, 'raw') ? String(current.raw ?? '') : undefined }).length;
        const busy = !!(historyBusy || runtime.busy || actions?.isPreparing?.() || actions?.isEditing?.());
        return {
            historyDisabled: !hasChat || busy,
            historyTitle: !hasChat ? '当前没有聊天' : busy ? '线正在处理中，暂不能查看历史' : historyCount ? `查看 ${historyCount} 个历史版本` : '暂无可恢复的历史版本',
        };
    };
    const renderBody = body => {
        const failure = lastGenerationFailure?.chatId === env.chatId?.() && lastGenerationFailure?.chatRevision === owners.currentChatRevision()
            ? lastGenerationFailure
            : null;
        const escapedFailure = failure ? (env.escapeHtml?.(failure.text) ?? escapePanelText(failure.text)) : '';
        const failureHint = failure ? `<div class="sp-cfg-hint sp-lines-generation-failure" role="status">${escapedFailure}</div>` : '';
        const panelBody = `${failureHint}${sheet === 'dashed' ? dashed?.panelHtml?.() || '' : String(body || '')}`;
        env.renderPanelDom?.({ toolbar: dashed?.toolbarHtml?.({ onEvents: sheet === 'events', lineBusy: runtime.busy ? ' sp-refresh-busy' : '', generationBusy: runtime.busy, ...historyToolbarState() }), body: panelBody });
    };
    const refreshPanel = (force = false) => {
        const raw = env.readRaw?.() || '';
        const body = runtime.busy && !force ? env.loading?.(runtime.label) : raw ? renderLines(raw) : env.empty?.();
        if (raw && !runtime.busy) runtime.cache(raw);
        renderBody(body);
        return body;
    };
    const applyStoredSwipe = ({ chatId, mesId, swipeId, key, writeStore, render, syncInline, expectedCanonical } = {}) => {
        if (env.isEditing?.()) return false;
        const rec = swipeStore.read(chatId, mesId);
        const hit = rec?.swipes?.[String(swipeId)];
        if (hit == null || !key || typeof writeStore !== 'function' || rec?.baseline == null) return false;
        const hasSaved = typeof env.readSaved === 'function' || typeof env.generationEnv?.readSaved === 'function';
        const saved = typeof env.readSaved === 'function' ? (env.readSaved() || {}) : (env.generationEnv?.readSaved?.() || {});
        const current = hasSaved ? snapshotLineStore(saved) : { raw: env.readRaw?.() || '', ts: null };
        if (expectedCanonical && (current.raw !== String(expectedCanonical.raw || '') || (expectedCanonical.ts != null && current.ts !== expectedCanonical.ts))) return false;
        if (hasSaved && ![rec.baseline, ...Object.values(rec.swipes || {})].includes(current.raw)) return false;
        if (!hasSaved && current.raw && ![rec.baseline, ...Object.values(rec.swipes || {})].includes(current.raw)) return false;
        const targetGeneratedAt = hit === rec.baseline
            ? normalizeLineGeneratedAt(rec.baselineMeta?.generatedAt)
            : normalizeLineGeneratedAt(rec.swipeMeta?.[String(swipeId)]?.generatedAt);
        const target = changeCurrentLineStore(current, hit, { now: Date.now(), generatedAt: targetGeneratedAt, archiveCurrent: current.raw !== hit }).value;
        writeStore(key, target);
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
        openHistory,
        isHistoryBusy: () => historyBusy,
        reconcileHistoryStorage,
        deleteLine: (...args) => actions?.delete?.(...args),
        togglePin: (...args) => actions?.pin?.(...args),
        get sheet() { return sheet; },
        setSheet: value => { if (value === 'events' || value === 'dashed') sheet = value; return sheet; },
        renderLines, inlineHtml, appendInlineBlock, syncInline, commitGenerationResult, cleanupOwner, abortGeneration,
        onMessageReceived, onCharacterRendered, onDateAftermath, onSwiped, onEdited, onSent, onGenerationStarted, onToken, onGenerationEnded,
        isStreaming: () => Date.now() < lifecycle.streamUntil,
        resetCounter: () => { lifecycle.counter = 0; },
        setLastDay: value => { lifecycle.lastDay = value; },
        onChatChanged: ({ lastSeen = -1 } = {}) => { pendingHistoryRestore = null; lifecycle.resetChat({ lastSeen, lastDay: env.dayAnchor?.() ?? null }); return env.onChatChanged?.({ lastSeen }); },
        renderBody,
        refreshPanel,
        awaitAutoAdvances: async () => { while (autoAdvancePump) await autoAdvancePump; },
    };
}
