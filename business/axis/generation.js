import { axisState } from './state.js';

export function createAxisGenerationController(env = {}) {
    const run = async (supplement = false) => {
        const chat = env.context?.(); const chatId = chat?.chatId; const ctrl = axisState.almanacAbortController = new AbortController();
        axisState.isGeneratingAlmanac = true; axisState._almGenLabel = supplement ? '正在通读全程·补录纪念日' : '正在编排历法'; env.render?.();
        try {
            const userName = chat.name1 || '用户', charName = chat.name2 || '角色', cfg = env.config?.();
            const existing = supplement ? (env.loadItems?.() || []).map(item => `- ${item.name}（${env.dateLabel?.(item)}）`).join('\n') : null;
            const prompt = supplement ? env.supplementPrompt?.(userName, charName, existing) : env.prompt?.(userName, charName);
            const raw = await env.callApi(chat, prompt, cfg, userName, charName, ctrl.signal, 4, { fullMemory: true });
            if (axisState.almanacAbortController !== ctrl) return { status: 'cancelled' };
            if (env.context?.().chatId !== chatId) return { status: 'cancelled' };
            if (!env.validate?.(raw)) throw new Error(supplement ? '补录返回不完整（缺少 almanac_widget 结束标签），旧历数据未改变，请重试' : '返回不完整（缺少 almanac_widget 结束标签），旧轴数据未改变，请重试');
            const parsed = env.parse?.(raw) || [];
            if (!supplement && !parsed.length) throw new Error('没有解析到有效日期，请重试');
            if (supplement) {
                const base = env.loadItems?.() || [], seen = new Set(base.map(env.dedupKey)), added = [];
                for (const item of parsed) { const key = env.dedupKey(item); if (seen.has(key)) continue; seen.add(key); added.push({ ...item, pin: true }); }
                if (added.length) env.saveItems?.([...base, ...added]);
                axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null; if (added.length) env.sync?.(); env.render?.(); env.notify?.(added.length ? `已补录 ${added.length} 条纪念日` : '通读全程后没有够格补录的新里程碑（这很正常）', added.length > 0); return { status: 'updated', added };
            }
            env.saveItems?.(env.merge?.(env.loadItems?.() || [], parsed)); axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null; env.sync?.(); env.render?.(); env.notify?.('轴已生成', true); return { status: 'updated', items: parsed };
        } catch (error) {
            if (axisState.almanacAbortController !== ctrl) return { status: 'cancelled' };
            axisState.isGeneratingAlmanac = false; axisState.almanacAbortController = null;
            if (error?.name === 'AbortError') { env.render?.(); return { status: 'cancelled' }; }
            if (env.context?.().chatId === chatId) { env.render?.(); env.error?.(error, supplement); }
            return { status: 'failed', error };
        }
    };
    const trigger = async (supplement = false) => {
        if (axisState.isGeneratingAlmanac) return { status: 'skipped' };
        const cfg = env.config?.(); if (!cfg?.url || !cfg?.key) { env.missingApi?.(); return { status: 'failed', reason: 'api' }; }
        if (!env.context?.().chatId) { env.missingChat?.(); return { status: 'failed', reason: 'chat' }; }
        if (!supplement && (env.loadItems?.() || []).length) { const ok = await env.confirm?.(); if (!ok) return { status: 'cancelled' }; }
        return run(supplement);
    };
    return { run, trigger, abort: () => axisState.almanacAbortController?.abort(), get isBusy() { return axisState.isGeneratingAlmanac; }, get abortController() { return axisState.almanacAbortController; } };
}
