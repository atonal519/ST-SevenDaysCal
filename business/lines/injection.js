import { activeLines, buildLinesInjection } from './strategy.js';
import { prefixNext } from './inline.js';

export const LINES_INJECT_KEY = 'sp_lines_latent';
export const LINES_INJECT_DEPTH = 4;

export function createLinesInjectionController({ context, settings, enabled, readRaw, promptTypes = {}, promptRoles = {}, clean = value => value } = {}) {
    const refresh = () => {
        const ctx = typeof context === 'function' ? context() : context;
        if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return false;
        const clear = () => ctx.setExtensionPrompt(LINES_INJECT_KEY, '');
        const current = typeof settings === 'function' ? settings() || {} : settings || {};
        if (enabled && !enabled()) { clear(); return true; }
        if (current.linesEnabled === false || current.linesInject !== true) { clear(); return true; }
        const lines = activeLines(typeof readRaw === 'function' ? readRaw() : '', { includeTerminal: false });
        if (!lines.length) { clear(); return true; }
        const text = buildLinesInjection(lines.map(line => ({ ...line, next: line.next ? prefixNext(line.next, line.stall) : line.next }))).replace(/\r/g, '').replace(/  (.*)/g, (_, value) => `  ${clean(value)}`);
        ctx.setExtensionPrompt(LINES_INJECT_KEY, text, promptTypes.IN_CHAT ?? 1, LINES_INJECT_DEPTH, false, promptRoles.SYSTEM ?? 0);
        return true;
    };
    return { refresh, clear: () => { const ctx = typeof context === 'function' ? context() : context; ctx?.setExtensionPrompt?.(LINES_INJECT_KEY, ''); } };
}
