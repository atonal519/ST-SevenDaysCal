import { classifyGenerationError, diagnosticMessage } from '../../api/diagnostics.js';
import { parseOutline } from './schema.js';

export function createOutlineUi(host = {}) {
    let controllers = null;
    let bound = false;
    const injectTexts = new Map();
    const copyTexts = new Map();
    let injectSequence = 0;
    let copySequence = 0;
    const query = selector => host.query?.(selector);
    const element = selector => host.element?.(selector);
    const fallbackEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
    const escape = value => fallbackEscape(value);
    const isMobileViewport = () => {
        const injected = host.isMobile?.();
        if (typeof injected === 'boolean') return injected;
        const width = Number(globalThis.window?.innerWidth ?? globalThis.innerWidth);
        return Number.isFinite(width) && width <= 640;
    };

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
    const draftField = (label, value) => value
        ? `<div class="sp-outline-draft-field"><span>${label}</span>${escape(value)}</div>`
        : '';
    const renderDraftPreview = (beats, historyIndex, state) => {
        const items = beats.map((beat, index) => `
            <li class="sp-outline-draft-node">
                <div class="sp-outline-draft-node-head"><span>${index + 1}</span><strong>${escape(beat.title || '未命名')}</strong>${beat.time ? `<em>${escape(beat.time)}</em>` : ''}</div>
                ${draftField('类型', beat.type)}
                ${draftField('故事线', beat.line)}
                ${draftField('结果', beat.outcome)}
                ${draftField('场景', beat.scene)}
                ${draftField('题记', beat.subtext)}
                ${draftField('思考', beat.think)}
            </li>`).join('');
        const action = state?.applied
            ? '<div class="sp-outline-draft-action"><button class="sp-apply-outline-btn" type="button" disabled>✓ 已应用</button><span>已在上方展示</span></div>'
            : state
                ? `<div class="sp-outline-draft-action"><button class="sp-apply-outline-btn" type="button" data-idx="${historyIndex}">应用此面</button></div>`
                : '<div class="sp-outline-draft-stale">较早的草稿，仅供查看</div>';
        return `<section class="sp-outline-draft-card">
            <div class="sp-outline-draft-summary"><strong>大纲草稿</strong><span>${beats.length} 个节点</span></div>
            <details class="sp-outline-draft-preview"><summary>查看节点预览</summary><ol>${items}</ol></details>
            ${action}
        </section>`;
    };
    const appendMessage = (role, content, historyIndex = null, candidateState = null) => {
        const source = String(content ?? '');
        const beats = role === 'ai' ? parseOutline(source) : [];
        const widgetPattern = /<outline_widget\b[^>]*>[\s\S]*?<\/outline_widget\s*>/gi;
        const hasCompleteWidget = beats.length > 0 && widgetPattern.test(source);
        widgetPattern.lastIndex = 0;
        const prose = hasCompleteWidget ? source.replace(widgetPattern, '').trim() : '';
        const display = beats.length ? prose || '[↑ 已生成新面]' : source;
        const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
        const wrapClass = role === 'user' ? 'sp-chat-msg-wrap-user'
            : role === 'ai' ? 'sp-chat-msg-wrap-ai' : 'sp-chat-msg-wrap-system';
        const canAct = role !== 'system' && Number.isInteger(historyIndex);
        const contentHtml = role === 'ai'
            ? (display ? host.formatAi?.(display) ?? escape(display).replace(/\n/g, '<br>') : '')
            : escape(display).replace(/\n/g, '<br>');
        const draftHtml = beats.length ? renderDraftPreview(beats, historyIndex, candidateState) : '';
        const $wrap = host.$?.('<div>').addClass(`sp-chat-msg-wrap ${wrapClass}`);
        if (!$wrap) return;
        if (canAct) $wrap.attr('data-idx', historyIndex);
        const $message = host.$('<div>').addClass(`sp-chat-msg ${cls}`);
        $message.html(`<div class="sp-chat-msg-content">${contentHtml}${draftHtml}</div>`);
        if (candidateState) {
            $message.find('.sp-apply-outline-btn').on('click', function () {
                if (controllers.chat.busy || this?.disabled) return;
                controllers.chat.applyCandidate(historyIndex, this);
            });
        }
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
        let latestCandidateIndex = -1;
        history.forEach((message, index) => {
            if (message.role === 'assistant' && parseOutline(message.content).length > 0) latestCandidateIndex = index;
        });
        history.forEach((message, index) => appendMessage(
            message.role === 'assistant' ? 'ai' : message.role,
            message.content,
            index,
            index === latestCandidateIndex ? controllers?.chat?.candidateState?.(index) : null,
        ));
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
        const sendInput = () => {
            const $input = query('#sp-chat-input');
            const message = String($input?.val?.() || '').trim();
            if (!message || controllers.chat.busy) return;
            $input.val('');
            host.autoGrow?.($input[0]);
            void controllers.chat.send(message);
        };
        $root.on('click.spOutlineFeature', '#sp-chat-send', sendInput);
        if (!isMobileViewport()) {
            $root.on('keydown.spOutlineFeature', '#sp-chat-input', event => {
                const nativeEvent = event.originalEvent;
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing || nativeEvent?.isComposing || event.repeat || nativeEvent?.repeat) return;
                event.preventDefault();
                sendInput();
            });
        }
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
