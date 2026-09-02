import { parseLines, serializeLines, validateLinesResponse, TERMINAL_LINE_STAGES } from './schema.js';
import { mergePinned } from './mutations.js';
import { decideLinesCommit } from './generation.js';
import { bindVectorTickets } from './vectors/bind.js';
import { createGenerationDiagnosticScope, makeDiagnosticError, runGenerationUiEffect } from '../../api/diagnostics.js';
import { drawAdultSelections, allocateAdultPools } from './adult.js';
import { enforceLineCapacity, AUTO_LINE_CAPACITY, AUTO_LINE_SEED_CAPACITY } from './capacity.js';
import { auditLineEvolution } from './evolution.js';

const LINES_GENERATION_LEASES = Symbol.for('st-seven-days-cal.lines-generation-leases');

function generationLeases() {
    const current = globalThis[LINES_GENERATION_LEASES];
    if (current instanceof Map) return current;
    const leases = new Map();
    globalThis[LINES_GENERATION_LEASES] = leases;
    return leases;
}

export function createLinesGenerationController(env = {}) {
    const owners = env.owners;
    const participantCurrent = identity => !identity || env.sameParticipantIdentity?.(identity, env.participantIdentity?.()) !== false;
    const run = async (silent = false, swipeCtx = null, travelContext = null, preflightOwner = null) => {
        const diagnostic = createGenerationDiagnosticScope('lines', { background: silent });
        if (env.isEditing?.()) return { status: 'cancelled', reason: 'editing' };
        const chatId = env.chatId();
        const chatRevision = owners.currentChatRevision();
        if (preflightOwner && !owners.isCurrent(preflightOwner, { chatId, chatRevision })) return { status: 'cancelled', reason: 'stale-preflight' };
        const participantIdentity = preflightOwner?.participantIdentity || env.participantIdentity?.() || null;
        const contextSnapshot = preflightOwner?.contextSnapshot || env.contextSnapshot?.() || null;
        if (!participantCurrent(participantIdentity)) return { status: 'cancelled', reason: 'stale-participant' };
        const leases = generationLeases();
        const leaseKey = `${String(chatId ?? '')}::${chatRevision}`;
        if (leases.has(leaseKey)) return { status: 'skipped', reason: 'busy' };
        const leaseToken = Object.freeze({});
        leases.set(leaseKey, leaseToken);
        let owner = null;
        let travelAbort = null;
        let abortFromTravel = null;
        let generationCommitted = false;
        try {
            owner = owners.create('lines-generation', { chatId, chatRevision, participantIdentity, intent: swipeCtx?.forceReroll || swipeCtx?.reroll ? 'reroll' : (travelContext ? 'time-travel' : 'advance') });
            owner.contextSnapshot = contextSnapshot;
            env.runtime?.start(owner.controller); env.onStart?.(owner);
            const signal = owner.controller.signal;
            travelAbort = travelContext?.signal;
            abortFromTravel = () => owner.controller.abort('time-travel-cancel');
            travelAbort?.addEventListener('abort', abortFromTravel, { once: true });
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
            const promptRaw = isReroll ? '' : previousRaw;
            let drawer = env.drawTickets; let capacity = Number(env.vectorCapacity);
            if (!drawer || !capacity) { const vectors = await import('./vectors/draw.js'); if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' }; drawer ||= vectors.drawTickets; capacity ||= vectors.LEGAL_TICKET_CAPACITY; }
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const adultMode = typeof env.adultMode === 'function' ? env.adultMode(participantIdentity) : env.adultMode;
            const isInitial = sourceLines.length === 0;
            const intent = isReroll ? 'reroll' : isInitial ? 'initial' : 'advance';
            const ticketCount = Math.min(capacity, AUTO_LINE_SEED_CAPACITY);
            const freshTickets = await drawer(ticketCount, { random: env.random || (() => Math.random()), seed: owner.id, nonce: owner.chatRevision });
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId }) || env.chatId() !== chatId) return { status: 'cancelled', reason: 'stale-owner' };
            const activeLines = sourceLines.filter(line => line.name && !line.pin && !TERMINAL_LINE_STAGES.has(line.stage));
            const allocatorBase = isReroll ? { activeCount: 0, activeAdultCount: 0 } : { activeCount: activeLines.length, activeAdultCount: activeLines.filter(line => line.adult).length };
            const pools = adultMode === 'off' ? null : allocateAdultPools(adultMode, freshTickets.length, allocatorBase);
            const selectionCount = pools ? pools.filter(pool => pool === 'nsfw').length : 0;
            const adultSelections = drawAdultSelections(adultMode, selectionCount, { random: env.random || (() => Math.random()), seed: owner.id });
            let selectionIndex = 0;
            const adultTickets = freshTickets.map((ticket, index) => {
                const pool = pools?.[index] || null;
                const selection = pool === 'nsfw' ? adultSelections[selectionIndex++] : null;
                return Object.freeze({ ...ticket, ticketId: `TICKET-${index + 1}`, ...(pool ? { adultPool: pool } : {}), ...(selection ? { adultSelection: selection } : {}) });
            });
            owner.vectorTickets = adultTickets;
            const vectorContext = { intent, retained: isReroll ? [] : identityLines.filter(line => line.cue), legacyWithoutCue: isReroll ? [] : identityLines.filter(line => !line.cue).map(line => line.name), pinnedBackground: isReroll ? identityLines.filter(line => line.pin) : [], freshTickets: adultTickets, adultSelections };
            const prompt = env.buildPrompt(promptRaw, travelContext, vectorContext, participantIdentity, contextSnapshot);
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId, chatRevision }) || env.chatId() !== chatId || !participantCurrent(participantIdentity)) return { status: 'cancelled', reason: 'stale-owner' };
            const beforeCall = env.readSaved() || {};
            if (String(beforeCall.raw || '') !== commitBaseline.raw || (Number(beforeCall.ts) || null) !== commitBaseline.ts) return { status: 'cancelled', reason: 'stale-baseline' };
            const raw = await env.callApi(prompt, signal, {
                ...(travelContext || {}),
                ...(swipeCtx?.forceReroll || swipeCtx?.reroll ? { reroll: true, module: 'lines' } : {}),
                promptMode: 'creative',
                diagnosticModule: 'lines',
                diagnosticSink: diagnostic.sink,
                diagnosticContext: { owner: owner.token, channel: owner.channel, chatRevision, floor: swipeCtx?.mesId },
            }, participantIdentity, contextSnapshot);
            if (env.isEditing?.()) return { status: 'cancelled', reason: 'editing' };
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner, { chatId, chatRevision }) || env.chatId() !== chatId || !participantCurrent(participantIdentity)) return { status: 'cancelled', reason: 'stale-owner' };
            const checked = validateLinesResponse(raw);
            if (!checked.ok) {
                const parseRejected = ['empty', 'incomplete-or-extraneous', 'text-outside-line', 'no-lines'].includes(checked.reason);
                const code = parseRejected ? 'parse' : checked.reason === 'invalid-field' ? 'invalid-fields' : 'invalid-structure';
                const error = diagnostic.rejected(makeDiagnosticError(code, { phase: parseRejected ? 'parse' : 'validation' }), { phase: parseRejected ? 'parse' : 'validation', reasonCode: checked.reason });
                env.fail?.(error, { silent }); return { status: 'failed', reason: checked.reason };
            }
            const audit = auditLineEvolution({ previousLines: identityLines, generatedLines: checked.model, freshTickets: adultTickets, intent });
            if (!audit.ok) { const error = diagnostic.rejected(makeDiagnosticError('invalid-fields', { phase: 'validation' }), { phase: 'validation', reasonCode: audit.reason }); env.fail?.(error, { silent }); return { status: 'failed', reason: audit.reason }; }
            const latest = env.readSaved() || {};
            const latestSnapshot = Object.freeze({ raw: String(latest.raw || ''), ts: Number(latest.ts) || null });
            const decision = decideLinesCommit({ ownerCurrent: owners.isCurrent(owner, { chatId, chatRevision }) && participantCurrent(participantIdentity) && !signal.aborted && !travelAbort?.aborted, validation: checked, baseline: { raw: commitBaseline.raw, ts: commitBaseline.ts }, latest: latestSnapshot });
            if (!decision.ok) return { status: 'cancelled', reason: decision.reason };
            const bound = bindVectorTickets({ previousLines: identityLines, generatedLines: checked.model, freshTickets: adultTickets });
            const merged = mergePinned(isReroll ? sourceRaw : previousRaw, serializeLines(bound), { preferPinnedSource: isReroll });
            if (!merged.ok) return { status: 'cancelled', reason: merged.reason };
            const capacityResult = enforceLineCapacity({ previousLines: parseLines(previousRaw), mergedLines: merged.model, max: AUTO_LINE_CAPACITY });
            if (capacityResult.dropped > 0) {
                const error = diagnostic.rejected(makeDiagnosticError('invalid-structure', { phase: 'validation' }), { phase: 'validation', reasonCode: 'evolution-auto-capacity-overflow' });
                env.fail?.(error, { silent }); return { status: 'failed', reason: 'evolution-auto-capacity-overflow' };
            }
            const resultModel = capacityResult.model;
            diagnostic.accepted({ phase: 'validation', reasonCode: 'lines-valid' });
            let commitResult;
            try { commitResult = await env.commit(serializeLines(resultModel), { silent, owner, swipeCtx, travelContext, commitBaseline }); }
            catch (cause) {
                if (cause?.diagnosticCode === 'save') throw cause;
                const status = Number(cause?.saveResult?.status ?? cause?.status);
                const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) });
                if (cause?.saveResult) error.saveResult = cause.saveResult;
                throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'lines-commit-failed' });
            }
            if (commitResult === false || commitResult?.ok === false) { const status = Number(commitResult?.status); const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) }); if (commitResult && typeof commitResult === 'object') error.saveResult = commitResult; throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'lines-commit-rejected' }); }
            diagnostic.committed({ reasonCode: commitResult?.stale ? 'lines-saved-stale' : 'lines-saved' });
            generationCommitted = true;
            if (commitResult?.uiError) diagnostic.uiFailed(commitResult.uiError, { reasonCode: 'lines-ui-refresh-failed' });
            if (commitResult?.stale) return { status: 'cancelled', reason: 'committed-but-stale', committed: true, targetDate: travelContext?.targetDate };
            return { status: 'updated', targetDate: travelContext?.targetDate };
        } catch (error) {
            if (error?.name === 'AbortError') return { status: 'cancelled' };
            if (owner && (!owners.isCurrent(owner, { chatId, chatRevision }) || !participantCurrent(participantIdentity))) return { status: 'cancelled', reason: 'stale-owner' };
            if (env.chatId() === chatId && participantCurrent(participantIdentity)) env.fail?.(error, { silent });
            return { status: 'failed', error };
        } finally {
            const cleanup = () => {
                if (abortFromTravel) travelAbort?.removeEventListener('abort', abortFromTravel);
                if (owner) { env.runtime?.finish(owner.controller); env.cleanup?.(owner, chatId); }
            };
            try {
                if (generationCommitted) await runGenerationUiEffect(cleanup, { diagnostic, reasonCode: 'lines-cleanup-failed' });
                else cleanup();
            } finally {
                if (leases.get(leaseKey) === leaseToken) leases.delete(leaseKey);
            }
        }
    };
    return { run };
}
