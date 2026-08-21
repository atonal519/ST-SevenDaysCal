import { axisState } from './state.js';

export function createAxisActions(env = {}) {
    const togglePin = id => {
        const list = env.load?.() || [], item = list.find(x => x.id === id); if (!item) return null;
        item.pin = !item.pin; env.save?.(list); env.toast?.(item.pin ? '已锁定 · 生成时保留' : '已解锁');
        return { id, pin: item.pin };
    };
    const remove = async id => {
        const list = env.load?.() || [], item = list.find(x => x.id === id); if (!item) return false;
        const ok = await env.confirm?.({ title: '删除日期', body: `确定删除「${item.name}」？`, confirmText: '删除', cancelText: '取消' }); if (!ok) return false;
        env.save?.(list.filter(x => x.id !== id)); env.render?.(); env.sync?.(); return true;
    };
    const clearHighlight = () => env.clear?.();
    const highlight = item => {
        clearHighlight(); if (!item) return [];
        const cal = env.calendar?.(), month = env.month?.() + 1, days = env.clamp?.(item.days, 1, env.yearLength?.(cal), 1), out = [];
        const start = env.dayOfYear?.(item.month, item.day, cal);
        for (let k = 0; k < days; k++) { const md = env.monthDayFromDoy?.(start + k, cal); if (md?.month === month) out.push(md.day); }
        return out;
    };
    return { togglePin, remove, highlight, clearHighlight };
}
