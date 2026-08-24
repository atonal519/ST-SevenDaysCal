import { theaterId } from './schema.js';

import { safeDiagnosticLog } from '../../api/diagnostics.js';
export function createTheaterGeneration({ write, beautify, buildWriteMessages, buildBeautifyMessages, sanitize, fallback, plainTextFallback, onDiagnostic, makeId = () => theaterId() } = {}) {
    return async function generateTheater(input, { signal, onStage, templateSource, userName, charName, storyContext, settings = {}, isCurrent = () => true } = {}) {
        if (!String(input || '').trim()) throw new Error('请先填写小剧场需求');
        // Owner-frozen names are authoritative even if a stale/malformed story
        // snapshot carries its own reversed names.
        const frozenStoryContext = { ...(storyContext || {}), userName, charName };
        onStage?.('折射');
        const raw = await write(buildWriteMessages(input, { userName, charName, storyContext: frozenStoryContext }, settings), { maxTokens: 30000, signal, userName, charName });
        if (!String(raw || '').trim()) throw new Error('写作 agent 返回为空，请重试或改输入');
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        onStage?.('渲染');
        let htmlRaw = '';
            try { htmlRaw = await beautify(buildBeautifyMessages(raw, { userName, charName }, settings), { maxTokens: 30000, signal, userName, charName }); }
            catch (error) { if (error?.name === 'AbortError') throw error; onDiagnostic?.(safeDiagnosticLog('theater', 'recoverable-fallback', error)); }
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        // 宿主回退可能触发额外格式化，只有美化空/失败时才调用，成功 HTML 不应被二次改写。
        const hasBeautifiedHtml = String(htmlRaw || '').trim();
        let html;
        let fallbackRaw = raw;
        let rendererFailed = false;
        if (!hasBeautifiedHtml) {
            try { fallbackRaw = fallback ? await fallback(raw) : raw; }
            catch (error) { if (error?.name === 'AbortError') throw error; onDiagnostic?.(safeDiagnosticLog('theater', 'recoverable-fallback', error)); rendererFailed = true; }
        }
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        if (rendererFailed) {
            // renderer 已失败，不能再把原文交回 sanitize；纯文本兜底负责完整转义。
            html = plainTextFallback ? plainTextFallback(raw) : raw;
        } else {
            try {
                if (typeof sanitize !== 'function') throw new Error('sanitize unavailable');
                html = sanitize(hasBeautifiedHtml ? htmlRaw : fallbackRaw);
            } catch {
                html = plainTextFallback ? plainTextFallback(raw) : fallbackRaw;
            }
            if (!String(html || '').trim()) html = plainTextFallback ? plainTextFallback(raw) : fallbackRaw;
        }
        if (!isCurrent()) throw Object.assign(new Error('theater-owner-stale'), { name: 'AbortError' });
        return { id: makeId(), title: '', raw: String(raw), request: String(input).trim(), html, ts: Date.now(), templateSource: templateSource?.input ? { ...templateSource, input: String(templateSource.input) } : undefined };
    };
}
