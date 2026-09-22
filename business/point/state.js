// ─── 点（日程）域 · 可变状态容器 ───────────────────────────────────────────────
// 统一持有当前点缓存、生成互斥状态和手动中止 controller。
export const pointState = {
    cachedSchedule: null,          // 当前点视图已生成的 raw 缓存
    isGenerating: false,           // 点生成互斥锁（防并发 generate）
    scheduleAbortController: null, // 点生成 AbortController（手动中止用）
};
