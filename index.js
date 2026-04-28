import { getContext } from '../../../extensions.js';
import { generateQuietPrompt, eventSource, event_types, substituteParams } from '../../../../script.js';

const PLUGIN_ID  = 'schedule-planner';
const MODAL_ID   = 'sp-modal-root';
const FAB_ID     = 'sp-fab';
const THEME_KEY  = 'sp-theme';
const API_KEY    = 'sp-api-cfg';
const POS_KEY    = 'sp-pos';
const SIZE_KEY    = 'sp-size';
const FAB_KEY     = 'sp-fab-show';

// view: 'user' | 'char'   charName: confirmed char name
function getCacheKey(view, charName) {
    const chatId = getContext().chatId;
    if (!chatId) return null;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    if (v === 'char' && c) return `sp-cache-${chatId}-char-${c}`;
    return `sp-cache-${chatId}-user`;
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

let currentTheme   = localStorage.getItem(THEME_KEY) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night');
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
let isFullscreen        = false;
let scheduleAbortController = null;
let outlineAbortController  = null;
const _injectTexts      = {};
let   _injectIdSeq      = 0;

const isMobile = () => window.innerWidth <= 640;

// ─── Init ─────────────────────────────────────────────────────────────────────

jQuery(async () => {
    injectExtButton();
    injectModal();
    injectFab();
    injectToastContainer();
    // Reset view state and reload cache on chat switch
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentView  = 'user';
        charViewName = null;
        outlineMode  = false;
        cachedOutline = null;
        outlineChatHistory = [];
        $('.sp-view-btn').removeClass('sp-view-active');
        $(`.sp-view-btn[data-view="user"]`).addClass('sp-view-active');
        cachedSchedule = loadCachedForCurrentChat();
        if ($(`#${MODAL_ID}`).is(':visible') && !isGenerating) {
            $('#sp-outline-wrap').hide();
            $('#sp-body').show();
            $(`#${MODAL_ID} .sp-outline-btn`).removeClass('sp-btn-active');
            $('#sp-chat-msgs').empty();
            if (cachedSchedule) setBody(cachedSchedule);
            else setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>暂无日程，点击右下角生成</p></div>`);
        }
    });
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
        if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'day' : 'night');
    });
});

// ─── Config helpers ───────────────────────────────────────────────────────────

function loadCfg() { try { return JSON.parse(localStorage.getItem(API_KEY)) || {}; } catch { return {}; } }
function saveCfg(c) { localStorage.setItem(API_KEY, JSON.stringify(c)); }
function maskKey(k) { return k.length <= 8 ? '•'.repeat(k.length) : '•'.repeat(k.length - 4) + k.slice(-4); }
function fabEnabled() { return localStorage.getItem(FAB_KEY) !== 'false'; }

// ─── Extensions panel ─────────────────────────────────────────────────────────

function injectExtButton() {
    const html = `
        <div id="${PLUGIN_ID}-settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>七日日程规划</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="sp-ext-row">
                    <button id="sp-open-btn" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-calendar-days"></i>
                        <span>打开日程</span>
                    </button>
                    <label class="sp-toggle-label">
                        <input type="checkbox" id="sp-fab-check" ${fabEnabled() ? 'checked' : ''}>
                        悬浮按钮
                    </label>
                </div>
            </div>
        </div>`;
    $('#extensions_settings').append(html);
    $('#sp-open-btn').on('click', openSchedule);
    $('#sp-fab-check').on('change', function () {
        localStorage.setItem(FAB_KEY, this.checked ? 'true' : 'false');
        $(`#${FAB_ID}`).toggle(this.checked);
    });
}

function setExtBtnState(state) {
    const $btn = $('#sp-open-btn');
    $btn.removeClass('sp-btn-generating sp-btn-done');
    if (state) $btn.addClass(`sp-btn-${state}`);
    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
    // Lock view toggle while generating to prevent mid-flight view switches
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
        <button class="sp-fab-btn sp-${currentTheme}" title="七日日程"
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
                    </div>
                    <div class="sp-topbar-actions">
                        <button class="sp-icon-btn sp-maximize-btn" title="全屏"><i class="fa-solid fa-expand"></i></button>
                        <button class="sp-icon-btn sp-settings-btn" title="设置"><i class="fa-solid fa-gear"></i></button>
                        <button class="sp-icon-btn sp-theme-btn"    title="切换主题"><i class="fa-solid fa-circle-half-stroke"></i></button>
                        <button class="sp-icon-btn sp-regen-btn"    title="重新生成"><i class="fa-solid fa-rotate-right"></i></button>
                        <button class="sp-icon-btn sp-close-btn"    title="关闭"><i class="fa-solid fa-xmark"></i></button>
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
                    <button id="sp-cfg-save" class="sp-save-btn"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                    <span id="sp-cfg-msg" class="sp-cfg-msg"></span>
                </div>

                <div class="sp-body" id="sp-body">
                    <div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>点击右上角刷新按钮生成日程</p></div>
                </div>

                <div class="sp-outline-wrap" id="sp-outline-wrap" style="display:none">
                    <div class="sp-outline-beats" id="sp-outline-beats">
                        <div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>点击右上角生成按钮生成大纲</p></div>
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

                <div class="sp-resize-handle" id="sp-resize-handle">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </div>
            </div>
        </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    if (cfg.key) $('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $(`#${MODAL_ID} .sp-close-btn`).on('click',    closePanel);
    $(`#${MODAL_ID} .sp-theme-btn`).on('click',    toggleTheme);
    $(`#${MODAL_ID} .sp-regen-btn`).on('click',    onRegenClick);
    $(`#${MODAL_ID} .sp-maximize-btn`).on('click', toggleFullscreen);
    $(`#${MODAL_ID} .sp-settings-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-backdrop`).on('click',     closePanel);

    // Outline chat
    function doSendChat() {
        const msg = $('#sp-chat-input').val().trim();
        if (msg && !isOutlineChatting) { $('#sp-chat-input').val(''); sendOutlineChat(msg); }
    }
    $('#sp-chat-send').on('click', doSendChat);
    $('#sp-chat-input').on('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendChat(); } });

    // Inject buttons (event delegation)
    $(`#sp-body, #sp-outline-wrap`).on('click', '.sp-inject-btn', function () {
        const text = _injectTexts[$(this).data('iid')];
        if (text) injectToST(text);
    });

    // Abort buttons (event delegation)
    $('#sp-body').on('click', '#sp-abort-generate', () => scheduleAbortController?.abort());
    $('#sp-outline-beats').on('click', '#sp-abort-outline', () => outlineAbortController?.abort());

    // View toggle: 我 / TA / 大纲
    $(`#${MODAL_ID} .sp-view-toggle`).on('click', '.sp-view-btn', function () {
        if (isGenerating) return;
        const view = $(this).data('view');

        if (view === 'outline') {
            if (outlineMode) return;
            outlineMode = true;
            $('.sp-view-btn').removeClass('sp-view-active');
            $(this).addClass('sp-view-active');
            $('#sp-body').hide();
            $('#sp-outline-wrap').css('display', 'flex');
            cachedOutline = loadCachedOutlineForCurrentChat();
            if (cachedOutline) setOutlineBody(cachedOutline);
            return;
        }

        // Leaving outline mode
        let wasOutline = false;
        if (outlineMode) {
            outlineMode = false;
            wasOutline = true;
            $('#sp-outline-wrap').hide();
            $('#sp-body').show();
        }

        if (view === currentView && !wasOutline) return;
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
    $('#sp-chat-msgs').empty();
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
    setTimeout(positionPanel, 0);
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
    const messages = buildMessages(ctx, prompt, userName, charName);
    const res = await fetch(`${cfg.url}/chat/completions`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, max_tokens: 4096 }),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return (await res.json()).choices?.[0]?.message?.content ?? '';
}

function buildMessages(ctx, prompt, userName, charName) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const sys  = [`你正在扮演 ${charName}。`, char.description,
        char.personality ? `【性格】${char.personality}` : '',
        char.scenario    ? `【场景】${char.scenario}`    : '',
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
    if (!chatId) return null;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    if (v === 'char' && c) return `sp-cache-${chatId}-outline-char-${c}`;
    return `sp-cache-${chatId}-outline-user`;
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

function buildOutlineChatMessages(userMsg) {
    const ctx      = getContext();
    const userName = ctx.name1 || '用户';
    const charName = currentView === 'char' ? (charViewName || ctx.name2 || '角色') : (ctx.name2 || '角色');
    let outlineCtx = '';
    try {
        const key  = getOutlineCacheKey();
        const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) outlineCtx = `\n当前大纲：\n${saved.raw}\n`;
    } catch { /* ignore */ }
    const sys = `你是一位故事创作顾问，正在帮助用户完善 ${userName} 与 ${charName} 的故事大纲。${outlineCtx}
请以创作顾问身份回答，不要扮演任何角色。如果用户要求修改大纲，在回复末尾输出完整的新大纲（格式与原大纲完全一致，使用 <outline_widget>...</outline_widget> 包裹）。`;
    return [{ role: 'system', content: sys }, ...outlineChatHistory, { role: 'user', content: userMsg }];
}

async function sendOutlineChat(userMsg) {
    if (isOutlineChatting) return;
    appendChatMsg('user', userMsg);
    outlineChatHistory.push({ role: 'user', content: userMsg });
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
            body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages: buildOutlineChatMessages(userMsg), max_tokens: 4096 }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reply = (await res.json()).choices?.[0]?.message?.content ?? '';
        outlineChatHistory.push({ role: 'assistant', content: reply });
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
        cachedOutline = loadCachedOutlineForCurrentChat();
        if (cachedOutline) setOutlineBody(cachedOutline);
    } else {
        $(`.sp-view-btn[data-view="${currentView}"]`).addClass('sp-view-active');
        $('#sp-outline-wrap').hide();
        $('#sp-body').show();
    }
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
    const subject   = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    return `请暂停角色扮演，以编剧顾问身份根据以上剧情，为 ${subject} 与 ${companion} 的故事生成大纲。
【重要】所有输出必须使用中文（人名、地名可保留原文）。

【第一步：故事基础分析】
生成节点之前，先在注释中梳理以下内容（200字以上）：
① 初始状态：${subject} 与 ${companion} 当前的关系状态、情感现状、未解决的张力
② 情感萌点：这段关系的核心吸引力或矛盾模式（如"互相吸引却为保护自己而互相伤害"）
③ 短期目标 / 长期目标：两人各自或共同想要达成的事
④ 剧情模式：这是什么类型的故事？情感推进的节奏规律是什么？（如"靠近→试探→受伤→退后→忍不住再靠近"的拉扯循环）
⑤ 两条故事线：主线（外部目标/生活事件）和情感线（关系推进轨迹）各自的走向
⑥ 两个角色各自的行为模式和语言风格特征，确保节点中的人物表现符合原设

【第二步：生成关键节点，目标 8 个】
节点必须基于上述分析，体现你确定的剧情模式。
情感线需要螺旋推进（进一步→退半步→再进一步），不能让关系线性发展。
节点要覆盖完整故事弧线：开场状态→情感萌动→第一次靠近→误解或退后→危机爆发→关键转折→余震→新的平衡。每个阶段1个节点，保证每个节点的 Scene 和 Think 内容充实，不要压缩质量来堆数量。

【标题要求】10字以内，必须有可追溯的文学渊源感——从以下方式中选一种：①直接摘抄真实存在的古诗词原句（如《此情可待成追忆》《春风不度玉门关》）；②改编真实歌词（如《春风十里不如你》改自冯唐诗）；③明确仿写某经典作品的句式和气质。禁止自造现代文艺短语（如"湖水没过礁石"这类），标题应让读者觉得"这是在引用某处"。

【字段说明】
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: 这一幕实际发生了什么
Subtext: 这一幕里某人没有说出口的那句话，或某个下意识的动作所隐含的情绪
Think: 创作思考

- 推演时间：相对时间，如"数日后""某个深夜""不知何时"
- 类型：节点性质，如冲突、突破、转折、试探、退后、揭示等
- 所属故事线：主线 / 情感线 / 双线交叉
- 结果：这个节点的结局或影响，一句话
- Scene：100-150字，写清楚发生了什么、谁做了什么、说了什么或没说什么
- Subtext：一句话，不超过40字，具体到某个人、某个瞬间，是潜台词而非总结
- Think：100-150字，每点一句话，必须覆盖：① 如何体现情感萌点/剧情模式 ② ${subject} 此刻的心理状态 ③ 对主线和情感线各自的推进作用 ④ 在螺旋进退中处于哪个位置

【输出格式（严格遵守，只输出以下结构，禁止省略 outline_widget 标签）】
<!-- 故事分析：（第一步的分析，200字以上） -->
<outline_widget>
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: 场景内容…
Subtext: 没说出口的话或隐含动作…
Think: 思考内容…
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: 场景内容…
Subtext: 没说出口的话或隐含动作…
Think: 思考内容…
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: 场景内容…
Subtext: 没说出口的话或隐含动作…
Think: 思考内容…
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: 场景内容…
Subtext: 没说出口的话或隐含动作…
Think: 思考内容…
（继续，每个弧线阶段1个节点，共8个，质量优先）
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
    if (beats.length === 0) return `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    return beats.map((b, i) => {
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
    $('#sp-settings-panel').slideToggle(200);
    $(`#${MODAL_ID} .sp-settings-btn`).toggleClass('sp-btn-active', settingsOpen);
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

function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const $icon = $(`#${MODAL_ID} .sp-maximize-btn i`);
    if (isFullscreen) {
        sheet.dataset.prevLeft    = sheet.style.left;
        sheet.dataset.prevTop     = sheet.style.top;
        sheet.dataset.prevWidth   = sheet.style.width;
        sheet.dataset.prevHeight  = sheet.style.height;
        sheet.dataset.prevMaxH    = sheet.style.maxHeight;
        sheet.style.animation     = 'none';
        sheet.style.left          = '10px';
        sheet.style.top           = '10px';
        sheet.style.right         = 'auto';
        sheet.style.transform     = 'none';
        sheet.style.width         = (window.innerWidth  - 20) + 'px';
        sheet.style.height        = (window.innerHeight - 20) + 'px';
        sheet.style.maxHeight     = (window.innerHeight - 20) + 'px';
        $icon.removeClass('fa-expand').addClass('fa-compress');
    } else {
        sheet.style.left      = sheet.dataset.prevLeft     || '';
        sheet.style.top       = sheet.dataset.prevTop      || '';
        sheet.style.width     = sheet.dataset.prevWidth    || '';
        sheet.style.height    = sheet.dataset.prevHeight   || '';
        sheet.style.maxHeight = sheet.dataset.prevMaxH     || '';
        $icon.removeClass('fa-compress').addClass('fa-expand');
    }
}

function toggleTheme() {
    applyTheme(currentTheme === 'night' ? 'day' : 'night');
    localStorage.setItem(THEME_KEY, currentTheme);
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
        const w = Math.max(280, Math.min(window.innerWidth * 0.9, resizeState.origW + cx - resizeState.startX));
        const h = Math.max(300, Math.min(window.innerHeight * 0.95, resizeState.origH + cy - resizeState.startY));
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
        return;
    }
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (pos) {
        sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
        sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
        sheet.style.right = 'auto';
    }
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
