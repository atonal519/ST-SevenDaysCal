# 2026-07-14 — UI 重构：顶栏 tab 改为左侧竖字侧栏

**Project**: ST-SevenDaysCal
**Repo**: git@github.com:atonal519/ST-SevenDaysCal.git (master)
**Commits**: `d8ff38b`（UI 重构主体）, `158fcb1`（布局细节修复）

---

## Session goal

用户要重构日程表插件的 UI。核心诉求：

1. 三个主视图（日程 / 大纲 / 线）像文件夹 tab 一样展示，从原来的**顶栏横向 tab** 改成**左侧竖向侧栏**
2. 配色完全从酒馆当前主题 (`--SmartTheme*` CSS 变量) 抓取，不再走插件自己的 day/night 二选一
3. 移动优先：手机上要接近全屏

## 最终形态

### 布局
- `.sp-sheet` 从 flex column 改成 **`grid 44px 1fr`**（侧栏 + 内容区）
- **侧栏 44px 窄**，3 主 tab 用**竖排中文**（`writing-mode: vertical-rl; text-orientation: upright`），配 glyph（`▤ ¶ ⁝`）—— 书脊/竹简观感
- 侧栏底部 ⚙ 图标（无字），进入设置面板
- 我/TA 从顶栏挪到**内容区头部 sub-toggle**，仅在日程视图显示；outline/lines 视图切进去时自动隐藏
- 顶栏（`.sp-topbar`）彻底删掉
- FAB 开关 + ✕ 关闭 挪到内容区头部右侧
- 调试抽屉暂留 content-col 底部（未合并进设置，Stage 2 再动）

### 主题色
- 视觉 token 拆两层：`--sp-*-legacy` 保留原 sp-night/sp-day 两套写死值作 fallback
- `.sp-root { --sp-* : var(--SmartTheme*, var(--sp-*-legacy)) }` cascade
- 聊天气泡走 `--SmartThemeUserMesBlurTintColor` / `--SmartThemeBotMesBlurTintColor`（跟酒馆本体一致）
- FAB、日程内 tab 激活态、事件线推进标记的写死 hex 全部走 `--sp-primary` / `color-mix`
- **状态色保留写死**：toast (成功/错误)、notice (API 提示)、mem-warn (记忆区警告)、beat-type（world/major/character 语义边框）—— 这些是"警告=黄""错误=红"的语义色，跨主题不能变

### 拖拽 / resize
- 桌面：**内容区头部**当拖拽把手（`.sp-content-head`），忽略 icon 按钮 / 我TA 按钮
- 桌面：resize handle 保留（右下角），拖动改 sheet 尺寸
- 手机：无拖拽、无 resize handle（`display: none`）；`.sp-content-head` `cursor: default; touch-action: auto` 覆盖，避免 touch 被拦

## 踩坑与修复

### 坑 1：手机上真全屏 (`inset: 0`) 弹窗打不出来
**症状**：点日程表按钮无任何弹窗，浏览器什么都不显示。

**尝试过的失败版本**：
- 真全屏 v1：`.sp-root { inset:0; pointer-events:auto }` + `.sp-sheet { inset:0; height:100dvh }` —— 完全无弹窗
- 伪全屏 v2：`.sp-root { pointer-events:none }` + `.sp-sheet { top:20px; bottom:20px; left:14px; right:14px }` —— 完全无弹窗

**根因**：用户手机浏览器没 devtools 无法定位。盲修不到具体是哪个 CSS 属性组合渲染失败。

**最终方案**：**保留原始浮卡的定位方式**（`top+left:50%+translateX(-50%)+width`），只把数值放大：
```css
top: calc(20px + env(safe-area-inset-top, 0px));
left: 50%;
transform: translateX(-50%);
width: calc(100dvw - 20px);
max-width: calc(100dvw - 20px);
height: calc(100dvh - 40px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
```
"接近全屏"但沿用已知能渲染的定位组合，绕开兼容性未知。

### 坑 2：长文无法滚动
**根因**：`.sp-sheet` 是 `display: grid; grid-template-columns: 44px 1fr` —— **没设 `grid-template-rows`**，隐式 row 是 auto、按内容拉伸。内容溢出 sheet 而不是内部滚动。

**修复**：给 `.sp-sheet` 加 `grid-template-rows: 1fr; min-height: 0`；给 `.sp-content-col` 加 `height: 100%`。

### 坑 3：拖大纲分隔条整个窗口跟着缩
**根因**：手机端 `.sp-sheet` 只设了 `max-height` 没设 `height` —— sheet 高度是被内容撑起来的。拖分隔条改 `#sp-outline-chat` height → sheet 里总高度变化 → sheet 自身高度跟着变。

**修复**：手机 sheet 加 `height: calc(...)` 跟 `max-height` 同值钉死。`syncMobileViewport` 里 inline 写 `height` 和 `maxHeight` 双份。

### 坑 4：桌面 resize 时左边外扩、不是右边
**症状**：右下角 handle 往右拖，sheet **左边缘向左推**，右边缘不动。

**根因**：桌面 `.sp-sheet` 用 `right: 20px` 锚右边，`width: 360px` 定宽。JS 改 `sheet.style.width` 时 right 不变、left 自动往外走。

**修复**：`onResizeStart` 里先 snap 到 left 锚（跟 drag 时一样的处理），把 `right` 设 `auto`，把 `left` 设当前 `getBoundingClientRect().left`。之后 resize 改 width 就是右边正常扩。

### 坑 5：拖拽把手放侧栏 → 完全拖不动
**根因**：侧栏是 3 tab + spacer + ⚙，几乎全被 tab 铺满。`onDragStart` 忽略列表包含 `.sp-side-tab`，等于点侧栏任何一处都被 return，永远拖不到。

**修复**：拖拽把手改到 `.sp-content-head`（内容区头部标题栏，符合浏览器窗口拖标题栏的直觉）。

### 坑 6：`syncMobileViewport` 老代码覆盖新 CSS
**根因**：旧 `syncMobileViewport` 会强写 `sheet.style.top = '70px'` 和 `maxHeight = calc(vh - 90px)`。inline style 覆盖了新的伪全屏 CSS。

**修复**：伪全屏方案里 `syncMobileViewport` 改成主动**清掉** inline `top` / `maxHeight`。最终版本用回浮卡定位后又恢复了旧逻辑（top:20+safe-area, bottomGap:20+safe-area）。

### 坑 7：手机 resize 事件冒泡
**症状**：拖大纲分隔条时事件冒泡到 resize handler（虽然 CSS 隐藏 handle 但事件绑定还在）。

**修复**：`onResizeStart` 顶部加 `if (isMobile()) return`。

## 未做的事（Stage 2 可选）
- 调试抽屉（🐛 AI 输入）合并进设置面板，作为一个 section
- 设置面板的四个 details section 内部排版也重构一次（现在只是外壳换了）
- 大纲 chat 气泡布局调优

## 决策记录

| 决策 | 结论 | 备注 |
|---|---|---|
| 拖拽功能 | 保留桌面，删手机 | 手机上浮卡不用拖 |
| 状态色是否走主题 | 不 | toast/notice/mem-warn 是语义色，跨主题不变 |
| 主题 fallback 策略 | 保守（--SmartTheme + legacy 二级 cascade） | 用户选"守住旧逻辑作安全网" |
| 我/TA 位置 | 归日程内 sub-toggle | vs 侧栏平铺 4 项 |
| 手机全屏方式 | 接近全屏（用浮卡定位） | 真全屏在用户手机上打不出弹窗 |

## 相关 memory
- `feedback_sillytavern_policy` — own ST 走 develop-local 流程；这次因用户明确"直接在服务器改"而破例
- `feedback_deploy_verify_first` — 改完先让用户验证再 commit/push（本次遵循，共两次 commit + push）
- `suzhi_pwa_cache_first` — 每次让用户刷时提醒 unregister SW，避免看到旧代码
- `feedback_commit_language` — commit message 用中文（本次遵循）
