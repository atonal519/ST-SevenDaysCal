// 点存储边界：保持原 schedule descriptor 与 {raw,userName,ts} 形状。
let deps = { keyDesc: () => null, readStore: () => null, renderSchedule: () => null, loadCalendar: () => null };

export function bindPointRepository(next = {}) { deps = { ...deps, ...next }; }
export function getScheduleKey(view, charName) {
    // 点的 char scope 必须有明确名字；禁止空 char 沿 store 的通用 fallback 落进 user scope。
    if (view === 'char') {
        const name = String(charName || '').trim();
        return name ? deps.keyDesc('schedule', 'char', name) : null;
    }
    return deps.keyDesc('schedule', view, charName);
}
export function loadCachedSchedule(view, charName) {
    const saved = deps.readStore(getScheduleKey(view, charName));
    if (saved?.raw) return deps.renderSchedule(saved.raw, saved.userName || '用户', view, deps.loadCalendar());
    return null;
}
export function refreshCachedSchedule(view, charName, { setCached = () => {}, setBody = () => {}, visible = false } = {}) {
    const html = loadCachedSchedule(view, charName);
    setCached(html);
    if (html && visible) setBody(html);
    return html;
}
