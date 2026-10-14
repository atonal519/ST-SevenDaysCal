// Shared, deliberately lossy diagnostics for AI generation paths.
// Never copy upstream response bodies, URLs, prompts, keys, or model output here.
import { isDiagnosticRequestId, safeSaveDiagnosticFields, traceDiagnosticEvent } from '../runtime/diagnostic-trace.js';
import { recordDiagnosticResult } from '../runtime/external-chat-storage.js';
import { captureLocalGenerationDiagnostic } from '../runtime/local-diagnostics.js';

const CODES = new Set([
    'config-missing', 'http-400', 'auth', 'not-found', 'rate-limit', 'server',
    'timeout', 'upstream-timeout', 'network', 'invalid-json', 'response-error', 'empty-output', 'truncated', 'sse-invalid', 'unknown',
    'parse', 'invalid-structure', 'invalid-fields', 'save', 'recoverable-fallback', 'memory-stale', 'memory-read',
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
    'http-400': '接口不接受当前请求参数，请检查模型配置或移除不支持的参数。',
    auth: '接口拒绝访问，请检查 Key 和模型权限。',
    'not-found': 'AI 接口地址不可用，请检查 Base URL。',
    'rate-limit': 'AI 请求触发限流，请稍后重试或检查额度。',
    server: 'AI 服务暂时异常，请稍后重试。',
    timeout: 'AI 请求超时，请稍后重试或缩短发送给模型的内容。',
    'upstream-timeout': 'AI 服务报告超时，本次未自动重试；请稍后重试或缩短发送给模型的内容。',
    network: '网络连接中断，请检查网络后重试。',
    'invalid-json': 'AI 接口返回内容无法读取，请检查接口兼容性后重试。',
    'response-error': 'AI 接口返回错误，没有可用正文；请检查接口状态和模型权限。',
    'empty-output': 'AI 没有返回可用正文，请调整模型或提示词后重试。',
    truncated: 'AI 回复被截断，不完整内容未保存；请缩短上下文或分段处理。',
    'sse-invalid': 'AI 流式回复损坏，不完整内容未保存；请重试。',
    parse: 'AI 已回复，但内容格式无法识别；原有内容未改变，请重试。',
    'invalid-structure': 'AI 已回复，但内容结构不完整；原有内容未改变，请重试。',
    'invalid-fields': 'AI 已回复，但有必需字段不符合要求；原有内容未改变，请重试。',
    save: '内容已生成，但未确认保存完成；请检查当前内容后重试。',
    'recoverable-fallback': '美化失败，已保留原稿。',
    'memory-stale': '本次记忆预检已失效，请重新生成。',
    'memory-read': '所选记忆源读取失败，请检查读取接口和当前聊天绑定后重试。',
    unknown: 'AI 生成失败，请稍后重试。',
});

export function diagnosticMessage(error, options = {}) {
    const code = classifyGenerationError(error, options);
    const save = error?.saveResult;
    if (code === 'save' && save?.reason === 'unsupported-core-contract' && save?.commitState === 'not-dispatched') {
        return '未发出保存：当前宿主缺少可用的安全保存接口，原有线没有被本次候选覆盖。请确认宿主兼容后再试。';
    }
    if (code === 'save' && save?.commitState === 'unknown') {
        return '保存请求已开始，但宿主尚未返回确认。请刷新当前聊天核实保存结果，确认前不要重复生成。';
    }
    if (code === 'save' && save?.commitState === 'conflict') {
        return '当前聊天保存版本已变化，本次未覆盖；请刷新核实后再继续。';
    }
    let message = MESSAGES[code] || MESSAGES.unknown;
    if (code === 'server') {
        const status = Number(error?.status ?? options.status);
        const attempt = Number(error?.attempt ?? options.attempt);
        if (Number.isInteger(status) && status >= 500) {
            message = Number.isInteger(attempt) && attempt > 0
            ? `AI 服务暂时异常，已尝试 ${attempt} 次仍失败，请稍后重试。`
                : 'AI 服务暂时异常，请稍后重试。';
        }
    }
    if (code === 'timeout') {
        const seconds = safeTimeoutSeconds(error?.timeoutSec ?? options.timeoutSec);
        const status = Number(error?.status ?? options.status);
        message = Number.isInteger(status) && status >= 200 && status < 300
            ? `AI 已响应，但内容读取超过 ${seconds} 秒仍未完成；本次未自动重试。`
            : `等待 AI 回复超过 ${seconds} 秒，本次未自动重试。`;
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
    const startedAt = Date.now();
    const runId = `run-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let metadata = Object.freeze({ module: safeModule, requestId: '', runId, startedAt });
    captureLocalGenerationDiagnostic({ runId, module: safeModule, startedAt, result: { processing: 'preparing', commit: 'not-requested', ui: 'not-requested', events: [] } });
    const sink = value => {
        const requestId = typeof value?.requestId === 'string' && isDiagnosticRequestId(value.requestId) ? value.requestId : '';
        if (requestId) {
            metadata = Object.freeze({ module: safeModule, requestId, runId, startedAt, apiStartedAt: Number(value?.startedAt) || Date.now() });
            captureLocalGenerationDiagnostic({ requestId, runId, module: safeModule, startedAt: metadata.apiStartedAt, runStartedAt: startedAt });
        }
    };
    const annotate = error => attachDiagnosticRequest(error, metadata);
    const record = (event, options = {}) => {
        const error = annotate(options.error);
        const saveDetails = safeSaveDiagnosticFields(error?.saveResult);
        const uiError = event === 'generation-ui-failed' && error ? {
            errorName: String(error.name || 'Error').slice(0, 80),
            errorMessage: String(error.message || error).replace(/(?:Bearer\s+)\S+/gi, '[redacted]').slice(0, 500),
            ...(error.stack ? { errorStack: String(error.stack).replace(/(?:Bearer\s+)\S+/gi, '[redacted]').slice(0, 1200) } : {}),
        } : {};
        const traced = traceDiagnosticEvent(event, {
            module: safeModule,
            ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
            status: options.status,
            phase: options.phase,
            reasonCode: options.reasonCode,
            errorClass: error ? classifyGenerationError(error, { phase: options.phase }) : undefined,
            ...uiError,
            background: defaults.background === true || options.background === true,
            ...saveDetails,
        });
        if (metadata.requestId) recordDiagnosticResult({
            requestId: metadata.requestId,
            module: safeModule,
            event,
            status: options.status,
            phase: options.phase,
            reasonCode: options.reasonCode,
            errorClass: error ? classifyGenerationError(error, { phase: options.phase }) : undefined,
            privateDetails: uiError,
            ...saveDetails,
        });
        else captureLocalGenerationDiagnostic({ runId, module: safeModule, startedAt, event: {
            event, status: options.status || event, phase: options.phase, reasonCode: options.reasonCode,
            errorClass: error ? classifyGenerationError(error, { phase: options.phase }) : undefined,
            ...uiError,
            ...saveDetails,
        } });
        return traced;
    };
    return Object.freeze({
        sink,
        annotate,
        accepted: options => record('generation-accepted', { ...options, status: 'accepted' }),
        rejected: (error, options = {}) => { annotate(error); record('generation-rejected', { ...options, error, status: 'rejected' }); return error; },
        committed: options => record('generation-committed', { ...options, status: 'committed', phase: options?.phase || 'save' }),
        // Ordinary chat_metadata writes report local application, never a remote save acknowledgement.
        locallyApplied: options => record('generation-locally-applied', { ...options, status: 'local-applied', phase: options?.phase || 'save' }),
        uiFailed: (error, options = {}) => { annotate(error); record('generation-ui-failed', { ...options, error, status: 'failed', phase: 'ui' }); return error; },
        uiDisplayed: options => record('generation-ui-displayed', { ...options, status: 'displayed', phase: 'ui' }),
        fallback: (error, options = {}) => { annotate(error); record('generation-fallback', { ...options, error, status: 'fallback', phase: options.phase || 'recoverable-fallback' }); return error; },
        metadata: () => metadata,
    });
}

// 保存已经确认后，toast/render/refresh/cleanup 都只能作为 UI 副作用失败记录，不能再把
// 已落盘的生成结果改判成 AI/API/保存失败。调用方可不传 diagnostic，先安全捕获后再在
// generation-committed 之后补记同一个请求 scope。
export async function runGenerationUiEffect(callback, { diagnostic = null, reasonCode = 'generation-ui-failed', reportDisplayed = true } = {}) {
    try { const value = await callback?.(); if (reportDisplayed) diagnostic?.uiDisplayed?.(); return { ok: true, value }; }
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
        ...safeSaveDiagnosticFields(error?.saveResult),
    });
}
