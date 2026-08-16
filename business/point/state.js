// ─── 点（日程）域 · 可变状态容器 ───────────────────────────────────────────────
// 从 index.js 顶部散落的 module-level let 收拢到此（原 cachedSchedule / isGenerating /
// scheduleAbortController）。index.js 侧把原引用按 pointState.X 纯机械替换，不改行为。
export const pointState = {
    cachedSchedule: null,          // 当前点视图已生成的 raw 缓存
    isGenerating: false,           // 点生成互斥锁（防并发 generate）
    scheduleAbortController: null, // 点生成 AbortController（手动中止用）
};
