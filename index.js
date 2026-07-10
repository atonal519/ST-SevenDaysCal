import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt, eventSource, event_types, substituteParams, saveSettingsDebounced } from '../../../../script.js';
import {
    buildCreativeChatHistoryKey,
    buildCreativeChatSystemPrompt,
    buildOutlineCacheKey as buildOutlineScopedCacheKey,
    buildScheduleCacheKey,
    buildStorylinesCacheKey as buildLinesScopedCacheKey,
    getCreativeChatPlaceholder,
} from './state.js';

const PLUGIN_ID  = 'schedule-planner';
const MODAL_ID   = 'sp-modal-root';
const FAB_ID     = 'sp-fab';
const POS_KEY    = 'sp-pos';
const SIZE_KEY    = 'sp-size';

// Default plugin settings (stored in ST's settings.json via extension_settings)
const DEFAULT_SETTINGS = {
    apiUrl  : '',
    apiKey  : '',
    apiModel: '',
    fabShow : true,
    linesInterval: 2,
    linesMode: 'turns',  // 'turns' | 'days'
};

let lastDebugPayload = null;

// view: 'user' | 'char'   charName: confirmed char name
function getCacheKey(view, charName) {
    const chatId = getContext().chatId;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    return buildScheduleCacheKey(chatId, v, c);
}

function loadCachedForCurrentChat(view, charName) {
    const key = getCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderSchedule(saved.raw, saved.userName || '用户', view ?? currentView);
    } catch { /* ignore corrupt cache */ }
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

let currentTheme   = detectSTTheme();
let cachedSchedule = null;
let isGenerating   = false;
let settingsOpen   = false;
let dragState      = null;
let resizeState    = null;
let resizeRAF      = null;
let fabDragged     = false;
let fabDragState   = null;
let currentView        = 'user';  // 'user' | 'char'
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
let linesAiMsgCounter   = 0;   // counts AI messages since last lines advancement
let scheduleAbortController = null;
let outlineAbortController  = null;
const _injectTexts      = {};
let   _injectIdSeq      = 0;
let viewportSyncBound   = false;

const isMobile = () => window.innerWidth <= 640;

// ─── Init ─────────────────────────────────────────────────────────────────────

jQuery(async () => {
    injectExtButton();
    injectModal();
    injectFab();
    injectToastContainer();
    // Back-fill inline blocks for any messages already rendered at startup
    setTimeout(backfillLinesInlineBlocks, 800);
    // Reset view state and reload cache on chat switch
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentView  = 'user';
        charViewName = null;
        outlineMode  = false;
        cachedOutline = null;
        outlineChatHistory = [];
        linesMode    = false;
        cachedLines  = null;
        linesAiMsgCounter = 0;
        lastDetectedDay   = null;
        $('.sp-view-btn').removeClass('sp-view-active');
        $(`.sp-view-btn[data-view="user"]`).addClass('sp-view-active');
        cachedSchedule = loadCachedForCurrentChat();
        if ($(`#${MODAL_ID}`).is(':visible') && !isGenerating) {
            $('#sp-outline-wrap').hide();
            $('#sp-lines-wrap').hide();
            $('#sp-body').show();
            $(`#${MODAL_ID} .sp-outline-btn`).removeClass('sp-btn-active');
            updateCreativeChatModeUI();
            $('#sp-chat-msgs').empty();
            if (cachedSchedule) setBody(cachedSchedule);
            else setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>还没有日程</p><button class="sp-gen-btn" id="sp-gen-schedule-now">生成日程</button></div>`);
        }
        // Back-fill inline blocks for newly loaded chat
        setTimeout(backfillLinesInlineBlocks, 300);
    });
    // Auto-advance storylines, then append inline block to every AI message.
    // NOTE: shouldAdvance triggers generation BEFORE appending the current block,
    // so the current (newest, still-unstable) message is NOT included in the LLM
    // context. The advance fires when the PREVIOUS message tips the counter over,
    // and this message just gets the freshly-generated result injected.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        let shouldAdvance = false;
        if (getLinesMode() === 'days') {
            // Time-based: advance when the in-game date appears to have changed
            // (use the previous message's text, not the current one)
            shouldAdvance = detectInGameDayChange(messageId, /* excludeCurrent */ true);
        } else {
            // Turn-based: advance when counter hits interval,
            // increment AFTER deciding so the current message is excluded
            const interval = getLinesInterval();
            if (linesAiMsgCounter >= interval) { linesAiMsgCounter = 0; shouldAdvance = true; }
            linesAiMsgCounter++;
        }
        appendLinesInlineBlock(messageId, shouldAdvance);
    });
    // Track ST theme changes via MutationObserver on documentElement style
    new MutationObserver(() => {
        const t = detectSTTheme();
        if (t !== currentTheme) applyTheme(t);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
});

// ─── Config helpers ───────────────────────────────────────────────────────────

// ─── Plugin settings (persisted in ST's settings.json) ────────────────────────

function getSettings() {
    if (!extension_settings[PLUGIN_ID]) extension_settings[PLUGIN_ID] = { ...DEFAULT_SETTINGS };
    return extension_settings[PLUGIN_ID];
}

function loadCfg() {
    const s = getSettings();
    return { url: s.apiUrl || '', key: s.apiKey || '', model: s.apiModel || '' };
}

function saveCfg(c) {
    const s = getSettings();
    s.apiUrl   = c.url   || '';
    s.apiKey   = c.key   || '';
    s.apiModel = c.model || '';
    saveSettingsDebounced();
}

function fabEnabled() { return getSettings().fabShow !== false; }

function getLinesInterval() {
    const v = parseInt(getSettings().linesInterval, 10);
    return Number.isFinite(v) && v >= 1 ? v : 2;
}

function saveLinesInterval(n) {
    getSettings().linesInterval = Math.max(1, parseInt(n, 10) || 2);
    saveSettingsDebounced();
}

function getLinesMode() {
    return getSettings().linesMode === 'days' ? 'days' : 'turns';
}

function saveLinesMode(mode) {
    getSettings().linesMode = (mode === 'days') ? 'days' : 'turns';
    saveSettingsDebounced();
}

function maskKey(k) { return k.length <= 8 ? '•'.repeat(k.length) : '•'.repeat(k.length - 4) + k.slice(-4); }

// ─── Time-based day-change detection ─────────────────────────────────────────
// Scans the last few AI messages for date/time expressions and detects when the
// in-game calendar date has advanced. Heuristic: look for Chinese date patterns
// (第N天, 周X, N月N日, 今天/明天/昨天 transitions) and compare consecutive messages.
let _lastDetectedDay = null;

function detectInGameDayChange(messageId) {
    const msgs = getContext().chat || [];
    // Only look at AI messages; find the one just before this one too
    const aiMsgs = msgs.filter(m => !m.is_user);
    if (aiMsgs.length < 1) return false;

    const DAY_PATTERNS = [
        /第\s*(\d+)\s*[天日]/,
        /([一二三四五六七八九十百千\d]+)\s*月\s*([一二三四五六七八九十百千\d]+)\s*[日号]/,
        /星期([一二三四五六日天])|周([一二三四五六日天])/,
        /今天|明天|后天|大后天/,
        /day\s*(\d+)/i,
    ];

    function extractDay(text) {
        for (const p of DAY_PATTERNS) {
            const m = text.match(p);
            if (m) return m[0];
        }
        return null;
    }

    const currentMsg = aiMsgs[aiMsgs.length - 1];
    const currentDay = extractDay(currentMsg?.mes || '');
    if (!currentDay) return false;

    if (currentDay !== _lastDetectedDay) {
        _lastDetectedDay = currentDay;
        return true;  // day changed → trigger advance
    }
    return false;
}

// ─── Storylines inline block (appended to AI messages) ────────────────────────

async function appendLinesInlineBlock(messageId, shouldAdvance) {
    // Only gate generation on API being configured; display runs regardless
    const cfg = loadCfg();
    if (shouldAdvance && !isGeneratingLines && cfg.url && cfg.key) {
        await runGenerateLines(true /* silent */);
    }

    const msgEl = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!msgEl) return;

    // Remove any previously injected block for this message
    const existing = msgEl.querySelector('.sp-lines-inline');
    if (existing) existing.remove();

    const raw = (() => {
        try {
            const key = getLinesCacheKey();
            const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
            return saved?.raw || '';
        } catch { return ''; }
    })();

    const block = document.createElement('details');
    block.className = 'sp-lines-inline';

    const lines = raw ? parseLines(raw) : [];
    if (lines.length) {
        const linesHtml = lines.map(l => {
            const levelNum = parseInt(l.level, 10);
            const level    = Number.isFinite(levelNum) ? Math.max(1, Math.min(4, levelNum)) : 1;
            const stageColor = STAGE_COLORS[l.stage] || '#9aa6b2';
            // Beads: filled squares for active level, faint for remainder
            const beadsHtml = Array.from({length: 4}, (_, i) =>
                `<span class="sp-bead${i < level ? ' sp-bead-on' : ''}" style="${i < level ? `background:${stageColor}` : ''}"></span>`
            ).join('');
            return `<div class="sp-inline-line" style="border-left:3px solid ${stageColor}20">
                <div class="sp-inline-head">
                    <span class="sp-inline-stage" style="color:${stageColor}">${escapeHtml(l.stage)}</span>
                    ${l.type ? `<span class="sp-inline-type">${escapeHtml(l.type)}</span>` : ''}
                    <span class="sp-inline-dots">${beadsHtml}</span>
                    ${l.when ? `<span class="sp-inline-when">${escapeHtml(l.when)}</span>` : ''}
                </div>
                <div class="sp-inline-name">${escapeHtml(l.name)}</div>
                ${l.desc ? `<div class="sp-inline-desc">${escapeHtml(cleanText(l.desc))}</div>` : ''}
            </div>`;
        }).join('');
        block.innerHTML = `<summary class="sp-inline-summary"><span class="sp-inline-title">事件线</span><span class="sp-inline-count">${lines.length} 条活跃</span></summary><div class="sp-inline-body">${linesHtml}</div>`;
    } else {
        block.innerHTML = `<summary class="sp-inline-summary"><span class="sp-inline-title">事件线</span><span class="sp-inline-count sp-inline-empty">暂无</span></summary>`;
    }

    msgEl.appendChild(block);
}

// Back-fill inline blocks on all existing AI messages (no generation, just render from cache)
async function backfillLinesInlineBlocks() {
    // Only back-fill the most recent AI messages visible in the DOM.
    // Injecting every historical message is wasteful — they'd all show the
    // same cached snapshot, and iterating hundreds of elements is slow.
    const BACKFILL_LIMIT = 10;
    const els = [...document.querySelectorAll('#chat .mes:not([is_user="true"])')].slice(-BACKFILL_LIMIT);
    for (const mesEl of els) {
        const mesId = mesEl.getAttribute('mesid');
        if (mesId == null) continue;
        const msgEl = mesEl.querySelector('.mes_text');
        if (!msgEl || msgEl.querySelector('.sp-lines-inline')) continue;
        await appendLinesInlineBlock(mesId, false);
    }
}

// ─── Extensions panel ─────────────────────────────────────────────────────────

function injectExtButton() {
    // No drawer content — panel opened via magic wand or FAB
    const wandHtml = `
        <div id="sp_open_wand" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-calendar-days extensionsMenuExtensionButton" title="打开日程表"></div>
            <span>日程表</span>
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

function setExtBtnState(state) {
    const $wandBtn = $('#sp_open_wand');
    $wandBtn.removeClass('sp-btn-generating sp-btn-done');
    if (state) $wandBtn.addClass(`sp-btn-${state}`);

    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
    $('.sp-view-toggle').toggleClass('sp-locked', state === 'generating');
}

// ─── FAB ─────────────────────────────────────────────────────────────────────

function injectFab() {
    const savedPos = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
    const mobile = isMobile();
    const posStyle = (!mobile && savedPos)
        ? `left:${savedPos.left}px;top:${savedPos.top}px;right:auto;bottom:auto;`
        : '';
    const html = `<div id="${FAB_ID}" style="position:fixed;z-index:2000000;${posStyle}${fabEnabled() ? '' : 'display:none'}">
        <button class="sp-fab-btn sp-${currentTheme}" title="日程表"
            style="width:44px;height:44px;border-radius:50%;background:#3a3648;color:#d0bcff;border:1.5px solid rgba(208,188,255,0.35);display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.5);transform:translateZ(0);clip:auto;">
            <i class="fa-solid fa-calendar-days"></i>
        </button>
    </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (nowMobile && !wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) { fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = ''; }
            const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
            if (sheet) { sheet.style.left = ''; sheet.style.top = ''; sheet.style.right = '';
                         sheet.style.transform = ''; sheet.style.width = ''; sheet.style.height = ''; sheet.style.maxHeight = ''; }
        } else if (!nowMobile && wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) {
                const sp = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
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
    }, { passive: true });

    $(`#${FAB_ID} .sp-fab-btn`).on('click', function () {
        if (!fabDragged) {
            $(`#${MODAL_ID}`).is(':visible') ? closePanel() : openSchedule();
        }
    });
}

function onFabTouchMove(ev) {
    if (!fabDragState) return;
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
}

function injectModal() {
    const cfg = loadCfg();
    const hasCustomApi = !!(cfg.url && cfg.key);
    const html = `
        <div id="${MODAL_ID}" class="sp-root sp-${currentTheme}" style="display:none;position:fixed;z-index:2000001">
            <div class="sp-backdrop"></div>
            <div class="sp-sheet">
                <div class="sp-topbar" id="sp-drag-handle">
                    <span class="sp-topbar-title"><i class="fa-solid fa-calendar-days"></i></span>
                    <div class="sp-view-toggle">
                        <button class="sp-view-btn sp-view-active" data-view="user">我</button>
                        <button class="sp-view-btn" data-view="char">TA</button>
                        <button class="sp-view-btn" data-view="outline">大纲</button>
                        <button class="sp-view-btn" data-view="lines">线</button>
                    </div>
                    <div class="sp-topbar-actions">
                        <button class="sp-icon-btn sp-fab-toggle-btn${fabEnabled() ? ' sp-btn-active' : ''}" title="悬浮按钮"><i class="fa-regular fa-circle-dot"></i></button>
                        <button class="sp-icon-btn sp-settings-btn" title="设置"><i class="fa-solid fa-gear"></i></button>
                        <button class="sp-icon-btn sp-close-btn"    title="关闭"><i class="fa-solid fa-xmark" style="font-size:1rem"></i></button>
                    </div>
                </div>

                <div id="sp-settings-panel" class="sp-settings-panel" style="display:none">
                    <div class="sp-api-notice ${hasCustomApi ? 'sp-notice-ok' : 'sp-notice-warn'}">
                        <i class="fa-solid ${hasCustomApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                        ${hasCustomApi
                            ? '已配置独立 API，后台生成不影响聊天'
                            : '未配置独立 API：生成期间将<b>占用聊天通道</b>，无法同时聊天'}
                    </div>
                    <p class="sp-cfg-hint">自定义 API（留空则使用酒馆当前模型）</p>
                    <input id="sp-cfg-url"   class="sp-input" type="url"
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
                    <div class="sp-interval-row">
                        <label class="sp-interval-label">事件线推进策略</label>
                        <div class="sp-mode-row">
                            <label class="sp-mode-opt">
                                <input type="radio" name="sp-lines-mode" value="turns" ${getLinesMode() === 'turns' ? 'checked' : ''}>
                                <span>回合制，每</span>
                                <input id="sp-lines-interval" class="sp-input sp-interval-input" type="number" min="1" value="${escapeAttr(String(getLinesInterval()))}">
                                <span>条推进一次</span>
                            </label>
                            <label class="sp-mode-opt">
                                <input type="radio" name="sp-lines-mode" value="days" ${getLinesMode() === 'days' ? 'checked' : ''}>
                                <span>时间制，按游戏内日期推进</span>
                            </label>
                        </div>
                    </div>
                    <button id="sp-cfg-save" class="sp-save-btn"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                    <span id="sp-cfg-msg" class="sp-cfg-msg"></span>
                </div>

                <div class="sp-body" id="sp-body">
                    <div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>还没有日程</p><button class="sp-gen-btn" id="sp-gen-schedule-now">生成日程</button></div>
                </div>

                <div class="sp-outline-wrap" id="sp-outline-wrap" style="display:none">
                    <div class="sp-outline-beats" id="sp-outline-beats">
                        <div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>当前还没有大纲，可以先直接聊天讨论，也可以生成一版大纲作为起点</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">生成大纲</button></div>
                    </div>
                    <div class="sp-outline-divider" id="sp-outline-divider">
                        <i class="fa-solid fa-grip-lines"></i>
                    </div>
                    <div class="sp-outline-chat" id="sp-outline-chat">
                        <div class="sp-chat-msgs" id="sp-chat-msgs"></div>
                        <div class="sp-chat-input-row">
                            <input type="text" id="sp-chat-input" class="sp-input" placeholder="和 AI 讨论大纲…">
                            <button id="sp-chat-send" class="sp-icon-btn" title="发送"><i class="fa-solid fa-paper-plane"></i></button>
                        </div>
                    </div>
                </div>

                <div class="sp-lines-wrap" id="sp-lines-wrap" style="display:none">
                    <div class="sp-lines-list" id="sp-lines-list">
                        <div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>还没有追踪的事件线，可以生成一版</p><button class="sp-gen-btn" id="sp-gen-lines-now">生成事件线</button></div>
                    </div>
                </div>

                <details class="sp-debug-drawer" id="sp-debug-drawer">
                    <summary class="sp-debug-summary">🐛 AI 输入</summary>
                    <pre class="sp-debug-pre" id="sp-debug-pre">（尚未发送请求）</pre>
                    <div class="sp-debug-actions">
                        <button class="sp-debug-copy-btn">复制</button>
                    </div>
                </details>

                <div class="sp-resize-handle" id="sp-resize-handle">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </div>
            </div>
        </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    if (cfg.key) $('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $(`#${MODAL_ID} .sp-close-btn`).on('click',    closePanel);
    $(`#${MODAL_ID} .sp-settings-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-fab-toggle-btn`).on('click', function () {
        const nowEnabled = !fabEnabled();
        getSettings().fabShow = nowEnabled;
        saveSettingsDebounced();
        $(`#${FAB_ID}`).toggle(nowEnabled);
        $(this).toggleClass('sp-btn-active', nowEnabled);
    });
    $(`#${MODAL_ID} .sp-backdrop`).on('click',     closePanel);
    document.getElementById('sp-debug-drawer').addEventListener('toggle', function () {
        if (this.open) {
            document.getElementById('sp-debug-pre').textContent =
                lastDebugPayload ? JSON.stringify(lastDebugPayload, null, 2) : '（尚未发送请求）';
        }
    });
    $(`#${MODAL_ID} .sp-debug-copy-btn`).on('click', function () {
        if (!lastDebugPayload) return;
        navigator.clipboard.writeText(JSON.stringify(lastDebugPayload, null, 2))
            .then(() => { $(this).text('已复制 ✓'); setTimeout(() => $(this).text('复制'), 2000); })
            .catch(() => {});
    });

    // Outline chat
    function doSendChat() {
        const msg = $('#sp-chat-input').val().trim();
        if (msg && !isOutlineChatting) { $('#sp-chat-input').val(''); sendOutlineChat(msg); }
    }
    $('#sp-chat-send').on('click', doSendChat);
    $('#sp-chat-input').on('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendChat(); } });
    $('#sp-outline-beats').on('click', '#sp-gen-outline-now', triggerGenerateOutline);
    $('#sp-lines-list').on('click', '#sp-gen-lines-now', triggerGenerateLines);
    $('#sp-body').on('click', '#sp-gen-schedule-now, .sp-refresh-schedule', onRegenClick);
    $('#sp-outline-beats').on('click', '.sp-refresh-outline', triggerGenerateOutline);
    $('#sp-lines-list').on('click', '.sp-refresh-lines', triggerGenerateLines);

    // Inject buttons (event delegation)
    $(`#sp-body, #sp-outline-wrap, #sp-lines-wrap`).on('click', '.sp-inject-btn', function () {
        const text = _injectTexts[$(this).data('iid')];
        if (text) injectToST(text);
    });

    // Abort buttons (event delegation)
    $('#sp-body').on('click', '#sp-abort-generate', () => scheduleAbortController?.abort());
    $('#sp-outline-beats').on('click', '#sp-abort-outline', () => outlineAbortController?.abort());
    $('#sp-lines-list').on('click', '#sp-abort-lines', () => linesAbortController?.abort());

    // View toggle: 我 / TA / 大纲 / 线
    $(`#${MODAL_ID} .sp-view-toggle`).on('click', '.sp-view-btn', function () {
        if (isGenerating) return;
        const view = $(this).data('view');

        if (view === 'outline') {
            if (outlineMode) return;
            outlineMode = true;
            linesMode = false;
            $('.sp-view-btn').removeClass('sp-view-active');
            $(this).addClass('sp-view-active');
            $('#sp-body').hide();
            $('#sp-lines-wrap').hide();
            $('#sp-outline-wrap').css('display', 'flex');
            loadCreativeChatHistory();
            updateCreativeChatModeUI();
            renderCreativeChatHistory();
            cachedOutline = loadCachedOutlineForCurrentChat();
            if (cachedOutline) setOutlineBody(cachedOutline);
            else setOutlineBody(renderEmptyOutlineState());
            return;
        }

        if (view === 'lines') {
            if (linesMode) return;
            linesMode = true;
            outlineMode = false;
            $('.sp-view-btn').removeClass('sp-view-active');
            $(this).addClass('sp-view-active');
            $('#sp-body').hide();
            $('#sp-outline-wrap').hide();
            $('#sp-lines-wrap').css('display', 'flex');
            cachedLines = loadCachedLinesForCurrentChat();
            if (cachedLines) setLinesBody(cachedLines);
            else setLinesBody(renderEmptyLinesState());
            return;
        }

        // Leaving outline/lines mode
        let wasExtra = false;
        if (outlineMode) {
            outlineMode = false;
            wasExtra = true;
            $('#sp-outline-wrap').hide();
        }
        if (linesMode) {
            linesMode = false;
            wasExtra = true;
            $('#sp-lines-wrap').hide();
        }
        if (wasExtra) $('#sp-body').show();

        if (view === currentView && !wasExtra) return;
        if (view === 'char') {
            if (charViewName) {
                setView('char', charViewName);
                if (cachedSchedule) setBody(cachedSchedule);
                else showEmptyGenerate();
            } else {
                switchToCharView();
            }
        } else {
            setView('user');
            if (cachedSchedule) setBody(cachedSchedule);
            else showEmptyGenerate();
        }
    });

    $('#sp-cfg-save').on('click',      saveSettings);
    $('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $('#sp-fetch-models').on('click',  fetchModels);
    $('#sp-cfg-key')
        .on('focus', () => { const r = $('#sp-cfg-key').data('real'); if (r) $('#sp-cfg-key').val(r); })
        .on('blur',  () => { const r = $('#sp-cfg-key').val().trim() || $('#sp-cfg-key').data('real') || ''; if (r) $('#sp-cfg-key').data('real', r).val(maskKey(r)); });

    $('#sp-body').on('click', '.sp-tab', function () {
        const idx   = parseInt($(this).data('day'));
        const total = parseInt($('.sp-days-track').data('total')) || 4;
        $('.sp-tab').removeClass('sp-tab-active');
        $(this).addClass('sp-tab-active');
        $('.sp-days-track').css('transform', `translateX(-${idx * 100 / total}%)`);
    });

    $('#sp-drag-handle').on('mousedown', onDragStart);
    document.getElementById('sp-drag-handle').addEventListener('touchstart', onDragStart, { passive: false });
    $('#sp-resize-handle').on('mousedown', onResizeStart);
    document.getElementById('sp-resize-handle').addEventListener('touchstart', onResizeStart, { passive: false });

    // Outline divider drag
    let divState = null;
    const divEl  = document.getElementById('sp-outline-divider');
    const chatEl = document.getElementById('sp-outline-chat');
    function onDivStart(e) {
        e.preventDefault();
        const savedH = parseInt(localStorage.getItem('sp-outline-chat-h')) || 210;
        chatEl.style.height = savedH + 'px';
        divState = { startY: e.touches ? e.touches[0].clientY : e.clientY, startH: chatEl.offsetHeight };
        document.addEventListener('mousemove', onDivMove);
        document.addEventListener('mouseup',   onDivEnd);
        document.addEventListener('touchmove', onDivMove, { passive: false });
        document.addEventListener('touchend',  onDivEnd);
    }
    function onDivMove(e) {
        if (!divState) return;
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
    }
    divEl.addEventListener('mousedown',  onDivStart);
    divEl.addEventListener('touchstart', onDivStart, { passive: false });
    restoreOutlineChatHeight();
}

// ─── View (我 / TA) ───────────────────────────────────────────────────────────

function onRegenClick() {
    if (outlineMode) {
        triggerGenerateOutline();
        return;
    }
    if (isGenerating) return;
    if (currentView === 'char') {
        // Clear char cache and re-show picker so user can pick a different char.
        // Stash the name first — switchToCharView reads charViewName for pre-fill.
        const key = getCacheKey();
        if (key) localStorage.removeItem(key);
        cachedSchedule = null;
        switchToCharView();   // pre-fills with current charViewName (or guesses)
        charViewName   = null; // clear after picker is rendered
    } else {
        triggerGenerate();
    }
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
    if (view === 'char') charViewName = charName || null;
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="${view}"]`).addClass('sp-view-active');
    cachedSchedule = loadCachedForCurrentChat();
    cachedOutline  = loadCachedOutlineForCurrentChat();
    outlineChatHistory = [];
    if (outlineMode) {
        loadCreativeChatHistory();
        updateCreativeChatModeUI();
        renderCreativeChatHistory();
    } else {
        $('#sp-chat-msgs').empty();
    }
    if (outlineMode && cachedOutline) setOutlineBody(cachedOutline);
}

function switchToCharView() {
    currentView = 'char';
    const ctx     = getContext();
    // Prefer previously confirmed name; fall back to guessing from chat messages
    const guessed = charViewName || guessCharName(ctx);
    setBody(`<div class="sp-char-picker">
        <p class="sp-char-picker-hint"><i class="fa-solid fa-user-pen"></i> 输入要查看日程的角色名</p>
        <div class="sp-char-picker-row">
            <input id="sp-char-name-input" class="sp-input" type="text"
                   placeholder="角色名" value="${escapeAttr(guessed)}">
            <button id="sp-char-name-confirm" class="sp-save-btn">确认</button>
        </div>
        ${guessed ? `<p class="sp-char-picker-sub">根据近期对话预填，可直接修改</p>` : ''}
    </div>`);
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="char"]`).addClass('sp-view-active');
    // .off().on() prevents duplicate bindings on repeated calls
    $('#sp-char-name-input').off('keydown.charview').on('keydown.charview', e => { if (e.key === 'Enter') confirmCharView(); });
    $('#sp-char-name-confirm').off('click.charview').on('click.charview', confirmCharView);
    setTimeout(() => { $('#sp-char-name-input').focus().select(); }, 50);
}

function confirmCharView() {
    const name = $('#sp-char-name-input').val().trim();
    if (!name) { $('#sp-char-name-input').focus(); return; }
    setView('char', name);
    if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-stop"></i>中止生成</button></div>`);
        if (!isGenerating) {
            isGenerating = true;
            setExtBtnState('generating');
            runGenerate();
        }
    }
}

// ─── Open / close ─────────────────────────────────────────────────────────────

function openSchedule() {
    showPanel();
    if (isGenerating) {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-stop"></i>中止生成</button></div>`);
    } else if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        showEmptyGenerate();
    }
}

function showEmptyGenerate() {
    setBody(`<div class="sp-empty">
        <i class="fa-regular fa-calendar"></i>
        <button class="sp-gen-btn" id="sp-gen-now">生成日程</button>
    </div>`);
    $('#sp-gen-now').on('click', triggerGenerate);
}

function showPanel() {
    const $root  = $(`#${MODAL_ID}`);
    const sheet  = document.querySelector(`#${MODAL_ID} .sp-sheet`);
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
    $(`#${MODAL_ID}`).stop(true).animate({ opacity: 0 }, 150, function () {
        $(this).css('display', 'none');
    });
}

function setBody(html) { $('#sp-body').html(html); }

// ─── Generation ───────────────────────────────────────────────────────────────

function triggerGenerate() {
    if (isGenerating) return;
    const key = getCacheKey();
    if (key) localStorage.removeItem(key);
    cachedSchedule = null;
    isGenerating = true;
    setExtBtnState('generating');
    if (!$(`#${MODAL_ID}`).is(':visible')) showPanel();
    setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-stop"></i>中止生成</button></div>`);
    runGenerate();
}

async function runGenerate() {
    // Snapshot view state — user may switch views while the request is in flight
    const viewSnap = currentView;
    const charSnap = charViewName;
    scheduleAbortController = new AbortController();
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || '用户';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || '角色') : (ctx.name2 || '角色');
        const subject  = viewSnap === 'char' ? charName : userName;
        const raw      = await generate(ctx, userName, charName, viewSnap, scheduleAbortController.signal);
        const html     = renderSchedule(raw, subject, viewSnap);

        const cacheKey = getCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, userName: subject, ts: Date.now() }));
        isGenerating = false;
        scheduleAbortController = null;
        setExtBtnState('done');

        if (viewSnap === 'char') charViewName = charSnap;

        const stillOnView = currentView === viewSnap &&
            (viewSnap !== 'char' || charViewName === charSnap);
        if (stillOnView) {
            cachedSchedule = html;
            if ($(`#${MODAL_ID}`).is(':visible')) setBody(html);
            else showToast('日程已生成，点击查看', () => { showPanel(); setBody(html); });
        } else {
            showToast('日程已生成，点击查看', () => {
                setView(viewSnap, charSnap);
                cachedSchedule = html;
                showPanel();
                setBody(html);
            });
        }
        setTimeout(() => setExtBtnState(null), 6000);
    } catch (err) {
        isGenerating = false;
        scheduleAbortController = null;
        setExtBtnState(null);
        if (err.name === 'AbortError') {
            if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) showEmptyGenerate();
            return;
        }
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`;
        if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) setBody(errHtml);
        else showToast('日程生成失败，请重试', null, true);
    }
}

async function generate(ctx, userName, charName, perspective = 'user', signal = null) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) {
        if (!settingsOpen) toggleSettings();
        throw new Error('请先在设置中填写自定义 API 的 URL 和 Key');
    }
    const prompt = buildPrompt(userName, charName, perspective);
    return callCustomApi(ctx, prompt, cfg, userName, charName, signal);
}

async function callCustomApi(ctx, prompt, cfg, userName, charName, signal = null) {
    const messages = await buildMessages(ctx, prompt, userName, charName);
    lastDebugPayload = { model: cfg.model || 'gpt-4o-mini', messages };
    const res = await fetch(`${cfg.url}/chat/completions`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, max_tokens: 4096 }),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return (await res.json()).choices?.[0]?.message?.content ?? '';
}

async function buildWorldInfoContext(ctx) {
    const parts = [];
    // 1. 角色卡内嵌 lorebook（character_book）
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const charBook = char.data?.character_book;
    if (charBook?.entries?.length) {
        const entries = charBook.entries
            .filter(e => !e.disabled)
            .map(e => e.content)
            .filter(Boolean);
        if (entries.length) parts.push(`【角色世界书】\n${entries.join('\n\n')}`);
    }
    // 2. 全局激活的世界书（尽量大的预算以包含所有条目）
    try {
        const wiData = await ctx.getWorldInfoPrompt(ctx.chat ?? [], 999999, true);
        if (wiData?.worldInfoString) parts.push(`【世界书】\n${wiData.worldInfoString}`);
    } catch { /* ignore */ }
    return parts.join('\n\n');
}

async function buildMessages(ctx, prompt, userName, charName) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const wiContext = await buildWorldInfoContext(ctx);
    const sys  = [
        `你是一位旁观者和叙事分析助手，负责以第三人称视角分析 ${userName} 与 ${charName} 的故事。`,
        `不要扮演任何角色，不要使用第一人称。所有输出必须以第三人称叙述。`,
        char.description ? `【${charName} 的背景资料】\n${char.description}` : '',
        char.personality ? `【性格】${char.personality}` : '',
        char.scenario    ? `【场景】${char.scenario}`    : '',
        wiContext,
    ].filter(Boolean).join('\n\n');
    // Only take the last 10 AI replies (+ their paired user messages) to avoid
    // anchoring on dates from early in the conversation.
    const allMsgs = ctx.chat ?? [];
    let aiCount = 0;
    let startIdx = allMsgs.length;
    for (let i = allMsgs.length - 1; i >= 0; i--) {
        if (!allMsgs[i].is_user) aiCount++;
        if (aiCount >= 10) { startIdx = i; break; }
    }
    const history = allMsgs.slice(startIdx).map(m => ({
        role   : m.is_user ? 'user' : 'assistant',
        content: substituteParams(m.mes ?? ''),
    }));
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: prompt }];
}

// ─── Outline cache helpers ────────────────────────────────────────────────────

function getOutlineCacheKey(view, charName) {
    const chatId = getContext().chatId;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    return buildOutlineScopedCacheKey(chatId, v, c);
}

function getCreativeChatHistoryKey(view, charName) {
    const chatId = getContext().chatId;
    return buildCreativeChatHistoryKey(chatId, view ?? currentView, charName ?? charViewName);
}

function loadCreativeChatHistory(view, charName) {
    const key = getCreativeChatHistoryKey(view, charName);
    if (!key) {
        outlineChatHistory = [];
        return outlineChatHistory;
    }
    try {
        const saved = JSON.parse(localStorage.getItem(key) || '[]');
        outlineChatHistory = Array.isArray(saved) ? saved.filter(item => item?.role && item?.content) : [];
    } catch {
        outlineChatHistory = [];
    }
    return outlineChatHistory;
}

function saveCreativeChatHistory(view, charName) {
    const key = getCreativeChatHistoryKey(view, charName);
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(outlineChatHistory));
}

function updateCreativeChatModeUI() {
    $('#sp-chat-input').attr('placeholder', getCreativeChatPlaceholder());
}

function renderCreativeChatHistory() {
    const $msgs = $('#sp-chat-msgs');
    $msgs.empty();
    for (const msg of outlineChatHistory) {
        appendChatMsg(msg.role === 'assistant' ? 'ai' : msg.role, msg.content);
    }
}

function loadCachedOutlineForCurrentChat(view, charName) {
    const key = getOutlineCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderOutline(saved.raw);
    } catch { /* ignore */ }
    return null;
}

// ─── Inject ───────────────────────────────────────────────────────────────────

function makeInjectBtn(text) {
    const id = ++_injectIdSeq;
    _injectTexts[id] = text;
    return `<button class="sp-inject-btn" data-iid="${id}" title="注入到输入框"><i class="fa-solid fa-arrow-right-to-bracket"></i></button>`;
}

function injectToST(text) {
    const $ta = $('#send_textarea');
    if (!$ta.length) { showToast('找不到输入框', null, true); return; }
    $ta.val(text).trigger('input');
    showToast('已注入到输入框');
}

// ─── Outline chat ─────────────────────────────────────────────────────────────

function appendChatMsg(role, content) {
    const display = content.replace(/<outline_widget[\s\S]*?<\/outline_widget>/gi, '[↑ 已生成新大纲]');
    const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
    $('<div>').addClass(`sp-chat-msg ${cls}`)
        .html(escapeHtml(display).replace(/\n/g, '<br>'))
        .appendTo('#sp-chat-msgs');
    const el = document.getElementById('sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
}

async function buildOutlineChatMessages(userMsg) {
    const ctx      = getContext();
    const userName = ctx.name1 || '用户';
    const charName = currentView === 'char' ? (charViewName || ctx.name2 || '角色') : (ctx.name2 || '角色');
    let outlineCtx = '';
    try {
        const key  = getOutlineCacheKey();
        const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) outlineCtx = saved.raw;
    } catch { /* ignore */ }
    const wiContext = await buildWorldInfoContext(ctx);
    const sys = buildCreativeChatSystemPrompt({
        userName,
        charName,
        outlineRaw: outlineCtx,
        wiContext,
    });
    return [{ role: 'system', content: sys }, ...outlineChatHistory, { role: 'user', content: userMsg }];
}

async function sendOutlineChat(userMsg) {
    if (isOutlineChatting) return;
    appendChatMsg('user', userMsg);
    outlineChatHistory.push({ role: 'user', content: userMsg });
    saveCreativeChatHistory();
    isOutlineChatting = true;
    const $dots = $('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking').text('…').appendTo('#sp-chat-msgs');
    const el = document.getElementById('sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
    try {
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); throw new Error('请先配置 API'); }
        const res = await fetch(`${cfg.url}/chat/completions`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
            body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages: await buildOutlineChatMessages(userMsg), max_tokens: 4096 }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reply = (await res.json()).choices?.[0]?.message?.content ?? '';
        outlineChatHistory.push({ role: 'assistant', content: reply });
        saveCreativeChatHistory();
        $dots.remove();
        appendChatMsg('ai', reply);
        if (/<outline_widget/i.test(reply)) {
            const pendingRaw = reply;
            const $btn = $('<button class="sp-apply-outline-btn">应用此大纲</button>');
            $btn.on('click', () => {
                const html = renderOutline(pendingRaw);
                setOutlineBody(html);
                cachedOutline = html;
                const key = getOutlineCacheKey();
                if (key) localStorage.setItem(key, JSON.stringify({ raw: pendingRaw, ts: Date.now() }));
                $btn.text('✓ 已应用').prop('disabled', true);
            });
            $('<div class="sp-chat-msg sp-chat-msg-system sp-apply-row"></div>').append($btn).appendTo('#sp-chat-msgs');
            const el2 = document.getElementById('sp-chat-msgs');
            if (el2) el2.scrollTop = el2.scrollHeight;
        }
    } catch (err) {
        $dots.remove();
        appendChatMsg('system', `发送失败：${err.message}`);
    }
    isOutlineChatting = false;
}



function toggleOutlineMode() {
    outlineMode = !outlineMode;
    $('.sp-view-btn').removeClass('sp-view-active');
    if (outlineMode) {
        $(`.sp-view-btn[data-view="outline"]`).addClass('sp-view-active');
        $('#sp-body').hide();
        $('#sp-outline-wrap').css('display', 'flex');
        loadCreativeChatHistory();
        updateCreativeChatModeUI();
        renderCreativeChatHistory();
        cachedOutline = loadCachedOutlineForCurrentChat();
        if (cachedOutline) setOutlineBody(cachedOutline);
        else setOutlineBody(renderEmptyOutlineState());
    } else {
        $(`.sp-view-btn[data-view="${currentView}"]`).addClass('sp-view-active');
        $('#sp-outline-wrap').hide();
        $('#sp-body').show();
    }
}

function renderEmptyOutlineState() {
    return `<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>当前还没有大纲，可以先直接聊天讨论，也可以生成一版大纲作为起点</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">生成大纲</button></div>`;
}

function setOutlineBody(html) { $('#sp-outline-beats').html(html); }

// ─── Outline generation ───────────────────────────────────────────────────────

function triggerGenerateOutline() {
    if (isGeneratingOutline) return;
    const key = getOutlineCacheKey();
    if (key) localStorage.removeItem(key);
    cachedOutline = null;
    isGeneratingOutline = true;
    setOutlineBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在构思大纲…</p><button class="sp-abort-btn" id="sp-abort-outline"><i class="fa-solid fa-stop"></i>中止生成</button></div>`);
    runGenerateOutline();
}

async function runGenerateOutline() {
    const viewSnap = currentView;
    const charSnap = charViewName;
    outlineAbortController = new AbortController();
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
        const raw      = await callCustomApi(ctx, prompt, cfg, userName, charName, outlineAbortController.signal);
        const html     = renderOutline(raw);
        const cacheKey = getOutlineCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, ts: Date.now() }));
        isGeneratingOutline = false;
        outlineAbortController = null;
        cachedOutline = html;
        if (outlineMode) setOutlineBody(html);
        else showToast('大纲已生成，点击查看', () => { if (!outlineMode) toggleOutlineMode(); showPanel(); });
    } catch (err) {
        isGeneratingOutline = false;
        outlineAbortController = null;
        if (err.name === 'AbortError') {
            if (outlineMode) setOutlineBody(`<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>已中止</p></div>`);
            return;
        }
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`;
        if (outlineMode) setOutlineBody(errHtml);
        else showToast('大纲生成失败，请重试', null, true);
    }
}

function buildOutlinePrompt(userName, charName, perspective = 'user') {
    const subject = perspective === 'char' ? charName : userName;
    return `请暂停角色扮演，以编剧顾问身份根据以上剧情，为当前故事生成大纲。
【重要】所有输出必须使用中文（人名、地名可保留原文）。

【第一步：故事基础分析】
生成节点之前，先在注释中梳理以下内容（300字以上）：
① 当前状态：故事中主要人物（包括 ${subject} 及其他关键角色）的现状、各自目标、未解决的矛盾
② 角色主次关系：核心主角、重要配角、对立势力及其在剧情中的权重
③ 情感萌点/核心吸引力：这个故事中最抓人的戏剧张力是什么？（如“互相利用却暗生情愫”、“共同御敌但理念冲突”、“救赎与被救赎”）
④ 外部环境现状与发展趋势：当前势力平衡、社会危机、即将发生的大事件等，以及若无干预的自然走向
⑤ 剧情模式：这是什么类型的故事？内部驱动力是什么？（如“外部压迫下的生存斗争 + 内部关系演变”或“个人复仇与救赎之旅”）
⑥ 故事线汇总：至少列出两条故事线——【主线】（外部目标、任务、对抗外部势力）和【情感线】（主要人物之间的情感关系变化）。如有必要可增加个人成长线、势力斗争线等。
⑦ 各主要角色的行为模式与语言风格特征，确保节点中的人物表现符合原设

【第二步：生成关键节点，目标 8 个】
节点必须基于上述分析，体现你确定的剧情模式。
- 故事线需要螺旋推进（进→退→再进），不可直线发展。
- 节点覆盖完整故事弧线：开局状态 → 摩擦/试探 → 第一次推进 → 受挫/退后 → 危机爆发 → 关键转折 → 余波 → 新平衡。每个阶段1个节点。
- 每个节点的 Scene 和 Think 内容充实，不压缩质量。

【标题要求】10字以内，有文学出处感——来自真实古诗词原句或改编、真实歌词改编、知名小说/影视台词化用。各节点标题风格不要全部相同，古诗词/歌词/小说三类至少各用一次。不要自造没有出处的文艺短语。

【字段说明】
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: 这一幕实际发生了什么（80-120字）
Subtext: 这一幕里某人没有说出口的那句话，或某个下意识的动作所隐含的情绪（不超过40字）
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
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/^Beat\s*:/i.test(t)) {
            if (cur) beats.push(cur);
            const parts = t.replace(/^Beat\s*:\s*/i, '').split('|');
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
        } else if (/^Scene\s*:/i.test(t) && cur) {
            cur.scene = t.replace(/^Scene\s*:\s*/i, '').trim();
        } else if (/^Subtext\s*:/i.test(t) && cur) {
            cur.subtext = t.replace(/^Subtext\s*:\s*/i, '').trim();
        } else if (/^Think\s*:/i.test(t) && cur) {
            cur.think = t.replace(/^Think\s*:\s*/i, '').trim();
        }
    }
    if (cur) beats.push(cur);
    return beats;
}

function renderOutline(raw) {
    const beats = parseOutline(raw);
    const toolbar = `<div class="sp-panel-toolbar"><button class="sp-panel-refresh sp-refresh-outline" title="重新生成大纲"><i class="fa-solid fa-rotate-right"></i></button></div>`;
    if (beats.length === 0) return toolbar + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    const cards = beats.map((b, i) => {
        const injectParts = [`【剧情节点参考】`, `${b.time}·《${b.title}》${b.type ? '·' + b.type : ''}${b.line ? '（' + b.line + '）' : ''}`];
        if (b.scene)   injectParts.push(b.scene);
        if (b.outcome) injectParts.push(`结果：${b.outcome}`);
        const injectBtn = makeInjectBtn(injectParts.join('\n'));
        return `
        <div class="sp-beat">
            <div class="sp-beat-head">
                <span class="sp-beat-index">${i + 1}</span>
                <span class="sp-beat-time">${escapeHtml(b.time)}</span>
                ${b.type ? `<span class="sp-beat-type">${escapeHtml(b.type)}</span>` : ''}
                ${b.line ? `<span class="sp-beat-line">${escapeHtml(b.line)}</span>` : ''}
                ${injectBtn}
            </div>
            <div class="sp-beat-title">${escapeHtml(b.title)}</div>
            ${b.outcome ? `<div class="sp-beat-outcome">${escapeHtml(cleanText(b.outcome))}</div>` : ''}
            ${b.scene   ? `<div class="sp-beat-scene">${escapeHtml(cleanText(b.scene))}</div>` : ''}
            ${b.subtext ? `<div class="sp-beat-subtext">"${escapeHtml(cleanText(b.subtext))}"</div>` : ''}
            ${b.think   ? `<details class="sp-beat-think"><summary>创作思考</summary><p>${escapeHtml(cleanText(b.think))}</p></details>` : ''}
        </div>`;
    }).join('');
    return toolbar + cards;
}


// ─── Storylines (事件线) ─────────────────────────────────────────────────────

function getLinesCacheKey(view, charName) {
    const chatId = getContext().chatId;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    return buildLinesScopedCacheKey(chatId, v, c);
}

function loadCachedLinesForCurrentChat(view, charName) {
    const key = getLinesCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderLines(saved.raw);
    } catch { /* ignore corrupt cache */ }
    return null;
}

function setLinesBody(html) { $('#sp-lines-list').html(html); }

function renderEmptyLinesState() {
    return `<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>还没有追踪的事件线，可以生成一版</p><button class="sp-gen-btn" id="sp-gen-lines-now">生成事件线</button></div>`;
}

function triggerGenerateLines() {
    if (isGeneratingLines) return;
    isGeneratingLines = true;
    setLinesBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在推演事件线…</p><button class="sp-abort-btn" id="sp-abort-lines"><i class="fa-solid fa-stop"></i>中止生成</button></div>`);
    runGenerateLines();
}

async function runGenerateLines(silent = false) {
    const viewSnap = currentView;
    const charSnap = charViewName;
    linesAbortController = new AbortController();
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
        let previousRaw = '';
        try {
            const saved = cacheKey && JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (saved?.raw) previousRaw = saved.raw;
        } catch { /* ignore corrupt cache */ }
        const prompt = buildLinesPrompt(userName, charName, viewSnap, previousRaw);
        const raw    = await callCustomApi(ctx, prompt, cfg, userName, charName, linesAbortController.signal);
        const html   = renderLines(raw);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, ts: Date.now() }));
        isGeneratingLines = false;
        linesAbortController = null;
        cachedLines = html;
        if (linesMode) setLinesBody(html);
        else if (!silent) showToast('事件线已生成，点击查看', () => {
            if (!linesMode) $('.sp-view-btn[data-view="lines"]').trigger('click');
            showPanel();
        });
    } catch (err) {
        isGeneratingLines = false;
        linesAbortController = null;
        if (err.name === 'AbortError') {
            if (linesMode) setLinesBody(`<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>已中止</p></div>`);
            return;
        }
        if (!silent) {
            const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`;
            if (linesMode) setLinesBody(errHtml);
            else showToast('事件线生成失败，请重试', null, true);
        }
    }
}

function buildLinesPrompt(userName, charName, perspective = 'user', previousRaw = '') {
    const subject = perspective === 'char' ? charName : userName;
    return `请暂停角色扮演，以编剧顾问身份根据以上剧情，追踪当前故事中正在发生的"事件线"。
【重要】所有输出必须使用中文（人名、地名可保留原文）。

事件线是指独立于 ${subject} 直接行动之外、正在自行发展的多阶段进程——阴谋、冲突升级、外部危机、他人的计划等。每条事件线属于以下两类之一，并处于对应阶段之一：
- 冲突类：萌芽 → 发酵 → 逼近 → 已爆发（或已消散）
- 推进类：筹备 → 执行 → 关键 → 已完成（或已失败）

【当前已追踪的事件线】
${previousRaw ? previousRaw : '（无，这是第一次生成。请从当前剧情中提炼 2-4 条正在发生或即将发生的事件线，若剧情中暂时看不出明显的多阶段进程，也可以只给 1-2 条）'}

请基于以上已有事件线和最新剧情进展更新它们：可能推进到下一阶段、可能受挫停滞在原阶段、可能达到终结阶段。如果剧情里出现了新的多阶段进程，可以新增，但总数不要超过 6 条；已经收尾且不再重要的事件线（如已经处于终结阶段一段时间）直接不要输出，视为自然收尾。

【输出格式（严格遵守）】
<storylines_widget>
Line: 名称|类型(冲突/推进)|阶段|等级(1-4，数字越大越重要)|最近进展的时间点（如"今天上午""三天后""下周一"，锚定在故事内具体时间，不要用"第N轮"这类说法）
Desc: 当前状态与可能走向（60-100字）
（每条事件线重复上面两行）
</storylines_widget>`;
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
            cur = {
                name : (parts[0] || '').trim(),
                type : (parts[1] || '').trim(),
                stage: (parts[2] || '').trim(),
                level: (parts[3] || '').trim(),
                when : (parts[4] || '').trim(),
                desc : '',
            };
        } else if (/^Desc\s*:/i.test(t) && cur) {
            cur.desc = t.replace(/^Desc\s*:\s*/i, '').trim();
        }
    }
    if (cur) lines.push(cur);
    return lines;
}

const STAGE_COLORS = {
    萌芽: '#d6b85a', 发酵: '#d98a3d', 逼近: '#cf5f3f', 已爆发: '#b93f3f', 已消散: '#888888',
    筹备: '#7de9d9', 执行: '#58e8b3', 关键: '#2a8a5d', 已完成: '#1b5e3b', 已失败: '#888888',
};

function renderLines(raw) {
    const lines = parseLines(raw);
    const toolbar = `<div class="sp-panel-toolbar"><button class="sp-panel-refresh sp-refresh-lines" title="重新生成事件线"><i class="fa-solid fa-rotate-right"></i></button></div>`;
    if (lines.length === 0) return toolbar + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    const cards = lines.map(l => {
        const levelNum  = parseInt(l.level, 10);
        const level     = Number.isFinite(levelNum) ? Math.max(1, Math.min(4, levelNum)) : 1;
        const stageColor = STAGE_COLORS[l.stage] || '#9aa6b2';
        const beadsHtml = Array.from({length: 4}, (_, i) =>
            `<span class="sp-bead${i < level ? ' sp-bead-on' : ''}" style="${i < level ? `background:${stageColor}` : ''}"></span>`
        ).join('');
        const injectParts = [`【事件线参考】${l.name}（${l.type}·${l.stage}）`];
        if (l.desc) injectParts.push(l.desc);
        const injectBtn = makeInjectBtn(injectParts.join('\n'));
        return `
        <div class="sp-beat" style="border-left:3px solid ${stageColor}30">
            <div class="sp-beat-head">
                <span class="sp-beat-type" style="color:${stageColor}">${escapeHtml(l.stage)}</span>
                ${l.type ? `<span class="sp-beat-line">${escapeHtml(l.type)}</span>` : ''}
                <span class="sp-beat-time">${beadsHtml}</span>
                ${l.when ? `<span class="sp-beat-time">${escapeHtml(l.when)}</span>` : ''}
                ${injectBtn}
            </div>
            <div class="sp-beat-title">${escapeHtml(l.name)}</div>
            ${l.desc ? `<div class="sp-beat-scene">${escapeHtml(cleanText(l.desc))}</div>` : ''}
        </div>`;
    }).join('');
    return toolbar + cards;
}


function buildPrompt(userName, charName, perspective = 'user') {
    const subject   = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    return `请暂停角色扮演，以旁观者视角根据以上剧情，为 ${subject} 生成日程。
【重要】所有输出必须使用中文（人名、地名可保留原文）。

事件分三类：
- main（明线）：${subject} 直接卷入、正在推进的事件
- hidden（暗线）：隐含的伏笔、悬而未决的走向
- bond（红线）：${subject} 与某人之间可能发生或加深的事件（不限于 ${companion}，可以是任意重要人物）

${subject} 和 ${companion} 都有各自独立的生活，事件可以涉及任意 NPC 和第三方，不必每条都围绕两人互动。

Day 1-3 每天生成 1 到 3 个事件；Future 块生成 5 到 10 个事件，时间跨度不限。

【字段说明】
格式：Event: type|title|description|time|location|线头动态
- type 只能是 main / hidden / bond
- description：${subject} 视角，生活化口吻，30字以上
- 线头动态：与此事件相关的其他角色同期动态，可以是任意 NPC 或第三方，30字以上；若无关联角色可留空

【日期说明】
Day 1 应从剧情当前时间节点开始，向后推演。如剧情中能明确推断出当前日期则填写 StartDate，否则省略。不要回填已经发生过的日期，Day 1 必须是剧情"现在"或之后的时间。

【输出格式（严格遵守，只输出以下结构）】
<!-- 日程思考：（结合剧情推演安排，100字以上） -->
<calendar_widget>
StartDate: YYYY-MM-DD（可从剧情推断则填写，否则省略此行）
Day: 1
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Day: 2
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Day: 3
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Future:
Event: type|title|description|time|location|线头动态
</calendar_widget>

【Future 说明】
Future 块收录剧情中出现的未来事项，时间不限。
允许基于剧情走向合理推测，但不能凭空捏造剧情中从未提及的约定或承诺。`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function fetchModels() {
    const url = $('#sp-cfg-url').val().trim().replace(/\/$/, '');
    const key = ($('#sp-cfg-key').data('real') || $('#sp-cfg-key').val()).trim();
    if (!url || !key) { showToast('请先填写 URL 和 Key', null, true); return; }

    const $btn = $('#sp-fetch-models');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    try {
        const res = await fetch(`${url}/models`, {
            headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || data.models || [])
            .map(m => (typeof m === 'string' ? m : m.id))
            .filter(Boolean).sort();
        if (!models.length) throw new Error('接口未返回任何模型');

        const current = loadCfg().model || '';
        const opts = models.map(m =>
            `<option value="${escapeAttr(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`
        ).join('');
        $('#sp-cfg-model').replaceWith(
            `<select id="sp-cfg-model" class="sp-input sp-model-input">${opts}</select>`
        );
        if (!current) $('#sp-cfg-model').val(models[0]);
        showToast(`已加载 ${models.length} 个模型`);
    } catch (err) {
        showToast(`获取模型失败：${err.message}`, null, true);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-list"></i>');
    }
}

function toggleSettings() {
    settingsOpen = !settingsOpen;
    $('#sp-settings-panel').slideToggle(200, () => {
        syncMobileViewport();
    });
    $(`#${MODAL_ID} .sp-settings-btn`).toggleClass('sp-btn-active', settingsOpen);
    syncMobileViewport();
}

function toggleKeyVisibility() {
    const $el = $('#sp-cfg-key'), $icon = $('#sp-key-toggle i');
    if ($el.attr('type') === 'password') {
        $el.attr('type', 'text').val($el.data('real') || $el.val());
        $icon.removeClass('fa-eye').addClass('fa-eye-slash');
    } else {
        const r = $el.val(); $el.data('real', r).attr('type', 'password').val(maskKey(r));
        $icon.removeClass('fa-eye-slash').addClass('fa-eye');
    }
}

function saveSettings() {
    const $k = $('#sp-cfg-key'), key = ($k.data('real') || $k.val()).trim();
    saveCfg({ url: $('#sp-cfg-url').val().trim().replace(/\/$/, ''), key, model: $('#sp-cfg-model').val().trim() });
    saveLinesInterval($('#sp-lines-interval').val());
    saveLinesMode($('input[name="sp-lines-mode"]:checked').val());
    $k.data('real', key).val(maskKey(key)).attr('type', 'password');
    const $m = $('#sp-cfg-msg'); $m.text('已保存 ✓'); setTimeout(() => $m.text(''), 2000);
    const hasApi = !!(loadCfg().url && loadCfg().key);
    $('.sp-api-notice')
        .removeClass('sp-notice-ok sp-notice-warn')
        .addClass(hasApi ? 'sp-notice-ok' : 'sp-notice-warn')
        .html(`<i class="fa-solid ${hasApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            ${hasApi ? '已配置独立 API，后台生成不影响聊天'
                     : '未配置独立 API：生成期间将<b>占用聊天通道</b>'}`);
    setTimeout(() => { if (settingsOpen) toggleSettings(); }, 400);
}

function applyTheme(theme) {
    currentTheme = theme;
    $(`#${MODAL_ID}`).removeClass('sp-night sp-day').addClass(`sp-${theme}`);
    $(`#${FAB_ID} .sp-fab-btn`).removeClass('sp-night sp-day').addClass(`sp-${theme}`);
}

// ─── Drag ─────────────────────────────────────────────────────────────────────

function onDragStart(e) {
    if ($(e.target).closest('.sp-icon-btn, .sp-view-btn').length) return;
    e.preventDefault();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);

    // Snap from CSS-transform centering to explicit px coords for drag math.
    // MUST cancel the CSS animation first — animation fill-mode has higher cascade
    // priority than inline styles, so transform:'none' alone won't override it.
    if (sheet.style.transform !== 'none') {
        sheet.style.animation = 'none';           // kill fill-mode translateX(-50%)
        const snap = sheet.getBoundingClientRect(); // read with CSS transform still active
        sheet.style.transform = 'none';
        sheet.style.right     = 'auto';
        sheet.style.left      = snap.left + 'px';
        sheet.style.top       = snap.top  + 'px';
    }

    const cx   = e.touches ? e.touches[0].clientX : e.clientX;
    const cy   = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = sheet.getBoundingClientRect(); // read AFTER snap
    dragState  = { startX: cx, startY: cy, origLeft: rect.left, origTop: rect.top };

    $(document).on('mousemove.spdrag', onDragMove).on('mouseup.spdrag', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend',  onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grabbing');
}

function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const left = Math.max(0, Math.min(dragState.origLeft + cx - dragState.startX, window.innerWidth  - sheet.offsetWidth));
    const top  = Math.max(0, Math.min(dragState.origTop  + cy - dragState.startY, window.innerHeight - 60));
    sheet.style.left  = left + 'px';
    sheet.style.top   = top  + 'px';
    sheet.style.right = 'auto';
}

function onDragEnd() {
    if (!dragState) return;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const rect  = sheet.getBoundingClientRect();
    if (!isMobile()) {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    }
    dragState = null;
    $(document).off('mousemove.spdrag mouseup.spdrag');
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend',  onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grab');
}

// ─── Resize ───────────────────────────────────────────────────────────────────

function onResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
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
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        const w = Math.max(280, Math.min(window.innerWidth - 10, resizeState.origW + cx - resizeState.startX));
        const h = Math.max(300, Math.min(window.innerHeight - 10, resizeState.origH + cy - resizeState.startY));
        sheet.style.width     = w + 'px';
        sheet.style.height    = h + 'px';
        sheet.style.maxHeight = h + 'px';
    });
}

function onResizeEnd() {
    if (!resizeState) return;
    if (resizeRAF) { cancelAnimationFrame(resizeRAF); resizeRAF = null; }
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
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
    const el = document.getElementById('sp-outline-chat');
    if (el) el.style.height = h + 'px';
}

function restorePositionAndSize() {
    setTimeout(() => {
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        if (!sheet) return;
        const pos  = JSON.parse(localStorage.getItem(POS_KEY)  || 'null');
        const size = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
        if (pos) {
            sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
            sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
            sheet.style.right = 'auto';
        }
        if (size) {
            sheet.style.width     = size.width  + 'px';
            sheet.style.height    = size.height + 'px';
            sheet.style.maxHeight = size.height + 'px';
        }
    }, 0);
}

function positionPanel() {
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (!sheet) return;
    if (isMobile()) {
        sheet.style.left      = '';
        sheet.style.top       = '';
        sheet.style.right     = '';
        sheet.style.transform = '';
        syncMobileViewport();
        bindViewportSync();
        return;
    }
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
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
    const root = document.getElementById(MODAL_ID);
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (!root || !sheet || root.style.display === 'none') return;

    const vv = window.visualViewport;
    const vh = Math.max(320, Math.round((vv?.height || window.innerHeight)));
    const top = 70;
    const bottomGap = 20;
    const maxH = Math.max(260, vh - top - bottomGap);

    sheet.style.top = `${top}px`;
    sheet.style.maxHeight = `${maxH}px`;
}

// ─── Toast (top) ──────────────────────────────────────────────────────────────

function injectToastContainer() {
    if (!$('#sp-toast-wrap').length) document.documentElement.insertAdjacentHTML('beforeend', '<div id="sp-toast-wrap"></div>');
}

function showToast(msg, onClick, isError = false) {
    const $t = $(`<div class="sp-toast${isError ? ' sp-toast-error' : ''}">
        <i class="fa-solid ${isError ? 'fa-circle-exclamation' : 'fa-calendar-check'}"></i>
        <span>${escapeHtml(msg)}</span>
    </div>`);
    $('#sp-toast-wrap').append($t);
    requestAnimationFrame(() => $t.addClass('sp-toast-show'));
    if (onClick) $t.css('cursor', 'pointer').on('click', () => { onClick(); $t.remove(); });
    setTimeout(() => { $t.removeClass('sp-toast-show'); setTimeout(() => $t.remove(), 350); }, 4000);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const TYPE_META = {
    main  : { icon: 'fa-bolt',      label: '明线', cls: 'sp-type-world'     },
    hidden: { icon: 'fa-eye-slash', label: '暗线', cls: 'sp-type-major'     },
    bond  : { icon: 'fa-heart',     label: '红线', cls: 'sp-type-character' },
};

function renderSchedule(raw, userName, perspective = 'user') {
    const { days, future, startDate } = parseCalendar(raw);
    const hasFuture = future && future.events.length > 0;
    if (days.length === 0 && !hasFuture) return `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;

    const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
    const totalTabs = days.length + (hasFuture ? 1 : 0);
    const chipCls   = perspective === 'char' ? 'sp-char-chip' : 'sp-user-chip';

    const header = `<div class="sp-schedule-header">
        <span class="${chipCls}">${escapeHtml(userName)}</span>
        <span class="sp-schedule-label">的日程</span>
        <button class="sp-panel-refresh sp-refresh-schedule" title="重新生成日程"><i class="fa-solid fa-rotate-right"></i></button>
    </div>`;

    const tabs = days.map((_, i) => {
        let numLabel = String(i + 1);
        let wdLabel = '';
        if (startDate) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            wdLabel  = WEEKDAYS[d.getDay()];
            numLabel = `${d.getMonth() + 1}/${d.getDate()}`;
        }
        return `<button class="sp-tab${i === 0 ? ' sp-tab-active' : ''}" data-day="${i}">
            <span class="sp-tab-num">${numLabel}</span>
            ${wdLabel ? `<span class="sp-tab-wd">${wdLabel}</span>` : ''}
        </button>`;
    });
    if (hasFuture) tabs.push(`<button class="sp-tab" data-day="${days.length}">
        <span class="sp-tab-num">未来</span>
    </button>`);

    const panels = days.map(day =>
        `<div class="sp-day-panel" style="width:calc(100%/${totalTabs})">${day.events.map(renderEvent).join('')}</div>`
    );
    if (hasFuture) panels.push(
        `<div class="sp-day-panel sp-future-panel" style="width:calc(100%/${totalTabs})">${future.events.map(renderEvent).join('')}</div>`
    );

    const debug = days.length < 3 ? `
        <details class="sp-debug"><summary>⚠ 仅解析到 ${days.length} 天</summary>
        <pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>` : '';

    return `${header}<div class="sp-tab-bar" data-total="${totalTabs}">${tabs.join('')}</div>
        <div class="sp-days-wrap"><div class="sp-days-track" data-total="${totalTabs}" style="width:${totalTabs * 100}%">${panels.join('')}</div></div>${debug}`;
}

function parseCalendar(raw) {
    const m = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const content = m ? m[1] : raw;

    const dateMatch = content.match(/^StartDate:\s*(\d{4}-\d{2}-\d{2})/m);
    let startDate = null;
    if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) startDate = d;
    }

    const days = []; let cur = null; let inFuture = false; let future = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('<!--')) continue;
        if (/^Day\s*:?\s*\d+/i.test(t) || /^第[一二三四五六七\d]+天/.test(t)) {
            if (cur && !inFuture) days.push(cur);
            cur = { events: [] }; inFuture = false; continue;
        }
        if (/^Future\s*:/i.test(t) || /^未来\s*:/i.test(t)) {
            if (cur && !inFuture) days.push(cur);
            future = { events: [] }; cur = future; inFuture = true; continue;
        }
        if (/^Event\s*:/i.test(t)) {
            if (!cur) cur = { events: [] };
            const parts = t.replace(/^Event\s*:\s*/i, '').split('|');
            if (parts.length >= 4) cur.events.push({
                type: (parts[0]||'user').trim().toLowerCase(), title: (parts[1]||'').trim(),
                desc: (parts[2]||'').trim(), time: (parts[3]||'').trim(),
                location: (parts[4]||'').trim(), npcAction: (parts[5]||'').trim(),
            });
        }
    }
    if (cur && !inFuture) days.push(cur);
    return { days: days.filter(d => d.events.length > 0), future, startDate };
}

function renderEvent(ev) {
    const meta = TYPE_META[ev.type] || TYPE_META.main;
    const injectParts = ['【日程参考】'];
    if (ev.time) injectParts.push(`时间：${ev.time}`);
    injectParts.push(ev.title);
    if (ev.desc)      injectParts.push(ev.desc);
    if (ev.location)  injectParts.push(`地点：${ev.location}`);
    if (ev.npcAction) injectParts.push(`线头：${ev.npcAction}`);
    const injectBtn = makeInjectBtn(injectParts.join('\n'));
    return `<div class="sp-event ${meta.cls}">
        <div class="sp-event-head">
            <span class="sp-type-badge"><i class="fa-solid ${meta.icon}"></i>${escapeHtml(meta.label)}</span>
            <span class="sp-event-title">${escapeHtml(ev.title)}</span>
            ${ev.time ? `<span class="sp-event-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(ev.time)}</span>` : ''}
            ${injectBtn}
        </div>
        ${ev.desc ? `<p class="sp-event-desc">${escapeHtml(ev.desc)}</p>` : ''}
        <div class="sp-event-meta">
            ${ev.location  ? `<span class="sp-event-loc"><i class="fa-solid fa-location-dot"></i>${escapeHtml(ev.location)}</span>` : ''}
            ${ev.npcAction ? `<span class="sp-event-npc"><i class="fa-solid fa-link"></i>${escapeHtml(ev.npcAction)}</span>` : ''}
        </div>
    </div>`;
}

function escapeHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeAttr(s)  { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function cleanText(s) {
    return String(s)
        .replace(/<ruby[^>]*>[\s\S]*?<\/ruby>/gi, (m) =>
            m.replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '').replace(/<\/?ruby[^>]*>/gi, ''))
        .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}

