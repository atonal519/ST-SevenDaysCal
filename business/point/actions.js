// 点行内操作：只编排宿主注入的存储、确认、重绘与提示，不改变 raw/schema。
export function createPointActions(env) {
    let editing = false;
    let editToken = null;
    const eventIdentity = event => JSON.stringify(['type', 'title', 'desc', 'time', 'location', 'npcAction', 'pin', 'adult'].map(key => event?.[key] ?? null));
    const participantCurrent = participant => !participant || env.sameParticipantIdentity?.(participant, env.captureParticipantIdentity?.()) !== false;
    const restoreActiveDay = dayKey => {
        const tabs = env.inShadow?.('#sp-body .sp-tab'); if (!tabs?.length) return;
        let found = false;
        tabs.each((_, el) => { const tab = env.$(el); const match = String(tab.attr('data-day')) === String(dayKey); tab.toggleClass('sp-tab-active', match); if (match) { tab.trigger('click'); found = true; } });
        if (!found) tabs.eq(0).trigger('click');
    };
    const rerender = (raw, saved, view) => { const html = env.renderSchedule(raw, saved.userName || '用户', view, env.loadCalendar()); env.setCached(html); env.setBody(html); return html; };
    async function togglePin(dayKey, eventIndex) {
        const key = env.getCacheKey(env.currentView(), env.currentChar()); const saved = env.readStore(key); const raw = saved?.raw || '';
        if (!raw) { env.showToast('待办已失效，请刷新面板', null, true); return; }
        const result = env.togglePointPinRaw(raw, dayKey, eventIndex, env.loadCalendar());
        if (!result.ok) { env.showToast('这个点已不存在，请刷新面板', null, true); return; }
        env.writeStore(key, { raw: result.raw, userName: saved.userName || '用户', ts: Date.now() });
        rerender(result.raw, saved, env.currentView()); restoreActiveDay(dayKey); env.syncLatestScheduleBlock();
        env.showToast(result.pinned ? '已锁定这个点' : '已解锁这个点');
    }
    async function editDescription(dayKey, eventIndex, target = {}) {
        if (editing || env.editing?.() || env.isBusy?.()) return false;
        const view = target.view === 'char' ? 'char' : 'user'; const charName = view === 'char' ? String(target.charName || '').trim() : '';
        const key = env.getCacheKey(view, charName); const saved = env.readStore(key); const raw = saved?.raw || ''; const parsed = env.parseCalendar(raw, env.loadCalendar());
        const events = dayKey === 'future' ? parsed.future?.events : parsed.days?.[Number(dayKey)]?.events; const event = events?.[Number(eventIndex)];
        if (!event) return env.showToast('这个点已不存在，请刷新面板', null, true);
        const token = Symbol('point-edit'); editToken = token; editing = true; env.setEditing?.(true); let value;
        try { value = env.promptFields ? await env.promptFields({ title: `编辑「${event.title || '未命名'}」`, fields: [{ name: 'desc', label: '描述', value: event.desc || '', rows: 3 }, { name: 'npcAction', label: '线头动态', value: event.npcAction || '', rows: 2 }], validate: fields => Object.values(fields).some(text => String(text).includes('|')) ? '点字段不能包含半角竖线「|」' : '' }) : await env.promptTextarea?.({ title: `编辑「${event.title || '未命名'}」`, initialValue: event.desc || '' }); }
        finally { if (editToken === token) { editToken = null; editing = false; env.setEditing?.(false); } }
        if (value === null || value === undefined) return;
        const latest = env.readStore(key); if (latest?.raw !== raw || latest?.ts !== saved?.ts) return env.showToast('点已变化，请重新打开编辑', null, true);
        const result = env.editPointFields(raw, dayKey, Number(eventIndex), typeof value === 'object' ? value : { desc: value }); if (!result.ok) return env.showToast(result.reason === 'pipe' ? '点字段不能包含半角竖线「|」' : '编辑失败，请刷新后重试', null, true);
        env.writeStore(key, { ...saved, raw: result.raw, ts: Date.now() }); rerender(result.raw, saved, view); env.syncLatestScheduleBlock(); env.showToast('已保存点描述');
    }
    async function deleteEvent(dayKey, eventIndex, target = {}) {
        const chatId = env.chatId?.(); const participant = env.captureParticipantIdentity?.() || null;
        const view = target.view === 'char' ? 'char' : 'user'; const charName = view === 'char' ? String(target.charName || '').trim() : '';
        const key = env.getCacheKey(view, charName); const saved = env.readStore(key); const raw = saved?.raw || '';
        if (!raw) { env.showToast('待办已失效，请刷新面板', null, true); return; }
        const calendar = env.loadCalendar(); const parsed = env.parseCalendar(raw, calendar); const sourceDay = dayKey === 'future' ? null : parsed.days?.[Number(dayKey)]; const events = dayKey === 'future' ? parsed.future?.events : sourceDay?.events; const event = events?.[eventIndex];
        if (!event) { env.showToast('这个点已不存在，请刷新面板', null, true); return; }
        const targetIdentity = eventIdentity(event); const sourceDayNumber = sourceDay?.dayNumber;
        if (!await env.confirm({ title: '删除这个点', body: `将删除「${event.title || '未命名'}」这一条，其它安排保留。此操作不可撤销。`, confirmText: '删除', cancelText: '取消' })) return;
        if ((env.chatId && env.chatId() !== chatId) || !participantCurrent(participant)) return false;
        const latest = env.readStore(key); const latestRaw = latest?.raw || ''; if (!latestRaw) return false;
        const latestCalendar = env.loadCalendar(); const latestParsed = env.parseCalendar(latestRaw, latestCalendar);
        const latestDayIndex = dayKey === 'future' ? 'future' : latestParsed.days?.findIndex(day => day.dayNumber === sourceDayNumber);
        const latestEvents = latestDayIndex === 'future' ? latestParsed.future?.events : latestParsed.days?.[latestDayIndex]?.events;
        let latestEventIndex = Number(eventIndex);
        if (latestRaw !== raw) {
            const matches = (latestEvents || []).map((candidate, index) => eventIdentity(candidate) === targetIdentity ? index : -1).filter(index => index >= 0);
            if (matches.length !== 1) return false;
            latestEventIndex = matches[0];
        }
        if (!latestEvents?.[latestEventIndex] || eventIdentity(latestEvents[latestEventIndex]) !== targetIdentity) return false;
        if ((env.chatId && env.chatId() !== chatId) || !participantCurrent(participant)) return false;
        const result = env.deletePointEventRaw(latestRaw, latestDayIndex, latestEventIndex, latestCalendar); if (!result.ok) return false;
        env.writeStore(key, { ...latest, raw: result.raw, userName: latest.userName || saved.userName || '用户', ts: Date.now() });
        if (env.currentView() === view && (view !== 'char' || env.currentChar() === charName)) { rerender(result.raw, latest, view); restoreActiveDay(latestDayIndex); }
        env.syncLatestScheduleBlock(); env.showToast('已删除这个点');
        return true;
    }
    return { togglePin, deleteEvent, editDescription, isEditing: () => editing };
}
