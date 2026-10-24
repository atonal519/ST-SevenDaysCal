import { appendSpaceAssistant, appendSpaceUser, spacePageId } from './schema.js';
import { createGenerationDiagnosticScope, diagnosticMessage, makeDiagnosticError } from '../../api/diagnostics.js';

export function createSpaceChat(env = {}) {
    const repository = env.repository;
    let busy = false;
    let abortController = null;

    const history = () => repository.history();
    const load = () => repository.load();
    const abort = (reason = 'manual-abort') => {
        abortController?.abort(reason);
        busy = false;
    };
    const activePageId = () => env.activePageId?.() || '1';
    const send = async (userMsg, pageId = activePageId()) => {
        if (busy) return Object.freeze({ status: 'busy' });
        const target = repository.capture();
        const before = history();
        const appended = appendSpaceUser(before, userMsg, pageId);
        if (!repository.replace(target, appended.history)) {
            if (JSON.stringify(history()) === JSON.stringify(before)) return Object.freeze({ status: 'failed', error: makeDiagnosticError('save', { phase: 'save' }) });
            return Object.freeze({ status: 'stale' });
        }
        env.ui?.appendMessage?.('user', userMsg, history().length - 1, { pageId });
        busy = true;
        const controller = new AbortController();
        abortController = controller;
        const thinking = env.ui?.beginThinking?.(pageId);
        const diagnostic = createGenerationDiagnosticScope('space');
        let locallyAppliedReply = null;
        let uiError = null;
        try {
            const config = env.loadConfig?.() || {};
            if (!config.url || !config.key) {
                env.openSettings?.();
                throw makeDiagnosticError('config-missing');
            }
            const messages = await env.buildMessages?.({
                target,
                pageId,
                pages: repository.pages(),
                userMsg,
                historySnapshot: [...history()],
            });
            const reply = await env.postCompletion?.({
                config,
                messages,
                temperature: env.temperature,
                signal: controller.signal,
                diagnosticModule: 'space',
                diagnosticSink: diagnostic.sink,
            });
            if (abortController !== controller || controller.signal.aborted) {
                return Object.freeze({ status: 'cancelled' });
            }
            diagnostic.accepted({ phase: 'response' });
            const widgetContext = {
                pageId,
                ...(Array.isArray(messages?.pointBaselines) ? { pointBaselines: messages.pointBaselines } : {}),
                ...(Array.isArray(messages?.lineBaselines) ? { lineBaselines: messages.lineBaselines } : {}),
                ...(messages?.expectedWidgetKind ? { expectedWidgetKind: messages.expectedWidgetKind } : {}),
                ...(Array.isArray(messages?.allowedWidgetKinds) ? { allowedWidgetKinds: messages.allowedWidgetKinds } : {}),
                ...(messages?.outlineRawToken && (messages?.expectedWidgetKind === 'outline_widget' || messages?.allowedWidgetKinds?.includes?.('outline_widget')) ? { outlineRawToken: messages.outlineRawToken } : {}),
            };
            if (!repository.replace(target, appendSpaceAssistant(appended.history, reply, widgetContext))) {
                const error = diagnostic.rejected(makeDiagnosticError('save', { phase: 'save' }), { phase: 'save', reasonCode: 'space-save-failed' });
                env.ui?.appendMessage?.('system', '发送失败：回复保存失败，请重试', null, { pageId });
                return Object.freeze({ status: 'failed', error });
            }
            diagnostic.locallyApplied({ phase: 'save', reasonCode: 'space-chat-local-applied' });
            locallyAppliedReply = reply;
            try {
                env.ui?.endThinking?.(thinking);
                const savedReply = history().at(-1);
                env.ui?.appendMessage?.('ai', savedReply?.content ?? reply, history().length - 1, {
                    pageId,
                    pointBaselines: savedReply?.pointBaselines,
                    lineBaselines: savedReply?.lineBaselines,
                    expectedWidgetKind: savedReply?.expectedWidgetKind,
                    allowedWidgetKinds: savedReply?.allowedWidgetKinds,
                    outlineRawToken: savedReply?.outlineRawToken,
                    historyIndex: history().length - 1,
                    legacyPointOwner: !Array.isArray(savedReply?.pointBaselines),
                });
                diagnostic.uiDisplayed({ reasonCode: 'space-chat-ui-applied' });
            } catch (error) { uiError = error; diagnostic.uiFailed(error, { reasonCode: 'space-chat-ui-failed' }); }
            return Object.freeze({ status: 'updated', reply, ...(uiError ? { uiError } : {}) });
        } catch (error) {
            if (locallyAppliedReply !== null) {
                diagnostic.uiFailed(error, { reasonCode: 'space-chat-post-apply-ui-failed' });
                return Object.freeze({ status: 'updated', reply: locallyAppliedReply, uiError: error });
            }
            diagnostic.rejected(error, { phase: error?.phase || 'request', reasonCode: 'space-request-failed' });
            if (abortController === controller && !controller.signal.aborted && error?.name !== 'AbortError') {
                env.ui?.appendMessage?.('system', `发送失败：${diagnosticMessage(error)}`, null, { pageId });
                return Object.freeze({ status: 'failed', error });
            }
            return Object.freeze({ status: 'cancelled', error });
        } finally {
            try { env.ui?.endThinking?.(thinking); }
            catch (error) { if (locallyAppliedReply !== null) diagnostic.uiFailed(error, { reasonCode: 'space-chat-finish-ui-failed' }); }
            if (abortController === controller) {
                abortController = null;
                busy = false;
            }
        }
    };
    const remove = index => {
        if (busy || !Number.isInteger(index) || index < 0 || index >= history().length || spacePageId(history()[index]) !== activePageId()) return false;
        const target = repository.capture();
        const next = [...history()];
        next.splice(index, 1);
        if (!repository.replace(target, next)) { env.ui?.toast?.('删除失败，对话记录未变更', true); return false; }
        env.ui?.renderHistory?.(history());
        return true;
    };
    const clear = (pageId = activePageId()) => {
        if (busy || !history().some(message => spacePageId(message) === pageId)) return false;
        const target = repository.capture();
        if (!repository.replace(target, history().filter(message => spacePageId(message) !== pageId))) {
            env.ui?.toast?.('清屏失败，对话记录未变更', true); return false;
        }
        env.ui?.renderHistory?.(history());
        return true;
    };
    const resendFrom = (index, content) => {
        if (busy || !Number.isInteger(index) || index < 0 || index >= history().length || spacePageId(history()[index]) !== activePageId() || !String(content || '').trim()) {
            return Promise.resolve(Object.freeze({ status: 'invalid' }));
        }
        const target = repository.capture();
        const pageId = spacePageId(history()[index]);
        if (!repository.replace(target, history().filter((message, position) => position < index || spacePageId(message) !== pageId))) {
            env.ui?.toast?.('重发失败，对话记录未变更', true);
            return Promise.resolve(Object.freeze({ status: 'stale' }));
        }
        env.ui?.renderHistory?.(history());
        return send(String(content).trim(), pageId);
    };
    return Object.freeze({
        history,
        load,
        send,
        remove,
        clear,
        resendFrom,
        abort,
        get busy() { return busy; },
        get signal() { return abortController?.signal; },
    });
}
