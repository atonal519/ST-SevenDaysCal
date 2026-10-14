// 间隔 0 只关闭对应自动任务，手动标注与更新仍走原入口。
export function normalizeLedgerInterval(value, fallback) {
    if (value === 0 || value === '0') return 0;
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.max(1, Math.min(30, Math.floor(number)));
}
