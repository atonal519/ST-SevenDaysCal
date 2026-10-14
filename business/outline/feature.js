import { createOutlineGeneration } from './generation.js';
import { createOutlineIdentity, sameOutlineIdentity } from './identity.js';
import { createOutlineInjection, formatOutlinePlanningProjection, isOutlinePlanningEnabled, projectOutlineBeats } from './injection.js';
import { createOutlineJudge } from './judge.js';
import { createOutlineRenderer } from './render.js';
import { createOutlineRepository } from './repository.js';
import { cursorAfterBeatDelete, deleteOutlineBeatFromRaw, parseOutline, editOutlineScene, normalizeOutlineResponse } from './schema.js';
import { pointRawToken } from '../space/schema.js';
import { createOutlineUi } from './ui.js';
import { createPanelFailureStore } from '../ui/panel-failure.js';
import { diagnosticMessage } from '../../api/diagnostics.js';
import { UI_REFRESH_FAILURE_TEXT } from '../ui/panel-failure.js';

export function createOutlineFeature(env = {}) {
    let chatRevision = 0;
    let editing = false;
    let editToken = null;
    const captureIdentity = () => {
        const chatId = String(env.context?.()?.chatId ?? '');
        return createOutlineIdentity({
            chatId,
            chatRevision,
            outlineKey: env.keyDesc?.('outline', 'user', ''),
        });
    };
    const isCurrent = target => sameOutlineIdentity(target, captureIdentity());
    const repository = createOutlineRepository({
        captureIdentity,
        isCurrent,
        readStore: env.readStore,
        writeStore: env.writeStore,
        writeStoreConfirmed: env.writeStoreConfirmed,
        removeStore: env.removeStore,
    });
    const ui = createOutlineUi(env.ui);
    const failureNotes = createPanelFailureStore({ escapeHtml: env.escapeHtml });
    let visibleFailureSlot = null;
    const identityKey = target => JSON.stringify([String(target?.chatId || ''), Number(target?.chatRevision) || 0]);
    const currentFailureKey = () => identityKey(captureIdentity());
    const renderFailureNotes = () => ui.setFailureHtml?.(visibleFailureSlot ? failureNotes.html('outline-last', currentFailureKey()) : '');
    const setFailureNote = (slot, key, text) => { visibleFailureSlot = slot; failureNotes.set('outline-last', key, text); };
    const clearFailureNote = (slot, key) => { if (visibleFailureSlot !== slot) return false; visibleFailureSlot = null; return failureNotes.clear('outline-last', key); };
    const failureAttempt = new Map();
    const runWithFailureNote = async (slot, label, run) => {
        if (slot === 'outline-generation' && generation?.busy) return run();
        const target = repository.capture(); const targetKey = identityKey(target); const attempt = (failureAttempt.get(slot) || 0) + 1;
        failureAttempt.set(slot, attempt); clearFailureNote(slot, targetKey); renderFailureNotes();
        let result;
        try { result = await run(); }
        catch (error) { result = { status: 'failed', error }; }
        if (failureAttempt.get(slot) !== attempt || !repository.isCurrent(target)) return result;
        if (result?.status === 'failed') {
            const detail = result.error ? diagnosticMessage(result.error) : result.reason === 'memory-precheck' ? '记忆读取失败，请重试' : '操作失败，请重试';
            setFailureNote(slot, targetKey, `上次${label}失败：${detail}`);
        } else if (result?.status === 'updated' && result.uiError) setFailureNote(slot, targetKey, UI_REFRESH_FAILURE_TEXT);
        else if (['updated', 'unchanged'].includes(result?.status)) clearFailureNote(slot, targetKey);
        try { renderFailureNotes(); } catch { try { ui.toast?.(UI_REFRESH_FAILURE_TEXT, true); } catch {} }
        return result;
    };
    const renderer = createOutlineRenderer({
        escapeHtml: env.escapeHtml,
        cleanText: env.cleanText,
        makeInjectButton: ui.makeInjectButton,
        makeCopyButton: ui.makeCopyButton,
        beginRender: ui.resetTextMaps,
    });
    const injection = createOutlineInjection({
        repository,
        context: env.context,
        settings: env.settings,
        injectEnabled: env.injectEnabled,
        cleanText: env.cleanText,
        preferences: env.preferences,
    });
    const refreshPanel = (target = repository.capture()) => {
        if (!repository.isCurrent(target)) return;
        const saved = repository.readOutline(target);
        ui.setOutline(saved?.raw ? renderer.render(saved.raw, repository.cursor(target)) : renderer.empty());
        renderFailureNotes();
    };
    const judge = createOutlineJudge({
        repository,
        context: env.context,
        settings: env.settings,
        pluginEnabled: env.pluginEnabled,
        injectEnabled: env.injectEnabled,
        loadConfig: env.loadUtilityConfig,
        callApi: env.callApi,
        cleanText: env.cleanText,
        isAutomationSuppressed: env.isAutomationSuppressed,
        automationModule: env.automationModule,
        bridgeAbortSignal: env.bridgeAbortSignal,
        injection,
        toast: (message, error) => ui.toast(message, error),
        logDiagnostic: env.logDiagnostic,
        isEditing: () => editing,
        failure: (slot, target, error) => {
            if (!isCurrent(target)) return;
            const key = identityKey(target); const label = slot === 'relocate' ? '面定位' : '面自动推进判定';
            setFailureNote(slot, key, `上次${label}失败：${diagnosticMessage(error)}`); renderFailureNotes();
        },
        clearFailure: (slot, target) => {
            if (!isCurrent(target)) return;
            clearFailureNote(slot, identityKey(target)); renderFailureNotes();
        },
        uiFailure: (slot, target, error) => {
            if (!isCurrent(target)) return;
            setFailureNote(slot, identityKey(target), UI_REFRESH_FAILURE_TEXT);
            try { renderFailureNotes(); } catch { try { ui.toast?.(UI_REFRESH_FAILURE_TEXT, true); } catch {} }
        },
        onCursorChanged: ({ target }) => { if (ui.isOutlineMode()) refreshPanel(target); },
    });
    const generation = createOutlineGeneration({
        repository,
        context: env.context,
        loadConfig: env.loadConfig,
        callApi: env.callApi,
        precheck: env.precheck,
        judge,
        injection,
        renderer,
        ui,
        settings: env.settings,
        preferences: env.preferences,
        openSettings: env.openSettings,
        now: env.now,
        isEditing: () => editing,
    });
    const actions = Object.freeze({
        async applyCandidate(raw, expectedRawToken) {
            const normalized = normalizeOutlineResponse(raw);
            if (!normalized) { ui.toast('这份面方案没有可用节点，请重新生成', true); return Object.freeze({ status: 'invalid' }); }
            if (typeof expectedRawToken !== 'string') { ui.toast('无法确认面草稿基于哪版正式稿，请重新生成', true); return Object.freeze({ status: 'stale' }); }
            const target = repository.capture();
            if (pointRawToken(repository.readRaw(target)) !== expectedRawToken) {
                ui.toast('面内容已修改，请重新生成方案', true);
                return Object.freeze({ status: 'conflict' });
            }
            let saved;
            try {
                saved = await repository.commitOutlineConfirmed(target, { raw: normalized, ts: env.now?.() ?? Date.now(), cursor: 1 });
            } catch (error) {
                if (error?.saveResult?.commitState === 'unknown') {
                    ui.toast('保存结果暂时无法确认，请刷新后查看面', true);
                    return Object.freeze({ status: 'unknown', error });
                }
                ui.toast('应用失败，正式面未改变', true);
                return Object.freeze({ status: 'failed', error });
            }
            if (saved === true || saved?.ok === true && ['local-applied', 'confirmed'].includes(saved.commitState)) {
                try {
                    injection.refresh(target);
                    if (ui.isOutlineMode()) refreshPanel(target);
                } catch (error) {
                    ui.toast('面已保存，但显示未刷新；重新打开面查看', true);
                    return Object.freeze({ status: 'applied', uiError: error });
                }
                ui.toast('已应用到面');
                return Object.freeze({ status: 'applied' });
            }
            if (saved?.commitState === 'unknown') {
                ui.toast('保存结果暂时无法确认，请刷新后查看面', true);
                return Object.freeze({ status: 'unknown', result: saved });
            }
            ui.toast('应用失败，正式面未改变', true);
            return Object.freeze({ status: 'failed', result: saved });
        },
        async editScene(index) {
            if (editing || generation.busy || judge.busy) return false;
            const target = repository.capture(); const saved = repository.readOutline(target); const beat = parseOutline(saved?.raw || '')[Number(index)];
            if (!beat) return false;
            const baseline = repository.baseline(target);
            if (editing || env.isEditing?.()) return false;
            const token = Symbol('outline-edit'); editToken = token; editing = true;
            let value;
            try {
                value = await env.promptTextarea?.({ title: `编辑「${beat.title || '未命名'}」`, initialValue: beat.scene || '', placeholder: '填写这一面的场景描述…' });
            } finally {
                if (editToken === token) { editToken = null; editing = false; }
            }
            if (value === null || value === undefined) return false;
            if (!repository.matches(target, baseline)) { ui.toast('面已变化，请重新打开编辑', true); return false; }
            const result = editOutlineScene(saved.raw, Number(index), value); if (!result.ok) return false;
            if (!repository.commitOutline(target, { raw: result.raw, ts: env.now?.() ?? Date.now(), cursor: baseline.cursor }, baseline)) { ui.toast('保存失败，面未修改', true); return false; }
            injection.refresh(target); if (ui.isOutlineMode()) refreshPanel(target); return true;
        },
        toggleCursor(cursor) {
            if (editing) return false;
            const target = repository.capture();
            const saved = repository.readOutline(target);
            if (!saved?.raw) return false;
            const baseline = repository.baseline(target);
            const next = repository.cursor(target) === cursor ? 0 : cursor;
            if (!repository.setCursor(target, next, baseline)) { ui.toast('保存失败，当前节点未修改', true); return false; }
            injection.refresh(target);
            refreshPanel(target);
            return true;
        },
        async deleteBeat(index) {
            if (editing || generation.busy || judge.busy) return false;
            const target = repository.capture();
            const saved = repository.readOutline(target);
            const beat = parseOutline(saved?.raw || '')[index];
            if (!beat) return false;
            const baseline = repository.baseline(target);
            const confirmed = await env.confirm?.({
                title: '删除这个面',
                body: `将删除「${beat.title || '未命名'}」这一节点，其它面保留。此操作不可撤销。`,
                confirmText: '删除',
                cancelText: '取消',
            });
            if (!confirmed || !repository.isCurrent(target) || !repository.matches(target, baseline)) return false;
            const raw = deleteOutlineBeatFromRaw(saved.raw, index);
            if (raw == null) return false;
            const remaining = parseOutline(raw);
            if (!remaining.length) {
                if (!repository.removeOutline(target, baseline)) { ui.toast('保存失败，面未删除', true); return false; }
                injection.refresh(target);
                if (ui.isOutlineMode()) ui.setOutline(renderer.empty());
                return true;
            }
            const cursor = cursorAfterBeatDelete(repository.cursor(target), index, remaining.length);
            if (!repository.commitOutline(target, { raw, ts: env.now?.() ?? Date.now(), cursor }, baseline)) { ui.toast('保存失败，面未删除', true); return false; }
            injection.refresh(target);
            if (ui.isOutlineMode()) refreshPanel(target);
            return true;
        },
    });
    const generationUi = Object.create(generation);
    Object.defineProperties(generationUi, {
        busy: { get: () => generation.busy },
        trigger: { value: (...args) => runWithFailureNote('outline-generation', '面生成', () => generation.trigger(...args)) },
        abort: { value: reason => { failureAttempt.set('outline-generation', (failureAttempt.get('outline-generation') || 0) + 1); clearFailureNote('outline-generation', currentFailureKey()); renderFailureNotes(); return generation.abort(reason); } },
    });
    ui.bindControllers({ generation: generationUi, actions });

    const open = () => {
        if (generation.busy) ui.setLoading();
        else refreshPanel();
        renderFailureNotes();
    };
    const onChatChanged = ({ lastSeen = -1 } = {}) => {
        chatRevision += 1;
        editing = false;
        judge.onChatChanged({ lastSeen });
        failureNotes.clearAll(); visibleFailureSlot = null; renderFailureNotes();
    };
    const abortAll = (reason = 'manual-abort') => {
        generation.abort(reason);
        judge.abort(reason);
        failureAttempt.set('outline-generation', (failureAttempt.get('outline-generation') || 0) + 1);
        failureNotes.clearAll(); visibleFailureSlot = null; renderFailureNotes();
    };
    const invalidateStoreKind = kind => {
        if (kind === 'outline') {
            generation.abort('store-clear');
            judge.abort('store-clear');
        }
    };
    const refreshAfterStoreClear = kind => {
        if (kind === 'outline') {
            if (ui.isOutlineMode()) ui.setOutline(renderer.empty());
            injection.refresh();
        }
    };
    const refreshFromStore = kind => {
        if (kind === 'outline') {
            if (ui.isOutlineMode()) refreshPanel();
            injection.refresh();
        }
    };
    const readPlanningProjection = () => {
        if (!isOutlinePlanningEnabled(env.injectEnabled, env.settings)) return Object.freeze({ beats: Object.freeze([]), cursor: 0 });
        const target = repository.capture();
        const saved = repository.readOutline(target);
        return projectOutlineBeats(parseOutline(saved?.raw || ''), repository.cursor(target));
    };
    return Object.freeze({
        repository,
        renderer,
        injection,
        judge,
        generation: generationUi,
        ui,
        actions,
        bindUi: ui.bind,
        open,
        refreshPanel,
        onChatChanged,
        onCharacterMessage: judge.onCharacterMessage,
        resetJudgeCounter: judge.resetCounter,
        relocate: judge.relocate,
        canRelocate: judge.canRelocate,
        abortAll,
        invalidateStoreKind,
        refreshAfterStoreClear,
        refreshFromStore,
        readRaw: () => repository.readRaw(repository.capture()),
        readSnapshot: () => {
            const target = repository.capture();
            const saved = repository.readOutline(target);
            return Object.freeze({
                beats: parseOutline(saved?.raw || ''),
                cursor: repository.cursor(target),
            });
        },
        readPlanningProjection,
        readPlanningText: () => formatOutlinePlanningProjection(readPlanningProjection(), env.cleanText),
        get chatRevision() { return chatRevision; },
    });
}
