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
export function createDateDetectionController(options = {}) {
    let busy = false; let abortController = null;
    const identity = () => options.identity?.() || { chatId: options.context()?.chatId || null, floor: null, swipe: null };
    const sameIdentity = (a, b) => !!a && !!b && String(a.chatId || '') === String(b.chatId || '') && a.floor === b.floor && String(a.swipe ?? '') === String(b.swipe ?? '');
    const current = (ctrl, ownerIdentity, signal) => abortController === ctrl && !ctrl.signal.aborted && !signal?.aborted && sameIdentity(ownerIdentity, identity());
    const apply = (charKey, md, notify = true, ownerIdentity = null, mode = 'api') => {
        if (!charKey || !md) return { status: 'unresolved' };
        const calibration = options.getCalibration?.(charKey);
        if (mode === 'sdc' && calibration && ownerIdentity && Number.isInteger(calibration.floor) && calibration.floor === ownerIdentity.floor) return { status: 'calibration-held', date: md };
        const prev = options.getAnchor?.(charKey);
        if (prev && prev.month === md.month && prev.day === md.day) return { status: 'unchanged', date: md };
        const stored = options.setAnchor?.(charKey, md.month, md.day, 'detected', mode === 'api' && calibration ? { calibration } : {});
        if (!stored?.ok) { if (notify) options.toast?.('剧情日期自动保存失败，请重试', null, true); return { status: 'failed', reason: stored?.reason }; }
        if (notify && options.settings?.().notifyMode === 'full') options.toast?.(`剧情日期已自动更新为 ${options.monthName?.(md.month)}${md.day}日 · 请注意查看`);
        options.aftermath?.();
        return { status: 'updated', date: md };
    };
    const reland = () => {
        if (options.storyEnabled?.() !== true) return { status: 'no-date', reason: 'disabled' };
        const clock = options.storyClock?.(); if (!options.completeStoryClock?.(clock)) return { status: 'no-date', reason: 'missing-complete-sdc' };
        const md = options.storyDate?.(); if (!md) return { status: 'no-date', reason: 'missing-date' };
        const ownerIdentity = { ...identity(), floor: clock.floor };
        const applied = apply(options.charKey?.(options.context()), md, true, ownerIdentity, 'sdc');
        return applied.status === 'failed' ? { status: 'write-failed', reason: applied.reason, date: md } : { status: applied.status === 'updated' ? 'updated' : 'handled', date: md };
    };
    const run = async ({ signal: externalSignal = null } = {}) => {
        if (busy) return { status: 'skipped' };
        const ctx = options.context(); const charKey = options.charKey?.(ctx); if (!charKey) return { status: 'skipped' };
        const cfg = options.config?.();
        if (!cfg?.url || !cfg?.key) {
            const error = makeDiagnosticError('config-missing');
            options.logDiagnostic?.(safeDiagnosticLog('axis', 'request', error, { background: true }));
            if (options.settings?.().notifyMode === 'full') options.toast?.('剧情日期自动确认失败，请先配置 API', null, true);
            return { status: 'failed', error };
        }
        const chatId = ctx.chatId; const ownerIdentity = identity(); const ctrl = new AbortController(); abortController = ctrl; busy = true;
        const remove = options.bridge?.(externalSignal, ctrl) || (() => {});
        try {
            const raw = await options.callApi(ctx, options.prompt?.() || DATE_JUDGE_PROMPT, cfg, ctx.name1 || '用户', ctx.name2 || '角色', ctrl.signal, DATE_JUDGE_HISTORY_LIMIT);
            if (!current(ctrl, ownerIdentity, externalSignal)) return { status: 'cancelled' };
            const md = options.parse?.(raw); if (!md) return { status: 'unresolved' };
            const result = apply(charKey, md, true, ownerIdentity);
            return ctrl.signal.aborted ? { status: 'cancelled' } : { ...result, date: md };
        } catch (error) {
            if (abortController !== ctrl || error?.name === 'AbortError' || externalSignal?.aborted || !sameIdentity(ownerIdentity, identity())) return { status: 'cancelled' };
            options.logDiagnostic?.(safeDiagnosticLog('axis', 'request', error, { background: true })); if (options.settings?.().notifyMode === 'full') options.toast?.('剧情日期自动确认失败，请检查 API 或网络', null, true); return { status: 'failed', error };
        } finally { if (abortController === ctrl) { busy = false; abortController = null; } remove(); }
    };
    return { run, reland, apply, abort: () => abortController?.abort(), reset: () => { abortController?.abort(); busy = false; abortController = null; }, get isBusy() { return busy; }, get abortController() { return abortController; } };
}
import { makeDiagnosticError, safeDiagnosticLog } from '../../api/diagnostics.js';
