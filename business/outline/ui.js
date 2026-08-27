import { classifyGenerationError, diagnosticMessage } from '../../api/diagnostics.js';

export function createOutlineUi(host = {}) {
    let controllers = null;
    let bound = false;
    const injectTexts = new Map();
    const copyTexts = new Map();
    let injectSequence = 0;
    let copySequence = 0;
    const query = selector => host.query?.(selector);
    const element = selector => host.element?.(selector);
    const escape = value => host.escapeHtml?.(String(value ?? '')) ?? String(value ?? '');

    const makeInjectButton = text => {
        const id = ++injectSequence;
        injectTexts.set(String(id), text);
        return String(id);
    };
    const makeCopyButton = text => {
        const id = ++copySequence;
        copyTexts.set(String(id), text);
        return String(id);
    };
    const setOutline = html => host.setOutline?.(html);
    const setLoading = () => setOutline(host.loading?.('正在构思面', 'sp-abort-outline') || '');
    const toast = (message, error = false) => host.toast?.(message, error);
    const showGenerationError = error => {
        const retry = classifyGenerationError(error) === 'config-missing' ? '' : '<button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">重新生成面</button>';
        setOutline(`<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${escape(diagnosticMessage(error))}</p>${retry}</div>`);
    };
    const appendMessage = (role, content, historyIndex = null) => {
        const source = String(content ?? '');
        const display = source.replace(/<outline_widget[\s\S]*?<\/outline_widget>/gi, '[↑ 已生成新面]');
        const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
        const wrapClass = role === 'user' ? 'sp-chat-msg-wrap-user'
            : role === 'ai' ? 'sp-chat-msg-wrap-ai' : 'sp-chat-msg-wrap-system';
        const canAct = role !== 'system' && Number.isInteger(historyIndex);
        const contentHtml = role === 'ai'
            ? host.formatAi?.(display) ?? escape(display).replace(/\n/g, '<br>')
            : escape(display).replace(/\n/g, '<br>');
        const $wrap = host.$?.('<div>').addClass(`sp-chat-msg-wrap ${wrapClass}`);
        if (!$wrap) return;
        if (canAct) $wrap.attr('data-idx', historyIndex);
        const $message = host.$('<div>').addClass(`sp-chat-msg ${cls}`);
        $message.html(`<div class="sp-chat-msg-content">${contentHtml}</div>`);
        $wrap.append($message);
        if (canAct) {
            const edit = role === 'user' ? '<button class="sp-chat-msg-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>' : '';
            $wrap.append(`<div class="sp-chat-msg-actions">${edit}<button class="sp-chat-msg-delete" title="删除"><i class="fa-solid fa-trash"></i></button></div>`);
        }
        $wrap.appendTo(query('#sp-chat-msgs'));
        const messages = element('#sp-chat-msgs');
        if (messages) messages.scrollTop = messages.scrollHeight;
    };
    const renderHistory = history => {
        const $messages = query('#sp-chat-msgs');
        $messages?.empty?.();
        history.forEach((message, index) => appendMessage(message.role === 'assistant' ? 'ai' : message.role, message.content, index));
    };
    const beginThinking = () => {
        const $dots = host.$?.('<div>')
            .addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking')
            .html('<span class="sp-typing"><i></i><i></i><i></i></span>')
            .appendTo(query('#sp-chat-msgs'));
        const messages = element('#sp-chat-msgs');
        if (messages) messages.scrollTop = messages.scrollHeight;
        return $dots;
    };
    const endThinking = thinking => thinking?.remove?.();
    const showApply = apply => {
        const $button = host.$?.('<button class="sp-apply-outline-btn">应用此面</button>');
        if (!$button) return;
        $button.on('click', () => apply($button));
        host.$('<div class="sp-chat-msg sp-chat-msg-system sp-apply-row"></div>')
            .append($button)
            .appendTo(query('#sp-chat-msgs'));
        const messages = element('#sp-chat-msgs');
        if (messages) messages.scrollTop = messages.scrollHeight;
    };
    const markApplied = button => button?.text?.('✓ 已应用')?.prop?.('disabled', true);
    const resetTextMaps = () => {
        injectTexts.clear();
        copyTexts.clear();
    };

    const startEdit = ($message, index) => {
        const original = controllers?.chat.history?.()[index]?.content ?? '';
        $message.find('.sp-chat-msg-content').replaceWith(`<textarea class="sp-chat-msg-editor">${escape(original)}</textarea>`);
        $message.find('.sp-chat-msg-actions').replaceWith(
            '<div class="sp-chat-msg-actions sp-chat-msg-editing">' +
            '<button class="sp-chat-msg-edit-save">保存并重发</button>' +
            '<button class="sp-chat-msg-edit-cancel">取消</button></div>',
        );
        const $textarea = $message.find('.sp-chat-msg-editor');
        $textarea.trigger('focus');
        const value = $textarea.val();
        $textarea[0]?.setSelectionRange?.(value.length, value.length);
        $message.find('.sp-chat-msg-edit-cancel').on('click', () => renderHistory(controllers.chat.history()));
        $message.find('.sp-chat-msg-edit-save').on('click', () => {
            if (controllers.chat.busy) return;
            const next = String($textarea.val() || '').trim();
            if (next) void controllers.chat.resendFrom(index, next);
        });
        $textarea.on('keydown', event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                $message.find('.sp-chat-msg-edit-save').trigger('click');
            } else if (event.key === 'Escape') {
                event.preventDefault();
                renderHistory(controllers.chat.history());
            }
        });
    };

    const bind = () => {
        if (bound) return;
        const $root = query('#sp-outline-wrap');
        if (!$root?.length) return;
        bound = true;
        $root.off('.spOutlineFeature');
        $root.on('click.spOutlineFeature', '#sp-chat-send', () => {
            const $input = query('#sp-chat-input');
            const message = String($input?.val?.() || '').trim();
            if (!message || controllers.chat.busy) return;
            $input.val('');
            host.autoGrow?.($input[0]);
            void controllers.chat.send(message);
        });
        $root.on('input.spOutlineFeature', '#sp-chat-input', function () { host.autoGrow?.(this); });
        $root.on('click.spOutlineFeature', '.sp-chat-msg-delete', function () {
            if (controllers.chat.busy) return;
            const index = Number(host.$(this).closest('.sp-chat-msg-wrap').attr('data-idx'));
            controllers.chat.remove(index);
        });
        $root.on('click.spOutlineFeature', '.sp-chat-msg-edit', function () {
            if (controllers.chat.busy) return;
            const $message = host.$(this).closest('.sp-chat-msg-wrap');
            const index = Number($message.attr('data-idx'));
            if (Number.isInteger(index)) startEdit($message, index);
        });
        $root.on('click.spOutlineFeature', '#sp-chat-clear', async () => {
            if (controllers.chat.busy || !controllers.chat.history().length) return;
            const confirmed = await host.confirm?.({
                title: '清空对话',
                body: '将清空这个面的讨论历史，不影响已生成的面本身。',
                confirmText: '清空',
                cancelText: '取消',
            });
            if (confirmed) controllers.chat.clear();
        });
        $root.on('click.spOutlineFeature', '#sp-gen-outline-now, .sp-refresh-outline', () => void controllers.generation.trigger({ reroll: true, module: 'outline' }));
        $root.on('click.spOutlineFeature', '#sp-abort-outline', () => controllers.generation.abort());
    };
    const bindControllers = value => { controllers = value; };
    return Object.freeze({
        bindControllers,
        bind,
        makeInjectButton,
        makeCopyButton,
        resetTextMaps,
        getInjectText: id => injectTexts.get(String(id)),
        getCopyText: id => copyTexts.get(String(id)),
        setOutline,
        setLoading,
        showGenerationError,
        toast,
        closedSuccess: () => host.closedSuccess?.(),
        isOutlineMode: () => !!host.isOutlineMode?.(),
        isPanelVisible: () => !!host.isPanelVisible?.(),
        renderHistory,
        appendMessage,
        beginThinking,
        endThinking,
        showApply,
        markApplied,
        setPlaceholder: value => query('#sp-chat-input')?.attr?.('placeholder', value),
    });
}
