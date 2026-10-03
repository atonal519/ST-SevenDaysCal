import { createTheaterController } from './controller.js';
import { createTheaterUi } from './ui.js';
import { createPanelFailureStore } from '../ui/panel-failure.js';
import { diagnosticMessage } from '../../api/diagnostics.js';

export function createTheaterFeature(env = {}) {
    const controller = createTheaterController(env);
    const failureNotes = createPanelFailureStore({ escapeHtml: env.ui?.host?.escapeHtml });
    const targetKey = (chat = env.chatId?.(), revision = env.chatRevision?.()) => JSON.stringify([String(chat || ''), Number(revision) || 0]);
    const currentKey = () => targetKey();
    const renderFailure = () => env.ui?.host?.setFailureHtml?.(failureNotes.html('theater', currentKey()));
    let attempt = 0;
    const feature = {
        controller,
        generate: async (...args) => {
            const key = targetKey(); const request = ++attempt;
            failureNotes.clear('theater', key); renderFailure();
            const result = await controller.run(...args);
            if (request !== attempt || key !== currentKey()) return result;
            if (result?.status === 'failed') failureNotes.set('theater', key, `上次小剧场生成失败：${diagnosticMessage(result.error)}`);
            else if (result?.status === 'updated') failureNotes.clear('theater', key);
            renderFailure(); return result;
        },
        abort: reason => { attempt++; failureNotes.clear('theater', currentKey()); renderFailure(); return controller.abort(reason); },
        clearSaved: target => env.repository?.clearSaved?.(target),
        captureTarget(chatId) { return env.captureTarget?.(chatId); },
        init() { return this; },
        open() { renderFailure(); this.ui?.render?.(); return this; },
        bindUi(root) { this.ui?.bind?.(root); return this; },
        bindSettings(root) { this.ui?.bindSettings?.(root); return this; },
        refreshTemplates() { return this.ui?.refreshTemplates?.(); },
        refreshUi() { return this.ui?.refreshTemplates?.(); },
        resetAfterStorageClear() { this.ui?.resetForChat?.(); this.ui?.render?.(); return this; },
        leave() { this.ui?.closeVisual?.(); return this; },
        onChatChanged() { this.abort('chat-boundary'); failureNotes.clearAll(); renderFailure(); this.ui?.resetForChat?.(); },
        onPluginDisabled() { this.abort('plugin-disabled'); this.ui?.closeVisual?.(); this.ui?.clearRetry?.(); this.ui?.clearTransient?.(); },
        onPanelClosed() { this.ui?.closeVisual?.(); this.ui?.clearRetry?.(); },
        destroy() { this.abort('destroyed'); this.ui?.destroy?.(); },
        get busy() { return controller.busy; },
    };
    if (env.ui) feature.ui = createTheaterUi({ repository: env.repository, templates: env.templates, resolveRegen: env.resolveRegen, draftCap: env.draftCap, ...env.ui, feature });
    return feature;
}
