// 「间」落地轴/历法卡片的纯动作层；存储、UI、确认和刷新均由宿主注入。
export function createAxisWidgetActions(env = {}) {
    function applyAlmanacWidget(body, button, idx) {
        const items = env.parseAlmanac?.(body) || [], item = items[Number(idx)] || (items.length === 1 ? items[0] : null);
        if (!item) return env.error?.('卡片格式不完整，无法应用');
        if (!env.key?.()) return env.error?.('当前 chat 没有可写入的轴缓存');
        item.pin = true; const existing = env.loadItems?.() || []; const seen = new Set(existing.map(env.dedupKey));
        if (seen.has(env.dedupKey(item))) { env.done?.(button, '轴里已有'); return env.error?.('这个日期轴里已经有了'); }
        env.saveItems?.([...existing, item]); env.render?.(); env.sync?.(); env.done?.(button, '已加到轴'); env.notify?.(`已加到轴：${item.name}`); return { ok: true, item };
    }
    async function applyEraWidget(body, button) {
        const desc = env.parseEra?.(body); if (!desc) return env.error?.('历法卡片格式不完整，无法应用');
        if (!env.calKey?.()) return env.error?.('当前 chat 没有可写入的历法缓存');
        const result = await env.commitCalendar?.(desc); if (!result?.ok) { if (!result?.cancelled) env.error?.(result?.error || '历法保存失败'); return result || { ok: false }; }
        env.render?.(); env.done?.(button, '历法已应用'); env.notifyEra?.(result.cal); return result;
    }
    return { applyAlmanacWidget, applyEraWidget };
}
