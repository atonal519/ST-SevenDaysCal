// Shared, deliberately lossy diagnostics for AI generation paths.
// Never copy upstream response bodies, URLs, prompts, keys, or model output here.
import { isDiagnosticRequestId } from '../runtime/diagnostic-trace.js';

const CODES = new Set([
    'config-missing', 'http-400', 'auth', 'not-found', 'rate-limit', 'server',
    'timeout', 'network', 'empty-output', 'truncated', 'sse-invalid', 'unknown',
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
    'empty-output': 'AI 没有返回可用正文，请调整模型或提示词后重试。',
    truncated: 'AI 输出达到上限，未保存完整结果；请提高输出上限或缩短提示词。',
    'sse-invalid': 'AI 流式响应损坏，未保存不完整结果；请重试。',
    parse: 'AI 返回内容无法解析，请重试。',
    'invalid-structure': 'AI 返回内容结构不完整，原有内容未改变；请重试。',
    'invalid-fields': 'AI 返回内容字段不完整，原有内容未改变；请重试。',
    save: '生成成功但保存失败，原有内容未改变；请重试。',
    'recoverable-fallback': '美化失败，已保留原稿。',
    unknown: 'AI 生成失败，请稍后重试。',
});

export function diagnosticMessage(error, options = {}) {
    const code = classifyGenerationError(error, options);
    const message = MESSAGES[code] || MESSAGES.unknown;
    const requestId = safeDiagnosticRequestId(error);
    return code === 'timeout' && requestId ? `${message}（诊断 ID：${requestId}）` : message;
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
    return error;
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
