import { theaterId } from './schema.js';

import { createGenerationDiagnosticScope, makeDiagnosticError, safeDiagnosticLog } from '../../api/diagnostics.js';
export function createTheaterGeneration({ write, beautify, buildWriteMessages, buildBeautifyMessages, sanitize, fallback, plainTextFallback, onDiagnostic, makeId = () => theaterId() } = {}) {
    return async function generateTheater(input, { signal, onStage, templateSource, userName, charName, storyContext, settings = {}, isCurrent = () => true, diagnosticScope = null } = {}) {
        const diagnostic = diagnosticScope || createGenerationDiagnosticScope('theater-generation');
        if (!String(input || '').trim()) throw new Error('请先填写小剧场需求');
        // Owner-frozen names are authoritative even if a stale/malformed story
        // snapshot carries its own reversed names.
        const frozenStoryContext = { ...(storyContext || {}), userName, charName };
        onStage?.('折射');
        const raw = await write(buildWriteMessages(input, { userName, charName, storyContext: frozenStoryContext }, settings), { maxTokens: 30000, signal, userName, charName, promptMode: 'creative', diagnosticModule: 'theater-generation', diagnosticSink: diagnostic.sink });
        if (!String(raw || '').trim()) throw diagnostic.rejected(makeDiagnosticError('empty-output', { phase: 'empty-output' }), { phase: 'parse', reasonCode: 'theater-empty-draft' });
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        diagnostic.accepted({ phase: 'validation', reasonCode: 'theater-draft-valid' });
        onStage?.('渲染');
        let htmlRaw = '';
        const beautifyDiagnostic = createGenerationDiagnosticScope('theater-beautify');
        let beautifyAccepted = false;
        try {
            htmlRaw = await beautify(buildBeautifyMessages(raw, { userName, charName }, settings), { maxTokens: 30000, signal, userName, charName, promptMode: 'mechanical', diagnosticModule: 'theater-beautify', diagnosticSink: beautifyDiagnostic.sink });
            if (!String(htmlRaw || '').trim()) throw makeDiagnosticError('empty-output', { phase: 'empty-output' });
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
        // 宿主回退可能触发额外格式化，只有美化空/失败时才调用，成功 HTML 不应被二次改写。
        const hasBeautifiedHtml = String(htmlRaw || '').trim();
        let html;
        let fallbackRaw = raw;
        let rendererFailed = false;
        let beautifyApplied = false;
        if (!hasBeautifiedHtml) {
            try { fallbackRaw = fallback ? await fallback(raw) : raw; }
            catch (error) { if (error?.name === 'AbortError') throw error; if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' }); diagnostic.fallback(error, { reasonCode: 'renderer-fallback' }); onDiagnostic?.(safeDiagnosticLog('theater', 'recoverable-fallback', error)); rendererFailed = true; }
        }
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        if (rendererFailed) {
            // renderer 已失败，不能再把原文交回 sanitize；纯文本兜底负责完整转义。
            html = plainTextFallback ? plainTextFallback(raw) : raw;
        } else {
            try {
                if (typeof sanitize !== 'function') throw new Error('sanitize unavailable');
                html = sanitize(hasBeautifiedHtml ? htmlRaw : fallbackRaw);
                beautifyApplied = Boolean(hasBeautifiedHtml && String(html || '').trim());
            } catch (error) {
                if (hasBeautifiedHtml) beautifyDiagnostic.fallback(error, { reasonCode: 'beautify-sanitize-fallback' });
                html = plainTextFallback ? plainTextFallback(raw) : fallbackRaw;
            }
            if (!String(html || '').trim()) {
                if (hasBeautifiedHtml) beautifyDiagnostic.fallback(makeDiagnosticError('invalid-structure', { phase: 'validation' }), { reasonCode: 'beautify-empty-after-sanitize' });
                html = plainTextFallback ? plainTextFallback(raw) : fallbackRaw;
            }
        }
        if (beautifyAccepted && beautifyApplied) beautifyDiagnostic.committed({ reasonCode: 'beautify-applied' });
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        return { id: makeId(), title: '', raw: String(raw), request: String(input).trim(), html, ts: Date.now(), templateSource: templateSource?.input ? { ...templateSource, input: String(templateSource.input) } : undefined };
    };
}
