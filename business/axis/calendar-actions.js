// 日历选择/联动状态机。DOM 只由宿主 adapter 应用，业务状态决策集中在此处。
export function createAxisCalendarActions(env = {}) {
    const clearLinked = () => { env.clearItemClass?.(); env.clearCellClass?.(); };
    const selectDay = day => {
        const current = env.selectedDay?.();
        env.setSelectedDay?.(current === day ? null : day);
        env.render?.();
        return current === day ? null : day;
    };
    const toggleItem = (id, event = {}) => {
        if (event.targetIsButton) return { handled: false };
        const wasLinked = env.itemLinked?.(id) === true;
        clearLinked();
        if (wasLinked) return { handled: true, linked: false };
        env.setItemLinked?.(id);
        const item = env.item?.(id);
        for (const day of env.highlight?.(item) || []) env.linkCell?.(day);
        return { handled: true, linked: true };
    };
    const blankClick = () => {
        if (env.selectedDay?.() != null) { env.setSelectedDay?.(null); env.render?.(); return true; }
        if (env.hasLinked?.()) { clearLinked(); return true; }
        return false;
    };
    return { clearLinked, selectDay, toggleItem, blankClick };
}
