import { parseLines, serializeLines, validateLinesResponse, TERMINAL_LINE_STAGES } from './schema.js';
import { mergePinned } from './mutations.js';
import { decideLinesCommit } from './generation.js';
import { bindVectorTickets } from './vectors/bind.js';
import { createGenerationDiagnosticScope, makeDiagnosticError, runGenerationUiEffect } from '../../api/diagnostics.js';
import { drawAdultSelections, allocateAdultPools } from './adult.js';
import { AUTO_LINE_CAPACITY, AUTO_LINE_SEED_CAPACITY } from './capacity.js';
import { auditLineEvolution } from './evolution.js';
import { freezeLineStore, lineStoreMatches } from './version-history.js';
import { traceDiagnosticEvent } from '../../runtime/diagnostic-trace.js';
import { LINES_TIME_LIMITS, waitForSignal } from '../../runtime/deadline.js';

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
    const run = async (silent = false, swipeCtx = null, travelContext = null, preflightOwner = null, memoryContext = null, triggerContext = null) => {
        const diagnostic = createGenerationDiagnosticScope('lines', { background: silent });
        if (env.isEditing?.()) return { status: 'cancelled', reason: 'editing' };
        const chatId = triggerContext?.chatId ?? env.chatId();
        const chatRevision = triggerContext?.chatRevision ?? owners.currentChatRevision();
        if (preflightOwner && !owners.isCurrent(preflightOwner, { chatId, chatRevision })) return { status: 'cancelled', reason: 'stale-preflight' };
        const participantIdentity = triggerContext?.participantIdentity || preflightOwner?.participantIdentity || env.participantIdentity?.() || null;
        const contextSnapshot = triggerContext?.contextSnapshot || preflightOwner?.contextSnapshot || env.contextSnapshot?.() || null;
        if (triggerContext?.deadlineAt && Date.now() >= triggerContext.deadlineAt) return { status: 'cancelled', reason: 'expired-trigger' };
        const leases = generationLeases();
        const leaseKey = `${String(chatId ?? '')}::${chatRevision}`;
        if (leases.has(leaseKey)) return { status: 'skipped', reason: 'busy' };
        const leaseToken = Object.freeze({});
        leases.set(leaseKey, leaseToken);
        // Abort must free this chat's lease immediately; the token check keeps a late old finally from clearing a newer run.
        const releaseLease = () => { if (leases.get(leaseKey) === leaseToken) leases.delete(leaseKey); };
        let owner = null;
        let totalTimer = null;
        let preparationTimer = null;
        let parentSignal = null;
        let abortFromPreflight = null;
        let travelAbort = null;
        let abortFromTravel = null;
        let generationCommitted = false;
        let preserveFailureUi = false;
        try {
            owner = owners.create('lines-generation', { chatId, chatRevision, participantIdentity, intent: swipeCtx?.forceReroll || swipeCtx?.reroll ? 'reroll' : (travelContext ? 'time-travel' : 'advance') });
            owner.contextSnapshot = contextSnapshot;
            owner.memoryOperationToken = memoryContext?.memoryOperationToken || preflightOwner?.token || owner.token;
            owner.deadlineAt = preflightOwner?.deadlineAt || triggerContext?.deadlineAt || (Date.now() + (env.timeLimits?.totalMs ?? LINES_TIME_LIMITS.totalMs));
            const preparationDeadlineAt = preflightOwner?.preparationDeadlineAt || triggerContext?.preparationDeadlineAt
                || Math.min(owner.deadlineAt, Date.now() + (env.timeLimits?.preparationMs ?? LINES_TIME_LIMITS.preparationMs));
            parentSignal = preflightOwner?.controller?.signal;
            abortFromPreflight = () => owner.controller.abort(parentSignal?.reason || new DOMException('The operation was aborted.', 'AbortError'));
            if (parentSignal?.aborted) abortFromPreflight();
            else parentSignal?.addEventListener('abort', abortFromPreflight, { once: true });
            totalTimer = preflightOwner ? null : setTimeout(() => owner.controller.abort(Object.assign(new Error('lines-total-timeout'), { name: 'TimeoutError', code: 'operation-timeout' })), Math.max(0, owner.deadlineAt - Date.now()));
            preparationTimer = setTimeout(() => owner.controller.abort(Object.assign(new Error('lines-preparation-timeout'), { name: 'TimeoutError', code: 'operation-timeout' })), Math.max(0, Math.min(preparationDeadlineAt, owner.deadlineAt) - Date.now()));
            const signal = owner.controller.signal;
            signal.addEventListener('abort', releaseLease, { once: true });
            const phaseLabels = {
                materials: '正在准备线素材…',
                'message-assembly': '正在组织请求材料…',
                'world-info': '正在准备世界书…',
                'world-info-books': '正在读取世界书条目…',
                'world-info-activation': '正在激活世界书…',
                memory: '正在读取记忆…',
                model: '正在等待模型…',
                'save-queue': '正在等待保存队列…',
                'save-patch': '正在准备保存内容…',
                'save-fetch': '正在保存线…',
                'save-receipt': '正在确认保存结果…',
            };
            const reportPhase = phase => {
                if (signal.aborted || !owners.isCurrent(owner)) return;
                const safePhase = String(phase || 'unknown').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'unknown';
                // The API client reports this only after buildMessages (including world info and memory) has settled.
                if (safePhase === 'model' && preparationTimer !== null) { clearTimeout(preparationTimer); preparationTimer = null; }
                traceDiagnosticEvent('lines-generation-stage', { module: 'lines', channel: 'lines', status: 'preparing', phase: safePhase, chatRevision });
                env.onPhase?.(owner, safePhase, phaseLabels[safePhase] || '正在准备请求…');
            };
            env.runtime?.start(owner.controller, phaseLabels.materials); env.onStart?.(owner);
            reportPhase('materials');
            travelAbort = travelContext?.signal;
            abortFromTravel = () => owner.controller.abort('time-travel-cancel');
            travelAbort?.addEventListener('abort', abortFromTravel, { once: true });
            if (signal.aborted || travelAbort?.aborted) return { status: 'cancelled', reason: 'aborted' };
            const cfg = env.loadConfig();
            if (!cfg?.url || !cfg?.key) { env.missingApi?.({ silent }); throw makeDiagnosticError('config-missing'); }
            const savedSnapshot = env.readSaved() || {};
            const baselineStore = freezeLineStore(savedSnapshot);
            const commitBaseline = Object.freeze({ chatId, key: env.cacheKey?.() ?? null, raw: String(savedSnapshot.raw || ''), ts: Number(savedSnapshot.ts) || null, cursor: savedSnapshot.cursor ?? 0, html: savedSnapshot.html ?? null, store: baselineStore });
            owner.baseline = commitBaseline;
            const sourceRaw = typeof swipeCtx?.baselineRaw === 'string' ? swipeCtx.baselineRaw : commitBaseline.raw;
            const isReroll = !!(swipeCtx?.forceReroll || swipeCtx?.reroll);
            const sourceLines = parseLines(sourceRaw);
            const liveCandidates = sourceLines.filter(line => line.pin || !TERMINAL_LINE_STAGES.has(line.stage));
            const identityLines = isReroll ? liveCandidates.filter(line => line.pin) : liveCandidates;
            const promptLines = isReroll ? [] : identityLines.filter(line => !line.pin);
            const previousRaw = isReroll || promptLines.length !== sourceLines.length ? serializeLines(promptLines) : sourceRaw;
            const promptRaw = isReroll ? '' : previousRaw;
            let drawer = env.drawTickets; let capacity = Number(env.vectorCapacity);
            if (!drawer || !capacity) { const vectors = await import('./vectors/draw.js'); if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner)) return { status: 'cancelled', reason: 'stale-owner' }; drawer ||= vectors.drawTickets; capacity ||= vectors.LEGAL_TICKET_CAPACITY; }
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner)) return { status: 'cancelled', reason: 'stale-owner' };
            const adultMode = typeof env.adultMode === 'function' ? env.adultMode(participantIdentity) : env.adultMode;
            const isInitial = sourceLines.length === 0;
            const intent = isReroll ? 'reroll' : isInitial ? 'initial' : 'advance';
            const ticketCount = Math.min(capacity, AUTO_LINE_SEED_CAPACITY);
            const freshTickets = await waitForSignal(drawer(ticketCount, { random: env.random || (() => Math.random()), seed: owner.id, nonce: owner.chatRevision }), signal);
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner)) return { status: 'cancelled', reason: 'stale-owner' };
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
            const vectorContext = { intent, retained: isReroll ? [] : promptLines.filter(line => line.cue), legacyWithoutCue: isReroll ? [] : promptLines.filter(line => !line.cue).map(line => line.name), rerollNames: isReroll ? [...new Set(sourceLines.filter(line => !line.pin).map(line => line.name.trim()).filter(Boolean))] : [], pinnedBackground: sourceLines.filter(line => line.pin), freshTickets: adultTickets, adultSelections };
            const prompt = env.buildPrompt(promptRaw, travelContext, vectorContext, participantIdentity, contextSnapshot);
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner)) return { status: 'cancelled', reason: 'stale-owner' };
            reportPhase('message-assembly');
            const beforeCall = env.readSaved() || {};
            if (!lineStoreMatches(beforeCall, commitBaseline.store)) return { status: 'cancelled', reason: 'stale-baseline' };
            const raw = await waitForSignal(env.callApi(prompt, signal, {
                ...(travelContext || {}),
                ...(swipeCtx?.forceReroll || swipeCtx?.reroll ? { reroll: true, module: 'lines' } : {}),
                promptMode: 'creative',
                diagnosticModule: 'lines',
                diagnosticSink: diagnostic.sink,
                diagnosticContext: { owner: owner.token, channel: owner.channel, chatRevision, floor: swipeCtx?.mesId },
                onGenerationPhase: reportPhase,
                memoryOperationToken: owner.memoryOperationToken,
                ...(memoryContext?.memorySnapshot ? { memorySnapshot: memoryContext.memorySnapshot, memoryOperationToken: memoryContext.memoryOperationToken } : {}),
            }, participantIdentity, contextSnapshot), signal);
            if (env.isEditing?.()) return { status: 'cancelled', reason: 'editing' };
            if (signal.aborted || travelAbort?.aborted || !owners.isCurrent(owner)) return { status: 'cancelled', reason: 'stale-owner' };
            const checked = validateLinesResponse(raw, { maxCandidates: AUTO_LINE_CAPACITY });
            if (!checked.ok) {
                const parseRejected = ['empty', 'incomplete-or-extraneous', 'text-outside-line', 'no-lines'].includes(checked.reason);
                const code = parseRejected ? 'parse' : checked.reason === 'invalid-field' ? 'invalid-fields' : 'invalid-structure';
                const error = diagnostic.rejected(makeDiagnosticError(code, { phase: parseRejected ? 'parse' : 'validation' }), { phase: parseRejected ? 'parse' : 'validation', reasonCode: checked.reason });
                env.fail?.(error, { silent, owner, reasonCode: checked.reason }); return { status: 'failed', reason: checked.reason };
            }
            const audit = auditLineEvolution({ previousLines: identityLines, generatedLines: checked.model, freshTickets: adultTickets, intent });
            if (!audit.ok) { const error = diagnostic.rejected(makeDiagnosticError('invalid-fields', { phase: 'validation' }), { phase: 'validation', reasonCode: audit.reason }); env.fail?.(error, { silent, owner, reasonCode: audit.reason }); return { status: 'failed', reason: audit.reason }; }
            const latest = env.readSaved() || {};
            const latestSnapshot = Object.freeze({ raw: String(latest.raw || ''), ts: Number(latest.ts) || null });
            if (!lineStoreMatches(latest, commitBaseline.store)) return { status: 'cancelled', reason: 'stale-baseline' };
            const decision = decideLinesCommit({ ownerCurrent: owners.isCurrent(owner) && !signal.aborted && !travelAbort?.aborted, validation: checked, baseline: { raw: commitBaseline.raw, ts: commitBaseline.ts }, latest: latestSnapshot });
            if (!decision.ok) return { status: 'cancelled', reason: decision.reason };
            const bound = bindVectorTickets({ previousLines: identityLines, generatedLines: checked.model, freshTickets: adultTickets });
            const merged = mergePinned(sourceRaw, serializeLines(bound), { preferPinnedSource: true });
            if (!merged.ok) return { status: 'cancelled', reason: merged.reason };
            const resultModel = merged.model;
            diagnostic.accepted({ phase: 'validation', reasonCode: 'lines-valid' });
            let commitResult;
            reportPhase('save-queue');
            owner.reportPhase = reportPhase;
            try { commitResult = await env.commit(serializeLines(resultModel), { silent, owner, swipeCtx, travelContext, commitBaseline }); }
            catch (cause) {
                if (cause?.diagnosticCode === 'save') throw cause;
                const status = Number(cause?.saveResult?.status ?? cause?.status);
                const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) });
                if (cause?.saveResult) error.saveResult = cause.saveResult;
                throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'lines-commit-failed' });
            }
            if (commitResult === false || commitResult?.ok === false) { const status = Number(commitResult?.status); const error = makeDiagnosticError('save', { phase: 'save', ...(Number.isInteger(status) ? { status } : {}) }); if (commitResult && typeof commitResult === 'object') error.saveResult = commitResult; throw diagnostic.rejected(error, { phase: 'save', reasonCode: 'lines-commit-rejected' }); }
            if (commitResult?.commitState === 'local-applied') diagnostic.locallyApplied({ reasonCode: 'lines-local-applied' });
            else diagnostic.committed({ reasonCode: commitResult?.stale ? 'lines-saved-stale' : 'lines-saved' });
            generationCommitted = true;
            if (commitResult?.uiApplied) diagnostic.uiDisplayed({ reasonCode: 'lines-ui-applied' });
            if (commitResult?.uiError) diagnostic.uiFailed(commitResult.uiError, { reasonCode: 'lines-ui-refresh-failed' });
            if (commitResult?.stale) return { status: 'cancelled', reason: 'committed-but-stale', committed: true, targetDate: travelContext?.targetDate };
            return { status: 'updated', targetDate: travelContext?.targetDate };
        } catch (error) {
            if (error?.name === 'AbortError') return { status: 'cancelled' };
            diagnostic.rejected(error, { phase: error?.phase || 'prepare', reasonCode: error?.phase || error?.diagnosticCode || 'lines-generation-failed' });
            const operationTimedOut = error?.name === 'TimeoutError' || error?.code === 'operation-timeout';
            const stillOwnsAbortedTimeout = operationTimedOut && owners.isOwner(owner, { chatId, chatRevision });
            if (owner && !owners.isCurrent(owner) && !stillOwnsAbortedTimeout) return { status: 'cancelled', reason: 'stale-owner' };
            if (error?.diagnosticCode === 'memory-stale') { preserveFailureUi = true; env.memoryFailure?.(error); return { status: 'failed', error }; }
            env.fail?.(error, { silent, owner, reasonCode: error?.reasonCode || error?.diagnosticCode || 'generation-failed' });
            return { status: 'failed', error };
        } finally {
            const cleanup = () => {
                if (totalTimer !== null) clearTimeout(totalTimer);
                if (preparationTimer !== null) clearTimeout(preparationTimer);
                parentSignal?.removeEventListener?.('abort', abortFromPreflight);
                if (abortFromTravel) travelAbort?.removeEventListener('abort', abortFromTravel);
                if (owner) { env.runtime?.finish(owner.controller); env.cleanup?.(owner, chatId, { preserveFailureUi }); }
            };
            try {
                if (generationCommitted) await runGenerationUiEffect(cleanup, { diagnostic, reasonCode: 'lines-cleanup-failed', reportDisplayed: false });
                else cleanup();
            } finally {
                owner?.controller?.signal?.removeEventListener('abort', releaseLease);
                if (leases.get(leaseKey) === leaseToken) leases.delete(leaseKey);
            }
        }
    };
    return { run };
}
