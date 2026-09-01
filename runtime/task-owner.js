// 纯逻辑任务 owner：不依赖宿主 UI、jQuery 或网络。
// token/revision 均由本模块单调递增，避免同毫秒任务或聊天切换发生碰撞。
export function createTaskOwnerManager() {
    let nextToken = 0;
    let chatRevision = 0;
    const channels = new Map();
    const latest = new Map();
    const pending = new Map();

    const nextChatRevision = () => ++chatRevision;
    const currentChatRevision = () => chatRevision;

    function create(channel, identity = {}) {
        const previous = channels.get(channel);
        if (previous) { previous.controller.abort('superseded-owner'); previous.status = 'invalidated'; }
        const previousFinished = latest.get(channel);
        if (previousFinished) previousFinished.status = 'invalidated';
        const owner = {
            token: ++nextToken,
            channel,
            chatId: identity.chatId ?? null,
            chatRevision: identity.chatRevision ?? chatRevision,
            view: identity.view ?? null,
            charName: identity.charName ?? null,
            scheduleRevision: identity.scheduleRevision,
            targetDate: identity.targetDate,
            intent: identity.intent ?? null,
            boundaryEpoch: identity.boundaryEpoch,
            participantIdentity: identity.participantIdentity ?? null,
            baselineRaw: identity.baselineRaw ?? '',
            baselineTs: identity.baselineTs ?? null,
            controller: new AbortController(),
            status: 'active',
        };
        channels.set(channel, owner);
        latest.set(channel, owner);
        pending.delete(channel);
        return owner;
    }

    function isOwner(owner, identity = {}) {
        if (!owner || channels.get(owner.channel) !== owner) return false;
        if (identity.chatId !== undefined && owner.chatId !== identity.chatId) return false;
        if (identity.chatRevision !== undefined && owner.chatRevision !== identity.chatRevision) return false;
        return true;
    }

    function isCurrent(owner, identity = {}) {
        return isOwner(owner, identity) && owner.status === 'active' && !owner.controller.signal.aborted;
    }

    function isValid(owner, identity = {}) {
        if (!owner || latest.get(owner.channel) !== owner || owner.status === 'invalidated' || owner.controller.signal.aborted) return false;
        if (owner.chatRevision !== chatRevision) return false;
        if (identity.chatId !== undefined && owner.chatId !== identity.chatId) return false;
        if (identity.chatRevision !== undefined && owner.chatRevision !== identity.chatRevision) return false;
        return true;
    }

    function invalidate(channel, reason = 'manual-abort') {
        const owner = channels.get(channel);
        owner?.controller.abort(reason);
        if (owner) owner.status = 'invalidated';
        if (owner && latest.get(channel) === owner) latest.delete(channel);
        if (owner) channels.delete(channel);
        pending.delete(channel);
        return owner || null;
    }

    function invalidateAll(reason = 'manual-abort') {
        for (const channel of channels.keys()) invalidate(channel, reason);
    }

    function finish(owner) {
        if (!isOwner(owner)) return false;
        owner.status = 'finished';
        channels.delete(owner.channel);
        return true;
    }

    function setPending(channel, identity = {}) {
        const owner = channels.get(channel);
        if (!isCurrent(owner, identity)) return false;
        pending.set(channel, {
            owner,
            chatId: identity.chatId ?? owner.chatId,
            chatRevision: identity.chatRevision ?? owner.chatRevision,
            targetDate: identity.targetDate,
            targetScope: identity.targetScope,
            auto: identity.auto === true,
        });
        return true;
    }

    function consumePending(owner) {
        const item = pending.get(owner?.channel);
        if (!item || item.owner !== owner || !isOwner(owner, { chatId: item.chatId, chatRevision: item.chatRevision })) return null;
        pending.delete(owner.channel);
        return item;
    }

    function peekPending(owner) {
        const item = pending.get(owner?.channel);
        return item?.owner === owner ? item : null;
    }

    function discardPending(owner) {
        const item = pending.get(owner?.channel);
        if (!item || item.owner !== owner) return false;
        pending.delete(owner.channel);
        return true;
    }

    return {
        create,
        isOwner,
        isCurrent,
        isValid,
        invalidate,
        invalidateAll,
        finish,
        setPending,
        consumePending,
        peekPending,
        discardPending,
        nextChatRevision,
        currentChatRevision,
    };
}
