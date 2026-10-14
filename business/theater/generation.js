import { theaterId } from './schema.js';
import { extractTheaterHtmlResponse } from './html.js';

import { createGenerationDiagnosticScope, makeDiagnosticError, safeDiagnosticLog } from '../../api/diagnostics.js';
export function createTheaterGeneration({ write, beautify, buildWriteMessages, buildBeautifyMessages, sanitize, plainTextFallback, onDiagnostic, makeId = () => theaterId() } = {}) {
    return async function generateTheater(input, { signal, onStage, templateSource, explicitTitle, userName, charName, storyContext, settings = {}, isCurrent = () => true, diagnosticScope = null } = {}) {
        const diagnostic = diagnosticScope || createGenerationDiagnosticScope('theater-generation');
        if (!String(input || '').trim()) throw new Error('请先填写小剧场需求');
        // Owner-frozen names are authoritative even if a stale/malformed story
        // snapshot carries its own reversed names.
        const frozenStoryContext = { ...(storyContext || {}), userName, charName };
        onStage?.('折射');
        const raw = await write(buildWriteMessages(input, { userName, charName, storyContext: frozenStoryContext }, settings), { signal, userName, charName, promptMode: 'creative', diagnosticModule: 'theater-generation', diagnosticSink: diagnostic.sink });
        if (!String(raw || '').trim()) throw diagnostic.rejected(makeDiagnosticError('empty-output', { phase: 'empty-output' }), { phase: 'parse', reasonCode: 'theater-empty-draft' });
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        diagnostic.accepted({ phase: 'validation', reasonCode: 'theater-draft-valid' });
        onStage?.('渲染');
        let htmlRaw = '';
        const beautifyDiagnostic = createGenerationDiagnosticScope('theater-beautify');
        let beautifyAccepted = false;
        try {
            const response = await beautify(buildBeautifyMessages(raw, settings), { signal, userName, charName, promptMode: 'mechanical', diagnosticModule: 'theater-beautify', diagnosticSink: beautifyDiagnostic.sink });
            htmlRaw = extractTheaterHtmlResponse(response);
            if (!htmlRaw) throw makeDiagnosticError('invalid-structure', { phase: 'validation' });
            beautifyDiagnostic.accepted({ phase: 'validation', reasonCode: 'beautify-valid' });
            beautifyAccepted = true;
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
            htmlRaw = '';
            beautifyDiagnostic.fallback(error, { reasonCode: 'beautify-api-fallback' });
            onDiagnostic?.(safeDiagnosticLog('theater', 'recoverable-fallback', error));
        }
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        const hasBeautifiedHtml = String(htmlRaw || '').trim();
        let html;
        let beautifyApplied = false;
        if (!hasBeautifiedHtml) {
            html = plainTextFallback ? plainTextFallback(raw) : raw;
        } else {
            try {
                if (typeof sanitize !== 'function') throw new Error('sanitize unavailable');
                html = sanitize(htmlRaw);
                beautifyApplied = Boolean(hasBeautifiedHtml && String(html || '').trim());
            } catch (error) {
                if (hasBeautifiedHtml) beautifyDiagnostic.fallback(error, { reasonCode: 'beautify-sanitize-fallback' });
                html = plainTextFallback ? plainTextFallback(raw) : raw;
            }
            if (!String(html || '').trim()) {
                if (hasBeautifiedHtml) beautifyDiagnostic.fallback(makeDiagnosticError('invalid-structure', { phase: 'validation' }), { reasonCode: 'beautify-empty-after-sanitize' });
                html = plainTextFallback ? plainTextFallback(raw) : raw;
            }
        }
        if (beautifyAccepted && beautifyApplied) beautifyDiagnostic.committed({ reasonCode: 'beautify-applied' });
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        const title = explicitTitle === undefined ? String(templateSource?.title || '').trim() : String(explicitTitle ?? '').trim();
        return { id: makeId(), title, raw: String(raw), request: String(input).trim(), html, ts: Date.now(), templateSource: templateSource?.input ? { ...templateSource, input: String(templateSource.input) } : undefined };
    };
}
