export function createOutlineChat({
    repository,
    loadConfig,
    buildMessages,
    postCompletion,
    injection,
    renderer,
    ui,
    openSettings,
    maxTokens = 30000,
    temperature,
    now = () => Date.now(),
} = {}) {
    let history = [];
    let owner = null;
    let busy = false;

    const owns = candidate => owner === candidate;
    const finish = candidate => {
        if (!owns(candidate)) return false;
        owner = null;
        busy = false;
        ui?.endThinking?.(candidate.thinking);
        return true;
    };
    const currentAndOwned = candidate => owns(candidate)
        && !candidate.controller.signal.aborted
        && repository.isCurrent(candidate.target);
    const load = (target = repository.capture()) => {
        if (!repository.isCurrent(target)) return [];
        history = repository.readHistory(target);
        ui?.renderHistory?.(history);
        return history;
    };
    const abort = () => {
        const previous = owner;
        owner = null;
        busy = false;
        try { previous?.controller?.abort(); } catch {}
        ui?.endThinking?.(previous?.thinking);
    };
    const applyRaw = (target, raw, button = null) => {
        if (!repository.isCurrent(target) || !String(raw || '').trim()) return false;
        if (!repository.commitOutline(target, { raw, ts: now(), cursor: 1 })) return false;
        injection?.refresh(target);
        ui?.setOutline?.(renderer.render(raw, 1));
        ui?.markApplied?.(button);
        return true;
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
        if (!repository.writeHistory(target, historySnapshot, before)) return { status: 'cancelled' };
        history = historySnapshot;
        if (historySnapshot.length !== before.length + 1) ui?.renderHistory?.(history);
        else ui?.appendMessage?.('user', userMsg, history.length - 1);
        const controller = new AbortController();
        const thinking = ui?.beginThinking?.();
        const task = Object.freeze({ target, historySnapshot, controller, thinking });
        owner = task;
        busy = true;
        try {
            const config = loadConfig?.() || {};
            if (!config.url || !config.key) {
                openSettings?.();
                throw new Error('请先配置 API');
            }
            const messages = await buildMessages?.({ target, userMsg, historySnapshot });
            if (!currentAndOwned(task) || !repository.sameHistory(target, historySnapshot)) return { status: 'cancelled' };
            const reply = await postCompletion?.({
                config,
                messages,
                maxTokens,
                temperature,
                signal: controller.signal,
            });
            if (!currentAndOwned(task) || !repository.sameHistory(target, historySnapshot)) return { status: 'cancelled' };
            const nextHistory = [...historySnapshot, { role: 'assistant', content: reply }].slice(-repository.historyCap);
            if (!repository.writeHistory(target, nextHistory, historySnapshot)) return { status: 'cancelled' };
            history = nextHistory;
            if (nextHistory.length !== historySnapshot.length + 1) ui?.renderHistory?.(history);
            else ui?.appendMessage?.('ai', reply, history.length - 1);
            if (/<outline_widget/i.test(String(reply || ''))) {
                ui?.showApply?.(button => applyRaw(target, reply, button), target);
            }
            finish(task);
            return { status: 'updated', reply };
        } catch (error) {
            if (!currentAndOwned(task)) return { status: 'cancelled' };
            if (!repository.sameHistory(target, historySnapshot)) return { status: 'cancelled' };
            if (error?.name !== 'AbortError') {
                ui?.appendMessage?.('system', `发送失败：${error?.message || '未知错误'}`);
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
        ui?.renderHistory?.(history);
        return true;
    };
    const clear = () => {
        if (busy) return false;
        const target = repository.capture();
        if (!repository.clearHistory(target)) return false;
        history = [];
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
        ui?.renderHistory?.(history);
        return send(text);
    };
    const onChatChanged = () => {
        abort();
        history = [];
    };
    return Object.freeze({
        load,
        send,
        remove,
        clear,
        resendFrom,
        applyRaw,
        abort,
        onChatChanged,
        get busy() { return busy; },
        history: () => history.slice(),
    });
}
