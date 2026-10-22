import { icon } from './utils/icons.js';
const OVERLAY_ID = 'sp-addon-dialog';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeTextareaRows(value) {
    const rows = Math.floor(Number(value));
    return Number.isFinite(rows) ? Math.min(12, Math.max(1, rows)) : 3;
}

// 通用决策弹窗只管理自身遮罩和 Promise 生命周期；业务判断与持久化留给调用方。
// removeOverlay（可选）：宿主使用独立 shadow 时必须注入正确查询根；否则默认用全局 $() 移除。
export function createDialogManager({ $, mount, getRootClass = () => '', subscribeContextChange = () => () => {}, removeOverlay = null } = {}) {
    if (typeof $ !== 'function' || !mount?.appendChild) throw new TypeError('弹窗管理器缺少 DOM 依赖');
    const purgeOverlay = removeOverlay || (() => $(`#${OVERLAY_ID}`).remove());

    let activeCancel = null;

    function cancelActive() {
        if (!activeCancel) return false;
        activeCancel();
        return true;
    }

    function prepareDialog() {
        cancelActive();
        purgeOverlay();
    }

    // 所有弹窗共用同一套关闭语义，避免某个接口漏掉遮罩、Esc 或聊天切换清理。
    function mountDialog($overlay, resolve, { onClose } = {}) {
        let done = false;
        let unsubscribe = () => {};
        const finish = value => {
            if (done) return false;
            done = true;
            if (activeCancel === externalClose) activeCancel = null;
            try { onClose?.(); }
            finally {
                unsubscribe();
                $overlay.remove();
                resolve(value);
            }
            return true;
        };
        const externalClose = () => finish(null);
        activeCancel = externalClose;
        $overlay.on('click', function (event) { if (event.target === this) externalClose(); });
        $overlay.on('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            externalClose();
        });
        $overlay.addClass(String(getRootClass() || ''));
        mount.appendChild($overlay[0]);
        unsubscribe = subscribeContextChange(externalClose) || (() => {});
        return Object.freeze({ finish, close: externalClose, isDone: () => done });
    }

    function choose({ title = '', body = '', note = '', choices = [], scrollable = false } = {}) {
        if (!Array.isArray(choices) || !choices.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            const buttons = choices.map((choice, index) => {
                const tone = choice.primary ? 'primary' : 'secondary';
                return `<button class="sp-dialog-button sp-dialog-button-${tone}" type="button" data-dialog-choice="${index}">${escapeHtml(choice.label)}</button>`;
            }).join('');
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet${scrollable ? ' sp-dialog-editor-sheet' : ''}" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    <div class="sp-dialog-body">${escapeHtml(body)}</div>
                    ${note ? `<div class="sp-dialog-note">${escapeHtml(note)}</div>` : ''}
                    <div class="sp-dialog-actions">${buttons}</div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve);
            $overlay.find('[data-dialog-choice]').on('click', function () {
                const choice = choices[Number($(this).attr('data-dialog-choice'))];
                session.finish(choice?.value ?? null);
            });
            setTimeout(() => $overlay.find('[data-dialog-choice]').last().trigger('focus'), 0);
        });
    }

    function confirm({ title, body, note, confirmText = '确定', cancelText = '取消' } = {}) {
        return choose({
            title,
            body,
            note,
            choices: [
                { value: 'cancel', label: cancelText },
                { value: 'confirm', label: confirmText, primary: true },
            ],
        }).then(value => value === 'confirm');
    }

    function prompt({ title = '', body = '', initialValue = '', placeholder = '', maxLength = 40, confirmText = '保存', cancelText = '取消', validate } = {}) {
        return new Promise(resolve => {
            prepareDialog();
            const limit = Number(maxLength) > 0 ? Number(maxLength) : 40;
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <input type="text" class="sp-dialog-input" value="${escapeHtml(initialValue)}" placeholder="${escapeHtml(placeholder)}" maxlength="${limit}" autocomplete="off">
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        <button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve);
            const submit = () => {
                const value = String($overlay.find('.sp-dialog-input').val() ?? '').trim();
                // 校验器返回非空字符串时显示错误，其它返回值均视为通过。
                const raw = typeof validate === 'function' ? validate(value) : '';
                const error = typeof raw === 'string' ? raw : '';
                if (error) {
                    $overlay.find('.sp-dialog-input-error').html(`${icon("alert-triangle")} ${escapeHtml(error)}`);
                    $overlay.find('.sp-dialog-input').trigger('focus');
                    return;
                }
                session.finish(value);
            };
            $overlay.find('.sp-dialog-submit').on('click', submit);
            $overlay.find('.sp-dialog-cancel').on('click', session.close);
            $overlay.find('.sp-dialog-input').on('input', () => $overlay.find('.sp-dialog-input-error').empty()).on('keydown', event => {
                if (event.key === 'Enter') { event.preventDefault(); submit(); }
                else if (event.key === 'Escape') { event.preventDefault(); session.close(); }
            });
            setTimeout(() => $overlay.find('.sp-dialog-input').trigger('focus').trigger('select'), 0);
        });
    }

    function custom({ title = '', content, confirmText = '确定', cancelText = '取消', submit, onClose } = {}) {
        if (!content || typeof submit !== 'function') throw new TypeError('自定义弹窗内容无效');
        return new Promise(resolve => {
            prepareDialog();
            let previousFocus = globalThis.document?.activeElement;
            while (previousFocus?.shadowRoot?.activeElement) previousFocus = previousFocus.shadowRoot.activeElement;
            const cancelButton = cancelText === '' || cancelText === null ? '' : `<button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>`;
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet sp-dialog-sheet-custom" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    <div class="sp-dialog-custom"></div>
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        ${cancelButton}
                        <button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            </div>`);
            $overlay.find('.sp-dialog-custom')[0]?.appendChild?.(content);
            const session = mountDialog($overlay, resolve, { onClose: () => { try { onClose?.(); } finally { if (previousFocus?.isConnected) previousFocus.focus(); } } });
            let submitting = false;
            const runSubmit = async () => {
                if (submitting || session.isDone()) return;
                submitting = true; $overlay.find('.sp-dialog-input-error').empty();
                try { const value = await submit(); session.finish(value ?? true); }
                catch (error) {
                    submitting = false;
                    $overlay.find('.sp-dialog-input-error').html(`${icon("alert-triangle")} ${escapeHtml('操作失败，请重试。')}`);
                }
            };
            $overlay.find('.sp-dialog-submit').on('click', runSubmit);
            $overlay.find('.sp-dialog-cancel').on('click', session.close);
            if (String(content.tagName ?? content.tag ?? '').toLowerCase() === 'form') {
                content.addEventListener?.('submit', event => { event.preventDefault(); runSubmit(); });
                content.addEventListener?.('keydown', event => {
                    const target = event.target;
                    const type = String(target?.type ?? target?.getAttribute?.('type') ?? 'text').toLowerCase();
                    if (String(target?.tagName ?? target?.tag ?? '').toLowerCase() !== 'input' || !['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week'].includes(type) || event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
                    event.preventDefault(); runSubmit();
                });
            }
            setTimeout(() => $overlay.find('.sp-dialog-submit').trigger('focus'), 0);
        });
    }

    // 通用多选表单：只负责选项互斥、自定义文本与生命周期，具体选项和业务校验由调用方提供。
    function selectMany({ title = '', body = '', choices = [], initialValues = [], custom = null, confirmText = '确定', cancelText = '取消', validate } = {}) {
        if (!Array.isArray(choices) || !choices.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            const initial = new Set((Array.isArray(initialValues) ? initialValues : []).map(String));
            const customValue = custom?.value == null ? '' : String(custom.value);
            const customLimit = Number(custom?.maxLength) > 0 ? Number(custom.maxLength) : 200;
            const customRows = normalizeTextareaRows(custom?.rows);
            const rows = choices.map(choice => {
                const value = String(choice?.value ?? '');
                const checked = initial.has(value) ? ' checked' : '';
                const exclusive = choice?.exclusive ? ' data-dialog-exclusive="true"' : '';
                return `<label class="sp-dialog-multi-option">
                    <input type="checkbox" class="sp-dialog-multi-check" data-dialog-value="${escapeHtml(value)}"${exclusive}${checked}>
                    <span>${escapeHtml(choice?.label ?? value)}</span>
                </label>`;
            }).join('');
            const customInput = customValue
                ? `<textarea class="sp-dialog-custom-input" maxlength="${customLimit}" placeholder="${escapeHtml(custom?.placeholder || '')}" rows="${customRows}"></textarea>`
                : '';
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <div class="sp-dialog-multi-list">${rows}</div>
                    ${customInput}
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        <button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve);
            const selectedValues = () => {
                const values = [];
                $overlay.find('.sp-dialog-multi-check').each(function () {
                    if ($(this).prop('checked')) values.push(String($(this).attr('data-dialog-value') || ''));
                });
                return values;
            };
            const syncCustomInput = () => {
                if (!customValue) return;
                const on = selectedValues().includes(customValue);
                $overlay.find('.sp-dialog-custom-input').prop('hidden', !on).prop('disabled', !on);
            };
            const submit = () => {
                const values = selectedValues();
                const inputValue = customValue && values.includes(customValue)
                    ? String($overlay.find('.sp-dialog-custom-input').val() ?? '').trim()
                    : '';
                const result = { values, customValue: inputValue };
                const raw = typeof validate === 'function' ? validate(result) : '';
                const error = typeof raw === 'string' ? raw : '';
                if (error) {
                    $overlay.find('.sp-dialog-input-error').html(`${icon("alert-triangle")} ${escapeHtml(error)}`);
                    if (customValue && values.includes(customValue) && !inputValue) $overlay.find('.sp-dialog-custom-input').trigger('focus');
                    return;
                }
                session.finish(result);
            };
            $overlay.find('.sp-dialog-multi-check').on('change', function () {
                const $self = $(this);
                if ($self.prop('checked')) {
                    if ($self.attr('data-dialog-exclusive') === 'true') {
                        $overlay.find('.sp-dialog-multi-check').each(function () { if (this !== $self[0]) $(this).prop('checked', false); });
                    } else {
                        $overlay.find('.sp-dialog-multi-check[data-dialog-exclusive="true"]').prop('checked', false);
                    }
                }
                $overlay.find('.sp-dialog-input-error').empty();
                syncCustomInput();
            });
            $overlay.find('.sp-dialog-custom-input').on('input', () => $overlay.find('.sp-dialog-input-error').empty()).on('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); session.close(); }
            });
            $overlay.find('.sp-dialog-submit').on('click', submit);
            $overlay.find('.sp-dialog-cancel').on('click', session.close);
            syncCustomInput();
            setTimeout(() => $overlay.find('.sp-dialog-multi-check').first().trigger('focus'), 0);
        });
    }

    // 通用单选表单：支持一个可展开的自定义输入，以及由调用方定义的多个提交动作。
    function selectOne({ title = '', body = '', choices = [], initialValue = '', custom = null, actions = [], cancelText = '取消', validate } = {}) {
        if (!Array.isArray(choices) || !choices.length || !Array.isArray(actions) || !actions.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            let selected = String(initialValue || choices[0]?.value || '');
            const customValue = custom?.value == null ? '' : String(custom.value);
            const customLimit = Number(custom?.maxLength) > 0 ? Number(custom.maxLength) : 200;
            const customInitialValue = String(custom?.initialValue ?? '').slice(0, customLimit);
            const customRows = normalizeTextareaRows(custom?.rows);
            const options = choices.map(choice => {
                const value = String(choice?.value ?? '');
                const pressed = value === selected ? 'true' : 'false';
                return `<button type="button" class="sp-dialog-single-option${value === selected ? ' sp-dialog-single-selected' : ''}" data-dialog-value="${escapeHtml(value)}" aria-pressed="${pressed}">${escapeHtml(choice?.label ?? value)}</button>`;
            }).join('');
            const actionButtons = actions.map((action, index) => {
                const tone = action?.primary ? 'primary' : 'secondary';
                return `<button type="button" class="sp-dialog-button sp-dialog-button-${tone}" data-dialog-action="${index}">${escapeHtml(action?.label ?? '')}</button>`;
            }).join('');
            const customInput = customValue
                ? `<textarea class="sp-dialog-custom-input" maxlength="${customLimit}" placeholder="${escapeHtml(custom?.placeholder || '')}" rows="${customRows}"${selected === customValue ? '' : ' hidden disabled'}></textarea>`
                : '';
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <div class="sp-dialog-single-list">${options}</div>
                    ${customInput}
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        ${actionButtons}
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve);
            if (customValue) $overlay.find('.sp-dialog-custom-input').val(customInitialValue);
            const syncSelection = () => {
                $overlay.find('.sp-dialog-single-option').each(function () {
                    const on = String($(this).attr('data-dialog-value') || '') === selected;
                    $(this).toggleClass('sp-dialog-single-selected', on).attr('aria-pressed', String(on));
                });
                if (customValue) {
                    const on = selected === customValue;
                    $overlay.find('.sp-dialog-custom-input').prop('hidden', !on).prop('disabled', !on);
                    if (on) $overlay.find('.sp-dialog-custom-input').trigger('focus');
                }
            };
            const submit = action => {
                const inputValue = customValue && selected === customValue
                    ? String($overlay.find('.sp-dialog-custom-input').val() ?? '').trim()
                    : '';
                const result = { action: String(action?.value ?? ''), value: selected, customValue: inputValue };
                const raw = typeof validate === 'function' ? validate(result) : '';
                const error = typeof raw === 'string' ? raw : '';
                if (error) {
                    $overlay.find('.sp-dialog-input-error').html(`${icon("alert-triangle")} ${escapeHtml(error)}`);
                    if (customValue && selected === customValue) $overlay.find('.sp-dialog-custom-input').trigger('focus');
                    return;
                }
                session.finish(result);
            };
            $overlay.find('.sp-dialog-single-option').on('click', function () {
                selected = String($(this).attr('data-dialog-value') || '');
                $overlay.find('.sp-dialog-input-error').empty();
                syncSelection();
            });
            $overlay.find('.sp-dialog-custom-input').on('input', () => $overlay.find('.sp-dialog-input-error').empty());
            $overlay.find('[data-dialog-action]').on('click', function () {
                submit(actions[Number($(this).attr('data-dialog-action'))]);
            });
            $overlay.find('.sp-dialog-cancel').on('click', session.close);
            syncSelection();
            setTimeout(() => $overlay.find('.sp-dialog-single-option').first().trigger('focus'), 0);
        });
    }

    // 通用异步单选：第二类弹窗自行加载选项，可在同一弹窗内重新加载并中止上一轮请求。
    function selectOneAsync({ title = '', body = '', loadChoices, refreshable = false, refreshText = '重新加载', confirmText = '确定', cancelText = '取消', cancelValue = null, loadingText = '正在加载…', emptyText = '没有可选内容', loadErrorText = '读取失败，请稍后重试' } = {}) {
        if (typeof loadChoices !== 'function') return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            let requestAbort = null;
            let runId = 0;
            let choices = [];
            let selected = '';
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet sp-dialog-async-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <div class="sp-dialog-async-body"></div>
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        ${refreshable ? `<button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-async-refresh" type="button">${escapeHtml(refreshText)}</button>` : ''}
                        <button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button" disabled>${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve, { onClose: () => {
                runId++;
                requestAbort?.abort();
                requestAbort = null;
            } });
            const renderChoices = () => {
                const html = choices.length
                    ? `<div class="sp-dialog-single-list sp-dialog-async-list" role="radiogroup">${choices.map(choice => {
                        const value = String(choice?.value ?? '');
                        const on = value === selected;
                        return `<button type="button" role="radio" class="sp-dialog-single-option${on ? ' sp-dialog-single-selected' : ''}" data-dialog-value="${escapeHtml(value)}" aria-checked="${String(on)}">${icon(on ? 'circle-check' : 'circle')}<span>${escapeHtml(choice?.label ?? value)}</span></button>`;
                    }).join('')}</div>`
                    : `<div class="sp-dialog-async-empty">${escapeHtml(emptyText)}</div>`;
                $overlay.find('.sp-dialog-async-body').html(html);
                $overlay.find('.sp-dialog-submit').prop('disabled', !selected);
            };
            const load = async () => {
                const myRun = ++runId;
                requestAbort?.abort();
                requestAbort = new AbortController();
                selected = '';
                choices = [];
                $overlay.find('.sp-dialog-input-error').empty();
                $overlay.find('.sp-dialog-submit').prop('disabled', true);
                $overlay.find('.sp-dialog-async-refresh').prop('disabled', true);
                $overlay.find('.sp-dialog-async-body').html(`<div class="sp-dialog-async-loading">${icon("loader-2", "sp-icon-spin")} ${escapeHtml(loadingText)}</div>`);
                try {
                    const loaded = await loadChoices({ signal: requestAbort.signal });
                    if (session.isDone() || myRun !== runId) return;
                    choices = Array.isArray(loaded) ? loaded : [];
                    renderChoices();
                } catch (error) {
                    if (session.isDone() || myRun !== runId || error?.name === 'AbortError') return;
                    const message = typeof loadErrorText === 'function' ? loadErrorText(error) : loadErrorText;
                    $overlay.find('.sp-dialog-async-body').html(`<div class="sp-dialog-async-empty">${icon("alert-triangle")} ${escapeHtml(message || '读取失败，请稍后重试')}</div>`);
                    $overlay.find('.sp-dialog-input-error').empty();
                } finally {
                    if (!session.isDone() && myRun === runId) {
                        requestAbort = null;
                        $overlay.find('.sp-dialog-async-refresh').prop('disabled', false);
                    }
                }
            };
            $overlay.on('click', '.sp-dialog-single-option', function () {
                selected = String($(this).attr('data-dialog-value') || '');
                renderChoices();
            });
            $overlay.find('.sp-dialog-async-refresh').on('click', load);
            $overlay.find('.sp-dialog-submit').on('click', () => { if (selected) session.finish(selected); });
            $overlay.find('.sp-dialog-cancel').on('click', () => session.finish(cancelValue));
            load();
        });
    }

    function promptTextarea({ title = '', body = '', initialValue = '', placeholder = '', maxLength = 4000, rows = 5, confirmText = '保存', cancelText = '取消', validate } = {}) {
        return new Promise(resolve => {
            prepareDialog();
            const limit = Number(maxLength) > 0 ? Number(maxLength) : 4000;
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay"><div class="sp-dialog-sheet sp-dialog-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title"><div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}<textarea class="sp-dialog-custom-input" rows="${normalizeTextareaRows(rows)}" maxlength="${limit}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(initialValue)}</textarea><div class="sp-dialog-input-error" aria-live="polite"></div><div class="sp-dialog-actions"><button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button><button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button">${escapeHtml(confirmText)}</button></div></div></div>`);
            const session = mountDialog($overlay, resolve);
            const submit = () => { const value = String($overlay.find('.sp-dialog-custom-input').val() ?? ''); const error = typeof validate === 'function' ? validate(value) : ''; if (typeof error === 'string' && error) { $overlay.find('.sp-dialog-input-error').html(`${icon("alert-triangle")} ${escapeHtml(error)}`); return; } session.finish(value); };
            $overlay.find('.sp-dialog-submit').on('click', submit); $overlay.find('.sp-dialog-cancel').on('click', session.close); $overlay.find('.sp-dialog-custom-input').on('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); session.close(); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } });
            setTimeout(() => $overlay.find('.sp-dialog-custom-input').trigger('focus'), 0);
        });
    }

    function promptFields({ title = '', body = '', fields = [], confirmText = '保存', cancelText = '取消', validate } = {}) {
        if (!Array.isArray(fields) || !fields.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            const controls = fields.map((field, index) => {
                const name = String(field?.name || `field${index}`); const label = escapeHtml(field?.label || name); const value = escapeHtml(field?.value ?? '');
                const control = field?.type === 'input' ? `<input class="sp-dialog-input" data-dialog-field="${escapeHtml(name)}" value="${value}" placeholder="${escapeHtml(field?.placeholder || '')}" maxlength="${Number(field?.maxLength) > 0 ? Number(field.maxLength) : 4000}">` : `<textarea class="sp-dialog-custom-input" data-dialog-field="${escapeHtml(name)}" rows="${normalizeTextareaRows(field?.rows || 3)}" maxlength="${Number(field?.maxLength) > 0 ? Number(field.maxLength) : 4000}" placeholder="${escapeHtml(field?.placeholder || '')}">${value}</textarea>`;
                return `<label class="sp-dialog-field"><span>${label}</span>${control}</label>${index < fields.length - 1 ? '<div class="sp-dialog-divider"></div>' : ''}`;
            }).join('');
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay"><div class="sp-dialog-sheet sp-dialog-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title"><div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}<div class="sp-dialog-fields sp-dialog-editor-fields">${controls}</div><div class="sp-dialog-input-error" aria-live="polite"></div><div class="sp-dialog-actions"><button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button><button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button">${escapeHtml(confirmText)}</button></div></div></div>`);
            const session = mountDialog($overlay, resolve);
            const submit = () => { const result = {}; $overlay.find('[data-dialog-field]').each(function () { result[String($(this).attr('data-dialog-field'))] = String($(this).val() ?? ''); }); const error = typeof validate === 'function' ? validate(result) : ''; if (typeof error === 'string' && error) { $overlay.find('.sp-dialog-input-error').text(error); return; } session.finish(result); };
            $overlay.find('.sp-dialog-submit').on('click', submit); $overlay.find('.sp-dialog-cancel').on('click', session.close); $overlay.find('[data-dialog-field]').on('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); session.close(); } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } });
            setTimeout(() => $overlay.find('[data-dialog-field]').first().trigger('focus'), 0);
        });
    }

    return Object.freeze({ confirm, choose, prompt, promptTextarea, promptFields, selectMany, selectOne, selectOneAsync, custom, cancelActive });
}
