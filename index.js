import { getContext, extension_settings } from '../../../extensions.js';
import * as worldInfoCore from '../../../world-info.js';
import { equalsIgnoreCaseAndAccents, getCharaFilename } from '../../../utils.js';
import * as scriptCore from '../../../../script.js';
import { eventSource, event_types, substituteParams, saveSettingsDebounced, saveSettings as stSaveSettings, system_message_types } from '../../../../script.js';
import {
    buildCreativeChatSystemPrompt,
    getCreativeChatPlaceholder,
} from './state.js';
import * as memory from './memory.js';
import { createTheaterRuntime } from './business/theater/runtime.js';
import { createCoordinateRuntime } from './business/coordinate/runtime.js';
import { enterCoordinateSidebar } from './business/coordinate/ui.js';
import { captureSnapshotElement } from './business/coordinate/capture.js';
import * as store from './store.js';
import { bindStoreViewFallback, keyDesc, readStore, writeStore, writeStoreConfirmed, removeStore } from './store.js';
import * as ledger from './business/ledger/repository.js';
import { createBestEffortMetadataSaver, createTargetMetadataSaver, dispatchTargetMetadataWithRefresh } from './runtime/target-metadata-save.js';
import * as theaterDeviceCache from './runtime/theater-device-cache.js';
import { createTheaterHostPorts } from './runtime/theater-host-ports.js';
import { selectVisibleChatHistory } from './business/lines/history.js';
import * as snapshot from './snapshot.js';
import { createDialogManager } from './modal.js';
import { createAutomationGate } from './automation-gate.js';
import { createDateCoordinator } from './date-coordinator.js';
import {
    TIME_TRAVEL_DIRECTION_OPTIONS,
    buildTravelDirectionPrompt,
    buildTravelStoryPrompt,
    collectTravelAnniversaries,
    createTimeTravelController,
    didStepComplete,
    formatTravelDate,
    parseTravelDirections,
    snapshotLastAssistant,
    removeTimeTravelBlocks,
    sameMonthDay,
} from './time-travel.js';
import { escapeHtml, escapeAttr, autoGrowTextarea, cleanText } from './utils/dom.js';
import { _cnToNumber, _CN_MONTH_ALIAS, extractDayFromTime } from './utils/cn-date.js';
import { weatherGlyph, maskKey } from './utils/format.js';
import { getSettings, parseExcludeParams, loadCfg, loadUtilityCfg, saveCfg, loadApiPresets, upsertApiPreset, deleteApiPreset, renameApiPreset, fabEnabled, pluginEnabled, injectEnabled, getLinesInterval, saveLinesInterval, getLinesMode, saveLinesMode } from './runtime/settings.js';
import { postChatCompletion, callCustomApi, callMemoryApi, callTheaterApi, bindApiClient, GEN_TEMPERATURE } from './api/client.js';
import { normalizeApiUrl } from './api/sse.js';
import { safeDiagnosticLog, diagnosticMessage, makeDiagnosticError, shouldNotifyGeneration, classifyGenerationError } from './api/diagnostics.js';
import { recordChatBoundary, shareRecentDiagnosticTrace, traceDiagnosticEvent } from './runtime/diagnostic-trace.js';
import { normalizeTagRules } from './utils/tag-names.js';
import { ADULT_MODES, ADULT_MODE_LABELS, adultModeForCharacter } from './business/lines/adult.js';
import { axisState } from './business/axis/state.js';
import {
    ALM_TYPES,
    almId,
    getAlmanacKey,
    almClampInt,
    normalizeAlmItem,
    loadAlmanac,
    saveAlmanacItems,
    saveAlmanacItemsConfirmed,
    almTypeMeta,
    almDateLabel,
    monthDayFromDayKey,
    almValidMonthDay,
    ALM_CHAT_SCAN_LIMIT,
    almDayOfYear,
    ALM_WEEKDAYS,
    weekdayAdjacentDate,
    validRealDate,
    almMonthDayFromDoy,
    almEndMonthDay,
    almItemCoversDoy,
    getCalDescInjectText,
    parseAlmanacWidget,
    parseEraWidget,
    almDedupKey,
    mergeAlmanac,
    loadCalDesc,
    getCalDescKey,
    saveCalDesc,
    DEFAULT_CAL,
    calYearLen,
    calMonthCount,
    calMonthDays,
    calMonthName,
    calHasEra,
    CALENDAR_LIMITS,
    CALENDAR_TEMPLATE_NAME_LENGTH,
    cloneCalDesc,
    validateCalendarDesc,
    loadCalendarTemplates,
    saveCalendarTemplates,
    calendarTemplateId,
    calendarTemplateBindings,
    sortCalendarTemplatesForCurrent,
} from './business/axis/data.js';
import {
    calendarSummary,
    calendarConflicts,
    formatCalendarDate,
    formatStoryClockHeadParts,
} from './business/axis/ui.js';
// 轴锚点/周几/距今/将至排序已抽出到 business/axis/anchor.js；index.js 内部跨域读取器经 bindAxisAnchor 注入。
import {
    bindAxisAnchor,
    almTodayAnchor, almDaysUntil, almDaysBetweenFull, almWeekdayRef, almWeekdayFor,
} from './business/axis/anchor.js';
// 历注入文本构造（纯函数，仅依赖 data.js/anchor.js）已抽出到 business/axis/inject.js。
import { getAlmanacInjectText } from './business/axis/inject.js';
import { createAxisPanel } from './business/axis/panel.js';
import { renderAxisToolbar } from './business/axis/toolbar.js';
import { renderAxisUpcoming } from './business/axis/upcoming.js';
import { renderAxisCalendar } from './business/axis/calendar.js';
import { openAxisEditor, closeAxisEditor, setAxisSheet, navigateAxisMonth, createAxisEditorController, renderAxisEditor, renderAxisWeekdayHint } from './business/axis/editor.js';
import { createCalendarManager, calendarCards, calendarBindingKey, calendarBoundTemplateId, setCalendarBinding, calendarBindingCandidates } from './business/axis/manager.js';
import { createAxisUi } from './business/axis/ui.js';
import { createAxisItemUi } from './business/axis/item-ui.js';
import { createAxisActions } from './business/axis/actions.js';
import { createAxisDateActions } from './business/axis/date-actions.js';
import { createAxisCalendarActions } from './business/axis/calendar-actions.js';
import { createAxisGenerationController, validateAlmanacResponse } from './business/axis/generation.js';
import { createAxisInlineRenderer } from './business/axis/inline.js';
import { createInlineFeature } from './business/inline/feature.js';
import { createAxisWidgetActions } from './business/axis/widget.js';
import { createAxisTransactionController } from './business/axis/transaction.js';
import { createAxisPromptBuilder } from './business/axis/prompts.js';
import { createAxisDateContext } from './business/axis/date-context.js';
import { resolveAlmanacContextText, sanitizeGenerationContextText } from './runtime/generation-context.js';
import { bindStoryClock, parseStoryClock as parseStoryClockPure, parseJudgedDate as parseJudgedDatePure, latestStoryClock as latestStoryClockPure, storyClockDate as storyClockDatePure, storyWeekdayRef as storyWeekdayRefPure, completeStoryClock as completeStoryClockPure, storyClockNarrativeBody, buildStoryClockPrompt, STORY_CLOCK_KEY, createStoryClockController } from './business/axis/story-clock.js';
import { createWeekdayConsumerContext } from './business/axis/weekday-coordinator.js';
import { buildDateJudgePrompt as buildDateJudgePromptPure } from './business/axis/date-detection.js';
import { createDateDetectionController } from './business/axis/date-detection.js';

// Must be initialized before the top-level bindAxisAnchor() wiring below.
// Keeping this as a const preserves the shared terminal-stage semantics while
// avoiding a temporal-dead-zone read during module evaluation.
const TERMINAL_STAGES = TERMINAL_LINE_STAGES;

// ─── 点（日程）域：状态 / 解析 / 提示词 / 渲染 ────────────────────────────────
// point 业务域已从本文件抽出到 business/point/*，此处仅按需导入（机械迁移，不改行为）。
import { pointState } from './business/point/state.js';
import { parseCalendar, validateGeneratedCalendar, bindPointAdultTickets, parsePointEventRecord, firstPointEventBlock, replacePointEventBlock, buildPointInjectText, numberedPointList, mergePinnedPoints, forceStartDate } from './business/point/parse.js';
import { isGregorian as isGregorianCalendar } from './business/calendar/date.js';
import { buildPrompt } from './business/point/prompt.js';
import { bindPointRender, renderSchedule, scheduleDayCtx, scheduleDayLabel, TYPE_META } from './business/point/render.js';
import { togglePointPinRaw, deletePointEventRaw, editPointDescription, editPointFields } from './business/point/mutations.js';
import { bindPointRepository, getScheduleKey, loadCachedSchedule, refreshCachedSchedule } from './business/point/repository.js';
import { createPointActions } from './business/point/actions.js';
import { createPointWidgetActions } from './business/point/widget.js';
import { createPointController, pointScheduleNeedsDateSync } from './business/point/controller.js';
import { createPointInlineRenderer } from './business/point/inline.js';
import { pointTicketPlan } from './business/point/adult.js';
// ledger 检索前置选择器（纯逻辑三件套）已抽出到 business/ledger/select.js；到期/距今口径经 bindLedgerSelect 注入。
import { bindLedgerSelect, selectLedgerForInject } from './business/ledger/select.js';
import { bindLedgerDate, ledgerDaysSince, ledgerDueInfo, listJudgeableLedger, fmtLedgerForJudge } from './business/ledger/date.js';
import { bindLedgerSchema, splitCnList, normGist, parseLedgerCapture as parseLedgerCaptureSchema, parseLedgerJudge as parseLedgerJudgeSchema } from './business/ledger/schema.js';
import { createLedgerInjectionController } from './business/ledger/inject.js';
import { createLedgerJudgeController } from './business/ledger/judge.js';
import { createLedgerInlineRenderer } from './business/ledger/inline.js';
import { createLedgerSnapshotBridge } from './business/ledger/snapshot.js';
import { createLedgerActions } from './business/ledger/actions.js';
import { bindLedgerEvents, createLedgerDeletedHandler } from './business/ledger/events.js';
import { buildLedgerSources } from './business/ledger/reconcile.js';
import { ledgerOwnerIdentity, sameLedgerOwner } from './business/ledger/owner.js';
import { bindLedgerCapture, createLedgerCaptureController, ledgerNarrativeMessage, ledgerFloorDateContext, ledgerAiFloorRecords, LEDGER_EVENT_TYPES, LEDGER_FIELD_SPEC } from './business/ledger/capture.js';
import { filterRerollItems, shouldRunPendingPointFollowup } from './runtime/refactor-adapters.js';
import {
    createDatabaseMemoryAccess,
    databaseMemoryDiagnostic,
    databaseMemoryUiIdentity,
    normalizeDatabaseWorldbookName,
    renderDatabaseWorldbookOptions,
    sameDatabaseMemoryUiIdentity,
} from './business/memory/database.js';
import { createTaskOwnerManager } from './runtime/task-owner.js';
import { evaluateTaskLifecycle } from './runtime/task-orchestration.js';
import { parseLines as parseCanonicalLines, TERMINAL_LINE_STAGES } from './business/lines/schema.js';
import { buildLinesPrompt as buildCanonicalLinesPrompt } from './business/lines/prompt.js';
import { createAdvanceStrategy } from './business/lines/strategy.js';
import { createLinesFeature } from './business/lines/feature.js';
import { syncVectorGlyphTheme } from './business/lines/vectors/glyph.js';
import { createOutlineFeature } from './business/outline/feature.js';
import { createSpaceFeature } from './business/space/feature.js';
import { getSpaceChatPlaceholder } from './business/space/prompts.js';
import { createChatAnchorRepository } from './runtime/chat-date-anchor.js';
import {
    initializeWorldInfoSelection,
    mergeWorldInfoSelection,
    normalizeWorldInfoSelectionBucket,
    worldInfoSelectionAllows,
} from './runtime/world-info-selection.js';

// 坐标与楼内框各自持有唯一 runtime 句柄。
let coordinateRuntime = null;
let inlineFeature = null;

function refreshInlineWindow(immediate = false) { return inlineFeature?.refresh?.(immediate); }
function _clearAllInlineBoxes() { return inlineFeature?.clear?.(); }
function syncLatestAlmanacBlock(expectedChatId = null) {
    if (expectedChatId != null && getContext().chatId !== expectedChatId) return;
    return refreshInlineWindow(true);
}
function syncLatestScheduleBlock(expectedChatId = null) {
    if (expectedChatId != null && getContext().chatId !== expectedChatId) return;
    return refreshInlineWindow(true);
}
// ledger 暗账页渲染/编辑/批量（Option B）已抽出到 business/ledger/render.js；index.js 宿主经 bindLedgerRender 注入。
import {
    bindLedgerRender,
    batchReset, resetLedgerRenderState,
    getBatchScope, setBatchScope, getBatchSelected,
    toggleLedgerArchiveOpen, getLedgerEditor,
    ledgerTypeClass,
    openLedgerEditor, closeLedgerEditor, renderLedgerEditor,
    saveLedgerEditor,
    batchBarHtml, BATCH_SCOPES, batchScopeIds, execBatch, renderLedgerSheet, renderLedgerControls,
} from './business/ledger/render.js';
import { formatLedgerList } from './business/ledger/inline.js';

// Ledger 优先使用固定聊天目标的 integrity/commitState saver；不支持时回退 best-effort saver，均不支持才保持不可用。
const ledgerMetadataSaverReady = (() => {
    const advanced = createTargetMetadataSaver({ coreModule: scriptCore });
    return advanced?.supported ? advanced : createBestEffortMetadataSaver({ context: getContext });
})();
const getLedgerTarget = () => {
    try { return typeof scriptCore.resolveChatStateTarget === 'function' ? scriptCore.resolveChatStateTarget() : null; }
    catch { return null; }
};
ledger.bindLedgerMetadataPersistence({
    async commit(ctx, options = {}) {
        const saver = await ledgerMetadataSaverReady;
        if (!saver?.supported) return { ok: false, reason: saver?.reason || 'metadata-saver-unavailable', commitState: 'not-dispatched' };
        const current = ctx || getContext?.();
        const target = options.target || getLedgerTarget();
        if (typeof saver.commit === 'function') return saver.commit(current, { ...options, target, ownerGuard: options.compensate ? () => true : (options.ownerGuard || (() => true)) });
        const after = { ...(current?.chatMetadata || {}) };
        if (current?.chatMetadata?.['sp-ledger']) after['sp-ledger'] = current.chatMetadata['sp-ledger'];
        return dispatchTargetMetadataWithRefresh({ saver, target, afterMetadata: after, refresh: scriptCore.refreshChatWriteSnapshotsFromServer, isCurrent: options.compensate ? () => true : (options.ownerGuard || (() => true)) });
    },
});
store.bindStoreMetadataPersistence({
    async commit(ctx, options = {}) {
        const current = ctx || getContext?.();
        const ownerGuard = typeof options.ownerGuard === 'function' ? options.ownerGuard : () => true;
        const target = options.target || getLedgerTarget();
        if (!current?.chatId || !ownerGuard()) return { ok: false, reason: 'stale-before-save', commitState: 'not-dispatched', dispatched: false };
        if (ledgerMetadataSaverReady?.supported && ledgerMetadataSaverReady.mode !== 'legacy-unconfirmed') {
            const after = { ...(current.chatMetadata || {}) };
            if (current.chatMetadata?.['sp-store']) after['sp-store'] = current.chatMetadata['sp-store'];
            return dispatchTargetMetadataWithRefresh({
                saver: ledgerMetadataSaverReady,
                target,
                afterMetadata: after,
                refresh: scriptCore.refreshChatWriteSnapshotsFromServer,
                isCurrent: ownerGuard,
            });
        }
        if (typeof current.saveMetadata !== 'function') return { ok: false, reason: 'saveMetadata-unavailable', commitState: 'not-dispatched', dispatched: false };
        try {
            const result = current.saveMetadata();
            if (!result || typeof result.then !== 'function') return { ok: false, reason: 'saveMetadata-unconfirmed', commitState: 'legacy-unconfirmed', dispatched: true };
            await result;
            if (!ownerGuard()) return { ok: false, reason: 'stale-after-save', commitState: 'legacy-unconfirmed', dispatched: true };
            return { ok: true, reason: 'saveMetadata-promise-resolved', commitState: 'confirmed', dispatched: true };
        } catch (error) {
            const status = Number(error?.status ?? error?.statusCode ?? error?.httpStatus);
            return { ok: false, reason: Number.isInteger(status) ? `http-${status}` : 'saveMetadata-rejected', ...(Number.isInteger(status) ? { status } : {}), commitState: 'not-dispatched', dispatched: false, error };
        }
    },
});

const pointTaskOwners = createTaskOwnerManager();
let chatBoundaryEpoch = 0;
let pendingDateBootstrap = null;
let activeChatBoundaryIdentity = null;
function runtimeIdentityHash(value) {
    let hash = 2166136261;
    for (const ch of String(value ?? '')) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16);
}
function captureParticipantIdentity(ctx = getContext()) {
    const character = ctx?.characters?.[ctx?.characterId] || {};
    const personaDescriptor = ctx?.powerUserSettings?.persona_name ?? ctx?.powerUserSettings?.default_persona ?? ctx?.powerUserSettings?.persona_description ?? '';
    return Object.freeze({
        boundaryEpoch: chatBoundaryEpoch,
        chatId: String(ctx?.chatId ?? ''),
        characterId: String(ctx?.characterId ?? ''),
        characterKey: String(character?.avatar || charStableKey(ctx) || ''),
        personaKey: runtimeIdentityHash(personaDescriptor),
        userName: String(ctx?.name1 || '用户'),
        charName: String(ctx?.name2 || '角色'),
    });
}
function sameParticipantIdentity(left, right) {
    return !!left && !!right && ['boundaryEpoch', 'chatId', 'characterId', 'characterKey', 'personaKey', 'userName', 'charName'].every(key => String(left[key] ?? '') === String(right[key] ?? ''));
}
function captureGenerationContext(ctx = getContext()) {
    const chat = Array.isArray(ctx?.chat) ? ctx.chat.map(message => ({ ...message, extra: message?.extra && typeof message.extra === 'object' ? { ...message.extra } : message?.extra })) : [];
    return { ...ctx, chat, name1: ctx?.name1 || '用户', name2: ctx?.name2 || '角色' };
}
function captureChatBoundary() { return Object.freeze({ epoch: chatBoundaryEpoch, chatId: String(getContext()?.chatId ?? '') }); }
function isCurrentChatBoundary(boundary) { return !!boundary && boundary.epoch === chatBoundaryEpoch && boundary.chatId === String(getContext()?.chatId ?? ''); }
function scheduleForChatBoundary(callback, delay) {
    const boundary = captureChatBoundary();
    return setTimeout(() => { if (isCurrentChatBoundary(boundary)) callback(boundary); }, delay);
}
function latestFloorBoundaryIdentity() {
    const ctx = getContext(); const messageId = (ctx?.chat?.length ?? 0) - 1;
    if (messageId < 0) return null;
    return Object.freeze({ ...captureChatBoundary(), messageId, swipeId: Number(ctx.chat?.[messageId]?.swipe_id ?? 0), contentSignature: _floorSig(messageId) || 'empty' });
}
function consumeDateBootstrap(messageId) {
    const pending = pendingDateBootstrap;
    if (!pending) return false;
    const current = buildDateRenderKey(messageId);
    const matches = isCurrentChatBoundary(pending) && pending.messageId === current.messageId && pending.swipeId === current.swipeId && pending.contentSignature === current.contentSignature;
    if (matches) pendingDateBootstrap = null;
    return matches;
}
let theaterFeature;
let memoryPauseNoticeShown = false;
function createTheaterHostFeature() {
    const runtime = createTheaterRuntime({
        storage: globalThis.localStorage, coreModule: scriptCore, getContext, callTheaterApi,
        buildWorldInfoContext: ctx => buildWorldInfoContext(ctx), readCardExtras: ctx => readCardExtras(ctx), getMemText: () => getMemText(),
        names: () => ({ userName: getContext().name1 || '用户', charName: getContext().name2 || '角色' }),
        settings: () => { const s = getSettings(); return { theaterStylePrompt: typeof s.theaterStylePrompt === 'string' ? s.theaterStylePrompt : '', theaterBeautifyPrompt: typeof s.theaterBeautifyPrompt === 'string' ? s.theaterBeautifyPrompt : '' }; },
        onDiagnostic: diagnostic => { console.warn('[SP theater]', diagnostic); if (getSettings().notifyMode === 'full') showToast('小剧场美化失败，已保留原稿', null, true); },
        stage: text => { if (theaterMode) setTheaterBody(loadingHtml(`正在${text}`, 'sp-abort-theater')); }, renderAiMessageHtml,
        ports: createTheaterHostPorts({ $, $in, inEl, documentRef: globalThis.document, getContext, captureTarget: chatId => runtime?.captureTarget?.(chatId), theaterMode: () => theaterMode, modalId: () => MODAL_ID, setBody: html => setTheaterBody(html), loading: loadingHtml, escapeHtml, escapeAttr, settings: getSettings, saveSettingsDebounced, showToast, showPanel, spConfirm, scriptCore }),
    });
    return runtime.feature;
}

// Shadow-DOM accessors are dependencies of the top-level DI wiring below.
// Declare them before any bind/create call can evaluate the dependency.
let _spShadow = null;
let _spDialogShadow = null;
let _activeSpConfirmCancel = null;
let _activeStoreConflictFinish = null;
const $in  = (sel) => { const el = _spShadow?.querySelector(sel); return el ? $(el) : $(); };
const inEl = (sel) => _spShadow?.querySelector(sel) ?? null;
const $inAll = (sel) => $(Array.from(_spShadow?.querySelectorAll(sel) ?? []));
const $dialog = (sel) => {
    const el = _spDialogShadow?.querySelector(sel);
    return el ? $(el) : $();
};
const removeDialogOverlays = () => {
    $dialog('#sp-confirm, #sp-store-conflict, #sp-addon-dialog').remove();
};

// store 视图态回退桥：keyDesc 缺省 view/charName 时回退到当前视图/角色（闭包捕获实时值）。
bindStoreViewFallback(() => currentView, () => charViewName);

const chatAnchorRepository = createChatAnchorRepository({
    chatId: () => getContext()?.chatId,
    read: () => readStore(keyDesc('date-anchor', 'user', '')),
    write: value => writeStore(keyDesc('date-anchor', 'user', ''), value),
    writeConfirmed: (value, options) => writeStoreConfirmed(keyDesc('date-anchor', 'user', ''), value, options),
    legacy: () => {
        const key = charStableKey(getContext());
        const value = key ? getSettings().dateAnchor?.[key] : null;
        return value ? { ...value, identity: `${key}:${value.month}/${value.day}` } : null;
    },
});
function latestStoryOwnerIdentity() {
    const context = getContext(); const clock = latestStoryClockPure(context, ALM_CHAT_SCAN_LIMIT); const floor = Number.isInteger(clock?.floor) ? clock.floor : null; const message = floor == null ? null : context?.chat?.[floor];
    return { chatId: context?.chatId || null, floor, swipe: message?.swipe_id ?? message?.mes_id ?? null };
}
const axisDateActions = createAxisDateActions({
    repository: chatAnchorRepository,
    charKey: () => charStableKey(getContext()),
    calendar: loadCalDesc,
    today: almTodayAnchor,
    dayOfYear: almDayOfYear,
    monthDayFromDoy: almMonthDayFromDoy,
    monthCount: calMonthCount,
    monthDays: calMonthDays,
    pending: () => chatAnchorRepository.pending(),
    weekday: (month, day, ref, cal) => almWeekdayFor(month, day, ref, cal),
    floor: () => latestStoryOwnerIdentity().floor,
    chatId: () => latestStoryOwnerIdentity().chatId,
    swipe: () => latestStoryOwnerIdentity().swipe,
    confirm: spConfirm,
    aftermath: () => runAnchorAftermath(),
    monthName: (cal, month) => calMonthName(cal, month),
    toast: showToast,
});

// 绑定 API 网络层所需的 UI/业务回调（避免 api/client.js 反向依赖 index.js 造成循环引用）。
bindApiClient({
    setFabBusy,
    setLastDebugPayload: (v) => { lastDebugPayload = v; },
    buildMessages,
    getDiagnosticContext: () => {
        const ctx = getContext?.() || {};
        const messageId = Array.isArray(ctx.chat) ? ctx.chat.length - 1 : null;
        return {
            chatId: ctx.chatId ?? null,
            chatRevision: pointTaskOwners.currentChatRevision(),
            boundaryEpoch: chatBoundaryEpoch,
            floor: messageId,
            messageId,
        };
    },
});

// 点渲染回调注入：render.js 的点日期上下文、标签与辅助渲染函数需访问本文件的
// almTodayAnchor/almWeekdayRef/almWeekdayFor/makeInjectBtn，经 bindPointRender 注入以避免反向依赖（循环引用）。
bindPointRender({ almTodayAnchor, almWeekdayRef, almWeekdayFor, makeInjectBtn, settings: getSettings });
bindPointRepository({ keyDesc, readStore, renderSchedule, loadCalendar: loadCalDesc });
const pointActions = createPointActions({
    inShadow: $inAll,
    $,
    getCacheKey: (...args) => getCacheKey(...args),
    readStore,
    writeStore,
    renderSchedule,
    loadCalendar: loadCalDesc,
    parseCalendar,
    togglePointPinRaw,
    deletePointEventRaw,
    editPointDescription,
    editPointFields: (raw, day, index, values) => editPointFields(raw, day, index, values),
    promptFields: options => customDialog.promptFields(options),
    setEditing: value => { manualEditing.point = value; },
    isBusy: () => pointState.isGenerating || axisState._almSyncingPoint,
    setCached: html => { pointState.cachedSchedule = html; },
    setBody,
    currentView: () => currentView,
    currentChar: () => charViewName,
    syncLatestScheduleBlock,
    showToast,
    confirm: spConfirm,
    chatId: () => getContext().chatId,
    captureParticipantIdentity,
    sameParticipantIdentity,
});
const applyPointWidget = createPointWidgetActions({
    firstPointEventBlock,
    parsePointEventRecord,
    getCacheKey: (...args) => getCacheKey(...args),
    readStore,
    writeStore,
    replaceNthEventLine,
    getUserName: () => getContext().name1 || '用户',
    currentView: () => currentView,
    renderSchedule,
    loadCalendar: loadCalDesc,
    setCached: html => { pointState.cachedSchedule = html; },
    shouldShowPanel: () => !outlineMode && !linesMode && !spaceMode && $(`#${MODAL_ID}`).is(':visible'),
    setBody,
    syncLatestScheduleBlock,
    showToast,
});
const pointController = createPointController({
    owners: pointTaskOwners,
    state: pointState,
    evaluate: evaluateTaskLifecycle,
    chatId: () => getContext().chatId,
    enabled: pluginEnabled,
    setButton: setExtBtnState,
    showEmpty: showEmptyGenerate,
    syncing: () => axisState._almSyncingPoint,
    toast: showToast,
    view: () => currentView,
    char: () => charViewName,
    precheck: memoryPreCheckConfirm,
    panelVisible: () => $(`#${MODAL_ID}`).is(':visible'),
    showPanel,
    setBody,
    loading: loadingHtml,
    abortAuto: () => { _autoRegenSchedAbort?.abort('superseded-owner'); },
    context: getContext,
    captureContext: captureGenerationContext,
    captureParticipantIdentity,
    sameParticipantIdentity,
    key: (...args) => getCacheKey(...args),
    read: readStore,
    write: writeStore,
    writeConfirmed: writeStoreConfirmed,
    parse: parseCalendar,
    calendar: loadCalDesc,
    generate,
    validate: validateGeneratedCalendar,
    mergePinned: mergePinnedPoints,
    today: almTodayAnchor,
    forceStart: forceStartDate,
    render: renderSchedule,
    sync: syncLatestScheduleBlock,
    setChar: value => { charViewName = value; },
    setCached: html => { pointState.cachedSchedule = html; },
    notify: () => getSettings().notifyMode,
    canCommit: (owner, travel) => evaluateTaskLifecycle({ manager: pointTaskOwners, owner, chatId: getContext().chatId, chatRevision: pointTaskOwners.currentChatRevision(), signal: travel?.signal, pluginEnabled: pluginEnabled() }).canCommit,
    editing: () => manualEditing.point,
    adultMode: identity => getAdultMode(identity?.characterKey || charStableKey(getContext())),
    bindAdult: bindPointAdultTickets,
    logDiagnostic: diagnostic => console.warn('[SP point failure]', diagnostic),
    canCallback: owner => evaluateTaskLifecycle({ manager: pointTaskOwners, owner, chatId: getContext().chatId, chatRevision: pointTaskOwners.currentChatRevision(), pluginEnabled: pluginEnabled(), phase: 'callback' }).canCallback,
    setView,
    showEmpty: showEmptyGenerate,
    escape: text => escapeHtml(text),
    config: loadCfg,
    setAuto: controller => { _autoRegenSchedAbort = controller; return controller; },
    setSyncing: value => { axisState._almSyncingPoint = value; },
    clearBusy: () => { if (axisState.almanacMode) renderAlmanacPanel(); $in('#sp-body .sp-refresh-schedule').removeClass('sp-refresh-busy'); },
    cached: () => pointState.cachedSchedule,
    monthName: month => calMonthName(loadCalDesc(), month),
    followupState: (owner, travel, allow, pending) => evaluateTaskLifecycle({ manager: pointTaskOwners, owner, chatId: getContext().chatId, chatRevision: owner.chatRevision, signal: travel?.signal, pluginEnabled: pluginEnabled(), allowPendingFollowup: allow, pending }),
    shouldFollowup: (life, travel, allow, owner) => shouldRunPendingPointFollowup({ pending: life.canFollowup, allowPendingFollowup: allow, signalAborted: travel?.signal?.aborted, chatSame: getContext().chatId === owner.chatId && pointTaskOwners.currentChatRevision() === owner.chatRevision, pointGenerating: pointState.isGenerating, needsSync: schedulePointNeedsSync(travel?.targetScope || { view: owner.view, charName: owner.charName }, travel?.targetDate) }) && life.canFollowup,
});
const pointInlineRenderer = createPointInlineRenderer({
    settings: getSettings,
    readRaw: () => readCacheRaw(getCacheKey('user', '')),
    loadCalendar: loadCalDesc,
    parseCalendar,
    scheduleDayCtx,
    scheduleDayLabel,
    weatherGlyph,
    escapeHtml,
    escapeAttr,
    weekdays: ALM_WEEKDAYS,
    typeMeta: TYPE_META,
    makeInjectBtn,
    buildPointInjectText,
    cleanText,
});
const parseJudgedDate = parseJudgedDatePure;

// ledger 选择器注入：select.js 的打分/门槛依赖到期/距今口径 ledgerDueInfo/ledgerDaysSince
// （二者仍滞留本文件、且另经历法助手触达），经 bindLedgerSelect 注入以免反向依赖循环引用。
bindLedgerSelect({ ledgerDaysSince, ledgerDueInfo });
const axisDateContext = createAxisDateContext({ today: almTodayAnchor, daysUntil: almDaysUntil, daysUntilFull: almDaysBetweenFull, weekdayRef: almWeekdayRef, weekdayFor: almWeekdayFor });
bindLedgerDate({ today: () => axisDateContext.today(), daysUntil: axisDateContext.daysUntil, daysUntilFull: axisDateContext.daysUntilFull, listEntries: () => ledger.listEntries() });
bindLedgerSchema({ parseJudgedDate, ledgerTypes: ledger.TYPES });
bindLedgerCapture({
    context: getContext,
    parseClock: parseStoryClockPure,
    parseDate: parseJudgedDate,
    stripTags: (text) => memory.stripTags(text, { keepTags: getSettings().keepTags, extraTags: getSettings().extraTags }),
    settings: getSettings,
    systemTypes: system_message_types,
    eventTypes: LEDGER_EVENT_TYPES,
    fieldSpec: LEDGER_FIELD_SPEC,
});
const ledgerCaptureController = createLedgerCaptureController({
    context: getContext,
    target: getLedgerTarget,
    charKey: charStableKey,
    config: loadCfg,
    provenanceConfig: loadUtilityCfg,
    calendar: loadCalDesc,
    validDate: almValidMonthDay,
    today: almTodayAnchor,
    appendTravel: appendTravelPromptContext,
    callApi: callCustomApi,
    parseCapture: parseLedgerCaptureSchema,
    listEntries: options => ledger.listEntries(options),
    normGist,
    addAtomic: ledger.addEntriesAtomic,
    applyAtomic: (plan, owner) => ledger.applyCapturePlanAtomic(plan, owner),
    bridge: bridgeAbortSignal,
    confirm: spConfirm,
    toast: showToast,
    settings: getSettings,
    refresh: () => ledgerInjectionController.refresh(),
    refreshInline: refreshInlineWindow,
    render: () => { if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel(); },
    setProgress: () => { if (axisState.almanacMode) renderAlmanacPanel(); },
});
const reconcileLedgerSources = async (owner = null) => {
    const logSourceError = (error, counts = {}) => { try { const save = error?.saveResult; console.error('[SP ledger source reconcile]', { phase: error?.phase || 'source-state-invalid', cause: error?.code || error?.phase || 'unknown', reason: save?.reason || null, commitState: save?.commitState || null, saveReason: save?.saveReason || null, path: save?.path || null, httpStatus: save?.status || null, dispatched: save?.dispatched ?? null, counts: { cleaned: counts.cleaned || 0, remapped: counts.remapped || 0, pending: counts.pending || 0, lockedMissing: counts.lockedMissing || 0, kept: counts.kept || 0, deleted: counts.deleted || 0 } }); } catch {} };
    let records;
    try { records = ledgerAiFloorRecords(); } catch (error) { error.phase = 'source-scan-failed'; logSourceError(error); return { changed: false, summary: {}, phase: error.phase, error }; }
    let sources;
    try { sources = buildLedgerSources(records); } catch (error) { error.phase = 'source-state-invalid'; logSourceError(error); return { changed: false, summary: {}, phase: error.phase, error }; }
    try { return await ledger.reconcileEntriesAtomic(sources, getContext()?.chat?.length || 0, owner); }
    catch (error) { logSourceError(error, error.planSummary); return { changed: false, summary: error.planSummary || {}, phase: error.phase || 'source-save-failed', error }; }
};
const runLedgerCaptureStep = (manual = false, travelContext = null) => ledgerCaptureController.run(manual, travelContext);
const ledgerInjectionController = createLedgerInjectionController({
    context: getContext,
    enabled: injectEnabled,
    settings: getSettings,
    entries: () => ledger.listEntries(),
    select: selectLedgerForInject,
    today: almTodayAnchor,
    daysSince: ledgerDaysSince,
    dueInfo: ledgerDueInfo,
    narrative: ledgerNarrativeMessage,
    stripTags: text => memory.stripTags(text, { keepTags: getSettings().keepTags, extraTags: getSettings().extraTags }),
});
const refreshLedgerInjection = () => ledgerInjectionController.refresh();
const ledgerJudgeController = createLedgerJudgeController({
    context: getContext,
    target: getLedgerTarget,
    charKey: charStableKey,
    listJudgeable: options => listJudgeableLedger(options),
    fmtLedger: fmtLedgerForJudge,
    config: loadCfg,
    calendar: loadCalDesc,
    validDate: almValidMonthDay,
    today: almTodayAnchor,
    floorContext: ledgerFloorDateContext,
    appendTravel: appendTravelPromptContext,
    callApi: callCustomApi,
    parseJudge: parseLedgerJudgeSchema,
    getEntry: id => ledger.getEntry(id),
    identity: () => ledgerOwnerIdentity(getContext() || {}),
    applyAtomic: (patches, owner) => ledger.applyJudgePatchesAtomic(patches, owner),
    reconcile: reconcileLedgerSources,
    update: (id, patch) => ledger.updateEntry(id, patch),
    close: id => ledger.closeEntry(id),
    dayOfYear: almDayOfYear,
    monthDayFromDoy: almMonthDayFromDoy,
    bridge: bridgeAbortSignal,
    setFabBusy,
    settings: getSettings,
    toast: showToast,
    refreshInject: refreshLedgerInjection,
    refreshInline: refreshInlineWindow,
    render: () => { if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel(); },
});
const runLedgerJudgeStep = (manual = false, travelContext = null) => ledgerJudgeController.run(manual, travelContext);
const ledgerInlineRenderer = createLedgerInlineRenderer({
    settings: getSettings,
    calendar: loadCalDesc,
    entries: () => ledger.listEntries(),
    echo: () => ledgerInjectionController.echo,
    capturing: () => ledgerCaptureController.isBusy,
    judging: () => ledgerJudgeController.isBusy,
    typeClass: ledgerTypeClass,
});
const _buildLedgerBlockHtml = (poolArg = null, readOnly = false, calendarOverride = undefined) => ledgerInlineRenderer.buildPool(poolArg, readOnly, calendarOverride);
const _buildUserRecallBoxHtml = (snap, isLatest, calendarOverride = undefined) => ledgerInlineRenderer.buildRecall(snap, isLatest, calendarOverride);
const ledgerSnapshotBridge = createLedgerSnapshotBridge({
    context: getContext,
    readPoint: () => readCacheRaw(getCacheKey('user', '')),
    readLine: () => readStore(getLinesCacheKey())?.raw || '',
    loadAlmanac,
    today: almTodayAnchor,
    entries: () => ledger.listEntries(),
    calendar: loadCalDesc,
    cloneCalendar: cloneCalDesc,
    weekdayRef: () => almWeekdayRef(loadCalDesc()),
    echo: () => ledgerInjectionController.echo,
    write: (id, value) => snapshot.writeSnapshot(id, value),
});
const freezeSnapshotToFloor = mesId => ledgerSnapshotBridge.freeze(mesId);
const ledgerActions = createLedgerActions({
    get: id => ledger.getEntry(id), lock: id => ledger.lockEntry(id), unlock: id => ledger.unlockEntry(id),
    mute: id => ledger.muteEntry(id), unmute: id => ledger.unmuteEntry(id), close: id => ledger.closeEntry(id),
    reopen: id => ledger.reopenEntry(id), remove: id => ledger.removeEntry(id), confirm: spConfirm, toast: showToast,
    refreshInject: refreshLedgerInjection,
    refreshPanel: () => { if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel(); },
    refreshInline: refreshInlineWindow,
});

// 轴锚点注入：anchor.js 的 almTodayAnchor/almWeekdayRef 需读本文件内的跨域来源
// （日期锚点/角色键/线缓存键+解析/点缓存键/终态集），经 bindAxisAnchor 注入以避免反向依赖循环引用。
bindAxisAnchor({
    getDateAnchor,
    getStoryCalibration: () => getStoryCalibration(charStableKey(getContext())),
    charStableKey,
    getLinesCacheKey,
    parseLines,
    TERMINAL_STAGES,
    getCacheKey: () => getCacheKey('user', ''),
});

// ledger 暗账页渲染注入：render.js 的行/编辑/批量需本文件宿主的 shadow 查询/提示/确认/主楼同步/
// 面板重绘/标注间隔与忙碌态。isCapturingLedger/isJudgingLedger 经 controller getter 读取实时状态。
bindLedgerRender({
    $in,
    showToast,
    splitCnList,
    spConfirm,
    syncLatestAlmanacBlock,
    renderAlmanacPanel: (...args) => renderAlmanacPanel(...args),
    getLedgerCaptureInterval,
    getLedgerCaptureProgress: () => ledgerCaptureController.progress,
    isCapturingLedger: () => ledgerCaptureController.isBusy,
    isJudgingLedger: () => ledgerJudgeController.isBusy,
    renderLedgerControls,
});

const MODAL_ID   = 'sp-modal-root';
const DIALOG_HOST_ID = 'sp-dialog-host';
const FAB_ID     = 'sp-fab';
const POS_KEY    = 'sp-pos';
const SIZE_KEY    = 'sp-size';

// ─── Shadow DOM 窗口宿主（2026-08-14 隔离改造批次1）──────────────────────────────
// 主窗口 #sp-modal-root 迁入 shadow root：ST 全局样式/选择器/事件在边界处切断，
// 根治样式污染。jQuery 选择器不穿透 shadow——窗口内 id/类查询一律改走 $in()/inEl()。
// _spShadow 在 injectModal() 里赋值；applyTheme() 同步 shadow 内 wrapper 的主题类。
// 集合版：querySelector 只取首个，集合操作（removeClass/addClass/toggleClass/show/hide/each/map/length…）必须走它
const almToolbarHtml = () => renderAxisToolbar(actionMenuHtml);
const axisItemUi = createAxisItemUi({
    typeMeta: almTypeMeta, weekdays: ALM_WEEKDAYS, weekdayFor: almWeekdayFor,
    clampInt: almClampInt, yearLength: calYearLen, itemCoversDoy: almItemCoversDoy,
    dateLabel: almDateLabel, batchScope: getBatchScope, batchSelected: getBatchSelected,
    escapeHtml,
});
const renderAlmanacUpcoming = () => renderAxisUpcoming({ renderAlmanacEmpty: axisItemUi.emptyHtml, batchBarHtml, almRowHtml: axisItemUi.rowHtml });
const renderAlmanacCalendar = () => renderAxisCalendar({ almRowHtml: axisItemUi.rowHtml });
const axisCalendarManager = createCalendarManager({
    render: (...args) => renderAlmanacPanel(...args),
    load: loadCalDesc,
    clone: cloneCalDesc,
    createState: () => ({ editing: false, draft: cloneCalDesc(loadCalDesc()), error: '', templatesOpen: false, bindTemplateId: null, bindQuery: '' }),
    readDraft: () => readCalendarDraftForm(),
    limits: CALENDAR_LIMITS,
    confirm: (...args) => customDialog.confirm(...args),
    chatId: () => getContext().chatId,
    cards: currentCharacterCards,
    bindings: calendarTemplateBindings,
    currentAvatar: () => charStableKey(getContext()),
    boundId: calendarBoundTemplateId,
    bindingCandidates: calendarBindingCandidates,
    templates: loadCalendarTemplates,
    templateId: calendarTemplateId,
    saveTemplates: saveCalendarTemplates,
    sortTemplates: sortCalendarTemplatesForCurrent,
    batchScope: getBatchScope,
    batchSelected: getBatchSelected,
    batchBar: batchBarHtml,
    escapeHtml,
    escapeAttr,
    setBinding: setCalendarBinding,
    writeBindings: bindings => { getSettings().calendarTemplateBindings = bindings; },
    save: saveSettingsDebounced,
    applyTemplate: options => maybeApplyBoundCalendarTemplate(options),
    validate: validateCalendarDesc,
    commit: cal => axisTransactionController.commit(cal),
    applyCalendar: (template) => axisTransactionController.commit(template),
    writeBindings: bindings => { getSettings().calendarTemplateBindings = bindings; },
    onApplyError: error => { console.error('[SP calendar] 角色默认历法应用失败', safeDiagnosticLog('axis', 'save', error)); showToast('角色绑定已更新，但默认历法没有应用成功，请稍后重试', null, true); },
    limits: { ...CALENDAR_LIMITS, monthNameLength: CALENDAR_LIMITS.monthNameLength, eraNameLength: CALENDAR_LIMITS.eraNameLength },
    root: () => $in('#sp-almanac-wrap'),
    $,
    activeElement: () => _spShadow?.activeElement,
});
const axisEditorController = createAxisEditorController({
    read: () => ({ name: String($in('#sp-alm-f-name').val() || '').trim(), type: $in('#sp-alm-f-type').val(), month: $in('#sp-alm-f-month').val(), day: $in('#sp-alm-f-day').val(), days: $in('#sp-alm-f-days').val(), displayDate: $in('#sp-alm-f-disp').val(), note: $in('#sp-alm-f-note').val() }),
    load: loadAlmanac,
    id: almId,
    normalize: normalizeAlmItem,
    persist: items => saveAlmanacItems(items),
    render: () => closeAxisEditor(renderAlmanacPanel),
    afterSave: syncLatestAlmanacBlock,
});
function deferredRenderAlmanacPanel(...args) { return renderAlmanacPanel(...args); }
const axisActions = createAxisActions({
    load: loadAlmanac, save: saveAlmanacItems, confirm: spConfirm, toast: showToast,
    render: deferredRenderAlmanacPanel, sync: syncLatestAlmanacBlock, clear: () => $inAll('#sp-almanac-wrap .sp-alm-cell-linked').removeClass('sp-alm-cell-linked'),
    calendar: loadCalDesc, month: almCalMonth, clamp: almClampInt, yearLength: calYearLen, dayOfYear: almDayOfYear, monthDayFromDoy: almMonthDayFromDoy,
    chatId: () => getContext().chatId, captureParticipantIdentity, sameParticipantIdentity,
});
const axisCalendarActions = createAxisCalendarActions({
    selectedDay: () => axisState._almanacCalDay,
    setSelectedDay: value => { axisState._almanacCalDay = value; },
    render: () => renderAlmanacPanel(),
    clearItemClass: () => $inAll('#sp-almanac-wrap .sp-alm-item-linked').removeClass('sp-alm-item-linked'),
    clearCellClass: () => $inAll('#sp-almanac-wrap .sp-alm-cell-linked').removeClass('sp-alm-cell-linked'),
    itemLinked: id => $in(`#sp-almanac-wrap .sp-alm-item[data-id="${id}"]`).hasClass('sp-alm-item-linked'),
    setItemLinked: id => $in(`#sp-almanac-wrap .sp-alm-item[data-id="${id}"]`).addClass('sp-alm-item-linked'),
    item: id => loadAlmanac().find(item => item.id === id),
    highlight: item => axisActions.highlight(item),
    linkCell: day => $in(`#sp-almanac-wrap .sp-alm-cell[data-day="${day}"]`).addClass('sp-alm-cell-linked'),
    hasLinked: () => $inAll('#sp-almanac-wrap .sp-alm-item-linked').length > 0,
});
const axisPromptBuilder = createAxisPromptBuilder({ loadCalDesc, calMonthCount, calYearLen, isGregorianCalendar, getCalDescInjectText });
const buildAlmanacPrompt = axisPromptBuilder.buildAlmanacPrompt;
const buildAnniversarySupplementPrompt = axisPromptBuilder.buildAnniversarySupplementPrompt;
const axisGenerationController = createAxisGenerationController({
    context: () => captureGenerationContext(), config: loadCfg, callApi: callCustomApi,
    prompt: (user, char) => buildAlmanacPrompt(user, char),
    supplementPrompt: (user, char, existing) => buildAnniversarySupplementPrompt(user, char, existing),
    validate: validateAlmanacResponse, parse: parseAlmanacWidget, merge: mergeAlmanac,
    loadItems: loadAlmanac, saveItems: saveAlmanacItemsConfirmed, dedupKey: almDedupKey, dateLabel: almDateLabel,
    sync: syncLatestAlmanacBlock, render: () => { if (axisState.almanacMode) renderAlmanacPanel(); },
    notify: (message, generated) => { if (generated) { if (axisState.almanacMode) { if (getSettings().notifyMode !== 'off') showToast(message); } else showToast(message, () => { $in('.sp-view-btn[data-view="almanac"]').trigger('click'); showPanel(); }); } else if (getSettings().notifyMode !== 'off') showToast(message); },
    error: (error, supplement) => showToast(`${supplement ? '补录失败：' : '轴生成失败：'}${diagnosticMessage(error)}`, null, true),
    missingApi: () => { if (!settingsOpen) toggleSettings(); showToast('请先在设置中填写自定义 API', null, true); },
    missingChat: () => showToast('请先打开一个聊天', null, true),
    confirm: () => spConfirm({ title: '重新生成节日', body: '将按当前世界观重新铺一整年的既定日期。已锁定的条目和你手动添加的日期会保留，未锁定的 AI 条目会被替换。', confirmText: '生成', cancelText: '取消' }),
    captureParticipantIdentity,
    sameParticipantIdentity,
});
const axisTransactionController = createAxisTransactionController({
    chatId: () => getContext().chatId, items: loadAlmanac, conflicts: calendarConflicts, charKey: () => charStableKey(getContext()), anchor: key => getSettings().dateAnchor?.[key],
    monthCount: cal => calMonthCount(cal), monthDays: (cal, month) => calMonthDays(cal, month), choose: options => customDialog.choose(options), writeBatch: entries => store.writeBatch(entries), setAnchor: (key, month, day) => setDateAnchor(key, month, day),
    syncAlmanac: syncLatestAlmanacBlock, syncSchedule: syncLatestScheduleBlock, pluginEnabled, readCal: () => readStore(getCalDescKey()), readItems: () => readStore(getAlmanacKey())?.items,
    bindings: calendarTemplateBindings, bindingKey: calendarBindingKey, cards: currentCharacterCards, templates: loadCalendarTemplates, clone: cloneCalDesc, saveCal: saveCalDesc, saveSettings: saveSettingsDebounced,
    render: () => { if (axisState.almanacMode) renderAlmanacPanel(); }, notifyMode: () => getSettings().notifyMode, toast: showToast,
    captureParticipantIdentity, sameParticipantIdentity,
});
const renderCalendarManager = axisCalendarManager.renderCalendarManager;
const refreshCalendarManager = axisCalendarManager.refreshCalendarManager;

// 面板工厂在 axisUi 的后置初始化前创建；包装只在实际渲染时读取目标函数。
function deferredAlmTodayBarHtml(...args) { return almTodayBarHtml(...args); }
function deferredStoryClockBarHtml(...args) { return storyClockBarHtml(...args); }

// Axis sheet orchestration lives in business/axis; render details are injected
// from this host to keep DOM/runtime dependencies out of the business module.
const renderAlmanacPanel = createAxisPanel({
    $in,
    getLedgerEditor,
    refreshCalendarManager,
    renderCalendarManager,
    renderAlmanacEditor,
    renderLedgerEditor,
    renderLedgerSheet,
    renderLedgerControls,
    renderAlmanacCalendar,
    renderAlmanacUpcoming,
    almToolbarHtml,
    almTodayBarHtml: deferredAlmTodayBarHtml,
    storyClockBarHtml: deferredStoryClockBarHtml,
    almRenderWdHint,
    loadingHtml,
    _almGenLabel: () => axisState._almGenLabel,
});

// Time travel orchestration stays at the host boundary: the controller is
// transport/UI agnostic while each existing domain keeps its own generation
// and persistence logic. The gate/coordinator prevent duplicate automation
// when the rendered floor triggers the normal listeners in the same tick.
const automationGate = createAutomationGate();
const dateCoordinator = createDateCoordinator();
const AUTOMATION_MODULES = Object.freeze({ LINES: 'lines', OUTLINE: 'outline', POINT: 'point', LEDGER_CAPTURE: 'ledger-capture', LEDGER_JUDGE: 'ledger-judge' });
function bridgeAbortSignal(externalSignal, internalController) {
    if (!externalSignal) return () => {};
    const abort = () => internalController.abort(externalSignal.reason ?? 'external-abort');
    if (externalSignal.aborted) internalController.abort(externalSignal.reason ?? 'external-abort');
    else externalSignal.addEventListener('abort', abort, { once: true });
    return () => externalSignal.removeEventListener('abort', abort);
}

bindStoryClock({
    loadCalendar: loadCalDesc,
    validMonthDay: almValidMonthDay,
    validRealDate,
    defaultCalendar: DEFAULT_CAL,
    monthDayFromKey: monthDayFromDayKey,
    extractDay: extractDayFromTime,
    cnToNumber: _cnToNumber,
    monthAlias: _CN_MONTH_ALIAS,
    explicitWeekdayDate: (text, cal) => weekdayAdjacentDate(text, cal == null || cal === DEFAULT_CAL || cal.kind === 'gregorian' || cal.id === 'default-gregorian'),
    context: getContext,
    dayOfYear: almDayOfYear,
});
const storyClockController = createStoryClockController({
    context: getContext,
    pluginEnabled,
    enabled: () => getSettings().storyClockEnabled !== false,
    settings: getSettings,
});
const storyClockEnabled = () => getSettings().storyClockEnabled !== false;
const refreshStoryClockInjection = () => storyClockController.refresh();
const latestStoryClock = () => latestStoryClockPure(getContext(), ALM_CHAT_SCAN_LIMIT);
const storyClockDate = () => storyClockDatePure(getContext(), parseJudgedDatePure, ALM_CHAT_SCAN_LIMIT);
const dateDetectionController = createDateDetectionController({
    context: () => captureGenerationContext(),
    charKey: ctx => charStableKey(ctx),
    config: loadUtilityCfg,
    storyEnabled: storyClockEnabled,
    storyDate: storyClockDate,
    storyClock: () => latestStoryClockPure(getContext(), ALM_CHAT_SCAN_LIMIT),
    completeStoryClock: clock => completeStoryClockPure(clock),
    identity: latestStoryOwnerIdentity,
    getCalibration: () => getStoryCalibration(charStableKey(getContext())),
    prompt: () => buildDateJudgePromptPure(getCalDescInjectText()),
    callApi: callCustomApi,
    parse: parseJudgedDatePure,
    bridge: bridgeAbortSignal,
    getAnchor: getDateAnchor,
    setAnchor: setDateAnchor,
    setAnchorConfirmed: (_charKey, month, day, source, anchorOptions, persistenceOptions) => chatAnchorRepository.setConfirmed(month, day, source, anchorOptions, persistenceOptions),
    settings: getSettings,
    monthName: month => calMonthName(loadCalDesc(), month),
    toast: showToast,
    logDiagnostic: diagnostic => console.warn('[SP axis failure]', diagnostic),
    aftermath: () => runAnchorAftermath(),
    captureParticipantIdentity,
    sameParticipantIdentity,
});
const applyDetectedDate = (charKey, md, { notify = true } = {}) => dateDetectionController.apply(charKey, md, notify);
const relandStoryClockAnchor = options => dateDetectionController.reland(options);
const runJudgeDateStep = options => dateDetectionController.run(options);
const timeTravel = createTimeTravelController({
    getChatId: () => getContext().chatId,
    getChat: () => getContext().chat,
    getCalendar: () => loadCalDesc(),
    resolveDestinationDate: async ({ chatId, messageId, selectedTargetDate, signal }) => {
        const cal = loadCalDesc();
        const target = almValidMonthDay(selectedTargetDate, cal);
        if (!target) throw new Error('无法读取时光旅行选择的目标日期');
        if (chatId !== getContext().chatId || signal?.aborted) throw Object.assign(new Error('时光旅行会话已失效'), { name: 'AbortError' });
        const chat = getContext().chat || [];
        const floor = chat[Number(messageId)];
        const clock = parseStoryClockPure(floor?.mes || '');
        const clockDate = parseJudgedDate(clock.end) || parseJudgedDate(clock.start);
        const key = buildDateRenderKey(messageId);
        if (clockDate) {
            const applied = applyDetectedDate(charStableKey(getContext()), clockDate, { notify: false });
            if (applied.status === 'failed') throw new Error('日期锚点保存失败');
            dateCoordinator.recordResult(key, { ...applied, date: clockDate });
            return clockDate;
        }
        if (getSettings().almanacAutoDetect === false) {
            const applied = applyDetectedDate(charStableKey(getContext()), target, { notify: false });
            if (applied.status === 'failed') throw new Error('日期锚点保存失败');
            dateCoordinator.recordResult(key, { ...applied, date: target });
            return target;
        }
        const result = await dateCoordinator.ensureResolved(key, {
            signal,
            // 时旅是普通日期监听的下游消费者：同一版正文只要已有一次判定终态，
            // 无论有日期、未知或失败，都直接复用；只有完全没有记录时才补跑一次。
            // 这是调用方窄策略，不改变 coordinator 其他调用方默认的“只接受有日期结果”。
            acceptPrevious: previous => previous != null && typeof previous === 'object',
            resolve: ({ signal: coordinatorSignal }) => runJudgeDateStep({ messageId, signal: coordinatorSignal }),
        });
        if (signal?.aborted || result?.status === 'cancelled') throw Object.assign(new Error('日期确认已取消'), { name: 'AbortError' });
        const judged = almValidMonthDay(result?.date, cal);
        if (judged) return judged;
        const currentKey = buildDateRenderKey(messageId);
        const sameRender = currentKey.chatId === key.chatId
            && currentKey.messageId === key.messageId
            && currentKey.swipeId === key.swipeId
            && currentKey.contentSignature === key.contentSignature;
        if (!sameRender || chatId !== getContext().chatId || signal?.aborted) throw Object.assign(new Error('正文版本已变化'), { name: 'AbortError' });
        const applied = applyDetectedDate(charStableKey(getContext()), target, { notify: false });
        if (applied.status === 'failed') throw new Error('日期锚点保存失败');
        dateCoordinator.recordResult(key, { ...applied, date: target });
        showToast('未能从正文确认日期，已采用你选择的时旅目标日');
        return target;
    },
    onStateChange: ({ state }) => {
        axisState.timeTravelState = state;
        const calendarVisible = axisState.almanacMode
            && axisState._almanacSheet === 'calendar'
            && !axisState._almanacManager
            && !axisState._almanacEditor
            && !getLedgerEditor()
            && !axisState.isGeneratingAlmanac;
        if (calendarVisible) renderAlmanacPanel({ preserveBodyScroll: true });
    },
    onStepResult: ({ key, result, destinationDate }) => {
        if (!didStepComplete(result)) return;
        if (key === AUTOMATION_MODULES.LINES) { if (getLinesMode() !== 'manual') linesFeature.resetCounter(); }
        if (key === AUTOMATION_MODULES.OUTLINE) outlineFeature.resetJudgeCounter();
        if (key === AUTOMATION_MODULES.LEDGER_CAPTURE) ledgerCaptureCounter = 0;
        if (key === AUTOMATION_MODULES.LEDGER_JUDGE) ledgerJudgeCounter = 0;
        if (key === AUTOMATION_MODULES.LINES && getLinesMode() === 'days') {
            const target = destinationDate;
            if (target?.month != null && target?.day != null) linesFeature.setLastDay(`${+target.month}-${+target.day}`);
        }
    },
    onSequenceEnd: ({ sessionId }) => releaseTimeTravelClaim(sessionId),
    onError: error => {
        console.error('[SP 时光旅行] 同步流程失败', safeDiagnosticLog('time-travel', 'request', error));
        showToast('时光旅行同步未完整完成，请手动检查各模块', null, true);
    },
    steps: [
        // 线不再被时旅步骤直生；若时旅确实落地正常新 AI 楼，由 MESSAGE_RECEIVED→CMR 统一入口处理。
        { key: AUTOMATION_MODULES.LINES, canRun: () => false, run: async () => ({ status: 'skipped' }) },
        { key: AUTOMATION_MODULES.OUTLINE, canRun: () => outlineFeature.canRelocate(), run: ({ promptAddon, signal }) => outlineFeature.relocate(promptAddon, signal) },
        { key: AUTOMATION_MODULES.POINT, canRun: () => !!readStore(getCacheKey('user', ''))?.raw, run: ({ destinationDate, promptAddon, signal }) => syncPointToToday(false, { targetDate: destinationDate, targetScope: { view: 'user', charName: '' }, promptAddon, feedback: 'time-travel', signal, allowPendingFollowup: false }) },
        { key: AUTOMATION_MODULES.LEDGER_CAPTURE, canRun: () => getSettings().ledgerCaptureEnabled === true, run: ({ destinationDate, promptAddon, signal }) => runLedgerCaptureStep(true, { targetDate: destinationDate, promptAddon, feedback: 'time-travel', signal }) },
        { key: AUTOMATION_MODULES.LEDGER_JUDGE, canRun: () => getSettings().ledgerCaptureEnabled === true, run: ({ destinationDate, promptAddon, signal }) => runLedgerJudgeStep(true, { targetDate: destinationDate, promptAddon, feedback: 'time-travel', signal }) },
    ],
});

// 自动化闸·会话级 token 登记：CMR 预检抢占（isInitialFloor 才占）→ 流程收尾（完成/失败/取消）经 onSequenceEnd 释放。
const _timeTravelClaimTokens = new Map();   // sessionId → automationGate token
function isAutomationSuppressed(messageId, moduleName) {
    return automationGate.isSuppressed({ scopeId: getContext().chatId, messageId, module: moduleName });
}
function releaseTimeTravelClaim(sessionId) {
    const token = _timeTravelClaimTokens.get(sessionId);
    if (!token) return;
    _timeTravelClaimTokens.delete(sessionId);
    automationGate.release(token);
}
function clearAutomationClaims() {
    _timeTravelClaimTokens.clear();
    automationGate.clear();
}
// 日期协调的楼层级 key：chatId + messageId + swipe + 内容签名，与 almanacJudge 共用同一把 key，
// 保证「戳直读」与「API 兜底」对同一楼层只解析一次（并发渲染去重）。
function buildDateRenderKey(messageId) {
    const ctx = getContext();
    const mid = Number(messageId);
    return {
        chatId: String(ctx.chatId ?? ''),
        messageId: mid,
        swipeId: Number(ctx.chat?.[mid]?.swipe_id ?? 0),
        contentSignature: _floorSig(mid) || 'empty',
    };
}

let _timeTravelSelectionSeq = 0;
let _activeTimeTravelSelection = null;

function travelAnniversaryCoverage(item, targetDate, calendar) {
    const targetDoy = almDayOfYear(targetDate?.month, targetDate?.day, calendar);
    if (!Number.isFinite(targetDoy) || !almItemCoversDoy(item, targetDoy, calendar)) return null;
    const total = calYearLen(calendar);
    const startDoy = almDayOfYear(item.month, item.day, calendar);
    const days = almClampInt(item.days, 1, total, 1);
    const dayIndex = ((targetDoy - startDoy) % total + total) % total + 1;
    return {
        startDate: { month: item.month, day: item.day },
        endDate: almEndMonthDay(item, calendar),
        days,
        dayIndex,
    };
}

function collectTimeTravelContext(sourceDate, targetDate) {
    const calendar = loadCalDesc();
    const anniversaries = collectTravelAnniversaries(
        loadAlmanac(),
        targetDate,
        calendar,
        travelAnniversaryCoverage,
        type => almTypeMeta(type).label,
    );
    const weekday = axisDateContext.weekdayFor(targetDate.month, targetDate.day, axisDateContext.weekdayRef(calendar), calendar);
    const targetWeekday = Number.isInteger(weekday) ? (ALM_WEEKDAYS[weekday] || '') : '';
    const outlineSnapshot = outlineFeature.readSnapshot();
    const outline = outlineSnapshot.beats;
    const outlineCursor = outlineSnapshot.cursor;
    const lines = parseCanonicalLines(readStore(getLinesCacheKey())?.raw || '')
        .filter(line => !TERMINAL_LINE_STAGES.has(line.stage));
    const settings = getSettings();
    const injectionOn = injectEnabled();
    const injectionState = {
        linesInjected: injectionOn && settings.linesEnabled !== false && settings.linesInject === true && lines.length > 0,
        outlineInjected: injectionOn && settings.outlineInject === true && outline.length > 0 && outlineCursor >= 1,
        ledgerInjected: injectionOn && settings.ledgerInject === true && ledgerInjectionController.echo.length > 0,
    };
    return { sourceDate, targetDate, calendar, anniversaries, targetWeekday, outline, outlineCursor, lines, injectionState };
}

function isTimeTravelSelectionCurrent(run) {
    if (!run || _activeTimeTravelSelection !== run) return false;
    if (!pluginEnabled() || getContext().chatId !== run.chatId || timeTravel.getState()) return false;
    const validTarget = almValidMonthDay(run.targetDate, loadCalDesc());
    return !!validTarget && sameMonthDay(validTarget, run.targetDate);
}

function directionValue(result) {
    if (!result) return '';
    if (result.value === 'custom') return String(result.customValue || '').trim();
    return TIME_TRAVEL_DIRECTION_OPTIONS.find(option => option.value === result.value)?.prompt || '';
}

async function startTimeTravel(targetDate) {
    const sourceDate = almTodayAnchor();
    const validTarget = almValidMonthDay(targetDate, loadCalDesc());
    if (!validTarget || sameMonthDay(sourceDate, validTarget)) return false;
    const initialChatId = getContext().chatId;
    const existing = timeTravel.getState();
    if (existing?.phase === 'syncing') {
        showToast('时光旅行正在同步，完成或中断后才能开始新的时旅');
        return false;
    }
    if (existing?.phase === 'waiting') {
        const confirmed = await customDialog.confirm({
            title: '先中断旧的时光旅行？',
            body: '输入框里还有一段尚未发送的时旅指令。开始新的时旅会移除旧指令。',
            confirmText: '中断并继续',
            cancelText: '保留旧时旅',
        });
        const current = timeTravel.getState();
        if (!current || current.sessionId !== existing.sessionId || current.phase !== existing.phase || getContext().chatId !== initialChatId) {
            showToast('时旅状态已经变化，本次没有覆盖当前会话');
            return false;
        }
        if (!confirmed) return false;
        clearTimeTravelSession(existing, { removeWaitingBlock: true, reason: 'replaced' });
    }

    const run = {
        id: ++_timeTravelSelectionSeq,
        chatId: initialChatId,
        sourceDate: { month: sourceDate.month, day: sourceDate.day },
        targetDate: { month: validTarget.month, day: validTarget.day },
    };
    _activeTimeTravelSelection = run;
    let selectedValue = 'none';
    let customValue = '';
    let excluded = [];
    let exclusionPreference = null;
    try {
        while (isTimeTravelSelectionCurrent(run)) {
            const context = collectTimeTravelContext(run.sourceDate, run.targetDate);
            const selection = await customDialog.selectOne({
                title: `跳到 ${formatTravelDate(run.targetDate, context.calendar)}`,
                body: '选择这次时间变化后的剧情方向。直接采用不会调用 API；AI 推演会先给出三个候选方向。',
                choices: TIME_TRAVEL_DIRECTION_OPTIONS,
                initialValue: selectedValue,
                custom: { value: 'custom', initialValue: customValue, placeholder: '写下希望发生的剧情方向…', maxLength: 300, rows: 3 },
                actions: [
                    { value: 'direct', label: '直接采用' },
                    { value: 'ai', label: 'AI 推演', primary: true },
                ],
                validate: value => value.value === 'custom' && !String(value.customValue || '').trim() ? '请先填写自定义剧情方向' : '',
            });
            if (!isTimeTravelSelectionCurrent(run) || !selection) return false;
            selectedValue = selection.value;
            customValue = selection.customValue;
            const preference = directionValue(selection);
            if (selection.action === 'direct') {
                const finalContext = collectTimeTravelContext(run.sourceDate, run.targetDate);
                const prompt = buildTravelStoryPrompt({ ...finalContext, direction: preference });
                if (!injectToST(prompt)) return false;
                if (!isTimeTravelSelectionCurrent(run)) return false;
                return timeTravel.begin({ chatId: run.chatId, sourceDate: run.sourceDate, selectedTargetDate: run.targetDate, direction: preference });
            }
            if (selection.action !== 'ai') continue;
            if (exclusionPreference !== preference) {
                excluded = [];
                exclusionPreference = preference;
            }
            const picked = await customDialog.selectOneAsync({
                title: '选择 AI 推演方向',
                body: '选择一条作为本次时旅方向；刷新会中止上一轮，并避开本次已经展示过的结果。',
                refreshable: true,
                refreshText: '换一批',
                confirmText: '采用方向',
                cancelText: '返回',
                cancelValue: '__back__',
                loadingText: '正在推演三个方向…',
                emptyText: '没有得到可用方向，请刷新重试',
                loadChoices: async ({ signal }) => {
                    if (!isTimeTravelSelectionCurrent(run)) throw Object.assign(new Error('时旅选择已结束'), { name: 'AbortError' });
                    const cfg = loadCfg();
                    if (!cfg.url || !cfg.key) throw new Error('请先在设置中填写自定义 API 的 URL 和 Key；也可以返回后直接采用');
                    const live = collectTimeTravelContext(run.sourceDate, run.targetDate);
                    const prompt = buildTravelDirectionPrompt({ ...live, preference, excluded });
                    const ctx = getContext();
                    const raw = await callCustomApi(ctx, prompt, cfg, ctx.name1 || '用户', ctx.name2 || '角色', signal, 10, { temperature: GEN_TEMPERATURE, promptMode: 'creative', diagnosticModule: 'time-travel-direction' });
                    if (signal?.aborted || !isTimeTravelSelectionCurrent(run)) throw Object.assign(new Error('时旅选择已结束'), { name: 'AbortError' });
                    const directions = parseTravelDirections(raw, excluded);
                    if (!directions.length) throw new Error('AI 没有返回可用方向，请刷新重试');
                    excluded.push(...directions);
                    return directions.map(value => ({ value, label: value }));
                },
            });
            if (!isTimeTravelSelectionCurrent(run) || picked == null) return false;
            if (picked === '__back__') continue;
            const finalContext = collectTimeTravelContext(run.sourceDate, run.targetDate);
            const prompt = buildTravelStoryPrompt({ ...finalContext, direction: picked });
            if (!injectToST(prompt)) return false;
            if (!isTimeTravelSelectionCurrent(run)) return false;
            return timeTravel.begin({ chatId: run.chatId, sourceDate: run.sourceDate, selectedTargetDate: run.targetDate, direction: picked });
        }
        return false;
    } finally {
        if (_activeTimeTravelSelection === run) _activeTimeTravelSelection = null;
    }
}

function clearTimeTravelSession(active = timeTravel.getState(), { removeWaitingBlock = false, reason = 'cleared' } = {}) {
    if (!active) return false;
    const abortReason = reason === 'plugin-disabled' ? 'plugin-disabled' : reason === 'chat-boundary' ? 'chat-boundary' : 'time-travel-cancel';
    traceDiagnosticEvent('abort-boundary', { module: 'time-travel', chatId: active.chatId, chatRevision: pointTaskOwners.currentChatRevision(), boundaryEpoch: chatBoundaryEpoch, abortReason, status: 'dispatch' });
    timeTravel.clear(reason);
    // clear() 不触发 onSequenceEnd（controller 只在 handleRendered 收尾时发），闸/协调器须随取消显式释放，
    // 否则 token 滞留 → 后续正常自动化被误抑制（同 chatId+messageId 复活场景）或协调器内存滞留。
    clearAutomationClaims();
    dateCoordinator.clear();
    dateDetectionController.abort(abortReason);
    linesFeature.abortGeneration({ reason: abortReason });
    outlineFeature.judge.abort(abortReason);
    _autoRegenSchedAbort?.abort(abortReason);
    ledgerCaptureController.abort(abortReason);
    ledgerJudgeController.abort(abortReason);
    if (removeWaitingBlock && active.phase === 'waiting') {
        const input = $('#send_textarea');
        if (input.length) input.val(removeTimeTravelBlocks(String(input.val() || ''))).trigger('input');
    }
    return true;
}

async function cancelTimeTravel() {
    const active = timeTravel.getState();
    if (!active) return false;
    const waiting = active.phase === 'waiting';
    const confirmed = await customDialog.confirm({
        title: waiting ? '取消这次时光旅行？' : '中止时光旅行同步？',
        body: waiting
            ? '确认后会移除输入框中尚未发送的时旅指令。'
            : '确认后会停止当前及后续同步；已经完成的模块更新会保留。',
        confirmText: waiting ? '取消时旅' : '中止同步',
        cancelText: '继续当前时旅',
    });
    const current = timeTravel.getState();
    if (!current || current.sessionId !== active.sessionId || current.phase !== active.phase) {
        showToast('时旅状态已经变化，本次没有中断当前会话');
        return false;
    }
    if (!confirmed) return false;
    clearTimeTravelSession(active, { removeWaitingBlock: waiting, reason: 'cancelled' });
    showToast(waiting ? '已取消时光旅行' : '已中止时光旅行同步；已完成的更新会保留');
    return true;
}

function cancelTimeTravelForDeletion() {
    const active = timeTravel.getState();
    if (!active) return false;
    const waiting = active.phase === 'waiting';
    clearTimeTravelSession(active, { removeWaitingBlock: waiting, reason: 'message-deleted' });
    showToast(waiting
        ? '楼层已删除，未发送的时旅指令也已移除'
        : '楼层已删除，时旅同步已中止；已完成的更新会保留');
    return true;
}

function appendTravelPromptContext(prompt, travelContext = null) {
    if (!travelContext || travelContext.feedback !== 'time-travel') return prompt;
    const target = travelContext.targetDate;
    const targetText = target && Number.isInteger(Number(target.month)) && Number.isInteger(Number(target.day))
        ? `目标日期：${target.month}月${target.day}日`
        : '';
    return [prompt, travelContext.promptAddon, targetText].filter(Boolean).join('\n\n');
}

// 扩展目录绝对路径（引自身 style.css 进 shadow）；ST 站点根（引 fontawesome.min.css，
// 与 ST 共用浏览器缓存）。import.meta.url = …/scripts/extensions/third-party/ST-SevenDaysCal/index.js
const EXT_BASE = new URL('.', import.meta.url).href;                 // …/ST-SevenDaysCal/
const ST_BASE  = new URL('../../../../../', import.meta.url).href;   // ST 站点根（public/ 即 /）

// 悬浮球图标（Solar「pen-new-round-outline」，MIT 免费素材；源 assets/pen.svg）。
// 内联而非 <img>：单 path 用 fill=currentColor，直接继承按钮字色——主题日/夜换色、
// 生成态霓虹变色（.sp-btn-generating 改 color）全都自动跟随，无需另写。宽高 1em 跟字号缩放，
// 替换旧的 <i class="fa-...">，行为一致。仅悬浮球用；魔杖菜单入口仍是字体图标（见 injectExtButton）。
const PEN_ICON_SVG = '<svg class="sp-pen-icon" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M1.25 12C1.25 6.063 6.063 1.25 12 1.25a.75.75 0 0 1 0 1.5A9.25 9.25 0 1 0 21.25 12a.75.75 0 0 1 1.5 0c0 5.937-4.813 10.75-10.75 10.75S1.25 17.937 1.25 12m15.52-9.724a3.503 3.503 0 0 1 4.954 4.953l-6.648 6.649c-.371.37-.604.604-.863.806a5.3 5.3 0 0 1-.987.61c-.297.141-.61.245-1.107.411l-2.905.968a1.492 1.492 0 0 1-1.887-1.887l.968-2.905c.166-.498.27-.81.411-1.107q.252-.526.61-.987c.202-.26.435-.492.806-.863zm3.893 1.06a2.003 2.003 0 0 0-2.832 0l-.376.377q.032.145.098.338c.143.413.415.957.927 1.469a3.9 3.9 0 0 0 1.807 1.025l.376-.376a2.003 2.003 0 0 0 0-2.832m-1.558 4.391a5.4 5.4 0 0 1-1.686-1.146a5.4 5.4 0 0 1-1.146-1.686L11.218 9.95c-.417.417-.58.582-.72.76a4 4 0 0 0-.437.71c-.098.203-.172.423-.359.982l-.431 1.295l1.032 1.033l1.295-.432c.56-.187.779-.261.983-.358q.378-.18.71-.439c.177-.139.342-.302.759-.718z" clip-rule="evenodd"/></svg>';


// 模块介绍：内容标题旁「?」点开的小气泡文案。键对应侧栏 data-view，面向使用者讲清用途与真实操作。
// 想改文字直接改这里即可（纯展示，不入库、不注入 AI）。
// 小百科·图标图例：模块介绍气泡内容。lede（这模块干嘛的·一句话）+ 若干「真 FontAwesome 图标 + 名称 + 一句话」，
// 图标与界面所见一致，用户对号入座即知每个钮啥意思。渲染端用 .html() 注入（内容全为作者手写、无用户输入，无注入面）。精简为主。
const _iLede = t => `<p class="sp-intro-lede">${t}</p>`;
const _iSub  = t => `<div class="sp-intro-sub">${t}</div>`;
const _iKey  = (icon, name, desc) => `<div class="sp-intro-key"><i class="fa-solid ${icon}"></i><b>${name}</b><span>${desc}</span></div>`;
const _iSvgKey = (svg, name, desc) => `<div class="sp-intro-key">${svg}<b>${name}</b><span>${desc}</span></div>`;
const _coordinateIntroSvg = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3.5 L6 18 L20.5 18"/><circle cx="14" cy="9.4" r="1.9" fill="currentColor" stroke="none"/></svg>';

const MODULE_INTROS = {
    schedule:
        _iLede('「点」从故事里的“今天”开始，为我／TA 安排接下来 3 天的事项，并把更远的事另列在“未来”；它不是人物此刻状态卡。时间戳是全局时间锚点，也负责星期判定，由主楼 AI 随回复输出，构画只读取、解析和展示，不会自行生成；是否出现、格式完整与时间合理取决于模型是否遵循提示词和主楼剧情质量，缺失或不完整时无法凭空补出可靠时间，可能让时间判断失真；没有可靠记录时不猜现实星期。') +
        _iSub('默认不会随日期变化自动重排，也不会潜伏注入主楼 AI。想更新就手动刷新；若要“今天”变化后后台重排，可在设置 → 推进设置 → 日期与点开启“点：后台自动跟随「今天」”（会额外调用 API）。') +
        _iKey('fa-rotate-right', '生成／刷新', '按最新剧情重做未锁事项；新结果会覆盖旧的未锁数据') +
        _iKey('fa-thumbtack',    '固定 TA',    '只把当前 TA 留在 TA▾ 抽屉，方便下次查看；不是锁定事项') +
        _iKey('fa-ellipsis-vertical', '⋮ 菜单', '每条点的操作都收在这里') +
        _iKey('fa-pen',          '编辑',       '手动修改这条事项') +
        _iKey('fa-lock',         '锁定',       '刷新时保住同名事项不被删除；时间、说明等仍可能随新剧情推进') +
        _iKey('fa-arrow-right-to-bracket', '注入', '把这条点写进输入框，供你确认或修改后发送；不是后台注入') +
        _iKey('fa-trash',        '删除',       '移除这条事项'),
    almanac:
        _iLede('「轴」有“即将到来”“日历”“刻度”三页：前两页管理节日、生日、纪念日与故事历法；刻度页跟踪伤情、约定、周期等会随时间变化的账。时间戳是全局时间锚点，也负责星期判定，由主楼 AI 随回复输出，构画只读取、解析和展示，不会自行生成；主楼未输出或格式不完整时无法凭空补出可靠时间，可能让时间判断失真；没有可靠记录时不猜现实星期。') +
        _iSub('节日 · 历法') +
        _iKey('fa-plus',          '添加',       '手动录入节日／生日／纪念日；手动项生成时会保留') +
        _iKey('fa-wand-magic-sparkles', '生成节日', '按世界观重做一整年：保留手动项和锁定项，替换未锁的旧 AI 日期') +
        _iKey('fa-heart-circle-plus', '补录纪念日', '只追加剧情中新出现的重大里程碑，可能没有结果；新增项自动锁定') +
        _iKey('fa-calendar-days', '历法管理',   '查看、编辑月份／天数／纪年和历法模板；换历法遇到无效日期时会先让你选择取消、删除或自动修正') +
        _iKey('fa-lock',          '锁定',       '以后生成节日时保留这条') +
        _iKey('fa-pen',           '编辑',       '修改名称、日期、说明等') +
        _iKey('fa-trash',         '删除',       '移除这条日期') +
        _iSub('刻度 · 时间账') +
        _iLede('刻度分持续状态／约定待办／周期三类。自动标注默认关闭；也可在刻度页或楼内“标注池”点［标注］捞取新条、点［更新］按时间刷新现状。潜伏注入也默认关闭，并且必须同时开启“允许潜伏注入主楼 AI（线 / 面 / 刻度）”总开关和刻度自己的“潜伏注入主楼 AI”才生效。') +
        _iKey('fa-pen',         '编辑',     '手动改字段；保存后自动成为用户锁') +
        _iKey('fa-lock',        '锁定',     'AI 更新不再改这条；与是否注入主楼是两回事') +
        _iKey('fa-bell',        '暂停埋入', '暂不注入主楼，但仍留在活跃账上继续跟进；再点恢复') +
        _iKey('fa-check',       '了结',     '从活跃区移到归档，之后仍可捞回') +
        _iKey('fa-rotate-left', '捞回',     '归档区：让已了结条目回到活跃区') +
        _iKey('fa-trash',       '彻底删除', '归档区：不可恢复地删除'),
    lines:
        _iLede('「线」有“平行事件”和“冷知识”两页。平行事件追踪仍在发展的伏笔、人物行动与局势；冷知识要先在设置 → 注入与内容设置 → 功能与内容开关开启“冷知识”，才会参与生成和显示。') +
        _iSub('线可按回合数自动推进、在故事日期变化时推进，或只接受手动推进；策略在设置 → 推进设置 → 线。潜伏注入必须同时开启总开关和线自己的“潜伏注入主楼 AI”。') +
        _iKey('fa-rotate-right', '重新生成', '重做未锁定的线；锁定线保留') +
        _iKey('fa-forward',      '推进',     '更新已有线，并可能新增少量真正独立的事件') +
        _iKey('fa-plus',         '新增冷知识', '在“冷知识”页选择主题生成；只在冷知识开关开启后可用') +
        _iKey('fa-ellipsis-vertical', '⋮ 菜单', '每条平行事件的操作都收在这里') +
        _iKey('fa-pen',          '编辑',     '手动修改这条线') +
        _iKey('fa-lock',         '锁定',     '重新生成时保留这条线；AI 不能替你创建用户锁') +
        _iKey('fa-arrow-right-to-bracket', '注入', '把单条线写进输入框，供你确认后发送') +
        _iKey('fa-trash',        '删除',     '移除这条线'),
    outline:
        _iLede('「面」左侧是一整份剧情大纲，右侧是只针对这份面的 AI 讨论。［重新生成］会替换整份旧面，不是只补一个节点；讨论里的回复只有成功解析出至少一个有效节点时，才会出现可用的“应用此面”。') +
        _iSub('自动判断会按设置的间隔识别故事演到哪，只会向后推进，不会自动倒退。大纲潜伏注入必须同时开启总开关、面自己的“大纲自动注入”，并且已经设有当前节点。') +
        _iKey('fa-rotate-right',        '重新生成',   '按最新剧情重做并覆盖整份面') +
        _iKey('fa-paper-plane',         '发送讨论',   '在右侧向 AI 讨论、修改或索要一版新面') +
        _iKey('fa-broom',               '清空讨论',   '只清右侧讨论记录，不删除左侧现有面') +
        _iKey('fa-ellipsis-vertical',   '⋮ 菜单',     '每个节点的操作都收在这里') +
        _iKey('fa-pen',                 '编辑',       '手动修改这个节点') +
        _iKey('fa-location-crosshairs', '设为当前',   '把这个节点标成正在进行；已是当前时显示“取消当前”') +
        _iKey('fa-arrow-right-to-bracket', '注入',    '把单个节点写进输入框，供你确认后发送') +
        _iKey('fa-copy',                '复制',       '复制这个节点的文字') +
        _iKey('fa-trash',               '删除',       '只删除这个节点'),
    space:
        _iLede('「间」是局外创作顾问：可以聊剧情、设定、人物和世界观，也能把 AI 给出的结构化卡片落到其他模块。这里不会写入正式角色扮演楼层，也不会直接推进剧情。发送新问题时会先清理较旧记录；一轮完整问答结束后，最多可能暂时显示 21 条间内消息。') +
        _iSub('落地规则：新点追加到“未来”且不会自动锁；改点会替换指定条目。新线追加后自动锁定，改已有线则保留它原来的锁态。轴日期只做去重追加并自动锁定。应用历法会换掉当前月份／天数／纪年；若现有日期不适用，会先让你选择取消、删除冲突日期或自动修正。') +
        _iKey('fa-paper-plane',    '发送',       '把问题发给局外创作顾问') +
        _iKey('fa-pen',            '编辑并重发', '只在你的消息上出现；会从这里截断后续记录并重新提问') +
        _iKey('fa-copy',           '复制',       '只复制这条消息的普通文字；结构化卡片不会随消息一起复制') +
        _iKey('fa-trash',          '删除',       '删除单条间内消息') +
        _iKey('fa-broom',          '清空',       '清掉当前聊天的全部间内记录') +
        _iKey('fa-plus',           '应用到点／线／轴', '按上面的规则写入对应模块') +
        _iKey('fa-calendar-check', '应用历法',    '确认冲突处理后换用这套历法'),
    theater:
        _iLede('「棱」＝小剧场：按当前故事背景写独立短篇／番外，结果不进入正式角色扮演楼层。可直接填写要求，也可从模板起草；模板库在设置 → 数据设置 → 小剧场模板库。') +
        _iKey('fa-shuffle', '随机',     '只从模板库随机填入一份模板；确认或修改输入后，还要点“生成小剧场”') +
        _iKey('fa-file-lines', '模板内容', '查看这次生成实际使用的模板文字') +
        _iKey('fa-expand',  '全屏浏览', '铺满视口阅读；再次点击或按 Esc 退出') +
        _iSub('［重新生成］沿用当前小剧场的主题／模板再生成一版。可先改标题再点［永久保存］存到本对话；草稿最多 10 条，新稿会挤掉最旧草稿。草稿和永久稿列表里的［删除］只删除对应稿件。'),
    anchor:
        _iLede('「坐标」收藏的是 AI 楼层正文的副本，方便以后回看，不是完整样式快照。入口受设置 → 通用设置 → 显示与通知管理里的“收藏此楼入口”控制，只会出现在 AI 楼；收藏后可立即选择标签，再点同一枚按钮会取消收藏。') +
        _iSub('收藏夹按角色 → 聊天 → 楼层分组，可用标签筛选和管理。删除收藏只删副本，不会删除或改动原楼层。') +
        _iSvgKey(_coordinateIntroSvg, '坐标形收藏', 'AI 楼上的这枚坐标形按钮：点击收藏，再次点击取消收藏') +
        _iSub('［标签管理］可新建、改名、改色或删除标签，删标签不会删收藏。收藏全文右上角的［⛶］进入全屏，［×］删除这份收藏副本。'),
};

let lastDebugPayload = null;

function lastDebugPayloadJson() {
    if (lastDebugPayload === null || lastDebugPayload === undefined) return null;
    try {
        const json = JSON.stringify(lastDebugPayload, null, 2);
        return typeof json === 'string' ? json : null;
    } catch { return null; }
}

function refreshLastDebugPayloadPreview() {
    const json = lastDebugPayloadJson();
    const hasPayload = Boolean(json);
    const preview = inEl('#sp-diagnostics-ai-input-pre');
    if (preview) preview.textContent = json || '（尚未发送请求）';
    $in('#sp-diagnostics-ai-input-preview').toggleClass('sp-diagnostics-preview-empty', !hasPayload);
    $in('#sp-diagnostics-ai-input-actions').prop('hidden', !hasPayload);
    $in('#sp-diagnostics-ai-input-copy').prop('disabled', !hasPayload);
    return json;
}

async function copyLastDebugPayload({
    copyText = copyPlainText,
    promptTextarea = options => customDialog.promptTextarea(options),
    notify = (message, isError) => showToast(message, null, isError),
} = {}) {
    const text = lastDebugPayloadJson();
    if (!text) {
        refreshLastDebugPayloadPreview();
        try { notify?.('尚未发送请求', false); } catch {}
        return Object.freeze({ status: 'empty' });
    }
    let copied = false;
    try { copied = await copyText?.(text) === true; } catch {}
    if (copied) {
        try { notify?.('AI 输入已复制', false); } catch {}
        return Object.freeze({ status: 'copied' });
    }
    if (typeof promptTextarea !== 'function') {
        try { notify?.('自动复制失败，请在预览区手动选择内容', true); } catch {}
        return Object.freeze({ status: 'failed' });
    }
    try {
        await promptTextarea({
            title: '复制 AI 输入',
            body: '自动复制失败，请长按文本复制。这里可能包含最近聊天、上下文、世界书和提示词等敏感内容，请勿公开分享。',
            initialValue: text,
            maxLength: Math.max(1, text.length),
            rows: 12,
            confirmText: '关闭',
            cancelText: '取消',
        });
        return Object.freeze({ status: 'manual-copy' });
    } catch {
        try { notify?.('自动复制失败，请在预览区手动选择内容', true); } catch {}
        return Object.freeze({ status: 'failed' });
    }
}


// 存储描述符 {kind, view, charName}：getCacheKey 是 schedule key alias，其余 key 已归入对应模块。
// 无 chat 时返回 null（保留旧 getter「无 chat → null」语义，各处 if(!key) 守卫照旧生效）。

// view: 'user' | 'char'   charName: confirmed char name
const getCacheKey = getScheduleKey;
const loadCachedForCurrentChat = (view, charName) => {
    const targetView = view ?? currentView;
    const targetCharName = targetView === 'char' ? (charName ?? charViewName) : '';
    return loadCachedSchedule(targetView, targetCharName);
};

// ─── ST theme detection ───────────────────────────────────────────────────────
// Read ST's --SmartThemeBodyColor (text color on documentElement) to decide
// dark vs light. If it's bright → panel uses dark (night); if dim → light (day).
function detectSTTheme() {
    try {
        const raw = getComputedStyle(document.documentElement)
            .getPropertyValue('--SmartThemeBodyColor').trim();
        if (raw) {
            // Parse rgb/rgba/hex, get perceived luminance
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = raw;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            // Relative luminance (sRGB)
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            return lum > 127 ? 'night' : 'day';  // bright text → dark bg (night)
        }
    } catch { /* ignore */ }
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night';
}

// Resolve the effective theme by combining the user's themeMode setting
// with the detected ST theme. 'auto' follows ST (transparent-theme users get
// the day/night fallback via explicit modes instead).
function getEffectiveTheme() {
    const mode = getSettings().themeMode || 'auto';
    if (mode === 'day' || mode === 'night') return mode;
    return detectSTTheme();
}

let currentTheme   = detectSTTheme();

// 新历法编辑使用独立决策弹窗；作者原有 spConfirm 与既有调用保持不变。
// 批次4：mount 用惰性包装——_spDialogShadow 在 injectModal() 运行时才赋值，而本实例化在模块
// 顶层（更早）；弹窗实际 append 发生在运行时，届时 _spDialogShadow 已就绪。removeOverlay 注入
// 让 modal.js 保持通用（独立 shadow 内 $() 查不到 overlay，须走 $dialog）。
const customDialog = createDialogManager({
    $: jQuery,
    mount: { appendChild: el => _spDialogShadow?.appendChild(el) },
    removeOverlay: () => $dialog('#sp-addon-dialog').remove(),
    getRootClass: () => `sp-root sp-${currentTheme}`,
    subscribeContextChange: handler => {
        eventSource.on(event_types.CHAT_CHANGED, handler);
        return () => eventSource.removeListener?.(event_types.CHAT_CHANGED, handler);
    },
});

let settingsOpen   = false;
let dragState      = null;
let resizeState    = null;
let resizeRAF      = null;
let fabDragged     = false;
let fabDragState   = null;
let currentView        = 'user';  // 'user' | 'char'
let _lastMainView      = 'schedule';  // 记住上次打开的模块视图（点/历/线/面/间/棱/坐标），同 chat 内跨开关面板保留；切 chat 复位成 schedule（第一页），见 CHAT_CHANGED
let charViewName       = null;    // confirmed char name; preserved when switching to user view
let outlineMode         = false;
let linesMode           = false;
const manualEditing = { point: false, lines: false, outline: false };
// 线·swipe 重算：楼层单调递增闸（区分真·新楼层 vs swipe/历史重渲染），及"待重算 swipe"标记。
const linesFeature = createLinesFeature({
    jumpHint: () => SP_JUMP_HINT_LINES,
    get stageColors() { return STAGE_COLORS; },
    escapeHtml, escapeAttr, cleanText, makeInjectBtn,
    cacheKey: () => getLinesCacheKey(), chatId: () => getContext().chatId,
    boundaryEpoch: () => chatBoundaryEpoch,
    participantIdentity: captureParticipantIdentity,
    sameParticipantIdentity,
    contextSnapshot: captureGenerationContext,
    isEditing: () => manualEditing.lines,
    readSaved: () => readStore(getLinesCacheKey()) || {},
    writeStore, writeStoreConfirmed, readRaw: () => readStore(getLinesCacheKey())?.raw || '',
    restoreBaseline: baseline => { if (!baseline || baseline.chatId !== getContext().chatId) return; const key = getLinesCacheKey(); if (!key) return; if (baseline.raw) writeStore(key, { raw: baseline.raw, ts: baseline.ts || Date.now() }); else removeStore(key); },
    loadConfig: loadCfg, swipeId: mesId => getContext().chat?.[mesId]?.swipe_id ?? 0,
    refreshInlineWindow: refreshInlineWindow,
    freezeSnapshot: freezeSnapshotToFloor,
    isPanelActive: () => linesMode, notifyMode: () => getSettings().notifyMode,
    toast: (message, error) => showToast(message, null, error),
    pluginEnabled, getSettings, getMode: getLinesMode, getInterval: getLinesInterval,
    floorSignature: _floorSig, messageText: mid => getContext().chat?.[mid]?.mes,
    chat: () => getContext().chat, lastAssistant: () => snapshotLastAssistant(getContext().chat),
    dayAnchor: () => { try { const md = almTodayAnchor(); return md && Number.isFinite(+md.month) && Number.isFinite(+md.day) ? `${+md.month}-${+md.day}` : null; } catch { return null; } },
    dayAdvance: createAdvanceStrategy,
    swipeEnv: {
        loadConfig: loadCfg, chatId: () => getContext().chatId,
        swipeId: mesId => getContext().chat?.[mesId]?.swipe_id ?? 0,
        key: () => getLinesCacheKey(), readCurrent: () => readStore(getLinesCacheKey())?.raw || '',
        previousBaseline: _prevAiFloorLines,
        writeStore, syncInline: syncLatestInlineBlock,
        render: () => {},
    },
    widgetEnv: {
        key: () => getLinesCacheKey(), read: key => readStore(key), write: (key, value) => writeStore(key, value),
        fail: message => showToast(message, null, true), refresh: () => {},
        button: ($btn, editIdx) => { if ($btn) $btn.prop('disabled', true).html(`<i class="fa-solid fa-check"></i> ${editIdx != null ? `已改第 ${editIdx} 条` : '已加到线'}`); showToast(editIdx != null ? `已替换线·第 ${editIdx} 条` : '已加到线'); },
    },
    readRaw: () => readStore(getLinesCacheKey())?.raw || '',
    empty: () => renderEmptyLinesState(),
    loading: () => loadingHtml('正在推演线', 'sp-abort-lines'),
    renderPanelDom: ({ toolbar, body }) => { $in('#sp-lines-toolbar').html(toolbar); $in('#sp-lines-list').html(body); },
    injectionEnv: {
        context: () => getContext(), settings: getSettings, enabled: injectEnabled,
        adultMode: () => getAdultMode(charStableKey(getContext())),
        readRaw: () => readStore(getLinesCacheKey())?.raw || '',
        promptTypes: getContext()?.constants?.promptTypes || {}, promptRoles: getContext()?.constants?.promptRoles || {}, clean: cleanText,
    },
    dashedEnv: {
        keyDesc, readStore, writeStore, writeStoreConfirmed, removeStore, getSettings,
        context: getContext, chatId: () => getContext().chatId, loadConfig: loadCfg,
        callApi: (...args) => callCustomApi(...args), filterRerollItems, dialog: customDialog,
        uuid: () => globalThis.crypto?.randomUUID?.(), now: () => Date.now(), random: () => Math.random(),
        toast: (message, error) => showToast(message, null, error), escapeHtml, escapeAttr,
        logDiagnostic: diagnostic => console.warn('[SP dashed failure]', diagnostic),
        refreshPanel: () => {}, refreshInline: () => {},
    },
    dashedEnabled: () => getSettings().dashedEnabled === true,
    generationEnv: {
        isEditing: () => manualEditing.lines,
        chatId: () => getContext().chatId, loadConfig: loadCfg,
        adultMode: identity => getAdultMode(identity?.characterKey || charStableKey(getContext())),
        readSaved: () => readStore(getLinesCacheKey()) || {},
        participantIdentity: captureParticipantIdentity,
        sameParticipantIdentity,
        contextSnapshot: captureGenerationContext,
        buildPrompt: (previousRaw, travelContext, vectorContext, identity) => appendTravelPromptContext(buildLinesPrompt(identity?.userName || '用户', identity?.charName || '角色', 'user', previousRaw, getScale(identity?.characterKey || charStableKey(getContext())), vectorContext, getAdultMode(identity?.characterKey || charStableKey(getContext()))), travelContext),
        random: () => Math.random(),
        callApi: (prompt, signal, options, identity, contextSnapshot) => callCustomApi(contextSnapshot || getContext(), prompt, loadCfg(), identity?.userName || '用户', identity?.charName || '角色', signal, options?.historyLimit ?? 3, options),
        missingApi: ({ silent }) => { if (!silent && !settingsOpen) toggleSettings(); },
        onStart: () => {},
        commit: () => {},
        fail: (error, { silent = false } = {}) => { const code = classifyGenerationError(error, { phase: error?.phase || 'request' }); const manual = !silent; const notify = shouldNotifyGeneration({ manual, notifyMode: getSettings().notifyMode, code }); const diagnostic = safeDiagnosticLog('lines', error?.phase || 'request', error, { background: !manual }); console.warn('[SP lines failure]', diagnostic); if (notify && getContext().chatId) showToast(`线生成失败：${diagnosticMessage(error)}`, null, true); }, cleanup: () => {},
    },
    actionsEnv: {
        setEditing: value => { manualEditing.lines = value; },
        isBusy: () => false, readSaved: () => readStore(getLinesCacheKey()), readRaw: () => readStore(getLinesCacheKey())?.raw || '',
        write: value => writeStore(getLinesCacheKey(), value), remove: () => removeStore(getLinesCacheKey()), confirm: spConfirm, toast: (message, error) => showToast(message, null, error),
        promptFields: options => customDialog.promptFields(options),
        render: raw => raw, setCached: () => {}, refreshPanel: () => {}, refreshInline: () => {},
        resetCounter: () => {}, runGenerate: () => {}, precheck: memoryPreCheckConfirm, silent: () => !linesMode,
    },
});
const linesRuntime = linesFeature.runtime;
const outlineFeature = createOutlineFeature({
    context: getContext,
    keyDesc,
    readStore,
    writeStore,
    writeStoreConfirmed,
    removeStore,
    settings: getSettings,
    pluginEnabled,
    injectEnabled,
    loadConfig: loadCfg,
    loadUtilityConfig: loadUtilityCfg,
    callApi: ({ ctx, prompt, config, userName, charName, signal, historyLimit, options }) =>
        callCustomApi(ctx, prompt, config, userName, charName, signal, historyLimit, options),
    precheck: memoryPreCheckConfirm,
    isAutomationSuppressed,
    automationModule: AUTOMATION_MODULES.OUTLINE,
    bridgeAbortSignal,
    buildChatMessages: args => composeCreativeChatMessages(args),
    postCompletion: ({ config, ...options }) => postChatCompletion({ cfg: config, ...options }),
    temperature: GEN_TEMPERATURE,
    chatPlaceholder: getCreativeChatPlaceholder,
    cleanText,
    escapeHtml,
    confirm: spConfirm,
    promptTextarea: options => customDialog.promptTextarea(options),
    openSettings: () => { if (!settingsOpen) toggleSettings(); },
    ui: {
        $,
        query: $in,
        element: inEl,
        escapeHtml,
        autoGrow: autoGrowTextarea,
        formatAi: renderAiMessageHtml,
        confirm: spConfirm,
        copyText: copyPlainText,
        injectToInput: injectToST,
        setOutline: html => setOutlineBody(html),
        loading: loadingHtml,
        isOutlineMode: () => outlineMode,
        isPanelVisible: () => $(`#${MODAL_ID}`).is(':visible'),
        toast: (message, error) => showToast(message, null, error),
        closedSuccess: () => showToast('面已生成，点击查看', () => {
            if (!outlineMode) $in('.sp-view-btn[data-view="outline"]').trigger('click');
            showPanel();
        }),
    },
    logDiagnostic: diagnostic => console.warn('[SP outline failure]', diagnostic),
});
let spaceMode = false;
const spaceFeature = createSpaceFeature({
    context: getContext,
    keyDesc,
    readStore,
    writeStore,
    loadConfig: loadCfg,
    postCompletion: ({ config, ...options }) => postChatCompletion({ cfg: config, ...options }),
    temperature: GEN_TEMPERATURE,
    placeholder: getSpaceChatPlaceholder,
    openSettings: () => { if (!settingsOpen) toggleSettings(); },
    isOpen: () => spaceMode,
    contextEnv: {
        context: getContext,
        settings: getSettings,
        readOutline: () => outlineFeature.readRaw(),
        readPointRaw: () => readCacheRaw(getCacheKey('user', '')),
        numberedPoints: numberedPointList,
        readLineRaw: () => readStore(getLinesCacheKey())?.raw || '',
        parseLines: parseCanonicalLines,
        readLedgerText: () => {
            try {
                const items = ledger.listEntries() || [];
                return items.length ? formatLedgerList(items, { daysSince: ledgerDaysSince, dueInfo: ledgerDueInfo }) : '';
            } catch { return ''; }
        },
        readWorldInfo: ctx => buildWorldInfoContext(ctx),
        readMemory: () => getMemText(),
        readRecent: ctx => buildRecentChatContext(ctx),
        readCardExtras,
        readAlmanacText: () => getAlmanacInjectText(),
        readCalendarText: () => getCalDescInjectText(),
    },
    renderEnv: {
        escapeHtml,
        formatAi: renderAiMessageHtml,
        parseAlmanac: parseAlmanacWidget,
        parseEra: parseEraWidget,
        loadCalendar: loadCalDesc,
        calendarMonthName: calMonthName,
        calendarMonthCount: calMonthCount,
        calendarYearLength: calYearLen,
    },
    ui: {
        $,
        query: $in,
        element: inEl,
        escapeHtml,
        autoGrow: autoGrowTextarea,
        copyText: copyPlainText,
        confirm: spConfirm,
        toast: (message, error) => showToast(message, null, error),
        // 轴动作在本 facade 之后初始化；只在真实点击时读取，严禁顶层提前解引用造成 TDZ。
        widgetActions: () => ({
            point: (body, $button, editIdx) => applyPointWidget(body, $button, editIdx),
            lines: (body, editIdx, $button) => linesFeature.widget.apply(body, editIdx, $button),
            almanac: (body, $button, index) => axisWidgetActions.applyAlmanacWidget(body, $button, index),
            era: (body, $button) => axisWidgetActions.applyEraWidget(body, $button),
        }),
    },
});
let theaterMode          = false;
// 暗历内联编辑态/归档折叠态/批量模式已随 ledger 渲染层迁入 business/ledger/render.js
// （经 getLedgerEditor、归档/批量 actions 与 resetLedgerRenderState 复位）。
const _injectTexts      = {};
let   _injectIdSeq      = 0;
let viewportSyncBound   = false;

const isMobile = () => window.innerWidth <= 640;

// 通用操作菜单只描述动作；具体页面决定何时显示、如何处理动作。
const ACTION_MENU_CONFIGS = Object.freeze({
    almanac: Object.freeze([
        Object.freeze({ action: 'generate-almanac', icon: 'fa-wand-magic-sparkles', label: '生成节日', title: 'AI 按世界观逐月考虑，按素材生成' }),
        Object.freeze({ action: 'supplement-anniversary', icon: 'fa-heart-circle-plus', label: '补录纪念日', title: '只增补新里程碑，不重铺、不动现有日历' }),
        Object.freeze({ action: 'manage-calendar', icon: 'fa-calendar-days', label: '历法管理', title: '查看、编辑和管理历法模板' }),
    ]),
});

// ─── Init ─────────────────────────────────────────────────────────────────────

// Module-level handles so hot-reload / re-init doesn't double-register.
// If the module loads again in the same page (rare but possible with ST's
// dev workflows), we need to be able to unregister and rewire cleanly.
let _themeObserver = null;
const _stListeners = { chat: null, char: null };
// 柏宝书加载顺序不固定：就绪事件监听句柄（幂等注册，见 jQuery init）
let _bbbReadyListener = null;

// 界面字体·自管控：按 settings.uiFontUrl / uiFontFamily 动态挂 <link> + 写 --sp-font-user。
// 幂等：复用固定 id 的 link 节点，重复调用只改 href / 不叠加。早期 bootstrap + 设置改动时各调一次。
const SP_FONT_LINK_ID = 'sp-ui-font-link';
const SP_FONT_DEFAULT_URL    = 'https://fontsapi.zeoseven.com/387/main/result.css';
const SP_FONT_DEFAULT_FAMILY = 'Nowar Rounded TW Wc';
function applyUiFont() {
    const s = getSettings();
    const url    = (s.uiFontUrl    ?? SP_FONT_DEFAULT_URL).trim();
    let   family = (s.uiFontFamily ?? SP_FONT_DEFAULT_FAMILY).trim();

    // <link> 侧：有 URL 就挂/换，留空则移除（=只用系统栈兜底）。href 用绝对 URL——
    // zeoseven 那份 CSS 里 @font-face src 是相对路径 ./xxx.woff2，浏览器基于 link href 解析，
    // 故必须走 <link href> 而非把 CSS 内容内联（内联会丢失基准 URL、woff2 404）。
    let link = document.getElementById(SP_FONT_LINK_ID);
    if (url) {
        if (!link) {
            link = document.createElement('link');
            link.id  = SP_FONT_LINK_ID;
            link.rel = 'stylesheet';
            document.head.appendChild(link);
        }
        if (link.getAttribute('href') !== url) link.setAttribute('href', url);
    } else if (link) {
        link.remove();
    }

    // --sp-font-user 侧：写生效 family 名（供 style.css 的 --sp-font 打头）。family 留空则回落默认名。
    // 名字含空格 / 非纯标识符时补引号，避免 CSS 里被拆成多个 family。
    if (!family) family = SP_FONT_DEFAULT_FAMILY;
    const quoted = ((family.startsWith('"') && family.endsWith('"')) || (family.startsWith("'") && family.endsWith("'")) || /^[A-Za-z_][A-Za-z0-9_-]*$/.test(family))
        ? family
        : `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    document.documentElement.style.setProperty('--sp-font-user', quoted);
}

// 从用户提供的 CSS 中读取首个有效 @font-face 字体名；只认 @font-face，
// 不猜测普通选择器里的 body/font 声明，避免把无关 CSS 当成界面字体。
export function parseFontFamilyFromCss(cssText) {
    if (typeof cssText !== 'string') return '';
    const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = withoutComments.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi);
    for (const match of blocks) {
        const declaration = /(?:^|;)\s*font-family\s*:\s*([^;}]*)/i.exec(match[1]);
        if (!declaration) continue;
        const family = declaration[1].trim();
        if (!family || family.includes(',')) continue;
        const quote = family[0];
        if (quote === '"' || quote === "'") {
            const body = family.slice(1, -1);
            let escaped = false;
            let hasUnescapedSameQuote = false;
            for (const character of body) {
                if (character === quote && !escaped) { hasUnescapedSameQuote = true; break; }
                if (character === '\\' && !escaped) escaped = true;
                else escaped = false;
            }
            let closingSlashCount = 0;
            for (let i = family.length - 2; i >= 0 && family[i] === '\\'; i--) closingSlashCount++;
            if (family.length < 3 || family.at(-1) !== quote || closingSlashCount % 2 === 1 || hasUnescapedSameQuote) continue;
            let unquoted = '';
            let invalidEscape = false;
            for (let i = 0; i < body.length;) {
                if (body[i] !== '\\') {
                    unquoted += body[i++];
                    continue;
                }
                i++;
                if (i >= body.length) { invalidEscape = true; break; }
                if (body[i] === '\r' || body[i] === '\n') {
                    if (body[i] === '\r' && body[i + 1] === '\n') i++;
                    i++;
                    continue;
                }
                const hex = /^[0-9a-f]{1,6}/i.exec(body.slice(i));
                if (hex) {
                    const codePoint = Number.parseInt(hex[0], 16);
                    i += hex[0].length;
                    if (/[\t\n\r ]/.test(body[i] || '')) i++;
                    if (!codePoint || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) { invalidEscape = true; break; }
                    unquoted += String.fromCodePoint(codePoint);
                    continue;
                }
                unquoted += body[i++];
            }
            unquoted = unquoted.trim();
            if (invalidEscape || /[\u0000-\u001f\u007f]/.test(unquoted)) continue;
            if (unquoted) return unquoted;
        } else if (/^[^{};'"\"]+$/.test(family)) {
            return family;
        }
    }
    return '';
}

jQuery(async () => {
    // 界面字号缩放：把持久化的 uiScale 写进 --sp-scale，令牌即刻按此缩放（早于注入 UI，防首帧闪错号）
    document.documentElement.style.setProperty('--sp-scale', String(Number(getSettings().uiScale) || 1));
    // 界面字体：按持久化的 uiFontUrl/uiFontFamily 挂 <link> + 写 --sp-font-user（早于注入 UI，防字体闪切）
    applyUiFont();
    injectExtButton();
    // 重新挂载主 Shadow root 前先销毁旧棱实例，清理 Esc、图片监听、owner 与 UI 委托。
    theaterFeature?.destroy?.();
    theaterFeature = createTheaterHostFeature();
    injectModal();
    injectFab();
    injectToastContainer();
    // Apply saved theme mode (day/night/auto) now that settings are guaranteed loaded
    applyTheme(getEffectiveTheme());
    // Initialize memory system — wires event listeners internally
    memory.initMemory({
        getSettings: () => {
            const s = getSettings();
            return {
                pluginEnabled  : s.pluginEnabled !== false,
                useBaiBaiBook  : !!s.useBaiBaiBook,
                useAnima       : !!s.useAnima,
                useDatabase    : !!s.useDatabase,
                memoryEnabled  : s.memoryEnabled !== false,
                memoryL0Group  : Number.isFinite(+s.memoryL0Group) ? +s.memoryL0Group : 5,
                memoryL1Group  : Number.isFinite(+s.memoryL1Group) ? +s.memoryL1Group : 10,
                memorySkipShort: Number.isFinite(+s.memorySkipShort) ? +s.memorySkipShort : 50,
                keepTags       : typeof s.keepTags  === 'string' ? s.keepTags  : 'content',
                extraTags      : typeof s.extraTags === 'string' ? s.extraTags : '',
            };
        },
        callApi: callMemoryApi,
        onPause: log => {
            console.warn('[SP memory pause]', log);
            if (getSettings().notifyMode === 'full' && !memoryPauseNoticeShown) { memoryPauseNoticeShown = true; showToast('记忆系统因连续失败已暂停：请检查 API 后点击补齐或重构', null, true); }
        },
    });
    coordinateRuntime = createCoordinateRuntime({
        forceNew: true,
        root: $in('#sp-anchor-body')?.[0] || null,
        warnBytes: Number(getSettings().anchorSizeWarnBytes) || 8 * 1024 * 1024,
        hostPorts: { settings: () => getSettings(), dom: () => document, context: () => getContext() },
        host: {
            document, context: () => getContext(), settings: () => getSettings(), enabled: () => pluginEnabled(),
            sheet: () => _spShadow?.querySelector?.('.sp-sheet') || document.querySelector('.sp-sheet'),
            chatName: () => { const el = document.querySelector('#selected_chat_pole, #chat_name_pole, .current_chat_name'); return el?.value || el?.textContent?.trim() || getContext().chatId || '当前聊天'; },
            capture: el => { const ctx = getContext?.() || {}; return captureSnapshotElement(el, { documentRef: document, DOMPurify: globalThis.DOMPurify, messageFormatting: ctx.messageFormatting }); },
            toast: (message, action, error) => showToast(message, action, error),
            saveChatDebounced: () => scriptCore.saveChatDebounced(),
            warn: (message, error) => console.warn(message, error),
            confirm: message => spConfirm({ title: String(message).includes('收藏') ? '删除收藏' : '删除标签', body: message }),
            selectMany: options => customDialog.selectMany(options),
            svg: cls => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3.5 L6 18 L20.5 18"/><circle cx="14" cy="9.4" r="1.9" fill="currentColor" stroke="none"/></svg>`,
        },
    });
    coordinateRuntime.feature.init({ chatId: getContext()?.chatId ?? null });
    coordinateRuntime.feature.bindInteractionCapture($in('#sp-anchor-wrap')?.[0] || null);
    coordinateRuntime.feature.bindUi($in('#sp-anchor-wrap')?.[0] || null);
    coordinateRuntime.feature.bindDelete($in('#sp-anchor-wrap')?.[0] || null);
    coordinateRuntime.feature.bindGestures($in('#sp-anchor-wrap')?.[0] || null);
    coordinateRuntime.feature.refreshSavedKeys();
    activeChatBoundaryIdentity = captureChatBoundary();
    setTimeout(() => coordinateRuntime.feature.scanButtons(), 900);
    initChatObserver();
    // 首屏补挂：backfill 内部 refreshLinesInjection()（潜伏注入）+ refreshInlineWindow(true)
    // 统一挂线/历/点三段。历/点无独立首屏副作用，全汇流到同一防抖窗口刷新，一次即可。
    scheduleForChatBoundary(backfillLinesInlineBlocks, 800);
    // Reset view state and reload cache on chat switch
    if (_stListeners.chat) eventSource.removeListener?.(event_types.CHAT_CHANGED, _stListeners.chat);
    _stListeners.chat = () => {
        // 切聊是构画的硬失败边界：先统一推进 epoch/revision，再无条件清掉所有聊天态任务。
        const previousChatId = activeChatBoundaryIdentity?.chatId ?? null;
        const previousBoundaryEpoch = chatBoundaryEpoch;
        const previousChatRevision = pointTaskOwners.currentChatRevision();
        chatBoundaryEpoch++;
        activeChatBoundaryIdentity = captureChatBoundary();
        pendingDateBootstrap = latestFloorBoundaryIdentity();
        const lastSeen = (getContext().chat?.length ?? 0) - 1;
        const chatRevision = pointTaskOwners.nextChatRevision();
        linesFeature.nextChatRevision();
        recordChatBoundary({ previousChatId, currentChatId: activeChatBoundaryIdentity.chatId, previousBoundaryEpoch, boundaryEpoch: chatBoundaryEpoch, previousChatRevision, chatRevision });
        traceDiagnosticEvent('abort-boundary', { module: 'runtime', chatId: activeChatBoundaryIdentity.chatId, chatRevision, boundaryEpoch: chatBoundaryEpoch, abortReason: 'chat-boundary', status: 'dispatch' });
        pointTaskOwners.invalidateAll('chat-boundary');
        pointController.reset('chat-boundary');
        linesFeature.onChatChanged({ lastSeen });
        memory.abortAll('chat-boundary');
        _timeTravelSelectionSeq++;
        _activeTimeTravelSelection = null;
        _activeSpConfirmCancel?.();
        _activeStoreConflictFinish?.('defer');
        customDialog.cancelActive();
        removeDialogOverlays();
        timeTravel.clear('chat-boundary');
        clearAutomationClaims();
        dateCoordinator.clear();
        dateDetectionController.reset('chat-boundary');
        outlineFeature.onChatChanged({ lastSeen });
        spaceFeature.onChatChanged({ enabled: pluginEnabled() });
        linesFeature.dashed.abort('chat-boundary');
        theaterFeature.onChatChanged();
        ledgerCaptureController.reset('chat-boundary');
        ledgerJudgeController.reset('chat-boundary');
        axisGenerationController.reset('chat-boundary');
        _autoRegenSchedAbort?.abort('chat-boundary'); _autoRegenSchedAbort = null;
        pointState.isGenerating = false;
        pointState.scheduleAbortController = null;
        axisState._almSyncingPoint = false;
        linesRuntime.reset();
        linesFeature.setSheet('events');
        linesFeature.dashed.resetError();
        if (previousChatId != null) linesFeature.clearAllSwipe(previousChatId);
        linesFeature.clearAllSwipe(getContext().chatId);
        almanacLastJudgedMsgId = lastSeen;
        almanacJudgeCounter = 0;
        ledgerLastCapturedMsgId = lastSeen;
        ledgerCaptureCounter = 0;
        ledgerLastJudgedMsgId = lastSeen;
        ledgerJudgeCounter = 0;
        currentView = 'user';
        charViewName = null;
        outlineMode = false;
        linesMode = false;
        spaceMode = false;
        theaterMode = false;
        manualEditing.point = manualEditing.lines = manualEditing.outline = false;
        axisState.almanacMode = false;
        axisState._almanacSheet = 'upcoming';
        axisState._almanacCalMonth = null;
        axisState._almanacCalDay = null;
        axisState._almanacEditor = null;
        axisState._almTodayEditing = false;
        resetLedgerRenderState();
        axisCalendarManager.close();
        _lastMainView = 'schedule';
        coordinateRuntime?.feature?.onChatChanged({ chatId: getContext()?.chatId ?? null, chatMetadataRef: getContext()?.chatMetadata ?? null, enabled: pluginEnabled() });
        // 老用户升级：把本 chat 散在 localStorage 的点线面间**同步**搬进 chat_metadata，
        // 必须早于下面任何 load（否则读的是空 metadata）。冲突（云端/本机各一份且不同）时
        // migrate 不动任何数据，稍后异步弹窗让用户决策。
        const _mig = store.migrateChatFromLocalStorage(getContext().chatId);
        // 插件总关只能截断新聊天初始化，不能截断上面的硬清场。
        if (!pluginEnabled()) { coordinateRuntime?.feature?.close?.(); return; }
        coordinateRuntime?.feature?.close?.();
        $inAll('.sp-side-tab.sp-view-btn').removeClass('sp-view-active');
        $in('.sp-side-tab.sp-view-btn[data-view="schedule"]').addClass('sp-view-active');
        $inAll('.sp-sub-btn').removeClass('sp-view-active');
        $in('.sp-sub-btn[data-view="user"]').addClass('sp-view-active');
        $in('#sp-sub-toggle').show();
        closeTaDrawer();            // 换 chat：收起可能开着的 TA▾ 抽屉
        updateTaTriggerLabel();     // charViewName 已清 → 标签回落「TA」
        $in('#sp-content-title').text('点');
        pointState.cachedSchedule = loadCachedForCurrentChat();
        if ($(`#${MODAL_ID}`).is(':visible') && !pointState.isGenerating) {
            $in('#sp-outline-wrap').hide();
            $in('#sp-lines-wrap').hide();
            $in('#sp-space-wrap').hide();
            $in('#sp-theater-wrap').hide();
            $in('#sp-anchor-wrap').hide();
            $in('#sp-almanac-wrap').hide();
            $in('#sp-body').show();
            $inAll('.sp-outline-btn').removeClass('sp-btn-active');
            updateCreativeChatModeUI();
            $in('#sp-chat-msgs').empty();
            $in('#sp-space-msgs').empty();
            if (pointState.cachedSchedule) setBody(pointState.cachedSchedule);
            else setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>还没有点</p><button class="sp-gen-btn" id="sp-gen-schedule-now">生成点</button></div>`);
        }
        // Back-fill inline blocks for newly loaded chat（backfill 内部已含线注入 + 统一窗口刷新）
        scheduleForChatBoundary(backfillLinesInlineBlocks, 300);
        // 锚：换 chat → 重载已收藏键（按钮态跟着新 chat 走）+ 补齐每楼收藏入口
        coordinateRuntime?.feature?.refreshSavedKeys();
        scheduleForChatBoundary(() => coordinateRuntime?.feature?.scanButtons(), 300);
        // Surface memory schema-migration notice, if any (once per upgraded chat)
        scheduleForChatBoundary(checkMemoryMigrationNotice, 500);
        // 跨设备冲突：本机和云端各有一份不同的点线面间 → 弹窗二选一（延后到面板/主题就绪）
        if (_mig.status === 'conflict') scheduleForChatBoundary(() => showStoreConflictDialog(_mig), 700);
        const calendarBoundary = captureChatBoundary();
        maybeApplyBoundCalendarTemplate().catch(error => {
            if (!isCurrentChatBoundary(calendarBoundary)) return;
            console.error('[SP calendar] 角色默认历法自动应用失败', safeDiagnosticLog('axis', 'save', error));
            if (getSettings().notifyMode === 'full') showToast('角色默认历法没有自动应用成功', null, true);
        });
        // 切进来立即按新 chat 的大纲+游标重设注入（关着或无大纲时内部自清）。
        outlineFeature.injection.refresh();
        // 线注入同步一并重设：楼内块靠上面 300ms 的 backfill 补挂（要等 DOM），但注入不能等——
        // 否则这 300ms 窗口内若触发生成，上一个 chat 的线注入会残留污染新 chat 首楼。
        // refreshLinesInjection 幂等（关/无活跃线时内部自清），与 backfill 内那次重复无副作用。
        refreshLinesInjection();
        refreshStoryClockInjection();   // 时间戳：切 chat 重设常驻注入（ST 切 chat 会清 extensionPrompt）
        refreshLedgerInjection();       // 暗历注入：切 chat → 账随 chat_metadata 变，重设（关/空时内部自清）
    };
    eventSource.on(event_types.CHAT_CHANGED, _stListeners.chat);
    // 首屏补迁移：扩展初始化时当前 chat 往往已 ready（CHAT_CHANGED 早已错过），
    // 否则老用户要手动切一次 chat 才触发迁移。同步搬数据，冲突延后弹窗。
    try {
        const _mig0 = store.migrateChatFromLocalStorage(getContext().chatId);
        if (_mig0.status === 'conflict') scheduleForChatBoundary(() => showStoreConflictDialog(_mig0), 900);
        if (pluginEnabled()) maybeApplyBoundCalendarTemplate().catch(error => {
            console.error('[SP calendar] 首屏角色默认历法自动应用失败', safeDiagnosticLog('axis', 'save', error));
            if (getSettings().notifyMode === 'full') showToast('角色默认历法没有自动应用成功', null, true);
        });
    } catch (err) { console.warn('[SP store] 首屏迁移失败', safeDiagnosticLog('storage', 'save', err)); }
    // Auto-advance storylines, then append inline block to every AI message.
    // NOTE: shouldAdvance triggers generation BEFORE appending the current block,
    // so the current (newest, still-unstable) message is NOT included in the LLM
    // context. The advance fires when the PREVIOUS message tips the counter over,
    // and this message just gets the freshly-generated result injected.
    // 时光旅行·预检占闸：必须先于 char 注册（同一 CMR tick 内按注册序先跑）——时旅首楼定型时，
    // 先把自动化闸整体占住（isInitialFloor 才占），让同 tick 的线/面/暗账/暗历/点全部 isSuppressed
    // 短路，避免与显式时旅步骤重复生成/重复记账。token 随 onSequenceEnd（完成/失败/取消）或 cancel 释放。
    if (_stListeners.timeTravelPreflight) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.timeTravelPreflight);
    _stListeners.timeTravelPreflight = messageId => {
        if (!pluginEnabled()) return;
        if (!timeTravel.isInitialFloor(messageId)) return;
        const session = timeTravel.getState();
        if (!session?.sessionId) return;
        const token = automationGate.claim({
            scopeId: getContext().chatId,
            messageId: Number(messageId),
            modules: Object.values(AUTOMATION_MODULES).filter(module => module !== AUTOMATION_MODULES.LINES),
        });
        if (token) _timeTravelClaimTokens.set(session.sessionId, token);
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.timeTravelPreflight);
    if (_stListeners.received) eventSource.removeListener?.(event_types.MESSAGE_RECEIVED, _stListeners.received);
    _stListeners.received = (messageId, type) => {
        linesFeature.onMessageReceived({ messageId: Number(messageId), type });
    };
    eventSource.on(event_types.MESSAGE_RECEIVED, _stListeners.received);
    if (_stListeners.char) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.char);
    _stListeners.char = async (messageId, type) => {
        if (!pluginEnabled()) return;   // 插件总关：不补锚点 / 不挂楼内块 / 不推进 / 不生成
        coordinateRuntime?.feature?.onCharacterRendered({ messageId: Number(messageId), type });
        // 锚收藏入口独立于线：不受 linesEnabled 影响，新楼渲染后补按钮
        scheduleForChatBoundary(() => coordinateRuntime?.feature?.scanButtons(), 150);
        // 轴日历块：独立于线主开关，刷新当前渲染窗口（最新 AI 楼读活态，历史楼读快照；只读，无生成）
        syncLatestAlmanacBlock();
        syncLatestScheduleBlock();   // 点·日程条：同上，随新楼补挂（只读）
        // Master switch: linesEnabled=false disables auto-advance + inline block
        if (getSettings().linesEnabled === false) return;
        const mid = Number(messageId);
        await linesFeature.onCharacterRendered({ messageId: mid, type, autoSuppressed: isAutomationSuppressed(mid, AUTOMATION_MODULES.LINES) });
        return;
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.char);
    if (_stListeners.timeTravel) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.timeTravel);
    _stListeners.timeTravel = async messageId => {
        if (!pluginEnabled()) return;
        // 闸由预检 preflight 抢占（先于 char 注册，同一 tick 生效）；这里只负责执行流程，
        // 占闸/释放全部走 preflight ↔ onSequenceEnd / cancel，杜绝「闸占在 char 之后」的死区。
        // 非匹配的最新 AI 楼也必须交给 controller，才能取消仍在 waiting 的旧会话。
        await timeTravel.handleRendered(messageId);
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.timeTravel);
    if (_stListeners.timeTravelDeleted) eventSource.removeListener?.(event_types.MESSAGE_DELETED, _stListeners.timeTravelDeleted);
    _stListeners.timeTravelDeleted = createLedgerDeletedHandler({ cancel: cancelTimeTravelForDeletion, reconcile: reconcileLedgerSources, toast: showToast, refreshInject: refreshLedgerInjection, refreshInline: () => refreshInlineWindow(true), refreshPanel: () => { if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel(); } });
    eventSource.on(event_types.MESSAGE_DELETED, _stListeners.timeTravelDeleted);
    // 线·swipe：滑到新 swipe 时线跟着重算（临时存 localStorage，发下条消息即固定）。
    // pendingGeneration=true → 该 swipe 会触发新生成，此刻新回复还没好，先记标记，等它的
    // CHARACTER_MESSAGE_RENDERED 再从楼层基线 B0 重算；=false → 滑回已生成的 swipe，直接取临时层已存线，不请求 API。
    if (_stListeners.swiped) eventSource.removeListener?.(event_types.MESSAGE_SWIPED, _stListeners.swiped);
    _stListeners.swiped = async (mesId, info) => {
        if (!pluginEnabled()) return;   // 插件总关
        // 轴日历块：swipe 可能改动剧情内时间锚点 → 按现锚点刷新当前渲染窗口（只读，无生成）
        // 戳优先·先落地：滑到的变体戳可能不同（如 920→919），先把锚点追到活戳再重建，否则轴仍读旧锚。
        // pendingGeneration 的 swipe 此刻新回复还没好、正文无新戳，跳过（等它的 CMR 再落地）。
        if (!info?.pendingGeneration) relandStoryClockAnchor();
        syncLatestAlmanacBlock();
        syncLatestScheduleBlock();   // 点·日程条：swipe 后一并重挂（点本身不随 swipe 变，纯补块）
        await linesFeature.onSwiped({ mesId, info });
        return;
    };
    eventSource.on(event_types.MESSAGE_SWIPED, _stListeners.swiped);
    // 线·编辑盖章：用户小铅笔改正文 → 只把该楼签名基线刷成编辑后正文，绝不重算/生成。
    // 堵的漏洞：编辑只发 MESSAGE_EDITED（线不监听→当场不动，合预期），但旧签名还停在编辑前；
    // 若这楼随后又触发一次 CMR（紧接着 swipe/🔄，或 MVU 类改写插件重渲染），就会拿「编辑后正文」比
    // 「编辑前签名」→ 误判 contentChanged=重roll、多算一次线。此处提前把签名对齐到编辑后即根除。
    // 照 swiped 的盖章同款：编辑要不要更新线交给用户手点刷新键，与「编辑不自动重算」一致。
    // emit 时机：messageEditDone 先 renderEditedMessage 再 emit，故 chat[mid].mes 已是新正文，_floorSig 拿到的即新签名。
    if (_stListeners.edited) eventSource.removeListener?.(event_types.MESSAGE_EDITED, _stListeners.edited);
    _stListeners.edited = (mesId) => {
        linesFeature.onEdited({ mesId });
    };
    eventSource.on(event_types.MESSAGE_EDITED, _stListeners.edited);
    // 线·固定：用户发出下一条消息 → 上一 AI 楼层定稿，清掉它的 swipe 临时层（store 已是当前 swipe 的线）。
    if (_stListeners.sent) eventSource.removeListener?.(event_types.MESSAGE_SENT, _stListeners.sent);
    _stListeners.sent = (insertAt) => {
        linesFeature.onSent({ insertAt });
    };
    eventSource.on(event_types.MESSAGE_SENT, _stListeners.sent);
    // 生成态闸（防楼内块流式频闪）：ST 流式每 token 重写末楼 .mes_text 会冲掉线块/轴日历块，observer 若在流式间隙补块就「补→被冲→再补」肉眼频闪。
    // 用「流式活跃截止时间戳」自愈闸而非布尔闸：GENERATION_ENDED 只在停止按钮显示过时才发（script.js hideStopButton），
    // quiet/后台生成不显示停止按钮却照发 GENERATION_STARTED —— 布尔闸会被这类生成置真后永不清零、observer 从此罢工、楼内块全失。
    // 时间戳闸靠「最近流式 token 时间」续期、到点自动失效，绝不卡死。
    if (_stListeners.genStart) eventSource.removeListener?.(event_types.GENERATION_STARTED, _stListeners.genStart);
    _stListeners.genStart = (genType, _opts, dryRun) => {
        refreshStoryClockInjection();
        linesFeature.onGenerationStarted({ genType, dryRun });
    };
    eventSource.on(event_types.GENERATION_STARTED, _stListeners.genStart);
    if (_stListeners.streamTok) eventSource.removeListener?.(event_types.STREAM_TOKEN_RECEIVED, _stListeners.streamTok);
    _stListeners.streamTok = () => { linesFeature.onToken(); };
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, _stListeners.streamTok);
    if (_stListeners.genEnd) eventSource.removeListener?.(event_types.GENERATION_ENDED, _stListeners.genEnd);
    if (_stListeners.genStopped) eventSource.removeListener?.(event_types.GENERATION_STOPPED, _stListeners.genStopped);
    _stListeners.genEnd = () => {
        linesFeature.onGenerationEnded({ stopped: false });
    };
    _stListeners.genStopped = () => {
        linesFeature.onGenerationEnded({ stopped: true });
    };
    eventSource.on(event_types.GENERATION_ENDED, _stListeners.genEnd);
    eventSource.on(event_types.GENERATION_STOPPED, _stListeners.genStopped);
    // 面·大纲自动注入：独立监听，跟线彻底解耦（绝不复用 _stListeners.char——它 linesEnabled=false
    // 会 early-return，连坐大纲）。每隔 N 楼独立判定一次剧情是否推进到下一节点，推进则游标 +1。
    if (_stListeners.outlineJudge) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.outlineJudge);
    _stListeners.outlineJudge = messageId => outlineFeature.onCharacterMessage(messageId);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.outlineJudge);
    // 历·确认当前剧情日期。戳优先——戳开且本楼有可解析戳 → **每次**最新楼定型都直读落地、零 API、不进单调闸；
    // 读不到戳（漏打 / 「谷雨」无月日）才走单调闸 + almanacAutoDetect 决定是否攒够 N 楼调一次 API 兜底 → 写共享 dateAnchor。
    if (_stListeners.almanacJudge) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.almanacJudge);
    _stListeners.almanacJudge = async (messageId) => {
        if (!pluginEnabled()) return;   // 插件总关：停后台历日期判定
        const chat = getContext().chat;
        if (!Array.isArray(chat)) return;
        if (messageId !== chat.length - 1) return;
        // 戳优先：戳开且本楼有戳 → 每次最新楼定型都直读落地（零 API、幂等），**不进单调闸**——
        // 重roll/swipe 复用同 messageId，若被闸挡掉，戳从 919 翻 920 时显示跟了、锚点没跟（论坛 bug）。
        // 结果登记进日期协调器：同 renderKey 的并发渲染共享一次解析，杜绝重复 API。
        const renderKey = buildDateRenderKey(messageId);
        const bootstrap = consumeDateBootstrap(messageId);
        const clockResult = relandStoryClockAnchor({ suppressAftermath: bootstrap });
        if (clockResult.status !== 'no-date') {
            dateCoordinator.recordResult(renderKey, { ...clockResult, source: 'story-clock' });
            return;
        }
        // 切聊时已存在的精确 greeting/末楼只负责初始化日期显示；首次 CMR 绝不派发任何生成 API。
        if (bootstrap) {
            dateCoordinator.recordResult(renderKey, { ...clockResult, source: 'chat-bootstrap' });
            return;
        }
        // 到这＝戳关，或戳开但本楼读不到戳（漏打 / 「谷雨」无月日）→ API judge 兜底才需单调闸防重放/重算。
        if (messageId <= almanacLastJudgedMsgId) return;
        almanacLastJudgedMsgId = messageId;
        if (getSettings().almanacAutoDetect === false) return;
        if (++almanacJudgeCounter < getAlmanacJudgeInterval()) return;
        almanacJudgeCounter = 0;
        dateCoordinator.runOnce(renderKey, ({ signal }) => runJudgeDateStep({ messageId, signal }));   // fire-and-forget；runOnce 兼并发去重
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.almanacJudge);
    // 点不单独判定日期；共享善后刷新楼内窗口/轴面板/线日期，只有 scheduleAutoDetect 开启且未被时旅抑制时才后台重排点。
    // 暗账·标注：每 N 楼从正文捞新事件写库。独立开关(ledgerCaptureEnabled)/间隔/单调闸；默认关。
    if (_stListeners.ledgerCapture) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.ledgerCapture);
    _stListeners.ledgerCapture = async (messageId) => {
        if (!pluginEnabled()) return;   // 插件总关：停后台标注
        if (getSettings().ledgerCaptureEnabled !== true) return;
        const chat = getContext().chat;
        if (!Array.isArray(chat)) return;
        if (messageId !== chat.length - 1) return;
        if (messageId <= ledgerLastCapturedMsgId) return;
        ledgerLastCapturedMsgId = messageId;
        // 时旅首楼：标注由显式步骤接管（LEDGER_CAPTURE step），跳过自动标注，防重复 API
        if (isAutomationSuppressed(messageId, AUTOMATION_MODULES.LEDGER_CAPTURE)) return;
        if (++ledgerCaptureCounter < getLedgerCaptureInterval()) return;
        ledgerCaptureCounter = 0;
        runLedgerCaptureStep();   // fire-and-forget，自带守卫
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.ledgerCapture);
    // 暗历·判定（刷现状）：每 N 楼重算活跃条目「距今多久」、只让 AI 回该变的那几条。与标注共用 ledgerCaptureEnabled
    // 总闸，各自独立计数/间隔/单调闸——两车间隔不同、少同楼齐发；无活跃条目时 runLedgerJudgeStep 自己跳过、不空烧。
    if (_stListeners.ledgerJudge) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.ledgerJudge);
    _stListeners.ledgerJudge = async (messageId) => {
        if (!pluginEnabled()) return;   // 插件总关：停后台判定
        if (getSettings().ledgerCaptureEnabled !== true) return;
        const chat = getContext().chat;
        if (!Array.isArray(chat)) return;
        if (messageId !== chat.length - 1) return;
        if (messageId <= ledgerLastJudgedMsgId) return;
        ledgerLastJudgedMsgId = messageId;
        // 时旅首楼：判定由显式步骤接管（LEDGER_JUDGE step），跳过自动判定，防重复 API
        if (isAutomationSuppressed(messageId, AUTOMATION_MODULES.LEDGER_JUDGE)) return;
        if (++ledgerJudgeCounter < getLedgerJudgeInterval()) return;
        ledgerJudgeCounter = 0;
        runLedgerJudgeStep();   // fire-and-forget，自带守卫
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.ledgerJudge);
    // 暗历·注入重算（场景感知）：每出一楼就按最新正文重挑注入集——纯 JS 打分、零 API，故不设间隔/单调闸，
    // 让选择跟着场景走（正文提到谁/什么标签，那条就浮上来）。仅 ledgerInject 开时干活（refresh 内部再兜一层门控）。
    if (_stListeners.ledgerInjectRescore) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.ledgerInjectRescore);
    _stListeners.ledgerInjectRescore = async (messageId) => {
        if (!pluginEnabled()) return;
        if (getSettings().ledgerInject !== true) return;
        const chat = getContext().chat;
        if (!Array.isArray(chat) || messageId !== chat.length - 1) return;   // 只跟最新楼，别为改旧楼空转
        // 先重挑注入集（更新 ledger injection controller echo），再刷窗——本监听器在 char 之后触发，char 那趟冻的是
        // 上一楼的旧回显；这里重挑后刷窗，让最新楼的「标注打捞」框读到本楼实际注入的那几条并重冻快照。
        try { refreshLedgerInjection(); } catch {}
        try { refreshInlineWindow(true); } catch {}
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.ledgerInjectRescore);
    // 聊天改名（酒馆改 chat 文件名 = chatId 变）→ 把坐标收藏里旧 chatId 的记录迁到新名，
    // 否则收藏夹里那个聊天桶名不跟新、且跳转来源失效。newFileName/oldFileName 均不带后缀，
    // 与 ctx.chatId 同格式。仅坐标受影响（点线面间随 chat_metadata 走，改名由酒馆自己搬）。
    if (_stListeners.rename) eventSource.removeListener?.(event_types.CHAT_RENAMED, _stListeners.rename);
    _stListeners.rename = async (data) => {
        if (!pluginEnabled()) return;   // 插件总关：与"如同未安装"一致，不做锚点改名同步
        // ST 的 CHAT_RENAMED 事件里 oldFileName/newFileName 带 .jsonl 后缀（script.js 的
        // original_file/renamed_file），而 ctx.chatId 不带——不剥后缀就永远匹配不上，
        // 改名同步等于从没生效过（正是"改了所有名字坐标全没跟上"的根因）。
        const stripExt = v => String(v ?? '').replace(/\.jsonl$/i, '');
        const oldId = stripExt(data?.oldFileName), newId = stripExt(data?.newFileName);
        if (!oldId || !newId) return;
        coordinateRuntime?.feature?.onChatRenamed({ oldId, newId });
        try {
            // 改名后重载 chat，chat_id_hash 已随文件搬到新 chat 上；顺手传进去补到收藏上，
            // 让后续分桶/自愈有稳定键（改名多少次都并一个桶）。
            const hash = getContext()?.chatMetadata?.chat_id_hash ?? null;
            const n = await coordinateRuntime?.feature?.renameChatId(oldId, newId, newId, hash);
            if (n) coordinateRuntime?.feature?.open('chars');
        } catch (err) { console.warn('[7dayscal] 坐标改名同步失败', safeDiagnosticLog('axis', 'save', err)); }
    };
    eventSource.on(event_types.CHAT_RENAMED, _stListeners.rename);
    // 柏宝书就绪事件：加载顺序不固定，早期同步检测可能扑空而误报"未就绪"。
    // 柏宝书文档推荐监听 st-baibai-book:ready 兜底——就绪后清掉"仅警告一次"的闩，
    // 并在面板开着且选了柏宝书源时立刻把状态刷成"已就绪"。
    if (_bbbReadyListener) window.removeEventListener('st-baibai-book:ready', _bbbReadyListener);
    _bbbReadyListener = () => {
        if (!pluginEnabled()) return;   // 插件总关
        getMemText._bbbWarned = false;
        if (getSettings().useBaiBaiBook) { try { renderMemorySection(); } catch {} }
    };
    window.addEventListener('st-baibai-book:ready', _bbbReadyListener);
    // Track ST theme changes via MutationObserver on documentElement style
    _themeObserver?.disconnect();
    _themeObserver = new MutationObserver(() => {
        // Only auto mode follows ST; forced day/night ignores ST changes.
        if ((getSettings().themeMode || 'auto') !== 'auto') return;
        const t = detectSTTheme();
        if (t !== currentTheme) applyTheme(t);
    });
    _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    // 首屏落地插件总开关：若加载时已是关闭态，藏球 / 清块 / 断后台 / 撤注入（各首屏挂载虽已被 pluginEnabled 闸挡，
    // 这里兜底把已挂的悬浮球藏掉、把注入清干净）。开启态无需动——上面各首屏路径已正常挂载。
    if (!pluginEnabled()) applyPluginEnabled(false);
});
// ─── Config helpers ───────────────────────────────────────────────────────────

// ─── Plugin settings (persisted in ST's settings.json) ────────────────────────


// 剔除参数：解析用户输入（换行/逗号分隔的参数名）成去空去重的数组。
// 用于规避不接受某些参数（如 Gemini 代理不认 frequency_penalty）的兼容端点报 400。


// 机械任务分流用 cfg：仅供「记忆摘要 / 大纲推进判定」这类机械调用。
// 设了 utilityPresetId 且该预设有 url+key → 用该预设快照；否则退回主 cfg（loadCfg）。
// 其他生成类调用按各自调用方读取配置；空/无效时遵循现行默认路径。


// ─── API 存储快切：预设仓库 ────────────────────────────────────────────────────
// 预设是「整套 API 配置的命名快照」。切换后立即填入并应用该快照。


// 把一套 cfg（loadCfg 形状）存成预设。有 id 且已存在→覆盖(改名+更新内容)，否则新建。
// 返回被写入/新建的预设 id。


// 给已存预设改名（就地，不动 url/key/model 等）。空名→保留原名。


// ─── 插件总开关（③）───────────────────────────────────────────────────────────
// pluginEnabled 关 = 全隐身；injectEnabled 关 = 掐线/面/刻度潜伏注入（受 pluginEnabled 统辖）。

// 一键中断所有在飞的后台判定与生成（各域 controller 及日期检测/点后台任务），并清 re-entry 闸，
// 让重新开启后能干净重跑。照 CHAT_CHANGED 的中断序列集中一处。
function _abortAllBackground() {
    const ctx = getContext?.() || {};
    traceDiagnosticEvent('abort-boundary', { module: 'runtime', chatId: ctx.chatId ?? null, chatRevision: pointTaskOwners.currentChatRevision(), boundaryEpoch: chatBoundaryEpoch, abortReason: 'plugin-disabled', status: 'dispatch' });
    memory.abortAll('plugin-disabled');
    const activeTravel = timeTravel.getState();
    if (activeTravel) clearTimeTravelSession(activeTravel, { removeWaitingBlock: activeTravel.phase === 'waiting', reason: 'plugin-disabled' });
    _timeTravelSelectionSeq++;
    _activeTimeTravelSelection = null;
    customDialog.cancelActive();
    linesFeature.abortGeneration({ reason: 'plugin-disabled' });
    for (const c of [
        linesFeature.runtime.controller,
        pointState.scheduleAbortController,
        dateDetectionController.abortController, _autoRegenSchedAbort,
        ledgerCaptureController.abortController, ledgerJudgeController.abortController,
    ]) { try { c?.abort('plugin-disabled'); } catch {} }
    outlineFeature.abortAll('plugin-disabled');
    spaceFeature.abortAll('plugin-disabled');
    linesFeature.dashed.abort('plugin-disabled');
    pointState.scheduleAbortController = null;
    theaterFeature.onPluginDisabled();
    axisGenerationController.reset('plugin-disabled');
    _autoRegenSchedAbort = null;
    ledgerJudgeController.reset('plugin-disabled');
    ledgerCaptureController.reset('plugin-disabled');
    if (outlineMode) outlineFeature.chat.load();
}

// 插件总开关落地。关：藏悬浮球、清所有楼内块与坐标入口（由各 feature 内部闸兜底）、
// 断所有后台任务、撤各域潜伏注入。不关面板——用户往往正站在设置里切它，留着好即时切回。
// 开：按各子开关恢复——显示悬浮球、重挂楼内块与线/面/故事时钟/刻度注入、补锚点入口。事件监听不注销，靠各 listener 的 pluginEnabled() 闸空转。
function applyPluginEnabled(on) {
    const ctx = getContext();
    if (on) {
        if (theaterMode) theaterFeature.open();
        $(`#${FAB_ID}`).css('display', fabEnabled() ? '' : 'none');
        try { backfillLinesInlineBlocks(); } catch {}   // 重挂线/历/点楼内块 + 重设线潜伏注入
        try { outlineFeature.injection.refresh(); } catch {}       // 重设大纲潜伏注入
        try { refreshStoryClockInjection(); } catch {}    // 重设时间戳注入
        try { coordinateRuntime?.feature?.refreshSavedKeys(); coordinateRuntime?.feature?.scanButtons(); } catch {} // 补回锚点收藏入口
        try { refreshInlineWindow(true); } catch {}
        maybeApplyBoundCalendarTemplate().catch(error => {
            console.error('[SP calendar] 重新启用后角色默认历法自动应用失败', safeDiagnosticLog('axis', 'save', error));
            if (getSettings().notifyMode === 'full') showToast('角色默认历法没有自动应用成功', null, true);
        });
    } else {
        try { coordinateRuntime?.feature?.close?.(); } catch {}
        $(`#${FAB_ID}`).css('display', 'none');
        try { _clearAllInlineBoxes(); } catch {}
        _abortAllBackground();
        try { ctx.setExtensionPrompt?.(LINES_INJECT_KEY, ''); } catch {}
        try { outlineFeature.injection.clear(); } catch {}
        try { ctx.setExtensionPrompt?.(STORY_CLOCK_KEY, ''); } catch {}
        try { ledgerInjectionController.clear(); } catch {}
    }
}







// ─── In-game day-change detection (桥接到历·almTodayAnchor) ───────────────────
// days 模式（跟随局内时间）的推进检测：从历的权威「今天」取 {月-日}，变化即推进。
// 历史上这里读柏宝书 state.time，现已改为桥接 almTodayAnchor
// 兜底来源按现行 anchor 优先级解析；柏宝书未安装时仍可由其他可用上下文推进，并与历共用同一个「今天」。
// extractDayFromTime / _cnToNumber / _CN_* 仍被 almTodayAnchor、parseJudgedDate 复用，保留。


// 中文数字 → 阿拉伯数字（覆盖 0–99，足以处理古代年月日）。含农历「廿/卅」与大写/繁体（民国·契据式）。


// 抽出"这一天"的规范化 key。剥掉 era 前缀、时分秒尾巴以及数字前导零，
// 让同一天不同写法（"1287/04/01" ≡ "1287/4/1" ≡ "1287年4月1日"）落到同一
// 个 key 上。返回 null 表示无法识别 → 不推进。

// ─── 楼内渲染框·快照桥 ────────────────────────────────────────────────────
// 采集「当前最新」的点/线/历/锚点 → 一份快照对象。这是权威源（sp-store 缓存 + 锚点）的
// 一次性抓拍；写进某层 AI 楼的 message.extra 后即成为那层楼的「死历史」。
// 只读、无副作用：任何时候调都安全。
// rawArg：null=读当前视角活缓存（最新楼，现状不变）；字符串=快照里的线 raw（历史楼）。
// readOnly：true=历史楼，去掉逐条注入/删除按钮 + 标题条的「推进」按钮（旧楼不触发生成）。
// 历史楼不并虚线子块（虚线是全局冷知识、非那层楼的历史态）。
// 楼内「标注池」框（AI 楼，镜像线块）：显示当前实际打捞到的暗历条目。
// poolArg：历史楼传快照里冻的 pool [{id,事由,类型,起始锚,周期长度,到期锚,标签,锁}]；最新楼传 null → 读活账 ledger.listEntries()
//   （与线/点/历「null=读活缓存」同款：最新楼恒反映当前标注池，historical 楼看当时冻结的）。
// readOnly=false（最新楼）：summary 带「标注/更新」两文字胶囊、每条带「锁定/归档了结」；true（历史楼）：纯只读。
// 空池 → 返回 ''（该楼不挂此段；与线/点/历子块空态、及旧「空回显不挂」一致，默认开关下不冒空条）。
// 字段照标注池闭环：类型胶囊(上色) + 事由 + 起始/周期/终止 + 标签；不显现状（现状归「召回」框）。
// 统一楼内块由当前渲染窗口控制；历史楼保留各自快照，最新楼读活态。
// 虚线冷知识已折进 .sp-lines-inline 的 body（合并成一个楼内块），清线块即连虚线一并清；
// 仍带上 .sp-dashed-inline 兜底，扫掉合并前旧版本残留在 DOM 里的独立虚线块。
// 新楼层挂线块 + （可选）首次推进生成。渲染改由 refreshInlineWindow() 统一负责；
// 入口保留唯一真副作用——首次推进的线生成，以及推进前后的即时刷窗。
// Back-fill：切聊天/初始化/主开关切换时的入口。渲染交给窗口控制器；保留潜伏注入 refresh 真副作用。
async function backfillLinesInlineBlocks() {
    refreshLinesInjection();   // chat 切换/初始化/主开关切换 → 重设潜伏注入（关闭时内部会清空）
    refreshStoryClockInjection();   // 时间戳：首屏/切 chat/主开关一并重设常驻注入
    refreshLedgerInjection();       // 暗历注入：首屏/切 chat/主开关一并重设（关/空时内部自清）
    refreshInlineWindow(true);
}

// Refresh the inline block on the latest AI message using current cache.
// Called after the panel regenerates lines so the message-level block doesn't
// stay stale until page reload.
function syncLatestInlineBlock(expectedChatId = null) {
    // If caller passed a chatId snapshot, skip when chat changed mid-flight
    if (expectedChatId != null && getContext().chatId !== expectedChatId) return;
    refreshLinesInjection();   // 线变化（regen/advance/edit/delete 都汇流到这）→ 重设潜伏注入（这是本函数唯一「非渲染」真副作用，保留）
    refreshInlineWindow(true);  // 线数据变 → 立即重算渲染窗口（最新楼会冻快照+全功能重挂，历史楼各自快照）
}

// ─── 历·楼内日历块（只读，反映历+锚点，无生成）─────────────────────────────────
// 与线块平行、共存于最新 AI 楼。外壳（标题条）仿线：一个 <details>，收起时是扁扁的
// 「历 · N个日程」条，点整条即展开——配色/圆角/边框全走线的 .sp-inline-* 类。
// 展开后的内容是历自己的「往后六天」条：6 格（周X + M/D，从明天起，今天已在大头日期块里、
// 这里不重复），覆盖到历条目的日子高亮打点；窗口内有节日则每格可点、点下方就地展开当天安排（.sp-alm-sday）。
// 纯读 loadAlmanac()+锚点，不请求 API、不受 linesEnabled 影响，只受 almanacInlineEnabled 开关控制。
// itemsArg：null=读当前活历 loadAlmanac()（最新楼）；数组=快照里的历条目（历史楼）。
// anchorArg：null=读当前锚点 almTodayAnchor()；{month,day}=快照锚点。历本就只读，无按钮需 gate。
// 楼内轴渲染统一由 axisInlineRenderer 提供。

// 历楼内只读渲染由 axis inline seam 持有；宿主仅提供实时数据与纯历法 helper。
const axisInlineRenderer = createAxisInlineRenderer({
    settings: getSettings,
    loadItems: loadAlmanac,
    today: almTodayAnchor,
    calendar: loadCalDesc,
    weekdayRef: cal => almWeekdayRef(cal),
    dayOfYear: almDayOfYear,
    weekdayFor: almWeekdayFor,
    yearLength: calYearLen,
    monthDayFromDoy: almMonthDayFromDoy,
    weekdays: ALM_WEEKDAYS,
    itemCoversDoy: almItemCoversDoy,
    typeMeta: almTypeMeta,
    clamp: almClampInt,
    daysUntil: almDaysUntil,
    escapeHtml,
    monthName: calMonthName,
    cleanText,
});
inlineFeature?.destroy?.();
inlineFeature = createInlineFeature({
    getSettings, extensionSettings: extension_settings, getContext, loadAlmanac, almTodayAnchor, loadCalDesc,
    almWeekdayRef, almDayOfYear, almWeekdayFor, ALM_WEEKDAYS, escapeHtml, calMonthName, getDateAnchor,
    charStableKey, readCacheRaw, getCacheKey, parseCalendar, weatherGlyph, calHasEra, validRealDate,
    formatCalendarDate, formatStoryClockHeadParts, storyClockEnabled, latestStoryClock, parseJudgedDate, readStore,
    getLinesCacheKey, parseLines, linesFeature, snapshot, keyDesc, createWeekdayConsumerContext,
    storyWeekdayRefPure, ALM_CHAT_SCAN_LIMIT, pointInlineRenderer, axisInlineRenderer, $, _buildLedgerBlockHtml,
    buildUserRecall: _buildUserRecallBoxHtml,
    pluginEnabled, documentRef: document, windowRef: window,
    freezeSnapshot: freezeSnapshotToFloor,
    readSnapshot: id => snapshot.readSnapshot(id),
    resolveSnapshotCalendar: snap => snapshot.resolveSnapshotCalendar(snap, {
        fallback: readStore(keyDesc('caldesc-fallback', 'user', '')),
        marker: !!readStore(keyDesc('caldesc-fallback', 'user', '')),
        current: loadCalDesc(),
    }),
    chatMessage: floor => getContext()?.chat?.[floor]?.mes || '', parseStoryClock: parseStoryClockPure,
    coordinateChanged: () => coordinateRuntime?.feature?.onChatDomChanged?.(),
    isStreaming: () => linesFeature.isStreaming(),
    syncTheme: () => syncVectorGlyphTheme(document, currentTheme, (getSettings().themeMode || 'auto') !== 'auto'),
});
if (document.querySelector('#chat')) inlineFeature.init();
// ─── 线·伏笔潜伏注入（隐形注入主楼 AI）────────────────────────────────────────
// 把当前视角的活跃线（跳过终态 stage）以 SYSTEM 角色注入聊天上下文（IN_CHAT + depth），
// 让主楼 AI「心里有数」、把伏笔当暗流自然缓慢推进；聊天记录里不显示。默认关（opt-in）——
// 改 AI 行为且增加 token。刷新时机跟内联块同步（见 sync/backfill + 开关 handler）。
const LINES_INJECT_KEY   = 'sp_lines_latent';
// 重设潜伏注入。读当前视角活跃线；关闭或无活跃线时清空。幂等，可随处多调。
function refreshLinesInjection() {
    return linesFeature.injection?.refresh?.();
}

// 历·自动确认日期的判定状态（抄 outline 那套三闸：防重入 + 单调 msgId + 攒够计数）。仅 API 兜底路用；戳优先路每楼直读不占这些。
let   almanacLastJudgedMsgId = -1;
let   almanacJudgeCounter    = 0;

// 暗账·标注的判定状态（自成一套三闸：防重入 + 单调 msgId + 攒够计数）。与历/点判定各自独立。
let   ledgerLastCapturedMsgId = -1;
let   ledgerCaptureCounter   = 0;
// 暗账·判定（刷现状）的一套闸，独立于标注：判定车重算「距今多久」、只让 AI 回该变的那几条。
let   ledgerLastJudgedMsgId  = -1;
let   ledgerJudgeCounter     = 0;

// 历·API 兜底判定的间隔（缺省/非法 → 3；≥1）。抄 getOutlineJudgeInterval。
function getAlmanacJudgeInterval() {
    const n = Number(getSettings().almanacJudgeInterval);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

// 暗账标注间隔（缺省/非法 → 5；≥1）。抄 getAlmanacJudgeInterval。
function getLedgerCaptureInterval() {
    const n = Number(getSettings().ledgerCaptureInterval);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}

// 暗账判定（刷现状）间隔（缺省/非法 → 4；≥1）。抄 getLedgerCaptureInterval。
function getLedgerJudgeInterval() {
    const n = Number(getSettings().ledgerJudgeInterval);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

// ─── 时间戳·时间锚点体系（注入 + 结构化回读 + 只读显示）─────────────────────────
// 目标：给整个构画一个「跟着剧情走」的坚固时间源。做法＝强制注入一段提示词，让主楼 AI
// 每楼正文首尾各打一个 HTML 注释时间戳（<!-- SDC-start … --> / <!-- SDC-end … -->），
// 我们再从 chat 末尾往回扫读回。HTML 注释酒馆天然不渲染，无需像柏宝书那样加隐藏正则；
// 但注释必须留在 message.mes 里，下楼主模型才看得见上楼 end、以它为基准往前推。
// 命门（吸收自柏宝书方法论、提示词全自写）：
//   ① 起止双界——一楼是一段区间不是一个点，故首尾两个戳；
//   ② 标签留正文——绝不删，靠它让下楼继承基准，增量在模型脑内、输出成绝对值；
//   ③ 往回扫 + 兜底——读「当前时间」从末楼往前扫第一条可解析的（end 优先），漏了也不崩。
// 当前链路会将时间戳注入、解析为结构化日期，并在完整戳存在时优先落入共享锚；缺失时按设置走 API 兜底。
// 首尾注释的正则（宽松容错：允许注释内外多余空白；内容自由，不强制格式）。

// 时间戳总开关（不受 injectEnabled 统辖，只受 pluginEnabled + 本开关；见 refreshStoryClockInjection）。默认开——用户定：这是全插件时间地基，值得常驻。
// storyClockEnabled 已迁至轴控制器。

// 自写提示词（吸收柏宝书三套路：拔高到系统强制 / 以上楼 end 为基准推进 / 禁用「某天」敷衍；
// 措辞、示例、标签名全原创，绝不照搬）。粒度到小时，年份可写可略。

// 取生效的强注词：用户在设置里二改了(非空)就整段用他的；留空用内置默认（默认词随插件更新）。
// 重设时间戳注入。关闭时清空。幂等，可随处多调。照 refreshLinesInjection 套路。
// refreshStoryClockInjection 已迁至 storyClockController。

// 从单楼正文解析首尾戳，并供结构化日期解析使用。返回 { start, end }（各为去空白后的原文字符串，缺失=null）。
// 从 chat 末尾往回扫，取最近一楼「可解析出至少一个戳」的 AI 楼。end 优先作「当前时间」。
// 漏了/坏了不崩：某楼无戳就继续往上找；全无 → 返回 null（显示层据此不显示这一行）。
// latestStoryClock 已迁至 story-clock.js。

// 从最近一楼的戳解析出结构化 {month,day}。end 优先(当前时间)、退 start。无戳/解析不出 → null（交回兜底）。
// storyClockDate 已迁至 story-clock.js。

// 自定义历法下，正文用的是自定义月名（如「霜月」），公历式发问会答非所问。带上历法描述、
// 并允许 AI 用「第M月D日」或月名作答；内置公历返回上面的原版 prompt（零行为变化）。

// ═══ 暗账·标注 ═════════════════════════════════════════════════════════════════
// 构画 AI 从最近正文里捞「需按时间追踪」的新事件，标注入 sp-ledger（此时·此物·此状态）。
// 起始锚 = 此刻楼层 + 历「今天」(almTodayAnchor)，钉死不改；判定与注入由同域流程负责。
// 触发：每 N 楼自动车(runLedgerCaptureStep 无参) + 轴面板「刻度」页手动「立即标注」(manual=true)。
// capture 窗口与来源批次大小由 business/ledger/capture.js 统一提供。

// ═══ 暗历③·判定·刷现状 ═══════════════════════════════════════════════════════
// 每 N 楼把活跃条目连同「距今几天」（纯 JS 算好，LLM 不擅长日期差）喂给构画 AI，
// 只让它回「状态该随时间变化的那几条」的新现状/了结/周期滚动。CODE 算数、AI 只下结论——正是暗历立意。
// ═══════════════════════════════════════════════════════════════════════════
//  检索·注入前置选择器（挑「哪几条」喂主楼 AI——全亮注入会撑爆 token 且喧宾夺主）
// ═══════════════════════════════════════════════════════════════════════════
// 策略＝场景感知：读最近几楼正文，正文提到某条的牵扯/标签就加权，叠在「临近到期/用户锁/
// 近期登记」基础权重上，砍到 N 条上限；活跃条少于上限时全带（兜底）。已了结由 listEntries
// 天然排除。留 RAG 口子：scoreLedgerEntry 整个可换（将来接 arg 检索只改这一处打分器）。

// 最近 N 楼 AI 正文拼成一段（去标记）。供场景加权命中判断；只读、无副作用。
// ─── 共享锚点善后 ───────────────────────────────────────────────────────────
// 任何一处改「今天」锚点（自动判定 applyDetectedDate / 历面板 ±1天·改·恢复自动）后都走这里，统一善后：
//   1) 刷当前渲染窗口与轴面板；2) 仅在 scheduleAutoDetect 开启且未被时旅抑制时后台重排点。
// 点连带走 syncPointToToday(true)：其自带「点没生成过就 no-op」「_almSyncingPoint 重入合并」「pointState.isGenerating/
// chatId/abort」守卫，fire-and-forget 安全；不占前台 pointState.isGenerating 锁。外层仅在 scheduleAutoDetect 开启且未被时旅抑制时调用。
function runAnchorAftermath() {
    syncLatestAlmanacBlock();
    syncLatestScheduleBlock();
    // 星期锚属于纯显示上下文：锚到位/变化时用现有 raw 重画当前点面板，不写 store、不请求 API。
    if (!pointState.isGenerating) {
        refreshCachedSchedule(currentView, charViewName, {
            setCached: html => { pointState.cachedSchedule = html; },
            setBody,
            visible: !outlineMode && !linesMode && !spaceMode && !theaterMode && !axisState.almanacMode && $(`#${MODAL_ID}`).is(':visible'),
        });
    }
    const _linesFloorId = (getContext().chat?.length ?? 0) - 1;
    const _linesDay = almTodayAnchor();
    void linesFeature.onDateAftermath({ messageId: _linesFloorId, chatId: getContext().chatId, day: _linesDay ? `${+_linesDay.month}-${+_linesDay.day}` : null });
    if (axisState.almanacMode) renderAlmanacPanel();
    // 点·后台自动跟随「今天」：仅在开关开时才自动重排点（每次一 API）；关（默认）时点原地不动，
    // 用户想对齐今天时去点面板手动刷新即可。syncPointToToday 内部还有「点从未生成过就 no-op」守卫，双保险。
    // 时旅首楼：点重排由显式步骤接管（POINT step），此处跳过自动跟随，防重复 API。
    if (getSettings().scheduleAutoDetect === true) {
        const floorId = (getContext().chat?.length ?? 1) - 1;
        const pointSuppressed = Number.isInteger(floorId) && floorId >= 0 && isAutomationSuppressed(floorId, AUTOMATION_MODULES.POINT);
        if (!pointSuppressed && schedulePointNeedsSync({ view: 'user', charName: '' })) {
            syncPointToToday(true, { targetScope: { view: 'user', charName: '' } });
        }
    }
}

// schedulePointNeedsSync() —— 判断后台跟随/时旅流程是否仍有 pending follow-up 需要补同步。
function schedulePointNeedsSync(target = { view: 'user', charName: '' }, targetDate = null) {
    const view = target?.view === 'char' ? 'char' : 'user';
    const charName = view === 'char' ? String(target?.charName || '').trim() : '';
    const cacheKey = getCacheKey(view, charName);
    if (!cacheKey) return false;
    const raw = readStore(cacheKey)?.raw || '';
    return pointScheduleNeedsDateSync(raw, targetDate || almTodayAnchor());
}

// syncPointToToday() —— 自动跟随、时旅及 pending follow-up 共用的控制器 facade；将当前视角点重排到共享「今天」。
// 绝不占用 pointState.isGenerating（前台 UI 锁，sidebar 切换靠它挡）——后台占了会把整个面板卡死；防 race 靠自带 abort + 落地前重查。
let _autoRegenSchedAbort = null;
async function syncPointToToday(auto = false, travelContext = null) { return pointController.syncPointToToday(auto, travelContext); }
// 跨模块跳转只复用现有侧栏切换，并在目标 DOM 就绪后做可选预填。
function openPluginViewWithPrefill(view, inputSelector = '', prefill = '') {
    showPanel();
    const $tab = $in(`.sp-side-tab.sp-view-btn[data-view="${view}"]`);
    if (!$tab.hasClass('sp-view-active')) $tab.trigger('click');
    if (!inputSelector || !prefill) return Promise.resolve(true);
    return new Promise(resolve => setTimeout(() => {
        // 面板整棵在 shadow 内，须用 $in 查 shadowRoot（全局 $ 穿不进影子边界 → 找不到输入框）
        const $input = $in(inputSelector);
        if (!$input.length) { resolve(false); return; }
        const old = String($input.val() || '').trimEnd();
        if (!old.includes(prefill)) $input.val(old ? `${old}\n\n${prefill}` : prefill);
        autoGrowTextarea($input[0]);
        $input.trigger('focus');
        resolve(true);
    }, 0));
}

function initChatObserver() {
    if (typeof inlineFeature !== 'undefined' && inlineFeature) {
        inlineFeature.init();
        return;
    }
    const chat = document.querySelector('#chat');
    if (!chat) { setTimeout(initChatObserver, 600); return; }
    let timer = null;
    new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            coordinateRuntime?.feature?.onChatDomChanged();
            if (!linesFeature.isStreaming()) refreshInlineWindow();
        }, 400);
    }).observe(chat, { childList: true, subtree: true });
}

function injectExtButton() {
    // No drawer content — panel opened via magic wand or FAB
    const wandHtml = `
        <div id="sp_open_wand" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-calendar-days extensionsMenuExtensionButton" title="打开构画"></div>
            <span>构画</span>
        </div>`;

    function mountWandBtn() {
        const c = document.getElementById('sp_wand_container') || document.getElementById('extensionsMenu');
        if (!c || document.getElementById('sp_open_wand')) return false;
        c.insertAdjacentHTML('beforeend', wandHtml);
        document.getElementById('sp_open_wand')?.addEventListener('click', openSchedule);
        return true;
    }
    if (!mountWandBtn()) {
        const obs = new MutationObserver(() => { if (mountWandBtn()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
    }
}

// 悬浮球「插件在忙」呼吸灯：引用计数。所有 LLM 请求都经唯一咽喉 postChatCompletion，
// 那里进 +1 / finally -1，故点/线/面/棱/历/暗历标注/暗历判定/写记忆/间——无论自动手动、
// 无论并发几路，只要还有一路在飞就呼吸，全部落地才熄。独立 class（sp-fab-busy）不碰点的
// sp-btn-generating/done，两套并存互不干扰。计数只增减、不直接读 pointState.isGenerating 那些分散旗标，
// 天然免漏灯/卡灯。
let _fabBusyCount = 0;
function setFabBusy(on) {
    _fabBusyCount = Math.max(0, _fabBusyCount + (on ? 1 : -1));
    $(`#${FAB_ID} .sp-fab-btn`).toggleClass('sp-fab-busy', _fabBusyCount > 0);
}

function setExtBtnState(state) {
    // 魔法棒(#sp_open_wand)生成态变色太不显眼、用户根本看不到，故不再给它挂状态类——生成指示统一交给悬浮球呼吸灯。
    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
    // 点生成中只锁「我/TA」子切换（本次生成绑定当前视角，中途换视角无意义，另有 .sp-view-btn 守卫兜底）；
    // 侧栏模块 tab(历/线/面/棱/锚) 绝不锁——切模块随时可用（点正文按状态重建，见 .sp-view-btn 处理器 schedule 分支）。
    $in('.sp-sub-toggle').toggleClass('sp-locked', state === 'generating');
}

// ─── FAB ─────────────────────────────────────────────────────────────────────

function injectFab() {
    let savedPos = null;
    try { savedPos = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null'); } catch { /* 位置数据损坏则忽略，不能让 FAB 注入整个崩掉 */ }
    const mobile = isMobile();
    const posStyle = (!mobile && savedPos)
        ? `left:${savedPos.left}px;top:${savedPos.top}px;right:auto;bottom:auto;`
        : '';
    const html = `<div id="${FAB_ID}" style="position:fixed;z-index:2000000;${posStyle}${fabEnabled() ? '' : 'display:none'}">
        <button class="sp-fab-btn sp-${currentTheme}" title="构画"
            style="transform:translateZ(0);clip:auto;">
            ${PEN_ICON_SVG}
        </button>
    </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (nowMobile && !wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) { fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = ''; }
            const sheet = inEl('.sp-sheet');
            if (sheet) { sheet.style.left = ''; sheet.style.top = ''; sheet.style.right = '';
                         sheet.style.transform = ''; sheet.style.width = ''; sheet.style.height = '';
                         sheet.style.maxHeight = ''; sheet.style.maxWidth = ''; }
        } else if (!nowMobile && wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) {
                let sp = null;
                try { sp = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null'); } catch { /* 位置数据损坏则忽略 */ }
                if (sp) {
                    fab.style.left   = Math.min(sp.left, window.innerWidth  - 60) + 'px';
                    fab.style.top    = Math.min(sp.top,  window.innerHeight - 60) + 'px';
                    fab.style.right  = 'auto';
                    fab.style.bottom = 'auto';
                }
            }
        }
        wasMobile = nowMobile;
    });

    $(`#${FAB_ID}`).on('mousedown', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
        $(document)
            .on('mousemove.fabdrag', function (ev) {
                if (!fabDragState) return;
                if (Math.abs(ev.clientX - fabDragState.startX) > 5 || Math.abs(ev.clientY - fabDragState.startY) > 5) fabDragged = true;
                if (!fabDragged) return;
                const f = document.getElementById(FAB_ID);
                f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ev.clientX - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
                f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ev.clientY - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
                f.style.right  = 'auto';
                f.style.bottom = 'auto';
            })
            .on('mouseup.fabdrag', onFabDragEnd);
    });
    document.getElementById(FAB_ID).addEventListener('touchstart', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, origLeft: rect.left, origTop: rect.top };
        document.addEventListener('touchmove', onFabTouchMove, { passive: false });
        document.addEventListener('touchend', onFabDragEnd);
        document.addEventListener('touchcancel', onFabDragEnd);   // 同 divider：手机端被滚动/系统打断发的是 touchcancel，漏接就黏手
    }, { passive: true });

    $(`#${FAB_ID} .sp-fab-btn`).on('click', function () {
        if (!fabDragged) {
            $(`#${MODAL_ID}`).is(':visible') ? closePanel() : openSchedule();
        }
    });
}

function onFabTouchMove(ev) {
    if (!fabDragState) return;
    // 自愈：触点已全部离开却还在收 move（touchcancel 漏接）→ 收尾，兼防 ev.touches[0] 取空崩。
    if (!ev.touches || ev.touches.length === 0) { onFabDragEnd(); return; }
    const ex = ev.touches[0].clientX;
    const ey = ev.touches[0].clientY;
    if (Math.abs(ex - fabDragState.startX) > 5 || Math.abs(ey - fabDragState.startY) > 5) fabDragged = true;
    if (!fabDragged) return;
    ev.preventDefault();
    const f = document.getElementById(FAB_ID);
    f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ex - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
    f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ey - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
    f.style.right  = 'auto';
    f.style.bottom = 'auto';
}
function onFabDragEnd() {
    if (fabDragged) {
        const f = document.getElementById(FAB_ID);
        const r = f.getBoundingClientRect();
        localStorage.setItem('sp-fab-pos', JSON.stringify({ left: r.left, top: r.top }));
    }
    fabDragState = null;
    $(document).off('mousemove.fabdrag mouseup.fabdrag');
    document.removeEventListener('touchmove', onFabTouchMove);
    document.removeEventListener('touchend', onFabDragEnd);
    document.removeEventListener('touchcancel', onFabDragEnd);
}

function injectModal() {
    const cfg = loadCfg();
    const hasCustomApi = !!(cfg.url && cfg.key);
    // 弹窗宿主独立于主面板：主面板关闭时仍保持可见，空宿主不拦截页面点击。
    const dialogHost = document.createElement('div');
    dialogHost.id = DIALOG_HOST_ID;
    dialogHost.style.cssText = 'position:fixed;inset:0;z-index:2000003;pointer-events:none';
    _spDialogShadow = dialogHost.attachShadow({ mode: 'open' });
    _spDialogShadow.innerHTML = `
        <link rel="stylesheet" href="${EXT_BASE}style.css">
        <link rel="stylesheet" href="${ST_BASE}css/fontawesome.min.css">`;
    document.documentElement.appendChild(dialogHost);
    const html = `
            <div class="sp-backdrop"></div>
            <div class="sp-sheet">
                <aside class="sp-sidebar">
                    <nav class="sp-sidebar-tabs" aria-label="主视图">
                        <button class="sp-side-tab sp-view-btn sp-view-active" data-view="schedule">
                            <span class="sp-tab-glyph" aria-hidden="true"><svg class="sp-tab-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/></svg></span>
                            <span class="sp-tab-label">点</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="almanac">
                            <span class="sp-tab-glyph" aria-hidden="true"><svg class="sp-tab-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="4" x2="8" y2="20"/><line x1="8" y1="8" x2="15" y2="8"/><line x1="8" y1="12" x2="15" y2="12"/><line x1="8" y1="16" x2="15" y2="16"/></svg></span>
                            <span class="sp-tab-label">轴</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="lines">
                            <span class="sp-tab-glyph" aria-hidden="true"><svg class="sp-tab-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="20"/><circle cx="12" cy="4" r="2.2" fill="currentColor" stroke="none"/><circle cx="12" cy="20" r="2.2" fill="currentColor" stroke="none"/></svg></span>
                            <span class="sp-tab-label">线</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="outline">
                            <span class="sp-tab-glyph" aria-hidden="true"><svg class="sp-tab-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 L16.5 12 L12 21 L7.5 12 Z"/></svg></span>
                            <span class="sp-tab-label">面</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="space">
                            <span class="sp-tab-glyph" aria-hidden="true"><svg class="sp-tab-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/></svg></span>
                            <span class="sp-tab-label">间</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="theater">
                            <span class="sp-tab-glyph" aria-hidden="true"><svg class="sp-tab-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5 L13 12 L9 19 L5 12 Z"/><path d="M15 5 L19 12 L15 19 L11 12 Z" stroke-dasharray="2.5 2.5"/></svg></span>
                            <span class="sp-tab-label">棱</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="anchor">
                            <span class="sp-tab-glyph" aria-hidden="true"><svg class="sp-tab-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 L6 18 L20.5 18"/><circle cx="14" cy="9.4" r="1.9" fill="currentColor" stroke="none"/></svg></span>
                            <span class="sp-tab-label">坐标</span>
                        </button>
                    </nav>
                    <div class="sp-sidebar-spacer"></div>
                    <nav class="sp-sidebar-tabs sp-sidebar-util" aria-label="工具">
                        <button class="sp-side-tab sp-settings-btn" aria-label="设置">
                            <span class="sp-tab-glyph" aria-hidden="true">⚙</span>
                        </button>
                    </nav>
                </aside>

                <div class="sp-content-col">
                    <header class="sp-content-head">
                        <h1 class="sp-content-title" id="sp-content-title">点</h1>
                        <button class="sp-module-intro-btn" id="sp-module-intro-btn" title="这个模块是干嘛的？" aria-label="模块介绍"><i class="fa-regular fa-circle-question"></i></button>
                        <div class="sp-sub-toggle-wrap" id="sp-sub-toggle-wrap">
                            <div class="sp-sub-toggle" id="sp-sub-toggle">
                                <button class="sp-view-btn sp-sub-btn sp-view-active" data-view="user">我</button>
                                <button class="sp-view-btn sp-sub-btn sp-ta-trigger" data-view="char" id="sp-ta-trigger"><span class="sp-ta-label">TA</span><i class="fa-solid fa-caret-down sp-ta-caret"></i></button>
                            </div>
                            <div class="sp-ta-drawer" id="sp-ta-drawer" style="display:none"></div>
                        </div>
                        <div class="sp-head-tools">
                            <button class="sp-icon-btn sp-theme-toggle-btn" title="${themeToggleTitle()}"><i class="fa-solid ${themeToggleIcon()}"></i></button>
                            <button class="sp-icon-btn sp-fab-toggle-btn${fabEnabled() ? ' sp-btn-active' : ''}" title="悬浮按钮"><i class="fa-regular fa-circle-dot"></i></button>
                            <button class="sp-icon-btn sp-close-btn"    title="关闭"><i class="fa-solid fa-xmark" style="font-size:var(--sp-fs-100)"></i></button>
                        </div>
                        <div class="sp-module-intro-pop" id="sp-module-intro-pop" style="display:none"></div>
                    </header>

                    <!-- Settings overlay: covers content-col only, sidebar stays visible -->
                    <div id="sp-settings-overlay" class="sp-settings-overlay" style="display:none">
                        <div class="sp-settings-header">
                            <span class="sp-settings-title"><i class="fa-solid fa-gear"></i> 设置</span>
                            <button class="sp-icon-btn sp-settings-close-btn" title="关闭设置"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        <div class="sp-settings-body">

                            <!-- ═══════════ 总开关 ═══════════ -->
                            <div class="sp-settings-total-row" id="sp-settings-total">
                                <label class="sp-mode-opt">
                                    <input type="checkbox" id="sp-plugin-enabled" ${getSettings().pluginEnabled !== false ? 'checked' : ''}>
                                    <span>启用构画</span>
                                </label>
                                <label class="sp-mode-opt" id="sp-storyclock-section">
                                    <input type="checkbox" id="sp-storyclock-enabled" ${getSettings().storyClockEnabled !== false ? 'checked' : ''}>
                                    <span>时间戳</span>
                                </label>
                                <p class="sp-cfg-hint">全局时间锚点，包含星期判定。由主楼 AI 随回复输出，构画只读取、解析和展示，不会自行生成；是否出现、格式完整与时间合理取决于模型是否遵循提示词和主楼剧情质量，缺失或不完整时无法凭空补出可靠时间，可能让时间判断失真。</p>
                            </div>

                            <!-- ═══════════ 通用设置 ═══════════ -->
                            <details class="sp-settings-layer">
                                <summary class="sp-settings-layer-title">通用设置</summary>
                                <div class="sp-settings-layer-body">

                            <!-- 全局设置 1：API（默认折叠：首次配置后基本不再动，无需默认展开） -->
                            <details class="sp-settings-section">
                                <summary class="sp-settings-section-title">API</summary>
                                <div class="sp-settings-section-body">
                                    <div class="sp-api-notice ${hasCustomApi ? 'sp-notice-ok' : 'sp-notice-warn'}">
                                        <i class="fa-solid ${hasCustomApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                                        ${hasCustomApi
                                            ? '已配置独立 API，后台生成不影响聊天'
                                            : '未配置独立 API：生成期间将<b>占用聊天通道</b>，无法同时聊天'}
                                    </div>
                                    <p class="sp-cfg-hint">留空则使用酒馆当前模型</p>

                                    <!-- API 存储快切：点假框→就地展开内联预设列表（非原生 select 弹窗，避开 WebView 里弹层被插件盖住）；选一项填入下方输入框即生效；＋新增按域名自动命名、🗑删除，均即时落 settings.json -->
                                    <div class="sp-preset-row">
                                        <button type="button" id="sp-preset-box" class="sp-preset-box" title="选择 API 预设">
                                            <span id="sp-preset-label" class="sp-preset-label">选择预设…</span>
                                            <i class="fa-solid fa-chevron-down sp-preset-caret"></i>
                                        </button>
                                        <button id="sp-preset-save" class="sp-fetch-btn" title="把当前这套 API 设置存为新预设"><i class="fa-solid fa-plus"></i></button>
                                        <button id="sp-preset-del" class="sp-fetch-btn" title="删除当前选中的预设"><i class="fa-solid fa-trash"></i></button>
                                    </div>
                                    <div id="sp-preset-list" class="sp-preset-list" style="display:none"></div>
                                    <p id="sp-preset-hint" class="sp-cfg-hint sp-preset-hint" style="display:none"></p>
                                    <input id="sp-cfg-url" class="sp-input" type="url"
                                           placeholder="Base URL，如 https://api.openai.com/v1"
                                           value="${escapeAttr(cfg.url || '')}">
                                    <div class="sp-key-row">
                                        <input id="sp-cfg-key" class="sp-input sp-key-input" type="password"
                                               placeholder="API Key" value="${escapeAttr(cfg.key || '')}">
                                        <button id="sp-key-toggle" class="sp-eye-btn"><i class="fa-solid fa-eye"></i></button>
                                    </div>
                                    <div class="sp-model-row">
                                        <input id="sp-cfg-model" class="sp-input sp-model-input" type="text"
                                               placeholder="模型名称，如 gpt-4o-mini"
                                               value="${escapeAttr(cfg.model || '')}">
                                        <button id="sp-fetch-models" class="sp-fetch-btn" title="拉取模型列表">
                                            <i class="fa-solid fa-list"></i>
                                        </button>
                                    </div>
                                    <details id="sp-model-list-section" class="sp-model-list-section" style="display:none">
                                        <summary class="sp-model-list-summary">
                                            <i class="fa-solid fa-chevron-right sp-model-list-chevron"></i>
                                            <span id="sp-model-list-count">已加载 0 个模型</span>
                                        </summary>
                                        <div class="sp-model-list-body">
                                            <input type="text" id="sp-model-list-search" class="sp-input sp-model-list-search" placeholder="搜索模型…" autocomplete="off">
                                            <div id="sp-model-list-items" class="sp-model-list-items"></div>
                                        </div>
                                    </details>

                                    <details class="sp-adv-api" style="margin-top:10px">
                                        <summary class="sp-adv-api-summary">接口高级选项</summary>
                                        <div class="sp-adv-api-body">
                                            <p class="sp-cfg-hint" style="margin-top:8px">
                                                <b>剔除参数</b>：发送前从请求里删掉这些字段，规避接口对某些参数报 400。多个用换行或逗号分隔，只填参数名。
                                            </p>
                                            <textarea id="sp-cfg-exclude" class="sp-input sp-exclude-input" rows="2"
                                                      placeholder="如：frequency_penalty&#10;presence_penalty">${escapeHtml((cfg.excludeParams || []).join('\n'))}</textarea>
                                            <div class="sp-mode-opt" style="margin-top:8px">
                                                <span>请求超时</span>
                                                <input id="sp-cfg-timeout" class="sp-input sp-interval-input" type="number" min="5" max="600" value="${escapeAttr(String(cfg.timeoutSec || 180))}">
                                                <span>秒</span>
                                            </div>
                                            <label class="sp-mode-opt" style="margin-top:6px">
                                                <input type="checkbox" id="sp-cfg-stream" ${cfg.stream ? 'checked' : ''}>
                                                <span>流式传输</span>
                                            </label>
                                        </div>
                                    </details>

                                    <div class="sp-preset-actions" id="sp-preset-actions">
                                        <button id="sp-preset-update" class="sp-save-btn" type="button"></button>
                                        <span id="sp-preset-sync-state" class="sp-cfg-hint" aria-live="polite"></span>
                                    </div>

                                    <hr class="sp-mem-divider">
                                    <label class="sp-cfg-group">机械任务分流</label>
                                    <!-- 机械任务分流：把「记忆摘要 / 大纲推进判定」这类机械调用可选路由到某个预设（如便宜小模型）；生成类始终走上面主 API。选项即时生效落 settings.json，无需点保存。留空=不分流 -->
                                    <div class="sp-util-preset-block">
                                        <p class="sp-cfg-hint">记忆摘要、日期 / 大纲判定这类机械调用改走此预设（如便宜小模型省钱）；正式生成始终走主 API。即时生效，无需保存。</p>
                                        <div class="sp-preset-row">
                                            <button type="button" id="sp-util-preset-box" class="sp-preset-box" title="选择机械任务预设">
                                                <span id="sp-util-preset-label" class="sp-preset-label">跟随主 API（不分流）</span>
                                                <i class="fa-solid fa-chevron-down sp-preset-caret"></i>
                                            </button>
                                        </div>
                                        <div id="sp-util-preset-list" class="sp-preset-list" style="display:none"></div>
                                    </div>
                                </div>
                            </details>

                            <!-- 全局设置 2：世界书 -->
                            <details class="sp-settings-section" id="sp-wi-section">
                                <summary class="sp-settings-section-title">世界书</summary>
                                <div class="sp-settings-section-body" id="sp-wi-body">
                                    <p class="sp-cfg-hint">这里完整显示当前聊天关联来源里的所有条目。条目首次出现时会镜像酒馆开关，之后勾选状态按当前聊天独立保存；实际注入仍须通过酒馆 🔵常驻／🟢关键词等激活规则。构画取消勾选或整本排除只会进一步收窄，不会替酒馆激活条目。</p>
                                    <div id="sp-wi-list" class="sp-wi-list">
                                        <span class="sp-cfg-hint">（打开设置时自动加载）</span>
                                    </div>
                                    <hr class="sp-mem-divider">
                                    <details class="sp-wi-exclude-drawer">
                                        <summary class="sp-wi-exclude-drawer-head">
                                            <span class="sp-wi-exclude-drawer-title">全局排除</span>
                                            <span id="sp-wi-exclude-count" class="sp-wi-exclude-drawer-count"></span>
                                        </summary>
                                        <div class="sp-wi-exclude-drawer-body">
                                            <p class="sp-cfg-hint">勾选的世界书构画<strong>一律不读</strong>——优先级高于上面的挑选，即便某角色卡关联或全局启用了它也照样跳过。适合把「只给主楼 AI 读」的大部头设定书排除在点/线/轴/刻度判定之外。<strong>全局生效，对所有角色卡通用。</strong></p>
                                            <input type="text" id="sp-wi-exclude-search" class="sp-input sp-wi-exclude-search" placeholder="查找世界书名…" autocomplete="off">
                                            <div id="sp-wi-exclude-list" class="sp-wi-exclude-list">
                                                <span class="sp-cfg-hint">（展开时自动加载）</span>
                                            </div>
                                        </div>
                                    </details>
                                </div>
                            </details>

                            <!-- 全局设置 3：记忆 -->
                            <details class="sp-settings-section" id="sp-mem-section">
                                <summary class="sp-settings-section-title">记忆</summary>
                                <div class="sp-settings-section-body" id="sp-mem-body">
                                    <label class="sp-cfg-group">记忆源</label>
                                    <label class="sp-mode-opt sp-mem-source-toggle">
                                        <input type="checkbox" id="sp-mem-source-bbb">
                                        <span>使用柏宝书作为记忆源</span>
                                    </label>
                                    <div id="sp-mem-bbb-status" class="sp-cfg-hint" style="display:none"></div>
                                    <label class="sp-mode-opt sp-mem-source-toggle">
                                        <input type="checkbox" id="sp-mem-source-anima">
                                        <span>使用 Anima 作为记忆源</span>
                                    </label>
                                    <div id="sp-mem-anima-status" class="sp-cfg-hint" style="display:none"></div>
                                    <div id="sp-mem-anima-options" class="sp-mode-opt" style="display:none">
                                        <span>外置记忆召回条数</span>
                                        <input id="sp-mem-anima-recall" class="sp-input sp-interval-input" type="number" min="1" max="50" step="1" value="20">
                                    </div>
                                    <label class="sp-mode-opt sp-mem-source-toggle">
                                        <input type="checkbox" id="sp-mem-source-database">
                                        <span>使用数据库作为记忆源</span>
                                    </label>
                                    <div id="sp-mem-database-worldbook-options" class="sp-mode-opt" style="display:none">
                                        <span>数据库纪要所在世界书</span>
                                        <select id="sp-mem-database-worldbook" class="sp-input">
                                            <option value="">跟随角色主世界书（默认）</option>
                                        </select>
                                    </div>
                                    <div id="sp-mem-database-status" class="sp-cfg-hint" style="display:none"></div>

                                    <div id="sp-mem-internal">
                                    <hr class="sp-mem-divider">
                                    <label class="sp-cfg-group">自动记忆</label>
                                    <p class="sp-cfg-hint">对话时逐楼生成客观摘要，供点 / 线 / 面 / 间参考。随聊天存储（不占浏览器缓存），最新一楼不摘要防重 roll。</p>
                                    <label class="sp-mode-opt">
                                        <input type="checkbox" id="sp-mem-enabled">
                                        <span>自动记忆开启</span>
                                    </label>

                                    <div class="sp-mode-opt">
                                        <span>每</span>
                                        <input id="sp-mem-l0" class="sp-input sp-interval-input" type="number" min="1" max="30" value="5">
                                        <span>楼合成一段 L0 摘要</span>
                                    </div>

                                    <div class="sp-mode-opt">
                                        <span>每</span>
                                        <input id="sp-mem-l1" class="sp-input sp-interval-input" type="number" min="2" max="30" value="10">
                                        <span>段 L0 合成一章 L1</span>
                                    </div>

                                    <div class="sp-mode-opt">
                                        <span>跳过短楼（不足</span>
                                        <input id="sp-mem-skipshort" class="sp-input sp-interval-input" type="number" min="0" max="500" value="50">
                                        <span>字的 AI 回复）</span>
                                    </div>

                                    <hr class="sp-mem-divider">

                                    <div id="sp-mem-status" class="sp-mem-status">
                                        <span class="sp-cfg-hint">（打开设置时自动刷新）</span>
                                    </div>

                                    <div id="sp-mem-progress" class="sp-mem-progress" style="display:none">
                                        <div class="sp-mem-progress-label">正在处理: <span id="sp-mem-progress-count">0/0</span></div>
                                        <div class="sp-mem-progress-bar"><div id="sp-mem-progress-fill" class="sp-mem-progress-fill"></div></div>
                                        <button id="sp-mem-progress-abort" class="sp-abort-btn"><i class="fa-solid fa-circle-stop"></i>中止</button>
                                    </div>

                                    <div class="sp-mem-actions">
                                        <button id="sp-mem-check" class="sp-mem-btn">检查完整性</button>
                                        <button id="sp-mem-fill" class="sp-mem-btn">补齐缺失</button>
                                        <button id="sp-mem-rebuild" class="sp-mem-btn sp-mem-btn-danger">推翻重构</button>
                                    </div>
                                    </div>
                                </div>
                            </details>

                            <!-- 显示管理：两个总开关（收藏此楼入口 / 楼内渲染框），渲染框下四个子开关（点·线·轴·标注打捞）。都不注入 AI、不请求 API，纯只读展示。 -->
                            <details class="sp-settings-section" id="sp-display-section">
                                <summary class="sp-settings-section-title">显示与通知管理</summary>
                                <div class="sp-settings-section-body">
                                    <label class="sp-cfg-group">显示</label>
                                    <label class="sp-mode-opt" style="margin-top:10px">
                                        <input type="checkbox" id="sp-adult-blur-enabled" ${getSettings().adultBlurEnabled !== false ? 'checked' : ''}>
                                        <span>默认模糊成人内容</span>
                                    </label>
                                    <label class="sp-mode-opt">
                                        <input type="checkbox" id="sp-anchor-inline-btn" ${getSettings().anchorInlineBtn !== false ? 'checked' : ''}>
                                        <span>收藏此楼入口</span>
                                    </label>

                                    <label class="sp-mode-opt" style="margin-top:10px">
                                        <input type="checkbox" id="sp-inline-render-enabled" ${getSettings().inlineRenderEnabled !== false ? 'checked' : ''}>
                                        <span>楼内渲染框</span>
                                    </label>
                                    <div class="sp-inline-subtoggles">
                                        <span class="sp-subtoggle-label">AI 楼</span>
                                        <label class="sp-mode-opt sp-mode-opt-sub">
                                            <input type="checkbox" id="sp-schedule-inline-enabled" ${getSettings().scheduleInlineEnabled !== false ? 'checked' : ''}>
                                            <span>点</span>
                                        </label>
                                        <label class="sp-mode-opt sp-mode-opt-sub">
                                            <input type="checkbox" id="sp-lines-inline-enabled" ${getSettings().linesInlineEnabled !== false ? 'checked' : ''}>
                                            <span>线</span>
                                        </label>
                                        <label class="sp-mode-opt sp-mode-opt-sub">
                                            <input type="checkbox" id="sp-almanac-inline-enabled" ${getSettings().almanacInlineEnabled !== false ? 'checked' : ''}>
                                            <span>轴</span>
                                        </label>
                                        <label class="sp-mode-opt sp-mode-opt-sub">
                                            <input type="checkbox" id="sp-ledger-inline-enabled" ${getSettings().ledgerInlineEnabled !== false ? 'checked' : ''}>
                                            <span>标注池</span>
                                        </label>
                                        <span class="sp-subtoggle-label" style="margin-top:6px">用户楼</span>
                                        <label class="sp-mode-opt sp-mode-opt-sub">
                                            <input type="checkbox" id="sp-recall-inline-enabled" ${getSettings().recallInlineEnabled !== false ? 'checked' : ''}>
                                            <span>召回</span>
                                        </label>
                                    </div>

                                    <label class="sp-mode-opt" style="margin-top:12px">
                                        <span>最多往上渲染</span>
                                        <input id="sp-inline-render-depth" class="sp-input sp-interval-input" type="number" min="0" value="${escapeAttr(String(Number(getSettings().inlineRenderDepth) || 0))}">
                                        <span>层（0=跟随酒馆助手）</span>
                                    </label>

                                    <label class="sp-mode-opt" style="margin-top:12px">
                                        <span>界面字号</span>
                                        <button type="button" id="sp-uiscale-minus" class="sp-uiscale-btn">−</button>
                                        <span id="sp-uiscale-val" class="sp-uiscale-val">${Math.round((Number(getSettings().uiScale) || 1) * 100)}%</span>
                                        <button type="button" id="sp-uiscale-plus" class="sp-uiscale-btn">＋</button>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">整套面板字号按此百分比缩放，<b>独立于酒馆「字体缩放」</b>。每档 5%，范围 80%–130%，默认 100%。</p>

                                    <hr class="sp-mem-divider sp-settings-display-divider">
                                    <label class="sp-cfg-group">界面字体</label>
                                    <p class="sp-cfg-hint">当前默认字体：有爱圆体</p>
                                    <input id="sp-cfg-font-url" class="sp-input" type="url"
                                           placeholder="字体 CSS URL，如 https://fontsapi.zeoseven.com/xxx/main/result.css"
                                           value="${escapeAttr(getSettings().uiFontUrl ?? '')}">
                                    <div class="sp-mode-opt" style="margin-top:8px; gap:8px">
                                        <button type="button" id="sp-font-apply" class="sp-fetch-btn"><i class="fa-solid fa-check"></i> 应用</button>
                                        <button type="button" id="sp-font-reset" class="sp-fetch-btn" title="恢复成构画自带的默认字体"><i class="fa-solid fa-rotate-left"></i> 恢复默认</button>
                                    </div>

                                    <hr class="sp-mem-divider sp-settings-display-divider">
                                    <label class="sp-cfg-group">通知提醒</label>
                                    <div class="sp-mode-row">
                                        <label class="sp-mode-opt">
                                            <input type="radio" name="sp-notify-mode" value="off" ${(getSettings().notifyMode || 'lite') === 'off' ? 'checked' : ''}>
                                            <span>关（全部静音）</span>
                                        </label>
                                        <label class="sp-mode-opt">
                                            <input type="radio" name="sp-notify-mode" value="lite" ${(getSettings().notifyMode || 'lite') === 'lite' ? 'checked' : ''}>
                                            <span>简约（仅手动生成 / 刷新时提示）</span>
                                        </label>
                                        <label class="sp-mode-opt">
                                            <input type="radio" name="sp-notify-mode" value="full" ${(getSettings().notifyMode || 'lite') === 'full' ? 'checked' : ''}>
                                            <span>全量（另在后台自动改动点 / 线 / 面 / 轴时提示）</span>
                                        </label>
                                    </div>
                                </div>
                            </details>

                            <!-- 通用：提示词与标签（所有用户可编辑文本集中于此） -->
                            <details class="sp-settings-section" id="sp-prompts-section">
                                <summary class="sp-settings-section-title">提示词与标签</summary>
                                <div class="sp-settings-section-body">
                                    <details class="sp-settings-subsection sp-prompt-global"><summary>创作链自定义提示词 / 写作规范</summary>
                                        <p class="sp-cfg-hint"><strong>已内置一版创作强化提示词</strong>（不显示）。此处内容<strong>只追加到构画的创作链</strong>，例如点 / 线 / 面 / 间 / 棱写作，适合放去八股、文风和叙事口吻等规范。日期判断、刻度、记忆压缩和排版等机械任务不使用它；全部链路仍自带如实处理虚构敏感内容的基础许可。支持 <code>{{char}}</code> / <code>{{user}}</code> 占位符。</p>
                                        <textarea id="sp-custom-prompt" class="sp-input sp-theater-cfg-textarea" placeholder="可留空（创作链只用内置强化词）。也可追加创作规范，如：去八股、控制文风、叙事口吻…"></textarea>
                                    </details>
                                    <details class="sp-settings-subsection sp-prompt-tags"><summary>标签清洗</summary>
                                        <p class="sp-cfg-hint">读取 AI 楼层原文时的标签过滤规则，<strong>对全部生成链路生效</strong>（记忆摘要、点 / 线 / 面生成、间 / 面讨论的对话注入），用来剔除状态栏 / 思维链等包裹、避免污染上下文。多个用英文逗号分隔；XML 包裹可写标签名或带尖括号（<code>content</code> / <code>&lt;content&gt;</code> 等效），双中括号包裹请固定填写 <code>[[...]]</code>（三个点是配置占位）。可组合填写 <code>content,[[...]]</code>，并支持中文、日文等 Unicode 标签名。</p>
                                        <div class="sp-mode-opt sp-tag-opt"><span>保留包裹符</span><input id="sp-mem-keeptags" class="sp-input sp-tag-input" type="text" placeholder="content" value=""></div>
                                        <p class="sp-cfg-hint">标签本身去掉、<strong>内部文字保留</strong>（如正文被 <code>content</code> 包裹）。</p>
                                        <div class="sp-mode-opt sp-tag-opt"><span>剔除包裹符</span><input id="sp-mem-extratags" class="sp-input sp-tag-input" type="text" placeholder="think,reasoning" value=""></div>
                                        <p class="sp-cfg-hint">包裹符<strong>连同内部内容一起删除</strong>（如 <code>think,reasoning,[[...]]</code>）；未闭合的双中括号会保留原文，不会吞掉后文。</p>
                                    </details>
                                    <details class="sp-settings-subsection sp-prompt-storyclock"><summary>时间戳提示词</summary>
                                        <p class="sp-cfg-hint"><strong>全部内容均可编辑</strong>；留空＝用内置完整默认（默认词随插件更新走）。删除 SDC 标签或机器合同可能导致时间戳无法识别，风险由你承担。务必让两端各带 date、weekday、time；旧无星期标记仍兼容读取，但不会从现实年份补星期。</p>
                                        <textarea id="sp-storyclock-prompt" class="sp-input sp-theater-cfg-textarea" placeholder="留空＝用内置完整默认强制词。"></textarea>
                                        <div style="display:flex; gap:8px; margin-top:6px"><button id="sp-storyclock-prompt-load" class="sp-mem-btn" type="button">载入默认再改</button><button id="sp-storyclock-prompt-reset" class="sp-mem-btn" type="button">恢复默认</button></div>
                                    </details>
                                    <details id="sp-space-section" class="sp-settings-subsection sp-prompt-space"><summary>间 · 人格 / 说话风格</summary>
                                        <p class="sp-cfg-hint">间 = 跳出扮演、和 AI 聊剧情/设定/关系的「局外」空间。这里可给它换一套<strong>说话语气与人格</strong>。</p>
                                        <label class="sp-cfg-label">间的人格 / 说话风格</label>
                                        <textarea id="sp-space-persona" class="sp-input sp-theater-cfg-textarea" placeholder="留空＝内置默认（柔和客观、含蓄内敛的中性顾问）。填了就换成你写的人格，如：深耕 ACG、熟知网络用语、爱用半个括号吐槽的重度宅女…"></textarea>
                                        <p class="sp-cfg-hint">只换<strong>语气 / 行文 / 人格色彩</strong>；「间仍是创作顾问、不推进剧情、不扮演故事角色」这条内核<strong>恒定保留</strong>（写得再放飞它也不会跑去演戏）。<b>只作用于「间」</b>，不影响面·和间聊聊。支持 <code>{{char}}</code> / <code>{{user}}</code>。</p>
                                    </details>
                                    <details id="sp-theater-section" class="sp-settings-subsection sp-prompt-theater-write"><summary>棱 · 写作提示词</summary>
                                        <label class="sp-cfg-label">写作提示词（文风 + 范文）</label>
                                        <textarea id="sp-theater-style" class="sp-input sp-theater-cfg-textarea" placeholder="指定文体基调、节奏、感官描写要求，禁套路化开头结尾；也可直接贴 1-2 段你认可的文笔让 AI 模仿其笔触…"></textarea>
                                    </details>
                                </div>
                            </details>

                                </div>
                            </details>

                            <!-- ═══════════ 注入与内容设置 ═══════════ -->
                            <details class="sp-settings-layer" id="sp-settings-content">
                                <summary class="sp-settings-layer-title">注入与内容设置</summary>
                                <div class="sp-settings-layer-body">
                                    <div class="sp-settings-section sp-settings-section-static" id="sp-inject-master-section">
                                        <div class="sp-settings-section-title">潜伏注入总开关</div>
                                        <div class="sp-settings-section-body">
                                            <label class="sp-mode-opt">
                                                <input type="checkbox" id="sp-inject-enabled" ${getSettings().injectEnabled !== false ? 'checked' : ''}>
                                                <span>允许潜伏注入主楼 AI（线 / 面 / 刻度）</span>
                                            </label>
                                            <p class="sp-cfg-hint">总闸：关闭则线 / 面 / 刻度一律不注入主楼 AI（不影响楼内展示与手动生成）。各模块自身的注入开关仍需分别开启才生效。</p>
                                        </div>
                                    </div>

                                    <details class="sp-settings-section" id="sp-module-injection-section">
                                        <summary class="sp-settings-section-title">模块注入</summary>
                                        <div class="sp-settings-section-body">
                                            <div class="sp-settings-subsection-static"><div class="sp-settings-subsection-title">线 · 潜伏注入</div>
                                                <label class="sp-mode-opt"><input type="checkbox" id="sp-lines-inject" ${getSettings().linesInject === true ? 'checked' : ''}><span>潜伏注入主楼 AI</span></label>
                                                <p class="sp-cfg-hint">活跃线隐形注入主楼 AI（聊天不显示），让伏笔当暗流缓慢推进。会改 AI 行为、略增 token，默认关。</p>
                                            </div>
                                            <div class="sp-settings-subsection-static"><div class="sp-settings-subsection-title">面 · 大纲注入</div>
                                                <label class="sp-mode-opt"><input type="checkbox" id="sp-outline-inject" ${getSettings().outlineInject === true ? 'checked' : ''}><span>大纲自动注入</span></label>
                                                <p class="sp-cfg-hint">沿大纲节点缓慢推进：每隔若干楼<b>独立判定</b>当前演到哪个节点，把「当前节点 + 下一步方向」隐形注入主楼 AI（聊天不显示）。游标<b>只进不退、无信号不动</b>，写再多跑题日常也不硬推。默认关，需先有一版面。</p>
                                            </div>
                                            <div class="sp-settings-subsection-static"><div class="sp-settings-subsection-title">刻度 · 潜伏注入</div>
                                                <label class="sp-mode-opt"><input type="checkbox" id="sp-ledger-inject" ${getSettings().ledgerInject === true ? 'checked' : ''}><span>潜伏注入主楼 AI</span></label>
                                                <p class="sp-cfg-hint">按剧情挑几条此刻最相关的账（伤情 / 约定 / 周期），隐形注入主楼 AI（聊天不显示），让它<b>记得</b>角色身上的账、随天数表现出该有的样子（不生硬点破）。会改 AI 行为、略增 token，默认关。开后楼内「线」块下方会多一个只读<b>标注打捞</b>框，可核对本回合实际注入了哪几条。</p>
                                            </div>
                                        </div>
                                    </details>

                                    <details class="sp-settings-section" id="sp-content-switches-section">
                                        <summary class="sp-settings-section-title">功能与内容开关</summary>
                                        <div class="sp-settings-section-body">
                                            <label class="sp-mode-opt"><input type="checkbox" id="sp-lines-enabled" ${getSettings().linesEnabled !== false ? 'checked' : ''}><span>线</span></label>
                                            <label class="sp-mode-opt"><input type="checkbox" id="sp-dashed-enabled" ${getSettings().dashedEnabled === true ? 'checked' : ''}><span>冷知识</span></label>
                                            <div class="sp-mode-opt sp-mode-opt-sub sp-dashed-keep-row">
                                                <input type="checkbox" id="sp-dashed-cleanup-enabled" ${getSettings().dashedCleanupEnabled !== false ? 'checked' : ''}>
                                                <label for="sp-dashed-cleanup-enabled">冷知识保存数量</label>
                                                <input id="sp-dashed-keep-count" class="sp-input sp-interval-input" type="number" min="2" step="1" value="${escapeAttr(String(linesFeature.dashed.normalizeKeepCount(getSettings().dashedKeepCount)))}" ${getSettings().dashedCleanupEnabled !== false ? '' : 'disabled'} aria-label="保留最近多少条未锁冷知识">
                                            </div>
                                            <label class="sp-mode-opt"><input type="checkbox" id="sp-ledger-capture-enabled" ${getSettings().ledgerCaptureEnabled === true ? 'checked' : ''}><span>刻度</span></label>
                                        </div>
                                    </details>

                                    <details class="sp-settings-section" id="sp-adult-scale-section">
                                        <summary class="sp-settings-section-title">成人内容与叙事尺度</summary>
                                        <div class="sp-settings-section-body">
                                            <p class="sp-cfg-group" id="sp-scale-hint">叙事尺度（按角色保存）</p>
                                            <div class="sp-mode-row" id="sp-scale-row"><!-- populated when settings opens --></div>
                                            <hr class="sp-mem-divider">
                                            <p class="sp-cfg-group">成人剧情模式（按角色保存）</p>
                                            <div class="sp-mode-row" id="sp-adult-row"><!-- populated when settings opens --></div>
                                        </div>
                                    </details>
                                </div>
                            </details>

                            <!-- ═══════════ 推进设置 ═══════════ -->
                            <details class="sp-settings-layer" id="sp-settings-pace">
                                <summary class="sp-settings-layer-title">推进设置</summary>
                                <div class="sp-settings-layer-body">
                                    <details class="sp-settings-section" id="sp-axis-section">
                                        <summary class="sp-settings-section-title">日期与点</summary>
                                        <div class="sp-settings-section-body">
                                            <label class="sp-mode-opt"><input type="checkbox" id="sp-almanac-autodetect" ${getSettings().almanacAutoDetect !== false ? 'checked' : ''}><span>读不到时间戳时，用 API 兜底判定日期</span></label>
                                            <label class="sp-mode-opt"><span>每</span><input id="sp-almanac-judge-interval" class="sp-input sp-interval-input" type="number" min="1" value="${escapeAttr(String(getAlmanacJudgeInterval()))}"><span>条 AI 回复兜底一次</span></label>
                                            <p class="sp-cfg-hint">有戳时每楼直接读、<b>不调 API</b>；只有漏打戳、或戳没写月日（如「谷雨」）时，才隔几楼调一次 API 从正文推算日期补上。<b>关掉＝只认戳、绝不为日期调 API</b>。</p>
                                            <label class="sp-mode-opt"><input type="checkbox" id="sp-schedule-autodetect" ${getSettings().scheduleAutoDetect === true ? 'checked' : ''}><span>点：后台自动跟随「今天」</span></label>
                                            <p class="sp-cfg-hint">开＝「今天」一推进就<b>自动在后台重排点</b>到今天（<b>每次多一趟 API</b>）。<b>关（默认）＝点原地不动、不后台调 API</b>；你想让点对齐今天时，去点面板<b>手动刷新一次</b>即可（刷新出来的点就从今天起排）。不常用点、想省 API 的就别开。</p>
                                        </div>
                                    </details>
                                    <details class="sp-settings-section" id="sp-pace-lines-section">
                                        <summary class="sp-settings-section-title">线</summary>
                                        <div class="sp-settings-section-body">
                                            <p class="sp-cfg-group">推进策略</p>
                                            <div class="sp-mode-row">
                                                <label class="sp-mode-opt"><input type="radio" name="sp-lines-mode" value="turns" ${getLinesMode() === 'turns' ? 'checked' : ''}><span>回合制，每</span><input id="sp-lines-interval" class="sp-input sp-interval-input" type="number" min="1" value="${escapeAttr(String(getLinesInterval()))}"><span>条 AI 回复推进一次</span></label>
                                                <label class="sp-mode-opt"><input type="radio" name="sp-lines-mode" value="days" ${getLinesMode() === 'days' ? 'checked' : ''}><span>时间制，按游戏内日期变化推进</span></label>
                                                <label class="sp-mode-opt"><input type="radio" name="sp-lines-mode" value="manual" ${getLinesMode() === 'manual' ? 'checked' : ''}><span>手动推进，由用户点击按钮触发</span></label>
                                            </div>
                                        </div>
                                    </details>
                                    <details class="sp-settings-section" id="sp-outline-section">
                                        <summary class="sp-settings-section-title">面</summary>
                                        <div class="sp-settings-section-body">
                                            <label class="sp-cfg-group">判定节奏</label>
                                            <label class="sp-mode-opt"><span>每</span><input id="sp-outline-judge-interval" class="sp-input sp-interval-input" type="number" min="1" value="${escapeAttr(String(outlineFeature.judge.getInterval()))}"><span>条 AI 回复判定一次推进</span></label>
                                            <p class="sp-cfg-hint">楼数越大越省 token、越迟钝；越小越灵敏、开销越高（<b>每次判定 = 一次额外 API</b>）。默认 3。</p>
                                        </div>
                                    </details>
                                    <details class="sp-settings-section" id="sp-pace-ledger-section">
                                        <summary class="sp-settings-section-title">刻度</summary>
                                        <div class="sp-settings-section-body">
                                            <label class="sp-mode-opt"><span>每</span><input id="sp-ledger-capture-interval" class="sp-input sp-interval-input" type="number" min="1" max="30" value="${escapeAttr(String(Math.max(1, Math.min(30, Number(getSettings().ledgerCaptureInterval) || 5))))}"><span>条 AI 回复标注一次</span></label>
                                            <label class="sp-mode-opt"><span>每</span><input id="sp-ledger-judge-interval" class="sp-input sp-interval-input" type="number" min="1" max="30" value="${escapeAttr(String(Math.max(1, Math.min(30, Number(getSettings().ledgerJudgeInterval) || 4))))}"><span>条 AI 回复更新一次现状</span></label>
                                            <p class="sp-cfg-hint">两项节奏均受“刻度 · 自动标注”开关统辖。</p>
                                        </div>
                                    </details>
                                </div>
                            </details>

                            <!-- ═══════════ 数据设置 ═══════════ -->
                            <details class="sp-settings-layer" id="sp-settings-data">
                                <summary class="sp-settings-layer-title">数据设置</summary>
                                <div class="sp-settings-layer-body">
                                    <details class="sp-settings-section" id="sp-theater-template-section">
                                        <summary class="sp-settings-section-title">小剧场模板库</summary>
                                        <div class="sp-settings-section-body">
                                            <p class="sp-cfg-hint">存于专用世界书 <code>构画-棱-小剧场模板</code>，全局共享、不进聊天文件、绝不注入 AI。棱输入区可点选模板起草；缓存用量与清理见“存储管理”。</p>
                                            <div id="sp-theater-tpl-mgr" class="sp-theater-tpl-mgr"><div class="sp-theater-list-empty">（打开设置时自动加载）</div></div>
                                        </div>
                                    </details>
                                    <details class="sp-settings-section" id="sp-storage-section">
                                        <summary class="sp-settings-section-title">存储管理</summary>
                                        <div class="sp-settings-section-body">
                                            <p class="sp-cfg-hint">统管构画的数据占用，按存储位置分层。</p>
                                            <div id="sp-storage-body"><div class="sp-cfg-hint">（打开设置时自动统计…）</div></div>
                                            <div class="sp-mem-actions"><button id="sp-storage-refresh" class="sp-mem-btn">刷新用量</button></div>
                                        </div>
                                    </details>
                                    <details class="sp-settings-section" id="sp-diagnostics-section">
                                        <summary class="sp-settings-section-title">诊断管理</summary>
                                        <div class="sp-settings-section-body">
                                            <div class="sp-diagnostics-block">
                                                <label class="sp-cfg-group">AI 输入</label>
                                                <p class="sp-cfg-hint"><strong>仅供本人排查。</strong>这里是最近一次实际发给 AI 的完整输入，可能包含最近聊天、上下文、世界书和提示词等敏感内容，不建议公开分享。</p>
                                                <details class="sp-diagnostics-preview sp-diagnostics-preview-empty" id="sp-diagnostics-ai-input-preview">
                                                    <summary class="sp-diagnostics-preview-title">查看最近 AI 输入</summary>
                                                    <pre class="sp-diagnostics-pre" id="sp-diagnostics-ai-input-pre" aria-live="polite">（尚未发送请求）</pre>
                                                    <div class="sp-diagnostics-actions" id="sp-diagnostics-ai-input-actions" hidden>
                                                        <button class="sp-diagnostics-copy-btn" id="sp-diagnostics-ai-input-copy" type="button" disabled><i class="fa-regular fa-copy"></i> 复制 AI 输入</button>
                                                    </div>
                                                </details>
                                            </div>
                                            <hr class="sp-mem-divider">
                                            <div class="sp-diagnostics-block">
                                                <label class="sp-cfg-group">请求诊断</label>
                                                <p class="sp-cfg-hint"><strong>适合发给开发者。</strong>复制最近 30 条安全诊断日志；不含正文、提示词、API Key 或 URL。</p>
                                                <button id="sp-diagnostic-export" class="sp-save-btn" type="button"><i class="fa-regular fa-copy"></i> 复制最近诊断日志</button>
                                            </div>
                                        </div>
                                    </details>
                                </div>
                            </details>

                        </div><!-- /sp-settings-body -->
                        <div class="sp-settings-footer">
                            <button id="sp-cfg-save" class="sp-save-btn"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                            <span id="sp-cfg-msg" class="sp-cfg-msg"></span>
                        </div>
                    </div><!-- /sp-settings-overlay -->

                    <div class="sp-main">
                        <div class="sp-body" id="sp-body">
                            <div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>还没有点</p><button class="sp-gen-btn" id="sp-gen-schedule-now">生成点</button></div>
                        </div>

                        <div class="sp-outline-wrap" id="sp-outline-wrap" style="display:none">
                            <div class="sp-schedule-header sp-outline-header">
                                <span class="sp-outline-title">故事面</span>
                                <span class="sp-schedule-label" id="sp-outline-node-count">0 个节点</span>
                                <button class="sp-panel-refresh sp-refresh-outline" title="重新生成面" aria-label="重新生成面"><i class="fa-solid fa-rotate-right"></i></button>
                            </div>
                            <div class="sp-outline-beats" id="sp-outline-beats">
                                <div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>当前还没有面，可以先直接聊天讨论，也可以生成一版面作为起点</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">生成面</button></div>
                            </div>
                            <div class="sp-outline-divider" id="sp-outline-divider">
                                <i class="fa-solid fa-grip-lines"></i>
                            </div>
                            <div class="sp-outline-chat" id="sp-outline-chat">
                                <div class="sp-chat-msgs" id="sp-chat-msgs"></div>
                                <div class="sp-chat-input-row">
                                    <button id="sp-chat-clear" class="sp-icon-btn" title="清空对话"><i class="fa-solid fa-broom"></i></button>
                                    <textarea id="sp-chat-input" class="sp-input sp-chat-input-ta" rows="1" placeholder="和 AI 讨论面…"></textarea>
                                    <button id="sp-chat-send" class="sp-icon-btn" title="发送"><i class="fa-solid fa-paper-plane"></i></button>
                                </div>
                            </div>
                        </div>

                        <div class="sp-lines-wrap" id="sp-lines-wrap" style="display:none">
                            <div class="sp-lines-toolbar" id="sp-lines-toolbar"></div>
                            <div class="sp-lines-list" id="sp-lines-list">
                                <div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>还没有追踪的线，可以生成一版</p><button class="sp-gen-btn" id="sp-gen-lines-now">生成线</button></div>
                            </div>
                        </div>

                        <div class="sp-space-wrap sp-outline-chat" id="sp-space-wrap" style="display:none;flex-direction:column;flex:1;min-height:0">
                            <div class="sp-chat-msgs" id="sp-space-msgs"></div>
                            <div class="sp-chat-input-row">
                                <button id="sp-space-clear" class="sp-icon-btn" title="清空对话"><i class="fa-solid fa-broom"></i></button>
                                <textarea id="sp-space-input" class="sp-input sp-chat-input-ta" rows="1" placeholder="局外聊聊：剧情、设定、关系、知识…"></textarea>
                                <button id="sp-space-send" class="sp-icon-btn" title="发送"><i class="fa-solid fa-paper-plane"></i></button>
                            </div>
                        </div>

                        <div class="sp-theater-wrap" id="sp-theater-wrap" style="display:none;flex-direction:column;flex:1;min-height:0">
                            <div class="sp-theater-body" id="sp-theater-body"></div>
                        </div>

                        <div class="sp-anchor-wrap" id="sp-anchor-wrap" style="display:none;flex-direction:column;flex:1;min-height:0">
                            <div class="sp-anchor-body" id="sp-anchor-body"></div>
                        </div>

                        <div class="sp-almanac-wrap" id="sp-almanac-wrap" style="display:none;flex-direction:column;flex:1;min-height:0"></div>
                    </div><!-- /sp-main -->

                </div><!-- /sp-content-col -->

                <div class="sp-resize-handle" id="sp-resize-handle">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </div>
            </div>`;
    // Shadow DOM 宿主（2026-08-14 隔离改造批次1）：id/类留在 light DOM 的 host 上——
    // openSchedule/closePanel 的 show/hide、applyTheme 的类切换、各 is(':visible')
    // 判断的操作对象不变；窗口内容整体进 shadow root，ST 全局 button/input/滚动条/
    // 文字阴影等规则在边界处切断。style.css 与 fontawesome 经 <link> 只作用于本 shadow；
    // :root 的 --sp-* 令牌与 --SmartTheme* 变量穿透 shadow 边界照常继承，主题色板/缩放零改动。
    const host = document.createElement('div');
    host.id = MODAL_ID;
    host.className = `sp-root sp-${currentTheme}`;
    host.style.cssText = 'display:none;position:fixed;z-index:2000001';
    const root = host.attachShadow({ mode: 'open' });
    _spShadow = root;
    // 键盘边界：shadow 内 input 的 keydown 是 composed 事件，冒泡到 document 时 ST 的
    // isInputElementInFocus() 读 document.activeElement = 宿主 div（非 shadow 内 input）→ 守卫
    // 失效 → 方向键等触发重roll/swipe。在 shadowRoot（冒泡先经此、后到 document；此处 target 不
    // retarget、是真实 input）截断输入框内非 Esc 按键。放行 Esc：各全屏/菜单的 document 级退出仍需收到。
    root.addEventListener('keydown', ev => {
        if (ev.key === 'Escape') return;
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) ev.stopPropagation();
    });
    // shadow 内第一层 wrapper 必须带 sp-root + 主题类：style.css 的 `.sp-root ...` 前缀选择器、
    // .sp-night/.sp-day 色板、.sp-forced-* 强制主题覆盖全靠它匹配
    // （applyTheme 同步它的主题类）。display:contents 不产生布局盒子，fixed 语义
    // 仍由 .sp-sheet 承担；host 无 transform/filter，内部 position:fixed 相对视口不变。
    root.innerHTML = `
        <link rel="stylesheet" href="${EXT_BASE}style.css">
        <link rel="stylesheet" href="${ST_BASE}css/fontawesome.min.css">
        <div class="sp-root sp-${currentTheme}" style="display:contents">${html}</div>`;
    document.documentElement.appendChild(host);

    if (cfg.key) $in('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $in('.sp-close-btn').on('click',    closePanel);
    $in('.sp-settings-btn').on('click', toggleSettings);
    $in('.sp-settings-close-btn').on('click', toggleSettings);
    $in('#sp-settings-overlay')
        .off('change.spLinesMode', 'input[name="sp-lines-mode"]')
        .on('change.spLinesMode', 'input[name="sp-lines-mode"]', function () {
            saveLinesMode(this.value);
            linesFeature.resetCounter();
        });
    $in('.sp-fab-toggle-btn').on('click', function () {
        const nowEnabled = !fabEnabled();
        getSettings().fabShow = nowEnabled;
        saveSettingsDebounced();
        $(`#${FAB_ID}`).toggle(nowEnabled);
        $(this).toggleClass('sp-btn-active', nowEnabled);
    });
    $in('.sp-theme-toggle-btn').on('click', cycleThemeMode);
    $in('.sp-backdrop').on('click',     closePanel);

    // 模块介绍气泡：点标题旁的 ? 弹出当前模块简介，点外部/切模块即关
    $in('.sp-module-intro-btn').on('click', function (e) {
        e.stopPropagation();
        const $pop = $in('#sp-module-intro-pop');
        if ($pop.is(':visible')) { $pop.hide(); return; }
        const view = $in('.sp-side-tab.sp-view-active').data('view') || 'schedule';
        $pop.html(MODULE_INTROS[view] || MODULE_INTROS.schedule).show();   // 内容全为作者手写 HTML（图标图例），无用户输入 → .html() 安全
    });
    // 批次3：shadow 内点击的 e.target 被重定向为 host，closest() 判断失效（点 pop 内部也触发关闭）
    // → 改走 composedPath()（含 shadow 内节点）判断点击是否落在 pop/btn 内。
    $(document).off('click.spIntro').on('click.spIntro', function (e) {
        // hotfix3：合成事件（如 fastChat/mobileKeyboard 的 jQuery .trigger()）无 originalEvent → ?. 防御，path 为空走关闭分支
        const path = e.originalEvent?.composedPath?.() || [];
        if (path.some(el => el instanceof Element && el.matches('#sp-module-intro-pop, .sp-module-intro-btn'))) return;
        $in('#sp-module-intro-pop').hide();
    });
    for (const id of ['#sp-diagnostics-section', '#sp-diagnostics-ai-input-preview']) {
        inEl(id)?.addEventListener('toggle', function () {
            if (this.open) refreshLastDebugPayloadPreview();
        });
    }
    $in('#sp-diagnostics-ai-input-copy').on('click', function () {
        void copyLastDebugPayload();
    });

    outlineFeature.bindUi();

    spaceFeature.bindUi();
    const $linesWrap = $in('#sp-lines-wrap');
    $linesWrap.on('click', '#sp-gen-lines-now', triggerGenerateLines);
    $linesWrap.on('click', '.sp-lines-sheet-btn', function () {
        const sheet = $(this).attr('data-sheet');
        if (sheet !== 'events' && sheet !== 'dashed') return;
        linesFeature.setSheet(sheet);
        linesFeature.refreshPanel();
    });
    $linesWrap.on('click', '.sp-lines-dashed-add', () => linesFeature.dashed.openDialog());
    $linesWrap.on('click', '.sp-lines-dashed-lock', function () { linesFeature.dashed.toggle($(this).attr('data-id')); });
    $linesWrap.on('click', '.sp-lines-dashed-delete', function () { linesFeature.dashed.remove($(this).attr('data-id')); });
    $in('#sp-body').on('click', '#sp-gen-schedule-now, .sp-refresh-schedule', onRegenClick);
    // 点视图头部 📌：固定/取消固定当前 char（只在 char 视角出现）。名字取按钮 data-name，兜底 charViewName。
    $in('#sp-body').on('click', '.sp-point-pin-char', function () {
        onCharPinToggle($(this).attr('data-name'));
    });
    // TA▾ 抽屉委托：点固定槽切人 / ✕ 移除槽 / 「添加·查看角色」开填写框。
    $in('#sp-ta-drawer').on('click', '.sp-ta-slot-del', function (e) {
        e.stopPropagation();   // 别冒泡到槽本身的「切人」
        const name = $(this).attr('data-name');
        store.removePinnedChar(name);
        if (store.readPinnedChars().length) openTaDrawer();   // 还有槽 → 重渲；空了 → 收起
        else closeTaDrawer();
        refreshCharPinIcon();   // 若删的正是当前 char，头部 📌 同步回未固定态
    });
    $in('#sp-ta-drawer').on('click', '.sp-ta-slot', function () {
        activateCharView($(this).attr('data-name'));
    });
    $in('#sp-ta-drawer').on('click', '.sp-ta-add', function () {
        closeTaDrawer();
        switchToCharView();
    });
    // Refresh lines — button appears in both panel toolbar and inline block
    // 双绑拆分：面板行在 shadow 内走 $in；楼内行在 light DOM #chat 保持原查询。
    $linesWrap.on('click', '.sp-refresh-lines, .sp-inline-refresh-lines', function (e) {
        e.stopPropagation();   // inline button lives in <summary>, don't toggle details
        linesFeature.actions.reroll();
    });
    $('#chat').on('click', '.sp-refresh-lines, .sp-inline-refresh-lines', function (e) {
        e.stopPropagation();   // inline button lives in <summary>, don't toggle details
        linesFeature.actions.reroll();
    });
    // Advance lines — button appears in both panel toolbar and inline block
    $linesWrap.on('click', '.sp-advance-lines, .sp-inline-advance-lines', function (e) {
        e.stopPropagation();   // inline button lives in <summary>, don't toggle details
        linesFeature.actions.advance();
    });
    $('#chat').on('click', '.sp-advance-lines, .sp-inline-advance-lines', function (e) {
        e.stopPropagation();   // inline button lives in <summary>, don't toggle details
        linesFeature.actions.advance();
    });
    // 楼层刷新仍直接广泛取材两条，不打开面板的主题选择弹窗。
    $('#chat').on('click', '.sp-inline-refresh-dashed', function (e) {
        e.stopPropagation();
        linesFeature.dashed.run({ reroll: true });
    });
    // Per-line delete (× on each line card, panel + inline). No full-clear button anymore.
    $linesWrap.on('click', '.sp-line-del-one', function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr('data-line-idx'));
        if (Number.isInteger(idx)) linesFeature.actions.delete(idx);
    });
    $('#chat').on('click', '.sp-line-del-one', function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr('data-line-idx'));
        if (Number.isInteger(idx)) linesFeature.actions.delete(idx);
    });
    // Per-line lock/unlock toggle (panel only — inline block shows a read-only marker).
    $linesWrap.on('click', '.sp-line-pin-toggle', function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr('data-line-idx'));
        if (Number.isInteger(idx)) linesFeature.actions.pin(idx);
    });
    $('#chat').on('click', '.sp-line-pin-toggle', function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr('data-line-idx'));
        if (Number.isInteger(idx)) linesFeature.actions.pin(idx);
    });
    const revealAdult = function (e) {
        const node = $(this); const root = node.closest('.sp-line-card, .sp-inline-line, .sp-event, .sp-sch-drawer-item');
        if (root.hasClass('sp-adult-revealed')) return;
        e.preventDefault(); e.stopPropagation(); root.addClass('sp-adult-revealed');
        root.find('.sp-adult-sensitive').removeAttr('role tabindex aria-label title').find('[aria-hidden="true"]').removeAttr('aria-hidden');
    };
    const revealAdultKey = function (e) { if (e.key !== 'Enter' && e.key !== ' ') return; revealAdult.call(this, e); };
    $in('#sp-lines-wrap').off('click.spAdultReveal keydown.spAdultReveal', '.sp-adult-sensitive').on('click.spAdultReveal', '.sp-adult-sensitive', revealAdult).on('keydown.spAdultReveal', '.sp-adult-sensitive', revealAdultKey);
    $in('#sp-body').off('click.spAdultReveal keydown.spAdultReveal', '.sp-adult-sensitive').on('click.spAdultReveal', '.sp-adult-sensitive', revealAdult).on('keydown.spAdultReveal', '.sp-adult-sensitive', revealAdultKey);
    $('#chat').off('click.spAdultReveal keydown.spAdultReveal', '.sp-adult-sensitive').on('click.spAdultReveal', '.sp-adult-sensitive', revealAdult).on('keydown.spAdultReveal', '.sp-adult-sensitive', revealAdultKey);
    $inAll('#sp-body, #sp-lines-wrap, #sp-outline-wrap').on('click.spManualActionMenu', '.sp-action-menu-toggle', function (e) {
        e.stopPropagation(); const menu = $(this).closest('.sp-action-menu').get(0); const open = !$(menu).hasClass('sp-action-menu-open'); closeActionMenus(menu); $(menu).toggleClass('sp-action-menu-open', open).find('.sp-action-menu-list').attr('hidden', !open).end().find('.sp-action-menu-toggle').attr('aria-expanded', String(open));
    }).on('click.spManualActionMenu', '.sp-action-menu-item', function (e) {
        e.stopPropagation(); const item = $(this); const menu = item.closest('.sp-action-menu'); const action = item.attr('data-action'); const idx = Number(menu.attr('data-line-idx') ?? menu.attr('data-idx')); const day = menu.attr('data-day');
        closeActionMenus();
        if (action === 'point-edit') return pointActions.editDescription(day === 'future' ? 'future' : Number(day), Number(menu.attr('data-ev')), { view: currentView, charName: charViewName });
        if (action === 'point-pin') return triggerTogglePointPin(day === 'future' ? 'future' : Number(day), Number(menu.attr('data-ev')));
        if (action === 'point-delete') return triggerDeletePointEvent(day === 'future' ? 'future' : Number(day), Number(menu.attr('data-ev')), { view: currentView, charName: charViewName });
        if (action === 'point-inject') return injectToST(_injectTexts[menu.attr('data-iid')]);
        if (action === 'line-edit') return linesFeature.actions.edit(idx);
        if (action === 'line-pin') return linesFeature.actions.pin(idx);
        if (action === 'line-delete') return linesFeature.actions.delete(idx);
        if (action === 'line-inject') return injectToST(_injectTexts[menu.attr('data-iid')]);
        if (action === 'outline-edit') return outlineFeature.actions.editScene(idx - 1);
        if (action === 'outline-current') return outlineFeature.actions.toggleCursor(idx);
        if (action === 'outline-inject') return injectToST(outlineFeature.ui.getInjectText(menu.attr('data-iid')));
        if (action === 'outline-copy') {
            const text = outlineFeature.ui.getCopyText(menu.attr('data-cid'));
            void copyPlainText(text).then(ok => showToast(ok ? '已复制' : '复制失败', null, !ok));
            return;
        }
        if (action === 'outline-delete') return outlineFeature.actions.deleteBeat(idx - 1);
    });
    // Per-point delete (× on each event, 点面板 + 楼内块抽屉；对齐线的 .sp-line-del-one 双绑 #sp-lines-list/#chat)。
    $in('#sp-body').on('click', '.sp-sch-del-one', function (e) {
        e.stopPropagation();
        const day = $(this).attr('data-day');
        const idx = Number($(this).attr('data-ev'));
        if (!Number.isInteger(idx)) return;
        const view = currentView;
        const charName = view === 'char' ? charViewName : '';
        triggerDeletePointEvent(day === 'future' ? 'future' : Number(day), idx, { view, charName });
    });
    $('#chat').on('click', '.sp-sch-del-one', function (e) {
        e.stopPropagation();
        const day = $(this).attr('data-day');
        const idx = Number($(this).attr('data-ev'));
        if (!Number.isInteger(idx)) return;
        triggerDeletePointEvent(day === 'future' ? 'future' : Number(day), idx, { view: 'user', charName: '' });
    });

    // Inject buttons (event delegation)——点/线宿主桥保留；面由 outline feature 的唯一 UI 入口负责。
    $inAll('#sp-body, #sp-lines-wrap').on('click', '.sp-inject-btn', function () {
        const text = _injectTexts[$(this).data('iid')];
        if (text) injectToST(text);
    });
    $('#chat').on('click', '.sp-inject-btn', function () {
        const text = _injectTexts[$(this).data('iid')];
        if (text) injectToST(text);
    });

    // 点/线面板底部「和间聊聊」引导 → 一键切到间（间能把讨论落地成点/线）
    // 同上：逗号选择器用 $inAll，否则只有 #sp-body 那区能点、#sp-lines-list 区的「和间聊聊」静默失效。
    $inAll('#sp-body, #sp-lines-wrap').on('click', '.sp-jump-link', () => $in('.sp-view-btn[data-view="space"]').trigger('click'));

    // Abort buttons (event delegation) — 即时撤下 UI，见 abort*Gen
    $in('#sp-body').on('click', '#sp-abort-generate', abortScheduleGen);
    $linesWrap.on('click', '#sp-abort-lines', abortLinesGen);

    // ── 棱（小剧场）事件（全部委托到注入式 ui；旧委托仅作为无 UI 兼容路径）──
    const $theater = $in('#sp-theater-wrap');
    theaterFeature.bindUi($theater);

    // ── 历（日历）事件（委托到 #sp-almanac-wrap，两个 sheet 动态重渲染）──
    const $almanac = $in('#sp-almanac-wrap');
    $almanac.on('click', '.sp-alm-sheet-btn', function () { almSetSheet($(this).attr('data-sheet')); });
    bindLedgerEvents({
        almanac: $almanac, chat: $('#chat'), $, settings: getSettings, saveSettings: saveSettingsDebounced,
        capture: { run: runLedgerCaptureStep, abort: () => ledgerCaptureController.abort() },
        judge: { run: runLedgerJudgeStep }, captureState: () => ({ busy: ledgerCaptureController.isBusy, controller: ledgerCaptureController.abortController }), actions: ledgerActions,
        render: renderAlmanacPanel,
        refreshInline: () => refreshInlineWindow(true),
        identity: () => ledgerOwnerIdentity(getContext() || {}),
        isCurrentIdentity: owner => sameLedgerOwner(owner, ledgerOwnerIdentity(getContext() || {})),
        editor: { open: openLedgerEditor, save: saveLedgerEditor, close: closeLedgerEditor, get: getLedgerEditor },
        archive: { toggle: toggleLedgerArchiveOpen },
        batch: { scopes: BATCH_SCOPES, scope: getBatchScope, setScope: setBatchScope, selected: getBatchSelected, reset: batchReset, ids: batchScopeIds, exec: execBatch },
        toast: showToast, resetCapture: () => { ledgerCaptureCounter = 0; },
    });
    // 轴面板「今天」栏：±1天 / 改（内联月日） / 自动（清锚）等操作经 runAnchorAftermath 共享善后；
    // 点后台是否重排由 scheduleAutoDetect 决定。
    $almanac.on('click', '.sp-alm-today-prev', function () { almNudgeToday(-1); });
    $almanac.on('click', '.sp-alm-today-next', function () { almNudgeToday(1); });
    $almanac.on('click', '.sp-alm-today-edit', function () {
        axisState._almTodayEditing = true;
        renderAlmanacPanel();
        setTimeout(() => $in('#sp-alm-today-month').trigger('focus'), 30);
    });
    $almanac.on('click', '.sp-alm-today-cancel', function () { axisState._almTodayEditing = false; renderAlmanacPanel(); });
    $almanac.on('click', '.sp-alm-today-save', async function () {
        const mo = parseInt($in('#sp-alm-today-month').val(), 10);
        const da = parseInt($in('#sp-alm-today-day').val(), 10);
        const weekday = parseInt($in('#sp-alm-today-weekday').val(), 10);
        const result = await axisDateActions.saveManual(mo, da, { storyClock: true, weekday });
        if (!result.ok) return;
        axisState._almTodayEditing = false;
    });
    $almanac.on('click', '.sp-alm-today-clear', function () {
        const key = charStableKey(getContext());
        if (!key) return;
        const cleared = axisDateActions.clearAnchor(key);   // 清锚 → 恢复自动确认
        if (!cleared.ok) { showToast('日期清除失败，请重试', null, true); return; }
        runAnchorAftermath();
        relandStoryClockAnchor();
        showToast('已清除手动日期，恢复自动确认');
    });
    // 月历：翻月 / 选日（再点已选=取消回全月）/ 看全月 / 加到某天
    $almanac.on('click', '.sp-alm-cal-prev', function () { almNavMonth(-1); });
    $almanac.on('click', '.sp-alm-cal-next', function () { almNavMonth(1); });
    $almanac.on('click', '.sp-alm-time-travel', function () {
        const day = Number($(this).attr('data-day'));
        if (Number.isInteger(day)) void startTimeTravel({ month: almCalMonth() + 1, day });
    });
    $almanac.on('click', '.sp-alm-time-travel-stop', function () { void cancelTimeTravel(); });
    $almanac.on('click', '.sp-alm-cell[data-day]', function () { axisCalendarActions.selectDay(parseInt($(this).attr('data-day'), 10)); });
    $almanac.on('click', '.sp-alm-cal-clearsel', function () { axisCalendarActions.selectDay(null); });
    $almanac.on('click', '.sp-alm-add-day', function () {
        openAlmanacEditor(null, { month: almCalMonth() + 1, day: parseInt($(this).attr('data-day'), 10) || 1 });
    });
    // 轴工具栏：宽版按钮与窄版抽屉共享同一动作分发，避免重构后只剩静态按钮。
    const dispatchAlmanacAction = action => {
        if (action === 'add-almanac') return openAlmanacEditor();
        if (action === 'generate-almanac') return triggerGenerateAlmanac();
        if (action === 'supplement-anniversary') return triggerSupplementAnniversary();
        if (action === 'manage-calendar') return openCalendarManager();
        return undefined;
    };
    const toggleAlmanacActionMenu = element => {
        const menu = $(element).closest('.sp-action-menu').get(0);
        if (!menu) return;
        const open = !$(menu).hasClass('sp-action-menu-open');
        closeActionMenus(open ? menu : null);
        $(menu).toggleClass('sp-action-menu-open', open)
            .find('.sp-action-menu-list').attr('hidden', !open)
            .end().find('.sp-action-menu-toggle').attr('aria-expanded', String(open));
    };
    $almanac.off('click.spAxisToolbar', '.sp-alm-add, .sp-alm-gen, .sp-alm-supplement, .sp-alm-manage, .sp-action-menu-toggle, .sp-action-menu-item')
        .on('click.spAxisToolbar', '.sp-alm-add, .sp-alm-gen, .sp-alm-supplement, .sp-alm-manage, .sp-action-menu-toggle, .sp-action-menu-item', function (event) {
            event.preventDefault();
            const $button = $(this);
            if ($button.hasClass('sp-action-menu-toggle')) return toggleAlmanacActionMenu(this);
            const action = $button.attr('data-action') || ($button.hasClass('sp-alm-add') ? 'add-almanac' : $button.hasClass('sp-alm-gen') ? 'generate-almanac' : $button.hasClass('sp-alm-supplement') ? 'supplement-anniversary' : 'manage-calendar');
            const result = dispatchAlmanacAction(action);
            if (result?.then) result.finally(() => closeActionMenus());
            else closeActionMenus();
        });
    // 上下联动：点日历详情里某条 → 高亮它在网格覆盖的那天/那几天，再点一下取消（就地改 class，不重渲）
    $almanac.on('click', '.sp-alm-cal-detail .sp-alm-item', function (e) {
        if ($(e.target).closest('button').length) return;   // 不劫持锁/编辑/删除按钮
        axisCalendarActions.toggleItem($(this).attr('data-id'), { targetIsButton: false });
    });
    $almanac.on('click.spAxisItems', '.sp-alm-pin, .sp-alm-edit, .sp-alm-del', function (e) {
        e.preventDefault(); e.stopPropagation(); const id = $(this).attr('data-id');
        if ($(this).hasClass('sp-alm-pin')) toggleAlmanacPin(id);
        else if ($(this).hasClass('sp-alm-edit')) openAlmanacEditor(id);
        else deleteAlmanacItem(id);
    });
    $almanac.on('click', '#sp-abort-almanac', abortAlmanacGen);
    // F4：日历里点空白处（非日格/条目/控件）→ 清掉当前瞬时态。既回退「选中某天」，也清「上下联动高亮」，两者任一存在都响应，做到点空白必回干净全月。
    $almanac.on('click', function (e) {
        if (!axisState.almanacMode || axisState._almanacEditor || axisState._almanacSheet !== 'calendar') return;
        if ($(e.target).closest('.sp-alm-cell,.sp-alm-item,button,input,select,textarea,.sp-alm-cal-detail-head').length) return;
        axisCalendarActions.blankClick();
    });
    // 内联编辑器：保存 / 取消 / 返回
    $almanac.on('click', '.sp-alm-editor-save', saveAlmanacEditor);
    $almanac.on('click', '.sp-alm-editor-cancel, .sp-alm-editor-back', closeAlmanacEditor);
    $almanac.on('input', '#sp-alm-f-month, #sp-alm-f-day, #sp-alm-f-days', almRenderWdHint);
    // 历法管理使用同一内联容器；所有正式写入只从 commitCalendarDesc 汇流。
    $almanac.on('click', '.sp-alm-manager-back', closeCalendarManager);
    $almanac.on('click', '.sp-alm-manager-chat-link', async function () {
        const filled = await openPluginViewWithPrefill('space', '#sp-space-input', '我想为当前世界设计一套自定义历法。请结合世界观和我讨论纪年名、月份数量、每个月的名称与天数，并在确认后给出完整历法。');
        if (!filled) showToast('已经打开间，但没有找到输入框，请手动填写历法需求', null, true);
        else if (getSettings().notifyMode !== 'off') showToast('已把历法需求预填到间');
    });
    $almanac.on('click', '.sp-alm-manager-edit-start', function () {
        axisCalendarManager.startEditing();
    });
    $almanac.on('click', '.sp-alm-manager-edit-cancel', function () {
        axisCalendarManager.cancelEditing();
    });
    $almanac.on('click', '.sp-alm-manager-add-month', function () {
        axisCalendarManager.addMonth();
    });
    $almanac.on('click', '.sp-alm-manager-month-delete', async function () {
        const index = Number($(this).closest('.sp-alm-manager-month-row').attr('data-index'));
        await axisCalendarManager.deleteMonth(index);
    });
    $almanac.on('click', '.sp-alm-manager-month-copy', function () {
        const index = Number($(this).closest('.sp-alm-manager-month-row').attr('data-index'));
        axisCalendarManager.copyMonth(index);
    });
    $almanac.on('click', '.sp-alm-manager-month-up, .sp-alm-manager-month-down', function () {
        const index = Number($(this).closest('.sp-alm-manager-month-row').attr('data-index'));
        const movingUp = $(this).hasClass('sp-alm-manager-month-up');
        axisCalendarManager.moveMonth(index, movingUp ? -1 : 1);
    });
    $almanac.on('input', '.sp-alm-manager-edit-fields input', function () {
        if (!axisCalendarManager.hasError()) return;
        axisCalendarManager.clearError();
        $inAll('#sp-almanac-wrap .sp-alm-manager-error').remove();
    });
    $almanac.on('click', '.sp-alm-manager-edit-save', async function () {
        const result = await axisCalendarManager.saveDraft();
        if (!result.ok) {
            if (result.cancelled) return;
            const message = result.error || '历法保存失败';
            showToast(message, null, true);
            return;
        }
        if (getSettings().notifyMode !== 'off') showToast(`历法已更新：${calendarSummary(result.cal)}`);
    });
    $almanac.on('click', '.sp-alm-manager-template-head', function () {
        axisCalendarManager.toggleTemplates();
    });
    $almanac.on('click', '.sp-alm-manager-template-save-current', async function () {
        const list = loadCalendarTemplates();
        const name = await customDialog.prompt({
            title: '保存当前历法为模板',
            body: '为当前历法填写一个便于识别的模板名称。',
            initialValue: loadCalDesc().era || '',
            placeholder: '模板名称',
            maxLength: CALENDAR_TEMPLATE_NAME_LENGTH,
            validate: value => !value ? '请填写模板名称' : (list.some(template => template.name === value) ? '模板名称已存在，请换一个名称' : ''),
        });
        if (name == null || !axisCalendarManager.isOpen()) return;
        const result = await axisCalendarManager.create({ name, calendar: loadCalDesc() });
        if (!result.ok) showToast(result.error || '模板保存失败', null, true);
    });
    $almanac.on('click', '.sp-alm-manager-template-rename', async function () {
        const id = $(this).attr('data-id');
        const list = loadCalendarTemplates();
        const template = axisCalendarManager.template(id);
        if (!template) { showToast('模板已不存在', null, true); renderAlmanacPanel(); return; }
        const name = await customDialog.prompt({
            title: '重命名历法模板',
            body: '填写一个便于识别的新名称。',
            initialValue: template.name,
            placeholder: '模板名称',
            maxLength: CALENDAR_TEMPLATE_NAME_LENGTH,
            validate: value => !value ? '请填写模板名称' : (list.some(item => item.id !== id && item.name === value) ? '模板名称已存在，请换一个名称' : ''),
        });
        if (name == null || !axisCalendarManager.isOpen() || name === template.name) return;
        const result = await axisCalendarManager.rename(id, name);
        if (!result.ok) showToast(result.error || '模板重命名失败', null, true);
    });
    $almanac.on('click', '.sp-alm-manager-template-apply', async function () {
        const id = $(this).attr('data-id');
        const template = axisCalendarManager.template(id);
        if (!template) { showToast('模板已不存在', null, true); renderAlmanacPanel(); return; }
        const ok = await customDialog.confirm({ title: '应用历法模板', body: `确定用「${template.name}」覆盖当前历法吗？`, confirmText: '应用', cancelText: '取消' });
        if (!ok || !axisCalendarManager.isOpen()) return;
        const result = await axisCalendarManager.apply(id);
        if (!result.ok) { if (!result.cancelled) showToast(result.error || '模板应用失败', null, true); return; }
        axisCalendarManager.cancelEditing();
        renderAlmanacPanel({ reveal: { kind: 'template', id: template.id }, focus: { kind: 'template', id: template.id, selector: '.sp-alm-manager-template-apply' } });
        if (getSettings().notifyMode !== 'off') showToast(`已应用历法模板：${template.name}`);
    });
    $almanac.on('click', '.sp-alm-manager-template-delete', async function () {
        const id = $(this).attr('data-id');
        const template = axisCalendarManager.template(id);
        if (!template) { showToast('模板已不存在', null, true); renderAlmanacPanel(); return; }
        const result = await axisCalendarManager.delete(id, { confirm: () => customDialog.confirm({ title: '删除历法模板', body: `确定删除「${template.name}」吗？角色卡绑定也会一并解除。`, confirmText: '删除', cancelText: '取消' }) });
        if (!result.ok && result.reason !== 'cancelled') showToast(result.error || '模板删除失败', null, true);
    });
    $almanac.on('click', '.sp-alm-manager-template-bind', function () {
        const id = $(this).attr('data-id');
        const opening = axisCalendarManager.bindingId() !== id;
        axisCalendarManager.setBindingView(id, opening);
    });
    $almanac.on('input', '.sp-alm-manager-bind-search', function () {
        if (!axisCalendarManager.isOpen()) return;
        axisCalendarManager.setBindingQuery($(this).val());
        const id = $(this).attr('data-template-id');
        $(this).closest('.sp-alm-manager-bind-panel').find('.sp-alm-manager-bind-results').html(axisCalendarManager.renderBindingOptions(id));
    });
    $almanac.on('click', '.sp-alm-manager-bind-option', async function () {
        await axisCalendarManager.updateBinding($(this).attr('data-avatar'), $(this).attr('data-template-id'));
    });
    $almanac.on('click', '.sp-alm-manager-bind-chip-remove', async function () {
        await axisCalendarManager.updateBinding($(this).attr('data-avatar'), null, $(this).attr('data-template-id'));
    });

    // 批次3：同 spIntro——action 菜单在 shadow 内，target 重定向失效，改 composedPath 判断。
    // hotfix3：合成事件无 originalEvent → ?. 防御，path 为空 → some()=false → 走关闭分支（安全默认）
    $(document).off('click.spActionMenu').on('click.spActionMenu', function (event) {
        if (!(event.originalEvent?.composedPath?.() || []).some(el => el instanceof Element && el.matches('.sp-action-menu'))) closeActionMenus();
    });
    // 批次3：keydown 是 composed 事件，从 shadow 冒泡到 document 照常触发、无 target 判断 → 无需改。
    $(document).off('keydown.spActionMenu').on('keydown.spActionMenu', function (event) {
        if (event.key === 'Escape') closeActionMenus();
    });

    // Tab switching: sidebar (schedule/outline/lines) + sub-toggle (user/char)
    $in('.sp-root').on('click', '.sp-view-btn', function () {  // 全窗委托（含 .sp-content-head 内 sub-btn/ta-trigger），等价原宿主级绑定
        // 点生成不再冻结整个侧栏：切模块(历/线/面/棱/锚)随时可用——点正文按状态重建（下方 schedule 分支），
        // 生成完成走 stillOnView 守卫写进(可能隐藏的) #sp-body，切走不被覆盖、切回自动补正。
        // 仅「我/TA」子切换在点生成途中仍挡（点按视角生成，中途换视角无意义）。
        const view = $(this).data('view');
        if (!view) return;
        $in('#sp-module-intro-pop').hide();   // 切模块即收起介绍气泡

        const $btn      = $(this);
        const isSideTab = $btn.hasClass('sp-side-tab');
        const isSubBtn  = $btn.hasClass('sp-sub-btn');
        if (isSideTab && settingsOpen) toggleSettings();

        // 离开棱时统一走 UI 生命周期出口，避免全屏滚动锁和 Esc listener 跟到其他侧栏。
        if (isSideTab && theaterMode && view !== 'theater') theaterFeature.leave();

        // 切模块（历/线/面/棱/锚/轴）会藏掉 sub-toggle → 顺手收起可能开着的 TA▾ 抽屉，免得它残留浮在别处。
        if (isSideTab) closeTaDrawer();

        // TA▾ 触发器：不直接切视角，而是开/关「固定槽抽屉」（换人入口，已与刷新解耦）。
        // 生成途中锁子切换（沿用 isSubBtn 分支原守卫）。active 态 / 标签由抽屉内真正切到某 char 时再落。
        if ($btn.hasClass('sp-ta-trigger')) {
            if (pointState.isGenerating) return;
            toggleTaDrawer();
            return;
        }

        // Update active state within the button's group
        if (isSideTab) {
            $inAll('.sp-side-tab.sp-view-btn').removeClass('sp-view-active');
            $btn.addClass('sp-view-active');
            _lastMainView = view;   // 记住当前模块视图，供下次打开面板时恢复（同 chat）
        } else if (isSubBtn) {
            $inAll('.sp-sub-btn').removeClass('sp-view-active');
            $btn.addClass('sp-view-active');
        }

        // Sidebar clicks
        if (isSideTab) {
            if (view === 'outline') {
                if (outlineMode) return;
                outlineMode = true;
                linesMode = false;
                spaceMode = false;
                theaterMode = false;
                axisState.almanacMode = false;
                $in('#sp-body').hide();
                $in('#sp-lines-wrap').hide();
                $in('#sp-space-wrap').hide();
                $in('#sp-theater-wrap').hide();
                $in('#sp-anchor-wrap').hide();
                $in('#sp-almanac-wrap').hide();
                $in('#sp-outline-wrap').css('display', 'flex');
                $in('#sp-sub-toggle').hide();
                $in('#sp-content-title').text('面');
                outlineFeature.open();
                return;
            }
            if (view === 'lines') {
                if (linesMode) return;
                linesMode = true;
                outlineMode = false;
                spaceMode = false;
                theaterMode = false;
                axisState.almanacMode = false;
                $in('#sp-body').hide();
                $in('#sp-outline-wrap').hide();
                $in('#sp-space-wrap').hide();
                $in('#sp-theater-wrap').hide();
                $in('#sp-anchor-wrap').hide();
                $in('#sp-almanac-wrap').hide();
                $in('#sp-lines-wrap').css('display', 'flex');
                $in('#sp-sub-toggle').hide();
                $in('#sp-content-title').text('线');
                // 生成在途时切回来：重建 loading，别 fallback 到"生成线"空态误导用户
                if (linesRuntime.busy) {
                    linesFeature.renderBody(loadingHtml('正在推演线', 'sp-abort-lines'));
                } else {
                    const cached = loadCachedLinesForCurrentChat();
                    if (cached) linesFeature.renderBody(cached);
                    else linesFeature.renderBody(renderEmptyLinesState());
                }
                return;
            }
            if (view === 'space') {
                if (spaceMode) return;
                spaceMode = true;
                outlineMode = false;
                linesMode = false;
                theaterMode = false;
                axisState.almanacMode = false;
                $in('#sp-body').hide();
                $in('#sp-outline-wrap').hide();
                $in('#sp-lines-wrap').hide();
                $in('#sp-theater-wrap').hide();
                $in('#sp-anchor-wrap').hide();
                $in('#sp-almanac-wrap').hide();
                $in('#sp-space-wrap').css('display', 'flex');
                $in('#sp-sub-toggle').hide();
                $in('#sp-content-title').text('间');
                spaceFeature.open();
                return;
            }
            if (view === 'theater') {
                if (theaterMode) return;
                theaterMode = true;
                outlineMode = false;
                linesMode = false;
                spaceMode = false;
                axisState.almanacMode = false;
                $in('#sp-body').hide();
                $in('#sp-outline-wrap').hide();
                $in('#sp-lines-wrap').hide();
                $in('#sp-space-wrap').hide();
                $in('#sp-anchor-wrap').hide();
                $in('#sp-almanac-wrap').hide();
                $in('#sp-theater-wrap').css('display', 'flex');
                $in('#sp-sub-toggle').hide();
                $in('#sp-content-title').text('棱');
                if (theaterFeature.busy) setTheaterBody(loadingHtml('正在折射', 'sp-abort-theater'));
                else theaterFeature.open();
                return;
            }
            if (view === 'anchor') {
                enterCoordinateSidebar({
                    resetModes: () => { outlineMode = false; linesMode = false; spaceMode = false; theaterMode = false; axisState.almanacMode = false; },
                    hidePanels: () => { $in('#sp-body').hide(); $in('#sp-outline-wrap').hide(); $in('#sp-lines-wrap').hide(); $in('#sp-space-wrap').hide(); $in('#sp-theater-wrap').hide(); $in('#sp-almanac-wrap').hide(); },
                    showCoordinate: () => $in('#sp-anchor-wrap').css('display', 'flex'),
                    hideSubToggle: () => $in('#sp-sub-toggle').hide(),
                    setTitle: title => $in('#sp-content-title').text(title),
                    feature: coordinateRuntime?.feature,
                });
                return;
            }
            if (view === 'almanac') {
                if (axisState.almanacMode) return;
                axisState.almanacMode = true;
                outlineMode = false;
                linesMode = false;
                spaceMode = false;
                theaterMode = false;
                $in('#sp-body').hide();
                $in('#sp-outline-wrap').hide();
                $in('#sp-lines-wrap').hide();
                $in('#sp-space-wrap').hide();
                $in('#sp-theater-wrap').hide();
                $in('#sp-anchor-wrap').hide();
                $in('#sp-almanac-wrap').css('display', 'flex');
                $in('#sp-sub-toggle').hide();
                $in('#sp-content-title').text('轴');
                renderAlmanacPanel();
                return;
            }
            // view === 'schedule' — leaving outline/lines/space/theater/anchor/almanac, restore body
            if (outlineMode) { outlineMode = false; $in('#sp-outline-wrap').hide(); }
            if (linesMode)   { linesMode   = false; $in('#sp-lines-wrap').hide(); }
            if (spaceMode)   { spaceMode   = false; $in('#sp-space-wrap').hide(); }
            if (theaterMode) { theaterMode = false; $in('#sp-theater-wrap').hide(); }
            coordinateRuntime?.feature?.close?.(); $in('#sp-anchor-wrap').hide();
            if (axisState.almanacMode) { axisState.almanacMode = false; $in('#sp-almanac-wrap').hide(); }
            $in('#sp-body').show();
            $in('#sp-sub-toggle').show();
            $in('#sp-content-title').text('点');
            $inAll('.sp-sub-btn').removeClass('sp-view-active');
            $inAll(`.sp-sub-btn[data-view="${currentView}"]`).addClass('sp-view-active');
            updateTaTriggerLabel();   // 回点视图：TA▾ 标签跟随当前视角（char 显名 / user 回落 TA）
            // 生成在途/切走再切回：从状态重建正文（镜像 线/面/棱），别露上次残留或僵尸转圈
            if (pointState.isGenerating) setBody(loadingHtml('正在规划', 'sp-abort-generate'));
            else if (pointState.cachedSchedule) setBody(pointState.cachedSchedule);
            else showEmptyGenerate();
            return;
        }

        // Sub-toggle clicks：走到这里只剩「我」（TA▾ 触发器已在上面拦截并 return）。
        if (isSubBtn) {
            if (pointState.isGenerating) return;   // 点生成途中不切视角：本次生成绑定当前视角，中途换「我/TA」无意义
            closeTaDrawer();            // 切回「我」顺手收起 TA 抽屉
            if (view === currentView) return;
            setView('user');
            if (pointState.cachedSchedule) setBody(pointState.cachedSchedule);
            else showEmptyGenerate();
            return;
        }
    });

    $in('#sp-cfg-save').on('click', function () {
        const $msg = $in('#sp-cfg-msg');
        $msg.text('已自动保存 ✓');
        clearTimeout(this._autoSaveHintTimer);
        this._autoSaveHintTimer = setTimeout(() => $msg.text(''), 2000);
        if (settingsOpen) toggleSettings();
    });
    $in('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $in('#sp-fetch-models').on('click',  fetchModels);
    $in('#sp-diagnostic-export').on('click', function () {
        void shareRecentDiagnosticTrace({
            copyText: copyPlainText,
            promptTextarea: options => customDialog.promptTextarea(options),
            notify: (message, isError) => showToast(message, null, isError),
        });
    });
    bindApiPresetEvents();
    renderApiPresetList();
    renderUtilityPresetList();
    $in('#sp-scale-row').on('change.autoSave', 'input[name="sp-lines-scale"]', function () {
        const charKey = charStableKey(getContext());
        if (!charKey) return;
        setScale(charKey, this.value);
        refreshLinesInjection();
    });
    $in('#sp-adult-row').on('change.autoSave', 'input[name="sp-lines-adult-mode"]', function () {
        const charKey = charStableKey(getContext());
        if (!charKey) return;
        setAdultMode(charKey, this.value);
        refreshLinesInjection();
    });
    // 插件总开关：立刻生效——关则全隐身（藏球/清楼内块/断后台/撤注入），开则按各子开关恢复。
    // 用 stSaveSettings 立即落盘，避免用户切完立刻刷新丢状态（与 customPrompt 同理）。
    $in('#sp-plugin-enabled').on('change', function () {
        getSettings().pluginEnabled = this.checked;
        stSaveSettings();
        applyPluginEnabled(this.checked);
    });
    // 潜伏注入总闸：立刻生效——重设线 / 面 / 暗历三路注入（关时内部各自清空）。
    $in('#sp-inject-enabled').on('change', function () {
        getSettings().injectEnabled = this.checked;
        saveSettingsDebounced();
        refreshLinesInjection();
        outlineFeature.injection.refresh();
        refreshLedgerInjection();
    });
    // Master switch: apply immediately so the user sees inline blocks appear/
    // disappear the moment they toggle, not on next AI message.
    $in('#sp-lines-enabled').on('change', function () {
        getSettings().linesEnabled = this.checked;
        saveSettingsDebounced();
        // Refresh chat area: on → back-fill latest floor with block; off → clear all
        backfillLinesInlineBlocks();
    });
    // 线·楼内块显隐开关（独立于线主开关 linesEnabled）：立刻生效。渲染窗口按段开关重算所有窗内楼。
    // 线的推进与潜伏注入不受影响（refreshLinesInjection 另在 backfill/sync 路径）。
    $in('#sp-lines-inline-enabled').on('change', function () {
        getSettings().linesInlineEnabled = this.checked;
        saveSettingsDebounced();
        refreshInlineWindow(true);
    });
    // 轴日历块开关：立刻生效。段开关变 → 刷新当前渲染窗口（每层楼的轴日历段随之显/隐）。
    $in('#sp-almanac-inline-enabled').on('change', function () {
        getSettings().almanacInlineEnabled = this.checked;
        saveSettingsDebounced();
        refreshInlineWindow(true);
    });
    // 点·日程条开关：立刻生效。段开关变 → 重算所有窗内楼。
    $in('#sp-schedule-inline-enabled').on('change', function () {
        getSettings().scheduleInlineEnabled = this.checked;
        saveSettingsDebounced();
        refreshInlineWindow(true);
    });
    $in('#sp-adult-blur-enabled').on('change', function () {
        getSettings().adultBlurEnabled = this.checked;
        saveSettingsDebounced();
        if (linesMode) linesFeature.refreshPanel();
        if (!outlineMode && !linesMode && !spaceMode) {
            const saved = readStore(getCacheKey(currentView, charViewName));
            pointState.cachedSchedule = saved?.raw ? renderSchedule(saved.raw, saved.userName || '用户', currentView, loadCalDesc()) : null;
            if (pointState.cachedSchedule) setBody(pointState.cachedSchedule);
        }
        refreshInlineWindow(true);
    });
    // 标注池·显隐开关（AI 楼）：只控这只读回显框显/隐，与注入 ledgerInject 解耦（关它注入照旧、只是不回显）。
    $in('#sp-ledger-inline-enabled').on('change', function () {
        getSettings().ledgerInlineEnabled = this.checked;
        saveSettingsDebounced();
        refreshInlineWindow(true);
    });
    // 召回·显隐开关（用户楼）：独立于标注池，只控用户楼召回框显/隐；与注入解耦。
    $in('#sp-recall-inline-enabled').on('change', function () {
        getSettings().recallInlineEnabled = this.checked;
        saveSettingsDebounced();
        refreshInlineWindow(true);
    });
    // 统一框渲染深度：0=跟随酒馆助手（读不到再兜底），正数=用它。改了立即重算窗口。
    $in('#sp-inline-render-depth').on('change', function () {
        const n = Math.max(0, Math.floor(Number(this.value) || 0));
        getSettings().inlineRenderDepth = n;
        this.value = String(n);   // 规范化回填（负数/小数 → 0/取整）
        saveSettingsDebounced();
        refreshInlineWindow(true);
    });
    // 潜伏注入开关：立刻生效——on → 注入当前活跃线；off → 清空扩展 prompt
    $in('#sp-lines-inject').on('change', function () {
        getSettings().linesInject = this.checked;
        saveSettingsDebounced();
        refreshLinesInjection();
    });
    // 时间戳开关：on → 立即注入首尾戳指令；off → 清空扩展 prompt（下楼主模型就不再被要求打戳）。
    // 面板开着则重渲染历，让「时间戳」只读行随之出现/消失（读回不依赖开关，但显示随开关走更直观）。
    $in('#sp-storyclock-enabled').on('change', function () {
        getSettings().storyClockEnabled = this.checked;
        saveSettingsDebounced();
        refreshStoryClockInjection();
        if (axisState.almanacMode) renderAlmanacPanel();
    });
    // 冷知识自动开关：off 只停随线生成与楼层展示，历史保留并仍可在线面板查看。
    $in('#sp-dashed-enabled').on('change', function () {
        getSettings().dashedEnabled = this.checked;
        saveSettingsDebounced();
        if (linesMode) linesFeature.refreshPanel();
        syncLatestInlineBlock();
    });
    $in('#sp-dashed-cleanup-enabled').on('change', function () {
        getSettings().dashedCleanupEnabled = this.checked;
        $in('#sp-dashed-keep-count').prop('disabled', !this.checked);
        saveSettingsDebounced();
        if (this.checked) linesFeature.dashed.cleanup(true);
    });
    $in('#sp-dashed-keep-count').on('change', function () {
        const count = linesFeature.dashed.normalizeKeepCount(this.value);
        getSettings().dashedKeepCount = count;
        this.value = String(count);
        saveSettingsDebounced();
        if (getSettings().dashedCleanupEnabled !== false) linesFeature.dashed.cleanup(true);
    });
    // 大纲自动注入（面）开关：on → 按当前大纲+游标立即注入；off → 清空扩展 prompt（游标留 chat_metadata，再开即续）
    $in('#sp-outline-inject').on('change', function () {
        getSettings().outlineInject = this.checked;
        saveSettingsDebounced();
        outlineFeature.resetJudgeCounter();
        outlineFeature.injection.refresh();
        if (outlineMode) outlineFeature.refreshPanel();
    });
    // 大纲判定间隔：改完即重新计数（避免旧计数立刻触发判定）
    $in('#sp-outline-judge-interval').on('change', function () {
        const n = Math.max(1, parseInt(this.value, 10) || 3);
        getSettings().outlineJudgeInterval = n;
        this.value = String(n);
        saveSettingsDebounced();
        outlineFeature.resetJudgeCounter();
    });
    // 历·自动确认当前日期 开关：改完重置历计数（避免残留计数刚开就判）
    $in('#sp-almanac-autodetect').on('change', function () {
        getSettings().almanacAutoDetect = this.checked;
        saveSettingsDebounced();
        almanacJudgeCounter = 0;
    });
    // 历·确认间隔：改完重新计数
    $in('#sp-almanac-judge-interval').on('change', function () {
        const n = Math.max(1, parseInt(this.value, 10) || 3);
        getSettings().almanacJudgeInterval = n;
        this.value = String(n);
        saveSettingsDebounced();
        almanacJudgeCounter = 0;
    });
    // 界面字号缩放：−/＋ 各 ±5%，夹 0.8–1.3、吸附到 0.05 网格；写 --sp-scale（即时生效）+ 存 uiScale + 回填读数。
    function applyUiScale(v) {
        const s = Math.min(1.3, Math.max(0.8, Math.round(v * 20) / 20));
        getSettings().uiScale = s;
        document.documentElement.style.setProperty('--sp-scale', String(s));
        $in('#sp-uiscale-val').text(Math.round(s * 100) + '%');
        saveSettingsDebounced();
    }
    $in('#sp-uiscale-minus').on('click', () => applyUiScale((Number(getSettings().uiScale) || 1) - 0.05));
    $in('#sp-uiscale-plus').on('click',  () => applyUiScale((Number(getSettings().uiScale) || 1) + 0.05));
    // 界面字体·应用：读取 CSS 中首个 @font-face 的 family 后再一次性保存；失败不污染旧设置。
    // （按钮/输入框在 shadow 窗口内，$→$in）
    $in('#sp-font-apply').on('click', async () => {
        const url = ($in('#sp-cfg-font-url').val() || '').trim();
        if (!url) {
            showToast('字体 CSS URL 不能为空，未修改现有字体', null, true);
            return;
        }
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const family = parseFontFamilyFromCss(await response.text());
            if (!family) throw new Error('未找到有效的 @font-face font-family');
            getSettings().uiFontUrl = url;
            getSettings().uiFontFamily = family;
            saveSettingsDebounced();
            applyUiFont();
            showToast(`字体已应用：${family}`);
        } catch (error) {
            console.warn('[SP font] CSS 读取或解析失败', error);
            showToast('字体 CSS 读取失败，未修改现有字体；请检查 URL 或 CSS 中的 @font-face', null, true);
        }
    });
    // 界面字体·恢复默认：回填构画自带的有爱圆体 URL/字体名
    $in('#sp-font-reset').on('click', () => {
        getSettings().uiFontUrl    = SP_FONT_DEFAULT_URL;
        getSettings().uiFontFamily = SP_FONT_DEFAULT_FAMILY;
        $in('#sp-cfg-font-url').val(SP_FONT_DEFAULT_URL);
        saveSettingsDebounced();
        applyUiFont();
        showToast('已恢复默认字体');
    });
    // 点·后台自动跟随「今天」：只写值。点无独立判定车，跟随经 runAnchorAftermath 门控，无计数器可重置。
    $in('#sp-schedule-autodetect').on('change', function () {
        getSettings().scheduleAutoDetect = this.checked;
        saveSettingsDebounced();
    });
    // 暗历·潜伏注入开关（原挂暗历 sheet，2.x 挪进设置「轴」区）：on → 按当前账+场景立即注入；off → 清空扩展 prompt + 回显。
    $in('#sp-ledger-inject').on('change', function () {
        getSettings().ledgerInject = this.checked;
        saveSettingsDebounced();
        refreshLedgerInjection();
        refreshInlineWindow(true);   // 回显框随注入集变——开/关即时刷窗，让「标注打捞」出现/消失
    });
    $in('#sp-ledger-capture-enabled').on('change', function () {
        getSettings().ledgerCaptureEnabled = this.checked;
        saveSettingsDebounced();
        ledgerCaptureCounter = 0;
    });
    $in('#sp-ledger-capture-interval').on('change', function () {
        const n = Math.max(1, Math.min(30, Math.floor(Number(this.value) || 5)));
        getSettings().ledgerCaptureInterval = n; this.value = String(n); saveSettingsDebounced(); ledgerCaptureCounter = 0;
    });
    $in('#sp-ledger-judge-interval').on('change', function () {
        const n = Math.max(1, Math.min(30, Math.floor(Number(this.value) || 4)));
        getSettings().ledgerJudgeInterval = n; this.value = String(n); saveSettingsDebounced(); ledgerJudgeCounter = 0;
    });
    // 楼内渲染框·主开关：关 → 整框全清、停观察；开 → 重算窗口挂回。三个子开关只在它开时才起效。
    $in('#sp-inline-render-enabled').on('change', function () {
        getSettings().inlineRenderEnabled = this.checked;
        saveSettingsDebounced();
        refreshInlineWindow(true);
    });
    // 通知提醒·三档：off 全静音 / lite 仅手动生成·刷新 / full 另在后台自动改动时提示
    $in('input[name="sp-notify-mode"]').on('change', function () {
        getSettings().notifyMode = $in('input[name="sp-notify-mode"]:checked').val();
        saveSettingsDebounced();
    });
    // 锚：楼层收藏入口开关——on → 补按钮；off → 清掉所有已注入按钮
    $in('#sp-anchor-inline-btn').on('change', function () {
        getSettings().anchorInlineBtn = this.checked;
        saveSettingsDebounced();
        coordinateRuntime?.feature?.scanButtons();
    });
    // Inline model list: pick an item → write to input + refresh active highlight
    $in('#sp-model-list-items').on('click', '.sp-model-list-item', function () {
        const model = $(this).attr('data-model');
        $in('#sp-cfg-model').val(model);
        $in('#sp-cfg-model').trigger('change');
        syncPresetState();
        $inAll('.sp-model-list-item').removeClass('sp-model-list-item-active');
        $(this).addClass('sp-model-list-item-active');
    });
    // Inline model list: live-filter as user types
    $in('#sp-model-list-search').on('input', function () {
        renderModelList(_cachedModels, $(this).val());
    });
    $in('#sp-cfg-key')
        .on('focus', () => { const r = $in('#sp-cfg-key').data('real'); if (r) $in('#sp-cfg-key').val(r); })
        .on('input', function () { const value = this.value.trim(); $in('#sp-cfg-key').data('real', value); getSettings().apiKey = value; saveSettingsDebounced(); syncPresetState(); })
        .on('blur', function () { const r = $in('#sp-cfg-key').val().trim(); $in('#sp-cfg-key').data('real', r).val(r ? maskKey(r) : ''); getSettings().apiKey = r; saveSettingsDebounced(); syncPresetState(); });
    $in('#sp-cfg-url').on('input change', function () { getSettings().apiUrl = this.value.trim().replace(/\/$/, ''); saveSettingsDebounced(); syncPresetState(); });
    $in('#sp-cfg-model').on('input change', function () { getSettings().apiModel = this.value.trim(); saveSettingsDebounced(); syncPresetState(); });
    $in('#sp-cfg-exclude').on('input change', function () { getSettings().apiExcludeParams = parseExcludeParams(this.value); saveSettingsDebounced(); syncPresetState(); });
    $in('#sp-cfg-timeout').on('input change', function () { const raw = String(this.value ?? '').trim(); const n = Number(raw); syncPresetState(); if (!raw || !Number.isInteger(n) || n < 5 || n > 600) return; getSettings().apiTimeoutSec = n; saveSettingsDebounced(); });
    $in('#sp-cfg-stream').on('change', function () { getSettings().apiStream = this.checked; saveSettingsDebounced(); syncPresetState(); });
    $in('#sp-lines-interval').on('input change', function () { const n = Number(this.value); if (!Number.isInteger(n) || n < 1) return; saveLinesInterval(n); this.value = String(n); });

    $in('#sp-body').on('click', '.sp-tab', function () {
        const rawDay = String($(this).attr('data-day') || '').trim().toLowerCase();
        const $track = $(this).closest('#sp-body').find('.sp-days-track').first();
        const total = Number($track.attr('data-total'));
        if (!Number.isInteger(total) || total < 1) return;
        const idx = rawDay === 'future' ? total - 1 : Number(rawDay);
        if (!Number.isInteger(idx) || idx < 0 || idx >= total) return;
        $inAll('.sp-tab').removeClass('sp-tab-active');
        $(this).addClass('sp-tab-active');
        $track.css('transform', `translateX(-${idx * 100 / total}%)`);
    });

    // Desktop drag: content header acts as the handle (like a title bar).
    // Skipped on mobile — near-fullscreen sheet doesn't move.
    const dragHandle = inEl('.sp-content-head');
    if (dragHandle) {
        dragHandle.addEventListener('mousedown',  onDragStart);
        dragHandle.addEventListener('touchstart', onDragStart, { passive: false });
    }
    $in('#sp-resize-handle').on('mousedown', onResizeStart);
    inEl('#sp-resize-handle')?.addEventListener('touchstart', onResizeStart, { passive: false });

    // Outline divider drag（面·聊天分隔条；inEl 防 shadow 下 null 崩掉 injectModal 尾部）
    let divState = null;
    const divEl  = inEl('#sp-outline-divider');
    const chatEl = inEl('#sp-outline-chat');
    function onDivStart(e) {
        e.preventDefault();
        const savedH = parseInt(localStorage.getItem('sp-outline-chat-h')) || 210;
        chatEl.style.height = savedH + 'px';
        divState = { startY: e.touches ? e.touches[0].clientY : e.clientY, startH: chatEl.offsetHeight };
        document.addEventListener('mousemove', onDivMove);
        document.addEventListener('mouseup',   onDivEnd);
        document.addEventListener('touchmove', onDivMove, { passive: false });
        document.addEventListener('touchend',  onDivEnd);
        document.addEventListener('touchcancel', onDivEnd);   // 手机端被系统/滚动打断时派发的是 touchcancel 而非 touchend；漏接它 divState 就卡住 → 黏手
    }
    function onDivMove(e) {
        if (!divState) return;
        // 自愈：触点/按键已松开却还在收 move（手机 touchcancel 漏接、或 PC 鼠标出窗漏 mouseup）→ 立即收尾，别黏住。
        if ((e.touches && e.touches.length === 0) || (!e.touches && e.buttons === 0)) { onDivEnd(); return; }
        e.preventDefault();
        const cy   = e.touches ? e.touches[0].clientY : e.clientY;
        const newH = Math.max(80, Math.min(420, divState.startH + divState.startY - cy));
        chatEl.style.height = newH + 'px';
    }
    function onDivEnd() {
        if (!divState) return;
        localStorage.setItem('sp-outline-chat-h', chatEl.offsetHeight);
        divState = null;
        document.removeEventListener('mousemove', onDivMove);
        document.removeEventListener('mouseup',   onDivEnd);
        document.removeEventListener('touchmove', onDivMove);
        document.removeEventListener('touchend',  onDivEnd);
        document.removeEventListener('touchcancel', onDivEnd);
    }
    divEl.addEventListener('mousedown',  onDivStart);
    divEl.addEventListener('touchstart', onDivStart, { passive: false });
    restoreOutlineChatHeight();
    bindMemoryHandlers();
    bindTheaterHandlers();
    bindStorageHandlers();
}

// ─── View (我 / TA) ───────────────────────────────────────────────────────────

function onRegenClick() {
    if (outlineMode) {
        void outlineFeature.generation.trigger({ reroll: true, module: 'outline' });
        return;
    }
    if (axisState._almSyncingPoint) { showToast('点正在同步到今天，稍候再刷新', null, true); return; }   // 同步在飞：别让点这边的刷新跟后台同步抢 store（否则重排点会被同步写回）
    if (pointState.isGenerating) return;
    // 刷新 = 对当前视角（我 / 当前 char）原地重排，永不弹填写框。
    // 「换人」已彻底交给 TA▾ 抽屉，与刷新解耦——故 user / char 两视角在此完全对称，同走 triggerGenerate。
    // （char 视角靠 charViewName 定主体，triggerGenerate→runGenerate 内部按 currentView/charViewName 取 subject。）
    triggerGenerate();
}

function guessCharName(ctx) {
    // Priority 1: char card name
    if (ctx.name2) return ctx.name2;
    // Priority 2: most frequent "Name:" pattern in recent AI messages
    const NOISE = new Set(['series','chapter','note','summary','part','vol','act','scene',
                           'title','author','narrator','system','user','assistant','ai']);
    const msgs = (ctx.chat || []).filter(m => !m.is_user && !m.is_system).slice(-20);
    const counts = {};
    for (const m of msgs) {
        const matches = [...(m.mes || '').matchAll(/^([^\s：:「」【\[\n*#]{1,12})[：:]/gm)];
        for (const match of matches) {
            const name = match[1].trim();
            if (name && !/[*#<>{}\[\]|\\]/.test(name) && !NOISE.has(name.toLowerCase()))
                counts[name] = (counts[name] || 0) + 1;
        }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || '';
}

function setView(view, charName) {
    currentView = view;
    // 记住"最近看的 char 是谁"：切到 char 更新它；切回 user **不清**——否则再切回 char 时
    // 没了名字，只能退回填名界面（老 bug）。user 视角下泄漏无虞：store.scopeOf 用
    // `view==='char' && charName` 双重门，user 视角 charViewName 再有值也拼不进 char 子键。
    // 真正该清 charViewName 的只有换聊天(CHAT_CHANGED)/主动重选角色(onRegenClick)。
    if (view === 'char' && charName) charViewName = charName;
    $inAll('.sp-view-btn').removeClass('sp-view-active');
    $inAll(`.sp-view-btn[data-view="${view}"]`).addClass('sp-view-active');
    pointState.cachedSchedule = loadCachedForCurrentChat();
}

function switchToCharView() {
    currentView = 'char';
    const ctx     = getContext();
    // Prefer previously confirmed name; fall back to guessing from chat messages
    const guessed = charViewName || guessCharName(ctx);
    // 最近填过的名字（本卡），做快捷 chip；排掉正预填在输入框里的那个，避免重复。
    const recents = store.readRecentCharNames().filter(n => n !== guessed);
    const chipsHtml = recents.length
        ? `<div class="sp-char-recent">
               <span class="sp-char-recent-label">最近：</span>
               ${recents.map(n => `<button type="button" class="sp-char-recent-chip" data-name="${escapeAttr(n)}">${escapeHtml(n)}</button>`).join('')}
           </div>`
        : '';
    setBody(`<div class="sp-char-picker">
        <p class="sp-char-picker-hint"><i class="fa-solid fa-user-pen"></i> 输入要查看点的角色名</p>
        <div class="sp-char-picker-row">
            <input id="sp-char-name-input" class="sp-input" type="text"
                   placeholder="角色 / NPC / 反派皆可" value="${escapeAttr(guessed)}">
            <button id="sp-char-name-confirm" class="sp-save-btn">确认</button>
        </div>
        ${chipsHtml}
        <p class="sp-char-picker-sub">${guessed ? '根据近期对话预填，可直接修改。' : ''}不必是主角，任何出场人物、NPC、反派都能查看其点；查看不占固定槽，想常驻再去 📌 固定</p>
    </div>`);
    $inAll('.sp-view-btn').removeClass('sp-view-active');
    $inAll(`.sp-view-btn[data-view="char"]`).addClass('sp-view-active');
    // .off().on() prevents duplicate bindings on repeated calls
    $in('#sp-char-name-input').off('keydown.charview').on('keydown.charview', e => { if (e.key === 'Enter') confirmCharView(); });
    $in('#sp-char-name-confirm').off('click.charview').on('click.charview', confirmCharView);
    // 点 chip：填进输入框（不直接确认，留一步给用户改），聚焦到末尾。
    $inAll('.sp-char-recent-chip').off('click.charview').on('click.charview', function () {
        $in('#sp-char-name-input').val($(this).attr('data-name')).focus();
    });
    setTimeout(() => { $in('#sp-char-name-input').focus().select(); }, 50);
}

function confirmCharView() {
    const name = $in('#sp-char-name-input').val().trim();
    if (!name) { $in('#sp-char-name-input').focus(); return; }
    store.pushRecentCharName(name);   // 记进"最近填过的名字"，供多人卡下次预填
    setView('char', name);
    updateTaTriggerLabel();
    if (pointState.cachedSchedule) {
        setBody(pointState.cachedSchedule);
    } else {
        triggerGenerate();
    }
}

// ─── TA▾ 固定槽抽屉（换人入口，已与「刷新」解耦）───────────────────────────────
// TA▾ 展开固定槽列表：点槽=切到该 char（读缓存、不弹框、不重生成）、✕=移除该槽、
// 「添加/查看角色」=开填写框查任意角色（含 NPC/反派）。查看不占槽，想固定去点视图头部 📌。
// 固定槽为空时点 TA▾ 直接开填写框（等于旧行为），钉了第一个才有列表可展开。
let _taDrawerOpen = false;

// TA▾ 标签：在 char 视角且有名字时显当前 char 名，否则回落「TA」。
function updateTaTriggerLabel() {
    const label = (currentView === 'char' && charViewName) ? charViewName : 'TA';
    $in('#sp-ta-trigger .sp-ta-label').text(label);
}

function renderTaDrawerHtml() {
    const pins = store.readPinnedChars();
    const slots = pins.map(n => `
        <div class="sp-ta-slot${currentView === 'char' && charViewName === n ? ' sp-ta-slot-active' : ''}" data-name="${escapeAttr(n)}">
            <span class="sp-ta-slot-name">${escapeHtml(n)}</span>
            <button type="button" class="sp-ta-slot-del" data-name="${escapeAttr(n)}" title="移除固定"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');
    return `${slots}<button type="button" class="sp-ta-add"><i class="fa-solid fa-user-plus"></i> 添加 / 查看角色</button>`;
}

function openTaDrawer() {
    $in('#sp-ta-drawer').html(renderTaDrawerHtml()).css('display', 'block');
    _taDrawerOpen = true;
    $in('#sp-ta-trigger').addClass('sp-ta-open');
    // 外点即收：点抽屉/触发器以外任意处关闭（触发器自身的 toggle 另管，故排除它避免双触发）。
    // 批次3：抽屉在 shadow 内，target 重定向失效 → 改 composedPath 判断点击是否落在抽屉/触发器内。
    // hotfix3：合成事件无 originalEvent → ?. 防御，path 为空 → some()=false → 不 return → 走关闭分支（安全默认）
    $(document).off('click.tadrawer').on('click.tadrawer', function (e) {
        if ((e.originalEvent?.composedPath?.() || []).some(el => el instanceof Element && el.matches('#sp-ta-drawer, #sp-ta-trigger'))) return;
        closeTaDrawer();
    });
}

function closeTaDrawer() {
    $in('#sp-ta-drawer').css('display', 'none').empty();
    _taDrawerOpen = false;
    $in('#sp-ta-trigger').removeClass('sp-ta-open');
    $(document).off('click.tadrawer');
}

function toggleTaDrawer() {
    if (_taDrawerOpen) { closeTaDrawer(); return; }
    if (store.readPinnedChars().length) { openTaDrawer(); return; }
    // 无固定槽的两条便利路径（都为了单 char 卡：确认过一次后，「我 ↔ TA」来回切永不再弹填写框）：
    //   · 此刻不在 char 视角、但记得上次看的 char → 直接回到它（读缓存、不弹框），等价于「切回 TA」；
    //   · 否则（从没看过任何 char，或已在 char 视角想换人）→ 开填写框。
    if (currentView !== 'char' && charViewName) { activateCharView(charViewName); return; }
    switchToCharView();
}

// 切到某固定槽 char：读缓存、不弹框、不重生成（无缓存 → 落「生成点」空态，不自动烧 API）。
function activateCharView(name) {
    const n = String(name || '').trim();
    if (!n) return;
    if (pointState.isGenerating) { showToast('点正在生成，稍候再换人', null, true); return; }
    closeTaDrawer();
    setView('char', n);          // 内部置 currentView/charViewName + active 态 + 载 pointState.cachedSchedule
    updateTaTriggerLabel();
    if (pointState.cachedSchedule) setBody(pointState.cachedSchedule);
    else showEmptyGenerate();
}

// 点视图头部 📌 切换：固定/取消固定当前 char（查看与固定解耦，此按钮是唯一的「固定」动作）。
// name 由调用方从按钮 data-name 传入（本卡渲染时的真名），兜底 charViewName——避免全局漂移致「没反应」。
function onCharPinToggle(name) {
    const n = String(name || charViewName || '').trim();
    if (!n) return;
    if (store.isPinnedChar(n)) {
        store.removePinnedChar(n);
        showToast(`已取消固定「${n}」`);
    } else {
        const r = store.addPinnedChar(n);
        if (r === 'full') { showToast(`固定槽已满（最多 ${store.PIN_CAP} 个），先在 TA▾ 里移除一个`, null, true); return; }
        showToast(`已固定「${n}」到 TA▾`);
    }
    // 固定态活在 store（独立于点 raw），故不重写 raw；但要用当前 raw 重跑 renderSchedule（内部读
    // isPinnedChar 定钉子高亮）刷新 pointState.cachedSchedule——否则重开面板/切视图回放旧字符串，钉态丢失
    // （对齐兄弟 triggerTogglePointPin：改完必更 pointState.cachedSchedule，别只改就地 DOM）。
    const saved = readStore(getCacheKey(currentView, charViewName));
    if (saved?.raw) {
        pointState.cachedSchedule = renderSchedule(saved.raw, saved.userName || '用户', currentView, loadCalDesc());
        setBody(pointState.cachedSchedule);
    } else {
        refreshCharPinIcon();   // 无 raw（罕见）→ 至少就地刷图标
    }
    if (_taDrawerOpen) openTaDrawer();   // 抽屉开着则同步重渲（槽增减/高亮）
}

// 就地刷新 📌 图标态（不重渲整份点正文）。图标恒 solid，只切颜色类 .sp-pinned（见 renderSchedule 注释）。
// 以 DOM 上按钮的 data-name 为准（兜底 charViewName）。
function refreshCharPinIcon() {
    const $btn = $in('#sp-body .sp-point-pin-char');
    const pinned = store.isPinnedChar(String($btn.attr('data-name') || charViewName || '').trim());
    $btn.attr('title', pinned ? '已固定·点击取消固定' : '固定 TA 到 TA▾ 抽屉');
    $btn.toggleClass('sp-pinned', pinned);
}

// ─── Open / close ─────────────────────────────────────────────────────────────

// 面板打开时先重置到点首页作为干净基线，再恢复同聊天上次的 lastMainView；切聊天时该值已复位为点。
// 清掉上次残留的子视图（历/线/面/间/棱/坐标）+ 内联编辑器，不 abort 生成、不动数据缓存。
// 无条件隐藏所有非点 wrap（不靠 mode 标志守卫）：CHAT_CHANGED 在面板隐藏时会把标志清成
// false 却不动 DOM，若这里再按标志判断就会漏隐藏 → 出现「点 + 坐标」同屏。故一律硬隐藏。
function resetPanelToScheduleHome() {
    outlineMode = linesMode = spaceMode = theaterMode = axisState.almanacMode = false;
    $in('#sp-outline-wrap').hide();
    $in('#sp-lines-wrap').hide();
    $in('#sp-space-wrap').hide();
    $in('#sp-theater-wrap').hide();
    $in('#sp-anchor-wrap').hide();
    $in('#sp-almanac-wrap').hide();
    axisState._almanacEditor = null;
    resetLedgerRenderState();
    axisCalendarManager.close();
    $in('#sp-body').show();
    $in('#sp-sub-toggle').show();
    $in('#sp-content-title').text('点');
    $inAll('.sp-outline-btn').removeClass('sp-btn-active');
    $inAll('.sp-side-tab.sp-view-btn').removeClass('sp-view-active');
    $in('.sp-side-tab.sp-view-btn[data-view="schedule"]').addClass('sp-view-active');
    $inAll('.sp-sub-btn').removeClass('sp-view-active');
    $in(`.sp-sub-btn[data-view="${currentView}"]`).addClass('sp-view-active');
}
function openSchedule() {
    showPanel();
    resetPanelToScheduleHome();   // 先归位到点首页（清所有子视图 mode/wrap），作为恢复的干净基线
    // 同 chat 内恢复上次打开的模块视图；切 chat 已把 _lastMainView 复位成 schedule → 默认第一页。
    // 非 schedule：触发该 tab 的 click 让它自渲染（此刻各 mode 均 false，不会被幂等 guard 挡）。
    if (_lastMainView && _lastMainView !== 'schedule') {
        const $tab = $in(`.sp-side-tab.sp-view-btn[data-view="${_lastMainView}"]`);
        if ($tab.length) {
            $tab.trigger('click');
            checkMemoryMigrationNotice();
            return;
        }
    }
    if (pointState.isGenerating) {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-circle-stop"></i>中止生成</button></div>`);
    } else if (pointState.cachedSchedule) {
        setBody(pointState.cachedSchedule);
    } else {
        showEmptyGenerate();
    }
    // Surface schema-migration notice for users who upgrade + open the panel
    // without ever switching chat first (rare but possible after fresh install/update)
    checkMemoryMigrationNotice();
}

function showEmptyGenerate() {
    setBody(`<div class="sp-empty">
        <i class="fa-regular fa-calendar"></i>
        <button class="sp-gen-btn" id="sp-gen-now">生成点</button>
    </div>`);
    $in('#sp-gen-now').on('click', triggerGenerate);
}

function showPanel() {
    const $root  = $(`#${MODAL_ID}`);
    const sheet  = inEl('.sp-sheet');
    // Clear inline animation so the CSS open-animation replays on every show
    if (sheet) sheet.style.animation = '';
    $root.stop(true).css({ display: 'block', opacity: 0 })
         .animate({ opacity: 1 }, 180);
    setTimeout(() => {
        positionPanel();
        syncMobileViewport();
    }, 0);
}

function closePanel() {
    // 关闭主面板时取消活动确认，但独立弹窗宿主本身不隐藏。
    // 收全屏残留：全屏中经背景/FAB 关面板时，若不清这些类，body 的滚动锁会滞留（酒馆卡死），
    // 且 .sp-sheet 的 sp-fs-flat 会带到下次打开（手机右移半屏）。棱、坐标一并清。
    coordinateRuntime?.feature?.close?.();
    theaterFeature.onPanelClosed();
    _activeSpConfirmCancel?.();
    _activeStoreConflictFinish?.('defer');
    removeDialogOverlays();
    customDialog.cancelActive();
    $(`#${MODAL_ID}`).stop(true).animate({ opacity: 0 }, 150, function () {
        $(this).css('display', 'none');
    });
}

function setBody(html) { $in('#sp-body').html(html); }

// ─── Memory pre-check helpers ─────────────────────────────────────────────────
// Show a one-time toast when memory schema migration wiped this chat's summaries.
// Called from CHAT_CHANGED and openSchedule so users see it on the next chat
// switch OR the first time they open the panel post-upgrade.
function checkMemoryMigrationNotice() {
    const _ms = getSettings();
    if (_ms.useBaiBaiBook || _ms.useAnima || _ms.useDatabase) return;      // 外置记忆源不受内置记忆迁移影响
    const notice = memory.consumeMigrationNotice?.();
    if (!notice) return;
    const { l0Count, l1Count } = notice;
    const msg = `故事记忆库已升级：${l0Count} 段 L0 + ${l1Count} 章 L1 需重算（点此打开设置补齐）`;
    showToast(msg, () => {
        showPanel();
        if (!settingsOpen) toggleSettings();
        // Expand the memory section so the "补齐缺失" button is visible
        $in('#sp-mem-section').attr('open', 'open');
    });
}

// Called by the three generation triggers (schedule/outline/lines).
// Returns a Promise<boolean>: true if user wants to continue, false if canceled.
async function memoryPreCheckConfirm() {
    // Anima mode: warn only if TavernHelper is missing or the chat-bound
    // worldbook has no anima_summary slices (built-in report is meaningless here).
    if (getSettings().useAnima) {
        const th = globalThis.TavernHelper;
        if (!th || typeof th.getChatWorldbookName !== 'function' || typeof th.getWorldbook !== 'function') {
            return spConfirm({
                title  : 'Anima 记忆源未就绪',
                body   : '当前选的是 Anima 记忆源，但检测不到酒馆助手(TavernHelper)接口。\n继续生成会没有历史记忆注入。',
                note   : '请确认已安装并启用「酒馆助手」与「Anima 记忆系统」，或临时关掉本插件的"使用 Anima 作为记忆源"。',
                confirmText: '继续生成',
                cancelText : '取消',
            });
        }
        let hasSummary = false;
        try { hasSummary = !!(await getAnimaMemText()).trim(); } catch {}
        if (!hasSummary) {
            return spConfirm({
                title  : 'Anima 记忆为空',
                body   : '当前聊天绑定的世界书里没读到 Anima 摘要（anima_summary）。',
                note   : '继续生成会没有历史记忆注入。请先让 Anima 跑出摘要，或确认世界书绑定正确。',
                confirmText: '继续生成',
                cancelText : '取消',
            });
        }
        return true;
    }
    // 柏宝书 mode: skip built-in report (its "pending" is meaningless here).
    // Instead, warn only if 柏宝书 itself says coverage is incomplete.
    if (getSettings().useBaiBaiBook) {
        const api = globalThis.STBaiBaiBook;
        if (!api || typeof api.getInjectedHistory !== 'function') {
            return spConfirm({
                title  : '柏宝书未就绪',
                body   : '当前选的是柏宝书记忆源，但检测不到柏宝书 API。\n继续生成会没有历史记忆注入。',
                note   : '请把柏宝书更新到最新版（旧版没有读取接口），或临时关掉本插件的"使用柏宝书作为记忆源"。',
                confirmText: '仍然继续',
                cancelText : '取消',
            });
        }
        try {
            const cov = api.getInjectedHistory()?.coverage;
            if (cov?.complete === false) {
                const miss = cov.missingAiFloors?.length ?? '?';
                return spConfirm({
                    title  : '柏宝书记忆未覆盖完整',
                    body   : `柏宝书报告缺 ${miss} 楼摘要（missingAiFloors）。`,
                    note   : '继续生成会使用当前柏宝书的历史（可能不完整）。你也可以先去柏宝书补齐。',
                    confirmText: '继续生成',
                    cancelText : '取消',
                });
            }
        } catch {}
        return true;
    }
    if (getSettings().useDatabase) {
        const result = await databaseMemoryAccess.result({ query: '' });
        if (result.text) return true;
        return spConfirm({
            title: '数据库记忆为空',
            body: `${databaseMemoryDiagnostic(result)}。继续生成将不注入数据库历史。`,
            confirmText: '继续生成',
            cancelText: '取消',
        });
    }
    const report = memory.getHealthReport();
    // No memory data yet is OK (fresh chat) — only warn when there ARE issues
    const hasPending = report.pending > 0 || report.permaFailed > 0 || report.strippedEmpty > 0 || report.paused;
    if (!hasPending) return true;
    const lines = [];
    if (report.paused) lines.push('• 记忆系统已暂停（连续失败或单楼超过 3 次）');
    if (report.pending > 0)    lines.push(`• 有 ${report.pending} 楼待摘要`);
    if (report.permaFailed > 0) lines.push(`• 有 ${report.permaFailed} 楼摘要永久失败（需手动补齐）`);
    if (report.strippedEmpty > 0) lines.push(`• 有 ${report.strippedEmpty} 组净化后正文几乎为空（请重查「保留标签」设置）`);
    if (report.busy)           lines.push('• 记忆系统正在后台生成');
    return spConfirm({
        title  : '记忆库不完整',
        body   : lines.join('\n'),
        note   : '继续生成会使用当前记忆库（可能不完整）。你也可以先去修复。',
        confirmText: '继续生成',
        cancelText : '取消',
    });
}

// Simple modal confirm — returns Promise<boolean>.
// Auto-resolves(false) on CHAT_CHANGED or when the panel closes, so callers
// awaiting the promise won't hang.
function spConfirm({ title, body, note, confirmText = '确定', cancelText = '取消' }) {
    return new Promise(resolve => {
        _activeSpConfirmCancel?.();
        $dialog('#sp-confirm').remove();
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            if (_activeSpConfirmCancel === cancel) _activeSpConfirmCancel = null;
            $ov.remove();
            eventSource.removeListener?.(event_types.CHAT_CHANGED, onExternalClose);
            resolve(v);
        };
        const cancel = () => finish(false);
        const onExternalClose = () => finish(false);
        const $ov = $(`<div id="sp-confirm" class="sp-confirm-overlay">
            <div class="sp-confirm-sheet">
                <div class="sp-confirm-head">${escapeHtml(title)}</div>
                <div class="sp-confirm-body">${escapeHtml(body).replace(/\n/g, '<br>')}</div>
                ${note ? `<div class="sp-confirm-note">${escapeHtml(note)}</div>` : ''}
                <div class="sp-confirm-actions">
                    <button class="sp-confirm-cancel">${escapeHtml(cancelText)}</button>
                    <button class="sp-confirm-ok">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        </div>`);
        $ov.find('.sp-confirm-ok').on('click', () => finish(true));
        $ov.find('.sp-confirm-cancel').on('click', () => finish(false));
        $ov.on('click', function (e) { if (e.target === this) finish(false); });
        // 独立弹窗宿主不随 #sp-modal-root 隐藏；空宿主 pointer-events:none，实际遮罩自行开启交互。
        $ov.addClass(`sp-root sp-${currentTheme}`);
        _spDialogShadow.appendChild($ov[0]);
        _activeSpConfirmCancel = cancel;
        eventSource.on(event_types.CHAT_CHANGED, onExternalClose);
    });
}

// ─── 跨设备存储冲突弹窗（迁移检测到云端/本机各一份不同数据）──────────────────────
// 三态：保留云端(丢 localStorage 副本) / 保留本机(localStorage 覆盖云端 + 重载) /
// 点窗外=暂不决定(什么都不动，下次进本 chat 再问)。故意不设「默认破坏动作」——
// 数据两难时，不选就谁都不动。
const KIND_LABEL = { schedule: '点', outline: '面', lines: '线', 'creative-chat': '面·讨论', 'space-chat': '间', almanac: '轴' };

function fmtStoreSide(sum) {
    const labels = (sum?.kinds || []).map(k => KIND_LABEL[k] || k).join('、') || '（无）';
    const when   = sum?.latestTs ? new Date(sum.latestTs).toLocaleString() : '时间未知';
    return `含 ${labels}　·　最近改动 ${when}`;
}

function showStoreConflictDialog(mig) {
    if (!mig || mig.status !== 'conflict') return;
    // 冲突可能在主面板关闭时由 CHAT_CHANGED 触发，必须使用始终可用的独立弹窗宿主。
    _activeStoreConflictFinish?.('defer');
    $dialog('#sp-store-conflict').remove();
    let done = false;
    const finish = (choice) => {
        if (done) return;
        done = true;
        if (_activeStoreConflictFinish === finish) _activeStoreConflictFinish = null;
        $ov.remove();
        eventSource.removeListener?.(event_types.CHAT_CHANGED, onExternalClose);
        if (choice === 'cloud')      store.discardLegacy(mig.legacy);
        else if (choice === 'local') { store.applyLegacyOverCloud(mig.legacy); reloadAfterConflict(); }
        // choice === 'defer' → 什么都不动，下次进本 chat 再弹
    };
    // 换 chat 视为「暂不决定」——绝不趁机替用户改数据
    const onExternalClose = () => finish('defer');
    const $ov = $(`<div id="sp-store-conflict" class="sp-confirm-overlay">
        <div class="sp-confirm-sheet">
            <div class="sp-confirm-head">构画数据冲突</div>
            <div class="sp-confirm-body">这个聊天在别的设备/浏览器也编辑过构画（点线面间），云端和本机各有一份、内容不同。保留哪一份？<br><br>
                <b>云端（跟聊天走）</b>：${escapeHtml(fmtStoreSide(mig.cloud))}<br>
                <b>本机（这台浏览器）</b>：${escapeHtml(fmtStoreSide(mig.local))}</div>
            <div class="sp-confirm-note">只影响构画自己的点线面间，不动记忆 / 棱 / 其他插件。点窗外＝暂不决定，下次再问。</div>
            <div class="sp-confirm-actions">
                <button class="sp-confirm-cancel" data-choice="local">保留本机</button>
                <button class="sp-confirm-ok" data-choice="cloud">保留云端</button>
            </div>
        </div>
    </div>`);
    $ov.find('[data-choice="cloud"]').on('click', () => finish('cloud'));
    $ov.find('[data-choice="local"]').on('click', () => finish('local'));
    $ov.on('click', function (e) { if (e.target === this) finish('defer'); });
    $ov.addClass(`sp-root sp-${currentTheme}`);
    _spDialogShadow.appendChild($ov[0]);
    _activeStoreConflictFinish = finish;
    eventSource.on(event_types.CHAT_CHANGED, onExternalClose);
}

// 冲突「保留本机」善后：localStorage 已覆盖进 metadata 并清空，重跑一遍 CHAT_CHANGED 逻辑
// （重置视图 + 从新 metadata 重载全部缓存 + 重渲染可见视图 + 补内联块）。此刻再扫 legacy 为空 → none，不会自触发。
function reloadAfterConflict() {
    _stListeners.chat?.();
}

// Dynamic loading text: reflect whether memory is currently being built
function loadingHtml(baseText, abortId) {
    // 柏宝书 / Anima mode has no built-in background queue — never show "补全记忆" text.
    const _ms = getSettings();
    const busy = !_ms.useBaiBaiBook && !_ms.useAnima && !_ms.useDatabase && memory.isMemoryBusy();
    const text = busy
        ? `正在补全记忆并${baseText}…`
        : `${baseText}中…`;
    return `<div class="sp-loading">
        <div class="sp-spinner"></div>
        <p class="sp-loading-text">${escapeHtml(text)}</p>
        <button class="sp-abort-btn" id="${abortId}"><i class="fa-solid fa-circle-stop"></i>中止生成</button>
    </div>`;
}

// ─── Generation ───────────────────────────────────────────────────────────────

async function triggerGenerate() {
    return pointController.triggerGenerate();
}

// 前置阶段（世界书组装等）不可打断，若只 abort 不即时复位界面，用户点"中止"会觉得没反应。
// 被中止的旧管线随后走各自 run* 的身份守卫（controller !== myCtrl）静默丢弃，不覆盖界面。
function abortScheduleGen() {
    pointController.abort('manual-abort');
}
function abortLinesGen() {
    if (!linesRuntime.busy) return;
    linesFeature.abortGeneration({ reason: 'manual-abort' });
    if (linesMode && linesFeature.sheet === 'events') linesFeature.refreshPanel();
}
function abortAlmanacGen() {
    if (!axisState.isGeneratingAlmanac) return;
    axisGenerationController.reset('manual-abort');
    if (axisState.almanacMode) renderAlmanacPanel();
}

async function generate(ctx, userName, charName, perspective = 'user', signal = null, pinned = null, travelContext = null, adultMode = 'off', diagnosticSink = null) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) {
        if (!settingsOpen) toggleSettings();
        throw makeDiagnosticError('config-missing');
    }
    const prompt = appendTravelPromptContext(buildPrompt(userName, charName, perspective, pinned, loadCalDesc(), { mode: adultMode, tickets: pointTicketPlan(adultMode, 14) }), travelContext);
    const apiOpts = { ...(travelContext?.feedback === 'time-travel' ? { fullMemory: true, ...travelContext } : (travelContext || {})), promptMode: 'creative', diagnosticModule: 'point', diagnosticSink };
    apiOpts.pointView = perspective;
    return callCustomApi(ctx, prompt, cfg, userName, charName, signal, 3, apiOpts);
}


// ─── World-info entry filter (per chat) ───────────────────────────────────────
// New model: extension_settings[PLUGIN_ID].wiSelectionByChat[chatKey]
// = { version: 1, decisions: { ["worldName::uid"]: boolean } }.
// Every key is initialized exactly once from the host switch, then belongs to this chat.
// Legacy wiFilter / wiFilterByChat remain read-only migration sources.
//
// charKey 用**角色卡文件名 avatar**（如 `坏狗.png`）——它跟着卡文件走、稳定不变。
// 早期误用 ctx.characterId（= this_chid，characters 数组的**下标索引**）：一旦增删/重排
// 角色，索引就漂移，同一张卡下次读到的是别人的（或空）设置——表现为每次进聊天筛选都被重置。
// 2.0.0 换稳定键，旧的数字键数据不迁移（已知会重置一次，发版公告告知用户重选）。
function charStableKey(ctx) {
    const c = ctx?.characters?.[ctx?.characterId];
    return c?.avatar || null;   // 无角色（群聊/未选卡）→ null，各 getter 守卫返回默认
}

function getLegacyWiFilter() {
    const s = getSettings();
    if (!s.wiFilter) s.wiFilter = {};
    return s.wiFilter;
}

function chatStableKey(ctx) {
    const hash = String(ctx?.chatMetadata?.chat_id_hash || '').trim();
    if (hash) return `hash:${hash}`;
    const chatId = String(ctx?.chatId || '').trim();
    const avatar = String(charStableKey(ctx) || '').trim();
    return chatId && avatar ? `legacy:${avatar}:${chatId}` : null;
}

function getLegacyWiFilterByChat() {
    const s = getSettings();
    if (!s.wiFilterByChat || typeof s.wiFilterByChat !== 'object' || Array.isArray(s.wiFilterByChat)) s.wiFilterByChat = {};
    return s.wiFilterByChat;
}

function getWiSelectionByChat() {
    const s = getSettings();
    if (!s.wiSelectionByChat || typeof s.wiSelectionByChat !== 'object' || Array.isArray(s.wiSelectionByChat)) s.wiSelectionByChat = {};
    return s.wiSelectionByChat;
}

function getLegacyDisabledKeys(ctx) {
    const chatKey = chatStableKey(ctx);
    if (chatKey) {
        const byChat = getLegacyWiFilterByChat();
        // An explicitly stored empty chat bucket means "all formerly visible entries allowed".
        if (Object.prototype.hasOwnProperty.call(byChat, chatKey)) {
            return Array.isArray(byChat[chatKey]) ? byChat[chatKey] : [];
        }
    }
    const charKey = charStableKey(ctx);
    const byCharacter = getLegacyWiFilter();
    return charKey && Array.isArray(byCharacter[charKey]) ? byCharacter[charKey] : [];
}

function ensureCurrentWiSelection(ctx, entries) {
    const chatKey = chatStableKey(ctx);
    const stored = chatKey ? getWiSelectionByChat()[chatKey] : null;
    const initialized = initializeWorldInfoSelection({
        stored,
        candidates: entries,
        legacyDisabled: getLegacyDisabledKeys(ctx),
    });
    if (chatKey && initialized.changed) {
        getWiSelectionByChat()[chatKey] = initialized.bucket;
        saveSettingsDebounced();
    }
    return initialized.bucket;
}

function setCurrentWiSelection(ctx, bucket) {
    const chatKey = chatStableKey(ctx);
    const normalized = normalizeWorldInfoSelectionBucket(bucket);
    if (!chatKey || !normalized) return;
    getWiSelectionByChat()[chatKey] = normalized;
    saveSettingsDebounced();
}

function saveCurrentWiSelection() {
    const ctx = getContext();
    const chatKey = chatStableKey(ctx);
    if (!chatKey) return;
    const visible = [];
    $inAll('#sp-wi-list .sp-wi-cb').each(function () { visible.push({ key: $(this).data('key'), checked: this.checked }); });
    const current = ensureCurrentWiSelection(ctx, [..._wiEntryCache.values()]);
    const merged = mergeWorldInfoSelection(current, visible);
    if (merged.changed) setCurrentWiSelection(ctx, merged.bucket);
}

// ─── World-book global exclusion (B方案) ─────────────────────────────────────
// 全局、按书名（非按条目、也非按角色卡）。被排除的书构画**一律不读**——优先级高于「角色卡
// 关联 / 全局启用 / persona 链接」任何一条收录途径（这类书通常是给主楼 AI 读的，不该混进
// 点/线/轴/暗历的判定）。剔除发生在 getCharBookEntries 末尾这一咽喉处，故连设置里「按角色卡
// 挑选」列表也不再显示被排除的书。存 extension_settings[PLUGIN_ID].wiExcludeBooks = [书名,…]
// （书名即 ctx.getWorldInfoNames() 的项）。照 wiFilter 的懒创建：无 DEFAULT_SETTINGS 项，getter 兜空。
function getWiExcludeSet() {
    const s = getSettings();
    const arr = Array.isArray(s.wiExcludeBooks) ? s.wiExcludeBooks : [];
    return new Set(arr.filter(x => typeof x === 'string' && x));
}
function hasWiExcluded(bookName, excluded = getWiExcludeSet()) {
    const name = String(bookName || '').trim();
    return !!name && [...excluded].some(saved => equalsIgnoreCaseAndAccents(saved, name));
}

function setWiExcluded(bookName, excluded) {
    const name = String(bookName || '').trim();
    if (!name) return;
    const s = getSettings();
    const set = new Set(Array.isArray(s.wiExcludeBooks) ? s.wiExcludeBooks : []);
    for (const saved of set) if (equalsIgnoreCaseAndAccents(saved, name)) set.delete(saved);
    if (excluded) set.add(name);
    s.wiExcludeBooks = [...set];
    saveSettingsDebounced();
}

// 当前聊天共享的历/点日期锚（{month, day}），可含人工校准；pending/unresolved 不是有效锚。
// 完整故事时间戳在恢复自动后可重新接管日期来源。
function getDateAnchor(charKey) {
    if (!charKey) return null;
    const local = chatAnchorRepository.get();
    if (local && (local.status === 'unresolved' || local.status === 'pending')) return null;
    if (local) {
        const cal = loadCalDesc();
        if (local.calibration) {
            if (!local.calibration || !Number.isInteger(local.calibration.weekday)) return null;
            const current = latestStoryClockPure(getContext(), ALM_CHAT_SCAN_LIMIT);
            // 半残 SDC 只能作为人工校准的日期相位，不能提前停用校准；
            // 只有当前 AI 楼的 start/end 两侧都完整且无重复歧义时才允许接管。
            if (completeStoryClockPure(current)) {
                const calibrationFloor = local.calibration?.floor;
                if (!Number.isInteger(calibrationFloor) || current.floor !== calibrationFloor) return null;
            }
        }
        return local.month >= 1 && local.month <= calMonthCount(cal) && local.day >= 1 && local.day <= calMonthDays(cal, local.month) ? { month: local.month, day: local.day, ...(local.year != null ? { year: local.year } : {}), ...(local.eraLabel ? { eraLabel: local.eraLabel } : {}) } : null;
    }
    return null;
}

function getStoryCalibration(charKey) {
    if (!charKey) return null;
    const local = chatAnchorRepository.get();
    if (!local?.calibration) return null;
    const cal = loadCalDesc();
    if (local.month < 1 || local.month > calMonthCount(cal) || local.day < 1 || local.day > calMonthDays(cal, local.month)) return null;
    if (!Number.isInteger(local.calibration.weekday) || local.calibration.weekday < 0 || local.calibration.weekday > 6) return null;
    return { month: local.month, day: local.day, refMonth: local.calibration.refMonth ?? local.month, refDay: local.calibration.refDay ?? local.day, weekday: local.calibration.weekday, floor: local.calibration.floor, sourceFloor: local.calibration.sourceFloor, swipe: local.calibration.swipe };
}

function setDateAnchor(charKey, month, day, source = 'explicit', options = {}) {
    return axisDateActions.saveAnchor(charKey, month, day, source, options);
}

// ─── Per-character narrative scale ──────────────────────────────────────────
// Controls the granularity of storyline events. 'auto' means the LLM decides
// from card context; explicit values override that.
// Stored: extension_settings[PLUGIN_ID].scale = { [charStableKey/avatar]: 'auto'|'macro'|'meso'|'micro' }
const SCALE_VALUES = ['auto', 'macro', 'meso', 'micro'];
const SCALE_LABELS = {
    auto : '自动（由 AI 依据剧情判断）',
    macro: '宏观（阴谋 / 势力 / 天下大势）',
    meso : '中观（家族 / 组织 / 职场 / 学派）',
    micro: '微观（人际 / 情感 / 日常）',
};

function getScaleMap() {
    const s = getSettings();
    if (!s.scale || typeof s.scale !== 'object') s.scale = {};
    return s.scale;
}

// charKey = charStableKey(ctx)（角色卡 avatar 文件名），与 wiFilter 同源，理由见 charStableKey 注释。
function getScale(charKey) {
    if (charKey == null) return 'auto';
    const v = getScaleMap()[charKey];
    return SCALE_VALUES.includes(v) ? v : 'auto';
}

function setScale(charKey, value) {
    if (charKey == null) return;
    getScaleMap()[charKey] = SCALE_VALUES.includes(value) ? value : 'auto';
    saveSettingsDebounced();
}

function getAdultModeMap() {
    const s = getSettings();
    if (!s.adultMode || typeof s.adultMode !== 'object') s.adultMode = {};
    return s.adultMode;
}

function getAdultMode(charKey) {
    return adultModeForCharacter(getSettings(), charKey);
}

function setAdultMode(charKey, value) {
    if (charKey == null) return;
    getAdultModeMap()[charKey] = ADULT_MODES.includes(value) ? value : 'off';
    saveSettingsDebounced();
}

// Resolve the list of world-book names to load for the current character.
// Prefers TavernHelper's getCharLorebooks (works uniformly across vanilla ST
// and Luker), falls back to reading character.data directly.
function getLinkedWorldNames(ctx) {
    const names = new Set();
    // 1. TavernHelper — most reliable across ST forks
    try {
        const th = globalThis?.TavernHelper;
        if (th && typeof th.getCharLorebooks === 'function') {
            const books = th.getCharLorebooks();   // { primary, additional }
            if (books?.primary) names.add(String(books.primary).trim());
            if (Array.isArray(books?.additional)) {
                for (const n of books.additional) if (n) names.add(String(n).trim());
            }
            if (names.size) return [...names].filter(Boolean);
        }
    } catch {}
    // 2. Vanilla/Luker fallback — read character.data directly
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const primary = String(char.data?.extensions?.world || '').trim();
    if (primary) names.add(primary);
    try {
        const fileName = getCharaFilename(ctx.characterId);
        const extra = worldInfoCore.world_info?.charLore?.find(item => item?.name === fileName)?.extraBooks;
        if (Array.isArray(extra)) for (const name of extra) if (name) names.add(String(name).trim());
    } catch {}
    // Some cards only have the embedded name without linking
    const embeddedName = String(char.data?.character_book?.name || '').trim();
    if (embeddedName && !primary) names.add(embeddedName);
    return [...names].filter(Boolean);
}

// Global world-info names enabled in ST's right-panel WI selector.
// Three-layer resolution — first hit wins:
//   1. TavernHelper.getLorebookSettings().selected_global_lorebooks (universal)
//   2. Luker-only: ctx.chatWorldInfo.globalSelection
//   3. Vanilla ST: globalThis.world_info.globalSelect
// Empty on any failure — plugin still works with just character books.
function getGlobalWorldNames(ctx) {
    // 1. TavernHelper
    try {
        const th = globalThis?.TavernHelper;
        if (th && typeof th.getLorebookSettings === 'function') {
            const s = th.getLorebookSettings();
            if (Array.isArray(s?.selected_global_lorebooks)) {
                return s.selected_global_lorebooks.filter(Boolean);
            }
        }
    } catch {}
    // 2. Luker wrapper on getContext
    try {
        const luker = ctx?.chatWorldInfo?.globalSelection;
        if (Array.isArray(luker)) return luker.filter(Boolean);
    } catch {}
    // 3. Vanilla ST official live export, with legacy global fallback
    try {
        if (Array.isArray(worldInfoCore.selected_world_info)) return worldInfoCore.selected_world_info.filter(Boolean);
        const vanilla = globalThis?.world_info?.globalSelect;
        if (Array.isArray(vanilla)) return vanilla.filter(Boolean);
    } catch {}
    return [];
}

function getChatWorldNames(ctx) {
    const raw = ctx?.chatMetadata?.world_info;
    const list = Array.isArray(raw) ? raw : [raw];
    return [...new Set(list.map(name => String(name || '').trim()).filter(Boolean))];
}

// Returns live world-info entries for the current character. Uses ctx.loadWorldInfo
// (the live editable copy), NOT ctx.characters[].data.character_book (stale snapshot).
// Fallback to character_book if no linked world book exists.
// Each item: { key, uid, label, preview, content, source, embedded, scope, hostEnabled }
//   scope = 'char'/'chat'/'persona'/'global' → 角色卡、当前聊天、用户 persona 或全局世界书来源
async function getCharBookEntries(ctx) {
    const items = [];
    const seen = new Set();

    // 1. Primary linked world book(s) via loadWorldInfo — live state
    const worldNames = getLinkedWorldNames(ctx);
    for (const name of worldNames) {
        try {
            const data = await ctx.loadWorldInfo(name);
            if (!data?.entries) continue;
            for (const [uid, entry] of Object.entries(data.entries)) {
                const label = entry.comment
                    || (Array.isArray(entry.key) ? entry.key.join(', ') : entry.key)
                    || `条目 ${uid}`;
                const preview = String(entry.content || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, 120);
                const key = `${name}::${uid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                    key, uid,
                    label,
                    preview,
                    content: entry.content || '',
                    source : name,
                    embedded: false,
                    scope  : 'char',
                    hostEnabled: entry?.disable !== true,
                });
            }
        } catch { /* ignore individual load failure */ }
    }

    // 2. Fallback: character_book embedded in the card (only if no external world worked)
    if (items.length === 0) {
        const char = ctx.characters?.[ctx.characterId] ?? {};
        const charBook = char.data?.character_book;
        if (charBook?.entries?.length) {
            const bookName = charBook.name || '角色内置世界书';
            for (const e of charBook.entries) {
                const uid = String(e.uid ?? e.id ?? '');
                const label = e.comment
                    || (Array.isArray(e.key) ? e.key.join(', ') : e.key)
                    || `条目 ${uid}`;
                const preview = String(e.content || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, 120);
                const key = `${bookName}::${uid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                    key, uid,
                    label,
                    preview,
                    content: e.content || '',
                    source : bookName,
                    embedded: true,
                    scope  : 'char',
                    // V2 card spec uses enabled; tolerate historical disabled-shaped cards too.
                    hostEnabled: typeof e.enabled === 'boolean' ? e.enabled : e.disabled !== true,
                });
            }
        }
    }

    // 3. Chat Lore：只绑定当前聊天的书，换聊天不跟随。
    for (const name of getChatWorldNames(ctx)) {
        try {
            const data = await ctx.loadWorldInfo(name);
            if (!data?.entries) continue;
            for (const [uid, entry] of Object.entries(data.entries)) {
                const label = entry.comment || (Array.isArray(entry.key) ? entry.key.join(', ') : entry.key) || `条目 ${uid}`;
                const key = `${name}::${uid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({ key, uid, label, preview: String(entry.content || '').replace(/\s+/g, ' ').slice(0, 120), content: entry.content || '', source: name, embedded: false, scope: 'chat', hostEnabled: entry?.disable !== true });
            }
        } catch {}
    }

    // 4. Global world-info (enabled via ST's WI panel — top-right世界书面板中间"启用"列表)
    const globalNames = getGlobalWorldNames(ctx);
    for (const name of globalNames) {
        if (worldNames.includes(name)) continue;   // skip if same book is already linked to char
        try {
            const data = await ctx.loadWorldInfo(name);
            if (!data?.entries) continue;
            for (const [uid, entry] of Object.entries(data.entries)) {
                const label = entry.comment
                    || (Array.isArray(entry.key) ? entry.key.join(', ') : entry.key)
                    || `条目 ${uid}`;
                const preview = String(entry.content || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, 120);
                const key = `${name}::${uid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                    key, uid,
                    label,
                    preview,
                    content: entry.content || '',
                    source : name,
                    embedded: false,
                    scope  : 'global',
                    hostEnabled: entry?.disable !== true,
                });
            }
        } catch { /* ignore individual load failure */ }
    }

    // 5. 用户/persona 世界书：ST「人物设定」页给当前 persona 链接的世界书（power_user.persona_description_lorebook）。
    //    与角色卡书同源读法（loadWorldInfo 取活状态），scope='persona' 供设置面板单列一栏、可逐条开关。
    //    已作为角色卡书 / 全局书收录过的同名书跳过，避免重复。
    const personaBook = String(ctx.powerUserSettings?.persona_description_lorebook || '').trim();
    if (personaBook && !worldNames.includes(personaBook) && !globalNames.includes(personaBook)) {
        try {
            const data = await ctx.loadWorldInfo(personaBook);
            if (data?.entries) {
                for (const [uid, entry] of Object.entries(data.entries)) {
                    const label = entry.comment
                        || (Array.isArray(entry.key) ? entry.key.join(', ') : entry.key)
                        || `条目 ${uid}`;
                    const preview = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 120);
                    const key = `${personaBook}::${uid}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    items.push({
                        key, uid, label, preview,
                        content: entry.content || '',
                        source : personaBook,
                        embedded: false,
                        scope  : 'persona',
                        hostEnabled: entry?.disable !== true,
                    });
                }
            }
        } catch { /* ignore persona book load failure */ }
    }

    // 全局排除（B方案）：被拉黑的书名一律剔除——优先级压过上面任何一条收录途径。放在最末统一
    // 过滤，故设置里「按角色卡挑选」列表也看不到这些书（buildWorldInfoContext 与 renderWiList 共用本函数）。
    const excluded = getWiExcludeSet();
    return excluded.size ? items.filter(e => !hasWiExcluded(e.source, excluded)) : items;
}

// Recent chat context — fills the gap between memory (delayed L0/L1 summaries)
// and "what the user just typed". Both 间 and 面 discussions previously saw
// only outline+wi+memText, so the last few floors of the main chat were
// invisible to the assistant — feels like it "ignores context".
// Returns a formatted block or '' when the chat is empty.
async function buildRecentChatContext(ctx, floorCount = 6, perMessageChars = 2500) {
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || !chat.length) return '';
    const charName = ctx.name2 || '角色';
    const s = getSettings();
    const stripOpts = { keepTags: s.keepTags, extraTags: s.extraTags };
    // Walk from the end backwards, collect up to N visible AI entries.
    const rows = [];
    for (let i = chat.length - 1; i >= 0 && rows.length < floorCount; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;   // only visible AI narrative
        const raw = String(m.mes || '');
        if (!raw.trim()) continue;
        const cleaned = memory.stripTags(raw, stripOpts).trim();
        if (!cleaned) continue;
        const speaker = m.name || charName;
        const capped = cleaned.length > perMessageChars
            ? cleaned.slice(0, perMessageChars) + '…'
            : cleaned;
        rows.unshift(`【${speaker}】${capped}`);
    }
    if (!rows.length) return '';
    return `【最近对话】以下是主聊天中最近几层对话原文，供理解当前剧情走向。\n\n${rows.join('\n\n')}`;
}

function worldInfoMaxContext(ctx) {
    try {
        const value = Number(typeof scriptCore.getMaxPromptTokens === 'function' ? scriptCore.getMaxPromptTokens() : NaN);
        if (Number.isFinite(value) && value > 0) return value;
    } catch {}
    const fallback = Number(ctx?.maxContext);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : undefined;
}

function worldInfoGlobalScanData(ctx) {
    let fields = null;
    try {
        if (typeof ctx?.getCharacterCardFields === 'function') fields = ctx.getCharacterCardFields() || null;
    } catch {}
    const character = ctx?.characters?.[ctx?.characterId] || {};
    const data = character?.data || {};
    const cardValue = (field, ...fallbacks) => {
        const value = fields?.[field];
        if (value !== undefined && value !== null) return String(value);
        for (const fallback of fallbacks) if (typeof fallback === 'string') return fallback;
        return '';
    };
    const persona = ctx?.powerUserSettings?.persona_description;
    return {
        personaDescription: cardValue('persona', persona),
        characterDescription: cardValue('description', character.description, data.description),
        characterPersonality: cardValue('personality', character.personality, data.personality),
        characterDepthPrompt: typeof fields?.charDepthPrompt === 'string'
            ? fields.charDepthPrompt
            : cardValue('charDepthPrompt', character.extensions?.depth_prompt?.prompt, data.extensions?.depth_prompt?.prompt),
        scenario: cardValue('scenario', character.scenario, data.scenario),
        creatorNotes: cardValue('creatorNotes', character.creator_notes, data.creator_notes),
        trigger: 'quiet',
    };
}

function worldInfoCandidateKey(world, uid) {
    const book = String(world ?? '').trim();
    const id = String(uid ?? '').trim();
    return book && id ? `${book}::${id}` : '';
}

function worldInfoActivationEntries(result, mode) {
    if (!result || typeof result !== 'object') return null;
    const entries = mode === 'luker' ? result.activatedEntries : result.allActivatedEntries;
    if (mode === 'luker') {
        if (!Array.isArray(entries)) return null;
        if (entries.some(entry => !entry || typeof entry !== 'object' || !worldInfoCandidateKey(entry.world, entry.uid))) return null;
        return entries;
    }
    if (!(entries instanceof Set)) return null;
    const values = [...entries];
    if (values.some(entry => !entry || typeof entry !== 'object' || !worldInfoCandidateKey(entry.world, entry.uid))) return null;
    return values;
}

const WORLD_INFO_TOKEN_BUDGET = 60000;
let lastWorldInfoFailureNoticeKey = '';

async function countWorldInfoTokens(text) {
    const value = String(text || '');
    try {
        const counter = getContext()?.getTokenCountAsync;
        if (typeof counter === 'function') {
            const total = Number(await counter.call(getContext(), value));
            if (Number.isFinite(total) && total >= 0) return { tokens: total, exact: true };
        }
    } catch {}
    let bytes = 0;
    if (typeof TextEncoder === 'function') bytes = new TextEncoder().encode(value).length;
    else for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x7f) bytes++;
        else if (code <= 0x7ff) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
    }
    return { tokens: bytes, exact: false };
}

function notifyWorldInfoActivationFailure(ctx) {
    const key = `${String(ctx?.chatId || ctx?.chatMetadata?.chat_id_hash || 'default')}:${Math.floor(Date.now() / 2000)}`;
    if (lastWorldInfoFailureNoticeKey === key) return;
    lastWorldInfoFailureNoticeKey = key;
    try { showToast('世界书激活失败，本次未注入世界书', null, true); } catch {}
}

async function resolveWorldInfoActivation(ctx, coreChat) {
    const maxContext = worldInfoMaxContext(ctx);
    const includeNames = worldInfoCore.world_info_include_names !== false;
    const globalScanData = worldInfoGlobalScanData(ctx);
    const simulate = ctx?.simulateWorldInfoActivation;
    let lukerFailed = false;
    if (typeof simulate === 'function') {
        try {
            const result = await simulate.call(ctx, {
                coreChat,
                dryRun: true,
                type: 'quiet',
                ...(maxContext ? { maxContext } : {}),
                includeNames,
                globalScanData,
            });
            const entries = worldInfoActivationEntries(result, 'luker');
            if (!entries) throw new Error('invalid Luker world-info activation result');
            return { supported: true, keys: new Set(entries.map(entry => worldInfoCandidateKey(entry?.world, entry?.uid)).filter(Boolean)) };
        } catch (error) {
            console.warn('[构画] Luker 世界书激活失败，回退兼容模式', safeDiagnosticLog('world-info', 'activation', error));
            lukerFailed = true;
        }
    }
    const check = worldInfoCore.checkWorldInfo;
    if (typeof check === 'function') {
        try {
            const chatForWI = coreChat.map(message => {
                const text = String(message.mes ?? message.content ?? '').trim();
                if (!includeNames) return text;
                return `${String(message.name || '').trim()}: ${text}`;
            }).filter(Boolean).reverse();
            const result = await check(chatForWI, maxContext, true, globalScanData);
            const entries = worldInfoActivationEntries(result, 'native');
            if (!entries) throw new Error('invalid native world-info activation result');
            return { supported: true, keys: new Set(entries.map(entry => worldInfoCandidateKey(entry?.world, entry?.uid)).filter(Boolean)) };
        } catch (error) {
            console.warn('[构画] 原生世界书激活失败，回退兼容模式', safeDiagnosticLog('world-info', 'activation', error));
        }
    }
    return { supported: false, failed: true, keys: new Set(), lukerFailed };
}

async function buildWorldInfoContext(ctx) {
    const entries = await getCharBookEntries(ctx);
    const selection = ensureCurrentWiSelection(ctx, entries);
    const coreChat = Array.isArray(ctx?.chat) ? ctx.chat.filter(message => {
        if (!message || message.is_system) return false;
        return String(message.mes ?? message.content ?? '').trim().length > 0;
    }) : [];
    const activation = await resolveWorldInfoActivation(ctx, coreChat);
    if (activation.failed) {
        notifyWorldInfoActivationFailure(ctx);
        console.warn('[构画] 世界书激活失败诊断', {
            ...safeDiagnosticLog('world-info', 'activation', null),
            candidateCount: entries.length,
            lukerAvailable: typeof ctx?.simulateWorldInfoActivation === 'function',
            nativeAvailable: typeof worldInfoCore.checkWorldInfo === 'function',
        });
        return '';
    }
    const candidates = entries
        .filter(e => worldInfoSelectionAllows(selection, e.key))
        .filter(e => activation.keys.has(worldInfoCandidateKey(e.source, e.uid)))
        .map(e => e.content)
        .filter(Boolean);
    if (!candidates.length) return '';

    const kept = [];
    let skipped = 0;
    const titleCount = await countWorldInfoTokens('【世界书】\n');
    const separatorCount = await countWorldInfoTokens('\n\n');
    let estimatedTokens = titleCount.tokens;
    let exactCount = titleCount.exact && separatorCount.exact;
    for (const content of candidates) {
        const counted = await countWorldInfoTokens(content);
        const nextTokens = estimatedTokens + counted.tokens + (kept.length ? separatorCount.tokens : 0);
        estimatedTokens = nextTokens;
        exactCount = exactCount && counted.exact;
        if (nextTokens > WORLD_INFO_TOKEN_BUDGET) {
            skipped++;
            estimatedTokens -= counted.tokens + (kept.length ? separatorCount.tokens : 0);
            continue;
        }
        kept.push(content);
    }
    let finalCount = await countWorldInfoTokens(`【世界书】\n${kept.join('\n\n')}`);
    while (finalCount.tokens > WORLD_INFO_TOKEN_BUDGET && kept.length) {
        const removed = kept.pop();
        skipped++;
        estimatedTokens -= (await countWorldInfoTokens(removed)).tokens + (kept.length ? separatorCount.tokens : 0);
        finalCount = await countWorldInfoTokens(`【世界书】\n${kept.join('\n\n')}`);
    }
    if (skipped) {
        console.warn('[构画] 世界书预算跳过条目诊断', {
            candidateCount: candidates.length,
            activatedCount: activation.keys.size,
            finalEntryCount: kept.length,
            estimatedTokens: finalCount.tokens,
            exactCount: finalCount.exact && exactCount,
            skippedCount: skipped,
            budget: WORLD_INFO_TOKEN_BUDGET,
        });
    }
    if (!kept.length) return '';
    return `【世界书】\n${kept.join('\n\n')}`;
}

// Read Anima's summary layer from the chat-bound worldbook. Anima persists each
// summary slice as <batchId_sliceId>…</batchId_sliceId> inside worldbook entries
// tagged extra.createdBy==="anima_summary", with extra.history[] carrying the
// {unique_id,batch_id,slice_id,narrative_time} index (see Anima worldbook_api.js
// saveSummaryBatchToWorldbook / getLatestRecentSummaries). Chapters/分卷 each get
// their own entry, so we merge across all of them and stitch slices back in
// chronological order. Goes through window.TavernHelper (Anima users always have
// 酒馆助手 installed); returns '' if that runtime or the worldbook isn't there.
// opts.full remains available for the caller, while normal recall ranks slices by
// the current query and recent chat terms, then restores chronological order for
// the selected window. This keeps relevant older summaries without truncating to
// merely the last N entries.
function getAnimaRecallCount() {
    const n = parseInt(getSettings().animaRecallCount, 10);
    return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 20;
}
function animaTextTokens(text) {
    const source = String(text || '').toLowerCase().replace(/\s+/g, ' ');
    const tokens = new Set();
    for (const run of source.match(/[\u3400-\u9fff]{2,}/g) || []) {
        if (run.length <= 8) tokens.add(run);
        for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
    }
    for (const word of source.match(/[a-z0-9_]{2,}/g) || []) tokens.add(word);
    return tokens;
}
function buildAnimaRecallQuery(explicitQuery = '') {
    const ctx = getContext();
    const recent = Array.isArray(ctx?.chat) ? ctx.chat.filter(m => !m?.is_user && !m?.is_system).slice(-6) : [];
    const s = getSettings();
    const tail = recent.map(m => memory.stripTags(String(m?.mes || ''), { keepTags: s.keepTags, extraTags: s.extraTags }).slice(-700)).join('\n');
    return `${explicitQuery}\n${tail}`.slice(-6000);
}
function selectAnimaSlices(slices, query, limit) {
    const q = animaTextTokens(query);
    return slices.map(item => {
        const hay = animaTextTokens(`${item.tags}\n${item.text}`);
        let score = 0;
        for (const token of q) if (hay.has(token)) score += token.length >= 4 ? 2 : 1;
        return { ...item, score, rankTime: Date.parse(item.time) || 0 };
    }).sort((a, b) => b.score - a.score || b.batch - a.batch || b.slice - a.slice || b.rankTime - a.rankTime)
        .slice(0, limit).sort((a, b) => a.batch - b.batch || a.slice - b.slice || a.rankTime - b.rankTime);
}

async function getAnimaMemText(opts = {}) {
    const th = globalThis.TavernHelper;
    if (!th || typeof th.getChatWorldbookName !== 'function' || typeof th.getWorldbook !== 'function') {
        if (!getMemText._animaWarned) {
            getMemText._animaWarned = true;
            console.info('[7dayscal] 选了 Anima 记忆源但酒馆助手(TavernHelper)接口未就绪，本次生成无历史注入');
        }
        return '';
    }
    let wbName = null;
    try { wbName = await th.getChatWorldbookName('current'); } catch {}
    if (!wbName) return '';
    let entries = null;
    try { entries = await th.getWorldbook(wbName); } catch { return ''; }
    if (!Array.isArray(entries)) return '';

    const all = [];
    for (const entry of entries) {
        const ex = entry?.extra;
        if (ex?.createdBy !== 'anima_summary' || !Array.isArray(ex.history)) continue;
        const content = String(entry.content || '');
        for (const h of ex.history) {
            const uid = h.unique_id !== undefined ? h.unique_id : h.index;
            if (uid === undefined || uid === null) continue;
            const sliceTag = String(uid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const sliceMatch = content.match(new RegExp(`<${sliceTag}>([\\s\\S]*?)<\\/${sliceTag}>`));
            const sliceText = sliceMatch?.[1]?.trim();
            if (!sliceText) continue;
            all.push({
                unique_id     : String(uid),
                text          : sliceText,
                tags          : Array.isArray(h.tags) ? h.tags.join(' ') : String(h.tags || ''),
                batch_id      : Number(h.batch_id !== undefined ? h.batch_id : h.index) || 0,
                slice_id      : Number(h.slice_id !== undefined ? h.slice_id : 0) || 0,
                narrative_time: h.narrative_time,
                parentContent : content,
            });
        }
    }
    if (!all.length) return '';

    const selected = selectAnimaSlices(all.map(item => ({ ...item, batch: item.batch_id, slice: item.slice_id, time: item.narrative_time })), buildAnimaRecallQuery(opts.query), getAnimaRecallCount());
    return selected.map(item => item.text).join('\n\n');
}

function getDatabasePrimaryWorldbookName(ctx = getContext()) {
    try {
        const primary = globalThis.TavernHelper?.getCharLorebooks?.()?.primary;
        if (primary) return String(primary).trim();
    } catch {}
    return String(ctx?.characters?.[ctx.characterId]?.data?.extensions?.world || '').trim();
}

function captureDatabaseMemoryTarget() {
    const selectedName = normalizeDatabaseWorldbookName(getSettings().databaseWorldbookName);
    // Do not even consult the primary book when an explicit target is configured:
    // a missing/renamed explicit book must fail visibly instead of crossing archives.
    return {
        selectedName,
        primaryName: selectedName ? '' : getDatabasePrimaryWorldbookName(),
    };
}

function captureDatabaseWorldbookReader() {
    const th = globalThis.TavernHelper;
    if (typeof th?.getWorldbook === 'function') return th.getWorldbook.bind(th);
    let context = null;
    try { context = getContext?.() || null; } catch {}
    if (typeof context?.loadWorldInfo !== 'function') return null;
    return async name => {
        const result = await context.loadWorldInfo(name);
        const entries = result?.entries;
        if (Array.isArray(entries)) {
            if (!entries.length) throw new Error('worldbook-entries-empty');
            return entries;
        }
        if (entries && typeof entries === 'object') {
            const values = Object.values(entries);
            if (!values.length) throw new Error('worldbook-entries-empty');
            return values;
        }
        throw new Error('worldbook-entries-invalid');
    };
}

const databaseMemoryAccess = createDatabaseMemoryAccess({
    captureTarget: captureDatabaseMemoryTarget,
    captureReader: captureDatabaseWorldbookReader,
    buildQuery: buildAnimaRecallQuery,
    getLimit: getAnimaRecallCount,
    selectSlices: selectAnimaSlices,
});

// Memory-source dispatcher. Priority: Anima → 数据库 → 柏宝书 → built-in L0/L1 store. The
// alternate sources are mutually exclusive (enforced in bindMemoryHandlers); each
// returns its own history or nothing (empty prompt block) — no fallback between them.
async function _getMemTextRaw(opts = {}) {
    const s = getSettings();
    if (s.useAnima) {
        try { return await getAnimaMemText(opts); }
        catch (err) { console.warn('[7dayscal] Anima 取摘要出错', safeDiagnosticLog('memory', 'request', err, { background: true })); return ''; }
    }
    if (s.useDatabase) {
        try { return await databaseMemoryAccess.text(opts); }
        catch (err) { console.warn('[7dayscal] 数据库取纪要出错', safeDiagnosticLog('memory', 'request', err, { background: true })); return ''; }
    }
    if (s.useBaiBaiBook) {
        const api = globalThis.STBaiBaiBook;
        if (!api || typeof api.getInjectedHistory !== 'function') {
            if (!getMemText._bbbWarned) {
                getMemText._bbbWarned = true;
                console.info('[7dayscal] 使用柏宝书记忆但 API 未就绪，本次生成无历史注入');
            }
            return '';
        }
        try {
            // opts.full：通读全故事的分析任务（如「历」编排全年纪念日）要完整时间线——
            // 用 getHistory（柏宝书「全部压缩历史」，含滑动窗口楼层）；而非 getInjectedHistory
            // （后者是按当前剧情向量召回、跳过滑动窗口的注入版，会漏掉与"此刻"无关的旧里程碑）。
            // 点/线/面贴当前剧情，保持 getInjectedHistory（聚焦近景、省额度）。
            if (opts.full && typeof api.getHistory === 'function') {
                return api.getHistory()?.relativeText || '';
            }
            return api.getInjectedHistory()?.relativeText || '';
        } catch (err) {
            console.warn('[7dayscal] 柏宝书取历史出错', safeDiagnosticLog('memory', 'request', err, { background: true }));
            return '';
        }
    }
    return memory.getMemoryContext();
}

// 记忆块 tk 预算封顶（源无关）：把上面任一记忆源产出的文本压到预算内再交给生成。早期设计缺漏——
// 柏宝书注入版靠向量召回自封顶，但 Anima 全量拼分片、内置 L1 早期章节全塞，长故事会飙到 10w+ tk。
//   full=true（历·排全年日期）→ 保覆盖：跨全程等距抽块，别掐中段（会漏中段生日/纪念日）。
//   full=false（点/线/面/间）→ 近景优先：留最近的块 + 一小段最早梗概，中段省略。
// 不超预算 → 原样返回、零改动。按空行块边界切（三源都用 '\n\n' 分语义单元），不切碎句子。
// token 用一次精确总数反推「每字 token 比」再按块长比例分摊，避免逐块调分词器。滚动再压是 v2。
async function getMemText(opts = {}) {
    const raw = await _getMemTextRaw(opts);
    try { return await _capMemText(raw, !!opts.full); }
    catch (err) { console.warn('[7dayscal] 记忆预算封顶出错，回退原文', safeDiagnosticLog('memory', 'request', err, { background: true })); return raw; }
}
const MEMORY_TOKEN_BUDGET = 60000;
async function _capMemText(text, full) {
    const t = String(text || '');
    if (!t.trim()) return t;
    const budget = MEMORY_TOKEN_BUDGET;
    let total;
    try { total = await getContext().getTokenCountAsync(t); }
    catch { total = Math.ceil(t.length / 2); }             // 分词器够不着 → 粗估 2 字/token
    if (total <= budget) return t;                         // 没超 → 原样返回
    // 填充按 95% 预算算，留 5% 余量：按块估 token 会漏掉块间 '\n\n'、省略标记、以及「单块内计数 vs 整体计数」的舍入差，
    // 不留余量会以约 1% 幅度轻微超顶。固定预算压到 95% 以内更稳。
    const eff = Math.floor(budget * 0.95);
    const ratio = total / t.length;                        // token/字，用于按块长估算
    const blocks = t.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    if (blocks.length <= 1) {
        // 单块就超预算（少见，多为柏宝书 full 那种整段文本）：按字比截。历取头(保早期起点)、点线面取尾(保近景)。
        const keepChars = Math.max(1, Math.floor(eff / ratio));
        return full ? t.slice(0, keepChars) : t.slice(-keepChars);
    }
    const tok = b => Math.max(1, Math.round(b.length * ratio));
    if (full) {
        // 历·保覆盖：等距抽块塞满预算，含首尾，中段均匀留样本——绝不整段掐掉（那会漏中段纪念日）。
        const avg = total / blocks.length;
        const keep = Math.max(1, Math.floor(eff / Math.max(1, avg)));
        if (keep >= blocks.length) return t;
        const step = blocks.length / keep;
        const idxs = [];
        for (let k = 0; k < keep; k++) {
            const idx = Math.min(blocks.length - 1, Math.round(k * step));
            if (idxs[idxs.length - 1] !== idx) idxs.push(idx);
        }
        if (idxs[idxs.length - 1] !== blocks.length - 1) idxs.push(blocks.length - 1);
        return ['（……为控制长度，以下为全程等距节选，非完整时间线……）', ...idxs.map(i => blocks[i])].join('\n\n');
    }
    // 点/线/面/间·近景优先：最早留一小段梗概（≤15% 预算）+ 最近塞满剩余，中段省略。
    const ELIDE = '（……中段记忆已省略以控制长度……）';
    const headBudget = Math.floor(eff * 0.15);
    const head = []; let hUsed = 0, hi = 0;
    while (hi < blocks.length && hUsed + tok(blocks[hi]) <= headBudget) { head.push(blocks[hi]); hUsed += tok(blocks[hi]); hi++; }
    const tailBudget = eff - hUsed - tok(ELIDE);
    const tailRev = []; let tUsed = 0, ti = blocks.length - 1;
    while (ti >= hi && tUsed + tok(blocks[ti]) <= tailBudget) { tailRev.push(blocks[ti]); tUsed += tok(blocks[ti]); ti--; }
    const tail = tailRev.reverse();
    if (head.length + tail.length === 0) {                 // 极端：块都比预算大 → 退回按字截最近一段
        const keepChars = Math.max(1, Math.floor(eff / ratio));
        return t.slice(-keepChars);
    }
    const parts = [];
    if (head.length) parts.push(...head);
    if (hi <= ti) parts.push(ELIDE);                       // 中段确有被跳过的块才插省略标记
    if (tail.length) parts.push(...tail);
    return parts.join('\n\n');
}

// user persona 描述 + 当前聊天的作者注释——点/线/面生成与间/面聊天共用同一读取口径。
// persona 取当前激活 persona（过去只读 name1 等于没读 user 卡）；
// 作者注释是酒馆原生 Author's Note，仅对当前聊天生效，存在 chatMetadata['note_prompt']（authors-note.js:metadata_keys.prompt）。
function readCardExtras(ctx) {
    const sub = typeof ctx.substituteParams === 'function' ? ctx.substituteParams : (s => s);
    return {
        personaDesc: String(sub(ctx.powerUserSettings?.persona_description || '')).trim(),
        authorNote : String(sub(ctx.chatMetadata?.note_prompt || '')).trim(),
    };
}

// historyLimit：喂给这次调用的「最近可见 AI 楼」条数上限。默认 3。
// 传 0 = 完全不喂近景，只靠 system 块（人设/卡描述/世界书/记忆库）。
async function buildMessages(ctx, prompt, userName, charName, historyLimit = 3, opts = {}) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const wiContext = await buildWorldInfoContext(ctx);
    const { personaDesc, authorNote: rawAuthorNote } = readCardExtras(ctx);
    const authorNote = rawAuthorNote;

    // Story memory (Plan C: objective memory + view tag)
    const rawMemText = await getMemText({ full: opts.fullMemory, query: prompt });
    const memText = sanitizeGenerationContextText(rawMemText, { reroll: opts.reroll });
    const memPerspective = opts.pointView === 'char' ? charName : opts.pointView === 'user' ? userName : null;
    const memBlock = memText
        ? `【故事记忆库】以下由本插件在对话过程中自动生成的客观摘要，反映从最早到近期的关键事件与伏笔。请**优先信任记忆库描述**，即使它与角色卡/世界书中较早的描述冲突（因为记忆库记录了事件后的最新状态）。${memPerspective ? `点视角优先关注对${memPerspective}有意义的信息。` : '请按当前聊天主角色上下文理解，不继承点的 TA 视角。'}\n\n${memText}`
        : '';

    // 历（本世界观重要日期）：供构画生成与讨论上下文使用，不做主楼常驻注入。
    const almanacText = resolveAlmanacContextText(opts, getAlmanacInjectText);
    const almanacBlock = almanacText
        ? `【本世界观·重要日期（历）】以下是这个世界的既定节日、生日、纪念日等重要日子，已按「当前剧情日期」标注倒计时；每条冒号后的「说明」是该日子的既定设定（由来、涉及人物阵营、习俗活动、持续天数等），是背景事实。\n${almanacText}\n\n★ 推演点/线/大纲时：凡列在【近期将至】里的日子（未来数日内或进行中），应**主动**把它纳入近期剧情——依据其「说明」里的设定生成与之相关的铺垫、筹备、事件或人物动向，让故事顺着该世界的历法自然推进；【全年其他重要日子】作为背景，时间线接近时再纳入考量。\n★ 务必尊重每条「说明」里的既定设定，据此展开合理、可延续的剧情；说明里没写到的细节可以合理补完，但**不得编造与既定设定冲突的内容**。`
        : '';

    // 历法（纪年/月份结构）：供构画生成与讨论上下文使用，不做主楼常驻注入；避免自定义历法被公历月份/天数覆盖。
    const calDescText = getCalDescInjectText();
    const calDescBlock = calDescText
        ? `【本世界观·现行历法（纪年）】${calDescText}\n推演点/线/大纲涉及日期时，一律以此历法为准（月份数、每月天数、纪年名），不要默认套用公历的 12 月 / 31 日。`
        : '';

    const sys  = [
        `你是一位旁观者和叙事分析助手，负责以第三人称视角分析 ${userName} 与 ${charName} 的故事。`,
        `不要扮演任何角色，不要使用第一人称。所有输出必须以第三人称叙述。`,
        personaDesc      ? `【${userName} 的人物设定】\n${personaDesc}` : '',
        char.description ? `【${charName} 的背景资料】\n${char.description}` : '',
        char.personality ? `【性格】${char.personality}` : '',
        char.scenario    ? `【场景】${char.scenario}`    : '',
        authorNote       ? `【作者注释（当前聊天）】\n${authorNote}` : '',
        wiContext,
        memBlock,
        almanacBlock,
        calDescBlock,
    ].filter(Boolean).join('\n\n');
    // 常规生成默认只取最近 3 层完整、可见 AI 回复；调用方可显式传入其他预算。
    // historyLimit=0 → 完全不喂历史（history 为空），只留 system + prompt。
    const allMsgs = ctx.chat ?? [];
    let history = [];
    if (historyLimit > 0) {
        // 标签清洗（全局 keepTags/extraTags）：先剥标签结构、再替换变量占位符，
        // 免得展开出的内容里的尖括号被当成标签。点/线/面主生成经此统一清洗，
        // 与记忆采集(memory.getAiFloors)、间/面讨论(buildRecentChatContext)同口径。
        const s = getSettings();
        const stripOpts = { keepTags: s.keepTags, extraTags: s.extraTags };
        history = selectVisibleChatHistory(allMsgs, historyLimit, { excludedAssistant: opts.excludedAssistant, mapMessage: m => ({
            role   : m.is_user ? 'user' : 'assistant',
            content: substituteParams(sanitizeGenerationContextText(m.mes ?? '', { reroll: opts.reroll, stripTags: value => memory.stripTags(value, stripOpts) })),
        }) });
    }
    if (Array.isArray(opts.ledgerSourceFloors)) {
        history = opts.ledgerSourceFloors.map(source => ({
            role: 'assistant',
            content: `【刻度可信来源｜楼层 ${source.floor}｜${source.sources?.length ? source.sources.map(x => `${x.token}=${x.stamp}`).join('、') : '无合法 SDC 令牌，仅供识别正文'}】\n${source.content || ''}`,
        }));
    }
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: prompt }];
}

// ─── Inject ───────────────────────────────────────────────────────────────────

function makeInjectBtn(text) {
    const id = ++_injectIdSeq;
    _injectTexts[id] = text;
    return `<button class="sp-inject-btn" data-iid="${id}" title="注入到输入框"><i class="fa-solid fa-arrow-right-to-bracket"></i></button>`;
}

function injectToST(text) {
    const $ta = $('#send_textarea');
    if (!$ta.length) { showToast('找不到输入框', null, true); return false; }
    // Append instead of overwrite — don't nuke whatever the user was typing.
    // Empty box → just set; non-empty → prepend a blank line separator so the
    // injection stays visually distinct from prior text.
    const prev = String($ta.val() || '');
    const combined = prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${text}` : text;
    const el = $ta.val(combined)[0];
    // SillyTavern listens with native addEventListener('input') for its autosize path.
    el?.dispatchEvent(new Event('input', { bubbles: true }));
    // Move caret to end + scroll into view so the newly injected text is
    // visible even if the box already had content.
    if (el && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(combined.length, combined.length);
    }
    el?.scrollTo?.({ top: el.scrollHeight });
    showToast(prev.trim() ? '已追加到输入框' : '已注入到输入框');
    return true;
}

// ─── Outline chat ─────────────────────────────────────────────────────────────

// Turn AI reply text into safe rendered HTML via ST's own messageFormatting
// (markdown + sanitizer + quote-wrap), so 间/面/棱 match the main chat area.
// Falls back to escaped text with <br> if the API isn't available. Never used
// for user messages — they typed plain text, don't reinterpret it as markdown.
//
// Regex isolation (约定：构画渲染绝不被用户正则改写)：构画的气泡没有真实楼层，
// messageId 只能传 null → ST 把它当成最远深度的楼，于是「显示域 + 按深度过滤」的
// 用户正则会命中并清空气泡（曾有用户装「不发送远楼信息」正则后 间/面/棱 全白）。
// 做法：调用期间临时把 'regex' 塞进 disabledExtensions，getRegexedString 开头即
// 短路返回原文（engine.js），markdown / 引号包裹 / 净化等其余步骤照跑，渲染与主
// 聊天一致。调用是同步的、随即在 finally 还原，不落盘、不触发保存、对别处无副作用。
function renderAiMessageHtml(text) {
    const ctx = getContext();
    if (typeof ctx?.messageFormatting === 'function') {
        const de = extension_settings?.disabledExtensions;
        const guardRegex = Array.isArray(de) && !de.includes('regex');
        if (guardRegex) de.push('regex');
        try {
            return ctx.messageFormatting(String(text ?? ''), '', false, false, null, {}, false);
        } catch (err) {
            console.warn('[7dayscal] messageFormatting failed, falling back to plain', safeDiagnosticLog('generation', 'parse', err));
        } finally {
            if (guardRegex) {
                const i = de.indexOf('regex');
                if (i !== -1) de.splice(i, 1);
            }
        }
    }
    return escapeHtml(String(text ?? '')).replace(/\n/g, '<br>');
}


// idx0 从 0 起。就地替换 calendar_widget 内第 idx0 个 Event: 行（保留其 Day/Future 归属与缩进），找不到返回 null。
function replaceNthEventLine(raw, idx0, newEventLine) {
    return replacePointEventBlock(raw, idx0, newEventLine);
}

function readCacheRaw(desc) {
    const saved = readStore(desc);
    return saved?.raw || '';
}

// ─── Apply widget to almanac (历) ─────────────────────────────────────────
// 历是一张扁平日期表（非 raw 文本）。一张卡一个日期，按 idx 取该条单独注入。
// **纯追加**：只把这一条去重后加进去，绝不动任何已有项——尤其不能碰「生成节日」出的
// 未锁 AI 节日（那是 source='ai' pin=false，用 mergeAlmanac 会被当未锁 AI 项清掉 → 原版节日全没）。
// 间来的日期默认 pin，日后「生成节日」重算也保得住（与「间加线默认锁定」一致）。
// 历法 widget 动作统一由 axisWidgetActions 提供。

const axisWidgetActions = createAxisWidgetActions({
    parseAlmanac: parseAlmanacWidget,
    parseEra: parseEraWidget,
    key: getAlmanacKey,
    calKey: getCalDescKey,
    loadItems: loadAlmanac,
    dedupKey: almDedupKey,
    saveItems: saveAlmanacItems,
    render: () => { if (axisState.almanacMode) renderAlmanacPanel(); },
    sync: syncLatestAlmanacBlock,
    done: ($btn, label) => $btn.prop('disabled', true).html(`<i class="fa-solid fa-check"></i> ${label}`),
    error: message => { showToast(message, null, true); return { ok: false }; },
    notify: message => showToast(message),
    commitCalendar: commitCalendarDesc,
    notifyEra: cal => { if (getSettings().notifyMode !== 'off') showToast(`历法已更新：${cal.era ? cal.era + '·' : ''}${calendarSummary(cal)}`); },
});

async function composeCreativeChatMessages({ target, userMsg, historySnapshot }) {
    const ctx      = getContext();
    const userName = ctx.name1 || '用户';
    const charName = ctx.name2 || '角色';
    const outlineCtx = outlineFeature.repository.readRaw(target);
    const { personaDesc, authorNote } = readCardExtras(ctx);
    const almanacText = getAlmanacInjectText();
    const calDescText = getCalDescInjectText();
    const wiContext = await buildWorldInfoContext(ctx);
    const recentCtx = await buildRecentChatContext(ctx);
    const sys = buildCreativeChatSystemPrompt({
        userName,
        charName,
        personaDesc,
        authorNote,
        outlineRaw: outlineCtx,
        wiContext,
        recentCtx,
        almanacText,
        calDescText,
    });
    // 历史快照已包含刚写入的 user turn；末尾再追加一次是当前生产合同，禁止在本轮去重。
    return [{ role: 'system', content: sys }, ...historySnapshot, { role: 'user', content: userMsg }];
}

// 写剪贴板：优先 navigator.clipboard（需安全上下文），失败/不可用则退回 execCommand。
// 酒馆常跑在非 https 的 WebView 里，clipboard API 可能缺失或抛权限错——execCommand 兜底保证手机也能复制。
async function copyPlainText(text) {
    const s = String(text ?? '');
    if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(s); return true; } catch {}
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, s.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch { return false; }
}

// ─── 棱（小剧场）render ─────────────────────────────────────────────────────────

function setTheaterBody(html) { $in('#sp-theater-body').html(html); }

// 预览折叠：内容超过阈值才折叠并露出「展开全文」按钮，短内容不折。
function setOutlineBody(html) {
    const $beats = $in('#sp-outline-beats').html(html);
    $in('#sp-outline-node-count').text(`${$beats.children('.sp-beat').length} 个节点`);
}

// ─── Storylines (事件线) ─────────────────────────────────────────────────────

function getLinesCacheKey(view, charName) {
    return keyDesc('lines', 'user', '');
}

// ── 线·swipe 临时层（localStorage）─────────────────────────────────────────
// 楼层没「固定」（用户还没发下一条消息）前，每份 swipe 的线临时存这里：
// key = sp-lines-swipe-<chatId>-<mesId>；value = { baseline:<B0>, swipes:{ "<swipeId>": <merged> }, view, charName }。
// baseline = 本楼生成前的线（pre-commit B0），保证每份 swipe 都从 B0 重推、不互相叠加污染。
// swipe 存储与恢复由 linesFeature 持有；此处只适配宿主 chat/store/UI 能力。
// 滑回已生成的 swipe：从临时层取回该 swipe 的线写回 store 当前活跃集 + 刷 UI，不请求 API。
// 命中返回 true；无记录返回 false（交给调用方决定是否重算）。
// 楼主文本签名（长度 + 首尾 32 字，避免全量哈希）：给「同 mesId 主文本变了 → 原楼重生成 = 重roll」检出用。
// 不依赖 ST 的 CMR type / GENERATION_STARTED genType——实测流式重roll下 type=undefined、latch 也不触发，三路检测全漏。
// 有时间戳则只签 <!-- SDC-start --> 与 <!-- SDC-end --> 之间的正文：正文出完后第三方插件在楼尾追加的变量块落在戳外、
// 不再扰动签名 → 不再把「追加变量块」误判成重 roll、省一次 API。无戳（时钟关/AI 漏戳）回退整条 mes，零回归。
function _floorSig(mid) {
    try {
        const t = String(getContext().chat?.[Number(mid)]?.mes ?? '');
        const body = storyClockNarrativeBody(t);
        return body.length + '|' + body.slice(0, 32) + '|' + body.slice(-32);
    } catch { return ''; }
}
// 上一 AI 楼的定稿快照线（raw）：从 mesId-1 往前找第一条非 user/非 system 楼，读其快照 .line。
// 那正是「本楼推进前」的线态 B0。快照每楼渲染即同步冻结、无 API 依赖，比 swipe 临时层可靠得多。
// 找不到（本楼即首楼/greeting）返回 ''。供🔄重生成在临时层基线丢失时重建楼层基线 B0。
function _prevAiFloorLines(mesId) {
    try {
        const chat = getContext().chat;
        if (!Array.isArray(chat)) return '';
        for (let i = Math.min(Number(mesId), chat.length) - 1; i >= 0; i--) {
            const m = chat[i];
            if (m && !m.is_user && !m.is_system) return snapshot.readSnapshot(i)?.line || '';
        }
    } catch { /* 空 */ }
    return '';
}
// swipe / 重 roll 事件本身不自动请求线 API；滑回旧 swipe 时只复用已有临时层并本地重画。
// 正常新 AI 楼的线推进仍只走 MESSAGE_RECEIVED → CHARACTER_MESSAGE_RENDERED 的统一入口。
function loadCachedLinesForCurrentChat(view, charName) {
    const saved = readStore(getLinesCacheKey(view, charName));
    if (saved?.raw) return linesFeature.renderLines(saved.raw);
    return null;
}

// ─── 存储管理面板 ──────────────────────────────────────────────────────────────
// 三层：①本聊天 chat_metadata（点线面间讨论 + 记忆 + 棱永久）②收藏（坐标·服务器）
//       ③本机缓存（localStorage：棱草稿 + UI 位置）。构画只统计/清理自己的数据。

const STORAGE_KIND_LABELS = {
    'schedule'     : '点（待办）',
    'outline'      : '面（大纲）',
    'lines'        : '线（伏笔）',
    'creative-chat': '面讨论',
    'space-chat'   : '间（局外）',
    'dashed'       : '虚线·冷知识',
    'almanac'      : '轴·日历条目（节日/生日/纪念日）',
};
const STORAGE_OWNKEY_LABELS = {
    'sp-memory' : '记忆',
    'sp-theater': '棱永久层',
    'sp-ledger' : '轴·刻度（状态/约定/周期）',
};
const STORAGE_CLEAR_TARGETS = Object.freeze({
    almanac: Object.freeze({ scope: 'kind', kind: 'almanac', label: '轴·日历条目（节日/生日/纪念日）' }),
    ledger: Object.freeze({ scope: 'ownkey', key: 'sp-ledger', label: '轴·刻度（状态/约定/周期）' }),
});

function storageChatIdentity() {
    const ctx = getContext();
    const chatId = String(ctx?.chatId || '');
    return chatId ? { chatId, metadata: ctx.chatMetadata } : null;
}

function storageChatStillCurrent(identity) {
    const now = storageChatIdentity();
    return !!identity && !!now && identity.chatId === now.chatId && identity.metadata === now.metadata;
}

function storageRow(label, bytesText, btnHtml = '', extraClass = '') {
    return `<div class="sp-storage-row ${extraClass}">
        <span class="sp-storage-row-label">${escapeHtml(label)}</span>
        <span class="sp-storage-row-bytes">${escapeHtml(bytesText)}</span>
        <span class="sp-storage-row-act">${btnHtml}</span>
    </div>`;
}

// 渲染三层用量到 #sp-storage-body。异步（坐标要读服务器索引）。
async function renderStorageUsage() {
    const $body = $in('#sp-storage-body');
    if (!$body.length) return;
    const fmt = store.formatBytes;

    // ① 本聊天 chat_metadata
    let chatHtml;
    if (!store.hasStore() && !store.ownKeyBytes('sp-memory') && !store.ownKeyBytes('sp-theater') && !store.ownKeyBytes('sp-ledger')) {
        chatHtml = `<div class="sp-cfg-hint" style="padding:4px 0">当前聊天暂无构画数据</div>`;
    } else {
        const usage = store.usageByKind();
        const rows = [];
        for (const kind of store.USER_CLEAR_KINDS) {
            const b = usage[kind] || 0;
            if (!b) continue;
            rows.push(storageRow(
                STORAGE_KIND_LABELS[kind] || kind,
                fmt(b),
                kind === STORAGE_CLEAR_TARGETS.almanac.kind
                    ? `<button class="sp-storage-del sp-mini-btn" data-scope="datakey" data-key="almanac-user">清除</button>`
                    : `<button class="sp-storage-del sp-mini-btn" data-scope="kind" data-kind="${kind}">清除</button>`,
            ));
        }
        for (const key of ['sp-memory', 'sp-theater', 'sp-ledger']) {
            const b = store.ownKeyBytes(key);
            if (!b) continue;
            rows.push(storageRow(
                STORAGE_OWNKEY_LABELS[key],
                fmt(b),
                `<button class="sp-storage-del sp-mini-btn sp-mini-btn-danger" data-scope="ownkey" data-key="${key}">清空</button>`,
            ));
        }
        chatHtml = rows.length ? rows.join('') : `<div class="sp-cfg-hint" style="padding:4px 0">当前聊天暂无构画数据</div>`;
    }

    // ③ 本机缓存（localStorage：棱草稿 + UI 位置），先算好（同步）
    const localBytes = theaterDeviceCache.pluginCacheBytes();

    // 先渲染同步部分 + 收藏占位（服务器读取慢，先占位再补）
    $body.html(`
        <div class="sp-storage-group">
            <div class="sp-storage-group-head">本聊天（随聊天文件存服务端）</div>
            ${chatHtml}
        </div>
        <div class="sp-storage-group">
            <div class="sp-storage-group-head">收藏 · 坐标（全局存服务端）</div>
            <div id="sp-storage-anchor-rows"><div class="sp-cfg-hint" style="padding:4px 0">统计中…</div></div>
        </div>
        <div class="sp-storage-group">
            <div class="sp-storage-group-head">本机缓存（localStorage，仅本浏览器）</div>
            ${storageRow('棱草稿 + 界面位置', fmt(localBytes),
                localBytes ? `<button class="sp-storage-del sp-mini-btn" data-scope="local">清理</button>` : '')}
            <div class="sp-cfg-hint" style="padding:2px 0 0">仅清本机的草稿与界面位置，不影响已存服务端的点线面间与收藏。</div>
        </div>
    `);

    // ② 收藏（坐标·服务器）——异步补进占位
    try {
        const usage = await coordinateRuntime?.feature?.storageUsage?.() || { count: 0, bytes: 0 };
        const cnt = usage.count;
        const bytes = usage.bytes;
        $in('#sp-storage-anchor-rows').html(
            cnt
                ? storageRow(`共 ${cnt} 条收藏`, coordinateRuntime.feature.formatBytes(bytes),
                    `<button class="sp-storage-del sp-mini-btn sp-mini-btn-danger" data-scope="anchor">清空</button>`)
                : `<div class="sp-cfg-hint" style="padding:4px 0">暂无收藏</div>`
        );
    } catch {
        $in('#sp-storage-anchor-rows').html(`<div class="sp-cfg-hint" style="padding:4px 0">统计失败（服务器不可达？）</div>`);
    }
}

function invalidateLedgerTasksForStoreClear() {
    traceDiagnosticEvent('abort-boundary', { module: 'ledger', chatId: getContext?.()?.chatId ?? null, chatRevision: pointTaskOwners.currentChatRevision(), boundaryEpoch: chatBoundaryEpoch, abortReason: 'store-clear', status: 'dispatch' });
    ledgerCaptureController.reset('store-clear');
    ledgerJudgeController.reset('store-clear');
    resetLedgerRenderState();
}

function refreshLedgerAfterStoreClear() {
    refreshLedgerInjection();
    refreshInlineWindow(true);
    if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
}

function invalidateAlmanacTasksForStoreClear() {
    traceDiagnosticEvent('abort-boundary', { module: 'axis-generation', chatId: getContext?.()?.chatId ?? null, chatRevision: pointTaskOwners.currentChatRevision(), boundaryEpoch: chatBoundaryEpoch, abortReason: 'store-clear', status: 'dispatch' });
    axisGenerationController.reset('store-clear');
    axisState._almanacEditor = null;
    axisCalendarManager.close();
    axisState._almanacCalDay = null;
    axisState._almanacCalMonth = null;
    axisState._almTodayEditing = false;
}

function refreshAlmanacAfterStoreClear() {
    syncLatestAlmanacBlock();
    if (axisState.almanacMode) renderAlmanacPanel();
}

function invalidateKindTasksForStoreClear(kind) {
    traceDiagnosticEvent('abort-boundary', { module: kind, chatId: getContext?.()?.chatId ?? null, chatRevision: pointTaskOwners.currentChatRevision(), boundaryEpoch: chatBoundaryEpoch, abortReason: 'store-clear', status: 'dispatch' });
    if (kind === 'schedule') {
        pointState.scheduleAbortController?.abort('store-clear'); pointState.scheduleAbortController = null;
        _autoRegenSchedAbort?.abort('store-clear'); _autoRegenSchedAbort = null;
        pointState.isGenerating = false;
    } else if (kind === 'outline') {
        outlineFeature.invalidateStoreKind(kind);
    } else if (kind === 'lines') {
        linesFeature.abortGeneration({ reason: 'store-clear' });
    } else if (kind === 'space-chat') {
        spaceFeature.invalidateStoreKind(kind);
    } else if (kind === 'creative-chat') {
        outlineFeature.invalidateStoreKind(kind);
    } else if (kind === 'dashed') {
        linesFeature.dashed.abort('store-clear');
    }
}

// 清完某 kind 数据后，若对应视图正开着就重渲染成空态；点视图另清内存缓存。
function refreshEditorsAfterStoreClear(kind) {
    if (kind === 'schedule') {
        pointState.cachedSchedule = null;
        setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>还没有点</p><button class="sp-gen-btn" id="sp-gen-schedule-now">生成点</button></div>`);
        syncLatestScheduleBlock();
    }
    if (kind === 'outline') { outlineFeature.refreshAfterStoreClear(kind); syncLatestInlineBlock(); }
    if (kind === 'lines') { linesRuntime.reset(); if (linesMode) linesFeature.renderBody(renderEmptyLinesState()); refreshLinesInjection(); syncLatestInlineBlock(); }
    if (kind === 'dashed') {
        linesFeature.dashed.resetError();
        if (linesMode) linesFeature.refreshPanel();
        syncLatestInlineBlock();
    }
    if (kind === 'creative-chat') {
        outlineFeature.refreshAfterStoreClear(kind);
    }
    if (kind === 'space-chat') {
        spaceFeature.refreshAfterStoreClear(kind);
    }
}

// 保存失败回滚后从当前 store 重新读取真实数据；与成功清理的空态刷新严格分开。
function refreshEditorsFromCurrentStore(kind) {
    if (kind === 'schedule') {
        const key = getCacheKey(currentView, charViewName);
        const saved = readStore(key);
        const subject = currentView === 'char' ? (charViewName || getContext().name2 || '角色') : (getContext().name1 || '用户');
        pointState.cachedSchedule = saved?.raw ? renderSchedule(saved.raw, saved.userName || subject, currentView, loadCalDesc()) : null;
        if (!outlineMode && !linesMode && !spaceMode && !theaterMode && $(`#${MODAL_ID}`).is(':visible')) {
            setBody(pointState.cachedSchedule || `<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>还没有点</p><button class="sp-gen-btn" id="sp-gen-schedule-now">生成点</button></div>`);
        }
        syncLatestScheduleBlock();
    } else if (kind === 'outline') {
        outlineFeature.refreshFromStore(kind);
    } else if (kind === 'lines') {
        linesRuntime.reset();
        if (linesMode) linesFeature.refreshPanel();
        refreshLinesInjection();
    } else if (kind === 'creative-chat') {
        outlineFeature.refreshFromStore(kind);
    } else if (kind === 'space-chat') {
        spaceFeature.refreshFromStore(kind);
    } else if (kind === 'dashed') {
        linesFeature.dashed.resetError();
        if (linesMode) linesFeature.refreshPanel();
        syncLatestInlineBlock();
    }
}
// ANCHOR_STORAGE_HANDLERS

// 绑定存储管理面板的清理按钮（委托到 #sp-storage-body，内容动态渲染）+ 刷新。
function bindStorageHandlers() {
    $in('#sp-storage-refresh').on('click', () => renderStorageUsage());

    const $body = $in('#sp-storage-body');

    // 日历条目必须按精确 dataKey 删除，不能调用按 kind 前缀的清理。
    $body.on('click', '.sp-storage-del[data-scope="datakey"]', async function () {
        const dataKey = $(this).attr('data-key');
        if (!store.isStorageDataKeyClearable(dataKey)) return;
        const identity = storageChatIdentity();
        if (!identity) return;
        if (!await spConfirm({
            title: `清除${STORAGE_CLEAR_TARGETS.almanac.label}`,
            body: '仅删除本聊天的节日、生日、纪念日和自定义日期条目；不会删除刻度、自定义历法、剧情今天或模板。\n此操作不可恢复。',
        })) return;
        if (!storageChatStillCurrent(identity)) return;
        invalidateAlmanacTasksForStoreClear();
        try {
            const ok = await store.clearDataKeyAsync(dataKey);
            if (!storageChatStillCurrent(identity)) return;
            refreshAlmanacAfterStoreClear();
            renderStorageUsage();
            showToast(ok ? '已清除轴·日历条目' : '轴·日历条目本就为空');
        } catch (error) {
            if (storageChatStillCurrent(identity)) { refreshAlmanacAfterStoreClear(); showToast('清除轴·日历条目失败：' + (error?.message || '保存失败'), null, true); }
        }
    });

    // ① 本聊天 chat_metadata —— 按 kind 清（点线面间讨论）
    $body.on('click', '.sp-storage-del[data-scope="kind"]', async function () {
        const kind = $(this).attr('data-kind');
        if (kind === STORAGE_CLEAR_TARGETS.almanac.kind) return;
        const label = STORAGE_KIND_LABELS[kind] || kind;
        if (!store.USER_CLEAR_KINDS.includes(kind)) return;
        const identity = storageChatIdentity();
        if (!identity) return;
        const detail = kind === STORAGE_CLEAR_TARGETS.almanac.kind
            ? '仅删除本聊天的节日、生日、纪念日和自定义日期条目；不会删除刻度、自定义历法、剧情今天或模板。'
            : `确定清除本聊天的「${label}」数据吗？我方 / TA 方视角都会一并清掉。`;
        if (!await spConfirm({ title: `清除${label}`, body: `${detail}\n此操作不可恢复。` })) return;
        if (!storageChatStillCurrent(identity)) return;
        invalidateKindTasksForStoreClear(kind);
        try {
            const n = await store.clearKindAsync(kind);
            if (!storageChatStillCurrent(identity)) return;
            refreshEditorsAfterStoreClear(kind);
            renderStorageUsage();
            showToast(n ? `已清除${label}` : `${label}本就为空`);
        } catch (error) {
            if (storageChatStillCurrent(identity)) {
                refreshEditorsFromCurrentStore(kind);
                showToast(`清除${label}失败：` + (error?.message || '保存失败'), null, true);
            }
        }
    });

    // ① 本聊天 —— 清整个 own key（记忆 / 棱永久）
    $body.on('click', '.sp-storage-del[data-scope="ownkey"]', async function () {
        const key = $(this).attr('data-key');
        const label = STORAGE_OWNKEY_LABELS[key] || key;
        if (!store.OWN_KEYS.includes(key)) return;
        const identity = storageChatIdentity();
        if (!identity) return;
        const detail = key === STORAGE_CLEAR_TARGETS.ledger.key
            ? '仅删除本聊天活跃/已了结刻度（状态、约定、周期）；不会删除日历条目、自定义历法、剧情今天或模板。'
            : `确定清空本聊天的「${label}」全部数据吗？`;
        if (!await spConfirm({ title: `清空${label}`, body: `${detail}\n此操作不可恢复。` })) return;
        if (!storageChatStillCurrent(identity)) return;
        if (key === STORAGE_CLEAR_TARGETS.ledger.key) {
            invalidateLedgerTasksForStoreClear();
            try {
                const ok = await store.clearOwnKeyAsync(key);
                if (!storageChatStillCurrent(identity)) return;
                refreshLedgerAfterStoreClear();
                renderStorageUsage();
                showToast(ok ? `已清空${label}` : `${label}本就为空`);
            } catch (error) {
                if (storageChatStillCurrent(identity)) { refreshLedgerAfterStoreClear(); showToast(`清空${label}失败：` + (error?.message || '保存失败'), null, true); }
            }
            return;
        }
        if (key === 'sp-theater') {
            const target = theaterFeature.captureTarget(identity.chatId);
            const result = await theaterFeature.clearSaved(target);
            if (!storageChatStillCurrent(identity)) return;
            if (theaterMode) theaterFeature.resetAfterStorageClear();
            renderStorageUsage();
            showToast(result?.ok ? `已清空${label}` : `清空${label}失败`, null, !result?.ok);
            return;
        }
        const ok = store.clearOwnKey(key);
        if (!storageChatStillCurrent(identity)) return;
        if (key === 'sp-memory') { refreshMemoryStatus?.(); }
        if (key === 'sp-theater' && theaterMode) theaterFeature.resetAfterStorageClear();
        renderStorageUsage();
        showToast(ok ? `已清空${label}` : `${label}本就为空`);
    });

    // ② 收藏（坐标·服务器）—— 清空全部
    $body.on('click', '.sp-storage-del[data-scope="anchor"]', async function () {
        const cnt = await coordinateRuntime?.feature?.storageUsage?.().then(info => info.count).catch(() => 0);
        if (!cnt) { showToast('还没有任何收藏'); return; }
        if (!await spConfirm({ title: '清空全部收藏', body: `确定删除全部 ${cnt} 条收藏吗？此操作不可恢复（原楼层不受影响）。` })) return;
        try {
            await coordinateRuntime?.feature?.clearAll?.();
            renderStorageUsage();
            showToast('已清空全部收藏');
        } catch (err) {
            console.error('[SP storage] 清空收藏失败', safeDiagnosticLog('storage', 'save', err));
            showToast('清空失败：' + (err?.message || '未知错误'), null, true);
        }
    });

    // ③ 本机缓存（localStorage：棱草稿 + UI 位置）
    $body.on('click', '.sp-storage-del[data-scope="local"]', async function () {
        if (!await spConfirm({ title: '清理本机缓存', body: '清理本浏览器的棱草稿与界面位置（面板位置/大小）。不影响已存服务端的点线面间和收藏。确定？' })) return;
        const n = theaterDeviceCache.clearPluginCache();
        if (theaterMode) theaterFeature.resetAfterStorageClear();
        renderStorageUsage();
        showToast(`已清理 ${n} 项本机缓存`);
    });
}



function renderEmptyLinesState() {
    return `<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>还没有追踪的线，可以生成一版</p><button class="sp-gen-btn" id="sp-gen-lines-now">生成线</button></div>`;
}

async function triggerGenerateLines() {
    return linesFeature.generate();
}

function buildLinesPrompt(userName, charName, perspective = 'user', previousRaw = '', scale = 'auto', vectorContext = {}, adultMode = 'off') {
    return buildCanonicalLinesPrompt(userName, charName, perspective, previousRaw, scale, vectorContext, adultMode);
}

// ─── Storylines parse / render ────────────────────────────────────────────────


// 线解析统一委托给 business/lines/schema.js。
function parseLines(raw) { return parseCanonicalLines(raw); }
// 锁定保护：把 oldRaw 里 pin 的线并进 AI 新输出。无锁定线时原样返回（零副作用）。

const STAGE_COLORS = {
    起线: '#7de9d9', 延展: '#58e8b3', 成形: '#d6b85a', 收束: '#2a8a5d', 淡出: '#888888',
};

// 点/线面板 header 下方另起一行的「去间改」引导，视觉对齐历法管理页的 .sp-alm-manager-hint。
// 「间」能把讨论落地成点/线，想调整时一键跳过去（handler 见 injectModal 委托）。
const SP_JUMP_HINT_LINES = `<div class="sp-jump-hint">想调整这些线？<button type="button" class="sp-jump-link">和「间」聊聊 →</button></div>`;


// ─── 历（日历 / 历法）─────────────────────────────────────────────────────────
// 独立模块，与点/线/面共通但存储隔离：点是 AI 每轮重算的易失数据，历要稳，
// 单独存 chat_metadata（kind='almanac'，不分我/TA，固定 user scope，抄 dashed）。
// 历数据供构画生成与讨论上下文使用，不作为主楼常驻注入。数据形状：{ items:[{id,name,type,month,day,displayDate,note,pin,source}], ts }






// 历「当前日期」锚点体系（almTodayAnchor/almDaysUntil/almWeekdayRef/almWeekdayFor 及日期差 helpers）
// 已抽出到 business/axis/anchor.js（纯数据层从 data.js/叶子模块 import，跨域读取器经 bindAxisAnchor 注入）。

// 历注入文本构造 getAlmanacInjectText 已抽出到 business/axis/inject.js（纯函数，仅依赖 data.js/anchor.js）。

// 当前历法描述（供间做「改历法」增量编辑参考）；内置公历返回 ''（无需告知，AI 直接按需新建）。

// AI 输出解析：<almanac_widget> 内 Item: name|type|month|day|days|displayDate|note

// 解析间落地的 <era_widget>（纪年/历法描述符）：一行可选 Era: 纪年名 + N 行 Month: 月名|天数。
// 交给现行历法 parse/validate/manager/actions 链校验；无有效月份描述时返回空结果。

// 重算合并：保留所有已锁 + 所有自填(user)，丢弃未锁 AI 项，再并入新 AI 项（按名+月日去重）。

// ── 渲染 ──
function closeActionMenus(except = null) {
    $inAll('.sp-action-menu-open').each(function () {
        if (except && this === except) return;
        $(this).removeClass('sp-action-menu-open').find('.sp-action-menu-list').attr('hidden', true);
        $(this).find('.sp-action-menu-toggle').attr('aria-expanded', 'false');
    });
}

const axisUi = createAxisUi({
    actionMenus: ACTION_MENU_CONFIGS,
    escapeHtml, escapeAttr,
    storyClockEnabled,
    latestClock: latestStoryClock,
    charKey: () => charStableKey(getContext()),
    calendar: loadCalDesc,
    today: almTodayAnchor,
    weekday: almWeekdayFor,
    weekdays: ALM_WEEKDAYS,
    monthName: (cal, month) => calMonthName(cal, month),
    monthCount: cal => calMonthCount(cal),
    anchor: key => getDateAnchor(key),
    storyCalibration: () => getStoryCalibration(charStableKey(getContext())),
    editing: () => axisState._almTodayEditing,
});
const actionMenuHtml = axisUi.actionMenuHtml;
const almTodayBarHtml = axisUi.todayBarHtml;
const storyClockBarHtml = axisUi.storyClockBarHtml;
function almNudgeToday(delta) {
    axisDateActions.nudgeToday(delta, { storyClock: true });
}
function currentCharacterCards() { return calendarCards(getContext(), charStableKey); }

function openCalendarManager() {
    axisState._almanacEditor = null;
    axisCalendarManager.begin();
    if (axisState.almanacMode) renderAlmanacPanel();
}

function closeCalendarManager() {
    axisCalendarManager.close();
}

function readCalendarDraftForm() {
    if (!axisCalendarManager.isEditing()) return null;
    return {
        era: String($in('#sp-alm-manager-era').val() || ''),
        displayStyle: String($in('#sp-alm-manager-display-style').val() || 'numeric') === 'classical' ? 'classical' : 'numeric',
        months: $inAll('#sp-almanac-wrap .sp-alm-manager-month-row').map(function () {
            return { name: String($(this).find('.sp-alm-manager-month-name').val() || ''), days: $(this).find('.sp-alm-manager-month-days').val() };
        }).get(),
    };
}

async function commitCalendarDesc(cal) { return axisTransactionController.commit(cal); }
async function maybeApplyBoundCalendarTemplate(options = {}) { return axisTransactionController.applyBound(options); }
function almCalMonth() {
    if (Number.isFinite(axisState._almanacCalMonth)) return axisState._almanacCalMonth;
    axisState._almanacCalMonth = almTodayAnchor().month - 1;
    return axisState._almanacCalMonth;
}

// ── 子视图 / 导航 ──
function almSetSheet(sheet) {
    if (axisState._almanacSheet === sheet) return;
    setAxisSheet(sheet, renderAlmanacPanel, batchReset);
}
function almNavMonth(delta) {
    navigateAxisMonth(delta, () => calMonthCount(loadCalDesc()), almCalMonth, renderAlmanacPanel);
}
// ── 生成 ──
async function triggerGenerateAlmanac() { return axisGenerationController.trigger(false); }

// 跑补录：复用 axisGenerationController（由 axisState.isGeneratingAlmanac 维护互斥），
// 但合并阶段走**纯追加去重**（非 mergeAlmanac）+ pin=true，且补 0 条时给出「没有够格」的正常态提示、不报错。
async function triggerSupplementAnniversary() { return axisGenerationController.trigger(true); }
// ── 手动新增 / 编辑（内联窗，不用弹窗）──
// 用户明确怕浮层弹窗出问题（会盖住/卡住），故表单直接渲进 #sp-almanac-wrap 里，
// 走 renderAlmanacPanel 的正常重渲，跟着 CHAT_CHANGED 一起被清，绝不残留浮层。
function openAlmanacEditor(id, prefill) {
    openAxisEditor(id, prefill, renderAlmanacPanel);
}
function closeAlmanacEditor() {
    closeAxisEditor(renderAlmanacPanel);
}
function renderAlmanacEditor() {
    return renderAxisEditor({
        calendar: loadCalDesc, items: loadAlmanac, monthIndex: almCalMonth, today: almTodayAnchor,
        types: ALM_TYPES, typeLabel: type => almTypeMeta(type).label, monthCount: calMonthCount,
        monthDays: calMonthDays, yearLength: calYearLen, escapeHtml, escapeAttr,
    });
}
// 编辑器里月/日/天数变动时，实时刷新只读周几提示（纯提示，不入库）。
function almRenderWdHint() {
    const $h = $in('#sp-alm-f-wdhint');
    if (!$h.length) return;
    $h.text(renderAxisWeekdayHint({ calendar: loadCalDesc, monthValue: () => $in('#sp-alm-f-month').val(), dayValue: () => $in('#sp-alm-f-day').val(), durationValue: () => $in('#sp-alm-f-days').val(), clamp: almClampInt, monthCount: calMonthCount, monthDays: calMonthDays, yearLength: calYearLen, weekdayRef: almWeekdayRef, weekdayFor: almWeekdayFor, weekdays: ALM_WEEKDAYS, monthName: calMonthName, endMonthDay: almEndMonthDay }));
}
function saveAlmanacEditor() {
    if (!axisState._almanacEditor) return;
    const result = axisEditorController.save();
    if (!result.ok) {
        if (result.reason === 'name') { showToast('请填写名称', null, true); $in('#sp-alm-f-name').trigger('focus'); }
        else if (result.reason === 'persist') showToast('日期保存失败，请重试', null, true);
    }
}

function toggleAlmanacPin(id) {
    const result = axisActions.togglePin(id); if (!result) return;
    // 就地更新该行（锁不改排序），不整面重渲 → 不会把滚动/视觉焦点弹回页头
    if (axisState.almanacMode) {
        const $rows = $in(`#sp-almanac-wrap .sp-alm-item[data-id="${id}"]`);
        $rows.toggleClass('sp-alm-pinned', result.pin);
        $rows.find('.sp-alm-pin')
            .attr('title', result.pin ? '已锁定 · 生成时保留（点击解锁）' : '锁定 · 生成时保留')
            .find('i').attr('class', `fa-solid ${result.pin ? 'fa-lock' : 'fa-lock-open'}`);
    }
}
// 日历详情↔网格联动：把某条目在当前月覆盖到的日子高亮到上方网格（直接改 class，不重渲）。
async function deleteAlmanacItem(id) {
    await axisActions.remove(id);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

// Inline model list state — cached models from last fetch. Not persisted
// across page reloads (matches original <select> behavior — user re-fetches
// if they refresh). Lives only while the tab is open.
let _cachedModels = [];

function renderModelList(models, filter = '') {
    _cachedModels = Array.isArray(models) ? models : [];
    $in('#sp-model-list-count').text(`已加载 ${_cachedModels.length} 个模型`);
    const q = filter.trim().toLowerCase();
    const shown = q ? _cachedModels.filter(m => m.toLowerCase().includes(q)) : _cachedModels;
    const current = ($in('#sp-cfg-model').val() || '').trim();
    if (!shown.length) {
        $in('#sp-model-list-items').html(`<div class="sp-model-list-empty">${q ? '无匹配项' : '暂无模型'}</div>`);
        return;
    }
    // Cap the initial render at 200 items with a "show more" tail for MASSIVE lists;
    // in practice most APIs return <200 so this is defensive.
    const html = shown.map(m =>
        `<button type="button" class="sp-model-list-item${m === current ? ' sp-model-list-item-active' : ''}" data-model="${escapeAttr(m)}">${escapeHtml(m)}</button>`
    ).join('');
    $in('#sp-model-list-items').html(html);
}

async function fetchModels() {
    const rawUrl = $in('#sp-cfg-url').val().trim();
    const key = ($in('#sp-cfg-key').data('real') || $in('#sp-cfg-key').val()).trim();
    if (!rawUrl || !key) { showToast('请先填写 URL 和 Key', null, true); return; }
    const url = normalizeApiUrl(rawUrl);
    const ctx = getContext();

    const $btn = $in('#sp-fetch-models');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    try {
        // Same proxy strategy as generation: go through ST's /status endpoint
        // which supports listing OpenAI-compatible models via a POST body.
        const res = await fetch('/api/backends/chat-completions/status', {
            method : 'POST',
            headers: ctx.getRequestHeaders(),
            body   : JSON.stringify({
                chat_completion_source: 'openai',
                reverse_proxy         : url,
                proxy_password        : key,
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
        const data = await res.json();
        if (data?.error) throw makeDiagnosticError('unknown', { phase: 'request' });
        const models = (data.data || data.models || [])
            .map(m => (typeof m === 'string' ? m : m.id))
            .filter(Boolean).sort();
        if (!models.length) throw new Error('接口未返回任何模型');

        // Inline model list — no popup, no z-index chaos. Render directly into
        // the settings body's <details> section so any browser/WebView that can
        // render <button> can render this. Fixes "popup appears behind plugin"
        // reports from in-app browsers (WeChat/QQ WebView, etc.) that don't
        // give <select> the native fullscreen picker treatment.
        renderModelList(models);
        // Auto-expand so user sees the result of their action
        $in('#sp-model-list-section').attr('open', 'open').show();
        showToast(`已加载 ${models.length} 个模型`);
    } catch (err) {
        showToast(`获取模型失败：${diagnosticMessage(err)}`, null, true);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-list"></i>');
    }
}

function toggleSettings() {
    settingsOpen = !settingsOpen;
    const $overlay = $in('#sp-settings-overlay');
    if (settingsOpen) {
        const savedLinesMode = getLinesMode();
        for (const value of ['turns', 'days', 'manual']) {
            $in(`input[name="sp-lines-mode"][value="${value}"]`).prop('checked', value === savedLinesMode);
        }
        renderWiList();     // async, fire-and-forget — fills list when done
        renderWiExcludeList();   // 全局排除清单（async fire-and-forget；冷缓存会强刷世界书全表）
        renderScaleRow();   // per-character scale radios (sync)
        renderAdultRow();
        renderMemorySection();   // memory status + settings sync
        renderTheaterSection();  // 棱 settings + cache usage + template manager
        renderStorageUsage();    // 存储管理面板：本聊天、坐标收藏、本机缓存三层用量统计
        $overlay.stop(true).css({ display: 'flex', opacity: 0 }).animate({ opacity: 1 }, 180);
    } else {
        $overlay.stop(true).animate({ opacity: 0 }, 150, function () { $(this).css('display', 'none'); });
        stSaveSettings();   // 关面板即把面板内所有改动立即写盘：兜底防抖未 flush 的字段（customPrompt 等），根治重启丢失
    }
    $in('.sp-settings-btn').toggleClass('sp-btn-active', settingsOpen);
    syncMobileViewport();
}

// ─── Memory section renderer + handlers ─────────────────────────────────────
let _databaseMemoryUiRevision = 0;

function captureDatabaseMemoryUiIdentity() {
    const ctx = getContext();
    return databaseMemoryUiIdentity({
        chatId: ctx?.chatId,
        characterId: ctx?.characterId,
        characterKey: charStableKey(ctx),
        selectedName: getSettings().databaseWorldbookName,
    });
}

function databaseMemoryUiRequestIsCurrent(identity, revision) {
    return revision === _databaseMemoryUiRevision
        && !!getSettings().useDatabase
        && sameDatabaseMemoryUiIdentity(identity, captureDatabaseMemoryUiIdentity());
}

async function renderDatabaseWorldbookSelector(identity, revision, ctx) {
    const $select = $in('#sp-mem-database-worldbook');
    if (!$select.length || !databaseMemoryUiRequestIsCurrent(identity, revision)) return;
    // Preserve the saved target immediately while the complete host list loads.
    $select.html(renderDatabaseWorldbookOptions([], identity.selectedName));
    let names = [];
    try { names = await getAllWorldNames(ctx); } catch {}
    if (!databaseMemoryUiRequestIsCurrent(identity, revision)) return;
    $select.html(renderDatabaseWorldbookOptions(names, identity.selectedName));
}

function renderMemorySection() {
    const databaseUiRevision = ++_databaseMemoryUiRevision;
    const s = getSettings();
    const useBbb   = !!s.useBaiBaiBook;
    const useAnima = !!s.useAnima;
    const useDatabase = !!s.useDatabase;
    $in('#sp-mem-source-bbb').prop('checked', useBbb);
    $in('#sp-mem-source-anima').prop('checked', useAnima);
    $in('#sp-mem-source-database').prop('checked', useDatabase);
    $in('#sp-mem-anima-options').toggle(useAnima || useDatabase);
    $in('#sp-mem-database-worldbook-options').toggle(useDatabase);
    $in('#sp-mem-anima-recall').val(getAnimaRecallCount());
    // 标签设置属于全局清洗规则，与记忆源无关；必须在各外部源 early-return 前回填。
    $in('#sp-mem-keeptags').val(typeof s.keepTags === 'string' ? s.keepTags : 'content');
    $in('#sp-mem-extratags').val(typeof s.extraTags === 'string' ? s.extraTags : '');
    // 自定义提示词是全局设置、与记忆源无关，必须在下面按源分支的 early-return 之前回填，
    // 否则用户选 Anima/柏宝书时函数提前 return，重开面板这框会空白（值其实已存盘）。
    $in('#sp-custom-prompt').val(typeof s.customPrompt === 'string' ? s.customPrompt : '');
    $in('#sp-storyclock-prompt').val(buildStoryClockPrompt(s));
    $in('#sp-space-persona').val(typeof s.spacePersona === 'string' ? s.spacePersona : '');   // 间·人格覆盖：同为全局设置，须在按源 early-return 前回填
    if (useBbb) {
        $in('#sp-mem-internal').hide();
        $in('#sp-mem-anima-status').hide();
        $in('#sp-mem-database-status').hide();
        $in('#sp-mem-bbb-status').show();
        const api = globalThis.STBaiBaiBook;
        if (api && typeof api.getInjectedHistory === 'function') {
            let coverageMsg = '柏宝书已就绪';
            try {
                const cov = api.getInjectedHistory()?.coverage;
                if (cov?.complete === false) coverageMsg += `（缺 ${cov.missingAiFloors?.length ?? '?'} 楼摘要）`;
                else coverageMsg += '（覆盖完整）';
            } catch {}
            $in('#sp-mem-bbb-status').html(`<i class="fa-solid fa-circle-check" style="color:var(--cardhub-accent,#7c9)"></i> ${escapeHtml(coverageMsg)}`);
        } else {
            $in('#sp-mem-bbb-status').html('<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> 检测不到柏宝书 API：请确认已安装并把柏宝书更新到最新版（旧版无读取接口）；点 / 线 / 面 / 间 生成时不会注入历史记忆');
        }
        return;
    }
    if (useAnima) {
        $in('#sp-mem-internal').hide();
        $in('#sp-mem-bbb-status').hide();
        $in('#sp-mem-database-status').hide();
        $in('#sp-mem-anima-status').show();
        renderAnimaStatus();
        return;
    }
    if (useDatabase) {
        const ctx = getContext();
        const identity = captureDatabaseMemoryUiIdentity();
        void renderDatabaseWorldbookSelector(identity, databaseUiRevision, ctx);
        $in('#sp-mem-internal').hide();
        $in('#sp-mem-bbb-status, #sp-mem-anima-status').hide();
        $in('#sp-mem-database-status').show().html('<i class="fa-solid fa-circle-info"></i> 正在读取数据库纪要…');
        databaseMemoryAccess.result().then(result => {
            if (!databaseMemoryUiRequestIsCurrent(identity, databaseUiRevision)) return;
            const ok = result.status === 'ready';
            $in('#sp-mem-database-status').html(ok
                ? `<i class="fa-solid fa-circle-check" style="color:var(--cardhub-accent,#7c9)"></i> ${escapeHtml(databaseMemoryDiagnostic(result))}`
                : `<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> ${escapeHtml(databaseMemoryDiagnostic(result))}`);
        }).catch(error => {
            if (!databaseMemoryUiRequestIsCurrent(identity, databaseUiRevision)) return;
            const bookName = identity.selectedName || getDatabasePrimaryWorldbookName(ctx);
            $in('#sp-mem-database-status').html(`<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> ${escapeHtml(databaseMemoryDiagnostic({ status: 'processing-failed', bookName, targetMode: identity.selectedName ? 'explicit' : 'primary', error }))}`);
        });
        return;
    }
    $in('#sp-mem-internal').show();
    $in('#sp-mem-bbb-status').hide();
    $in('#sp-mem-anima-status').hide();
    $in('#sp-mem-database-status').hide();
    $in('#sp-mem-enabled').prop('checked', s.memoryEnabled !== false);
    $in('#sp-mem-l0').val(Number.isFinite(+s.memoryL0Group) ? +s.memoryL0Group : 5);
    $in('#sp-mem-l1').val(Number.isFinite(+s.memoryL1Group) ? +s.memoryL1Group : 10);
    $in('#sp-mem-skipshort').val(Number.isFinite(+s.memorySkipShort) ? +s.memorySkipShort : 50);
    refreshMemoryStatus();
}

// Async status line for the Anima source: resolves the chat-bound worldbook via
// 酒馆助手 and counts anima_summary slices. Guarded against the user flipping the
// source mid-await (re-checks useAnima before writing).
async function renderAnimaStatus() {
    const $st = $in('#sp-mem-anima-status');
    const th = globalThis.TavernHelper;
    if (!th || typeof th.getChatWorldbookName !== 'function' || typeof th.getWorldbook !== 'function') {
        $st.html('<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> 检测不到酒馆助手(TavernHelper)：请确认已安装并启用「酒馆助手」与「Anima 记忆系统」；点 / 线 / 面 / 间 生成时不会注入历史记忆');
        return;
    }
    $st.html('<i class="fa-solid fa-spinner fa-spin"></i> 正在读取 Anima 摘要…');
    let wbName = null;
    try { wbName = await th.getChatWorldbookName('current'); } catch {}
    if (!getSettings().useAnima) return;   // await 期间用户切走了源
    if (!wbName) {
        $st.html('<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> 当前聊天没有绑定世界书，读不到 Anima 摘要');
        return;
    }
    let count = 0;
    try {
        const entries = await th.getWorldbook(wbName);
        if (Array.isArray(entries)) {
            for (const e of entries) {
                if (e?.extra?.createdBy === 'anima_summary' && Array.isArray(e.extra.history)) count += e.extra.history.length;
            }
        }
    } catch {}
    if (!getSettings().useAnima) return;
    if (count > 0) {
        $st.html(`<i class="fa-solid fa-circle-check" style="color:var(--cardhub-accent,#7c9)"></i> Anima 已就绪（世界书「${escapeHtml(wbName)}」读到 ${count} 段摘要）`);
    } else {
        $st.html(`<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> 世界书「${escapeHtml(wbName)}」里没有 Anima 摘要（anima_summary）——请先让 Anima 跑出摘要`);
    }
}


function refreshMemoryStatus() {
    const r = memory.getHealthReport();
    if (!r.paused) memoryPauseNoticeShown = false;
    const rows = [
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">AI 楼总数</span><span class="sp-mem-stat-v">${r.totalAi}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">稳定分组数</span><span class="sp-mem-stat-v">${r.totalGroups}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">已生成 L0</span><span class="sp-mem-stat-v">${r.withL0}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">待生成</span><span class="sp-mem-stat-v${r.pending > 0 ? ' sp-mem-warn' : ''}">${r.pending}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">永久失败</span><span class="sp-mem-stat-v${r.permaFailed > 0 ? ' sp-mem-warn' : ''}">${r.permaFailed}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">L1 章节数</span><span class="sp-mem-stat-v">${r.l1Chapters}</span></div>`,
    ];
    if (r.strippedEmpty > 0) rows.splice(5, 0,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">标签致空</span><span class="sp-mem-stat-v sp-mem-warn">${r.strippedEmpty}</span></div>`);
    if (r.strippedEmpty > 0) rows.push(`<div class="sp-mem-alert">⚠ 有 ${r.strippedEmpty} 组净化后正文几乎为空，请重查「保留标签」设置（非模型问题，无需换模型）。</div>`);
    if (r.paused) rows.push(`<div class="sp-mem-alert">⚠ 记忆系统已暂停：${escapeHtml(r.lastError || '连续失败')}。点补齐或重构以恢复。</div>`);
    if (r.busy)   rows.push(`<div class="sp-mem-alert sp-mem-alert-info">🔄 记忆系统正在后台工作</div>`);
    $in('#sp-mem-status').html(rows.join(''));
}

// ─── 棱 settings renderer ───────────────────────────────────────────────────
function renderTheaterSection() {
    const s = getSettings();
    $in('#sp-theater-style').val(typeof s.theaterStylePrompt === 'string' ? s.theaterStylePrompt : '');
    void theaterFeature?.refreshUi();
}

// 棱设置分节的事件（config 字段即改即存；模板 CRUD。缓存治理已移交存储管理面板）
function bindTheaterHandlers() {
    // 棱 section 会被布局 seam 拆成提示词/数据两个抽屉；绑定共同祖先，避免指向已移除旧节点。
    theaterFeature?.bindSettings($in('.sp-settings-body'));
}

function bindMemoryHandlers() {
    $in('#sp-mem-source-bbb').on('change', function () {
        const s = getSettings();
        s.useBaiBaiBook = this.checked;
        if (this.checked) { s.useAnima = false; s.useDatabase = false; }   // 记忆源互斥
        saveSettingsDebounced();
        memory.abortAll('manual-abort');
        renderMemorySection();
    });
    $in('#sp-mem-source-anima').on('change', function () {
        const s = getSettings();
        s.useAnima = this.checked;
        if (this.checked) { s.useBaiBaiBook = false; s.useDatabase = false; }   // 记忆源互斥
        saveSettingsDebounced();
        memory.abortAll('manual-abort');
        renderMemorySection();
    });
    $in('#sp-mem-source-database').on('change', function () {
        const s = getSettings();
        s.useDatabase = this.checked;
        if (this.checked) { s.useBaiBaiBook = false; s.useAnima = false; }
        saveSettingsDebounced();
        memory.abortAll('manual-abort');
        renderMemorySection();
    });
    $in('#sp-mem-database-worldbook').on('change', function () {
        const value = normalizeDatabaseWorldbookName(this.value);
        getSettings().databaseWorldbookName = value;
        this.value = value;
        saveSettingsDebounced();
        renderMemorySection();
    });
    $in('#sp-mem-anima-recall').on('change', function () {
        const value = Math.max(1, Math.min(50, parseInt(this.value, 10) || 20));
        getSettings().animaRecallCount = value;
        this.value = value;
        saveSettingsDebounced();
    });
    $in('#sp-mem-enabled').on('change', function () {
        getSettings().memoryEnabled = this.checked;
        saveSettingsDebounced();
        if (!this.checked) memory.abortAll('manual-abort');
    });
    $in('#sp-mem-l0').on('change', function () {
        const v = Math.max(1, Math.min(30, parseInt(this.value, 10) || 5));
        getSettings().memoryL0Group = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $in('#sp-mem-l1').on('change', function () {
        const v = Math.max(2, Math.min(30, parseInt(this.value, 10) || 10));
        getSettings().memoryL1Group = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $in('#sp-mem-skipshort').on('change', function () {
        const v = Math.max(0, Math.min(500, parseInt(this.value, 10) || 50));
        getSettings().memorySkipShort = v;
        this.value = v;
        saveSettingsDebounced();
    });
    // Tag sanitizer inputs — normalize Unicode tag names or the fixed [[...]] rule, then save.
    // Applies to future reads; existing L0 summaries built with old rules keep
    // their hash and stay valid — new content read after change uses new rules.
    // input=即打即存（存 sanitize 值但不回写 value，免光标跳）；change=失焦时规范化回写显示。
    // 关键：只用 change 会在「输入框还没失焦就点保存/关面板」时丢掉那次编辑（表现为“动了 API，标签/提示词被重置”）。
    function sanitizeTagList(raw) {
        return normalizeTagRules(raw).join(',');
    }
    function bindTagField(sel, key) {
        // sel 是 #sp-mem-* 选择器串（设置区在 shadow 内）→ 必须 $in 绑定，否则不落存
        $in(sel).on('input', function () {
            getSettings()[key] = sanitizeTagList(this.value);
            saveSettingsDebounced();
        }).on('change', function () {
            const v = sanitizeTagList(this.value);
            getSettings()[key] = v;
            this.value = v;                 // 失焦才回写，避免打字途中光标跳到末尾
            saveSettingsDebounced();
            stSaveSettings();
        });
    }
    bindTagField('#sp-mem-keeptags',  'keepTags');
    bindTagField('#sp-mem-extratags', 'extraTags');
    $in('#sp-custom-prompt').on('input', function () {
        getSettings().customPrompt = this.value;
        saveSettingsDebounced();
    }).on('blur', function () {
        getSettings().customPrompt = this.value;
        stSaveSettings();   // 失焦即落盘，覆盖"填完没关面板就直接刷新"的场景
    });
    // 间·人格覆盖：与 customPrompt 同套持久化（无常驻注入，下次进「间」发消息时经 buildSpaceChatSystemPrompt 现读现生效）。
    $in('#sp-space-persona').on('input', function () {
        getSettings().spacePersona = this.value;
        saveSettingsDebounced();
    }).on('blur', function () {
        getSettings().spacePersona = this.value;
        stSaveSettings();
    });
    // 时间戳·强注词二改：与 customPrompt 同套持久化；改后立即重设常驻注入让新词当楼生效。
    $in('#sp-storyclock-prompt').on('input', function () {
        getSettings().storyClockPrompt = this.value;
        getSettings().storyClockPromptVersion = 2;
        saveSettingsDebounced();
        try { refreshStoryClockInjection(); } catch {}
    }).on('blur', function () {
        getSettings().storyClockPrompt = this.value;
        getSettings().storyClockPromptVersion = 2;
        stSaveSettings();
    });
    $in('#sp-storyclock-prompt-load').on('click', function () {
        const fullDefault = buildStoryClockPrompt({});
        $in('#sp-storyclock-prompt').val(fullDefault);
        getSettings().storyClockPrompt = fullDefault;
        getSettings().storyClockPromptVersion = 2;
        stSaveSettings();
        try { refreshStoryClockInjection(); } catch {}
        try { showToast('已把默认强制词载入编辑框，可直接修改'); } catch {}
    });
    // 恢复默认＝清空＝回到内置 live 默认（继续跟随插件更新），区别于「载入默认再改」的冻结快照。
    $in('#sp-storyclock-prompt-reset').on('click', function () {
        $in('#sp-storyclock-prompt').val('');
        getSettings().storyClockPrompt = '';
        getSettings().storyClockPromptVersion = 2;
        stSaveSettings();
        try { refreshStoryClockInjection(); } catch {}
        try { showToast('已恢复内置默认（跟随插件更新）'); } catch {}
    });
    $in('#sp-mem-check').on('click', function () {
        refreshMemoryStatus();
        showToast('已刷新记忆状态');
    });
    $in('#sp-mem-fill').on('click', async function () {
        if ($(this).prop('disabled')) return;
        setMemoryProgressVisible(true);
        $(this).prop('disabled', true);
        try {
            await memory.fillMissing(({ current, total, done }) => {
                updateMemoryProgress(current, total);
                if (current % 3 === 0 || done) refreshMemoryStatus();
            });
            showToast('补齐完成');
        } catch (err) {
            showToast('补齐失败：' + diagnosticMessage(err), null, true);
        } finally {
            $(this).prop('disabled', false);
            setMemoryProgressVisible(false);
            refreshMemoryStatus();
        }
    });
    $in('#sp-mem-rebuild').on('click', async function () {
        const r = memory.getHealthReport();
        const cost = r.totalGroups;
        const ok = await spConfirm({
            title  : '推翻重构',
            body   : `将清空全部摘要并按当前分组重新生成，约需 ${cost} 次 L0 API 调用 + 若干次 L1 压缩。`,
            note   : '重构期间可随时中止；中止会还原到重构前的记忆、不会清空。已有的点 / 线 / 面 不受影响。',
            confirmText: '开始重构',
            cancelText : '取消',
        });
        if (!ok) return;
        if ($(this).prop('disabled')) return;
        setMemoryProgressVisible(true);
        $(this).prop('disabled', true);
        let wasAborted = false;
        try {
            await memory.rebuildAll(({ current, total, done, aborted }) => {
                if (aborted) wasAborted = true;
                updateMemoryProgress(current, total, aborted);
                if (current % 3 === 0 || done || aborted) refreshMemoryStatus();
            });
            showToast(wasAborted ? '已中止，已还原到重构前的记忆' : '重构完成');
        } catch (err) {
            showToast('重构失败：' + diagnosticMessage(err), null, true);
        } finally {
            $(this).prop('disabled', false);
            setMemoryProgressVisible(false);
            refreshMemoryStatus();
        }
    });
    $in('#sp-mem-progress-abort').on('click', () => memory.abortRebuild());
}

function setMemoryProgressVisible(visible) {
    $in('#sp-mem-progress').toggle(!!visible);
    if (visible) updateMemoryProgress(0, 0);
}

function updateMemoryProgress(current, total, aborted = false) {
    $in('#sp-mem-progress-count').text(aborted ? `已中止 (${current}/${total})` : `${current}/${total}`);
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    $in('#sp-mem-progress-fill').css('width', pct + '%');
}

// Renders the narrative-scale radio group into #sp-scale-row using the current
// character's saved value. Regenerated each time settings opens (character can
// change between opens).
function renderScaleRow() {
    const $row = $in('#sp-scale-row');
    if (!$row.length) return;
    const ctx = getContext();
    const current = getScale(charStableKey(ctx));
    const opts = SCALE_VALUES.map(v => `
        <label class="sp-mode-opt">
            <input type="radio" name="sp-lines-scale" value="${v}"${v === current ? ' checked' : ''}>
            <span>${escapeHtml(SCALE_LABELS[v])}</span>
        </label>`).join('');
    $row.html(opts);
}

function renderAdultRow() {
    const $row = $in('#sp-adult-row');
    if (!$row.length) return;
    const current = getAdultMode(charStableKey(getContext()));
    $row.html(ADULT_MODES.map(v => `<label class="sp-mode-opt"><input type="radio" name="sp-lines-adult-mode" value="${v}"${v === current ? ' checked' : ''}><span>${escapeHtml(ADULT_MODE_LABELS[v])}</span></label>`).join(''));
}

// Render world-info entry checklist for the current character into #sp-wi-list.
// Perf: builds one HTML string + inserts once, uses event delegation on the list root.
let _wiEntryCache = new Map();   // key → entry object, for eye-button popup lookup
let _wiListRevision = 0;

function _wiListIdentity(ctx) {
    return JSON.stringify({
        chatId: String(ctx?.chatId ?? ''),
        characterId: String(ctx?.characterId ?? ''),
        characterKey: charStableKey(ctx),
    });
}

// Nearest scrollable ancestor — used to keep the viewport steady across a
// re-render (adding/removing an extra book rebuilds the whole list).
function _wiScrollParent(el) {
    let p = el && el.parentElement;
    while (p) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
        p = p.parentElement;
    }
    return null;
}

async function renderWiList() {
    const ctx = getContext();
    const $list = $in('#sp-wi-list');
    const revision = ++_wiListRevision;
    const identity = _wiListIdentity(ctx);
    const isCurrent = () => revision === _wiListRevision && identity === _wiListIdentity(getContext());

    // Snapshot the current expand + scroll state BEFORE the loading placeholder
    // wipes the DOM, so a re-render doesn't spring every <details> group back open
    // or bounce the viewport. First open has no groups yet → everything defaults
    // open as before.
    const prevSources = new Set();
    const openSources = new Set();
    $list.find('.sp-wi-group').each(function () {
        const src = String(this.getAttribute('data-source') || '');
        prevSources.add(src);
        if (this.open) openSources.add(src);
    });
    const hadGroups = prevSources.size > 0;
    const scrollEl = _wiScrollParent($list[0]);
    const savedScroll = scrollEl ? scrollEl.scrollTop : 0;

    $list.html('<span class="sp-cfg-hint">正在加载世界书条目…</span>');

    let entries;
    try {
        entries = await getCharBookEntries(ctx);
    } catch (err) {
        if (!isCurrent()) return;
        $list.html(`<span class="sp-cfg-hint">加载失败：${escapeHtml(diagnosticMessage(err))}</span>`);
        return;
    }
    if (!isCurrent()) return;

    // Cache entries for the eye-button popup
    if (!isCurrent()) return;
    _wiEntryCache = new Map(entries.map(e => [e.key, e]));

    const selection = ensureCurrentWiSelection(ctx, entries);

    // Two-level group: scope (char / chat / persona / global) → source (book name) → entries.
    // Preserves entry order within each source: char, chat, persona, then global.
    const scopes = new Map([['char', new Map()], ['chat', new Map()], ['persona', new Map()], ['global', new Map()]]);
    for (const e of entries) {
        const scopeGroup = scopes.get(e.scope) || scopes.get('char');
        if (!scopeGroup.has(e.source)) scopeGroup.set(e.source, []);
        scopeGroup.get(e.source).push(e);
    }
    const SCOPE_LABELS = { char: '角色卡世界书', chat: '当前聊天世界书', persona: '用户世界书', global: '全局世界书' };

    // Build HTML in one pass.
    const parts = [];
    if (entries.length) {
        parts.push(`<div class="sp-wi-all-row">
            <label class="sp-wi-toggle-all">
                <input type="checkbox" id="sp-wi-select-all"> 全选 / 全不选
            </label>
            <span class="sp-wi-count">${entries.length} 条</span>
        </div>`);
    } else {
        parts.push('<span class="sp-cfg-hint">当前角色没有关联 / 全局启用的世界书。</span>');
    }

    for (const [scope, groups] of scopes) {
        if (!groups.size) continue;
        const scopeCount = [...groups.values()].reduce((n, g) => n + g.length, 0);
        parts.push(`<div class="sp-wi-scope">
            <div class="sp-wi-scope-label">${escapeHtml(SCOPE_LABELS[scope])} <span class="sp-wi-scope-count">${scopeCount} 条</span></div>`);
        for (const [source, group] of groups) {
            // Each book is collapsible; default open. summary shows a
            // per-book "select-all" checkbox (indeterminate when partial).
            const groupChecked = group.filter(e => worldInfoSelectionAllows(selection, e.key)).length;
            const groupAllOn   = groupChecked === group.length;
            const groupAllOff  = groupChecked === 0;
            const escSrc       = escapeAttr(source);
            // Preserve prior expand state across re-renders; open by default on the
            // first render and for a newly-appearing book (source not seen before).
            const groupOpen = !hadGroups || openSources.has(source) || !prevSources.has(source);
            parts.push(`<details class="sp-wi-group" data-source="${escSrc}"${groupOpen ? ' open' : ''}>
                <summary class="sp-wi-source-label">
                    <input type="checkbox" class="sp-wi-group-cb" data-source="${escSrc}"${groupAllOn ? ' checked' : ''}${!groupAllOn && !groupAllOff ? ' data-indeterminate="true"' : ''}>
                    <span class="sp-wi-source-name">${escapeHtml(source)}</span>
                    <span class="sp-wi-group-count">${group.length} 条</span>
                </summary>
                <div class="sp-wi-items">`);
            for (const e of group) {
                const checked = worldInfoSelectionAllows(selection, e.key);
                parts.push(`<div class="sp-wi-card${checked ? '' : ' sp-wi-card-off'}" data-key="${escapeAttr(e.key)}" data-source="${escSrc}" role="button" tabindex="0">
                    <div class="sp-wi-card-head">
                        <input type="checkbox" class="sp-wi-cb" data-key="${escapeAttr(e.key)}"${checked ? ' checked' : ''}>
                        <span class="sp-wi-label">${escapeHtml(e.label)}</span>
                    </div>
                    <div class="sp-wi-card-body">
                        <div class="sp-wi-preview">${e.preview ? escapeHtml(e.preview) + '…' : '<span class="sp-wi-empty">（无内容）</span>'}</div>
                        <button class="sp-wi-view-btn" type="button" title="查看全文" data-key="${escapeAttr(e.key)}"><i class="fa-regular fa-eye"></i></button>
                    </div>
                </div>`);
            }
            parts.push(`</div></details>`);
        }
        parts.push(`</div>`);
    }

    // Single DOM write
    if (!isCurrent()) return;
    $list[0].innerHTML = parts.join('');

    // Event delegation — one handler for the whole list, regardless of entry count
    $list.off('.wi').on('click.wi', '.sp-wi-view-btn', function (ev) {
        ev.stopPropagation();
        const key = $(this).data('key');
        const entry = _wiEntryCache.get(key);
        if (entry) showWiEntryFull(entry);
    }).on('click.wi', '.sp-wi-card', function (ev) {
        if ($(ev.target).closest('.sp-wi-view-btn').length) return;
        const $card = $(this);
        const $cb   = $card.find('.sp-wi-cb');
        if (ev.target !== $cb[0]) {
            $cb.prop('checked', !$cb.prop('checked'));
        }
        $card.toggleClass('sp-wi-card-off', !$cb.prop('checked'));
        syncWiSelectAll();
        saveCurrentWiSelection();
    }).on('keydown.wi', '.sp-wi-card', function (ev) {
        if (ev.key !== ' ' && ev.key !== 'Enter') return;
        ev.preventDefault();
        const $card = $(this);
        const $cb   = $card.find('.sp-wi-cb');
        $cb.prop('checked', !$cb.prop('checked'));
        $card.toggleClass('sp-wi-card-off', !$cb.prop('checked'));
        syncWiSelectAll();
        saveCurrentWiSelection();
    }).on('change.wi', '#sp-wi-select-all', function () {
        const checked = this.checked;
        $list.find('.sp-wi-cb').prop('checked', checked);
        $list.find('.sp-wi-card').toggleClass('sp-wi-card-off', !checked);
        $list.find('.sp-wi-group-cb').prop({ checked, indeterminate: false });
        saveCurrentWiSelection();
    }).on('change.wi', '.sp-wi-group-cb', function (ev) {
        // Per-book select-all — flip every entry in this <details> group
        ev.stopPropagation();
        const $group = $(this).closest('.sp-wi-group');
        const checked = this.checked;
        $group.find('.sp-wi-cb').prop('checked', checked);
        $group.find('.sp-wi-card').toggleClass('sp-wi-card-off', !checked);
        this.indeterminate = false;
        syncWiSelectAll();
        saveCurrentWiSelection();
    }).on('click.wi', '.sp-wi-group-cb', function (ev) {
        // Don't let click on the summary's checkbox also toggle <details> open/close
        ev.stopPropagation();
    });

    // Keep the viewport where it was across a re-render (skip on first open).
    if (scrollEl && hadGroups) scrollEl.scrollTop = savedScroll;

    syncWiSelectAll();
}

function syncWiSelectAll() {
    const $cbs = $inAll('#sp-wi-list .sp-wi-cb');
    if (!$cbs.length) return;
    const total   = $cbs.length;
    const checked = $cbs.filter(':checked').length;
    const $all = $in('#sp-wi-select-all')[0];
    if ($all) {
        $all.checked       = checked === total;
        $all.indeterminate = checked > 0 && checked < total;
    }
    // Refresh each group's per-book checkbox based on its own entries
    $inAll('#sp-wi-list .sp-wi-group').each(function () {
        const $g = $(this);
        const $groupCb = $g.find('.sp-wi-group-cb')[0];
        if (!$groupCb) return;
        const gCbs = $g.find('.sp-wi-cb');
        const gTotal = gCbs.length;
        const gChecked = gCbs.filter(':checked').length;
        $groupCb.checked       = gChecked === gTotal;
        $groupCb.indeterminate = gChecked > 0 && gChecked < gTotal;
    });
}

// 解析 ST 里注册的「全部世界书名」——供全局排除清单用。
// getWorldInfoNames() 只读内存缓存 world_names，而它要 updateWorldInfoList()（拉
// /api/worldinfo/list）才填；用户没开过酒馆 WI 面板 → 缓存冷 → 清单空。读书路径不受影响
// （走 loadWorldInfo/TavernHelper 直取），所以会出现「读书正常、排除清单空」。分层兜底、
// 首个非空即用：
//   1. 暖缓存 getWorldInfoNames()（已填则零成本，行为同旧版）
//   2. TavernHelper（跨分支便携：新 getWorldbookNames / 旧 getLorebooks）
//   3. 强制刷新 updateWorldInfoList() 再读——/api/worldinfo/list 权威、根治空清单
async function getAllWorldNames(ctx) {
    try {
        const cached = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
        if (Array.isArray(cached) && cached.length) return cached;
    } catch {}
    try {
        const th = globalThis?.TavernHelper;
        const fn = th?.getWorldbookNames || th?.getLorebooks;
        if (typeof fn === 'function') {
            const list = await fn.call(th);
            if (Array.isArray(list) && list.length) return list;
        }
    } catch {}
    try {
        if (typeof ctx.updateWorldInfoList === 'function') {
            await ctx.updateWorldInfoList();
            const refreshed = typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
            if (Array.isArray(refreshed)) return refreshed;
        }
    } catch {}
    return [];
}

// 全局排除清单（B方案）：列出 ST 里所有世界书（与角色卡无关），勾选 = 拉黑、构画一律不读。
// 存 s.wiExcludeBooks（全局），与 renderWiList 的按角色卡挑选正交。书多（三四十本）时套进
// 内联抽屉 + 查找框：本函数只铺行，查找靠 _filterWiExcludeList 纯前端隐/显，不重渲（重渲会
// 打断查找框输入焦点）。名单经 getAllWorldNames 解析（冷缓存会强刷 /api/worldinfo/list）。
async function renderWiExcludeList() {
    const $list = $in('#sp-wi-exclude-list');
    if (!$list.length) return;
    const ctx = getContext();
    let names = await getAllWorldNames(ctx);
    names = [...new Set((names || []).filter(n => typeof n === 'string' && n))].sort((a, b) => a.localeCompare(b, 'zh'));
    const excluded = getWiExcludeSet();
    _syncWiExcludeCount(excluded.size, names.length);
    if (!names.length) {
        $list.html('<span class="sp-cfg-hint">当前没有任何世界书。</span>');
        return;
    }
    const rows = names.map(name => {
        const on = hasWiExcluded(name, excluded);
        return `<label class="sp-wi-exclude-row${on ? ' sp-wi-exclude-on' : ''}" data-name="${escapeAttr(name)}">
            <input type="checkbox" class="sp-wi-exclude-cb" data-name="${escapeAttr(name)}"${on ? ' checked' : ''}>
            <span class="sp-wi-exclude-name">${escapeHtml(name)}</span>
        </label>`;
    }).join('');
    $list[0].innerHTML = rows;
    $list.off('.wix').on('change.wix', '.sp-wi-exclude-cb', function () {
        const name = String($(this).data('name') || '');
        setWiExcluded(name, this.checked);
        $(this).closest('.sp-wi-exclude-row').toggleClass('sp-wi-exclude-on', this.checked);
        _syncWiExcludeCount(getWiExcludeSet().size, names.length);
        renderWiList();   // 排除变化即时反映到上面的按角色卡挑选列表（被排除的书从中消失/重现）
    });
    // 查找框：一次性绑定（每次 render 都重绑，off 先解旧的），输入即隐/显匹配行。
    const $search = $in('#sp-wi-exclude-search');
    $search.off('.wix').on('input.wix', function () {
        _filterWiExcludeList(String(this.value || '').trim().toLowerCase());
    });
    if ($search.val()) _filterWiExcludeList(String($search.val()).trim().toLowerCase());
}

// 查找框纯前端过滤：名字含关键词的行显示、其余隐藏；空词全显。
function _filterWiExcludeList(kw) {
    const $rows = $inAll('#sp-wi-exclude-list .sp-wi-exclude-row');
    if (!kw) { $rows.show(); return; }
    $rows.each(function () {
        const name = String(this.getAttribute('data-name') || '').toLowerCase();
        this.style.display = name.includes(kw) ? '' : 'none';
    });
}

// 抽屉标题右侧的计数徽标：「已排除 M / 共 N」，M=0 时只显总数、淡化。
function _syncWiExcludeCount(excludedN, totalN) {
    const $c = $in('#sp-wi-exclude-count');
    if (!$c.length) return;
    $c.text(excludedN > 0 ? `已排除 ${excludedN} / 共 ${totalN}` : `共 ${totalN}`)
      .toggleClass('sp-wi-exclude-count-active', excludedN > 0);
}

// Full-text popup for a single world-info entry
function showWiEntryFull(entry) {
    $in('#sp-wi-fullview').remove();
    const $overlay = $(`<div id="sp-wi-fullview" class="sp-wi-fullview">
        <div class="sp-wi-fullview-sheet">
            <div class="sp-wi-fullview-head">
                <div class="sp-wi-fullview-title">
                    <div class="sp-wi-fullview-source">${escapeHtml(entry.source)}</div>
                    <div class="sp-wi-fullview-label">${escapeHtml(entry.label)}</div>
                </div>
                <button class="sp-icon-btn sp-wi-fullview-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="sp-wi-fullview-body">${escapeHtml(entry.content || '').replace(/\n/g, '<br>')}</div>
        </div>
    </div>`);
    $overlay.on('click', function (e) {
        if (e.target === this) $overlay.remove();
    });
    $overlay.find('.sp-wi-fullview-close').on('click', () => $overlay.remove());
    $in('.sp-sheet').append($overlay);
}

function toggleKeyVisibility() {
    const $el = $in('#sp-cfg-key'), $icon = $in('#sp-key-toggle i');
    if ($el.attr('type') === 'password') {
        $el.attr('type', 'text').val($el.data('real') || $el.val());
        $icon.removeClass('fa-eye').addClass('fa-eye-slash');
    } else {
        const r = $el.val(); $el.data('real', r).attr('type', 'password').val(maskKey(r));
        $icon.removeClass('fa-eye-slash').addClass('fa-eye');
    }
}

// ─── API 存储快切：UI 事件 + 下拉渲染 ────────────────────────────────────────
// 从当前输入框读出这一套 API 配置（含未点保存的改动、Key 取 data('real') 真值）。
function readApiInputs() {
    const $k = $in('#sp-cfg-key');
    const rawTimeout = String($in('#sp-cfg-timeout').val() ?? '').trim();
    const timeout = Number(rawTimeout);
    const timeoutValid = rawTimeout !== '' && Number.isInteger(timeout) && timeout >= 5 && timeout <= 600;
    return {
        url          : $in('#sp-cfg-url').val().trim().replace(/\/$/, ''),
        key          : ($k.data('real') || $k.val() || '').trim(),
        model        : $in('#sp-cfg-model').val().trim(),
        excludeParams: parseExcludeParams($in('#sp-cfg-exclude').val()),
        timeoutSec   : timeoutValid ? timeout : null,
        timeoutValid,
        stream       : $in('#sp-cfg-stream').is(':checked'),
    };
}

function apiPresetSnapshotKey(cfg) {
    return JSON.stringify({
        url: cfg?.url || '', key: cfg?.key || '', model: cfg?.model || '',
        excludeParams: Array.isArray(cfg?.excludeParams) ? cfg.excludeParams : [],
        timeoutSec: Number.isInteger(Number(cfg?.timeoutSec)) ? Number(cfg.timeoutSec) : null, stream: cfg?.stream === true,
    });
}

function activeApiPreset() {
    const id = getSettings().apiPresetActiveId || '';
    return id ? loadApiPresets().find(p => p.id === id) || null : null;
}

function apiInputsDirty() {
    const p = activeApiPreset();
    return !!p && apiPresetSnapshotKey(readApiInputs()) !== apiPresetSnapshotKey(p);
}

function apiInputsSaveable(cfg) {
    return cfg?.timeoutValid !== false && Number.isInteger(Number(cfg?.timeoutSec)) && Number(cfg.timeoutSec) >= 5 && Number(cfg.timeoutSec) <= 600;
}

function saveCurrentAsPreset() {
    const cur = readApiInputs();
    if (!apiInputsSaveable(cur)) { showPresetHint('请求超时必须填写 5–600 秒，未保存预设'); return null; }
    if (!cur.url && !cur.key) { showPresetHint('先填 API 再保存预设'); return null; }
    const name = autoPresetName(cur.url);
    upsertApiPreset(name, cur, null);
    renderApiPresetList();
    renderUtilityPresetList();
    showPresetHint(`已存为预设「${name}」`);
    return name;
}

// 把一套预设填回输入框。Key 走 maskKey 遮罩 + data('real') 存真值。
function fillApiInputs(p) {
    $in('#sp-cfg-url').val(p.url || '');
    const $k = $in('#sp-cfg-key');
    if (p.key) $k.data('real', p.key).val(maskKey(p.key)).attr('type', 'password');
    else       $k.data('real', '').val('');
    $in('#sp-cfg-model').val(p.model || '');
    $in('#sp-cfg-exclude').val((Array.isArray(p.excludeParams) ? p.excludeParams : []).join('\n'));
    $in('#sp-cfg-timeout').val(p.timeoutSec || 180);
    $in('#sp-cfg-stream').prop('checked', p.stream === true);
}

// 渲染内联预设列表：在流内展开，非原生 <select> 弹窗——与「模型列表」同一套内联思路，
// 避开 WebView（微信/QQ 内置浏览器等）里 select 弹层被插件盖住/弹不出的老问题。
function renderApiPresetList() {
    const $list = $in('#sp-preset-list');
    if (!$list.length) return;
    const list = loadApiPresets();
    const activeId = getSettings().apiPresetActiveId || '';
    $list.html(list.length
        ? list.map(p => `<div class="sp-preset-item-row" data-id="${escapeAttr(p.id)}"><button type="button" class="sp-preset-item${p.id === activeId ? ' sp-preset-item-active' : ''}" data-id="${escapeAttr(p.id)}">${escapeHtml(p.name)}</button><button type="button" class="sp-preset-rename" data-id="${escapeAttr(p.id)}" title="仅修改这条预设的名称"><i class="fa-solid fa-pen"></i></button></div>`).join('')
        : `<div class="sp-preset-empty">暂无预设，填好 API 后点右侧＋存一个</div>`);
    $in('#sp-preset-del').prop('disabled', !activeId);
    syncPresetLabel();
    syncPresetState();
}

// 「假框」显示当前选中预设名（无原生 select，直接按 activeId 回显）
function syncPresetLabel() {
    const $lb = $in('#sp-preset-label');
    if (!$lb.length) return;
    const p = loadApiPresets().find(x => x.id === (getSettings().apiPresetActiveId || ''));
    $lb.text(p ? p.name : '选择预设…');
}

function showPresetHint(msg) {
    const $h = $in('#sp-preset-hint');
    if (!$h.length) return;
    $h.text(msg).show();
    clearTimeout(showPresetHint._t);
    showPresetHint._t = setTimeout(() => $h.fadeOut(200), 2600);
}

function syncPresetState() {
    const $btn = $in('#sp-preset-update');
    const $state = $in('#sp-preset-sync-state');
    if (!$btn.length) return;
    const p = activeApiPreset();
    if (p) {
        const dirty = apiInputsDirty();
        const valid = apiInputsSaveable(readApiInputs());
        $btn.text(`更新「${p.name}」`).prop('disabled', !dirty || !valid);
        $state.text(!valid ? '请求超时需填写 5–600 秒' : dirty ? '尚未更新到预设' : '已与预设同步').toggle(!valid || !!dirty);
    } else {
        const valid = apiInputsSaveable(readApiInputs());
        $btn.text('另存为新预设').prop('disabled', !valid);
        $state.text(valid ? '' : '请求超时需填写 5–600 秒').toggle(!valid);
    }
}

async function confirmPresetSwitch(nextPreset) {
    const current = activeApiPreset();
    if (!current || !apiInputsDirty()) return 'switch';
    const choice = await customDialog.choose({
        title: '当前预设有未保存改动',
        body: `要如何切换到「${nextPreset.name}」？`,
        choices: [
            { value: 'save', label: '保存并切换', primary: true },
            { value: 'switch', label: '直接切换' },
            { value: 'cancel', label: '取消' },
        ],
    });
    if (choice === 'save') {
        const currentCfg = readApiInputs();
        if (!apiInputsSaveable(currentCfg)) { showPresetHint('请求超时必须填写 5–600 秒，未保存预设'); return 'cancel'; }
        upsertApiPreset(current.name, currentCfg, current.id);
    }
    return choice || 'cancel';
}

function bindApiPresetEvents() {
    // 点假框 → 就地展开/收起内联预设列表（在流内，非原生弹窗）
    $in('#sp-preset-box').on('click', function (e) {
        e.preventDefault();
        $in('#sp-preset-list').slideToggle(120);
        $(this).toggleClass('sp-preset-box-open');
    });
    // 选某预设 → 填入输入框并立即应用，收起列表
    $in('#sp-preset-list').on('click', '.sp-preset-item', async function () {
        const id = $(this).attr('data-id');
        const p = loadApiPresets().find(x => x.id === id);
        if (!p || p.id === (getSettings().apiPresetActiveId || '')) return;
        const decision = await confirmPresetSwitch(p);
        if (decision === 'cancel') return;
        getSettings().apiPresetActiveId = id;
        $in('#sp-preset-list').slideUp(120);
        $in('#sp-preset-box').removeClass('sp-preset-box-open');
        if (!p) return;
        fillApiInputs(p);
        saveCfg(readApiInputs());
        renderApiPresetList();
        syncPresetState();
        showPresetHint(`已填入并应用「${p.name}」`);
    });

    // 编辑一条预设（内联，无弹窗）：点 ✎ 只改名字，不选择预设，也不覆盖当前 API 草稿。
    const commitPresetEdit = ($row) => {
        const $inp = $row.find('.sp-preset-rename-input');
        if (!$inp.length) return;
        const id = $row.attr('data-id');
        const p = loadApiPresets().find(x => x.id === id);
        const name = $inp.val().trim() || (p ? p.name : '');
        renameApiPreset(id, name);
        renderApiPresetList();       // 回到按钮态（名字/模型已更新）
        renderUtilityPresetList();   // 机械预设列表同名同步
        showPresetHint(`已改名为「${name}」`);
    };
    $in('#sp-preset-list').on('click', '.sp-preset-rename', function (e) {
        e.preventDefault(); e.stopPropagation();
        const id = $(this).attr('data-id');
        const p = loadApiPresets().find(x => x.id === id);
        if (!p) return;
        const $row = $(this).closest('.sp-preset-item-row');
        $row.addClass('sp-preset-item-row-edit').html(
            `<input type="text" class="sp-input sp-preset-rename-input" value="${escapeAttr(p.name)}" maxlength="40" spellcheck="false">` +
            `<button type="button" class="sp-preset-rename-ok" title="保存预设名称"><i class="fa-solid fa-check"></i></button>`
        );
        $row.find('.sp-preset-rename-input').trigger('focus').trigger('select');
        showPresetHint(`编辑「${p.name}」名称；当前 API 输入不会改变`);
    });
    $in('#sp-preset-list').on('click', '.sp-preset-rename-ok', function (e) {
        e.preventDefault(); e.stopPropagation();
        commitPresetEdit($(this).closest('.sp-preset-item-row'));
    });
    $in('#sp-preset-list').on('keydown', '.sp-preset-rename-input', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitPresetEdit($(this).closest('.sp-preset-item-row')); }
        else if (e.key === 'Escape') { e.preventDefault(); renderApiPresetList(); }
    });

    // ＋新增 → 把当前输入框这套存成新预设，名字先按 URL 域名自动生成（同名自动加序号）；
    // 存好后可在列表里点 ✎ 就地改名。覆盖内容仍是「删掉重存」。零弹窗。
    $in('#sp-preset-save').on('click', function () {
        saveCurrentAsPreset();
    });

    $in('#sp-preset-update').on('click', function () {
        const p = activeApiPreset();
        const cur = readApiInputs();
        if (p) {
            if (!apiInputsSaveable(cur)) { showPresetHint('请求超时必须填写 5–600 秒，未更新预设'); return; }
            upsertApiPreset(p.name, cur, p.id);
            renderApiPresetList();
            renderUtilityPresetList();
            showPresetHint(`已更新预设「${p.name}」`);
        } else {
            saveCurrentAsPreset();
        }
    });

    // 删除当前选中预设 —— 内联二次确认（图标变红勾，再点才删；3 秒无操作复原），零弹窗
    let delArmed = false, delTimer = null;
    $in('#sp-preset-del').on('click', function () {
        const id = getSettings().apiPresetActiveId;
        if (!id) return;
        const $btn = $(this), $i = $btn.find('i');
        if (!delArmed) {
            delArmed = true;
            $i.attr('class', 'fa-solid fa-check');
            $btn.css('color', '#e06c6c').attr('title', '再点一次确认删除');
            showPresetHint('再点一次垃圾桶确认删除');
            delTimer = setTimeout(() => {
                delArmed = false; $i.attr('class', 'fa-solid fa-trash');
                $btn.css('color', '').attr('title', '删除当前选中的预设');
            }, 3000);
            return;
        }
        clearTimeout(delTimer); delArmed = false;
        $i.attr('class', 'fa-solid fa-trash'); $btn.css('color', '').attr('title', '删除当前选中的预设');
        const p = loadApiPresets().find(x => x.id === id);
        if (getSettings().utilityPresetId === id) getSettings().utilityPresetId = '';   // 删掉的正是机械预设 → 退回不分流
        deleteApiPreset(id);
        renderApiPresetList();
        renderUtilityPresetList();
        showPresetHint(p ? `已删除「${p.name}」` : '已删除');
    });

    // ── 机械任务预设：点假框展开候选（含「跟随主 API」项）；选一项即时生效落盘，无需保存 ──
    $in('#sp-util-preset-box').on('click', function (e) {
        e.preventDefault();
        $in('#sp-util-preset-list').slideToggle(120);
        $(this).toggleClass('sp-preset-box-open');
    });
    $in('#sp-util-preset-list').on('click', '.sp-preset-item', function () {
        const id = $(this).attr('data-id') || '';   // 空 = 跟随主 API（不分流）
        getSettings().utilityPresetId = id;
        saveSettingsDebounced();
        renderUtilityPresetList();
        $in('#sp-util-preset-list').slideUp(120);
        $in('#sp-util-preset-box').removeClass('sp-preset-box-open');
    });
}

// 机械任务预设：内联候选列表 =「跟随主 API（不分流）」+ 每个已存预设。选中项高亮。
function renderUtilityPresetList() {
    const $list = $in('#sp-util-preset-list');
    if (!$list.length) return;
    const list = loadApiPresets();
    const activeId = getSettings().utilityPresetId || '';
    const follow = `<button type="button" class="sp-preset-item${!activeId ? ' sp-preset-item-active' : ''}" data-id="">跟随主 API（不分流）</button>`;
    const items = list.map(p => `<button type="button" class="sp-preset-item${p.id === activeId ? ' sp-preset-item-active' : ''}" data-id="${escapeAttr(p.id)}">${escapeHtml(p.name)}</button>`).join('');
    $list.html(follow + items);
    syncUtilityPresetLabel();
}

// 「假框」显示当前机械预设名；id 指向的预设不存在（被删）→ 清 id 并回显「跟随主 API」
function syncUtilityPresetLabel() {
    const $lb = $in('#sp-util-preset-label');
    if (!$lb.length) return;
    const id = getSettings().utilityPresetId || '';
    const p = id ? loadApiPresets().find(x => x.id === id) : null;
    if (id && !p) { getSettings().utilityPresetId = ''; }   // 悬空 id 自愈
    $lb.text(p ? `机械任务 → ${p.name}` : '跟随主 API（不分流）');
}

// 按 URL 域名生成预设名；无 URL 用「预设」。撞已有名自动加 -2/-3…
function autoPresetName(url) {
    let base = '';
    try { base = url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch { base = ''; }
    if (!base) base = '预设';
    const names = new Set(loadApiPresets().map(p => p.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) { const n = `${base}-${i}`; if (!names.has(n)) return n; }
}

function applyTheme(theme) {
    currentTheme = theme;
    const forced = (getSettings().themeMode || 'auto') !== 'auto';
    const $modal = $(`#${MODAL_ID}`);
    const $fab   = $(`#${FAB_ID} .sp-fab-btn`);
    const $toast = $('#sp-toast-wrap');   // 同 $modal 走一套：让 toast 的 --sp-*-legacy 底板令牌随主题就位
    $modal.removeClass('sp-night sp-day sp-forced-day sp-forced-night').addClass(`sp-${theme}`);
    $fab.removeClass('sp-night sp-day sp-forced-day sp-forced-night').addClass(`sp-${theme}`);
    $toast.removeClass('sp-night sp-day sp-forced-day sp-forced-night').addClass(`sp-${theme}`);
    if (forced) {
        $modal.addClass(`sp-forced-${theme}`);
        $fab.addClass(`sp-forced-${theme}`);
        $toast.addClass(`sp-forced-${theme}`);
    }
    // Shadow 内 wrapper 同步主题类：.sp-night/.sp-day 色板与 .sp-forced-* 强制覆盖在
    // shadow 内靠 wrapper 匹配（host 的类不穿边界），不换则 `--sp-*-legacy` 回退丢失、
    // `.sp-night .sp-xxx` 类后代选择器失配。
    const wrapper = _spShadow?.querySelector('.sp-root');
    if (wrapper) {
        wrapper.classList.remove('sp-night', 'sp-day', 'sp-forced-day', 'sp-forced-night');
        wrapper.classList.add(`sp-${theme}`);
        if (forced) wrapper.classList.add(`sp-forced-${theme}`);
    }
    syncVectorGlyphTheme(document, theme, forced);
    coordinateRuntime?.feature?.onThemeChanged?.(theme);
}

// ─── Theme mode toggle (day / night / auto) ─────────────────────────────────
// Auto follows ST theme; day/night force a fallback so users on transparent
// ST themes still get a readable panel.
function themeToggleIcon() {
    const mode = getSettings().themeMode || 'auto';
    if (mode === 'day')   return 'fa-sun';
    if (mode === 'night') return 'fa-moon';
    return 'fa-circle-half-stroke';   // auto
}

function themeToggleTitle() {
    const mode = getSettings().themeMode || 'auto';
    if (mode === 'day')   return '主题：日间（点击切换到夜间）';
    if (mode === 'night') return '主题：夜间（点击切换到跟随酒馆）';
    return '主题：跟随酒馆（点击切换到日间）';
}

function cycleThemeMode() {
    const cur  = getSettings().themeMode || 'auto';
    const next = cur === 'auto' ? 'day' : cur === 'day' ? 'night' : 'auto';
    getSettings().themeMode = next;
    saveSettingsDebounced();
    applyTheme(getEffectiveTheme());
    // Update this button's icon + tooltip in place
    const $btn = $in('.sp-theme-toggle-btn');
    $btn.attr('title', themeToggleTitle());
    $btn.find('i').attr('class', `fa-solid ${themeToggleIcon()}`);
}

// ─── Drag (desktop only) ──────────────────────────────────────────────────────

function onDragStart(e) {
    // Skip on mobile — sheet is near-fullscreen and shouldn't move.
    if (isMobile()) return;
    // Only respond to left-click for mouse events. Right-click (and middle)
    // don't emit matching mouseup, which used to leave dragState set forever
    // and drag the sheet on every subsequent mousemove.
    if (e.type === 'mousedown' && e.button !== 0) return;
    // Ignore drags starting on interactive elements inside the header.
    if ($(e.target).closest('.sp-icon-btn, .sp-sub-btn, button, a, input, textarea').length) return;
    e.preventDefault();
    const sheet = inEl('.sp-sheet');

    // Snap from CSS-transform centering to explicit px coords for drag math.
    // MUST cancel the CSS animation first — animation fill-mode has higher cascade
    // priority than inline styles, so transform:'none' alone won't override it.
    if (sheet.style.transform !== 'none') {
        sheet.style.animation = 'none';
        const snap = sheet.getBoundingClientRect();
        sheet.style.transform = 'none';
        sheet.style.right     = 'auto';
        sheet.style.left      = snap.left + 'px';
        sheet.style.top       = snap.top  + 'px';
    }

    const cx   = e.touches ? e.touches[0].clientX : e.clientX;
    const cy   = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = sheet.getBoundingClientRect();
    dragState  = { startX: cx, startY: cy, origLeft: rect.left, origTop: rect.top };

    $(document).on('mousemove.spdrag', onDragMove).on('mouseup.spdrag', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend',  onDragEnd);
    document.body.style.cursor = 'grabbing';
}

function onDragMove(e) {
    if (!dragState) return;
    // Self-heal: if the mouse left the window (or alt-tabbed away) mid-drag,
    // the matching mouseup never reaches document and dragState gets stuck
    // forever — every future mousemove keeps dragging the sheet until reload.
    // e.buttons===0 means no mouse button is currently held, regardless of
    // whether we ever received the mouseup event for it.
    if (e.buttons === 0 && !e.touches) { onDragEnd(); return; }
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const sheet = inEl('.sp-sheet');
    const left = Math.max(0, Math.min(dragState.origLeft + cx - dragState.startX, window.innerWidth  - sheet.offsetWidth));
    const top  = Math.max(0, Math.min(dragState.origTop  + cy - dragState.startY, window.innerHeight - 60));
    sheet.style.left  = left + 'px';
    sheet.style.top   = top  + 'px';
    sheet.style.right = 'auto';
}

function onDragEnd() {
    if (!dragState) return;
    const sheet = inEl('.sp-sheet');
    const rect  = sheet.getBoundingClientRect();
    if (!isMobile()) {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    }
    dragState = null;
    $(document).off('mousemove.spdrag mouseup.spdrag');
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend',  onDragEnd);
    document.body.style.cursor = '';
}

// ─── Resize ───────────────────────────────────────────────────────────────────

function onResizeStart(e) {
    // Resize is desktop-only. On mobile the sheet is near-fullscreen and the
    // handle is hidden; any resize event on mobile is stray (e.g. bubbling
    // from the outline divider) — ignore it so the sheet doesn't shrink.
    if (isMobile()) return;
    e.preventDefault();
    e.stopPropagation();
    const sheet = inEl('.sp-sheet');

    // Desktop sheet uses `right: 20px` as its horizontal anchor. If we grow
    // width while `right` is fixed, the LEFT edge moves outward instead of
    // the right edge. Snap to left-anchored inline coords before resizing.
    if (!sheet.style.left || sheet.style.right !== 'auto') {
        const snap = sheet.getBoundingClientRect();
        sheet.style.left  = snap.left + 'px';
        sheet.style.top   = snap.top  + 'px';
        sheet.style.right = 'auto';
    }

    sheet.style.willChange = 'width, height';
    document.body.style.userSelect = 'none';
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    resizeState = {
        startX: cx, startY: cy,
        origW : sheet.offsetWidth, origH : sheet.offsetHeight,
    };
    $(document).on('mousemove.spresize', onResizeMove).on('mouseup.spresize', onResizeEnd);
    document.addEventListener('touchmove', onResizeMove, { passive: false });
    document.addEventListener('touchend',  onResizeEnd);
}

function onResizeMove(e) {
    if (!resizeState) return;
    e.preventDefault();
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    const cx = touch ? touch.clientX : e.clientX;
    const cy = touch ? touch.clientY : e.clientY;
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        const sheet = inEl('.sp-sheet');
        const mobile = isMobile();
        // On mobile, we ALSO override max-width (CSS media query caps it at 340px);
        // without this, inline width can't exceed the cap.
        const maxW = mobile
            ? Math.min(window.innerWidth - 10, 500)
            : window.innerWidth - 10;
        const w = Math.max(280, Math.min(maxW, resizeState.origW + cx - resizeState.startX));
        const h = Math.max(300, Math.min(window.innerHeight - 10, resizeState.origH + cy - resizeState.startY));
        sheet.style.width     = w + 'px';
        sheet.style.height    = h + 'px';
        sheet.style.maxHeight = h + 'px';
        if (mobile) {
            sheet.style.maxWidth = w + 'px';
            // Recenter after resize: keep translateX(-50%) if still set, else pin left
            if (!sheet.style.left || sheet.style.left === '50%') {
                sheet.style.left = '50%';
            }
        }
    });
}

function onResizeEnd() {
    if (!resizeState) return;
    if (resizeRAF) { cancelAnimationFrame(resizeRAF); resizeRAF = null; }
    const sheet = inEl('.sp-sheet');
    sheet.style.willChange = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: sheet.offsetWidth, height: sheet.offsetHeight }));
    resizeState = null;
    $(document).off('mousemove.spresize mouseup.spresize');
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend',  onResizeEnd);
}

function restoreOutlineChatHeight() {
    const h = parseInt(localStorage.getItem('sp-outline-chat-h')) || 210;
    const el = inEl('#sp-outline-chat');
    if (el) el.style.height = h + 'px';
}

function positionPanel() {
    const sheet = inEl('.sp-sheet');
    if (!sheet) return;
    if (isMobile()) {
        sheet.style.left      = '';
        sheet.style.top       = '';
        sheet.style.right     = '';
        sheet.style.height    = '';
        sheet.style.transform = '';
        syncMobileViewport();
        bindViewportSync();
        return;
    }
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { /* 位置数据损坏则忽略 */ }
    if (pos) {
        sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
        sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
        sheet.style.right = 'auto';
    }
}

function bindViewportSync() {
    if (viewportSyncBound) return;
    viewportSyncBound = true;
    const onViewportChange = () => syncMobileViewport();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChange);
        window.visualViewport.addEventListener('scroll', onViewportChange);
    }
}

function syncMobileViewport() {
    if (!isMobile()) return;
    const root  = document.getElementById(MODAL_ID);
    const sheet = inEl('.sp-sheet');   // .sp-sheet 在 shadow 内：document.querySelector('#sp-modal-root .sp-sheet') 跨不过边界→null→整个移动端视口同步静默失效；用 inEl 查 shadow root
    if (!root || !sheet || root.style.display === 'none') return;

    // Read safe-area insets from CSS env() via a probe element.
    // Fallback to 0 when unsupported (older Android browsers).
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;top:env(safe-area-inset-top,0px);bottom:env(safe-area-inset-bottom,0px)';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const safeTop = parseFloat(cs.top) || 0;
    const safeBot = parseFloat(cs.bottom) || 0;
    document.body.removeChild(probe);

    const vv = window.visualViewport;
    const vh = Math.max(320, Math.round((vv?.height || window.innerHeight)));
    // iOS 软键盘不缩小 layout viewport，而是把可视视口整体上移，visualViewport.offsetTop
    // 变正；安卓则是直接缩小 layout（offsetTop≈0，靠 vh 变小自适应）。sheet 是
    // position:fixed（相对 layout viewport 定位），若 top 不叠加 offsetTop，键盘一弹
    // sheet 就停在 layout 顶部、被推到可视区上方看不见——正是 iOS 用户反馈的
    // "整个界面被挤出页面、找不到输入框"。叠加 offsetTop 让 sheet 跟随可视视口下移到
    // 键盘上方；安卓 offsetTop≈0 完全不受影响，属 iOS 定向修复。
    const offsetTop = vv ? Math.max(0, vv.offsetTop) : 0;
    const marginTop = 20 + safeTop;      // sheet 顶到可视视口顶的留白
    const bottomGap = 20 + safeBot;
    const top  = offsetTop + marginTop;  // fixed 绝对值 = 可视视口位移 + 留白
    const maxH = Math.max(260, vh - marginTop - bottomGap);  // 高度只按可视视口算，不含 offsetTop

    const nextTop = `${top}px`;
    const nextHeight = `${maxH}px`;
    if (sheet.style.top === nextTop && sheet.style.height === nextHeight && sheet.style.maxHeight === nextHeight) return;

    const settingsBody = settingsOpen ? inEl('.sp-settings-body') : null;
    const savedScrollTop = settingsBody?.scrollTop;
    sheet.style.top = nextTop;
    sheet.style.height = nextHeight;
    sheet.style.maxHeight = nextHeight;

    if (!settingsBody) return;
    if (settingsBody.scrollTop !== savedScrollTop) settingsBody.scrollTop = savedScrollTop;

    const focused = _spShadow?.activeElement;
    const tagName = focused?.tagName;
    if (!focused || !settingsBody.contains(focused)
        || (tagName !== 'INPUT' && tagName !== 'TEXTAREA' && tagName !== 'SELECT' && !focused.isContentEditable)) return;
    const bodyRect = settingsBody.getBoundingClientRect();
    const focusRect = focused.getBoundingClientRect();
    const above = focusRect.top < bodyRect.top;
    const below = focusRect.bottom > bodyRect.bottom;
    if (above && below) return;  // 超高输入框已横跨可见区，保持用户当前阅读位置
    if (below) settingsBody.scrollTop += focusRect.bottom - bodyRect.bottom;
    else if (above) settingsBody.scrollTop -= bodyRect.top - focusRect.top;
}

// ─── Toast (top) ──────────────────────────────────────────────────────────────
// 批次4决议：toast 暂留 light DOM，不迁 shadow。
// 理由：sp-toast 类 + text-shadow 清零已免疫大部分 ST 污染；有 zmer-toast-theme-loader
// 插件接管分支（见 showToast），动了易踩第三方；toast 是短命元素，受污染面最小。
// TODO(批次5+)：若用户反馈污染再迁——injectToastContainer 的
// documentElement.insertAdjacentHTML → _spShadow，showToast 的 $('#sp-toast-wrap') → $in，
// 并复核 zmer 插件分支。

function injectToastContainer() {
    // 带上主题类：#sp-toast-wrap 挂在 <html> 下、在 .sp-root 之外，拿不到 .sp-night/.sp-day
    // 作用域里的 --sp-*-legacy 令牌。双层背景的不透明底板 var(--sp-surface-legacy) 会落空→透底。
    // 加 sp-${theme} 把 legacy 令牌带进作用域（applyTheme 会随主题切换更新）。
    if (!$('#sp-toast-wrap').length) document.documentElement.insertAdjacentHTML('beforeend', `<div id="sp-toast-wrap" class="sp-${currentTheme}"></div>`);
}

function showToast(msg, onClick, isError = false) {
    // 失败 toast 停留更久：失败需要用户处置（查 API/网络/重试），4 秒对不盯屏的用户太短、易错过；
    // 成功仍 4 秒。（用户反馈：生成失败常没留意到，正是因为告警一闪而过。）
    const holdMs = isError ? 10000 : 4000;
    // 若装了「酒馆提示框美化 (zmer-toast-theme-loader)」插件，改走原生 toastr，
    // 让它的 MutationObserver 捕获 #toast-container 里的 toast 并统一美化风格。
    // 探测其 init 时无条件挂上的全局清理钩子——与任何 UI 开关无关，最稳；
    // 探测失败（未装/改版/换名）则无害回退到下方自绘 toast。
    const tr = globalThis.toastr;
    if (globalThis.__zmerUniversalToastThemeCleanup && tr) {
        // 视觉参数交给美化插件统一；但失败破例覆盖 timeOut，保证告警停留够久（可靠性 > 风格统一）。
        const opts = onClick ? { onclick: onClick } : {};
        if (isError) { opts.timeOut = holdMs; opts.extendedTimeOut = holdMs; }
        (isError ? tr.error : tr.success)(msg, '', opts);
        return;
    }
    const $t = $(`<div class="sp-toast${isError ? ' sp-toast-error' : ''}">
        <i class="fa-solid ${isError ? 'fa-circle-exclamation' : 'fa-calendar-check'}"></i>
        <span>${escapeHtml(msg)}</span>
    </div>`);
    $('#sp-toast-wrap').append($t);
    requestAnimationFrame(() => $t.addClass('sp-toast-show'));
    if (onClick) $t.css('cursor', 'pointer').on('click', () => { onClick(); $t.remove(); });
    else if (isError) $t.css('cursor', 'pointer').on('click', () => { $t.removeClass('sp-toast-show'); setTimeout(() => $t.remove(), 350); });   // 失败 toast 停留久，允许点掉提前消失，免堆叠挡视线
    setTimeout(() => { $t.removeClass('sp-toast-show'); setTimeout(() => $t.remove(), 350); }, holdMs);
}

// 点行内 actions 已迁入 business/point/actions.js；这里仅保留薄事件转发。
const triggerTogglePointPin = (...args) => pointActions.togglePin(...args);
const triggerDeletePointEvent = (...args) => pointActions.deleteEvent(...args);

// 聊天输入框随内容自增高：先归零再按 scrollHeight 撑，CSS 用 max-height 封顶后转滚动条。
// 清空发送后也调一次即可缩回单行。
