import { createGenerationDiagnosticScope, diagnosticMessage, makeDiagnosticError, runGenerationUiEffect, safeDiagnosticLog } from '../../api/diagnostics.js';

export const DATE_JUDGE_HISTORY_LIMIT = 3;
export const DATE_JUDGE_PROMPT = `请暂停角色扮演，作为剧情分析助手，只做一件事：判断以上最近的对话里，故事此刻发生在哪一天。
只回答「当前剧情日期」，格式为 M月D日（例如 3月15日）；年份不重要、无需回答。
若最近对话中并无明确日期线索、无法确定具体月日，就只回答「未知」。
不要解释，不要输出任何多余文字。`;
export function buildDateJudgePrompt(calendarText = '') { return calendarText ? `请暂停角色扮演，作为剧情分析助手，只做一件事：判断以上最近的对话里，故事此刻发生在哪一天。
本世界观使用自定义历法（非公历）——${calendarText}
只回答「当前剧情日期」，格式为「第M月D日」（M=第几个月的序号，D=该月第几日，例如第3月15日），或直接用上面列出的月名；年份不重要、无需回答。
若最近对话中并无明确日期线索、无法确定具体月日，就只回答「未知」。
不要解释，不要输出任何多余文字。` : DATE_JUDGE_PROMPT; }
export function storyWeekdayDisplaySignature(clock) {
    const meta = clock?.endMeta;
    return meta?.complete && Number.isInteger(meta.month) && Number.isInteger(meta.day) && Number.isInteger(meta.weekdayIndex)
        ? `${meta.month}/${meta.day}:${meta.weekdayIndex}`
        : null;
}
export function createDateDetectionController(options = {}) {
    let busy = false; let abortController = null; let lastWeekdayDisplaySignature;
    const identity = () => options.identity?.() || { chatId: options.context()?.chatId || null, floor: null, swipe: null };
    const sameIdentity = (a, b) => !!a && !!b && String(a.chatId || '') === String(b.chatId || '') && a.floor === b.floor && String(a.swipe ?? '') === String(b.swipe ?? '');
    const participantCurrent = participant => !participant || options.sameParticipantIdentity?.(participant, options.captureParticipantIdentity?.()) !== false;
    const ownerCurrent = ownerIdentity => !!ownerIdentity && sameIdentity(ownerIdentity, identity()) && participantCurrent(ownerIdentity.participantIdentity);
    const current = (ctrl, ownerIdentity, signal) => abortController === ctrl && !ctrl.signal.aborted && !signal?.aborted && ownerCurrent(ownerIdentity);
    const apply = (charKey, md, notify = true, ownerIdentity = null, mode = 'api', { suppressAftermath = false } = {}) => {
        if (!charKey || !md) return { status: 'unresolved' };
        if (ownerIdentity && !ownerCurrent(ownerIdentity)) return { status: 'cancelled' };
        const calibration = options.getCalibration?.(charKey);
        if (mode === 'sdc' && calibration && ownerIdentity && Number.isInteger(calibration.floor) && calibration.floor === ownerIdentity.floor) return { status: 'calibration-held', date: md };
        const prev = options.getAnchor?.(charKey);
        if (prev && prev.month === md.month && prev.day === md.day && prev.year === md.year && prev.eraLabel === md.eraLabel) return { status: 'unchanged', date: md };
        if (ownerIdentity && !ownerCurrent(ownerIdentity)) return { status: 'cancelled' };
        const stored = options.setAnchor?.(charKey, md.month, md.day, 'detected', { ...(mode === 'api' && calibration ? { calibration } : {}), year: md.year, eraLabel: md.eraLabel });
        if (!stored?.ok) { if (notify) options.toast?.('剧情日期自动保存失败，请重试', null, true); return { status: 'failed', reason: stored?.reason }; }
        if (ownerIdentity && !ownerCurrent(ownerIdentity)) return { status: 'cancelled' };
        if (notify && options.settings?.().notifyMode === 'full') {
            if (ownerIdentity && !ownerCurrent(ownerIdentity)) return { status: 'cancelled' };
            options.toast?.(`剧情日期已自动更新为 ${options.monthName?.(md.month)}${md.day}日 · 请注意查看`);
        }
        if (!suppressAftermath) {
            if (ownerIdentity && !ownerCurrent(ownerIdentity)) return { status: 'cancelled' };
            options.aftermath?.();
        }
        return { status: 'updated', date: md };
    };
    const applyConfirmed = async (charKey, md, ownerIdentity) => {
        if (!charKey || !md) return { status: 'unresolved' };
        if (!ownerCurrent(ownerIdentity)) return { status: 'cancelled' };
        const calibration = options.getCalibration?.(charKey);
        const prev = options.getAnchor?.(charKey);
        if (prev && prev.month === md.month && prev.day === md.day && prev.year === md.year && prev.eraLabel === md.eraLabel) return { status: 'unchanged', date: md };
        const anchorOptions = { ...(calibration ? { calibration } : {}), year: md.year, eraLabel: md.eraLabel };
        const stored = await (options.setAnchorConfirmed || options.setAnchor)?.(charKey, md.month, md.day, 'detected', anchorOptions, { ownerGuard: () => ownerCurrent(ownerIdentity) });
        if (!(stored === true || stored?.ok === true)) return { status: 'failed', reason: stored?.reason || 'write-failed', saveResult: stored || null };
        if (stored?.stale || !ownerCurrent(ownerIdentity)) return { status: 'committed-stale', date: md, saveResult: stored };
        return { status: 'updated', date: md, saveResult: stored };
    };
    const reland = ({ suppressAftermath = false } = {}) => {
        if (options.storyEnabled?.() !== true) return { status: 'no-date', reason: 'disabled' };
        const clock = options.storyClock?.();
        const nextWeekdaySignature = options.completeStoryClock?.(clock) ? storyWeekdayDisplaySignature(clock) : null;
        const weekdayDisplayChanged = lastWeekdayDisplaySignature !== nextWeekdaySignature && (lastWeekdayDisplaySignature !== undefined || nextWeekdaySignature !== null);
        lastWeekdayDisplaySignature = nextWeekdaySignature;
        if (!options.completeStoryClock?.(clock)) { if (weekdayDisplayChanged && !suppressAftermath) options.aftermath?.(); return { status: 'no-date', reason: 'missing-complete-sdc' }; }
        const md = options.storyDate?.(); if (!md) return { status: 'no-date', reason: 'missing-date' };
        const ownerIdentity = { ...identity(), floor: clock.floor, participantIdentity: options.captureParticipantIdentity?.() || null };
        const applied = apply(options.charKey?.(options.context()), md, true, ownerIdentity, 'sdc', { suppressAftermath });
        if (weekdayDisplayChanged && !suppressAftermath && (applied.status === 'unchanged' || applied.status === 'calibration-held')) options.aftermath?.();
        return applied.status === 'failed' ? { status: 'write-failed', reason: applied.reason, date: md } : { status: applied.status === 'updated' ? 'updated' : 'handled', date: md };
    };
    const run = async ({ signal: externalSignal = null } = {}) => {
        const diagnostic = createGenerationDiagnosticScope('axis-date', { background: true });
        let generationCommitted = false;
        if (busy) return { status: 'skipped' };
        const participantIdentity = options.captureParticipantIdentity?.() || null;
        const ctx = options.context(); const charKey = options.charKey?.(ctx); if (!charKey) return { status: 'skipped' };
        const cfg = options.config?.();
        if (!cfg?.url || !cfg?.key) {
            const error = makeDiagnosticError('config-missing');
            options.logDiagnostic?.(safeDiagnosticLog('axis', 'request', error, { background: true }));
            if (options.settings?.().notifyMode === 'full') options.toast?.('剧情日期自动确认失败，请先配置 API', null, true);
            return { status: 'failed', error };
        }
        const ownerIdentity = { ...identity(), participantIdentity }; const ctrl = new AbortController(); abortController = ctrl; busy = true;
        const remove = options.bridge?.(externalSignal, ctrl) || (() => {});
        try {
            if (!current(ctrl, ownerIdentity, externalSignal)) return { status: 'cancelled' };
            const raw = await options.callApi(ctx, options.prompt?.() || DATE_JUDGE_PROMPT, cfg, ctx.name1 || '用户', ctx.name2 || '角色', ctrl.signal, DATE_JUDGE_HISTORY_LIMIT, { promptMode: 'mechanical', diagnosticModule: 'axis-date', diagnosticSink: diagnostic.sink });
            if (!current(ctrl, ownerIdentity, externalSignal)) return { status: 'cancelled' };
            const md = options.parse?.(raw);
            if (!md) {
                if (/^(?:未知|无法确定)[。.!！]?$/u.test(String(raw || '').trim())) { diagnostic.accepted({ phase: 'validation', reasonCode: 'date-explicit-unknown' }); diagnostic.committed({ reasonCode: 'date-no-change' }); generationCommitted = true; return { status: 'unresolved' }; }
                const error = diagnostic.rejected(makeDiagnosticError('parse', { phase: 'parse' }), { phase: 'parse', reasonCode: 'date-format-unrecognized' });
                options.logDiagnostic?.(safeDiagnosticLog('axis-date', 'parse', error, { background: true }));
                if (options.settings?.().notifyMode === 'full') options.toast?.(`剧情日期自动确认失败：${diagnosticMessage(error)}`, null, true);
                return { status: 'failed', error };
            }
            if (!current(ctrl, ownerIdentity, externalSignal)) return { status: 'cancelled' };
            diagnostic.accepted({ phase: 'validation', reasonCode: 'date-valid' });
            let result;
            try { result = await applyConfirmed(charKey, md, ownerIdentity); }
            catch (cause) { const status = Number(cause?.saveResult?.status ?? cause?.status); const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) }); if (cause?.saveResult) error.saveResult = cause.saveResult; throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'date-save-failed' }); }
            if (result.status === 'failed') {
                const status = Number(result.saveResult?.status); const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) }); if (result.saveResult) error.saveResult = result.saveResult;
                throw diagnostic.rejected(error, { phase: 'save', reasonCode: result.reason || 'date-save-failed' });
            }
            diagnostic.committed({ reasonCode: result.status === 'updated' ? 'date-saved' : 'date-no-change' });
            generationCommitted = true;
            if (result.status === 'committed-stale') return { status: 'cancelled', reason: 'committed-but-stale', committed: true, date: md };
            if (result.status === 'updated') {
                if (options.settings?.().notifyMode === 'full') await runGenerationUiEffect(() => options.toast?.(`剧情日期已自动更新为 ${options.monthName?.(md.month)}${md.day}日 · 请注意查看`), { diagnostic, reasonCode: 'date-toast-failed' });
                await runGenerationUiEffect(() => options.aftermath?.(), { diagnostic, reasonCode: 'date-ui-refresh-failed' });
            }
            return ctrl.signal.aborted ? { status: 'cancelled' } : { ...result, date: md };
        } catch (error) {
            if (abortController !== ctrl || error?.name === 'AbortError' || externalSignal?.aborted || !ownerCurrent(ownerIdentity)) return { status: 'cancelled' };
            const phase = error?.phase || 'request';
            options.logDiagnostic?.(safeDiagnosticLog('axis', phase, error, { background: true })); if (options.settings?.().notifyMode === 'full') options.toast?.(`剧情日期自动确认失败：${diagnosticMessage(error)}`, null, true); return { status: 'failed', reason: phase === 'save' ? 'save' : undefined, error };
        } finally {
            if (abortController === ctrl) { busy = false; abortController = null; }
            if (generationCommitted) await runGenerationUiEffect(remove, { diagnostic, reasonCode: 'date-cleanup-failed' });
            else remove();
        }
    };
    return { run, reland, apply, applyConfirmed, abort: (reason = 'manual-abort') => abortController?.abort(reason), reset: (reason = 'reset') => { abortController?.abort(reason); busy = false; abortController = null; lastWeekdayDisplaySignature = undefined; }, get isBusy() { return busy; }, get abortController() { return abortController; } };
}
