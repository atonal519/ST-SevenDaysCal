import { axisState } from './state.js';

export function calendarCards(context, charKey) {
    const characters = Array.isArray(context?.characters) ? context.characters : [], current = charKey?.(context), seen = new Set();
    return characters.map(character => { const avatar = String(character?.avatar ?? ''); if (!avatar || seen.has(avatar)) return null; seen.add(avatar); const raw = character?.name == null ? '' : String(character.name); return { avatar, name: raw || avatar, current: avatar === current }; }).filter(Boolean).sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name, 'zh-CN'));
}
export function calendarBindingKey(bindings, avatar, cards = []) { if (Object.prototype.hasOwnProperty.call(bindings || {}, avatar)) return avatar; const legacy = String(avatar || '').trim(); return legacy !== avatar && Object.prototype.hasOwnProperty.call(bindings || {}, legacy) && !cards.some(card => card.avatar === legacy) ? legacy : avatar; }
export function calendarBoundTemplateId(bindings, avatar, cards = []) { return (bindings || {})[calendarBindingKey(bindings, avatar, cards)] || ''; }
export function setCalendarBinding(bindings, avatar, templateId, cards = []) { const key = calendarBindingKey(bindings, avatar, cards); delete bindings[key]; delete bindings[avatar]; if (templateId) bindings[avatar] = templateId; return bindings; }
export function calendarBindingCandidates(cards, bindings, templateId, query = '') { const normalized = String(query || '').trim().toLocaleLowerCase(); return (cards || []).filter(card => calendarBoundTemplateId(bindings, card.avatar, cards) !== templateId && (!normalized || card.name.toLocaleLowerCase().includes(normalized) || card.avatar.toLocaleLowerCase().includes(normalized))); }

// 历法管理器：拥有草稿、月份编辑、模板面板和局部刷新所需的状态转移。
// DOM 查询、确认框、持久化和渲染由宿主注入；业务状态不再由 index 直接拼装。
export function createCalendarManager(env = {}) {
    const manager = () => axisState._almanacManager;
    const render = options => env.render?.(options);
    const ensure = () => manager() || null;
    const begin = () => {
        axisState._almanacManager = env.createState?.() || { editing: false, draft: env.clone?.(env.load?.()), error: '', templatesOpen: false, bindTemplateId: null, bindQuery: '' };
        return axisState._almanacManager;
    };
    const close = () => { axisState._almanacManager = null; render(); };
    const startEditing = () => { const m = ensure(); if (!m) return false; m.editing = true; m.draft = env.clone?.(env.load?.()) || m.draft; m.error = ''; render(); return true; };
    const cancelEditing = () => { const m = ensure(); if (!m) return false; m.editing = false; m.draft = env.clone?.(env.load?.()) || m.draft; m.error = ''; render(); return true; };
    const captureDraft = () => {
        const m = ensure(); if (!m || !m.editing) return m?.draft;
        const fields = env.readDraft?.();
        if (fields) {
            const previous = m.draft || env.load?.() || {};
            m.draft = {
                kind: previous.kind, id: previous.id, revision: previous.revision, weekdayCycle: previous.weekdayCycle,
                ...(Number.isInteger(previous.epochYear) ? { epochYear: previous.epochYear } : {}),
                ...(Number.isInteger(previous.epochOrdinal) ? { epochOrdinal: previous.epochOrdinal } : {}),
                ...(Number.isInteger(previous.epochWeekday) ? { epochWeekday: previous.epochWeekday } : {}),
                ...(previous.absoluteCycle === true ? { absoluteCycle: true } : {}),
                era: String(fields.era || ''),
                months: Array.isArray(fields.months) ? fields.months.map(month => ({ name: String(month.name || ''), days: month.days })) : [],
            };
        }
        return m.draft;
    };
    const addMonth = () => {
        const m = ensure(); if (!m) return { ok: false, reason: 'missing-manager' }; captureDraft();
        if (m.draft.months.length >= env.limits.monthCount) { m.error = `最多只能有 ${env.limits.monthCount} 个月份`; render(); return { ok: false, reason: 'limit' }; }
        const index = m.draft.months.length;
        m.draft.months.push({ name: `${index + 1}月`, days: env.limits.defaultMonthDays }); m.error = '';
        render({ reveal: { kind: 'month', index }, focus: { kind: 'month', index, selector: '.sp-alm-manager-month-name' } }); return { ok: true, index };
    };
    const deleteMonth = async index => {
        const m = ensure(); if (!m) return { ok: false, reason: 'missing-manager' }; captureDraft();
        if (m.draft.months.length <= 1) { m.error = '至少保留一个月份'; render(); return { ok: false, reason: 'minimum' }; }
        const month = m.draft.months[index]; if (!month) return { ok: false, reason: 'missing-month' };
        const chatIdSnapshot = env.chatId?.();
        const confirmed = await env.confirm?.({ title: '删除月份', body: `确定删除月份「${month.name}」吗？保存历法时会继续检查受影响的纪念日。`, confirmText: '删除', cancelText: '取消' });
        if (!confirmed || axisState._almanacManager !== m || env.chatId?.() !== chatIdSnapshot) return { ok: false, reason: 'cancelled' };
        m.draft.months.splice(index, 1); m.error = ''; const nextIndex = Math.min(index, m.draft.months.length - 1);
        render({ reveal: { kind: 'month', index: nextIndex }, focus: { kind: 'month', index: nextIndex, selector: '.sp-alm-manager-month-delete' } }); return { ok: true, index: nextIndex };
    };
    const copyMonth = index => {
        const m = ensure(); if (!m) return { ok: false, reason: 'missing-manager' }; captureDraft();
        if (!Array.isArray(m.draft.months) || m.draft.months.length >= env.limits.monthCount || !m.draft.months[index]) { m.error = m.draft.months.length >= env.limits.monthCount ? `最多只能有 ${env.limits.monthCount} 个月份` : '找不到要复制的月份'; render(); return { ok: false, reason: 'invalid' }; }
        const source = m.draft.months[index];
        m.draft.months.splice(index + 1, 0, { name: source.name, days: source.days });
        m.error = ''; render({ reveal: { kind: 'month', index: index + 1 }, focus: { kind: 'month', index: index + 1, selector: '.sp-alm-manager-month-name' } }); return { ok: true, index: index + 1 };
    };
    const moveMonth = (index, delta) => { const m = ensure(); if (!m) return false; captureDraft(); const next = index + delta; if (next < 0 || next >= m.draft.months.length) return false; [m.draft.months[index], m.draft.months[next]] = [m.draft.months[next], m.draft.months[index]]; render({ reveal: { kind: 'month', index: next }, focus: { kind: 'month', index: next, selector: delta < 0 ? '.sp-alm-manager-month-up' : '.sp-alm-manager-month-down' } }); return true; };
    const toggleTemplates = () => { const m = ensure(); if (!m) return false; m.templatesOpen = !m.templatesOpen; m.bindTemplateId = null; m.bindQuery = ''; render({ focus: { selector: '.sp-alm-manager-template-head' } }); return m.templatesOpen; };
    const setBindingView = (id, open) => { const m = ensure(); if (!m) return false; m.bindTemplateId = open ? id : null; m.bindQuery = ''; render({ reveal: { kind: 'template', id, selector: open ? '.sp-alm-manager-bind-search' : '.sp-alm-manager-template-bind' }, focusBindingId: open ? id : null, focus: open ? null : { kind: 'template', id, selector: '.sp-alm-manager-template-bind' } }); return true; };
    const setBindingQuery = value => { const m = ensure(); if (!m) return false; m.bindQuery = String(value ?? ''); return true; };
    const clearError = () => { const m = ensure(); if (!m) return false; m.error = ''; return true; };
    const hasError = () => Boolean(ensure()?.error);
    const isOpen = () => Boolean(manager());
    const isEditing = () => Boolean(manager()?.editing);
    const bindingId = () => manager()?.bindTemplateId || null;
    const updateBinding = async (avatar, nextTemplateId, expectedTemplateId = null) => {
        const m = ensure(); if (!m || !avatar) return false;
        const cards = env.cards?.() || [], bindings = { ...(env.bindings?.() || {}) }, currentId = env.boundId?.(bindings, avatar, cards) || '';
        if (expectedTemplateId != null && currentId !== expectedTemplateId) return false;
        if (currentId === (nextTemplateId || '')) return true;
        const chatId = env.chatId?.(), currentAvatar = env.currentAvatar?.();
        env.setBinding?.(bindings, avatar, nextTemplateId, cards); env.writeBindings?.(bindings); m.bindQuery = '';
        refreshManager({ scope: 'templates', reveal: { kind: 'template', id: m.bindTemplateId, selector: '.sp-alm-manager-bind-search' }, focusBindingId: m.bindTemplateId }); env.save?.();
        if (nextTemplateId && avatar === currentAvatar && env.chatId?.() === chatId) {
            await new Promise(resolve => (globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0)))(resolve));
            const latestCards = env.cards?.(); const stillCurrent = env.chatId?.() === chatId && env.currentAvatar?.() === currentAvatar && env.boundId?.(env.bindings?.() || {}, avatar, latestCards) === nextTemplateId;
            if (stillCurrent) { try { const applied = await env.applyTemplate?.({ render: false }); if (applied && ensure()) refreshManager({ scope: 'card' }); } catch (error) { env.onApplyError?.(error); } }
        }
        return true;
    };
    const saveDraft = async () => {
        const m = ensure(); if (!m) return { ok: false, reason: 'missing-manager' };
        captureDraft(); const checked = env.validate?.(m.draft); if (!checked?.value) { m.error = checked?.error || '历法格式不正确'; render(); return { ok: false, error: m.error }; }
        const result = await env.commit?.(checked.value); if (!result?.ok) { if (!result?.cancelled) { m.error = result?.error || '历法保存失败'; render(); } return result || { ok: false }; }
        m.editing = false; m.draft = env.clone?.(result.cal) || result.cal; m.error = ''; render(); return result;
    };
    const create = async ({ name, calendar } = {}) => {
        const value = String(name || '').trim();
        if (!value) return { ok: false, reason: 'name', error: '请填写模板名称' };
        const list = env.templates?.() || [];
        if (list.some(item => item.name === value)) return { ok: false, reason: 'duplicate', error: '模板名称已存在，请换一个名称' };
        const now = Date.now(); const id = env.templateId?.() || `cal-${now}-${Math.random().toString(36).slice(2, 8)}`;
        const template = { ...(env.clone?.(calendar || env.load?.()) || calendar), id, name: value, createdAt: now, updatedAt: now };
        env.saveTemplates?.([...list, template]); render({ reveal: { kind: 'template', id } });
        return { ok: true, template };
    };
    const rename = async (id, name) => {
        const value = String(name || '').trim(); const list = env.templates?.() || []; const current = list.find(item => item.id === id);
        if (!current) return { ok: false, reason: 'missing', error: '模板已不存在' };
        if (!value) return { ok: false, reason: 'name', error: '请填写模板名称' };
        if (list.some(item => item.id !== id && item.name === value)) return { ok: false, reason: 'duplicate', error: '模板名称已存在，请换一个名称' };
        env.saveTemplates?.(list.map(item => item.id === id ? { ...item, name: value, updatedAt: Date.now() } : item));
        render({ reveal: { kind: 'template', id }, focus: { kind: 'template', id, selector: '.sp-alm-manager-template-rename' } });
        return { ok: true };
    };
    const apply = async (id, options = {}) => {
        const template = (env.templates?.() || []).find(item => item.id === id);
        if (!template) return { ok: false, reason: 'missing', error: '模板已不存在' };
        const result = await env.applyCalendar?.(template, options);
        if (result?.ok === false) return result;
        return result || { ok: true, template };
    };
    const template = id => (env.templates?.() || []).find(item => item.id === id) || null;
    const deleteTemplate = async (id, options = {}) => {
        const list = env.templates?.() || [], template = list.find(item => item.id === id);
        if (!template) return { ok: false, reason: 'missing', error: '模板已不存在' };
        if (options.confirm && !await options.confirm(template)) return { ok: false, reason: 'cancelled' };
        const bindings = { ...(env.bindings?.() || {}) };
        for (const avatar of Object.keys(bindings)) if (bindings[avatar] === id) delete bindings[avatar];
        env.writeBindings?.(bindings); env.saveTemplates?.(list.filter(item => item.id !== id));
        if (ensure()) ensure().bindTemplateId = null;
        render({ focus: { selector: '.sp-alm-manager-template-head' } });
        return { ok: true, id };
    };
    const renderBody = () => `${env.renderCard?.() || ''}${env.renderTemplates?.() || ''}`;
    const renderCard = () => {
        const m = ensure(); if (!m) return '';
        const cal = m.editing ? m.draft : env.clone?.(env.load?.());
        const actions = `<span class="sp-alm-manager-card-actions">${m.editing ? '<button class="sp-icon-btn sp-alm-manager-edit-cancel" title="取消编辑" aria-label="取消编辑"><i class="fa-solid fa-xmark"></i></button><button class="sp-icon-btn sp-alm-manager-edit-save" title="保存历法" aria-label="保存历法"><i class="fa-solid fa-check"></i></button>' : '<button class="sp-icon-btn sp-alm-manager-edit-start" title="编辑历法" aria-label="编辑历法"><i class="fa-solid fa-pen"></i></button>'}</span>`;
        if (!m.editing) return `<section class="sp-alm-manager-card"><div class="sp-alm-manager-card-head"><div class="sp-alm-manager-card-title">当前历法</div>${actions}</div><div class="sp-alm-manager-card-body">${cal.era ? `<div class="sp-alm-manager-current-name">${env.escapeHtml(cal.era)}</div>` : ''}<div class="sp-alm-manager-months">${cal.months.map(month => `<span class="sp-alm-manager-month-chip">${env.escapeHtml(month.name)} · ${month.days}天</span>`).join('')}</div></div></section>`;
        const rows = cal.months.map((month, index) => `<div class="sp-alm-manager-month-row" data-index="${index}"><label class="sp-alm-manager-month-field sp-alm-manager-month-field-name"><span>月份名称</span><input class="sp-input sp-alm-manager-month-name" maxlength="${env.limits.monthNameLength}" value="${env.escapeAttr(month.name)}" aria-label="第 ${index + 1} 月名称"></label><label class="sp-alm-manager-month-field sp-alm-manager-month-field-days"><span>天数</span><input class="sp-input sp-alm-manager-month-days" type="number" min="${env.limits.monthDaysMin}" max="${env.limits.monthDaysMax}" value="${env.escapeAttr(month.days)}" aria-label="第 ${index + 1} 月天数"></label><span class="sp-alm-manager-month-actions"><button class="sp-icon-btn sp-alm-manager-month-up" title="上移月份" aria-label="上移月份"${index === 0 ? ' disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button><button class="sp-icon-btn sp-alm-manager-month-down" title="下移月份" aria-label="下移月份"${index === cal.months.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button><button class="sp-icon-btn sp-alm-manager-month-copy" title="复制月份" aria-label="复制月份"><i class="fa-solid fa-copy"></i></button><button class="sp-icon-btn sp-alm-manager-month-delete" title="删除月份" aria-label="删除月份"><i class="fa-solid fa-trash"></i></button></span></div>`).join('');
        return `<section class="sp-alm-manager-card"><div class="sp-alm-manager-card-head"><div class="sp-alm-manager-card-title">编辑当前历法</div>${actions}</div><div class="sp-alm-manager-edit-fields">${m.error ? `<div class="sp-alm-manager-error" role="alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${env.escapeHtml(m.error)}</div>` : ''}<label class="sp-alm-field"><span>纪年名 <small>选填</small></span><input id="sp-alm-manager-era" maxlength="${env.limits.eraNameLength}" value="${env.escapeAttr(cal.era)}"></label>${rows}<button class="sp-alm-manager-add-month" type="button"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>添加月份</span></button></div></section>`;
    };
    const renderBindingOptions = templateId => {
        const m = ensure(); if (!m) return '';
        const cards = env.cards?.() || [], bindings = env.bindings?.() || {}, query = String(m.bindQuery ?? ''), shown = env.bindingCandidates?.(cards, bindings, templateId, query) || [];
        if (!shown.length) return `<div class="sp-alm-manager-bind-empty">${query ? '没有匹配的角色卡' : '没有更多可添加的角色卡'}</div>`;
        return shown.map(card => `<button type="button" class="sp-alm-manager-bind-option${card.current ? ' sp-alm-manager-bind-option-current' : ''}" role="option" aria-selected="false" data-template-id="${env.escapeAttr(templateId)}" data-avatar="${env.escapeAttr(card.avatar)}" title="${env.escapeAttr(card.avatar)}"><i class="fa-solid fa-user" aria-hidden="true"></i><span class="sp-alm-manager-bind-option-label"><span class="sp-alm-manager-bind-option-name">${env.escapeHtml(card.name)}</span>${card.current ? '<small class="sp-alm-manager-bind-option-hint">(当前角色卡)</small>' : ''}</span></button>`).join('');
    };
    const renderBindingEditor = (templateId, cards, bindings) => {
        const selected = cards.filter(card => env.boundId?.(bindings, card.avatar, cards) === templateId);
        const chips = selected.map(card => `<button type="button" class="sp-alm-manager-bind-chip-remove${card.current ? ' sp-alm-manager-bind-chip-current' : ''}" data-template-id="${env.escapeAttr(templateId)}" data-avatar="${env.escapeAttr(card.avatar)}" aria-label="解除角色卡 ${env.escapeAttr(card.name)} 的模板绑定" title="解除绑定"><span>${env.escapeHtml(card.name)}</span><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`).join('');
        return `<div class="sp-alm-manager-bind-panel"><div class="sp-alm-manager-bind-chips">${chips || '<span class="sp-alm-manager-bind-empty">尚未绑定角色卡 · 当绑定角色的当前聊天既没有历法，也没有纪念日时，将自动采用此历法</span>'}</div><input type="text" class="sp-input sp-alm-manager-bind-search" role="combobox" aria-expanded="true" aria-controls="sp-alm-manager-bind-results-${env.escapeAttr(templateId)}" data-template-id="${env.escapeAttr(templateId)}" value="${env.escapeAttr(ensure().bindQuery)}" placeholder="搜索角色卡名称…" autocomplete="off"><div id="sp-alm-manager-bind-results-${env.escapeAttr(templateId)}" class="sp-alm-manager-bind-results" role="listbox">${renderBindingOptions(templateId)}</div></div>`;
    };
    const renderTemplates = () => {
        const m = ensure(); if (!m) return '';
        const cards = env.cards?.() || [], bindings = env.bindings?.() || {}, current = env.currentAvatar?.(), currentId = current ? env.boundId?.(bindings, current, cards) : '', count = id => Object.values(bindings).filter(value => value === id).length;
        const batchOn = env.batchScope?.() === 'calendar', selected = env.batchSelected?.() || new Set(), templates = env.sortTemplates?.(env.templates?.(), currentId) || [];
        const rows = templates.map(template => { const open = m.bindTemplateId === template.id, isCurrent = template.id === currentId, checked = batchOn && selected.has(template.id), checkbox = batchOn ? `<input type="checkbox" class="sp-batch-check" ${checked ? 'checked' : ''} aria-label="选择此模板">` : '', acts = batchOn ? '' : `<span class="sp-alm-manager-template-actions"><button class="sp-icon-btn sp-alm-manager-template-rename" data-id="${env.escapeAttr(template.id)}" title="重命名模板" aria-label="重命名模板"><i class="fa-solid fa-i-cursor"></i></button><button class="sp-icon-btn sp-alm-manager-template-apply" data-id="${env.escapeAttr(template.id)}" title="应用此模板" aria-label="应用此模板"><i class="fa-solid fa-file-import"></i></button><button class="sp-icon-btn sp-alm-manager-template-bind${isCurrent ? ' sp-btn-active' : ''}" data-id="${env.escapeAttr(template.id)}" title="${isCurrent ? '当前角色已绑定此模板' : '绑定角色卡'}" aria-label="绑定角色卡" aria-expanded="${open}"><i class="fa-solid fa-link"></i></button><button class="sp-icon-btn sp-alm-manager-template-delete" data-id="${env.escapeAttr(template.id)}" title="删除模板" aria-label="删除模板"><i class="fa-solid fa-trash"></i></button></span>`; return `<div class="sp-alm-manager-template-entry${isCurrent ? ' sp-alm-manager-template-current' : ''}${batchOn ? ' sp-batch-row' : ''}${checked ? ' sp-batch-checked' : ''}" data-template-id="${env.escapeAttr(template.id)}"><div class="sp-alm-manager-template-row">${checkbox}<div class="sp-alm-manager-template-main"><div class="sp-alm-manager-template-name">${env.escapeHtml(template.name)}</div><div class="sp-alm-manager-template-meta">已绑定 ${count(template.id)} 张角色卡</div></div>${acts}</div>${!batchOn && open ? renderBindingEditor(template.id, cards, bindings) : ''}</div>`; }).join('');
        return `<section class="sp-alm-manager-templates"><button class="sp-alm-manager-template-head" type="button" aria-expanded="${m.templatesOpen}"><span>模板管理</span><i class="fa-solid fa-chevron-${m.templatesOpen ? 'up' : 'down'}"></i></button>${m.templatesOpen ? `<div class="sp-alm-manager-template-body"><button type="button" class="sp-alm-manager-template-save-current"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>保存当前历法为模板</span></button>${env.batchBar?.('calendar', templates.length, '批量删除', true) || ''}<div class="sp-alm-manager-template-list">${rows || '<div class="sp-alm-manager-empty-templates">还没有历法模板</div>'}</div></div>` : ''}</section>`;
    };
    env.renderCard = renderCard;
    env.renderTemplates = renderTemplates;
    const target = (spec, $content) => {
        if (!spec) return env.emptySelection?.();
        if (spec.kind === 'month') return $content.find('.sp-alm-manager-month-row').filter(function () { return Number(env.$(this).attr('data-index')) === spec.index; }).first().find(spec.selector || '*').first();
        if (spec.kind === 'template') return $content.find('.sp-alm-manager-template-entry').filter(function () { return env.$(this).attr('data-template-id') === spec.id; }).first().find(spec.selector || '*').first();
        return $content.find(spec.selector || '*').first();
    };
    const focus = $target => { const element = $target?.get?.(0); if (!element || typeof element.focus !== 'function' || element.disabled) return; try { element.focus({ preventScroll: true }); } catch { element.focus(); } };
    const reveal = ($target, $scroller) => { const element = $target?.get?.(0), scroller = $scroller?.get?.(0); if (!element || !scroller) return; const a = element.getBoundingClientRect(), b = scroller.getBoundingClientRect(); if (a.top < b.top) scroller.scrollTop += a.top - b.top - 6; else if (a.bottom > b.bottom) scroller.scrollTop += a.bottom - b.bottom + 6; };
    const renderManager = () => `<div class="sp-alm-editor-head"><button class="sp-icon-btn sp-alm-manager-back" title="返回" aria-label="返回"><i class="fa-solid fa-arrow-left"></i></button><span class="sp-alm-editor-title">历法管理</span></div><div class="sp-alm-manager-hint">不想自己填？<button type="button" class="sp-alm-manager-chat-link">和间聊聊吧 →</button></div><div class="sp-alm-body"><div class="sp-alm-editor-body">${renderBody()}</div></div>`;
    const refreshManager = (options = {}) => {
        const $wrap = env.root?.(), $scroller = $wrap?.find('.sp-alm-body').first(), $content = $scroller?.children('.sp-alm-editor-body').first();
        if (!$wrap?.find('.sp-alm-manager-hint').length || !$content?.length) return false;
        const $oldSearch = $content.find('.sp-alm-manager-bind-search').first();
        const old = $oldSearch.length ? { id: $oldSearch.attr('data-template-id'), query: String($oldSearch.val() ?? ''), active: (env.activeElement?.() || globalThis.document?.activeElement) === $oldSearch.get(0), start: $oldSearch.get(0).selectionStart, end: $oldSearch.get(0).selectionEnd, scroll: $oldSearch.closest('.sp-alm-manager-bind-panel').find('.sp-alm-manager-bind-results').scrollTop() || 0 } : null;
        if (options.scope === 'templates') { const node = $content.children('.sp-alm-manager-templates').first(); if (!node.length) return false; node.replaceWith(env.renderTemplates?.() || ''); }
        else if (options.scope === 'card') { const node = $content.children('.sp-alm-manager-card').first(); if (!node.length) return false; node.replaceWith(env.renderCard?.() || ''); }
        else $content.html(renderBody());
        const focusId = options.focusBindingId || (old?.active ? old.id : null);
        if (old) { const next = $content.find('.sp-alm-manager-bind-search').filter(function () { return env.$(this).attr('data-template-id') === old.id; }).first(); if (next.length && String(next.val() ?? '') === old.query) { next.closest('.sp-alm-manager-bind-panel').find('.sp-alm-manager-bind-results').scrollTop(old.scroll); if (old.active) { focus(next); next.get(0).setSelectionRange(old.start, old.end); } } }
        if (focusId) focus($content.find('.sp-alm-manager-bind-search').filter(function () { return env.$(this).attr('data-template-id') === focusId; }).first()); else if (options.focus) focus(target(options.focus, $content));
        reveal(target(options.reveal, $content), $scroller); return true;
    };
    return { begin, close, isOpen, isEditing, bindingId, startEditing, cancelEditing, captureDraft, saveDraft, create, rename, apply, template, delete: deleteTemplate, addMonth, deleteMonth, copyMonth, moveMonth, toggleTemplates, setBindingView, setBindingQuery, clearError, hasError, updateBinding, renderBindingOptions, renderCalendarManager: renderManager, refreshCalendarManager: refreshManager };
}
