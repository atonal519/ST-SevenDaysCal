// 点异步任务的纯逻辑生命周期判定。宿主只负责执行判定结果，不在各分支重复拼接竞态条件。
export function evaluateTaskLifecycle({ manager, owner, chatId, chatRevision, signal = null, pluginEnabled = true, allowPendingFollowup = true, pending = null, phase = 'task' } = {}) {
    const identity = { chatId, chatRevision };
    const ownerCurrent = !!manager?.isCurrent(owner, identity);
    const ownerOwned = !!manager?.isOwner(owner, identity);
    const externallyAborted = !!signal?.aborted;
    const ownerAborted = !!owner?.controller?.signal?.aborted;
    const canCommit = !!(pluginEnabled && ownerCurrent && !externallyAborted && !ownerAborted);
    const canCleanup = !!(ownerOwned && owner?.channel);
    const canFollowup = !!(pluginEnabled && canCommit && allowPendingFollowup && pending && pending.owner === owner && pending.chatId === (chatId ?? owner?.chatId) && pending.chatRevision === (chatRevision ?? owner?.chatRevision));
    const canCallback = !!(pluginEnabled && manager?.isValid(owner, identity));
    return { canCommit, canCleanup, canFollowup, canCallback: phase === 'callback' ? canCallback : false, pendingTargetDate: canFollowup ? pending.targetDate : undefined };
}
