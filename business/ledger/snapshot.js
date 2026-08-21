export function createLedgerSnapshotBridge(options = {}) {
    const cloneAnchor = value => (value && typeof value === 'object') ? { ...value } : null;
    const capture = () => {
        let point = '', line = '', almanac = [], anchor = null, pool = [];
        try { point = options.readPoint?.() || ''; } catch {}
        try { line = options.readLine?.() || ''; } catch {}
        try { almanac = options.loadAlmanac?.() || []; } catch {}
        try { const a = options.today?.(); if (a && Number.isFinite(+a.month) && Number.isFinite(+a.day)) anchor = { month: +a.month, day: +a.day }; } catch {}
        try { pool = (options.entries?.() || []).map(e => ({ id: e.id, 事由: e.事由, 类型: e.类型, 起始锚: cloneAnchor(e.起始锚), 周期长度: e.周期长度, 到期锚: cloneAnchor(e.到期锚), 标签: Array.isArray(e.标签) ? e.标签.slice() : [], 锁: e.锁, 静音: e.静音 })); } catch {}
        const weekdayRef = options.weekdayRef?.();
        const out = { point, line, almanac, anchor, pool, calendar: options.cloneCalendar?.(options.calendar?.()) };
        if (weekdayRef && Number.isInteger(weekdayRef.refDoy) && Number.isInteger(weekdayRef.refWd)) out.weekdayRef = { refDoy: weekdayRef.refDoy, refWd: weekdayRef.refWd };
        return out;
    };
    const captureRecall = () => { const value = options.echo?.(); return { recall: Array.isArray(value) ? value.slice() : [], calendar: options.cloneCalendar?.(options.calendar?.()) }; };
    const freeze = mesId => {
        if (mesId == null) return;
        try {
            const msg = options.context?.().chat?.[Number(mesId)];
            if (msg?.is_user) {
                const snap = captureRecall();
                if (!snap.recall.length) return;
                options.write?.(Number(mesId), snap);
            } else options.write?.(Number(mesId), capture());
        } catch {}
    };
    return { capture, captureRecall, freeze };
}
