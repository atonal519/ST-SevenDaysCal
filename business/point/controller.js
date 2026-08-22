// 点任务控制器的宿主边界：owner/lifecycle 由宿主提供，模块只负责统一清理与中止。
export function splitAbortController(controller) {
    if (!controller || typeof controller.abort !== 'function' || !controller.signal || typeof controller.signal.addEventListener !== 'function') throw new TypeError('需要原生 AbortController');
    return { controller, signal: controller.signal };
}

export function createPointController(env) {
    function cleanupManualOwner(owner) {
        const lifecycle = env.evaluate({ manager: env.owners, owner, chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), pluginEnabled: env.enabled() });
        if (!lifecycle.canCleanup) return false;
        if (env.state.scheduleAbortController === null || env.state.scheduleAbortController === owner.controller) env.state.scheduleAbortController = null;
        env.state.isGenerating = false; env.setButton(null); env.owners.finish(owner); return true;
    }
    function abort() {
        if (!env.state.isGenerating) return false;
        env.state.scheduleAbortController?.abort(); env.state.scheduleAbortController = null; env.state.isGenerating = false; env.setButton(null); env.showEmpty?.(); return true;
    }
    async function triggerGenerate() {
        if (env.state.isGenerating) return;
        if (env.syncing()) { env.toast('点正在同步到今天，稍候', null, true); return; }
        const view = env.view(); const char = env.char();
        const owner = env.owners.create('point-manual', { chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), view, charName: char });
        if (!await env.precheck()) { cleanupManualOwner(owner); return; }
        if (!env.evaluate({ manager: env.owners, owner, chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), pluginEnabled: env.enabled() }).canCommit) { cleanupManualOwner(owner); return; }
        env.state.cachedSchedule = null; env.state.isGenerating = true; env.setButton('generating');
        if (!env.panelVisible()) env.showPanel(); env.setBody(env.loading('正在规划', 'sp-abort-generate'));
        void runGenerate(null, owner);
    }
    async function runGenerate(travelContext = null, owner = null) {
        const view = owner?.view ?? env.view(); const char = owner?.charName ?? env.char();
        if (!owner) owner = env.owners.create('point-manual', { chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), view, charName: char });
        const { controller, signal } = splitAbortController(owner.controller);
        env.state.scheduleAbortController = controller; env.abortAuto?.();
        try {
            const ctx = env.context(); const user = ctx.name1 || '用户'; const character = view === 'char' ? (char || ctx.name2 || '角色') : (ctx.name2 || '角色'); const subject = view === 'char' ? character : user;
            const key = env.key(view, char); const previous = env.read(key)?.raw || ''; const pinned = [];
            if (previous) { const parsed = env.parse(previous, env.calendar()); for (const day of parsed.days) for (const event of day.events) if (event.pin) pinned.push(event); if (parsed.future) for (const event of parsed.future.events) if (event.pin) pinned.push(event); }
            const raw = await env.generate(ctx, user, character, view, signal, pinned, travelContext);
            if (!env.canCommit(owner, travelContext)) return;
            if (!env.validate(raw, env.calendar()).ok) { const error = new Error('返回不完整（需要闭合的 Day 1–3 及至少 5 条 Future 事件），旧点数据未改变，请重试'); error.pointIncomplete = true; throw error; }
            let merged = previous ? env.mergePinned(previous, raw, env.calendar()) : raw; const today = env.today(); merged = env.forceStart(merged, today.month, today.day, env.calendar());
            if (!env.validate(merged, env.calendar()).ok) throw new Error('生成结果结构不完整，旧点数据未改变，请重试');
            const html = env.render(merged, subject, view, env.calendar()); if (!env.canCommit(owner, travelContext)) return { status: 'cancelled' };
            env.write(key, { raw: merged, userName: subject, ts: Date.now() }); env.sync(); if (!env.canCommit(owner, travelContext)) return;
            env.state.isGenerating = false; env.state.scheduleAbortController = null; env.setButton('done'); if (view === 'char') env.setChar(char);
            const same = env.view() === view && (view !== 'char' || env.char() === char);
            if (same) { env.setCached(html); if (env.panelVisible()) { env.setBody(html); if (env.notify() !== 'off') env.toast('点已生成'); } else env.toast('点已生成，点击查看', () => { if (!env.canCallback(owner)) return; env.showPanel(); env.setBody(html); }); }
            else env.toast('点已生成，点击查看', () => { if (!env.canCallback(owner)) return; env.setView(view, char); env.setCached(html); env.showPanel(); env.setBody(html); });
            setTimeout(() => { if (env.canCallback(owner)) env.setButton(null); }, 6000); env.owners.finish(owner);
        } catch (error) {
            if (!env.canCommit(owner, travelContext)) return; env.state.isGenerating = false; env.state.scheduleAbortController = null; env.setButton(null);
            if (error?.name === 'AbortError') { if (env.panelVisible() && env.view() === view) env.showEmpty(); return; }
            const html = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>生成失败：${env.escape(error.message || '未知错误')}</p></div>`;
            if (env.panelVisible() && env.view() === view) env.setBody(html); else env.toast('点生成失败，请重试', null, true);
        } finally { cleanupManualOwner(owner); }
    }
    async function syncPointToToday(auto = false, travelContext = null) {
        if (!env.enabled()) return { status: 'skipped' }; const allowPending = travelContext?.allowPendingFollowup !== false;
        if (env.syncing()) { if (allowPending) env.owners.setPending('point-auto', { chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), targetDate: travelContext?.targetDate }); return { status: 'skipped' }; }
        if (env.state.isGenerating) { if (!auto) env.toast('点正在生成，稍候再同步', null, true); return { status: 'skipped' }; }
        const view = env.view(), char = env.char(), key = env.key(view, char), saved = key && env.read(key), previous = saved?.raw || ''; if (!key || !previous) return { status: 'skipped' };
        env.abortAuto?.(); const chatId = env.chatId(); const owner = env.owners.create('point-auto', { chatId, chatRevision: env.owners.currentChatRevision(), view, charName: char, targetDate: travelContext?.targetDate }); const { controller, signal } = splitAbortController(env.setAuto(owner.controller)); env.setSyncing(true);
        try {
            const ctx = env.context(), cfg = env.config(); if (!cfg.url || !cfg.key) { env.toast('未配置主 API，无法同步点', null, true); return { status: 'failed', error: new Error('未配置主 API') }; }
            const user = ctx.name1 || '用户', character = view === 'char' ? (char || ctx.name2 || '角色') : (ctx.name2 || '角色'), subject = view === 'char' ? character : user, parsed = env.parse(previous, env.calendar()), pinned = [];
            for (const day of parsed.days) for (const event of day.events) if (event.pin) pinned.push(event); if (parsed.future) for (const event of parsed.future.events) if (event.pin) pinned.push(event);
            const fresh = await env.generate(ctx, user, character, view, signal, pinned, travelContext); if (!env.canCommit(owner, travelContext) || env.state.isGenerating || env.chatId() !== chatId) return { status: 'cancelled' };
            const today = travelContext?.targetDate || env.today(); if (!env.validate(fresh, env.calendar()).ok) { env.toast('点同步返回不完整（需要闭合的 Day 1–3 及至少 5 条 Future 事件），旧点数据未改变，请重试', null, true); return { status: 'failed', error: new Error('返回不完整') }; }
            const merged = env.forceStart(env.mergePinned(previous, fresh, env.calendar()), today.month, today.day, env.calendar()); if (!env.validate(merged, env.calendar()).ok) { env.toast('点同步结果结构不完整，旧点数据未改变，请重试', null, true); return { status: 'failed', error: new Error('同步结果不完整') }; }
            env.write(key, { raw: merged, userName: subject, ts: Date.now() }); env.sync(); if (env.view() === view && (view !== 'char' || env.char() === char)) { env.setCached(env.render(merged, subject, view, env.calendar())); if (env.panelVisible()) env.setBody(env.cached()); }
            if (auto ? env.notify() === 'full' : env.notify() !== 'off') env.toast(`点已同步到 ${env.monthName(today.month)}${today.day}日`); return { status: 'updated', targetDate: today };
        } catch (error) { if (error?.name !== 'AbortError' && env.canCommit(owner, travelContext)) env.toast('点同步到今天失败，请重试', null, true); return { status: error?.name === 'AbortError' || travelContext?.signal?.aborted ? 'cancelled' : 'failed', error }; }
        finally {
            const pending = env.owners.peekPending(owner); const lifecycle = env.followupState(owner, travelContext, allowPending, pending); if (!lifecycle.canCleanup) return; env.setAuto(null); env.setSyncing(false); env.clearBusy();
            if (!lifecycle.canFollowup) env.owners.discardPending(owner); const followup = pending?.targetDate ? { ...(travelContext || {}), targetDate: pending.targetDate } : travelContext;
            if (env.shouldFollowup(lifecycle, followup, allowPending, owner)) syncPointToToday(auto, followup); env.owners.finish(owner);
        }
    }
    return { cleanupManualOwner, abort, triggerGenerate, runGenerate, syncPointToToday };
}
