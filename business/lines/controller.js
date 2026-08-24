import { parseLines, serializeLines, validateLinesResponse, TERMINAL_LINE_STAGES } from './schema.js';
import { mergePinned } from './mutations.js';
import { decideLinesCommit } from './generation.js';
import { bindVectorTickets } from './vectors/bind.js';

export function createLinesGenerationController(env = {}) {
    const owners = env.owners;
    const run = async (silent = false, swipeCtx = null, travelContext = null) => {
        const chatId = env.chatId();
        const owner = owners.create('lines-generation', { chatId, chatRevision: owners.currentChatRevision(), intent: swipeCtx?.forceReroll || swipeCtx?.reroll ? 'reroll' : (travelContext ? 'time-travel' : 'advance') });
        env.runtime?.start(owner.controller);
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
                throw makeDiagnosticError('config-missing');
            }
            const savedSnapshot = env.readSaved() || {};
            const commitBaseline = Object.freeze({ chatId, key: env.cacheKey?.() ?? null, raw: String(savedSnapshot.raw || ''), ts: Number(savedSnapshot.ts) || null, cursor: savedSnapshot.cursor ?? 0, html: savedSnapshot.html ?? null });
            // owner baseline is captured once and never replaced by a later live-store read.
            owner.baseline = commitBaseline;
            const sourceRaw = typeof swipeCtx?.baselineRaw === 'string' ? swipeCtx.baselineRaw : owner.baseline.raw;
            const isReroll = !!(swipeCtx?.forceReroll || swipeCtx?.reroll);
            const sourceLines = parseLines(sourceRaw);
            const liveCandidates = sourceLines.filter(line => line.pin || !TERMINAL_LINE_STAGES.has(line.stage));
            const identityLines = isReroll ? liveCandidates.filter(line => line.pin) : liveCandidates;
            const previousRaw = isReroll || liveCandidates.length !== sourceLines.length ? serializeLines(identityLines) : sourceRaw;
            let drawer = env.drawTickets;
            let capacity = Number(env.vectorCapacity);
            if (!drawer || !capacity) {
                const vectors = await import('./vectors/draw.js');
                if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
                drawer ||= vectors.drawTickets;
                capacity ||= vectors.LEGAL_TICKET_CAPACITY;
            }
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const ticketCount = Math.min(capacity, Math.max(8, sourceLines.filter(line => line.name).length + 2));
            const freshTickets = await drawer(ticketCount, { random: env.random || (() => Math.random()), seed: owner.id, nonce: owner.chatRevision });
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            owner.vectorTickets = freshTickets;
            const vectorContext = { retained: identityLines.filter(line => line.cue), legacyWithoutCue: identityLines.filter(line => !line.cue).map(line => line.name), freshTickets };
            const prompt = env.buildPrompt(previousRaw, travelContext, vectorContext);
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const raw = await env.callApi(prompt, signal, { ...(travelContext || {}), ...(swipeCtx?.forceReroll || swipeCtx?.reroll ? { reroll: true, module: 'lines' } : {}) });
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const checked = validateLinesResponse(raw);
            if (!checked.ok) {
                env.fail?.(makeDiagnosticError('invalid-structure', { phase: 'parse' }), { silent });
                return { status: 'failed', reason: checked.reason };
            }
            const latest = env.readSaved() || {};
            const latestSnapshot = Object.freeze({ raw: String(latest.raw || ''), ts: Number(latest.ts) || null });
            const decision = decideLinesCommit({ ownerCurrent: owners.isCurrent(owner, { chatId }) && !signal.aborted && !travelAbort?.aborted, validation: checked, baseline: { raw: commitBaseline.raw, ts: commitBaseline.ts }, latest: latestSnapshot });
            if (!decision.ok) return { status: 'cancelled', reason: decision.reason };
            const bound = bindVectorTickets({ previousLines: identityLines, generatedLines: checked.model, freshTickets });
            const merged = mergePinned(previousRaw, serializeLines(bound));
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
            env.runtime?.finish(owner.controller);
            env.cleanup?.(owner, chatId);
        }
    };
    return { run };
}
import { diagnosticMessage, makeDiagnosticError } from '../../api/diagnostics.js';
