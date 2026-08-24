// 刻度错误只输出有限的安全摘要；不得把原始错误文本送到 UI 或控制台。
const statusOf = error => {
    const values = [error?.status, error?.statusCode, error?.httpStatus, error?.response?.status, error?.code];
    return values.map(value => Number(value)).find(value => Number.isInteger(value) && value >= 100 && value <= 599) || null;
};
const textOf = error => typeof error === 'string' ? error : (typeof error?.message === 'string' ? error.message : '');
export function safeLedgerErrorMessage(error) {
    const raw = textOf(error).toLowerCase();
    const match = raw.match(/\b([1-5]\d\d)\b/);
    const status = statusOf(error) || (match ? Number(match[1]) : null);
    if (status === 401) return 'HTTP 401 未授权';
    if (status === 403) return 'HTTP 403 禁止访问';
    if (status === 404) return 'HTTP 404 地址不存在';
    if (status === 408) return 'HTTP 408 请求超时';
    if (status === 429) return 'HTTP 429 请求过于频繁';
    if (status >= 500) return `HTTP ${status} 服务端错误`;
    if (/\b(timeout|timed?\s*out|etimedout|请求超时|超时)/i.test(raw)) return '请求超时';
    if (/\b(network|fetch failed|econnreset|econnrefused|enotfound|网络错误|网络失败|连接失败|无法连接)/i.test(raw)) return '网络连接失败';
    if (status) return `HTTP ${status} 请求失败`;
    return '';
}
export function markLedgerError(error, meta = {}) {
    if (!error || typeof error !== 'object') return error;
    if (meta.ledgerPhase) error.ledgerPhase = meta.ledgerPhase;
    else if (meta.phase) error.ledgerPhase = meta.phase;
    if (meta.batchNo != null && error.ledgerBatchNo == null) error.ledgerBatchNo = meta.batchNo;
    if (meta.batchTotal != null && error.ledgerBatchTotal == null) error.ledgerBatchTotal = meta.batchTotal;
    return error;
}
export function ledgerFailureDiagnostic(error, meta = {}) {
    const phase = String(meta.ledgerPhase || meta.phase || error?.ledgerPhase || '').trim() || 'unknown';
    const batchNo = meta.batchNo ?? error?.ledgerBatchNo, batchTotal = meta.batchTotal ?? error?.ledgerBatchTotal;
    return { phase, ...(batchNo != null ? { batchNo: Number(batchNo) } : {}), ...(batchTotal != null ? { batchTotal: Number(batchTotal) } : {}), reason: safeLedgerErrorMessage(error) || null };
}
export function ledgerFailureText(prefix, error, meta = {}) {
    const diagnostic = ledgerFailureDiagnostic(error, meta);
    const phaseText = { 'capture-request': '标注请求', 'source-provenance': diagnostic.batchNo != null && diagnostic.batchTotal != null ? `来源溯源第 ${diagnostic.batchNo}/${diagnostic.batchTotal} 批` : '来源溯源', 'judge-request': '判定请求' }[diagnostic.phase];
    const detail = diagnostic.reason ? [phaseText, diagnostic.reason].filter(Boolean).join('：') : '';
    return `${prefix}：${detail || '请检查 API 或网络'}`;
}
export function logLedgerFailure(error, meta = {}) { try { console.error('[SP ledger failure]', ledgerFailureDiagnostic(error, meta)); } catch {} }
