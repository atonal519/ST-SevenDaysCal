import { createGenerationDiagnosticScope, diagnosticMessage, makeDiagnosticError } from '../../api/diagnostics.js';
import { normalizeOutlineResponse } from './schema.js';

export function createOutlineChat({
    repository,
    loadConfig,
    buildMessages,
    postCompletion,
    injection,
    renderer,
    ui,
    openSettings,
    temperature,
    now = () => Date.now(),
} = {}) {
    let history = [];
    let historyTarget = null;
    let owner = null;
    let busy = false;

    const owns = candidate => owner === candidate;
    const finish = candidate => {
        if (!owns(candidate)) return false;
        owner = null;
        busy = false;
        try { ui?.endThinking?.(candidate.thinking); } catch (error) { return error; }
        return null;
        return true;
    };
    const currentAndOwned = candidate => owns(candidate)
        && !candidate.controller.signal.aborted
        && repository.isCurrent(candidate.target);
    const activeTarget = target => {
        const current = repository.capture();
        return { target: current, sameChat: String(current?.chatId || '') === String(target?.chatId || '') };
    };
    const load = (target = repository.capture()) => {
        if (!repository.isCurrent(target)) return [];
        history = repository.readHistory(target);
        historyTarget = target;
        ui?.renderHistory?.(history);
        return history;
    };
    const abort = (reason = 'manual-abort') => {
        const previous = owner;
        owner = null;
        busy = false;
        try { previous?.controller?.abort(reason); } catch {}
        ui?.endThinking?.(previous?.thinking);
    };
    const applyRaw = (target, raw, button = null) => {
        const normalizedRaw = normalizeOutlineResponse(raw);
        if (!repository.isCurrent(target) || !normalizedRaw) return false;
        if (!repository.commitOutline(target, { raw: normalizedRaw, ts: now(), cursor: 1 })) return false;
        injection?.refresh(target);
        ui?.setOutline?.(renderer.render(normalizedRaw, 1));
        ui?.markApplied?.(button);
        ui?.renderHistory?.(history);
        return true;
    };
    const latestCandidateIndex = () => {
        for (let index = history.length - 1; index >= 0; index -= 1) {
            const message = history[index];
            if (message?.role === 'assistant' && normalizeOutlineResponse(message.content)) return index;
        }
        return -1;
    };
    const candidateState = index => {
        if (!Number.isInteger(index) || index !== latestCandidateIndex()) return null;
        const target = historyTarget;
        if (!target || !repository.isCurrent(target)) return null;
        const raw = String(history[index]?.content ?? '');
        const normalizedRaw = normalizeOutlineResponse(raw);
        if (!normalizedRaw) return null;
        return Object.freeze({ applied: String(repository.readOutline(target)?.raw ?? '') === normalizedRaw });
    };
    const applyCandidate = (index, button = null) => {
        const state = candidateState(index);
        if (!state || state.applied) return false;
        const target = historyTarget;
        return applyRaw(target, String(history[index]?.content ?? ''), button);
    };

    const send = async userMessage => {
        const userMsg = String(userMessage || '').trim();
        if (busy || !userMsg) return { status: 'skipped' };
        const target = repository.capture();
        const before = repository.readHistory(target);
        const historySnapshot = Object.freeze(
            [...before, { role: 'user', content: userMsg }]
                .slice(-repository.historyCap)
                .map(message => Object.freeze({ ...message })),
        );
        if (!repository.writeHistory(target, historySnapshot, before)) {
            if (repository.isCurrent(target) && repository.sameHistory(target, before)) return { status: 'failed', error: makeDiagnosticError('save', { phase: 'save' }) };
            return { status: 'cancelled' };
        }
        history = historySnapshot;
        historyTarget = target;
        if (historySnapshot.length !== before.length + 1) ui?.renderHistory?.(history);
        else ui?.appendMessage?.('user', userMsg, history.length - 1);
        const controller = new AbortController();
        const thinking = ui?.beginThinking?.();
        const task = Object.freeze({ target, historySnapshot, controller, thinking });
        const diagnostic = createGenerationDiagnosticScope('outline-chat');
        let locallyAppliedReply = null;
        let uiError = null;
        owner = task;
        busy = true;
        try {
            const config = loadConfig?.() || {};
            if (!config.url || !config.key) {
                openSettings?.();
                throw makeDiagnosticError('config-missing');
            }
            const messages = await buildMessages?.({ target, userMsg, historySnapshot, signal: controller.signal });
            let active = activeTarget(target);
            if (!currentAndOwned(task) || (active.sameChat && !repository.sameHistory(active.target, historySnapshot))) return { status: 'cancelled' };
            const reply = await postCompletion?.({
                config,
                messages,
                temperature,
                signal: controller.signal,
                promptMode: 'creative',
                diagnosticModule: 'outline-chat',
                diagnosticSink: diagnostic.sink,
            });
            active = activeTarget(target);
            if (!currentAndOwned(task) || (active.sameChat && !repository.sameHistory(active.target, historySnapshot))) return { status: 'cancelled' };
            const currentHistory = active.sameChat ? historySnapshot : repository.readHistory(active.target);
            const nextHistory = (active.sameChat
                ? [...currentHistory, { role: 'assistant', content: reply }]
                : [...currentHistory, { role: 'user', content: userMsg }, { role: 'assistant', content: reply }])
                .slice(-repository.historyCap);
            diagnostic.accepted({ phase: 'response' });
            if (!repository.writeHistory(active.target, nextHistory, active.sameChat ? historySnapshot : null)) {
                if (!currentAndOwned(task) || (active.sameChat && !repository.sameHistory(active.target, historySnapshot))) return { status: 'cancelled' };
                const error = diagnostic.rejected(makeDiagnosticError('save', { phase: 'save' }), { phase: 'save', reasonCode: 'outline-chat-save-failed' });
                ui?.appendMessage?.('system', '发送失败：回复保存未确认，请重试');
                finish(task);
                return { status: 'failed', error };
            }
            diagnostic.locallyApplied({ phase: 'save', reasonCode: 'outline-chat-local-applied' });
            locallyAppliedReply = reply;
            history = nextHistory;
            historyTarget = active.target;
            try {
                if (nextHistory.length !== historySnapshot.length + 1 || normalizeOutlineResponse(reply)) ui?.renderHistory?.(history);
                else ui?.appendMessage?.('ai', reply, history.length - 1);
                diagnostic.uiDisplayed({ reasonCode: 'outline-chat-ui-applied' });
            } catch (error) { uiError = error; diagnostic.uiFailed(error, { reasonCode: 'outline-chat-ui-failed' }); }
            const finishError = finish(task);
            if (finishError) { uiError ||= finishError; diagnostic.uiFailed(finishError, { reasonCode: 'outline-chat-finish-ui-failed' }); }
            return { status: 'updated', reply, ...(uiError ? { uiError } : {}) };
        } catch (error) {
            if (locallyAppliedReply !== null) {
                diagnostic.uiFailed(error, { reasonCode: 'outline-chat-post-apply-ui-failed' });
                finish(task);
                return { status: 'updated', reply: locallyAppliedReply, uiError: error };
            }
            diagnostic.rejected(error, { phase: error?.phase || 'request', reasonCode: 'outline-chat-request-failed' });
            if (!currentAndOwned(task)) return { status: 'cancelled' };
            const active = activeTarget(target);
            if (active.sameChat && !repository.sameHistory(active.target, historySnapshot)) return { status: 'cancelled' };
            if (error?.name !== 'AbortError') {
                ui?.appendMessage?.('system', error?.outlineChatMessage || `发送失败：${diagnosticMessage(error)}`);
            }
            finish(task);
            return error?.name === 'AbortError' ? { status: 'cancelled' } : { status: 'failed', error };
        } finally {
            finish(task);
        }
    };

    const remove = index => {
        if (busy || !Number.isInteger(index) || index < 0 || index >= history.length) return false;
        const target = repository.capture();
        const before = repository.readHistory(target);
        if (index >= before.length) return false;
        const next = before.filter((_, itemIndex) => itemIndex !== index);
        if (!repository.writeHistory(target, next, before)) return false;
        history = next;
        historyTarget = target;
        ui?.renderHistory?.(history);
        return true;
    };
    const clear = () => {
        if (busy) return false;
        const target = repository.capture();
        if (!repository.clearHistory(target)) return false;
        history = [];
        historyTarget = target;
        ui?.renderHistory?.(history);
        return true;
    };
    const resendFrom = async (index, text) => {
        if (busy || !Number.isInteger(index) || index < 0 || index >= history.length) return { status: 'skipped' };
        const target = repository.capture();
        const before = repository.readHistory(target);
        const truncated = before.slice(0, index);
        if (!repository.writeHistory(target, truncated, before)) return { status: 'cancelled' };
        history = truncated;
        historyTarget = target;
        ui?.renderHistory?.(history);
        return send(text);
    };
    const onChatChanged = () => {
        history = [];
        historyTarget = null;
    };
    return Object.freeze({
        load,
        send,
        remove,
        clear,
        resendFrom,
        applyRaw,
        candidateState,
        applyCandidate,
        abort,
        onChatChanged,
        get busy() { return busy; },
        history: () => history.slice(),
    });
}
