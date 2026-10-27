import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { createTheaterRepository } from './repository.js';
import { createTheaterFeature } from './feature.js';
import { createTheaterGeneration } from './generation.js';
import { createTheaterStoryContext } from './context.js';
import { buildWriteMessages, buildBeautifyMessages } from './prompts.js';
import { sanitizeHtml, safePlainTextHtml } from './html.js';
import { createTheaterTemplates } from './templates.js';
import { THEATER_TEMPLATE_BOOK, THEATER_DRAFT_CAP, theaterDraftKey } from './constants.js';
import { getChatRoot, prepareNormalChatStoreForSave, registerChatStorageContext } from '../../runtime/chat-storage.js';

export function createTheaterRuntime(host = {}) {
    registerChatStorageContext(host.getContext);
    const owners = createTaskOwnerManager();
    const captureTarget = (chatId = host.getContext?.()?.chatId) => {
        const context = host.getContext?.(); context.chatMetadata ||= {};
        const metadata = getChatRoot('sp-theater', { create: true, factory: () => ({ version: 1, saved: [] }) });
        return { chatId, metadata, persist: () => { prepareNormalChatStoreForSave(context); return context.saveMetadata?.(); }, isCurrent: () => true };
    };
    const repository = createTheaterRepository({
        storage: host.storage, metadata: () => captureTarget().metadata, persist: () => { const context = host.getContext?.(); prepareNormalChatStoreForSave(context); return context?.saveMetadata?.(); },
        keyForChat: host.keyForChat || theaterDraftKey, cap: THEATER_DRAFT_CAP,
    });
    const templates = createTheaterTemplates({ context: host.getContext, bookName: THEATER_TEMPLATE_BOOK });
    const generation = createTheaterGeneration({
        write: host.callTheaterApi, beautify: host.callTheaterApi,
        buildWriteMessages: (input, options, settings) => buildWriteMessages(input, { ...(options?.storyContext || {}), userName: options?.userName || '用户', charName: options?.charName || '角色', sysBlocks: Array.isArray(options?.storyContext?.sysBlocks) ? options.storyContext.sysBlocks : [] }, settings),
        buildBeautifyMessages, sanitize: sanitizeHtml, plainTextFallback: safePlainTextHtml,
        onDiagnostic: host.onDiagnostic,
    });
    const storyContext = createTheaterStoryContext({ getContext: host.getContext, buildWorldInfoContext: host.buildWorldInfoContext, readCardExtras: host.readCardExtras, buildRecentContext: host.buildRecentContext, getRecentMesIds: host.getRecentMesIds, getMemText: host.getMemText, owners });
    const feature = createTheaterFeature({
        repository, templates, generation, owners, captureTarget, draftCap: THEATER_DRAFT_CAP,
        resolveRegen: (piece, fallback) => ({ input: String(piece?.request || piece?.templateSource?.input || fallback || '').trim(), templateSource: piece?.templateSource?.input ? { ...piece.templateSource, input: String(piece.templateSource.input).trim() } : null }),
        generate: (...args) => generation(...args), chatId: () => host.getContext?.().chatId, chatRevision: () => owners.currentChatRevision(),
        names: host.names, settings: host.settings, storyContext: owner => storyContext(owner), stage: host.stage, current: () => {},
        ui: { host: host.ports },
    });
    return { feature, owners, repository, generation, templates, storyContext, captureTarget };
}
