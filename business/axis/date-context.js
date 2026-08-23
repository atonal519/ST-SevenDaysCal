// 轴对外窄日期接口。星期锚点仍由现行轴实现提供，后续可替换来源而不改点/刻度调用方。
export function createAxisDateContext({ today, daysUntil, daysUntilFull, weekdayRef, weekdayFor } = {}) {
    return Object.freeze({
        today: (...args) => today?.(...args) ?? null,
        daysUntil: (...args) => daysUntil?.(...args) ?? null,
        daysUntilFull: (...args) => daysUntilFull?.(...args) ?? null,
        weekdayRef: (...args) => weekdayRef?.(...args) ?? null,
        weekdayFor: (...args) => weekdayFor?.(...args) ?? null,
    });
}
