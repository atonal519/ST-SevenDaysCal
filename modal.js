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
// removeOverlay（可选）：注入"移除已存在 overlay"的实现——宿主迁入 shadow 后，light DOM 的
// $() 查不到 overlay，由调用方提供（如 () => $in('#sp-addon-dialog').remove()）。
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

    function choose({ title = '', body = '', note = '', choices = [] } = {}) {
        if (!Array.isArray(choices) || !choices.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            const buttons = choices.map((choice, index) => {
                const tone = choice.primary ? 'primary' : 'secondary';
                return `<button class="sp-dialog-button sp-dialog-button-${tone}" type="button" data-dialog-choice="${index}">${escapeHtml(choice.label)}</button>`;
            }).join('');
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
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
                // 校验约定：返回非空字符串＝错误信息，其它（''/null/undefined/true/数字/对象）一律算通过。
                // 旧写法 String(validate()||'') 会把 true→"true"、对象→"[object Object]" 误当错误显示，且吞掉 0/false。
                const raw = typeof validate === 'function' ? validate(value) : '';
                const error = typeof raw === 'string' ? raw : '';
                if (error) {
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error)}`);
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
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error)}`);
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
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error)}`);
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
    function selectOneAsync({ title = '', body = '', loadChoices, refreshable = false, refreshText = '重新加载', confirmText = '确定', cancelText = '取消', cancelValue = null, loadingText = '正在加载…', emptyText = '没有可选内容' } = {}) {
        if (typeof loadChoices !== 'function') return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            let requestAbort = null;
            let runId = 0;
            let choices = [];
            let selected = '';
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
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
                        return `<button type="button" role="radio" class="sp-dialog-single-option${on ? ' sp-dialog-single-selected' : ''}" data-dialog-value="${escapeHtml(value)}" aria-checked="${String(on)}"><i class="${on ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle'}" aria-hidden="true"></i><span>${escapeHtml(choice?.label ?? value)}</span></button>`;
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
                $overlay.find('.sp-dialog-async-body').html(`<div class="sp-dialog-async-loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(loadingText)}</div>`);
                try {
                    const loaded = await loadChoices({ signal: requestAbort.signal });
                    if (session.isDone() || myRun !== runId) return;
                    choices = Array.isArray(loaded) ? loaded : [];
                    renderChoices();
                } catch (error) {
                    if (session.isDone() || myRun !== runId || error?.name === 'AbortError') return;
                    $overlay.find('.sp-dialog-async-body').html(`<div class="sp-dialog-async-empty">${escapeHtml(emptyText)}</div>`);
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error?.message || '加载失败')}`);
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

    return Object.freeze({ confirm, choose, prompt, selectMany, selectOne, selectOneAsync, cancelActive });
}
