// 故事星期生产协调策略：DOM/宿主由调用方负责，本模块只统一 ref 选择。
export function resolveWeekdayRef({ override, hasOverride = override !== undefined, snapshotRef, floor, resolveLocal } = {}) {
    if (hasOverride) return override;
    if (snapshotRef !== undefined) return snapshotRef;
    return typeof resolveLocal === 'function' && Number.isInteger(floor) ? (resolveLocal(floor) || null) : null;
}

export function createWeekdayConsumerContext(options = {}) {
    const ref = resolveWeekdayRef(options);
    return Object.freeze({ weekdayRef: ref, unknown: ref == null, label: ref == null ? '星期未记录' : null });
}

export function weekdayContextForPoint(context) {
    if (!context || !Object.prototype.hasOwnProperty.call(context, 'localWeekdayRef')) return undefined;
    return context.localWeekdayRef;
}
