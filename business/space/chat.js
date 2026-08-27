import { appendSpaceAssistant, appendSpaceUser } from './schema.js';

export function createSpaceChat(env = {}) {
    const repository = env.repository;
    let busy = false;
    let abortController = null;

    const history = () => repository.history();
    const load = () => repository.load();
    const abort = () => {
        abortController?.abort();
        busy = false;
    };
    const send = async userMsg => {
        if (busy) return Object.freeze({ status: 'busy' });
        const target = repository.capture();
        const appended = appendSpaceUser(history(), userMsg);
        if (!repository.replace(target, appended.history)) return Object.freeze({ status: 'stale' });
        if (appended.trimmed) env.ui?.renderHistory?.(history());
        else env.ui?.appendMessage?.('user', userMsg, history().length - 1);
        busy = true;
        const controller = new AbortController();
        abortController = controller;
        const thinking = env.ui?.beginThinking?.();
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
                maxTokens: env.maxTokens ?? 30000,
                temperature: env.temperature,
                signal: controller.signal,
            });
            if (abortController !== controller || controller.signal.aborted || !repository.isCurrent(target)) {
                return Object.freeze({ status: 'cancelled' });
            }
            if (!repository.replace(target, appendSpaceAssistant(history(), reply))) {
                env.ui?.appendMessage?.('system', '发送失败：回复保存失败，请重试');
                return Object.freeze({ status: 'failed', error: new Error('space reply persistence failed') });
            }
            env.ui?.endThinking?.(thinking);
            env.ui?.appendMessage?.('ai', reply, history().length - 1);
            return Object.freeze({ status: 'updated', reply });
        } catch (error) {
            if (abortController === controller && repository.isCurrent(target) && error?.name !== 'AbortError') {
                env.ui?.appendMessage?.('system', `发送失败：${diagnosticMessage(error)}`);
                return Object.freeze({ status: 'failed', error });
            }
            return Object.freeze({ status: 'cancelled', error });
        } finally {
            env.ui?.endThinking?.(thinking);
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
import { diagnosticMessage, makeDiagnosticError } from '../../api/diagnostics.js';
