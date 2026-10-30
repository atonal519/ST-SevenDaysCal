import { icon } from '../../utils/icons.js';
import { resolveSpaceWidgets, spaceMessagePlainText, spacePageId } from './schema.js';

export function createSpaceUi(host = {}) {
    const query = host.query || (() => null);
    const element = host.element || (() => null);
    const escape = value => host.escapeHtml?.(String(value ?? '')) ?? String(value ?? '');
    const isMobileViewport = () => {
        const injected = host.isMobile?.();
        if (typeof injected === 'boolean') return injected;
        const width = Number(globalThis.window?.innerWidth ?? globalThis.innerWidth);
        return Number.isFinite(width) && width <= 640;
    };
    const widgets = new Map();
    let widgetSeq = 0;
    let controllers = null;
    let bound = false;
    let activePage = '1';
    const drafts = new Map();
    const scrolls = new Map();
    let thinking = null;
    let pageAnimation = null;
    const pageIds = () => controllers?.repository?.pages?.() || ['1'];
    const syncPages = () => {
        if (!pageIds().includes(activePage)) activePage = '1';
        const bar = query('#sp-space-pages');
        bar?.prop?.('hidden', pageIds().length < 2);
        for (const id of ['1', '2']) query(`[data-space-page="${id}"]`)?.attr?.('aria-selected', String(activePage === id))?.attr?.('tabindex', activePage === id ? '0' : '-1');
        query('#sp-space-add-page')?.prop?.('disabled', pageIds().length >= 2)?.attr?.('title', pageIds().length >= 2 ? '已有两个窗口' : '新增第二个窗口');
    };
    const switchPage = pageId => {
        if (pageId === activePage || !pageIds().includes(pageId)) return;
        drafts.set(activePage, String(query('#sp-space-input')?.val?.() || ''));
        scrolls.set(activePage, element('#sp-space-msgs')?.scrollTop || 0);
        activePage = pageId;
        query('#sp-space-input')?.val?.(drafts.get(pageId) || '');
        host.autoGrow?.(element('#sp-space-input'));
        host.closeActionMenus?.();
        renderHistory(controllers.chat.history());
        const messages = element('#sp-space-msgs');
        if (messages && scrolls.has(pageId)) messages.scrollTop = scrolls.get(pageId);
        pageAnimation?.cancel?.();
        const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        pageAnimation = messages?.animate?.(reduced ? [{ opacity: 0.7 }, { opacity: 1 }] : [
            { clipPath: 'inset(0 0 100% 0)', transform: 'translateY(-8px)' },
            { clipPath: 'inset(0 0 0% 0)', transform: 'translateY(0)' },
        ], { duration: reduced ? 120 : 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
        host.onPageChanged?.();
    };

    const registerWidget = (widget, messageContext = {}) => {
        const wid = String(++widgetSeq);
        widgets.set(wid, {
            kind: widget.kind,
            body: widget.body,
            historyIndex: messageContext.historyIndex,
            outlineRawToken: messageContext.outlineRawToken || null,
            editIdx: widget.editIdx,
            owner: widget.owner,
            pointBaselines: Array.isArray(messageContext.pointBaselines) ? messageContext.pointBaselines : null,
            lineLocator: widget.kind === 'line_widget' && Number.isInteger(widget.editIdx)
                ? messageContext.lineBaselines?.[widget.editIdx - 1] || null
                : null,
            legacyPointOwner: messageContext.legacyPointOwner === true,
            readOnly: messageContext.readOnly === true,
            pageId: activePage,
            identity: host.captureIdentity?.() || null,
        });
        return wid;
    };
    const appendMessage = (role, content, historyIndex = null, messageContext = {}) => {
        if ((messageContext.pageId || '1') !== activePage) return;
        messageContext = { ...messageContext, currentOutlineRaw: host.currentOutlineRaw?.() || '' };
        const parts = controllers.renderer.message(role, content, historyIndex, registerWidget, messageContext);
        const $wrap = host.$?.('<div>').addClass(`sp-chat-msg-wrap ${parts.wrapClass}`);
        if (!$wrap) return;
        if (parts.canAct) $wrap.attr('data-idx', historyIndex);
        if (parts.contentHtml) {
            const $message = host.$('<div>').addClass(`sp-chat-msg ${parts.cls}`);
            $message.html(`<div class="sp-chat-msg-content">${parts.contentHtml}</div>`);
            $wrap.append($message);
        }
        if (parts.widgetCards) $wrap.append(parts.widgetCards);
        if (parts.actions) $wrap.append(parts.actions);
        $wrap.appendTo(query('#sp-space-msgs'));
        const messages = element('#sp-space-msgs');
        if (messages) messages.scrollTop = messages.scrollHeight;
    };
    const latestOutlineCandidateIndex = history => {
        for (let index = history.length - 1; index >= 0; index -= 1) {
            const message = history[index];
            if (message?.role !== 'assistant' || message.portableReadonly === true || spacePageId(message) !== activePage) continue;
            const resolved = resolveSpaceWidgets(message.content, message, host.widgetParsers || {});
            if (!resolved.ambiguous && resolved.widgets.some(widget => widget.kind === 'outline_widget')
                && typeof message.outlineRawToken === 'string' && message.outlineRawToken) return index;
        }
        return -1;
    };
    const renderHistory = history => {
        syncPages();
        widgets.clear();
        query('#sp-space-msgs')?.empty?.();
        const latestOutline = latestOutlineCandidateIndex(history);
        history.forEach((message, index) => {
            if (spacePageId(message) !== activePage) return;
            const resolved = resolveSpaceWidgets(message.content, message, host.widgetParsers || {});
            const hasOutlineCandidate = !resolved.ambiguous && resolved.widgets.some(widget => widget.kind === 'outline_widget');
            appendMessage(message.role === 'assistant' ? 'ai' : message.role, message.content, index, {
                pageId: spacePageId(message),
                pointBaselines: message.pointBaselines,
                lineBaselines: message.lineBaselines,
                expectedWidgetKind: message.expectedWidgetKind,
                allowedWidgetKinds: message.allowedWidgetKinds,
                outlineRawToken: message.outlineRawToken,
                currentOutlineRaw: host.currentOutlineRaw?.() || '',
                historyIndex: index,
                readOnly: message.portableReadonly === true || (hasOutlineCandidate
                    && (index !== latestOutline || typeof message.outlineRawToken !== 'string')),
                legacyPointOwner: message.role === 'assistant' && !Object.prototype.hasOwnProperty.call(message, 'pointBaselines'),
            });
        });
        if (thinking?.pageId === activePage) thinking.node = appendThinking();
    };
    const emptyMessages = () => { widgets.clear(); query('#sp-space-msgs')?.empty?.(); };
    const appendThinking = () => {
        const dots = host.$?.('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking')
            .html('<span class="sp-typing"><i></i><i></i><i></i></span>').appendTo(query('#sp-space-msgs'));
        const messages = element('#sp-space-msgs');
        if (messages) messages.scrollTop = messages.scrollHeight;
        return dots;
    };
    const beginThinking = (pageId = activePage) => {
        thinking = { pageId, node: pageId === activePage ? appendThinking() : null };
        return thinking;
    };
    const endThinking = value => {
        value?.node?.remove?.();
        if (thinking === value) thinking = null;
    };

    const startEdit = ($message, index) => {
        const original = controllers.chat.history()[index]?.content ?? '';
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
        const $root = query('#sp-space-wrap');
        if (!$root?.length) return;
        bound = true;
        $root.off('.spSpaceFeature');
        const sendInput = () => {
            const $input = query('#sp-space-input');
            const message = String($input?.val?.() || '').trim();
            if (!message || controllers.chat.busy) return;
            $input.val('');
            host.autoGrow?.($input[0]);
            void controllers.chat.send(message);
        };
        $root.on('click.spSpaceFeature', '#sp-space-send', sendInput);
        $root.on('click.spSpaceFeature', '[data-space-page]', function () { switchPage(host.$(this).attr('data-space-page')); });
        $root.on('keydown.spSpaceFeature', '[data-space-page]', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            switchPage(event.key === 'Home' ? '1' : event.key === 'End' ? '2' : activePage === '1' ? '2' : '1');
            element(`[data-space-page="${activePage}"]`)?.focus?.();
        });
        $root.on('click.spSpaceFeature', '#sp-space-more', function (event) {
            event.stopPropagation();
            const menu = this.closest('.sp-action-menu');
            const open = !host.$(menu).hasClass('sp-action-menu-open');
            host.closeActionMenus?.();
            host.$(menu).toggleClass('sp-action-menu-open', open).find('.sp-action-menu-list').prop('hidden', !open);
            host.$(this).attr('aria-expanded', String(open));
            syncPages();
        });
        $root.on('click.spSpaceFeature', '#sp-space-add-page', event => {
            event.stopPropagation(); host.closeActionMenus?.();
            if (pageIds().length >= 2) return;
            const pageId = controllers.repository.addPage();
            if (pageId) switchPage(pageId);
            else host.toast?.('新增窗口失败，请重试', true);
        });
        $root.on('keydown.spSpaceFeature', '#sp-space-input', event => {
                const nativeEvent = event.originalEvent;
                if (isMobileViewport() || event.key !== 'Enter' || event.shiftKey || event.isComposing || nativeEvent?.isComposing || event.repeat || nativeEvent?.repeat) return;
                event.preventDefault();
                sendInput();
        });
        $root.on('input.spSpaceFeature', '#sp-space-input', function () { host.autoGrow?.(this); });
        $root.on('click.spSpaceFeature', '.sp-chat-msg-delete', function () {
            if (controllers.chat.busy) return;
            const index = Number(host.$(this).closest('.sp-chat-msg-wrap').attr('data-idx'));
            controllers.chat.remove(index);
        });
        $root.on('click.spSpaceFeature', '.sp-chat-msg-copy', async function () {
            const index = Number(host.$(this).closest('.sp-chat-msg-wrap').attr('data-idx'));
            if (!Number.isInteger(index) || index < 0 || index >= controllers.chat.history().length) return;
            const $button = host.$(this);
            const oldTimer = $button.data('sp-copy-reset');
            if (oldTimer) clearTimeout(oldTimer);
            const copied = await host.copyText?.(spaceMessagePlainText(controllers.chat.history()[index]));
            $button.html(copied ? `${icon("check")}` : `${icon("x")}`)
                .attr('title', copied ? '已复制' : '复制失败');
            const timer = setTimeout(() => {
                $button.html(`${icon("copy")}`).attr('title', '复制').removeData('sp-copy-reset');
            }, 1200);
            $button.data('sp-copy-reset', timer);
        });
        $root.on('click.spSpaceFeature', '.sp-chat-msg-edit', function () {
            if (controllers.chat.busy) return;
            const $message = host.$(this).closest('.sp-chat-msg-wrap');
            const index = Number($message.attr('data-idx'));
            if (Number.isInteger(index) && index >= 0 && index < controllers.chat.history().length) startEdit($message, index);
        });
        $root.on('click.spSpaceFeature', '.sp-space-widget-apply', async function () {
            const $button = host.$(this);
            if ($button.prop('disabled')) return;
            const stored = widgets.get($button.attr('data-wid'));
            if (!stored) {
                host.toast?.('这张卡片已过期，请再让 AI 生成一次', true);
                return;
            }
            if (stored.readOnly) {
                host.toast?.('这份历史方案仅供查看', 'info');
                return;
            }
            if (stored.kind === 'outline_widget') {
                const history = controllers.chat.history();
                if (latestOutlineCandidateIndex(history) !== stored.historyIndex) {
                    host.toast?.('较早的面草稿仅供查看，请使用最新方案', true);
                    return;
                }
            }
            if (stored.identity && host.isCurrentIdentity?.(stored.identity) === false) {
                host.toast?.('这张卡片属于之前的聊天，请在当前聊天重新生成', true);
                return;
            }
            const actions = host.widgetActions?.() || {};
            if (stored.kind === 'schedule_widget') await actions.point?.(stored.body, $button, {
                editIndex: stored.editIdx,
                owner: stored.owner || (stored.legacyPointOwner ? { view: 'user', charName: '' } : null),
                pointBaselines: stored.pointBaselines,
                legacyPointOwner: stored.legacyPointOwner,
            });
            else if (stored.kind === 'line_widget') actions.lines?.(stored.body, stored.editIdx, $button, stored.lineLocator);
            else if (stored.kind === 'almanac_widget') actions.almanac?.(stored.body, $button, $button.attr('data-idx'));
            else if (stored.kind === 'era_widget') actions.era?.(stored.body, $button);
            else if (stored.kind === 'outline_widget') await actions.outline?.(stored.body, stored.outlineRawToken, $button);
        });
        $root.on('click.spSpaceFeature', '#sp-space-clear', async event => {
            event.stopPropagation(); host.closeActionMenus?.();
            const pageId = activePage;
            if (controllers.chat.busy || !controllers.chat.history().some(message => spacePageId(message) === pageId)) return;
            const confirmed = await host.confirm?.({
                title: '清屏',
                body: `将删除窗口${pageId}的全部讨论记录。`,
                confirmText: '清屏',
                cancelText: '取消',
            });
            if (confirmed) controllers.chat.clear(pageId);
        });
    };
    return Object.freeze({
        bindControllers: value => { controllers = value; },
        bind,
        renderHistory,
        activePageId: () => activePage,
        switchPage,
        resetPages: () => {
            activePage = '1'; drafts.clear(); scrolls.clear(); thinking = null; pageAnimation?.cancel?.();
            query('#sp-space-input')?.val?.('');
            host.autoGrow?.(element('#sp-space-input'));
            syncPages();
        },
        appendMessage,
        emptyMessages,
        beginThinking,
        endThinking,
        setFailureHtml: html => host.setFailureHtml?.(html),
        setPlaceholder: value => query('#sp-space-input')?.attr?.('placeholder', value),
        clearWidgets: () => widgets.clear(),
        widgetEntries: () => [...widgets.values()],
        widgetRecords: () => [...widgets.entries()],
    });
}
