import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { createTheaterRepository } from './repository.js';
import { createTheaterFeature } from './feature.js';
import { createTheaterGeneration } from './generation.js';
import { createTheaterStoryContext } from './context.js';
import { buildWriteMessages, buildBeautifyMessages } from './prompts.js';
import { sanitizeHtml, safePlainTextHtml } from './html.js';
import { createTheaterTemplates } from './templates.js';
import { THEATER_TEMPLATE_BOOK, THEATER_DRAFT_CAP, theaterDraftKey } from './constants.js';
import { getChatRoot, isExternalMode, persistExternalRoots, registerExternalStorageContext } from '../../runtime/external-chat-storage.js';

export function createTheaterRuntime(host = {}) {
    registerExternalStorageContext(host.getContext);
    const owners = createTaskOwnerManager();
    const storageSaver = {
        supported: true,
        capture: target => target?.external ? { external: true } : null,
        dispatch: (captured, options) => captured?.external
            ? persistExternalRoots({ confirmed: true, ownerGuard: options?.isCurrent })
            : Promise.resolve({ ok: false, commitState: 'not-dispatched' }),
        confirm: () => Promise.resolve({ confirmed: false, available: false }),
    };
    const captureTarget = (chatId = host.getContext?.()?.chatId) => {
        const context = host.getContext?.(); context.chatMetadata ||= {};
        const external = isExternalMode();
        const metadata = getChatRoot('sp-theater', { create: true, factory: () => ({ version: 1, saved: [] }) });
        // The metadata/file target and its real CAS remain fixed; changing the visible chat is not a cancellation signal.
        return { chatId, metadata, external, metadataSnapshot: { ...(context.chatMetadata || {}) }, target: external ? { external: true } : host.coreModule?.resolveChatStateTarget?.(), persist: () => external ? persistExternalRoots({ confirmed: true }) : context.saveMetadata?.(), isCurrent: () => true };
    };
    const repository = createTheaterRepository({
        storage: host.storage, metadata: () => captureTarget().metadata, persist: () => host.getContext?.().saveMetadata?.(),
        keyForChat: host.keyForChat || theaterDraftKey, metadataSaver: storageSaver.supported ? storageSaver : null, requireFixedSaver: storageSaver.supported, cap: THEATER_DRAFT_CAP,
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
