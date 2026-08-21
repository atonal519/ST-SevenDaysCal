// 历法正式校验标准；轴数据层与 snapshot/runtime 共用，避免快照口径漂移。
export function validateCalendarDescriptor(raw) {
    const era = String(raw?.era || '').trim();
    if (era.length > 24) return { error: '纪年名过长' };
    const months = Array.isArray(raw?.months) ? raw.months : [];
    if (!months.length) return { error: '至少需要一个月份' };
    if (months.length > 60) return { error: '月份数量超限' };
    const out = [];
    for (let i = 0; i < months.length; i++) { const name = String(months[i]?.name || '').trim(); const days = Number(months[i]?.days); if (!name || name.length > 12 || !Number.isInteger(days) || days < 1 || days > 60) return { error: '月份定义无效' }; out.push({ name, days }); }
    if (out.reduce((sum, m) => sum + m.days, 0) > 2000) return { error: '全年总天数超限' };
    return { value: { kind: raw?.kind === 'gregorian' ? 'gregorian' : 'custom', id: String(raw?.id || 'custom-calendar'), revision: Number.isInteger(raw?.revision) && raw.revision > 0 ? raw.revision : 1, weekdayCycle: Number.isInteger(raw?.weekdayCycle) && raw.weekdayCycle > 0 ? raw.weekdayCycle : 7, era, months: out } };
}
