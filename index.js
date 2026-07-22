import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt, eventSource, event_types, substituteParams, saveSettingsDebounced } from '../../../../script.js';
import {
    buildCreativeChatHistoryKey,
    buildCreativeChatSystemPrompt,
    buildOutlineCacheKey as buildOutlineScopedCacheKey,
    buildScheduleCacheKey,
    buildStorylinesCacheKey as buildLinesScopedCacheKey,
    buildSpaceChatHistoryKey,
    buildSpaceChatSystemPrompt,
    getCreativeChatPlaceholder,
    getSpaceChatPlaceholder,
} from './state.js';
import * as memory from './memory.js';

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
    themeMode: 'auto',   // 'auto' | 'day' | 'night' — 'auto' follows ST theme; day/night force
    linesEnabled : true, // master switch: false disables both auto-advance AND inline block rendering
    linesInterval: 2,
    linesMode: 'turns',  // 'turns' | 'days'
    // Memory system
    memoryEnabled  : true,
    memoryL0Group  : 5,    // AI floors per L0 entry
    memoryL1Group  : 10,   // L0 entries per L1 chapter
    memorySkipShort: 50,   // skip AI floors shorter than N chars
    useBaiBaiBook  : false, // if true, pull history from 柏宝书 getInjectedHistory() and skip built-in memory entirely
    // Tag sanitizer (used by memory.js:stripTags AND anywhere else that reads
    // AI floor content). Both are comma-separated bare tag names (no <>).
    keepTags       : 'content',  // protect list — contents inside these tags survive stripping
    extraTags      : '',         // extra strip list — forcibly delete these tags + their content
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

// Resolve the effective theme by combining the user's themeMode setting
// with the detected ST theme. 'auto' follows ST (transparent-theme users get
// the day/night fallback via explicit modes instead).
function getEffectiveTheme() {
    const mode = getSettings().themeMode || 'auto';
    if (mode === 'day' || mode === 'night') return mode;
    return detectSTTheme();
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
let spaceMode           = false;
let spaceChatHistory    = [];
let isSpaceChatting     = false;
let spaceChatAbortController = null;
let linesAiMsgCounter   = 0;   // counts AI messages since last lines advancement
let scheduleAbortController = null;
let outlineAbortController  = null;
const _injectTexts      = {};
let   _injectIdSeq      = 0;
let viewportSyncBound   = false;

const isMobile = () => window.innerWidth <= 640;

// ─── Init ─────────────────────────────────────────────────────────────────────

// Module-level handles so hot-reload / re-init doesn't double-register.
// If the module loads again in the same page (rare but possible with ST's
// dev workflows), we need to be able to unregister and rewire cleanly.
let _themeObserver = null;
const _stListeners = { chat: null, char: null };

jQuery(async () => {
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
                useBaiBaiBook  : !!s.useBaiBaiBook,
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
    // Back-fill inline blocks for any messages already rendered at startup
    setTimeout(backfillLinesInlineBlocks, 800);
    // Reset view state and reload cache on chat switch
    if (_stListeners.chat) eventSource.removeListener?.(event_types.CHAT_CHANGED, _stListeners.chat);
    _stListeners.chat = () => {
        currentView  = 'user';
        charViewName = null;
        outlineMode  = false;
        cachedOutline = null;
        outlineChatHistory = [];
        outlineChatAbortController?.abort();
        outlineChatAbortController = null;
        linesMode    = false;
        cachedLines  = null;
        linesAiMsgCounter = 0;
        _lastDetectedDay  = null;   // days-mode: reset day tracker on chat switch
        spaceMode = false;
        spaceChatHistory = [];
        spaceChatAbortController?.abort();
        spaceChatAbortController = null;
        $('.sp-side-tab.sp-view-btn').removeClass('sp-view-active');
        $(`.sp-side-tab.sp-view-btn[data-view="schedule"]`).addClass('sp-view-active');
        $('.sp-sub-btn').removeClass('sp-view-active');
        $(`.sp-sub-btn[data-view="user"]`).addClass('sp-view-active');
        $('#sp-sub-toggle').show();
        $('#sp-content-title').text('点');
        cachedSchedule = loadCachedForCurrentChat();
        if ($(`#${MODAL_ID}`).is(':visible') && !isGenerating) {
            $('#sp-outline-wrap').hide();
            $('#sp-lines-wrap').hide();
            $('#sp-space-wrap').hide();
            $('#sp-body').show();
            $(`#${MODAL_ID} .sp-outline-btn`).removeClass('sp-btn-active');
            updateCreativeChatModeUI();
            $('#sp-chat-msgs').empty();
            $('#sp-space-msgs').empty();
            if (cachedSchedule) setBody(cachedSchedule);
            else setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>还没有点</p><button class="sp-gen-btn" id="sp-gen-schedule-now">生成点</button></div>`);
        }
        // Back-fill inline blocks for newly loaded chat
        setTimeout(backfillLinesInlineBlocks, 300);
        // Surface memory schema-migration notice, if any (once per upgraded chat)
        setTimeout(checkMemoryMigrationNotice, 500);
    };
    eventSource.on(event_types.CHAT_CHANGED, _stListeners.chat);
    // Auto-advance storylines, then append inline block to every AI message.
    // NOTE: shouldAdvance triggers generation BEFORE appending the current block,
    // so the current (newest, still-unstable) message is NOT included in the LLM
    // context. The advance fires when the PREVIOUS message tips the counter over,
    // and this message just gets the freshly-generated result injected.
    if (_stListeners.char) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.char);
    _stListeners.char = async (messageId) => {
        // Master switch: linesEnabled=false disables auto-advance + inline block
        if (getSettings().linesEnabled === false) return;
        let shouldAdvance = false;
        if (getLinesMode() === 'days') {
            shouldAdvance = detectInGameDayChange(messageId, /* excludeCurrent */ true);
        } else {
            const interval = getLinesInterval();
            if (linesAiMsgCounter >= interval) { linesAiMsgCounter = 0; shouldAdvance = true; }
            linesAiMsgCounter++;
        }
        appendLinesInlineBlock(messageId, shouldAdvance);
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.char);
    // Track ST theme changes via MutationObserver on documentElement style
    _themeObserver?.disconnect();
    _themeObserver = new MutationObserver(() => {
        // Only auto mode follows ST; forced day/night ignores ST changes.
        if ((getSettings().themeMode || 'auto') !== 'auto') return;
        const t = detectSTTheme();
        if (t !== currentTheme) applyTheme(t);
    });
    _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
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

// ─── In-game day-change detection (via 柏宝书 API) ─────────────────────────────
// Reads authoritative in-game time from 柏宝书 (ST-BaiBai-Book) instead of
// grepping message text — the old regex heuristic false-positived on every
// mention of 今天/明天/周X. Extracts a canonical day key from state.time and
// signals advance only when it actually changes.
let _lastDetectedDay = null;
let _bbbWarned       = false;

// 中文数字 → 阿拉伯数字（覆盖 0–99，足以处理古代年月日）。
const _CN_NUM_MAP = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 };
const _CN_MONTH_ALIAS = { 正:1, 冬:11, 腊:12 };

function _cnToNumber(s) {
    if (!s) return null;
    if (s === '元') return 1;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.length === 1) return _CN_NUM_MAP[s] ?? null;
    if (s.includes('十')) {
        const [a, b] = s.split('十');
        const tens = a === '' ? 1 : _CN_NUM_MAP[a];
        const ones = b === '' ? 0 : _CN_NUM_MAP[b];
        if (tens != null && ones != null) return tens * 10 + ones;
    }
    return null;
}

// 抽出"这一天"的规范化 key。剥掉 era 前缀、时分秒尾巴以及数字前导零，
// 让同一天不同写法（"1287/04/01" ≡ "1287/4/1" ≡ "1287年4月1日"）落到同一
// 个 key 上。返回 null 表示无法识别 → 不推进。
function extractDayFromTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    let m;
    // 阿拉伯：YYYY年M月D日
    if ((m = timeStr.match(/(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/))) return `${+m[1]}-${+m[2]}-${+m[3]}`;
    // 阿拉伯：YYYY/M/D、YYYY-M-D、YYYY.M.D
    if ((m = timeStr.match(/(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/))) return `${+m[1]}-${+m[2]}-${+m[3]}`;
    // 相对天数：第N天/日
    if ((m = timeStr.match(/第\s*(\d+)\s*[天日]/))) return `day-${+m[1]}`;
    // day N
    if ((m = timeStr.match(/day\s*(\d+)/i))) return `day-${+m[1]}`;
    // 古代中文：<cn年>年<cn月/正/冬/腊>月<初X/cn日>[日]?
    m = timeStr.match(/(元|[零〇一二两三四五六七八九十]+)\s*年\s*(正|冬|腊|[零〇一二两三四五六七八九十]+)\s*月\s*(初[零〇一二两三四五六七八九十]|[零〇一二两三四五六七八九十]+)/);
    if (m) {
        const year  = _cnToNumber(m[1]);
        const month = (m[2] in _CN_MONTH_ALIAS) ? _CN_MONTH_ALIAS[m[2]] : _cnToNumber(m[2]);
        const day   = m[3].startsWith('初') ? _cnToNumber(m[3].slice(1)) : _cnToNumber(m[3]);
        if (year != null && month != null && day != null) return `cn-${year}-${month}-${day}`;
    }
    return null;
}

function detectInGameDayChange(messageId, excludeCurrent = false) {
    const api = globalThis.STBaiBaiBook;
    if (!api || typeof api.getSnapshot !== 'function') {
        if (!_bbbWarned) {
            _bbbWarned = true;
            console.info('[7dayscal] STBaiBaiBook 未就绪，days 模式不自动推进');
        }
        return false;
    }

    const msgs = getContext().chat || [];
    const aiFloors = [];
    for (let i = 0; i < msgs.length; i++) if (!msgs[i].is_user) aiFloors.push(i);
    if (aiFloors.length < (excludeCurrent ? 2 : 1)) return false;

    // 与旧实现一致：excludeCurrent=true 时读上一条 AI 楼的状态，避开
    // 刚渲染完的这一条（"advance BEFORE current message enters context"）。
    const targetFloor = excludeCurrent
        ? aiFloors[aiFloors.length - 2]
        : aiFloors[aiFloors.length - 1];

    let snapshot;
    try {
        snapshot = api.getSnapshot({ floor: targetFloor, at: 'after' });
    } catch {
        return false;
    }

    const day = extractDayFromTime(snapshot?.state?.time);
    if (!day) return false;

    if (day !== _lastDetectedDay) {
        _lastDetectedDay = day;
        return true;
    }
    return false;
}

// ─── Storylines inline block (appended to AI messages) ────────────────────────

function _buildLinesBlockHtml() {
    const raw = (() => {
        try {
            const key = getLinesCacheKey();
            const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
            return saved?.raw || '';
        } catch { return ''; }
    })();
    const lines = raw ? parseLines(raw) : [];
    if (lines.length) {
        const linesHtml = lines.map(l => {
            const levelNum = parseInt(l.level, 10);
            const level    = Number.isFinite(levelNum) ? Math.max(1, Math.min(4, levelNum)) : 1;
            const stageColor = STAGE_COLORS[l.stage] || '#9aa6b2';
            const beadsHtml = Array.from({length: 4}, (_, i) =>
                `<span class="sp-bead${i < level ? ' sp-bead-on' : ''}" style="${i < level ? `background:${stageColor}` : ''}"></span>`
            ).join('');
            // Per-line inject button — parallels the one in the outer panel (renderLines)
            const injectParts = [`【线参考】${l.name}（${l.type}·${l.stage}${l.stall ? '·停滞' : ''}）`];
            if (l.desc) injectParts.push(l.desc);
            if (l.next) injectParts.push((l.stall ? '恢复条件：' : '下一步：') + l.next);
            const injectBtn = makeInjectBtn(injectParts.join('\n'));
            return `<div class="sp-inline-line${l.stall ? ' sp-line-stall' : ''}" style="border-left:3px solid ${stageColor}20">
                <div class="sp-inline-head">
                    <span class="sp-inline-stage" style="color:${stageColor}">${escapeHtml(l.stage)}</span>
                    ${l.type ? `<span class="sp-inline-type">${escapeHtml(l.type)}</span>` : ''}
                    <span class="sp-inline-dots">${beadsHtml}</span>
                    ${l.when ? `<span class="sp-inline-when">${escapeHtml(l.when)}</span>` : ''}
                    ${l.stall ? `<span class="sp-line-stall-tag sp-inline-stall">停滞</span>` : ''}
                    ${agencyBadge(l.agency)}
                    ${injectBtn}
                </div>
                <div class="sp-inline-name">${escapeHtml(l.name)}</div>
                ${l.desc ? `<div class="sp-inline-desc">${escapeHtml(cleanText(l.desc))}</div>` : ''}
                ${l.next ? `<div class="sp-line-next sp-inline-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}">
                    <span class="sp-line-next-tag">${l.stall ? '⏸ 恢复条件' : '→ 下一步'}</span>
                    <span class="sp-line-next-text">${escapeHtml(cleanText(l.next))}</span>
                </div>` : ''}
            </div>`;
        }).join('');
        return `<summary class="sp-inline-summary"><span class="sp-inline-title">线</span><span class="sp-inline-count">${lines.length} 条活跃</span></summary><div class="sp-inline-body">${linesHtml}</div>`;
    }
    return `<summary class="sp-inline-summary"><span class="sp-inline-title">线</span><span class="sp-inline-count sp-inline-empty">暂无</span></summary>`;
}

// Remove inline lines block from ALL AI messages — enforces "only the latest floor holds it".
function _removeAllInlineBlocks() {
    document.querySelectorAll('#chat .sp-lines-inline').forEach(el => el.remove());
}

async function appendLinesInlineBlock(messageId, shouldAdvance) {
    const msgEl = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!msgEl) return;

    // Enforce single-copy: nuke any prior inline block on any floor (including this one)
    _removeAllInlineBlocks();

    // Immediately render current cached state so the block always appears
    const block = document.createElement('details');
    block.className = 'sp-lines-inline';
    block.innerHTML = _buildLinesBlockHtml();
    msgEl.appendChild(block);

    // If we need to advance, run generation and then update the same block in-place
    const cfg = loadCfg();
    if (shouldAdvance && !isGeneratingLines && cfg.url && cfg.key) {
        await runGenerateLines(true /* silent */);
        // Re-render into the same block element (it may still be in the DOM)
        if (block.isConnected) {
            block.innerHTML = _buildLinesBlockHtml();
        }
    }
}

// Back-fill: only pin the latest AI message — history doesn't need stale snapshots.
async function backfillLinesInlineBlocks() {
    _removeAllInlineBlocks();  // clean up any accumulated blocks from previous state
    if (getSettings().linesEnabled === false) return;   // master switch off: leave chat clean
    const lastMesEl = [...document.querySelectorAll('#chat .mes:not([is_user="true"])')].at(-1);
    if (!lastMesEl) return;
    const mesId = lastMesEl.getAttribute('mesid');
    if (mesId == null) return;
    const msgEl = lastMesEl.querySelector('.mes_text');
    if (!msgEl) return;
    await appendLinesInlineBlock(mesId, false);
}

// Refresh the inline block on the latest AI message using current cache.
// Called after the panel regenerates lines so the message-level block doesn't
// stay stale until page reload.
function syncLatestInlineBlock(expectedChatId = null) {
    // If caller passed a chatId snapshot, skip when chat changed mid-flight
    if (expectedChatId != null && getContext().chatId !== expectedChatId) return;
    _removeAllInlineBlocks();
    const lastMesEl = [...document.querySelectorAll('#chat .mes:not([is_user="true"])')].at(-1);
    if (!lastMesEl) return;
    const msgEl = lastMesEl.querySelector('.mes_text');
    if (!msgEl) return;
    const block = document.createElement('details');
    block.className = 'sp-lines-inline';
    block.innerHTML = _buildLinesBlockHtml();
    msgEl.appendChild(block);
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

function setExtBtnState(state) {
    const $wandBtn = $('#sp_open_wand');
    $wandBtn.removeClass('sp-btn-generating sp-btn-done');
    if (state) $wandBtn.addClass(`sp-btn-${state}`);

    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
    $('.sp-sub-toggle, .sp-sidebar-tabs').toggleClass('sp-locked', state === 'generating');
}

// ─── FAB ─────────────────────────────────────────────────────────────────────

function injectFab() {
    const savedPos = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
    const mobile = isMobile();
    const posStyle = (!mobile && savedPos)
        ? `left:${savedPos.left}px;top:${savedPos.top}px;right:auto;bottom:auto;`
        : '';
    const html = `<div id="${FAB_ID}" style="position:fixed;z-index:2000000;${posStyle}${fabEnabled() ? '' : 'display:none'}">
        <button class="sp-fab-btn sp-${currentTheme}" title="构画"
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
                         sheet.style.transform = ''; sheet.style.width = ''; sheet.style.height = '';
                         sheet.style.maxHeight = ''; sheet.style.maxWidth = ''; }
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
                <aside class="sp-sidebar">
                    <nav class="sp-sidebar-tabs" aria-label="主视图">
                        <button class="sp-side-tab sp-view-btn sp-view-active" data-view="schedule">
                            <span class="sp-tab-glyph" aria-hidden="true">▤</span>
                            <span class="sp-tab-label">点</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="lines">
                            <span class="sp-tab-glyph" aria-hidden="true">⁝</span>
                            <span class="sp-tab-label">线</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="outline">
                            <span class="sp-tab-glyph" aria-hidden="true">¶</span>
                            <span class="sp-tab-label">面</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="space">
                            <span class="sp-tab-glyph" aria-hidden="true">‖</span>
                            <span class="sp-tab-label">间</span>
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
                        <div class="sp-sub-toggle" id="sp-sub-toggle">
                            <button class="sp-view-btn sp-sub-btn sp-view-active" data-view="user">我</button>
                            <button class="sp-view-btn sp-sub-btn" data-view="char">TA</button>
                        </div>
                        <div class="sp-head-tools">
                            <button class="sp-icon-btn sp-theme-toggle-btn" title="${themeToggleTitle()}"><i class="fa-solid ${themeToggleIcon()}"></i></button>
                            <button class="sp-icon-btn sp-fab-toggle-btn${fabEnabled() ? ' sp-btn-active' : ''}" title="悬浮按钮"><i class="fa-regular fa-circle-dot"></i></button>
                            <button class="sp-icon-btn sp-close-btn"    title="关闭"><i class="fa-solid fa-xmark" style="font-size:1rem"></i></button>
                        </div>
                    </header>

                    <!-- Settings overlay: covers content-col only, sidebar stays visible -->
                    <div id="sp-settings-overlay" class="sp-settings-overlay" style="display:none">
                        <div class="sp-settings-header">
                            <span class="sp-settings-title"><i class="fa-solid fa-gear"></i> 设置</span>
                            <button class="sp-icon-btn sp-settings-close-btn" title="关闭设置"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        <div class="sp-settings-body">

                            <!-- Section 1: API -->
                            <details class="sp-settings-section" open>
                                <summary class="sp-settings-section-title">API 配置</summary>
                                <div class="sp-settings-section-body">
                                    <div class="sp-api-notice ${hasCustomApi ? 'sp-notice-ok' : 'sp-notice-warn'}">
                                        <i class="fa-solid ${hasCustomApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                                        ${hasCustomApi
                                            ? '已配置独立 API，后台生成不影响聊天'
                                            : '未配置独立 API：生成期间将<b>占用聊天通道</b>，无法同时聊天'}
                                    </div>
                                    <p class="sp-cfg-hint">留空则使用酒馆当前模型</p>
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
                                </div>
                            </details>

                            <!-- Section 2: 功能设置 -->
                            <details class="sp-settings-section">
                                <summary class="sp-settings-section-title">功能设置</summary>
                                <div class="sp-settings-section-body">
                                    <label class="sp-mode-opt">
                                        <input type="checkbox" id="sp-lines-enabled" ${getSettings().linesEnabled !== false ? 'checked' : ''}>
                                        <span>启用平行事件（线）</span>
                                    </label>
                                    <p class="sp-cfg-hint" style="margin-top:2px">关闭后不再自动推进、也不再向楼层追加内联展示</p>

                                    <hr class="sp-mem-divider">

                                    <p class="sp-cfg-hint">平行事件推进策略</p>
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
                                    </div>

                                    <p class="sp-cfg-hint" id="sp-scale-hint" style="margin-top:14px">叙事尺度（按角色保存）</p>
                                    <div class="sp-mode-row" id="sp-scale-row">
                                        <!-- populated by refreshScaleRadio() when settings opens -->
                                    </div>
                                </div>
                            </details>

                            <!-- Section 3: 世界书筛选 -->
                            <details class="sp-settings-section" id="sp-wi-section">
                                <summary class="sp-settings-section-title">世界书筛选</summary>
                                <div class="sp-settings-section-body" id="sp-wi-body">
                                    <p class="sp-cfg-hint">识别角色卡关联和全局启用的所有世界书。勾选的条目会传给 AI，取消勾选则跳过。按角色卡保存。</p>
                                    <div id="sp-wi-list" class="sp-wi-list">
                                        <span class="sp-cfg-hint">（打开设置时自动加载）</span>
                                    </div>
                                </div>
                            </details>

                            <!-- Section 4: 故事记忆库 -->
                            <details class="sp-settings-section" id="sp-mem-section">
                                <summary class="sp-settings-section-title">故事记忆库</summary>
                                <div class="sp-settings-section-body" id="sp-mem-body">
                                    <label class="sp-mode-opt sp-mem-source-toggle">
                                        <input type="checkbox" id="sp-mem-source-bbb">
                                        <span>使用柏宝书作为记忆源</span>
                                    </label>
                                    <div id="sp-mem-bbb-status" class="sp-cfg-hint" style="display:none"></div>

                                    <div id="sp-mem-internal">
                                    <p class="sp-cfg-hint">
                                        对话时自动为每层楼生成客观摘要，供点 / 线 / 面 / 间生成时参考。
                                        随聊天存储（不占浏览器缓存）。最新一楼永不摘要，防重 roll。
                                    </p>

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

                                    <p class="sp-cfg-hint" style="margin-top:10px">
                                        标签清洗：读取 AI 楼层时的过滤规则。多个用英文逗号分隔，只写名字（如 <code>content</code>），不用带尖括号。
                                    </p>
                                    <div class="sp-mode-opt sp-tag-opt">
                                        <span>保留包裹符</span>
                                        <input id="sp-mem-keeptags" class="sp-input sp-tag-input" type="text" placeholder="content" value="">
                                    </div>
                                    <div class="sp-mode-opt sp-tag-opt">
                                        <span>剔除包裹符</span>
                                        <input id="sp-mem-extratags" class="sp-input sp-tag-input" type="text" placeholder="think,reasoning" value="">
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
                                    <input type="text" id="sp-chat-input" class="sp-input" placeholder="和 AI 讨论面…">
                                    <button id="sp-chat-send" class="sp-icon-btn" title="发送"><i class="fa-solid fa-paper-plane"></i></button>
                                </div>
                            </div>
                        </div>

                        <div class="sp-lines-wrap" id="sp-lines-wrap" style="display:none">
                            <div class="sp-lines-list" id="sp-lines-list">
                                <div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>还没有追踪的线，可以生成一版</p><button class="sp-gen-btn" id="sp-gen-lines-now">生成线</button></div>
                            </div>
                        </div>

                        <div class="sp-space-wrap sp-outline-chat" id="sp-space-wrap" style="display:none;flex-direction:column;flex:1;min-height:0">
                            <div class="sp-chat-msgs" id="sp-space-msgs"></div>
                            <div class="sp-chat-input-row">
                                <button id="sp-space-clear" class="sp-icon-btn" title="清空对话"><i class="fa-solid fa-broom"></i></button>
                                <input type="text" id="sp-space-input" class="sp-input" placeholder="局外聊聊：剧情、设定、关系、知识…">
                                <button id="sp-space-send" class="sp-icon-btn" title="发送"><i class="fa-solid fa-paper-plane"></i></button>
                            </div>
                        </div>
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
            </div>
        </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    if (cfg.key) $('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $(`#${MODAL_ID} .sp-close-btn`).on('click',    closePanel);
    $(`#${MODAL_ID} .sp-settings-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-settings-close-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-fab-toggle-btn`).on('click', function () {
        const nowEnabled = !fabEnabled();
        getSettings().fabShow = nowEnabled;
        saveSettingsDebounced();
        $(`#${FAB_ID}`).toggle(nowEnabled);
        $(this).toggleClass('sp-btn-active', nowEnabled);
    });
    $(`#${MODAL_ID} .sp-theme-toggle-btn`).on('click', cycleThemeMode);
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

    // Delete a single message (leaves the rest alone — user chose "just this one")
    $('#sp-chat-msgs').on('click', '.sp-chat-msg-delete', function () {
        if (isOutlineChatting) return;
        const idx = Number($(this).closest('.sp-chat-msg').attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= outlineChatHistory.length) return;
        outlineChatHistory.splice(idx, 1);
        saveCreativeChatHistory();
        renderCreativeChatHistory();
    });

    // Edit user message → inline editor
    $('#sp-chat-msgs').on('click', '.sp-chat-msg-edit', function () {
        if (isOutlineChatting) return;
        const $msg = $(this).closest('.sp-chat-msg');
        const idx  = Number($msg.attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= outlineChatHistory.length) return;
        startInlineEdit($msg, idx);
    });

    $('#sp-chat-clear').on('click', async () => {
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
        $('#sp-chat-msgs').empty();
    });

    // Space chat (间)
    function doSendSpaceChat() {
        const msg = $('#sp-space-input').val().trim();
        if (msg && !isSpaceChatting) { $('#sp-space-input').val(''); sendSpaceChat(msg); }
    }
    $('#sp-space-send').on('click', doSendSpaceChat);
    $('#sp-space-input').on('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendSpaceChat(); } });

    $('#sp-space-msgs').on('click', '.sp-chat-msg-delete', function () {
        if (isSpaceChatting) return;
        const idx = Number($(this).closest('.sp-chat-msg').attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= spaceChatHistory.length) return;
        spaceChatHistory.splice(idx, 1);
        saveSpaceChatHistory();
        renderSpaceChatHistory();
    });

    $('#sp-space-msgs').on('click', '.sp-chat-msg-edit', function () {
        if (isSpaceChatting) return;
        const $msg = $(this).closest('.sp-chat-msg');
        const idx  = Number($msg.attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= spaceChatHistory.length) return;
        startSpaceInlineEdit($msg, idx);
    });

    $('#sp-space-clear').on('click', async () => {
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
        $('#sp-space-msgs').empty();
    });
    $('#sp-outline-beats').on('click', '#sp-gen-outline-now', triggerGenerateOutline);
    $('#sp-lines-list').on('click', '#sp-gen-lines-now', triggerGenerateLines);
    $('#sp-body').on('click', '#sp-gen-schedule-now, .sp-refresh-schedule', onRegenClick);
    $('#sp-outline-beats').on('click', '.sp-refresh-outline', triggerGenerateOutline);
    $('#sp-lines-list').on('click', '.sp-refresh-lines', triggerGenerateLines);

    // Inject buttons (event delegation)
    $(`#sp-body, #sp-outline-wrap, #sp-lines-wrap, #chat`).on('click', '.sp-inject-btn', function () {
        const text = _injectTexts[$(this).data('iid')];
        if (text) injectToST(text);
    });

    // Abort buttons (event delegation)
    $('#sp-body').on('click', '#sp-abort-generate', () => scheduleAbortController?.abort());
    $('#sp-outline-beats').on('click', '#sp-abort-outline', () => outlineAbortController?.abort());
    $('#sp-lines-list').on('click', '#sp-abort-lines', () => linesAbortController?.abort());

    // Tab switching: sidebar (schedule/outline/lines) + sub-toggle (user/char)
    $(`#${MODAL_ID}`).on('click', '.sp-view-btn', function () {
        if (isGenerating) return;
        const view = $(this).data('view');
        if (!view) return;

        const $btn      = $(this);
        const isSideTab = $btn.hasClass('sp-side-tab');
        const isSubBtn  = $btn.hasClass('sp-sub-btn');

        // Update active state within the button's group
        if (isSideTab) {
            $('.sp-side-tab.sp-view-btn').removeClass('sp-view-active');
            $btn.addClass('sp-view-active');
        } else if (isSubBtn) {
            $('.sp-sub-btn').removeClass('sp-view-active');
            $btn.addClass('sp-view-active');
        }

        // Sidebar clicks
        if (isSideTab) {
            if (view === 'outline') {
                if (outlineMode) return;
                outlineMode = true;
                linesMode = false;
                spaceMode = false;
                $('#sp-body').hide();
                $('#sp-lines-wrap').hide();
                $('#sp-space-wrap').hide();
                $('#sp-outline-wrap').css('display', 'flex');
                $('#sp-sub-toggle').hide();
                $('#sp-content-title').text('面');
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
                spaceMode = false;
                $('#sp-body').hide();
                $('#sp-outline-wrap').hide();
                $('#sp-space-wrap').hide();
                $('#sp-lines-wrap').css('display', 'flex');
                $('#sp-sub-toggle').hide();
                $('#sp-content-title').text('线');
                cachedLines = loadCachedLinesForCurrentChat();
                if (cachedLines) setLinesBody(cachedLines);
                else setLinesBody(renderEmptyLinesState());
                return;
            }
            if (view === 'space') {
                if (spaceMode) return;
                spaceMode = true;
                outlineMode = false;
                linesMode = false;
                $('#sp-body').hide();
                $('#sp-outline-wrap').hide();
                $('#sp-lines-wrap').hide();
                $('#sp-space-wrap').css('display', 'flex');
                $('#sp-sub-toggle').hide();
                $('#sp-content-title').text('间');
                $('#sp-space-input').attr('placeholder', getSpaceChatPlaceholder());
                loadSpaceChatHistory();
                renderSpaceChatHistory();
                return;
            }
            // view === 'schedule' — leaving outline/lines/space, restore body
            if (outlineMode) { outlineMode = false; $('#sp-outline-wrap').hide(); }
            if (linesMode)   { linesMode   = false; $('#sp-lines-wrap').hide(); }
            if (spaceMode)   { spaceMode   = false; $('#sp-space-wrap').hide(); }
            $('#sp-body').show();
            $('#sp-sub-toggle').show();
            $('#sp-content-title').text('点');
            $('.sp-sub-btn').removeClass('sp-view-active');
            $(`.sp-sub-btn[data-view="${currentView}"]`).addClass('sp-view-active');
            return;
        }

        // Sub-toggle clicks: user / char (only meaningful when schedule mode)
        if (isSubBtn) {
            if (view === currentView) return;
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
            return;
        }
    });

    $('#sp-cfg-save').on('click',      saveSettings);
    $('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $('#sp-fetch-models').on('click',  fetchModels);
    // Master switch: apply immediately so the user sees inline blocks appear/
    // disappear the moment they toggle, not on next AI message.
    $('#sp-lines-enabled').on('change', function () {
        getSettings().linesEnabled = this.checked;
        saveSettingsDebounced();
        // Refresh chat area: on → back-fill latest floor with block; off → clear all
        backfillLinesInlineBlocks();
    });
    // Inline model list: pick an item → write to input + refresh active highlight
    $('#sp-model-list-items').on('click', '.sp-model-list-item', function () {
        const model = $(this).attr('data-model');
        $('#sp-cfg-model').val(model);
        $('.sp-model-list-item').removeClass('sp-model-list-item-active');
        $(this).addClass('sp-model-list-item-active');
    });
    // Inline model list: live-filter as user types
    $('#sp-model-list-search').on('input', function () {
        renderModelList(_cachedModels, $(this).val());
    });
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

    // Desktop drag: content header acts as the handle (like a title bar).
    // Skipped on mobile — near-fullscreen sheet doesn't move.
    const dragHandle = document.querySelector(`#${MODAL_ID} .sp-content-head`);
    if (dragHandle) {
        dragHandle.addEventListener('mousedown',  onDragStart);
        dragHandle.addEventListener('touchstart', onDragStart, { passive: false });
    }
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
    bindMemoryHandlers();
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
    else charViewName = null;   // switching away from char: clear stale name so cache keys can't leak
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
        <p class="sp-char-picker-hint"><i class="fa-solid fa-user-pen"></i> 输入要查看点的角色名</p>
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
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-circle-stop"></i>中止生成</button></div>`);
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
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-circle-stop"></i>中止生成</button></div>`);
    } else if (cachedSchedule) {
        setBody(cachedSchedule);
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
    // Dismiss any pending confirm — spConfirm's own handler will resolve(false)
    // via the click handler on the button we simulate here, but since panel close
    // is out-of-band, we just remove the overlay directly; the awaiting Promise
    // will get its CHAT_CHANGED escape hatch on next chat switch. If user reopens
    // without switching, they'll see the confirm was gone and click again.
    $('#sp-confirm .sp-confirm-cancel').trigger('click');
    $(`#${MODAL_ID}`).stop(true).animate({ opacity: 0 }, 150, function () {
        $(this).css('display', 'none');
    });
}

function setBody(html) { $('#sp-body').html(html); }

// ─── Memory pre-check helpers ─────────────────────────────────────────────────
// Show a one-time toast when memory schema migration wiped this chat's summaries.
// Called from CHAT_CHANGED and openSchedule so users see it on the next chat
// switch OR the first time they open the panel post-upgrade.
function checkMemoryMigrationNotice() {
    if (getSettings().useBaiBaiBook) return;      // 柏宝书用户不受影响
    const notice = memory.consumeMigrationNotice?.();
    if (!notice) return;
    const { l0Count, l1Count } = notice;
    const msg = `故事记忆库已升级：${l0Count} 段 L0 + ${l1Count} 章 L1 需重算（点此打开设置补齐）`;
    showToast(msg, () => {
        showPanel();
        if (!settingsOpen) toggleSettings();
        // Expand the memory section so the "补齐缺失" button is visible
        $('#sp-mem-section').attr('open', 'open');
    });
}

// Called by the three generation triggers (schedule/outline/lines).
// Returns a Promise<boolean>: true if user wants to continue, false if canceled.
async function memoryPreCheckConfirm() {
    // 柏宝书 mode: skip built-in report (its "pending" is meaningless here).
    // Instead, warn only if 柏宝书 itself says coverage is incomplete.
    if (getSettings().useBaiBaiBook) {
        const api = globalThis.STBaiBaiBook;
        if (!api || typeof api.getInjectedHistory !== 'function') {
            return spConfirm({
                title  : '柏宝书未就绪',
                body   : '当前选的是柏宝书记忆源，但检测不到柏宝书 API。\n继续生成会没有历史记忆注入。',
                note   : '可以先去插件面板启用柏宝书，或临时关掉本插件的"使用柏宝书作为记忆源"。',
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
    const report = memory.getHealthReport();
    // No memory data yet is OK (fresh chat) — only warn when there ARE issues
    const hasPending = report.pending > 0 || report.permaFailed > 0 || report.paused;
    if (!hasPending) return true;
    const lines = [];
    if (report.paused) lines.push('• 记忆系统已暂停（连续失败或单楼超过 3 次）');
    if (report.pending > 0)    lines.push(`• 有 ${report.pending} 楼待摘要`);
    if (report.permaFailed > 0) lines.push(`• 有 ${report.permaFailed} 楼摘要永久失败（需手动补齐）`);
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
        $('#sp-confirm').remove();
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            $ov.remove();
            eventSource.removeListener?.(event_types.CHAT_CHANGED, onExternalClose);
            resolve(v);
        };
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
        $(`#${MODAL_ID} .sp-sheet`).append($ov);
        eventSource.on(event_types.CHAT_CHANGED, onExternalClose);
    });
}

// Dynamic loading text: reflect whether memory is currently being built
function loadingHtml(baseText, abortId) {
    // 柏宝书 mode has no built-in background queue — never show "补全记忆" text.
    const busy = !getSettings().useBaiBaiBook && memory.isMemoryBusy();
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
    if (isGenerating) return;
    if (!await memoryPreCheckConfirm()) return;
    const key = getCacheKey();
    if (key) localStorage.removeItem(key);
    cachedSchedule = null;
    isGenerating = true;
    setExtBtnState('generating');
    if (!$(`#${MODAL_ID}`).is(':visible')) showPanel();
    setBody(loadingHtml('正在规划', 'sp-abort-generate'));
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
            else showToast('点已生成，点击查看', () => { showPanel(); setBody(html); });
        } else {
            showToast('点已生成，点击查看', () => {
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
        else showToast('点生成失败，请重试', null, true);
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

// Single fetch wrapper for all OpenAI-compatible /chat/completions calls.
async function postChatCompletion({ cfg, messages, maxTokens, temperature, signal = null } = {}) {
    if (!cfg?.url || !cfg?.key) throw new Error('API 未配置');
    const body = { model: cfg.model || 'gpt-4o-mini', messages };
    if (Number.isFinite(maxTokens))   body.max_tokens  = maxTokens;
    if (Number.isFinite(temperature)) body.temperature = temperature;
    const res = await fetch(`${cfg.url}/chat/completions`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body   : JSON.stringify(body),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return (await res.json()).choices?.[0]?.message?.content ?? '';
}

async function callCustomApi(ctx, prompt, cfg, userName, charName, signal = null) {
    const messages = await buildMessages(ctx, prompt, userName, charName);
    lastDebugPayload = { model: cfg.model || 'gpt-4o-mini', messages };
    return postChatCompletion({ cfg, messages, maxTokens: 4096, signal });
}

// Called by memory.js — minimal wrapper around user's configured API.
// Skips chat history / world info; just sends raw messages array through.
async function callMemoryApi(messages, signal = null) {
    return postChatCompletion({
        cfg: loadCfg(),
        messages,
        maxTokens: 800,     // summaries are short
        temperature: 0.3,   // low temp for factual extraction
        signal,
    });
}

// ─── World-info entry filter (per character) ──────────────────────────────────
// Stores disabled entry uids per character in extension_settings.
// Structure: extension_settings[PLUGIN_ID].wiFilter = { [characterId]: [key, ...] }
// where key = "worldName::uid" to survive re-imports and name collisions.

function getWiFilter() {
    const s = getSettings();
    if (!s.wiFilter) s.wiFilter = {};
    return s.wiFilter;
}

function getDisabledKeys(characterId) {
    if (!characterId) return new Set();
    return new Set(getWiFilter()[characterId] || []);
}

function setDisabledKeys(characterId, disabledSet) {
    if (!characterId) return;
    getWiFilter()[characterId] = [...disabledSet];
    saveSettingsDebounced();
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

function getScale(characterId) {
    if (characterId == null) return 'auto';
    const v = getScaleMap()[characterId];
    return SCALE_VALUES.includes(v) ? v : 'auto';
}

function setScale(characterId, value) {
    if (characterId == null) return;
    getScaleMap()[characterId] = SCALE_VALUES.includes(value) ? value : 'auto';
    saveSettingsDebounced();
}

// Resolve the list of world-book names to load for the current character.
// Priority: character.data.extensions.world (primary linked), then character_book.name.
function getLinkedWorldNames(ctx) {
    const names = new Set();
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const primary = String(char.data?.extensions?.world || '').trim();
    if (primary) names.add(primary);
    // Fallback: some cards only have the embedded name without linking
    const embeddedName = String(char.data?.character_book?.name || '').trim();
    if (embeddedName && !primary) names.add(embeddedName);
    return [...names];
}

// Global world-info names enabled in ST's right-panel WI selector.
// Uses the exposed getter ctx.chatWorldInfo.globalSelection when available.
function getGlobalWorldNames(ctx) {
    try {
        const globals = ctx?.chatWorldInfo?.globalSelection;
        return Array.isArray(globals) ? globals.filter(Boolean) : [];
    } catch { return []; }
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

    // 3. Global world-info (enabled via ST's WI panel — top-right世界书面板中间"启用"列表)
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

    return items;
}

async function buildWorldInfoContext(ctx) {
    const characterId = ctx.characterId;
    const disabledKeys = getDisabledKeys(characterId);
    const entries = await getCharBookEntries(ctx);
    const kept = entries
        .filter(e => !disabledKeys.has(e.key))
        .map(e => e.content)
        .filter(Boolean);
    if (!kept.length) return '';
    return `【世界书】\n${kept.join('\n\n')}`;
}

// Memory-source dispatcher. When useBaiBaiBook is on, read the same history text
// 柏宝书 injects into its own prompt; otherwise fall through to the built-in
// L0/L1 store. No fallback between the two — 柏宝书 mode either returns its
// history or nothing (empty prompt block).
function getMemText() {
    const s = getSettings();
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
            return api.getInjectedHistory()?.relativeText || '';
        } catch (err) {
            console.warn('[7dayscal] 柏宝书 getInjectedHistory 出错:', err);
            return '';
        }
    }
    return memory.getMemoryContext();
}

async function buildMessages(ctx, prompt, userName, charName) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const wiContext = await buildWorldInfoContext(ctx);

    // Story memory (Plan C: objective memory + view tag)
    const memText = getMemText();
    const memBlock = memText
        ? `【故事记忆库】以下由本插件在对话过程中自动生成的客观摘要，反映从最早到近期的关键事件与伏笔。请**优先信任记忆库描述**，即使它与角色卡/世界书中较早的描述冲突（因为记忆库记录了事件后的最新状态）。以 ${currentView === 'char' ? charName : userName} 的视角优先关注对其有意义的信息。\n\n${memText}`
        : '';

    const sys  = [
        `你是一位旁观者和叙事分析助手，负责以第三人称视角分析 ${userName} 与 ${charName} 的故事。`,
        `不要扮演任何角色，不要使用第一人称。所有输出必须以第三人称叙述。`,
        char.description ? `【${charName} 的背景资料】\n${char.description}` : '',
        char.personality ? `【性格】${char.personality}` : '',
        char.scenario    ? `【场景】${char.scenario}`    : '',
        wiContext,
        memBlock,
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
    outlineChatHistory.forEach((msg, idx) => {
        appendChatMsg(msg.role === 'assistant' ? 'ai' : msg.role, msg.content, idx);
    });
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

function appendChatMsg(role, content, historyIndex = null) {
    const display = content.replace(/<outline_widget[\s\S]*?<\/outline_widget>/gi, '[↑ 已生成新面]');
    const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
    const $msg = $('<div>').addClass(`sp-chat-msg ${cls}`);
    const canAct = role !== 'system' && Number.isInteger(historyIndex);
    if (canAct) $msg.attr('data-idx', historyIndex);
    const contentHtml = escapeHtml(display).replace(/\n/g, '<br>');
    if (canAct) {
        const editBtn = role === 'user'
            ? '<button class="sp-chat-msg-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>'
            : '';
        $msg.html(`<div class="sp-chat-msg-content">${contentHtml}</div>` +
                  `<div class="sp-chat-msg-actions">${editBtn}` +
                  `<button class="sp-chat-msg-delete" title="删除"><i class="fa-solid fa-trash"></i></button></div>`);
    } else {
        $msg.html(contentHtml);
    }
    $msg.appendTo('#sp-chat-msgs');
    const el = document.getElementById('sp-chat-msgs');
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
    const $dots = $('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking').text('…').appendTo('#sp-chat-msgs');
    const el = document.getElementById('sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
    try {
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); throw new Error('请先配置 API'); }
        const reply = await postChatCompletion({
            cfg,
            messages: await buildOutlineChatMessages(userMsg),
            maxTokens: 4096,
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
    const chatId = getContext().chatId;
    return buildSpaceChatHistoryKey(chatId, view ?? currentView, charName ?? charViewName);
}

function loadSpaceChatHistory(view, charName) {
    const key = getSpaceChatHistoryKey(view, charName);
    if (!key) { spaceChatHistory = []; return spaceChatHistory; }
    try {
        const saved = JSON.parse(localStorage.getItem(key) || '[]');
        spaceChatHistory = Array.isArray(saved) ? saved.filter(item => item?.role && item?.content) : [];
    } catch { spaceChatHistory = []; }
    return spaceChatHistory;
}

function saveSpaceChatHistory(view, charName) {
    const key = getSpaceChatHistoryKey(view, charName);
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(spaceChatHistory));
}

function renderSpaceChatHistory() {
    const $msgs = $('#sp-space-msgs');
    $msgs.empty();
    spaceChatHistory.forEach((msg, idx) => {
        appendSpaceChatMsg(msg.role === 'assistant' ? 'ai' : msg.role, msg.content, idx);
    });
}

function appendSpaceChatMsg(role, content, historyIndex = null) {
    const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
    const $msg = $('<div>').addClass(`sp-chat-msg ${cls}`);
    const canAct = role !== 'system' && Number.isInteger(historyIndex);
    if (canAct) $msg.attr('data-idx', historyIndex);
    const contentHtml = escapeHtml(content).replace(/\n/g, '<br>');
    if (canAct) {
        const editBtn = role === 'user'
            ? '<button class="sp-chat-msg-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>'
            : '';
        $msg.html(`<div class="sp-chat-msg-content">${contentHtml}</div>` +
                  `<div class="sp-chat-msg-actions">${editBtn}` +
                  `<button class="sp-chat-msg-delete" title="删除"><i class="fa-solid fa-trash"></i></button></div>`);
    } else {
        $msg.html(contentHtml);
    }
    $msg.appendTo('#sp-space-msgs');
    const el = document.getElementById('sp-space-msgs');
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

async function buildSpaceChatMessages(userMsg) {
    const ctx      = getContext();
    const userName = ctx.name1 || '用户';
    const charName = currentView === 'char' ? (charViewName || ctx.name2 || '角色') : (ctx.name2 || '角色');
    let outlineCtx = '';
    try {
        const key   = getOutlineCacheKey();
        const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) outlineCtx = saved.raw;
    } catch { /* ignore */ }
    const wiContext = await buildWorldInfoContext(ctx);
    const memText   = getMemText();
    const sys = buildSpaceChatSystemPrompt({
        userName,
        charName,
        outlineRaw: outlineCtx,
        wiContext,
        memText,
    });
    return [{ role: 'system', content: sys }, ...spaceChatHistory, { role: 'user', content: userMsg }];
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
    const $dots = $('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking').text('…').appendTo('#sp-space-msgs');
    const el = document.getElementById('sp-space-msgs');
    if (el) el.scrollTop = el.scrollHeight;
    try {
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); throw new Error('请先配置 API'); }
        const reply = await postChatCompletion({
            cfg,
            messages: await buildSpaceChatMessages(userMsg),
            maxTokens: 4096,
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




function renderEmptyOutlineState() {
    return `<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>当前还没有面，可以先直接聊天讨论，也可以生成一版面作为起点</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">生成面</button></div>`;
}

function setOutlineBody(html) { $('#sp-outline-beats').html(html); }

// ─── Outline generation ───────────────────────────────────────────────────────

async function triggerGenerateOutline() {
    if (isGeneratingOutline) return;
    if (!await memoryPreCheckConfirm()) return;
    const key = getOutlineCacheKey();
    if (key) localStorage.removeItem(key);
    cachedOutline = null;
    isGeneratingOutline = true;
    setOutlineBody(loadingHtml('正在构思面', 'sp-abort-outline'));
    runGenerateOutline();
}

async function runGenerateOutline() {
    const viewSnap = currentView;
    const charSnap = charViewName;
    const chatIdSnap = getContext().chatId;
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

        if (getContext().chatId !== chatIdSnap) {
            isGeneratingOutline = false;
            outlineAbortController = null;
            return;
        }

        const html     = renderOutline(raw);
        const cacheKey = getOutlineCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, ts: Date.now() }));
        isGeneratingOutline = false;
        outlineAbortController = null;
        cachedOutline = html;
        if (outlineMode) setOutlineBody(html);
        else showToast('面已生成，点击查看', () => {
            if (!outlineMode) $('.sp-view-btn[data-view="outline"]').trigger('click');
            showPanel();
        });
    } catch (err) {
        isGeneratingOutline = false;
        outlineAbortController = null;
        if (err.name === 'AbortError') {
            if (outlineMode && getContext().chatId === chatIdSnap) setOutlineBody(`<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>已中止</p></div>`);
            return;
        }
        if (getContext().chatId !== chatIdSnap) return;
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`;
        if (outlineMode) setOutlineBody(errHtml);
        else showToast('面生成失败，请重试', null, true);
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
    const toolbar = `<div class="sp-panel-toolbar"><button class="sp-panel-refresh sp-refresh-outline" title="重新生成面"><i class="fa-solid fa-rotate-right"></i></button></div>`;
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
    // If we parsed few beats but the raw has substantial content, LLM likely
    // deviated from format — surface it so the user isn't silently truncated.
    const rawTail = beats.length < 3
        ? `<details class="sp-debug"><summary>⚠ 仅解析到 ${beats.length} 个节点</summary><pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>`
        : '';
    return toolbar + cards + rawTail;
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
    return `<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>还没有追踪的线，可以生成一版</p><button class="sp-gen-btn" id="sp-gen-lines-now">生成线</button></div>`;
}

async function triggerGenerateLines() {
    if (isGeneratingLines) return;
    if (!await memoryPreCheckConfirm()) return;
    // Manual refresh: clear cache so LLM generates fresh instead of just echoing
    // the previous raw. Auto-advance path (CHARACTER_MESSAGE_RENDERED) calls
    // runGenerateLines(true) directly and preserves previousRaw for continuity.
    const key = getLinesCacheKey();
    if (key) localStorage.removeItem(key);
    cachedLines = null;
    isGeneratingLines = true;
    setLinesBody(loadingHtml('正在推演线', 'sp-abort-lines'));
    runGenerateLines();
}

async function runGenerateLines(silent = false) {
    const viewSnap = currentView;
    const charSnap = charViewName;
    const chatIdSnap = getContext().chatId;
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
        const prompt = buildLinesPrompt(userName, charName, viewSnap, previousRaw, getScale(ctx.characterId));
        const raw    = await callCustomApi(ctx, prompt, cfg, userName, charName, linesAbortController.signal);

        // Chat may have switched while we were awaiting; do not touch cache or UI in that case
        if (getContext().chatId !== chatIdSnap) {
            isGeneratingLines = false;
            linesAbortController = null;
            return;
        }

        const html   = renderLines(raw);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, ts: Date.now() }));
        isGeneratingLines = false;
        linesAbortController = null;
        cachedLines = html;
        // Panel body
        if (linesMode) setLinesBody(html);
        // Sync the inline block on the latest AI message — panel & inline share
        // the same cache; without this the message-level block shows stale data
        // until page reload.
        syncLatestInlineBlock(chatIdSnap);
        if (!linesMode && !silent) showToast('线已生成，点击查看', () => {
            if (!linesMode) $('.sp-view-btn[data-view="lines"]').trigger('click');
            showPanel();
        });
    } catch (err) {
        isGeneratingLines = false;
        linesAbortController = null;
        if (err.name === 'AbortError') {
            if (linesMode && getContext().chatId === chatIdSnap) setLinesBody(`<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>已中止</p></div>`);
            return;
        }
        if (!silent && getContext().chatId === chatIdSnap) {
            const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`;
            if (linesMode) setLinesBody(errHtml);
            else showToast('线生成失败，请重试', null, true);
        }
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
${scaleBlock}

事件线是独立于 ${subject} 直接行动之外、需要跨轮次持续追踪的主事项。每条属于两类之一：
- 冲突类 (conflict)：萌芽 → 发酵 → 逼近 → 已爆发（或已消散）
- 推进类 (progress)：筹备 → 执行 → 关键 → 已完成（或已失败）

【推进属性 agency（必填）】
- player：事件推进依赖 ${subject} 主动行动（如：${subject} 答应的委托、结下的关系、承接的事项）
- world：事件在世界 / 他人 / 环境层面自行演化，${subject} 不动它也会推进（具体举例请对齐上方"叙事尺度"块的类型）

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

【输出格式（严格遵守，三行都必须输出）】
<storylines_widget>
Line: 名称|类型(冲突/推进)|阶段|等级(1-4)|时间锚点(如"今天上午"/"三天后"，禁用"第N轮")|agency(player/world)|stall(true/false)
Desc: 描述当前状态、关键背景、涉及的人物势力及其立场（60-100字，写现在的样子，不要写"接下来会…"）
Next: **必须输出，不得省略**。一句话给出前瞻信号（20-40字）。stall=true 时写"恢复条件"（什么触发能重新推进）；stall=false 时写"下一步"（最可能的下一动作、下一阶段的催化事件、或即将出现的关键分岔）。
（每条事件线重复上面三行）
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
            const agencyRaw = (parts[5] || '').trim().toLowerCase();
            const stallRaw  = (parts[6] || '').trim().toLowerCase();
            cur = {
                name  : (parts[0] || '').trim(),
                type  : (parts[1] || '').trim(),
                stage : (parts[2] || '').trim(),
                level : (parts[3] || '').trim(),
                when  : (parts[4] || '').trim(),
                // Backward-compat migration: missing agency → 'world', missing stall → false
                agency: agencyRaw === 'player' ? 'player' : 'world',
                stall : stallRaw === 'true' || stallRaw === '1' || stallRaw === 'yes',
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

// ─── Agency SVG icons (person / globe) ────────────────────────────────────────
// Pure stroke, currentColor, 20×20 viewBox — inherits container text color.
const AGENCY_ICONS = {
    player: '<svg class="sp-agency-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="需推动"><circle cx="10" cy="7" r="3"/><path d="M4 17 c1-3 4-5 6-5 s5 2 6 5"/></svg>',
    world : '<svg class="sp-agency-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="自演化"><circle cx="10" cy="10" r="7"/><ellipse cx="10" cy="10" rx="3" ry="7"/><path d="M3 10 h14"/></svg>',
};
const AGENCY_LABELS = { player: '需推动', world: '自演化' };

function agencyBadge(agency) {
    const key = agency === 'player' ? 'player' : 'world';
    return `<span class="sp-agency-badge sp-agency-${key}" title="${AGENCY_LABELS[key]}">${AGENCY_ICONS[key]}</span>`;
}

const STAGE_COLORS = {
    萌芽: '#d6b85a', 发酵: '#d98a3d', 逼近: '#cf5f3f', 已爆发: '#b93f3f', 已消散: '#888888',
    筹备: '#7de9d9', 执行: '#58e8b3', 关键: '#2a8a5d', 已完成: '#1b5e3b', 已失败: '#888888',
};

function renderLines(raw) {
    const lines = parseLines(raw);
    const toolbar = `<div class="sp-schedule-header">
        <span class="sp-user-chip">平行事件</span>
        <button class="sp-panel-refresh sp-refresh-lines" title="重新生成线"><i class="fa-solid fa-rotate-right"></i></button>
    </div>`;
    if (lines.length === 0) return toolbar + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    const cards = lines.map(l => {
        const levelNum  = parseInt(l.level, 10);
        const level     = Number.isFinite(levelNum) ? Math.max(1, Math.min(4, levelNum)) : 1;
        const stageColor = STAGE_COLORS[l.stage] || '#9aa6b2';
        const beadsHtml = Array.from({length: 4}, (_, i) =>
            `<span class="sp-bead${i < level ? ' sp-bead-on' : ''}" style="${i < level ? `background:${stageColor}` : ''}"></span>`
        ).join('');
        const injectParts = [`【线参考】${l.name}（${l.type}·${l.stage}${l.stall ? '·停滞' : ''}）`];
        if (l.desc) injectParts.push(l.desc);
        if (l.next) injectParts.push((l.stall ? '恢复条件：' : '下一步：') + l.next);
        const injectBtn = makeInjectBtn(injectParts.join('\n'));
        const stallCls  = l.stall ? ' sp-line-stall' : '';
        const stallTag  = l.stall ? `<span class="sp-line-stall-tag">停滞</span>` : '';
        const nextRow   = l.next
            ? `<div class="sp-line-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}">
                    <span class="sp-line-next-tag">${l.stall ? '⏸ 恢复条件' : '→ 下一步'}</span>
                    <span class="sp-line-next-text">${escapeHtml(cleanText(l.next))}</span>
               </div>`
            : '';
        return `
        <div class="sp-beat sp-line-card${stallCls}" style="border-left:3px solid ${stageColor}30">
            <div class="sp-beat-head">
                <span class="sp-beat-type" style="color:${stageColor}">${escapeHtml(l.stage)}</span>
                ${l.type ? `<span class="sp-beat-line">${escapeHtml(l.type)}</span>` : ''}
                <span class="sp-beat-time">${beadsHtml}</span>
                ${l.when ? `<span class="sp-beat-time">${escapeHtml(l.when)}</span>` : ''}
                ${stallTag}
                ${agencyBadge(l.agency)}
                ${injectBtn}
            </div>
            <div class="sp-beat-title">${escapeHtml(l.name)}</div>
            ${l.desc ? `<div class="sp-beat-scene">${escapeHtml(cleanText(l.desc))}</div>` : ''}
            ${nextRow}
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

// Inline model list state — cached models from last fetch. Not persisted
// across page reloads (matches original <select> behavior — user re-fetches
// if they refresh). Lives only while the tab is open.
let _cachedModels = [];

function renderModelList(models, filter = '') {
    _cachedModels = Array.isArray(models) ? models : [];
    $('#sp-model-list-count').text(`已加载 ${_cachedModels.length} 个模型`);
    const q = filter.trim().toLowerCase();
    const shown = q ? _cachedModels.filter(m => m.toLowerCase().includes(q)) : _cachedModels;
    const current = ($('#sp-cfg-model').val() || '').trim();
    if (!shown.length) {
        $('#sp-model-list-items').html(`<div class="sp-model-list-empty">${q ? '无匹配项' : '暂无模型'}</div>`);
        return;
    }
    // Cap the initial render at 200 items with a "show more" tail for MASSIVE lists;
    // in practice most APIs return <200 so this is defensive.
    const html = shown.map(m =>
        `<button type="button" class="sp-model-list-item${m === current ? ' sp-model-list-item-active' : ''}" data-model="${escapeAttr(m)}">${escapeHtml(m)}</button>`
    ).join('');
    $('#sp-model-list-items').html(html);
}

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

        // Inline model list — no popup, no z-index chaos. Render directly into
        // the settings body's <details> section so any browser/WebView that can
        // render <button> can render this. Fixes "popup appears behind plugin"
        // reports from in-app browsers (WeChat/QQ WebView, etc.) that don't
        // give <select> the native fullscreen picker treatment.
        renderModelList(models);
        // Auto-expand so user sees the result of their action
        $('#sp-model-list-section').attr('open', 'open').show();
        showToast(`已加载 ${models.length} 个模型`);
    } catch (err) {
        showToast(`获取模型失败：${err.message}`, null, true);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-list"></i>');
    }
}

function toggleSettings() {
    settingsOpen = !settingsOpen;
    const $overlay = $('#sp-settings-overlay');
    if (settingsOpen) {
        renderWiList();     // async, fire-and-forget — fills list when done
        renderScaleRow();   // per-character scale radios (sync)
        renderMemorySection();   // memory status + settings sync
        $overlay.stop(true).css({ display: 'flex', opacity: 0 }).animate({ opacity: 1 }, 180);
    } else {
        $overlay.stop(true).animate({ opacity: 0 }, 150, function () { $(this).css('display', 'none'); });
    }
    $(`#${MODAL_ID} .sp-settings-btn`).toggleClass('sp-btn-active', settingsOpen);
    syncMobileViewport();
}

// ─── Memory section renderer + handlers ─────────────────────────────────────
function renderMemorySection() {
    const s = getSettings();
    const useBbb = !!s.useBaiBaiBook;
    $('#sp-mem-source-bbb').prop('checked', useBbb);
    if (useBbb) {
        $('#sp-mem-internal').hide();
        $('#sp-mem-bbb-status').show();
        const api = globalThis.STBaiBaiBook;
        if (api && typeof api.getInjectedHistory === 'function') {
            let coverageMsg = '柏宝书已就绪';
            try {
                const cov = api.getInjectedHistory()?.coverage;
                if (cov?.complete === false) coverageMsg += `（缺 ${cov.missingAiFloors?.length ?? '?'} 楼摘要）`;
                else coverageMsg += '（覆盖完整）';
            } catch {}
            $('#sp-mem-bbb-status').html(`<i class="fa-solid fa-circle-check" style="color:var(--cardhub-accent,#7c9)"></i> ${escapeHtml(coverageMsg)}`);
        } else {
            $('#sp-mem-bbb-status').html('<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> 柏宝书 API 未就绪；点 / 线 / 面 / 间 生成时不会注入历史记忆');
        }
        return;
    }
    $('#sp-mem-internal').show();
    $('#sp-mem-bbb-status').hide();
    $('#sp-mem-enabled').prop('checked', s.memoryEnabled !== false);
    $('#sp-mem-l0').val(Number.isFinite(+s.memoryL0Group) ? +s.memoryL0Group : 5);
    $('#sp-mem-l1').val(Number.isFinite(+s.memoryL1Group) ? +s.memoryL1Group : 10);
    $('#sp-mem-skipshort').val(Number.isFinite(+s.memorySkipShort) ? +s.memorySkipShort : 50);
    $('#sp-mem-keeptags').val(typeof s.keepTags  === 'string' ? s.keepTags  : 'content');
    $('#sp-mem-extratags').val(typeof s.extraTags === 'string' ? s.extraTags : '');
    refreshMemoryStatus();
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
    if (r.paused) rows.push(`<div class="sp-mem-alert">⚠ 记忆系统已暂停：${escapeHtml(r.lastError || '连续失败')}。点补齐或重构以恢复。</div>`);
    if (r.busy)   rows.push(`<div class="sp-mem-alert sp-mem-alert-info">🔄 记忆系统正在后台工作</div>`);
    $('#sp-mem-status').html(rows.join(''));
}

function bindMemoryHandlers() {
    $('#sp-mem-source-bbb').on('change', function () {
        getSettings().useBaiBaiBook = this.checked;
        saveSettingsDebounced();
        if (this.checked) memory.abortRebuild();
        renderMemorySection();
    });
    $('#sp-mem-enabled').on('change', function () {
        getSettings().memoryEnabled = this.checked;
        saveSettingsDebounced();
    });
    $('#sp-mem-l0').on('change', function () {
        const v = Math.max(1, Math.min(30, parseInt(this.value, 10) || 5));
        getSettings().memoryL0Group = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $('#sp-mem-l1').on('change', function () {
        const v = Math.max(2, Math.min(30, parseInt(this.value, 10) || 10));
        getSettings().memoryL1Group = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $('#sp-mem-skipshort').on('change', function () {
        const v = Math.max(0, Math.min(500, parseInt(this.value, 10) || 50));
        getSettings().memorySkipShort = v;
        this.value = v;
        saveSettingsDebounced();
    });
    // Tag sanitizer inputs — sanitize (bare tag names, comma-separated), save.
    // Applies to future reads; existing L0 summaries built with old rules keep
    // their hash and stay valid — new content read after change uses new rules.
    function sanitizeTagList(raw) {
        return String(raw || '')
            .split(',')
            .map(s => s.trim().replace(/^<|>$/g, '').replace(/\/$/, ''))  // tolerate '<content>' or 'content/'
            .filter(s => /^[a-zA-Z][\w-]*$/.test(s))
            .join(',');
    }
    $('#sp-mem-keeptags').on('change', function () {
        const v = sanitizeTagList(this.value);
        getSettings().keepTags = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $('#sp-mem-extratags').on('change', function () {
        const v = sanitizeTagList(this.value);
        getSettings().extraTags = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $('#sp-mem-check').on('click', function () {
        refreshMemoryStatus();
        showToast('已刷新记忆状态');
    });
    $('#sp-mem-fill').on('click', async function () {
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
    $('#sp-mem-rebuild').on('click', async function () {
        const r = memory.getHealthReport();
        const cost = r.totalGroups;
        const ok = await spConfirm({
            title  : '推翻重构',
            body   : `将清空全部摘要并按当前分组重新生成，约需 ${cost} 次 L0 API 调用 + 若干次 L1 压缩。`,
            note   : '重构期间可以中止。已有的点 / 线 / 面 不受影响。',
            confirmText: '开始重构',
            cancelText : '取消',
        });
        if (!ok) return;
        if ($(this).prop('disabled')) return;
        setMemoryProgressVisible(true);
        $(this).prop('disabled', true);
        try {
            await memory.rebuildAll(({ current, total, done, aborted }) => {
                updateMemoryProgress(current, total, aborted);
                if (current % 3 === 0 || done || aborted) refreshMemoryStatus();
            });
            showToast('重构完成');
        } catch (err) {
            showToast('重构失败：' + err.message, null, true);
        } finally {
            $(this).prop('disabled', false);
            setMemoryProgressVisible(false);
            refreshMemoryStatus();
        }
    });
    $('#sp-mem-progress-abort').on('click', () => memory.abortRebuild());
}

function setMemoryProgressVisible(visible) {
    $('#sp-mem-progress').toggle(!!visible);
    if (visible) updateMemoryProgress(0, 0);
}

function updateMemoryProgress(current, total, aborted = false) {
    $('#sp-mem-progress-count').text(aborted ? `已中止 (${current}/${total})` : `${current}/${total}`);
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    $('#sp-mem-progress-fill').css('width', pct + '%');
}

// Renders the narrative-scale radio group into #sp-scale-row using the current
// character's saved value. Regenerated each time settings opens (character can
// change between opens).
function renderScaleRow() {
    const $row = $('#sp-scale-row');
    if (!$row.length) return;
    const ctx = getContext();
    const cid = ctx.characterId;
    const current = getScale(cid);
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

async function renderWiList() {
    const ctx = getContext();
    const characterId = ctx.characterId;
    const $list = $('#sp-wi-list');
    $list.html('<span class="sp-cfg-hint">正在加载世界书条目…</span>');

    let entries;
    try {
        entries = await getCharBookEntries(ctx);
    } catch (err) {
        $list.html(`<span class="sp-cfg-hint">加载失败：${escapeHtml(err.message || '未知错误')}</span>`);
        return;
    }

    if (!entries.length) {
        $list.html('<span class="sp-cfg-hint">当前角色没有绑定世界书条目</span>');
        return;
    }

    // Cache entries for the eye-button popup
    _wiEntryCache = new Map(entries.map(e => [e.key, e]));

    const disabledKeys = getDisabledKeys(characterId);

    // Two-level group: scope (char / global) → source (book name) → entries
    // Preserves entry order within each source, and puts char scope first
    // (feels more relevant to the current character).
    const scopes = new Map([['char', new Map()], ['global', new Map()]]);
    for (const e of entries) {
        const scopeGroup = scopes.get(e.scope) || scopes.get('char');
        if (!scopeGroup.has(e.source)) scopeGroup.set(e.source, []);
        scopeGroup.get(e.source).push(e);
    }
    const SCOPE_LABELS = { char: '角色卡世界书', global: '全局世界书' };

    // Build HTML in one pass
    const parts = [];
    parts.push(`<div class="sp-wi-all-row">
        <label class="sp-wi-toggle-all">
            <input type="checkbox" id="sp-wi-select-all"> 全选 / 全不选
        </label>
        <span class="sp-wi-count">${entries.length} 条</span>
    </div>`);

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
            parts.push(`<details class="sp-wi-group" open data-source="${escSrc}">
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

    syncWiSelectAll();
}

function syncWiSelectAll() {
    const $cbs = $('#sp-wi-list .sp-wi-cb');
    if (!$cbs.length) return;
    const total   = $cbs.length;
    const checked = $cbs.filter(':checked').length;
    const $all = $('#sp-wi-select-all')[0];
    if ($all) {
        $all.checked       = checked === total;
        $all.indeterminate = checked > 0 && checked < total;
    }
    // Refresh each group's per-book checkbox based on its own entries
    $('#sp-wi-list .sp-wi-group').each(function () {
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

// Full-text popup for a single world-info entry
function showWiEntryFull(entry) {
    $('#sp-wi-fullview').remove();
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
    $(`#${MODAL_ID} .sp-sheet`).append($overlay);
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
    // Save world-info entry filter and narrative scale for current character
    const ctx = getContext();
    if (ctx.characterId != null) {
        const disabled = new Set();
        $('#sp-wi-list .sp-wi-cb').each(function () {
            if (!this.checked) disabled.add($(this).data('key'));
        });
        setDisabledKeys(ctx.characterId, disabled);
        const scaleVal = $('input[name="sp-lines-scale"]:checked').val() || 'auto';
        setScale(ctx.characterId, scaleVal);
    }
    $k.data('real', key).val(maskKey(key)).attr('type', 'password');
    const $m = $('#sp-cfg-msg'); $m.text('已保存 ✓'); setTimeout(() => $m.text(''), 2000);
    const hasApi = !!(loadCfg().url && loadCfg().key);
    $('#sp-settings-overlay .sp-api-notice')
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
    $modal.removeClass('sp-night sp-day sp-forced-day sp-forced-night').addClass(`sp-${theme}`);
    $fab.removeClass('sp-night sp-day sp-forced-day sp-forced-night').addClass(`sp-${theme}`);
    if (forced) {
        $modal.addClass(`sp-forced-${theme}`);
        $fab.addClass(`sp-forced-${theme}`);
    }
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
    const $btn = $(`#${MODAL_ID} .sp-theme-toggle-btn`);
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
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);

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
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);

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
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
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

function positionPanel() {
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
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
    const root  = document.getElementById(MODAL_ID);
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
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
    const top = 20 + safeTop;
    const bottomGap = 20 + safeBot;
    const maxH = Math.max(260, vh - top - bottomGap);

    sheet.style.top = `${top}px`;
    sheet.style.height = `${maxH}px`;
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

    const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
    const totalTabs = days.length + (hasFuture ? 1 : 0);
    const chipCls   = perspective === 'char' ? 'sp-char-chip' : 'sp-user-chip';

    const header = `<div class="sp-schedule-header">
        <span class="${chipCls}">${escapeHtml(userName)}</span>
        <span class="sp-schedule-label">的点</span>
        <button class="sp-panel-refresh sp-refresh-schedule" title="重新生成点"><i class="fa-solid fa-rotate-right"></i></button>
    </div>`;

    // Parse failed (AI leaked prompt / malformed output) — still render header
    // so the user has a refresh button to reroll. Otherwise they get stuck
    // staring at raw garbage with no way to try again.
    if (days.length === 0 && !hasFuture) {
        return header + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    }

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
    // Strip HTML comments across the whole widget body before splitting into lines.
    // LLM often emits multi-line <!-- 日程思考: ... --> blocks; per-line startsWith
    // would only skip the first line and treat the rest as content.
    const content = (m ? m[1] : raw).replace(/<!--[\s\S]*?-->/g, '');

    const dateMatch = content.match(/^StartDate:\s*(\d{4}-\d{2}-\d{2})/m);
    let startDate = null;
    if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) startDate = d;
    }

    const days = []; let cur = null; let inFuture = false; let future = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
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
    const injectParts = ['【点参考】'];
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

