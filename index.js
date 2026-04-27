import { getContext } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';

const PLUGIN_ID  = 'schedule-planner';
const MODAL_ID   = 'sp-modal-root';
const FAB_ID     = 'sp-fab';
const THEME_KEY  = 'sp-theme';
const API_KEY    = 'sp-api-cfg';
const POS_KEY    = 'sp-pos';
const SIZE_KEY    = 'sp-size';
const FAB_KEY     = 'sp-fab-show';
const CACHE_KEY   = 'sp-cache';

let currentTheme   = localStorage.getItem(THEME_KEY) || 'night';
let cachedSchedule = null;
let isGenerating   = false;
let settingsOpen   = false;
let dragState      = null;
let resizeState    = null;
let resizeRAF      = null;

const isMobile = () => window.innerWidth <= 640;

// ─── Init ─────────────────────────────────────────────────────────────────────

jQuery(async () => {
    injectExtButton();
    injectModal();
    injectFab();
    injectToastContainer();
    // Restore cached schedule from previous session
    try {
        const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (saved?.raw) cachedSchedule = renderSchedule(saved.raw, saved.userName || '用户');
    } catch { /* ignore corrupt cache */ }
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
    // Mirror to FAB
    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
}

// ─── FAB ─────────────────────────────────────────────────────────────────────

function injectFab() {
    const savedPos = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
    // Mobile: always use CSS defaults; desktop: restore dragged position if available
    const mobile = isMobile();
    const posStyle = (!mobile && savedPos)
        ? `left:${savedPos.left}px;top:${savedPos.top}px;right:auto;bottom:auto;`
        : '';  // CSS handles default position via calc(100dvh - ...)
    const html = `<div id="${FAB_ID}" style="position:fixed;z-index:2000000;${posStyle}${fabEnabled() ? '' : 'display:none'}">
        <button class="sp-fab-btn sp-${currentTheme}" title="七日日程"
            style="width:44px;height:44px;border-radius:50%;background:#3a3648;color:#d0bcff;border:1.5px solid rgba(208,188,255,0.35);display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.5);transform:translateZ(0);clip:auto;">
            <i class="fa-solid fa-calendar-days"></i>
        </button>
    </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    // On viewport resize, clear desktop inline styles when entering mobile
    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (nowMobile && !wasMobile) {
            // desktop → mobile: clear all inline position so CSS (dvh-based + centering) takes over
            const fab = document.getElementById(FAB_ID);
            if (fab) { fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = ''; }
            const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
            if (sheet) { sheet.style.left = ''; sheet.style.top = ''; sheet.style.right = '';
                         sheet.style.transform = ''; sheet.style.width = ''; sheet.style.height = ''; sheet.style.maxHeight = ''; }
        } else if (!nowMobile && wasMobile) {
            // mobile → desktop: restore saved drag position if any
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

    let fabDragged = false;
    let fabDragState = null;

    $(`#${FAB_ID}`).on('mousedown touchstart', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        const cx   = e.touches ? e.touches[0].clientX : e.clientX;
        const cy   = e.touches ? e.touches[0].clientY : e.clientY;
        fabDragState = { startX: cx, startY: cy, origLeft: rect.left, origTop: rect.top };
        $(document)
            .on('mousemove.fabdrag touchmove.fabdrag', function (ev) {
                if (!fabDragState) return;
                const ex = ev.touches ? ev.touches[0].clientX : ev.clientX;
                const ey = ev.touches ? ev.touches[0].clientY : ev.clientY;
                if (Math.abs(ex - fabDragState.startX) > 5 || Math.abs(ey - fabDragState.startY) > 5) fabDragged = true;
                if (!fabDragged) return;
                ev.preventDefault();
                const f = document.getElementById(FAB_ID);
                f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ex - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
                f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ey - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
                f.style.right  = 'auto';
                f.style.bottom = 'auto';
            })
            .on('mouseup.fabdrag touchend.fabdrag', function () {
                if (fabDragged) {
                    const f = document.getElementById(FAB_ID);
                    const r = f.getBoundingClientRect();
                    localStorage.setItem('sp-fab-pos', JSON.stringify({ left: r.left, top: r.top }));
                }
                fabDragState = null;
                $(document).off('mousemove.fabdrag touchmove.fabdrag mouseup.fabdrag touchend.fabdrag');
            });
    });

    $(`#${FAB_ID} .sp-fab-btn`).on('click', function () {
        if (!fabDragged) {
            $(`#${MODAL_ID}`).is(':visible') ? closePanel() : openSchedule();
        }
    });
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function injectModal() {
    const cfg = loadCfg();
    const hasCustomApi = !!(cfg.url && cfg.key);
    const html = `
        <div id="${MODAL_ID}" class="sp-root sp-${currentTheme}" style="display:none;position:fixed;z-index:2000001">
            <div class="sp-backdrop"></div>
            <div class="sp-sheet">
                <div class="sp-topbar" id="sp-drag-handle">
                    <span class="sp-topbar-title">七日日程</span>
                    <div class="sp-topbar-actions">
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

                <div class="sp-resize-handle" id="sp-resize-handle">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </div>
            </div>
        </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    if (cfg.key) $('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $(`#${MODAL_ID} .sp-close-btn`).on('click',    closePanel);
    $(`#${MODAL_ID} .sp-theme-btn`).on('click',    toggleTheme);
    $(`#${MODAL_ID} .sp-regen-btn`).on('click',    triggerGenerate);
    $(`#${MODAL_ID} .sp-settings-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-backdrop`).on('click',     closePanel);

    $('#sp-cfg-save').on('click',      saveSettings);
    $('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $('#sp-fetch-models').on('click',  fetchModels);
    $('#sp-cfg-key')
        .on('focus', () => { const r = $('#sp-cfg-key').data('real'); if (r) $('#sp-cfg-key').val(r); })
        .on('blur',  () => { const r = $('#sp-cfg-key').data('real') || $('#sp-cfg-key').val(); if (r) $('#sp-cfg-key').data('real', r).val(maskKey(r)); });

    $('#sp-body').on('click', '.sp-tab', function () {
        const idx = parseInt($(this).data('day'));
        $('.sp-tab').removeClass('sp-tab-active');
        $(this).addClass('sp-tab-active');
        $('.sp-days-track').css('transform', `translateX(-${idx * 100 / 7}%)`);
    });

    // Drag
    $('#sp-drag-handle')
        .on('mousedown',  onDragStart)
        .on('touchstart', onDragStart, { passive: false });

    // Resize
    $('#sp-resize-handle')
        .on('mousedown', onResizeStart);

    restorePositionAndSize();
}

// ─── Open / close ─────────────────────────────────────────────────────────────

function openSchedule() {
    showPanel();
    if (isGenerating) {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p></div>`);
    } else if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        triggerGenerate();
    }
}

function showPanel() {
    const $root = $(`#${MODAL_ID}`);
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
    isGenerating = true;
    setExtBtnState('generating');
    showPanel();
    setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">正在规划中…</p></div>`);
    runGenerate();
}

async function runGenerate() {
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || '用户';
        const charName = ctx.name2 || '角色';
        const raw      = await generate(ctx, userName, charName);
        const html     = renderSchedule(raw, userName);
        cachedSchedule = html;
        localStorage.setItem(CACHE_KEY, JSON.stringify({ raw, userName, ts: Date.now() }));
        isGenerating   = false;
        setExtBtnState('done');

        if ($(`#${MODAL_ID}`).is(':visible')) {
            setBody(html);
        } else {
            showToast('日程已生成，点击查看', () => { showPanel(); setBody(cachedSchedule); });
        }
        setTimeout(() => setExtBtnState(null), 6000);
    } catch (err) {
        isGenerating = false;
        setExtBtnState(null);
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escapeHtml(err.message || '未知错误')}</p></div>`;
        if ($(`#${MODAL_ID}`).is(':visible')) { setBody(errHtml); }
        else { showToast('日程生成失败，请重试', null, true); }
    }
}

async function generate(ctx, userName, charName) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) {
        if (!settingsOpen) toggleSettings();
        throw new Error('请先在设置中填写自定义 API 的 URL 和 Key');
    }
    const prompt = buildPrompt(userName, charName);
    return callCustomApi(ctx, prompt, cfg, userName, charName);
}

async function callCustomApi(ctx, prompt, cfg, userName, charName) {
    const messages = buildMessages(ctx, prompt, userName, charName);
    const res = await fetch(`${cfg.url}/chat/completions`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, max_tokens: 4096 }),
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
    const history = (ctx.chat ?? []).slice(-40).map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes ?? '' }));
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: prompt }];
}

function buildPrompt(userName, charName) {
    return `请暂停角色扮演，以写作助手身份完成以下任务（内容仅作参考，不出现在正文）：

根据以上剧情背景与世界设定，为 ${userName} 规划接下来七天的日程安排。

【具体规则】
1. 时间跨度：必须生成包含今日起连续未来 7 天的日程，禁止遗漏任何一天。
2. 事件数量：每天安排 2 到 5 个事件，总计 15-30 个事件。
3. 内容来源：基于当前对话剧情、世界观设定以及角色关系合理推演。
4. 字段规范（每行一个 Event）：
   格式：Event: type|title|description|time|location|npc_action
   - type：world / major / user / character
   - description：${userName} 视角，生活化口吻，30字以上
   - npc_action：${charName} 同期行动，30字以上

【输出格式（严格遵守，只输出以下结构）】
<!-- 日程思考：（根据当前剧情思考安排，100字以上） -->
<calendar_widget>
StartDate: YYYY-MM-DD （若剧情中能明确或合理推断故事当前日期则填写，格式如 2024-03-15；若完全无法确定则省略此行）
Day: 1
Event: type|title|description|time|location|npc_action
Event: type|title|description|time|location|npc_action
Day: 2
Event: type|title|description|time|location|npc_action
Day: 3
Event: type|title|description|time|location|npc_action
Day: 4
Event: type|title|description|time|location|npc_action
Day: 5
Event: type|title|description|time|location|npc_action
Day: 6
Event: type|title|description|time|location|npc_action
Day: 7
Event: type|title|description|time|location|npc_action
</calendar_widget>`;
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
    // Reload notice
    const hasApi = !!(loadCfg().url && loadCfg().key);
    $('.sp-api-notice')
        .removeClass('sp-notice-ok sp-notice-warn')
        .addClass(hasApi ? 'sp-notice-ok' : 'sp-notice-warn')
        .html(`<i class="fa-solid ${hasApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            ${hasApi ? '已配置独立 API，后台生成不影响聊天'
                     : '未配置独立 API：生成期间将<b>占用聊天通道</b>'}`);
    // Auto-close settings panel after save
    setTimeout(() => { if (settingsOpen) toggleSettings(); }, 400);
}

function toggleTheme() {
    currentTheme = currentTheme === 'night' ? 'day' : 'night';
    localStorage.setItem(THEME_KEY, currentTheme);
    $(`#${MODAL_ID}`).removeClass('sp-night sp-day').addClass(`sp-${currentTheme}`);
    $(`#${FAB_ID} .sp-fab-btn`).removeClass('sp-night sp-day').addClass(`sp-${currentTheme}`);
}

// ─── Drag ─────────────────────────────────────────────────────────────────────

function onDragStart(e) {
    if ($(e.target).closest('.sp-icon-btn').length) return;
    e.preventDefault();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const rect  = sheet.getBoundingClientRect();
    // If CSS centering via transform is active, snap to explicit coords first
    if (sheet.style.transform !== 'none' && (sheet.style.left === '' || sheet.style.left === '50%')) {
        sheet.style.transform = 'none';
        sheet.style.left = rect.left + 'px';
        sheet.style.top  = rect.top  + 'px';
    }
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    dragState = { startX: cx, startY: cy, origLeft: rect.left, origTop: rect.top };
    $(document).on('mousemove.spdrag touchmove.spdrag', onDragMove)
               .on('mouseup.spdrag  touchend.spdrag',   onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grabbing');
}

function onDragMove(e) {
    if (!dragState) return;
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
    localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    dragState = null;
    $(document).off('mousemove.spdrag touchmove.spdrag mouseup.spdrag touchend.spdrag');
    $('#sp-drag-handle').css('cursor', 'grab');
}

// ─── Resize ───────────────────────────────────────────────────────────────────

function onResizeStart(e) {
    if (isMobile()) return;
    e.preventDefault();
    e.stopPropagation();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    sheet.style.willChange = 'width, height';
    document.body.style.userSelect = 'none';
    resizeState = {
        startX: e.clientX, startY: e.clientY,
        origW : sheet.offsetWidth, origH : sheet.offsetHeight,
    };
    $(document).on('mousemove.spresize', onResizeMove)
               .on('mouseup.spresize',   onResizeEnd);
}

function onResizeMove(e) {
    if (!resizeState) return;
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        const w = Math.max(280, Math.min(700, resizeState.origW + e.clientX - resizeState.startX));
        const h = Math.max(300, Math.min(window.innerHeight * 0.92, resizeState.origH + e.clientY - resizeState.startY));
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
    world    : { icon: 'fa-earth-asia', label: '世界',  cls: 'sp-type-world'     },
    major    : { icon: 'fa-star',       label: '大事',  cls: 'sp-type-major'     },
    user     : { icon: 'fa-user',       label: '个人',  cls: 'sp-type-user'      },
    character: { icon: 'fa-heart',      label: 'NPC',   cls: 'sp-type-character' },
};

function renderSchedule(raw, userName) {
    const { days, startDate } = parseCalendar(raw);
    if (days.length === 0) return `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;

    const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];

    const header = `<div class="sp-schedule-header">
        <span class="sp-user-chip">${escapeHtml(userName)}</span>
        <span class="sp-schedule-label">的七日日程</span>
    </div>`;

    const tabs = days.map((_, i) => {
        const wdLabel = startDate
            ? (() => { const d = new Date(startDate); d.setDate(startDate.getDate() + i); return WEEKDAYS[d.getDay()]; })()
            : '';
        return `<button class="sp-tab${i === 0 ? ' sp-tab-active' : ''}" data-day="${i}">
            <span class="sp-tab-num">${i + 1}</span>
            ${wdLabel ? `<span class="sp-tab-wd">${wdLabel}</span>` : ''}
        </button>`;
    }).join('');

    const panels = days.map(day =>
        `<div class="sp-day-panel">${day.events.map(renderEvent).join('')}</div>`
    ).join('');

    const debug = days.length < 7 ? `
        <details class="sp-debug"><summary>⚠ 仅解析到 ${days.length} 天</summary>
        <pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>` : '';

    return `${header}<div class="sp-tab-bar">${tabs}</div>
        <div class="sp-days-wrap"><div class="sp-days-track">${panels}</div></div>${debug}`;
}

function parseCalendar(raw) {
    const m = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const content = m ? m[1] : raw;

    // Extract optional StartDate
    const dateMatch = content.match(/^StartDate:\s*(\d{4}-\d{2}-\d{2})/m);
    let startDate = null;
    if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) startDate = d;
    }

    const days = []; let cur = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('<!--')) continue;
        if (/^Day\s*:?\s*\d+/i.test(t) || /^第[一二三四五六七\d]+天/.test(t)) {
            if (cur) days.push(cur); cur = { events: [] }; continue;
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
    if (cur) days.push(cur);
    return { days: days.filter(d => d.events.length > 0), startDate };
}

function renderEvent(ev) {
    const meta = TYPE_META[ev.type] || TYPE_META.user;
    return `<div class="sp-event ${meta.cls}">
        <div class="sp-event-head">
            <span class="sp-type-badge"><i class="fa-solid ${meta.icon}"></i>${escapeHtml(meta.label)}</span>
            <span class="sp-event-title">${escapeHtml(ev.title)}</span>
            ${ev.time ? `<span class="sp-event-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(ev.time)}</span>` : ''}
        </div>
        ${ev.desc ? `<p class="sp-event-desc">${escapeHtml(ev.desc)}</p>` : ''}
        <div class="sp-event-meta">
            ${ev.location  ? `<span class="sp-event-loc"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(ev.location)}</span>` : ''}
            ${ev.npcAction ? `<span class="sp-event-npc"><i class="fa-solid fa-user-secret"></i> ${escapeHtml(ev.npcAction)}</span>` : ''}
        </div>
    </div>`;
}

function escapeHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeAttr(s)  { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
