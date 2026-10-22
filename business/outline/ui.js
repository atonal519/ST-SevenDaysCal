import { icon } from '../../utils/icons.js';
import { classifyGenerationError, diagnosticMessage } from '../../api/diagnostics.js';

export function createOutlineUi(host = {}) {
    let controllers = null;
    let bound = false;
    const injectTexts = new Map();
    const copyTexts = new Map();
    let injectSequence = 0;
    let copySequence = 0;
    const query = selector => host.query?.(selector);
    const fallbackEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
    const setOutline = html => host.setOutline?.(html);
    const setLoading = (label = '正在构思面') => setOutline(host.loading?.(label, 'sp-abort-outline') || '');
    const toast = (message, error = false) => host.toast?.(message, error);
    const showGenerationError = error => {
        const retry = classifyGenerationError(error) === 'config-missing' ? '' : '<button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">重新生成面</button>';
        setOutline(`<div class="sp-error">${icon("alert-circle")}<p>生成失败：${fallbackEscape(diagnosticMessage(error))}</p>${retry}</div>`);
    };
    const showPreflightError = message => setOutline(`<div class="sp-error">${icon("alert-circle")}<p>${fallbackEscape(message || '记忆读取失败，请重试')}</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">重新生成面</button></div>`);
    const bind = () => {
        if (bound) return;
        const $root = query('#sp-outline-wrap');
        if (!$root?.length) return;
        bound = true;
        $root.off('.spOutlineFeature');
        $root.on('click.spOutlineFeature', '#sp-gen-outline-now, .sp-refresh-outline', () => void controllers.generation.trigger({ reroll: true, module: 'outline' }));
        $root.on('click.spOutlineFeature', '#sp-abort-outline', () => controllers.generation.abort());
        $root.on('click.spOutlineFeature', '#sp-open-space-discussion', () => {
            host.openSpaceDiscussion?.('你觉得当前面的剧情方向有哪些可调整之处？');
        });
    };
    return Object.freeze({
        bindControllers: value => { controllers = value; },
        bind,
        makeInjectButton: text => { const id = String(++injectSequence); injectTexts.set(id, text); return id; },
        makeCopyButton: text => { const id = String(++copySequence); copyTexts.set(id, text); return id; },
        resetTextMaps: () => { injectTexts.clear(); copyTexts.clear(); },
        getInjectText: id => injectTexts.get(String(id)),
        getCopyText: id => copyTexts.get(String(id)),
        setOutline,
        setFailureHtml: html => host.setFailureHtml?.(html),
        setLoading,
        showGenerationError,
        showPreflightError,
        toast,
        closedSuccess: () => host.closedSuccess?.(),
        isOutlineMode: () => !!host.isOutlineMode?.(),
        isPanelVisible: () => !!host.isPanelVisible?.(),
    });
}
