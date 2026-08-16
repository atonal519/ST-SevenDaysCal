const OVERLAY_ID = 'sp-addon-dialog';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

    function choose({ title = '', body = '', note = '', choices = [] } = {}) {
        if (!Array.isArray(choices) || !choices.length) return Promise.resolve(null);
        return new Promise(resolve => {
            cancelActive();
            purgeOverlay();
            let done = false;
            let unsubscribe = () => {};
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
            const finish = value => {
                if (done) return;
                done = true;
                if (activeCancel === onExternalClose) activeCancel = null;
                unsubscribe();
                $overlay.remove();
                resolve(value);
            };
            const onExternalClose = () => finish(null);
            activeCancel = onExternalClose;
            $overlay.find('[data-dialog-choice]').on('click', function () {
                const choice = choices[Number($(this).attr('data-dialog-choice'))];
                finish(choice?.value ?? null);
            });
            $overlay.on('click', function (event) { if (event.target === this) finish(null); });
            $overlay.on('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); finish(null); } });
            $overlay.addClass(String(getRootClass() || ''));
            mount.appendChild($overlay[0]);
            unsubscribe = subscribeContextChange(onExternalClose) || (() => {});
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
            cancelActive();
            purgeOverlay();
            let done = false;
            let unsubscribe = () => {};
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
            const finish = value => {
                if (done) return;
                done = true;
                if (activeCancel === onExternalClose) activeCancel = null;
                unsubscribe();
                $overlay.remove();
                resolve(value);
            };
            const onExternalClose = () => finish(null);
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
                finish(value);
            };
            activeCancel = onExternalClose;
            $overlay.find('.sp-dialog-submit').on('click', submit);
            $overlay.find('.sp-dialog-cancel').on('click', () => finish(null));
            $overlay.find('.sp-dialog-input').on('input', () => $overlay.find('.sp-dialog-input-error').empty()).on('keydown', event => {
                if (event.key === 'Enter') { event.preventDefault(); submit(); }
                else if (event.key === 'Escape') { event.preventDefault(); finish(null); }
            });
            $overlay.on('click', function (event) { if (event.target === this) finish(null); });
            $overlay.addClass(String(getRootClass() || ''));
            mount.appendChild($overlay[0]);
            unsubscribe = subscribeContextChange(onExternalClose) || (() => {});
            setTimeout(() => $overlay.find('.sp-dialog-input').trigger('focus').trigger('select'), 0);
        });
    }

    // 通用多选表单：只负责选项互斥、自定义文本与生命周期，具体选项和业务校验由调用方提供。
    function selectMany({ title = '', body = '', choices = [], initialValues = [], custom = null, confirmText = '确定', cancelText = '取消', validate } = {}) {
        if (!Array.isArray(choices) || !choices.length) return Promise.resolve(null);
        return new Promise(resolve => {
            cancelActive();
            purgeOverlay();
            let done = false;
            let unsubscribe = () => {};
            const initial = new Set((Array.isArray(initialValues) ? initialValues : []).map(String));
            const customValue = custom?.value == null ? '' : String(custom.value);
            const customLimit = Number(custom?.maxLength) > 0 ? Number(custom.maxLength) : 200;
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
                ? `<textarea class="sp-dialog-custom-input" maxlength="${customLimit}" placeholder="${escapeHtml(custom?.placeholder || '')}" rows="3"></textarea>`
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
            const finish = value => {
                if (done) return;
                done = true;
                if (activeCancel === onExternalClose) activeCancel = null;
                unsubscribe();
                $overlay.remove();
                resolve(value);
            };
            const onExternalClose = () => finish(null);
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
                finish(result);
            };
            activeCancel = onExternalClose;
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
                if (event.key === 'Escape') { event.preventDefault(); finish(null); }
            });
            $overlay.find('.sp-dialog-submit').on('click', submit);
            $overlay.find('.sp-dialog-cancel').on('click', () => finish(null));
            $overlay.on('click', function (event) { if (event.target === this) finish(null); });
            $overlay.on('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); finish(null); } });
            $overlay.addClass(String(getRootClass() || ''));
            mount.appendChild($overlay[0]);
            unsubscribe = subscribeContextChange(onExternalClose) || (() => {});
            syncCustomInput();
            setTimeout(() => $overlay.find('.sp-dialog-multi-check').first().trigger('focus'), 0);
        });
    }

    return Object.freeze({ confirm, choose, prompt, selectMany, cancelActive });
}
