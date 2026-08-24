import { buildOutlinePrompt } from './prompts.js';

export function createOutlineGeneration({
    repository,
    context,
    loadConfig,
    callApi,
    precheck,
    judge,
    injection,
    renderer,
    ui,
    settings,
    openSettings,
    now = () => Date.now(),
} = {}) {
    let owner = null;
    let busy = false;

    const owns = candidate => owner === candidate;
    const finish = candidate => {
        if (!owns(candidate)) return false;
        owner = null;
        busy = false;
        return true;
    };
    const currentAndOwned = candidate => owns(candidate)
        && !candidate.controller.signal.aborted
        && repository.isCurrent(candidate.target);
    const renderCurrent = target => {
        if (!repository.isCurrent(target)) return;
        const saved = repository.readOutline(target);
        ui?.setOutline(saved?.raw ? renderer.render(saved.raw, repository.cursor(target)) : renderer.empty());
    };
    const abort = () => {
        if (!busy) return false;
        const previous = owner;
        owner = null;
        busy = false;
        try { previous?.controller?.abort(); } catch {}
        if (previous?.target) renderCurrent(previous.target);
        return true;
    };

    const trigger = async (apiOptions = { reroll: true, module: 'outline' }) => {
        if (busy) return { status: 'skipped' };
        const target = repository.capture();
        if (!target?.chatId) return { status: 'skipped' };
        if (precheck && !await precheck()) return { status: 'cancelled' };
        if (!repository.isCurrent(target) || busy) return { status: 'cancelled' };
        judge?.abort();
        const baseline = repository.baseline(target);
        const controller = new AbortController();
        const task = Object.freeze({ target, baseline, controller });
        owner = task;
        busy = true;
        ui?.setLoading();
        try {
            const ctx = context?.();
            const userName = ctx?.name1 || '用户';
            const charName = ctx?.name2 || '角色';
            const config = loadConfig?.() || {};
            if (!config.url || !config.key) {
                openSettings?.();
                throw makeDiagnosticError('config-missing');
            }
            const raw = await callApi?.({
                ctx,
                prompt: buildOutlinePrompt(userName, charName, 'user'),
                config,
                userName,
                charName,
                signal: controller.signal,
                historyLimit: 10,
                options: apiOptions,
            });
            if (!currentAndOwned(task) || !repository.matches(target, baseline)) return { status: 'cancelled' };
            if (!String(raw || '').trim()) throw new Error('AI 未返回可保存的面内容');
            if (!repository.commitOutline(target, { raw, ts: now(), cursor: 1 }, baseline)) return { status: 'cancelled' };
            finish(task);
            injection?.refresh(target);
            const html = renderer.render(raw, 1);
            if (ui?.isOutlineMode?.()) {
                ui.setOutline(html);
                if (settings?.().notifyMode !== 'off') ui.toast?.('面已生成');
            } else {
                ui?.closedSuccess?.();
            }
            return { status: 'updated', raw };
        } catch (error) {
            if (!currentAndOwned(task)) return { status: 'cancelled' };
            if (!repository.matches(target, task.baseline)) return { status: 'cancelled' };
            finish(task);
            if (error?.name === 'AbortError') {
                renderCurrent(target);
                return { status: 'cancelled' };
            }
            if (task.baseline.raw) {
                renderCurrent(target);
                ui?.toast?.('面生成失败，已保留原存档', true);
            } else if (ui?.isOutlineMode?.() && ui?.isPanelVisible?.()) {
                ui?.showGenerationError?.(error);
            } else {
                ui?.toast?.('面生成失败，请重试', true);
            }
            return { status: 'failed', error };
        } finally {
            finish(task);
        }
    };
    return Object.freeze({
        trigger,
        abort,
        renderCurrent,
        get busy() { return busy; },
        owner: () => owner,
    });
}
import { makeDiagnosticError } from '../../api/diagnostics.js';
