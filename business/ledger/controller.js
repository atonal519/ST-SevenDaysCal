// 刻度控制器协议：宿主注入 transport、提交与 chat 守卫；controller 不拥有 API 或存储实现。
export function createLedgerController({ capture, judge, getChatId, transport, commit, parseCapture, parseJudge, signal } = {}) {
    const run = async (kind, payload = {}) => {
        const chatId = getChatId?.();
        const result = await transport?.(kind, payload, signal?.());
        if (chatId != null && getChatId?.() !== chatId) return { status: 'cancelled' };
        const parsed = kind === 'capture' ? parseCapture?.(result) : parseJudge?.(result);
        if (!parsed) return { status: 'invalid' };
        if (kind === 'capture') await commit?.(parsed, payload);
        return parsed;
    };
    return { capture: payload => run('capture', payload), judge: payload => run('judge', payload) };
}
