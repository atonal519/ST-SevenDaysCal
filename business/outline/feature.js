import { createOutlineChat } from './chat.js';
import { createOutlineGeneration } from './generation.js';
import { createOutlineIdentity, sameOutlineIdentity } from './identity.js';
import { createOutlineInjection } from './injection.js';
import { createOutlineJudge } from './judge.js';
import { createOutlineRenderer } from './render.js';
import { createOutlineRepository } from './repository.js';
import { cursorAfterBeatDelete, deleteOutlineBeatFromRaw, parseOutline, editOutlineScene } from './schema.js';
import { createOutlineUi } from './ui.js';

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
            creativeChatKey: env.keyDesc?.('creative-chat', 'user', ''),
        });
    };
    const isCurrent = target => sameOutlineIdentity(target, captureIdentity());
    const repository = createOutlineRepository({
        captureIdentity,
        isCurrent,
        readStore: env.readStore,
        writeStore: env.writeStore,
        removeStore: env.removeStore,
    });
    const ui = createOutlineUi(env.ui);
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
    });
    const refreshPanel = (target = repository.capture()) => {
        if (!repository.isCurrent(target)) return;
        const saved = repository.readOutline(target);
        ui.setOutline(saved?.raw ? renderer.render(saved.raw, repository.cursor(target)) : renderer.empty());
    };
    const judge = createOutlineJudge({
        repository,
        context: env.context,
        settings: env.settings,
        pluginEnabled: env.pluginEnabled,
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
        openSettings: env.openSettings,
        now: env.now,
        isEditing: () => editing,
    });
    const chat = createOutlineChat({
        repository,
        loadConfig: env.loadConfig,
        buildMessages: env.buildChatMessages,
        postCompletion: env.postCompletion,
        injection,
        renderer,
        ui,
        openSettings: env.openSettings,
        maxTokens: 30000,
        temperature: env.temperature,
        now: env.now,
    });
    const actions = Object.freeze({
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
            if (!repository.commitOutline(target, { raw: result.raw, ts: env.now?.() ?? Date.now(), cursor: baseline.cursor }, baseline)) return false;
            injection.refresh(target); if (ui.isOutlineMode()) refreshPanel(target); return true;
        },
        toggleCursor(cursor) {
            if (editing) return false;
            const target = repository.capture();
            const saved = repository.readOutline(target);
            if (!saved?.raw) return false;
            const baseline = repository.baseline(target);
            const next = repository.cursor(target) === cursor ? 0 : cursor;
            if (!repository.setCursor(target, next, baseline)) return false;
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
                if (!repository.removeOutline(target, baseline)) return false;
                injection.refresh(target);
                if (ui.isOutlineMode()) ui.setOutline(renderer.empty());
                return true;
            }
            const cursor = cursorAfterBeatDelete(repository.cursor(target), index, remaining.length);
            if (!repository.commitOutline(target, { raw, ts: env.now?.() ?? Date.now(), cursor }, baseline)) return false;
            injection.refresh(target);
            if (ui.isOutlineMode()) refreshPanel(target);
            return true;
        },
    });
    ui.bindControllers({ generation, chat, actions });

    const open = () => {
        ui.setPlaceholder(env.chatPlaceholder?.() || '和 AI 讨论剧情、面或设定…');
        chat.load();
        if (generation.busy) ui.setLoading();
        else refreshPanel();
    };
    const onChatChanged = ({ lastSeen = -1 } = {}) => {
        chatRevision += 1;
        editing = false;
        generation.abort();
        judge.onChatChanged({ lastSeen });
        chat.onChatChanged();
    };
    const abortAll = () => {
        generation.abort();
        judge.abort();
        chat.abort();
    };
    const invalidateStoreKind = kind => {
        if (kind === 'outline') {
            generation.abort();
            judge.abort();
        } else if (kind === 'creative-chat') {
            chat.abort();
        }
    };
    const refreshAfterStoreClear = kind => {
        if (kind === 'outline') {
            if (ui.isOutlineMode()) ui.setOutline(renderer.empty());
            injection.refresh();
        } else if (kind === 'creative-chat') {
            chat.load();
        }
    };
    const refreshFromStore = kind => {
        if (kind === 'outline') {
            if (ui.isOutlineMode()) refreshPanel();
            injection.refresh();
        } else if (kind === 'creative-chat') {
            chat.load();
        }
    };
    return Object.freeze({
        repository,
        renderer,
        injection,
        judge,
        generation,
        chat,
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
        get chatRevision() { return chatRevision; },
    });
}
