import { parseOutline } from './schema.js';
import { buildOutlineInjectionText, OUTLINE_INJECT_DEPTH, OUTLINE_INJECT_KEY } from './prompts.js';

export function createOutlineInjection({ repository, context, settings, injectEnabled, cleanText } = {}) {
    const clear = () => {
        const ctx = context?.();
        if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(OUTLINE_INJECT_KEY, '');
    };
    const refresh = (target = repository.capture()) => {
        const ctx = context?.();
        if (typeof ctx?.setExtensionPrompt !== 'function') return;
        if (!repository.isCurrent(target)) return;
        if (!injectEnabled?.() || settings?.().outlineInject !== true) {
            clear();
            return;
        }
        let beats = [];
        let cursor = 0;
        try {
            const saved = repository.readOutline(target);
            if (saved?.raw) {
                beats = parseOutline(saved.raw);
                cursor = repository.cursor(target);
            }
        } catch {
            beats = [];
        }
        if (!beats.length || cursor < 1) {
            clear();
            return;
        }
        const promptType = ctx.constants?.promptTypes?.IN_CHAT ?? 1;
        const promptRole = ctx.constants?.promptRoles?.SYSTEM ?? 0;
        ctx.setExtensionPrompt(
            OUTLINE_INJECT_KEY,
            buildOutlineInjectionText(beats, cursor, cleanText),
            promptType,
            OUTLINE_INJECT_DEPTH,
            false,
            promptRole,
        );
    };
    return Object.freeze({ refresh, clear, key: OUTLINE_INJECT_KEY, depth: OUTLINE_INJECT_DEPTH });
}
