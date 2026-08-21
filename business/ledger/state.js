// 刻度异步任务状态：统一 busy/abort/progress 的可替换容器，不改变现有数据 schema。
export function createLedgerTaskState() {
    let capture = { busy: false, progress: null, controller: null };
    let judge = { busy: false, controller: null };
    return {
        get capture() { return capture; }, get judge() { return judge; },
        startCapture(controller) { capture = { ...capture, busy: true, controller }; return capture; },
        finishCapture() { capture = { busy: false, progress: null, controller: null }; return capture; },
        setCaptureProgress(done, total) { capture = { ...capture, progress: total > 0 ? { done, total } : null }; return capture; },
        startJudge(controller) { judge = { busy: true, controller }; return judge; },
        finishJudge() { judge = { busy: false, controller: null }; return judge; },
        abortAll() { capture.controller?.abort?.(); judge.controller?.abort?.(); capture = { busy: false, progress: null, controller: null }; judge = { busy: false, controller: null }; },
    };
}
