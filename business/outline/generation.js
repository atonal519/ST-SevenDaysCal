import { buildOutlinePrompt } from './prompts.js';
import { parseOutline } from './schema.js';
import { createGenerationDiagnosticScope, diagnosticMessage, makeDiagnosticError } from '../../api/diagnostics.js';

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
    isEditing = () => false,
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
    const abort = (reason = 'manual-abort') => {
        if (!busy) return false;
        const previous = owner;
        owner = null;
        busy = false;
        try { previous?.controller?.abort(reason); } catch {}
        if (previous?.target) renderCurrent(previous.target);
        return true;
    };

    const trigger = async (apiOptions = { reroll: true, module: 'outline' }) => {
        const diagnostic = createGenerationDiagnosticScope('outline-generation');
        if (busy || isEditing()) return { status: 'skipped' };
        const target = repository.capture();
        if (!target?.chatId) return { status: 'skipped' };
        if (precheck && !await precheck()) return { status: 'cancelled' };
        if (!repository.isCurrent(target) || busy) return { status: 'cancelled' };
        judge?.abort('superseded-owner');
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
                historyLimit: 3,
                options: { ...(apiOptions || {}), promptMode: 'creative', diagnosticModule: 'outline-generation', diagnosticSink: diagnostic.sink },
            });
            if (isEditing() || !currentAndOwned(task) || !repository.matches(target, baseline)) return { status: 'cancelled' };
            if (!String(raw || '').trim()) throw diagnostic.rejected(makeDiagnosticError('empty-output', { phase: 'empty-output' }), { phase: 'parse', reasonCode: 'outline-empty' });
            if (parseOutline(raw).length === 0) throw diagnostic.rejected(makeDiagnosticError('parse', { phase: 'parse' }), { phase: 'parse', reasonCode: 'outline-no-beats' });
            diagnostic.accepted({ phase: 'validation', reasonCode: 'outline-valid' });
            let committed;
            try { committed = await (repository.commitOutlineConfirmed || repository.commitOutline)(target, { raw, ts: now(), cursor: 1 }, baseline, { ownerGuard: () => currentAndOwned(task) }); }
            catch (cause) { const status = Number(cause?.saveResult?.status ?? cause?.status); const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) }); if (cause?.saveResult) error.saveResult = cause.saveResult; throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'outline-save-failed' }); }
            if (!(committed === true || committed?.ok === true)) {
                if (!currentAndOwned(task) || !repository.matches(target, baseline)) return { status: 'cancelled' };
                const status = Number(committed?.status); const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) }); if (committed && typeof committed === 'object') error.saveResult = committed; throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'outline-save-rejected' });
            }
            diagnostic.committed({ reasonCode: committed?.stale ? 'outline-saved-stale' : 'outline-saved' });
            if (committed?.stale || !currentAndOwned(task)) { finish(task); return { status: 'cancelled', reason: 'committed-but-stale', committed: true, raw }; }
            finish(task);
            try {
                injection?.refresh(target);
                const html = renderer.render(raw, 1);
                if (ui?.isOutlineMode?.()) {
                    ui.setOutline(html);
                    if (settings?.().notifyMode !== 'off') ui.toast?.('面已生成');
                } else ui?.closedSuccess?.();
            } catch (error) { diagnostic.uiFailed(error, { reasonCode: 'outline-ui-refresh-failed' }); }
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
                ui?.toast?.(`面生成失败：${diagnosticMessage(error)}；已保留原存档`, true);
            } else if (ui?.isOutlineMode?.() && ui?.isPanelVisible?.()) {
                ui?.showGenerationError?.(error);
            } else {
                ui?.toast?.(`面生成失败：${diagnosticMessage(error)}`, true);
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
