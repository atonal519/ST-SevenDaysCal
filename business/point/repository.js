// 点存储边界：保持原 schedule descriptor 与 {raw,userName,ts} 形状。
let deps = { keyDesc: () => null, readStore: () => null, renderSchedule: () => null, loadCalendar: () => null };

export function bindPointRepository(next = {}) { deps = { ...deps, ...next }; }
export function getScheduleKey(view, charName) { return deps.keyDesc('schedule', view, charName); }
export function loadCachedSchedule(view, charName) {
    const saved = deps.readStore(getScheduleKey(view, charName));
    if (saved?.raw) return deps.renderSchedule(saved.raw, saved.userName || '用户', view, deps.loadCalendar());
    return null;
}
