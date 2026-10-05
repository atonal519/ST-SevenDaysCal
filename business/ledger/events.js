import { UI_REFRESH_FAILURE_TEXT } from '../ui/panel-failure.js';
import { ledgerFailureText } from './diagnostics.js';

export function formatLedgerJudgeFeedback(result) {
    const r = result || { status: 'failed', reason: 'unknown' };
    if (r.status === 'updated' && r.uiError) return { message: '内容已更新，界面刷新失败', error: true };
    const s = r.reconcile?.summary || {};
    const saveResult = r.saveResult || r.error?.saveResult || r.reconcile?.error?.saveResult || null;
    const saveStatus = Number(saveResult?.status);
    const saveConflict = saveStatus === 409 || /(?:409|conflict)/i.test(String(saveResult?.reason || ''));
    const reconcileSaved = r.reconcileCommitted === true || (r.reconcile?.summary?.changed === true && !r.reconcile?.error);
    const reconciliationSucceeded = !r.reconcile?.error;
    const suffix = reconciliationSucceeded && (s.cleaned || s.remapped || s.lockedMissing) ? `；校对：清理${s.cleaned || 0}、重映射${s.remapped || 0}、保留锁定缺失${s.lockedMissing || 0}` : '';
    const pendingText = reconciliationSucceeded && s.pending ? `；已保留 ${s.pending} 条待确认来源` : '';
    const text = {
        busy: '已有刻度更新正在进行，请稍候',
        skipped: r.reason === 'no-character' ? '当前没有角色卡，无法判定' : r.reason === 'no-entry' ? '暂无可判定的活跃事件' : r.reason === 'spDisabled' ? '刻度功能已停用' : '刻度更新已跳过',
        failed: r.reason === 'no-api' ? '请先在设置中填写 API' : r.reason === 'source-scan-failed' ? '来源扫描失败，未发起 API 请求' : r.reason === 'source-state-invalid' ? '来源状态无法确认，未发起 API 请求' : r.reason === 'source-stale-chat' ? '来源快照或聊天状态已变化，未发起 API 请求' : r.reason === 'source-save-failed' ? `来源清理保存${saveConflict ? '发生 HTTP 409 冲突' : '失败'}，清理未保存，已恢复原状态；未发起 AI 请求` : r.reason === 'metadata-capture-failed' ? '元数据快照无法恢复，未发起保存请求' : r.reason === 'invalid-operation' ? '存档操作校验失败，模型判定未开始' : r.reason === 'persistence-not-committed' ? '保存未提交，已恢复本地状态' : r.reason === 'capture-state-invalid' ? '标注保存后状态不一致，已撤销' : r.reason === 'judge-state-invalid' ? '刷新保存后状态不一致，已撤销' : r.reason === 'persistence-unknown' ? '刻度持久状态无法确认，未发起 API 请求' : r.reason === 'rollback-save-failed' ? '原存档恢复保存失败，持久状态暂无法确认' : r.reason === 'judge-save-failed' ? reconcileSaved ? `来源清理已保存；AI 刷新保存${saveConflict ? '发生 HTTP 409 冲突' : '失败'}，本轮 AI 更新未写入` : `AI 刷新保存${saveConflict ? '发生 HTTP 409 冲突' : '失败'}，本轮 AI 更新未写入` : r.reason === 'capture-save-failed' ? '刻度标注保存失败，未确认写入更新' : ledgerFailureText('刻度判定失败', r.error, { ledgerPhase: r.error?.ledgerPhase || 'judge-request' }),
        invalid: '刻度判定格式无法识别',
        unchanged: r.reason === 'protected' ? '本轮变化均无效或受保护，刻度未更新' : '本轮无需更新刻度',
        updated: `刻度刷新 ${(r.applied || []).length} 条${r.applied?.length ? `：${r.applied.join('、')}` : ''}${s.judgeable != null ? `；参与判定 ${s.judgeable} 条` : ''}${pendingText} · 请注意查看`,
        cancelled: '刻度更新已中止',
    }[r.status] || '刻度更新已结束';
    return { message: `${text}${suffix}${r.status === 'updated' ? '' : pendingText}`, error: r.status === 'failed' || r.status === 'invalid' };
}

export function createLedgerDeletedHandler({ cancel, onDeleted, reconcile, toast, refreshInject, refreshInline, refreshPanel } = {}) {
    return async (...args) => {
        cancel?.(...args);
        onDeleted?.(...args);
        const result = await reconcile?.(...args);
        const s = result?.summary || {};
        if (s.cleaned || s.remapped || s.lockedMissing) {
            toast?.(`已清理 ${s.cleaned || 0} 条、重映射 ${s.remapped || 0} 条、保留锁定来源缺失 ${s.lockedMissing || 0} 条`);
            refreshInject?.(); refreshInline?.(true); refreshPanel?.();
        }
        return result;
    };
}

export function formatLedgerCaptureFeedback(result) {
    const r = result || { status: 'failed', reason: 'unknown' };
    if (r.status === 'updated' && r.uiError) return { message: '内容已更新，界面刷新失败', error: true };
    const text = {
        busy: '已有刻度标注正在进行，请稍候',
        skipped: r.reason === 'no-character' ? '当前没有角色卡，无法标注' : r.reason === 'spDisabled' ? '刻度功能已停用' : '本次刻度标注已跳过',
        failed: r.reason === 'no-api' ? '请先在设置中填写 API' : r.reason === 'checkpoint-invalid' ? '已保留的来源进度与当前聊天、角色、来源或刻度数据不一致；已保存条目保持不变，本次没有继续写入。' : r.reason === 'capture-fields-unusable' || r.reason === 'provenance-fields-unusable' ? '模型回复里没有可用的刻度字段，本次未保存' : r.reason === 'capture-source-unmatched' || r.reason === 'provenance-source-unmatched' ? '模型给出的来源未匹配当前允许的正文范围，本次未保存' : r.reason === 'provenance-date-unreliable' ? '模型所指楼层没有可靠日期锚，本次未保存' : r.reason === 'capture-save-failed' ? '刻度保存失败；已保存内容保持不变，本次未确认写入' : r.reason === 'completed-source-invalid' ? `${Number.isFinite(r.totalBatches) ? `${r.totalBatches} 批` : '全部批次'}刻度溯源已完成，但最终选中的来源正文已经变化，结果无法安全恢复；本轮未写入，如需继续请重新完整标注。` : r.reason === 'pending-commit-invalid' ? '已保留的刻度结果无法安全提交：聊天、角色、刻度池或来源正文已经变化；本次没有写入，也没有重跑 API。' : r.reason === 'capture-state-invalid' ? '标注保存后状态不一致，已撤销' : r.reason === 'persistence-not-committed' ? '保存未提交，已恢复本地状态' : r.reason === 'persistence-unknown' ? '刻度持久状态无法确认，已恢复本地状态' : r.reason === 'rollback-save-failed' ? '原存档恢复保存失败，请检查当前聊天数据' : ledgerFailureText('刻度标注失败', r.error, { ledgerPhase: r.error?.ledgerPhase }),
        unchanged: r.reason === 'duplicate' ? '没有新事件（都已在刻度上）' : '未发现可登记的新事件',
        'needs-confirmation': r.reason === 'provenance-range-exhausted' ? `所选范围已查完，仍有 ${r.pending || 0} 项没有可靠来源；可在设置扩大范围后继续，或放弃待查候选。已保存条目不受影响。` : r.reason === 'provenance-resume-manual' ? '已有逐批保存的来源进度，请点“标注”继续当前批；也可先在设置改范围，或放弃待查候选。' : '本次标注需要确认后才能继续',
        cancelled: r.reason === 'confirmation-cancelled' ? '已取消本次刻度标注' : '刻度标注已中止',
        'pending-commit': `${Number.isFinite(r.totalBatches) ? `${r.totalBatches} 批` : '全部批次'}刻度溯源已完成，结果已保留但尚未写入；聊天状态发生变化，请再次点「立即标注」安全提交，不会重跑 API。`,
        updated: `刻度标注已完成${Number.isFinite(r.added) || Number.isFinite(r.patched) ? `：新增 ${r.added || 0} 条、更新 ${r.patched || 0} 条` : ''} · 请注意查看`,
    }[r.status] || '刻度标注已结束';
    return { message: `${text}${r.ignored > 0 ? `；另有 ${r.ignored} 行字段不完整或来源不可靠，已忽略` : ''}`, error: r.status === 'failed' };
}

export function finalizeLedgerPanelFeedback(result, { formatFeedback, setFailure, clearFailure, render, toast, clearOnSuccess = false, formatFailure = feedback => feedback.message } = {}) {
    let next = result;
    const feedback = formatFeedback?.(result) || { message: '', error: false };
    if (feedback.error) { try { setFailure?.(formatFailure(feedback, result)); } catch {} }
    else if (clearOnSuccess && ['updated', 'unchanged'].includes(result?.status)) { try { clearFailure?.(); } catch {} }
    try { render?.(); }
    catch (error) {
        if (result?.status === 'updated') {
            next = { ...result, uiError: result.uiError || error };
            try { setFailure?.(UI_REFRESH_FAILURE_TEXT); } catch {}
            if (!result.uiError) { try { toast?.(UI_REFRESH_FAILURE_TEXT, null, true); } catch {} }
        }
    }
    return next;
}

export function finalizeLedgerCapturePanel(result, options = {}) {
    return finalizeLedgerPanelFeedback(result, { ...options, formatFeedback: formatLedgerCaptureFeedback });
}

export function finalizeLedgerJudgePanel(result, options = {}) {
    return finalizeLedgerPanelFeedback(result, { ...options, formatFeedback: formatLedgerJudgeFeedback });
}

export function finalizeLedgerEventUi(result, { refreshInline, render, toast } = {}) {
    let uiError = null;
    try { refreshInline?.(true); } catch (error) { uiError = error; }
    try { render?.(); } catch (error) { uiError ||= error; }
    if (result?.status === 'updated' && uiError) {
        const next = { ...result, uiError: result.uiError || uiError, feedbackShown: true };
        try { toast?.(UI_REFRESH_FAILURE_TEXT, null, true); } catch {}
        return next;
    }
    return result;
}

export function bindLedgerEvents({ almanac, chat, $, settings, saveSettings, capture, judge, captureState, actions, render, refreshInline, identity, isCurrentIdentity, editor, archive, batch, toast, resetCapture } = {}) {
    const namespace = '.spLedger';
    const redraw = () => { render(); };
    const current = owner => !owner || typeof isCurrentIdentity !== 'function' || isCurrentIdentity(owner) !== false;
    const staleResult = result => result?.stale === true || result?.reason === 'source-stale-chat' || result?.reason === 'superseded';
    const captureFeedback = result => { const feedback = formatLedgerCaptureFeedback(result); toast?.(feedback.message, feedback.error ? null : undefined, feedback.error); };
    const judgeFeedback = result => { const feedback = formatLedgerJudgeFeedback(result); toast?.(feedback.message, feedback.error ? null : undefined, feedback.error); };
    const setCaptureBusy = (button, busy, inline) => {
        if (!button) return;
        const $button = $(button);
        $button.toggleClass('sp-ledger-capture-busy', !!busy).attr('aria-busy', busy ? 'true' : 'false');
        if (inline) {
            $button.prop('disabled', !!busy).attr('aria-disabled', busy ? 'true' : 'false').text(busy ? '标注中…' : '标注');
        } else {
            $button.attr('aria-disabled', 'false').attr('title', busy ? '再次点击可中止当前标注' : '立即标注一次').text(busy ? '中止标注' : '标注');
        }
    };
    const runManualCapture = async (button, { inline = false } = {}) => {
        if (captureState?.().busy) {
            if (inline) { toast?.('正在标注中…'); return { status: 'busy' }; }
            capture.abort?.();
            const $button = $(button);
            $button.attr('aria-busy', 'true').addClass('sp-ledger-capture-busy').text('中止中…');
            return { status: 'cancelled', reason: 'abort-requested' };
        }
        const owner = identity?.();
        const task = {};
        if (button) button.__spLedgerCaptureTask = task;
        setCaptureBusy(button, true, inline);
        let outcome = null;
        let result = null;
        let showFeedback = true;
        try {
            result = outcome = await capture.run(true);
            const completedProvenance = result?.status === 'pending-commit' || result?.reason === 'completed-source-invalid';
            if ((!current(owner) && !completedProvenance) || staleResult(result)) showFeedback = false;
        } catch (error) {
            if (!current(owner)) { result = outcome = { status: 'cancelled', reason: 'source-stale-chat', stale: true, error }; showFeedback = false; }
            else result = outcome = { status: 'failed', reason: error?.phase || 'ui-handler-failed', error };
        } finally {
            const completedProvenance = outcome?.status === 'pending-commit' || outcome?.reason === 'completed-source-invalid';
            if (button?.__spLedgerCaptureTask === task && (current(owner) || completedProvenance)) {
                setCaptureBusy(button, false, inline);
                result = finalizeLedgerEventUi(result, { refreshInline, render: redraw, toast });
            }
        }
        if (showFeedback && current(owner) && !staleResult(result) && result?.feedbackShown !== true) captureFeedback(result);
        return result;
    };
    const runManualJudge = async () => {
        const owner = identity?.();
        let result;
        try {
            result = await judge.run(true);
        } catch (error) {
            result = { status: 'failed', reason: error?.phase || 'api-failed', error };
        } finally { if (current(owner)) result = finalizeLedgerEventUi(result, { render: redraw, toast }); }
        if (current(owner) && !staleResult(result) && result?.feedbackShown !== true) judgeFeedback(result);
        return result;
    };
    almanac.off?.(namespace);
    almanac.on(`click${namespace}`, '.sp-ledger-capture-now', function () { return runManualCapture(this); });
    almanac.on(`click${namespace}`, '.sp-ledger-judge-now', function () { return runManualJudge(); });
    almanac.on(`click${namespace}`, '.sp-ledger-abandon', async function () {
        const owner = identity?.();
        const token = capture.prepareAbandon?.();
        if (!token) return;
        const ok = await envConfirm();
        if (!ok) return;
        if (!current(owner)) return;
        let result;
        try { result = await capture.abandon?.(token); }
        catch (error) { result = { status: 'failed', reason: error?.phase || 'capture-save-failed', error }; }
        if (!current(owner)) return result;
        if (result?.status === 'updated') {
            redraw(); refreshInline?.(true); toast?.('已放弃未确认候选；已保存的刻度条目保持不变');
        } else if (result?.status === 'failed') captureFeedback(result);
        return result;
    });
    almanac.on(`click${namespace}`, '.sp-ledger-edit', function (e) { e.stopPropagation(); const id = $(this).closest('.sp-ledger-row').attr('data-id'); if (id) editor.open(id); });
    almanac.on(`click${namespace}`, '.sp-ledger-lock-toggle', function (e) { e.stopPropagation(); actions.toggleLock($(this).closest('.sp-ledger-row').attr('data-id')); });
    almanac.on(`click${namespace}`, '.sp-ledger-mute-toggle', function (e) { e.stopPropagation(); actions.toggleMute($(this).closest('.sp-ledger-row').attr('data-id'), { inline: true }); });
    almanac.on(`click${namespace}`, '.sp-ledger-close', async function (e) { e.stopPropagation(); await actions.close($(this).closest('.sp-ledger-row').attr('data-id')); });
    almanac.on(`click${namespace}`, '.sp-ledger-archive-head', function (e) { e.stopPropagation(); archive.toggle(); redraw(); });
    almanac.on(`click${namespace}`, '.sp-ledger-reopen', function (e) { e.stopPropagation(); actions.reopen($(this).closest('.sp-ledger-row').attr('data-id')); });
    almanac.on(`click${namespace}`, '.sp-ledger-remove', async function (e) { e.stopPropagation(); await actions.remove($(this).closest('.sp-ledger-row').attr('data-id')); });
    almanac.on(`click${namespace}`, '.sp-led-editor-save', editor.save);
    almanac.on(`click${namespace}`, '.sp-led-editor-cancel, .sp-led-editor-back', editor.close);
    almanac.on(`click${namespace}`, '.sp-led-adv-open', function () { const ed = editor.get(); if (ed) { ed.advanced = true; redraw(); } });
    almanac.on(`click${namespace}`, '.sp-batch-enter', function (e) { e.stopPropagation(); const scope = $(this).attr('data-scope'); if (!batch.scopes.includes(scope)) return; batch.setScope(scope); batch.selected().clear(); redraw(); });
    almanac.on(`click${namespace}`, '.sp-batch-exit', function (e) { e.stopPropagation(); batch.reset(); redraw(); });
    almanac.on(`change${namespace}`, '.sp-batch-selall', function () { const scope = batch.scope(); if (!scope || !batch.scopes.includes(scope)) return; if (this.checked) batch.ids(scope).forEach(id => batch.selected().add(id)); else batch.selected().clear(); redraw(); });
    almanac.on(`change${namespace}`, '.sp-batch-check', function () { const id = $(this).closest('[data-id]').attr('data-id'); if (id == null) return; if (this.checked) batch.selected().add(id); else batch.selected().delete(id); redraw(); });
    almanac.on(`click${namespace}`, '.sp-batch-exec', async function (e) { e.stopPropagation(); const scope = batch.scope(); const ids = [...batch.selected()]; if (!scope || !batch.scopes.includes(scope) || !ids.length) return; await batch.exec(scope, ids); });
    if (chat) {
        if (chat !== almanac) chat.off?.(namespace);
        chat.on(`click${namespace}`, '.sp-inline-ledger-capture', function (e) { e.stopPropagation(); return runManualCapture(this, { inline: true }); });
        chat.on(`click${namespace}`, '.sp-inline-ledger-judge', function (e) { e.stopPropagation(); return runManualJudge(); });
        chat.on(`click${namespace}`, '.sp-inline-ledger-lock', function (e) { e.stopPropagation(); actions.toggleLock($(this).attr('data-id'), { inline: true, panel: false }); });
        chat.on(`click${namespace}`, '.sp-inline-ledger-mute', function (e) { e.stopPropagation(); actions.toggleMute($(this).attr('data-id'), { inline: true, panel: false }); });
        chat.on(`click${namespace}`, '.sp-inline-ledger-close', async function (e) { e.stopPropagation(); await actions.close($(this).attr('data-id'), { inline: true, panel: false }); });
    }
    async function envConfirm() {
        return typeof capture.confirmAbandon === 'function' ? capture.confirmAbandon() : true;
    }
}
