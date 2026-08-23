import { ledgerOwnerIdentity, sameLedgerOwner } from './owner.js';
export const JUDGE_FLOORS = 4;

function buildJudgePrompt(env, today, entries = env.listJudgeable?.() || []) {
    const lines = entries.map(e => env.fmtLedger?.(e, today)).join('\n');
    return `请暂停角色扮演，作为剧情连续性助手，只做一件事：根据下面【已登记事件】各自「距今过了多少天」和最近正文，判断哪些事件的状态**该随时间变化了**，只输出需要更新的那几条。

【已登记事件】（方括号是编号，天数已由系统算好，你不必自己算日期）
${lines || '（暂无活跃事件）'}

【怎么判断该不该变】
- 持续状态：随天数自然演变（如割伤：当天流血→两三天结痂→约一周愈合；病症、孕期同理）。到该愈合/该缓解的天数了就更新现状；已彻底痊愈/结束的标「了结」。
- 约定待办：到期或已过期还没兑现→在现状里点出「今天该…／已过 X 天未…」；正文里已兑现→标「了结」。
- 周期：到期即本轮该发生（如月经）；正文印证发生了→更新现状并标「滚周期」（系统会把下次到期顺延一个周期）。
- 退场／翻篇（跨类型通用，务必保守）：某条对应的人物或事件已明显退出当前剧情（角色离场且短期不会回、情节段落翻篇、长期不再牵动剧情）——即便没有明确结果，也标「了结」让它淡出，账只留此刻仍牵动剧情的事。反过来：只是最近几楼碰巧没提、但人物仍在场或事情仍悬着的，一律「维持」，别误清还悬着的事。

【输出格式】只输出状态**有变化**的条目，每条一行，全角竖线「｜」分隔 4 段，顺序固定：
 编号｜新现状｜动作｜新到期
 · 编号：原样抄方括号里的（如 L3），不带方括号
 · 新现状：更新后的一句话状态（如「伤口已结痂，隐隐作痒」）
 · 动作：维持 / 了结 / 滚周期（三选一，原样写）
 · 新到期：仅在「约定待办」改期、或有明确下次日子的周期（月经、发薪、值班）本轮滚动时填（如「第3月20日」，自定义历按其月名/月序）；永久例行周期与其余情况一律留空
- 没有任何该变的，就只回一个字：无
不要解释、不要输出表头、不要输出没变化的条目。`;
}

export function createLedgerJudgeController(options = {}) {
    const env = options;
    let busy = false;
    let abortController = null;
    const ownerOf = () => {
        return ledgerOwnerIdentity(env.context?.() || {});
    };
    const sameOwner = sameLedgerOwner;
    const current = (ctrl, owner, travel) => abortController === ctrl && !ctrl.signal.aborted && !travel?.signal?.aborted && sameOwner(owner, ownerOf());
    const finish = (ctrl, owner) => {
        if (abortController !== ctrl) return false;
        busy = false; abortController = null;
        if (sameOwner(owner, ownerOf())) { env.render?.(); env.refreshInline?.(true); }
        return true;
    };
    const run = async (manual = false, travel = null) => {
        if (busy) return { status: 'busy', reason: '已有刻度更新正在进行' };
        const ctx = env.context();
        const owner = env.identity?.() || ownerOf(); owner.target = env.target?.(); const ctrl = new AbortController(); owner.guard = () => !ctrl.signal.aborted && !travel?.signal?.aborted && abortController === ctrl && sameOwner(owner, ownerOf()); abortController = ctrl; busy = true;
        let reconcile = null;
        const removeBridge = env.bridge?.(travel?.signal, ctrl) || (() => {});
        env.render?.(); env.refreshInline?.(true);
        try {
            try { reconcile = await env.reconcile?.(owner); } catch (error) { error.phase ||= 'source-scan-failed'; return { status: 'failed', reason: error.phase, reconcile: null, applied: [], error }; }
            if (reconcile?.error) {
                if ((reconcile.phase || reconcile.error.phase) === 'rollback-save-failed') return { status: 'failed', reason: 'rollback-save-failed', reconcile, applied: [], error: reconcile.error };
                if (ctrl.signal.aborted || travel?.signal?.aborted || !current(ctrl, owner, travel)) return { status: 'cancelled', reason: 'source-stale-chat', reconcile, applied: [], error: reconcile.error };
                return { status: 'failed', reason: reconcile.error.saveResult?.reason || reconcile.phase || reconcile.error.phase || 'source-state-invalid', reconcile, applied: [], error: reconcile.error, saveResult: reconcile.error.saveResult };
            }
            if (!current(ctrl, owner, travel)) return { status: 'cancelled', reason: 'source-stale-chat', reconcile, applied: [] };
            const summary = reconcile?.summary || {};
            if (reconcile?.summary?.changed) { env.refreshInject?.(); env.refreshInline?.(true); env.render?.(); }
            if (!env.charKey?.(ctx)) return { status: 'skipped', reason: 'no-character', reconcile, applied: [] };
            const judgeable = (env.listJudgeable?.() || []).filter(entry => entry?.来源状态 !== '待确认' && entry?.来源状态 !== '来源已删除');
            if (reconcile?.summary) reconcile.summary.judgeable = judgeable.length;
            if (!judgeable.length) return { status: 'skipped', reason: 'no-entry', reconcile, applied: [] };
            const cfg = env.config?.();
            if (!cfg?.url || !cfg?.key) return { status: 'failed', reason: 'no-api', error: new Error('未配置 API'), reconcile, applied: [] };
            const target = env.validDate?.(travel?.targetDate, env.calendar?.());
            const floorContext = env.floorContext?.();
            const floor = floorContext?.floor ?? null;
            const date = target || floorContext?.date || env.today?.();
            const judgePrompt = buildJudgePrompt(env, date, judgeable);
            const raw = await env.callApi(ctx, env.appendTravel?.(judgePrompt, travel) || judgePrompt, cfg, ctx.name1 || '用户', ctx.name2 || '角色', ctrl.signal, JUDGE_FLOORS, { ...(travel || {}), noAlmanac: true });
            if (!current(ctrl, owner, travel)) return { status: 'cancelled', reason: 'source-stale-chat', reconcile, applied: [] };
            const parsed = env.parseJudge?.(raw);
            if (parsed?.status === 'none') return { status: 'unchanged', reason: 'none', reconcile, applied: [] };
            if (parsed?.status === 'invalid') return { status: 'invalid', reason: 'format', reconcile, applied: [] };
            const cal = env.calendar?.(); const applied = [];
            for (const change of parsed?.changes || []) {
                if (!current(ctrl, owner, travel)) return { status: 'cancelled', reason: 'source-stale-chat', reconcile, applied: [] };
                const entry = env.getEntry?.(change.id);
                if (!entry) return { status: 'invalid', reason: 'source-state-invalid', reconcile, applied: [] };
                if (entry.状态 === '已了结' || entry.锁 === '用户锁') continue;
                if (entry.来源状态 === '待确认' || entry.来源状态 === '来源已删除') return { status: 'invalid', reason: 'source-state-invalid', reconcile, applied: [] };
                if (entry.静音 === true && change.动作 === '了结') continue;
                const patch = { 现状锚: { 楼层: floor, 历日期: date } };
                if (change.现状) patch.现状 = change.现状;
                if (change.动作 === '滚周期' && entry.周期长度 > 0 && entry.到期锚?.历日期) {
                    const base = entry.到期锚.历日期;
                    patch.到期锚 = { 历日期: env.monthDayFromDoy?.(env.dayOfYear?.(base.month, base.day, cal) + entry.周期长度, cal) };
                } else if (change.到期 && change.动作 !== '滚周期') patch.到期锚 = { 历日期: change.到期 };
                applied.push({ id: entry.id, patch, close: change.动作 === '了结',事由: entry.事由 });
            }
            if (!current(ctrl, owner, travel)) return { status: 'cancelled', reason: 'source-stale-chat', reconcile, applied: [] };
            if (!applied.length) return { status: 'unchanged', reason: 'protected', reconcile, applied: [] };
            let saved = null;
            if (env.applyAtomic) { try { saved = await env.applyAtomic(applied, owner); } catch (error) { error.phase ||= 'judge-save-failed'; throw error; } }
            if (env.applyAtomic && !saved?.ok) return { status: 'failed', reason: 'judge-save-failed', reconcile, applied: [] };
            if (!current(ctrl, owner, travel)) return { status: 'cancelled', reason: 'source-stale-chat', reconcile, applied: [] };
            if (!env.applyAtomic) for (const change of applied) { env.update?.(change.id, change.patch); if (change.close) env.close?.(change.id); }
            env.refreshInject?.(); env.refreshInline?.(true); env.render?.();
            return { status: 'updated', applied: applied.map(change => change.事由), reconcile };
        } catch (error) {
            if (abortController !== ctrl) return { status: 'cancelled', reason: 'superseded', reconcile, applied: [], error };
            if (error?.phase === 'rollback-save-failed') return { status: 'failed', reason: 'rollback-save-failed', reconcile, applied: [], error };
            if (ctrl.signal.aborted || error?.name === 'AbortError' || travel?.signal?.aborted) return { status: 'cancelled', reason: 'aborted', reconcile, applied: [], error };
            if (error?.spDisabled) return { status: 'skipped', reason: 'spDisabled', reconcile, applied: [], error };
            if (!sameOwner(owner, ownerOf())) return { status: 'cancelled', reason: 'source-stale-chat', reconcile, applied: [], error };
            return { status: 'failed', reason: error?.saveResult?.reason || error?.phase || (error?.spDisabled ? 'spDisabled' : 'api-failed'), error, saveResult: error?.saveResult, reconcile, applied: [] };
        } finally { finish(ctrl, owner); removeBridge(); }
    };
    return { run, abort: () => abortController?.abort(), reset: () => { abortController?.abort(); busy = false; abortController = null; }, get isBusy() { return busy; }, get abortController() { return abortController; } };
}
