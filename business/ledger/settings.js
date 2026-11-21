export function ledgerGenerationBlock(settings, toast, manual, travel) {
    if (settings?.ledgerCaptureEnabled === true) return null;
    const feedbackShown = manual && travel?.feedback !== 'time-travel';
    if (feedbackShown) toast?.('请先开启刻度功能');
    return { status: 'skipped', reason: 'ledger-disabled', feedbackShown };
}

// 刻度开启时，间隔 0 只关闭对应自动任务。
export function normalizeLedgerInterval(value, fallback) {
    if (value === 0 || value === '0') return 0;
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.max(1, Math.min(30, Math.floor(number)));
}
