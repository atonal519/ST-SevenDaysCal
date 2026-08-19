// Normalize user-input OpenAI-compatible base URL:
// - '.../v1/chat/completions' → strip trailing endpoint (user pasted the wrong URL)
// - bare 'https://api.example.com' (no path) → append '/v1'
// - 'https://x/v2/coding' (custom path) → keep as-is, don't guess
export function normalizeApiUrl(url) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
    if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
    return u;
}

// 固定路由字段：这些是走 ST 代理必需的，即便用户填进剔除框也不能删（否则请求直接废掉）。
// 剔除只针对采样参数（temperature/max_tokens/presence_penalty/frequency_penalty/top_p...）。
export const PROTECTED_BODY_KEYS = new Set(['chat_completion_source', 'reverse_proxy', 'proxy_password', 'model', 'messages']);

// 把原始错误（HTTP 状态码 / 上游报文 / 网络异常）翻译成用户能照着做的提示。
// status：HTTP 状态码（无则 0）；raw：上游返回的报文或错误 message。
// 推理模型（GLM / o1 等）常把输出预算耗在思维链上，导致正文为空；
// 代理层遇到空候选会回一个 `<none>` 之类的占位错误。统一给用户一句可诊断的说明。
export function emptyContentMessage(finishReason = '') {
    const tail = finishReason === 'length'
        ? '（本次因达到输出上限被截断）'
        : '';
    return `模型没有返回正文${tail}。若使用 GLM 等推理模型，多是思维链占满了输出预算；可换非推理模型、或稍后重试。`;
}

// 占位空回：代理常以 <none>/none 之类占位符顶替空正文（GLM 等推理模型正文为空时多见）。这类回复是真值、
// 会被 extractCompletion 当正文咽下去 → 下游解析无内容、静默空转（判定看似"卡住却不报错"）。统一在此判成空，
// 让成功路径也抛错、触发失败 toast。精确匹配去空白全文、不用 includes，免误杀正文里恰好提到 <none> 的正常回复。
export function isPlaceholderContent(s) {
    const t = String(s || '').trim().toLowerCase();
    return t === '<none>' || t === 'none';
}

// 从非流式响应里提取正文：优先 content，空则兜底 reasoning_content，仍空则抛可读错误。
export function extractCompletion(data) {
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    let content = msg?.content ?? choice?.text ?? data?.content ?? '';
    if (typeof content !== 'string') content = String(content ?? '');
    content = content.trim();
    if (content && !isPlaceholderContent(content)) return content;
    // 正文为空：兜底取推理内容（至少有东西可渲染，而非白屏/报错）
    const reasoning = msg?.reasoning_content ?? msg?.reasoning ?? '';
    if (typeof reasoning === 'string' && reasoning.trim()) return reasoning.trim();
    throw new Error(emptyContentMessage(choice?.finish_reason || ''));
}

export function mapApiError(status, raw) {
    const text = String(raw || '');
    const low = text.toLowerCase();
    // 代理回传的空候选占位（GLM 等推理模型正文为空时常见）：给可读说明而非甩个 <none>
    if (low === '<none>' || low === 'none' || low.includes('<none>')) return emptyContentMessage('');
    // socket hang up / 网络中断：bbs 作者确认多为超时或网络波动
    if (low.includes('socket hang up') || low.includes('econnreset') || low.includes('network') || low.includes('fetch failed')) {
        return '网络波动或连接被中断（socket hang up）。多为线路抖动或上游超时，稍后重试；若频繁出现，可在设置里调大「请求超时」或开启「流式传输」。';
    }
    // 400 且报文里出现被拒的参数名 → 引导去剔除框
    if (status === 400) {
        const m = text.match(/(frequency_penalty|presence_penalty|temperature|top_p|top_k|max_tokens|logit_bias|seed|n)\b/i);
        const hint = m ? `参数「${m[1]}」不被该接口接受。` : '请求含该接口不支持的参数。';
        return `${hint}请到「API 配置 → 剔除参数」把它填进去（如 frequency_penalty），再重试。`;
    }
    if (status === 401 || status === 403) return 'API Key 无效或无权限（401/403）。请检查 Key 是否填对、是否有该模型权限。';
    if (status === 404) return '接口地址不对（404）。请检查 Base URL，或试试补/去掉结尾的 /v1。';
    if (status === 429) return '触发限流（429）。请求太频繁或额度用尽，稍后再试。';
    if (status >= 500) return `上游服务异常（${status}）。通常是中转站或模型服务临时故障，稍后重试。`;
    if (status) return `HTTP ${status}: ${text.slice(0, 120)}`;
    return text.slice(0, 160) || '未知错误';
}

// 读取 SSE 流（text/event-stream），拼接 delta.content。
// ST 的 generate 端点在 stream=true 时透传上游 SSE：每行 `data: {json}`，以 `data: [DONE]` 结束。
export async function readSseContent(resp) {
    const reader = resp.body?.getReader();
    if (!reader) {
        const data = await resp.json().catch(() => null);
        return data ? (data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.content ?? '') : '';
    }
    const decoder = new TextDecoder();
    let buf = '', out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            const t = line.trim();
            if (!t || !t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                if (json?.error) throw new Error(json.error.message || '返回错误');
                const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text;
                if (typeof delta === 'string') out += delta;
            } catch (e) {
                if (e instanceof Error && e.message !== 'Unexpected end of JSON input') { /* 单行解析失败忽略：可能是心跳/注释 */ }
            }
        }
    }
    return out.trim();
}

// 退避延迟（毫秒）：指数增长 + 抖动，attempt 从 1 起。若上游透传了 Retry-After 就优先听它。
// 注意：请求过 ST 代理转发，上游的 Retry-After 多半带不回来，属尽力而为，拿不到就走退避。
export function retryBackoffMs(attempt, res) {
    const ra = res?.headers?.get?.('retry-after');
    if (ra) {
        const sec = Number(ra);
        if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 15000);
        const at = Date.parse(ra);
        if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 15000);
    }
    const base = 800 * Math.pow(2, attempt - 1);   // 800ms → 1600ms → …
    return Math.min(base + Math.random() * 400, 8000);
}

// 可被外部 signal 打断的退避睡眠：等待重试期间用户点「中止」立即抛 AbortError，不干等。
export function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const onAbort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
        const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
