// 轴日期动作：保存/清除锚点以及“今天 ±1”的宿主无关业务流程。
export function createAxisDateActions(env = {}) {
    const saveAnchor = (key, month, day, source = 'explicit') => {
        if (!key) return { ok: false, reason: 'missing-character' };
        if (month == null) return env.repository?.clear?.() || { ok: false, reason: 'missing-repository' };
        return env.repository?.set?.(month, day, source) || { ok: false, reason: 'missing-repository' };
    };
    const clearAnchor = (key) => {
        if (!key) return { ok: false, reason: 'missing-character' };
        return env.repository?.clear?.(key) || { ok: false, reason: 'missing-repository' };
    };
    const nudgeToday = (delta, { storyClock = false } = {}) => {
        if (storyClock) return { ok: false, reason: 'story-clock' };
        const key = env.charKey?.();
        if (!key) { env.toast?.('当前没有角色卡，无法钉日期', null, true); return { ok: false, reason: 'missing-character' }; }
        const calendar = env.calendar?.();
        const today = env.today?.();
        const target = env.monthDayFromDoy?.((env.dayOfYear?.(today?.month, today?.day, calendar) || 0) + Number(delta || 0), calendar);
        if (!target) { env.toast?.('日期保存失败，请重试', null, true); return { ok: false, reason: 'invalid-target' }; }
        const stored = saveAnchor(key, target.month, target.day);
        if (!stored.ok) { env.toast?.('日期保存失败，请重试', null, true); return stored; }
        env.aftermath?.();
        return { ok: true, date: target };
    };
    const saveManual = async (month, day, { storyClock = false } = {}) => {
        if (storyClock) return { ok: false, reason: 'story-clock' };
        const key = env.charKey?.(); if (!key) { env.toast?.('当前没有角色卡，无法钉日期', null, true); return { ok: false, reason: 'missing-character' }; }
        const calendar = env.calendar?.(), count = env.monthCount?.(calendar);
        if (!(month >= 1 && month <= count)) { env.toast?.(`请填 1-${count} 月`, null, true); return { ok: false, reason: 'month' }; }
        const max = env.monthDays?.(calendar, month);
        if (!(day >= 1 && day <= max)) { env.toast?.(`${month} 月只有 1-${max} 日`, null, true); return { ok: false, reason: 'day' }; }
        let stored;
        if (env.pending?.()) {
            const confirmed = await env.confirm?.({ title: '发现旧版日期锚点', body: '是否将旧版全局日期仅认领到当前聊天？', confirmText: '认领', cancelText: '取消' });
            if (!confirmed) { env.toast?.('已取消认领，未写入日期', null, true); return { ok: false, reason: 'cancelled' }; }
            stored = env.repository?.claim?.(month, day);
        } else stored = saveAnchor(key, month, day);
        if (!stored?.ok) { env.toast?.('日期保存失败，请重试', null, true); return stored || { ok: false, reason: 'save' }; }
        env.aftermath?.(); env.toast?.(`已把今天钉为 ${month}月${day}日`); return { ok: true, date: { month, day } };
    };
    return { saveAnchor, clearAnchor, saveManual, nudgeToday };
}
