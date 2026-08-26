import { parseLines, serializeLines, validateLinesResponse, TERMINAL_LINE_STAGES } from './schema.js';
import { mergePinned } from './mutations.js';
import { decideLinesCommit } from './generation.js';
import { bindVectorTickets } from './vectors/bind.js';
import { makeDiagnosticError } from '../../api/diagnostics.js';
import { drawAdultSelections } from './adult.js';
import { enforceLineCapacity } from './capacity.js';

export function createLinesGenerationController(env = {}) {
    const owners = env.owners;
    const run = async (silent = false, swipeCtx = null, travelContext = null) => {
        if (env.isEditing?.()) return { status: 'cancelled', reason: 'editing' };
        const chatId = env.chatId();
        const owner = owners.create('lines-generation', { chatId, chatRevision: owners.currentChatRevision(), intent: swipeCtx?.forceReroll || swipeCtx?.reroll ? 'reroll' : (travelContext ? 'time-travel' : 'advance') });
        env.runtime?.start(owner.controller); env.onStart?.(owner);
        const signal = owner.controller.signal; const travelAbort = travelContext?.signal;
        const abortFromTravel = () => owner.controller.abort();
        travelAbort?.addEventListener('abort', abortFromTravel, { once: true });
        try {
            if (signal.aborted || travelAbort?.aborted) return { status: 'cancelled', reason: 'aborted' };
            const cfg = env.loadConfig();
            if (!cfg?.url || !cfg?.key) { env.missingApi?.({ silent }); throw makeDiagnosticError('config-missing'); }
            const savedSnapshot = env.readSaved() || {};
            const commitBaseline = Object.freeze({ chatId, key: env.cacheKey?.() ?? null, raw: String(savedSnapshot.raw || ''), ts: Number(savedSnapshot.ts) || null, cursor: savedSnapshot.cursor ?? 0, html: savedSnapshot.html ?? null });
            owner.baseline = commitBaseline;
            const sourceRaw = typeof swipeCtx?.baselineRaw === 'string' ? swipeCtx.baselineRaw : commitBaseline.raw;
            const isReroll = !!(swipeCtx?.forceReroll || swipeCtx?.reroll);
            const sourceLines = parseLines(sourceRaw);
            const liveCandidates = sourceLines.filter(line => line.pin || !TERMINAL_LINE_STAGES.has(line.stage));
            const identityLines = isReroll ? liveCandidates.filter(line => line.pin) : liveCandidates;
            const previousRaw = isReroll || liveCandidates.length !== sourceLines.length ? serializeLines(identityLines) : sourceRaw;
            let drawer = env.drawTickets; let capacity = Number(env.vectorCapacity);
            if (!drawer || !capacity) { const vectors = await import('./vectors/draw.js'); if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' }; drawer ||= vectors.drawTickets; capacity ||= vectors.LEGAL_TICKET_CAPACITY; }
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const adultMode = typeof env.adultMode === 'function' ? env.adultMode() : env.adultMode;
            const isInitial = identityLines.length === 0;
            const isDominantPoolRun = adultMode === 'dominant' && (isReroll || isInitial);
            const ticketCount = Math.min(capacity, isDominantPoolRun ? 7 : Math.max(8, sourceLines.filter(line => line.name).length + 2));
            const freshTickets = await drawer(ticketCount, { random: env.random || (() => Math.random()), seed: owner.id, nonce: owner.chatRevision });
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const selectionCount = isDominantPoolRun ? 5 : (adultMode === 'dominant' ? freshTickets.length : (adultMode === 'mixed' ? 1 : 0));
            const adultSelections = drawAdultSelections(adultMode, selectionCount, { random: env.random || (() => Math.random()), seed: owner.id });
            const adultStart = isDominantPoolRun ? 2 : 0;
            const adultTickets = freshTickets.map((ticket, index) => {
                const selection = adultSelections[index - adultStart];
                const pool = isDominantPoolRun ? (index < 2 ? 'sfw' : 'nsfw') : null;
                return Object.freeze({ ...ticket, ticketId: `TICKET-${index + 1}`, ...(pool ? { adultPool: pool } : {}), ...(selection ? { adultSelection: selection } : {}) });
            });
            owner.vectorTickets = adultTickets;
            const vectorContext = { intent: isDominantPoolRun ? (isReroll ? 'reroll' : 'initial') : 'advance', retained: identityLines.filter(line => line.cue), legacyWithoutCue: identityLines.filter(line => !line.cue).map(line => line.name), freshTickets: adultTickets, adultSelections };
            const prompt = env.buildPrompt(previousRaw, travelContext, vectorContext);
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const beforeCall = env.readSaved() || {};
            if (String(beforeCall.raw || '') !== commitBaseline.raw || (Number(beforeCall.ts) || null) !== commitBaseline.ts) return { status: 'cancelled', reason: 'stale-baseline' };
            const raw = await env.callApi(prompt, signal, { ...(travelContext || {}), ...(swipeCtx?.forceReroll || swipeCtx?.reroll ? { reroll: true, module: 'lines' } : {}) });
            if (env.isEditing?.()) return { status: 'cancelled', reason: 'editing' };
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const checked = validateLinesResponse(raw);
            if (!checked.ok) { env.fail?.(makeDiagnosticError('invalid-structure', { phase: 'parse' }), { silent }); return { status: 'failed', reason: checked.reason }; }
            const latest = env.readSaved() || {};
            const latestSnapshot = Object.freeze({ raw: String(latest.raw || ''), ts: Number(latest.ts) || null });
            const decision = decideLinesCommit({ ownerCurrent: owners.isCurrent(owner, { chatId }) && !signal.aborted && !travelAbort?.aborted, validation: checked, baseline: { raw: commitBaseline.raw, ts: commitBaseline.ts }, latest: latestSnapshot });
            if (!decision.ok) return { status: 'cancelled', reason: decision.reason };
            const bound = bindVectorTickets({ previousLines: identityLines, generatedLines: checked.model, freshTickets: adultTickets });
            const merged = mergePinned(previousRaw, serializeLines(bound));
            if (!merged.ok) return { status: 'cancelled', reason: merged.reason };
            const capacityResult = enforceLineCapacity({ previousLines: parseLines(previousRaw), mergedLines: merged.model });
            env.commit(serializeLines(capacityResult.model), { silent, owner, swipeCtx, travelContext, commitBaseline });
            return { status: 'updated', targetDate: travelContext?.targetDate };
        } catch (error) {
            if (error?.name === 'AbortError') return { status: 'cancelled' };
            if (!owners.isCurrent(owner, { chatId })) return { status: 'cancelled', reason: 'stale-owner' };
            if (env.chatId() === chatId) env.fail?.(error, { silent });
            return { status: 'failed', error };
        } finally { travelAbort?.removeEventListener('abort', abortFromTravel); env.runtime?.finish(owner.controller); env.cleanup?.(owner, chatId); }
    };
    return { run };
}
