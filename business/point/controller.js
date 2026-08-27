import { classifyGenerationError, diagnosticMessage, makeDiagnosticError, safeDiagnosticLog } from '../../api/diagnostics.js';
// 点任务控制器的宿主边界：owner/lifecycle 由宿主提供，模块只负责统一清理与中止。
export function splitAbortController(controller) {
    if (!controller || typeof controller.abort !== 'function' || !controller.signal || typeof controller.signal.addEventListener !== 'function') throw new TypeError('需要原生 AbortController');
    return { controller, signal: controller.signal };
}

export function createPointController(env) {
    let activeManualOwner = null;
    const sameOwnerIdentity = (owner, view, char) => env.chatId() === owner.chatId && env.view() === view && (view !== 'char' || env.char() === char);
    const canonicalSnapshot = (view, char) => {
        const key = env.key(view, char); const saved = key ? env.read(key) : null;
        return { key, raw: String(saved?.raw || ''), ts: Number(saved?.ts) || null, chatId: env.chatId(), view, char };
    };
    const canonicalMatches = expected => {
        if (!expected || env.chatId() !== expected.chatId || env.view() !== expected.view || (expected.view === 'char' && env.char() !== expected.char)) return false;
        const saved = expected.key ? env.read(expected.key) : null;
        return String(saved?.raw || '') === expected.raw && (Number(saved?.ts) || null) === expected.ts;
    };
    function restoreManualOwner(owner) {
        if (!owner || env.chatId() !== owner.chatId || env.view() !== owner.view || (owner.view === 'char' && env.char() !== owner.charName)) return false;
        if (owner.previousCachedSchedule) { env.state.cachedSchedule = owner.previousCachedSchedule; if (env.panelVisible()) env.setBody(owner.previousCachedSchedule); }
        else { env.state.cachedSchedule = null; if (env.panelVisible()) env.showEmpty?.(); }
        return true;
    }
    function cleanupManualOwner(owner) {
        const lifecycle = env.evaluate({ manager: env.owners, owner, chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), pluginEnabled: env.enabled() });
        if (!lifecycle.canCleanup) return false;
        const isCurrent = env.state.scheduleAbortController === owner.controller;
        if (isCurrent || !env.state.isGenerating) { if (isCurrent) env.state.scheduleAbortController = null; env.state.isGenerating = false; env.setButton(null); }
        if (activeManualOwner === owner) activeManualOwner = null; env.owners.finish(owner); return true;
    }
    function abort() {
        if (!env.state.isGenerating) return false;
        const owner = activeManualOwner; env.state.scheduleAbortController?.abort(); env.state.scheduleAbortController = null; env.state.isGenerating = false; env.setButton(null); restoreManualOwner(owner); return true;
    }
    async function triggerGenerate() {
        if (env.state.isGenerating || env.editing?.()) return;
        if (env.syncing()) { env.toast('点正在同步到今天，稍候', null, true); return; }
        const view = env.view(); const char = env.char();
        const owner = env.owners.create('point-manual', { chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), view, charName: char });
        if (!await env.precheck()) { cleanupManualOwner(owner); return; }
        if (!env.evaluate({ manager: env.owners, owner, chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), pluginEnabled: env.enabled() }).canCommit) { cleanupManualOwner(owner); return; }
        owner.previousCachedSchedule = env.state.cachedSchedule; owner.previousView = view; owner.previousChar = char; activeManualOwner = owner; env.state.cachedSchedule = null; env.state.isGenerating = true; env.setButton('generating');
        if (!env.panelVisible()) env.showPanel(); env.setBody(env.loading('正在规划', 'sp-abort-generate'));
        void runGenerate(null, owner);
    }
    async function runGenerate(travelContext = null, owner = null) {
        const view = owner?.view ?? env.view(); const char = owner?.charName ?? env.char();
        if (!owner) {
            owner = env.owners.create('point-manual', { chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), view, charName: char });
            owner.previousCachedSchedule = env.state.cachedSchedule; owner.previousView = view; owner.previousChar = char; activeManualOwner = owner;
            if (!env.state.isGenerating) { env.state.cachedSchedule = null; env.state.isGenerating = true; env.setButton('generating'); if (env.panelVisible()) env.setBody(env.loading('正在规划', 'sp-abort-generate')); }
        }
        const { controller, signal } = splitAbortController(owner.controller);
        owner.canonical = owner.canonical || canonicalSnapshot(view, char);
        owner.adultMode = owner.adultMode || (env.adultMode?.() || 'off');
        env.state.scheduleAbortController = controller; env.abortAuto?.();
        try {
            const ctx = env.context(); const user = ctx.name1 || '用户'; const character = view === 'char' ? (char || ctx.name2 || '角色') : (ctx.name2 || '角色'); const subject = view === 'char' ? character : user;
            const key = owner.canonical.key; const previous = owner.canonical.raw; const pinned = [];
            if (previous) { const parsed = env.parse(previous, env.calendar()); for (const day of parsed.days) for (const event of day.events) if (event.pin) pinned.push(event); if (parsed.future) for (const event of parsed.future.events) if (event.pin) pinned.push(event); }
            const raw = await env.generate(ctx, user, character, view, signal, pinned, travelContext, owner.adultMode);
            if (env.editing?.() || !env.canCommit(owner, travelContext) || !canonicalMatches(owner.canonical)) return { status: 'cancelled' };
            const rawCheck = env.validate(raw, env.calendar(), { generated: true, adultMode: owner.adultMode, pinned }); if (!rawCheck.ok) { const error = new Error(`点输出无效（${rawCheck.code || rawCheck.reason || '结构不完整'}）`); error.pointIncomplete = true; error.validation = rawCheck; throw error; }
            if (env.editing?.() || !canonicalMatches(owner.canonical)) return { status: 'cancelled' };
            let bound = env.bindAdult ? env.bindAdult(raw, owner.adultMode, env.calendar()) : raw;
            let merged = previous ? env.mergePinned(previous, bound, env.calendar()) : bound; const today = env.today(); merged = env.forceStart(merged, today.month, today.day, env.calendar());
            const mergedCheck = env.validate(merged, env.calendar()); if (!mergedCheck.ok) throw new Error(`生成结果结构不完整（${mergedCheck.code || mergedCheck.reason || '未知原因'}）`);
            const html = env.render(merged, subject, view, env.calendar()); if (env.editing?.() || !env.canCommit(owner, travelContext) || !sameOwnerIdentity(owner, view, char) || !canonicalMatches(owner.canonical)) return { status: 'cancelled' };
            env.write(key, { raw: merged, userName: subject, ts: Date.now() }); env.sync(); if (!env.canCommit(owner, travelContext)) return;
            env.state.isGenerating = false; env.state.scheduleAbortController = null; env.setButton('done'); if (view === 'char') env.setChar(char);
            const same = env.view() === view && (view !== 'char' || env.char() === char);
            if (same) { env.setCached(html); if (env.panelVisible()) { env.setBody(html); if (env.notify() !== 'off') env.toast('点已生成'); } else env.toast('点已生成，点击查看', () => { if (!env.canCallback(owner)) return; env.showPanel(); env.setBody(html); }); }
            else env.toast('点已生成，点击查看', () => { if (!env.canCallback(owner)) return; env.setView(view, char); env.setCached(html); env.showPanel(); env.setBody(html); });
            setTimeout(() => { if (env.canCallback(owner)) env.setButton(null); }, 6000); env.owners.finish(owner);
        } catch (error) {
            const sameOwnerView = sameOwnerIdentity(owner, view, char); const isCurrent = env.state.scheduleAbortController === owner.controller; if (!isCurrent) return; env.state.isGenerating = false; env.state.scheduleAbortController = null; env.setButton(null); if (!env.canCommit(owner, travelContext) || !sameOwnerView) return;
            if (error?.name === 'AbortError') { restoreManualOwner(owner); return; }
            const restored = restoreManualOwner(owner);
            if (restored && owner.previousCachedSchedule) env.toast(`点生成失败：${diagnosticMessage(error)}；已保留原存档`, null, true);
            else { const retry = classifyGenerationError(error) === 'config-missing' ? '' : '<button class="sp-gen-btn" id="sp-gen-schedule-now">重新生成点</button>'; const html = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>${env.escape(diagnosticMessage(error))}</p>${retry}</div>`; if (env.panelVisible() && env.view() === view) env.setBody(html); else env.toast('点生成失败，请重试', null, true); }
        } finally { cleanupManualOwner(owner); }
    }
    async function syncPointToToday(auto = false, travelContext = null) {
        if (!env.enabled()) return { status: 'skipped' }; const allowPending = travelContext?.allowPendingFollowup !== false;
        if (env.syncing()) { if (allowPending) env.owners.setPending('point-auto', { chatId: env.chatId(), chatRevision: env.owners.currentChatRevision(), targetDate: travelContext?.targetDate }); return { status: 'skipped' }; }
        if (env.state.isGenerating || env.editing?.()) { if (!auto) env.toast('点正在生成或编辑中，稍候再同步', null, true); return { status: 'skipped' }; }
        const view = env.view(), char = env.char(), key = env.key(view, char), saved = key && env.read(key), previous = saved?.raw || ''; if (!key || !previous) return { status: 'skipped' };
        env.abortAuto?.(); const chatId = env.chatId(); const owner = env.owners.create('point-auto', { chatId, chatRevision: env.owners.currentChatRevision(), view, charName: char, targetDate: travelContext?.targetDate }); owner.canonical = { key, raw: previous, ts: Number(saved?.ts) || null, chatId, view, char }; const { signal } = splitAbortController(env.setAuto(owner.controller)); env.setSyncing(true);
        owner.adultMode = env.adultMode?.() || 'off';
        try {
            const ctx = env.context(), cfg = env.config(); if (!cfg.url || !cfg.key) { const error = makeDiagnosticError('config-missing'); env.logDiagnostic?.(safeDiagnosticLog('point', 'request', error, { background: auto })); if (!auto || env.notify() === 'full') env.toast(diagnosticMessage(error), null, true); return { status: 'failed', error }; }
            const user = ctx.name1 || '用户', character = view === 'char' ? (char || ctx.name2 || '角色') : (ctx.name2 || '角色'), subject = view === 'char' ? character : user, parsed = env.parse(previous, env.calendar()), pinned = [];
            for (const day of parsed.days) for (const event of day.events) if (event.pin) pinned.push(event); if (parsed.future) for (const event of parsed.future.events) if (event.pin) pinned.push(event);
            const fresh = await env.generate(ctx, user, character, view, signal, pinned, travelContext, owner.adultMode); if (env.editing?.() || !env.canCommit(owner, travelContext) || env.state.isGenerating || !canonicalMatches(owner.canonical)) return { status: 'cancelled' };
            const today = travelContext?.targetDate || env.today(); const freshCheck = env.validate(fresh, env.calendar(), { generated: true, adultMode: owner.adultMode, pinned }); if (!freshCheck.ok) { const error = makeDiagnosticError('invalid-structure', { phase: 'parse' }); env.logDiagnostic?.(safeDiagnosticLog('point', 'parse', error, { background: auto })); if (!auto || env.notify() === 'full') env.toast(`点同步失败：${diagnosticMessage(error)}；旧点数据未改变，请重试`, null, true); return { status: 'failed', error }; }
            const boundFresh = env.bindAdult ? env.bindAdult(fresh, owner.adultMode, env.calendar()) : fresh; const merged = env.forceStart(env.mergePinned(previous, boundFresh, env.calendar()), today.month, today.day, env.calendar()); const mergedCheck = env.validate(merged, env.calendar()); if (!mergedCheck.ok) { const error = makeDiagnosticError('invalid-structure', { phase: 'parse' }); env.logDiagnostic?.(safeDiagnosticLog('point', 'parse', error, { background: auto })); if (!auto || env.notify() === 'full') env.toast(`点同步失败：${diagnosticMessage(error)}；旧点数据未改变，请重试`, null, true); return { status: 'failed', error }; }
            if (env.editing?.() || !canonicalMatches(owner.canonical)) return { status: 'cancelled' };
            env.write(key, { raw: merged, userName: subject, ts: Date.now() }); env.sync(); if (env.view() === view && (view !== 'char' || env.char() === char)) { env.setCached(env.render(merged, subject, view, env.calendar())); if (env.panelVisible()) env.setBody(env.cached()); }
            if (auto ? env.notify() === 'full' : env.notify() !== 'off') env.toast(`点已同步到 ${env.monthName(today.month)}${today.day}日`); return { status: 'updated', targetDate: today };
        } catch (error) { const canNotify = error?.name !== 'AbortError' && env.canCommit(owner, travelContext); if (canNotify) { env.logDiagnostic?.(safeDiagnosticLog('point', 'request', error, { background: auto })); if (!auto || env.notify() === 'full') env.toast(`点同步失败：${diagnosticMessage(error)}`, null, true); } return { status: error?.name === 'AbortError' || travelContext?.signal?.aborted ? 'cancelled' : 'failed', error }; }
        finally {
            const pending = env.owners.peekPending(owner); const lifecycle = env.followupState(owner, travelContext, allowPending, pending); if (!lifecycle.canCleanup) return; env.setAuto(null); env.setSyncing(false); env.clearBusy();
            if (!lifecycle.canFollowup) env.owners.discardPending(owner); const followup = pending?.targetDate ? { ...(travelContext || {}), targetDate: pending.targetDate } : travelContext;
            if (env.shouldFollowup(lifecycle, followup, allowPending, owner)) syncPointToToday(auto, followup); env.owners.finish(owner);
        }
    }
    return { cleanupManualOwner, abort, triggerGenerate, runGenerate, syncPointToToday };
}
