import { axisState } from './state.js';
import { createGenerationDiagnosticScope, makeDiagnosticError } from '../../api/diagnostics.js';

export function validateAlmanacResponse(raw) {
    return /<almanac_widget\b[^>]*>[\s\S]*<\/almanac_widget\s*>/i.test(String(raw || ''));
}

export function createAxisGenerationController(env = {}) {
    const participantCurrent = participant => !participant || env.sameParticipantIdentity?.(participant, env.captureParticipantIdentity?.()) !== false;
    const run = async (supplement = false, participantLease = null) => {
        const diagnostic = createGenerationDiagnosticScope('axis-generation');
        const runUi = (callback, reasonCode) => { try { callback?.(); } catch (error) { diagnostic.uiFailed(error, { reasonCode }); } };
        const participant = participantLease || env.captureParticipantIdentity?.() || null;
        if (!participantCurrent(participant)) return { status: 'cancelled' };
        const chat = env.context?.(); const chatId = chat?.chatId; const ctrl = axisState.almanacAbortController = new AbortController();
        axisState.isGeneratingAlmanac = true; axisState._almGenLabel = supplement ? '正在通读全程·补录纪念日' : '正在编排历法'; env.render?.();
        const cancelOwned = () => {
            if (axisState.almanacAbortController === ctrl) { axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null; }
            return { status: 'cancelled' };
        };
        try {
            const userName = participant?.userName || chat.name1 || '用户', charName = participant?.charName || chat.name2 || '角色', cfg = env.config?.();
            const existing = supplement ? (env.loadItems?.() || [])
                .filter(item => item?.type === 'anniversary' || item?.type === 'custom')
                .map(item => {
                    const note = String(item.note || '').replace(/\s+/g, ' ').trim();
                    return `- 名称：${item.name}｜类型：${item.type}｜日期：${env.dateLabel?.(item) || `${item.month}月${item.day}日`}${note ? `｜说明：${note}` : ''}`;
                }).join('\n') : null;
            const prompt = supplement ? env.supplementPrompt?.(userName, charName, existing) : env.prompt?.(userName, charName);
            // 整历 reroll 必须与旧历隔离：既不把当前历作为 system 数据源再喂回模型，
            // 也让统一消息构建器剥掉记忆/历史里残留的旧 widget。补录仍需看现有历去重，保持旧调用不变。
            const apiOptions = supplement
                ? { fullMemory: true, promptMode: 'creative', diagnosticModule: 'axis-generation', diagnosticSink: diagnostic.sink }
                : { fullMemory: true, noAlmanac: true, reroll: true, module: 'almanac', promptMode: 'creative', diagnosticModule: 'axis-generation', diagnosticSink: diagnostic.sink };
            if (!participantCurrent(participant) || env.context?.().chatId !== chatId) return cancelOwned();
            const raw = await env.callApi(chat, prompt, cfg, userName, charName, ctrl.signal, 3, apiOptions);
            if (axisState.almanacAbortController !== ctrl) return { status: 'cancelled' };
            if (!participantCurrent(participant) || env.context?.().chatId !== chatId) return cancelOwned();
            if (!env.validate?.(raw)) throw diagnostic.rejected(makeDiagnosticError('parse', { phase: 'parse' }), { phase: 'parse', reasonCode: 'almanac-widget-missing' });
            const parsed = env.parse?.(raw) || [];
            if (!supplement && !parsed.length) throw diagnostic.rejected(makeDiagnosticError('invalid-fields', { phase: 'validation' }), { phase: 'validation', reasonCode: 'almanac-no-valid-date' });
            if (supplement) {
                const base = env.loadItems?.() || [], seen = new Set(base.map(env.dedupKey)), added = [];
                for (const item of parsed) { const key = env.dedupKey(item); if (seen.has(key)) continue; seen.add(key); added.push({ ...item, pin: true }); }
                if (!participantCurrent(participant) || env.context?.().chatId !== chatId) return cancelOwned();
                diagnostic.accepted({ phase: 'validation', reasonCode: added.length ? 'supplement-valid' : 'supplement-empty' });
                let stored = null;
                if (added.length) { try { stored = await env.saveItems?.([...base, ...added], { ownerGuard: () => participantCurrent(participant) && env.context?.().chatId === chatId && axisState.almanacAbortController === ctrl }); if (!(stored === true || stored?.ok === true)) throw Object.assign(new Error(stored?.reason || 'save-rejected'), { saveResult: stored }); } catch (cause) { const status = Number(cause?.saveResult?.status ?? cause?.status); const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) }); if (cause?.saveResult) error.saveResult = cause.saveResult; throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'axis-save-failed' }); } }
                if (!participantCurrent(participant) || env.context?.().chatId !== chatId) return cancelOwned();
                diagnostic.committed({ reasonCode: added.length ? 'axis-saved' : 'axis-no-change' });
                if (stored?.stale) { axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null; return { status: 'cancelled', reason: 'committed-but-stale', committed: true, added }; }
                axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null;
                if (added.length) runUi(() => env.sync?.(), 'axis-sync-failed');
                runUi(() => env.render?.(), 'axis-render-failed');
                runUi(() => env.notify?.(added.length ? `已补录 ${added.length} 条纪念日` : '通读全程后没有够格补录的新里程碑（这很正常）', added.length > 0), 'axis-notify-failed');
                return { status: 'updated', added };
            }
            if (!participantCurrent(participant) || env.context?.().chatId !== chatId) return cancelOwned();
            diagnostic.accepted({ phase: 'validation', reasonCode: 'almanac-valid' });
            let stored;
            try { stored = await env.saveItems?.(env.merge?.(env.loadItems?.() || [], parsed), { ownerGuard: () => participantCurrent(participant) && env.context?.().chatId === chatId && axisState.almanacAbortController === ctrl }); if (!(stored === true || stored?.ok === true)) throw Object.assign(new Error(stored?.reason || 'save-rejected'), { saveResult: stored }); } catch (cause) { const status = Number(cause?.saveResult?.status ?? cause?.status); const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) }); if (cause?.saveResult) error.saveResult = cause.saveResult; throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'axis-save-failed' }); }
            if (!participantCurrent(participant) || env.context?.().chatId !== chatId) return cancelOwned();
            diagnostic.committed({ reasonCode: 'axis-saved' });
            if (stored?.stale) { axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null; return { status: 'cancelled', reason: 'committed-but-stale', committed: true, items: parsed }; }
            axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null;
            runUi(() => env.sync?.(), 'axis-sync-failed'); runUi(() => env.render?.(), 'axis-render-failed'); runUi(() => env.notify?.('轴已生成', true), 'axis-notify-failed');
            return { status: 'updated', items: parsed };
        } catch (error) {
            if (axisState.almanacAbortController !== ctrl) return { status: 'cancelled' };
            axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null;
            if (error?.name === 'AbortError') { env.render?.(); return { status: 'cancelled' }; }
            if (participantCurrent(participant) && env.context?.().chatId === chatId) { env.render?.(); env.error?.(error, supplement); }
            return { status: 'failed', error };
        }
    };
    const trigger = async (supplement = false) => {
        const participant = env.captureParticipantIdentity?.() || null;
        if (axisState.isGeneratingAlmanac) return { status: 'skipped' };
        const cfg = env.config?.(); if (!cfg?.url || !cfg?.key) { env.missingApi?.(); return { status: 'failed', reason: 'api' }; }
        if (!env.context?.().chatId) { env.missingChat?.(); return { status: 'failed', reason: 'chat' }; }
        if (!supplement && (env.loadItems?.() || []).length) { const ok = await env.confirm?.(); if (!ok) return { status: 'cancelled' }; }
        if (!participantCurrent(participant)) return { status: 'cancelled' };
        return run(supplement, participant);
    };
    const reset = (reason = 'reset') => {
        const ctrl = axisState.almanacAbortController;
        ctrl?.abort(reason);
        if (axisState.almanacAbortController === ctrl) {
            axisState.almanacAbortController = null;
            axisState.isGeneratingAlmanac = false;
        }
        return ctrl;
    };
    return { run, trigger, abort: (reason = 'manual-abort') => axisState.almanacAbortController?.abort(reason), reset, get isBusy() { return axisState.isGeneratingAlmanac; }, get abortController() { return axisState.almanacAbortController; } };
}
