import { parseLines, serializeLines, validateLinesResponse } from './schema.js';
import { mergePinned } from './mutations.js';
import { decideLinesCommit } from './generation.js';

export function createLinesGenerationController(env = {}) {
    const owners = env.owners;
    const run = async (silent = false, swipeCtx = null, travelContext = null) => {
        const chatId = env.chatId();
        const owner = owners.create('lines-generation', { chatId, chatRevision: owners.currentChatRevision(), intent: swipeCtx?.forceReroll || swipeCtx?.reroll ? 'reroll' : (travelContext ? 'time-travel' : 'advance') });
        env.onStart?.(owner);
        const signal = owner.controller.signal;
        const travelAbort = travelContext?.signal;
        const abortFromTravel = () => owner.controller.abort();
        travelAbort?.addEventListener('abort', abortFromTravel, { once: true });
        try {
            if (signal.aborted || travelAbort?.aborted) return { status: 'cancelled', reason: 'aborted' };
            const cfg = env.loadConfig();
            if (!cfg?.url || !cfg?.key) {
                env.missingApi?.({ silent });
                throw new Error('请先在设置中填写自定义 API 的 URL 和 Key');
            }
            const commitBaseline = env.readSaved() || {};
            const sourceRaw = typeof swipeCtx?.baselineRaw === 'string' ? swipeCtx.baselineRaw : (commitBaseline.raw || '');
            const isReroll = !!(swipeCtx?.forceReroll || swipeCtx?.reroll);
            const previousRaw = isReroll ? serializeLines(parseLines(sourceRaw).filter(line => line.pin)) : sourceRaw;
            const prompt = env.buildPrompt(previousRaw, travelContext);
            const raw = await env.callApi(prompt, signal, { ...(travelContext || {}), ...(swipeCtx?.forceReroll || swipeCtx?.reroll ? { reroll: true, module: 'lines' } : {}) });
            if (!owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const checked = validateLinesResponse(raw);
            if (!checked.ok) {
                env.fail?.(new Error(`线输出无效：${checked.reason}`), { silent });
                return { status: 'failed', reason: checked.reason };
            }
            const latest = env.readSaved() || {};
            const decision = decideLinesCommit({ ownerCurrent: owners.isCurrent(owner, { chatId }), validation: checked, baseline: { raw: commitBaseline.raw || '', ts: commitBaseline.ts }, latest: { raw: latest.raw || '', ts: latest.ts } });
            if (!decision.ok) return { status: 'cancelled', reason: decision.reason };
            const merged = mergePinned(previousRaw, checked.raw);
            if (!merged.ok) return { status: 'cancelled', reason: merged.reason };
            env.commit(merged.raw, { silent, owner, swipeCtx, travelContext, commitBaseline });
            return { status: 'updated', targetDate: travelContext?.targetDate };
        } catch (error) {
            if (error?.name === 'AbortError') return { status: 'cancelled' };
            if (!owners.isCurrent(owner, { chatId })) return { status: 'cancelled', reason: 'stale-owner' };
            if (env.chatId() === chatId) env.fail?.(error, { silent });
            return { status: 'failed', error };
        } finally {
            travelAbort?.removeEventListener('abort', abortFromTravel);
            env.cleanup?.(owner, chatId);
        }
    };
    return { run };
}
