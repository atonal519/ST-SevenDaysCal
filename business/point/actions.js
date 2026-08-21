// 点行内操作：只编排宿主注入的存储、确认、重绘与提示，不改变 raw/schema。
export function createPointActions(env) {
    const restoreActiveDay = dayKey => {
        const tabs = env.inShadow?.('#sp-body .sp-tab'); if (!tabs?.length) return;
        let found = false;
        tabs.each((_, el) => { const tab = env.$(el); const match = String(tab.attr('data-day')) === String(dayKey); tab.toggleClass('sp-tab-active', match); if (match) { tab.trigger('click'); found = true; } });
        if (!found) tabs.eq(0).trigger('click');
    };
    const rerender = (raw, saved, view) => { const html = env.renderSchedule(raw, saved.userName || '用户', view, env.loadCalendar()); env.setCached(html); env.setBody(html); return html; };
    async function togglePin(dayKey, eventIndex) {
        const key = env.getCacheKey(); const saved = env.readStore(key); const raw = saved?.raw || '';
        if (!raw) { env.showToast('待办已失效，请刷新面板', null, true); return; }
        const result = env.togglePointPinRaw(raw, dayKey, eventIndex, env.loadCalendar());
        if (!result.ok) { env.showToast('这个点已不存在，请刷新面板', null, true); return; }
        env.writeStore(key, { raw: result.raw, userName: saved.userName || '用户', ts: Date.now() });
        rerender(result.raw, saved, env.currentView()); restoreActiveDay(dayKey); env.syncLatestScheduleBlock();
        env.showToast(result.pinned ? '已锁定这个点' : '已解锁这个点');
    }
    async function deleteEvent(dayKey, eventIndex, target = {}) {
        const view = target.view === 'char' ? 'char' : 'user'; const charName = view === 'char' ? String(target.charName || '').trim() : '';
        const key = env.getCacheKey(view, charName); const saved = env.readStore(key); const raw = saved?.raw || '';
        if (!raw) { env.showToast('待办已失效，请刷新面板', null, true); return; }
        const parsed = env.parseCalendar(raw, env.loadCalendar()); const events = dayKey === 'future' ? parsed.future?.events : parsed.days?.[Number(dayKey)]?.events; const event = events?.[eventIndex];
        if (!event) { env.showToast('这个点已不存在，请刷新面板', null, true); return; }
        if (!await env.confirm({ title: '删除这个点', body: `将删除「${event.title || '未命名'}」这一条，其它安排保留。此操作不可撤销。`, confirmText: '删除', cancelText: '取消' })) return;
        const result = env.deletePointEventRaw(raw, dayKey, eventIndex, env.loadCalendar()); if (!result.ok) return;
        env.writeStore(key, { raw: result.raw, userName: saved.userName || '用户', ts: Date.now() });
        if (env.currentView() === view && (view !== 'char' || env.currentChar() === charName)) { rerender(result.raw, saved, view); restoreActiveDay(dayKey); }
        env.syncLatestScheduleBlock(); env.showToast('已删除这个点');
    }
    return { togglePin, deleteEvent };
}
