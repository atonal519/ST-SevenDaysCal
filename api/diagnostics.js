// Shared, deliberately lossy diagnostics for AI generation paths.
// Never copy upstream response bodies, URLs, prompts, keys, or model output here.
import { isDiagnosticRequestId, traceDiagnosticEvent } from '../runtime/diagnostic-trace.js';

const CODES = new Set([
    'config-missing', 'http-400', 'auth', 'not-found', 'rate-limit', 'server',
    'timeout', 'network', 'invalid-json', 'response-error', 'empty-output', 'truncated', 'sse-invalid', 'unknown',
    'parse', 'invalid-structure', 'invalid-fields', 'save', 'recoverable-fallback',
]);

export function classifyGenerationError(error, { status = 0, phase = 'request' } = {}) {
    status = Number(status || error?.status || 0);
    const code = String(error?.diagnosticCode || '').trim();
    if (CODES.has(code)) return code;
    const name = String(error?.name || '').toLowerCase();
    const text = String(error?.message || error || '').toLowerCase();
    if (name === 'aborterror' || error?.aborted) return 'unknown';
    if (phase === 'empty-output' || text.includes('empty-output')) return 'empty-output';
    if (phase === 'truncated' || text.includes('truncat')) return 'truncated';
    if (phase === 'parse') return 'parse';
    if (phase === 'invalid-structure') return 'invalid-structure';
    if (phase === 'invalid-fields') return 'invalid-fields';
    if (phase === 'save') return 'save';
    if (name === 'timeouterror' || text.includes('timeout') || text.includes('超时')) return 'timeout';
    if (status === 400) return 'http-400';
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'not-found';
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server';
    if (name === 'typeerror' || /network|fetch failed|econnreset|socket hang up|连接/.test(text)) return 'network';
    if (phase === 'recoverable-fallback') return 'recoverable-fallback';
    return 'unknown';
}

const MESSAGES = Object.freeze({
    'config-missing': '请先配置 API',
    'http-400': 'AI 请求参数不被接口接受。请检查模型配置或在“剔除参数”中移除不支持的参数。',
    auth: 'AI API Key 无效或没有权限，请检查 Key 和模型权限。',
    'not-found': 'AI 接口地址不可用（404），请检查 Base URL。',
    'rate-limit': 'AI 请求触发限流，请稍后重试或检查额度。',
    server: 'AI 服务暂时异常，请稍后重试。',
    timeout: 'AI 请求超时，请稍后重试或调大请求超时。',
    network: '网络连接中断，请检查网络后重试。',
    'invalid-json': 'AI 接口已响应，但响应包不是有效 JSON，构画无法读取正文；请重试或检查接口兼容性。',
    'response-error': 'AI 接口已响应，但返回的是错误包而非正文；请检查接口状态、额度或模型权限。',
    'empty-output': 'AI 没有返回可用正文，请调整模型或提示词后重试。',
    truncated: 'AI 输出达到上限，未保存完整结果；请提高输出上限或缩短提示词。',
    'sse-invalid': 'AI 流式响应损坏，未保存不完整结果；请重试。',
    parse: '模型已返回，但构画未识别出该模块要求的格式；原有内容未改变，请重试。',
    'invalid-structure': '模型已返回，构画已识别格式，但结构未通过本地校验；原有内容未改变，请重试。',
    'invalid-fields': '模型已返回，构画已识别格式，但字段未通过本地校验；原有内容未改变，请重试。',
    save: '内容已生成，但未确认保存完成；请检查当前内容后重试。',
    'recoverable-fallback': '美化失败，已保留原稿。',
    unknown: 'AI 生成失败，请稍后重试。',
});

export function diagnosticMessage(error, options = {}) {
    const code = classifyGenerationError(error, options);
    let message = MESSAGES[code] || MESSAGES.unknown;
    if (code === 'server') {
        const status = Number(error?.status ?? options.status);
        const attempt = Number(error?.attempt ?? options.attempt);
        if (Number.isInteger(status) && status >= 500) {
            message = Number.isInteger(attempt) && attempt > 0
                ? `上游服务返回 HTTP ${status}；本次已尝试 ${attempt} 次仍失败，请稍后重试。`
                : `上游服务返回 HTTP ${status}，请稍后重试。`;
        }
    }
    if (code === 'timeout') {
        const seconds = safeTimeoutSeconds(error?.timeoutSec ?? options.timeoutSec);
        const status = Number(error?.status ?? options.status);
        message = Number.isInteger(status) && status >= 200 && status < 300
            ? `AI 请求超时：已收到 HTTP ${status} 响应，但正文/响应流在 ${seconds} 秒内未完成，已在本地终止。本次未自动重试。`
            : `AI 请求超时：等待 ${seconds} 秒后已在本地终止。本次未自动重试。`;
    }
    return message;
}

function safeTimeoutSeconds(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.max(1, Math.min(600, Math.round(number))) : 180;
}

function safeDiagnosticRequestId(error) {
    const requestId = typeof error?.spDiagnosticRequestId === 'string'
        ? error.spDiagnosticRequestId.trim()
        : '';
    return isDiagnosticRequestId(requestId) ? requestId : '';
}

export function makeDiagnosticError(code, options = {}) {
    const error = new Error(diagnosticMessage({ diagnosticCode: code }, options));
    error.diagnosticCode = CODES.has(code) ? code : 'unknown';
    if (Number.isInteger(options.status) && options.status > 0) error.status = options.status;
    if (options.phase) error.phase = String(options.phase);
    if (options.retryable !== undefined) error.retryable = !!options.retryable;
    if (Number.isInteger(options.attempt) && options.attempt > 0) error.attempt = options.attempt;
    if (error.diagnosticCode === 'timeout') error.timeoutSec = safeTimeoutSeconds(options.timeoutSec);
    return error;
}

export function attachDiagnosticRequest(error, metadata = {}) {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
    const requestId = typeof metadata?.requestId === 'string' ? metadata.requestId.trim() : '';
    if (!isDiagnosticRequestId(requestId)) return error;
    try {
        error.spDiagnosticRequestId ||= requestId;
        if (metadata.module) error.spDiagnosticModule ||= String(metadata.module);
    } catch {}
    return error;
}

// 成功响应仍保持普通字符串合同；调用方只通过这个安全 sink 接收请求号，再记录业务终点。
export function createGenerationDiagnosticScope(module, defaults = {}) {
    const safeModule = String(module || 'generation');
    let metadata = Object.freeze({ module: safeModule, requestId: '' });
    const sink = value => {
        const requestId = typeof value?.requestId === 'string' && isDiagnosticRequestId(value.requestId) ? value.requestId : '';
        if (requestId) metadata = Object.freeze({ module: safeModule, requestId });
    };
    const annotate = error => attachDiagnosticRequest(error, metadata);
    const record = (event, options = {}) => {
        const error = annotate(options.error);
        return traceDiagnosticEvent(event, {
            module: safeModule,
            ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
            status: options.status,
            phase: options.phase,
            reasonCode: options.reasonCode,
            errorClass: error ? classifyGenerationError(error, { phase: options.phase }) : undefined,
            background: defaults.background === true || options.background === true,
        });
    };
    return Object.freeze({
        sink,
        annotate,
        accepted: options => record('generation-accepted', { ...options, status: 'accepted' }),
        rejected: (error, options = {}) => { annotate(error); record('generation-rejected', { ...options, error, status: 'rejected' }); return error; },
        committed: options => record('generation-committed', { ...options, status: 'committed', phase: options?.phase || 'save' }),
        uiFailed: (error, options = {}) => { annotate(error); record('generation-ui-failed', { ...options, error, status: 'failed', phase: 'ui' }); return error; },
        fallback: (error, options = {}) => { annotate(error); record('generation-fallback', { ...options, error, status: 'fallback', phase: options.phase || 'recoverable-fallback' }); return error; },
        metadata: () => metadata,
    });
}

// 保存已经确认后，toast/render/refresh/cleanup 都只能作为 UI 副作用失败记录，不能再把
// 已落盘的生成结果改判成 AI/API/保存失败。调用方可不传 diagnostic，先安全捕获后再在
// generation-committed 之后补记同一个请求 scope。
export async function runGenerationUiEffect(callback, { diagnostic = null, reasonCode = 'generation-ui-failed' } = {}) {
    try { return { ok: true, value: await callback?.() }; }
    catch (error) { diagnostic?.uiFailed?.(error, { reasonCode }); return { ok: false, error }; }
}

export function shouldNotifyGeneration({ manual = false, notifyMode = 'lite', code = '' } = {}) {
    if (code === 'unknown' && !manual) return notifyMode === 'full';
    return manual || notifyMode === 'full';
}

export function safeDiagnosticLog(module, phase, error, extra = {}) {
    const requestId = safeDiagnosticRequestId(error);
    return Object.freeze({
        module: String(module || 'unknown'),
        phase: String(phase || error?.phase || 'request'),
        code: classifyGenerationError(error, { phase }),
        ...(requestId ? { requestId } : {}),
        ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
        ...(extra.background !== undefined ? { background: !!extra.background } : {}),
    });
}
