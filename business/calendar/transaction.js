// 单聊天迁移事务：stage/verify 后只通过 target metadata saver dispatch 一次。
// 不调用 snapshot.flush/saveMetadata/saveChat；消息、swipe 与其它 metadata 保留。
export async function runCalendarMigrationTransaction({ chatId, revision, plan, storeAdapter, ledgerAdapter, snapshotAdapter, metadataSaver = null, target = null, nextMetadata = null, owner = null, isCurrent = () => true, busyGate = null, whenIdle = null, input } = {}) {
    const txId = `cal-migration-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const diagnostic = { txId, phase: 'start', chatId, chatRevision: revision, durability: 'not-dispatched', rollback: null };
    const staged = [];
    const rollback = () => {
        for (const [, adapter, token] of staged.slice().reverse()) {
            try { const result = adapter?.restore?.(token); if (result && result.ok === false) diagnostic.rollback = 'failed'; }
            catch { diagnostic.rollback = 'failed'; }
        }
        if (!diagnostic.rollback) diagnostic.rollback = staged.length ? 'completed' : 'not-needed';
    };
    try {
        if (busyGate?.isBusy?.() || busyGate?.enter?.(chatId, revision) === false) throw new Error('migration-busy');
        diagnostic.phase = 'plan';
        const planned = plan(input);
        if (!planned?.ok) return { ok: false, diagnostic: { ...diagnostic, cause: 'plan-failed' } };
        diagnostic.phase = 'stage-ledger';
        const ledgerToken = ledgerAdapter?.stage?.(planned.nextLedgerState, { expectedChatId: chatId, expectedRevision: revision, txId }); if (ledgerAdapter?.stage && !ledgerToken) throw new Error('ledger-stage-failed'); if (ledgerToken) staged.push(['ledger', ledgerAdapter, ledgerToken]);
        diagnostic.phase = 'stage-store';
        const storeToken = storeAdapter?.stage?.(planned.nextStoreEntries, { expectedChatId: chatId, expectedRevision: revision, txId }); if (storeAdapter?.stage && !storeToken) throw new Error('store-stage-failed'); if (storeToken) staged.push(['store', storeAdapter, storeToken]);
        diagnostic.phase = 'verify';
        if (staged.some(([, adapter, token]) => adapter.verify && !adapter.verify(token))) throw new Error('verify-failed');
        if (input?.revision !== undefined && input.revision !== revision) throw new Error('stale-revision');
        diagnostic.phase = 'dispatch';
        if (whenIdle) await whenIdle();
        if (!isCurrent(owner, { chatId, chatRevision: revision })) throw new Error('stale-before-dispatch');
        if (!metadataSaver?.capture || !metadataSaver?.dispatch) throw new Error('metadata-saver-unavailable');
        const captured = metadataSaver.capture(target, nextMetadata ?? { ...(input?.metadata || {}), 'sp-store': planned.nextStoreEntries, 'sp-ledger': planned.nextLedgerState });
        if (!captured) throw new Error('metadata-capture-failed');
        const dispatched = await metadataSaver.dispatch(captured, { isCurrent: () => isCurrent(owner, { chatId, chatRevision: revision }) });
        diagnostic.dispatch = dispatched?.commitState || 'not-dispatched';
        if (!dispatched?.ok) {
            diagnostic.durability = dispatched?.commitState === 'unknown' ? 'unknown' : 'not-dispatched';
            if (dispatched?.commitState === 'unknown') {
                // 请求可能已落盘；禁止把本地 staged 状态当成失败提交回滚。
                return { ok: false, plan: planned, diagnostic, dispatch: dispatched };
            }
            throw new Error(dispatched?.reason || 'metadata-dispatch-failed');
        }
        diagnostic.durability = 'metadata-patch';
        return { ok: true, plan: planned, diagnostic, dispatch: dispatched };
    } catch (error) {
        diagnostic.cause = error.message;
        rollback();
        return { ok: false, diagnostic, error };
    } finally {
        busyGate?.leave?.(chatId, revision, txId);
    }
}
