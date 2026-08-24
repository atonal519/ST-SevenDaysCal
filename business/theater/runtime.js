import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { createTargetMetadataSaver } from '../../runtime/target-metadata-save.js';
import { createTheaterRepository } from './repository.js';
import { createTheaterFeature } from './feature.js';
import { createTheaterGeneration } from './generation.js';
import { createTheaterStoryContext } from './context.js';
import { buildWriteMessages, buildBeautifyMessages } from './prompts.js';
import { sanitizeHtml, safePlainTextHtml } from './html.js';
import { createTheaterTemplates } from './templates.js';
import { THEATER_TEMPLATE_BOOK, THEATER_DRAFT_CAP, theaterDraftKey } from './constants.js';

export function createTheaterRuntime(host = {}) {
    const owners = createTaskOwnerManager();
    const fixedSaver = createTargetMetadataSaver({ coreModule: host.coreModule, ownedRoots: ['/sp-theater'] });
    const captureTarget = (chatId = host.getContext?.()?.chatId) => {
        const context = host.getContext?.(); context.chatMetadata ||= {};
        const metadata = context.chatMetadata['sp-theater'] ||= { version: 1, saved: [] };
        return { chatId, metadata, metadataSnapshot: { ...(context.chatMetadata || {}) }, target: host.coreModule?.resolveChatStateTarget?.(), persist: () => context.saveMetadata?.(), isCurrent: () => host.getContext?.()?.chatId === chatId };
    };
    const repository = createTheaterRepository({
        storage: host.storage, metadata: () => captureTarget().metadata, persist: () => host.getContext?.().saveMetadata?.(),
        keyForChat: host.keyForChat || theaterDraftKey, metadataSaver: fixedSaver.supported ? fixedSaver : null, requireFixedSaver: fixedSaver.supported, cap: THEATER_DRAFT_CAP,
    });
    const templates = createTheaterTemplates({ context: host.getContext, bookName: THEATER_TEMPLATE_BOOK });
    const generation = createTheaterGeneration({
        write: host.callTheaterApi, beautify: host.callTheaterApi,
        buildWriteMessages: (input, options, settings) => buildWriteMessages(input, { ...(options?.storyContext || {}), userName: options?.userName || '用户', charName: options?.charName || '角色', sysBlocks: Array.isArray(options?.storyContext?.sysBlocks) ? options.storyContext.sysBlocks : [] }, settings),
        buildBeautifyMessages, sanitize: sanitizeHtml, fallback: host.renderAiMessageHtml, plainTextFallback: safePlainTextHtml,
        onDiagnostic: host.onDiagnostic,
    });
    const storyContext = createTheaterStoryContext({ getContext: host.getContext, buildWorldInfoContext: host.buildWorldInfoContext, readCardExtras: host.readCardExtras, getMemText: host.getMemText, owners });
    const feature = createTheaterFeature({
        repository, templates, generation, storyContext, owners, captureTarget, draftCap: THEATER_DRAFT_CAP,
        resolveRegen: (piece, fallback) => ({ input: String(piece?.request || piece?.templateSource?.input || fallback || '').trim(), templateSource: piece?.templateSource?.input ? { ...piece.templateSource, input: String(piece.templateSource.input).trim() } : null }),
        generate: (...args) => generation(...args), chatId: () => host.getContext?.().chatId, chatRevision: () => owners.currentChatRevision(),
        names: host.names, settings: host.settings, storyContext: owner => storyContext(owner), stage: host.stage, current: () => {},
        ui: { host: host.ports },
    });
    return { feature, owners, repository, generation, templates, storyContext, captureTarget };
}
