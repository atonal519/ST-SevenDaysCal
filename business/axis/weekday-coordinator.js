// 故事星期生产协调策略：DOM/宿主由调用方负责，本模块只统一 ref 选择。
export function resolveWeekdayRef({ override, hasOverride = override !== undefined, snapshotRef, floor, resolveLocal } = {}) {
    if (hasOverride) return override;
    if (snapshotRef !== undefined) return snapshotRef;
    return typeof resolveLocal === 'function' && Number.isInteger(floor) ? (resolveLocal(floor) || null) : null;
}

// 人工故事时间校准是纠错锚：两种浅兜底都不能绕过它。只有校准楼之后
// 恢复的完整 SDC 才重新接管；旧存档缺楼号时沿用既有“完整 SDC 可恢复自动”语义。
export function automaticWeekdayCanReplaceCalibration(automatic, calibration) {
    if (!calibration) return !!automatic;
    if (automatic?.source !== 'sdc') return false;
    // 旧存档可能没有 calibration.floor；沿用既有“完整 SDC 可恢复自动”的兼容语义。
    if (!Number.isInteger(calibration.floor)) return true;
    return Number.isInteger(automatic.floor) && automatic.floor > calibration.floor;
}

export function createWeekdayConsumerContext(options = {}) {
    const ref = resolveWeekdayRef(options);
    return Object.freeze({ weekdayRef: ref, unknown: ref == null, label: ref == null ? '星期未记录' : null });
}

export function weekdayContextForPoint(context) {
    if (!context || !Object.prototype.hasOwnProperty.call(context, 'localWeekdayRef')) return undefined;
    return context.localWeekdayRef;
}
