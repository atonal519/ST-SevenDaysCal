import { createSpaceChat } from './chat.js';
import { createSpaceContext } from './context.js';
import { createSpaceIdentity, sameSpaceIdentity } from './identity.js';
import { getSpaceChatPlaceholder } from './prompts.js';
import { createSpaceRenderer } from './render.js';
import { createSpaceRepository } from './repository.js';
import { createSpaceUi } from './ui.js';
import { createPanelFailureStore } from '../ui/panel-failure.js';
import { diagnosticMessage } from '../../api/diagnostics.js';

export function createSpaceFeature(env = {}) {
    let chatRevision = 0;
    const captureIdentity = () => createSpaceIdentity({
        chatId: env.context?.()?.chatId || '',
        chatRevision,
        historyKey: env.keyDesc?.('space-chat', 'user', ''),
    });
    const isCurrent = target => sameSpaceIdentity(target, captureIdentity());
    const repository = createSpaceRepository({
        captureIdentity,
        isCurrent,
        readStore: env.readStore,
        writeStore: env.writeStore,
    });
    const context = createSpaceContext(env.contextEnv);
    const renderer = createSpaceRenderer(env.renderEnv);
    const ui = createSpaceUi({ ...env.ui, captureIdentity, isCurrentIdentity: isCurrent });
    const failureNotes = createPanelFailureStore({ escapeHtml: env.escapeHtml });
    const failureKey = target => JSON.stringify([String(target?.chatId || ''), Number(target?.chatRevision) || 0]);
    const renderFailure = () => ui.setFailureHtml?.(failureNotes.html('space-chat', failureKey(repository.capture())));
    let sendAttempt = 0;
    const chat = createSpaceChat({
        repository,
        loadConfig: env.loadConfig,
        buildMessages: context.buildMessages,
        postCompletion: env.postCompletion,
        openSettings: env.openSettings,
        temperature: env.temperature,
        ui,
    });
    const chatUi = Object.create(chat);
    Object.defineProperties(chatUi, {
        busy: { get: () => chat.busy },
        send: { value: async (...args) => {
            if (chat.busy) return chat.send(...args);
            const target = repository.capture(); const key = failureKey(target); const attempt = ++sendAttempt;
            failureNotes.clear('space-chat', key); renderFailure();
            const result = await chat.send(...args);
            if (attempt !== sendAttempt || !repository.isCurrent(target)) return result;
            if (result?.status === 'failed') failureNotes.set('space-chat', key, `上次局外讨论失败：${diagnosticMessage(result.error)}`);
            else if (result?.status === 'updated') failureNotes.clear('space-chat', key);
            renderFailure(); return result;
        } },
        resendFrom: { value: async (...args) => {
            if (chat.busy) return chat.resendFrom(...args);
            const target = repository.capture(); const key = failureKey(target); const attempt = ++sendAttempt;
            failureNotes.clear('space-chat', key); renderFailure();
            const result = await chat.resendFrom(...args);
            if (attempt !== sendAttempt || !repository.isCurrent(target)) return result;
            if (result?.status === 'failed') failureNotes.set('space-chat', key, `上次局外讨论失败：${diagnosticMessage(result.error)}`);
            else if (result?.status === 'updated') failureNotes.clear('space-chat', key);
            renderFailure(); return result;
        } },
        abort: { value: reason => { sendAttempt++; failureNotes.clear('space-chat', failureKey(repository.capture())); renderFailure(); return chat.abort(reason); } },
    });
    ui.bindControllers({ chat: chatUi, renderer });

    const open = () => {
        ui.setPlaceholder(env.placeholder?.() || getSpaceChatPlaceholder());
        chat.load();
        ui.renderHistory(chat.history());
        renderFailure();
    };
    const onChatChanged = ({ enabled = true } = {}) => {
        chatRevision += 1;
        failureNotes.clearAll(); renderFailure();
        ui.clearWidgets();
        if (!enabled) return;
        repository.clearMemory();
        ui.emptyMessages();
    };
    const abortAll = (reason = 'manual-abort') => {
        chat.abort(reason);
        sendAttempt++; failureNotes.clearAll(); renderFailure();
        if (reason === 'manual-abort' || reason === 'user-abort') { sendAttempt++; failureNotes.clear('space-chat', failureKey(repository.capture())); renderFailure(); }
        if (env.isOpen?.()) ui.renderHistory(chat.history());
    };
    const invalidateStoreKind = kind => {
        if (kind === 'space-chat') { chat.abort('store-clear'); sendAttempt++; failureNotes.clearAll(); renderFailure(); }
    };
    const refreshAfterStoreClear = kind => {
        if (kind !== 'space-chat') return;
        repository.clearMemory();
        ui.clearWidgets();
        if (env.isOpen?.()) ui.renderHistory(chat.history());
    };
    const refreshFromStore = kind => {
        if (kind !== 'space-chat') return;
        chat.load();
        if (env.isOpen?.()) ui.renderHistory(chat.history());
    };
    return Object.freeze({
        repository,
        context,
        renderer,
        ui,
        chat: chatUi,
        bindUi: ui.bind,
        open,
        onChatChanged,
        abortAll,
        invalidateStoreKind,
        refreshAfterStoreClear,
        refreshFromStore,
        get chatRevision() { return chatRevision; },
    });
}
