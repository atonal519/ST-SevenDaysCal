import { appendSpaceAssistant, appendSpaceUser } from './schema.js';
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
    const send = async userMsg => {
        if (busy) return Object.freeze({ status: 'busy' });
        const target = repository.capture();
        const before = history();
        const appended = appendSpaceUser(before, userMsg);
        if (!repository.replace(target, appended.history)) {
            if (JSON.stringify(history()) === JSON.stringify(before)) return Object.freeze({ status: 'failed', error: makeDiagnosticError('save', { phase: 'save' }) });
            return Object.freeze({ status: 'stale' });
        }
        if (appended.trimmed) env.ui?.renderHistory?.(history());
        else env.ui?.appendMessage?.('user', userMsg, history().length - 1);
        busy = true;
        const controller = new AbortController();
        abortController = controller;
        const thinking = env.ui?.beginThinking?.();
        const diagnostic = createGenerationDiagnosticScope('space');
        let locallyAppliedReply = null;
        try {
            const config = env.loadConfig?.() || {};
            if (!config.url || !config.key) {
                env.openSettings?.();
                throw makeDiagnosticError('config-missing');
            }
            const messages = await env.buildMessages?.({
                target,
                userMsg,
                historySnapshot: [...history()],
            });
            const reply = await env.postCompletion?.({
                config,
                messages,
                temperature: env.temperature,
                signal: controller.signal,
                promptMode: 'creative',
                diagnosticModule: 'space',
                diagnosticSink: diagnostic.sink,
            });
            if (abortController !== controller || controller.signal.aborted) {
                return Object.freeze({ status: 'cancelled' });
            }
            diagnostic.accepted({ phase: 'response' });
            const liveTarget = repository.capture();
            const changedChat = String(liveTarget?.chatId || '') !== String(target?.chatId || '');
            const baseHistory = changedChat ? repository.load(liveTarget) : history();
            const userHistory = changedChat ? appendSpaceUser(baseHistory, userMsg).history : baseHistory;
            const widgetContext = {
                ...(Array.isArray(messages?.pointBaselines) ? { pointBaselines: messages.pointBaselines } : {}),
                ...(Array.isArray(messages?.lineBaselines) ? { lineBaselines: messages.lineBaselines } : {}),
                ...(messages?.expectedWidgetKind ? { expectedWidgetKind: messages.expectedWidgetKind } : {}),
            };
            if (!repository.replace(liveTarget, appendSpaceAssistant(userHistory, reply, widgetContext))) {
                const error = diagnostic.rejected(makeDiagnosticError('save', { phase: 'save' }), { phase: 'save', reasonCode: 'space-save-failed' });
                env.ui?.appendMessage?.('system', '发送失败：回复保存失败，请重试');
                return Object.freeze({ status: 'failed', error });
            }
            diagnostic.locallyApplied({ phase: 'save', reasonCode: 'space-chat-local-applied' });
            locallyAppliedReply = reply;
            try {
                env.ui?.endThinking?.(thinking);
                const savedReply = history().at(-1);
                env.ui?.appendMessage?.('ai', reply, history().length - 1, {
                    pointBaselines: savedReply?.pointBaselines,
                    lineBaselines: savedReply?.lineBaselines,
                    expectedWidgetKind: savedReply?.expectedWidgetKind,
                    legacyPointOwner: !Array.isArray(savedReply?.pointBaselines),
                });
                diagnostic.uiDisplayed({ reasonCode: 'space-chat-ui-applied' });
            } catch (error) { diagnostic.uiFailed(error, { reasonCode: 'space-chat-ui-failed' }); }
            return Object.freeze({ status: 'updated', reply });
        } catch (error) {
            if (locallyAppliedReply !== null) {
                diagnostic.uiFailed(error, { reasonCode: 'space-chat-post-apply-ui-failed' });
                return Object.freeze({ status: 'updated', reply: locallyAppliedReply });
            }
            diagnostic.rejected(error, { phase: error?.phase || 'request', reasonCode: 'space-request-failed' });
            if (abortController === controller && !controller.signal.aborted && error?.name !== 'AbortError') {
                env.ui?.appendMessage?.('system', `发送失败：${diagnosticMessage(error)}`);
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
        if (busy || !Number.isInteger(index) || index < 0 || index >= history().length) return false;
        const target = repository.capture();
        const next = [...history()];
        next.splice(index, 1);
        if (!repository.replace(target, next)) return false;
        env.ui?.renderHistory?.(history());
        return true;
    };
    const clear = () => {
        if (busy || !history().length) return false;
        const target = repository.capture();
        if (!repository.clear(target)) return false;
        env.ui?.emptyMessages?.();
        return true;
    };
    const resendFrom = (index, content) => {
        if (busy || !Number.isInteger(index) || index < 0 || index >= history().length || !String(content || '').trim()) {
            return Promise.resolve(Object.freeze({ status: 'invalid' }));
        }
        const target = repository.capture();
        if (!repository.replace(target, history().slice(0, index))) return Promise.resolve(Object.freeze({ status: 'stale' }));
        env.ui?.renderHistory?.(history());
        return send(String(content).trim());
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
