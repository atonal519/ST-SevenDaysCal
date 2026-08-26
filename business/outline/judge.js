import { outlineBaseline, parseOutline, parseOutlineRelocationAnswer, shouldAdvanceOutline } from './schema.js';
import { buildOutlineJudgePrompt, buildOutlineRelocationPrompt } from './prompts.js';
import { safeDiagnosticLog } from '../../api/diagnostics.js';

export function createOutlineJudge({
    repository,
    context,
    settings,
    pluginEnabled,
    loadConfig,
    callApi,
    cleanText,
    isAutomationSuppressed,
    automationModule = 'outline',
    bridgeAbortSignal,
    injection,
    onCursorChanged,
    toast,
    logDiagnostic,
    isEditing = () => false,
} = {}) {
    let owner = null;
    let busy = false;
    let lastJudgedMessageId = -1;
    let messageCounter = 0;

    const owns = candidate => owner === candidate;
    const finish = candidate => {
        if (!owns(candidate)) return false;
        owner = null;
        busy = false;
        return true;
    };
    const abort = () => {
        const previous = owner;
        owner = null;
        busy = false;
        try { previous?.controller?.abort(); } catch {}
    };
    const makeOwner = (target, baseline) => {
        const controller = new AbortController();
        const next = Object.freeze({ controller, target, baseline });
        owner = next;
        busy = true;
        return next;
    };
    const currentAndOwned = candidate => owns(candidate)
        && !candidate.controller.signal.aborted
        && repository.isCurrent(candidate.target);
    const notifyChanged = (candidate, raw, cursor) => {
        injection?.refresh(candidate.target);
        onCursorChanged?.({ target: candidate.target, raw, cursor });
    };

    const runAdvance = async () => {
        if (busy && owner?.controller?.signal?.aborted) {
            owner = null;
            busy = false;
        }
        if (busy || isEditing()) return { status: 'skipped' };
        const target = repository.capture();
        const saved = repository.readOutline(target);
        if (!saved?.raw) return { status: 'skipped' };
        const beats = parseOutline(saved.raw);
        const cursor = repository.cursor(target);
        const baseline = outlineBaseline(saved);
        if (!beats.length || cursor < 1 || cursor >= beats.length) return { status: 'skipped' };
        const current = beats[cursor - 1];
        const next = beats[cursor];
        const task = makeOwner(target, baseline);
        try {
            const ctx = context?.();
            const config = loadConfig?.() || {};
            if (!config.url || !config.key) {
                finish(task);
                return { status: 'skipped' };
            }
            const format = beat => `${beat.time ? beat.time + '·' : ''}《${beat.title}》`;
            const prompt = buildOutlineJudgePrompt(
                format(current),
                format(next),
                (cleanText?.(current.scene || '') ?? current.scene) || '',
                (cleanText?.(next.scene || '') ?? next.scene) || '',
            );
            const answer = await callApi?.({
                ctx,
                prompt,
                config,
                userName: ctx?.name1 || '用户',
                charName: ctx?.name2 || '角色',
                signal: task.controller.signal,
            });
            if (!currentAndOwned(task) || !repository.matches(target, baseline)) return { status: 'cancelled' };
            if (!shouldAdvanceOutline(answer)) {
                finish(task);
                return { status: 'unchanged' };
            }
            if (!repository.setCursor(target, cursor + 1, baseline)) return { status: 'cancelled' };
            finish(task);
            if (settings?.().notifyMode === 'full') toast?.('面已自动推进到下一节点 · 请注意查看');
            notifyChanged(task, saved.raw, cursor + 1);
            return { status: 'updated' };
        } catch (error) {
            if (!currentAndOwned(task)) return { status: 'cancelled' };
            if (!repository.matches(target, baseline)) return { status: 'cancelled' };
            finish(task);
            if (error?.name === 'AbortError' || !repository.isCurrent(target)) return { status: 'cancelled' };
            logDiagnostic?.(safeDiagnosticLog('outline', 'request', error, { background: true }));
            if (settings?.().notifyMode === 'full') toast?.('面自动推进判定失败，请检查 API 或网络', true);
            return { status: 'failed', error };
        } finally {
            finish(task);
        }
    };

    const relocate = async (promptAddon = '', externalSignal = null) => {
        if (isEditing()) return { status: 'skipped' };
        const target = repository.capture();
        const saved = repository.readOutline(target);
        if (!saved?.raw) return { status: 'skipped' };
        const beats = parseOutline(saved.raw);
        const current = repository.cursor(target);
        if (!beats.length || current < 1) return { status: 'skipped' };
        const ctx = context?.();
        const config = loadConfig?.() || {};
        if (!config.url || !config.key) { const error = makeDiagnosticError('config-missing'); logDiagnostic?.(safeDiagnosticLog('outline', 'request', error, { background: true })); return { status: 'failed', error }; }
        abort();
        const baseline = outlineBaseline(saved);
        const task = makeOwner(target, baseline);
        const removeBridge = bridgeAbortSignal?.(externalSignal, task.controller) || (() => {});
        try {
            if (externalSignal?.aborted || task.controller.signal.aborted) return { status: 'cancelled' };
            const prompt = buildOutlineRelocationPrompt(beats, current, promptAddon, cleanText);
            const answer = await callApi?.({
                ctx,
                prompt,
                config,
                userName: ctx?.name1 || '用户',
                charName: ctx?.name2 || '角色',
                signal: task.controller.signal,
            });
            if (!currentAndOwned(task) || externalSignal?.aborted || !repository.matches(target, baseline)) return { status: 'cancelled' };
            const next = parseOutlineRelocationAnswer(answer, beats.length);
            if (next == null) throw new Error('AI 未返回有效节点编号');
            if (next === current) return { status: 'unchanged' };
            if (!repository.setCursor(target, next, baseline)) return { status: 'cancelled' };
            notifyChanged(task, saved.raw, next);
            return { status: 'updated' };
        } catch (error) {
            if (!currentAndOwned(task) || error?.name === 'AbortError' || externalSignal?.aborted) return { status: 'cancelled' };
            if (!repository.matches(target, baseline)) return { status: 'cancelled' };
            logDiagnostic?.(safeDiagnosticLog('outline', 'request', error, { background: true }));
            return { status: 'failed', error };
        } finally {
            try { removeBridge(); } catch {}
            finish(task);
        }
    };

    const interval = () => {
        const value = Number(settings?.().outlineJudgeInterval);
        return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3;
    };
    const onCharacterMessage = messageId => {
        if (!pluginEnabled?.() || settings?.().outlineInject !== true) return false;
        const chat = context?.()?.chat;
        if (!Array.isArray(chat) || messageId !== chat.length - 1 || messageId <= lastJudgedMessageId) return false;
        lastJudgedMessageId = messageId;
        if (isAutomationSuppressed?.(messageId, automationModule)) return false;
        if (++messageCounter < interval()) return false;
        messageCounter = 0;
        void runAdvance();
        return true;
    };
    const onChatChanged = ({ lastSeen = -1 } = {}) => {
        abort();
        lastJudgedMessageId = Number.isFinite(Number(lastSeen)) ? Number(lastSeen) : -1;
        messageCounter = 0;
    };
    const resetCounter = () => { messageCounter = 0; };
    const canRelocate = () => {
        const target = repository.capture();
        const saved = repository.readOutline(target);
        return !!(saved?.raw && parseOutline(saved.raw).length && repository.cursor(target) >= 1);
    };
    return Object.freeze({
        runAdvance,
        relocate,
        onCharacterMessage,
        onChatChanged,
        resetCounter,
        canRelocate,
        abort,
        getInterval: interval,
        get busy() { return busy; },
        state: () => ({ busy, lastJudgedMessageId, messageCounter }),
    });
}
import { makeDiagnosticError } from '../../api/diagnostics.js';
