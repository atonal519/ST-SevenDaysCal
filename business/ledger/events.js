export function formatLedgerJudgeFeedback(result) {
    const r = result || { status: 'failed', reason: 'unknown' };
    const s = r.reconcile?.summary || {};
    const suffix = s.cleaned || s.remapped || s.lockedMissing ? `；校对：清理${s.cleaned || 0}、重映射${s.remapped || 0}、保留锁定缺失${s.lockedMissing || 0}` : '';
    const text = {
        busy: '已有刻度更新正在进行，请稍候',
        skipped: r.reason === 'no-character' ? '当前没有角色卡，无法判定' : r.reason === 'no-entry' ? '暂无可判定的活跃事件' : r.reason === 'spDisabled' ? '刻度功能已停用' : '刻度更新已跳过',
        failed: r.reason === 'no-api' ? '请先在设置中填写 API' : ['reconcile-failed', 'source-scan-failed', 'source-state-invalid', 'source-save-failed'].includes(r.reason) ? '来源校对失败，未发起 API 请求' : r.reason === 'rollback-save-failed' ? '原存档恢复保存失败，持久状态暂无法确认' : r.reason === 'judge-save-failed' ? '刻度保存失败，本轮未写入更新' : '刻度判定失败，请检查 API 或网络',
        invalid: '刻度判定格式无法识别',
        unchanged: r.reason === 'protected' ? '本轮变化均无效或受保护，刻度未更新' : '本轮无需更新刻度',
        updated: `刻度刷新 ${(r.applied || []).length} 条${r.applied?.length ? `：${r.applied.join('、')}` : ''} · 请注意查看`,
        cancelled: '刻度更新已中止',
    }[r.status] || '刻度更新已结束';
    return { message: `${text}${suffix}`, error: r.status === 'failed' || r.status === 'invalid' };
}

export function createLedgerDeletedHandler({ cancel, reconcile, toast, refreshInject, refreshInline, refreshPanel } = {}) {
    return async (...args) => {
        cancel?.(...args);
        const result = await reconcile?.(...args);
        const s = result?.summary || {};
        if (s.cleaned || s.remapped || s.lockedMissing) {
            toast?.(`已清理 ${s.cleaned || 0} 条、重映射 ${s.remapped || 0} 条、保留锁定来源缺失 ${s.lockedMissing || 0} 条`);
            refreshInject?.(); refreshInline?.(true); refreshPanel?.();
        }
        return result;
    };
}

export function bindLedgerEvents({ almanac, chat, $, settings, saveSettings, capture, judge, captureState, actions, render, editor, archive, batch, toast, resetCapture } = {}) {
    const redraw = () => { render(); };
    const judgeFeedback = result => { const feedback = formatLedgerJudgeFeedback(result); toast?.(feedback.message, feedback.error ? null : undefined, feedback.error); };
    const runManualJudge = async () => { const result = await judge.run(true); judgeFeedback(result); redraw(); return result; };
    almanac.on('change', '.sp-ledger-auto-toggle', function () { settings().ledgerCaptureEnabled = this.checked; saveSettings(); resetCapture?.(); redraw(); });
    almanac.on('change', '.sp-ledger-interval', function () { const n = Math.max(1, Math.min(30, Math.floor(Number(this.value) || 5))); settings().ledgerCaptureInterval = n; this.value = String(n); saveSettings(); resetCapture?.(); redraw(); });
    almanac.on('click', '.sp-ledger-capture-now', function () { if (captureState().busy) { capture.abort(); toast('已请求中止刻度标注'); return; } const p = capture.run(true); redraw(); p.then(() => redraw()); });
    almanac.on('click', '.sp-ledger-judge-now', function () { runManualJudge(); });
    almanac.on('click', '.sp-ledger-edit', function (e) { e.stopPropagation(); const id = $(this).closest('.sp-ledger-row').attr('data-id'); if (id) editor.open(id); });
    almanac.on('click', '.sp-ledger-lock-toggle', function (e) { e.stopPropagation(); actions.toggleLock($(this).closest('.sp-ledger-row').attr('data-id')); });
    almanac.on('click', '.sp-ledger-mute-toggle', function (e) { e.stopPropagation(); actions.toggleMute($(this).closest('.sp-ledger-row').attr('data-id'), { inline: true }); });
    almanac.on('click', '.sp-ledger-close', async function (e) { e.stopPropagation(); await actions.close($(this).closest('.sp-ledger-row').attr('data-id')); });
    almanac.on('click', '.sp-ledger-archive-head', function (e) { e.stopPropagation(); archive.toggle(); redraw(); });
    almanac.on('click', '.sp-ledger-reopen', function (e) { e.stopPropagation(); actions.reopen($(this).closest('.sp-ledger-row').attr('data-id')); });
    almanac.on('click', '.sp-ledger-remove', async function (e) { e.stopPropagation(); await actions.remove($(this).closest('.sp-ledger-row').attr('data-id')); });
    almanac.on('click', '.sp-led-editor-save', editor.save);
    almanac.on('click', '.sp-led-editor-cancel, .sp-led-editor-back', editor.close);
    almanac.on('click', '.sp-led-adv-open', function () { const ed = editor.get(); if (ed) { ed.advanced = true; redraw(); } });
    almanac.on('click', '.sp-batch-enter', function (e) { e.stopPropagation(); const scope = $(this).attr('data-scope'); if (!batch.scopes.includes(scope)) return; batch.setScope(scope); batch.selected().clear(); redraw(); });
    almanac.on('click', '.sp-batch-exit', function (e) { e.stopPropagation(); batch.reset(); redraw(); });
    almanac.on('change', '.sp-batch-selall', function () { const scope = batch.scope(); if (!scope || !batch.scopes.includes(scope)) return; if (this.checked) batch.ids(scope).forEach(id => batch.selected().add(id)); else batch.selected().clear(); redraw(); });
    almanac.on('change', '.sp-batch-check', function () { const id = $(this).closest('[data-id]').attr('data-id'); if (id == null) return; if (this.checked) batch.selected().add(id); else batch.selected().delete(id); redraw(); });
    almanac.on('click', '.sp-batch-exec', async function (e) { e.stopPropagation(); const scope = batch.scope(); const ids = [...batch.selected()]; if (!scope || !batch.scopes.includes(scope) || !ids.length) return; await batch.exec(scope, ids); });
    if (chat) {
        chat.on('click', '.sp-inline-ledger-capture', function (e) { e.stopPropagation(); if (captureState().busy) { toast('正在标注中…'); return; } capture.run(true); });
        chat.on('click', '.sp-inline-ledger-judge', function (e) { e.stopPropagation(); runManualJudge(); });
        chat.on('click', '.sp-inline-ledger-lock', function (e) { e.stopPropagation(); actions.toggleLock($(this).attr('data-id'), { inline: true, panel: false }); });
        chat.on('click', '.sp-inline-ledger-mute', function (e) { e.stopPropagation(); actions.toggleMute($(this).attr('data-id'), { inline: true, panel: false }); });
        chat.on('click', '.sp-inline-ledger-close', async function (e) { e.stopPropagation(); await actions.close($(this).attr('data-id'), { inline: true, panel: false }); });
    }
}
