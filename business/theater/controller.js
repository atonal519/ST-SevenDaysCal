import { createGenerationDiagnosticScope, makeDiagnosticError } from '../../api/diagnostics.js';

export function createTheaterController({ owners, repository, generate, current, chatId, chatRevision, names, settings, storyContext, stage, commit, error, reset } = {}) {
    let active = null;
    const valid = owner => owners.isValid(owner, { chatId: chatId(), chatRevision: chatRevision() }) && !owner.controller.signal.aborted;
    const cancellationReason = owner => owner?.cancelReason === 'user-abort' ? 'aborted' : (owner?.cancelReason || 'stale');
    async function run(input, options = {}) {
        if (active) return { status: 'skipped' };
        // Freeze the host names exactly once. Story loading and both API stages may
        // outlive a chat switch, so no later context snapshot may replace them.
        const frozenNames = names?.() || {};
        const owner = owners.create('theater', { chatId: chatId(), chatRevision: chatRevision(), userName: frozenNames.userName || '用户', charName: frozenNames.charName || '角色', input: String(input || ''), templateSource: options.templateSource || null });
        owner.input = String(input || '');
        owner.userName = frozenNames.userName || '用户';
        owner.charName = frozenNames.charName || '角色';
        owner.templateSource = options.templateSource || null;
        owner.settings = settings?.();
        const diagnostic = createGenerationDiagnosticScope('theater-generation');
        active = owner;
        try {
            owner.storyContext = await storyContext?.(owner);
            if (!valid(owner)) return { status: 'cancelled', reason: cancellationReason(owner) };
            const piece = await generate(owner.input, { ...options, signal: owner.controller.signal, userName: owner.userName, charName: owner.charName, storyContext: owner.storyContext, settings: owner.settings, diagnosticScope: diagnostic, isCurrent: () => valid(owner), onStage: text => { if (valid(owner)) stage?.(text, owner); } });
            if (!valid(owner)) return { status: 'cancelled', reason: cancellationReason(owner) };
            const saved = await repository.pushDraft(owner.chatId, piece);
            if (!saved?.ok) { const saveError = diagnostic.rejected(makeDiagnosticError('save', { phase: 'save' }), { phase: 'save', reasonCode: 'theater-draft-save-failed' }); error?.(saveError, owner); return { status: 'failed', reason: 'draft-save', error: saveError }; }
            diagnostic.committed({ reasonCode: 'theater-draft-saved' }); commit?.(piece, owner); current?.(piece, owner); return { status: 'updated', piece };
        } catch (err) {
            // 请求可能不遵守 AbortSignal，并在 owner 已换代后抛普通 Error；先验身份，绝不能把 A 的迟到错误反馈到 B。
            if (!valid(owner)) return { status: 'cancelled', reason: cancellationReason(owner) };
            if (err?.name === 'AbortError') return { status: 'cancelled', reason: 'aborted' };
            error?.(err, owner);
            return { status: 'failed', error: err };
        }
        finally { if (active === owner) active = null; owners.finish(owner); }
    }
    return { run, abort: (reason = 'user-abort') => { if (!active) return false; const owner = active; owner.cancelReason = reason === 'aborted' ? 'user-abort' : reason; owners.invalidate('theater', owner.cancelReason); reset?.(owner, owner.cancelReason); active = null; return true; }, get owner() { return active; }, get busy() { return !!active; } };
}
