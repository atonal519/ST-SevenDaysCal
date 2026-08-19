import { getContext, extension_settings } from '../../../extensions.js';
import { selected_world_info, world_info } from '../../../world-info.js';
import { equalsIgnoreCaseAndAccents, getCharaFilename } from '../../../utils.js';
import { eventSource, event_types, substituteParams, saveSettingsDebounced, saveSettings as stSaveSettings } from '../../../../script.js';
import {
    buildCreativeChatSystemPrompt,
    buildSpaceChatSystemPrompt,
    getCreativeChatPlaceholder,
    getSpaceChatPlaceholder,
    buildTheaterDraftKey,
} from './state.js';
import * as memory from './memory.js';
import * as theater from './theater.js';
import * as anchor from './anchor.js';
import * as store from './store.js';
import { bindStoreViewFallback, keyDesc, readStore, writeStore, removeStore } from './store.js';
import * as ledger from './ledger.js';
import * as snapshot from './snapshot.js';
import { createDialogManager } from './modal.js';
import { createAutomationGate } from './automation-gate.js';
import { createDateCoordinator } from './date-coordinator.js';
import {
    buildTravelStoryPrompt,
    createTimeTravelController,
    didStepComplete,
    snapshotLastAssistant,
    removeTimeTravelBlocks,
    sameMonthDay,
} from './time-travel.js';
import { escapeHtml, escapeAttr, autoGrowTextarea, cleanText } from './utils/dom.js';
import { _cnToNumber, _CN_MONTH_ALIAS, extractDayFromTime } from './utils/cn-date.js';
import { weatherGlyph, weatherChipHtml, fmtAnchorTs, maskKey } from './utils/format.js';
import { getSettings, parseExcludeParams, loadCfg, loadUtilityCfg, saveCfg, loadApiPresets, genPresetId, upsertApiPreset, deleteApiPreset, renameApiPreset, fabEnabled, pluginEnabled, injectEnabled, getLinesInterval, saveLinesInterval, getLinesMode, saveLinesMode } from './runtime/settings.js';
import { postChatCompletion, callCustomApi, callMemoryApi, callTheaterApi, bindApiClient, GEN_TEMPERATURE } from './api/client.js';
import { normalizeApiUrl } from './api/sse.js';
import { axisState } from './business/axis/state.js';
import {
    ALM_TYPES,
    almId,
    getAlmanacKey,
    almClampInt,
    normalizeAlmItem,
    loadAlmanac,
    saveAlmanacItems,
    almTypeMeta,
    almDateLabel,
    monthDayFromDayKey,
    almValidMonthDay,
    ALM_CHAT_SCAN_LIMIT,
    almDayOfYear,
    ALM_WEEKDAYS,
    parseWeekdayToken,
    _WEEKDAY_ADJ_RE,
    weekdayAdjacent,
    calRealWeekdayRef,
    almMonthDayFromDoy,
    almEndMonthDay,
    almItemCoversDoy,
    getCalDescInjectText,
    almMapType,
    parseAlmanacWidget,
    parseEraWidget,
    almDedupKey,
    mergeAlmanac,
    loadCalDesc,
    getCalDescKey,
    normalizeCalDesc,
    saveCalDesc,
    ALM_DAYS_IN_MONTH,
    DEFAULT_CAL,
    _cal,
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
    renameCalendarTemplate,
    calendarTemplateBindings,
    sortCalendarTemplatesForCurrent,
    almDateFromChat,
} from './business/axis/data.js';
import {
    calendarSummary,
    calendarConflicts,
} from './business/axis/ui.js';
// 轴锚点/周几/距今/将至排序已抽出到 business/axis/anchor.js；index.js 内部跨域读取器经 bindAxisAnchor 注入。
import {
    bindAxisAnchor,
    almTodayAnchor, almDaysUntil, almWeekdayRef, almWeekdayFor, sortAlmanacUpcoming,
} from './business/axis/anchor.js';
// 历注入文本构造（纯函数，仅依赖 data.js/anchor.js）已抽出到 business/axis/inject.js。
import { getAlmanacInjectText } from './business/axis/inject.js';
import { createAxisPanel } from './business/axis/panel.js';
import { renderAxisToolbar } from './business/axis/toolbar.js';
import { renderAxisUpcoming } from './business/axis/upcoming.js';
import { renderAxisCalendar } from './business/axis/calendar.js';
import { openAxisEditor, closeAxisEditor, setAxisSheet, selectAxisDay, navigateAxisMonth } from './business/axis/editor.js';
import { createCalendarManager } from './business/axis/manager.js';

// Must be initialized before the top-level bindAxisAnchor() wiring below.
// Keeping this as a const preserves the shared terminal-stage semantics while
// avoiding a temporal-dead-zone read during module evaluation.
const TERMINAL_STAGES = new Set(['已消散', '已完成', '已失败']);

// ─── 点（日程）域：状态 / 解析 / 提示词 / 渲染 ────────────────────────────────
// point 业务域已从本文件抽出到 business/point/*，此处仅按需导入（机械迁移，不改行为）。
import { pointState } from './business/point/state.js';
import { parseCalendar, buildPointInjectText, numberedPointList, mergePinnedPoints, forceStartDate, serializeCalendar } from './business/point/parse.js';
import { buildPrompt } from './business/point/prompt.js';
import { bindPointRender, renderSchedule, scheduleDayCtx, scheduleDayLabel, TYPE_META } from './business/point/render.js';
// ledger 检索前置选择器（纯逻辑三件套）已抽出到 business/ledger/select.js；到期/距今口径经 bindLedgerSelect 注入。
import { bindLedgerSelect, scoreLedgerEntry, isLedgerSalient, selectLedgerForInject } from './business/ledger/select.js';
import { mergeRecallTags, filterRerollItems, pickWithoutPrevious, shouldRunPendingPointFollowup, nonEmptyTemplates, snapshotTheaterSource } from './runtime/refactor-adapters.js';
// ledger 暗账页渲染/编辑/批量（Option B）已抽出到 business/ledger/render.js；index.js 宿主经 bindLedgerRender 注入。
import {
    bindLedgerRender,
    batchReset, resetLedgerRenderState,
    getBatchScope, setBatchScope, getBatchSelected,
    isLedgerArchiveOpen, toggleLedgerArchiveOpen, getLedgerEditor,
    ledgerTypeClass, fmtLedgerAnchorDate, ledgerRowHtml,
    openLedgerEditor, closeLedgerEditor, ledgerMdToInput, renderLedgerEditor,
    ledgerReadMd, saveLedgerEditor,
    batchBarHtml, BATCH_SCOPES, batchScopeIds, execBatch, renderLedgerSheet,
} from './business/ledger/render.js';

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

// 绑定 API 网络层所需的 UI/业务回调（避免 api/client.js 反向依赖 index.js 造成循环引用）。
bindApiClient({
    setFabBusy,
    setLastDebugPayload: (v) => { lastDebugPayload = v; },
    buildMessages,
});

// 点渲染回调注入：render.js 的 scheduleDayCtx/scheduleDayLabel/renderEvent 需访问本文件的
// almTodayAnchor/almWeekdayRef/almWeekdayFor/makeInjectBtn，经 bindPointRender 注入以避免反向依赖（循环引用）。
bindPointRender({ almTodayAnchor, almWeekdayRef, almWeekdayFor, makeInjectBtn });

// ledger 选择器注入：select.js 的打分/门槛依赖到期/距今口径 ledgerDueInfo/ledgerDaysSince
// （二者仍滞留本文件、且另经历法助手触达），经 bindLedgerSelect 注入以免反向依赖循环引用。
bindLedgerSelect({ ledgerDaysSince, ledgerDueInfo });

// 轴锚点注入：anchor.js 的 almTodayAnchor/almWeekdayRef 需读本文件内的跨域来源
// （日期锚点/角色键/线缓存键+解析/点缓存键/终态集），经 bindAxisAnchor 注入以避免反向依赖循环引用。
bindAxisAnchor({
    getDateAnchor,
    charStableKey,
    getLinesCacheKey,
    parseLines,
    TERMINAL_STAGES,
    getCacheKey,
});

// ledger 暗账页渲染注入：render.js 的行/编辑/批量需本文件宿主的 shadow 查询/提示/确认/主楼同步/
// 面板重绘/标注间隔与忙碌态。isCapturingLedger/isJudgingLedger 是实时可变 let，传 getter 以读当前值。
bindLedgerRender({
    $in,
    showToast,
    splitCnList,
    spConfirm,
    syncLatestAlmanacBlock,
    renderAlmanacPanel: (...args) => renderAlmanacPanel(...args),
    getLedgerCaptureInterval,
    isCapturingLedger: () => isCapturingLedger,
    isJudgingLedger: () => isJudgingLedger,
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
const renderAlmanacUpcoming = () => renderAxisUpcoming({
    renderAlmanacEmpty,
    batchBarHtml,
    almRowHtml,
});
const renderAlmanacCalendar = () => renderAxisCalendar({ almRowHtml });
const axisCalendarManager = createCalendarManager({
    renderLegacy: (...args) => legacyRenderCalendarManager(...args),
    refreshLegacy: (...args) => legacyRefreshCalendarManager(...args),
});
const renderCalendarManager = axisCalendarManager.renderCalendarManager;
const refreshCalendarManager = axisCalendarManager.refreshCalendarManager;

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
    renderAlmanacCalendar,
    renderAlmanacUpcoming,
    almToolbarHtml,
    almTodayBarHtml,
    storyClockBarHtml,
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
    const abort = () => internalController.abort();
    if (externalSignal.aborted) internalController.abort();
    else externalSignal.addEventListener('abort', abort, { once: true });
    return () => externalSignal.removeEventListener('abort', abort);
}
const timeTravel = createTimeTravelController({
    getChatId: () => getContext().chatId,
    getChat: () => getContext().chat,
    getCalendar: () => loadCalDesc(),
    resolveDestinationDate: async ({ chatId, messageId, selectedTargetDate, signal }) => {
        const cal = loadCalDesc();
        const target = almValidMonthDay(selectedTargetDate, cal);
        if (!target) throw new Error('无法读取时光旅行选择的目标日期');
        const chat = getContext().chat || [];
        const floor = chat[Number(messageId)];
        const clock = parseStoryClock(floor?.mes || '');
        const clockDate = parseJudgedDate(clock.end) || parseJudgedDate(clock.start);
        const key = buildDateRenderKey(messageId);
        if (clockDate) {
            const applied = applyDetectedDate(charStableKey(getContext()), clockDate);
            dateCoordinator.recordResult(key, { ...applied, date: clockDate });
            return clockDate;
        }
        if (getSettings().almanacAutoDetect === false) {
            const applied = applyDetectedDate(charStableKey(getContext()), target);
            dateCoordinator.recordResult(key, { ...applied, date: target });
            return target;
        }
        const result = await dateCoordinator.runOnce(key, () => runJudgeDateStep({ messageId, signal }));
        if (signal?.aborted || result?.status === 'cancelled') throw Object.assign(new Error('日期确认已取消'), { name: 'AbortError' });
        const judged = almValidMonthDay(result?.date, cal);
        if (judged) return judged;
        const applied = applyDetectedDate(charStableKey(getContext()), target);
        dateCoordinator.recordResult(key, { ...applied, date: target });
        return target;
    },
    onStateChange: ({ state }) => {
        axisState.timeTravelState = state;
        if (axisState.almanacMode) renderAlmanacPanel();
    },
    onStepResult: ({ key, result, destinationDate }) => {
        if (!didStepComplete(result)) return;
        if (key === AUTOMATION_MODULES.LINES) { if (getLinesMode() !== 'manual') linesAiMsgCounter = 0; }
        if (key === AUTOMATION_MODULES.OUTLINE) outlineJudgeMsgCounter = 0;
        if (key === AUTOMATION_MODULES.LEDGER_CAPTURE) ledgerCaptureCounter = 0;
        if (key === AUTOMATION_MODULES.LEDGER_JUDGE) ledgerJudgeCounter = 0;
        if (key === AUTOMATION_MODULES.LINES && getLinesMode() === 'days') {
            const target = destinationDate;
            if (target?.month != null && target?.day != null) _lastDetectedDay = `${+target.month}-${+target.day}`;
        }
    },
    onSequenceEnd: ({ sessionId }) => releaseTimeTravelClaim(sessionId),
    steps: [
        { key: AUTOMATION_MODULES.LINES, canRun: () => getSettings().linesEnabled !== false, run: async ({ messageId, destinationDate, promptAddon, signal }) => (await runGenerateLines(false, { mesId: Number(messageId), forceReroll: true }, { targetDate: destinationDate, promptAddon, feedback: 'time-travel', signal }) || { status: 'updated' }) },
        { key: AUTOMATION_MODULES.OUTLINE, canRun: () => { const saved = readStore(getOutlineCacheKey()); return !!(saved?.raw && parseOutline(saved.raw).length && getOutlineCursor() >= 1); }, run: ({ promptAddon, signal }) => runRelocateOutlineCursor(promptAddon, signal) },
        { key: AUTOMATION_MODULES.POINT, canRun: () => !!readStore(getCacheKey(currentView, charViewName))?.raw, run: ({ destinationDate, promptAddon, signal }) => syncPointToToday(false, { targetDate: destinationDate, promptAddon, feedback: 'time-travel', signal, allowPendingFollowup: false }) },
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

function startTimeTravel(targetDate) {
    const sourceDate = almTodayAnchor();
    if (!targetDate || sameMonthDay(sourceDate, targetDate)) return false;
    const prompt = buildTravelStoryPrompt({ sourceDate, targetDate, calendar: loadCalDesc() });
    if (!injectToST(prompt)) return false;
    const started = timeTravel.begin({ chatId: getContext().chatId, sourceDate, selectedTargetDate: targetDate });
    return started;
}

function cancelTimeTravel() {
    const active = timeTravel.getState();
    timeTravel.clear();
    axisState._almSyncPending = false;
    // clear() 不触发 onSequenceEnd（controller 只在 handleRendered 收尾时发），闸/协调器须随取消显式释放，
    // 否则 token 滞留 → 后续正常自动化被误抑制（同 chatId+messageId 复活场景）或协调器内存滞留。
    clearAutomationClaims();
    dateCoordinator.clear();
    almanacJudgeAbort?.abort();
    outlineJudgeAbort?.abort();
    _autoRegenSchedAbort?.abort();
    ledgerCaptureAbort?.abort();
    ledgerJudgeAbort?.abort();
    if (active?.phase === 'waiting') {
        const input = $('#send_textarea');
        if (input.length) input.val(removeTimeTravelBlocks(String(input.val() || ''))).trigger('input');
    }
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


// 模块介绍：内容标题旁「?」点开的小气泡文案。键对应侧栏 data-view。每段控制在 200 字内、面向使用者。
// 想改文字直接改这里即可（纯展示，不入库、不注入 AI）。
// 小百科·图标图例：模块介绍气泡内容。lede（这模块干嘛的·一句话）+ 若干「真 FontAwesome 图标 + 名称 + 一句话」，
// 图标与界面所见一致，用户对号入座即知每个钮啥意思。渲染端用 .html() 注入（内容全为作者手写、无用户输入，无注入面）。精简为主。
const _iLede = t => `<p class="sp-intro-lede">${t}</p>`;
const _iSub  = t => `<div class="sp-intro-sub">${t}</div>`;
const _iKey  = (icon, name, desc) => `<div class="sp-intro-key"><i class="fa-solid ${icon}"></i><b>${name}</b><span>${desc}</span></div>`;

const MODULE_INTROS = {
    schedule:
        _iLede('「点」＝当前视角（我／TA）的近期待办与状态卡片：读剧情自动推断某人此刻在做什么、心情、所在地。只读展示，不注入正文。') +
        _iKey('fa-rotate-right', '生成／刷新', '按最新剧情重算卡片') +
        _iKey('fa-lock',         '锁定',       '这条重算时保留不动') +
        _iKey('fa-thumbtack',    '固定 TA',    '把某人钉进 TA▾ 抽屉常驻') +
        _iKey('fa-xmark',        '删除',       '移除这张卡'),
    almanac:
        _iLede('「轴」＝这个世界的历法＋节日日历，并内嵌「刻度（时间账）」。历法／节日反哺点／线／面的生成，让故事与世界历法自洽。') +
        _iSub('节日 · 历法') +
        _iKey('fa-wand-magic-sparkles', '生成节日', 'AI 按世界观铺满一整年') +
        _iKey('fa-heart-circle-plus', '补录纪念日', '只增补新里程碑，不重铺、不动现有日历') +
        _iKey('fa-plus',          '添加',     '手动录节日／生日／纪念日') +
        _iKey('fa-calendar-days', '历法管理', '定义月份、天数、纪年名') +
        _iKey('fa-lock',          '锁定',     '重新生成时保留此条') +
        _iKey('fa-pen',           '编辑',     '改名／改日期／改说明') +
        _iSub('刻度 · 时间账') +
        _iLede('从正文自动打捞「此时·此事·此状态」，按天数推算现状、悄悄提醒主楼（你不用手算）。分<b>持续状态／约定待办／周期</b>三类；楼内「标注池」顶部［标注］手动捞新条、［更新］按时间刷现状。每条：') +
        _iKey('fa-lock',        '锁定',     'AI 判定车不再改动此条') +
        _iKey('fa-bell',        '暂停埋入', '暂不注入主楼、但仍在账上跟进（再点恢复）') +
        _iKey('fa-check',       '了结',     '从活跃移除、归档（可捞回）') +
        _iKey('fa-pen',         '编辑',     '手动改现状／字段') +
        _iKey('fa-rotate-left', '捞回',     '归档区：把了结条拉回活跃') +
        _iKey('fa-trash',       '彻底删',   '归档区：不可恢复地删除'),
    lines:
        _iLede('「线」＝追踪剧情伏笔与暗线：那些已埋下、还没收束的悬念。随对话按你设的节奏推进，可隐形注入正文提醒 AI 别忘。') +
        _iKey('fa-rotate-right', '重新生成', '推翻重排全部线') +
        _iKey('fa-forward',      '推进',     '在已有线上继续往下推演') +
        _iKey('fa-lock',         '锁定',     '重点线不被冲掉') +
        _iKey('fa-xmark',        '删除',     '移除这条线'),
    outline:
        _iLede('「面」＝整段故事的大纲／节拍表：拆成若干节点、标出现在演到哪、下一步去哪。开注入后隐形引导 AI 顺大纲走。') +
        _iKey('fa-location-crosshairs', '狙击当前点', '手选剧情游标（再点取消）') +
        _iKey('fa-rotate-right',        '重新生成',   '按剧情重排节拍表'),
    space:
        _iLede('「间」＝局外创作顾问：跳出角色扮演，直接和 AI 聊剧情、设定、人物、世界观，聊出的结论还能<b>整理成卡片、一键落地</b>到点／线／轴／历法。这里的对话不进正式剧情、也不影响角色。') +
        _iKey('fa-paper-plane',    '发送',            '向创作顾问发问') +
        _iKey('fa-broom',          '清空',            '清掉这段局外对话') +
        _iKey('fa-plus',           '应用到点／线／轴',  '把顾问给的日程／事件线／节日卡一键写进对应模块') +
        _iKey('fa-calendar-check', '应用历法',         '把顾问拟的历法（月份／纪年）一键换上'),
    theater:
        _iLede('「棱」＝小剧场：基于当前故事背景写一段独立短篇／番外（「如果……会怎样」）。点「生成小剧场」出初稿，产出不进正式对话、纯当素材。') +
        _iKey('fa-shuffle', '随机', '从模板库抽一个直接生成') +
        _iKey('fa-expand',  '全屏浏览', '铺满视口、便于截图'),
    anchor:
        _iLede('「坐标」＝楼层收藏夹：把喜欢的楼层连同当时的样式快照一键收藏，按角色／聊天归档，日后随时回看名场面。') +
        _iKey('fa-star',   '收藏',     '楼层角色名旁点星收藏') +
        _iKey('fa-tags',   '标签管理', '给收藏分类') +
        _iKey('fa-expand', '全屏浏览', '便于截图') +
        _iKey('fa-trash',  '删除收藏', '移除这条收藏'),
};

let lastDebugPayload = null;


// 存储描述符 {kind, view, charName}：5 个 getXxxKey() 都返回它，喂给 store.readData/writeData/removeData。
// 无 chat 时返回 null（保留旧 getter「无 chat → null」语义，各处 if(!key) 守卫照旧生效）。

// view: 'user' | 'char'   charName: confirmed char name
function getCacheKey(view, charName) {
    return keyDesc('schedule', view, charName);
}

function loadCachedForCurrentChat(view, charName) {
    const saved = readStore(getCacheKey(view, charName));
    if (saved?.raw) return renderSchedule(saved.raw, saved.userName || '用户', view ?? currentView);
    return null;
}

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
let isGeneratingOutline = false;
let cachedOutline       = null;
let outlineChatHistory  = [];
let isOutlineChatting   = false;
let linesMode           = false;
let isGeneratingLines   = false;
let cachedLines         = null;
let linesAbortController = null;
let _linesSheet         = 'events';   // 线子视图：平行事件 | 冷知识；同 chat 保留，切 chat 复位
// 线·swipe 重算：楼层单调递增闸（区分真·新楼层 vs swipe/历史重渲染），及"待重算 swipe"标记。
let _lastSeenMaxMesId   = -1;
let _pendingSwipeGen    = null;   // { mesId }：swipe 触发新生成，等对应 RENDERED 后从楼层基线 B0 重算
let _floorTextSig       = {};     // mesId → 楼主文本签名；「同 mesId 内容变了」= 原楼重生成 = 重roll。版本无关，兜底「流式重roll的 CMR type=undefined、GENERATION_STARTED 不 latch」的实测坑
let _pendingReroll      = false;  // 🔄重生成握手
let _rerollExcludedAssistant = null;
let _stStreamUntil      = 0;      // 流式输出活跃截止时间戳：Date.now()<此值 = ST 正流式重写末楼 .mes_text，此间 observer 不塞楼内块（防频闪）。基于「最近一个流式 token 的时间」自动续期、到点自愈，绝不会像布尔闸那样卡死（ENDED 事件在 quiet 生成里不保证触发）
let isGeneratingDashed  = false;   // 虚线·冷知识生成中
let dashedAbortController = null;  // 虚线独立 abort，跟线互不干扰
let _dashedPanelError   = '';      // 冷知识页近端错误；切 chat / 下次生成时清空
let spaceMode           = false;
let spaceChatHistory    = [];
let isSpaceChatting     = false;
let spaceChatAbortController = null;
let linesAiMsgCounter   = 0;   // counts AI messages since last lines advancement
let outlineAbortController  = null;
let theaterMode          = false;
let isGeneratingTheater  = false;
let theaterAbortController = null;
let theaterCurrentPiece  = null;   // 当前渲染中的 piece（重生成/升永久用）
let _theaterFsEsc        = null;   // 小剧场全屏时的 Esc 退出监听（一次性绑定，全局复用）
let anchorMode           = false;  // 锚（收藏楼层）视图是否激活
let _anchorSavedKeys     = new Set();   // 已收藏楼层键 `${chatId}::${mesid}`（内存缓存，供按钮同步态）
let _anchorView          = { level: 'chars', charName: null, chatId: null, itemId: null };  // 四层抽屉：角色→聊天→收藏→全文
let _anchorCurrentItem   = null;   // 当前全文视图的 item（跳转/删除/导出用）
let _anchorFullTagEdit   = false;  // 全文视图「编辑标签」是否内联展开（避免 body 浮层被面板盖住）
// 暗历内联编辑态/归档折叠态/批量模式已随 ledger 渲染层迁入 business/ledger/render.js
// （经 getLedgerEditor/isLedgerArchiveOpen/getBatchScope 等访问器 + resetLedgerRenderState 复位）。
const _injectTexts      = {};
let   _injectIdSeq      = 0;
let viewportSyncBound   = false;

const isMobile = () => window.innerWidth <= 640;

// 通用操作菜单只描述动作；具体页面决定何时显示、如何处理动作。
const ACTION_MENU_CONFIGS = Object.freeze({
    almanac: Object.freeze([
        Object.freeze({ action: 'generate-almanac', icon: 'fa-wand-magic-sparkles', label: '生成节日', title: 'AI 按世界观铺满一整年' }),
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
    const quoted = /^["']/.test(family) || /^[A-Za-z_][A-Za-z0-9_-]*$/.test(family)
        ? family
        : `"${family.replace(/"/g, '\\"')}"`;
    document.documentElement.style.setProperty('--sp-font-user', quoted);
}

jQuery(async () => {
    // 界面字号缩放：把持久化的 uiScale 写进 --sp-scale，令牌即刻按此缩放（早于注入 UI，防首帧闪错号）
    document.documentElement.style.setProperty('--sp-scale', String(Number(getSettings().uiScale) || 1));
    // 界面字体：按持久化的 uiFontUrl/uiFontFamily 挂 <link> + 写 --sp-font-user（早于注入 UI，防字体闪切）
    applyUiFont();
    injectExtButton();
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
                useBaiBaiBook  : !!s.useBaiBaiBook || !!s.useAnima,   // Anima 用户同样跳过内置采集/注入（memory.js 只认这一个旗标）
                memoryEnabled  : s.memoryEnabled !== false,
                memoryL0Group  : Number.isFinite(+s.memoryL0Group) ? +s.memoryL0Group : 5,
                memoryL1Group  : Number.isFinite(+s.memoryL1Group) ? +s.memoryL1Group : 10,
                memorySkipShort: Number.isFinite(+s.memorySkipShort) ? +s.memorySkipShort : 50,
                keepTags       : typeof s.keepTags  === 'string' ? s.keepTags  : 'content',
                extraTags      : typeof s.extraTags === 'string' ? s.extraTags : '',
            };
        },
        callApi: callMemoryApi,
    });
    // Initialize theater (棱/小剧场) — storage + two-stage generation pipeline
    theater.initTheater({
        getSettings: () => {
            const s = getSettings();
            return {
                theaterStylePrompt   : typeof s.theaterStylePrompt === 'string' ? s.theaterStylePrompt : '',
                theaterBeautifyPrompt: typeof s.theaterBeautifyPrompt === 'string' ? s.theaterBeautifyPrompt : '',
            };
        },
        callWriteApi   : callTheaterApi,
        callBeautifyApi: callTheaterApi,
        getStoryContext: getTheaterStoryContext,
        fallbackRender : renderAiMessageHtml,
    });
    // Initialize anchor (坐标/收藏楼层) — /api/files 存储层；预热索引 + 载入已收藏楼层键
    anchor.initAnchor({
        getSettings: () => {
            const s = getSettings();
            return {
                anchorSizeWarnBytes: Number.isFinite(+s.anchorSizeWarnBytes) ? +s.anchorSizeWarnBytes : 8 * 1024 * 1024,
            };
        },
    });
    refreshAnchorSavedKeys();
    setTimeout(scanAnchorButtons, 900);
    initAnchorObserver();
    // 首屏补挂：backfill 内部 refreshLinesInjection()（潜伏注入）+ refreshInlineWindow(true)
    // 统一挂线/历/点三段。历/点无独立首屏副作用，全汇流到同一防抖窗口刷新，一次即可。
    setTimeout(backfillLinesInlineBlocks, 800);
    initAlmanacStripDelegation();   // 历·七天条格子点击委托（一次性注册到 document）
    initScheduleStripDelegation();  // 点·日程条格子点击委托（一次性注册到 document）
    // Reset view state and reload cache on chat switch
    if (_stListeners.chat) eventSource.removeListener?.(event_types.CHAT_CHANGED, _stListeners.chat);
    _stListeners.chat = () => {
        // 老用户升级：把本 chat 散在 localStorage 的点线面间**同步**搬进 chat_metadata，
        // 必须早于下面任何 load（否则读的是空 metadata）。冲突（云端/本机各一份且不同）时
        // migrate 不动任何数据，稍后异步弹窗让用户决策。
        const _mig = store.migrateChatFromLocalStorage(getContext().chatId);
        timeTravel.clear();
        clearAutomationClaims();
        dateCoordinator.clear();
        // 日期判定不属于 timeTravel controller 的步骤时，也必须在切 chat 时立即中止。
        almanacJudgeAbort?.abort();
        almanacJudgeAbort = null;
        // 插件总关：迁移照做（幂等·防老用户数据漂移），其余全屏隐藏/后台相关一律不跑。
        if (!pluginEnabled()) return;
        currentView  = 'user';
        charViewName = null;
        outlineMode  = false;
        cachedOutline = null;
        outlineChatHistory = [];
        outlineChatAbortController?.abort();
        outlineChatAbortController = null;
        linesMode    = false;
        cachedLines  = null;
        _linesSheet  = 'events';
        linesAiMsgCounter = 0;
        _dashedPanelError = '';
        // 线·swipe：切 chat 复位单调闸到当前末楼（历史楼不误判为新楼），清待重算标记 + 所有临时层。
        _lastSeenMaxMesId = (getContext().chat?.length ?? 0) - 1;
        _pendingSwipeGen = null;
        _floorTextSig = {};   // 切 chat 清楼文本签名，避免跨 chat 同 mesId 串味
        _clearAllSwipeLines();
        // 大纲自动注入：切 chat 复位判定追踪。起点设成当前末楼→载入历史楼不回判；
        // 中断进行中的判定、清计数，避免旧 chat 的判定落到新 chat。
        outlineLastJudgedMsgId = (getContext().chat?.length ?? 0) - 1;
        outlineJudgeMsgCounter = 0;
        outlineJudgeAbort?.abort();
        outlineJudgeAbort = null;
        isJudgingOutline = false;
        // 历·自动确认日期：同理切 chat 复位单调闸到末楼、清计数、中断进行中的判定。
        almanacLastJudgedMsgId = (getContext().chat?.length ?? 0) - 1;
        almanacJudgeCounter = 0;
        almanacJudgeAbort?.abort();  almanacJudgeAbort = null;
        isJudgingDate = false;
        // 暗账标注：切 chat 同理复位单调闸到末楼、清计数、中断进行中的标注。
        ledgerLastCapturedMsgId = (getContext().chat?.length ?? 0) - 1;
        ledgerCaptureCounter = 0;
        ledgerCaptureAbort?.abort(); ledgerCaptureAbort = null;
        isCapturingLedger = false;
        // 暗账判定：同理复位。
        ledgerLastJudgedMsgId = (getContext().chat?.length ?? 0) - 1;
        ledgerJudgeCounter = 0;
        ledgerJudgeAbort?.abort(); ledgerJudgeAbort = null;
        isJudgingLedger = false;
        _autoRegenSchedAbort?.abort(); _autoRegenSchedAbort = null;   // 中断进行中的「同步到点」后台生成
        _lastDetectedDay  = null;   // days-mode: reset day tracker on chat switch
        spaceMode = false;
        spaceChatHistory = [];
        spaceChatAbortController?.abort();
        spaceChatAbortController = null;
        theaterMode = false;
        isGeneratingTheater = false;
        theaterCurrentPiece = null;
        theaterAbortController?.abort();
        theaterAbortController = null;
        anchorMode = false;
        _anchorView = { level: 'chars', charName: null, chatId: null, itemId: null };
        axisState.almanacMode = false;
        axisState.isGeneratingAlmanac = false;
        axisState.almanacAbortController?.abort();
        axisState.almanacAbortController = null;
        axisState._almanacSheet = 'upcoming';
        axisState._almanacCalMonth = null;
        axisState._almanacCalDay = null;
        axisState._almanacEditor = null;
        resetLedgerRenderState();
        axisState._almanacManager = null;
        axisState._almTodayEditing = false;
        axisState._almSyncingPoint = false;
        axisState._almSyncPending = false;
        _lastMainView = 'schedule';   // 跨 chat：下次打开面板默认回到点（第一页）
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
        setTimeout(backfillLinesInlineBlocks, 300);
        // 锚：换 chat → 重载已收藏键（按钮态跟着新 chat 走）+ 补齐每楼收藏入口
        refreshAnchorSavedKeys();
        setTimeout(scanAnchorButtons, 300);
        // 锚自愈：按 chat_id_hash（改名不变的稳定键）兜住 CHAT_RENAMED 漏网的收藏
        //（改名那刻插件没在听 → 旧 chatId 残留、跳转失效）。命中则静默迁到当前 chat 并刷新按钮态。
        const _healHash = getContext()?.chatMetadata?.chat_id_hash;
        const _healChatId = getContext()?.chatId;
        if (_healChatId) {
            (async () => {
                let n = 0;
                if (_healHash) n += await anchor.healChatByHash(_healChatId, getChatDisplayName(), _healHash).catch(() => 0);
                n += await adoptOrphanAnchors(_healChatId, _healHash).catch(() => 0);
                if (n > 0) { refreshAnchorSavedKeys(); if (anchorMode) renderAnchorPanel(); }
            })().catch(err => console.warn('[SP anchor] 自愈失败:', err));
        }
        // Surface memory schema-migration notice, if any (once per upgraded chat)
        setTimeout(checkMemoryMigrationNotice, 500);
        // 跨设备冲突：本机和云端各有一份不同的点线面间 → 弹窗二选一（延后到面板/主题就绪）
        if (_mig.status === 'conflict') setTimeout(() => showStoreConflictDialog(_mig), 700);
        maybeApplyBoundCalendarTemplate().catch(error => {
            console.error('[SP calendar] 角色默认历法自动应用失败', error);
            if (getSettings().notifyMode === 'full') showToast('角色默认历法没有自动应用成功', null, true);
        });
        // 切进来立即按新 chat 的大纲+游标重设注入（关着或无大纲时内部自清）。
        refreshOutlineInjection();
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
        if (_mig0.status === 'conflict') setTimeout(() => showStoreConflictDialog(_mig0), 900);
        if (pluginEnabled()) maybeApplyBoundCalendarTemplate().catch(error => {
            console.error('[SP calendar] 首屏角色默认历法自动应用失败', error);
            if (getSettings().notifyMode === 'full') showToast('角色默认历法没有自动应用成功', null, true);
        });
    } catch (err) { console.warn('[SP store] 首屏迁移失败:', err); }
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
            modules: Object.values(AUTOMATION_MODULES),
        });
        if (token) _timeTravelClaimTokens.set(session.sessionId, token);
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.timeTravelPreflight);
    if (_stListeners.char) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.char);
    _stListeners.char = async (messageId, type) => {
        if (!pluginEnabled()) return;   // 插件总关：不补锚点 / 不挂楼内块 / 不推进 / 不生成
        // 锚收藏入口独立于线：不受 linesEnabled 影响，新楼渲染后补按钮
        setTimeout(scanAnchorButtons, 150);
        // 历·七天条：独立于线主开关，每次楼层渲染都把七天条补挂到最新 AI 楼（只读，无生成）
        syncLatestAlmanacBlock();
        syncLatestScheduleBlock();   // 点·日程条：同上，随新楼补挂（只读）
        // Master switch: linesEnabled=false disables auto-advance + inline block
        if (getSettings().linesEnabled === false) return;
        const mid = Number(messageId);
        // 时旅首楼：自动化线被显式步骤接管——本楼只阻止重复请求，不推进、不提前消费累计进度。
        // （预检占闸先于本监听注册，同一 tick 生效，故此时闸必然已占住。）
        const autoSuppressed = isAutomationSuppressed(mid, AUTOMATION_MODULES.LINES);
        // 🔄重生成握手消费：读一次即清，防陈旧标记泄漏到后续事件。放在 isNewFloor 判定前，但下方分支
        // 顺序保证 isNewFloor 优先——真·新楼即便撞上残留标记也走推进、不会误判成重 roll。
        const wasPendingReroll = _pendingReroll; _pendingReroll = false;
        // 单调递增闸：mid 递增 = 真·新楼层；同 mid 重渲染 = swipe/刷新/历史回渲。
        // counter++ 与自动推进只在真·新楼层做（修掉 swipe/重渲染误触 counter 的老 bug）；
        // 但内联块要在**每次**渲染时补回最新楼——重渲染会清掉旧 DOM，不补则硬刷后主楼线块消失。
        const isNewFloor = Number.isFinite(mid) && mid > _lastSeenMaxMesId;
        // 重 roll 判定（type/latch 两路 + 内容签名兜底）：
        //   ① type==='swipe'：滑到末尾生成新 swipe，未降级、直接认。
        //   ② type==='regenerate' / wasPendingReroll：重生成按钮🔄 的理想信号，但**实测不可靠**——
        //      流式下这条 CMR 的 type 竟是 undefined 且 GENERATION_STARTED 没 latch 到 'regenerate'（pRr=false），
        //      非流式又被 saveReply 降级成 'normal'。单靠 type/latch → 「点🔄线不重算·必现·毫无动静」。
        //   ③ contentChanged（真·兜底，最稳）：**最新楼**的主文本变了 = 就在原楼重生成 = 重roll。版本无关。
        //      只认最新楼（mid===_lastSeenMaxMesId）：历史楼改文本不该动当前线（runGenerateLines 写的是全局当前线缓存）。
        //      滑到已生成 swipe 属既有 MESSAGE_SWIPED 处理，那里已盖章签名，不会在此误判。
        const _curSig  = _floorSig(mid);
        const _curText = String(getContext().chat?.[mid]?.mes ?? '');
        const contentChanged = (mid === _lastSeenMaxMesId && _floorTextSig[mid] !== undefined && _curSig !== _floorTextSig[mid] && _curText.trim() !== '');
        _floorTextSig[mid] = _curSig;   // 记本次签名，供下条 CMR 比对
        const isReroll = (type === 'regenerate' || type === 'swipe' || wasPendingReroll || contentChanged);
        let shouldAdvance = false;
        if (isNewFloor) {
            _lastSeenMaxMesId = mid;
            const mode = getLinesMode();
            if (autoSuppressed) {
                // 时旅流程进行中：显式流程尚未返回结果，本楼只阻止重复请求，不提前消费已有累计进度。
            } else if (mode === 'days') {
                shouldAdvance = detectInGameDayChange(mid, /* excludeCurrent */ true);
            } else if (mode === 'turns') {
                const interval = getLinesInterval();
                // 先自增后比较：interval=1 时每个新楼都推进。原来"先比较(>=)、末尾再 ++"，counter 从 0 起，
                // 首个新楼 0>=1 不成立 → 第一楼不推进、整体相位晚一拍（切 chat / 删线归零后每次重犯），
                // 表现为"这一楼和上一楼线相同"。对齐「面·大纲判定」的 ++counter 写法即可。
                if (++linesAiMsgCounter >= interval) { linesAiMsgCounter = 0; shouldAdvance = true; }
            }
            // mode === 'manual': never auto-advance, only inline block append
        } else if (isReroll || (_pendingSwipeGen && _pendingSwipeGen.mesId === mid)) {
            // 重 roll（🔄 重生成按钮）刚渲染完 → 先贴当前线（避免重算期间主楼空白），再从楼层基线 B0 重算。
            // 纯 swipe 生成新变体（_pendingSwipeGen 命中）不再自动重算——只本地重挂，用户想更新线自己点刷新键。
            // 借此避开「swipe 撞后台/改写插件请求」的并发；🔄 重 roll 仍保留自动重算（用户明确要留）。
            // 区分靠 _pendingSwipeGen：只在 MESSAGE_SWIPED 带 pendingGeneration 时置位，重 roll 走 GENERATION_STARTED 不置。
            const wasSwipeGen = !!(_pendingSwipeGen && _pendingSwipeGen.mesId === mid);
            _pendingSwipeGen = null;
            appendLinesInlineBlock(mid, false);
            // 非推进楼没有 B0 基线，_regenLinesForSwipe 内部会早退、线保持原样（与既有重 roll 语义一致，防止凭空推进）。
            if (!wasSwipeGen) _regenLinesForSwipe(mid, true);
            return;
        }
        // 新楼层按 shouldAdvance 推进并贴块；刷新/历史/swipe 回退重渲染 shouldAdvance=false，仅把内联块补回最新楼。
        appendLinesInlineBlock(mid, shouldAdvance);
        // 全量通知：线随剧情真推进了才弹（不推进不响，对应「变了才提示」）
        if (shouldAdvance && getSettings().notifyMode === 'full') showToast('线已随剧情自动推进 · 请注意查看');
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.char);
    if (_stListeners.timeTravel) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.timeTravel);
    _stListeners.timeTravel = async messageId => {
        if (!pluginEnabled()) return;
        // 闸由预检 preflight 抢占（先于 char 注册，同一 tick 生效）；这里只负责执行流程，
        // 占闸/释放全部走 preflight ↔ onSequenceEnd / cancel，杜绝「闸占在 char 之后」的死区。
        if (!timeTravel.isInitialFloor(messageId)) return;
        await timeTravel.handleRendered(messageId);
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.timeTravel);
    if (_stListeners.timeTravelDeleted) eventSource.removeListener?.(event_types.MESSAGE_DELETED, _stListeners.timeTravelDeleted);
    _stListeners.timeTravelDeleted = () => cancelTimeTravel();
    eventSource.on(event_types.MESSAGE_DELETED, _stListeners.timeTravelDeleted);
    // 线·swipe：滑到新 swipe 时线跟着重算（临时存 localStorage，发下条消息即固定）。
    // pendingGeneration=true → 该 swipe 会触发新生成，此刻新回复还没好，先记标记，等它的
    // CHARACTER_MESSAGE_RENDERED 再从楼层基线 B0 重算；=false → 滑回已生成的 swipe，直接取临时层已存线，不请求 API。
    if (_stListeners.swiped) eventSource.removeListener?.(event_types.MESSAGE_SWIPED, _stListeners.swiped);
    _stListeners.swiped = async (mesId, info) => {
        if (!pluginEnabled()) return;   // 插件总关
        // 历·七天条：swipe 可能改动剧情内时间锚点 → 按现锚点重建（只读，无生成，独立于线主开关）
        // 戳优先·先落地：滑到的变体戳可能不同（如 920→919），先把锚点追到活戳再重建，否则轴仍读旧锚。
        // pendingGeneration 的 swipe 此刻新回复还没好、正文无新戳，跳过（等它的 CMR 再落地）。
        if (!info?.pendingGeneration) relandStoryClockAnchor();
        syncLatestAlmanacBlock();
        syncLatestScheduleBlock();   // 点·日程条：swipe 后一并重挂（点本身不随 swipe 变，纯补块）
        if (getSettings().linesEnabled === false) return;
        const mid = Number(mesId);
        if (info?.pendingGeneration) { _pendingSwipeGen = { mesId: mid }; return; }
        _floorTextSig[mid] = _floorSig(mid);   // 盖章：滑到已生成 swipe 由本处处理，别让随后 CMR 的内容签名把它误判成重roll
        _applyStoredSwipeLines(mid, Number(info?.nextSwipeId ?? getContext().chat?.[mid]?.swipe_id ?? 0));
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
        if (!pluginEnabled()) return;           // 插件总关
        if (getSettings().linesEnabled === false) return;
        const mid = Number(mesId);
        if (!Number.isFinite(mid)) return;
        _floorTextSig[mid] = _floorSig(mid);    // 盖章：对齐到编辑后正文，别让随后 CMR 把这次编辑误判成重roll
    };
    eventSource.on(event_types.MESSAGE_EDITED, _stListeners.edited);
    // 线·固定：用户发出下一条消息 → 上一 AI 楼层定稿，清掉它的 swipe 临时层（store 已是当前 swipe 的线）。
    if (_stListeners.sent) eventSource.removeListener?.(event_types.MESSAGE_SENT, _stListeners.sent);
    _stListeners.sent = (insertAt) => {
        if (!pluginEnabled()) return;   // 插件总关
        if (getSettings().linesEnabled === false) return;
        const chat = getContext().chat;
        if (!Array.isArray(chat)) return;
        const upto = Number.isFinite(Number(insertAt)) ? Number(insertAt) : chat.length;
        for (let i = Math.min(upto, chat.length) - 1; i >= 0; i--) {
            if (!chat[i]?.is_user) { _clearSwipeLines(getContext().chatId, i); break; }
        }
    };
    eventSource.on(event_types.MESSAGE_SENT, _stListeners.sent);
    // 生成态闸（防楼内块流式频闪）：ST 流式每 token 重写末楼 .mes_text 会冲掉线块/七天条，observer 若在流式间隙补块就「补→被冲→再补」肉眼频闪。
    // 用「流式活跃截止时间戳」自愈闸而非布尔闸：GENERATION_ENDED 只在停止按钮显示过时才发（script.js hideStopButton），
    // quiet/后台生成不显示停止按钮却照发 GENERATION_STARTED —— 布尔闸会被这类生成置真后永不清零、observer 从此罢工、楼内块全失。
    // 时间戳闸靠「最近流式 token 时间」续期、到点自动失效，绝不卡死。
    if (_stListeners.genStart) eventSource.removeListener?.(event_types.GENERATION_STARTED, _stListeners.genStart);
    _stListeners.genStart = (genType, _opts, dryRun) => {
        if (!pluginEnabled()) return;   // 插件总关
        if (dryRun) return;
        _stStreamUntil = Date.now() + 3000;   // 盖住首 token 前的模型延迟；无 token 也 3s 自愈
        // 🔄重生成：此刻 type 尚是原始 'regenerate'（还没进 saveReply 被降级成 'normal'）→ 置位待下一条 CMR 消费。
        if (genType === 'regenerate') {
            _pendingReroll = true;
            _rerollExcludedAssistant = null;
            _rerollExcludedAssistant = snapshotLastAssistant(getContext().chat);
        }
    };
    eventSource.on(event_types.GENERATION_STARTED, _stListeners.genStart);
    if (_stListeners.streamTok) eventSource.removeListener?.(event_types.STREAM_TOKEN_RECEIVED, _stListeners.streamTok);
    _stListeners.streamTok = () => { if (!pluginEnabled()) return; _stStreamUntil = Date.now() + 1500; }; // 每个可见 token 把闸续 1.5s；token 停 1.5s 后 observer 自动恢复补块
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, _stListeners.streamTok);
    if (_stListeners.genEnd) {
        eventSource.removeListener?.(event_types.GENERATION_ENDED, _stListeners.genEnd);
        eventSource.removeListener?.(event_types.GENERATION_STOPPED, _stListeners.genEnd);
    }
    _stListeners.genEnd = () => {
        if (!pluginEnabled()) return;   // 插件总关
        _stStreamUntil = 0;   // 立即开闸（有 ENDED 就即时恢复；没有也无妨，时间戳会自愈）
        _pendingReroll = false;
        _rerollExcludedAssistant = null;
        setTimeout(() => refreshInlineWindow(true), 60);   // 流式结束 → 重算渲染窗口（最新楼冻快照+重挂）
    };
    eventSource.on(event_types.GENERATION_ENDED, _stListeners.genEnd);
    eventSource.on(event_types.GENERATION_STOPPED, _stListeners.genEnd);
    // 面·大纲自动注入：独立监听，跟线彻底解耦（绝不复用 _stListeners.char——它 linesEnabled=false
    // 会 early-return，连坐大纲）。每隔 N 楼独立判定一次剧情是否推进到下一节点，推进则游标 +1。
    if (_stListeners.outlineJudge) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.outlineJudge);
    _stListeners.outlineJudge = async (messageId) => {
        if (!pluginEnabled()) return;   // 插件总关：停后台大纲推进判定
        if (getSettings().outlineInject !== true) return;
        const chat = getContext().chat;
        if (!Array.isArray(chat)) return;
        // 只判「真·末楼」：backfill/历史重渲染会重放旧楼，靠 messageId===末楼 + 单调递增双闸挡掉
        if (messageId !== chat.length - 1) return;
        if (messageId <= outlineLastJudgedMsgId) return;
        outlineLastJudgedMsgId = messageId;
        // 时旅首楼：面推进由显式步骤接管（OUTLINE step），跳过自动判定，防重复 API
        if (isAutomationSuppressed(messageId, AUTOMATION_MODULES.OUTLINE)) return;
        // 攒够 interval 条真·新回复才跑判定（省 token）。计数只被真末楼 bump，历史重放到不了这
        if (++outlineJudgeMsgCounter < getOutlineJudgeInterval()) return;
        outlineJudgeMsgCounter = 0;
        runJudgeOutlineStep();   // fire-and-forget，自带守卫
    };
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
        if (relandStoryClockAnchor()) {
            dateCoordinator.recordResult(renderKey, { source: 'story-clock' });
            return;
        }
        // 到这＝戳关，或戳开但本楼读不到戳（漏打 / 「谷雨」无月日）→ API judge 兜底才需单调闸防重放/重算。
        if (messageId <= almanacLastJudgedMsgId) return;
        almanacLastJudgedMsgId = messageId;
        if (getSettings().almanacAutoDetect === false) return;
        if (++almanacJudgeCounter < getAlmanacJudgeInterval()) return;
        almanacJudgeCounter = 0;
        dateCoordinator.runOnce(renderKey, () => runJudgeDateStep());   // fire-and-forget；runOnce 兼并发去重
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.almanacJudge);
    // 点不再独立判定日期、也无独立跟随开关：任何一处改「今天」锚点都经 runAnchorAftermath → 顺手把点重排到今天，点纯下游连带跟随。
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
        // 先重挑注入集（更新 _ledgerInjectEcho），再刷窗——本监听器在 char 之后触发，char 那趟冻的是
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
        try {
            // 改名后重载 chat，chat_id_hash 已随文件搬到新 chat 上；顺手传进去补到收藏上，
            // 让后续分桶/自愈有稳定键（改名多少次都并一个桶）。
            const hash = getContext()?.chatMetadata?.chat_id_hash ?? null;
            const n = await anchor.renameChatId(oldId, newId, newId, hash);
            if (n && anchorMode) renderAnchorPanel();
        } catch (err) { console.warn('[7dayscal] 坐标改名同步失败:', err); }
    };
    eventSource.on(event_types.CHAT_RENAMED, _stListeners.rename);
    // 柏宝书就绪事件：加载顺序不固定，早期同步检测可能扑空而误报"未就绪"。
    // 柏宝书文档推荐监听 st-baibai-book:ready 兜底——就绪后清掉"仅警告一次"的闩，
    // 并在面板开着且选了柏宝书源时立刻把状态刷成"已就绪"。
    if (_bbbReadyListener) window.removeEventListener('st-baibai-book:ready', _bbbReadyListener);
    _bbbReadyListener = () => {
        if (!pluginEnabled()) return;   // 插件总关
        _bbbWarned = false;
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
// 生成类调用不走这里，始终 loadCfg()。空/无效即与旧版完全一致。


// ─── API 存储快切：预设仓库 ────────────────────────────────────────────────────
// 预设是「整套 API 配置的命名快照」。存的是当前输入框里的这套（含未点保存的改动），
// 切换只把某个预设填回输入框，不直接改生效配置——用户核对后点「保存设置」才落地。


// 把一套 cfg（loadCfg 形状）存成预设。有 id 且已存在→覆盖(改名+更新内容)，否则新建。
// 返回被写入/新建的预设 id。


// 给已存预设改名（就地，不动 url/key/model 等）。空名→保留原名。


// ─── 插件总开关（③）───────────────────────────────────────────────────────────
// pluginEnabled 关 = 全隐身；injectEnabled 关 = 只掐线/面潜伏注入（受 pluginEnabled 统辖）。

// 一键中断所有在飞的后台判定与生成（点/线/虚线/面/间/棱/历 + 三路日期判定 + 同步到点），并清 re-entry 闸，
// 让重新开启后能干净重跑。照 CHAT_CHANGED 的中断序列集中一处。
function _abortAllBackground() {
    for (const c of [
        linesAbortController, dashedAbortController, spaceChatAbortController,
        pointState.scheduleAbortController, outlineAbortController, theaterAbortController,
        axisState.almanacAbortController, outlineChatAbortController,
        outlineJudgeAbort, almanacJudgeAbort, _autoRegenSchedAbort,
        ledgerCaptureAbort, ledgerJudgeAbort,
    ]) { try { c?.abort(); } catch {} }
    linesAbortController = dashedAbortController = spaceChatAbortController = null;
    pointState.scheduleAbortController = outlineAbortController = theaterAbortController = null;
    axisState.almanacAbortController = outlineChatAbortController = null;
    outlineJudgeAbort = almanacJudgeAbort = _autoRegenSchedAbort = null;
    ledgerCaptureAbort = ledgerJudgeAbort = null;
    isGeneratingOutline = isGeneratingLines = isGeneratingDashed = false;
    isGeneratingTheater = axisState.isGeneratingAlmanac = false;
    isJudgingOutline = isJudgingDate = false;
    isCapturingLedger = isJudgingLedger = false;
}

// 插件总开关落地。关：藏悬浮球、清所有楼内块与锚点入口（由 refreshInlineWindow/scanAnchorButtons 内部闸兜底）、
// 断所有后台任务、撤两路潜伏注入。不关面板——用户往往正站在设置里切它，留着好即时切回。
// 开：按各子开关恢复——显示悬浮球、重挂楼内块与两路注入、补锚点入口。事件监听不注销，靠各 listener 的 pluginEnabled() 闸空转。
function applyPluginEnabled(on) {
    const ctx = getContext();
    if (on) {
        $(`#${FAB_ID}`).css('display', fabEnabled() ? '' : 'none');
        try { backfillLinesInlineBlocks(); } catch {}   // 重挂线/历/点楼内块 + 重设线潜伏注入
        try { refreshOutlineInjection(); } catch {}       // 重设大纲潜伏注入
        try { refreshStoryClockInjection(); } catch {}    // 重设时间戳注入
        try { scanAnchorButtons(); } catch {}             // 补回锚点收藏入口
        try { refreshInlineWindow(true); } catch {}
        maybeApplyBoundCalendarTemplate().catch(error => {
            console.error('[SP calendar] 重新启用后角色默认历法自动应用失败', error);
            if (getSettings().notifyMode === 'full') showToast('角色默认历法没有自动应用成功', null, true);
        });
    } else {
        $(`#${FAB_ID}`).css('display', 'none');
        try { _clearAllInlineBoxes(); } catch {}
        _abortAllBackground();
        try { ctx.setExtensionPrompt?.(LINES_INJECT_KEY, ''); } catch {}
        try { ctx.setExtensionPrompt?.(OUTLINE_INJECT_KEY, ''); } catch {}
        try { ctx.setExtensionPrompt?.(SDC_CLOCK_INJECT_KEY, ''); } catch {}
        try { ctx.setExtensionPrompt?.(LEDGER_INJECT_KEY, ''); _ledgerInjectEcho = []; } catch {}
    }
}







// ─── In-game day-change detection (桥接到历·almTodayAnchor) ───────────────────
// days 模式（跟随局内时间）的推进检测：从历的权威「今天」取 {月-日}，变化即推进。
// 历史上这里读柏宝书 state.time（见 detectInGameDayChange 内注释），已改为桥接 almTodayAnchor
// 六层兜底源——柏宝书没装也能靠记忆/线/点/正文推进，且与历共用同一个「今天」。
// extractDayFromTime / _cnToNumber / _CN_* 仍被 almTodayAnchor、parseJudgedDate 复用，保留。
let _lastDetectedDay = null;
let _bbbWarned       = false;   // 现已无读取点（旧 days 检测的唯一读者随桥接删除）；仅剩 622 处复位，留着不动柏宝书就绪handler


// 中文数字 → 阿拉伯数字（覆盖 0–99，足以处理古代年月日）。含农历「廿/卅」与大写/繁体（民国·契据式）。


// 抽出"这一天"的规范化 key。剥掉 era 前缀、时分秒尾巴以及数字前导零，
// 让同一天不同写法（"1287/04/01" ≡ "1287/4/1" ≡ "1287年4月1日"）落到同一
// 个 key 上。返回 null 表示无法识别 → 不推进。

// days 模式（设置里的「跟随局内时间」自动推进）：桥接到历的权威「今天」almTodayAnchor()。
// 旧实现硬依赖外部柏宝书快照、且只读上一条 AI 楼 —— 柏宝书没装就静默永不推进（days 模式等于废的）。
// almTodayAnchor 是六层兜底（①柏宝书→②记忆→③线→④点→⑤正文扫描→⑥兜底）：柏宝书在时答案一致、
// 不在时靠记忆/线/点/正文继续推进；其⑤正文层直接读本楼原文，天然吸收「正文已跳日、慢源没跟上」的相位差。
// 变更键取 {月-日}，与上次检测到的不同即算「过了一天」→ 推进一次。
// 注：almTodayAnchor 读当前最新态、不接受楼层参数，故 messageId/excludeCurrent 仅为兼容旧签名保留、不再使用。
function detectInGameDayChange(messageId, excludeCurrent = false) {
    let md;
    try { md = almTodayAnchor(); } catch { return false; }
    if (!md || !Number.isFinite(+md.month) || !Number.isFinite(+md.day)) return false;
    const day = `${+md.month}-${+md.day}`;
    if (day !== _lastDetectedDay) {
        _lastDetectedDay = day;
        return true;
    }
    return false;
}

// ─── 楼内渲染框·快照桥 ────────────────────────────────────────────────────
// 采集「当前最新」的点/线/历/锚点 → 一份快照对象。这是权威源（sp-store 缓存 + 锚点）的
// 一次性抓拍；写进某层 AI 楼的 message.extra 后即成为那层楼的「死历史」。
// 只读、无副作用：任何时候调都安全。
function captureSnapshot() {
    let point = '', line = '', almanac = [], anchorMD = null;
    try { point = readCacheRaw(getCacheKey()) || ''; } catch { /* 空 */ }
    try {
        const saved = readStore(getLinesCacheKey());
        line = saved?.raw || '';
    } catch { /* 空 */ }
    try { almanac = loadAlmanac(); } catch { almanac = []; }
    try {
        const a = almTodayAnchor();
        if (a && Number.isFinite(+a.month) && Number.isFinite(+a.day)) anchorMD = { month: +a.month, day: +a.day };
    } catch { /* null */ }
    // 标注池：封存当前活跃暗历条目 → 该 AI 楼「当时的标注池」。字段照标注池闭环：
    //   起始/周期/终止锚 + 标签 + 锁态（供高亮），不冻现状（现状是「召回」框的活、标注池只摆台账事实）。
    let pool = [];
    try {
        const cloneAnchor = a => (a && typeof a === 'object') ? { ...a } : null;
        pool = (ledger.listEntries() || []).map(e => ({
            id: e.id, 事由: e.事由, 类型: e.类型,
            起始锚: cloneAnchor(e.起始锚), 周期长度: e.周期长度, 到期锚: cloneAnchor(e.到期锚),
            标签: Array.isArray(e.标签) ? e.标签.slice() : [], 锁: e.锁, 静音: e.静音,
        }));
    } catch { pool = []; }
    return { point, line, almanac, anchor: anchorMD, pool };
}

// 用户楼快照：封存本回合召回注入回显（丰富版 [{id,事由,类型,起始锚,现状}]）。
// 与 captureSnapshot 分工：AI 楼冻标注池、用户楼冻召回，各挂各的框（见 freezeSnapshotToFloor 分派）。
function captureRecallSnapshot() {
    const recall = Array.isArray(_ledgerInjectEcho) ? _ledgerInjectEcho.slice() : [];
    return { recall };
}

// 把当前最新态封存进第 mesId 层（幂等：内容没变不写、不触发保存）。按楼性质分派：
//   AI 楼 → captureSnapshot()（点/线/历/锚点/标注池）；用户楼 → captureRecallSnapshot()（召回）。
// 挂在各「最新楼」路径上——数据一有变化就汇流到这，达成最终一致。
function freezeSnapshotToFloor(mesId) {
    if (mesId == null) return;
    try {
        const msg = getContext()?.chat?.[Number(mesId)];
        if (msg?.is_user) {
            const snap = captureRecallSnapshot();
            if (!snap.recall.length) return;   // 用户楼无召回 → 不建空快照（不挂框、不占存档）
            snapshot.writeSnapshot(Number(mesId), snap);
        } else {
            snapshot.writeSnapshot(Number(mesId), captureSnapshot());
        }
    } catch { /* 存档失败不影响渲染 */ }
}

// ─── Storylines inline block (appended to AI messages) ────────────────────────

// 线注入正文时给 Next 加「下一步：/恢复条件：」前缀。模型有时已在 l.next 里
// 自带前缀（甚至混用），会导致「下一步：下一步：xxx」；先剥掉任意已有前缀再统一加。
function prefixNext(next, stall) {
    let clean = String(next || '').trim();
    // 循环剥掉开头任意层模型自带的「下一步/恢复条件」标签，再统一加前缀。
    // 只在能确认是"标签"而非正文时才剥（避免误伤"下一步行动是…"这类正文）：
    //   (a) 被成对强调符包裹：**下一步** / **下一步：** / *恢复条件*（模型有时不加冒号，只加粗）
    //   (b) 裸标签＋冒号：下一步： / 恢复条件：（必须带冒号才算标签）
    let prev;
    do {
        prev = clean;
        clean = clean.replace(/^(\*\*|__|\*|_)\s*(下一步|恢复条件)\s*[:：]?\s*\1\s*[:：]?\s*/, '').trim();
        clean = clean.replace(/^\s*(下一步|恢复条件)\s*[:：]\s*/, '').trim();
    } while (clean !== prev);
    return (stall ? '恢复条件：' : '下一步：') + clean;
}

// rawArg：null=读当前视角活缓存（最新楼，现状不变）；字符串=快照里的线 raw（历史楼）。
// readOnly：true=历史楼，去掉逐条注入/删除按钮 + 标题条的「推进」按钮（旧楼不触发生成）。
// 历史楼不并虚线子块（虚线是全局冷知识、非那层楼的历史态）。
function _buildLinesBlockHtml(rawArg = null, readOnly = false) {
    if (getSettings().linesInlineEnabled === false) return '';   // 线段单独关 → 不渲这段（与历/点两段自门控对齐）
    const raw = rawArg != null ? rawArg : (() => {
        try {
            const saved = readStore(getLinesCacheKey());
            return saved?.raw || '';
        } catch { return ''; }
    })();
    const lines = raw ? parseLines(raw) : [];
    const dashedSub = readOnly ? '' : _buildDashedSubsectionHtml();   // 虚线冷知识折进同一个块的 body（合并成一个楼内窗口）；历史楼不并
    if (lines.length) {
        const linesHtml = lines.map((l, i) => {
            const levelNum = parseInt(l.level, 10);
            const level    = Number.isFinite(levelNum) ? Math.max(1, Math.min(4, levelNum)) : 1;
            const stageColor = STAGE_COLORS[l.stage] || '#9aa6b2';
            const beadsHtml = Array.from({length: 4}, (_, i) =>
                `<span class="sp-bead${i < level ? ' sp-bead-on' : ''}" style="${i < level ? `background:${stageColor}` : ''}"></span>`
            ).join('');
            // Per-line inject button — parallels the one in the outer panel (renderLines)。历史楼只读：整组动作按钮不挂。
            let actions = '';
            if (!readOnly) {
                const injectParts = [`【线参考】${l.name}（${l.type}·${l.stage}${l.stall ? '·停滞' : ''}）`];
                if (l.desc) injectParts.push(l.desc);
                if (l.next) injectParts.push(prefixNext(l.next, l.stall));
                actions = `<span class="sp-beat-actions">
                        ${makeInjectBtn(injectParts.join('\n'))}
                        <button class="sp-line-del-one" data-line-idx="${i}" title="删除这条线"><i class="fa-solid fa-xmark"></i></button>
                    </span>`;
            }
            return `<div class="sp-inline-line${l.stall ? ' sp-line-stall' : ''}" data-line-idx="${i}" style="border-left:3px solid ${stageColor}20">
                <div class="sp-inline-head">
                    <span class="sp-inline-stage" style="color:${stageColor}">${escapeHtml(l.stage)}</span>
                    ${l.type ? `<span class="sp-inline-type">${escapeHtml(l.type)}</span>` : ''}
                    <span class="sp-inline-dots">${beadsHtml}</span>
                    ${l.when ? `<span class="sp-inline-when">${escapeHtml(l.when)}</span>` : ''}
                    ${l.stall ? `<span class="sp-line-stall-tag sp-inline-stall">停滞</span>` : ''}
                    ${actions}
                </div>
                <div class="sp-inline-name">${escapeHtml(l.name)}</div>
                ${l.desc ? `<div class="sp-inline-desc">${escapeHtml(cleanText(l.desc))}</div>` : ''}
                ${l.next ? `<div class="sp-line-next sp-inline-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}">
                    <span class="sp-line-next-tag">${l.stall ? '⏸' : '→'}</span>
                    <span class="sp-line-next-text">${escapeHtml(cleanText(l.next))}</span>
                </div>` : ''}
            </div>`;
        }).join('');
        const advanceBtn = readOnly ? '' : `<span class="sp-inline-summary-actions">
            <button class="sp-inline-refresh-lines" title="重新生成线"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="sp-inline-advance-lines" title="推进事件线"><i class="fa-solid fa-forward"></i></button>
        </span>`;
        return `<summary class="sp-inline-summary"><span class="sp-inline-title">线</span><span class="sp-inline-count">${lines.length} 条活跃</span>${advanceBtn}</summary><div class="sp-inline-body">${linesHtml}${dashedSub}</div>`;
    }
    // 无活跃线：线块「暂无」；若虚线有内容仍给一个 body 承载它（合并后虚线寄居在线块里）。
    const emptySummary = `<summary class="sp-inline-summary"><span class="sp-inline-title">线</span><span class="sp-inline-count sp-inline-empty">暂无</span></summary>`;
    return dashedSub ? `${emptySummary}<div class="sp-inline-body">${dashedSub}</div>` : emptySummary;
}

// 楼内「标注池」框（AI 楼，镜像线块 _buildLinesBlockHtml）：显示当前实际打捞到的暗历条目。
// poolArg：历史楼传快照里冻的 pool [{id,事由,类型,起始锚,周期长度,到期锚,标签,锁}]；最新楼传 null → 读活账 ledger.listEntries()
//   （与线/点/历「null=读活缓存」同款：最新楼恒反映当前标注池，historical 楼看当时冻结的）。
// readOnly=false（最新楼）：summary 带「标注/更新」两文字胶囊、每条带「锁定/归档了结」；true（历史楼）：纯只读。
// 空池 → 返回 ''（该楼不挂此段；与线/点/历子块空态、及旧「空回显不挂」一致，默认开关下不冒空条）。
// 字段照标注池闭环：类型胶囊(上色) + 事由 + 起始/周期/终止 + 标签；不显现状（现状归「召回」框）。
function _buildLedgerBlockHtml(poolArg = null, readOnly = false) {
    if (getSettings().ledgerInlineEnabled === false) return '';   // 显隐开关单独关 → 不渲这段（与线/点/历子开关自门控对齐；与注入 ledgerInject 解耦）
    let items;
    if (poolArg != null) {
        items = Array.isArray(poolArg) ? poolArg.filter(x => x && x.事由) : [];
    } else {
        try { items = (ledger.listEntries() || []).filter(x => x && x.事由); } catch { items = []; }
    }
    if (!items.length) return '';   // 空池 → 不挂

    const cal = loadCalDesc();
    // 打捞/更新：照主面板改文字胶囊（图标看不懂）——复用 .sp-mini-btn.sp-ledger-pill，CSS 里另有覆盖免被 summary 22px 方钮规则压扁。
    const actions = readOnly ? '' : `<span class="sp-inline-summary-actions">
            <button class="sp-mini-btn sp-ledger-pill sp-inline-ledger-capture" title="打捞新标注">标注</button>
            <button class="sp-mini-btn sp-ledger-pill sp-inline-ledger-judge" title="按时间更新现状">更新</button>
        </span>`;
    const rows = items.map(it => {
        const tcls = ledgerTypeClass(it.类型);   // 行挂类型类 → --ledger-c 级联给类型胶囊上色（持续状态/约定/周期各一色）
        const type = it.类型 ? `<span class="sp-ledger-type">${escapeHtml(it.类型)}</span>` : '';
        const locked = it.锁 === '用户锁';
        const paused = it.静音 === true;   // 暂停埋入
        let rowActions = '';
        if (!readOnly) {
            rowActions = `<span class="sp-beat-actions">
                    <button class="sp-inline-ledger-lock${locked ? ' sp-inline-locked' : ''}" data-id="${escapeAttr(it.id)}" title="${locked ? '已锁定 · 点击解锁' : '锁定 · AI 判定不再改动此条'}"><i class="fa-solid fa-${locked ? 'lock' : 'lock-open'}"></i></button>
                    <button class="sp-inline-ledger-mute${paused ? ' sp-inline-paused' : ''}" data-id="${escapeAttr(it.id)}" title="${paused ? '已暂停埋入 · 点击恢复' : '暂停埋入 · 暂不注入主楼'}"><i class="fa-solid fa-${paused ? 'bell-slash' : 'bell'}"></i></button>
                    <button class="sp-inline-ledger-close" data-id="${escapeAttr(it.id)}" title="归档了结 · 移出活跃、可捞回"><i class="fa-solid fa-box-archive"></i></button>
                </span>`;
        }
        const start = fmtLedgerAnchorDate(it.起始锚?.历日期, cal);
        const startTag = start ? `<span class="sp-ledger-meta">起 ${escapeHtml(start)}</span>` : '';
        const cyc = it.周期长度 ? `<span class="sp-ledger-meta">周期${escapeHtml(String(it.周期长度))}天</span>` : '';
        const dueStr = fmtLedgerAnchorDate(it.到期锚?.历日期, cal);
        const due = dueStr ? `<span class="sp-ledger-meta">终 ${escapeHtml(dueStr)}</span>` : '';
        const dates = `${startTag}${cyc}${due}`;
        const datesRow = dates ? `<div class="sp-ledger-dates">${dates}</div>` : '';
        const tags = (it.标签 || []).map(t => `<span class="sp-ledger-tag">${escapeHtml(t)}</span>`).join('');
        const tagsRow = tags ? `<div class="sp-ledger-r3">${tags}</div>` : '';
        return `<div class="sp-ledger-inline-row sp-ledger-${tcls}${locked ? ' sp-line-pinned' : ''}${paused ? ' sp-ledger-paused' : ''}" data-id="${escapeAttr(it.id)}">
                <div class="sp-inline-head">${type}${rowActions}</div>
                <div class="sp-inline-name">${escapeHtml(it.事由)}</div>
                ${datesRow}
                ${tagsRow}
            </div>`;
    }).join('');
    return `<summary class="sp-inline-summary"><span class="sp-inline-title">标注池</span><span class="sp-inline-count">${items.length} 条</span>${actions}</summary><div class="sp-inline-body sp-ledger-inline-body">${rows}</div>`;
}


// Remove inline lines block from ALL AI messages — enforces "only the latest floor holds it".
// 虚线冷知识已折进 .sp-lines-inline 的 body（合并成一个楼内块），清线块即连虚线一并清；
// 仍带上 .sp-dashed-inline 兜底，扫掉合并前旧版本残留在 DOM 里的独立虚线块。
function _removeAllInlineBlocks() {
    document.querySelectorAll('#chat .sp-lines-inline, #chat .sp-dashed-inline').forEach(el => el.remove());
}

// 新楼层挂线块 + （可选）首次推进生成。渲染改由 refreshInlineWindow() 统一负责；
// 本函数保留唯一真副作用——首次推进的线生成（runGenerateLines），以及推进前后的即时刷窗。
async function appendLinesInlineBlock(messageId, shouldAdvance) {
    // 先即时刷一次窗，让新楼的框（含当前线态）立刻出现（显隐门/深度窗/视口由控制器判定）
    refreshInlineWindow(true);

    // If we need to advance, run generation and then refresh again（推进不受显隐门影响）
    const cfg = loadCfg();
    if (shouldAdvance && !isGeneratingLines && cfg.url && cfg.key) {
        // 新楼层首次推进：带上 swipeCtx（当前 swipeId，通常 0），把本次 pre-commit 基线 B0
        // 连同结果记进 swipe 临时层，后续在本楼 swipe 时能从 B0 重推、来回 swipe 复用。
        const swipeId = Number(getContext().chat?.[messageId]?.swipe_id ?? 0);
        await runGenerateLines(true /* silent */, { mesId: Number(messageId), swipeId });
        refreshInlineWindow(true);   // 推进产生的新线态 → 重刷窗（最新楼会重冻快照+重挂）
    }

    // 冻快照进本楼：新楼首挂 / 推进后线态已定，把此刻的点/线/历/锚点封存到这条 message（幂等）。
    freezeSnapshotToFloor(messageId);
}

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

// ─── 历·楼内七天条（只读，反映历+锚点，无生成）─────────────────────────────────
// 与线块平行、共存于最新 AI 楼。外壳（标题条）仿线：一个 <details>，收起时是扁扁的
// 「历 · N个日程」条，点整条即展开——配色/圆角/边框全走线的 .sp-inline-* 类。
// 展开后的内容是历自己的「往后六天」条：6 格（周X + M/D，从明天起，今天已在大头日期块里、
// 这里不重复），覆盖到历条目的日子高亮打点；窗口内有节日则每格可点、点下方就地展开当天安排（.sp-alm-sday）。
// 纯读 loadAlmanac()+锚点，不请求 API、不受 linesEnabled 影响，只受 almanacInlineEnabled 开关控制。
// itemsArg：null=读当前活历 loadAlmanac()（最新楼）；数组=快照里的历条目（历史楼）。
// anchorArg：null=读当前锚点 almTodayAnchor()；{month,day}=快照锚点。历本就只读，无按钮需 gate。
function _buildAlmanacBlockHtml(itemsArg = null, anchorArg = null) {
    if (getSettings().almanacInlineEnabled === false) return null;
    const items = Array.isArray(itemsArg) ? itemsArg : loadAlmanac();
    if (!items.length) return null;   // 无任何历条目 → 不打扰聊天，不显示
    const anchor  = (anchorArg && Number.isFinite(+anchorArg.month) && Number.isFinite(+anchorArg.day))
        ? { month: +anchorArg.month, day: +anchorArg.day }
        : almTodayAnchor();
    const cal     = loadCalDesc();
    const ref     = almWeekdayRef(cal);
    const baseDoy = almDayOfYear(anchor.month, anchor.day, cal);
    const baseWd  = almWeekdayFor(anchor.month, anchor.day, ref, cal);
    const total   = calYearLen(cal);
    let hasAny = false;
    const coveredItems = new Set();   // 未来 7 天窗口内被覆盖到的历条目（多日节日只计一次）→ 标题「N个日程」
    // 六格（非七格）：大头已经是「今天」，这里只排今天之后的 6 天（周X + M/D），
    // 有种从大头往后延续的感觉、不重复今天。i 从 1（明天）起。
    const cells = Array.from({ length: 6 }, (_, k) => {
        const i   = k + 1;
        const doy = ((baseDoy - 1 + i) % total) + 1;
        const md  = almMonthDayFromDoy(doy, cal);
        const wd  = ALM_WEEKDAYS[(baseWd + i) % 7];   // 线性偏移 → 周几连续（不受年尾接缝影响）
        const cover = items.filter(it => almItemCoversDoy(it, doy, cal));
        const has = cover.length > 0;
        if (has) { hasAny = true; cover.forEach(it => coveredItems.add(it)); }
        const cls = ['sp-alm-scell'];
        if (has) cls.push('sp-alm-scell-has');
        const dot = has ? `<span class="sp-alm-dot sp-alm-type-${almTypeMeta(cover[0].type).cls}"></span>` : '';
        return `<div class="${cls.join(' ')}" data-doy="${doy}">
            <span class="sp-alm-scell-wd">${wd}</span>
            <span class="sp-alm-scell-md">${md.month}/${md.day}</span>
            ${dot}
        </div>`;
    }).join('');
    // 标题条仿线：收起态就是这条「历 · N个日程」，点整条展开（原生 <details>/<summary>）
    const summary = `<summary class="sp-inline-summary"><span class="sp-inline-title">轴</span><span class="sp-inline-count">${coveredItems.size}个日程</span></summary>`;
    const strip   = `<div class="sp-alm-strip">${cells}</div>`;
    // 即将到来清单（仪表盘顶行·今头右侧的 ≡ 倒计时行）：全历条目按「还有几天」排，多日节假日
    // 今天正落区间内记「进行中」(d=-1) 置顶。用本函数的 anchor/baseDoy，历史楼快照锚点也对。
    // 取前 3 条免得刷屏；用户展开七天条 / 历面板看全量。
    const upcoming = items
        .map(it => {
            const active = almClampInt(it.days, 1, calYearLen(cal), 1) > 1 && almItemCoversDoy(it, baseDoy, cal);
            return { it, d: active ? -1 : almDaysUntil(it.month, it.day, anchor, cal) };
        })
        .sort((a, b) => a.d - b.d || a.it.month - b.it.month || a.it.day - b.it.day)
        .slice(0, 3);
    const upHtml = upcoming.map(({ it, d }) => {
        const meta  = almTypeMeta(it.type);
        const label = d === -1 ? '进行中' : d === 0 ? '今天' : `还有${d}天`;
        return `<div class="sp-alm-up-row">
            <span class="sp-alm-up-dot sp-alm-type-${meta.cls}"></span>
            <span class="sp-alm-up-name">${escapeHtml(it.name)}</span>
            <span class="sp-alm-up-when${d <= 0 ? ' sp-alm-up-soon' : ''}">${label}</span>
        </div>`;
    }).join('');
    const upList = upHtml ? `<div class="sp-alm-up">${upHtml}</div>` : '';
    // 六格条：单独打包成 stripHtml，由仪表盘组装时放到「顶行下方·满宽」（不再挤在今头右侧列里，
    // 让右侧列只剩 summary+即将到来 ≈ 今头方形高，今头得以贴成正方形）。
    // 无节日 → flat（不可点）；有节日 → live（可点、下方就地展开 .sp-alm-sday）。
    const stripHtml = hasAny
        ? `<div class="sp-alm-strip-wrap sp-alm-strip-live">${strip}<div class="sp-alm-sday" hidden></div></div>`
        : `<div class="sp-alm-strip-wrap sp-alm-strip-flat">${strip}</div>`;
    return { summary, upHtml: upList, stripHtml };
}

// 七天条：某一天(doy) 的就地详情 HTML（点某格时填进该条的 .sp-alm-sday）。
// 只读 loadAlmanac()、按覆盖该天筛选；空 → 「这天没有安排」。
// itemsArg：null=读活历（最新楼）；数组=快照历条目（历史楼）。历只读，无按钮需 gate。
function _almanacStripDayHtml(doy, itemsArg = null) {
    const cal   = loadCalDesc();
    const ref   = almWeekdayRef(cal);
    const md    = almMonthDayFromDoy(doy, cal);
    const wd    = ALM_WEEKDAYS[almWeekdayFor(md.month, md.day, ref, cal)];
    const head  = `<div class="sp-alm-sday-head">${calMonthName(cal, md.month)}${md.day}日 · ${wd}</div>`;
    const src   = Array.isArray(itemsArg) ? itemsArg : loadAlmanac();
    const day   = src.filter(it => almItemCoversDoy(it, doy, cal)).sort((a, b) => a.month - b.month || a.day - b.day);
    if (!day.length) return `${head}<div class="sp-alm-sday-empty">这天没有安排</div>`;
    const rows = day.map(it => {
        const meta = almTypeMeta(it.type);
        const days = almClampInt(it.days, 1, calYearLen(cal), 1);
        const span = days > 1 ? `<span class="sp-alm-drawer-span">共${days}天</span>` : '';
        return `<div class="sp-alm-drawer-item">
            <i class="fa-solid ${meta.icon} sp-alm-drawer-icon sp-alm-type-${meta.cls}"></i>
            <span class="sp-alm-drawer-name">${escapeHtml(it.name)}</span>
            <span class="sp-alm-drawer-type">${meta.label}</span>${span}
            ${it.note ? `<span class="sp-alm-drawer-note">${escapeHtml(cleanText(it.note))}</span>` : ''}
        </div>`;
    }).join('');
    return `${head}<div class="sp-alm-sday-list">${rows}</div>`;
}

// 七天条 per-day tap：点某格 → 下方就地展开当天安排（再点同格收起、点别格切换）。委托到 document、
// 只注册一次——块会被 #chat observer 反复重建，不能绑在块自身上；只对 .sp-alm-strip-live 可交互条生效。
// 注：格子在 <details> 的 body 内，点它不触发 summary 的展开/收起，两套交互互不打架。
function initAlmanacStripDelegation() {
    $(document).on('click.spalmstrip', '.sp-dash .sp-alm-strip-live .sp-alm-scell', function (e) {
        e.preventDefault();
        e.stopPropagation();   // 别冒泡到 ST 的楼层点击（编辑等）
        const wrap = this.closest('.sp-alm-strip-live');
        if (!wrap) return;
        const sday = wrap.querySelector('.sp-alm-sday');
        if (!sday) return;
        if (this.classList.contains('sp-alm-scell-open')) {   // 点已展开的格 → 收起
            this.classList.remove('sp-alm-scell-open');
            sday.hidden = true;
            sday.innerHTML = '';
            return;
        }
        wrap.querySelectorAll('.sp-alm-scell-open').forEach(c => c.classList.remove('sp-alm-scell-open'));
        this.classList.add('sp-alm-scell-open');
        const { snap } = _inlineTapCtx(this);   // 历史楼只读框 → 用该楼快照的历条目；最新楼 → snap=null 读活缓存
        sday.innerHTML = _almanacStripDayHtml(Number(this.dataset.doy), snap ? (snap.almanac || []) : null);
        sday.hidden = false;
    });
}

// 清掉所有 AI 楼里的历七天条（维持「只挂最新楼」的单副本）。
function _removeAllAlmanacBlocks() {
    document.querySelectorAll('#chat .sp-almanac-inline').forEach(el => el.remove());
}

// 历改动 / 新楼 / swipe / 切聊天 都汇流到这。渲染改由 refreshInlineWindow() 统一负责（最新楼冻快照+重挂）。
function syncLatestAlmanacBlock(expectedChatId = null) {
    if (expectedChatId != null && getContext().chatId !== expectedChatId) return;
    refreshInlineWindow(true);
}

// ─── 点·楼内日程条（只读，反映当前视角的点，无生成）──────────────────────────────
// 与线块/历条平行、共存于最新 AI 楼。收起态是扁扁的「点 · N件待办」条，点整条展开是「日程条」：
// 每个 Day 一格（周X + 日期 + 天气图标 + 待办数），Future 另起一格；点某格就地展开当天事件（标题+时间）。
// 纯读当前视角存的点 raw（getCacheKey），不请求 API、不受 linesEnabled 影响，只受 scheduleInlineEnabled 控制。
// 外壳/标题条走线的 .sp-inline-* 类，与线块/历条一致；只有条内格子用独立的 .sp-sch-* 类。
// rawArg：null=读当前视角活缓存（最新楼，现状行为不变）；字符串=用快照里的点 raw（历史楼）。
// readOnly：true=历史楼，drawer 去掉注入/删除/锁定按钮（在旧楼改点语义矛盾）。
function _buildScheduleBlockHtml(rawArg = null, readOnly = false) {
    if (getSettings().scheduleInlineEnabled === false) return '';
    const raw = rawArg != null ? rawArg : readCacheRaw(getCacheKey());
    if (!raw) return '';   // 当前视角还没生成点 → 不打扰聊天
    const { days, future, startDate } = parseCalendar(raw);
    const hasFuture = future && future.events.length > 0;
    if (!days.length && !hasFuture) return '';   // 解析失败/全空 → 不显示
    let total = 0;
    // 两行格：第一行相对日（今天/明天/后天/未来），第二行 日期+天气+待办数 挤一行省空间。
    const REL = ['今天', '明天', '后天'];
    const cellHtml = (relLabel, mdLabel, wx, n, cls, dayKey) =>
        `<div class="sp-sch-scell${cls}" data-day="${escapeAttr(String(dayKey))}">
            <span class="sp-sch-scell-rel">${escapeHtml(relLabel)}</span>
            <span class="sp-sch-scell-line">${mdLabel ? `<span class="sp-sch-scell-md">${escapeHtml(mdLabel)}</span>` : ''}${wx ? `<span class="sp-sch-scell-wx">${wx}</span>` : ''}<span class="sp-sch-scell-n">${n}</span></span>
        </div>`;
    const ctx = scheduleDayCtx();
    const cells = days.map((day, i) => {
        const n = day.events.length; total += n;
        let mdLabel = `第${i + 1}天`;
        if (startDate) {
            const { month, day: dd } = scheduleDayLabel(i, startDate, ctx);
            mdLabel = `${month}/${dd}`;
        }
        const cls = (i === 0 ? ' sp-sch-scell-today' : '') + (n ? ' sp-sch-scell-has' : '');
        return cellHtml(REL[i] || `第${i + 1}天`, mdLabel, weatherGlyph(day.weather), n, cls, i);
    });
    if (hasFuture) {
        const n = future.events.length;
        cells.push(cellHtml('未来', '', '', n, ' sp-sch-scell-future' + (n ? ' sp-sch-scell-has' : ''), 'future'));
    }
    const summary = `<summary class="sp-inline-summary"><span class="sp-inline-title">点</span><span class="sp-inline-count">${total}件待办</span></summary>`;
    const strip   = `<div class="sp-sch-strip">${cells.join('')}</div>`;
    return `${summary}<div class="sp-inline-body sp-sch-inline-body"><div class="sp-sch-strip-wrap sp-sch-strip-live">${strip}<div class="sp-sch-sday" hidden></div></div></div>`;
}

// 日程条：某一天(dayKey='0'|'1'|…|'future') 的就地详情 HTML（点某格时填进 .sp-sch-sday）。
// 每次都重读 raw（点 raw 会被重算/锁定改写），按天筛事件；空 → 「这天没有安排」。
// dayKey='0'|'1'|…|'future'。rawArg=null 读活缓存（最新楼）；字符串=快照 raw（历史楼）。
// readOnly=true 时 drawer 去掉注入/删除按钮（历史楼只读）。
function _scheduleStripDayHtml(dayKey, rawArg = null, readOnly = false) {
    const { days, future, startDate } = parseCalendar(rawArg != null ? rawArg : readCacheRaw(getCacheKey()));
    let evs = [], headLabel = '', dateLabel = '', wx = '', tp = '';
    if (dayKey === 'future') {
        evs = future?.events || [];
        headLabel = '未来';
        dateLabel = '未来';
    } else {
        const di  = Number(dayKey);
        const day = days[di];
        evs = day?.events || [];
        wx = String(day?.weather || '').trim();
        tp = String(day?.temp || '').trim();
        if (startDate) {
            const ctx = scheduleDayCtx();
            const { month, day: dd, wd } = scheduleDayLabel(di, startDate, ctx);
            headLabel = `${month}月${dd}日 · ${ALM_WEEKDAYS[wd]}`;
        } else {
            headLabel = `第${di + 1}天`;
        }
        dateLabel = headLabel;   // 注入用干净日期（不含天气）；天气随后另拼进 headLabel 仅供显示
        if (wx || tp) headLabel += ` · ${weatherGlyph(wx)}${wx}${tp ? ' ' + tp : ''}`;
    }
    const head = `<div class="sp-sch-sday-head">${escapeHtml(headLabel)}</div>`;
    if (!evs.length) return `${head}<div class="sp-sch-sday-empty">这天没有安排</div>`;
    // 完整事项 + 逐条注入/删除（对齐线：注入用共享 builder 带上当天天气，删除走 .sp-sch-del-one）。
    const rows = evs.map((ev, ei) => {
        const meta = TYPE_META[ev.type] || TYPE_META.main;
        const actions = readOnly ? '' : `<span class="sp-sch-drawer-actions">
                    ${makeInjectBtn(buildPointInjectText(ev, wx, tp, dateLabel))}
                    <button class="sp-sch-del-one" data-day="${escapeAttr(String(dayKey))}" data-ev="${ei}" title="删除这个点"><i class="fa-solid fa-xmark"></i></button>
                </span>`;
        return `<div class="sp-sch-drawer-item${ev.pin ? ' sp-sch-drawer-pinned' : ''}">
            <div class="sp-sch-drawer-head">
                <span class="sp-sch-drawer-badge"><i class="fa-solid ${meta.icon}"></i>${escapeHtml(meta.label)}</span>
                <span class="sp-sch-drawer-title">${escapeHtml(ev.title || '')}</span>
                ${ev.time ? `<span class="sp-sch-drawer-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(ev.time)}</span>` : ''}
                ${ev.pin ? `<i class="fa-solid fa-lock sp-sch-drawer-lock" title="已锁定"></i>` : ''}
                ${actions}
            </div>
            ${ev.desc ? `<div class="sp-sch-drawer-desc">${escapeHtml(cleanText(ev.desc))}</div>` : ''}
            ${(ev.location || ev.npcAction) ? `<div class="sp-sch-drawer-meta">
                ${ev.location  ? `<span class="sp-sch-drawer-loc"><i class="fa-solid fa-location-dot"></i>${escapeHtml(ev.location)}</span>` : ''}
                ${ev.npcAction ? `<span class="sp-sch-drawer-npc"><i class="fa-solid fa-link"></i>${escapeHtml(ev.npcAction)}</span>` : ''}
            </div>` : ''}
        </div>`;
    }).join('');
    return `${head}<div class="sp-sch-sday-list">${rows}</div>`;
}

// 日程条 per-day tap：点某格 → 下方就地展开当天事件（再点同格收起、点别格切换）。委托到 document、
// 只注册一次——块会被 #chat observer 反复重建，不能绑在块自身上；只对 .sp-sch-strip-live 生效。
function initScheduleStripDelegation() {
    $(document).on('click.spschstrip', '.sp-schedule-inline .sp-sch-strip-live .sp-sch-scell', function (e) {
        e.preventDefault();
        e.stopPropagation();   // 别冒泡到 ST 的楼层点击
        const wrap = this.closest('.sp-sch-strip-live');
        if (!wrap) return;
        const sday = wrap.querySelector('.sp-sch-sday');
        if (!sday) return;
        if (this.classList.contains('sp-sch-scell-open')) {
            this.classList.remove('sp-sch-scell-open');
            sday.hidden = true; sday.innerHTML = '';
            return;
        }
        wrap.querySelectorAll('.sp-sch-scell-open').forEach(c => c.classList.remove('sp-sch-scell-open'));
        this.classList.add('sp-sch-scell-open');
        const { readOnly, snap } = _inlineTapCtx(this);   // 历史楼只读框 → 用该楼快照的点 raw + 剥按钮；最新楼 → 活缓存全功能
        sday.innerHTML = _scheduleStripDayHtml(this.dataset.day, snap ? (snap.point || '') : null, readOnly);
        sday.hidden = false;
    });
}

function _removeAllScheduleBlocks() {
    document.querySelectorAll('#chat .sp-schedule-inline').forEach(el => el.remove());
}

// ═══════════════════════════════════════════════════════════════════════════
//  楼内仪表盘（今头 + 历/点/线三区·融进一个面板·最新楼全功能 / 历史楼只读）
// ═══════════════════════════════════════════════════════════════════════════
//
// 结构（对齐用户手绘图，不是三段并列）：以「今」为主心骨的一个面板。
//   ┌─────────────────────────────────────────────┐
//   │ ┌───────┐  历区（即将到来 ≡ + 未来七天格）     │  ← 顶行：今头 + 历
//   │ │今 M/D │                                     │
//   │ │周X ☀  │                                     │
//   │ └───────┘                                     │
//   │ 点区（今日待办）                               │
//   │ 线区（活跃事件线）                             │
//   └─────────────────────────────────────────────┘
//
// 铁律「模块可拆」：历/点/线各自独立开关（各 builder 自门控，关/空→返回 ''）。
//   某区关 → 面板里根本没这区、其余区流式补位、不留空洞。
//   今头的日期来源是历/点的锚点 → 历、点全无 → 今头连带收起，面板退成纯线区。
//   三区全空 → 返回 ''（该楼不挂框）。
//
// snap=null → 最新楼：读活缓存、全功能（注入/删除/推进/锁定按钮都在）。
// snap=对象 → 历史楼：读该楼快照、只读（各 builder 收到 readOnly=true，剥掉可变按钮）。

// 今头/摘要共用的锚点解析：快照有合法锚点用快照，否则退活锚点。
function _dashAnchor(snap) {
    return (snap?.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
        ? { month: +snap.anchor.month, day: +snap.anchor.day }
        : almTodayAnchor();
}

// 「是否真有日期上下文」——与点/线/历三个显示开关无关，只看底层数据在不在：钉了锚点、
// 或有历条目、或有点 raw。用来决定：三区全关（或都空）时，最扁的折叠条是否仍值得显「今 M/D 周X ☀」。
// 全空（新聊天、没数据）→ false，别硬造个「今 1/1」噪声条。历史楼看快照自带的 almanac/point/anchor。
function _hasDateData(snap) {
    if (snap) return !!((Array.isArray(snap.almanac) && snap.almanac.length) || snap.point || snap.anchor);
    let pinned = false;
    try { pinned = !!getDateAnchor(charStableKey(getContext())); } catch { pinned = false; }
    if (pinned) return true;
    try { if (loadAlmanac().length) return true; } catch { /* 忽略 */ }
    try { if (readCacheRaw(getCacheKey())) return true; } catch { /* 忽略 */ }
    return false;
}

// 今头（masthead）：大日期块。月/日 + 周几为主体；天气取点当天格；纪年名(era)由日历描述符驱动，
// 有则点亮、无则不撑（公历默认无 era）。anchor 缺则退活锚点。
function _dashMastheadHtml(snap) {
    const anchor = _dashAnchor(snap);
    const cal = loadCalDesc();
    let wd = '';
    try { wd = ALM_WEEKDAYS[almWeekdayFor(anchor.month, anchor.day, null, cal)]; } catch { wd = ''; }
    // 天气：从点当天格（days[0].weather）拿；拿不到留空。历史楼用快照点 raw。
    let wxHtml = '';
    try {
        const raw = snap ? (snap.point || '') : readCacheRaw(getCacheKey());
        if (raw) {
            const wx = String(parseCalendar(raw).days?.[0]?.weather || '').trim();
            if (wx) wxHtml = `<span class="sp-dash-today-wx">${weatherGlyph(wx)}</span>`;
        }
    } catch { /* 天气拿不到就不显 */ }
    // 纪年位：日历描述符带 era（纪年名）时点亮，无则不撑。
    const eraHtml = calHasEra(cal) ? `<span class="sp-dash-today-era">${escapeHtml(cal.era)}</span>` : '';
    return `<div class="sp-dash-today">
        <span class="sp-dash-today-md">${anchor.month}/${anchor.day}</span>
        <span class="sp-dash-today-wd">${wd}</span>
        ${(wxHtml || eraHtml) ? `<span class="sp-dash-today-meta">${wxHtml}${eraHtml}</span>` : ''}
    </div>`;
}

// 折叠态（整框收成一小条）的摘要内层：今 M/D 周X ☀ + 计数 chips（历N 点N 线N）。
// 「今 M/D 周X + 天气」是今天的身份标识，只要拿得到日期就恒显——不受点/线/历子开关影响
// （子开关只管展开面板里那几个区显不显，日期/天气来自剧情锚点+点数据，与显示开关无关）。
// chips 则跟着子开关走：只给「开着且有内容」的区计数（关掉的区不该在摘要里冒计数）。
// flat=true：整框只剩这一条（点线历都关但有日期）→ 用 <div> 包、无折叠箭头、不可展开。
// 时间戳·窄条抬戳：最新楼扫到戳时，戳「抬」成当天身份（end 优先）——
//   数字戳（2024-10-08 15:10 / 10月8日 …）→ 解析成规整「年月日 周几」，把「时」挪到天气之后；
//   古风/无法解析（谷雨亥时 / 霜月初三）→ 原样抬（无周几）；完全无戳/关/历史楼 → 锚点兜底日期。
//   周几：有年且公历按真年算(JS Date)，否则用与锚点同源的年-free 周几（自定义历法也走这条）。
//   与展开区 storyClockBarHtml（带标签+起→止）互补。
// 从戳原文抠数字日期/时刻。返回 {year?,month,day,time?}；抠不出数字日期 → null（交回原样抬）。
function parseStampDate(stamp) {
    const s = String(stamp || '');
    let year = null, month = null, day = null, time = '';
    let m;
    if ((m = s.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/))) {
        year = +m[1]; month = +m[2]; day = +m[3];
    } else if ((m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/))) {
        month = +m[1]; day = +m[2];
    }
    if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;   // 非数字日期 → 原样抬
    if ((m = s.match(/(\d{1,2})\s*[:：]\s*(\d{2})/)))   time = `${+m[1]}:${m[2]}`;
    else if ((m = s.match(/(\d{1,2})\s*[时點点]/)))     time = `${+m[1]}时`;
    return { year, month, day, time };
}
// 组窄条「今 …」那截：{ todayHtml(含 .sp-dash-sum-today 壳), timeHtml(时刻尾巴，贴天气后) }。
function storyClockHeadParts(isLatest, a, anchorWd) {
    const today = (inner, tip) => `<span class="sp-dash-sum-today"${tip ? ` title="${tip}"` : ''}>${inner}</span>`;
    const fallback = { todayHtml: today(`今 ${a.month}月${a.day}日${anchorWd ? ' ' + anchorWd : ''}`), timeHtml: '' };
    if (!isLatest || !storyClockEnabled()) return fallback;
    let clk = null;
    try { clk = latestStoryClock(); } catch { clk = null; }
    const stamp = clk && (clk.end || clk.start);
    if (!stamp) return fallback;
    const tip = '时间戳·主楼 AI 每楼隐形打点读回';
    const p = parseStampDate(stamp);
    if (!p) return { todayHtml: today(`今 ${escapeHtml(stamp)}`, tip), timeHtml: '' };   // 古风/无法解析 → 原样抬
    let swd = '';
    try {
        swd = (p.year && loadCalDesc() === DEFAULT_CAL)
            ? (ALM_WEEKDAYS[new Date(p.year, p.month - 1, p.day).getDay()] || '')
            : (ALM_WEEKDAYS[almWeekdayFor(p.month, p.day)] || '');
    } catch { swd = ''; }
    const ymd = `${p.year ? p.year + '年' : ''}${p.month}月${p.day}日`;
    const timeHtml = p.time ? `<span class="sp-dash-sum-time">${escapeHtml(p.time)}</span>` : '';
    return { todayHtml: today(`今 ${ymd}${swd ? ' ' + swd : ''}`, tip), timeHtml };
}
function _dashSummaryHtml(snap, hasDate, almOn, schOn, linesOn, flat = false, isLatest = false) {
    let head = '';
    if (hasDate) {
        const a = _dashAnchor(snap);
        let wd = '';
        try { wd = ALM_WEEKDAYS[almWeekdayFor(a.month, a.day)]; } catch { wd = ''; }
        // 天气：从点当天格（days[0].weather）拿，与大头 masthead 同源；拿不到就不显。历史楼用快照点 raw。
        let wxHtml = '';
        try {
            const raw = snap ? (snap.point || '') : readCacheRaw(getCacheKey());
            if (raw) {
                const wx = String(parseCalendar(raw).days?.[0]?.weather || '').trim();
                if (wx) wxHtml = `<span class="sp-dash-sum-wx">${weatherGlyph(wx)}</span>`;
            }
        } catch { /* 天气拿不到就不显 */ }
        const parts = storyClockHeadParts(isLatest, a, wd);
        head = `${parts.todayHtml}${wxHtml}${parts.timeHtml}`;
    }
    const chips = [];
    if (almOn) {
        const items = snap ? (snap.almanac || []) : loadAlmanac();
        chips.push(`<span class="sp-dash-sum-chip">轴${Array.isArray(items) ? items.length : 0}</span>`);
    }
    if (schOn) {
        let n = 0;
        try {
            const raw = snap ? (snap.point || '') : readCacheRaw(getCacheKey());
            const { days, future } = parseCalendar(raw || '');
            n = (days || []).reduce((s, d) => s + (d.events?.length || 0), 0) + (future?.events?.length || 0);
        } catch { n = 0; }
        chips.push(`<span class="sp-dash-sum-chip">点${n}</span>`);
    }
    if (linesOn) {
        let n = 0;
        try {
            const raw = snap ? (snap.line || '') : (readStore(getLinesCacheKey())?.raw || '');
            n = parseLines(raw).length;
        } catch { n = 0; }
        chips.push(`<span class="sp-dash-sum-chip">线${n}</span>`);
    }
    const chipsHtml = chips.length ? `<span class="sp-dash-sum-chips">${chips.join('')}</span>` : '';
    // 时间戳已抬进 head 的「今 …」那截（见 storyClockHeadParts），此处不再单列一段。
    const inner = `${head}${chipsHtml}`;
    // 只有日期没有任何区 → 纯日期条：<div> 包、无箭头、不可折叠（点了也没东西展开）。
    if (flat) return `<div class="sp-dash-summary sp-dash-summary-flat">${inner}</div>`;
    return `<summary class="sp-dash-summary">${inner}<i class="fa-solid fa-chevron-down sp-dash-sum-caret"></i></summary>`;
}

// 组一个仪表盘的完整 HTML（含外壳）。三区全空且无日期 → 返回 ''（该楼不挂框）。
// 外壳是 <details>：收起 = 一小条摘要（今 M/D 周X ☀ · 历N 点N 线N），展开 = 完整面板。
// 面板内点/线各自是 <details> 可折叠；历区顶行（今头+即将到来）+ 满宽六格条构成一组。
// 「今 M/D 周X ☀」在折叠条里恒显（只要有日期数据，与三个显示开关无关）；三区全关但有日期
// → 退成纯日期扁条（不可展开）。isLatest=true：最新楼、全功能；false：历史楼、只读。
function _buildInlineBoxHtml(snap, isLatest) {
    const readOnly = !isLatest;
    // 历区返回结构 {summary,upHtml,stripHtml}|null；点/线返回内层字符串或 ''。各自门控开关/空态。
    const alm        = _buildAlmanacBlockHtml(snap ? (snap.almanac || []) : null, snap ? snap.anchor : null);
    const schInner   = _buildScheduleBlockHtml(snap ? (snap.point || '') : null, readOnly);
    const linesInner = _buildLinesBlockHtml(snap ? (snap.line || '') : null, readOnly);
    // 标注池：AI 楼实际打捞到的暗历条目（快照 pool 字段驱动；最新楼读活账，空则不出块）。
    const ledgerInner = _buildLedgerBlockHtml(snap ? (snap.pool || []) : null, readOnly);

    // 日期是否真实存在（与显示开关无关）：决定折叠条头 + 纯日期扁条兜底。
    const hasDateData = _hasDateData(snap);
    if (!alm && !schInner && !linesInner && !ledgerInner && !hasDateData) return '';   // 啥也没有 → 不挂框

    // 展开面板里的大头 masthead：仅当有「历/点」区在场时出现（线独存时不显大头——edge case A）。
    const hasDateRegion = !!alm || !!schInner;

    const region = (cls, seg, inner) => inner
        ? `<details class="${cls} sp-dash-region" data-seg="${seg}" open>${inner}</details>`
        : '';

    // 顶行 + 历满宽条：历在场 → 顶行 [方形今头 + 历(summary+即将到来清单)]，六格条满宽落在顶行下方。
    // 无历但有点 → 顶行只放今头（点提供日期）。历/点全无 → 无顶行（面板从点/线区起）。
    let top = '', almStripRow = '';
    if (alm) {
        // 历整块：满宽 summary 头（点它折叠整个历单元）+ [方形今头 + 即将到来清单] 行 + 满宽六格条。
        // summary 提到顶行上方通栏铺满（原来缩在右列、今头上方左侧留空白）；今头与清单/六格条一起
        // 挂在 details 内，随历折叠一并收起——原生 <details> 折叠即隐藏，不再需要 :has() 联动隐藏六格条。
        const dashTop  = `<div class="sp-dash-top">${_dashMastheadHtml(snap)}<div class="sp-inline-body sp-alm-inline-body">${alm.upHtml}</div></div>`;
        const stripRow = alm.stripHtml ? `<div class="sp-alm-strip-region">${alm.stripHtml}</div>` : '';
        top = `<details class="sp-almanac-inline sp-dash-region" data-seg="almanac" open>${alm.summary}${dashTop}${stripRow}</details>`;
    } else if (hasDateRegion) {
        top = `<div class="sp-dash-top sp-dash-top-noalm">${_dashMastheadHtml(snap)}</div>`;
    }
    const schRegion   = region('sp-schedule-inline', 'schedule', schInner);
    const linesRegion = region('sp-lines-inline', 'lines', linesInner);
    const ledgerRegion = region('sp-ledger-inline', 'ledger', ledgerInner);

    // 段序：轴(top) → 标注池 → 点 → 线。标注池与日历同属「轴」范畴，紧贴轴放；点/线在其下。
    const body = `${top}${almStripRow}${ledgerRegion}${schRegion}${linesRegion}`;
    // 面板体为空但有日期数据（三区都关，只剩日期）→ 纯日期扁条：不可折叠，只显今头缩写。
    if (!body) {
        const flatBar = _dashSummaryHtml(snap, true, false, false, false, true, isLatest);
        const cls = 'sp-inline-box sp-dash sp-dash-flat' + (readOnly ? ' sp-inline-box-ro' : '');
        return `<div class="${cls}">${flatBar}</div>`;
    }

    const summary = _dashSummaryHtml(snap, hasDateData, !!alm, !!schInner, !!linesInner, false, isLatest);
    const cls = 'sp-inline-box sp-dash' + (readOnly ? ' sp-inline-box-ro' : '');
    // 默认折叠成一小条（不带 open）：只显摘要「今 M/D 周X ☀ · 历N 点N 线N」，点开才展开完整面板。
    return `<details class="${cls}">${summary}<div class="sp-dash-body">${body}</div></details>`;
}

// 用户楼「召回框」：外壳复用 .sp-inline-box/.sp-dash（与 AI 楼一摸一样形式），内含本回合召回注入回显（丰富版）。
// snap：历史用户楼传快照（读 snap.recall [{id,事由,类型,起始锚,现状}]）；最新用户楼传 null → 读活态 _ledgerInjectEcho。
// 字段照召回闭环：类型胶囊(上色) + 事由 + 起始 + 推测应至状态(现状)。纯只读——召回是给用户核对「AI 这轮收到了啥」，无逐条操作。
// 空召回 → 返回 ''（该用户楼不挂框；关注入/无召回的楼天然无此块）。
function _buildUserRecallBoxHtml(snap, isLatest) {
    if (getSettings().recallInlineEnabled === false) return '';   // 召回显隐开关（独立于 AI 楼标注池）关 → 不渲
    const src = snap ? snap.recall : _ledgerInjectEcho;
    const items = Array.isArray(src) ? src.filter(x => x && x.事由) : [];
    if (!items.length) return '';
    const cal = loadCalDesc();
    const rows = items.map(it => {
        const tcls = ledgerTypeClass(it.类型);   // 行挂类型类 → --ledger-c 级联给类型胶囊上色
        const type = it.类型 ? `<span class="sp-ledger-type">${escapeHtml(it.类型)}</span>` : '';
        const start = fmtLedgerAnchorDate(it.起始锚?.历日期, cal);
        const startTag = start ? `<span class="sp-inline-when">起 ${escapeHtml(start)}</span>` : '';
        return `<div class="sp-recall-row sp-ledger-${tcls}">
                <div class="sp-inline-head">${type}${startTag}</div>
                <div class="sp-inline-name">${escapeHtml(it.事由)}</div>
                ${it.现状 ? `<div class="sp-inline-desc">推测应为「${escapeHtml(it.现状)}」</div>` : ''}
            </div>`;
    }).join('');
    const summary = `<summary class="sp-inline-summary"><span class="sp-inline-title">召回</span><span class="sp-inline-count">${items.length} 条</span></summary>`;
    const cls = 'sp-inline-box sp-dash sp-recall-box' + (isLatest ? '' : ' sp-inline-box-ro');
    return `<details class="${cls}">${summary}<div class="sp-inline-body sp-recall-body">${rows}</div></details>`;
}

// strip 委托（历/点的 per-day tap）共用：从被点元素回溯它所在的框，判断是否历史楼只读框，
// 若是则取该楼快照，供 drawer 用快照数据渲染（历史楼 tap 展开看到的是那层楼当时的态，非活缓存）。
// 返回 { readOnly, snap }：readOnly=false（最新楼）时 snap=null，drawer 各 helper 退回读活缓存。
function _inlineTapCtx(el) {
    const box = el.closest?.('.sp-inline-box-ro');
    if (!box) return { readOnly: false, snap: null };
    const mesEl = el.closest('.mes');
    const mid = mesEl?.getAttribute('mesid');
    const snap = mid != null ? snapshot.readSnapshot(Number(mid)) : null;
    return { readOnly: true, snap };
}

// ═══════════════════════════════════════════════════════════════════════════
//  楼内渲染窗口控制器（render_depth 深度窗 + IntersectionObserver 视口懒挂）
// ═══════════════════════════════════════════════════════════════════════════
//
// 取代旧的「三套 syncLatest*/ensureLatest*/backfill* + anchor #chat MutationObserver 打地鼠」：
// 只在「深度窗口 ∩ 视口」内的 AI 楼挂统一框，超窗只留 message.extra 快照、不挂 DOM，滑回秒重建。
//
// 深度窗口：最新 N 层 AI 楼（N=有效 render_depth）。N=0（跟随酒馆助手且它设 0=全渲）→ 不设上限、全挂。
//   inlineRenderDepth>0 → 用它；=0 → 跟随酒馆助手 render.depth；读不到/为 0 → 用兜底常量。
// 视口：IntersectionObserver 观察每层 AI 楼，进视口才真正 build DOM、离开视口卸 DOM（省重排）。
//   深度窗外的楼直接不观察、不挂（连快照都不建 DOM，只静静躺在 extra 里）。
//
// 最新楼（chat 里最后一条 AI 楼）= 全功能、读活缓存；其余窗内楼 = 只读、读各自快照。

const INLINE_RENDER_DEPTH_FALLBACK = 6;   // 跟随酒馆助手但读不到/它为 0 时的内置默认深度
const INLINE_BOX_SELECTOR = '.sp-inline-box';

let _inlineIO = null;           // IntersectionObserver（视口懒挂）
let _inlineWinTimer = null;     // 深度窗重算防抖

// 有效渲染深度：inlineRenderDepth>0 直接用；=0 跟随酒馆助手 render.depth；后者读不到/为 0 → 兜底。
// 返回 0 = 不设深度上限（全渲，仅受视口约束）。
function effectiveRenderDepth() {
    const own = Number(getSettings().inlineRenderDepth);
    if (Number.isFinite(own) && own > 0) return Math.floor(own);
    // 跟随酒馆助手
    let th = 0;
    try { th = Number(extension_settings?.tavern_helper?.render?.depth) || 0; } catch { th = 0; }
    if (th > 0) return Math.floor(th);
    // 酒馆助手全渲(0)或读不到：构画自己也别无限渲，用兜底把窗口收住（用户诉求正是"别越翻越大"）
    return INLINE_RENDER_DEPTH_FALLBACK;
}

// 是否忽略隐藏楼（跟随酒馆助手的「忽略隐藏楼层」；读不到默认 true——隐藏楼本就不该显块）。
function inlineIgnoreHidden() {
    try {
        const v = extension_settings?.tavern_helper?.render?.depth_ignore_hidden;
        return v === undefined ? true : !!v;
    } catch { return true; }
}

// 当前深度窗内的楼元素集合（含 user 楼）。深度按 AI 楼数算（保原 AI 覆盖不变）：取最新 N 层可见 AI 楼，
// 窗口 = 从其中最早那层起、到 chat 末尾的连续尾段——自然含其间夹的 user 楼与末尾尚未回复的 user 楼。
// 忽略隐藏楼——不计数、不入窗。depth=0 → 窗口 = 全部可见楼。
// 返回 { winSet, latestAiEl, latestUserEl }：两个「最新」各自读活态（AI 楼活缓存/池，user 楼活召回）。
function computeInlineWindow() {
    const ignoreHidden = inlineIgnoreHidden();
    const allSel = ignoreHidden
        ? '#chat .mes:not([is_system="true"])'
        : '#chat .mes';
    const aiSel = ignoreHidden
        ? '#chat .mes:not([is_user="true"]):not([is_system="true"])'
        : '#chat .mes:not([is_user="true"])';
    const allFloors = [...document.querySelectorAll(allSel)];
    const aiFloors  = [...document.querySelectorAll(aiSel)];
    const userFloors = allFloors.filter(el => el.getAttribute('is_user') === 'true');
    const latestAiEl   = aiFloors.length   ? aiFloors[aiFloors.length - 1]     : null;
    const latestUserEl = userFloors.length ? userFloors[userFloors.length - 1] : null;
    const depth = effectiveRenderDepth();
    let win;
    if (depth > 0 && aiFloors.length > depth) {
        const earliestAi = aiFloors[aiFloors.length - depth];
        const startIdx = allFloors.indexOf(earliestAi);
        win = startIdx >= 0 ? allFloors.slice(startIdx) : allFloors;
    } else {
        win = allFloors;
    }
    return { winSet: new Set(win), latestAiEl, latestUserEl };
}

// 在某层楼 el 上挂/更新框。isLatest 决定全功能/只读、活缓存/快照；is_user 决定挂 AI 框(点/线/历/池)还是用户召回框。
// 幂等：内容 HTML 没变则不动 DOM（保住 <details> 展开态、断自激循环）。
function mountInlineBox(el, isLatest) {
    if (!pluginEnabled()) return;   // 插件总关：兜住 IO 回调直呼此处的路径
    const msgEl = el.querySelector('.mes_text');
    if (!msgEl) return;
    const isUser = el.getAttribute('is_user') === 'true';
    let snap = null;
    if (isLatest) {
        // 最新楼：先把当前活态冻进本楼快照（幂等），使「最新楼活态」与「该楼死历史」一致——
        // 将来滑走、它变历史楼时，读到的快照正是此刻这一屏（AI 楼冻点/线/历/池，用户楼冻召回）。
        const mid = el.getAttribute('mesid');
        if (mid != null) freezeSnapshotToFloor(mid);
    } else {
        const mid = el.getAttribute('mesid');
        snap = mid != null ? snapshot.readSnapshot(Number(mid)) : null;
        if (!snap) { unmountInlineBox(el); return; }   // 历史楼无快照（老楼 / 用户楼无召回）→ 不显框
    }
    const html = isUser ? _buildUserRecallBoxHtml(snap, isLatest) : _buildInlineBoxHtml(snap, isLatest);
    const existing = msgEl.querySelector(':scope > ' + INLINE_BOX_SELECTOR);
    if (!html) { if (existing) existing.remove(); return; }   // 全空 → 不挂
    if (existing && existing.dataset.sig === _boxSig(html, isLatest)) return;   // 幂等：签名没变不重建
    if (existing) existing.remove();
    const box = document.createElement('div');
    box.innerHTML = html;
    const boxEl = box.firstElementChild;
    if (!boxEl) return;
    boxEl.dataset.sig = _boxSig(html, isLatest);
    msgEl.appendChild(boxEl);
}

// 框签名：内容 HTML + 楼性质（最新/历史）。用于幂等判断，避免每次视口回调都重建 DOM。
function _boxSig(html, isLatest) {
    // 轻量：长度+性质+首尾片段（够区分内容变化，不必全串比对）。
    return `${isLatest ? 'L' : 'H'}:${html.length}:${html.slice(0, 24)}:${html.slice(-24)}`;
}

// 卸掉某层楼的统一框（滑出视口/超深度窗时）。
function unmountInlineBox(el) {
    el.querySelectorAll(INLINE_BOX_SELECTOR).forEach(b => b.remove());
}

// 全量重算渲染窗口：确定深度窗 + 观察窗内每层楼、卸掉窗外楼的框。防抖调用（refreshInlineWindow）。
function _recomputeInlineWindow() {
    if (!pluginEnabled()) { _clearAllInlineBoxes(); return; }   // 插件总关：兜住防抖定时器直呼此处的路径
    if (!_anyInlineSegOn()) { _clearAllInlineBoxes(); return; }   // 三段全关 → 清干净、不观察
    _ensureInlineIO();
    const { winSet, latestAiEl, latestUserEl } = computeInlineWindow();
    const allBoxes = document.querySelectorAll('#chat .mes:not([is_system="true"])');
    for (const el of allBoxes) {
        const isLatest = (el === latestAiEl || el === latestUserEl);
        if (winSet.has(el)) {
            _inlineIO.observe(el);   // 窗内：交给视口决定挂不挂（重复 observe 无害）
            // 已在视口内的窗内楼立即挂（IO 首帧可能延迟；最新楼尤其要秒出）
            if (isLatest || _inViewport(el)) mountInlineBox(el, isLatest);
        } else {
            _inlineIO.unobserve(el);
            unmountInlineBox(el);    // 窗外：卸框、停观察，只留 extra 快照
        }
    }
}

// 是否要观察/挂框：只看主开关。三个子开关只管「哪个区显示」，主开关开着时即便三区全关，
// 仍可能因有日期数据挂一条纯日期扁条，故观察与否只由主开关决定。
function _anyInlineSegOn() {
    return getSettings().inlineRenderEnabled !== false;
}

// 清掉所有 AI 楼上的统一框（含旧三类残块兜底）。
function _clearAllInlineBoxes() {
    document.querySelectorAll('#chat ' + INLINE_BOX_SELECTOR).forEach(b => b.remove());
    _removeAllInlineBlocks(); _removeAllAlmanacBlocks(); _removeAllScheduleBlocks();
}

// 粗判元素是否在视口内（IO 首挂前的即时兜底用）。
function _inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight);
}

// 懒建 IntersectionObserver：窗内楼进视口→挂框、离视口→卸框。取代旧 anchor MutationObserver 补块。
function _ensureInlineIO() {
    if (_inlineIO) return;
    _inlineIO = new IntersectionObserver((entries) => {
        // 每次回调都现算两个「最新楼」（流式/新楼会变）：最新 AI 楼读活缓存/池，最新 user 楼读活召回。
        const w = computeInlineWindow();
        for (const ent of entries) {
            const el = ent.target;
            const isLatest = (el === w.latestAiEl || el === w.latestUserEl);
            if (ent.isIntersecting) mountInlineBox(el, isLatest);
            else if (!isLatest) unmountInlineBox(el);   // 最新楼即便暂时离屏也保留（用户随时会滑回、且它在推进）
        }
    }, { root: null, rootMargin: '200px 0px', threshold: 0 });
}

// 对外主入口：数据变了 / 楼变了 / 开关变了 → 防抖重算窗口。取代旧 syncLatest*/ensure*/backfill*。
function refreshInlineWindow(immediate = false) {
    if (!pluginEnabled()) { _clearAllInlineBoxes(); return; }   // 插件总关：不挂任何楼内块（兜住定时器/观察者等一切调用方）
    clearTimeout(_inlineWinTimer);
    if (immediate) { _recomputeInlineWindow(); return; }
    _inlineWinTimer = setTimeout(_recomputeInlineWindow, 120);
}


// 点生成 / 锁定 / 新楼 / swipe / 切聊天 都汇流到这。渲染改由 refreshInlineWindow() 统一负责。
function syncLatestScheduleBlock(expectedChatId = null) {
    if (expectedChatId != null && getContext().chatId !== expectedChatId) return;
    refreshInlineWindow(true);
}

// ─── 线·伏笔潜伏注入（隐形注入主楼 AI）────────────────────────────────────────
// 把当前视角的活跃线（跳过终态 stage）以 SYSTEM 角色注入聊天上下文（IN_CHAT + depth），
// 让主楼 AI「心里有数」、把伏笔当暗流自然缓慢推进；聊天记录里不显示。默认关（opt-in）——
// 改 AI 行为且增加 token。刷新时机跟内联块同步（见 sync/backfill + 开关 handler）。
const LINES_INJECT_KEY   = 'sp_lines_latent';
const LINES_INJECT_DEPTH = 4;
function buildLinesInjectionText(lines) {
    const items = lines.map(l => {
        const parts = [`- ${l.name}（${l.type || '线'}·${l.stage}${l.stall ? '·停滞' : ''}）`];
        if (l.desc) parts.push(`  ${cleanText(l.desc)}`);
        if (l.next) parts.push(`  ${prefixNext(l.next, l.stall)}`);
        return parts.join('\n');
    }).join('\n');
    return [
        '【潜伏的伏笔·仅供你把握暗线走向，切勿直接引用或点破】',
        '以下是这个故事水面之下正在发展的伏笔。请把它们当作暗流，在接下来的叙事中',
        '自然、含蓄、缓慢地顺势推进：不要生硬提及、不要让角色直接谈论、更不要一次抖开。',
        items,
    ].join('\n');
}

// 重设潜伏注入。读当前视角活跃线；关闭或无活跃线时清空。幂等，可随处多调。
function refreshLinesInjection() {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const clear = () => ctx.setExtensionPrompt(LINES_INJECT_KEY, '');
    const s = getSettings();
    if (!injectEnabled()) { clear(); return; }   // 注入总闸（含插件总关）→ 一律不注入
    if (s.linesEnabled === false || s.linesInject !== true) { clear(); return; }
    let lines = [];
    try {
        const saved = readStore(getLinesCacheKey());
        lines = saved?.raw ? parseLines(saved.raw) : [];
    } catch { lines = []; }
    const active = lines.filter(l => l.name && !TERMINAL_STAGES.has(l.stage));
    if (!active.length) { clear(); return; }
    const pt = ctx.constants?.promptTypes?.IN_CHAT ?? 1;   // IN_CHAT
    const pr = ctx.constants?.promptRoles?.SYSTEM  ?? 0;   // SYSTEM
    ctx.setExtensionPrompt(LINES_INJECT_KEY, buildLinesInjectionText(active), pt, LINES_INJECT_DEPTH, false, pr);
}

// ─── 面·大纲自动注入（游标沿节点前进，隐形喂主楼 AI）──────────────────────────────
// 大纲本就是线性节点串（parseOutline 出 beats）。开启后每隔 N 楼独立判定一次剧情演到哪个
// 节点（游标只进不退、无信号不动），把「当前节点 + 下个方向」以 SYSTEM/IN_CHAT 注入主楼 AI，
// 让叙事自然顺着大纲走。游标存进大纲对象 {raw,ts,cursor}（随视角/聊天走）。默认关（opt-in，
// 每次判定多一次 API 调用）。跟线彻底解耦：独立监听、独立 abort、不受 linesEnabled 影响。
const OUTLINE_INJECT_KEY   = 'sp_outline_step';
const OUTLINE_INJECT_DEPTH = 4;
let   isJudgingOutline       = false;
let   outlineJudgeAbort      = null;
let   outlineLastJudgedMsgId = -1;   // 防重放：只判「比上次判过的更新的末楼」，切 chat 时设成末楼
let   outlineJudgeMsgCounter = 0;    // 攒够 interval 条真·新回复才跑一次判定（照 linesAiMsgCounter 套路）

// 历·自动确认日期的判定状态（抄 outline 那套三闸：防重入 + 单调 msgId + 攒够计数）。仅 API 兜底路用；戳优先路每楼直读不占这些。
let   isJudgingDate          = false; // 写 dateAnchor 的重入锁
let   almanacJudgeAbort      = null;
let   almanacLastJudgedMsgId = -1;
let   almanacJudgeCounter    = 0;

// 暗账·标注的判定状态（自成一套三闸：防重入 + 单调 msgId + 攒够计数）。与历/点判定各自独立。
let   isCapturingLedger      = false; // 标注重入锁
let   ledgerCaptureAbort     = null;
let   ledgerLastCapturedMsgId = -1;
let   ledgerCaptureCounter   = 0;
// 暗账·判定（刷现状）的一套闸，独立于标注：判定车重算「距今多久」、只让 AI 回该变的那几条。
let   isJudgingLedger        = false; // 判定重入锁
let   ledgerJudgeAbort       = null;
let   ledgerLastJudgedMsgId  = -1;
let   ledgerJudgeCounter     = 0;

// 判定间隔（缺省/非法 → 3；≥1）。独立于线的 getLinesInterval。
function getOutlineJudgeInterval() {
    const n = Number(getSettings().outlineJudgeInterval);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

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

// 读当前视角大纲游标（1-based；无大纲 → 0 表示「无」；有大纲无 cursor 字段 → 默认停在第 1 节点）。
function getOutlineCursor() {
    const saved = readStore(getOutlineCacheKey());
    if (!saved?.raw) return 0;
    const n = Number(saved.cursor);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);   // 含显式 0＝已取消狙击（无当前节点）
    return 1;                                                  // cursor 字段缺失/非法 → 默认落在第 1 节点
}
// 写游标（读-改-写，保留 raw/ts/其它字段）。clamp 到 [0, 节点数]：0＝取消狙击（无当前节点）。
function setOutlineCursor(cursor) {
    const key = getOutlineCacheKey();
    const saved = readStore(key);
    if (!saved?.raw) return;
    const total = parseOutline(saved.raw).length || 1;
    const c = Math.max(0, Math.min(total, Math.floor(cursor)));
    writeStore(key, { ...saved, cursor: c });
}

function buildOutlineInjectionText(beats, cursor) {
    const cur = beats[cursor - 1];
    const nxt = beats[cursor];   // 可能 undefined（已到最后一个节点）
    const fmt = b => `${b.time ? b.time + '·' : ''}《${b.title}》${b.type ? '·' + b.type : ''}`;
    const parts = [
        '【剧情大纲·当前进度参考·仅供你把握走向，切勿直接引用或点破】',
        '故事正沿一条大纲缓慢推进。请把下面的「当前节点」当作此刻所处的阶段，',
        '自然、含蓄地顺着它叙事；把「下个节点」当作隐约的方向，不要生硬跳进、不要提前抖开。',
        `当前节点：${fmt(cur)}` + (cur.scene ? `\n  ${cleanText(cur.scene)}` : ''),
    ];
    if (nxt) parts.push(`下个节点（方向，勿急）：${fmt(nxt)}` + (nxt.scene ? `\n  ${cleanText(nxt.scene)}` : ''));
    else     parts.push('已是大纲最后一个节点，可从容收束。');
    return parts.join('\n');
}

// 重设大纲注入。读当前视角大纲+游标；关闭或无大纲时清空。幂等，可随处多调。
function refreshOutlineInjection() {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const clear = () => ctx.setExtensionPrompt(OUTLINE_INJECT_KEY, '');
    if (!injectEnabled()) { clear(); return; }   // 注入总闸（含插件总关）→ 一律不注入
    if (getSettings().outlineInject !== true) { clear(); return; }
    let beats = [], cursor = 0;
    try {
        const saved = readStore(getOutlineCacheKey());
        if (saved?.raw) { beats = parseOutline(saved.raw); cursor = getOutlineCursor(); }
    } catch { beats = []; cursor = 0; }
    if (!beats.length || cursor < 1) { clear(); return; }
    const pt = ctx.constants?.promptTypes?.IN_CHAT ?? 1;
    const pr = ctx.constants?.promptRoles?.SYSTEM  ?? 0;
    ctx.setExtensionPrompt(OUTLINE_INJECT_KEY, buildOutlineInjectionText(beats, cursor), pt, OUTLINE_INJECT_DEPTH, false, pr);
}

// ─── 时间戳·时间锚点体系（第一片：注入 + 回读 + 只读显示）─────────────────────────
// 目标：给整个构画一个「跟着剧情走」的坚固时间源。做法＝强制注入一段提示词，让主楼 AI
// 每楼正文首尾各打一个 HTML 注释时间戳（<!-- SDC-start … --> / <!-- SDC-end … -->），
// 我们再从 chat 末尾往回扫读回。HTML 注释酒馆天然不渲染，无需像柏宝书那样加隐藏正则；
// 但注释必须留在 message.mes 里，下楼主模型才看得见上楼 end、以它为基准往前推。
// 命门（吸收自柏宝书方法论、提示词全自写）：
//   ① 起止双界——一楼是一段区间不是一个点，故首尾两个戳；
//   ② 标签留正文——绝不删，靠它让下楼继承基准，增量在模型脑内、输出成绝对值；
//   ③ 往回扫 + 兜底——读「当前时间」从末楼往前扫第一条可解析的（end 优先），漏了也不崩。
// 本片只做「注入 + 回读 + 历面板只读显示一行」，**不**改 almTodayAnchor 的 {month,day}
// 数据形状、**不**解析成结构、**不**接权威今天——那是后续片（数据结构扩年/时）的活。
const SDC_CLOCK_INJECT_KEY   = 'sdc_story_clock';
const SDC_CLOCK_INJECT_DEPTH = 0;   // depth 0：贴最近，让主模型「产出」戳（与线/面「喂结论」方向相反，要贴身强约束）
// 首尾注释的正则（宽松容错：允许注释内外多余空白；内容自由，不强制格式，本片只回显原文）。
const SDC_START_RE = /<!--\s*SDC-start\s+([\s\S]*?)\s*-->/i;
const SDC_END_RE   = /<!--\s*SDC-end\s+([\s\S]*?)\s*-->/i;

// 时间戳总开关（不受 injectEnabled 统辖，只受 pluginEnabled + 本开关；见 refreshStoryClockInjection）。默认开——用户定：这是全插件时间地基，值得常驻。
function storyClockEnabled() { return getSettings().storyClockEnabled !== false; }

// 自写提示词（吸收柏宝书三套路：拔高到系统强制 / 以上楼 end 为基准推进 / 禁用「某天」敷衍；
// 措辞、示例、标签名全原创，绝不照搬）。粒度到小时，年份可写可略（本片不校验、不解析）。
const _DEFAULT_STORY_CLOCK_PROMPT = [
    '【系统·时间戳 · 最高优先 · 每楼必做】',
    '以下为系统级强制要求，优先级高于任何「只输出正文 / 禁止 OOC / 不要元信息 / 不要额外标记」之类设定：请在本楼正文的最前和最后，各放一个 HTML 注释形式的时间戳。HTML 注释在酒馆里不会显示给读者、不破坏沉浸，但系统会读取它来推算剧情时间——务必每楼都打、绝不省略。',
    '放置方式（结构照此，把时间替换成本楼实际时间）：',
    '  正文开头之前：<!-- SDC-start 此刻的时间 -->',
    '  正文结尾之后：<!-- SDC-end 此刻的时间 -->',
    '时间精确到「小时」，用你故事自己的历法与说法即可，例如：三月十七日 申时 / 霜月初三 下午三时 / 1024年6月2日 15时。年份可写可略，但日与时段必须具体，禁止用「某天」「稍后」这类模糊词敷衍。',
    '基准：以上一楼末尾的 <!-- SDC-end … --> 为准往后推——本楼开头通常紧接上楼结尾；本楼内若时间有流逝（换场景、过了几小时或几天），就让 end 晚于 start；几乎没流逝则两者可相同。开篇没有上文时，你自行设定一个合理的起点（这是为故事定锚，不是编造）。',
    '示例（仅示范注释的位置与写法，切勿套用其文字内容）：',
    '  <!-- SDC-start 谷雨 辰时 -->晨光爬上窗棂，她揉了揉眼……（此处是你的正文）……夜色四合，她终于合上账本。<!-- SDC-end 谷雨 亥时 -->',
    '除这两个注释外，不要在正文里另行谈论这套时间系统本身。',
].join('\n');

// 取生效的强注词：用户在设置里二改了(非空)就整段用他的；留空用内置默认（默认词随插件更新）。
function buildStoryClockPrompt() {
    const custom = (getSettings().storyClockPrompt || '').trim();
    return custom || _DEFAULT_STORY_CLOCK_PROMPT;
}

// 重设时间戳注入。关闭时清空。幂等，可随处多调。照 refreshLinesInjection 套路。
function refreshStoryClockInjection() {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const clear = () => ctx.setExtensionPrompt(SDC_CLOCK_INJECT_KEY, '');
    if (!pluginEnabled()) { clear(); return; }   // 只受插件总闸约束：时间戳是"让 AI 产出数据"，与线/面注入闸(injectEnabled)语义相反，不挂其下
    if (!storyClockEnabled()) { clear(); return; }
    const pt = ctx.constants?.promptTypes?.IN_CHAT ?? 1;
    const pr = ctx.constants?.promptRoles?.SYSTEM  ?? 0;
    ctx.setExtensionPrompt(SDC_CLOCK_INJECT_KEY, buildStoryClockPrompt(), pt, SDC_CLOCK_INJECT_DEPTH, false, pr);
}

// 从单楼正文解析首尾戳。返回 { start, end }（各为去空白后的原文字符串，缺失=null）。本片不解析成结构。
function parseStoryClock(mes) {
    const s = String(mes || '');
    const sm = SDC_START_RE.exec(s);
    const em = SDC_END_RE.exec(s);
    return {
        start: sm ? sm[1].trim() : null,
        end:   em ? em[1].trim() : null,
    };
}

// 从 chat 末尾往回扫，取最近一楼「可解析出至少一个戳」的 AI 楼。end 优先作「当前时间」。
// 漏了/坏了不崩：某楼无戳就继续往上找；全无 → 返回 null（显示层据此不显示这一行）。
function latestStoryClock() {
    const msgs = getContext().chat || [];
    let scanned = 0;
    for (let i = msgs.length - 1; i >= 0 && scanned < ALM_CHAT_SCAN_LIMIT; i--) {
        const msg = msgs[i];
        if (!msg || msg.is_user || !msg.mes) continue;
        scanned++;
        const { start, end } = parseStoryClock(msg.mes);
        if (start || end) return { start, end, floor: i };
    }
    return null;
}

// 从最近一楼的戳解析出结构化 {month,day}。end 优先(当前时间)、退 start。无戳/解析不出 → null（交回兜底）。
function storyClockDate() {
    let clk = null;
    try { clk = latestStoryClock(); } catch { return null; }
    if (!clk) return null;
    return parseJudgedDate(clk.end) || parseJudgedDate(clk.start);
}

const OUTLINE_JUDGE_PROMPT = (cur, nxt, curScene, nxtScene) =>
`请暂停角色扮演，作为剧情分析助手，判断上面的最近对话是否已经把剧情推进到了「下一个节点」。
当前节点：${cur}${curScene ? '（' + curScene + '）' : ''}
下一个节点：${nxt}${nxtScene ? '（' + nxtScene + '）' : ''}
只有当最近剧情已经明确进入或跨过「下一个节点」所描述的阶段时，才算推进。
若剧情仍停留在当前节点、或在写与主线无关的日常/支线，都算「没推进」。
只回答一个词：推进 或 未推进。不要解释。`;

// 判定当前视角大纲是否该前进一个节点。fire-and-forget，照 runGenerateDashed 的 abort/chatId 守卫。
async function runJudgeOutlineStep() {
    if (isJudgingOutline) return;
    const chatIdSnap = getContext().chatId;
    const saved = readStore(getOutlineCacheKey());
    if (!saved?.raw) return;
    const beats = parseOutline(saved.raw);
    const cursor = getOutlineCursor();
    if (!beats.length || cursor < 1 || cursor >= beats.length) return;   // 已在最后节点 → 无「下一个」可判
    const cur = beats[cursor - 1], nxt = beats[cursor];
    const myCtrl = outlineJudgeAbort = new AbortController();
    isJudgingOutline = true;
    try {
        const ctx = getContext();
        const userName = ctx.name1 || '用户', charName = ctx.name2 || '角色';
        const cfg = loadUtilityCfg();   // 机械任务：大纲推进判定可分流到轻量预设，未设则=主 API
        if (!cfg.url || !cfg.key) { isJudgingOutline = false; outlineJudgeAbort = null; return; }
        const fmt = b => `${b.time ? b.time + '·' : ''}《${b.title}》`;
        const prompt = OUTLINE_JUDGE_PROMPT(fmt(cur), fmt(nxt), cleanText(cur.scene || ''), cleanText(nxt.scene || ''));
        const raw = await callCustomApi(ctx, prompt, cfg, userName, charName, myCtrl.signal);
        if (outlineJudgeAbort !== myCtrl) return;                          // 被更新的判定取代
        if (getContext().chatId !== chatIdSnap) { isJudgingOutline = false; outlineJudgeAbort = null; return; }
        isJudgingOutline = false; outlineJudgeAbort = null;
        // 只认明确「推进」；含「未/没/不/无 推进」一律不动（无信号不动的兜底）
        const ans = String(raw || '').trim();
        const advanced = /推进/.test(ans) && !/(未|没|不|无)\s*推进/.test(ans);
        if (advanced) {
            setOutlineCursor(cursor + 1);
            // 全量通知：面游标真前进一节才弹
            if (getSettings().notifyMode === 'full') showToast('面已自动推进到下一节点 · 请注意查看');
            refreshOutlineInjection();
            if (outlineMode) {   // 面板开着看大纲 → 重渲染让高亮跟着走
                const s2 = readStore(getOutlineCacheKey());
                if (s2?.raw) { cachedOutline = renderOutline(s2.raw, getOutlineCursor()); setOutlineBody(cachedOutline); }
            }
        }
    } catch (err) {
        if (outlineJudgeAbort !== myCtrl) return;          // 被更新的判定取代 → 别动状态
        isJudgingOutline = false; outlineJudgeAbort = null;
        if (err?.name === 'AbortError') return;            // 中止 / 切档 → 不算失败
        if (getContext().chatId !== chatIdSnap) return;    // 已切 chat → 作废，别弹
        // 判定失败也弹（不动游标，纯提示）：同日期判定，每 N 楼跑一次、用户未必盯着，失败要让他知道。
        // isError toast 不受通知三档静音；下一轮攒够计数会自动再判，无需手动重试。
        showToast('面自动推进判定失败，请检查 API 或网络', null, true);
    }
}

// 时旅专用：根据正文在全部既有节点中重新定位游标，允许前进或回退。
async function runRelocateOutlineCursor(promptAddon = '', externalSignal = null) {
    const cacheKey = getOutlineCacheKey();
    const saved = readStore(cacheKey);
    if (!saved?.raw) return { status: 'skipped' };
    const beats = parseOutline(saved.raw);
    const current = getOutlineCursor();
    if (!beats.length || current < 1) return { status: 'skipped' };
    const ctx = getContext();
    const chatIdSnap = ctx.chatId;
    const cfg = loadUtilityCfg();
    if (!cfg.url || !cfg.key) return { status: 'failed', error: new Error('未配置 API') };
    outlineJudgeAbort?.abort();
    const myCtrl = outlineJudgeAbort = new AbortController();
    const removeAbortBridge = bridgeAbortSignal(externalSignal, myCtrl);
    isJudgingOutline = true;
    try {
        const nodes = beats.map((beat, index) => `${index + 1}. ${beat.time ? beat.time + '·' : ''}《${beat.title}》${beat.scene ? `：${cleanText(beat.scene)}` : ''}`).join('\n');
        const prompt = `请暂停角色扮演，作为剧情分析助手，根据最近正文判断故事在以下既有大纲节点中最符合哪一个。\n\n【既有节点】\n${nodes}\n\n当前游标：${current}\n\n只能回答一个已有节点编号。允许选择当前节点、之前节点或之后节点；不得新增、改写、合并或删除节点。证据不足时回答当前游标编号。\n\n${promptAddon}`;
        const raw = await callCustomApi(ctx, prompt, cfg, ctx.name1 || '用户', ctx.name2 || '角色', myCtrl.signal);
        if (outlineJudgeAbort !== myCtrl || myCtrl.signal.aborted || externalSignal?.aborted || getContext().chatId !== chatIdSnap) return { status: 'cancelled' };
        const latest = readStore(cacheKey);
        if (!latest?.raw || latest.raw !== saved.raw) return { status: 'cancelled' };
        const match = String(raw || '').trim().match(/^\s*(\d+)\s*[。.！!?]?\s*$/);
        const next = match ? Number(match[1]) : NaN;
        if (!Number.isInteger(next) || next < 1 || next > beats.length) throw new Error('AI 未返回有效节点编号');
        if (next === current) return { status: 'unchanged' };
        if (myCtrl.signal.aborted || externalSignal?.aborted || getContext().chatId !== chatIdSnap || outlineJudgeAbort !== myCtrl) return { status: 'cancelled' };
        setOutlineCursor(next);
        refreshOutlineInjection();
        cachedOutline = renderOutline(saved.raw, next);
        if (outlineMode) setOutlineBody(cachedOutline);
        return { status: 'updated' };
    } catch (error) {
        if (outlineJudgeAbort !== myCtrl || error?.name === 'AbortError' || myCtrl.signal.aborted || getContext().chatId !== chatIdSnap) return { status: 'cancelled' };
        return { status: 'failed', error };
    } finally {
        removeAbortBridge();
        if (outlineJudgeAbort === myCtrl) outlineJudgeAbort = null;
        isJudgingOutline = false;
    }
}

const DATE_JUDGE_PROMPT =
`请暂停角色扮演，作为剧情分析助手，只做一件事：判断以上最近的对话里，故事此刻发生在哪一天。
只回答「当前剧情日期」，格式为 M月D日（例如 3月15日）；年份不重要、无需回答。
若最近对话中并无明确日期线索、无法确定具体月日，就只回答「未知」。
不要解释，不要输出任何多余文字。`;

// 自定义历法下，正文用的是自定义月名（如「霜月」），公历式发问会答非所问。带上历法描述、
// 并允许 AI 用「第M月D日」或月名作答；内置公历返回上面的原版 prompt（零行为变化）。
function buildDateJudgePrompt() {
    const calDesc = getCalDescInjectText();
    if (!calDesc) return DATE_JUDGE_PROMPT;
    return `请暂停角色扮演，作为剧情分析助手，只做一件事：判断以上最近的对话里，故事此刻发生在哪一天。
本世界观使用自定义历法（非公历）——${calDesc}
只回答「当前剧情日期」，格式为「第M月D日」（M=第几个月的序号，D=该月第几日，例如第3月15日），或直接用上面列出的月名，如「霜月15日」；年份不重要、无需回答。
若最近对话中并无明确日期线索、无法确定具体月日，就只回答「未知」。
不要解释，不要输出任何多余文字。`;
}

// 从 judge 回答里抠出 {month, day}。先认「M月D日」，再兜底走 extractDayFromTime（认 3/15、
// 2024-3-15、三月十五 等格式）。认不出 / 明确「未知」→ 返回 null（＝保持上次锚点不动）。
function parseJudgedDate(ans) {
    const s = String(ans || '').trim();
    if (!s || /未知|无法|不确定|不清楚|没有|无明确/.test(s)) return null;
    const cal = loadCalDesc();
    // 「第M月D日」（自定义历序号式）或「M月D日」（公历/序号式）：M 一律当「第几个月」序号。
    let m = s.match(/第?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (m) {
        const md = almValidMonthDay({ month: +m[1], day: +m[2] }, cal);
        if (md) return md;
    }
    // 自定义月名式（如「霜月15日」）：在历法月名里找匹配，取其序号。仅自定义历需要（公历月名即「N月」，上面已covered）。
    if (cal !== DEFAULT_CAL) {
        for (let i = 0; i < cal.months.length; i++) {
            const nm = String(cal.months[i].name || '').trim();
            if (!nm) continue;
            const nmEsc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const mm = s.match(new RegExp(nmEsc + '\\s*(初[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]+|\\d{1,2})\\s*日?'));
            if (mm) {
                const da = /^\d+$/.test(mm[1]) ? +mm[1] : (mm[1].startsWith('初') ? _cnToNumber(mm[1].slice(1)) : _cnToNumber(mm[1]));
                const md = almValidMonthDay({ month: i + 1, day: da }, cal);
                if (md) return md;
            }
        }
    }
    // 中文数字「M月D日/初X」：三月十七日 / 冬月初三 → 序号月+日（与 extractDayFromTime 古代中文段同源，但不要求年份）。
    const cnMD = s.match(/(正|冬|腊|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]+)\s*月\s*(初[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]+)\s*日?/);
    if (cnMD) {
        const mo = (cnMD[1] in _CN_MONTH_ALIAS) ? _CN_MONTH_ALIAS[cnMD[1]] : _cnToNumber(cnMD[1]);
        const da = cnMD[2].startsWith('初') ? _cnToNumber(cnMD[2].slice(1)) : _cnToNumber(cnMD[2]);
        const md = almValidMonthDay({ month: mo, day: da }, cal);
        if (md) return md;
    }
    return monthDayFromDayKey(extractDayFromTime(s));
}

// 落地检测到的剧情日期：变了才写/才弹 → 共享善后（runAnchorAftermath 内含点连带跟随）。
// 戳优先路（almanacJudge 每楼直读戳）与 API 兜底路（runJudgeDateStep）共用。
function applyDetectedDate(charKey, md) {
    if (!charKey || !md) return { status: 'unresolved' };
    const prev = getDateAnchor(charKey);
    if (prev && prev.month === md.month && prev.day === md.day) return { status: 'unchanged', date: { month: md.month, day: md.day } }; // 日期没变 → 免重渲染
    setDateAnchor(charKey, md.month, md.day);
    // 全量通知：真把「今天」改了才弹（上面 prev 相等已 return，到这里必是真变）
    if (getSettings().notifyMode === 'full') showToast(`剧情日期已自动更新为 ${calMonthName(loadCalDesc(), md.month)}${md.day}日 · 请注意查看`);
    runAnchorAftermath();   // 共享善后：刷历条/点条/历面板 + 点连带跟随今天
    return { status: 'updated', date: { month: md.month, day: md.day } };
}

// 戳优先·落地：戳开且最新楼扫到可解析戳 → 直读落地到 dateAnchor（零 API、幂等，未变即 no-op）。
// 必须在**每次**最新楼定型时跑（新楼 / 重roll / swipe），否则显示读活戳跳了、轴读陈旧锚点没跟——
// 锚点是 almTodayAnchor ①′ 最高优先，压过活戳，刷新也不会自愈（论坛：戳 920、轴停 919、刷新无效）。
// 返回 true=已走戳优先路（无论是否真改锚点），false=戳关/无戳（交回 API 兜底判断）。
function relandStoryClockAnchor() {
    if (!storyClockEnabled()) return false;
    const md = storyClockDate();
    if (!md) return false;
    applyDetectedDate(charStableKey(getContext()), md);
    return true;
}

// 历·API 兜底判定当前剧情日期（仅在读不到戳、almanacAutoDetect 开时调用）：抄 runJudgeOutlineStep 的 abort/chatId/重入守卫。
// fire-and-forget，失败静默。识别不到日期 → 不动锚点（保留上次值），符合「无信号不动」的兜底。
async function runJudgeDateStep({ signal: externalSignal = null } = {}) {
    if (isJudgingDate) return { status: 'skipped' }; // 历、点共一把锁：都写同一个锚点，不必并发
    const ctx = getContext();
    const charKey = charStableKey(ctx);
    if (!charKey) return { status: 'skipped' };      // 无卡（群聊/无角色）→ 锚点无处落键，跳过
    const chatIdSnap = ctx.chatId;
    const cfg = loadUtilityCfg();                    // 机械任务：可分流到轻量预设，未设则=主 API
    if (!cfg.url || !cfg.key) return { status: 'failed', error: new Error('未配置 API') };
    const setAbort = c => { almanacJudgeAbort = c; };
    const getAbort = ()  =>   almanacJudgeAbort;
    const myCtrl = new AbortController(); setAbort(myCtrl);
    const abortFromCaller = () => myCtrl.abort();
    if (externalSignal?.aborted) myCtrl.abort();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    isJudgingDate = true;
    const done = () => { isJudgingDate = false; setAbort(null); };
    try {
        const userName = ctx.name1 || '用户', charName = ctx.name2 || '角色';
        // historyLimit=4：只需最近几楼就能读出剧情内日期，省 token（与历生成同量级）。
        const raw = await callCustomApi(ctx, buildDateJudgePrompt(), cfg, userName, charName, myCtrl.signal, 4);
        if (getAbort() !== myCtrl) return { status: 'cancelled' };           // 被更新的判定取代
        if (getContext().chatId !== chatIdSnap || myCtrl.signal.aborted) { done(); return { status: 'cancelled' }; }         // 已切 chat，丢弃结果
        done();
        if (myCtrl.signal.aborted) return { status: 'cancelled' };
        const md = parseJudgedDate(raw);
        if (!md) return { status: 'unresolved' };                           // 识别不到 → 保持上次不动
        const applied = applyDetectedDate(charKey, md);                    // 变了才写/才弹 + 点连带跟随（共享咽喉）
        if (myCtrl.signal.aborted) return { status: 'cancelled' };
        return { ...applied, date: md };
    } catch (err) {
        if (getAbort() !== myCtrl) return { status: 'cancelled' }; // 被更新的判定取代 → 新判定接管状态，别动
        done();
        if (err?.name === 'AbortError' || myCtrl.signal.aborted) return { status: 'cancelled' };            // 中止 / 切档 → 不算失败
        if (getContext().chatId !== chatIdSnap) return { status: 'cancelled' }; // 已切 chat → 结果作废，别弹
        // 判定失败也弹（不动锚点，纯提示）：判定按每 N 楼跑，用户未必每楼盯着，失败要让他知道去查 API。
        // isError toast 不受通知三档静音；下一轮 AI 回复攒够计数会自动再判，无需手动重试。
        showToast('剧情日期自动确认失败，请检查 API 或网络', null, true);
        return { status: 'failed', error: err };
    } finally {
        externalSignal?.removeEventListener('abort', abortFromCaller);
    }
}

// ═══ 暗账·标注 ═════════════════════════════════════════════════════════════════
// 构画 AI 从最近正文里捞「需按时间追踪」的新事件，标注入 sp-ledger（此时·此物·此状态）。
// 起始锚 = 此刻楼层 + 历「今天」(almTodayAnchor)，钉死不改；判定/注入是后续切片。
// 触发：每 N 楼自动车(runLedgerCaptureStep 无参) + 历面板「暗账」页手动「立即标注」(manual=true)。
const LEDGER_CAPTURE_FLOORS = 6;   // 标注窗口：读最近几楼 AI 正文找新事件（比日期判定的 4 稍宽，捞得全）

// 全角/半角顿号逗号分隔 → 去空数组（牵扯/标签用）。
function splitCnList(v) {
    return String(v || '').split(/[、,，;；]/).map(x => x.trim()).filter(Boolean);
}
// 事由归一化（JS 侧兜底去重键）：去空白。中文无大小写，够用。
function normGist(s) { return String(s || '').replace(/\s+/g, ''); }
// 最新 AI 楼下标（无 AI 楼 → 末楼下标兜底）。
function latestAiFloorId() {
    const chat = getContext().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user) return i;
    return chat.length - 1;
}
// 现有活跃条目摘要（喂进提示词供 AI 去重）。
function listActiveLedgerBrief() {
    const act = ledger.listEntries();   // 默认只活跃
    if (!act.length) return '（暂无，本次都是新登记）';
    return act.map(e => `- ${e.事由}${e.标签?.length ? `（${e.标签.join('、')}）` : ''}`).join('\n');
}
// 已了结条目摘要（喂进提示词，防「用户归档过的事又被重新捞进新池」）。空则回空串，调用端据此省掉整段。
function listClosedLedgerBrief() {
    const closed = ledger.listEntries({ includeClosed: true }).filter(e => e.状态 === '已了结');
    if (!closed.length) return '';
    return closed.map(e => `- ${e.事由}${e.标签?.length ? `（${e.标签.join('、')}）` : ''}`).join('\n');
}

// 两个标注提示词（首次建账 / 日常增量）共用的两段——单一来源，防两处 7 字段格式漂移。
const LEDGER_EVENT_TYPES = `【什么算刻度事件】会随时间推移改变状态、或到某天该发生的事，典型三类：
- 持续状态：身体伤情 / 病症、怀孕、显著且会延续的情绪等——会随天数自然演变（如割伤→结痂→愈合）。
- 约定待办：约好要做的事（哪天见面、答应帮忙），无论有没有定下具体日期都要记。
- 周期：规律反复发生的事（月经、发薪、值班），带大致周期天数。
【主语永远是「人」】每条都登记在某个人物身上——记 TA 的状态，或 TA 牵扯的约定/周期。不要给物品单独立条（如「桌上有把枪」「仓库存着粮」不记）；但物品作用到人身上的状态要记（如「A 中了毒、尚未解」「B 戴着诅咒项链、受其束缚」）。`;

const LEDGER_FIELD_SPEC = `- 每个事件一行，用全角竖线「｜」分隔 7 个字段，顺序固定：
  事由｜类型｜牵扯｜标签｜现状｜到期｜周期
  · 类型：持续状态 / 约定待办 / 周期（只能三选一，原样写这三个词之一）
  · 牵扯：涉及的人物，多个用顿号「、」分隔；没有就留空
  · 标签：检索关键词，多个用「、」分隔（如：伤、左手、身体）
  · 现状：此刻状态一句话（如「新伤口，仍在流血」）
  · 到期：只有这件事有一个「你会特意关心的具体未来日子」才填——约定的赴约日、或周期里你想知道「下次哪天」的（月经、发薪、值班）。纯背景例行、天天都在做、不用盯某天的（每日洗漱更衣、每天喂马、日常晨练）到期留空。填时写大致哪天（如「第3月20日」，本世界观自定义历法请按其月名/月序），说不清也留空
  · 周期：仅周期类填天数（如 30）；其它类型留空`;

function buildLedgerCapturePrompt() {
    const closed = listClosedLedgerBrief();
    const closedSection = closed
        ? `\n【已了结·别重新登记】
下面这些已经完结、或被用户手动归档了。默认**一律别再登记**；只有正文里出现了**明确的新进展**（旧事重新启动、或又发生了一次全新的独立事件）才重新记，并在现状里点明「新」在哪：
${closed}\n`
        : '';
    return `请暂停角色扮演，作为剧情分析助手，只做一件事：从以上最近的对话正文里，捞取「需要按时间追踪」的新事件，记入「刻度」。

${LEDGER_EVENT_TYPES}

【已在刻度上的（不要重复登记）】
${listActiveLedgerBrief()}
${closedSection}
【规则】
- 只登记上面对话里【新出现】的，或【虽同名但明显是另一次独立事件】的；已在刻度上的同一件事跳过。
- **同一件事只记一条**：判断「是不是同一件事」看的是**事情本身**，不是措辞——同一个人的同一桩事，哪怕换了说法、换了角度、详略不同，也算重复。这有两层：① 别登记与上面清单里已有的重复；② 你这一次别把一件事拆成两三条近义的分别登记。
- 宁可多记，但「多记」指的是多记【确实是新的、不同的】事——拿不准是不是新事就记下；不是把同一件事重复记，也不是把已了结/已归档的翻出来重记。
${LEDGER_FIELD_SPEC}
- 若没有任何新事件可登记，只回一个字：无
不要解释，不要输出表头，不要输出多余文字。`;
}

// 首次建账专用（账上全空时用，见 runLedgerCaptureStep 的 isFirst 分支）：除了对话正文里的已发生事件，
// 额外指向【角色卡背景资料 / 世界书设定】——把开局就存在、却不会在正文里「新冒出来」的既定机制（周期硬规则、
// 死线、长期状态/契约）一并种进账。角色卡/世界书本就在 buildMessages 的 system 里，故零额外 API，只换这段指令。
function buildLedgerFirstScanPrompt() {
    return `请暂停角色扮演，作为剧情分析助手，只做一件事：这是本故事**第一次**建立「刻度」，请把所有【需要长期按时间追踪】的事项一次性记入刻度，覆盖两个来源：

【来源一·既定机制（最重要，务必别漏）】从【角色卡背景资料 / 场景 / 世界书设定】里，找出开局就存在、需要长期盯着时间的**规则型设定**，尤其：
- 周期性硬规则：如「每 N 天必须做某事，否则触发严重后果」「每逢某日会发生某事」——务必抓出周期天数。
- 死线 / 倒计时：如「X 天内必须完成某事，否则……」。
- 长期状态 / 契约 / 诅咒 / 期限：会随时间推进演变或到期的既定设定。
这类往往是这张卡的核心机制、甚至关乎生死，最该盯——哪怕最近对话还没提到，也要从设定里登记下来。

【来源二·已发生事件】再从最近对话正文里，捞取已经出现、需要追踪的事件（同下三类）。

${LEDGER_EVENT_TYPES}

【规则】
- 宁可多记：拿不准也记下，漏记的代价比多记大；既定机制哪怕暂时还没触发也要记。
${LEDGER_FIELD_SPEC}
- 若确实没有任何可登记的，只回一个字：无
不要解释，不要输出表头，不要输出多余文字。`;
}

// 解析标注回答 → 松散条目数组（起始锚由 runLedgerCaptureStep 补钉）。认全角竖线分隔行，其余行忽略。
function parseLedgerCapture(raw) {
    const s = String(raw || '').trim();
    if (!s || /^无[。.！!]?$/.test(s)) return [];
    const out = [];
    for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t || !t.includes('｜')) continue;                 // 只认带全角竖线的登记行（跳过表头/寒暄）
        if (/^事由\s*｜/.test(t)) continue;                     // AI 若误输出表头，跳过
        const cols = t.split('｜').map(x => x.trim());
        const 事由 = cols[0];
        if (!事由) continue;
        const entry = {
            事由,
            类型: ledger.TYPES.includes(cols[1]) ? cols[1] : '持续状态',
            牵扯: splitCnList(cols[2]),
            标签: splitCnList(cols[3]),
            现状: cols[4] || '',
        };
        const cyc = parseInt(cols[6], 10);
        if (Number.isFinite(cyc) && cyc > 0) entry.周期长度 = cyc;
        const due = parseJudgedDate(cols[5] || '');            // 复用日期解析（认「第M月D日」/月名式）；相对日「三天后」认不出即留空
        if (due) entry.到期锚 = { 历日期: due };
        out.push(entry);
    }
    return out;
}

// 标注一次：抄 runJudgeDateStep 的 abort/chatId/重入守卫。manual=true 时（历面板手动点）无论通知档位都反馈结果。
// fire-and-forget，失败静默（自动车）/弹错（手动）。
async function runLedgerCaptureStep(manual = false, travelContext = null) {
    if (isCapturingLedger) return { status: 'skipped' };
    const ctx = getContext();
    const charKey = charStableKey(ctx);
    if (!charKey) { if (manual) showToast('当前没有角色卡，无法标注', null, true); return { status: 'skipped' }; }
    const chatIdSnap = ctx.chatId;
    const cfg = loadCfg();                            // 标注＝从正文捞事件（内容活）→ 走内容生成 API，不分流机械
    if (!cfg.url || !cfg.key) { if (manual) showToast('请先在设置中填写 API', null, true); return { status: 'failed', error: new Error('未配置 API') }; }
    const myCtrl = new AbortController(); ledgerCaptureAbort = myCtrl;
    const removeAbortBridge = bridgeAbortSignal(travelContext?.signal, myCtrl);
    isCapturingLedger = true;
    const done = () => { isCapturingLedger = false; if (ledgerCaptureAbort === myCtrl) ledgerCaptureAbort = null; };
    try {
        const userName = ctx.name1 || '用户', charName = ctx.name2 || '角色';
        // 账上全空 = 本卡首次建账：这一趟连角色卡/世界书里的既定机制（周期硬规则、死线、长期状态）一并扫入，
        // 而非只捞对话正文里的新事件。零额外 API——角色卡/世界书本就在 buildMessages 的 system 里，只是换一段指令。
        const isFirst = ledger.listEntries({ includeClosed: true }).length === 0;
        const prompt = appendTravelPromptContext(isFirst ? buildLedgerFirstScanPrompt() : buildLedgerCapturePrompt(), travelContext);
        const raw = await callCustomApi(ctx, prompt, cfg, userName, charName, myCtrl.signal, LEDGER_CAPTURE_FLOORS, { ...(travelContext || {}), noAlmanac: true });
        if (ledgerCaptureAbort !== myCtrl || myCtrl.signal.aborted || travelContext?.signal?.aborted) return { status: 'cancelled' };
        if (getContext().chatId !== chatIdSnap) { done(); return { status: 'cancelled' }; }
        done();
        if (myCtrl.signal.aborted || travelContext?.signal?.aborted || getContext().chatId !== chatIdSnap) return { status: 'cancelled' };
        const picked = parseLedgerCapture(raw);
        if (!picked.length) { if (manual) showToast('未发现可登记的新事件'); return { status: 'unchanged' }; }
        const floor = latestAiFloorId();
        const today = travelContext?.targetDate || almTodayAnchor();
        const seen = new Set(ledger.listEntries({ includeClosed: true }).map(e => normGist(e.事由)));
        const added = [];
        for (const p of picked) {
            const g = normGist(p.事由);
            if (!g || seen.has(g)) continue;                               // JS 侧兜底去重（同名事由）
            seen.add(g);
            p.起始锚 = { 楼层: floor, 历日期: today };                     // 底账·钉死
            p.现状锚 = { 楼层: floor, 历日期: today };                     // 入库即以起始为现状锚（判定车后续刷）
            const e = ledger.addEntry(p);
            if (e) added.push(e);
        }
        if (!added.length) { if (manual) showToast('没有新事件（都已在刻度上）'); return { status: 'unchanged' }; }
        // 通知：手动必反馈；自动仅 full 档弹（照三档静音约定）。
        if (manual || getSettings().notifyMode === 'full') {
            showToast(`刻度标注 ${added.length} 条：${added.map(e => e.事由).join('、')} · 请注意查看`);
        }
        refreshLedgerInjection();   // 新条目入账 → 重算注入集（关/空时内部自清）
        refreshInlineWindow(true);  // 标注池变了 → 刷楼内框（最新 AI 楼读活账重挂标注池）
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
        return { status: 'updated' };
    } catch (err) {
        if (ledgerCaptureAbort !== myCtrl) return { status: 'cancelled' };
        done();
        if (err?.name === 'AbortError' || travelContext?.signal?.aborted) return { status: 'cancelled' };
        if (err?.spDisabled) return { status: 'skipped' };
        if (getContext().chatId !== chatIdSnap) return { status: 'cancelled' };
        showToast('刻度标注失败，请检查 API 或网络', null, true);
        return { status: 'failed', error: err };
    } finally {
        removeAbortBridge();
    }
}

// ═══ 暗历③·判定·刷现状 ═══════════════════════════════════════════════════════
// 每 N 楼把活跃条目连同「距今几天」（纯 JS 算好，LLM 不擅长日期差）喂给构画 AI，
// 只让它回「状态该随时间变化的那几条」的新现状/了结/周期滚动。CODE 算数、AI 只下结论——正是暗历立意。
const LEDGER_JUDGE_FLOORS = 4;   // 判定读最近几楼正文（比标注窄，够看「刚发生了什么」即可）

// 距今天数：从起始锚(历日期)到今天，环形不涉年（<1 年场景足够）。缺锚/非法 → null。
function ledgerDaysSince(entry) {
    const a = entry?.起始锚?.历日期;
    if (!a || !Number.isFinite(+a.month) || !Number.isFinite(+a.day)) return null;
    const t = almTodayAnchor();
    return almDaysUntil(t.month, t.day, a);
}
// 到期口径：{天数, 过期}。无到期锚 → null；今天到期 → {天数:0}；已过 → {过期:true}。环形取短弧判过期。
function ledgerDueInfo(entry) {
    const d = entry?.到期锚?.历日期;
    if (!d || !Number.isFinite(+d.month) || !Number.isFinite(+d.day)) return null;
    const t = almTodayAnchor();
    const to = almDaysUntil(d.month, d.day, t);          // 今天→到期
    const since = almDaysUntil(t.month, t.day, d);       // 到期→今天
    if (to === 0) return { 天数: 0, 过期: false };
    return to <= since ? { 天数: to, 过期: false } : { 天数: since, 过期: true };
}
// 参与判定的活跃条目（排除「用户锁」——用户手改过的不许判定车再动，照点/线锁机制）。
function listJudgeableLedger() {
    return ledger.listEntries().filter(e => e.锁 !== '用户锁');
}
// 一行摘要（喂进判定提示词）。天数由 CODE 算好塞进去，AI 据此下结论、不自己算日期。
function fmtLedgerForJudge(e) {
    const since = ledgerDaysSince(e);
    const sinceStr = since == null ? '起始不明' : (since === 0 ? '今天登记' : `距登记 ${since} 天`);
    const du = ledgerDueInfo(e);
    const dueStr = !du ? '' : (du.天数 === 0 ? '·今天到期' : (du.过期 ? `·已过期 ${du.天数} 天` : `·还有 ${du.天数} 天到期`));
    const cyc = e.周期长度 ? `·周期 ${e.周期长度} 天` : '';
    const who = e.牵扯?.length ? `·涉及 ${e.牵扯.join('、')}` : '';
    return `[${e.id}] ${e.事由}（${e.类型}）：现状「${e.现状 || '—'}」｜${sinceStr}${dueStr}${cyc}${who}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  检索·注入前置选择器（挑「哪几条」喂主楼 AI——全亮注入会撑爆 token 且喧宾夺主）
// ═══════════════════════════════════════════════════════════════════════════
// 策略＝场景感知：读最近几楼正文，正文提到某条的牵扯/标签就加权，叠在「临近到期/用户锁/
// 近期登记」基础权重上，砍到 N 条上限；活跃条少于上限时全带（兜底）。已了结由 listEntries
// 天然排除。留 RAG 口子：scoreLedgerEntry 整个可换（将来接 arg 检索只改这一处打分器）。

// 最近 N 楼 AI 正文拼成一段（去标记）。供场景加权命中判断；只读、无副作用。
function _recentLedgerSceneText(nFloors = LEDGER_JUDGE_FLOORS) {
    const chat = getContext().chat || [];
    const s = getSettings();
    const stripOpts = { keepTags: s.keepTags, extraTags: s.extraTags };
    const parts = [];
    for (let i = chat.length - 1; i >= 0 && parts.length < nFloors; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;   // 只读 AI 楼，跳隐藏行
        const raw = String(m.mes || '');
        if (!raw.trim()) continue;
        const cleaned = memory.stripTags(raw, stripOpts).trim();
        if (cleaned) parts.unshift(cleaned);
    }
    return parts.join('\n');
}

// 单条打分 / 相关度门槛 / 选注入集（scoreLedgerEntry·isLedgerSalient·selectLedgerForInject）
// 已抽出到 business/ledger/select.js（纯逻辑，经 bindLedgerSelect 注入 ledgerDueInfo/ledgerDaysSince）。

// 组注入文本：分两组（①持续身心状态·带距今天数+现应如何 ②约定/周期·倒计时）。
// 天数由 CODE 用 ledgerDaysSince/ledgerDueInfo 算好塞进去，主楼 AI 只据此表达、不自算日期。
function buildLedgerInjectionText(picked, _cal) {
    const states = picked.filter(e => e.类型 === '持续状态');
    const timed  = picked.filter(e => e.类型 !== '持续状态');
    const fmtState = e => {
        const since = ledgerDaysSince(e);
        const sinceStr = since == null ? '' : (since === 0 ? '（今天）' : `（距今 ${since} 天）`);
        const who = e.牵扯?.length ? `${e.牵扯.join('、')}：` : '';
        return `- ${who}${e.事由}${sinceStr}——当前应为「${e.现状 || '—'}」`;
    };
    const fmtTimed = e => {
        const du = ledgerDueInfo(e);
        const dueStr = !du ? '（未定期）' : (du.天数 === 0 ? '（今天到期）' : (du.过期 ? `（已过期 ${du.天数} 天未了）` : `（还有 ${du.天数} 天到期）`));
        const cyc = e.周期长度 ? `·约 ${e.周期长度} 天一轮` : '';
        const who = e.牵扯?.length ? `${e.牵扯.join('、')}：` : '';
        return `- ${who}${e.事由}${dueStr}${cyc}——现状「${e.现状 || '—'}」`;
    };
    const blocks = [
        '【暗线·时间账·仅供你把握角色此刻的身心与待办，切勿直接念出编号或「系统」字样】',
        '以下是随剧情时间推移、此刻仍牵动角色的事。请把它们自然融进叙事与角色状态，别生硬罗列、别让角色开口谈论这套记录本身。',
    ];
    if (states.length) blocks.push('◆ 正持续的身心状态（按登记至今的天数，表现出它此刻该有的样子）：\n' + states.map(fmtState).join('\n'));
    if (timed.length)  blocks.push('◆ 临近的约定与周期（按倒计时，该临近就流露惦记、该发生就顺势发生）：\n' + timed.map(fmtTimed).join('\n'));
    return blocks.join('\n');
}

// ─── 暗历·主楼潜伏注入（镜像 refreshLinesInjection）────────────────────────────
const LEDGER_INJECT_KEY   = 'sp_ledger_remind';
const LEDGER_INJECT_DEPTH = 2;   // 浅层（别到 depth 0 盖用户 input）；比线/面(4)更贴身，让「此刻状态」离生成更近

// 本回合实际注入的条目回显（丰富版 [{id,事由,类型,起始锚,现状}]）——供用户楼「召回框」显示起始时间+推测应至状态。
// refreshLedgerInjection 每次重算时刷新；清空/关闭时置空。
let _ledgerInjectEcho = [];

// 重设暗历潜伏注入。受注入总闸 injectEnabled + 本模块 ledgerInject opt-in 双门控；关/空清空。幂等，可随处多调。
function refreshLedgerInjection() {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const clear = () => { ctx.setExtensionPrompt(LEDGER_INJECT_KEY, ''); _ledgerInjectEcho = []; };
    if (!injectEnabled()) { clear(); return; }               // 注入总闸（含插件总关）→ 一律不注入
    if (getSettings().ledgerInject !== true) { clear(); return; }
    const picked = selectLedgerForInject(ledger.listEntries(), _recentLedgerSceneText(), almTodayAnchor());
    if (!picked.length) { clear(); return; }
    const pt = ctx.constants?.promptTypes?.IN_CHAT ?? 1;
    const pr = ctx.constants?.promptRoles?.SYSTEM  ?? 0;
    ctx.setExtensionPrompt(LEDGER_INJECT_KEY, buildLedgerInjectionText(picked, loadCalDesc()), pt, LEDGER_INJECT_DEPTH, false, pr);
    // 回显丰富版（多带起始锚/现状，供召回框显示起始时间+推测应至状态；picked 是完整条目，字段齐）。
    _ledgerInjectEcho = picked.map(e => ({ id: e.id, 事由: e.事由, 类型: e.类型, 起始锚: e.起始锚, 现状: e.现状 }));
}


function buildLedgerJudgePrompt() {
    const lines = listJudgeableLedger().map(fmtLedgerForJudge).join('\n');
    return `请暂停角色扮演，作为剧情连续性助手，只做一件事：根据下面【已登记事件】各自「距今过了多少天」和最近正文，判断哪些事件的状态**该随时间变化了**，只输出需要更新的那几条。

【已登记事件】（方括号是编号，天数已由系统算好，你不必自己算日期）
${lines || '（暂无活跃事件）'}

【怎么判断该不该变】
- 持续状态：随天数自然演变（如割伤：当天流血→两三天结痂→约一周愈合；病症、孕期同理）。到该愈合/该缓解的天数了就更新现状；已彻底痊愈/结束的标「了结」。
- 约定待办：到期或已过期还没兑现→在现状里点出「今天该…／已过 X 天未…」；正文里已兑现→标「了结」。
- 周期：到期即本轮该发生（如月经）；正文印证发生了→更新现状并标「滚周期」（系统会把下次到期顺延一个周期）。
- 退场／翻篇（跨类型通用，务必保守）：某条对应的人物或事件已明显退出当前剧情（角色离场且短期不会回、情节段落翻篇、长期不再牵动剧情）——即便没有明确结果，也标「了结」让它淡出，账只留此刻仍牵动剧情的事。反过来：只是最近几楼碰巧没提、但人物仍在场或事情仍悬着的，一律「维持」，别误清还悬着的事。

【输出格式】只输出状态**有变化**的条目，每条一行，全角竖线「｜」分隔 4 段，顺序固定：
  编号｜新现状｜动作｜新到期
  · 编号：原样抄方括号里的（如 L3），不带方括号
  · 新现状：更新后的一句话状态（如「伤口已结痂，隐隐作痒」）
  · 动作：维持 / 了结 / 滚周期（三选一，原样写）
  · 新到期：仅在「约定待办」改期、或有明确下次日子的周期（月经、发薪、值班）本轮滚动时填（如「第3月20日」，自定义历按其月名/月序）；永久例行周期（每日洗漱、每天喂马这类，本就没盯着某天）与其余情况一律留空
- 没有任何该变的，就只回一个字：无
不要解释、不要输出表头、不要输出没变化的条目。`;
}

// 判定动作归一：严格等值匹配会把 AI 的近义/多字写法（「结束」「完结」「滚动」）静默降级成「维持」，
// 让本该了结的条目一直悬在活账里注入。故按关键词宽松认——先认「滚周期」再认「了结」，都不像才退
// 「维持」（安全默认·不动账）。canonical 的「维持/了结/滚周期」三串各自命中对应分支，行为不变。
function normalizeJudgeAction(raw) {
    const s = String(raw || '').replace(/\s+/g, '');
    if (!s) return '维持';
    if (/滚|周期|顺延|续期/.test(s)) return '滚周期';
    if (/了结|了断|结束|完结|终结|终止|结案|兑现|愈合|痊愈|康复|已了/.test(s)) return '了结';
    return '维持';
}

// 解析判定回答 → 改动数组。认全角竖线行；编号剥方括号；动作走 normalizeJudgeAction 宽松归一。
function parseLedgerJudge(raw) {
    const s = String(raw || '').trim();
    if (!s || /^无[。.！!]?$/.test(s)) return [];
    const out = [];
    for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t || !t.includes('｜')) continue;
        if (/^编号\s*｜/.test(t)) continue;                    // AI 若误输出表头，跳过
        const cols = t.split('｜').map(x => x.trim());
        const id = cols[0].replace(/[\[\]【】]/g, '').trim();
        if (!id) continue;
        const 动作 = normalizeJudgeAction(cols[2]);
        const chg = { id, 现状: cols[1] || '', 动作 };
        const due = parseJudgedDate(cols[3] || '');
        if (due) chg.到期 = due;
        out.push(chg);
    }
    return out;
}

// 判定一次：抄 runLedgerCaptureStep 的 abort/chatId/重入守卫。manual=true（手动点）无论通知档位都反馈结果。
// fire-and-forget，失败静默（自动车）/弹错（手动）。无活跃条目直接跳过、不空烧 API。
async function runLedgerJudgeStep(manual = false, travelContext = null) {
    if (isJudgingLedger) return { status: 'skipped' };
    const ctx = getContext();
    const charKey = charStableKey(ctx);
    if (!charKey) { if (manual) showToast('当前没有角色卡，无法判定', null, true); return { status: 'skipped' }; }
    if (!listJudgeableLedger().length) { if (manual) showToast('暂无可判定的活跃事件'); return { status: 'skipped' }; }
    const chatIdSnap = ctx.chatId;
    const cfg = loadCfg();                            // 判定 API 干的是「据天数写新现状」(内容活)；时间重算是上面零-API 的 JS → 走内容生成 API
    if (!cfg.url || !cfg.key) { if (manual) showToast('请先在设置中填写 API', null, true); return { status: 'failed', error: new Error('未配置 API') }; }
    const myCtrl = new AbortController(); ledgerJudgeAbort = myCtrl;
    const removeAbortBridge = bridgeAbortSignal(travelContext?.signal, myCtrl);
    isJudgingLedger = true;
    const done = () => { isJudgingLedger = false; if (ledgerJudgeAbort === myCtrl) ledgerJudgeAbort = null; };
    try {
        const userName = ctx.name1 || '用户', charName = ctx.name2 || '角色';
        const raw = await callCustomApi(ctx, appendTravelPromptContext(buildLedgerJudgePrompt(), travelContext), cfg, userName, charName, myCtrl.signal, LEDGER_JUDGE_FLOORS, { ...(travelContext || {}), noAlmanac: true });
        if (ledgerJudgeAbort !== myCtrl || myCtrl.signal.aborted || travelContext?.signal?.aborted) return { status: 'cancelled' };
        if (getContext().chatId !== chatIdSnap) { done(); return { status: 'cancelled' }; }
        done();
        if (myCtrl.signal.aborted || travelContext?.signal?.aborted || getContext().chatId !== chatIdSnap) return { status: 'cancelled' };
        const changes = parseLedgerJudge(raw);
        if (!changes.length) { if (manual) showToast('本轮没有事件需要更新'); return { status: 'unchanged' }; }
        const cal = loadCalDesc();
        const floor = latestAiFloorId();
        const today = travelContext?.targetDate || almTodayAnchor();
        const applied = [];
        for (const c of changes) {
            if (myCtrl.signal.aborted || travelContext?.signal?.aborted || getContext().chatId !== chatIdSnap || ledgerJudgeAbort !== myCtrl) return { status: 'cancelled' };
            const e = ledger.getEntry(c.id);
            if (!e || e.状态 === '已了结' || e.锁 === '用户锁') continue;   // 目标须活跃、非用户锁（AI 乱报编号也挡掉）
            // 静音（暂停埋入）条遇「了结」判定：整条跳过——不改现状、不归档。它没被注入、天然不在近景，
            // 退场/翻篇规则几乎必然误判它「该了结」；静音语义正是「留着、只是别提」。若只吞 closeEntry、仍套 patch，
            // 现状会被每轮改写成退场话术。维持/滚周期不受此限（后台照常跟进）。
            if (e.静音 === true && c.动作 === '了结') continue;
            const patch = { 现状锚: { 楼层: floor, 历日期: today } };       // 现状锚每次刷到今天（起始锚永不动）
            if (c.现状) patch.现状 = c.现状;
            if (c.动作 === '滚周期' && e.周期长度 > 0 && e.到期锚?.历日期) {
                const base = e.到期锚.历日期;                               // 保相位：从上次到期顺延一个周期
                patch.到期锚 = { 历日期: almMonthDayFromDoy(almDayOfYear(base.month, base.day, cal) + e.周期长度, cal) };
                // 无到期锚的周期（永久例行，如每日洗漱、每天喂马）不凭空造死线：滚周期只更现状，到期恒空。
            } else if (c.到期 && c.动作 !== '滚周期') {                       // 新到期只服务「约定改期」；滚周期的下次日子只由上面顺延，AI 给的到期一律忽略
                patch.到期锚 = { 历日期: c.到期 };
            }
            ledger.updateEntry(e.id, patch);
            if (c.动作 === '了结') ledger.closeEntry(e.id);                  // 静音条已在上方跳过，此处到不了
            applied.push(e.事由);
        }
        if (!applied.length) { if (manual) showToast('没有需要更新的事件'); return { status: 'unchanged' }; }
        // 通知：手动必反馈；自动仅 full 档弹（照三档静音约定）。
        if (manual || getSettings().notifyMode === 'full') {
            showToast(`刻度刷新 ${applied.length} 条：${applied.join('、')} · 请注意查看`);
        }
        refreshLedgerInjection();   // 现状/了结变了 → 重算注入集（关/空时内部自清）
        refreshInlineWindow(true);  // 标注池现状变了 → 刷楼内框（最新 AI 楼读活账重挂标注池）
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
        return { status: 'updated' };
    } catch (err) {
        if (ledgerJudgeAbort !== myCtrl) return { status: 'cancelled' };
        done();
        if (err?.name === 'AbortError' || travelContext?.signal?.aborted) return { status: 'cancelled' };
        if (err?.spDisabled) return { status: 'skipped' };
        if (getContext().chatId !== chatIdSnap) return { status: 'cancelled' };
        showToast('刻度判定失败，请检查 API 或网络', null, true);
        return { status: 'failed', error: err };
    } finally {
        removeAbortBridge();
    }
}

// ─── 共享锚点善后 ───────────────────────────────────────────────────────────
// 任何一处改「今天」锚点（自动判定 applyDetectedDate / 历面板 ±1天·改·恢复自动）后都走这里，统一善后：
//   1) 刷楼内历条 / 点条、历面板；2) 点恒跟随今天——把点重排到今天（点纯下游连带，无独立开关）。
// 点连带走 syncPointToToday(true)：其自带「点没生成过就 no-op」「_almSyncingPoint 重入合并」「pointState.isGenerating/
// chatId/abort」守卫，fire-and-forget 安全；不占前台 pointState.isGenerating 锁。故这里无脑调、由它自己判断要不要真重生成。
function runAnchorAftermath() {
    syncLatestAlmanacBlock();
    syncLatestScheduleBlock();
    if (axisState.almanacMode) renderAlmanacPanel();
    // 点·后台自动跟随「今天」：仅在开关开时才自动重排点（每次一 API）；关（默认）时点原地不动，
    // 用户想对齐今天时去点面板手动刷新即可。syncPointToToday 内部还有「点从未生成过就 no-op」守卫，双保险。
    // 时旅首楼：点重排由显式步骤接管（POINT step），此处跳过自动跟随，防重复 API。
    if (getSettings().scheduleAutoDetect === true) {
        const floorId = (getContext().chat?.length ?? 1) - 1;
        const pointSuppressed = Number.isInteger(floorId) && floorId >= 0 && isAutomationSuppressed(floorId, AUTOMATION_MODULES.POINT);
        if (!pointSuppressed) syncPointToToday(true);
    }
}

// 方案 B·点随「今天」按钮同步（历面板「同步到点」键触发，非自动）：
// schedulePointNeedsSync() —— 判定当前视角的点是否落后于共享「今天」，历面板据此决定要不要在今天条冒出「同步到点」键。
//   条件：当前视角已生成过点 + 点的 StartDate 月/日 ≠ 今天。refresh-only：空白页不算「需同步」。
//   与「点·自动检测」开关解耦：不论点自动检测开没开，只要点落后今天就给这枚手动补的入口——
//   点关+历开时历自己推进今天、点原地不动，正是靠它手动追上；点开时它作为自动跟随的兜底也会短暂出现。
function schedulePointNeedsSync() {
    const cacheKey = getCacheKey(currentView, charViewName);
    if (!cacheKey) return false;
    const raw = readStore(cacheKey)?.raw || '';
    if (!raw) return false;                                        // 没生成过点 → 不凭空催
    // 文本直接比 StartDate 月/日 vs 今天，不经 new Date（避开 UTC 时区漂移）。
    const sdMatch = raw.match(/StartDate:\s*\d{4}-(\d{2})-(\d{2})/);
    if (!sdMatch) return false;                                    // 无绝对起始日 → 无从对齐今天
    const today = almTodayAnchor();
    return !(parseInt(sdMatch[1], 10) === today.month && parseInt(sdMatch[2], 10) === today.day);
}

// syncPointToToday() —— 用户在历面板点「同步到点」触发：后台把当前视角的点重生成，StartDate 强钉到「今天」，
// 让「点」从今天起排 7 天、与「历」同一天。反馈全在历（按钮态「同步中…」+ toast），结果落在点。
// 绝不占用 pointState.isGenerating（前台 UI 锁，sidebar 切换靠它挡）——后台占了会把整个面板卡死；防 race 靠自带 abort + 落地前重查。
let _autoRegenSchedAbort = null;
async function syncPointToToday(auto = false, travelContext = null) {
    const allowPendingFollowup = travelContext?.allowPendingFollowup !== false;
    if (axisState._almSyncingPoint) {
        if (allowPendingFollowup) axisState._almSyncPending = true;
        return { status: 'skipped' };
    }
    if (pointState.isGenerating) { if (!auto) showToast('点正在生成，稍候再同步', null, true); return { status: 'skipped' }; }
    const view = currentView, charName = charViewName;
    const cacheKey = getCacheKey(view, charName);
    if (!cacheKey) return { status: 'skipped' };
    const raw = readStore(cacheKey)?.raw || '';
    if (!raw) return { status: 'skipped' };                  // refresh-only：没生成过 → 不凭空建
    _autoRegenSchedAbort?.abort();
    const myCtrl = _autoRegenSchedAbort = new AbortController();
    const removeAbortBridge = bridgeAbortSignal(travelContext?.signal, myCtrl);
    const chatIdSnap = getContext().chatId;
    axisState._almSyncingPoint = true;
    if (axisState.almanacMode) renderAlmanacPanel();                   // 今天条：「同步到点」→「同步中…」
    $in('#sp-body .sp-refresh-schedule').addClass('sp-refresh-busy');   // 点面板此刻正开着也即时置灰，不等重渲染
    try {
        const ctx = getContext();
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { showToast('未配置主 API，无法同步点', null, true); return { status: 'failed', error: new Error('未配置主 API') }; }
        const userName = ctx.name1 || '用户';
        const cName = view === 'char' ? (charName || ctx.name2 || '角色') : (ctx.name2 || '角色');
        const subject = view === 'char' ? cName : userName;
        const pinnedEvents = [];
        const pc = parseCalendar(raw);
        for (const d of pc.days) for (const ev of d.events) if (ev.pin) pinnedEvents.push(ev);
        if (pc.future) for (const ev of pc.future.events) if (ev.pin) pinnedEvents.push(ev);
        const fresh = await generate(ctx, userName, cName, view, myCtrl.signal, pinnedEvents, travelContext);
        if (_autoRegenSchedAbort !== myCtrl || myCtrl.signal.aborted || travelContext?.signal?.aborted) return { status: 'cancelled' };
        if (pointState.isGenerating) return { status: 'cancelled' };    // 期间前台手动生成插了队 → 让前台赢
        if (getContext().chatId !== chatIdSnap) return { status: 'cancelled' }; // 已切 chat → 丢弃
        const today = travelContext?.targetDate || almTodayAnchor();
        const merged = forceStartDate(mergePinnedPoints(raw, fresh), today.month, today.day);
        writeStore(cacheKey, { raw: merged, userName: subject, ts: Date.now() });
        syncLatestScheduleBlock();                           // 楼内点条即时刷到新日期
        // 修 pointState.cachedSchedule 陈旧：只要同步的视角 == 当前视角就刷缓存——哪怕此刻停在历面板，
        // 回头切到点也拿到新版（不再限「点面板正开着」才更新，否则切过去会看到旧点）。
        if (currentView === view && (view !== 'char' || charViewName === charName)) {
            pointState.cachedSchedule = renderSchedule(merged, subject, view);
            const onPointPanel = !axisState.almanacMode && !outlineMode && !linesMode && !spaceMode && !theaterMode && !anchorMode;
            if (onPointPanel && $(`#${MODAL_ID}`).is(':visible')) setBody(pointState.cachedSchedule);
        }
        if (auto ? getSettings().notifyMode === 'full' : getSettings().notifyMode !== 'off') showToast(`点已同步到 ${calMonthName(loadCalDesc(), today.month)}${today.day}日`);
        return { status: 'updated', targetDate: today };
    } catch (err) {
        // 报错弹窗：同步失败要让用户看见——#41 自愈也靠它，静默会把真问题藏掉。
        // 排除中止 / 被更新的同步取代 / 切档——那些不是失败。isError toast 不受 notifyMode 静默。
        if (err?.name !== 'AbortError' && _autoRegenSchedAbort === myCtrl && getContext().chatId === chatIdSnap && !travelContext?.signal?.aborted) {
            showToast('点同步到今天失败，请重试', null, true);
        }
        return { status: err?.name === 'AbortError' || travelContext?.signal?.aborted ? 'cancelled' : 'failed', error: err };
    }
    finally {
        removeAbortBridge();
        if (_autoRegenSchedAbort === myCtrl) _autoRegenSchedAbort = null;
        axisState._almSyncingPoint = false;
        if (axisState.almanacMode) renderAlmanacPanel();               // 恢复今天条（同步键消失，或仍需同步则复现）
        $in('#sp-body .sp-refresh-schedule').removeClass('sp-refresh-busy');   // 同步结束：解除刷新圆圈置灰
        // 自对账：同步在飞期间被丢过新的「今天」推进 → 若点仍落后今天且环境未变，收尾补一轮，保证都开态最终收敛（不会永久停在旧日期）。
        const pending = axisState._almSyncPending;
        axisState._almSyncPending = false;
        if (shouldRunPendingPointFollowup({
            pending,
            allowPendingFollowup,
            signalAborted: travelContext?.signal?.aborted,
            chatSame: getContext().chatId === chatIdSnap,
            pointGenerating: pointState.isGenerating,
            needsSync: schedulePointNeedsSync(),
        })) {
            syncPointToToday(auto, travelContext);
        }
    }
}

// ─── 锚·收藏楼层：每楼收藏入口（快照捕获）────────────────────────────────────────
// 楼层头部（char 名旁）挂一枚「坐标」按钮，点一下 = 抓 live .mes_text.innerHTML 快照存服务器。
// 已收藏则点按跳锚面板定位。按钮态靠内存里的 _anchorSavedKeys（`chatId::mesid`）同步。
// 扫描幂等：已有按钮的楼跳过；靠 CHAR_MSG_RENDERED / CHAT_CHANGED / MutationObserver 三路补齐。

const ANCHOR_SVG_INNER = '<path d="M6 3.5 L6 18 L20.5 18"/><circle cx="14" cy="9.4" r="1.9" fill="currentColor" stroke="none"/>';
function anchorSvg(cls) {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ANCHOR_SVG_INNER}</svg>`;
}

const anchorFloorKey = (chatId, mesid) => `${chatId ?? ''}::${mesid ?? ''}`;

function getChatDisplayName() {
    const el = document.querySelector('#selected_chat_pole, #chat_name_pole, .current_chat_name');
    const v = el?.value || el?.textContent?.trim();
    if (v) return v;
    return getContext().chatId || '当前聊天';
}

// 重载「已收藏楼层键」缓存（异步读坐标索引），并把当前 DOM 里的按钮态刷成一致。
async function refreshAnchorSavedKeys() {
    try {
        const items = await anchor.getAllItems();
        _anchorSavedKeys = new Set(items.map(it => anchorFloorKey(it.chatId, it.messageId)));
    } catch (err) { console.warn('[SP anchor] 读取已收藏键失败:', err); return; }
    const chatId = getContext().chatId;
    document.querySelectorAll('#chat .mes .sp-anchor-btn').forEach(btn => {
        const mid = btn.closest('.mes')?.getAttribute('mesid');
        const saved = _anchorSavedKeys.has(anchorFloorKey(chatId, mid));
        btn.classList.toggle('sp-anchor-saved', saved);
        btn.title = saved ? '已收藏 · 点击取消' : '收藏此楼';
    });
}

// 给每条 AI 楼补「收藏此楼」按钮（幂等）。关掉入口开关则清干净。
function scanAnchorButtons() {
    if (!pluginEnabled()) {   // 插件总关：清掉并不再补锚点入口（兜住 _anchorObserver 的突变回调）
        document.querySelectorAll('#chat .sp-anchor-btn').forEach(el => el.remove());
        return;
    }
    if (getSettings().anchorInlineBtn === false) {
        document.querySelectorAll('#chat .sp-anchor-btn').forEach(el => el.remove());
        return;
    }
    const chatId = getContext().chatId;
    document.querySelectorAll('#chat .mes[is_user="false"]').forEach(mes => {
        if (mes.querySelector('.sp-anchor-btn')) return;
        const target = mes.querySelector('.mes_buttons, .extraMesButtons, .name_text')
            || mes.querySelector('.mes_block') || mes;
        const mid   = mes.getAttribute('mesid');
        const saved = _anchorSavedKeys.has(anchorFloorKey(chatId, mid));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sp-anchor-btn' + (saved ? ' sp-anchor-saved' : '');
        btn.title = saved ? '已收藏 · 点击取消' : '收藏此楼';
        btn.innerHTML = anchorSvg('sp-anchor-btn-svg');
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            onAnchorButtonClick(mes);
        });
        target.appendChild(btn);
    });
}

// 用 ST 自己的 messageFormatting 把这楼的原始文本重新渲染一遍，从结果里抠出 <style> 块。
// 这是美化 CSS 最可靠的来源：正则替换出的 <style> 经 ST 管线会得到 .mes_text .custom-* 选择器，
// 但落进 DOM 后常被页面优化机制（酒馆助手等）挪走去重，收藏时楼内已经没有了；而 messageFormatting
// 是纯字符串函数，随时能重放出完整带样式的 HTML，不依赖页面此刻的样式放在哪。
function collectMessageStyles(messageId) {
    try {
        const ctx = getContext();
        const msg = ctx?.chat?.[messageId];
        if (!msg || typeof ctx?.messageFormatting !== 'function') return '';
        const html = ctx.messageFormatting(String(msg.mes ?? ''), msg.name, !!msg.is_system, !!msg.is_user, messageId);
        return [...String(html).matchAll(/<style>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
    } catch { return ''; }
}

// 收集页面里作用于消息美化的 CSS 规则（选择器含 .custom- 或 .mes_text 的），冻进快照。
// 背景：正则美化输出的 <style> 经 ST 管线（encodeStyleTags→DOMPurify 改名 class→decodeStyleTags 加
// .mes_text 前缀）后会被酒馆助手等从楼层里挪走去重，收藏时楼内已无 style，只剩 custom-* 结构（中间态）。
// 快照渲染在 :host{all:initial} 的 Shadow DOM 里，页面样式够不着，必须在收藏时把这些规则一并带走。
// 注意：不能用 `if (r.cssRules) 递归` 判断分组规则——支持 CSS nesting 的浏览器里普通样式规则
// 也带（空的）cssRules，会把所有规则都当成分组跳过；这里以 selectorText 有无区分。
function collectCustomCss() {
    const seen = new Set();
    const walk = (rules, sink) => {
        for (const r of rules) {
            try {
                const sel = r.selectorText;
                if (sel) {
                    // 只收 .custom-* 或 .mes_text 的**后代**规则；裸 .mes_text{} 是容器级主题规则，
                    // 冻进快照会反过来命中快照容器本身（它也挂着 mes_text class），顶掉容器内边距
                    const ok = sel.includes('.custom-') || /\.mes_text\s+\S/.test(sel);
                    if (ok && !seen.has(r.cssText)) {
                        seen.add(r.cssText);
                        sink.push(r.cssText);
                    }
                } else if (r.cssRules && r.cssRules.length) {
                    // @media/@supports/@layer 等分组：保留条件头，只收里面命中的规则
                    const inner = [];
                    walk(r.cssRules, inner);
                    if (inner.length) {
                        const head = String(r.cssText || '').split('{', 1)[0].trim();
                        sink.push(head ? `${head} {\n${inner.join('\n')}\n}` : inner.join('\n'));
                    }
                }
            } catch { }
        }
    };
    const out = [];
    for (const sheet of document.styleSheets) {
        try { if (sheet.cssRules) walk(sheet.cssRules, out); } catch { }   // 跨域表读不了，跳过
    }
    return out.join('\n');
}

// 收藏前把楼层里"活的"渲染冻成静态 HTML，再交给 saveSnapshot 序列化。
// 关键：酒馆助手(TavernHelper/JS-Slash-Runner)把角色卡状态栏渲染成 <div class="TH-render"><iframe srcdoc>，
// 真正的状态栏 DOM 活在 iframe.contentDocument 里；直接取 .mes_text.innerHTML 只拿到空的 <iframe> 壳，
// 序列化后状态栏就没了（且 stripRenderBoxes 还会把 .TH-render 整块删掉）。这里在克隆体上就地把每个
// same-origin iframe 的 contentDocument 正文 + <style> 一并搬进一个静态容器，替换掉 iframe，状态栏遂被冻存。
// 跨域/取不到 doc 的 iframe 保持原样（后续 stripRenderBoxes 兜底删除），不至于报错。
function captureFloorHtml(textEl, messageId = null) {
    if (!textEl) return '';
    let clone;
    try { clone = textEl.cloneNode(true); }
    catch { return textEl.innerHTML; }
    // 克隆体里的 iframe 是空壳，得按顺序对应回源 DOM 里那些"活"的 iframe 去读 contentDocument。
    const liveFrames  = textEl.querySelectorAll('.TH-render iframe, iframe');
    const cloneFrames = clone.querySelectorAll('.TH-render iframe, iframe');
    cloneFrames.forEach((cf, i) => {
        const live = liveFrames[i];
        let inner = '';
        try {
            const doc = live && (live.contentDocument || live.contentWindow?.document);
            if (doc && doc.body) {
                const styles = [...doc.querySelectorAll('style')].map(st => st.outerHTML).join('');
                inner = styles + doc.body.innerHTML;
            }
        } catch { inner = ''; }   // 跨域读不到 → 留空，交给下游按 .TH-render 删除
        if (!inner) return;
        const frozen = document.createElement('div');
        frozen.className = 'sp-anchor-frozen-render';
        frozen.innerHTML = inner;
        // 连同外层 .TH-render 一起换掉，避免 stripRenderBoxes 把冻好的内容再删一遍
        const box = cf.closest('.TH-render') || cf;
        box.replaceWith(frozen);
    });
    let css = '';
    try { css = collectCustomCss(); } catch { css = ''; }
    let msgCss = '';
    try { msgCss = collectMessageStyles(messageId); } catch { msgCss = ''; }
    // data-sp-cap 是捕获代码版本标记（DOMPurify 会保留 data- 属性），排查"改了没生效"时看它
    return '<div hidden data-sp-cap="3"></div>'
        + (msgCss ? `<style>${msgCss}</style>` : '')
        + (css ? `<style>${css}</style>` : '')
        + clone.innerHTML;
}

// 孤儿收藏收养（hash 链断掉的旧数据）：拉当前角色现存聊天文件清单，
// 仅当"该角色只有当前这一个聊天"时，把挂在已消失旧名下、charName 相同的收藏认领进来。
// 详见 anchor.adoptOrphans 的判据说明。群聊跳过（无 avatar 概念）。
async function adoptOrphanAnchors(currentChatId, chatIdHash) {
    const ctx = getContext();
    if (!currentChatId || ctx.groupId) return 0;
    const avatar = ctx.characters?.[ctx.characterId]?.avatar;
    const charName = ctx.name2;
    if (!avatar || !charName) return 0;
    let list;
    try {
        const res = await fetch('/api/characters/chats', {
            method : 'POST',
            headers: ctx.getRequestHeaders(),
            body   : JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!res.ok) return 0;
        list = await res.json();
    } catch { return 0; }
    const rows = Array.isArray(list) ? list : Object.values(list || {});
    const existing = new Set(
        rows.map(c => String(c?.file_name || '').replace(/\.jsonl$/i, '')).filter(Boolean)
    );
    // 该角色不止一个聊天 → 孤儿归属有歧义，不动
    if (existing.size !== 1 || !existing.has(String(currentChatId))) return 0;
    return anchor.adoptOrphans(charName, existing, currentChatId, getChatDisplayName(), chatIdHash ?? null);
}

async function onAnchorButtonClick(mes) {
    const ctx    = getContext();
    const chatId = ctx.chatId ?? null;
    const mid    = mes.getAttribute('mesid');
    const key    = anchorFloorKey(chatId, mid);
    const btn    = mes.querySelector('.sp-anchor-btn');
    if (_anchorSavedKeys.has(key)) {                                        // 已收藏 → 再点即取消
        if (btn) btn.classList.add('sp-anchor-busy');
        try {
            const ids = await anchor.findItemIdsByFloor(chatId, +mid);      // 同楼可能多条，全删
            for (const id of ids) await anchor.deleteItem(id);
            _anchorSavedKeys.delete(key);
            if (btn) { btn.classList.remove('sp-anchor-saved'); btn.title = '收藏此楼'; }
            showToast('已取消收藏');
            if (anchorMode) renderAnchorPanel();
        } catch (err) {
            console.error('[SP anchor] 取消收藏失败', err);
            showToast('取消收藏失败：' + (err?.message || '未知错误'), null, true);
        } finally {
            if (btn) btn.classList.remove('sp-anchor-busy');
        }
        return;
    }
    const textEl = mes.querySelector('.mes_text');
    if (!textEl) { showToast('找不到楼层内容', null, true); return; }
    if (btn) btn.classList.add('sp-anchor-busy');
    try {
        const savedItem = await anchor.saveSnapshot({
            chatId,
            chatIdHash: ctx?.chatMetadata?.chat_id_hash ?? null,   // 改名不变的稳定键，落到每条上，供分桶/自愈用
            chatName  : getChatDisplayName(),
            charName  : mes.getAttribute('ch_name') || ctx.name2 || '角色',
            messageId : mid,
            floorIndex: Number.isFinite(+mid) ? +mid : null,
        }, captureFloorHtml(textEl, Number.isFinite(+mid) ? +mid : null));
        _anchorSavedKeys.add(key);
        if (btn) { btn.classList.add('sp-anchor-saved'); btn.title = '已收藏 · 点击取消'; }
        showToast('已收藏此楼', () => openAnchorAtChat(chatId));
        if (anchorMode) renderAnchorPanel();
        anchor.checkSize()
            .then(r => { if (r.over) showToast(`收藏已占 ${anchor.formatBytes(r.bytes)}，可在坐标面板清理`, null, true); })
            .catch(() => {});
    } catch (err) {
        console.error('[SP anchor] 收藏失败', err);
        showToast('收藏失败：' + (err?.message || '未知错误'), null, true);
    } finally {
        if (btn) btn.classList.remove('sp-anchor-busy');
    }
}

// 打开锚面板并定位到某 chat 的收藏列表（第三层抽屉；charName 由 renderAnchorItems 回填）
function openAnchorAtChat(chatId) {
    _anchorTagFilter = null;   // 直达某聊天层：清筛，免得刚存的楼被旧筛选藏掉
    _anchorView = { level: 'items', charName: null, chatId, itemId: null };
    showPanel();
    if (anchorMode) renderAnchorPanel();
    else $in('.sp-view-btn[data-view="anchor"]').trigger('click');
}

// 跨模块跳转只复用现有侧栏切换，并在目标 DOM 就绪后做可选预填；它不发送消息，也不建立第二套路由状态。
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

// #chat 变动（swipe/编辑/重渲染会抹掉注入的按钮）→ 防抖补齐
let _anchorObserver  = null;
let _anchorScanTimer = null;
// 盯 #chat 的共用 observer：既给每楼补「收藏」按钮，也在楼层结构变动时重算渲染窗口
// （新楼进窗要 observe、删楼/swipe 要重定最新楼）。块的挂/卸本身交给渲染窗口的 IntersectionObserver，
// 这里只负责「结构变了 → 重算窗口」，不再逐块打地鼠。
function initAnchorObserver() {
    const chat = document.querySelector('#chat');
    if (!chat) { setTimeout(initAnchorObserver, 600); return; }
    _anchorObserver?.disconnect();
    _anchorObserver = new MutationObserver(() => {
        clearTimeout(_anchorScanTimer);
        _anchorScanTimer = setTimeout(() => {
            scanAnchorButtons();
            // 流式中不重算窗口：ST 每 token 重写 .mes_text，此时算了也会被冲；等流式结束
            // （token 停 1.5s／GENERATION_ENDED／CHARACTER_MESSAGE_RENDERED）统一刷。按钮扫描不受此限（按钮在 .mes 头部）。
            if (Date.now() < _stStreamUntil) return;
            refreshInlineWindow();   // 结构变 → 防抖重算深度窗 + 观察新楼（幂等，已挂的框不动）
        }, 400);
    });
    _anchorObserver.observe(chat, { childList: true, subtree: true });
}

// ─── Extensions panel ─────────────────────────────────────────────────────────

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
    // 点生成中只锁「我/TA」子切换（本次生成绑定当前视角，中途换视角无意义，另有 .sp-view-btn 里 3207 JS 守卫兜底）；
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
                            <details class="sp-settings-section" open>
                                <summary class="sp-settings-section-title">总开关</summary>
                                <div class="sp-settings-section-body">
                                    <label class="sp-mode-opt">
                                        <input type="checkbox" id="sp-plugin-enabled" ${getSettings().pluginEnabled !== false ? 'checked' : ''}>
                                        <span>启用构画</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">关闭后如同未安装：隐藏悬浮球与全部楼内展示，停止一切后台判定与注入。此设置面板仍可从酒馆魔杖菜单重新打开。</p>

                                    <label class="sp-mode-opt" style="margin-top:10px">
                                        <input type="checkbox" id="sp-inject-enabled" ${getSettings().injectEnabled !== false ? 'checked' : ''}>
                                        <span>允许潜伏注入主楼 AI（线 / 面 / 刻度）</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">总闸：关闭则线 / 面 / 刻度一律不注入主楼 AI（不影响楼内展示与手动生成）。各模块自身的注入开关仍需分别开启才生效。</p>
                                </div>
                            </details>

                            <!-- ═══════════ 基础设置 ═══════════ -->
                            <details class="sp-settings-layer">
                                <summary class="sp-settings-layer-title">基础设置</summary>
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

                                    <!-- API 存储快切：点假框→就地展开内联预设列表（非原生 select 弹窗，避开 WebView 里弹层被插件盖住）；选一项填入下方输入框（仍需点保存生效）；＋新增按域名自动命名、🗑删除，均即时落 settings.json -->
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
                                    <p class="sp-cfg-hint">列出角色卡关联 + 全局启用的世界书。勾选的传给 AI，不勾则跳过。按角色卡保存。</p>
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
                                    <div id="sp-mem-database-status" class="sp-cfg-hint" style="display:none"></div>

                                    <hr class="sp-mem-divider">
                                    <label class="sp-cfg-group">容量</label>
                                    <div class="sp-mode-opt">
                                        <span>记忆块 token 上限</span>
                                        <input id="sp-mem-maxtokens" class="sp-input sp-interval-input" type="number" min="0" step="1000" value="60000">
                                        <span>（0=不限）</span>
                                    </div>
                                    <p class="sp-cfg-hint">超出则压缩再注入：点 / 线 / 面 / 间取近景，轴全程等距节选（不漏日期）；不超原样。防长故事撑爆 token。</p>

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

                                    <label class="sp-cfg-group" style="margin-top:12px">界面字体</label>
                                    <p class="sp-cfg-hint">构画自带一套字体（默认<b>有爱圆体</b>），<b>独立于酒馆</b>。想换成别的：把字体 CSS 的链接填到「字体 URL」，再把该 CSS 里 <code>@font-face</code> 声明的字体名填到「字体名」。留空 URL＝不加载网络字体、只用系统默认字体。改完点「应用」。</p>
                                    <input id="sp-cfg-font-url" class="sp-input" type="url"
                                           placeholder="字体 CSS URL，如 https://fontsapi.zeoseven.com/xxx/main/result.css"
                                           value="${escapeAttr(getSettings().uiFontUrl ?? '')}">
                                    <input id="sp-cfg-font-family" class="sp-input" type="text" style="margin-top:6px"
                                           placeholder="字体名，如 Nowar Rounded TW Wc"
                                           value="${escapeAttr(getSettings().uiFontFamily ?? '')}">
                                    <div class="sp-mode-opt" style="margin-top:8px; gap:8px">
                                        <button type="button" id="sp-font-apply" class="sp-fetch-btn"><i class="fa-solid fa-check"></i> 应用</button>
                                        <button type="button" id="sp-font-reset" class="sp-fetch-btn" title="恢复成构画自带的默认字体"><i class="fa-solid fa-rotate-left"></i> 恢复默认</button>
                                    </div>

                                    <hr class="sp-mem-divider">
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

                                </div>
                            </details>

                            <!-- ═══════════ 模块设置 ═══════════ -->
                            <details class="sp-settings-layer">
                                <summary class="sp-settings-layer-title">模块设置</summary>
                                <div class="sp-settings-layer-body">

                            <!-- 模块设置：时间戳（时间锚点体系·让主楼 AI 每楼产出时间戳） -->
                            <details class="sp-settings-section" id="sp-storyclock-section">
                                <summary class="sp-settings-section-title">时间戳</summary>
                                <div class="sp-settings-section-body">
                                    <label class="sp-mode-opt">
                                        <input type="checkbox" id="sp-storyclock-enabled" ${getSettings().storyClockEnabled !== false ? 'checked' : ''}>
                                        <span>启用时间戳</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">给整个故事一个<b>跟着剧情走的时间源</b>：向主楼 AI 注入一段指令，让它在<b>每楼正文首尾各打一个隐形时间戳</b>（HTML 注释，聊天里看不到），构画读回它来把握「现在是什么时候」，精确到<b>小时</b>。这是时间系统的地基——默认开。<br><span style="opacity:.75">注：会给每楼多加一小段系统提示词（占少量 token）；导出聊天原文时能看到这些 <code>&lt;!-- … --&gt;</code> 注释。不受「允许潜伏注入」总闸控制——关掉那个总闸不会关掉时间戳。它是让主楼 AI 产出时间数据的地基（与线/面「把数据喂给 AI」方向相反），只由插件总开关和上面这个开关控制。</span></p>
                                    <p class="sp-cfg-hint" style="margin-top:4px; opacity:.75">另：所有刷新判定都挂钩时间戳；不开启时，遇到楼尾的额外变量计算（如 MVU）可能<b>重复调用 API</b>。</p>
                                    <hr class="sp-mem-divider">
                                    <label class="sp-cfg-group" style="margin-top:10px">强制注入提示词（可二改）</label>
                                    <p class="sp-cfg-hint"><strong>留空＝用内置默认</strong>（默认词随插件更新走）。想自定义就点「载入默认再改」把默认全文拉进编辑框，<strong>改成什么就整段注入什么</strong>；想回到跟随更新的原版，点「恢复默认」清空即可。⚠️ 务必保留 <code>&lt;!-- SDC-start … --&gt;</code> / <code>&lt;!-- SDC-end … --&gt;</code> 这对注释结构——构画靠它读回时间戳；改坏了只是时间戳读空、轴 / 点仍照常兜底，不影响其它。</p>
                                    <textarea id="sp-storyclock-prompt" class="sp-input sp-theater-cfg-textarea" placeholder="留空＝用内置默认强制词。"></textarea>
                                    <div style="display:flex; gap:8px; margin-top:6px">
                                        <button id="sp-storyclock-prompt-load" class="sp-mem-btn" type="button">载入默认再改</button>
                                        <button id="sp-storyclock-prompt-reset" class="sp-mem-btn" type="button">恢复默认</button>
                                    </div>
                                </div>
                            </details>

                            <!-- 模块设置：轴（历法时间轴 · 剧情日期判定 + 暗历潜伏注入） -->
                            <details class="sp-settings-section" id="sp-axis-section">
                                <summary class="sp-settings-section-title">轴</summary>
                                <div class="sp-settings-section-body">
                                    <label class="sp-cfg-group">剧情日期（轴 / 点共用「今天」）</label>
                                    <label class="sp-mode-opt" style="margin-top:6px">
                                        <input type="checkbox" id="sp-almanac-autodetect" ${getSettings().almanacAutoDetect !== false ? 'checked' : ''}>
                                        <span>读不到戳时，用 API 兜底判定日期</span>
                                    </label>
                                    <label class="sp-mode-opt" style="margin-top:6px">
                                        <span>每</span><input id="sp-almanac-judge-interval" class="sp-input sp-interval-input" type="number" min="1" value="${escapeAttr(String(getAlmanacJudgeInterval()))}"><span>条 AI 回复兜底一次</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">有戳时每楼直接读、<b>不调 API</b>；只有漏打戳、或戳没写月日（如「谷雨」）时，才隔几楼调一次 API 从正文推算日期补上。<b>关掉＝只认戳、绝不为日期调 API</b>。</p>
                                    <label class="sp-mode-opt" style="margin-top:10px">
                                        <input type="checkbox" id="sp-schedule-autodetect" ${getSettings().scheduleAutoDetect === true ? 'checked' : ''}>
                                        <span>点：后台自动跟随「今天」</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">开＝「今天」一推进就<b>自动在后台重排点</b>到今天（<b>每次多一趟 API</b>）。<b>关（默认）＝点原地不动、不后台调 API</b>；你想让点对齐今天时，去点面板<b>手动刷新一次</b>即可（刷新出来的点就从今天起排）。不常用点、想省 API 的就别开。</p>

                                    <hr class="sp-mem-divider">
                                    <label class="sp-cfg-group">刻度 · 潜伏注入主楼 AI</label>
                                    <label class="sp-mode-opt" style="margin-top:6px">
                                        <input type="checkbox" id="sp-ledger-inject" ${getSettings().ledgerInject === true ? 'checked' : ''}>
                                        <span>潜伏注入主楼 AI</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">按剧情挑几条此刻最相关的账（伤情 / 约定 / 周期），隐形注入主楼 AI（聊天不显示），让它<b>记得</b>角色身上的账、随天数表现出该有的样子（不生硬点破）。会改 AI 行为、略增 token，默认关。开后楼内「线」块下方会多一个只读<b>标注打捞</b>框，可核对本回合实际注入了哪几条。</p>
                                </div>
                            </details>

                            <!-- 模块设置 1：线（伏笔） -->
                            <details class="sp-settings-section">
                                <summary class="sp-settings-section-title">线</summary>
                                <div class="sp-settings-section-body">
                                    <label class="sp-cfg-group">功能开关</label>
                                    <label class="sp-mode-opt">
                                        <input type="checkbox" id="sp-lines-enabled" ${getSettings().linesEnabled !== false ? 'checked' : ''}>
                                        <span>启用平行事件（线）</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">关闭后不再自动推进、也不再向楼层追加内联展示</p>

                                    <label class="sp-mode-opt" style="margin-top:10px">
                                        <input type="checkbox" id="sp-lines-inject" ${getSettings().linesInject === true ? 'checked' : ''}>
                                        <span>潜伏注入主楼 AI</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">活跃线隐形注入主楼 AI（聊天不显示），让伏笔当暗流缓慢推进。会改 AI 行为、略增 token，默认关。</p>

                                    <label class="sp-mode-opt" style="margin-top:10px">
                                        <input type="checkbox" id="sp-dashed-enabled" ${getSettings().dashedEnabled === true ? 'checked' : ''}>
                                        <span>虚线 · 冷知识（跟随线生成）</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">开启后，每次线生成 / 推进会额外新增两条冷知识，并在最新楼层展示。关闭只停止自动生成和楼层展示，已保存的冷知识仍可在线面板查看。<b>纯娱乐、不注入任何地方</b>。多一次 API，默认关。</p>

                                    <div class="sp-mode-opt sp-mode-opt-sub" style="margin-top:6px">
                                        <input type="checkbox" id="sp-dashed-cleanup-enabled" ${getSettings().dashedCleanupEnabled !== false ? 'checked' : ''}>
                                        <label for="sp-dashed-cleanup-enabled">只保留最近</label>
                                        <input id="sp-dashed-keep-count" class="sp-input sp-interval-input" type="number" min="2" step="1" value="${escapeAttr(String(getDashedKeepCount()))}" ${getSettings().dashedCleanupEnabled !== false ? '' : 'disabled'} aria-label="保留最近多少条未锁冷知识">
                                        <span>条未锁冷知识</span>
                                    </div>
                                    <p class="sp-cfg-hint" style="margin-top:2px">修改后会对当前聊天立刻生效，其他聊天会在下次冷知识更新时按规则清理。锁定的冷知识不会被自动清除。</p>

                                    <hr class="sp-mem-divider">

                                    <p class="sp-cfg-group">推进策略</p>
                                    <div class="sp-mode-row">
                                        <label class="sp-mode-opt">
                                            <input type="radio" name="sp-lines-mode" value="turns" ${getLinesMode() === 'turns' ? 'checked' : ''}>
                                            <span>回合制，每</span>
                                            <input id="sp-lines-interval" class="sp-input sp-interval-input" type="number" min="1" value="${escapeAttr(String(getLinesInterval()))}">
                                            <span>条 AI 回复推进一次</span>
                                        </label>
                                        <label class="sp-mode-opt">
                                            <input type="radio" name="sp-lines-mode" value="days" ${getLinesMode() === 'days' ? 'checked' : ''}>
                                            <span>时间制，按游戏内日期变化推进</span>
                                        </label>
                                        <label class="sp-mode-opt">
                                            <input type="radio" name="sp-lines-mode" value="manual" ${getLinesMode() === 'manual' ? 'checked' : ''}>
                                            <span>手动推进，由用户点击按钮触发</span>
                                        </label>
                                    </div>

                                    <hr class="sp-mem-divider">
                                    <p class="sp-cfg-group" id="sp-scale-hint" style="margin-top:0">叙事尺度（按角色保存）</p>
                                    <div class="sp-mode-row" id="sp-scale-row">
                                        <!-- populated by refreshScaleRadio() when settings opens -->
                                    </div>
                                </div>
                            </details>

                            <!-- 模块设置 2：面（大纲）自动注入 -->
                            <details class="sp-settings-section" id="sp-outline-section">
                                <summary class="sp-settings-section-title">面</summary>
                                <div class="sp-settings-section-body">
                                    <label class="sp-mode-opt">
                                        <input type="checkbox" id="sp-outline-inject" ${getSettings().outlineInject === true ? 'checked' : ''}>
                                        <span>大纲自动注入</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">沿大纲节点缓慢推进：每隔若干楼<b>独立判定</b>当前演到哪个节点，把「当前节点 + 下一步方向」隐形注入主楼 AI（聊天不显示）。游标<b>只进不退、无信号不动</b>，写再多跑题日常也不硬推。默认关，需先有一版面。</p>

                                    <hr class="sp-mem-divider">
                                    <label class="sp-cfg-group">判定节奏</label>
                                    <label class="sp-mode-opt">
                                        <span>每</span>
                                        <input id="sp-outline-judge-interval" class="sp-input sp-interval-input" type="number" min="1" value="${escapeAttr(String(getOutlineJudgeInterval()))}">
                                        <span>条 AI 回复判定一次推进</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">楼数越大越省 token、越迟钝；越小越灵敏、开销越高（<b>每次判定 = 一次额外 API</b>）。默认 3。</p>
                                </div>
                            </details>

                            <!-- 模块设置 3：棱（小剧场） -->
                            <details class="sp-settings-section" id="sp-theater-section">
                                <summary class="sp-settings-section-title">棱</summary>
                                <div class="sp-settings-section-body">
                                    <p class="sp-cfg-hint">棱 = 单轮小剧场（if 线 / 番外 / 可能性）。写作 agent 出文本、美化 agent 自动排版。</p>
                                    <label class="sp-cfg-label">写作提示词（文风 + 范文）</label>
                                    <textarea id="sp-theater-style" class="sp-input sp-theater-cfg-textarea" placeholder="指定文体基调、节奏、感官描写要求，禁套路化开头结尾；也可直接贴 1-2 段你认可的文笔让 AI 模仿其笔触…"></textarea>

                                    <hr class="sp-mem-divider">

                                    <label class="sp-cfg-group">小剧场模板库</label>
                                    <p class="sp-cfg-hint">存于专用世界书 <code>构画-棱-小剧场模板</code>，全局共享、不进聊天文件、绝不注入 AI。棱输入区可点选模板起草；缓存用量与清理见「存储管理」。</p>
                                    <div id="sp-theater-tpl-mgr" class="sp-theater-tpl-mgr">
                                        <div class="sp-theater-list-empty">（打开设置时自动加载）</div>
                                    </div>
                                </div>
                            </details>

                            <!-- 模块设置 4：间（局外对话空间）人格覆盖 -->
                            <details class="sp-settings-section" id="sp-space-section">
                                <summary class="sp-settings-section-title">间</summary>
                                <div class="sp-settings-section-body">
                                    <p class="sp-cfg-hint">间 = 跳出扮演、和 AI 聊剧情/设定/关系的「局外」空间。这里可给它换一套<strong>说话语气与人格</strong>。</p>
                                    <label class="sp-cfg-label">间的人格 / 说话风格</label>
                                    <textarea id="sp-space-persona" class="sp-input sp-theater-cfg-textarea" placeholder="留空＝内置默认（柔和客观、含蓄内敛的中性顾问）。填了就换成你写的人格，如：深耕 ACG、熟知网络用语、爱用半个括号吐槽的重度宅女…"></textarea>
                                    <p class="sp-cfg-hint" style="margin-top:2px">只换<strong>语气 / 行文 / 人格色彩</strong>；「间仍是创作顾问、不推进剧情、不扮演故事角色」这条内核<strong>恒定保留</strong>（写得再放飞它也不会跑去演戏）。<b>只作用于「间」</b>，不影响面·和间聊聊。支持 <code>{{char}}</code> / <code>{{user}}</code>。</p>
                                </div>
                            </details>

                                </div>
                            </details>
                            <details class="sp-settings-layer">
                                <summary class="sp-settings-layer-title">高级设置</summary>
                                <div class="sp-settings-layer-body">

                            <!-- 高级：标签清洗与全局提示词（作用于全部生成链路） -->
                            <details class="sp-settings-section">
                                <summary class="sp-settings-section-title">标签与提示词</summary>
                                <div class="sp-settings-section-body">
                                    <label class="sp-cfg-group">标签清洗</label>
                                    <p class="sp-cfg-hint">读取 AI 楼层原文时的标签过滤规则，<strong>对全部生成链路生效</strong>（记忆摘要、点 / 线 / 面生成、间 / 面讨论的对话注入），用来剔除状态栏 / 思维链等包裹、避免污染上下文。多个用英文逗号分隔，只写标签名（如 <code>content</code>）、不带尖括号。</p>
                                    <div class="sp-mode-opt sp-tag-opt">
                                        <span>保留包裹符</span>
                                        <input id="sp-mem-keeptags" class="sp-input sp-tag-input" type="text" placeholder="content" value="">
                                    </div>
                                    <p class="sp-cfg-hint">标签本身去掉、<strong>内部文字保留</strong>（如正文被 <code>content</code> 包裹）。</p>
                                    <div class="sp-mode-opt sp-tag-opt">
                                        <span>剔除包裹符</span>
                                        <input id="sp-mem-extratags" class="sp-input sp-tag-input" type="text" placeholder="think,reasoning" value="">
                                    </div>
                                    <p class="sp-cfg-hint">标签<strong>连同内部内容一起删除</strong>（如思维链 <code>think</code> / <code>reasoning</code>）。</p>

                                    <hr class="sp-mem-divider">

                                    <label class="sp-cfg-group">自定义提示词 / 全局写作规范</label>
                                    <p class="sp-cfg-hint"><strong>已内置一版默认破限词</strong>（不显示、恒定生效）。此处内容<strong>追加在其后</strong>，一同拼到<strong>全部生成链路</strong>系统提示词最前端。适合放全局写作规范：去八股 / 控制文风 / 叙事口吻（可直接贴这类世界书正文）。支持 <code>{{char}}</code> / <code>{{user}}</code> 占位符。</p>
                                    <textarea id="sp-custom-prompt" class="sp-input sp-theater-cfg-textarea" placeholder="可留空（只用默认破限）。也可在此追加全局写作规范，如：去八股、控制文风、叙事口吻…会叠加在默认破限词之后一起注入。"></textarea>
                                </div>
                            </details>

                            <!-- 存储管理：统管构画三层存储（聊天 chat_metadata / 收藏服务器 / 本机缓存） -->
                            <details class="sp-settings-section" id="sp-storage-section">
                                <summary class="sp-settings-section-title">存储管理</summary>
                                <div class="sp-settings-section-body">
                                    <p class="sp-cfg-hint">统管构画的数据占用，按存储位置分层。</p>
                                    <div id="sp-storage-body">
                                        <div class="sp-cfg-hint">（打开设置时自动统计…）</div>
                                    </div>
                                    <div class="sp-mem-actions">
                                        <button id="sp-storage-refresh" class="sp-mem-btn">刷新用量</button>
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

                    <details class="sp-debug-drawer" id="sp-debug-drawer">
                        <summary class="sp-debug-summary">🐛 AI 输入</summary>
                        <pre class="sp-debug-pre" id="sp-debug-pre">（尚未发送请求）</pre>
                        <div class="sp-debug-actions">
                            <button class="sp-debug-copy-btn">复制</button>
                        </div>
                    </details>
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
    // shadow 内第一层 wrapper 必须带 sp-root + 主题类：style.css 里 13 处 `.sp-root ...`
    // 前缀选择器、.sp-night/.sp-day 色板、.sp-forced-* 强制主题覆盖全靠它匹配
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
    inEl('#sp-debug-drawer')?.addEventListener('toggle', function () {
        if (this.open) {
            inEl('#sp-debug-pre').textContent =
                lastDebugPayload ? JSON.stringify(lastDebugPayload, null, 2) : '（尚未发送请求）';
        }
    });
    $in('.sp-debug-copy-btn').on('click', function () {
        if (!lastDebugPayload) return;
        navigator.clipboard.writeText(JSON.stringify(lastDebugPayload, null, 2))
            .then(() => { $(this).text('已复制 ✓'); setTimeout(() => $(this).text('复制'), 2000); })
            .catch(() => {});
    });

    // Outline chat
    function doSendChat() {
        const msg = $in('#sp-chat-input').val().trim();
        if (msg && !isOutlineChatting) { const $i = $in('#sp-chat-input'); $i.val(''); autoGrowTextarea($i[0]); sendOutlineChat(msg); }
    }
    $in('#sp-chat-send').on('click', doSendChat);
    // 回车换行、只用按钮发送（用户偏好）——不再拦 Enter；自动长高保留。
    $in('#sp-chat-input').on('input', function () { autoGrowTextarea(this); });

    // Delete a single message (leaves the rest alone — user chose "just this one")
    $in('#sp-chat-msgs').on('click', '.sp-chat-msg-delete', function () {
        if (isOutlineChatting) return;
        const idx = Number($(this).closest('.sp-chat-msg-wrap').attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= outlineChatHistory.length) return;
        outlineChatHistory.splice(idx, 1);
        saveCreativeChatHistory();
        renderCreativeChatHistory();
    });

    // Edit user message → inline editor
    $in('#sp-chat-msgs').on('click', '.sp-chat-msg-edit', function () {
        if (isOutlineChatting) return;
        const $msg = $(this).closest('.sp-chat-msg-wrap');
        const idx  = Number($msg.attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= outlineChatHistory.length) return;
        startInlineEdit($msg, idx);
    });

    $in('#sp-chat-clear').on('click', async () => {
        if (isOutlineChatting) return;
        if (!outlineChatHistory.length) return;
        const ok = await spConfirm({
            title: '清空对话',
            body : '将清空这个面的讨论历史，不影响已生成的面本身。',
            confirmText: '清空',
            cancelText : '取消',
        });
        if (!ok) return;
        outlineChatHistory = [];
        saveCreativeChatHistory();
        $in('#sp-chat-msgs').empty();
    });

    // Space chat (间)
    function doSendSpaceChat() {
        const msg = $in('#sp-space-input').val().trim();
        if (msg && !isSpaceChatting) { const $i = $in('#sp-space-input'); $i.val(''); autoGrowTextarea($i[0]); sendSpaceChat(msg); }
    }
    $in('#sp-space-send').on('click', doSendSpaceChat);
    // 回车换行、只用按钮发送（用户偏好）——不再拦 Enter；自动长高保留。
    $in('#sp-space-input').on('input', function () { autoGrowTextarea(this); });

    $in('#sp-space-msgs').on('click', '.sp-chat-msg-delete', function () {
        if (isSpaceChatting) return;
        const idx = Number($(this).closest('.sp-chat-msg-wrap').attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= spaceChatHistory.length) return;
        spaceChatHistory.splice(idx, 1);
        saveSpaceChatHistory();
        renderSpaceChatHistory();
    });

    // 逐条复制：取该条干净文本（AI 剥 widget 标签）写剪贴板，图标闪一下 ✓ 反馈。不受生成中态限制（只读操作）。
    $in('#sp-space-msgs').on('click', '.sp-chat-msg-copy', async function () {
        const idx = Number($(this).closest('.sp-chat-msg-wrap').attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= spaceChatHistory.length) return;
        const text = spaceMsgPlainText(spaceChatHistory[idx]);
        const $btn = $(this);
        if ($btn.data('sp-copy-reset')) { clearTimeout($btn.data('sp-copy-reset')); }
        const ok = await copyPlainText(text);
        $btn.html(ok ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>')
            .attr('title', ok ? '已复制' : '复制失败');
        const t = setTimeout(() => {
            $btn.html('<i class="fa-solid fa-copy"></i>').attr('title', '复制').removeData('sp-copy-reset');
        }, 1200);
        $btn.data('sp-copy-reset', t);
    });

    $in('#sp-space-msgs').on('click', '.sp-chat-msg-edit', function () {
        if (isSpaceChatting) return;
        const $msg = $(this).closest('.sp-chat-msg-wrap');
        const idx  = Number($msg.attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= spaceChatHistory.length) return;
        startSpaceInlineEdit($msg, idx);
    });

    // Widget apply: attach the AI-generated Event/Line to current chat's cache
    $in('#sp-space-msgs').on('click', '.sp-space-widget-apply', function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        const wid = $btn.attr('data-wid');
        const stored = _spaceWidgetStore.get(wid);
        if (!stored) { showToast('这张卡片已过期，请再让 AI 生成一次', null, true); return; }
        if (stored.kind === 'schedule_widget') applyScheduleWidget(stored.body, $btn, stored.editIdx);
        else if (stored.kind === 'line_widget') applyLineWidget(stored.body, $btn, stored.editIdx);
        else if (stored.kind === 'almanac_widget') applyAlmanacWidget(stored.body, $btn, $btn.attr('data-idx'));
        else if (stored.kind === 'era_widget') applyEraWidget(stored.body, $btn);
    });

    $in('#sp-space-clear').on('click', async () => {
        if (isSpaceChatting) return;
        if (!spaceChatHistory.length) return;
        const ok = await spConfirm({
            title: '清空对话',
            body : '将清空"间"的局外聊天记录。',
            confirmText: '清空',
            cancelText : '取消',
        });
        if (!ok) return;
        spaceChatHistory = [];
        saveSpaceChatHistory();
        $in('#sp-space-msgs').empty();
    });
    $in('#sp-outline-beats').on('click', '#sp-gen-outline-now', triggerGenerateOutline);
    const $linesWrap = $in('#sp-lines-wrap');
    $linesWrap.on('click', '#sp-gen-lines-now', triggerGenerateLines);
    $linesWrap.on('click', '.sp-lines-sheet-btn', function () {
        const sheet = $(this).attr('data-sheet');
        if (sheet !== 'events' && sheet !== 'dashed') return;
        _linesSheet = sheet;
        refreshLinesPanel();
    });
    $linesWrap.on('click', '.sp-lines-dashed-add', openDashedGeneratorDialog);
    $linesWrap.on('click', '.sp-lines-dashed-lock', function () { triggerToggleDashedLock($(this).attr('data-id')); });
    $linesWrap.on('click', '.sp-lines-dashed-delete', function () { triggerDeleteDashedItem($(this).attr('data-id')); });
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
    $in('#sp-outline-beats').on('click', '.sp-refresh-outline', triggerGenerateOutline);
    $in('#sp-outline-beats').on('click', '.sp-beat-delete', function () {
        const idx = Number($(this).attr('data-idx'));
        if (Number.isInteger(idx)) triggerDeleteOutlineBeat(idx);
    });
    // 手选当前剧情点：写游标 → 重渲染（高亮跟着走）→ 刷注入（开着自动注入才真注入，否则只清）。
    // 再点已选中的节点 = 取消狙击（游标→0：清高亮、清注入、停自动推进判定，直到再次手选）。
    $in('#sp-outline-beats').on('click', '.sp-beat-setcur', function () {
        const idx = Number($(this).attr('data-idx'));
        if (!Number.isFinite(idx) || idx < 1) return;
        const next = (getOutlineCursor() === idx) ? 0 : idx;
        setOutlineCursor(next);
        const saved = readStore(getOutlineCacheKey());
        if (saved?.raw) { cachedOutline = renderOutline(saved.raw, getOutlineCursor()); setOutlineBody(cachedOutline); }
        refreshOutlineInjection();
    });
    // 面·逐 step 复制：取该节点干净文本写剪贴板，图标闪 ✓ 反馈（只读操作，不受生成态限制；照抄间的 .sp-chat-msg-copy）。
    $in('#sp-outline-beats').on('click', '.sp-beat-copy', async function () {
        const text = _copyTexts[$(this).data('cid')];
        if (text == null) return;
        const $btn = $(this);
        if ($btn.data('sp-copy-reset')) { clearTimeout($btn.data('sp-copy-reset')); }
        const ok = await copyPlainText(text);
        $btn.html(ok ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>')
            .attr('title', ok ? '已复制' : '复制失败');
        const t = setTimeout(() => {
            $btn.html('<i class="fa-solid fa-copy"></i>').attr('title', '复制这一步').removeData('sp-copy-reset');
        }, 1200);
        $btn.data('sp-copy-reset', t);
    });
    // Refresh lines — button appears in both panel toolbar and inline block
    // 双绑拆分：面板行在 shadow 内走 $in；楼内行在 light DOM #chat 保持原查询。
    $linesWrap.on('click', '.sp-refresh-lines, .sp-inline-refresh-lines', function (e) {
        e.stopPropagation();   // inline button lives in <summary>, don't toggle details
        triggerGenerateLines();
    });
    $('#chat').on('click', '.sp-refresh-lines, .sp-inline-refresh-lines', function (e) {
        e.stopPropagation();   // inline button lives in <summary>, don't toggle details
        triggerGenerateLines();
    });
    // Advance lines — button appears in both panel toolbar and inline block
    $linesWrap.on('click', '.sp-advance-lines, .sp-inline-advance-lines', function (e) {
        e.stopPropagation();   // inline button lives in <summary>, don't toggle details
        triggerAdvanceLines();
    });
    $('#chat').on('click', '.sp-advance-lines, .sp-inline-advance-lines', function (e) {
        e.stopPropagation();   // inline button lives in <summary>, don't toggle details
        triggerAdvanceLines();
    });
    // 楼层刷新仍直接广泛取材两条，不打开面板的主题选择弹窗。
    $('#chat').on('click', '.sp-inline-refresh-dashed', function (e) {
        e.stopPropagation();
        runGenerateDashed({ reroll: true });
    });
    // Per-line delete (× on each line card, panel + inline). No full-clear button anymore.
    $linesWrap.on('click', '.sp-line-del-one', function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr('data-line-idx'));
        if (Number.isInteger(idx)) triggerDeleteOneLine(idx);
    });
    $('#chat').on('click', '.sp-line-del-one', function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr('data-line-idx'));
        if (Number.isInteger(idx)) triggerDeleteOneLine(idx);
    });
    // Per-line lock/unlock toggle (panel only — inline block shows a read-only marker).
    $linesWrap.on('click', '.sp-line-pin-toggle', function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr('data-line-idx'));
        if (Number.isInteger(idx)) triggerToggleLinePin(idx);
    });
    $('#chat').on('click', '.sp-line-pin-toggle', function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr('data-line-idx'));
        if (Number.isInteger(idx)) triggerToggleLinePin(idx);
    });
    // Per-point lock/unlock toggle (schedule panel only; pin 存 raw、机制对齐线，无楼内块)。
    $in('#sp-body').on('click', '.sp-point-pin-toggle', function (e) {
        e.stopPropagation();
        const day = $(this).attr('data-day');
        const idx = Number($(this).attr('data-ev'));
        if (!Number.isInteger(idx)) return;
        triggerTogglePointPin(day === 'future' ? 'future' : Number(day), idx);
    });
    // Per-point delete (× on each event, 点面板 + 楼内块抽屉；对齐线的 .sp-line-del-one 双绑 #sp-lines-list/#chat)。
    $in('#sp-body').on('click', '.sp-sch-del-one', function (e) {
        e.stopPropagation();
        const day = $(this).attr('data-day');
        const idx = Number($(this).attr('data-ev'));
        if (!Number.isInteger(idx)) return;
        triggerDeletePointEvent(day === 'future' ? 'future' : Number(day), idx);
    });
    $('#chat').on('click', '.sp-sch-del-one', function (e) {
        e.stopPropagation();
        const day = $(this).attr('data-day');
        const idx = Number($(this).attr('data-ev'));
        if (!Number.isInteger(idx)) return;
        triggerDeletePointEvent(day === 'future' ? 'future' : Number(day), idx);
    });

    // 楼内「标注池」框（AI 楼）：summary 的打捞/更新 + 每条锁定/归档了结。钮在 <summary>/行内，需 stopPropagation 免折叠。
    $('#chat').on('click', '.sp-inline-ledger-capture', function (e) {
        e.stopPropagation();
        if (isCapturingLedger) { showToast('正在标注中…'); return; }
        runLedgerCaptureStep(true);   // 手动打捞：无新事件/无 API 时自带 toast
    });
    $('#chat').on('click', '.sp-inline-ledger-judge', function (e) {
        e.stopPropagation();
        if (isJudgingLedger) { showToast('正在更新中…'); return; }
        runLedgerJudgeStep(true);     // 手动判定：无活跃条目/无改动时自带 toast
    });
    $('#chat').on('click', '.sp-inline-ledger-lock', function (e) {
        e.stopPropagation();
        const id = $(this).attr('data-id');
        const it = id && ledger.getEntry(id);
        if (!it) return;
        if (it.锁 === '用户锁') { ledger.unlockEntry(id); showToast('已解锁 · AI 判定可再更新此条'); }
        else { ledger.lockEntry(id); showToast('已锁定 · AI 判定不再改动此条'); }
        refreshInlineWindow(true);
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });
    $('#chat').on('click', '.sp-inline-ledger-mute', function (e) {
        e.stopPropagation();
        const id = $(this).attr('data-id');
        const it = id && ledger.getEntry(id);
        if (!it) return;
        if (it.静音 === true) { ledger.unmuteEntry(id); showToast('已恢复埋入 · 重新参与注入'); }
        else { ledger.muteEntry(id); showToast('已暂停埋入 · 保留跟进、暂不注入主楼'); }
        refreshLedgerInjection();   // 注入集变了 → 当场重算
        refreshInlineWindow(true);
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });
    $('#chat').on('click', '.sp-inline-ledger-close', async function (e) {
        e.stopPropagation();
        const id = $(this).attr('data-id');
        const it = id && ledger.getEntry(id);
        if (!it) return;
        const ok = await spConfirm({ title: '了结条目', body: `把「${it.事由}」移出活跃刻度？可在刻度页归档里捞回。`, confirmText: '了结', cancelText: '取消' });
        if (!ok) return;
        ledger.closeEntry(id);
        refreshLedgerInjection();
        refreshInlineWindow(true);
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });

    // Inject buttons (event delegation)——双绑拆分：面板三区在 shadow 内走 $inAll；楼内注入钮在 light DOM #chat 保持原查询。
    // 逗号选择器必须 $inAll：$in=querySelector 只取首个容器(#sp-body)，outline/lines 两区的注入钮会静默失效。
    $inAll('#sp-body, #sp-outline-wrap, #sp-lines-wrap').on('click', '.sp-inject-btn', function () {
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
    $in('#sp-outline-beats').on('click', '#sp-abort-outline', abortOutlineGen);
    $linesWrap.on('click', '#sp-abort-lines', abortLinesGen);

    // ── 棱（小剧场）事件（全部委托到 #sp-theater-wrap，内容动态重渲染）──
    const $theater = $in('#sp-theater-wrap');
    // 模板点选（内联列表）→ 内容填入输入框（可二次编辑），并收起选择器
    $theater.on('click', '.sp-theater-tpl-pick', function () {
        const uid = $(this).data('uid');
        const tpl = _theaterTemplateCache.find(t => String(t.uid) === String(uid));
        if (tpl) {
            $in('#sp-theater-input').val(tpl.text);
            _theaterTemplateSource = { uid: tpl.uid, title: tpl.title, input: tpl.text };
            $in('#sp-theater-tpl-picker').removeAttr('open');
            $in('#sp-theater-input').trigger('focus');
        }
    });
    // 生成 / 重新生成
    $theater.on('click', '.sp-theater-generate', function () {
        if (isGeneratingTheater) return;
        const input = String($in('#sp-theater-input').val() || '').trim();
        if (!input) { showToast('请先填写小剧场需求', null, true); return; }
        runGenerateTheater(input);
    });
    // 随机起草：从模板库随机抽一个直接生成（模板 text 即需求）。缓存空则临时拉一次，仍空则友好提示。
    $theater.on('click', '.sp-theater-random', async function () {
        if (isGeneratingTheater) return;
        let pool = _theaterTemplateCache;
        if (!pool || !pool.length) {
            try { await refreshTheaterTemplates(); } catch { /* 读取失败按空库处理 */ }
            pool = _theaterTemplateCache;
        }
        if (!pool || !pool.length) { showToast('模板库为空，先去设置 · 棱新增模板', null, true); return; }
        const nonEmptyPool = nonEmptyTemplates(pool);
        if (!nonEmptyPool.length) { showToast('模板库里没有可用的非空模板', null, true); return; }
        const pick = pickWithoutPrevious(nonEmptyPool, _lastRandomTheaterTemplateUid);
        const text = String(pick?.text || '').trim();
        if (!text) { showToast('随机到的模板内容为空，去设置补一下内容', null, true); return; }
        $in('#sp-theater-input').val(text);               // 让用户看到抽中了什么，也便于中止后二次编辑
        $in('#sp-theater-tpl-picker').removeAttr('open'); // 收起模板选择器
        _theaterTemplateSource = { uid: pick.uid, title: pick.title, input: text };
        _lastRandomTheaterTemplateUid = pick.uid;
        showToast('已随机填入模板，请确认后再生成');
    });
    $theater.on('click', '.sp-theater-regen', function () {
        if (isGeneratingTheater) return;
        const input = String($in('#sp-theater-input').val() || '').trim();
        if (!input) { showToast('改一下输入再重新生成', null, true); return; }
        runGenerateTheater(input);
    });
    $theater.on('click', '#sp-abort-theater', abortTheaterGen);
    $theater.on('click', '.sp-theater-back', renderTheaterPanel);
    // 预览框展开 / 收起
    $theater.on('click', '.sp-theater-fullscreen-btn', function () {
        const el = inEl('#sp-theater-result');
        if (!el) return;
        const on = el.classList.toggle('sp-theater-fullscreen');
        // 桌面去掉 .sp-sheet 的 transform，全屏 fixed 才能逃出面板锚到视口（否则被 sheet 的 transform
        // 包含块困在面板内、只满面板）。.sp-fs-flat 在 CSS 里 desktop-only：手机保留 sheet 的居中
        // translateX(-50%)、不位移，全屏铺满面板（≈手机整屏）即可。
        inEl('.sp-sheet')?.classList.toggle('sp-fs-flat', on);
        // 全屏时强制展开（去折叠），退出时按原逻辑重新判定是否需要折叠
        if (on) el.classList.remove('sp-theater-result-collapsed');
        const $i = $(this).find('i');
        $i.attr('class', on ? 'fa-solid fa-compress' : 'fa-solid fa-expand');
        $(this).attr('title', on ? '退出全屏' : '全屏浏览小剧场');
        document.body.classList.toggle('sp-theater-fs-lock', on);   // 锁背景滚动
        if (on) {
            if (!_theaterFsEsc) {
                _theaterFsEsc = (ev) => {
                    if (ev.key === 'Escape') {
                        const r = inEl('#sp-theater-result');
                        if (r && r.classList.contains('sp-theater-fullscreen')) {
                            $in('.sp-theater-fullscreen-btn').trigger('click');
                        }
                    }
                };
                document.addEventListener('keydown', _theaterFsEsc);
            }
        } else {
            applyTheaterFold();   // 退出全屏后按实际高度重判折叠
        }
    });

    $theater.on('click', '.sp-theater-fold-toggle', function () {
        const el = inEl('#sp-theater-result');
        if (!el) return;
        const collapsed = el.classList.toggle('sp-theater-result-collapsed');
        const $btn = $(this);
        $btn.find('.sp-theater-fold-label').text(collapsed ? '展开全文' : '收起');
        $btn.find('i').attr('class', collapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up');
        // 收起时把视口带回按钮所在的预览顶部，避免停在半空
        if (collapsed) $btn.closest('.sp-theater-result-wrap')[0]?.scrollIntoView({ block: 'start' });
    });
    // 永久保存当前结果（带标题）
    $theater.on('click', '.sp-theater-save', function () {
        if (!theaterCurrentPiece) return;
        theaterCurrentPiece.title = String($in('#sp-theater-title').val() || '').trim();
        // 同步更新草稿里的同 id 条目（标题），再升永久
        syncDraftMeta(theaterCurrentPiece);
        theater.promoteToSaved(theaterCurrentPiece);
        showToast('已永久保存到本对话');
        renderTheaterPanel();
    });
    // 列表：查看 / 升永久 / 删草稿 / 删已保存
    $theater.on('click', '.sp-theater-view', function () {
        const id = $(this).data('id');
        const piece = findPieceById(id);
        if (piece) {
            theaterCurrentPiece = piece;
            renderTheaterPanel();
            // 结果区在顶部、列表在底部——查看后把滚动条拉回顶部，否则像"没反应"
            $in('#sp-theater-body').scrollTop(0);
        }
    });
    $theater.on('click', '.sp-theater-promote', function () {
        const id = $(this).data('id');
        const piece = theater.loadDrafts().find(p => p.id === id);
        if (piece) { theater.promoteToSaved(piece); showToast('已永久保存'); renderTheaterPanel(); }
    });
    $theater.on('click', '.sp-theater-del-draft', async function () {
        const id = $(this).data('id');
        if (!await spConfirm({ title: '删除草稿', body: '确定删除这条小剧场草稿吗？' })) return;
        theater.deleteDraft(id);
        renderTheaterPanel();
    });
    $theater.on('click', '.sp-theater-del-saved', async function () {
        const id = $(this).data('id');
        if (!await spConfirm({ title: '删除永久保存', body: '确定从本对话删除这条已永久保存的小剧场吗？删除后无法恢复。' })) return;
        theater.deleteSaved(id);
        renderTheaterPanel();
    });

    // ── 锚（收藏楼层）事件（委托到 #sp-anchor-wrap，三层抽屉动态重渲染）──
    const $anchor = $in('#sp-anchor-wrap');
    $anchor.on('click', '.sp-anchor-char-card', function () {
        _anchorView = { level: 'chats', charName: $(this).attr('data-char'), chatId: null, itemId: null };
        renderAnchorPanel();
    });
    $anchor.on('click', '.sp-anchor-chat-card', function () {
        _anchorView = { level: 'items', charName: _anchorView.charName, chatId: $(this).attr('data-chatid'), itemId: null };
        renderAnchorPanel();
    });
    $anchor.on('click', '.sp-anchor-item-card', function () {
        _anchorFullTagEdit = false;   // 每次新进全文都从只读态开始
        _anchorView = { level: 'full', charName: _anchorView.charName, chatId: _anchorView.chatId, itemId: $(this).attr('data-id') };
        renderAnchorPanel();
    });
    $anchor.on('click', '.sp-anchor-back', function () {
        const to = $(this).attr('data-to');
        if (to === 'items')      _anchorView = { level: 'items', charName: _anchorView.charName, chatId: $(this).attr('data-chatid'), itemId: null };
        else if (to === 'chats') _anchorView = { level: 'chats', charName: $(this).attr('data-char'), chatId: null, itemId: null };
        else                     _anchorView = { level: 'chars', charName: null, chatId: null, itemId: null };
        renderAnchorPanel();
    });
    $anchor.on('click', '.sp-anchor-fullscreen', function () { toggleAnchorFullscreen(this); });
    // 全屏浮卡拖拽（PC 专属）：拖右下角标缩放；拖头部空白处移动（排除头部按钮，避免和返回/退出/删除冲突）。
    $anchor.on('mousedown', '.sp-anchor-fs-resize', function (e) { _anchorFsGestureStart('resize', e); });
    $anchor.on('mousedown', '.sp-anchor-fs-on .sp-anchor-head', function (e) {
        if ($(e.target).closest('button, .sp-icon-btn, .sp-anchor-back').length) return;
        _anchorFsGestureStart('move', e);
    });
    $anchor.on('click', '.sp-anchor-tag-edit', function () {
        if (!_anchorCurrentItem) return;
        _anchorFullTagEdit = true;
        renderAnchorFull(_anchorCurrentItem.id);
    });
    // 全文内联标签编辑：chip 点选即写库（就地改 it.tags，连点不丢）、新建即选中、完成收起。
    $anchor.on('click', '.sp-anchor-ftag-chip', async function () {
        const it = _anchorCurrentItem;
        if (!it) return;
        const id = $(this).attr('data-id');
        const cur = new Set(Array.isArray(it.tags) ? it.tags : []);
        if (cur.has(id)) cur.delete(id); else cur.add(id);
        it.tags = [...cur];
        $(this).toggleClass('sp-tp-chip-on');   // 就地反馈，不整体重渲（避免网络往返闪烁）
        try { await anchor.setItemTags(it.id, [...cur]); }
        catch (err) { showToast('保存标签失败：' + (err?.message || ''), null, true); }
    });
    $anchor.on('click', '.sp-anchor-ftag-swatch', function () {
        const scope = $(this).closest('.sp-anchor-ftag-new');
        scope.find('.sp-anchor-ftag-swatch').removeClass('sp-tp-swatch-on');
        $(this).addClass('sp-tp-swatch-on');
    });
    $anchor.on('click', '.sp-anchor-ftag-add', async function () {
        const it = _anchorCurrentItem;
        if (!it) return;
        const scope = $(this).closest('.sp-anchor-ftag-new');
        const nm = String(scope.find('.sp-anchor-ftag-name').val() || '').trim();
        if (!nm) { scope.find('.sp-anchor-ftag-name').trigger('focus'); return; }
        const color = scope.find('.sp-anchor-ftag-swatch.sp-tp-swatch-on').attr('data-color') || ANCHOR_TAG_PALETTE[0];
        try {
            const tag = await anchor.addTag(nm, color);   // 同名去重：返回既有
            const cur = new Set(Array.isArray(it.tags) ? it.tags : []);
            if (tag) cur.add(tag.id);
            it.tags = [...cur];
            await anchor.setItemTags(it.id, [...cur]);
            renderAnchorFull(it.id);   // 重渲以显示新 chip（已选中）
        } catch (err) { showToast('新建标签失败：' + (err?.message || ''), null, true); }
    });
    $anchor.on('keydown', '.sp-anchor-ftag-name', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); $(this).closest('.sp-anchor-ftag-new').find('.sp-anchor-ftag-add').trigger('click'); }
    });
    $anchor.on('click', '.sp-anchor-ftag-done', function () {
        _anchorFullTagEdit = false;
        if (_anchorCurrentItem) renderAnchorFull(_anchorCurrentItem.id);
    });
    $anchor.on('click', '.sp-anchor-del', async function () {
        const it = _anchorCurrentItem;
        if (!it) return;
        if (!await spConfirm({ title: '删除收藏', body: '确定删除这条收藏吗？原楼层不受影响。' })) return;
        await anchor.deleteItem(it.id);
        _anchorSavedKeys.delete(anchorFloorKey(it.chatId, it.messageId));
        // 若删的是当前 chat 的楼，同步该楼收藏按钮态
        if (String(getContext().chatId) === String(it.chatId)) {
            document.querySelectorAll('#chat .mes .sp-anchor-btn').forEach(btn => {
                const mid = btn.closest('.mes')?.getAttribute('mesid');
                if (String(mid) === String(it.messageId)) { btn.classList.remove('sp-anchor-saved'); btn.title = '收藏此楼'; }
            });
        }
        showToast('已删除收藏');
        _anchorView = { level: 'items', charName: _anchorView.charName, chatId: it.chatId, itemId: null };
        renderAnchorPanel();
    });

    // ── 标签筛选栏（三层通用）：点标签筛、点「全部」清 ──
    $anchor.on('click', '.sp-anchor-filter-chip', function () {
        const id = $(this).attr('data-id') || null;
        _anchorTagFilter = (id && id === _anchorTagFilter) ? null : id;   // 再点已选=清除
        renderAnchorPanel();
    });

    // ── 标签管理面：入口 + 建/改名/改色/删 ──
    $anchor.on('click', '.sp-anchor-tagmgr-btn', function () {
        _tagMgrEditId = null; _tagMgrDelId = null;
        _anchorView = { level: 'tags', charName: null, chatId: null, itemId: null };
        renderAnchorPanel();
    });
    // 色板选色：仅在所属行内高亮（新建行 / 某编辑行各自独立），保存时现读高亮项，无需额外状态
    $anchor.on('click', '.sp-tagmgr-swatch', function () {
        const scope = $(this).closest('.sp-anchor-tagmgr-new, .sp-anchor-tagmgr-row');
        scope.find('.sp-tagmgr-swatch').removeClass('sp-tp-swatch-on');
        $(this).addClass('sp-tp-swatch-on');
    });
    const _tagMgrPickedColor = (scopeEl) => scopeEl.find('.sp-tagmgr-swatch.sp-tp-swatch-on').attr('data-color') || ANCHOR_TAG_PALETTE[0];
    $anchor.on('click', '.sp-tagmgr-new-add', async function () {
        const scope = $(this).closest('.sp-anchor-tagmgr-new');
        const nm = String(scope.find('.sp-tagmgr-new-name').val() || '').trim();
        if (!nm) { scope.find('.sp-tagmgr-new-name').trigger('focus'); return; }
        try { await anchor.addTag(nm, _tagMgrPickedColor(scope)); renderAnchorTagManager(); }
        catch (err) { showToast('新建标签失败：' + (err?.message || ''), null, true); }
    });
    $anchor.on('keydown', '.sp-tagmgr-new-name', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); $(this).closest('.sp-anchor-tagmgr-new').find('.sp-tagmgr-new-add').trigger('click'); }
    });
    $anchor.on('click', '.sp-tagmgr-edit', function () {
        _tagMgrEditId = $(this).closest('.sp-anchor-tagmgr-row').attr('data-id');
        _tagMgrDelId = null;
        renderAnchorTagManager();
    });
    $anchor.on('click', '.sp-tagmgr-cancel', function () { _tagMgrEditId = null; renderAnchorTagManager(); });
    $anchor.on('keydown', '.sp-tagmgr-name-input', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); $(this).closest('.sp-anchor-tagmgr-row').find('.sp-tagmgr-save').trigger('click'); }
    });
    $anchor.on('click', '.sp-tagmgr-save', async function () {
        const row = $(this).closest('.sp-anchor-tagmgr-row');
        const id  = row.attr('data-id');
        const nm  = String(row.find('.sp-tagmgr-name-input').val() || '').trim();
        const color = _tagMgrPickedColor(row);
        try {
            if (nm) await anchor.renameTag(id, nm);
            await anchor.recolorTag(id, color);
            _tagMgrEditId = null;
            renderAnchorTagManager();
        } catch (err) { showToast('保存标签失败：' + (err?.message || ''), null, true); }
    });
    $anchor.on('click', '.sp-tagmgr-del', function () {
        _tagMgrDelId = $(this).closest('.sp-anchor-tagmgr-row').attr('data-id');
        _tagMgrEditId = null;
        renderAnchorTagManager();
    });
    $anchor.on('click', '.sp-tagmgr-del-no', function () { _tagMgrDelId = null; renderAnchorTagManager(); });
    $anchor.on('click', '.sp-tagmgr-del-yes', async function () {
        const id = $(this).closest('.sp-anchor-tagmgr-row').attr('data-id');
        try {
            const n = await anchor.deleteTag(id);
            if (_anchorTagFilter === id) _anchorTagFilter = null;   // 正筛的标签被删 → 清筛
            _tagMgrDelId = null;
            showToast(`已删除标签${n ? `（从 ${n} 条收藏移除）` : ''}`);
            renderAnchorTagManager();
        } catch (err) { showToast('删除标签失败：' + (err?.message || ''), null, true); }
    });

    // ── 历（日历）事件（委托到 #sp-almanac-wrap，两个 sheet 动态重渲染）──
    const $almanac = $in('#sp-almanac-wrap');
    $almanac.on('click', '.sp-alm-sheet-btn', function () { almSetSheet($(this).attr('data-sheet')); });
    // 暗账页：自动标注开关 / 间隔 / 立即标注。委托到 #sp-almanac-wrap，随 sheet 重渲染存活。
    $almanac.on('change', '.sp-ledger-auto-toggle', function () {
        getSettings().ledgerCaptureEnabled = this.checked;
        saveSettingsDebounced();
        ledgerCaptureCounter = 0;   // 开/关都重置计数，避免残留计数刚开就触发
        renderAlmanacPanel();       // 开/关切换后空态提示措辞跟着变（关态催勾开关、开态提示已自动）
    });
    $almanac.on('change', '.sp-ledger-interval', function () {
        const n = Math.max(1, Math.min(30, Math.floor(Number(this.value) || 5)));
        getSettings().ledgerCaptureInterval = n;
        this.value = String(n);     // 规范化回填
        saveSettingsDebounced();
        ledgerCaptureCounter = 0;
    });
    $almanac.on('click', '.sp-ledger-capture-now', function () {
        if (isCapturingLedger) return;
        const p = runLedgerCaptureStep(true);   // 同步内设 isCapturingLedger=true（守卫通过时）
        renderAlmanacPanel();                    // 立刻渲染成 busy 态（spinner + 禁用）
        p.then(() => { if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel(); });
    });
    $almanac.on('click', '.sp-ledger-judge-now', function () {
        if (isJudgingLedger) return;
        const p = runLedgerJudgeStep(true);      // manual=true：无活跃条目/无改动时给 toast
        renderAlmanacPanel();                    // 立刻渲染成 busy 态（spinner + 禁用）
        p.then(() => { if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel(); });
    });
    // 暗历行操作：编辑 / 锁·解锁 / 了结（软删·可捞回）。id 从行容器取。
    $almanac.on('click', '.sp-ledger-edit', function (e) {
        e.stopPropagation();
        const id = $(this).closest('.sp-ledger-row').attr('data-id');
        if (id) openLedgerEditor(id);
    });
    $almanac.on('click', '.sp-ledger-lock-toggle', function (e) {
        e.stopPropagation();
        const id = $(this).closest('.sp-ledger-row').attr('data-id');
        const it = id && ledger.getEntry(id);
        if (!it) return;
        if (it.锁 === '用户锁') { ledger.unlockEntry(id); showToast('已解锁 · AI 判定可再更新此条'); }
        else { ledger.lockEntry(id); showToast('已锁定 · AI 判定不再改动此条'); }
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });
    // 暗历行·暂停埋入（静音）：翻标志位。注入集当场变 → 必刷 refreshLedgerInjection（区别于锁：锁不动注入集）。
    $almanac.on('click', '.sp-ledger-mute-toggle', function (e) {
        e.stopPropagation();
        const id = $(this).closest('.sp-ledger-row').attr('data-id');
        const it = id && ledger.getEntry(id);
        if (!it) return;
        if (it.静音 === true) { ledger.unmuteEntry(id); showToast('已恢复埋入 · 重新参与注入'); }
        else { ledger.muteEntry(id); showToast('已暂停埋入 · 保留跟进、暂不注入主楼'); }
        refreshLedgerInjection();   // 注入集变了 → 当场重算（静音条即刻退出/回归注入）
        refreshInlineWindow(true);  // 标注池静音态变了 → 刷楼内框
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });
    $almanac.on('click', '.sp-ledger-close', async function (e) {
        e.stopPropagation();
        const id = $(this).closest('.sp-ledger-row').attr('data-id');
        const it = id && ledger.getEntry(id);
        if (!it) return;
        const ok = await spConfirm({ title: '了结条目', body: `把「${it.事由}」移出活跃刻度？可在归档里捞回。`, confirmText: '了结', cancelText: '取消' });
        if (!ok) return;
        ledger.closeEntry(id);
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });
    // 归档折叠区：标题条切换展开/收起。
    $almanac.on('click', '.sp-ledger-archive-head', function (e) {
        e.stopPropagation();
        toggleLedgerArchiveOpen();
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });
    // 归档条：捞回（回活跃）/ 彻底删（物理删·带确认·不可逆）。
    $almanac.on('click', '.sp-ledger-reopen', function (e) {
        e.stopPropagation();
        const id = $(this).closest('.sp-ledger-row').attr('data-id');
        if (!id || !ledger.getEntry(id)) return;
        ledger.reopenEntry(id);
        showToast('已捞回 · 回到活跃、判定车重新跟进');
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });
    $almanac.on('click', '.sp-ledger-remove', async function (e) {
        e.stopPropagation();
        const id = $(this).closest('.sp-ledger-row').attr('data-id');
        const it = id && ledger.getEntry(id);
        if (!it) return;
        const ok = await spConfirm({ title: '彻底删除', body: `「${it.事由}」将被永久删除，无法恢复。确定？`, confirmText: '删除', cancelText: '取消' });
        if (!ok) return;
        ledger.removeEntry(id);
        if (axisState.almanacMode && axisState._almanacSheet === 'ledger') renderAlmanacPanel();
    });
    // 暗历编辑窗内：保存 / 取消 / 返回 / 展开改起始锚。
    $almanac.on('click', '.sp-led-editor-save', saveLedgerEditor);
    $almanac.on('click', '.sp-led-editor-cancel, .sp-led-editor-back', closeLedgerEditor);
    $almanac.on('click', '.sp-led-adv-open', function () {
        const ed = getLedgerEditor();
        if (ed) { ed.advanced = true; renderAlmanacPanel(); }
    });
    $almanac.on('click', '.sp-alm-add', function () { openAlmanacEditor(null); });
    $almanac.on('click', '.sp-alm-gen', triggerGenerateAlmanac);
    $almanac.on('click', '.sp-alm-supplement', triggerSupplementAnniversary);
    $almanac.on('click', '.sp-alm-manage', openCalendarManager);
    $almanac.on('click', '.sp-action-menu-toggle', function (event) {
        event.stopPropagation();
        const menu = $(this).closest('.sp-action-menu')[0];
        const willOpen = !$(menu).hasClass('sp-action-menu-open');
        closeActionMenus(menu);
        $(menu).toggleClass('sp-action-menu-open', willOpen).find('.sp-action-menu-list').attr('hidden', !willOpen);
        $(this).attr('aria-expanded', String(willOpen));
    });
    $almanac.on('click', '.sp-action-menu-item', function () {
        const action = $(this).attr('data-action');
        closeActionMenus();
        if (action === 'generate-almanac') triggerGenerateAlmanac();
        else if (action === 'supplement-anniversary') triggerSupplementAnniversary();
        else if (action === 'manage-calendar') openCalendarManager();
    });
    $almanac.on('click', '.sp-alm-pin', function () { toggleAlmanacPin($(this).attr('data-id')); });
    $almanac.on('click', '.sp-alm-edit', function () { openAlmanacEditor($(this).attr('data-id')); });
    $almanac.on('click', '.sp-alm-del', function () { deleteAlmanacItem($(this).attr('data-id')); });
    // ── 历面板批量模式：三个入口（日历条目删 / 活跃刻度归档 / 归档刻度删）。严格限定 scope，不接模板管理。──
    $almanac.on('click', '.sp-batch-enter', function (e) {
        e.stopPropagation();
        const scope = $(this).attr('data-scope');
        if (!BATCH_SCOPES.includes(scope)) return;   // 严格限定入口：仅 'almanac' / 'ledger-active' / 'ledger-archive'
        setBatchScope(scope);
        getBatchSelected().clear();
        renderAlmanacPanel();
    });
    $almanac.on('click', '.sp-batch-exit', function (e) {
        e.stopPropagation();
        batchReset();
        renderAlmanacPanel();
    });
    $almanac.on('change', '.sp-batch-selall', function () {
        const scope = getBatchScope();
        if (!scope || !BATCH_SCOPES.includes(scope)) return;
        if (this.checked) batchScopeIds(scope).forEach(id => getBatchSelected().add(id));
        else getBatchSelected().clear();
        renderAlmanacPanel();
    });
    $almanac.on('change', '.sp-batch-check', function () {
        const id = $(this).closest('[data-id]').attr('data-id');
        if (id == null) return;
        if (this.checked) getBatchSelected().add(id);
        else getBatchSelected().delete(id);
        renderAlmanacPanel();
    });
    $almanac.on('click', '.sp-batch-exec', async function (e) {
        e.stopPropagation();
        const scope = getBatchScope();
        const ids = [...getBatchSelected()];
        if (!scope || !BATCH_SCOPES.includes(scope) || !ids.length) return;
        await execBatch(scope, ids);
    });
    // 历面板「今天」栏：±1天 / 改（内联月日） / 自动（清锚） / 同步到点。前三者经 runAnchorAftermath 共享善后
    // （刷两条只读条 + 历面板）；改今天不再自动烧点，点要跟随由「同步到点」键显式触发（历点共用这枚今天锚点）。
    $almanac.on('click', '.sp-alm-today-prev', function () { almNudgeToday(-1); });
    $almanac.on('click', '.sp-alm-today-next', function () { almNudgeToday(1); });
    $almanac.on('click', '.sp-alm-today-edit', function () {
        axisState._almTodayEditing = true;
        renderAlmanacPanel();
        setTimeout(() => $in('#sp-alm-today-month').trigger('focus'), 30);
    });
    $almanac.on('click', '.sp-alm-today-cancel', function () { axisState._almTodayEditing = false; renderAlmanacPanel(); });
    $almanac.on('click', '.sp-alm-today-save', function () {
        if (storyClockEnabled()) { axisState._almTodayEditing = false; renderAlmanacPanel(); return; }   // 戳开时手动钉禁用（防陈旧 DOM 误触）
        const key = charStableKey(getContext());
        if (!key) { showToast('当前没有角色卡，无法钉日期', null, true); return; }
        const mo = parseInt($in('#sp-alm-today-month').val(), 10);
        const da = parseInt($in('#sp-alm-today-day').val(), 10);
        const _tcal = loadCalDesc();
        const _tmc = calMonthCount(_tcal);
        if (!(mo >= 1 && mo <= _tmc)) { showToast(`请填 1-${_tmc} 月`, null, true); return; }
        const _tdmax = calMonthDays(_tcal, mo);
        if (!(da >= 1 && da <= _tdmax)) { showToast(`${mo} 月只有 1-${_tdmax} 日`, null, true); return; }
        setDateAnchor(key, mo, da);
        axisState._almTodayEditing = false;
        runAnchorAftermath();
        showToast(`已把今天钉为 ${mo}月${da}日`);
    });
    $almanac.on('click', '.sp-alm-today-clear', function () {
        if (storyClockEnabled()) return;   // 戳开时无「恢复自动」概念（今天恒由戳钉）；防陈旧 DOM 误触
        const key = charStableKey(getContext());
        if (!key) return;
        setDateAnchor(key, null);   // 清锚 → 恢复自动确认
        runAnchorAftermath();
        showToast('已清除手动日期，恢复自动确认');
    });
    // 月历：翻月 / 选日（再点已选=取消回全月）/ 看全月 / 加到某天
    $almanac.on('click', '.sp-alm-cal-prev', function () { almNavMonth(-1); });
    $almanac.on('click', '.sp-alm-cal-next', function () { almNavMonth(1); });
    $almanac.on('click', '.sp-alm-time-travel', function () {
        const day = Number($(this).attr('data-day'));
        if (Number.isInteger(day)) startTimeTravel({ month: almCalMonth() + 1, day });
    });
    $almanac.on('click', '.sp-alm-time-travel-stop', function () { cancelTimeTravel(); });
    $almanac.on('click', '.sp-alm-cell[data-day]', function () { almSelectDay(parseInt($(this).attr('data-day'), 10)); });
    $almanac.on('click', '.sp-alm-cal-clearsel', function () { axisState._almanacCalDay = null; renderAlmanacPanel(); });
    $almanac.on('click', '.sp-alm-add-day', function () {
        openAlmanacEditor(null, { month: almCalMonth() + 1, day: parseInt($(this).attr('data-day'), 10) || 1 });
    });
    // 上下联动：点日历详情里某条 → 高亮它在网格覆盖的那天/那几天，再点一下取消（就地改 class，不重渲）
    $almanac.on('click', '.sp-alm-cal-detail .sp-alm-item', function (e) {
        if ($(e.target).closest('button').length) return;   // 不劫持锁/编辑/删除按钮
        const wasLinked = $(this).hasClass('sp-alm-item-linked');
        $inAll('#sp-almanac-wrap .sp-alm-item-linked').removeClass('sp-alm-item-linked');
        almClearHilite();
        if (wasLinked) return;   // 再点=取消高亮
        $(this).addClass('sp-alm-item-linked');
        almHiliteCells(loadAlmanac().find(x => x.id === $(this).attr('data-id')));
    });
    $almanac.on('click', '#sp-abort-almanac', abortAlmanacGen);
    // F4：日历里点空白处（非日格/条目/控件）→ 清掉当前瞬时态。既回退「选中某天」，也清「上下联动高亮」，两者任一存在都响应，做到点空白必回干净全月。
    $almanac.on('click', function (e) {
        if (!axisState.almanacMode || axisState._almanacEditor || axisState._almanacSheet !== 'calendar') return;
        if ($(e.target).closest('.sp-alm-cell,.sp-alm-item,button,input,select,textarea,.sp-alm-cal-detail-head').length) return;
        if (axisState._almanacCalDay != null) {
            axisState._almanacCalDay = null;
            renderAlmanacPanel();   // 重渲染顺带把联动高亮的 class 冲掉
        } else if ($inAll('#sp-almanac-wrap .sp-alm-item-linked').length) {
            $inAll('#sp-almanac-wrap .sp-alm-item-linked').removeClass('sp-alm-item-linked');
            almClearHilite();       // 只清高亮 class，不重渲，避免闪
        }
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
        axisState._almanacManager.editing = true;
        axisState._almanacManager.draft = cloneCalDesc(loadCalDesc());
        axisState._almanacManager.error = '';
        renderAlmanacPanel();
    });
    $almanac.on('click', '.sp-alm-manager-edit-cancel', function () {
        axisState._almanacManager.editing = false;
        axisState._almanacManager.draft = cloneCalDesc(loadCalDesc());
        axisState._almanacManager.error = '';
        renderAlmanacPanel();
    });
    $almanac.on('click', '.sp-alm-manager-add-month', function () {
        captureCalendarDraft();
        if (axisState._almanacManager.draft.months.length >= CALENDAR_LIMITS.monthCount) {
            axisState._almanacManager.error = `最多只能有 ${CALENDAR_LIMITS.monthCount} 个月份`;
            renderAlmanacPanel();
            return;
        }
        const index = axisState._almanacManager.draft.months.length;
        axisState._almanacManager.draft.months.push({ name: `${index + 1}月`, days: CALENDAR_LIMITS.defaultMonthDays });
        axisState._almanacManager.error = '';
        renderAlmanacPanel({ reveal: { kind: 'month', index }, focus: { kind: 'month', index, selector: '.sp-alm-manager-month-name' } });
    });
    $almanac.on('click', '.sp-alm-manager-month-delete', async function () {
        captureCalendarDraft();
        if (axisState._almanacManager.draft.months.length <= 1) { axisState._almanacManager.error = '至少保留一个月份'; renderAlmanacPanel(); return; }
        const manager = axisState._almanacManager;
        const chatIdSnap = getContext().chatId;
        const index = Number($(this).closest('.sp-alm-manager-month-row').attr('data-index'));
        const month = manager.draft.months[index];
        if (!month) return;
        const ok = await customDialog.confirm({
            title: '删除月份',
            body: `确定删除月份「${month.name}」吗？保存历法时会继续检查受影响的纪念日。`,
            confirmText: '删除',
            cancelText: '取消',
        });
        if (!ok || axisState._almanacManager !== manager || getContext().chatId !== chatIdSnap || manager.draft.months[index] !== month) return;
        manager.draft.months.splice(index, 1);
        manager.error = '';
        const nextIndex = Math.min(index, manager.draft.months.length - 1);
        renderAlmanacPanel({ reveal: { kind: 'month', index: nextIndex }, focus: { kind: 'month', index: nextIndex, selector: '.sp-alm-manager-month-delete' } });
    });
    $almanac.on('click', '.sp-alm-manager-month-copy', function () {
        captureCalendarDraft();
        const index = Number($(this).closest('.sp-alm-manager-month-row').attr('data-index'));
        if (!copyCalendarMonth(axisState._almanacManager.draft.months, index, CALENDAR_LIMITS.monthCount)) {
            axisState._almanacManager.error = axisState._almanacManager.draft.months.length >= CALENDAR_LIMITS.monthCount ? `最多只能有 ${CALENDAR_LIMITS.monthCount} 个月份` : '找不到要复制的月份';
            renderAlmanacPanel();
            return;
        }
        axisState._almanacManager.error = '';
        renderAlmanacPanel({ reveal: { kind: 'month', index: index + 1 }, focus: { kind: 'month', index: index + 1, selector: '.sp-alm-manager-month-name' } });
    });
    $almanac.on('click', '.sp-alm-manager-month-up, .sp-alm-manager-month-down', function () {
        captureCalendarDraft();
        const index = Number($(this).closest('.sp-alm-manager-month-row').attr('data-index'));
        const movingUp = $(this).hasClass('sp-alm-manager-month-up');
        const nextIndex = index + (movingUp ? -1 : 1);
        if (nextIndex < 0 || nextIndex >= axisState._almanacManager.draft.months.length) return;
        [axisState._almanacManager.draft.months[index], axisState._almanacManager.draft.months[nextIndex]] = [axisState._almanacManager.draft.months[nextIndex], axisState._almanacManager.draft.months[index]];
        renderAlmanacPanel({ reveal: { kind: 'month', index: nextIndex }, focus: { kind: 'month', index: nextIndex, selector: movingUp ? '.sp-alm-manager-month-up' : '.sp-alm-manager-month-down' } });
    });
    $almanac.on('input', '.sp-alm-manager-edit-fields input', function () {
        if (!axisState._almanacManager?.error) return;
        axisState._almanacManager.error = '';
        $inAll('#sp-almanac-wrap .sp-alm-manager-error').remove();
    });
    $almanac.on('click', '.sp-alm-manager-edit-save', async function () {
        axisState._almanacManager.draft = readCalendarDraftForm();
        axisState._almanacManager.error = '';
        $inAll('#sp-almanac-wrap .sp-alm-manager-error').remove();
        const checked = validateCalendarDesc(axisState._almanacManager.draft);
        if (!checked.value) {
            showToast(checked.error, null, true);
            return;
        }
        const result = await commitCalendarDesc(checked.value);
        if (!result.ok) {
            if (result.cancelled) return;
            const message = result.error || '历法保存失败';
            showToast(message, null, true);
            return;
        }
        if (axisState._almanacManager) {
            axisState._almanacManager.editing = false;
            axisState._almanacManager.draft = cloneCalDesc(result.cal);
            axisState._almanacManager.error = '';
            renderAlmanacPanel();
        }
        if (getSettings().notifyMode !== 'off') showToast(`历法已更新：${calendarSummary(result.cal)}`);
    });
    $almanac.on('click', '.sp-alm-manager-template-head', function () {
        axisState._almanacManager.templatesOpen = !axisState._almanacManager.templatesOpen;
        axisState._almanacManager.bindTemplateId = null;
        axisState._almanacManager.bindQuery = '';
        renderAlmanacPanel({ focus: { selector: '.sp-alm-manager-template-head' } });
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
        if (name == null || !axisState._almanacManager) return;
        const latest = loadCalendarTemplates();
        if (latest.some(template => template.name === name)) {
            showToast('模板名称已存在，请换一个名称', null, true);
            return;
        }
        const now = Date.now();
        const id = calendarTemplateId();
        latest.push({ ...cloneCalDesc(loadCalDesc()), id, name, createdAt: now, updatedAt: now });
        saveCalendarTemplates(latest);
        renderAlmanacPanel({ reveal: { kind: 'template', id } });
    });
    $almanac.on('click', '.sp-alm-manager-template-rename', async function () {
        const id = $(this).attr('data-id');
        const list = loadCalendarTemplates();
        const template = list.find(item => item.id === id);
        if (!template) { showToast('模板已不存在', null, true); renderAlmanacPanel(); return; }
        const name = await customDialog.prompt({
            title: '重命名历法模板',
            body: '填写一个便于识别的新名称。',
            initialValue: template.name,
            placeholder: '模板名称',
            maxLength: CALENDAR_TEMPLATE_NAME_LENGTH,
            validate: value => !value ? '请填写模板名称' : (list.some(item => item.id !== id && item.name === value) ? '模板名称已存在，请换一个名称' : ''),
        });
        if (name == null || !axisState._almanacManager || name === template.name) return;
        const latest = loadCalendarTemplates();
        if (latest.some(item => item.id !== id && item.name === name)) { showToast('模板名称已存在，请换一个名称', null, true); return; }
        if (!latest.some(item => item.id === id)) { showToast('模板已不存在', null, true); renderAlmanacPanel(); return; }
        saveCalendarTemplates(renameCalendarTemplate(latest, id, name));
        if (axisState._almanacManager) renderAlmanacPanel({ reveal: { kind: 'template', id }, focus: { kind: 'template', id, selector: '.sp-alm-manager-template-rename' } });
    });
    $almanac.on('click', '.sp-alm-manager-template-apply', async function () {
        const template = loadCalendarTemplates().find(item => item.id === $(this).attr('data-id'));
        if (!template) { showToast('模板已不存在', null, true); renderAlmanacPanel(); return; }
        const ok = await customDialog.confirm({ title: '应用历法模板', body: `确定用「${template.name}」覆盖当前历法吗？`, confirmText: '应用', cancelText: '取消' });
        if (!ok || !axisState._almanacManager) return;
        const result = await commitCalendarDesc(template);
        if (!result.ok) { if (!result.cancelled) showToast(result.error || '模板应用失败', null, true); return; }
        axisState._almanacManager.draft = cloneCalDesc(result.cal);
        axisState._almanacManager.editing = false;
        renderAlmanacPanel({ reveal: { kind: 'template', id: template.id }, focus: { kind: 'template', id: template.id, selector: '.sp-alm-manager-template-apply' } });
        if (getSettings().notifyMode !== 'off') showToast(`已应用历法模板：${template.name}`);
    });
    $almanac.on('click', '.sp-alm-manager-template-delete', async function () {
        const id = $(this).attr('data-id');
        const template = loadCalendarTemplates().find(item => item.id === id);
        if (!template) { showToast('模板已不存在', null, true); renderAlmanacPanel(); return; }
        if (!await customDialog.confirm({ title: '删除历法模板', body: `确定删除「${template.name}」吗？角色卡绑定也会一并解除。`, confirmText: '删除', cancelText: '取消' })) return;
        const bindings = { ...calendarTemplateBindings() };
        for (const avatar of Object.keys(bindings)) if (bindings[avatar] === id) delete bindings[avatar];
        getSettings().calendarTemplateBindings = bindings;
        saveCalendarTemplates(loadCalendarTemplates().filter(item => item.id !== id));
        if (axisState._almanacManager) { axisState._almanacManager.bindTemplateId = null; renderAlmanacPanel({ focus: { selector: '.sp-alm-manager-template-head' } }); }
    });
    $almanac.on('click', '.sp-alm-manager-template-bind', function () {
        const id = $(this).attr('data-id');
        const opening = axisState._almanacManager.bindTemplateId !== id;
        axisState._almanacManager.bindTemplateId = opening ? id : null;
        axisState._almanacManager.bindQuery = '';
        renderAlmanacPanel({
            reveal: { kind: 'template', id, selector: opening ? '.sp-alm-manager-bind-search' : '.sp-alm-manager-template-bind' },
            focusBindingId: opening ? id : null,
            focus: opening ? null : { kind: 'template', id, selector: '.sp-alm-manager-template-bind' },
        });
    });
    $almanac.on('input', '.sp-alm-manager-bind-search', function () {
        if (!axisState._almanacManager) return;
        axisState._almanacManager.bindQuery = String($(this).val() ?? '');
        const id = $(this).attr('data-template-id');
        $(this).closest('.sp-alm-manager-bind-panel').find('.sp-alm-manager-bind-results').html(renderCalendarBindingOptions(id));
    });
    $almanac.on('click', '.sp-alm-manager-bind-option', async function () {
        await updateCalendarTemplateBinding($(this).attr('data-avatar'), $(this).attr('data-template-id'));
    });
    $almanac.on('click', '.sp-alm-manager-bind-chip-remove', async function () {
        await updateCalendarTemplateBinding($(this).attr('data-avatar'), null, $(this).attr('data-template-id'));
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
                anchorMode = false;
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
                loadCreativeChatHistory();
                updateCreativeChatModeUI();
                renderCreativeChatHistory();
                // 生成在途时切回来：重建 loading，别 fallback 到"生成面"空态误导用户
                if (isGeneratingOutline) {
                    setOutlineBody(loadingHtml('正在构思面', 'sp-abort-outline'));
                } else {
                    cachedOutline = loadCachedOutlineForCurrentChat();
                    if (cachedOutline) setOutlineBody(cachedOutline);
                    else setOutlineBody(renderEmptyOutlineState());
                }
                return;
            }
            if (view === 'lines') {
                if (linesMode) return;
                linesMode = true;
                outlineMode = false;
                spaceMode = false;
                theaterMode = false;
                anchorMode = false;
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
                if (isGeneratingLines) {
                    setLinesBody(loadingHtml('正在推演线', 'sp-abort-lines'));
                } else {
                    cachedLines = loadCachedLinesForCurrentChat();
                    if (cachedLines) setLinesBody(cachedLines);
                    else setLinesBody(renderEmptyLinesState());
                }
                return;
            }
            if (view === 'space') {
                if (spaceMode) return;
                spaceMode = true;
                outlineMode = false;
                linesMode = false;
                theaterMode = false;
                anchorMode = false;
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
                $in('#sp-space-input').attr('placeholder', getSpaceChatPlaceholder());
                loadSpaceChatHistory();
                renderSpaceChatHistory();
                return;
            }
            if (view === 'theater') {
                if (theaterMode) return;
                theaterMode = true;
                outlineMode = false;
                linesMode = false;
                spaceMode = false;
                anchorMode = false;
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
                // 打开棱面板即预取剧情上下文（世界书/人设，异步），供写作 agent 用
                refreshTheaterStoryContext().catch(() => {});
                if (isGeneratingTheater) {
                    setTheaterBody(loadingHtml('正在折射', 'sp-abort-theater'));
                } else {
                    renderTheaterPanel();
                }
                return;
            }
            if (view === 'anchor') {
                if (anchorMode) return;
                anchorMode = true;
                _anchorTagFilter = null;   // 进 anchor 视图复位筛选；层间导航才保留
                _tagMgrEditId = null; _tagMgrDelId = null;
                _anchorFullTagEdit = false;
                outlineMode = false;
                linesMode = false;
                spaceMode = false;
                theaterMode = false;
                axisState.almanacMode = false;
                $in('#sp-body').hide();
                $in('#sp-outline-wrap').hide();
                $in('#sp-lines-wrap').hide();
                $in('#sp-space-wrap').hide();
                $in('#sp-theater-wrap').hide();
                $in('#sp-almanac-wrap').hide();
                $in('#sp-anchor-wrap').css('display', 'flex');
                $in('#sp-sub-toggle').hide();
                $in('#sp-content-title').text('坐标');
                renderAnchorPanel();
                return;
            }
            if (view === 'almanac') {
                if (axisState.almanacMode) return;
                axisState.almanacMode = true;
                outlineMode = false;
                linesMode = false;
                spaceMode = false;
                theaterMode = false;
                anchorMode = false;
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
            if (anchorMode)  { anchorMode  = false; $in('#sp-anchor-wrap').hide(); }
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

    $in('#sp-cfg-save').on('click',      saveSettings);
    $in('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $in('#sp-fetch-models').on('click',  fetchModels);
    bindApiPresetEvents();
    renderApiPresetList();
    renderUtilityPresetList();
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
        refreshOutlineInjection();
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
    // 历·七天条开关：立刻生效。段开关变 → 重算所有窗内楼（每层楼的历段随之显/隐）。
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
        if (linesMode) refreshLinesPanel();
        syncLatestInlineBlock();
    });
    $in('#sp-dashed-cleanup-enabled').on('change', function () {
        getSettings().dashedCleanupEnabled = this.checked;
        $in('#sp-dashed-keep-count').prop('disabled', !this.checked);
        saveSettingsDebounced();
        if (this.checked) applyDashedCleanupToCurrent(true);
    });
    $in('#sp-dashed-keep-count').on('change', function () {
        const count = normalizeDashedKeepCount(this.value);
        getSettings().dashedKeepCount = count;
        this.value = String(count);
        saveSettingsDebounced();
        if (getSettings().dashedCleanupEnabled !== false) applyDashedCleanupToCurrent(true);
    });
    // 大纲自动注入（面）开关：on → 按当前大纲+游标立即注入；off → 清空扩展 prompt（游标留 chat_metadata，再开即续）
    $in('#sp-outline-inject').on('change', function () {
        getSettings().outlineInject = this.checked;
        saveSettingsDebounced();
        outlineJudgeMsgCounter = 0;   // 开/关都重置计数，避免残留计数导致刚开就判
        refreshOutlineInjection();
        // 面板开着看大纲 → 重渲染让高亮出现/消失
        if (outlineMode) { const s = readStore(getOutlineCacheKey()); if (s?.raw) { cachedOutline = renderOutline(s.raw, getOutlineCursor()); setOutlineBody(cachedOutline); } }
    });
    // 大纲判定间隔：改完即重新计数（避免旧计数立刻触发判定）
    $in('#sp-outline-judge-interval').on('change', function () {
        const n = Math.max(1, parseInt(this.value, 10) || 3);
        getSettings().outlineJudgeInterval = n;
        this.value = String(n);
        saveSettingsDebounced();
        outlineJudgeMsgCounter = 0;
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
    // 界面字体·应用：读两栏 → 存 uiFontUrl/uiFontFamily → 重挂 <link> + 改 --sp-font-user（applyUiFont 即时生效）
    // （merge-v3.1.0 适配：按钮/输入框在 shadow 窗口内，$→$in）
    $in('#sp-font-apply').on('click', () => {
        getSettings().uiFontUrl    = ($in('#sp-cfg-font-url').val()    || '').trim();
        getSettings().uiFontFamily = ($in('#sp-cfg-font-family').val() || '').trim();
        saveSettingsDebounced();
        applyUiFont();
        showToast('字体已应用');
    });
    // 界面字体·恢复默认：回填构画自带的有爱圆体 URL/字体名，同步刷两栏输入框
    $in('#sp-font-reset').on('click', () => {
        getSettings().uiFontUrl    = SP_FONT_DEFAULT_URL;
        getSettings().uiFontFamily = SP_FONT_DEFAULT_FAMILY;
        $in('#sp-cfg-font-url').val(SP_FONT_DEFAULT_URL);
        $in('#sp-cfg-font-family').val(SP_FONT_DEFAULT_FAMILY);
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
        scanAnchorButtons();
    });
    // Inline model list: pick an item → write to input + refresh active highlight
    $in('#sp-model-list-items').on('click', '.sp-model-list-item', function () {
        const model = $(this).attr('data-model');
        $in('#sp-cfg-model').val(model);
        $inAll('.sp-model-list-item').removeClass('sp-model-list-item-active');
        $(this).addClass('sp-model-list-item-active');
    });
    // Inline model list: live-filter as user types
    $in('#sp-model-list-search').on('input', function () {
        renderModelList(_cachedModels, $(this).val());
    });
    $in('#sp-cfg-key')
        .on('focus', () => { const r = $in('#sp-cfg-key').data('real'); if (r) $in('#sp-cfg-key').val(r); })
        .on('blur',  () => { const r = $in('#sp-cfg-key').val().trim() || $in('#sp-cfg-key').data('real') || ''; if (r) $in('#sp-cfg-key').data('real', r).val(maskKey(r)); });

    $in('#sp-body').on('click', '.sp-tab', function () {
        const idx   = parseInt($(this).data('day'));
        const total = parseInt($in('.sp-days-track').data('total')) || 4;
        $inAll('.sp-tab').removeClass('sp-tab-active');
        $(this).addClass('sp-tab-active');
        $inAll('.sp-days-track').css('transform', `translateX(-${idx * 100 / total}%)`);
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
        triggerGenerateOutline();
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
    const msgs = (ctx.chat || []).filter(m => !m.is_user).slice(-20);
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
    refreshLinesInjection();   // 视角切换 → 活跃线集合变了，重设潜伏注入跟随当前视角
    refreshOutlineInjection(); // 视角切换 → 大纲/游标随视角变，重设注入（loadCached 已带高亮）
    $inAll('.sp-view-btn').removeClass('sp-view-active');
    $inAll(`.sp-view-btn[data-view="${view}"]`).addClass('sp-view-active');
    pointState.cachedSchedule = loadCachedForCurrentChat();
    cachedOutline  = loadCachedOutlineForCurrentChat();
    outlineChatHistory = [];
    if (outlineMode) {
        loadCreativeChatHistory();
        updateCreativeChatModeUI();
        renderCreativeChatHistory();
    } else {
        $in('#sp-chat-msgs').empty();
    }
    if (outlineMode && cachedOutline) setOutlineBody(cachedOutline);
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
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-circle-stop"></i>中止生成</button></div>`);
        if (!pointState.isGenerating) {
            pointState.isGenerating = true;
            setExtBtnState('generating');
            runGenerate();
        }
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
    const saved = readStore(getCacheKey());
    if (saved?.raw) {
        pointState.cachedSchedule = renderSchedule(saved.raw, saved.userName || '用户', currentView);
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

// 面板每次打开都回到「点」首页：清掉上次残留的子视图（历/线/面/间/棱/坐标）+ 内联编辑器，
// 避免换聊天后重开还停在旧窗、内容残留。只复位视图，不 abort 生成、不动数据缓存。
// 无条件隐藏所有非点 wrap（不靠 mode 标志守卫）：CHAT_CHANGED 在面板隐藏时会把标志清成
// false 却不动 DOM，若这里再按标志判断就会漏隐藏 → 出现「点 + 坐标」同屏。故一律硬隐藏。
function resetPanelToScheduleHome() {
    outlineMode = linesMode = spaceMode = theaterMode = anchorMode = axisState.almanacMode = false;
    $in('#sp-outline-wrap').hide();
    $in('#sp-lines-wrap').hide();
    $in('#sp-space-wrap').hide();
    $in('#sp-theater-wrap').hide();
    $in('#sp-anchor-wrap').hide();
    $in('#sp-almanac-wrap').hide();
    axisState._almanacEditor = null;
    resetLedgerRenderState();
    axisState._almanacManager = null;
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
    _clearAnchorFs();
    inEl('#sp-theater-result')?.classList.remove('sp-theater-fullscreen');
    document.body.classList.remove('sp-theater-fs-lock');
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
        const text = await getDatabaseMemText({ query: '' }).catch(() => '');
        if (text) return true;
        return spConfirm({
            title: '数据库记忆为空',
            body: '当前角色主世界书中没有识别到数据库纪要。继续生成将不注入数据库历史。',
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
    if (pointState.isGenerating) return;
    if (axisState._almSyncingPoint) { showToast('点正在同步到今天，稍候', null, true); return; }   // 同步在飞：拦住点这边的生成，避免跟后台同步双写
    if (!await memoryPreCheckConfirm()) return;
    // F5 锁点对齐线：不清 raw，保留旧 raw（含 pin 标记）供 mergePinnedPoints 回并；
    // 生成失败/中止则旧点原样留存，成功后 runGenerate 覆写。
    pointState.cachedSchedule = null;
    pointState.isGenerating = true;
    setExtBtnState('generating');
    if (!$(`#${MODAL_ID}`).is(':visible')) showPanel();
    setBody(loadingHtml('正在规划', 'sp-abort-generate'));
    runGenerate({ reroll: true, module: 'point' });
}

async function runGenerate(travelContext = null) {
    // Snapshot view state — user may switch views while the request is in flight
    const viewSnap = currentView;
    const charSnap = charViewName;
    const myCtrl = pointState.scheduleAbortController = new AbortController();
    _autoRegenSchedAbort?.abort();   // 手动生成优先：掐掉可能在飞的「同步到点」后台生成，免得它慢半拍回来覆盖手动结果
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || '用户';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || '角色') : (ctx.name2 || '角色');
        const subject  = viewSnap === 'char' ? charName : userName;
        const cacheKey = getCacheKey(viewSnap, charSnap);
        const prevRaw  = readStore(cacheKey)?.raw || '';   // F5：旧 raw（含 pin 标记），对齐线
        // 已锁事件抽出来喂提示，让 AI 尽量别删（真删了 mergePinnedPoints 也会按 title 补回）
        const pinnedEvents = [];
        if (prevRaw) {
            const pc = parseCalendar(prevRaw);
            for (const d of pc.days) for (const ev of d.events) if (ev.pin) pinnedEvents.push(ev);
            if (pc.future) for (const ev of pc.future.events) if (ev.pin) pinnedEvents.push(ev);
        }
        const raw = await generate(ctx, userName, charName, viewSnap, myCtrl.signal, pinnedEvents, travelContext);
        if (pointState.scheduleAbortController !== myCtrl) return;   // 生成途中被中止/取代：丢弃本次结果
        // F5：合并锁定，机制对齐 mergePinnedLines(oldRaw, aiRaw)
        let merged = prevRaw ? mergePinnedPoints(prevRaw, raw) : raw;
        // 点恒跟随今天：手动生成也把 StartDate 钉到「今天」，与轴同日（今天由戳/手动钉/兜底经 almTodayAnchor 单一咽喉给出）。
        // 不钉的话 AI 常不产 StartDate → 点只显 1/2/3/未来相对天、无日期，正是用户困惑的「没日期」态。
        const t = almTodayAnchor();
        merged = forceStartDate(merged, t.month, t.day);
        const html   = renderSchedule(merged, subject, viewSnap);

        writeStore(cacheKey, { raw: merged, userName: subject, ts: Date.now() });
        syncLatestScheduleBlock();   // 点生成 → 楼内日程条即时刷
        pointState.isGenerating = false;
        pointState.scheduleAbortController = null;
        setExtBtnState('done');

        if (viewSnap === 'char') charViewName = charSnap;

        const stillOnView = currentView === viewSnap &&
            (viewSnap !== 'char' || charViewName === charSnap);
        if (stillOnView) {
            pointState.cachedSchedule = html;
            if ($(`#${MODAL_ID}`).is(':visible')) { setBody(html); if (getSettings().notifyMode !== 'off') showToast('点已生成'); }
            else showToast('点已生成，点击查看', () => { showPanel(); setBody(html); });
        } else {
            showToast('点已生成，点击查看', () => {
                setView(viewSnap, charSnap);
                pointState.cachedSchedule = html;
                showPanel();
                setBody(html);
            });
        }
        setTimeout(() => setExtBtnState(null), 6000);
    } catch (err) {
        if (pointState.scheduleAbortController !== myCtrl) return;   // 已中止/被新一次生成取代：状态与界面已另处理
        pointState.isGenerating = false;
        pointState.scheduleAbortController = null;
        setExtBtnState(null);
        if (err.name === 'AbortError') {
            if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) showEmptyGenerate();
            return;
        }
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`;
        if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) setBody(errHtml);
        else showToast('点生成失败，请重试', null, true);
    }
}

// 中止生成：立即撤下 loading、复位状态并 abort，不等待管线。
// 前置阶段（世界书组装等）不可打断，若只 abort 不即时复位界面，用户点"中止"会觉得没反应。
// 被中止的旧管线随后走各自 run* 的身份守卫（controller !== myCtrl）静默丢弃，不覆盖界面。
function abortScheduleGen() {
    if (!pointState.isGenerating) return;
    pointState.scheduleAbortController?.abort();
    pointState.scheduleAbortController = null;
    pointState.isGenerating = false;
    setExtBtnState(null);
    showEmptyGenerate();
}
function abortOutlineGen() {
    if (!isGeneratingOutline) return;
    outlineAbortController?.abort();
    outlineAbortController = null;
    isGeneratingOutline = false;
    setOutlineBody(`<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>已中止</p></div>`);
}
function abortLinesGen() {
    if (!isGeneratingLines) return;
    linesAbortController?.abort();
    linesAbortController = null;
    isGeneratingLines = false;
    setLinesBody(`<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>已中止</p></div>`);
}
function abortTheaterGen() {
    if (!isGeneratingTheater) return;
    theaterAbortController?.abort();
    theaterAbortController = null;
    isGeneratingTheater = false;
    theater.resetTheaterGenerating();   // 同步清 theater.js 内部标志，避免立刻再点生成误报"正在生成中"
    renderTheaterPanel();
}
function abortAlmanacGen() {
    if (!axisState.isGeneratingAlmanac) return;
    axisState.almanacAbortController?.abort();
    axisState.almanacAbortController = null;
    axisState.isGeneratingAlmanac = false;
    if (axisState.almanacMode) renderAlmanacPanel();
}

// 保存/查看时同步草稿里同 id 条目的 title（保证草稿列表与永久保存一致）
function syncDraftMeta(piece) {
    const drafts = theater.loadDrafts();
    const idx = drafts.findIndex(p => p.id === piece.id);
    if (idx >= 0) {
        drafts[idx].title = piece.title;
        // theater.js 无 setter；直接回写 localStorage 同一 key
        const chatId = getContext().chatId;
        const key = buildTheaterDraftKey(chatId);
        if (key) { try { localStorage.setItem(key, JSON.stringify(drafts.slice(-theater.THEATER_DRAFT_CAP))); } catch {} }
    }
}

// 在草稿+已保存里按 id 找 piece
function findPieceById(id) {
    return theater.loadDrafts().find(p => p.id === id)
        || theater.loadSaved().find(p => p.id === id)
        || null;
}

async function generate(ctx, userName, charName, perspective = 'user', signal = null, pinned = null, travelContext = null) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) {
        if (!settingsOpen) toggleSettings();
        throw new Error('请先在设置中填写自定义 API 的 URL 和 Key');
    }
    const prompt = appendTravelPromptContext(buildPrompt(userName, charName, perspective, pinned), travelContext);
    const apiOpts = travelContext?.feedback === 'time-travel' ? { fullMemory: true, ...travelContext } : (travelContext || {});
    return callCustomApi(ctx, prompt, cfg, userName, charName, signal, 10, apiOpts);
}


// Story context for theater's writing agent: world info + persona + character card.
// Reuses the same readers as 点/线/面 (buildWorldInfoContext / readCardExtras) so
// the mini-theater is grounded in the same setting. Returns sys blocks + names.
// NOTE: async work (world info) is prefetched into a cache on panel open; this
// sync accessor returns the last snapshot so theater.js can build messages sync.
let _theaterStorySnap = { sysBlocks: [], userName: '用户', charName: '角色' };
async function refreshTheaterStoryContext() {
    const ctx = getContext();
    const userName = ctx.name1 || '用户';
    const charName = ctx.name2 || '角色';
    const char = ctx.characters?.[ctx.characterId] ?? {};
    let wiContext = '';
    try { wiContext = await buildWorldInfoContext(ctx); } catch { wiContext = ''; }
    const { personaDesc, authorNote } = readCardExtras(ctx);
    const memText = await getMemText();
    const sysBlocks = [
        personaDesc      ? `【${userName} 的人物设定】\n${personaDesc}` : '',
        char.description ? `【${charName} 的背景资料】\n${char.description}` : '',
        char.personality ? `【性格】${char.personality}` : '',
        char.scenario    ? `【场景】${char.scenario}`    : '',
        authorNote       ? `【作者注释（当前聊天）】\n${authorNote}` : '',
        wiContext,
        memText ? `【故事记忆库】以下是本插件自动生成的剧情客观摘要（从最早到近期的关键事件与伏笔），作为这段小剧场的既有背景，注意与之保持连贯：\n\n${memText}` : '',
    ].filter(Boolean);
    _theaterStorySnap = { sysBlocks, userName, charName };
    return _theaterStorySnap;
}
function getTheaterStoryContext() { return _theaterStorySnap; }

// ─── World-info entry filter (per character) ──────────────────────────────────
// Stores disabled entry uids per character in extension_settings.
// Structure: extension_settings[PLUGIN_ID].wiFilter = { [charKey]: [key, ...] }
// where key = "worldName::uid" to survive re-imports and name collisions.
//
// charKey 用**角色卡文件名 avatar**（如 `坏狗.png`）——它跟着卡文件走、稳定不变。
// 早期误用 ctx.characterId（= this_chid，characters 数组的**下标索引**）：一旦增删/重排
// 角色，索引就漂移，同一张卡下次读到的是别人的（或空）设置——表现为每次进聊天筛选都被重置。
// 2.0.0 换稳定键，旧的数字键数据不迁移（已知会重置一次，发版公告告知用户重选）。
function charStableKey(ctx) {
    const c = ctx?.characters?.[ctx?.characterId];
    return c?.avatar || null;   // 无角色（群聊/未选卡）→ null，各 getter 守卫返回默认
}

function getWiFilter() {
    const s = getSettings();
    if (!s.wiFilter) s.wiFilter = {};
    return s.wiFilter;
}

function getDisabledKeys(charKey) {
    if (!charKey) return new Set();
    return new Set(getWiFilter()[charKey] || []);
}

function setDisabledKeys(charKey, disabledSet) {
    if (!charKey) return;
    getWiFilter()[charKey] = [...disabledSet];
    saveSettingsDebounced();
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

// Manual/auto "today" anchor for 历 + 点 (per-character). Stores {month, day}
// (year is meaningless in RP). Two writers: the user pinning a date by hand, and
// the auto-confirm judge writing the date it detected from recent floors. Read as
// the highest-priority tier in almTodayAnchor (before 柏宝书) so a pinned/confirmed
// date always wins over the slower passive sources. Keyed by card avatar like
// wiFilter (reason see charStableKey). Clearing (null) reverts to full auto.
function getDateAnchor(charKey) {
    if (!charKey) return null;
    const s = getSettings();
    if (!s.dateAnchor || typeof s.dateAnchor !== 'object') s.dateAnchor = {};
    const a = s.dateAnchor[charKey];
    if (!a) return null;
    const month = Number(a.month), day = Number(a.day);
    const cal = loadCalDesc();
    if (month >= 1 && month <= calMonthCount(cal) && day >= 1 && day <= calMonthDays(cal, month)) return { month, day };
    return null;
}

function setDateAnchor(charKey, month, day) {
    if (!charKey) return;
    const s = getSettings();
    if (!s.dateAnchor || typeof s.dateAnchor !== 'object') s.dateAnchor = {};
    if (month == null) { delete s.dateAnchor[charKey]; saveSettingsDebounced(); return; }
    const mo = Number(month), da = Number(day);
    const cal = loadCalDesc();
    if (mo >= 1 && mo <= calMonthCount(cal) && da >= 1 && da <= calMonthDays(cal, mo)) {
        s.dateAnchor[charKey] = { month: mo, day: da };
        saveSettingsDebounced();
    }
}

// ─── Per-character narrative scale ──────────────────────────────────────────
// Controls the granularity of storyline events. 'auto' means the LLM decides
// from card context; explicit values override that.
// Stored: extension_settings[PLUGIN_ID].scale = { [characterId]: 'auto'|'macro'|'meso'|'micro' }
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
        const extra = world_info?.charLore?.find(item => item?.name === fileName)?.extraBooks;
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
        if (Array.isArray(selected_world_info)) return selected_world_info.filter(Boolean);
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
// Each item: { key, uid, label, preview, content, source, embedded, scope }
//   scope = 'char'  → came from card's linked/embedded book
//         = 'global' → came from ST's global world info selection
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
                if (entry?.disable) continue;
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
                if (e.disabled) continue;
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
                if (entry?.disable) continue;
                const label = entry.comment || (Array.isArray(entry.key) ? entry.key.join(', ') : entry.key) || `条目 ${uid}`;
                const key = `${name}::${uid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({ key, uid, label, preview: String(entry.content || '').replace(/\s+/g, ' ').slice(0, 120), content: entry.content || '', source: name, embedded: false, scope: 'chat' });
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
                if (entry?.disable) continue;
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
                });
            }
        } catch { /* ignore individual load failure */ }
    }

    // 4. 用户/persona 世界书：ST「人物设定」页给当前 persona 链接的世界书（power_user.persona_description_lorebook）。
    //    与角色卡书同源读法（loadWorldInfo 取活状态），scope='persona' 供设置面板单列一栏、可逐条开关。
    //    已作为角色卡书 / 全局书收录过的同名书跳过，避免重复。
    const personaBook = String(ctx.powerUserSettings?.persona_description_lorebook || '').trim();
    if (personaBook && !worldNames.includes(personaBook) && !globalNames.includes(personaBook)) {
        try {
            const data = await ctx.loadWorldInfo(personaBook);
            if (data?.entries) {
                for (const [uid, entry] of Object.entries(data.entries)) {
                    if (entry?.disable) continue;
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
async function buildRecentChatContext(ctx, floorCount = 6, perMessageChars = 800) {
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || !chat.length) return '';
    const userName = ctx.name1 || '用户';
    const charName = ctx.name2 || '角色';
    const s = getSettings();
    const stripOpts = { keepTags: s.keepTags, extraTags: s.extraTags };
    // Walk from the end backwards, collect up to N usable entries (skip hidden system rows)
    const rows = [];
    for (let i = chat.length - 1; i >= 0 && rows.length < floorCount; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;   // hidden / OOC noise
        const raw = String(m.mes || '');
        if (!raw.trim()) continue;
        const cleaned = memory.stripTags(raw, stripOpts).trim();
        if (!cleaned) continue;
        const speaker = m.is_user ? userName : (m.name || charName);
        const capped = cleaned.length > perMessageChars
            ? cleaned.slice(0, perMessageChars) + '…'
            : cleaned;
        rows.unshift(`【${speaker}】${capped}`);
    }
    if (!rows.length) return '';
    return `【最近对话】以下是主聊天中最近几层对话原文，供理解当前剧情走向。\n\n${rows.join('\n\n')}`;
}

async function buildWorldInfoContext(ctx) {
    const disabledKeys = getDisabledKeys(charStableKey(ctx));
    const entries = await getCharBookEntries(ctx);
    const kept = entries
        .filter(e => !disabledKeys.has(e.key))
        .map(e => e.content)
        .filter(Boolean);
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
    const recent = Array.isArray(ctx?.chat) ? ctx.chat.slice(-6) : [];
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

async function getDatabaseMemText(opts = {}) {
    const th = globalThis.TavernHelper;
    const name = getDatabasePrimaryWorldbookName();
    if (!th || typeof th.getWorldbook !== 'function' || !name) return '';
    let entries;
    try { entries = await th.getWorldbook(name); } catch { return ''; }
    if (!Array.isArray(entries)) return '';
    const memories = entries.filter(entry => {
        const comment = String(entry?.comment || '').trim();
        return /^TavernDB-ACU-CustomExport-纪要-\d+$/i.test(comment)
            || /^(?:总结条目|小总结条目)(?:[\s_#-]*\d+)?(?:\s.*)?$/i.test(comment);
    }).map((entry, index) => ({
        text: String(entry?.content || '').trim(),
        tags: mergeRecallTags(entry),
        batch: index, slice: 0, time: '',
    })).filter(item => item.text);
    return selectAnimaSlices(memories, buildAnimaRecallQuery(opts.query), getAnimaRecallCount()).map(item => item.text).join('\n\n');
}

// Memory-source dispatcher. Priority: Anima → 柏宝书 → built-in L0/L1 store. The
// alternate sources are mutually exclusive (enforced in bindMemoryHandlers); each
// returns its own history or nothing (empty prompt block) — no fallback between them.
async function _getMemTextRaw(opts = {}) {
    const s = getSettings();
    if (s.useAnima) {
        try { return await getAnimaMemText(opts); }
        catch (err) { console.warn('[7dayscal] Anima 取摘要出错:', err); return ''; }
    }
    if (s.useDatabase) {
        try { return await getDatabaseMemText(opts); }
        catch (err) { console.warn('[7dayscal] 数据库取纪要出错:', err); return ''; }
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
            console.warn('[7dayscal] 柏宝书取历史出错:', err);
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
    catch (err) { console.warn('[7dayscal] 记忆预算封顶出错，回退原文:', err); return raw; }
}
function getMemMaxTokens() {
    const v = parseInt(getSettings().memMaxTokens, 10);
    return Number.isFinite(v) ? v : 60000;
}
async function _capMemText(text, full) {
    const t = String(text || '');
    if (!t.trim()) return t;
    const budget = getMemMaxTokens();
    if (budget <= 0) return t;                              // 0/负 = 关闭封顶
    let total;
    try { total = await getContext().getTokenCountAsync(t); }
    catch { total = Math.ceil(t.length / 2); }             // 分词器够不着 → 粗估 2 字/token
    if (total <= budget) return t;                         // 没超 → 原样返回
    // 填充按 95% 预算算，留 5% 余量：按块估 token 会漏掉块间 '\n\n'、省略标记、以及「单块内计数 vs 整体计数」的舍入差，
    // 不留余量会以约 1% 幅度轻微超顶。budget 是用户设的舒适上限，压到 95% 以内更稳。
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

// historyLimit：喂给这次调用的「最近 AI 楼」条数上限（连带其配对 user 楼）。默认 10。
// 传 0 = 完全不喂近景，只靠 system 块（人设/卡描述/世界书/记忆库）——冷知识发散专用，
// 免得被最近十楼里反复出现的某个道具/场景锚死。点/线/面/判定仍用默认 10（它们要贴当前剧情）。
function stripRerollModuleArtifacts(text) {
    return String(text || '')
        .replace(/<(?:calendar|schedule|storylines|line|outline|almanac|era)_widget(?:\s[^>]*)?>[\s\S]*?<\/(?:calendar|schedule|storylines|line|outline|almanac|era)_widget>/gi, '')
        .replace(/<\/?(?:calendar|schedule|storylines|line|outline|almanac|era)_widget(?:\s[^>]*)?>/gi, '')
        .trim();
}

async function buildMessages(ctx, prompt, userName, charName, historyLimit = 10, opts = {}) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const wiContext = await buildWorldInfoContext(ctx);
    const { personaDesc, authorNote } = readCardExtras(ctx);

    // Story memory (Plan C: objective memory + view tag)
    const rawMemText = await getMemText({ full: opts.fullMemory, query: prompt });
    const memText = opts.reroll ? stripRerollModuleArtifacts(rawMemText) : rawMemText;
    const memBlock = memText
        ? `【故事记忆库】以下由本插件在对话过程中自动生成的客观摘要，反映从最早到近期的关键事件与伏笔。请**优先信任记忆库描述**，即使它与角色卡/世界书中较早的描述冲突（因为记忆库记录了事件后的最新状态）。以 ${currentView === 'char' ? charName : userName} 的视角优先关注对其有意义的信息。\n\n${memText}`
        : '';

    // 历（本世界观重要日期）：历自己不进主楼，只在这里作为数据源反哺点/线/大纲。
    const almanacText = opts.noAlmanac ? '' : getAlmanacInjectText();
    const almanacBlock = almanacText
        ? `【本世界观·重要日期（历）】以下是这个世界的既定节日、生日、纪念日等重要日子，已按「当前剧情日期」标注倒计时；每条冒号后的「说明」是该日子的既定设定（由来、涉及人物阵营、习俗活动、持续天数等），是背景事实。\n${almanacText}\n\n★ 推演点/线/大纲时：凡列在【近期将至】里的日子（未来数日内或进行中），应**主动**把它纳入近期剧情——依据其「说明」里的设定生成与之相关的铺垫、筹备、事件或人物动向，让故事顺着该世界的历法自然推进；【全年其他重要日子】作为背景，时间线接近时再纳入考量。\n★ 务必尊重每条「说明」里的既定设定，据此展开合理、可延续的剧情；说明里没写到的细节可以合理补完，但**不得编造与既定设定冲突的内容**。`
        : '';

    // 历法（纪年/月份结构）：内置公历返回空、无需告知；自定义历法则反哺点/线/大纲，免得套用公历月份/天数。
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
    // 只取最近 historyLimit 个 AI 回复（连带配对的 user 楼），避免被早期上下文（如日期）锚定。
    // historyLimit=0 → 完全不喂历史（history 为空），只留 system + prompt。
    const allMsgs = ctx.chat ?? [];
    let history = [];
    if (historyLimit > 0) {
        let aiCount = 0;
        let startIdx = 0;   // 哨兵取 0：AI 楼不足 historyLimit 时喂全部历史；数满才把起点前移做截断
        for (let i = allMsgs.length - 1; i >= 0; i--) {
            if (!allMsgs[i].is_user) aiCount++;
            if (aiCount >= historyLimit) { startIdx = i; break; }
        }
        // 标签清洗（全局 keepTags/extraTags）：先剥标签结构、再替换变量占位符，
        // 免得展开出的内容里的尖括号被当成标签。点/线/面主生成经此统一清洗，
        // 与记忆采集(memory.getAiFloors)、间/面讨论(buildRecentChatContext)同口径。
        const s = getSettings();
        const stripOpts = { keepTags: s.keepTags, extraTags: s.extraTags };
        history = allMsgs.slice(startIdx).map((m, offset) => ({ m, mesId: startIdx + offset })).filter(({ m, mesId }) => {
            const excluded = _pendingReroll ? _rerollExcludedAssistant : null;
            if (!excluded || m.is_user || m.is_system) return true;
            return !(mesId === excluded.mesId && String(m.mes ?? '') === excluded.text);
        }).map(({ m }) => ({
            role   : m.is_user ? 'user' : 'assistant',
            content: substituteParams(opts.reroll ? stripRerollModuleArtifacts(memory.stripTags(m.mes ?? '', stripOpts)) : memory.stripTags(m.mes ?? '', stripOpts)),
        }));
    }
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: prompt }];
}

// ─── Outline cache helpers ────────────────────────────────────────────────────

function getOutlineCacheKey(view, charName) {
    return keyDesc('outline', view, charName);
}

function getCreativeChatHistoryKey(view, charName) {
    return keyDesc('creative-chat', view, charName);
}

function loadCreativeChatHistory(view, charName) {
    const saved = readStore(getCreativeChatHistoryKey(view, charName));
    outlineChatHistory = Array.isArray(saved) ? saved.filter(item => item?.role && item?.content) : [];
    return outlineChatHistory;
}

function saveCreativeChatHistory(view, charName) {
    writeStore(getCreativeChatHistoryKey(view, charName), outlineChatHistory);
}

function updateCreativeChatModeUI() {
    $in('#sp-chat-input').attr('placeholder', getCreativeChatPlaceholder());
}

function renderCreativeChatHistory() {
    const $msgs = $in('#sp-chat-msgs');
    $msgs.empty();
    outlineChatHistory.forEach((msg, idx) => {
        appendChatMsg(msg.role === 'assistant' ? 'ai' : msg.role, msg.content, idx);
    });
}

function loadCachedOutlineForCurrentChat(view, charName) {
    const saved = readStore(getOutlineCacheKey(view, charName));
    if (saved?.raw) {
        // 游标取自同一 saved 对象（对任意 view 都正确；有大纲无 cursor → 默认 1）。
        const n = Number(saved.cursor);
        const cursor = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
        return renderOutline(saved.raw, cursor);
    }
    return null;
}

// ─── Inject ───────────────────────────────────────────────────────────────────

function makeInjectBtn(text) {
    const id = ++_injectIdSeq;
    _injectTexts[id] = text;
    return `<button class="sp-inject-btn" data-iid="${id}" title="注入到输入框"><i class="fa-solid fa-arrow-right-to-bracket"></i></button>`;
}

// 复制按钮：仿 makeInjectBtn 把整段文本寄存进 _copyTexts、按钮带 data-cid，点击时 handler 取回写剪贴板。
// 用于面·逐 step 复制（每个剧情节点一份干净文本）。
const _copyTexts = {};
let _copyIdSeq = 0;
function makeCopyBtn(text) {
    const id = ++_copyIdSeq;
    _copyTexts[id] = text;
    return `<button class="sp-beat-copy" data-cid="${id}" title="复制这一步"><i class="fa-solid fa-copy"></i></button>`;
}

function injectToST(text) {
    const $ta = $('#send_textarea');
    if (!$ta.length) { showToast('找不到输入框', null, true); return; }
    // Append instead of overwrite — don't nuke whatever the user was typing.
    // Empty box → just set; non-empty → prepend a blank line separator so the
    // injection stays visually distinct from prior text.
    const prev = String($ta.val() || '');
    const combined = prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${text}` : text;
    $ta.val(combined).trigger('input');
    // Move caret to end + scroll into view so the newly injected text is
    // visible even if the box already had content.
    const el = $ta[0];
    if (el && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(combined.length, combined.length);
    }
    el?.scrollTo?.({ top: el.scrollHeight });
    showToast(prev.trim() ? '已追加到输入框' : '已注入到输入框');
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
            console.warn('[7dayscal] messageFormatting failed, falling back to plain:', err);
        } finally {
            if (guardRegex) {
                const i = de.indexOf('regex');
                if (i !== -1) de.splice(i, 1);
            }
        }
    }
    return escapeHtml(String(text ?? '')).replace(/\n/g, '<br>');
}

// ─── Space chat widget extraction ─────────────────────────────────────────
// AI 输出 <schedule_widget> / <line_widget> / <almanac_widget> 时切成三段：
//   1. widget 之外的正文（如果有）走 markdown 渲染
//   2. 每个 widget 转成"卡片 + 应用按钮"预览
// 多个 widget 一起出可以并列显示，用户挑一个应用。
function extractSpaceWidgets(raw) {
    const widgets = [];
    const rx = /<(schedule_widget|line_widget|almanac_widget|era_widget)([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
    let cleaned = String(raw || '');
    let m;
    while ((m = rx.exec(cleaned)) !== null) {
        const em = (m[2] || '').match(/\bedit\s*=\s*["']?\s*(\d+)/i);
        widgets.push({ kind: m[1].toLowerCase(), body: m[3].trim(), editIdx: em ? parseInt(em[1], 10) : null });
    }
    cleaned = cleaned.replace(rx, '').trim();
    return { text: cleaned, widgets };
}

// Turn a widget body into a preview card HTML (no apply button yet — button is
// wired separately so click handler can capture the raw body).
function renderSpaceWidgetCard(kind, body, wid, editIdx = null) {
    if (kind === 'schedule_widget') {
        const line = body.split('\n').find(l => /^Event\s*:/i.test(l)) || '';
        const parts = line.replace(/^Event\s*:\s*/i, '').split('|').map(s => s.trim());
        const [type, title, desc, time, location, dynamic] = parts;
        const TYPE_META = { main: { label: '明线', color: '#d6b85a' }, hidden: { label: '暗线', color: '#a06fd6' }, bond: { label: '红线', color: '#d67f6f' } };
        const meta = TYPE_META[type] || { label: type || '?', color: '#9aa6b2' };
        return `<div class="sp-space-widget-card" data-wid="${wid}" data-kind="schedule">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge" style="background:${meta.color}22;color:${meta.color};border-color:${meta.color}">
                    <i class="fa-regular fa-calendar"></i> ${editIdx != null ? `建议改点·第 ${editIdx} 条` : '建议加到点'}（${escapeHtml(meta.label)}）
                </span>
            </div>
            <div class="sp-space-widget-body">
                <div class="sp-space-widget-title">${escapeHtml(title || '(未命名)')}</div>
                ${desc ? `<div class="sp-space-widget-desc">${escapeHtml(desc)}</div>` : ''}
                <div class="sp-space-widget-meta">
                    ${time ? `<span><i class="fa-regular fa-clock"></i> ${escapeHtml(time)}</span>` : ''}
                    ${location ? `<span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(location)}</span>` : ''}
                </div>
                ${dynamic ? `<div class="sp-space-widget-dynamic">🧵 ${escapeHtml(dynamic)}</div>` : ''}
            </div>
            <div class="sp-space-widget-actions">
                <button class="sp-space-widget-apply" data-wid="${wid}"><i class="fa-solid ${editIdx != null ? 'fa-pen' : 'fa-plus'}"></i> ${editIdx != null ? `替换第 ${editIdx} 条` : '应用到点'}</button>
            </div>
        </div>`;
    }
    if (kind === 'line_widget') {
        const lineRow = body.split('\n').find(l => /^Line\s*:/i.test(l)) || '';
        const descRow = body.split('\n').find(l => /^Desc\s*:/i.test(l)) || '';
        const nextRow = body.split('\n').find(l => /^Next\s*:/i.test(l)) || '';
        const parts = lineRow.replace(/^Line\s*:\s*/i, '').split('|').map(s => s.trim());
        const [name, ltype, stage, level, when, agency, stall] = parts;
        const desc = descRow.replace(/^Desc\s*:\s*/i, '').trim();
        const next = nextRow.replace(/^Next\s*:\s*/i, '').trim();
        const isStall = String(stall).toLowerCase() === 'true';
        return `<div class="sp-space-widget-card" data-wid="${wid}" data-kind="line">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge sp-space-widget-badge-line">
                    <i class="fa-solid fa-diagram-project"></i> ${editIdx != null ? `建议改线·第 ${editIdx} 条` : '建议加到线'}
                </span>
            </div>
            <div class="sp-space-widget-body">
                <div class="sp-space-widget-title">${escapeHtml(name || '(未命名)')}</div>
                <div class="sp-space-widget-meta">
                    ${ltype  ? `<span>${escapeHtml(ltype)}</span>` : ''}
                    ${stage  ? `<span>${escapeHtml(stage)}${isStall ? ' · 停滞' : ''}</span>` : ''}
                    ${when   ? `<span>${escapeHtml(when)}</span>` : ''}
                    ${agency ? `<span>${agency === 'player' ? '需推动' : '自演化'}</span>` : ''}
                </div>
                ${desc ? `<div class="sp-space-widget-desc">${escapeHtml(desc)}</div>` : ''}
                ${next ? `<div class="sp-space-widget-next">→ ${escapeHtml(next)}</div>` : ''}
            </div>
            <div class="sp-space-widget-actions">
                <button class="sp-space-widget-apply" data-wid="${wid}"><i class="fa-solid ${editIdx != null ? 'fa-pen' : 'fa-plus'}"></i> ${editIdx != null ? `替换第 ${editIdx} 条` : '应用到线'}</button>
            </div>
        </div>`;
    }
    if (kind === 'almanac_widget') {
        // 每个日期渲染成**独立一张卡 + 独立按钮**，可分别注入（用 data-idx 对齐 parseAlmanacWidget 的下标）。
        const items = parseAlmanacWidget(body);
        if (!items.length) return '';
        const cal = loadCalDesc();
        const TYPE_LABEL = { festival: '节日', birthday: '生日', anniversary: '纪念日', custom: '自定义' };
        return items.map((it, i) => {
            const dateTxt = it.displayDate || `${calMonthName(cal, it.month)}${it.day}日`;
            const label = TYPE_LABEL[it.type] || '自定义';
            return `<div class="sp-space-widget-card" data-wid="${wid}" data-kind="almanac">
                <div class="sp-space-widget-head">
                    <span class="sp-space-widget-badge sp-space-widget-badge-almanac">
                        <i class="fa-regular fa-calendar-check"></i> 建议加到历
                    </span>
                </div>
                <div class="sp-space-widget-body">
                    <div class="sp-space-widget-almrow">
                        <span class="sp-space-widget-almdate">${escapeHtml(dateTxt)}</span>
                        <span class="sp-space-widget-almname">${escapeHtml(it.name)}</span>
                        <span class="sp-space-widget-almtype">${escapeHtml(label)}</span>
                    </div>
                </div>
                <div class="sp-space-widget-actions">
                    <button class="sp-space-widget-apply" data-wid="${wid}" data-idx="${i}"><i class="fa-solid fa-plus"></i> 应用到轴</button>
                </div>
            </div>`;
        }).join('');
    }
    if (kind === 'era_widget') {
        // 历法/纪年描述符：单张卡，展示纪年名 + 「一年 N 月、共 M 天」+ 每月名·天数；应用即换整套历法。
        const desc = parseEraWidget(body);
        if (!desc) return '';
        const monthsHtml = desc.months
            .map(mo => `<span class="sp-space-widget-eramonth">${escapeHtml(mo.name)}·${mo.days}天</span>`)
            .join('');
        return `<div class="sp-space-widget-card" data-wid="${wid}" data-kind="era">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge sp-space-widget-badge-era">
                    <i class="fa-regular fa-calendar-days"></i> 建议应用历法
                </span>
            </div>
            <div class="sp-space-widget-body">
                <div class="sp-space-widget-title">${escapeHtml(desc.era || '自定义历法')}</div>
                <div class="sp-space-widget-desc">一年 ${calMonthCount(desc)} 个月、共 ${calYearLen(desc)} 天</div>
                <div class="sp-space-widget-eramonths">${monthsHtml}</div>
            </div>
            <div class="sp-space-widget-actions">
                <button class="sp-space-widget-apply" data-wid="${wid}"><i class="fa-solid fa-calendar-check"></i> 应用历法</button>
            </div>
        </div>`;
    }
    return '';
}

// Cache widget bodies by short id so click handler can retrieve them.
// Persists per-session; not saved to disk (raw is preserved in chat history anyway).
const _spaceWidgetStore = new Map();
let _spaceWidgetSeq = 0;

// idx0 从 0 起。就地替换 calendar_widget 内第 idx0 个 Event: 行（保留其 Day/Future 归属与缩进），找不到返回 null。
function replaceNthEventLine(raw, idx0, newEventLine) {
    const src = String(raw || '');
    const m = src.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const inner = m ? m[1] : src;
    let n = -1, done = false;
    const newInner = inner.split('\n').map(line => {
        if (/^\s*Event\s*:/i.test(line) && ++n === idx0) {
            done = true;
            return line.match(/^\s*/)[0] + newEventLine.trim();
        }
        return line;
    }).join('\n');
    if (!done) return null;
    return m ? src.replace(m[0], `<calendar_widget>${newInner}</calendar_widget>`) : newInner;
}

// idx0 从 0 起。就地替换 storylines_widget 内第 idx0 条线块（Line: 及其后的 Desc/Next），找不到返回 null。
function replaceNthLineBlock(raw, idx0, newBlock) {
    const src = String(raw || '');
    const m = src.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i);
    const inner = m ? m[1] : src;
    const blocks = [];
    let cur = null;
    for (const rawLine of inner.split('\n')) {
        if (/^\s*Line\s*:/i.test(rawLine)) { if (cur) blocks.push(cur); cur = [rawLine]; }
        else if (cur) cur.push(rawLine);
    }
    if (cur) blocks.push(cur);
    if (idx0 < 0 || idx0 >= blocks.length) return null;
    blocks[idx0] = newBlock.split('\n');
    const newInner = blocks.map(b => b.join('\n').replace(/\s+$/, '')).join('\n\n');
    return m
        ? src.replace(m[0], `<storylines_widget>\n${newInner}\n</storylines_widget>`)
        : `<storylines_widget>\n${newInner}\n</storylines_widget>`;
}

// ─── Apply widget to schedule (点) ────────────────────────────────────────
// Body is the raw text between <schedule_widget>...</schedule_widget>.
// 无 edit 序号：追加到 Future（用户不用操心归到哪天，去"未来"列看）。
// 有 edit="N"：就地替换现有第 N 条 Event。
function applyScheduleWidget(body, $btn, editIdx = null) {
    // Extract the Event line
    const eventLine = body.split('\n').map(l => l.trim()).find(l => /^Event\s*:/i.test(l));
    if (!eventLine) { showToast('卡片格式不完整，无法应用', null, true); return; }
    // Use current view's cache key (respects user vs char view + charViewName)
    const key = getCacheKey();
    if (!key) { showToast('当前 chat 没有可写入的待办缓存', null, true); return; }
    let raw = '';
    const saved = readStore(key);
    if (saved?.raw) raw = saved.raw;
    if (editIdx != null) {
        // 改现有第 N 条
        const newRaw = raw ? replaceNthEventLine(raw, editIdx - 1, eventLine) : null;
        if (newRaw == null) { showToast(`找不到第 ${editIdx} 条点，请刷新面板后重试`, null, true); return; }
        raw = newRaw;
    } else if (!raw) {
        // If no existing schedule → build minimal wrapper containing just Future
        raw = `<calendar_widget>\nFuture:\n${eventLine}\n</calendar_widget>`;
    } else {
        // Find (or create) Future: section inside calendar_widget
        const widgetMatch = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
        if (widgetMatch) {
            const inner = widgetMatch[1];
            let newInner;
            if (/^\s*Future\s*:/im.test(inner)) {
                // Future section exists — append event line to the end
                newInner = inner.replace(/(Future\s*:[^\n]*\n?)([\s\S]*)$/i, (_m, header, tail) => {
                    return `${header}${tail}${tail.endsWith('\n') || !tail ? '' : '\n'}${eventLine}\n`;
                });
            } else {
                // No Future section — append one
                newInner = `${inner.replace(/\s+$/, '')}\nFuture:\n${eventLine}\n`;
            }
            raw = raw.replace(widgetMatch[0], `<calendar_widget>${newInner}</calendar_widget>`);
        } else {
            // No calendar_widget wrapper — wrap what's there and append Future
            raw = `<calendar_widget>\n${raw}\nFuture:\n${eventLine}\n</calendar_widget>`;
        }
    }
    const subject = currentView === 'char' ? (charViewName || getContext().name2 || '角色') : (getContext().name1 || '用户');
    writeStore(key, { raw, userName: subject, ts: Date.now() });
    // Update cached rendered HTML for schedule view. Only setBody() if the
    // schedule view is what user is currently looking at — don't stomp on
    // outline/lines/space views.
    const rendered = renderSchedule(raw, subject, currentView);
    pointState.cachedSchedule = rendered;
    if (!outlineMode && !linesMode && !spaceMode && $(`#${MODAL_ID}`).is(':visible')) {
        setBody(rendered);
    }
    syncLatestScheduleBlock();   // 楼内点条即时刷（对齐 applyLineWidget → syncLatestInlineBlock）
    $btn.prop('disabled', true).html(`<i class="fa-solid fa-check"></i> ${editIdx != null ? `已改第 ${editIdx} 条` : '已加到点·未来列'}`);
    showToast(editIdx != null ? `已替换点·第 ${editIdx} 条` : '已加到点：请去"未来"列查看');
}

// ─── Apply widget to storylines (线) ──────────────────────────────────────
// 无 edit 序号：新增一条线；有 edit="N"：就地替换现有第 N 条线。
function applyLineWidget(body, $btn, editIdx = null) {
    // Grab the 3 lines: Line: / Desc: / Next:
    const rows = body.split('\n').map(l => l.trim()).filter(Boolean);
    const lineRow = rows.find(l => /^Line\s*:/i.test(l));
    const descRow = rows.find(l => /^Desc\s*:/i.test(l)) || '';
    const nextRow = rows.find(l => /^Next\s*:/i.test(l)) || '';
    if (!lineRow) { showToast('卡片格式不完整，无法应用', null, true); return; }
    const block = [lineRow, descRow, nextRow].filter(Boolean).join('\n');

    const key = getLinesCacheKey();
    if (!key) { showToast('当前 chat 没有可写入的线缓存', null, true); return; }
    let raw = '';
    const saved = readStore(key);
    if (saved?.raw) raw = saved.raw;
    if (editIdx != null) {
        // 改现有第 N 条
        const newRaw = raw ? replaceNthLineBlock(raw, editIdx - 1, block) : null;
        if (newRaw == null) { showToast(`找不到第 ${editIdx} 条线，请刷新面板后重试`, null, true); return; }
        raw = newRaw;
    } else if (!raw) {
        raw = `<storylines_widget>\n${block}\n</storylines_widget>`;
    } else {
        const widgetMatch = raw.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i);
        if (widgetMatch) {
            const inner = widgetMatch[1].replace(/\s+$/, '');
            const newInner = `${inner}\n\n${block}\n`;
            raw = raw.replace(widgetMatch[0], `<storylines_widget>${newInner}</storylines_widget>`);
        } else {
            raw = `<storylines_widget>\n${raw}\n\n${block}\n</storylines_widget>`;
        }
    }
    if (editIdx == null) {
        // 「间」新增的线默认锁定：不靠正文锚定, 全靠 pin 保命。
        const parsed = parseLines(raw);
        if (parsed.length) {
            parsed[parsed.length - 1].pin = true;
            raw = linesToRaw(parsed);
        }
    }
    writeStore(key, { raw, ts: Date.now() });
    // Refresh lines view + inline block on latest AI floor
    const html = renderLines(raw);
    cachedLines = html;
    if (linesMode) setLinesBody(html);
    syncLatestInlineBlock();
    $btn.prop('disabled', true).html(`<i class="fa-solid fa-check"></i> ${editIdx != null ? `已改第 ${editIdx} 条` : '已加到线'}`);
    showToast(editIdx != null ? `已替换线·第 ${editIdx} 条` : '已加到线');
}

// ─── Apply widget to almanac (历) ─────────────────────────────────────────
// 历是一张扁平日期表（非 raw 文本）。一张卡一个日期，按 idx 取该条单独注入。
// **纯追加**：只把这一条去重后加进去，绝不动任何已有项——尤其不能碰「生成节日」出的
// 未锁 AI 节日（那是 source='ai' pin=false，用 mergeAlmanac 会被当未锁 AI 项清掉 → 原版节日全没）。
// 间来的日期默认 pin，日后「生成节日」重算也保得住（与「间加线默认锁定」一致）。
function applyAlmanacWidget(body, $btn, idx) {
    const items = parseAlmanacWidget(body);
    const it = items[Number(idx)] || (items.length === 1 ? items[0] : null);
    if (!it) { showToast('卡片格式不完整，无法应用', null, true); return; }
    if (!getAlmanacKey()) { showToast('当前 chat 没有可写入的轴缓存', null, true); return; }
    it.pin = true;
    const existing = loadAlmanac();
    const seen = new Set(existing.map(almDedupKey));
    if (seen.has(almDedupKey(it))) {
        $btn.prop('disabled', true).html(`<i class="fa-solid fa-check"></i> 轴里已有`);
        showToast('这个日期轴里已经有了', null, true);
        return;
    }
    saveAlmanacItems([...existing, it]);   // 纯追加，不丢任何现有项
    if (axisState.almanacMode) renderAlmanacPanel();
    syncLatestAlmanacBlock();   // 楼内历条即时刷（对齐 applyEraWidget）
    $btn.prop('disabled', true).html(`<i class="fa-solid fa-check"></i> 已加到轴`);
    showToast(`已加到轴：${it.name}`);
}

// 应用间落地的历法描述符：写入全局 caldesc（单例，非追加），整个历的月数/月名/月长随之改变。
// 换历法后月历选中态可能越界 → 清 _almanacCalMonth/_almanacCalDay 回落当前锚点月；刷新历面板 + 楼内历条/今头纪年名。
async function applyEraWidget(body, $btn) {
    const desc = parseEraWidget(body);
    if (!desc) { showToast('历法卡片格式不完整，无法应用', null, true); return; }
    if (!getCalDescKey()) { showToast('当前 chat 没有可写入的历法缓存', null, true); return; }
    const result = await commitCalendarDesc(desc);
    if (!result.ok) {
        if (!result.cancelled) showToast(result.error || '历法保存失败', null, true);
        return;
    }
    if (axisState.almanacMode) renderAlmanacPanel();
    $btn.prop('disabled', true).html(`<i class="fa-solid fa-check"></i> 历法已应用`);
    if (getSettings().notifyMode !== 'off') showToast(`历法已更新：${result.cal.era ? result.cal.era + '·' : ''}${calendarSummary(result.cal)}`);
}

function appendChatMsg(role, content, historyIndex = null) {
    const display = content.replace(/<outline_widget[\s\S]*?<\/outline_widget>/gi, '[↑ 已生成新面]');
    const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
    const wrapCls = role === 'user' ? 'sp-chat-msg-wrap-user'
                  : role === 'ai'   ? 'sp-chat-msg-wrap-ai'
                                    : 'sp-chat-msg-wrap-system';
    const canAct = role !== 'system' && Number.isInteger(historyIndex);
    // User: keep plain text (they typed literally). AI: run through ST's markdown.
    const contentHtml = role === 'ai'
        ? renderAiMessageHtml(display)
        : escapeHtml(display).replace(/\n/g, '<br>');
    // wrap holds both the bubble and its actions (actions live outside the bubble)
    const $wrap = $('<div>').addClass(`sp-chat-msg-wrap ${wrapCls}`);
    if (canAct) $wrap.attr('data-idx', historyIndex);
    const $msg = $('<div>').addClass(`sp-chat-msg ${cls}`);
    $msg.html(`<div class="sp-chat-msg-content">${contentHtml}</div>`);
    $wrap.append($msg);
    if (canAct) {
        const editBtn = role === 'user'
            ? '<button class="sp-chat-msg-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>'
            : '';
        $wrap.append(
            `<div class="sp-chat-msg-actions">${editBtn}` +
            `<button class="sp-chat-msg-delete" title="删除"><i class="fa-solid fa-trash"></i></button></div>`,
        );
    }
    $wrap.appendTo($in('#sp-chat-msgs'));
    const el = inEl('#sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
}

function startInlineEdit($msg, idx) {
    const original = outlineChatHistory[idx]?.content ?? '';
    $msg.find('.sp-chat-msg-content').replaceWith(
        `<textarea class="sp-chat-msg-editor">${escapeHtml(original)}</textarea>`
    );
    $msg.find('.sp-chat-msg-actions').replaceWith(
        '<div class="sp-chat-msg-actions sp-chat-msg-editing">' +
        '<button class="sp-chat-msg-edit-save">保存并重发</button>' +
        '<button class="sp-chat-msg-edit-cancel">取消</button>' +
        '</div>'
    );
    const $ta = $msg.find('.sp-chat-msg-editor');
    $ta.trigger('focus');
    const val = $ta.val();
    $ta[0].setSelectionRange(val.length, val.length);

    $msg.find('.sp-chat-msg-edit-cancel').on('click', () => {
        renderCreativeChatHistory();
    });
    $msg.find('.sp-chat-msg-edit-save').on('click', () => {
        if (isOutlineChatting) return;
        const newText = $ta.val().trim();
        if (!newText) return;
        // Truncate from this user message onward (drops the paired AI reply too),
        // then rerun sendOutlineChat with the new text.
        outlineChatHistory.splice(idx);
        saveCreativeChatHistory();
        renderCreativeChatHistory();
        sendOutlineChat(newText);
    });
    $ta.on('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            $msg.find('.sp-chat-msg-edit-save').trigger('click');
        } else if (e.key === 'Escape') {
            e.preventDefault();
            renderCreativeChatHistory();
        }
    });
}

async function buildOutlineChatMessages(userMsg) {
    const ctx      = getContext();
    const userName = ctx.name1 || '用户';
    const charName = currentView === 'char' ? (charViewName || ctx.name2 || '角色') : (ctx.name2 || '角色');
    let outlineCtx = '';
    const savedOutline = readStore(getOutlineCacheKey());
    if (savedOutline?.raw) outlineCtx = savedOutline.raw;
    const wiContext = await buildWorldInfoContext(ctx);
    const recentCtx = await buildRecentChatContext(ctx);
    const { personaDesc, authorNote } = readCardExtras(ctx);
    const sys = buildCreativeChatSystemPrompt({
        userName,
        charName,
        personaDesc,
        authorNote,
        outlineRaw: outlineCtx,
        wiContext,
        recentCtx,
        almanacText: getAlmanacInjectText(),
        calDescText: getCalDescInjectText(),
    });
    return [{ role: 'system', content: sys }, ...outlineChatHistory, { role: 'user', content: userMsg }];
}

let outlineChatAbortController = null;
const OUTLINE_HISTORY_CAP = 20;   // sliding window: keep last N messages, drop the rest

async function sendOutlineChat(userMsg) {
    if (isOutlineChatting) return;
    outlineChatHistory.push({ role: 'user', content: userMsg });
    // Sliding window: cap history growth so localStorage doesn't bloat.
    // When trim happens all indices shift, so re-render instead of append.
    let trimmed = false;
    if (outlineChatHistory.length > OUTLINE_HISTORY_CAP) {
        outlineChatHistory.splice(0, outlineChatHistory.length - OUTLINE_HISTORY_CAP);
        trimmed = true;
    }
    if (trimmed) renderCreativeChatHistory();
    else appendChatMsg('user', userMsg, outlineChatHistory.length - 1);
    saveCreativeChatHistory();
    isOutlineChatting = true;
    const chatIdSnap = getContext().chatId;
    outlineChatAbortController = new AbortController();
    const $dots = $('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking').html('<span class="sp-typing"><i></i><i></i><i></i></span>').appendTo($in('#sp-chat-msgs'));
    const el = inEl('#sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
    try {
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); throw new Error('请先配置 API'); }
        const reply = await postChatCompletion({
            cfg,
            messages: await buildOutlineChatMessages(userMsg),
            maxTokens: 30000,
            temperature: GEN_TEMPERATURE,
            signal: outlineChatAbortController.signal,
        });
        if (getContext().chatId !== chatIdSnap) { $dots.remove(); return; }
        outlineChatHistory.push({ role: 'assistant', content: reply });
        saveCreativeChatHistory();
        $dots.remove();
        appendChatMsg('ai', reply, outlineChatHistory.length - 1);
        if (/<outline_widget/i.test(reply)) {
            const pendingRaw = reply;
            const $btn = $('<button class="sp-apply-outline-btn">应用此面</button>');
            $btn.on('click', () => {
                // 应用新大纲 → 游标归 1（第一个节点），先落库带 cursor 再渲染/刷注入。
                writeStore(getOutlineCacheKey(), { raw: pendingRaw, ts: Date.now(), cursor: 1 });
                refreshOutlineInjection();
                const html = renderOutline(pendingRaw, 1);
                setOutlineBody(html);
                cachedOutline = html;
                $btn.text('✓ 已应用').prop('disabled', true);
            });
            $('<div class="sp-chat-msg sp-chat-msg-system sp-apply-row"></div>').append($btn).appendTo($in('#sp-chat-msgs'));
            const el2 = inEl('#sp-chat-msgs');
            if (el2) el2.scrollTop = el2.scrollHeight;
        }
    } catch (err) {
        $dots.remove();
        if (err?.name !== 'AbortError') appendChatMsg('system', `发送失败：${err.message}`);
    }
    outlineChatAbortController = null;
    isOutlineChatting = false;
}

// ─── Space chat (间：off-scenario OOC) ───────────────────────────────────────
// Mirrors outline chat but talks to the user out of scene as consultant/知识帮手.
// Same context sources (world info + memory + outline for reference), no
// <outline_widget> extraction.

function getSpaceChatHistoryKey(view, charName) {
    return keyDesc('space-chat', view, charName);
}

function loadSpaceChatHistory(view, charName) {
    const saved = readStore(getSpaceChatHistoryKey(view, charName));
    spaceChatHistory = Array.isArray(saved) ? saved.filter(item => item?.role && item?.content) : [];
    return spaceChatHistory;
}

function saveSpaceChatHistory(view, charName) {
    writeStore(getSpaceChatHistoryKey(view, charName), spaceChatHistory);
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

// 取某条间消息的可复制纯文本：AI 消息剥掉 widget 标签（只留正文），user/system 原样。
function spaceMsgPlainText(msg) {
    if (!msg) return '';
    const raw = String(msg.content ?? '');
    if (msg.role === 'assistant') return extractSpaceWidgets(raw).text;
    return raw;
}

function renderSpaceChatHistory() {
    const $msgs = $in('#sp-space-msgs');
    $msgs.empty();
    spaceChatHistory.forEach((msg, idx) => {
        appendSpaceChatMsg(msg.role === 'assistant' ? 'ai' : msg.role, msg.content, idx);
    });
}

function appendSpaceChatMsg(role, content, historyIndex = null) {
    const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
    const wrapCls = role === 'user' ? 'sp-chat-msg-wrap-user'
                  : role === 'ai'   ? 'sp-chat-msg-wrap-ai'
                                    : 'sp-chat-msg-wrap-system';
    const canAct = role !== 'system' && Number.isInteger(historyIndex);
    // AI: extract schedule/line widgets first — they render as cards below the
    // text bubble. Non-widget text still renders as markdown.
    let contentHtml;
    let widgetCards = '';
    if (role === 'ai') {
        const { text, widgets } = extractSpaceWidgets(content);
        contentHtml = text ? renderAiMessageHtml(text) : '';
        widgetCards = widgets.map(w => {
            const wid = String(++_spaceWidgetSeq);
            _spaceWidgetStore.set(wid, { kind: w.kind, body: w.body, editIdx: w.editIdx });
            return renderSpaceWidgetCard(w.kind, w.body, wid, w.editIdx);
        }).join('');
    } else {
        contentHtml = escapeHtml(content).replace(/\n/g, '<br>');
    }
    const $wrap = $('<div>').addClass(`sp-chat-msg-wrap ${wrapCls}`);
    if (canAct) $wrap.attr('data-idx', historyIndex);
    // Only render the bubble if there's text; if AI's whole reply is just a
    // widget card, skip the empty bubble
    if (contentHtml) {
        const $msg = $('<div>').addClass(`sp-chat-msg ${cls}`);
        $msg.html(`<div class="sp-chat-msg-content">${contentHtml}</div>`);
        $wrap.append($msg);
    }
    if (widgetCards) $wrap.append(widgetCards);
    if (canAct) {
        const editBtn = role === 'user'
            ? '<button class="sp-chat-msg-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>'
            : '';
        $wrap.append(
            `<div class="sp-chat-msg-actions">${editBtn}` +
            `<button class="sp-chat-msg-copy" title="复制"><i class="fa-solid fa-copy"></i></button>` +
            `<button class="sp-chat-msg-delete" title="删除"><i class="fa-solid fa-trash"></i></button></div>`,
        );
    }
    $wrap.appendTo($in('#sp-space-msgs'));
    const el = inEl('#sp-space-msgs');
    if (el) el.scrollTop = el.scrollHeight;
}

function startSpaceInlineEdit($msg, idx) {
    const original = spaceChatHistory[idx]?.content ?? '';
    $msg.find('.sp-chat-msg-content').replaceWith(
        `<textarea class="sp-chat-msg-editor">${escapeHtml(original)}</textarea>`
    );
    $msg.find('.sp-chat-msg-actions').replaceWith(
        '<div class="sp-chat-msg-actions sp-chat-msg-editing">' +
        '<button class="sp-chat-msg-edit-save">保存并重发</button>' +
        '<button class="sp-chat-msg-edit-cancel">取消</button>' +
        '</div>'
    );
    const $ta = $msg.find('.sp-chat-msg-editor');
    $ta.trigger('focus');
    const val = $ta.val();
    $ta[0].setSelectionRange(val.length, val.length);

    $msg.find('.sp-chat-msg-edit-cancel').on('click', () => renderSpaceChatHistory());
    $msg.find('.sp-chat-msg-edit-save').on('click', () => {
        if (isSpaceChatting) return;
        const newText = $ta.val().trim();
        if (!newText) return;
        spaceChatHistory.splice(idx);
        saveSpaceChatHistory();
        renderSpaceChatHistory();
        sendSpaceChat(newText);
    });
    $ta.on('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            $msg.find('.sp-chat-msg-edit-save').trigger('click');
        } else if (e.key === 'Escape') {
            e.preventDefault();
            renderSpaceChatHistory();
        }
    });
}

// 「间」聊天改现有点/线：命中关键词才把当前 raw 编号后注入，供 AI 定位"第 N 条"。
// 关键词与落地卡片一致（见 state.js），避免用户学两套词；单字"点/线"可能误命中，
// 但注入只是多给点上下文，真正改不改由提示词把关，代价可控。平时不命中就不注入，省 token。
const EDIT_POINT_KEYWORDS = ['日程', '日历', '待办', '点'];
const EDIT_LINE_KEYWORDS  = ['事件线', '线索', '伏笔', '线'];
// 刻度（暗历·时间账）触发词：命中才把活跃条目喂进「间」（省 token，与点/线同套路）。
const LEDGER_READ_KEYWORDS = ['刻度', '暗历', '暗账', '状态', '伤', '病', '孕', '约定', '周期', '待办', '身心', '现在怎', '好了没', '没了结'];
// 排障/答疑触发词：命中才把「插件功能 FAQ + 当前开关状态」喂进「间」，让它当客服答「XX 在哪 / 怎么开 / 为啥没生效」。
const SPACE_HELP_KEYWORDS = ['悬浮球', '悬浮按钮', '开关', '在哪', '怎么开', '怎么用', '怎么设', '为什么', '为啥', '没反应', '没生效', '不生效', '注入', '没出现', '不显示', '设置在', '功能', '干嘛', '干什么', '啥用', '什么用', '怎么弄', '找不到', '能不能', '可以吗', '能吗', '会吗', '支持', '自动', '后台', '纪念日', '补录'];

function readCacheRaw(desc) {
    const saved = readStore(desc);
    return saved?.raw || '';
}

function numberedLineList(raw) {
    return parseLines(raw).map((l, i) => {
        const bits = [`#${i + 1}`, l.name || '(未命名)'];
        if (l.type)  bits.push(`｜${l.type}`);
        if (l.stage) bits.push(`｜${l.stage}${l.stall ? '(停滞)' : ''}`);
        if (l.when)  bits.push(`｜${l.when}`);
        bits.push(`｜${l.agency === 'player' ? '需推动' : '自演化'}`);
        if (l.desc)  bits.push(`｜${l.desc}`);
        if (l.next)  bits.push(`｜下一步:${l.next}`);
        return bits.join(' ');
    }).join('\n');
}

// 「间」可读的活跃刻度清单（只读参考，非编号可改列表——刻度不走「改第N条」落地）。
// 复用注入侧的距今/倒计时语义，但去掉「别念编号」等主楼叙事约束（间是局外答问、可直说）。
function numberedLedgerList() {
    let items = [];
    try { items = ledger.listEntries() || []; } catch { return ''; }
    if (!items.length) return '';
    return items.map(e => {
        const who = e.牵扯?.length ? `${e.牵扯.join('、')}：` : '';
        if (e.类型 === '持续状态') {
            const since = ledgerDaysSince(e);
            const s = since == null ? '' : (since === 0 ? '（今天起）' : `（已 ${since} 天）`);
            return `- ${who}${e.事由}${s}——现状「${e.现状 || '—'}」`;
        }
        const du = ledgerDueInfo(e);
        const dueStr = !du ? '（未定期）' : (du.天数 === 0 ? '（今天到期）' : (du.过期 ? `（已过期 ${du.天数} 天）` : `（还有 ${du.天数} 天）`));
        const cyc = e.周期长度 ? `·约 ${e.周期长度} 天一轮` : '';
        return `- ${who}${e.事由}${dueStr}${cyc}——现状「${e.现状 || '—'}」`;
    }).join('\n');
}

// 「间」排障/答疑知识：插件功能 + 每个开关的真实位置（照设置面板实际文案/结构，不是模块简介）。
// 静态骨架部分是死知识；动态部分（buildSpaceHelpText）再拼当前开关的实际开/关状态，让间能答「你这个没开」。
const SPACE_HELP_FACTS = `【构画·功能与设置速查（你据此回答用户关于"某开关在哪、怎么开、为啥没生效"的问题，要答得具体、能指路，别只泛泛介绍模块）】
· 【拿不准就别编，铁律】只回答这份速查覆盖到、或你有明确依据的内容；速查没写到、或你不确定的构画细节，老实说"这条我不太确定，建议点开设置里对应的小问号看说明"，**绝不凭大模型常识编造构画的功能、开关或用法**——宁可说不知道，也别给个听着合理的错答案误导用户。
· 面板入口：点屏幕上的「构画」悬浮球打开主面板；面板左侧竖排是模块页签——点、轴、线、面、间、棱、坐标。
· 悬浮球开关：在主面板**右上角**、标题栏那排小图标里——一个**空心圆点**图标（鼠标停上去显示"悬浮按钮"），点它切换悬浮球显示/隐藏（它旁边分别是主题切换、关闭）。**它不在设置里**，很多人找不到就是因为在找设置页。关掉悬浮球后想再打开面板，可从酒馆的扩展/魔杖菜单进入。
· 设置入口：主面板里的齿轮「设置」。设置从上到下分几大块：总开关 / 基础设置（API、世界书、记忆、显示与通知）/ 模块设置（时间戳、轴、线、面、棱、间）/ 高级设置（标签、自定义提示词、存储管理）。
· 总开关（设置最顶部）：①「启用构画」——关了整个插件如同未安装。②「允许潜伏注入主楼 AI（线/面/刻度）」——这是**注入总闸**，它关着的话，就算线/面/刻度各自的注入开关开了也不会注入。用户说"我开了注入怎么没用"先让他确认这个总闸。
· 【谁能后台注入主楼 AI（关键事实，别答错）】只有**三家**能潜伏注入主楼 AI：线、面（大纲）、刻度（暗历）。**「点/日程」不能后台自动注入主楼 AI**——它是只读展示（面板卡片 + 楼内日程条），只能手动生成/刷新，没有"注入开关"。同理「轴/历」本身也不注入正文（历只在楼内挂只读日程块）。用户问"点能不能后台自动注入/自动喂给 AI"，答案是**不能**，别顺着说可以；他要的效果得靠线/面/刻度承载。
· 时间戳（设置→模块设置→时间戳）：「启用时间戳」，让主楼 AI 每楼打隐形时间戳作时间源，默认开。
· 轴（设置→模块设置→轴）：含「读不到戳时用 API 兜底判定日期」「点·后台自动跟随今天」「（刻度）潜伏注入主楼 AI」等。
· 轴·生成节日 vs 补录纪念日（都在轴面板右上角工具区，手机端收在 ⋮ 菜单里）：「**生成节日**」按世界观**重铺一整年**——会先参照世界书/角色卡判断故事所在地域文化再铺对应节日（别默认套中华节庆，美国背景就别硬塞中秋），已锁定条与你手动加的会保留、未锁的旧 AI 条被替换。「**补录纪念日**」只**增补**剧情里新浮现的重大里程碑纪念日（上限约 3 条、宁缺毋滥、可能一条都不补），**纯追加、不动任何现有条、也不重铺整历**，补录的条目会自动锁定防日后重铺被冲。两者别混：想加新纪念日又不想动现有历，用「补录纪念日」。目前补录**只有手动触发**，暂无后台自动补录。
· 线（设置→模块设置→线）：「启用平行事件（线）」「潜伏注入主楼 AI」「虚线·冷知识」「推进策略（回合/时间/手动）+ 间隔」。线以 UC（用户核心角色）为主轴，也会额外放行 1-2 条**非 UC 的配角/NPC 支线**（重要配角自己的小线索，须同一世界观、同一叙事尺度，不会跨尺度乱入）。
· 面（设置→模块设置→面）：「大纲自动注入」+ 判定间隔。
· 刻度/暗历（自动标注）：开关在设置里，默认**关**（opt-in，会多一路后台 API）。要它自动从剧情捞状态/约定，得手动开；也可在轴面板「刻度」页手动「立即标注」「立即推进」。每条刻度可单独操作：**锁定**（AI 判定车不再改它）、**暂停埋入**（暂不注入主楼、但仍在账上跟进现状，再点恢复；与锁定正交）、**了结**（归档、可捞回）、**编辑**。刻度注入**不定死条数、也不硬凑**——只挑当下氛围最相关的埋进去（锁定的必进、暂停埋入的必不进），活跃条多也不会硬塞满一堆。
· 楼内渲染框（设置→基础设置→显示与通知）：主开关「楼内渲染框」，下面有子开关分别控制 点/线/轴/标注池/召回 这几个框显不显；主开关关了子开关全失效。
· 界面字号：设置→显示与通知里的 −／＋ 步进，独立于酒馆自身的字号。
· 通知档位：关／简约／全量三档。`;

// 动态拼当前开关实际状态（让间能直接指出「你这个开关现在是关的」，而非泛泛而谈）。
function buildSpaceHelpText() {
    const s = getSettings();
    const on = v => v ? '开' : '关';
    const state = [
        `\n【该用户此刻的开关实况（据此排障；发现用户想要的效果依赖的开关是"关"，直接点出来）】`,
        `- 启用构画：${on(s.pluginEnabled !== false)}`,
        `- 潜伏注入总闸（线/面/刻度注入的总开关）：${on(s.injectEnabled !== false)}`,
        `- 时间戳：${on(s.storyClockEnabled !== false)}`,
        `- 线·启用：${on(s.linesEnabled !== false)}；线·潜伏注入：${on(s.linesInject === true)}`,
        `- 面·大纲自动注入：${on(s.outlineInject === true)}`,
        `- 刻度·自动标注：${on(s.ledgerCaptureEnabled === true)}；刻度·潜伏注入：${on(s.ledgerInject === true)}`,
        `- 楼内渲染框·主开关：${on(s.inlineRenderEnabled !== false)}`,
        `- 悬浮球显示：${on(s.fabShow !== false)}`,
    ].join('\n');
    return `${SPACE_HELP_FACTS}\n${state}`;
}

// 发给 API 前，把历史 AI 回复里的结构化卡片块换成占位符。旧卡片带的是当时的点/线数据，
// 会污染"改第 N 条"定位（AI 可能照抄历史里的旧内容）；system 已注入最新编号列表作为唯一真相源。
// 只作用于发给 API 的副本，不改 spaceChatHistory 本身，界面显示与"应用"按钮不受影响。
function stripWidgetsForApi(history) {
    return history.map(m => {
        if (m.role !== 'assistant') return m;
        const cleaned = String(m.content || '')
            .replace(/<schedule_widget[^>]*>[\s\S]*?<\/schedule_widget\s*>/gi, '【已输出一张点卡片（内容以当前面板为准）】')
            .replace(/<line_widget[^>]*>[\s\S]*?<\/line_widget\s*>/gi, '【已输出一张线卡片（内容以当前面板为准）】')
            .replace(/<almanac_widget[^>]*>[\s\S]*?<\/almanac_widget\s*>/gi, '【已输出一张历卡片（内容以当前面板为准）】')
            .replace(/<era_widget[^>]*>[\s\S]*?<\/era_widget\s*>/gi, '【已输出一张历法卡片（内容以当前面板为准）】');
        return cleaned === m.content ? m : { ...m, content: cleaned };
    });
}

async function buildSpaceChatMessages(userMsg) {
    const ctx      = getContext();
    const userName = ctx.name1 || '用户';
    const charName = currentView === 'char' ? (charViewName || ctx.name2 || '角色') : (ctx.name2 || '角色');
    let outlineCtx = '';
    const savedOutline = readStore(getOutlineCacheKey());
    if (savedOutline?.raw) outlineCtx = savedOutline.raw;
    // 命中关键词才注入编号版现有点/线，供"改第 N 条"定位；平时不注入省 token
    const msg = String(userMsg || '');
    const pointList = EDIT_POINT_KEYWORDS.some(w => msg.includes(w)) ? numberedPointList(readCacheRaw(getCacheKey())) : '';
    const lineList  = EDIT_LINE_KEYWORDS.some(w => msg.includes(w))  ? numberedLineList(readCacheRaw(getLinesCacheKey())) : '';
    // 命中刻度词才喂活跃刻度（问状态/伤情/约定/周期时才带，省 token）；命中排障/答疑词才喂功能FAQ+开关实况
    const ledgerList = LEDGER_READ_KEYWORDS.some(w => msg.includes(w)) ? numberedLedgerList() : '';
    const faqText    = SPACE_HELP_KEYWORDS.some(w => msg.includes(w))  ? buildSpaceHelpText() : '';
    const wiContext = await buildWorldInfoContext(ctx);
    const memText   = await getMemText();
    const recentCtx = await buildRecentChatContext(ctx);
    const { personaDesc, authorNote } = readCardExtras(ctx);
    const sys = buildSpaceChatSystemPrompt({
        userName,
        charName,
        personaDesc,
        authorNote,
        outlineRaw: outlineCtx,
        wiContext,
        memText,
        recentCtx,
        pointList,
        lineList,
        ledgerList,
        almanacText: getAlmanacInjectText(),
        calDescText: getCalDescInjectText(),
        faqText,
        personaOverride: (getSettings().spacePersona || '').trim(),   // 间·人格覆盖：填了就换间的语气/人格（顾问身份恒保留）
    });
    return [{ role: 'system', content: sys }, ...stripWidgetsForApi(spaceChatHistory), { role: 'user', content: userMsg }];
}

const SPACE_HISTORY_CAP = 20;

async function sendSpaceChat(userMsg) {
    if (isSpaceChatting) return;
    spaceChatHistory.push({ role: 'user', content: userMsg });
    let trimmed = false;
    if (spaceChatHistory.length > SPACE_HISTORY_CAP) {
        spaceChatHistory.splice(0, spaceChatHistory.length - SPACE_HISTORY_CAP);
        trimmed = true;
    }
    if (trimmed) renderSpaceChatHistory();
    else appendSpaceChatMsg('user', userMsg, spaceChatHistory.length - 1);
    saveSpaceChatHistory();
    isSpaceChatting = true;
    const chatIdSnap = getContext().chatId;
    spaceChatAbortController = new AbortController();
    const $dots = $('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking').html('<span class="sp-typing"><i></i><i></i><i></i></span>').appendTo($in('#sp-space-msgs'));
    const el = inEl('#sp-space-msgs');
    if (el) el.scrollTop = el.scrollHeight;
    try {
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); throw new Error('请先配置 API'); }
        const reply = await postChatCompletion({
            cfg,
            messages: await buildSpaceChatMessages(userMsg),
            maxTokens: 30000,
            temperature: GEN_TEMPERATURE,
            signal: spaceChatAbortController.signal,
        });
        if (getContext().chatId !== chatIdSnap) { $dots.remove(); return; }
        spaceChatHistory.push({ role: 'assistant', content: reply });
        saveSpaceChatHistory();
        $dots.remove();
        appendSpaceChatMsg('ai', reply, spaceChatHistory.length - 1);
    } catch (err) {
        $dots.remove();
        if (err?.name !== 'AbortError') appendSpaceChatMsg('system', `发送失败：${err.message}`);
    }
    spaceChatAbortController = null;
    isSpaceChatting = false;
}




// ─── 棱（小剧场）render ─────────────────────────────────────────────────────────

function setTheaterBody(html) { $in('#sp-theater-body').html(html); }

// 一条 piece 的卡片（草稿/已保存列表共用）。saved=true 时显示"删除"，false 时"升永久+删除"。
function renderPieceCard(piece, saved) {
    const title = escapeHtml(piece.title || '(未命名)');
    const when  = piece.ts ? new Date(piece.ts).toLocaleString('zh-CN', { hour12: false }) : '';
    const actions = saved
        ? `<button class="sp-theater-del-saved" data-id="${escapeAttr(piece.id)}">删除</button>`
        : `<button class="sp-theater-promote" data-id="${escapeAttr(piece.id)}">永久保存</button>
           <button class="sp-theater-del-draft" data-id="${escapeAttr(piece.id)}">删除</button>`;
    return `<div class="sp-theater-card" data-id="${escapeAttr(piece.id)}">
        <div class="sp-theater-card-head">
            <span class="sp-theater-card-title">${title}</span>
            <span class="sp-theater-card-time">${escapeHtml(when)}</span>
        </div>
        <div class="sp-theater-card-actions">
            <button class="sp-theater-view" data-id="${escapeAttr(piece.id)}">查看</button>
            ${actions}
        </div>
    </div>`;
}

// 主面板：输入区 + 结果区 + 操作栏 + 草稿/已保存列表。
function renderTheaterPanel() {
    // 模板改用内联可点列表（不用原生 <select>：其弹层在内置浏览器里会跑到面板下面，
    // 跟 API 模型选择当初同款坑）。骨架先渲染，refreshTheaterTemplates() 异步填充。
    const drafts = theater.loadDrafts().slice().reverse();
    const saved  = theater.loadSaved().slice().reverse();
    const piece  = theaterCurrentPiece;

    const sourceLabel = piece?.templateSource?.title ? `<div class="sp-theater-source">模板：${escapeHtml(piece.templateSource.title)}</div>` : '';
    const resultHtml = piece
        ? `${sourceLabel}<div class="sp-theater-result-inner">${piece.html || ''}</div>`
        : `<div class="sp-empty sp-theater-result-empty"><i class="fa-solid fa-masks-theater"></i><p>填写场景与要求，生成一段小剧场</p></div>`;

    // 长篇预览折叠：piece 存在时把结果区包一层，底部给个展开/收起按钮，
    // 具体是否显示按钮由 applyTheaterFold() 按实际高度决定（矮内容不折叠）。
    const resultBlock = piece
        ? `<div class="sp-theater-result-wrap">
              <button class="sp-theater-fullscreen-btn" type="button" title="全屏浏览小剧场">
                  <i class="fa-solid fa-expand"></i>
              </button>
              <button class="sp-theater-fold-toggle" type="button" style="display:none">
                  <i class="fa-solid fa-chevron-down"></i><span class="sp-theater-fold-label">展开全文</span>
              </button>
              <div class="sp-theater-result sp-theater-result-collapsible" id="sp-theater-result">${resultHtml}</div>
           </div>`
        : `<div class="sp-theater-result" id="sp-theater-result">${resultHtml}</div>`;

    const opBar = piece
        ? `<div class="sp-theater-opbar">
              <button class="sp-btn sp-theater-regen">重新生成</button>
              <input type="text" id="sp-theater-title" class="sp-input" placeholder="标题（可选）" value="${escapeAttr(piece.title || '')}">
              <button class="sp-btn sp-btn-primary sp-theater-save">永久保存</button>
           </div>`
        : '';

    const draftsHtml = drafts.length
        ? drafts.map(p => renderPieceCard(p, false)).join('')
        : '<div class="sp-theater-list-empty">暂无草稿</div>';
    const savedHtml = saved.length
        ? saved.map(p => renderPieceCard(p, true)).join('')
        : '<div class="sp-theater-list-empty">暂无永久保存</div>';

    setTheaterBody(`
        <div class="sp-theater-input-area">
            <details class="sp-theater-tpl-picker" id="sp-theater-tpl-picker">
                <summary class="sp-theater-tpl-picker-summary">
                    <i class="fa-solid fa-chevron-right sp-theater-tpl-picker-chevron"></i>
                    <span>选择模板起草（可选）</span>
                </summary>
                <div class="sp-theater-tpl-picker-body" id="sp-theater-tpl-picker-list">
                    <div class="sp-theater-list-empty">加载中…</div>
                </div>
            </details>
            <textarea id="sp-theater-input" class="sp-input sp-theater-textarea" placeholder="描述这段小剧场：场景、人物状态、想看的走向、字数等…"></textarea>
            <div class="sp-theater-btn-row">
                <button class="sp-btn sp-theater-random" title="从模板库随机抽一个模板直接生成"><i class="fa-solid fa-shuffle"></i> 随机</button>
                <button class="sp-btn sp-btn-primary sp-theater-generate">生成小剧场</button>
            </div>
        </div>
        <hr class="sp-theater-divider">
        ${resultBlock}
        ${opBar}
        <hr class="sp-theater-divider">
        <div class="sp-theater-lists">
            <details class="sp-theater-list-group" open>
                <summary>草稿（最多 ${theater.THEATER_DRAFT_CAP} 条，新挤旧）</summary>
                <div class="sp-theater-list">${draftsHtml}</div>
            </details>
            <details class="sp-theater-list-group"${saved.length ? ' open' : ''}>
                <summary>已永久保存（本对话）</summary>
                <div class="sp-theater-list">${savedHtml}</div>
            </details>
        </div>
    `);
    refreshTheaterTemplates();
    applyTheaterFold();
}

// 预览折叠：内容超过阈值才折叠并露出「展开全文」按钮，短内容不折。
function applyTheaterFold() {
    const el = inEl('#sp-theater-result');
    const $btn = $in('.sp-theater-fold-toggle');
    if (!el || !el.classList.contains('sp-theater-result-collapsible')) { $btn.hide(); return; }
    const COLLAPSED_MAX = 360;
    // 图片未加载完时 scrollHeight 可能偏小，这里先按当前测；下方 img.onload 再复测。
    const measure = () => {
        if (el.scrollHeight > COLLAPSED_MAX + 40) {
            el.classList.add('sp-theater-result-collapsed');
            $btn.css('display', '');
            $btn.find('.sp-theater-fold-label').text('展开全文');
            $btn.find('i').attr('class', 'fa-solid fa-chevron-down');
        } else {
            el.classList.remove('sp-theater-result-collapsed');
            $btn.hide();
        }
    };
    measure();
    el.querySelectorAll('img').forEach(img => {
        if (!img.complete) img.addEventListener('load', measure, { once: true });
    });
}

// 异步拉模板填进内联列表（棱面板 + 设置分节共用数据源）
async function refreshTheaterTemplates() {
    let templates = [];
    try { templates = await theater.listTemplates(); } catch (err) { console.warn('[7dayscal] 模板读取失败:', err); }
    _theaterTemplateCache = templates;
    const $list = $in('#sp-theater-tpl-picker-list');
    if ($list.length) {
        $list.html(templates.length
            ? templates.map(t => `<button type="button" class="sp-theater-tpl-pick" data-uid="${escapeAttr(t.uid)}">${escapeHtml(t.title)}</button>`).join('')
            : '<div class="sp-theater-list-empty">暂无模板，可在设置 · 棱里新增</div>');
    }
    // 若设置分节开着，也刷新其列表
    if ($in('#sp-theater-tpl-mgr').length) renderTheaterTemplateManager(templates);
}
let _theaterTemplateCache = [];
let _theaterTemplateSource = null;
let _lastRandomTheaterTemplateUid = null;

// ─── 棱生成编排（照抄 runGenerateOutline 的 abort/chatId 快照守卫）──────────────
async function runGenerateTheater(userInput) {
    const chatIdSnap = getContext().chatId;
    const myCtrl = theaterAbortController = new AbortController();
    const inputSnapshot = String(userInput || '').trim();
    const sourceSnapshot = _theaterTemplateSource ? { ..._theaterTemplateSource } : null;
    isGeneratingTheater = true;
    setTheaterBody(loadingHtml('正在折射', 'sp-abort-theater'));
    try {
        await refreshTheaterStoryContext();
        const { piece } = await theater.generate(inputSnapshot, {
            signal: myCtrl.signal,
            templateSource: snapshotTheaterSource(sourceSnapshot, inputSnapshot),
            onStage: (stage) => {
                if (theaterAbortController === myCtrl && theaterMode) {
                    setTheaterBody(loadingHtml(`正在${stage}`, 'sp-abort-theater'));
                }
            },
        });
        if (theaterAbortController !== myCtrl) return;
        if (getContext().chatId !== chatIdSnap) {
            isGeneratingTheater = false;
            theaterAbortController = null;
            return;
        }
        isGeneratingTheater = false;
        theaterAbortController = null;
        theaterCurrentPiece = piece;
        if (_theaterTemplateSource?.uid === sourceSnapshot?.uid && _theaterTemplateSource?.input === sourceSnapshot?.input) _theaterTemplateSource = null;
        if (theaterMode) { renderTheaterPanel(); if (getSettings().notifyMode !== 'off') showToast('棱已生成'); }
        else showToast('棱已生成，点击查看', () => {
            $in('.sp-view-btn[data-view="theater"]').trigger('click');
            showPanel();
        });
    } catch (err) {
        if (theaterAbortController !== myCtrl) return;
        isGeneratingTheater = false;
        theaterAbortController = null;
        if (err?.name === 'AbortError') {
            if (theaterMode && getContext().chatId === chatIdSnap) renderTheaterPanel();
            return;
        }
        if (getContext().chatId !== chatIdSnap) return;
        // 面板可见才落面板正文；关了面板则弹 toast。必须判可见而非只判 theaterMode——closePanel 只
        // display:none、不重置视角标志，关面板后 theaterMode 仍为真，漏可见性判断会把错误写进看不见的面板、不弹 toast。
        if (theaterMode && $(`#${MODAL_ID}`).is(':visible')) setTheaterBody(`<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p><button class="sp-btn sp-theater-back">返回</button></div>`);
        else showToast('棱生成失败，请重试', null, true);
    }
}

// 设置分节里的模板管理器渲染
function renderTheaterTemplateManager(templates) {
    const $mgr = $in('#sp-theater-tpl-mgr');
    if (!$mgr.length) return;
    // 重渲染前记住外层抽屉的开合，避免用户整理时被合上
    const libOpen = $mgr.find('.sp-theater-tpl-library').prop('open');
    // 设置面板只做写入口（新增 + 批量导入）；查看/修改/删除交给酒馆世界书编辑器
    // （模板本就是 TEMPLATE_BOOK 的条目）——不在此重造折叠列表，避开抽屉展开挤压相邻项的老问题。
    const count = (templates || []).length;
    $mgr.html(`
        <details class="sp-theater-tpl-library"${libOpen ? ' open' : ''}>
            <summary class="sp-theater-tpl-library-head">
                <i class="fa-solid fa-chevron-right sp-theater-tpl-library-chevron"></i>
                <span>模板库</span>
                <span class="sp-theater-tpl-library-count">${count}</span>
            </summary>
            <div class="sp-theater-tpl-library-body">
                <div class="sp-theater-tpl-add-row">
                    <input type="text" id="sp-theater-tpl-new-title" class="sp-input" placeholder="新模板标题">
                    <textarea id="sp-theater-tpl-new-text" class="sp-input" placeholder="新模板内容"></textarea>
                    <button class="sp-btn sp-btn-primary" id="sp-theater-tpl-add">+ 新增模板</button>
                </div>
                <div class="sp-theater-tpl-import-row">
                    <input type="file" id="sp-theater-tpl-import-file" accept=".txt,text/plain" hidden>
                    <button class="sp-btn" id="sp-theater-tpl-import">批量导入 txt</button>
                    <span class="sp-theater-tpl-import-hint">每条以 <code>title：</code> 起头，正文接 <code>content：</code>（可跨多行）</span>
                </div>
                <div class="sp-theater-tpl-manage-hint">查看 / 修改 / 删除模板请到世界书 <code>构画-棱-小剧场模板</code></div>
            </div>
        </details>
    `);
}


// 解析棱批量导入 txt：每条以行首 `title：` 起头（全/半角冒号 + 可选空格），
// 其后正文可跨多行，直到下一个 `title：` 行为止；正文里开头的 `content：` 前缀会被剥掉。
// title 行之前的散文（无 title 起头的开场白）忽略。返回 [{ title, text }]。
function parseTheaterImport(raw) {
    const text = String(raw || '').replace(/\r\n?/g, '\n');
    const titleRe = /^[ \t]*title[ \t]*[：:][ \t]*(.*)$/i;
    const items = [];
    let cur = null;      // { title, bodyLines: [] }
    for (const line of text.split('\n')) {
        const m = line.match(titleRe);
        if (m) {
            if (cur) items.push(cur);
            cur = { title: m[1].trim(), bodyLines: [] };
        } else if (cur) {
            cur.bodyLines.push(line);
        }
    }
    if (cur) items.push(cur);
    return items.map(it => {
        // 拼回正文，剥掉最前面的 content： 前缀，再去掉首尾空行
        let body = it.bodyLines.join('\n').replace(/^[ \t]*content[ \t]*[：:][ \t]*/i, '');
        body = body.replace(/^\n+/, '').replace(/\n+$/, '');
        return { title: it.title, text: body };
    }).filter(it => it.title || it.text);
}

function renderEmptyOutlineState() {
    return `<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>当前还没有面，可以先直接聊天讨论，也可以生成一版面作为起点</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">生成面</button></div>`;
}

function setOutlineBody(html) { $in('#sp-outline-beats').html(html); }

// ─── Outline generation ───────────────────────────────────────────────────────

async function triggerGenerateOutline() {
    if (isGeneratingOutline) return;
    if (!await memoryPreCheckConfirm()) return;
    cachedOutline = null;
    isGeneratingOutline = true;
    setOutlineBody(loadingHtml('正在构思面', 'sp-abort-outline'));
    runGenerateOutline({ reroll: true, module: 'outline' });
}

async function runGenerateOutline(apiOpts = {}) {
    const viewSnap = currentView;
    const charSnap = charViewName;
    const chatIdSnap = getContext().chatId;
    const myCtrl = outlineAbortController = new AbortController();
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || '用户';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || '角色') : (ctx.name2 || '角色');
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) {
            if (!settingsOpen) toggleSettings();
            throw new Error('请先在设置中填写自定义 API 的 URL 和 Key');
        }
        const prompt   = buildOutlinePrompt(userName, charName, viewSnap);
        const raw      = await callCustomApi(ctx, prompt, cfg, userName, charName, myCtrl.signal, 10, apiOpts);

        if (outlineAbortController !== myCtrl) return;
        if (getContext().chatId !== chatIdSnap) {
            isGeneratingOutline = false;
            outlineAbortController = null;
            return;
        }

        // 新生成大纲 → 游标归 1，先落库带 cursor 再刷注入/渲染。
        writeStore(getOutlineCacheKey(viewSnap, charSnap), { raw, ts: Date.now(), cursor: 1 });
        refreshOutlineInjection();
        const html     = renderOutline(raw, 1);
        isGeneratingOutline = false;
        outlineAbortController = null;
        cachedOutline = html;
        if (outlineMode) { setOutlineBody(html); if (getSettings().notifyMode !== 'off') showToast('面已生成'); }
        else showToast('面已生成，点击查看', () => {
            if (!outlineMode) $in('.sp-view-btn[data-view="outline"]').trigger('click');
            showPanel();
        });
    } catch (err) {
        if (outlineAbortController !== myCtrl) return;
        isGeneratingOutline = false;
        outlineAbortController = null;
        if (err.name === 'AbortError') {
            if (outlineMode && getContext().chatId === chatIdSnap) setOutlineBody(`<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>已中止</p></div>`);
            return;
        }
        if (getContext().chatId !== chatIdSnap) return;
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`;
        // 面板可见才落面板正文；关了面板则弹 toast。必须判可见而非只判 outlineMode——closePanel 只
        // display:none、不重置视角标志，关面板后 outlineMode 仍为真，漏可见性判断会把错误写进看不见的面板、不弹 toast。
        if (outlineMode && $(`#${MODAL_ID}`).is(':visible')) setOutlineBody(errHtml);
        else showToast('面生成失败，请重试', null, true);
    }
}

function buildOutlinePrompt(userName, charName, perspective = 'user') {
    const subject = perspective === 'char' ? charName : userName;
    return `请暂停角色扮演，以编剧顾问身份根据以上剧情，为当前故事生成大纲。
【重要】所有输出必须使用中文（人名、地名可保留原文）。
【人称】以编剧顾问的第三人称视角撰写，直呼角色名字，不要扮演角色，严禁使用"我""我们"等第一人称。

【第一步：故事基础分析】
生成节点之前，先在注释中梳理以下内容（300字以上）：
① 当前状态：故事中主要人物（包括 ${subject} 及其他关键角色）的现状、各自目标、未解决的矛盾
② 角色主次关系：核心主角、重要配角、对立势力及其在剧情中的权重
③ 核心吸引力：这个故事中最抓人的戏剧张力是什么？（取决于故事类型，可以是情感羁绊，也可以是权谋博弈、生存压迫、复仇执念、逆袭成长、探案解谜等。如“互相利用却暗生情愫”、“以弱胜强的势力博弈”、“绝境求生中的人性考验”、“背负血仇的步步为营”）
④ 外部环境现状与发展趋势：当前势力平衡、社会危机、即将发生的大事件等，以及若无干预的自然走向
⑤ 剧情模式：这是什么类型的故事？内部驱动力是什么？（如“外部压迫下的生存斗争 + 内部关系演变”或“个人复仇与救赎之旅”）
⑥ 故事线汇总：至少列出两条故事线。【主线】必备（外部目标、任务、对抗外部势力）；此外按故事类型再选一条或多条副线——如情感线（人物情感关系变化）、成长线（个人能力或心境蜕变）、势力斗争线、复仇线、悬疑解谜线等。副线要贴合本故事的核心吸引力，不要为了凑情感线而生硬加戏。
⑦ 各主要角色的行为模式与语言风格特征，确保节点中的人物表现符合原设

【第二步：生成关键节点，目标 8 个】
节点必须基于上述分析，体现你确定的剧情模式。
- 【时间跨度·宏观】这是一份宏观长线大纲，8 个节点应横跨数周乃至数月，是一次庞大的长期推进，绝非日程式的今天/明天/后天。每个节点代表故事的一个**大阶段或重大转折**（可能持续数天到数周），不是某个具体场景、更不是某一天里的一幕。
- 【大胆发散】未来本就未知，大纲不必拘泥于眼前既定事实的线性延伸，可以放开想象、铺开多种可能的长线走向，给出有张力的大开大合。
- 故事线需要螺旋推进（进→退→再进），不可直线发展；这种进退发生在横跨较长时间的大阶段之间，而非连续几场戏之间。
- 节点覆盖完整故事弧线：开局状态 → 摩擦/试探 → 第一次推进 → 受挫/退后 → 危机爆发 → 关键转折 → 余波 → 新平衡。每个阶段1个节点。
- 每个节点的 Scene 和 Think 内容充实，不压缩质量。

【创作顺序】每个节点先想透 Scene（发生了什么）与 Think（创作思考），再从已构思好的内容里提炼 title 与 Subtext 引言，让标题和引言是对内容的凝练与升华。（脑内可先内容后标题，但**输出时仍严格按 Beat→Scene→Subtext→Think 的字段顺序排列**，不可打乱，否则大纲窗口无法解析。）

【标题要求】title 是这一节点的凝练点题小标题——形式与长度都放开：可以是一个意象、一个动作、一个词或半句话，贴合这一节点的气质与情绪即可。

【字段说明】
Beat: 推演时间|标题|类型|所属故事线|结果
- 推演时间：宏观、相对、粗略的长跨度时间锚（如"初期""数周内""约一两个月后""数月之后""半年左右"），不要精确到某一天；相邻节点之间通常间隔数天到数周乃至更久。
Scene: 这一阶段大致发生了什么、故事整体推进到了哪一步（80-120字），着眼段落级的进展与走向，而非某一个镜头
Subtext: 这一节点的**引言**（题记）——含蓄、文艺、有留白的一句或几句话，为这一段定调。它是像卷首题记那样的文学化点睛，而非对 Scene 的复述总结；可自由取用说书、箴言、史评、心声、民谣、预言、判词等任一叙述口吻，用意象或余韵点出这一节点的情绪底色。直接写引言正文，风格、句式与长短随内容自然生发。
Think: 创作思考（100-150字），必须覆盖：
 ① 如何体现核心吸引力和剧情模式
 ② 主要角色（至少一个）此刻的心理状态
 ③ 对各故事线的推进作用
 ④ 在螺旋进退中处于哪个位置（相对于前一个节点）

【输出格式（严格遵守）】
<!-- 故事分析：（第一步的分析，300字以上） -->
<outline_widget>
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: …
Subtext: …
Think: …
（共8个节点，每节点重复上述结构）
</outline_widget>`;}

// ─── Outline parse / render ───────────────────────────────────────────────────

function parseOutline(raw) {
    const m = raw.match(/<outline_widget[^>]*>([\s\S]*?)<\/outline_widget>/i);
    const content = m ? m[1] : raw;  // fallback: parse raw directly if no widget tag
    const beats = []; let cur = null;
    for (const rawLine of content.split('\n')) {
        // 容错：去掉行首的 Markdown 装饰（**、*、-、>、#、空格）再匹配字段名，
        // 免得模型把 Beat/Scene 包成 **Beat:** 或 "- Beat:" 时整段落解析失败。
        const t = rawLine.trim().replace(/^[>#*\-\s]+/, '').replace(/\*+/g, '');
        if (!t) continue;
        if (/^Beat\s*[:：]/i.test(t)) {
            if (cur) beats.push(cur);
            const parts = t.replace(/^Beat\s*[:：]\s*/i, '').split(/[|｜]/);
            cur = {
                time   : (parts[0] || '').trim(),
                title  : (parts[1] || '').trim(),
                type   : (parts[2] || '').trim(),
                line   : (parts[3] || '').trim(),
                outcome: (parts[4] || '').trim(),
                scene  : '',
                subtext: '',
                think  : '',
            };
        } else if (/^Scene\s*[:：]/i.test(t) && cur) {
            cur.scene = t.replace(/^Scene\s*[:：]\s*/i, '').trim();
        } else if (/^Subtext\s*[:：]/i.test(t) && cur) {
            cur.subtext = t.replace(/^Subtext\s*[:：]\s*/i, '').trim();
        } else if (/^Think\s*[:：]/i.test(t) && cur) {
            cur.think = t.replace(/^Think\s*[:：]\s*/i, '').trim();
        }
    }
    if (cur) beats.push(cur);
    return beats;
}

function deleteOutlineBeatFromRaw(raw, idx) {
    const src = String(raw || '');
    const widget = /<outline_widget[^>]*>([\s\S]*?)<\/outline_widget>/i.exec(src);
    const contentStart = widget ? widget.index + widget[0].indexOf(widget[1]) : 0;
    const content = widget ? widget[1] : src;
    const contentEnd = contentStart + content.length;
    const starts = [];
    let offset = 0;
    for (const lineWithBreak of content.matchAll(/.*(?:\n|$)/g)) {
        const line = lineWithBreak[0];
        if (!line) continue;
        const text = line.replace(/\r?\n$/, '').trim().replace(/^[>#*\-\s]+/, '').replace(/\*+/g, '');
        if (/^Beat\s*[:：]/i.test(text)) starts.push(contentStart + offset);
        offset += line.length;
    }
    if (idx < 0 || idx >= starts.length) return null;
    const removeStart = starts[idx];
    const removeEnd = idx + 1 < starts.length ? starts[idx + 1] : contentEnd;
    return src.slice(0, removeStart) + src.slice(removeEnd);
}

async function triggerDeleteOutlineBeat(idx) {
    if (isGeneratingOutline) return;
    const key = getOutlineCacheKey();
    const saved = readStore(key);
    const raw = saved?.raw || '';
    const target = parseOutline(raw)[idx];
    if (!target) return;
    if (!await spConfirm({ title: '删除这个面', body: `将删除「${target.title || '未命名'}」这一节点，其它面保留。此操作不可撤销。`, confirmText: '删除', cancelText: '取消' })) return;
    const nextRaw = deleteOutlineBeatFromRaw(raw, idx);
    if (nextRaw == null) return;
    const remaining = parseOutline(nextRaw);
    if (!remaining.length) {
        removeStore(key); cachedOutline = null; refreshOutlineInjection();
        if (outlineMode) setOutlineBody(renderEmptyOutlineState());
        return;
    }
    const cursor = getOutlineCursor();
    const nextCursor = cursor > idx + 1 ? cursor - 1 : Math.min(cursor, remaining.length);
    writeStore(key, { ...saved, raw: nextRaw, ts: Date.now(), cursor: nextCursor });
    refreshOutlineInjection();
    cachedOutline = renderOutline(nextRaw, nextCursor);
    if (outlineMode) setOutlineBody(cachedOutline);
}

function renderOutline(raw, cursor = 0) {
    const beats = parseOutline(raw);
    const toolbar = `<div class="sp-panel-toolbar"><button class="sp-panel-refresh sp-refresh-outline" title="重新生成面"><i class="fa-solid fa-rotate-right"></i></button></div>`;
    if (beats.length === 0) return toolbar + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    // 高亮不再受「自动注入」开关限制：只要有游标(cursor>=1)就点亮当前节点 .sp-beat-current + 下一节点 .sp-beat-next，
    // 让用户随时看清剧情演到哪。每个节点带「设为当前」按钮 .sp-beat-setcur（手选游标，见 #sp-outline-beats 委托）。
    const cards = beats.map((b, i) => {
        const injectParts = [`【剧情节点参考】`, `${b.time}·《${b.title}》${b.type ? '·' + b.type : ''}${b.line ? '（' + b.line + '）' : ''}`];
        if (b.scene)   injectParts.push(b.scene);
        if (b.outcome) injectParts.push(`结果：${b.outcome}`);
        const injectBtn = makeInjectBtn(injectParts.join('\n'));
        // 逐 step 复制：该节点的干净可读文本（时间·标题·类型（线）/结果/场景/潜台词），供粘贴到别处。
        const copyBtn = makeCopyBtn([
            `${b.time}·《${b.title}》${b.type ? '·' + b.type : ''}${b.line ? '（' + b.line + '）' : ''}`,
            b.outcome ? `结果：${cleanText(b.outcome)}` : '',
            b.scene   ? cleanText(b.scene) : '',
            b.subtext ? `"${cleanText(b.subtext)}"` : '',
        ].filter(Boolean).join('\n'));
        const isCur  = cursor >= 1 && i + 1 === cursor;
        const isNext = cursor >= 1 && i + 1 === cursor + 1;
        const hi = isCur ? ' sp-beat-current' : (isNext ? ' sp-beat-next' : '');
        const badge = isCur  ? `<span class="sp-beat-badge sp-beat-badge-cur">进行中</span>`
                    : isNext ? `<span class="sp-beat-badge sp-beat-badge-next">预计下一步</span>`
                    : '';
        const setcurBtn = `<button class="sp-beat-setcur${isCur ? ' sp-beat-setcur-on' : ''}" data-idx="${i + 1}" title="${isCur ? '当前剧情点（再点取消狙击）' : '设为当前剧情点'}"><i class="fa-solid fa-location-crosshairs"></i></button>`;
        return `
        <div class="sp-beat${hi}">
            <div class="sp-beat-head">
                <span class="sp-beat-index">${i + 1}</span>
                ${badge}
                <span class="sp-beat-time">${escapeHtml(b.time)}</span>
                ${b.type ? `<span class="sp-beat-type">${escapeHtml(b.type)}</span>` : ''}
                <span class="sp-beat-actions">${setcurBtn}${injectBtn}${copyBtn}<button class="sp-beat-delete" data-idx="${i}" title="删除此节点"><i class="fa-solid fa-trash"></i></button></span>
            </div>
            ${b.line ? `<span class="sp-beat-linerow">${escapeHtml(b.line)}</span>` : ''}
            <div class="sp-beat-title">${escapeHtml(b.title)}</div>
            ${b.outcome ? `<div class="sp-beat-outcome">${escapeHtml(cleanText(b.outcome))}</div>` : ''}
            ${b.scene   ? `<div class="sp-beat-scene">${escapeHtml(cleanText(b.scene))}</div>` : ''}
            ${b.subtext ? `<div class="sp-beat-subtext">"${escapeHtml(cleanText(b.subtext))}"</div>` : ''}
            ${b.think   ? `<details class="sp-beat-think"><summary>创作思考</summary><p>${escapeHtml(cleanText(b.think))}</p></details>` : ''}
        </div>`;
    }).join('');
    // If we parsed few beats but the raw has substantial content, LLM likely
    // deviated from format — surface it so the user isn't silently truncated.
    const rawTail = beats.length < 3
        ? `<details class="sp-debug"><summary>⚠ 仅解析到 ${beats.length} 个节点</summary><pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>`
        : '';
    return toolbar + cards + rawTail;
}


// ─── Storylines (事件线) ─────────────────────────────────────────────────────

function getLinesCacheKey(view, charName) {
    return keyDesc('lines', view, charName);
}

// ── 线·swipe 临时层（localStorage）─────────────────────────────────────────
// 楼层没「固定」（用户还没发下一条消息）前，每份 swipe 的线临时存这里：
// key = sp-lines-swipe-<chatId>-<mesId>；value = { baseline:<B0>, swipes:{ "<swipeId>": <merged> }, view, charName }。
// baseline = 本楼生成前的线（pre-commit B0），保证每份 swipe 都从 B0 重推、不互相叠加污染。
function _swipeLinesKey(chatId, mesId) { return `sp-lines-swipe-${chatId}-${mesId}`; }
function _readSwipeLines(chatId, mesId) {
    try { return JSON.parse(localStorage.getItem(_swipeLinesKey(chatId, mesId)) || 'null'); }
    catch { return null; }
}
function _writeSwipeLines(chatId, mesId, data) {
    try { localStorage.setItem(_swipeLinesKey(chatId, mesId), JSON.stringify(data)); } catch { /* 忽略 */ }
}
function _clearSwipeLines(chatId, mesId) {
    try { localStorage.removeItem(_swipeLinesKey(chatId, mesId)); } catch { /* 忽略 */ }
}
function _clearAllSwipeLines() {
    try {
        const rm = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('sp-lines-swipe-')) rm.push(k);
        }
        rm.forEach(k => localStorage.removeItem(k));
    } catch { /* 忽略 */ }
}
// 滑回已生成的 swipe：从临时层取回该 swipe 的线写回 store 当前活跃集 + 刷 UI，不请求 API。
// 命中返回 true；无记录返回 false（交给调用方决定是否重算）。
function _applyStoredSwipeLines(mesId, swipeId) {
    const chatId = getContext().chatId;
    const rec = _readSwipeLines(chatId, mesId);
    const hit = rec?.swipes?.[String(swipeId)];
    if (hit == null) return false;
    const key = getLinesCacheKey();
    if (!key) return false;
    writeStore(key, { raw: hit, ts: Date.now() });
    cachedLines = renderLines(hit);
    if (linesMode) setLinesBody(cachedLines);
    syncLatestInlineBlock(chatId);
    return true;
}
// 楼主文本签名（长度 + 首尾 32 字，避免全量哈希）：给「同 mesId 主文本变了 → 原楼重生成 = 重roll」检出用。
// 不依赖 ST 的 CMR type / GENERATION_STARTED genType——实测流式重roll下 type=undefined、latch 也不触发，三路检测全漏。
// 有时间戳则只签 <!-- SDC-start --> 与 <!-- SDC-end --> 之间的正文：正文出完后第三方插件在楼尾追加的变量块落在戳外、
// 不再扰动签名 → 不再把「追加变量块」误判成重 roll、省一次 API。无戳（时钟关/AI 漏戳）回退整条 mes，零回归。
function _floorSig(mid) {
    try {
        const t = String(getContext().chat?.[Number(mid)]?.mes ?? '');
        const sm = SDC_START_RE.exec(t);
        const em = SDC_END_RE.exec(t);
        let body = t;
        if (sm && em && em.index > sm.index + sm[0].length) {
            body = t.slice(sm.index + sm[0].length, em.index);
        }
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
// swipe 触发的新回复渲染完 → 重算线：先看临时层有没有算过（有则复用），没有就从楼层基线 B0 重推。
// forceRegen=true（重 roll 专用）：跳过「已算过则复用」的缓存短路，强制从 B0 重算。
//   原因——重生成按钮🔄 pop 掉旧楼再 push 新楼、新楼没有 swipe_id → 退化成 0，会命中推进时写下的 swipes["0"]
//   旧缓存、把**重 roll 前**的旧线又贴回去（表现为「按钮重 roll 线不动·必现」）。重 roll = 内容已换新，
//   必须重算、绝不能复用旧 swipe 缓存；缓存复用只留给「滑回旧 swipe 只看不生成」那条（MESSAGE_SWIPED 分支）。
function _regenLinesForSwipe(mesId, forceRegen = false) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) return;
    const chatId = getContext().chatId;
    const swipeId = Number(getContext().chat?.[mesId]?.swipe_id ?? 0);
    if (!forceRegen && _applyStoredSwipeLines(mesId, swipeId)) return;   // 该 swipe 已算过，直接复用（仅非强制时）
    const rec = _readSwipeLines(chatId, mesId);
    let baseline = rec?.baseline;
    // 🔄重生成·基线兜底（次要，非本 bug 根因）：楼层基线 B0 是在异步线生成落地时（runGenerateLines 尾）才写进
    // swipe 临时层的——若用户在那几秒 API 未回时就点🔄，此刻 rec 尚未落盘 → baseline 为空、会早退。
    // 故临时层无基线时，从「上一 AI 楼定稿快照」重建 B0（快照每楼渲染即同步冻结、无 API 依赖，必已就位）。
    // 仅重 roll（forceRegen）用，且只在「本楼确实推进过」（当前线 ≠ 上一楼线）时重建——非推进楼当前线本就等于上一楼，跳过、绝不凭空推进。
    // 注：重 roll「有没有被认出来」是上游 CMR 靠**内容签名**判的（那才是真根因——流式下 CMR 的 type=undefined、latch 不触发）；这里只管拿到基线。
    if (forceRegen && baseline == null) {
        const prevLines = _prevAiFloorLines(Number(mesId));
        let curLines = '';
        try { curLines = readStore(getLinesCacheKey())?.raw || ''; } catch { /* 空 */ }
        if (prevLines && curLines && curLines !== prevLines) baseline = prevLines;
    }
    // 无基线可依（非推进楼 / 首楼）→ 保持现状，绝不凭空推进。
    // ⚠ 这条 return 必须在「抢占在飞 gen」之前：非推进楼本就不重算，若先抢占会把上一个推进楼
    //   还在飞的合法 gen 误杀、又不补新的 → 表现为「重 roll 后线不更新」概率不降反升（回归）。
    if (baseline == null) return;
    // 竞态抢占：确认本次要重算了，才中止在飞的旧 gen（上一次 swipe 重算 / 手动重生成 / advance 推进）。
    // 旧 gen 完成时会把线写回成**重 roll 前**的推演——偶现"重 roll 后线不更新"的根因
    // （连续快速 roll 时尤甚：第①次的重算还没落，第②次撞 isGeneratingLines 被静默丢弃）。
    // 抢占后紧接着就 runGenerateLines 启新 gen（旧 gen 的 myCtrl 失配后自行退出），中间无空档。
    if (isGeneratingLines || linesAbortController) {
        try { linesAbortController?.abort(); } catch { /* 忽略 */ }
        isGeneratingLines  = false;
        linesAbortController = null;
    }
    isGeneratingLines = true;
    runGenerateLines(true, { mesId: Number(mesId), swipeId, baselineRaw: baseline, forceReroll: true });
}

function loadCachedLinesForCurrentChat(view, charName) {
    const saved = readStore(getLinesCacheKey(view, charName));
    if (saved?.raw) return renderLines(saved.raw);
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  锚·收藏楼层面板：三层抽屉（聊天桶 → 缩略 → 全文）+ Shadow DOM 全文渲染
// ═══════════════════════════════════════════════════════════════════════════

function setAnchorBody(html) { $in('#sp-anchor-body').html(html); }


// ─── 坐标·标签 ─────────────────────────────────────────────────────────────────
// 8 个低饱和预设色 key；tag 只存 color=key，实际配色由 style.css 的
// `.sp-anchor-tagchip[data-color="key"]` 定义（日/夜自洽）。JS 侧只用 key 列色板供选择器画色块。
const ANCHOR_TAG_PALETTE = ['rose', 'amber', 'olive', 'teal', 'indigo', 'plum', 'slate', 'clay'];

// 单标签筛选：模块级状态（null=不筛）。进入 anchor 视图复位，层间导航保留。
let _anchorTagFilter = null;
// 标签管理面的行内编辑/删除态（只在管理面内有意义）：正在改名改色的 id / 待确认删除的 id
let _tagMgrEditId = null;
let _tagMgrDelId  = null;

// 当前单标签筛选下，某条 item 是否入选（无筛选=全入选；meta 自带 tags，无需拉快照）
function itemMatchesFilter(it) {
    if (!_anchorTagFilter) return true;
    return Array.isArray(it.tags) && it.tags.includes(_anchorTagFilter);
}

// 三层通用的筛选栏：全局标签 chip + 「全部」清除项，active 高亮。无标签则不渲染。
function renderAnchorFilterBar(tags, activeId) {
    if (!Array.isArray(tags) || !tags.length) return '';
    const allChip = `<button type="button" class="sp-anchor-filter-chip${!activeId ? ' sp-anchor-filter-on' : ''}" data-id="">全部</button>`;
    const chips = tags.map(t =>
        `<button type="button" class="sp-anchor-filter-chip sp-anchor-filter-tag${t.id === activeId ? ' sp-anchor-filter-on' : ''}" data-id="${escapeAttr(t.id)}"><span class="sp-anchor-tagchip" data-color="${escapeAttr(t.color || 'slate')}">${escapeHtml(t.name)}</span></button>`
    ).join('');
    return `<div class="sp-anchor-filterbar">${allChip}${chips}</div>`;
}

// item.tags(id 数组) + 标签注册表 Map(id→{name,color}) → 只读 chip 串。
// 无标签 / 全是孤儿 id 则返回空串（配合 .sp-anchor-item-tags:empty{display:none} 布局零变化）。
function renderTagChips(tagIds, tagMap) {
    if (!Array.isArray(tagIds) || !tagIds.length) return '';
    return tagIds.map(id => {
        const t = tagMap.get(id);
        if (!t) return '';
        return `<span class="sp-anchor-tagchip" data-color="${escapeAttr(t.color || 'slate')}">${escapeHtml(t.name)}</span>`;
    }).join('');
}

async function renderAnchorPanel() {
    if (!anchorMode) return;
    // 离开全文视图（返回/删除/切档/外部刷新到非 full）时清全屏态；停在同一 full 则不清，
    // 由 renderAnchorFull 读 #sp-anchor-body 的 fs 类自行保留（「编辑标签」重渲即靠此不丢全屏）。
    if (_anchorView.level !== 'full') _clearAnchorFs();
    setAnchorBody('<div class="sp-anchor-loading"><div class="sp-spinner"></div></div>');
    try {
        if (_anchorView.level === 'full' && _anchorView.itemId) { await renderAnchorFull(_anchorView.itemId); return; }
        if (_anchorView.level === 'items' && _anchorView.chatId != null) { await renderAnchorItems(_anchorView.chatId); return; }
        if (_anchorView.level === 'tags') { await renderAnchorTagManager(); return; }
        if (_anchorView.level === 'chats') { await renderAnchorChats(_anchorView.charName); return; }
        await renderAnchorChars();
    } catch (err) {
        console.error('[SP anchor] 面板渲染失败', err);
        setAnchorBody(`<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>读取收藏失败：${escapeHtml(err?.message || '未知错误')}</p></div>`);
    }
}

// 第一层：按角色分组（同名角色会合并——收藏只存 charName 显示名、无 avatar 键，无法区分同名不同卡）
async function renderAnchorChars() {
    const buckets = await anchor.listByChat();
    const tags = await anchor.getTags();
    // L1 顶部小 head：标题「标签」+ 标签管理入口（空态也保留，好让用户随时进管理面）
    const head = `<div class="sp-anchor-head sp-anchor-chars-head">
        <span class="sp-anchor-head-title">标签</span>
        <button class="sp-icon-btn sp-anchor-tagmgr-btn" title="标签管理"><i class="fa-solid fa-tags"></i></button>
    </div>`;
    if (!buckets.length) {
        setAnchorBody(`${head}<div class="sp-empty"><span class="sp-anchor-empty-glyph">${anchorSvg('sp-anchor-empty-svg')}</span><p>还没有收藏的楼层</p><p class="sp-anchor-empty-hint">在聊天楼层的角色名旁点「坐标」图标即可收藏</p></div>`);
        return;
    }
    // 把聊天桶再按角色归并：一个角色可能跑了多个聊天文件（多条剧情线）；先按标签过滤 items，丢空桶
    const chars = new Map();
    for (const b of buckets) {
        const items = b.items.filter(itemMatchesFilter);
        if (!items.length) continue;
        const key = b.charName || '(未知角色)';
        if (!chars.has(key)) chars.set(key, { charName: key, chatCount: 0, count: 0, latestTs: 0 });
        const c = chars.get(key);
        c.chatCount += 1;
        c.count     += items.length;
        const latest = items.reduce((m, it) => Math.max(m, it.ts || 0), 0);
        if (latest > c.latestTs) c.latestTs = latest;
    }
    const list = [...chars.values()].sort((a, z) => z.latestTs - a.latestTs);
    const sizeInfo = await anchor.checkSize().catch(() => null);
    const bar = sizeInfo
        ? `<div class="sp-anchor-sizebar${sizeInfo.over ? ' sp-anchor-sizebar-over' : ''}">已用 ${anchor.formatBytes(sizeInfo.bytes)}${sizeInfo.over ? ' · 偏大，建议清理旧收藏' : ''}</div>`
        : '';
    const filterBar = renderAnchorFilterBar(tags, _anchorTagFilter);
    const cards = list.length ? list.map(c => `
        <button class="sp-anchor-char-card" data-char="${escapeAttr(c.charName)}">
            <span class="sp-anchor-chat-icon">${anchorSvg('sp-anchor-chat-svg')}</span>
            <span class="sp-anchor-chat-main">
                <span class="sp-anchor-chat-name">${escapeHtml(c.charName)}</span>
                <span class="sp-anchor-chat-sub">${c.chatCount} 个聊天</span>
            </span>
            <span class="sp-anchor-chat-meta">
                <span class="sp-anchor-chat-count">${c.count}</span>
                <span class="sp-anchor-chat-ts">${fmtAnchorTs(c.latestTs)}</span>
            </span>
        </button>`).join('') : `<div class="sp-anchor-filter-empty">没有含此标签的收藏</div>`;
    setAnchorBody(`${head}<div class="sp-anchor-scroll">${bar}${filterBar}<div class="sp-anchor-char-list">${cards}</div></div>`);
}

// 标签管理面（面板内一层，_anchorView.level='tags'）：建 / 改名 / 改色 / 删。
// 删除是全局破坏性操作（会从所有收藏剥离该标签），故做一次轻量行内确认。
async function renderAnchorTagManager() {
    const tags = await anchor.getTags();
    // 各标签被多少条收藏引用（meta 自带 tags，无需拉快照）
    const buckets = await anchor.listByChat();
    const usage = new Map();
    for (const b of buckets) for (const it of b.items) {
        if (!Array.isArray(it.tags)) continue;
        for (const id of it.tags) usage.set(id, (usage.get(id) || 0) + 1);
    }
    const swatches = (activeColor) => ANCHOR_TAG_PALETTE.map(c =>
        `<button type="button" class="sp-tagmgr-swatch${c === activeColor ? ' sp-tp-swatch-on' : ''}" data-color="${c}"><span class="sp-anchor-tagchip" data-color="${c}">A</span></button>`
    ).join('');
    const rows = tags.length ? tags.map(t => {
        const n = usage.get(t.id) || 0;
        if (_tagMgrEditId === t.id) {
            // 编辑态：名输入 + 色板 + 保存/取消
            return `<div class="sp-anchor-tagmgr-row sp-tagmgr-editing" data-id="${escapeAttr(t.id)}">
                <input type="text" class="sp-tagmgr-name-input sp-input" value="${escapeAttr(t.name)}" maxlength="20">
                <div class="sp-tagmgr-swatches">${swatches(t.color)}</div>
                <div class="sp-tagmgr-row-actions">
                    <button type="button" class="sp-tagmgr-save sp-mini-btn"><i class="fa-solid fa-check"></i></button>
                    <button type="button" class="sp-tagmgr-cancel sp-mini-btn"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>`;
        }
        if (_tagMgrDelId === t.id) {
            // 删除确认态
            return `<div class="sp-anchor-tagmgr-row sp-tagmgr-confirming" data-id="${escapeAttr(t.id)}">
                <span class="sp-tagmgr-confirm-text">删除「${escapeHtml(t.name)}」？将从 ${n} 条收藏移除</span>
                <div class="sp-tagmgr-row-actions">
                    <button type="button" class="sp-tagmgr-del-yes sp-mini-btn sp-mini-btn-danger">删除</button>
                    <button type="button" class="sp-tagmgr-del-no sp-mini-btn">取消</button>
                </div>
            </div>`;
        }
        return `<div class="sp-anchor-tagmgr-row" data-id="${escapeAttr(t.id)}">
            <span class="sp-anchor-tagchip" data-color="${escapeAttr(t.color || 'slate')}">${escapeHtml(t.name)}</span>
            <span class="sp-tagmgr-usage">${n} 条</span>
            <div class="sp-tagmgr-row-actions">
                <button type="button" class="sp-tagmgr-edit sp-icon-btn" title="改名 / 改色"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="sp-tagmgr-del sp-icon-btn" title="删除标签"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
    }).join('') : `<div class="sp-anchor-filter-empty">还没有标签，在下方新建第一个</div>`;
    setAnchorBody(`
        <div class="sp-anchor-head sp-anchor-tagmgr-head">
            <button class="sp-anchor-back" data-to="chars"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="sp-anchor-head-title">标签管理</span>
            <span class="sp-anchor-head-count">${tags.length} 个</span>
        </div>
        <div class="sp-anchor-scroll">
            <div class="sp-anchor-tagmgr-new">
                <input type="text" class="sp-tagmgr-new-name sp-input" placeholder="新建标签名…" maxlength="20">
                <div class="sp-tagmgr-swatches sp-tagmgr-new-swatches">${swatches(ANCHOR_TAG_PALETTE[0])}</div>
                <button type="button" class="sp-tagmgr-new-add sp-mini-btn"><i class="fa-solid fa-plus"></i> 新建</button>
            </div>
            <div class="sp-anchor-tagmgr-list">${rows}</div>
        </div>`);
}

// 第二层：某角色下的聊天文件分桶（charName 为 null 时退化为全部，兜底）
async function renderAnchorChats(charName) {
    const all = await anchor.listByChat();
    const key = charName || '(未知角色)';
    const allBuckets = charName == null ? all : all.filter(b => (b.charName || '(未知角色)') === key);
    if (!allBuckets.length) { _anchorView = { level: 'chars', charName: null, chatId: null, itemId: null }; await renderAnchorChars(); return; }
    const tags = await anchor.getTags();
    // 每桶按标签过滤 items、丢空桶；count/latestTs 用过滤后的重算
    const buckets = allBuckets
        .map(b => {
            const items = b.items.filter(itemMatchesFilter);
            return { ...b, items, count: items.length, latestTs: items.reduce((m, it) => Math.max(m, it.ts || 0), 0) };
        })
        .filter(b => b.items.length);
    const filterBar = renderAnchorFilterBar(tags, _anchorTagFilter);
    const cards = buckets.length ? buckets.map(b => `
        <button class="sp-anchor-chat-card" data-chatid="${escapeAttr(b.chatId ?? '')}">
            <span class="sp-anchor-chat-icon">${anchorSvg('sp-anchor-chat-svg')}</span>
            <span class="sp-anchor-chat-main">
                <span class="sp-anchor-chat-name">${escapeHtml(b.chatName || '(未命名聊天)')}</span>
                <span class="sp-anchor-chat-sub">${escapeHtml(b.charName || '')}</span>
            </span>
            <span class="sp-anchor-chat-meta">
                <span class="sp-anchor-chat-count">${b.count}</span>
                <span class="sp-anchor-chat-ts">${fmtAnchorTs(b.latestTs)}</span>
            </span>
        </button>`).join('') : `<div class="sp-anchor-filter-empty">没有含此标签的收藏</div>`;
    setAnchorBody(`
        <div class="sp-anchor-head">
            <button class="sp-anchor-back" data-to="chars"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="sp-anchor-head-title">${escapeHtml(key)}</span>
            <span class="sp-anchor-head-count">${buckets.length} 个聊天</span>
        </div>
        <div class="sp-anchor-scroll">${filterBar}<div class="sp-anchor-chat-list">${cards}</div></div>`);
}

// 第三层：某聊天文件内收藏的缩略列表（只显正文前一小段）
async function renderAnchorItems(chatId) {
    const buckets = await anchor.listByChat();
    const bucket  = buckets.find(b => String(b.chatId ?? '') === String(chatId ?? ''));
    if (!bucket) { _anchorView = { level: 'chars', charName: null, chatId: null, itemId: null }; await renderAnchorChars(); return; }
    const charKey = bucket.charName || '(未知角色)';
    _anchorView.charName = charKey;   // 回填角色键：openAnchorAtChat 直达 items 时，返回键也能正确落到角色层
    const tags = await anchor.getTags();
    const tagMap = new Map(tags.map(t => [t.id, t]));
    const items = bucket.items.filter(itemMatchesFilter);
    const filterBar = renderAnchorFilterBar(tags, _anchorTagFilter);
    const cards = items.length ? items.map(it => `
        <button class="sp-anchor-item-card" data-id="${escapeAttr(it.id)}">
            <span class="sp-anchor-item-tags">${renderTagChips(it.tags, tagMap)}</span>
            <span class="sp-anchor-item-main">
                <span class="sp-anchor-item-floor">#${it.floorIndex ?? '?'}</span>
                <span class="sp-anchor-item-preview">${escapeHtml(it.textPreview || '(无正文预览)')}</span>
                <span class="sp-anchor-item-ts">${fmtAnchorTs(it.ts)}</span>
            </span>
        </button>`).join('') : `<div class="sp-anchor-filter-empty">没有含此标签的收藏</div>`;
    setAnchorBody(`
        <div class="sp-anchor-head">
            <button class="sp-anchor-back" data-to="chats" data-char="${escapeAttr(charKey)}"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="sp-anchor-head-title">${escapeHtml(bucket.chatName || bucket.charName || '收藏')}</span>
            <span class="sp-anchor-head-count">${items.length} 条</span>
        </div>
        <div class="sp-anchor-scroll">${filterBar}<div class="sp-anchor-item-list">${cards}</div></div>`);
}

// 第三层：全文——Shadow DOM 渲染，隔离状态栏 <style>（既不外泄污染面板，也不被面板样式覆盖）
// 关键：ST 的 decodeStyleTags 会给楼层 <style> 每条选择器加 `.mes_text ` 前缀（类名再改 .custom-*），
// 所以快照容器必须带 class="mes_text" 当祖先，否则正则状态栏「有文字没样式」。
async function renderAnchorFull(itemId) {
    const it = await anchor.getItem(itemId);
    if (!it) { _anchorView = { level: 'chars', charName: null, chatId: null, itemId: null }; await renderAnchorChars(); return; }
    _anchorCurrentItem = it;
    // 全屏态挂在 #sp-anchor-body（跨重渲持久）；重建头部时按当前态给全屏按钮初始图标/标题，
    // 否则「编辑标签」重渲后按钮会被复位成 fa-expand（虽仍在全屏、图标却成「进入全屏」）。
    const fsOn = !!inEl('#sp-anchor-body')?.classList.contains('sp-anchor-fs-on');
    const tagMap = new Map((await anchor.getTags()).map(t => [t.id, t]));
    // 标签区：只读态（chips + 编辑标签按钮）/ 内联编辑态（chip 点选即写 + 新建行 + 完成）。
    // 内联而非 body 浮层——全文视图铺满面板，浮层会被面板盖住看不见（用户反馈）。
    let tagsBlock;
    if (_anchorFullTagEdit) {
        const selSet = new Set(Array.isArray(it.tags) ? it.tags : []);
        const allTags = [...tagMap.values()];
        const chips = allTags.length
            ? allTags.map(t => `<button type="button" class="sp-anchor-ftag-chip${selSet.has(t.id) ? ' sp-tp-chip-on' : ''}" data-id="${escapeAttr(t.id)}"><span class="sp-anchor-tagchip" data-color="${escapeAttr(t.color || 'slate')}">${escapeHtml(t.name)}</span></button>`).join('')
            : '<div class="sp-tagpicker-empty">还没有标签，在下方新建</div>';
        const swatches = ANCHOR_TAG_PALETTE.map((c, i) => `<button type="button" class="sp-anchor-ftag-swatch${i === 0 ? ' sp-tp-swatch-on' : ''}" data-color="${c}"><span class="sp-anchor-tagchip" data-color="${c}">A</span></button>`).join('');
        tagsBlock = `<div class="sp-anchor-full-tagedit">
                <div class="sp-anchor-ftag-chips">${chips}</div>
                <div class="sp-anchor-ftag-new">
                    <input type="text" class="sp-anchor-ftag-name sp-input" placeholder="新建标签名…" maxlength="20">
                    <div class="sp-tagmgr-swatches">${swatches}</div>
                    <button type="button" class="sp-anchor-ftag-add sp-mini-btn"><i class="fa-solid fa-plus"></i></button>
                </div>
                <div class="sp-anchor-ftag-foot">
                    <button type="button" class="sp-anchor-ftag-done sp-mini-btn"><i class="fa-solid fa-check"></i> 完成</button>
                </div>
            </div>`;
    } else {
        tagsBlock = `<div class="sp-anchor-full-tags">${renderTagChips(it.tags, tagMap)}<button class="sp-anchor-tag-edit sp-mini-btn" type="button"><i class="fa-solid fa-tag"></i> 编辑标签</button></div>`;
    }
    setAnchorBody(`
        <div class="sp-anchor-head">
            <button class="sp-anchor-back" data-to="items" data-chatid="${escapeAttr(it.chatId ?? '')}"><i class="fa-solid fa-chevron-left"></i></button>
            <span class="sp-anchor-head-title">${escapeHtml(it.charName || '')}<span class="sp-anchor-head-floor"> · #${it.floorIndex ?? '?'}</span></span>
            <span class="sp-anchor-head-actions">
                <button class="sp-icon-btn sp-anchor-fullscreen" title="${fsOn ? '退出全屏' : '全屏浏览（便于截图）'}"><i class="fa-solid ${fsOn ? 'fa-compress' : 'fa-expand'}"></i></button>
                <button class="sp-icon-btn sp-anchor-del"    title="删除此收藏"><i class="fa-solid fa-trash"></i></button>
            </span>
        </div>
        <div class="sp-anchor-scroll">
            ${tagsBlock}
            <div class="sp-anchor-full-host" id="sp-anchor-full-host"></div>
            <div class="sp-anchor-full-ts">收藏于 ${fmtAnchorTs(it.ts)}</div>
        </div>
        <div class="sp-anchor-fs-resize" title="拖拽调整大小"></div>`);
    const host = inEl('#sp-anchor-full-host');
    if (host) {
        // Shadow DOM 的 :host{all:initial} 会切断颜色继承；只设字色救不了——快照里状态栏常自带
        // 背景卡片，单一字色遇到「浅字撞浅底/深字撞深底」必然翻车（夜间尤其）。正解是给容器一对
        // **自洽的「底+字」**（见下方取值），状态栏自带 inline 背景的卡片用自己的底覆盖容器底、不受影响；
        // 只设了字色没设底的状态栏文字则落在容器底上，底与字同主题、必然对比清晰。
        // 用探针把 CSS 变量解析成具体 rgb（规避 var() 在 getComputedStyle 里不展开的坑）再内联进 Shadow。
        // Shadow DOM 切断继承；直接读 currentTheme 取硬编码色对，规避探针在 CSS 变量继承链上的不稳定。
        // 日=深字+浅底，夜=浅字+深底，两两成对必然可读。
        const isNight = currentTheme === 'night';
        const fg   = isNight ? '#D8D9DA' : '#2c2e2a';
        const bg   = isNight ? '#272829' : '#F6F4E8';
        const link = isNight ? '#A8A49E' : '#DC9B9B';
        const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
        // Shadow DOM 的 :host{all:initial} 隔断了 ST 那条 `.mes q:before/:after{content:''}`，
        // UA 默认的 q 自动引号在 shadow 里复活；而 ST 格式化阶段已把字面引号写进文本，
        // 于是「字面引号 + UA 自动引号」= 双引号。这里补回同款压制。
        root.innerHTML = `<style>:host{all:initial;display:block;}
            .sp-anchor-snap{display:block;color:${fg};background:${bg};padding:16px 18px !important;margin:0 !important;border:none !important;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.6;word-break:break-word;}
            .sp-anchor-snap img{max-width:100%;height:auto;}
            .sp-anchor-snap a{color:${link};}
            .sp-anchor-snap q:before,.sp-anchor-snap q:after{content:'';}
        </style><div class="mes_text sp-anchor-snap">${it.html || ''}</div>`;
    }
}

// ─── 坐标·导出图片 ─────────────────────────────────────────────────────────────
// 坐标全屏浏览：纯 CSS 切 class + 锁背景滚动 + Esc 退出（照搬小剧场全屏，稳且不依赖任何库）。
// 状态类挂 #sp-anchor-body 本身（不是 .sp-anchor-scroll）：setAnchorBody 只换 innerHTML、不动元素本身，
// 「编辑标签」触发的重渲因此不丢全屏态；头部退出按钮也随卡片一起 fixed，无需 :has() 钉位。
// 桌面留白成卡片、手机铺满面板（尺寸/留白见 style.css 媒体查询）。
let _anchorFsEsc = null;
// 清全屏浮卡的拖拽 inline 尺寸/坐标：退出全屏时必须清，否则 width/height 会黏到非全屏的
// in-flow #sp-anchor-body 上（它此时是 flex:1 子项），把列表视图撑破版。
function _clearAnchorFsInline() {
    const b = inEl('#sp-anchor-body');
    if (!b) return;
    b.style.left = b.style.top = b.style.right = b.style.bottom = b.style.width = b.style.height = '';
}
// 清坐标全屏态（三个类一起去）：返回/删除/切档等离开全文视图时调用，避免 fixed 卡片黏在列表视图上。
function _clearAnchorFs() {
    inEl('#sp-anchor-body')?.classList.remove('sp-anchor-fs-on');
    inEl('.sp-sheet')?.classList.remove('sp-fs-flat');
    document.body.classList.remove('sp-anchor-fs-lock');
    _clearAnchorFsInline();
}
function toggleAnchorFullscreen(btnEl) {
    const body = inEl('#sp-anchor-body');
    if (!body) return;
    const on = body.classList.toggle('sp-anchor-fs-on');
    if (!on) _clearAnchorFsInline();   // 退出：清掉拖拽留下的 inline 尺寸/坐标
    // 桌面去掉 .sp-sheet 的 transform 让 fixed 卡片逃出面板锚到视口（.sp-fs-flat 在 CSS 里 desktop-only，
    // 手机不动 → sheet 的居中 translateX(-50%) 保留、卡片不再右移半屏）。
    inEl('.sp-sheet')?.classList.toggle('sp-fs-flat', on);
    const $i = $(btnEl).find('i');
    $i.attr('class', on ? 'fa-solid fa-compress' : 'fa-solid fa-expand');
    $(btnEl).attr('title', on ? '退出全屏' : '全屏浏览（便于截图）');
    document.body.classList.toggle('sp-anchor-fs-lock', on);
    if (on && !_anchorFsEsc) {
        _anchorFsEsc = (ev) => {
            if (ev.key !== 'Escape') return;
            if (inEl('#sp-anchor-body.sp-anchor-fs-on')) $in('.sp-anchor-fullscreen').trigger('click');
        };
        document.addEventListener('keydown', _anchorFsEsc);
    }
}

// 坐标全屏浮卡·拖拽移动 + 右下角缩放（PC 专属：手机全屏铺满面板、不允许拖，故只绑鼠标、不碰 touch）。
// 机制镜像主面板 sheet 的 drag/resize：卡片默认位置由 CSS vw/vh 锚定，首次手势时 snap 成显式 px
// （left/top/width/height + right/bottom:auto），之后 inline 坐标驱动。退出全屏时由 _clearAnchorFs /
// toggle-off 清掉这些 inline，避免黏到非全屏的 in-flow #sp-anchor-body 上（width/height 会破版）。
let _anchorFsGesture = null;
function _anchorFsSnapToPx(card) {
    if (card.style.width) return;   // 已 snap 过：本次全屏会话内保留用户调好的尺寸
    const r = card.getBoundingClientRect();
    card.style.left = r.left + 'px'; card.style.top = r.top + 'px';
    card.style.width = r.width + 'px'; card.style.height = r.height + 'px';
    card.style.right = 'auto'; card.style.bottom = 'auto';
}
function _anchorFsGestureStart(mode, e) {
    if (isMobile()) return;
    const card = inEl('#sp-anchor-body');
    if (!card || !card.classList.contains('sp-anchor-fs-on')) return;
    e.preventDefault(); e.stopPropagation();
    _anchorFsSnapToPx(card);
    const r = card.getBoundingClientRect();
    _anchorFsGesture = { mode, startX: e.clientX, startY: e.clientY,
        origLeft: r.left, origTop: r.top, origW: r.width, origH: r.height };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', _anchorFsGestureMove);
    document.addEventListener('mouseup', _anchorFsGestureEnd);
}
function _anchorFsGestureMove(e) {
    if (!_anchorFsGesture) return;
    if (e.buttons === 0) { _anchorFsGestureEnd(); return; }   // 自愈：鼠标离窗错过 mouseup 时别卡住
    const card = inEl('#sp-anchor-body');
    if (!card) return;
    const g = _anchorFsGesture;
    if (g.mode === 'move') {
        const left = Math.max(0, Math.min(g.origLeft + e.clientX - g.startX, window.innerWidth  - card.offsetWidth));
        const top  = Math.max(0, Math.min(g.origTop  + e.clientY - g.startY, window.innerHeight - 40));
        card.style.left = left + 'px'; card.style.top = top + 'px';
    } else {
        const w = Math.max(320, Math.min(window.innerWidth  - g.origLeft - 8, g.origW + e.clientX - g.startX));
        const h = Math.max(240, Math.min(window.innerHeight - g.origTop  - 8, g.origH + e.clientY - g.startY));
        card.style.width = w + 'px'; card.style.height = h + 'px';
    }
}
function _anchorFsGestureEnd() {
    if (!_anchorFsGesture) return;
    _anchorFsGesture = null;
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', _anchorFsGestureMove);
    document.removeEventListener('mouseup', _anchorFsGestureEnd);
}

function setLinesBody(eventsHtml) {
    $in('#sp-lines-toolbar').html(linesToolbarHtml());
    $in('#sp-lines-list').html(_linesSheet === 'dashed' ? renderDashedPanel() : eventsHtml);
}

function refreshLinesPanel() {
    let eventsHtml;
    if (isGeneratingLines) eventsHtml = loadingHtml('正在推演线', 'sp-abort-lines');
    else {
        const saved = readStore(getLinesCacheKey());
        eventsHtml = saved?.raw ? renderLines(saved.raw) : renderEmptyLinesState();
        cachedLines = saved?.raw ? eventsHtml : null;
    }
    setLinesBody(eventsHtml);
}

// 收藏占用统计 → 设置面板「收藏占用」行（打开设置时刷新）
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
    'almanac'      : '轴（日历）',
};
const STORAGE_OWNKEY_LABELS = {
    'sp-memory' : '记忆',
    'sp-theater': '棱永久层',
    'sp-ledger' : '刻度',
};

function storageRow(label, bytesText, btnHtml = '', extraClass = '') {
    return `<div class="sp-storage-row ${extraClass}">
        <span class="sp-storage-row-label">${escapeHtml(label)}</span>
        <span class="sp-storage-row-bytes">${escapeHtml(bytesText)}</span>
        <span class="sp-storage-row-act">${btnHtml}</span>
    </div>`;
}

// 渲染四层用量到 #sp-storage-body。异步（坐标要读服务器索引）。
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
        for (const kind of store.KINDS) {
            const b = usage[kind] || 0;
            if (!b) continue;
            rows.push(storageRow(
                STORAGE_KIND_LABELS[kind] || kind,
                fmt(b),
                `<button class="sp-storage-del sp-mini-btn" data-scope="kind" data-kind="${kind}">清除</button>`,
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
    const localBytes = theater.pluginCacheBytes();

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
        const cnt = await anchor.countItems();
        const bytes = await anchor.estimateBytes();
        $in('#sp-storage-anchor-rows').html(
            cnt
                ? storageRow(`共 ${cnt} 条收藏`, anchor.formatBytes(bytes),
                    `<button class="sp-storage-del sp-mini-btn sp-mini-btn-danger" data-scope="anchor">清空</button>`)
                : `<div class="sp-cfg-hint" style="padding:4px 0">暂无收藏</div>`
        );
    } catch {
        $in('#sp-storage-anchor-rows').html(`<div class="sp-cfg-hint" style="padding:4px 0">统计失败（服务器不可达？）</div>`);
    }
}

// 清完某 kind 数据后，若对应视图正开着就重渲染成空态；点视图另清内存缓存。
function refreshEditorsAfterStoreClear(kind) {
    if (kind === 'schedule') {
        pointState.cachedSchedule = null;
        setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>还没有点</p><button class="sp-gen-btn" id="sp-gen-schedule-now">生成点</button></div>`);
    }
    if (kind === 'outline' && outlineMode) setOutlineBody(renderEmptyOutlineState());
    if (kind === 'lines') { cachedLines = null; if (linesMode) setLinesBody(renderEmptyLinesState()); }
    if (kind === 'dashed') {
        _dashedPanelError = '';
        if (linesMode) refreshLinesPanel();
        syncLatestInlineBlock();
    }
    if (kind === 'space-chat' && spaceMode) $in('#sp-space-msgs').empty();
}
// ANCHOR_STORAGE_HANDLERS

// 绑定存储管理面板的清理按钮（委托到 #sp-storage-body，内容动态渲染）+ 刷新。
function bindStorageHandlers() {
    $in('#sp-storage-refresh').on('click', () => renderStorageUsage());

    const $body = $in('#sp-storage-body');

    // ① 本聊天 chat_metadata —— 按 kind 清（点线面间讨论）
    $body.on('click', '.sp-storage-del[data-scope="kind"]', async function () {
        const kind = $(this).attr('data-kind');
        const label = STORAGE_KIND_LABELS[kind] || kind;
        if (!await spConfirm({ title: `清除${label}`, body: `确定清除本聊天的「${label}」数据吗？我方 / TA 方视角都会一并清掉，不可恢复。` })) return;
        const n = store.clearKind(kind);
        refreshEditorsAfterStoreClear(kind);
        renderStorageUsage();
        showToast(n ? `已清除${label}` : `${label}本就为空`);
    });

    // ① 本聊天 —— 清整个 own key（记忆 / 棱永久）
    $body.on('click', '.sp-storage-del[data-scope="ownkey"]', async function () {
        const key = $(this).attr('data-key');
        const label = STORAGE_OWNKEY_LABELS[key] || key;
        if (!await spConfirm({ title: `清空${label}`, body: `确定清空本聊天的「${label}」全部数据吗？不可恢复。` })) return;
        const ok = store.clearOwnKey(key);
        if (key === 'sp-memory') { refreshMemoryStatus?.(); }
        if (key === 'sp-theater' && theaterMode) { theaterCurrentPiece = null; renderTheaterPanel(); }
        renderStorageUsage();
        showToast(ok ? `已清空${label}` : `${label}本就为空`);
    });

    // ② 收藏（坐标·服务器）—— 清空全部
    $body.on('click', '.sp-storage-del[data-scope="anchor"]', async function () {
        const cnt = await anchor.countItems().catch(() => 0);
        if (!cnt) { showToast('还没有任何收藏'); return; }
        if (!await spConfirm({ title: '清空全部收藏', body: `确定删除全部 ${cnt} 条收藏吗？此操作不可恢复（原楼层不受影响）。` })) return;
        try {
            const items = await anchor.getAllItems();
            for (const it of items) await anchor.deleteItem(it.id);
            _anchorSavedKeys.clear();
            document.querySelectorAll('#chat .mes .sp-anchor-btn').forEach(btn => { btn.classList.remove('sp-anchor-saved'); btn.title = '收藏此楼'; });
            if (anchorMode) { _anchorView = { level: 'chars', charName: null, chatId: null, itemId: null }; renderAnchorPanel(); }
            renderStorageUsage();
            showToast('已清空全部收藏');
        } catch (err) {
            console.error('[SP storage] 清空收藏失败', err);
            showToast('清空失败：' + (err?.message || '未知错误'), null, true);
        }
    });

    // ③ 本机缓存（localStorage：棱草稿 + UI 位置）
    $body.on('click', '.sp-storage-del[data-scope="local"]', async function () {
        if (!await spConfirm({ title: '清理本机缓存', body: '清理本浏览器的棱草稿与界面位置（面板位置/大小）。不影响已存服务端的点线面间和收藏。确定？' })) return;
        const n = theater.clearPluginCache();
        if (theaterMode) { theaterCurrentPiece = null; renderTheaterPanel(); }
        renderStorageUsage();
        showToast(`已清理 ${n} 项本机缓存`);
    });
}



function renderEmptyLinesState() {
    return `<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>还没有追踪的线，可以生成一版</p><button class="sp-gen-btn" id="sp-gen-lines-now">生成线</button></div>`;
}

async function triggerGenerateLines() {
    if (isGeneratingLines) return;
    if (!await memoryPreCheckConfirm()) return;
    // Manual refresh: clear cache so LLM generates fresh instead of just echoing
    // the previous raw. Auto-advance path (CHARACTER_MESSAGE_RENDERED) calls
    // runGenerateLines(true) directly and preserves previousRaw for continuity.
    // Locked lines survive even a full regenerate — 全程保护：清空时只留锁定线,
    // runGenerateLines 会把它们当 previousRaw 喂给 AI 延续, 写回时 mergePinnedLines 兜底。
    const key = getLinesCacheKey();
    if (key) {
        const saved = readStore(key);
        const pinnedOnly = saved?.raw ? parseLines(saved.raw).filter(l => l.pin) : [];
        if (pinnedOnly.length) writeStore(key, { raw: linesToRaw(pinnedOnly), ts: Date.now() });
        else removeStore(key);
    }
    cachedLines = null;
    isGeneratingLines = true;
    setLinesBody(loadingHtml('正在推演线', 'sp-abort-lines'));
    runGenerateLines(false, { reroll: true });
}

// Advance = generate based on existing raw (preserves previousRaw for continuity).
// Called from manual-advance buttons on inline block + panel toolbar.
async function triggerAdvanceLines() {
    if (isGeneratingLines) return;
    if (!await memoryPreCheckConfirm()) return;
    // NOTE: no cache clear — runGenerateLines will read previousRaw and pass it
    // to the LLM as the "existing storylines to continue" context.
    isGeneratingLines = true;
    if (linesMode) setLinesBody(loadingHtml('正在推进线', 'sp-abort-lines'));
    runGenerateLines(!linesMode /* silent if panel not open */);
}

// Remove one storyline by index (as parsed by parseLines). Works on the raw text
// block-by-block so the OTHER lines keep their exact serialization untouched.
// Returns: new raw string / '' when the removed line was the last one / null on bad idx.
function deleteOneLineFromRaw(raw, idx) {
    const src = String(raw || '');
    const m = src.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i);
    const inner = m ? m[1] : src;
    const blocks = [];
    let cur = null;
    for (const rawLine of inner.split('\n')) {
        if (/^\s*Line\s*:/i.test(rawLine)) {
            if (cur) blocks.push(cur);
            cur = [rawLine];
        } else if (cur) {
            cur.push(rawLine);
        }
    }
    if (cur) blocks.push(cur);
    if (idx < 0 || idx >= blocks.length) return null;
    blocks.splice(idx, 1);
    if (!blocks.length) return '';
    const newInner = blocks.map(b => b.join('\n').replace(/\s+$/, '')).join('\n\n');
    return m
        ? src.replace(m[0], `<storylines_widget>\n${newInner}\n</storylines_widget>`)
        : `<storylines_widget>\n${newInner}\n</storylines_widget>`;
}

// Delete just ONE line by index; the other lines stay applied.
async function triggerDeleteOneLine(idx) {
    if (isGeneratingLines) return;
    const key = getLinesCacheKey();
    if (!key) return;
    const saved = readStore(key);
    const raw = saved?.raw || '';
    if (!raw) return;
    const target = parseLines(raw)[idx];
    if (!target) { showToast('这条线已不存在，请刷新面板', null, true); return; }
    const ok = await spConfirm({
        title: '删除这条线',
        body : `将删除「${target.name || '未命名'}」这一条，其它事件线保留。此操作不可撤销。`,
        confirmText: '删除',
        cancelText : '取消',
    });
    if (!ok) return;
    const newRaw = deleteOneLineFromRaw(raw, idx);
    if (newRaw == null) { showToast('删除失败：条目错位，请刷新后重试', null, true); return; }
    if (newRaw === '') {
        // that was the last line — clear the cache like a full delete
        removeStore(key);
        cachedLines = null;
        linesAiMsgCounter = 0;
        if (linesMode) setLinesBody(renderEmptyLinesState());
        syncLatestInlineBlock();
        showToast('已删除，事件线已清空');
        return;
    }
    writeStore(key, { ...saved, raw: newRaw, ts: Date.now() });
    const html = renderLines(newRaw);
    cachedLines = html;
    if (linesMode) setLinesBody(html);
    syncLatestInlineBlock();
    showToast('已删除这条线');
}

// 锁定 / 解锁单条线（面板按钮，内联块只读不出现这个按钮）。
function triggerToggleLinePin(idx) {
    const key = getLinesCacheKey();
    if (!key) return;
    const saved = readStore(key);
    const raw = saved?.raw || '';
    if (!raw) return;
    const parsed = parseLines(raw);
    const target = parsed[idx];
    if (!target) { showToast('这条线已不存在，请刷新面板', null, true); return; }
    target.pin = !target.pin;
    const newRaw = linesToRaw(parsed);
    writeStore(key, { raw: newRaw, ts: Date.now() });
    const html = renderLines(newRaw);
    cachedLines = html;
    if (linesMode) setLinesBody(html);
    syncLatestInlineBlock();
    showToast(target.pin ? '已锁定这条线' : '已解锁这条线');
}

// ─── 虚线·冷知识（聊天级历史集合；纯展示、绝不注入）────────────────────────────
// 新格式只保留 items 单一真源；旧 raw/recent 仅在读取时兼容，下一次真实写操作再懒迁移。
const DASHED_TOPIC_CONFIG = Object.freeze([
    Object.freeze({ value: 'user',     label: 'user',     prompt: name => `${name} 本人` }),
    Object.freeze({ value: 'char',     label: 'char',     prompt: name => `${name} 本人` }),
    Object.freeze({ value: 'world',    label: '世界观',   prompt: () => '世界观设定' }),
    Object.freeze({ value: 'history',  label: '历史传说', prompt: () => '历史与传说' }),
    Object.freeze({ value: 'factions', label: '势力组织', prompt: () => '势力与组织' }),
    Object.freeze({ value: 'places',   label: '地点风物', prompt: () => '地点与风物' }),
    Object.freeze({ value: 'items',    label: '物品特性', prompt: () => '物品或造物的隐藏特性' }),
    Object.freeze({ value: 'rules',    label: '规则因果', prompt: () => '未被明说的规则或因果' }),
    Object.freeze({ value: 'customs',  label: '习俗禁忌', prompt: () => '习俗与禁忌' }),
]);
const DASHED_AVOID_COUNT = 12;

function getDashedCacheKey() { return keyDesc('dashed', 'user', ''); }
function normalizeDashedKeepCount(value) {
    const count = Math.floor(Number(value));
    return Number.isFinite(count) && count >= 2 ? Math.min(count, Number.MAX_SAFE_INTEGER) : 15;
}
function getDashedKeepCount() { return normalizeDashedKeepCount(getSettings().dashedKeepCount); }

// 原始返回 → 文本数组。只剥真正的列表序号，不误伤「3000年前」等正文数字。
function _dashedItemsFromRaw(raw) {
    return String(raw || '').split('\n')
        .map(s => s.replace(/^[\s\-*·•]+/, '').replace(/^\d{1,2}[.、．)）]\s*/, '').trim())
        .filter(Boolean);
}

function _dashedLegacyId(text, index) {
    let hash = 2166136261;
    for (const ch of String(text || '')) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return `dashed-legacy-${index}-${(hash >>> 0).toString(36)}`;
}
function _newDashedId(now, index) {
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid ? `dashed-${uuid}` : `dashed-${now.toString(36)}-${index}-${Math.random().toString(36).slice(2, 9)}`;
}

// 兼容旧 `{raw,recent,ts}`：raw 最新，随后 recent；按正文去重且只在内存归一化。
function normalizeDashedStore(saved) {
    if (!saved || typeof saved !== 'object') return [];
    const ts = Number(saved.ts) || 0;
    if (Array.isArray(saved.items)) {
        const seen = new Set();
        return saved.items.map((item, index) => ({
            id: String(item?.id || _dashedLegacyId(item?.text, index)),
            text: String(item?.text || '').trim(),
            createdAt: Number(item?.createdAt) || ts,
            locked: item?.locked === true,
        })).filter(item => {
            if (!item.text || seen.has(item.text)) return false;
            seen.add(item.text);
            return true;
        });
    }
    const texts = [..._dashedItemsFromRaw(saved.raw), ...(Array.isArray(saved.recent) ? saved.recent : [])];
    const seen = new Set();
    return texts.map(text => String(text || '').trim()).filter(text => {
        if (!text || seen.has(text)) return false;
        seen.add(text);
        return true;
    })
        .map((text, index) => ({ id: _dashedLegacyId(text, index), text, createdAt: ts, locked: false }));
}

function readDashedItems() { return normalizeDashedStore(readStore(getDashedCacheKey())); }
function parseDashedItems(limit = Infinity) { return readDashedItems().slice(0, limit).map(item => item.text); }

// 锁定项完全独立于保留数量；只从最新到最旧计数未锁条目，超出部分才进入自动清理。
function pruneDashedItems(items, keepCount, enabled = true) {
    if (!enabled) return { items: [...(items || [])], removed: [] };
    const limit = normalizeDashedKeepCount(keepCount);
    let unlockedCount = 0;
    const kept = [];
    const removed = [];
    for (const item of items || []) {
        if (item?.locked === true || unlockedCount < limit) {
            kept.push(item);
            if (item?.locked !== true) unlockedCount += 1;
        } else removed.push(item);
    }
    return { items: kept, removed };
}

// 冷知识唯一写入咽喉：所有真实修改都在这里统一执行保留策略并落盘。
function commitDashedItems(items, ts = Date.now()) {
    const result = pruneDashedItems(items, getDashedKeepCount(), getSettings().dashedCleanupEnabled !== false);
    if (result.items.length) writeStore(getDashedCacheKey(), { items: result.items, ts });
    else removeStore(getDashedCacheKey());
    return result;
}

function applyDashedCleanupToCurrent(notify = false) {
    if (getSettings().dashedCleanupEnabled === false) return 0;
    const current = readDashedItems();
    const preview = pruneDashedItems(current, getDashedKeepCount(), true);
    if (!preview.removed.length) return 0;
    commitDashedItems(current);
    if (linesMode) refreshLinesPanel();
    syncLatestInlineBlock();
    if (notify && getSettings().notifyMode !== 'off') showToast(`已清理 ${preview.removed.length} 条较旧冷知识`);
    return preview.removed.length;
}

function mergeDashedItems(newTexts, currentItems, createdAt = Date.now()) {
    const freshSeen = new Set();
    const fresh = (newTexts || []).map(text => String(text || '').trim()).filter(text => {
        if (!text || freshSeen.has(text)) return false;
        freshSeen.add(text);
        return true;
    });
    const added = fresh.filter(text => !(currentItems || []).some(item => item.text === text))
        .map((text, index) => ({ id: _newDashedId(createdAt, index), text, createdAt, locked: false }));
    const merged = [...added];
    const seen = new Set(added.map(item => item.text));
    for (const item of currentItems || []) {
        if (!item?.text || seen.has(item.text)) continue;
        seen.add(item.text); merged.push(item);
    }
    return { added, items: merged };
}

function dashedTargetCount(topicCount) { return Math.max(2, Math.floor(Number(topicCount) || 0)); }
function pickRandomDashedTopics(entries = DASHED_TOPIC_CONFIG, random = Math.random) {
    const pool = [...entries];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, 2).map(item => item.value);
}

function dashedTopicText(value, userName, charName, customValue = '') {
    if (value === 'custom') return String(customValue || '').trim();
    const item = DASHED_TOPIC_CONFIG.find(entry => entry.value === value);
    if (!item) return '';
    const name = value === 'user' ? userName : value === 'char' ? charName : '';
    return item.prompt(name);
}

function buildDashedPrompt(userName, charName, avoidItems = [], options = {}) {
    const topics = (options.topics || []).map(String).filter(Boolean);
    const count = dashedTargetCount(options.count || topics.length || 2);
    const broad = `取材面要开阔——世界观设定、历史与传说、势力/组织、地点/风物、物品/造物的隐藏特性、未被明说的规则或因果、习俗与禁忌都可以写；${userName} 和 ${charName} 只是世界里的成员之一，可以偶尔涉及，但不要每条都围着他们转。`;
    let focus = broad;
    if (topics.length === 1) focus = `本次只围绕「${topics[0]}」取材，写出 ${count} 条角度不同、互不重复的冷知识。`;
    else if (topics.length > 1) focus = `本次依次围绕以下 ${topics.length} 个主题取材，每个主题恰好写一条，顺序保持一致：\n${topics.map((topic, i) => `${i + 1}. ${topic}`).join('\n')}`;
    let prompt = `请暂停角色扮演，跳出正文叙事，以设定考据者的身份回答。这是设定考据、不是续写正文：不要输出任何剧情场景、对话、动作或第一/第二人称叙述，不要推进故事，也不要复述记忆库/世界书里已发生的事件经过。
请无视上文里的状态栏、数值面板、表格等格式化内容，绝对不要复述或模仿它们。
完全遵循当前世界的设定与世界观。${focus}
优先挖容易被忽略、却让世界更立体的角落；每条都要展开讲清来龙去脉、背景和细节，不要只丢一句结论，绝对禁止 OOC 和脱离当前背景。
直接从第一条写起，不要开场白或旁白。恰好写 ${count} 条，每行一条，每条 50 到 100 个汉字，纯中文叙述，不要序号、状态栏或任何格式符号。`;
    const avoid = (avoidItems || []).map(text => String(text || '').trim()).filter(Boolean);
    if (avoid.length) prompt += `\n【以下内容最近已经讲过，务必避开；换全新的素材，改写同一件事也不允许】：\n${avoid.map(text => `- ${text}`).join('\n')}`;
    return prompt.replace(/\{\{user\}\}/g, userName).replace(/\{\{char\}\}/g, charName);
}

// 所有入口共用保存咽喉。完成请求后重读最新 items，避免飞行期间的删除被旧快照复活。
async function runGenerateDashed(options = {}) {
    if (isGeneratingDashed) return;
    const manual = options.manual === true;
    const reroll = manual || options.reroll === true;
    const selectedTopicValues = Array.isArray(options.topics) && options.topics.length
        ? options.topics
        : pickRandomDashedTopics();
    const targetCount = dashedTargetCount(options.count || selectedTopicValues.length || 2);
    const chatIdSnap = getContext().chatId;
    const myCtrl = dashedAbortController = new AbortController();
    isGeneratingDashed = true;
    _dashedPanelError = '';
    if (linesMode) refreshLinesPanel();
    syncLatestInlineBlock();
    try {
        const ctx = getContext();
        const userName = ctx.name1 || '用户';
        const charName = ctx.name2 || '角色';
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) throw new Error('未配置自定义 API');
        const topics = selectedTopicValues.map(value => dashedTopicText(value, userName, charName, options.customValue)).filter(Boolean);
        const avoidRecent = reroll ? [] : parseDashedItems(DASHED_AVOID_COUNT);
        const prompt = buildDashedPrompt(userName, charName, avoidRecent, { topics, count: targetCount });
        // 不喂最近对话，只靠人设、世界书、记忆库等 system 背景发散。
        const raw = await callCustomApi(ctx, prompt, cfg, userName, charName, myCtrl.signal, 0, reroll ? { reroll: true, module: 'dashed' } : {});
        if (dashedAbortController !== myCtrl) return;
        if (getContext().chatId !== chatIdSnap) { isGeneratingDashed = false; dashedAbortController = null; return; }
        const returned = _dashedItemsFromRaw(raw).slice(0, targetCount);
        if (!returned.length) throw new Error('模型没有返回可用的冷知识');
        const now = Date.now();
        const currentItems = filterRerollItems(readDashedItems(), reroll);
        const merged = mergeDashedItems(returned, currentItems, now);
        const committed = merged.added.length ? commitDashedItems(merged.items, now) : { items: merged.items, removed: [] };
        const keptIds = new Set(committed.items.map(item => item.id));
        const addedCount = merged.added.filter(item => keptIds.has(item.id)).length;
        isGeneratingDashed = false;
        dashedAbortController = null;
        if (manual && getSettings().notifyMode !== 'off') {
            const suffix = addedCount < targetCount ? `（期望 ${targetCount} 条，实际有效新增 ${addedCount} 条）` : '';
            showToast(addedCount ? `已新增 ${addedCount} 条冷知识${suffix}` : '本次内容与已有冷知识重复，没有新增');
        }
        if (linesMode) refreshLinesPanel();
        syncLatestInlineBlock();
    } catch (err) {
        if (dashedAbortController !== myCtrl) return;
        isGeneratingDashed = false;
        dashedAbortController = null;
        if (err?.name === 'AbortError' || getContext().chatId !== chatIdSnap) return;
        _dashedPanelError = `生成失败：${err?.message || '未知错误'}`;
        if (linesMode) refreshLinesPanel();
        if (manual) showToast('冷知识生成失败，请检查 API 或网络', null, true);
    }
}

async function openDashedGeneratorDialog() {
    if (isGeneratingDashed) return;
    const ctx = getContext();
    const chatIdSnap = ctx.chatId;
    const userName = ctx.name1 || '用户';
    const charName = ctx.name2 || '角色';
    const choices = [
        { value: 'random', label: '随机抽取两个主题', exclusive: true },
        ...DASHED_TOPIC_CONFIG.map(item => ({ value: item.value, label: item.value === 'user' ? userName : item.value === 'char' ? charName : item.label })),
        { value: 'custom', label: '自定义' },
    ];
    const result = await customDialog.selectMany({
        title: '新增冷知识',
        body: '选择想了解的主题。选择几个主题就生成几条，最少生成两条。',
        choices,
        initialValues: ['random'],
        custom: { value: 'custom', placeholder: '填写想了解的冷知识方向…', maxLength: 200 },
        confirmText: '生成',
        validate: value => {
            if (!value.values.length) return '请至少选择一个主题';
            if (value.values.includes('custom') && !value.customValue) return '请填写自定义主题';
            const count = value.values.includes('random') ? 2 : dashedTargetCount(value.values.length);
            return getSettings().dashedCleanupEnabled !== false && count > getDashedKeepCount()
                ? `当前只保留最近 ${getDashedKeepCount()} 条未锁冷知识，请减少主题或调高保留数量`
                : '';
        },
    });
    if (!result || getContext().chatId !== chatIdSnap) return;
    let topics = result.values;
    if (topics.includes('random')) topics = pickRandomDashedTopics();
    runGenerateDashed({ manual: true, topics, customValue: result.customValue, count: dashedTargetCount(topics.length) });
}

async function triggerDeleteDashedItem(id) {
    const target = readDashedItems().find(item => item.id === id);
    if (!target) { showToast('这条冷知识已不存在', null, true); if (linesMode) refreshLinesPanel(); return; }
    const chatIdSnap = getContext().chatId;
    const ok = await customDialog.confirm({ title: '删除冷知识', body: '确认删除这条冷知识吗？', confirmText: '删除', cancelText: '取消' });
    if (!ok || getContext().chatId !== chatIdSnap) return;
    const latest = readDashedItems();
    if (!latest.some(item => item.id === id)) { if (linesMode) refreshLinesPanel(); return; }
    const items = latest.filter(item => item.id !== id);
    commitDashedItems(items);
    if (linesMode) refreshLinesPanel();
    syncLatestInlineBlock();
}

function triggerToggleDashedLock(id) {
    const latest = readDashedItems();
    const target = latest.find(item => item.id === id);
    if (!target) { showToast('这条冷知识已不存在', null, true); if (linesMode) refreshLinesPanel(); return; }
    const wasLocked = target.locked === true;
    const next = latest.map(item => item.id === id ? { ...item, locked: !wasLocked } : item);
    const committed = commitDashedItems(next);
    const targetKept = committed.items.some(item => item.id === id);
    if (linesMode) refreshLinesPanel();
    syncLatestInlineBlock();
    if (wasLocked && !targetKept) showToast('已解锁，并按保留规则清理这条较旧冷知识');
    else if (committed.removed.length) showToast(`${wasLocked ? '已解锁' : '已锁定'}；同时清理 ${committed.removed.length} 条较旧冷知识`);
    else showToast(wasLocked ? '已解锁这条冷知识' : '已锁定这条冷知识');
}

// ─── 虚线楼内子块（折进 .sp-lines-inline 的 body，与线合并成一个楼内窗口）──────────
// 返回一段子块 HTML（非独立 <details>），由 _buildLinesBlockHtml 嵌进线块 body 里。
// 只读展示、绝不写进 message.mes、绝不 setExtensionPrompt。关或无内容 → 返回 ''（不占位）。
// 靠虚线上边框 + 「世界观补充」小字点明性质，不打功能名字招牌。
function _buildDashedSubsectionHtml() {
    if (getSettings().dashedEnabled !== true) return '';
    const items = parseDashedItems(2);
    // 开启即渲染外壳（含刷新键），哪怕暂无条目——供首次从楼内块直接生成。
    let inner;
    if (isGeneratingDashed) {
        inner = '<div class="sp-dashed-inline-empty"><i class="fa-solid fa-spinner fa-spin"></i> 正在翻找冷知识…</div>';
    } else if (items.length) {
        inner = `<ul class="sp-dashed-list">${items.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
    } else {
        inner = '<div class="sp-dashed-inline-empty">线生成 / 推进时会顺手抽一条冷知识</div>';
    }
    // 刷新键坐在「世界观补充」这行右侧、冷知识区内部——不与线键混（用户要求，防误会）。
    const btn = `<button class="sp-inline-refresh-dashed${isGeneratingDashed ? ' sp-refresh-busy' : ''}" title="换一条冷知识"><i class="fa-solid fa-rotate-right"></i></button>`;
    return '<div class="sp-dashed-inline-sub">'
        + `<div class="sp-dashed-inline-hint"><span>世界观补充</span>${btn}</div>`
        + inner + '</div>';
}

async function runGenerateLines(silent = false, swipeCtx = null, travelContext = null) {
    const viewSnap = currentView;
    const charSnap = charViewName;
    const chatIdSnap = getContext().chatId;
    const myCtrl = linesAbortController = new AbortController();
    const travelAbort = travelContext?.signal;
    const abortFromTravel = () => myCtrl.abort();
    travelAbort?.addEventListener('abort', abortFromTravel, { once: true });
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || '用户';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || '角色') : (ctx.name2 || '角色');
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) {
            if (!silent && !settingsOpen) toggleSettings();
            throw new Error('请先在设置中填写自定义 API 的 URL 和 Key');
        }
        const cacheKey = getLinesCacheKey(viewSnap, charSnap);
        // previousRaw = 推进基线。swipe 重算时用楼层 pre-commit 基线 B0（swipeCtx.baselineRaw），
        // 保证每份 swipe 都从「本楼生成前」的状态推进，不叠加到别的 swipe 的推进上；
        // 常规新楼/手动重生成则从 store 当前活跃集推进。
        let previousRaw = '';
        if (swipeCtx && typeof swipeCtx.baselineRaw === 'string') {
            previousRaw = swipeCtx.forceReroll ? linesToRaw(parseLines(swipeCtx.baselineRaw).filter(line => line.pin)) : swipeCtx.baselineRaw;
        } else {
            const savedLines = readStore(cacheKey);
            if (savedLines?.raw) previousRaw = swipeCtx?.forceReroll ? linesToRaw(parseLines(savedLines.raw).filter(line => line.pin)) : savedLines.raw;
        }
        const prompt = appendTravelPromptContext(buildLinesPrompt(userName, charName, viewSnap, previousRaw, getScale(charStableKey(ctx))), travelContext);
        const apiOpts = { ...(travelContext || {}) };
        if (swipeCtx?.forceReroll || swipeCtx?.reroll) Object.assign(apiOpts, { reroll: true, module: 'lines' });
        const raw    = await callCustomApi(ctx, prompt, cfg, userName, charName, myCtrl.signal, 10, apiOpts);

        if (linesAbortController !== myCtrl) return { status: 'cancelled' };
        // Chat may have switched while we were awaiting; do not touch cache or UI in that case
        if (getContext().chatId !== chatIdSnap) {
            isGeneratingLines = false;
            linesAbortController = null;
            return { status: 'cancelled' };
        }

        const merged = mergePinnedLines(previousRaw, raw);
        const html   = renderLines(merged);
        writeStore(cacheKey, { raw: merged, ts: Date.now() });
        // 线·swipe 临时层：记本楼基线 B0 + 各 swipe 的线，供来回 swipe 复用/发消息时固定清理。
        if (swipeCtx && swipeCtx.mesId != null) {
            const rec = _readSwipeLines(chatIdSnap, swipeCtx.mesId)
                || { baseline: previousRaw, swipes: {}, view: viewSnap, charName: charSnap };
            if (rec.baseline == null) rec.baseline = previousRaw;
            rec.swipes[String(swipeCtx.swipeId ?? 0)] = merged;
            _writeSwipeLines(chatIdSnap, swipeCtx.mesId, rec);
        }
        isGeneratingLines = false;
        linesAbortController = null;
        cachedLines = html;
        // Panel body
        if (linesMode) { setLinesBody(html); if (!silent && getSettings().notifyMode !== 'off') showToast('线已生成'); }
        // Sync the inline block on the latest AI message — panel & inline share
        // the same cache; without this the message-level block shows stale data
        // until page reload.
        syncLatestInlineBlock(chatIdSnap);
        // 虚线·冷知识：跟线同触发（覆盖自动轮次/手动重生成/推进——都汇流到这）。
        // fire-and-forget：不 await、不阻塞线 UI；虚线自带 try/catch 与独立 abort。
        if (getSettings().dashedEnabled === true) runGenerateDashed();
        if (!linesMode && !silent) showToast('线已生成，点击查看', () => {
            if (!linesMode) $in('.sp-view-btn[data-view="lines"]').trigger('click');
            showPanel();
        });
        return { status: 'updated', targetDate: travelContext?.targetDate };
    } catch (err) {
        if (linesAbortController !== myCtrl) return { status: 'cancelled' };
        isGeneratingLines = false;
        linesAbortController = null;
        if (err.name === 'AbortError') {
            if (linesMode && getContext().chatId === chatIdSnap) setLinesBody(`<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>已中止</p></div>`);
            return { status: 'cancelled' };
        }
        // 报错弹窗：线生成失败要让用户看见——即便后台自动推进（silent）也弹（isError 不受 notifyMode 静默）。
        // 面板可见时错落面板；后台/自动、或面板已关 → 走 toast，不清掉可能正开着的面板。成功路径仍按 silent 静默。
        // ⚠ 必须判面板可见而非只判 linesMode：closePanel 只 display:none、不重置视角标志，关面板后 linesMode
        //   仍为真，漏可见性判断就会把错误写进看不见的面板、不弹 toast（用户「关面板后生成失败无告警」的根因）。
        if (getContext().chatId === chatIdSnap) {
            if (linesMode && _linesSheet === 'events' && !silent && $(`#${MODAL_ID}`).is(':visible')) setLinesBody(`<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`);
            else showToast('线生成失败，请重试', null, true);
        }
        return { status: 'failed', error: err };
    } finally {
        travelAbort?.removeEventListener('abort', abortFromTravel);
    }
}

function buildLinesPrompt(userName, charName, perspective = 'user', previousRaw = '', scale = 'auto') {
    const subject = perspective === 'char' ? charName : userName;

    // ─── Scale-specific guidance ──────────────────────────────────────────
    const SCALE_BLOCKS = {
        macro: `
【叙事尺度：宏观】
本卡属于大世界叙事——武侠 / 仙侠 / 朝廷 / 战争 / 修真 / 异世界冒险 / 末世 等。
- 事件主体应是**势力 / 组织 / 集团 / 朝廷 / 大人物**，可以有天下大势、势力博弈、阴谋、江湖恩怨等
- 冲突类事件线的"发酵/逼近/已爆发"按字面意义使用（暴力冲突、战事、追杀、政变等）
- 事件影响范围：城 / 国 / 区域 / 天下
- 允许出现宏观的伏笔（远方战报、朝堂密信、势力异动、江湖传闻等）`,
        meso : `
【叙事尺度：中观】
本卡属于社群/组织尺度——都市职场 / 家族 / 商界 / 帮派 / 学派 / 公会 / 探案 / 悬疑 等。
- 事件主体应是**具体人物 + 中小组织**（公司、家族、社群、帮派、学派、班组）
- 冲突类事件线用"发酵/逼近/已爆发"表达组织内博弈、职场斗争、家族矛盾、商业竞争、悬案调查升温等
- 事件影响范围：家族 / 公司 / 社区 / 学校 / 城市局部
- 伏笔多是具体人物的暗中动机、组织内部立场、未公开的交易、可疑线索等
- **避免**天下 / 战争 / 朝堂尺度的事件；也**避免**单纯的两人情感变化（那是微观）`,
        micro: `
【叙事尺度：微观】
本卡属于日常/亲密关系尺度——校园 / 恋爱 / 同居 / 师生 / 治愈 / 慢生活 等。
- 事件主体是**具体的几个人**（${subject}、身边的密友 / 家人 / 同学 / 同事）
- **禁止**出现"势力"、"组织行动"、"阴谋"、"朝堂"、"战事"、"帮派"这类宏观概念
- **禁止**出现暴力冲突、追杀、系统性对抗、宏大危机
- 冲突类事件线的"萌芽/发酵/逼近/已爆发"应理解为**心结生长 / 关系张力 / 摊牌前夕 / 情感爆发**——只涉及具体人之间的情绪与关系动态
- 推进类事件线适合表达：暗恋进展 / 考试筹备 / 兼职计划 / 学业目标 / 习惯养成 / 秘密准备的礼物 等
- 允许的伏笔类型：
  * 某人未说出口的话 / 一个欲言又止的瞬间
  * 一段关系里的隐性张力
  * 未处理的心结、旧账、误会
  * 生活里的小变化（新习惯、新去处、新的联系人）
  * 家庭或学校/职场里悬着的具体事项
- 事件影响范围：个人 + 密友圈`,
    };

    const AUTO_HEADER = `
【叙事尺度：自动判断】
在推演前先根据角色卡描述、场景设定、最近对话内容判断当前故事的尺度：
- **宏观**：涉及天下 / 朝堂 / 势力 / 江湖 / 战事 / 修真等——用宏大叙事对应类型的事件
- **中观**：涉及组织 / 公司 / 家族 / 学派 / 帮派——用中等叙事，具体人物 + 小组织
- **微观**：校园 / 恋爱 / 日常 / 亲密关系——只有具体的人和情感，禁止势力/阴谋/暴力冲突这类宏观概念
判断后严格按对应尺度选择事件类型，不要跨越尺度举例。`;

    const scaleBlock = SCALE_BLOCKS[scale] || AUTO_HEADER;

    return `请暂停角色扮演，以编剧顾问身份根据以上剧情，追踪当前故事中正在发生的"事件线"。
【重要】所有输出必须使用中文（人名、地名可保留原文）。
【人称】以旁观者的第三人称视角撰写，直呼角色名字，不要扮演角色，严禁使用"我""我们"等第一人称。
${scaleBlock}

事件线是独立于 ${subject} 直接行动之外、需要跨轮次持续追踪的主事项。每条属于两类之一：
- 冲突类 (conflict)：萌芽 → 发酵 → 逼近 → 已爆发（或已消散）
- 推进类 (progress)：筹备 → 执行 → 关键 → 已完成（或已失败）

【推进属性 agency（必填）】
- player：事件推进依赖 ${subject} 主动行动（如：${subject} 答应的委托、结下的关系、承接的事项）
- world：事件在世界 / 他人 / 环境层面自行演化，${subject} 不动它也会推进（具体举例请对齐上方"叙事尺度"块的类型）

【非 UC 支线·额外放行 1-2 条】
主线仍围绕 ${subject}，但世界不该只绕着 ${subject} 转。**允许**在主线之外，额外追踪 **1-2 条主体不是 ${subject}** 的支线——让重要配角 / NPC 拥有自己的、与 ${subject} 暂时未必有交集的小线索，世界才有呼吸感。四条约束务必守住：
- **只放开"主体"，绝不放开"尺度"**：非 UC 支线必须严格落在上方判定的**同一叙事尺度**里，写该尺度该有的那类事。微观日常就写配角自己的微观小事（同桌最近总借故早退、常去那家店的店员在偷偷攒钱想辞职、班主任这阵子心事重重似有难处），**严禁**借非 UC 之名引入上方尺度块明令禁止的概念（微观里绝不许突然冒出势力 / 战事 / 大案 / 阴谋这类跨尺度乱入）。这些非 UC 支线**同样要有可延续的小钩子**（动机 / 悬念 / 未了的心事），不是一次性的日常小动作——后者仍按下方"禁止创建事件线"规则剔除。
- **限重要角色、且必须确有其人**：主体只从剧情 / 【故事记忆库】/ 世界书 / 角色卡里**真实存在**的重要配角 / NPC 中取，别为凑数捏造新路人（沿用上方"串味杂质"判据）。
- **限量 1-2 条**，计入下方总数上限；agency 归 world（不依赖 ${subject} 行动）。宁缺毋滥，没有合适的就一条都不写。
- **标题只写线索本身、别贴分类标签**：名称字段照常写这条线索的具体名字（如「同桌的早退」「店员攒钱辞职」「班主任的心事」），**严禁**在名称里加「暗线」「非 UC」「支线」这类分类字样当前缀——一条线是不是非 UC，只由 agency=world 体现，绝不写进标题。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【每次推演的核心任务——按此顺序执行】
1. **主动挖掘新伏笔**：先通读最近剧情，找出可能被忽略的新事件苗头、埋伏笔、NPC 台词里的暗示、场景细节、次要角色的立场变化等，评估是否有值得新建的事件线。
2. **归并判断**：如果新苗头跟已有事件线是同一件事的延伸，就更新已有的（见下方归并规则）；如果是独立主线，就新建。
3. **更新已有事件线**：根据最新剧情推进 / 停滞 / 终结已有事件线。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【新建 vs 归并——判断标准】
优先考虑新建的情况：
- 剧情里出现了新的独立主体（新人物 / 新地点 / 新组织 / 新关系）且带有可延续的动机或目标
- 已有对话/场景里埋下了新的伏笔（角色说漏嘴、异常动作、意味深长的暗示）
- 出现新的外部信号（环境变化、消息、传闻、他方行动，或人物新表态）
- 一个次要角色首次表现出立场或计划

归并到已有事件线的情况：
- 新内容明显是已有事件的下一个阶段或子步骤
- 主体、目标、动机跟已有事件线完全一致，只是执行细节变化

**判断原则**：宁可新建后再合并，也不要因为"沾点边"就都塞进老事件线。归并只在"确定是同一件事"时使用；判断不清就新建。

【禁止创建事件线的情况——严格但只针对以下几类】
- 已经完成/胜负已定/无需继续追踪的事情
- 单次的场景动作、日常互动、当前场景内即可收束的普通事项
- 纯情绪、气氛、内心想法（未表达出来的）
- 把同一主事项的多个执行步骤拆成多条

【推进节奏约束】
- 单次推进通常只前进一个阶段；非明确剧情信号不跨越多个阶段。
- 避免同一次推演中多条事件线同时进入高烈度（已爆发 / 关键）。
- 已有事件线剧情中没有明显进展信号时，使用 stall=true 保持原 stage，desc 写明停滞原因——不要为了显得有变化就臆造推进。
- 冲突类尤其克制：只有出现明确激化迹象才从"萌芽"进入"发酵"。

【终局判定】
- "已爆发" / "已消散" / "已完成" / "已失败" 为终局，进入后不得回退。
- stall 不是终局；只要仍有恢复可能就用 stall=true，不要标终局。
- 已终结且已过多轮的事件线可以不再输出。

【当前已追踪的事件线】
${previousRaw ? previousRaw : '（无，这是第一次生成。请从当前剧情中提炼 2-4 条事件线；初次生成时冲突类等级不宜超过 2）'}

**注意**：即使已有事件线不少，也请再通读一遍最近剧情，主动寻找是否有新苗头。理想状态下每次推演都能有 1-2 条新增或有实质进展的事件线，剧情才有活力。总数不超过 6 条；已终结或不再重要的老事件直接不输出即可。

【串味杂质·主动剔除】
- 若【当前已追踪的事件线】里某条线的核心人物 / 事件，在以上剧情、【故事记忆库】、世界书及角色卡设定中**完全找不到任何依据**（既不是本卡的角色 / 地点 / 势力，也从未在剧情或记忆里出现过），判定为串味杂质——**本轮直接不再输出该条**，不要沿用、也不要改写延续它。
- 判断从严：只针对"整条线的主体明显不属于本故事世界"的情况。一条线只是近期没进展、暂时没被提及、或你一时想不起出处，都**不算**杂质，照常用 stall=true 保留。

【输出格式（严格遵守，三行都必须输出）】
<storylines_widget>
Line: 名称|类型(冲突/推进)|阶段|等级(1-4)|时间锚点(如"今天上午"/"三天后"，禁用"第N轮")|agency(player/world)|stall(true/false)
Desc: 描述当前状态、关键背景、涉及的人物势力及其立场（60-100字，写现在的样子，不要写"接下来会…"）
Next: **必须输出，不得省略**。一句话给出前瞻信号（20-40字），**直接写内容本身、不要加"下一步："/"恢复条件："之类的标签前缀（面板会自动加）**。stall=true 时写恢复推进的触发条件；stall=false 时写最可能的下一动作、下一阶段的催化事件、或即将出现的关键分岔。
（每条事件线重复上面三行）
</storylines_widget>

【输出前自查】逐条确认每条事件线都齐 Line / Desc / Next 三行——尤其 Next 绝不能省，缺了补上再输出。`;
}

// ─── Storylines parse / render ────────────────────────────────────────────────

function parseLines(raw) {
    const m = raw.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i);
    const content = m ? m[1] : raw;  // fallback: parse raw directly if no widget tag
    const lines = []; let cur = null;
    for (const rawLine of content.split('\n')) {
        const t = rawLine.trim();
        if (!t) continue;
        if (/^Line\s*:/i.test(t)) {
            if (cur) lines.push(cur);
            const parts = t.replace(/^Line\s*:\s*/i, '').split('|');
            const agencyRaw = (parts[5] || '').trim().toLowerCase();
            const stallRaw  = (parts[6] || '').trim().toLowerCase();
            const pinRaw    = (parts[7] || '').trim().toLowerCase();
            cur = {
                name  : (parts[0] || '').trim(),
                type  : (parts[1] || '').trim(),
                stage : (parts[2] || '').trim(),
                level : (parts[3] || '').trim(),
                when  : (parts[4] || '').trim(),
                // Backward-compat migration: missing agency → 'world', missing stall/pin → false
                agency: agencyRaw === 'player' ? 'player' : 'world',
                stall : stallRaw === 'true' || stallRaw === '1' || stallRaw === 'yes',
                pin   : pinRaw === 'true' || pinRaw === '1' || pinRaw === 'yes',
                desc  : '',
                next  : '',
            };
        } else if (/^Desc\s*:/i.test(t) && cur) {
            cur.desc = t.replace(/^Desc\s*:\s*/i, '').trim();
        } else if (/^Next\s*:/i.test(t) && cur) {
            cur.next = t.replace(/^Next\s*:\s*/i, '').trim();
        }
    }
    if (cur) lines.push(cur);
    return lines;
}

// parseLines 的逆：把线对象数组序列化回 <storylines_widget> raw。
// 字段与 parseLines 严格对称：Line: name|type|stage|level|when|agency|stall|pin
function linesToRaw(lines) {
    const blocks = (Array.isArray(lines) ? lines : []).map((l) => {
        const cells = [
            l.name || '', l.type || '', l.stage || '', l.level || '', l.when || '',
            l.agency === 'player' ? 'player' : 'world',
            l.stall ? 'true' : 'false',
            l.pin ? 'true' : 'false',
        ];
        const rows = [`Line: ${cells.join('|')}`];
        if (l.desc) rows.push(`Desc: ${l.desc}`);
        if (l.next) rows.push(`Next: ${l.next}`);
        return rows.join('\n');
    });
    return `<storylines_widget>\n${blocks.join('\n\n')}\n</storylines_widget>`;
}

// 锁定保护：把 oldRaw 里 pin 的线并进 AI 新输出。无锁定线时原样返回（零副作用）。
function mergePinnedLines(oldRaw, aiRaw) {
    const oldPinned = parseLines(oldRaw).filter(l => l.pin);
    if (!oldPinned.length) return aiRaw;
    const newLines = parseLines(aiRaw);
    for (const p of oldPinned) {
        const hit = newLines.find(n => n.name && n.name === p.name);
        if (hit) hit.pin = true;       // AI 保留 → 采纳其推进，重新标 pin
        else newLines.push({ ...p });   // AI 删了 → 原样并回（保命）
    }
    return linesToRaw(newLines);
}

const STAGE_COLORS = {
    萌芽: '#d6b85a', 发酵: '#d98a3d', 逼近: '#cf5f3f', 已爆发: '#b93f3f', 已消散: '#888888',
    筹备: '#7de9d9', 执行: '#58e8b3', 关键: '#2a8a5d', 已完成: '#1b5e3b', 已失败: '#888888',
};

// 点/线面板 header 下方另起一行的「去间改」引导，视觉对齐历法管理页的 .sp-alm-manager-hint。
// 「间」能把讨论落地成点/线，想调整时一键跳过去（handler 见 injectModal 委托）。
const SP_JUMP_HINT_LINES = `<div class="sp-jump-hint">想调整这些线？<button type="button" class="sp-jump-link">和「间」聊聊 →</button></div>`;

function linesToolbarHtml() {
    const onEvents = _linesSheet === 'events';
    const lineBusy = isGeneratingLines ? ' sp-refresh-busy' : '';
    const dashedBusy = isGeneratingDashed ? ' sp-refresh-busy' : '';
    return `<div class="sp-lines-toolbar-inner">
        <div class="sp-lines-sheet-toggle">
            <button type="button" class="sp-lines-sheet-btn${onEvents ? ' sp-lines-sheet-active' : ''}" data-sheet="events">平行事件</button>
            <button type="button" class="sp-lines-sheet-btn${onEvents ? '' : ' sp-lines-sheet-active'}" data-sheet="dashed">冷知识</button>
        </div>
        <div class="sp-lines-tools">
            ${onEvents ? `
                <button class="sp-panel-refresh sp-refresh-lines${lineBusy}" title="重新生成线" aria-label="重新生成线"${isGeneratingLines ? ' disabled' : ''}><i class="fa-solid fa-rotate-right"></i></button>
                <button class="sp-panel-refresh sp-advance-lines${lineBusy}" title="推进事件线（在已有线基础上继续推演）" aria-label="推进事件线"${isGeneratingLines ? ' disabled' : ''}><i class="fa-solid fa-forward"></i></button>
            ` : `<button class="sp-panel-refresh sp-lines-dashed-add${dashedBusy}" title="新增冷知识" aria-label="新增冷知识"${isGeneratingDashed ? ' disabled' : ''}><i class="fa-solid fa-plus"></i></button>`}
        </div>
    </div>`;
}

function renderDashedPanel() {
    const items = readDashedItems();
    const status = isGeneratingDashed
        ? '<div class="sp-lines-dashed-status"><i class="fa-solid fa-spinner fa-spin"></i> 正在翻找冷知识…</div>'
        : _dashedPanelError ? `<div class="sp-lines-dashed-error"><i class="fa-solid fa-circle-exclamation"></i> ${escapeHtml(_dashedPanelError)}</div>` : '';
    if (!items.length) {
        return `${status}<div class="sp-empty sp-lines-dashed-empty"><i class="fa-solid fa-lightbulb"></i><p>还没有冷知识，可以点击右上角新增</p></div>`;
    }
    const rows = items.map((item, index) => `<div class="sp-beat sp-lines-dashed-item${item.locked ? ' sp-lines-dashed-pinned' : ''}" data-id="${escapeAttr(item.id)}">
        <div class="sp-beat-head">
            <span class="sp-seq-badge">#${index + 1}</span>
            <span class="sp-beat-actions">
                <button type="button" class="sp-lines-dashed-lock" data-id="${escapeAttr(item.id)}" title="${item.locked ? '取消锁定这条冷知识' : '锁定这条冷知识'}" aria-label="${item.locked ? '取消锁定这条冷知识' : '锁定这条冷知识'}"><i class="fa-solid ${item.locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
                <button type="button" class="sp-lines-dashed-delete" data-id="${escapeAttr(item.id)}" title="删除这条冷知识" aria-label="删除这条冷知识"><i class="fa-solid fa-xmark"></i></button>
            </span>
        </div>
        <div class="sp-beat-scene">${escapeHtml(item.text)}</div>
    </div>`).join('');
    return `${status}<div class="sp-lines-dashed-list">${rows}</div>`;
}

function renderLines(raw) {
    const lines = parseLines(raw);
    if (lines.length === 0) return SP_JUMP_HINT_LINES + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    const cards = lines.map((l, i) => {
        const levelNum  = parseInt(l.level, 10);
        const level     = Number.isFinite(levelNum) ? Math.max(1, Math.min(4, levelNum)) : 1;
        const stageColor = STAGE_COLORS[l.stage] || '#9aa6b2';
        const beadsHtml = Array.from({length: 4}, (_, i) =>
            `<span class="sp-bead${i < level ? ' sp-bead-on' : ''}" style="${i < level ? `background:${stageColor}` : ''}"></span>`
        ).join('');
        const injectParts = [`【线参考】${l.name}（${l.type}·${l.stage}${l.stall ? '·停滞' : ''}）`];
        if (l.desc) injectParts.push(l.desc);
        if (l.next) injectParts.push(prefixNext(l.next, l.stall));
        const injectBtn = makeInjectBtn(injectParts.join('\n'));
        const stallCls  = l.stall ? ' sp-line-stall' : '';
        const pinCls    = l.pin ? ' sp-line-pinned' : '';
        const stallTag  = l.stall ? `<span class="sp-line-stall-tag">停滞</span>` : '';
        const nextRow   = l.next
            ? `<div class="sp-line-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}">
                    <span class="sp-line-next-tag">${l.stall ? '⏸' : '→'}</span>
                    <span class="sp-line-next-text">${escapeHtml(cleanText(l.next))}</span>
               </div>`
            : '';
        return `
        <div class="sp-beat sp-line-card${stallCls}${pinCls}" data-line-idx="${i}" style="border-left:3px solid ${stageColor}30">
            <div class="sp-beat-head">
                <span class="sp-seq-badge">#${i + 1}</span>
                <span class="sp-beat-type" style="color:${stageColor}">${escapeHtml(l.stage)}</span>
                ${l.type ? `<span class="sp-beat-line">${escapeHtml(l.type)}</span>` : ''}
                <span class="sp-beat-time">${beadsHtml}</span>
                ${stallTag}
                <span class="sp-beat-actions">
                    ${injectBtn}
                    <button class="sp-line-pin-toggle" data-line-idx="${i}" title="${l.pin ? '解锁' : '锁定'}"><i class="fa-solid fa-${l.pin ? 'lock' : 'lock-open'}"></i></button>
                    <button class="sp-line-del-one" data-line-idx="${i}" title="删除这条线"><i class="fa-solid fa-xmark"></i></button>
                </span>
            </div>
            ${l.when ? `<div class="sp-line-when">${escapeHtml(l.when)}</div>` : ''}
            <div class="sp-beat-title">${escapeHtml(l.name)}</div>
            ${l.desc ? `<div class="sp-beat-scene">${escapeHtml(cleanText(l.desc))}</div>` : ''}
            ${nextRow}
        </div>`;
    }).join('');
    return SP_JUMP_HINT_LINES + cards;
}


// ─── 历（日历 / 历法）─────────────────────────────────────────────────────────
// 独立模块，与点/线/面共通但存储隔离：点是 AI 每轮重算的易失数据，历要稳，
// 单独存 chat_metadata（kind='almanac'，不分我/TA，固定 user scope，抄 dashed）。
// 历自己不注入主楼——只在 buildMessages 里作为「本世界观重要日期」喂点/线/大纲，
// 跟随它们已有的注入进主楼。数据形状：{ items:[{id,name,type,month,day,displayDate,note,pin,source}], ts }






// 历「当前日期」锚点体系（almTodayAnchor/almDaysUntil/almWeekdayRef/almWeekdayFor/sortAlmanacUpcoming）
// 已抽出到 business/axis/anchor.js（纯数据层从 data.js/叶子模块 import，跨域读取器经 bindAxisAnchor 注入）。

// 历注入文本构造 getAlmanacInjectText 已抽出到 business/axis/inject.js（纯函数，仅依赖 data.js/anchor.js）。

// 当前历法描述（供间做「改历法」增量编辑参考）；内置公历返回 ''（无需告知，AI 直接按需新建）。

// AI 输出解析：<almanac_widget> 内 Item: name|type|month|day|days|displayDate|note

// 解析间落地的 <era_widget>（纪年/历法描述符）：一行可选 Era: 纪年名 + N 行 Month: 月名|天数。
// 交给 normalizeCalDesc 统一校验裁剪（月名≤12字、天数1-60、月数≤60、年长≤2000），无 Month 行/校验不过 → null。

// 重算合并：保留所有已锁 + 所有自填(user)，丢弃未锁 AI 项，再并入新 AI 项（按名+月日去重）。

// ── 渲染 ──
function closeActionMenus(except = null) {
    $inAll('.sp-action-menu-open').each(function () {
        if (except && this === except) return;
        $(this).removeClass('sp-action-menu-open').find('.sp-action-menu-list').attr('hidden', true);
        $(this).find('.sp-action-menu-toggle').attr('aria-expanded', 'false');
    });
}

function actionMenuHtml(menuId) {
    const items = ACTION_MENU_CONFIGS[menuId] || [];
    const rows = items.map(item => `<button type="button" class="sp-action-menu-item" data-action="${escapeAttr(item.action)}" title="${escapeAttr(item.title)}">
        <i class="fa-solid ${escapeAttr(item.icon)}" aria-hidden="true"></i><span>${escapeHtml(item.label)}</span>
    </button>`).join('');
    return `<div class="sp-action-menu" data-menu-id="${escapeAttr(menuId)}">
        <button type="button" class="sp-icon-btn sp-action-menu-toggle" title="更多操作" aria-label="更多操作" aria-expanded="false"><i class="fa-solid fa-ellipsis-vertical"></i></button>
        <div class="sp-action-menu-list" hidden>${rows}</div>
    </div>`;
}

// 历面板「今天」栏（仅时间戳关时显示；戳开时整行隐藏——时间戳条已明写当日日期、古风无「周几」概念，只读也多余）。
//   ‹ / ›  = 把「今天」锚点往前/后挪一天（挪一下即固定成手动锚点）
//   改      = 内联输入月/日（不弹窗，_almTodayEditing 切换）
//   自动    = 清锚，恢复自动确认（仅当前已手动钉住时出现）
// 点恒跟随今天：这里挪/钉/清今天都走 runAnchorAftermath → 顺带把点重排到今天（无独立「同步到点」键）。
// 正是给「AI 老提取不准、每天都得去设置里重钉」的卡准备的顺手推进入口。无角色卡 → 只读显示、不给控制。
function almTodayBarHtml() {
    if (storyClockEnabled()) return '';   // 戳开（默认）：今天由戳一线钉，整行隐藏；校准改为回那一楼 reroll
    const key = charStableKey(getContext());
    const cal = loadCalDesc();
    const t = almTodayAnchor();
    const wd = ALM_WEEKDAYS[almWeekdayFor(t.month, t.day, null, cal)];
    if (!key) {
        return `<div class="sp-alm-today">
            <span class="sp-alm-today-lbl">今天</span>
            <span class="sp-alm-today-date">${calMonthName(cal, t.month)}${t.day}日·${wd}</span>
            <span class="sp-alm-today-hint">无角色卡，无法钉</span>
        </div>`;
    }
    if (axisState._almTodayEditing) {
        const maxDim = Math.max(...cal.months.map(x => x.days));
        return `<div class="sp-alm-today sp-alm-today-editing">
            <span class="sp-alm-today-lbl">今天</span>
            <input id="sp-alm-today-month" class="sp-input sp-alm-today-input" type="number" min="1" max="${calMonthCount(cal)}" placeholder="月" value="${t.month}">
            <span class="sp-alm-today-lbl">月</span>
            <input id="sp-alm-today-day" class="sp-input sp-alm-today-input" type="number" min="1" max="${maxDim}" placeholder="日" value="${t.day}">
            <span class="sp-alm-today-lbl">日</span>
            <span class="sp-alm-today-acts">
                <button class="sp-icon-btn sp-alm-today-save" title="确定"><i class="fa-solid fa-check"></i></button>
                <button class="sp-icon-btn sp-alm-today-cancel" title="取消"><i class="fa-solid fa-xmark"></i></button>
            </span>
        </div>`;
    }
    const pinned = getDateAnchor(key);
    const pinTag = pinned ? '<span class="sp-alm-today-pin" title="已手动钉住，压过自动确认"><i class="fa-solid fa-thumbtack"></i></span>' : '';
    const autoBtn = pinned ? '<button class="sp-icon-btn sp-alm-today-clear" title="恢复自动确认"><i class="fa-solid fa-rotate"></i></button>' : '';
    return `<div class="sp-alm-today">
        <span class="sp-alm-today-lbl">今天</span>
        <span class="sp-alm-today-date">${calMonthName(cal, t.month)}${t.day}日·${wd}</span>${pinTag}
        <span class="sp-alm-today-acts">
            <button class="sp-icon-btn sp-alm-today-prev" title="往前一天（−1 天）"><i class="fa-solid fa-chevron-left"></i></button>
            <button class="sp-icon-btn sp-alm-today-next" title="往后一天（+1 天）"><i class="fa-solid fa-chevron-right"></i></button>
            <button class="sp-icon-btn sp-alm-today-edit" title="改日期"><i class="fa-solid fa-pen"></i></button>${autoBtn}
        </span>
    </div>`;
}
// 时间戳·只读显示行。开关关 → 空串（整行不显）。开着但还没扫到戳 → 显示占位（可诊断）。
// 扫到戳 → 起→止（只有其一就单显）。本片只回显原文、不解析。放今天条下方，与「今天(历日期)」并列作参考。
function storyClockBarHtml() {
    if (!storyClockEnabled()) return '';
    let clk = null;
    try { clk = latestStoryClock(); } catch { clk = null; }
    let val;
    if (!clk || (!clk.start && !clk.end)) {
        // 开着但还没扫到任何戳：显示占位，让用户区分「显示层/开关坏了」还是「主楼 AI 还没产出戳」。
        val = '<span class="sp-alm-clock-wait">等待主楼 AI 打点…（发几楼后自动出现）</span>';
    } else if (clk.start && clk.end && clk.start !== clk.end) {
        val = `${escapeHtml(clk.start)} <span class="sp-alm-clock-arrow">→</span> ${escapeHtml(clk.end)}`;
    } else {
        val = escapeHtml(clk.end || clk.start);
    }
    return `<div class="sp-alm-clock" title="由主楼 AI 每楼打的隐形时间戳读回，精确到小时">
        <span class="sp-alm-clock-lbl"><i class="fa-regular fa-clock"></i>时间戳</span>
        <span class="sp-alm-clock-val">${val}</span>
    </div>`;
}
// 「今天」±1 天：以当前显示的今天（可能来自自动源）为基准挪 delta 天，钉成手动锚点，走共享善后。
function almNudgeToday(delta) {
    if (storyClockEnabled()) return;   // 戳开时今天由戳一线钉、手动挪键已隐；防手机端陈旧 DOM 误触
    const key = charStableKey(getContext());
    if (!key) { showToast('当前没有角色卡，无法钉日期', null, true); return; }
    const cal = loadCalDesc();
    const t = almTodayAnchor();
    const nd = almMonthDayFromDoy(almDayOfYear(t.month, t.day, cal) + delta, cal);
    setDateAnchor(key, nd.month, nd.day);
    runAnchorAftermath();
}
function almRowHtml(it, ctx) {
    const meta = almTypeMeta(it.type);
    const wd = ALM_WEEKDAYS[almWeekdayFor(it.month, it.day, ctx?.wkRef, ctx?.cal)];   // 起始日周几（年-free）
    const days = almClampInt(it.days, 1, calYearLen(ctx?.cal), 1);
    const spanTag = days > 1 ? `<span class="sp-alm-span-tag">共${days}天</span>` : '';
    const active = days > 1 && ctx?.todayDoy != null && almItemCoversDoy(it, ctx.todayDoy, ctx?.cal);
    const activeTag = active ? '<span class="sp-alm-active-tag">进行中</span>' : '';
    const srcTag = it.source === 'user' ? '<span class="sp-alm-src-tag">自填</span>' : '';
    // 批量模式：日历条目对应 'almanac' scope。命中当前 scope 才出勾选框、隐藏行操作钮。
    const batchOn = getBatchScope() === 'almanac';
    const checked = batchOn && getBatchSelected().has(it.id);
    const checkbox = batchOn
        ? `<input type="checkbox" class="sp-batch-check" ${checked ? 'checked' : ''} aria-label="选择此条">`
        : '';
    // 三行布局（旧两行把日期/周几/名字/标签全塞第一行，长节日名会把末尾操作按钮顶掉）：
    //   L1 = 日期 + 周几 + 持续天数「共N天」…… 右对齐三个操作按钮（全是短、定宽内容，按钮永不被挤掉）
    //   L2 = 节日名 + 类型标签 + 自填 + 进行中（可变长的名字独占一行、溢出省略号，不再顶按钮）
    //   L3 = 备注（整行）
    return `<div class="sp-alm-item sp-alm-type-${meta.cls}${it.pin ? ' sp-alm-pinned' : ''}${batchOn ? ' sp-batch-row' : ''}${checked ? ' sp-batch-checked' : ''}" data-id="${it.id}">
        <div class="sp-alm-top">
            ${checkbox}<i class="fa-solid ${meta.icon} sp-alm-date-icon"></i>
            <span class="sp-alm-date-txt">${escapeHtml(almDateLabel(it, ctx?.cal))}</span>
            <span class="sp-alm-wd">${wd}</span>${spanTag}
            ${batchOn ? '' : `<span class="sp-alm-acts">
                <button class="sp-icon-btn sp-alm-pin" data-id="${it.id}" title="${it.pin ? '已锁定 · 生成时保留（点击解锁）' : '锁定 · 生成时保留'}"><i class="fa-solid ${it.pin ? 'fa-lock' : 'fa-lock-open'}"></i></button>
                <button class="sp-icon-btn sp-alm-edit" data-id="${it.id}" title="编辑"><i class="fa-solid fa-pen"></i></button>
                <button class="sp-icon-btn sp-alm-del" data-id="${it.id}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </span>`}
        </div>
        <div class="sp-alm-meta">
            <span class="sp-alm-name">${escapeHtml(it.name)}</span>
            <span class="sp-alm-type-tag">${meta.label}</span>${srcTag}${activeTag}
        </div>
        ${it.note ? `<div class="sp-alm-note">${escapeHtml(it.note)}</div>` : ''}
    </div>`;
}

function renderAlmanacEmpty() {
    return `<div class="sp-empty sp-alm-empty">
        <span class="sp-alm-empty-glyph"><i class="fa-regular fa-calendar"></i></span>
        <p>还没有历法数据</p>
        <p class="sp-alm-empty-hint">点「生成节日」让 AI 按当前世界观铺满一整年，或「添加」手动录入生日、纪念日等</p>
        <div class="sp-alm-empty-actions">
            <button class="sp-gen-btn sp-alm-gen">生成节日</button>
            <button class="sp-alm-add-link sp-alm-add">手动添加</button>
        </div>
    </div>`;
}

function legacyRenderAlmanacUpcoming() {
    const items = loadAlmanac();
    if (!items.length) return renderAlmanacEmpty();
    const anchor = almTodayAnchor();
    const cal = loadCalDesc();
    const ctx = { cal, wkRef: almWeekdayRef(cal), todayDoy: almDayOfYear(anchor.month, anchor.day, cal) };
    const sorted = sortAlmanacUpcoming(items, cal);
    return batchBarHtml('almanac', sorted.length, '批量删除', true) + `<div class="sp-alm-list">${sorted.map(it => almRowHtml(it, ctx)).join('')}</div>`;
}

// 暗账页（ledger sheet）渲染/编辑/批量交互整套已迁入 business/ledger/render.js（Option B）；index.js 宿主经 bindLedgerRender 注入，事件层经访问器读写迁出的渲染态。
function currentCharacterCards() {
    const ctx = getContext();
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const currentAvatar = charStableKey(ctx);
    const seen = new Set();
    return characters.map(character => {
        const avatar = String(character?.avatar ?? '');
        if (!avatar || seen.has(avatar)) return null;
        seen.add(avatar);
        const rawName = character?.name == null ? '' : String(character.name);
        return { avatar, name: rawName === '' ? avatar : rawName, current: avatar === currentAvatar };
    }).filter(Boolean).sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name, 'zh-CN'));
}

// 早期 WIP 曾裁剪 avatar；精确键优先，只有不存在同名精确角色时才兼容旧裁剪键。
function calendarBindingKey(bindings, avatar, cards = currentCharacterCards()) {
    if (Object.prototype.hasOwnProperty.call(bindings, avatar)) return avatar;
    const legacy = avatar.trim();
    if (legacy !== avatar && Object.prototype.hasOwnProperty.call(bindings, legacy) && !cards.some(card => card.avatar === legacy)) return legacy;
    return avatar;
}

function calendarBoundTemplateId(bindings, avatar, cards = currentCharacterCards()) {
    return bindings[calendarBindingKey(bindings, avatar, cards)] || '';
}

function setCalendarBinding(bindings, avatar, templateId, cards = currentCharacterCards()) {
    const oldKey = calendarBindingKey(bindings, avatar, cards);
    delete bindings[oldKey];
    delete bindings[avatar];
    if (templateId) bindings[avatar] = templateId;
}

function calendarBindingCandidates(cards, bindings, templateId, query = '') {
    const normalizedQuery = String(query ?? '').toLocaleLowerCase();
    return cards.filter(card => {
        if (calendarBoundTemplateId(bindings, card.avatar, cards) === templateId) return false;
        return !normalizedQuery || card.name.toLocaleLowerCase().includes(normalizedQuery) || card.avatar.toLocaleLowerCase().includes(normalizedQuery);
    });
}

function openCalendarManager() {
    axisState._almanacEditor = null;
    axisState._almanacManager = { editing: false, draft: cloneCalDesc(loadCalDesc()), error: '', templatesOpen: false, bindTemplateId: null, bindQuery: '' };
    if (axisState.almanacMode) renderAlmanacPanel();
}

function closeCalendarManager() {
    axisState._almanacManager = null;
    if (axisState.almanacMode) renderAlmanacPanel();
}

function readCalendarDraftForm() {
    if (!axisState._almanacManager?.editing) return axisState._almanacManager?.draft;
    return {
        era: String($in('#sp-alm-manager-era').val() || ''),
        months: $inAll('#sp-almanac-wrap .sp-alm-manager-month-row').map(function () {
            return { name: String($(this).find('.sp-alm-manager-month-name').val() || ''), days: $(this).find('.sp-alm-manager-month-days').val() };
        }).get(),
    };
}

function captureCalendarDraft() {
    if (axisState._almanacManager?.editing) axisState._almanacManager.draft = readCalendarDraftForm();
}

function copyCalendarMonth(months, index, maxMonths) {
    if (!Array.isArray(months) || months.length >= maxMonths || !months[index]) return false;
    const source = months[index];
    months.splice(index + 1, 0, { name: source.name, days: source.days });
    return true;
}

function renderCalendarCard() {
    const manager = axisState._almanacManager;
    const cal = manager.editing ? manager.draft : cloneCalDesc(loadCalDesc());
    const actionButtons = manager.editing
        ? `<button class="sp-icon-btn sp-alm-manager-edit-cancel" title="取消编辑" aria-label="取消编辑"><i class="fa-solid fa-xmark"></i></button>
           <button class="sp-icon-btn sp-alm-manager-edit-save" title="保存历法" aria-label="保存历法"><i class="fa-solid fa-check"></i></button>`
        : `<button class="sp-icon-btn sp-alm-manager-edit-start" title="编辑历法" aria-label="编辑历法"><i class="fa-solid fa-pen"></i></button>`;
    const actions = `<span class="sp-alm-manager-card-actions">${actionButtons}</span>`;
    if (!manager.editing) {
        const months = cal.months.map(month => `<span class="sp-alm-manager-month-chip">${escapeHtml(month.name)} · ${month.days}天</span>`).join('');
        return `<section class="sp-alm-manager-card"><div class="sp-alm-manager-card-head">
            <div class="sp-alm-manager-card-title">当前历法</div>${actions}
        </div><div class="sp-alm-manager-card-body">${cal.era ? `<div class="sp-alm-manager-current-name">${escapeHtml(cal.era)}</div>` : ''}<div class="sp-alm-manager-months">${months}</div></div></section>`;
    }
    const rows = cal.months.map((month, index) => `<div class="sp-alm-manager-month-row" data-index="${index}">
        <label class="sp-alm-manager-month-field sp-alm-manager-month-field-name"><span>月份名称</span><input class="sp-input sp-alm-manager-month-name" maxlength="${CALENDAR_LIMITS.monthNameLength}" value="${escapeAttr(month.name)}" aria-label="第 ${index + 1} 月名称"></label>
        <label class="sp-alm-manager-month-field sp-alm-manager-month-field-days"><span>天数</span><input class="sp-input sp-alm-manager-month-days" type="number" min="${CALENDAR_LIMITS.monthDaysMin}" max="${CALENDAR_LIMITS.monthDaysMax}" value="${escapeAttr(month.days)}" aria-label="第 ${index + 1} 月天数"></label>
        <span class="sp-alm-manager-month-actions">
            <button class="sp-icon-btn sp-alm-manager-month-up" title="上移月份" aria-label="上移月份"${index === 0 ? ' disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
            <button class="sp-icon-btn sp-alm-manager-month-down" title="下移月份" aria-label="下移月份"${index === cal.months.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
            <button class="sp-icon-btn sp-alm-manager-month-copy" title="复制月份" aria-label="复制月份"><i class="fa-solid fa-copy"></i></button>
            <button class="sp-icon-btn sp-alm-manager-month-delete" title="删除月份" aria-label="删除月份"><i class="fa-solid fa-trash"></i></button>
        </span>
    </div>`).join('');
    return `<section class="sp-alm-manager-card"><div class="sp-alm-manager-card-head">
        <div class="sp-alm-manager-card-title">编辑当前历法</div>${actions}
    </div><div class="sp-alm-manager-edit-fields">
        ${manager.error ? `<div class="sp-alm-manager-error" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(manager.error)}</div>` : ''}
        <label class="sp-alm-field"><span>纪年名 <small>选填</small></span><input id="sp-alm-manager-era" maxlength="${CALENDAR_LIMITS.eraNameLength}" value="${escapeAttr(cal.era)}"></label>
        ${rows}<button class="sp-alm-manager-add-month" type="button"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>添加月份</span></button>
    </div></section>`;
}

function renderCalendarBindingOptions(templateId) {
    const manager = axisState._almanacManager;
    if (!manager) return '';
    const cards = currentCharacterCards();
    const bindings = calendarTemplateBindings();
    const query = String(manager.bindQuery ?? '');
    const shown = calendarBindingCandidates(cards, bindings, templateId, query);
    if (!shown.length) return `<div class="sp-alm-manager-bind-empty">${query ? '没有匹配的角色卡' : '没有更多可添加的角色卡'}</div>`;
    return shown.map(card => `<button type="button" class="sp-alm-manager-bind-option${card.current ? ' sp-alm-manager-bind-option-current' : ''}" role="option" aria-selected="false" data-template-id="${escapeAttr(templateId)}" data-avatar="${escapeAttr(card.avatar)}" title="${escapeAttr(card.avatar)}">
        <i class="fa-solid fa-user" aria-hidden="true"></i><span class="sp-alm-manager-bind-option-label"><span class="sp-alm-manager-bind-option-name">${escapeHtml(card.name)}</span>${card.current ? '<small class="sp-alm-manager-bind-option-hint">(当前角色卡)</small>' : ''}</span>
    </button>`).join('');
}

function renderCalendarBindingEditor(templateId, cards, bindings) {
    const selected = cards.filter(card => calendarBoundTemplateId(bindings, card.avatar, cards) === templateId);
    const chips = selected.map(card => `<button type="button" class="sp-alm-manager-bind-chip-remove${card.current ? ' sp-alm-manager-bind-chip-current' : ''}" data-template-id="${escapeAttr(templateId)}" data-avatar="${escapeAttr(card.avatar)}" aria-label="解除角色卡 ${escapeAttr(card.name)} 的模板绑定" title="解除绑定">
        <span>${escapeHtml(card.name)}</span><i class="fa-solid fa-xmark" aria-hidden="true"></i>
    </button>`).join('');
    return `<div class="sp-alm-manager-bind-panel">
        <div class="sp-alm-manager-bind-chips">${chips || '<span class="sp-alm-manager-bind-empty">尚未绑定角色卡 · 当绑定角色的当前聊天既没有历法，也没有纪念日时，将自动采用此历法</span>'}</div>
        <input type="text" class="sp-input sp-alm-manager-bind-search" role="combobox" aria-expanded="true" aria-controls="sp-alm-manager-bind-results-${escapeAttr(templateId)}" data-template-id="${escapeAttr(templateId)}" value="${escapeAttr(axisState._almanacManager.bindQuery)}" placeholder="搜索角色卡名称…" autocomplete="off">
        <div id="sp-alm-manager-bind-results-${escapeAttr(templateId)}" class="sp-alm-manager-bind-results" role="listbox">${renderCalendarBindingOptions(templateId)}</div>
    </div>`;
}

function renderCalendarTemplates() {
    const manager = axisState._almanacManager;
    const cards = currentCharacterCards();
    const bindings = calendarTemplateBindings();
    const currentAvatar = charStableKey(getContext());
    const currentTemplateId = currentAvatar ? calendarBoundTemplateId(bindings, currentAvatar, cards) : '';
    const countFor = id => Object.values(bindings).filter(value => value === id).length;
    const batchOn = getBatchScope() === 'calendar';
    const templateRows = sortCalendarTemplatesForCurrent(loadCalendarTemplates(), currentTemplateId);
    const rows = templateRows.map(template => {
        const bindOpen = manager.bindTemplateId === template.id;
        const isCurrent = template.id === currentTemplateId;
        const bindTitle = isCurrent ? '当前角色已绑定此模板' : '绑定角色卡';
        const checked = batchOn && getBatchSelected().has(template.id);
        const checkbox = batchOn
            ? `<input type="checkbox" class="sp-batch-check" ${checked ? 'checked' : ''} aria-label="选择此模板">`
            : '';
        const acts = batchOn ? '' : `<span class="sp-alm-manager-template-actions">
                <button class="sp-icon-btn sp-alm-manager-template-rename" data-id="${escapeAttr(template.id)}" title="重命名模板" aria-label="重命名模板"><i class="fa-solid fa-i-cursor"></i></button>
                <button class="sp-icon-btn sp-alm-manager-template-apply" data-id="${escapeAttr(template.id)}" title="应用此模板" aria-label="应用此模板"><i class="fa-solid fa-file-import"></i></button>
                <button class="sp-icon-btn sp-alm-manager-template-bind${isCurrent ? ' sp-btn-active' : ''}" data-id="${escapeAttr(template.id)}" title="${bindTitle}" aria-label="${bindTitle}" aria-expanded="${bindOpen}"><i class="fa-solid fa-link"></i></button>
                <button class="sp-icon-btn sp-alm-manager-template-delete" data-id="${escapeAttr(template.id)}" title="删除模板" aria-label="删除模板"><i class="fa-solid fa-trash"></i></button>
            </span>`;
        return `<div class="sp-alm-manager-template-entry${isCurrent ? ' sp-alm-manager-template-current' : ''}${batchOn ? ' sp-batch-row' : ''}${checked ? ' sp-batch-checked' : ''}" data-template-id="${escapeAttr(template.id)}">
            <div class="sp-alm-manager-template-row">${checkbox}<div class="sp-alm-manager-template-main">
                <div class="sp-alm-manager-template-name">${escapeHtml(template.name)}</div>
                <div class="sp-alm-manager-template-meta">已绑定 ${countFor(template.id)} 张角色卡</div>
            </div>${acts}</div>
            ${!batchOn && bindOpen ? renderCalendarBindingEditor(template.id, cards, bindings) : ''}
        </div>`;
    }).join('');
    const batchBar = batchBarHtml('calendar', templateRows.length, '批量删除', true);
    return `<section class="sp-alm-manager-templates">
        <button class="sp-alm-manager-template-head" type="button" aria-expanded="${manager.templatesOpen}"><span>模板管理</span><i class="fa-solid fa-chevron-${manager.templatesOpen ? 'up' : 'down'}"></i></button>
        ${manager.templatesOpen ? `<div class="sp-alm-manager-template-body">
            <button type="button" class="sp-alm-manager-template-save-current"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>保存当前历法为模板</span></button>
            ${batchBar}
            <div class="sp-alm-manager-template-list">${rows || '<div class="sp-alm-manager-empty-templates">还没有历法模板</div>'}</div>
        </div>` : ''}
    </section>`;
}

// 绑定写入设置唯一状态源后立即局部重绘；ST 设置保存没有可靠的逐次成功回执，因此不显示成功提示。
async function updateCalendarTemplateBinding(avatar, nextTemplateId, expectedTemplateId = null) {
    const manager = axisState._almanacManager;
    if (!manager || !avatar) return false;
    const cards = currentCharacterCards();
    const bindings = { ...calendarTemplateBindings() };
    const currentId = calendarBoundTemplateId(bindings, avatar, cards);
    if (expectedTemplateId != null && currentId !== expectedTemplateId) return false;
    if (currentId === (nextTemplateId || '')) return true;

    const chatIdSnap = getContext().chatId;
    const currentAvatarSnap = charStableKey(getContext());
    setCalendarBinding(bindings, avatar, nextTemplateId, cards);
    getSettings().calendarTemplateBindings = bindings;
    manager.bindQuery = '';
    refreshCalendarManager({ scope: 'templates', reveal: { kind: 'template', id: manager.bindTemplateId, selector: '.sp-alm-manager-bind-search' }, focusBindingId: manager.bindTemplateId });
    saveSettingsDebounced();

    if (nextTemplateId && avatar === currentAvatarSnap && getContext().chatId === chatIdSnap) {
        // 先让移动端绘制绑定结果；连续改绑时，只有仍然生效的最后一次操作可以应用默认历法。
        await new Promise(resolve => (globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0)))(resolve));
        const latestCards = currentCharacterCards();
        const stillCurrent = getContext().chatId === chatIdSnap
            && charStableKey(getContext()) === currentAvatarSnap
            && calendarBoundTemplateId(calendarTemplateBindings(), avatar, latestCards) === nextTemplateId;
        if (stillCurrent) {
            try {
                const applied = await maybeApplyBoundCalendarTemplate({ render: false });
                if (applied && axisState._almanacManager) refreshCalendarManager({ scope: 'card' });
            } catch (error) {
                console.error('[SP calendar] 角色默认历法应用失败', error);
                showToast('角色绑定已更新，但默认历法没有应用成功，请稍后重试', null, true);
            }
        }
    }
    return true;
}

function legacyRenderCalendarManagerBody() { return renderCalendarCard() + renderCalendarTemplates(); }

function calendarManagerTarget(target, $content) {
    if (!target) return $();
    if (target.kind === 'month') {
        const $row = $content.find('.sp-alm-manager-month-row').filter(function () { return Number($(this).attr('data-index')) === target.index; }).first();
        return target.selector ? $row.find(target.selector).first() : $row;
    }
    if (target.kind === 'template') {
        const $entry = $content.find('.sp-alm-manager-template-entry').filter(function () { return $(this).attr('data-template-id') === target.id; }).first();
        return target.selector ? $entry.find(target.selector).first() : $entry;
    }
    return target.selector ? $content.find(target.selector).first() : $();
}

function focusCalendarManagerTarget($target) {
    const element = $target?.get?.(0);
    if (!element || typeof element.focus !== 'function' || element.disabled) return;
    try { element.focus({ preventScroll: true }); }
    catch (_) { element.focus(); }
}

function revealCalendarManagerTarget($target, $scroller) {
    const element = $target?.get?.(0), scroller = $scroller?.get?.(0);
    if (!element || !scroller) return;
    const targetRect = element.getBoundingClientRect(), scrollRect = scroller.getBoundingClientRect();
    if (targetRect.top < scrollRect.top) scroller.scrollTop += targetRect.top - scrollRect.top - 6;
    else if (targetRect.bottom > scrollRect.bottom) scroller.scrollTop += targetRect.bottom - scrollRect.bottom + 6;
}

// 管理页内部只替换业务内容，保留真正的滚动容器；否则每次操作都会重建 scrollTop 和焦点。
function legacyRefreshCalendarManager(options = {}) {
    const $wrap = $in('#sp-almanac-wrap');
    const $scroller = $wrap.find('.sp-alm-body').first();
    const $content = $scroller.children('.sp-alm-editor-body').first();
    if (!$wrap.find('.sp-alm-manager-hint').length || !$content.length) return false;

    const scope = options.scope || 'body';
    const $oldSearch = $content.find('.sp-alm-manager-bind-search').first();
    const oldBindingView = $oldSearch.length ? {
        id: $oldSearch.attr('data-template-id'),
        query: String($oldSearch.val() ?? ''),
        // focus 在 shadow 内时 document.activeElement 被重定向为 host（拿不到内部输入框）→ 查 _spShadow.activeElement，否则搜索框每次重渲都丢焦点
        active: (_spShadow?.activeElement ?? document.activeElement) === $oldSearch.get(0),
        selectionStart: $oldSearch.get(0).selectionStart,
        selectionEnd: $oldSearch.get(0).selectionEnd,
        resultsScrollTop: $oldSearch.closest('.sp-alm-manager-bind-panel').find('.sp-alm-manager-bind-results').scrollTop() || 0,
    } : null;

    if (scope === 'templates') {
        const $templates = $content.children('.sp-alm-manager-templates').first();
        if (!$templates.length) return false;
        $templates.replaceWith(renderCalendarTemplates());
    } else if (scope === 'card') {
        const $card = $content.children('.sp-alm-manager-card').first();
        if (!$card.length) return false;
        $card.replaceWith(renderCalendarCard());
    } else {
        $content.html(legacyRenderCalendarManagerBody());
    }

    const focusBindingId = options.focusBindingId || (oldBindingView?.active ? oldBindingView.id : null);
    if (oldBindingView) {
        const $newSearch = $content.find('.sp-alm-manager-bind-search').filter(function () { return $(this).attr('data-template-id') === oldBindingView.id; }).first();
        if ($newSearch.length && String($newSearch.val() ?? '') === oldBindingView.query) {
            $newSearch.closest('.sp-alm-manager-bind-panel').find('.sp-alm-manager-bind-results').scrollTop(oldBindingView.resultsScrollTop);
            if (oldBindingView.active) {
                focusCalendarManagerTarget($newSearch);
                $newSearch.get(0).setSelectionRange(oldBindingView.selectionStart, oldBindingView.selectionEnd);
            }
        }
    }
    if (focusBindingId) {
        const $search = $content.find('.sp-alm-manager-bind-search').filter(function () { return $(this).attr('data-template-id') === focusBindingId; }).first();
        focusCalendarManagerTarget($search);
    } else if (options.focus) {
        focusCalendarManagerTarget(calendarManagerTarget(options.focus, $content));
    }
    revealCalendarManagerTarget(calendarManagerTarget(options.reveal, $content), $scroller);
    return true;
}

function legacyRenderCalendarManager() {
    return `<div class="sp-alm-editor-head">
        <button class="sp-icon-btn sp-alm-manager-back" title="返回" aria-label="返回"><i class="fa-solid fa-arrow-left"></i></button>
        <span class="sp-alm-editor-title">历法管理</span>
    </div><div class="sp-alm-manager-hint">不想自己填？<button type="button" class="sp-alm-manager-chat-link">和间聊聊吧 →</button></div>
    <div class="sp-alm-body"><div class="sp-alm-editor-body">${legacyRenderCalendarManagerBody()}</div></div>`;
}

// 调用方负责传入已规范化的历法；本函数只处理日期冲突、统一写入和消费者刷新。
async function commitCalendarDesc(cal) {
    const chatIdSnap = getContext().chatId;
    const items = loadAlmanac();
    const conflicts = calendarConflicts(items, cal);
    const charKey = charStableKey(getContext());
    const rawAnchor = charKey ? getSettings().dateAnchor?.[charKey] : null;
    const anchorConflict = rawAnchor && !(Number(rawAnchor.month) >= 1 && Number(rawAnchor.month) <= calMonthCount(cal) && Number(rawAnchor.day) >= 1 && Number(rawAnchor.day) <= calMonthDays(cal, Number(rawAnchor.month)));
    let action = 'keep';
    if (conflicts.length || anchorConflict) {
        const shown = conflicts.slice(0, 12).map(conflict => `• ${conflict.item.name}：${conflict.item.month}/${conflict.item.day} → ${conflict.fixed.month}/${conflict.fixed.day}`);
        if (conflicts.length > shown.length) shown.push(`• 另有 ${conflicts.length - shown.length} 条`);
        if (anchorConflict) {
            const fixedMonth = Math.min(Math.max(Number(rawAnchor.month) || 1, 1), calMonthCount(cal));
            const fixedDay = Math.min(Math.max(Number(rawAnchor.day) || 1, 1), calMonthDays(cal, fixedMonth));
            shown.push(`• 当前剧情日期：${rawAnchor.month}/${rawAnchor.day} → ${fixedMonth}/${fixedDay}`);
        }
        action = await customDialog.choose({
            title: '有日期不适用于新历法',
            body: shown.join('\n'),
            note: '自动修改会保留条目并夹取到有效日期；删除只删除上面列出的日期。',
            choices: [
                { value: 'cancel', label: '取消' },
                { value: 'delete', label: '删除这些日期' },
                { value: 'fix', label: '自动修改', primary: true },
            ],
        });
        if (!action || action === 'cancel' || getContext().chatId !== chatIdSnap) return { ok: false, cancelled: true };
    }
    const conflictIds = new Set(conflicts.map(conflict => conflict.item.id));
    const fixedById = new Map(conflicts.map(conflict => [conflict.item.id, conflict.fixed]));
    const nextItems = action === 'delete' ? items.filter(item => !conflictIds.has(item.id)) : items.map(item => fixedById.get(item.id) || item);
    if (getContext().chatId !== chatIdSnap) return { ok: false, cancelled: true };
    const ts = Date.now();
    const ok = store.writeBatch([
        { kind: 'caldesc', view: 'user', charName: '', value: { ...cal, ts } },
        { kind: 'almanac', view: 'user', charName: '', value: { items: nextItems, ts } },
    ]);
    if (!ok) return { ok: false, error: '当前聊天无法写入历法' };
    if (anchorConflict && charKey) {
        if (action === 'delete') setDateAnchor(charKey, null);
        else {
            const fixedMonth = Math.min(Math.max(Number(rawAnchor.month) || 1, 1), calMonthCount(cal));
            const fixedDay = Math.min(Math.max(Number(rawAnchor.day) || 1, 1), calMonthDays(cal, fixedMonth));
            setDateAnchor(charKey, fixedMonth, fixedDay);
        }
    }
    axisState._almanacCalMonth = null;
    axisState._almanacCalDay = null;
    axisState._almTodayEditing = false;
    syncLatestAlmanacBlock();
    syncLatestScheduleBlock();
    return { ok: true, cal };
}

async function maybeApplyBoundCalendarTemplate({ notify = true, render = true } = {}) {
    if (!pluginEnabled() || !getContext().chatId) return false;
    const charKey = charStableKey(getContext());
    if (!charKey || readStore(getCalDescKey()) != null) return false;
    const rawItems = readStore(getAlmanacKey())?.items;
    if (Array.isArray(rawItems) && rawItems.length) return false; // 已有日期时完全静默，避免打扰和隐式迁移。
    const bindings = calendarTemplateBindings();
    const bindingKey = calendarBindingKey(bindings, charKey, currentCharacterCards());
    const templateId = bindings[bindingKey] || '';
    if (!templateId) return false;
    const template = loadCalendarTemplates().find(item => item.id === templateId);
    if (!template) {
        delete bindings[bindingKey];
        saveSettingsDebounced();
        return false;
    }
    const cal = cloneCalDesc(template);
    const chatIdSnap = getContext().chatId;
    if (getContext().chatId !== chatIdSnap) return false;
    if (!saveCalDesc(cal)) throw new Error('当前聊天无法写入角色默认历法');
    const rawAnchor = getSettings().dateAnchor?.[charKey];
    if (rawAnchor) {
        const month = Math.min(Math.max(Number(rawAnchor.month) || 1, 1), calMonthCount(cal));
        const day = Math.min(Math.max(Number(rawAnchor.day) || 1, 1), calMonthDays(cal, month));
        setDateAnchor(charKey, month, day);
    }
    axisState._almanacCalMonth = null;
    axisState._almanacCalDay = null;
    syncLatestAlmanacBlock(chatIdSnap);
    syncLatestScheduleBlock(chatIdSnap);
    if (render && axisState.almanacMode) renderAlmanacPanel();
    if (notify && getSettings().notifyMode === 'full') showToast(`已采用角色默认历法：${template.name}`);
    return true;
}

function almCalMonth() {
    if (Number.isFinite(axisState._almanacCalMonth)) return axisState._almanacCalMonth;
    axisState._almanacCalMonth = almTodayAnchor().month - 1;
    return axisState._almanacCalMonth;
}

function legacyRenderAlmanacCalendar() {
    const cal = loadCalDesc();
    const m0 = almCalMonth();
    const month1 = m0 + 1;
    const items = loadAlmanac();
    const wkRef = almWeekdayRef(cal);
    // 多日节假日在每个「覆盖到本月」的日子都打点：逐条按 days 折算覆盖日，落在本月才计入。
    const byDay = {};
    for (const it of items) {
        const days = almClampInt(it.days, 1, calYearLen(cal), 1);
        const startDoy = almDayOfYear(it.month, it.day, cal);
        for (let k = 0; k < days; k++) {
            const md = almMonthDayFromDoy(startDoy + k, cal);
            if (md.month !== month1) continue;
            (byDay[md.day] = byDay[md.day] || []).push(it);
        }
    }
    const dim = calMonthDays(cal, month1);
    const anchor = almTodayAnchor();
    const todayDoy = almDayOfYear(anchor.month, anchor.day, cal);
    const ctx = { cal, wkRef, todayDoy };
    const isThisMonth = (anchor.month - 1) === m0;   // 只比月/日，不比年
    const todayD = anchor.day;
    const selDay = axisState._almanacCalDay;

    // 周一起表头 + 首日前留白：day1 的周几决定 lead（周一=0 空格 … 周日=6 空格）。
    const weekHead = ['一', '二', '三', '四', '五', '六', '日']
        .map(w => `<div class="sp-alm-weekhead-cell">${w}</div>`).join('');
    const wd1 = almWeekdayFor(month1, 1, wkRef, cal);
    const lead = (wd1 + 6) % 7;
    const leadCells = Array.from({ length: lead }, () => '<div class="sp-alm-cell-empty"></div>').join('');

    const cells = [];
    for (let dnum = 1; dnum <= dim; dnum++) {
        const dayItems = byDay[dnum] || [];
        const has = dayItems.length > 0;
        const dots = has
            ? `<span class="sp-alm-cell-dots">${dayItems.slice(0, 3).map(it => `<i class="sp-alm-dot sp-alm-type-${almTypeMeta(it.type).cls}"></i>`).join('')}</span>`
            : '';
        cells.push(`<div class="sp-alm-cell${has ? ' sp-alm-cell-has' : ''}${isThisMonth && dnum === todayD ? ' sp-alm-cell-today' : ''}${selDay === dnum ? ' sp-alm-cell-sel' : ''}" data-day="${dnum}">
            <span class="sp-alm-cell-num">${dnum}</span>${dots}
        </div>`);
    }

    const header = `<div class="sp-alm-cal-head">
        <button class="sp-icon-btn sp-alm-cal-prev" title="上个月"><i class="fa-solid fa-chevron-left"></i></button>
        <span class="sp-alm-cal-title">${calMonthName(cal, month1)}</span>
        <button class="sp-icon-btn sp-alm-cal-next" title="下个月"><i class="fa-solid fa-chevron-right"></i></button>
    </div>`;

    let detailItems, detailHead;
    if (selDay != null) {
        // 详情列出「覆盖选中日」的条目（含跨月延续来的多日节假日），按起始日排序。
        const selDoy = almDayOfYear(month1, selDay, cal);
        detailItems = items.filter(it => almItemCoversDoy(it, selDoy, cal)).sort((a, b) => a.month - b.month || a.day - b.day);
        detailHead = `<div class="sp-alm-cal-detail-head">
            <span>${calMonthName(cal, month1)}${selDay}日 · ${ALM_WEEKDAYS[almWeekdayFor(month1, selDay, wkRef, cal)]}</span>
            <span class="sp-alm-cal-detail-tools">
                <button class="sp-alm-add-day sp-mini-btn" data-day="${selDay}">＋加到这天</button>
                <button class="sp-alm-cal-clearsel sp-mini-btn">看全月</button>
            </span>
        </div>`;
    } else {
        detailItems = items.filter(it => it.month === month1).sort((a, b) => a.day - b.day);
        detailHead = `<div class="sp-alm-cal-detail-head"><span>本月日期</span></div>`;
    }
    const detailRows = detailItems.length
        ? `<div class="sp-alm-list">${detailItems.map(it => almRowHtml(it, ctx)).join('')}</div>`
        : `<div class="sp-alm-cal-empty">${selDay != null ? '这天没有日期' : '本月暂无日期'}</div>`;

    return `<div class="sp-alm-cal">
        ${header}
        <div class="sp-alm-weekhead">${weekHead}</div>
        <div class="sp-alm-grid">${leadCells}${cells.join('')}</div>
        <div class="sp-alm-cal-detail">${detailHead}${detailRows}</div>
    </div>`;
}

// ── 子视图 / 导航 ──
function almSetSheet(sheet) {
    if (axisState._almanacSheet === sheet) return;
    setAxisSheet(sheet, renderAlmanacPanel, batchReset);
    return;
    batchReset();   // 切换 sheet 退出批量模式，避免跨列表误删
    renderAlmanacPanel();
}
function almNavMonth(delta) {
    navigateAxisMonth(delta, () => calMonthCount(loadCalDesc()), almCalMonth, renderAlmanacPanel);
    return;
    axisState._almanacCalMonth = (almCalMonth() + delta + mc) % mc;   // 只在有效月数内循环，不涉及年
    axisState._almanacCalDay = null;
    renderAlmanacPanel();
}
function almSelectDay(day) {
    selectAxisDay(day, renderAlmanacPanel);
}

// ── 生成 ──
async function triggerGenerateAlmanac() {
    if (axisState.isGeneratingAlmanac) return;
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); showToast('请先在设置中填写自定义 API', null, true); return; }
    if (!getContext().chatId) { showToast('请先打开一个聊天', null, true); return; }
    if (loadAlmanac().length) {
        const ok = await spConfirm({
            title: '重新生成节日',
            body: '将按当前世界观重新铺一整年的既定日期。已锁定的条目和你手动添加的日期会保留，未锁定的 AI 条目会被替换。',
            confirmText: '生成', cancelText: '取消',
        });
        if (!ok) return;
    }
    runGenerateAlmanac();
}
async function runGenerateAlmanac() {
    const chatIdSnap = getContext().chatId;
    const myCtrl = axisState.almanacAbortController = new AbortController();
    axisState.isGeneratingAlmanac = true;
    axisState._almGenLabel = '正在编排历法';
    if (axisState.almanacMode) renderAlmanacPanel();
    try {
        const ctx = getContext();
        const userName = ctx.name1 || '用户';
        const charName = ctx.name2 || '角色';
        const cfg = loadCfg();
        const prompt = buildAlmanacPrompt(userName, charName);
        // 抬温 1.05：锚定周年靠记忆撑着不会跑，受益的是次要节日/风味文案更发散、每次不雷同
        const raw = await callCustomApi(ctx, prompt, cfg, userName, charName, myCtrl.signal, 4, { fullMemory: true });
        if (axisState.almanacAbortController !== myCtrl) return;
        if (getContext().chatId !== chatIdSnap) { axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null; return; }
        const aiItems = parseAlmanacWidget(raw);
        if (!aiItems.length) throw new Error('没有解析到有效日期，请重试');
        saveAlmanacItems(mergeAlmanac(loadAlmanac(), aiItems));
        axisState.isGeneratingAlmanac = false;
        axisState.almanacAbortController = null;
        syncLatestAlmanacBlock();   // 历生成 → 楼内七天条即时刷
        if (axisState.almanacMode) { renderAlmanacPanel(); if (getSettings().notifyMode !== 'off') showToast('轴已生成'); }
        else showToast('轴已生成，点击查看', () => { $in('.sp-view-btn[data-view="almanac"]').trigger('click'); showPanel(); });
    } catch (err) {
        if (axisState.almanacAbortController !== myCtrl) return;
        axisState.isGeneratingAlmanac = false;
        axisState.almanacAbortController = null;
        if (err.name === 'AbortError') { if (axisState.almanacMode) renderAlmanacPanel(); return; }
        if (getContext().chatId === chatIdSnap) {
            if (axisState.almanacMode) { renderAlmanacPanel(); showToast('生成失败：' + escapeHtml(err.message || '未知错误'), null, true); }
            else showToast('轴生成失败，请重试', null, true);
        }
    }
}
function buildAlmanacPrompt(userName, charName) {
    const cal = loadCalDesc();
    const monthCount = calMonthCount(cal);
    const yearLen = calYearLen(cal);
    const maxDim = Math.max(...cal.months.map(m => m.days));
    const isGregorian = cal === DEFAULT_CAL;

    // 自定义历法才需要把月份结构讲给 AI；内置公历不赘述（AI 本就按公历走）。
    const calLine = isGregorian
        ? ''
        : `\n**本世界采用自定义历法**：${getCalDescInjectText()}。下面所有日期都要落在这套历法上（按其月份数与每月天数），**不要套用公历的 12 月 / 31 日**。`;

    // 通用节日地板：公历世界**先判地域文化、再铺该地域的真实节日**（别默认中华节庆——美国人不过中秋）；自定义历法改成「贴该历法与设定自编节令」。
    const festivalFloor = isGregorian
        ? `- **先从角色卡 / 世界书 / 场景设定判断这个故事发生在哪个国家 / 地区 / 文化圈**，然后**只铺这个地域真实通行的节日**，逐月覆盖。切忌不看背景就默认套中华节庆——请对号入座，例如：
    · 美国 / 北美：新年、情人节、复活节、独立日(7/4)、万圣节(10/31)、感恩节(11 月第四个周四)、圣诞等
    · 欧洲：新年、情人节、复活节、各国国庆 / 主保日、万圣节、圣诞、跨年等
    · 华语圈（仅当设定确为中华背景才用）：元旦、春节、元宵、清明、端午、七夕、中秋、国庆、圣诞等
    · 日本：正月、成人节、女儿节、黄金周、七夕、盂兰盆、文化日、圣诞、大晦日等
    · 其它地域 / 宗教文化（伊斯兰、印度、拉美等）：按其真实主要节庆同样逐月铺满
  设定含糊、看不出具体地域时，只铺情人节 / 万圣节 / 圣诞 / 新年这类跨文化通用节，别硬塞地域专属节。`
        : `- 这个世界用的是自定义历法，**不要套用公历节日与日期**。请贴合该历法的月份名与世界观设定，自编合理的年度节令（如某月祭典、某位神祇诞辰、丰收节、纪元庆典等），并逐月铺满、别只堆在前几个月。`;

    const tailMonthHint = isGregorian
        ? `下半年（尤其 7 月、10 月、11 月、12 月）同样要有内容。`
        : `越靠后的月份越容易被跳过，务必一路排到第 ${monthCount} 月。`;

    const bigFestCheck = isGregorian
        ? `这个地域 / 文化该有的主要节日是否都逐月铺到了、有没有误把别国节日硬塞进来？`
        : `这套历法里该有的年度节令是否都逐月铺到了？`;

    const gridSection = isGregorian
        ? `【日期与网格】无论世界观如何，每条都必须给一个能排到普通日历上的 month(1-12) 与 day(1-31)：
- 现实节日按其公历日期（农历 / 宗教历 / 阴历节日就近折算到一个公历月日）
- 架空/幻想历法：映射到 1-12 月、1-31 日的格子上，保持先后顺序合理`
        : `【日期与网格】每条都必须给出符合本世界历法的 month（1-${monthCount}）与 day（1 到该月天数、最多 ${maxDim}）：
- 严格按上面列出的历法逐月对应，day 不要超过该月的实际天数
- 保持先后顺序合理，节令尽量分散到不同月份`;

    return `请暂停角色扮演，以世界观设定分析者的身份，为当前故事所处的世界编排**完整一整年（${monthCount} 个月、共 ${yearLen} 天全覆盖）**的「历法·重要日期」。${calLine}
【任务】依据以上角色卡设定、背景、世界书与人物设定，先判断这个世界的**时代与类型**，据此先铺一层该世界的**通用重要日期**：
- 现代 / 近现代：采用现实世界对应文化的节假日
- 古代 / 架空历史：采用该朝代或文化泛化的节庆与要事（元日、上元、寒食、端阳、七夕、中元、重阳，以及围猎、春闱、秋狝、祭天大典等）
- 西幻 / 玄幻 / 赛博 / 科幻等特殊世界观：贴合设定编造合理的节日与纪念日（如某神祇的祭典、双月同辉之夜、建城纪念日、企业年庆等），须与世界观自洽
若设定中能明确推断出 ${userName} 或 ${charName} 的生日，一并列出（type 用 birthday）；不确定的生日不要瞎编，留给用户自填。

【本故事专属日期 · 让日历长在这个故事上｜与通用节日同等重要】
通用节日只是底盘。真正让这份历有灵魂的，是从**上文的「故事记忆库」、角色卡、世界书、人物关系与既有剧情**里挖出**只属于这个故事**的日子——通用模板里绝不会出现、一看就知道属于这个世界 / 这段关系的。数量**随故事长度水涨船高，宁多勿少**：短对话至少 3-5 条，剧情丰富的长故事请挖到 **8 条以上**（一千楼的长文抓出十条八条纪念日都不嫌多，别只留最标志性的两三个就收手）：
- 记忆库线索（若上文提供了「故事记忆库」，**从头到尾通读整条时间线，别只盯最近几段**）：初遇、立约、告白、离别、重逢、生死、胜负、失去、初次同行、并肩作战、背叛与和解、重大抉择、身份揭晓、失而复得、命运转折这类**里程碑**——无论发生在故事早期、中段还是近期，只要记忆库里有明确日期或可推断出时序，都值得挑出来立为**周年纪念**（type 用 anniversary）。**宁可多列几条稍次要的，也别漏掉**，并尽量分散到一年的不同月份，别扎堆
- 关系与人物：${userName} 与 ${charName} 的初遇纪念、结缔 / 同居纪念、某位角色的忌日或人生重要转折日、家族或组织的成立日（type 用 anniversary）
- 世界书里的既定事件：某场战役 / 灾变 / 建城 / 立国 / 传说神迹发生的周年（type 用 anniversary 或 custom）
- 这个世界独有的习俗节令：设定里提到、或可由设定合理推演出的地方性节庆、阵营 / 行业的年度活动（type 用 custom 或 festival）
要求：宁可具体贴脸，不要空泛套话；能从设定或记忆库找到依据的优先。若这是一段全新对话、既没有记忆库也没有足够剧情，就跳过「记忆库」这一路，别硬编。**anniversary 与 custom 两个类型主要就靠这一段用起来，别让它们空着。**

【完整性要求 · 通用节日的地板】和上面的专属日期同等重要，务必做到：
- **必须从第 1 月一路排到第 ${monthCount} 月，逐月检查，绝不能排到头两三个月就停下**。${tailMonthHint}
${festivalFloor}
- 数量不设上限，宁全勿缺；通用节日 + 专属日期加起来，一整年 15 条以上是正常的。**不要因为"够了"就提前收尾**。
- 输出前先自查两遍：① 第 1 到第 ${monthCount} 月每个月是否都被考虑过？${bigFestCheck}② 专属日期够不够——短对话至少 3-5 条，长故事至少 8 条 anniversary/custom（来自记忆库或设定）？记忆库里还有没有没被立成纪念日的里程碑漏网？任一条没达到就补上再输出。

${gridSection}
- displayDate 填该世界观下的**风味日期名**（如"正月十五""星陨月第三日""霜降前夜""两人初遇之日"）；若与"M月D日"无异可留空

【持续天数 days】每条都要给一个 days（放假/持续几天）：
- 单日节日或纪念日：days=1（绝大多数情况）
- 连放多天的长假：给实际天数，且 month/day 填**第一天**。例：春节黄金周 days=7、五一黄金周 days=5、国庆黄金周 days=7；其它世界观里的连日庆典（如三日祭、七日狩猎节）同理。
- 拿不准就填 1。

【说明（每条最后一段）· 这是点/线/大纲乃至主楼 AI 日后展开这个日子的唯一依据，务必写全、写实，别只写一句泛泛套话】
最后一段「说明」要在**同一行内**（严禁换行，可用逗号 / 分号分隔要点）交代清楚：
- 由来与意义：纪念什么、为何重要；
- 涉及的人物 / 阵营：谁的生日 / 忌日 / 纪念，哪些人会参与或格外在意；
- 典型活动 / 习俗：这天通常做什么（祭祀、团聚、赠礼、休战、狩猎、庆典……）；
- 专属日期（anniversary / custom）额外点明它绑定的那段剧情或关系，让读者一看就知道来龙去脉。
宁可信息少写，也不要编造与设定冲突的细节；但至少要让人明白「这天该发生什么、和谁有关、怎么过」。

【输出格式（严格遵守，只输出下面结构，不要任何多余解释）】
<almanac_widget>
Item: 名称|type|month|day|days|displayDate|说明（由来+涉及人物+习俗活动，写全关键信息，单行不换行）
Item: 名称|type|month|day|days|displayDate|说明（同上）
</almanac_widget>
按 month、day 从小到大排列。type 只能是 festival / birthday / anniversary / custom。所有文字用中文（专有名词可保留原文）。`;
}

// ── 增量补录纪念日（不重生成整历，只增补新里程碑）──
// 动机：历原本只能整体「生成节日」重铺；用户想在剧情推进后把**新冒出来的里程碑**增量补进去，
// 又不愿重铺一整年、更不想每件小事都被写成纪念日。故单开一条**高门槛、限量、纯追加去重**的管线：
// 只挖 anniversary/custom 里程碑、把已在账上的排除掉、上限 3 条、宁缺毋滥（可补 0 条）；命中项
// pin=true（与「间→历」应用一致），日后「生成节日」整历重算也冲不掉。绝不走 mergeAlmanac
// （那会清掉未锁 AI 节日），照 applyAlmanacWidget 逐条 almDedupKey 去重后追加、绝不动任何现有条。
function buildAnniversarySupplementPrompt(userName, charName, existingList) {
    const cal = loadCalDesc();
    const monthCount = calMonthCount(cal);
    const maxDim = Math.max(...cal.months.map(m => m.days));
    const isGregorian = cal === DEFAULT_CAL;
    const cap = 3;

    const calLine = isGregorian
        ? ''
        : `\n**本世界采用自定义历法**：${getCalDescInjectText()}。下面所有日期都要落在这套历法上（按其月份数与每月天数），**不要套用公历的 12 月 / 31 日**。`;

    const gridLine = isGregorian
        ? `month 用 1-12、day 用 1-31（架空历法映射到普通日历格子上，保持时序合理）`
        : `month 用 1-${monthCount}、day 用 1 到该月天数（最多 ${maxDim}），严格落在本世界历法上`;

    const already = existingList && existingList.trim()
        ? `【已在历上·请勿重复】以下日期已经在这份历里了，**绝不要再列出来**（即便措辞略有不同、只要指的是同一件事 / 同一天，就算重复，跳过）：\n${existingList}\n`
        : `【历上暂无既有条目】这是一份还很空的历，但本任务**仍只补真正够格的里程碑**，不要借机把普通剧情铺成一堆纪念日。\n`;

    return `请暂停角色扮演，以世界观设定分析者的身份，通读当前故事的完整时间线，为这份**已存在的历**做一次「里程碑纪念日」的**增量补录**。${calLine}

【这是补录，不是重做】历里的节日和既有纪念日都已经铺好了，你**唯一**的任务是：找出剧情推进到现在、**新浮现出来、却还没被立成纪念日**的重大里程碑，把它们补进去。**只补 anniversary / custom 两类里程碑，绝不要再列任何节日 / 生日 / 通用节庆**（那些已经有了）。

${already}
【什么才够格立为纪念日 · 门槛必须高】只挑真正**够分量、值得每年一记**的里程碑——初遇、立约、告白、定情、离别、重逢、生死攸关、重大胜负、身份揭晓、命运转折、失而复得、并肩之战、背叛与和解这类**改变了关系或故事走向**的节点。判断标准：
- **宁缺毋滥，这不是流水账**：一次普通的约会、一顿饭、一句寻常对话、一场无关痛痒的小摩擦、一件当天就翻篇的小事，**统统不够格**，绝不要写成纪念日。够不够格的自问：一年后的这一天，角色真的会想起、会在意吗？答案不是斩钉截铁的「会」，就不要立。
- **必须确有其事**：只从剧情 /【故事记忆库】/ 世界书 / 角色卡里**真实发生过**的事件取材，且能定位到具体或可合理推断的日期。凭空编造的、尚未发生的、只是"可能会怎样"的，一律不要。
- **最多 ${cap} 条**（大多数情况 0-2 条就够）。真没有够格的新里程碑，就**一条都不要写**、直接输出空的 <almanac_widget></almanac_widget>——补录不到东西是完全正常、甚至常见的结果，**绝不能为凑数硬编**。

【日期与网格】每条给出 ${gridLine}；单日纪念 days=1。displayDate 填该世界观下的风味日期名（如"两人初遇之日""断桥重逢日"），与"M月D日"无异则留空。

【说明（每条最后一段·单行不换行）】交代：纪念的是哪段剧情 / 哪个节点、涉及谁、为何值得每年一记，让人一看就知道来龙去脉。

【输出格式（严格遵守，只输出下面结构；没有够格的就输出空 widget，不要任何多余解释）】
<almanac_widget>
Item: 名称|type|month|day|days|displayDate|说明（单行不换行）
</almanac_widget>
type 只能是 anniversary 或 custom。所有文字用中文（专有名词可保留原文）。`;
}

// 跑补录：照 runGenerateAlmanac 的骨架（共用 isGeneratingAlmanac / almanacAbortController 互斥同一 store），
// 但合并阶段走**纯追加去重**（非 mergeAlmanac）+ pin=true，且补 0 条时给出「没有够格」的正常态提示、不报错。
async function runSupplementAnniversary() {
    const chatIdSnap = getContext().chatId;
    const myCtrl = axisState.almanacAbortController = new AbortController();
    axisState.isGeneratingAlmanac = true;
    axisState._almGenLabel = '正在通读全程·补录纪念日';
    if (axisState.almanacMode) renderAlmanacPanel();
    try {
        const ctx = getContext();
        const userName = ctx.name1 || '用户';
        const charName = ctx.name2 || '角色';
        const cfg = loadCfg();
        // 已在账上的日期清单（含全部类型），喂给提示词排除，防它重复列已有条
        const existingList = loadAlmanac().map(it => `- ${it.name}（${almDateLabel(it)}）`).join('\n');
        const prompt = buildAnniversarySupplementPrompt(userName, charName, existingList);
        const raw = await callCustomApi(ctx, prompt, cfg, userName, charName, myCtrl.signal, 4, { fullMemory: true });
        if (axisState.almanacAbortController !== myCtrl) return;
        if (getContext().chatId !== chatIdSnap) { axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null; return; }
        const aiItems = parseAlmanacWidget(raw);
        // 纯追加去重（照 applyAlmanacWidget）：重新取一次现表避开生成期间被别处改，
        // 逐条按 almDedupKey 去重、命中的补录项 pin=true 防日后整历重算冲掉，绝不 mergeAlmanac。
        const base = loadAlmanac();
        const seen = new Set(base.map(almDedupKey));
        const added = [];
        for (const it of aiItems) {
            const k = almDedupKey(it);
            if (seen.has(k)) continue;
            seen.add(k);
            it.pin = true;
            added.push(it);
        }
        axisState.isGeneratingAlmanac = false;
        axisState.almanacAbortController = null;
        if (added.length) { saveAlmanacItems([...base, ...added]); syncLatestAlmanacBlock(); }
        if (axisState.almanacMode) renderAlmanacPanel();
        if (added.length) {
            showToast(`已补录 ${added.length} 条纪念日`);
        } else if (getSettings().notifyMode !== 'off') {
            showToast('通读全程后没有够格补录的新里程碑（这很正常）');
        }
    } catch (err) {
        if (axisState.almanacAbortController !== myCtrl) return;
        axisState.isGeneratingAlmanac = false;
        axisState.almanacAbortController = null;
        if (err.name === 'AbortError') { if (axisState.almanacMode) renderAlmanacPanel(); return; }
        if (getContext().chatId === chatIdSnap) {
            if (axisState.almanacMode) { renderAlmanacPanel(); showToast('补录失败：' + escapeHtml(err.message || '未知错误'), null, true); }
            else showToast('补录纪念日失败，请重试', null, true);
        }
    }
}

// 补录纪念日是**纯追加、不动任何现有条** → 无需「生成节日」那种破坏性重铺确认，校验齐 API/chat 即直接跑。
async function triggerSupplementAnniversary() {
    if (axisState.isGeneratingAlmanac) return;
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); showToast('请先在设置中填写自定义 API', null, true); return; }
    if (!getContext().chatId) { showToast('请先打开一个聊天', null, true); return; }
    runSupplementAnniversary();
}

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
    const { id, prefill } = axisState._almanacEditor;
    const cal = loadCalDesc();
    const maxDim = Math.max(...cal.months.map(x => x.days));
    const editing = id ? loadAlmanac().find(it => it.id === id) : null;
    const it = editing || {
        name: '', type: 'custom',
        month: prefill?.month || (almCalMonth() + 1),
        day: prefill?.day || (prefill ? 1 : almTodayAnchor().day),
        days: 1,
        displayDate: '', note: '', pin: true, source: 'user',
    };
    const typeOpts = ALM_TYPES.map(t => `<option value="${t}"${it.type === t ? ' selected' : ''}>${almTypeMeta(t).label}</option>`).join('');
    return `<div class="sp-alm-editor-head">
        <button class="sp-icon-btn sp-alm-editor-back" title="返回"><i class="fa-solid fa-arrow-left"></i></button>
        <span class="sp-alm-editor-title">${editing ? '编辑日期' : '添加日期'}</span>
    </div>
    <div class="sp-alm-body">
        <div class="sp-alm-editor-body">
            <label class="sp-alm-field"><span>名称</span><input type="text" id="sp-alm-f-name" maxlength="40" placeholder="如 元宵节 / 阿露的生日" value="${escapeAttr(it.name)}"></label>
            <label class="sp-alm-field"><span>类型</span><select id="sp-alm-f-type">${typeOpts}</select></label>
            <div class="sp-alm-field-row">
                <label class="sp-alm-field sp-alm-field-sm"><span>月</span><input type="number" id="sp-alm-f-month" min="1" max="${calMonthCount(cal)}" value="${it.month}"></label>
                <label class="sp-alm-field sp-alm-field-sm"><span>日</span><input type="number" id="sp-alm-f-day" min="1" max="${maxDim}" value="${it.day}"></label>
                <label class="sp-alm-field sp-alm-field-sm"><span>天数</span><input type="number" id="sp-alm-f-days" min="1" max="${calYearLen(cal)}" value="${it.days || 1}"></label>
            </div>
            <div class="sp-alm-wd-hint" id="sp-alm-f-wdhint"></div>
            <label class="sp-alm-field"><span>风味日期 <small>选填，如"正月十五"</small></span><input type="text" id="sp-alm-f-disp" maxlength="40" placeholder="留空则显示 M月D日" value="${escapeAttr(it.displayDate)}"></label>
            <label class="sp-alm-field"><span>说明 <small>选填</small></span><textarea id="sp-alm-f-note" rows="2" maxlength="200" placeholder="这个日子的意义 / 习俗">${escapeHtml(it.note)}</textarea></label>
        </div>
        <div class="sp-alm-editor-actions">
            <button class="sp-mini-btn sp-alm-editor-cancel">取消</button>
            <button class="sp-gen-btn sp-alm-editor-save">保存</button>
        </div>
    </div>`;
}
// 编辑器里月/日/天数变动时，实时刷新只读周几提示（纯提示，不入库）。
function almRenderWdHint() {
    const $h = $in('#sp-alm-f-wdhint');
    if (!$h.length) return;
    const cal = loadCalDesc();
    const month = almClampInt($in('#sp-alm-f-month').val(), 1, calMonthCount(cal), 1);
    const day = almClampInt($in('#sp-alm-f-day').val(), 1, calMonthDays(cal, month), 1);
    const days = almClampInt($in('#sp-alm-f-days').val(), 1, calYearLen(cal), 1);
    const ref = almWeekdayRef(cal);
    const wd = ALM_WEEKDAYS[almWeekdayFor(month, day, ref, cal)];
    if (days > 1) {
        const e = almEndMonthDay({ month, day, days }, cal);
        const ewd = ALM_WEEKDAYS[almWeekdayFor(e.month, e.day, ref, cal)];
        $h.text(`${calMonthName(cal, month)}${day}日 ${wd} · 共 ${days} 天，至 ${calMonthName(cal, e.month)}${e.day}日 ${ewd}`);
    } else {
        $h.text(`${calMonthName(cal, month)}${day}日 · ${wd}`);
    }
}
function saveAlmanacEditor() {
    if (!axisState._almanacEditor) return;
    const name = String($in('#sp-alm-f-name').val() || '').trim();
    if (!name) { showToast('请填写名称', null, true); $in('#sp-alm-f-name').trigger('focus'); return; }
    const editing = axisState._almanacEditor.id ? loadAlmanac().find(x => x.id === axisState._almanacEditor.id) : null;
    const rec = normalizeAlmItem({
        id: editing ? editing.id : almId(),
        name,
        type: $in('#sp-alm-f-type').val(),
        month: $in('#sp-alm-f-month').val(),
        day: $in('#sp-alm-f-day').val(),
        days: $in('#sp-alm-f-days').val(),
        displayDate: $in('#sp-alm-f-disp').val(),
        note: $in('#sp-alm-f-note').val(),
        pin: editing ? editing.pin : true,       // 自填默认自动锁定（用户最看重，别被生成冲掉）
        source: editing ? editing.source : 'user',
    });
    const list = loadAlmanac();
    if (editing) {
        const idx = list.findIndex(x => x.id === editing.id);
        if (idx >= 0) list[idx] = rec; else list.push(rec);
    } else {
        list.push(rec);
    }
    saveAlmanacItems(list);
    closeAlmanacEditor();
    syncLatestAlmanacBlock();   // 历改动 → 楼内七天条即时刷
}

function toggleAlmanacPin(id) {
    const list = loadAlmanac();
    const it = list.find(x => x.id === id);
    if (!it) return;
    it.pin = !it.pin;
    saveAlmanacItems(list);
    // 就地更新该行（锁不改排序），不整面重渲 → 不会把滚动/视觉焦点弹回页头
    if (axisState.almanacMode) {
        const $rows = $in(`#sp-almanac-wrap .sp-alm-item[data-id="${id}"]`);
        $rows.toggleClass('sp-alm-pinned', it.pin);
        $rows.find('.sp-alm-pin')
            .attr('title', it.pin ? '已锁定 · 生成时保留（点击解锁）' : '锁定 · 生成时保留')
            .find('i').attr('class', `fa-solid ${it.pin ? 'fa-lock' : 'fa-lock-open'}`);
    }
    showToast(it.pin ? '已锁定 · 生成时保留' : '已解锁');
}
// 日历详情↔网格联动：把某条目在当前月覆盖到的日子高亮到上方网格（直接改 class，不重渲）。
function almHiliteCells(it) {
    almClearHilite();
    if (!it) return;
    const cal = loadCalDesc();
    const month1 = almCalMonth() + 1;
    const days = almClampInt(it.days, 1, calYearLen(cal), 1);
    const startDoy = almDayOfYear(it.month, it.day, cal);
    for (let k = 0; k < days; k++) {
        const md = almMonthDayFromDoy(startDoy + k, cal);
        if (md.month === month1) $in(`#sp-almanac-wrap .sp-alm-cell[data-day="${md.day}"]`).addClass('sp-alm-cell-linked');
    }
}
function almClearHilite() {
    $inAll('#sp-almanac-wrap .sp-alm-cell-linked').removeClass('sp-alm-cell-linked');
}
async function deleteAlmanacItem(id) {
    const list = loadAlmanac();
    const it = list.find(x => x.id === id);
    if (!it) return;
    const ok = await spConfirm({ title: '删除日期', body: `确定删除「${it.name}」？`, confirmText: '删除', cancelText: '取消' });
    if (!ok) return;
    saveAlmanacItems(list.filter(x => x.id !== id));
    if (axisState.almanacMode) renderAlmanacPanel();
    syncLatestAlmanacBlock();   // 删条目 → 楼内七天条即时刷
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
        if (data?.error) throw new Error(data.error.message || '返回错误');
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
        showToast(`获取模型失败：${err.message}`, null, true);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-list"></i>');
    }
}

function toggleSettings() {
    settingsOpen = !settingsOpen;
    const $overlay = $in('#sp-settings-overlay');
    if (settingsOpen) {
        renderWiList();     // async, fire-and-forget — fills list when done
        renderWiExcludeList();   // 全局排除清单（async fire-and-forget；冷缓存会强刷世界书全表）
        renderScaleRow();   // per-character scale radios (sync)
        renderMemorySection();   // memory status + settings sync
        renderTheaterSection();  // 棱 settings + cache usage + template manager
        renderStorageUsage();    // 存储管理面板：四层用量统计（含坐标收藏占用）
        $overlay.stop(true).css({ display: 'flex', opacity: 0 }).animate({ opacity: 1 }, 180);
    } else {
        $overlay.stop(true).animate({ opacity: 0 }, 150, function () { $(this).css('display', 'none'); });
        stSaveSettings();   // 关面板即把面板内所有改动立即写盘：兜底防抖未 flush 的字段（customPrompt 等），根治重启丢失
    }
    $in('.sp-settings-btn').toggleClass('sp-btn-active', settingsOpen);
    syncMobileViewport();
}

// ─── Memory section renderer + handlers ─────────────────────────────────────
function renderMemorySection() {
    const s = getSettings();
    const useBbb   = !!s.useBaiBaiBook;
    const useAnima = !!s.useAnima;
    const useDatabase = !!s.useDatabase;
    $in('#sp-mem-source-bbb').prop('checked', useBbb);
    $in('#sp-mem-source-anima').prop('checked', useAnima);
    $in('#sp-mem-source-database').prop('checked', useDatabase);
    $in('#sp-mem-anima-options').toggle(useAnima || useDatabase);
    $in('#sp-mem-anima-recall').val(getAnimaRecallCount());
    // 自定义提示词是全局设置、与记忆源无关，必须在下面按源分支的 early-return 之前回填，
    // 否则用户选 Anima/柏宝书时函数提前 return，重开面板这框会空白（值其实已存盘）。
    $in('#sp-custom-prompt').val(typeof s.customPrompt === 'string' ? s.customPrompt : '');
    $in('#sp-storyclock-prompt').val(typeof s.storyClockPrompt === 'string' ? s.storyClockPrompt : '');
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
        $in('#sp-mem-internal').hide();
        $in('#sp-mem-bbb-status, #sp-mem-anima-status').hide();
        $in('#sp-mem-database-status').show().html('<i class="fa-solid fa-circle-info"></i> 正在读取数据库纪要…');
        getDatabaseMemText().then(text => {
            if (!getSettings().useDatabase) return;
            $in('#sp-mem-database-status').html(text
                ? `<i class="fa-solid fa-circle-check" style="color:var(--cardhub-accent,#7c9)"></i> 数据库记忆已就绪（读到 ${text.split(/\n\n/).length} 条纪要）`
                : '<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> 未识别到数据库纪要');
        }).catch(() => $in('#sp-mem-database-status').text('数据库读取失败'));
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
    $in('#sp-mem-maxtokens').val(Number.isFinite(+s.memMaxTokens) ? +s.memMaxTokens : 60000);
    $in('#sp-mem-keeptags').val(typeof s.keepTags  === 'string' ? s.keepTags  : 'content');
    $in('#sp-mem-extratags').val(typeof s.extraTags === 'string' ? s.extraTags : '');
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
    refreshTheaterTemplates();   // async, fills #sp-theater-tpl-mgr when done
}

// 棱设置分节的事件（config 字段即改即存；模板 CRUD。缓存治理已移交存储管理面板）
function bindTheaterHandlers() {
    $in('#sp-theater-style').on('change', function () {
        getSettings().theaterStylePrompt = this.value;
        saveSettingsDebounced();
    });

    // 模板写入口（委托到管理器容器，内容动态渲染）。查看/改/删交给酒馆世界书编辑器。
    const $mgr = $in('#sp-theater-tpl-mgr');
    $mgr.on('click', '#sp-theater-tpl-add', async function () {
        const title = String($in('#sp-theater-tpl-new-title').val() || '').trim();
        const text  = String($in('#sp-theater-tpl-new-text').val() || '').trim();
        if (!title && !text) { showToast('模板标题或内容不能都为空', null, true); return; }
        try {
            await theater.addTemplate(title || '(无标题)', text);
            $in('#sp-theater-tpl-new-title').val('');
            $in('#sp-theater-tpl-new-text').val('');
            await refreshTheaterTemplates();  // 重渲染 → 计数 +1
            showToast('模板已新增');
        } catch (err) { showToast('新增失败：' + (err.message || err), null, true); }
    });
    // 批量导入 txt：点按钮 → 触发隐藏 file input → 读文本 → 解析 → addTemplatesBatch 一次入库
    $mgr.on('click', '#sp-theater-tpl-import', function () {
        $in('#sp-theater-tpl-import-file').trigger('click');
    });
    $mgr.on('change', '#sp-theater-tpl-import-file', async function () {
        const file = this.files && this.files[0];
        this.value = '';                       // 允许连选同一文件重导
        if (!file) return;
        try {
            const raw = await file.text();
            const items = parseTheaterImport(raw);
            if (!items.length) { showToast('未解析到模板，请检查 txt 格式（需 title：起头）', null, true); return; }
            const n = await theater.addTemplatesBatch(items);
            await refreshTheaterTemplates();
            showToast(`已导入 ${n} 条模板`);
        } catch (err) { showToast('导入失败：' + (err.message || err), null, true); }
    });
}

function bindMemoryHandlers() {
    $in('#sp-mem-source-bbb').on('change', function () {
        const s = getSettings();
        s.useBaiBaiBook = this.checked;
        if (this.checked) { s.useAnima = false; s.useDatabase = false; }   // 记忆源互斥
        saveSettingsDebounced();
        if (this.checked) memory.abortRebuild();
        renderMemorySection();
    });
    $in('#sp-mem-source-anima').on('change', function () {
        const s = getSettings();
        s.useAnima = this.checked;
        if (this.checked) { s.useBaiBaiBook = false; s.useDatabase = false; }   // 记忆源互斥
        saveSettingsDebounced();
        if (this.checked) memory.abortRebuild();
        renderMemorySection();
    });
    $in('#sp-mem-source-database').on('change', function () {
        const s = getSettings();
        s.useDatabase = this.checked;
        if (this.checked) { s.useBaiBaiBook = false; s.useAnima = false; }
        saveSettingsDebounced();
        if (this.checked) memory.abortRebuild();
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
    $in('#sp-mem-maxtokens').on('change', function () {
        // 0 = 不限；否则给个下限防手滑填极小值把记忆压没（1000 tk 起）
        let v = parseInt(this.value, 10);
        if (!Number.isFinite(v) || v < 0) v = 60000;
        if (v > 0 && v < 1000) v = 1000;
        getSettings().memMaxTokens = v;
        this.value = v;
        saveSettingsDebounced();
    });
    // Tag sanitizer inputs — sanitize (bare tag names, comma-separated), save.
    // Applies to future reads; existing L0 summaries built with old rules keep
    // their hash and stay valid — new content read after change uses new rules.
    // input=即打即存（存 sanitize 值但不回写 value，免光标跳）；change=失焦时规范化回写显示。
    // 关键：只用 change 会在「输入框还没失焦就点保存/关面板」时丢掉那次编辑（表现为“动了 API，标签/提示词被重置”）。
    function sanitizeTagList(raw) {
        return String(raw || '')
            .split(',')
            .map(s => s.trim().replace(/^<|>$/g, '').replace(/\/$/, ''))  // tolerate '<content>' or 'content/'
            .filter(s => /^[\p{L}][\p{L}\p{N}_-]*$/u.test(s))
            .join(',');
    }
    function bindTagField(sel, key) {
        // sel 是 #sp-mem-* 选择器串（设置区在 shadow 内，同 11820 的 $in 读取）→ 必须 $in 绑定，否则不落存
        $in(sel).on('input', function () {
            getSettings()[key] = sanitizeTagList(this.value);
            saveSettingsDebounced();
        }).on('change', function () {
            const v = sanitizeTagList(this.value);
            getSettings()[key] = v;
            this.value = v;                 // 失焦才回写，避免打字途中光标跳到末尾
            saveSettingsDebounced();
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
        saveSettingsDebounced();
        try { refreshStoryClockInjection(); } catch {}
    }).on('blur', function () {
        getSettings().storyClockPrompt = this.value;
        stSaveSettings();
    });
    $in('#sp-storyclock-prompt-load').on('click', function () {
        $in('#sp-storyclock-prompt').val(_DEFAULT_STORY_CLOCK_PROMPT);
        getSettings().storyClockPrompt = _DEFAULT_STORY_CLOCK_PROMPT;
        stSaveSettings();
        try { refreshStoryClockInjection(); } catch {}
        try { showToast('已把默认强制词载入编辑框，可直接修改'); } catch {}
    });
    // 恢复默认＝清空＝回到内置 live 默认（继续跟随插件更新），区别于「载入默认再改」的冻结快照。
    $in('#sp-storyclock-prompt-reset').on('click', function () {
        $in('#sp-storyclock-prompt').val('');
        getSettings().storyClockPrompt = '';
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
            showToast('补齐失败：' + err.message, null, true);
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
            showToast('重构失败：' + err.message, null, true);
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

// Render world-info entry checklist for the current character into #sp-wi-list.
// Perf: builds one HTML string + inserts once, uses event delegation on the list root.
let _wiEntryCache = new Map();   // key → entry object, for eye-button popup lookup

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
        $list.html(`<span class="sp-cfg-hint">加载失败：${escapeHtml(err.message || '未知错误')}</span>`);
        return;
    }

    // Cache entries for the eye-button popup
    _wiEntryCache = new Map(entries.map(e => [e.key, e]));

    const charKey = charStableKey(ctx);
    const disabledKeys = getDisabledKeys(charKey);

    // Two-level group: scope (char / persona / global) → source (book name) → entries.
    // Preserves entry order within each source; char first, then persona, then global.
    const scopes = new Map([['char', new Map()], ['persona', new Map()], ['global', new Map()]]);
    for (const e of entries) {
        const scopeGroup = scopes.get(e.scope) || scopes.get('char');
        if (!scopeGroup.has(e.source)) scopeGroup.set(e.source, []);
        scopeGroup.get(e.source).push(e);
    }
    const SCOPE_LABELS = { char: '角色卡世界书', persona: '用户世界书', global: '全局世界书' };

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
            const groupChecked = group.filter(e => !disabledKeys.has(e.key)).length;
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
                const checked = !disabledKeys.has(e.key);
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
    }).on('keydown.wi', '.sp-wi-card', function (ev) {
        if (ev.key !== ' ' && ev.key !== 'Enter') return;
        ev.preventDefault();
        const $card = $(this);
        const $cb   = $card.find('.sp-wi-cb');
        $cb.prop('checked', !$cb.prop('checked'));
        $card.toggleClass('sp-wi-card-off', !$cb.prop('checked'));
        syncWiSelectAll();
    }).on('change.wi', '#sp-wi-select-all', function () {
        const checked = this.checked;
        $list.find('.sp-wi-cb').prop('checked', checked);
        $list.find('.sp-wi-card').toggleClass('sp-wi-card-off', !checked);
        $list.find('.sp-wi-group-cb').prop({ checked, indeterminate: false });
    }).on('change.wi', '.sp-wi-group-cb', function (ev) {
        // Per-book select-all — flip every entry in this <details> group
        ev.stopPropagation();
        const $group = $(this).closest('.sp-wi-group');
        const checked = this.checked;
        $group.find('.sp-wi-cb').prop('checked', checked);
        $group.find('.sp-wi-card').toggleClass('sp-wi-card-off', !checked);
        this.indeterminate = false;
        syncWiSelectAll();
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
    return {
        url          : $in('#sp-cfg-url').val().trim().replace(/\/$/, ''),
        key          : ($k.data('real') || $k.val() || '').trim(),
        model        : $in('#sp-cfg-model').val().trim(),
        excludeParams: parseExcludeParams($in('#sp-cfg-exclude').val()),
        timeoutSec   : parseInt($in('#sp-cfg-timeout').val(), 10) || 180,
        stream       : $in('#sp-cfg-stream').is(':checked'),
    };
}

// 把一套预设填回输入框（不生效，等用户点保存）。Key 走 maskKey 遮罩 + data('real') 存真值。
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
        ? list.map(p => `<div class="sp-preset-item-row" data-id="${escapeAttr(p.id)}"><button type="button" class="sp-preset-item${p.id === activeId ? ' sp-preset-item-active' : ''}" data-id="${escapeAttr(p.id)}">${escapeHtml(p.name)}</button><button type="button" class="sp-preset-rename" data-id="${escapeAttr(p.id)}" title="编辑这条预设（名字 / 模型）"><i class="fa-solid fa-pen"></i></button></div>`).join('')
        : `<div class="sp-preset-empty">暂无预设，填好 API 后点右侧＋存一个</div>`);
    $in('#sp-preset-del').prop('disabled', !activeId);
    syncPresetLabel();
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

function bindApiPresetEvents() {
    // 点假框 → 就地展开/收起内联预设列表（在流内，非原生弹窗）
    $in('#sp-preset-box').on('click', function (e) {
        e.preventDefault();
        $in('#sp-preset-list').slideToggle(120);
        $(this).toggleClass('sp-preset-box-open');
    });
    // 选某预设 → 填入输入框（提示仍需点保存生效），收起列表
    $in('#sp-preset-list').on('click', '.sp-preset-item', function () {
        const id = $(this).attr('data-id');
        getSettings().apiPresetActiveId = id;
        const p = loadApiPresets().find(x => x.id === id);
        renderApiPresetList();
        $in('#sp-preset-list').slideUp(120);
        $in('#sp-preset-box').removeClass('sp-preset-box-open');
        if (!p) return;
        fillApiInputs(p);
        showPresetHint(`已填入「${p.name}」，点下方「保存」生效`);
    });

    // 编辑一条预设（内联，无弹窗）：点 ✎ → 顺手把这条填进输入框并选中它，名字就地变输入框。
    // 用户可改名，或去下方模型栏换模型（输入框已是这条，换模型只动这条）。Enter / ✓ 提交，Esc 取消。
    // 提交 = 把「名字 + 当前输入框整套(含模型)」写回这条预设；走 upsertApiPreset，**不碰生效配置**（脱钩）。
    const commitPresetEdit = ($row) => {
        const $inp = $row.find('.sp-preset-rename-input');
        if (!$inp.length) return;
        const id = $row.attr('data-id');
        const p = loadApiPresets().find(x => x.id === id);
        const name = $inp.val().trim() || (p ? p.name : '');
        upsertApiPreset(name, readApiInputs(), id);   // 名字+模型(整套)写回这条；不动 s.apiModel 等生效配置
        renderApiPresetList();       // 回到按钮态（名字/模型已更新）
        renderUtilityPresetList();   // 机械预设列表同名同步
        showPresetHint(`已更新预设「${name}」（名字 / 模型）`);
    };
    $in('#sp-preset-list').on('click', '.sp-preset-rename', function (e) {
        e.preventDefault(); e.stopPropagation();
        const id = $(this).attr('data-id');
        const p = loadApiPresets().find(x => x.id === id);
        if (!p) return;
        getSettings().apiPresetActiveId = id;   // 进编辑=顺手选中这条
        fillApiInputs(p);                        // 把这条填进输入框，保证「去下方模型栏换模型」只动这条
        syncPresetLabel();
        const $row = $(this).closest('.sp-preset-item-row');
        $row.addClass('sp-preset-item-row-edit').html(
            `<input type="text" class="sp-input sp-preset-rename-input" value="${escapeAttr(p.name)}" maxlength="40" spellcheck="false">` +
            `<button type="button" class="sp-preset-rename-ok" title="保存到这条预设（名字 / 模型）"><i class="fa-solid fa-check"></i></button>`
        );
        $row.find('.sp-preset-rename-input').trigger('focus').trigger('select');
        showPresetHint(`编辑「${p.name}」：可改名，或去下方模型栏换模型，改完点 ✓ 存回这条`);
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
        const cur = readApiInputs();
        if (!cur.url && !cur.key) { showPresetHint('先填 API 再点新增'); return; }
        const name = autoPresetName(cur.url);
        upsertApiPreset(name, cur, null);   // 内部已把 apiPresetActiveId 设为新 id
        renderApiPresetList();
        renderUtilityPresetList();          // 新预设也进机械分流候选
        showPresetHint(`已存为预设「${name}」，点它右侧 ✎ 可改名`);
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

function saveSettings() {
    const $k = $in('#sp-cfg-key'), key = ($k.data('real') || $k.val()).trim();
    saveCfg({
        url          : $in('#sp-cfg-url').val().trim().replace(/\/$/, ''),
        key,
        model        : $in('#sp-cfg-model').val().trim(),
        excludeParams: parseExcludeParams($in('#sp-cfg-exclude').val()),
        timeoutSec   : parseInt($in('#sp-cfg-timeout').val(), 10),
        stream       : $in('#sp-cfg-stream').is(':checked'),
    });
    saveLinesInterval($in('#sp-lines-interval').val());
    saveLinesMode($in('input[name="sp-lines-mode"]:checked').val());
    // Save world-info entry filter and narrative scale for current character
    const ctx = getContext();
    const charKey = charStableKey(ctx);
    if (charKey) {
        const disabled = new Set();
        $inAll('#sp-wi-list .sp-wi-cb').each(function () {
            if (!this.checked) disabled.add($(this).data('key'));
        });
        setDisabledKeys(charKey, disabled);
        const scaleVal = $in('input[name="sp-lines-scale"]:checked').val() || 'auto';
        setScale(charKey, scaleVal);
    }
    $k.data('real', key).val(maskKey(key)).attr('type', 'password');
    const $m = $in('#sp-cfg-msg'); $m.text('已保存 ✓'); setTimeout(() => $m.text(''), 2000);
    const hasApi = !!(loadCfg().url && loadCfg().key);
    $in('#sp-settings-overlay .sp-api-notice')
        .removeClass('sp-notice-ok sp-notice-warn')
        .addClass(hasApi ? 'sp-notice-ok' : 'sp-notice-warn')
        .html(`<i class="fa-solid ${hasApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            ${hasApi ? '已配置独立 API，后台生成不影响聊天'
                     : '未配置独立 API：生成期间将<b>占用聊天通道</b>'}`);
    setTimeout(() => { if (settingsOpen) toggleSettings(); }, 400);
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
    // 坐标全屏快照的字/底色是按 currentTheme 烘死内联进嵌套 shadow 的（renderAnchorFull），变量级
    // 换类救不到；正看全文快照时重渲一次让它跟主题（覆盖手动切主题 + ST 自动跟随两条路径）。
    if (_anchorView.level === 'full' && _anchorCurrentItem) renderAnchorFull(_anchorCurrentItem.id);
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

    sheet.style.top = `${top}px`;
    sheet.style.height = `${maxH}px`;
    sheet.style.maxHeight = `${maxH}px`;
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

// ─── Rendering ────────────────────────────────────────────────────────────────

// 手动锁/解一个点（对齐 triggerToggleLinePin）：解析 raw → 翻转该事件 pin → 重序列化写回
// raw → 原地重渲染（不重算）。pin 就活在 raw 里，无旁挂结构。
function restorePointActiveDay(dayKey) {
    const $tabs = $inAll('#sp-body .sp-tab');
    if (!$tabs?.length) return;
    let found = false;
    $tabs.each((_, el) => {
        const $tab = $(el);
        const match = String($tab.attr('data-day')) === String(dayKey);
        $tab.toggleClass('sp-tab-active', match);
        if (match) { $tab.trigger('click'); found = true; }
    });
    if (!found) $tabs.eq(0).trigger('click');
}

function triggerTogglePointPin(dayKey, evIdx) {
    const key = getCacheKey();
    const saved = readStore(key);
    const raw = saved?.raw || '';
    if (!raw) { showToast('待办已失效，请刷新面板', null, true); return; }
    const parsed = parseCalendar(raw);
    const ev = dayKey === 'future'
        ? (parsed.future?.events?.[evIdx] || null)
        : (parsed.days?.[Number(dayKey)]?.events?.[evIdx] || null);
    if (!ev || !ev.title || !ev.title.trim()) { showToast('这个点已不存在，请刷新面板', null, true); return; }
    ev.pin = !ev.pin;
    const newRaw = serializeCalendar(parsed.days, parsed.future, parsed.startDate);
    writeStore(key, { raw: newRaw, userName: saved.userName || '用户', ts: Date.now() });
    const html = renderSchedule(newRaw, saved.userName || '用户', currentView);
    pointState.cachedSchedule = html;
    setBody(html);
    restorePointActiveDay(dayKey);
    syncLatestScheduleBlock();   // 锁/解点 → 楼内日程条锁标即时刷
    showToast(ev.pin ? '已锁定这个点' : '已解锁这个点');
}

// 删除单个点（楼内抽屉专用，对齐线的 triggerDeleteOneLine）：确认 → 从解析结果里 splice
// 掉该事件 → 重序列化写回 raw → 原地重渲染 + 刷楼内条。pin 活在 raw 里，删除即连带清掉。
async function triggerDeletePointEvent(dayKey, evIdx) {
    const key = getCacheKey();
    const saved = readStore(key);
    const raw = saved?.raw || '';
    if (!raw) { showToast('待办已失效，请刷新面板', null, true); return; }
    const parsed = parseCalendar(raw);
    const arr = dayKey === 'future'
        ? (parsed.future?.events || null)
        : (parsed.days?.[Number(dayKey)]?.events || null);
    const ev = arr?.[evIdx] || null;
    if (!ev) { showToast('这个点已不存在，请刷新面板', null, true); return; }
    const ok = await spConfirm({
        title: '删除这个点',
        body : `将删除「${ev.title || '未命名'}」这一条，其它安排保留。此操作不可撤销。`,
        confirmText: '删除',
        cancelText : '取消',
    });
    if (!ok) return;
    arr.splice(evIdx, 1);
    const newRaw = serializeCalendar(parsed.days, parsed.future, parsed.startDate);
    writeStore(key, { raw: newRaw, userName: saved.userName || '用户', ts: Date.now() });
    const html = renderSchedule(newRaw, saved.userName || '用户', currentView);
    pointState.cachedSchedule = html;
    setBody(html);
    restorePointActiveDay(dayKey);
    syncLatestScheduleBlock();
    showToast('已删除这个点');
}

// 聊天输入框随内容自增高：先归零再按 scrollHeight 撑，CSS 用 max-height 封顶后转滚动条。
// 清空发送后也调一次即可缩回单行。
