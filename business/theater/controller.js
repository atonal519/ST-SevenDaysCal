export function createTheaterController({ owners, repository, generate, current, chatId, chatRevision, names, storyContext, stage, commit, error, reset } = {}) {
    let active = null;
    const valid = owner => owners.isValid(owner, { chatId: chatId(), chatRevision: chatRevision() }) && !owner.controller.signal.aborted;
    const cancellationReason = owner => owner?.cancelReason === 'aborted' ? 'aborted' : 'stale';
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
        active = owner;
        try {
            owner.storyContext = await storyContext?.(owner);
            if (!valid(owner)) return { status: 'cancelled', reason: cancellationReason(owner) };
            const piece = await generate(owner.input, { ...options, signal: owner.controller.signal, userName: owner.userName, charName: owner.charName, storyContext: owner.storyContext, onStage: text => { if (valid(owner)) stage?.(text, owner); } });
            if (!valid(owner)) return { status: 'cancelled', reason: cancellationReason(owner) };
            const saved = await repository.pushDraft(owner.chatId, piece);
            if (!saved?.ok) return { status: 'failed', reason: 'draft-save', error: saved?.error || new Error('draft-save-failed') };
            commit?.(piece, owner); current?.(piece, owner); return { status: 'updated', piece };
        } catch (err) {
            // 请求可能不遵守 AbortSignal，并在 owner 已换代后抛普通 Error；先验身份，绝不能把 A 的迟到错误反馈到 B。
            if (!valid(owner)) return { status: 'cancelled', reason: cancellationReason(owner) };
            if (err?.name === 'AbortError') return { status: 'cancelled', reason: 'aborted' };
            error?.(err, owner);
            return { status: 'failed', error: err };
        }
        finally { if (active === owner) active = null; owners.finish(owner); }
    }
    return { run, abort: (reason = 'aborted') => { if (!active) return false; const owner = active; owner.cancelReason = reason === 'aborted' ? 'aborted' : 'stale'; owners.invalidate('theater'); reset?.(owner, owner.cancelReason); active = null; return true; }, get owner() { return active; }, get busy() { return !!active; } };
}
