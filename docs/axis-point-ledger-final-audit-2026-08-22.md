# 点、轴与刻度基础拆分最终审计

本报告对应 `rebuild` 分支的阶段 7 机械重构。范围是点、整轴（故事时间戳、日期判定、历法管理器、生成与事务）和刻度（capture/judge/inject 及 UI/快照/actions/events/scroll）；线模块不在本次修改范围内。

## index.js 保留的必要桥

- SillyTavern 宿主依赖：`getContext`、`callCustomApi`、`setExtensionPrompt`、DOM/Shadow DOM 查询、toast/confirm、事件注册、store 与设置读写。
- 跨模块 aftermath：日期锚点改变后的 `runAnchorAftermath`，以及面、点、刻度刷新顺序的协调。
- 点：`triggerGenerate`、`runGenerate`、`syncPointToToday` 只转发到 `business/point/controller.js`；楼内 HTML/strip 只转发到 `business/point/inline.js`；快照最终投影仍由宿主 dashboard 写入。
- 刻度：capture/judge/inject 的生产入口分别由 `business/ledger/capture.js`、`judge.js`、`inject.js` 控制；index 仅注入 API、上下文、DOM/confirm/toast/render 与时间旅行协调。UI、快照、actions、events 由对应 ledger 模块承载，轴面板滚动恢复由 `business/axis/panel.js` 单一承载。
- 轴：故事时间戳与日期判定由 `business/axis/story-clock.js`、`date-detection.js` 承载；历法管理器由 `manager.js` 承载；生成与纪念日补录由 `generation.js` 承载；历法冲突事务由 `transaction.js` 承载；编辑器/UI/日期条目卡片与空态由 `editor.js`、`ui.js`、`item-ui.js` 承载。index 仅保留宿主桥和兼容入口转发。

## 旧体/死代码清理

- 删除 index 中不可达的 `legacyRenderAlmanacUpcoming`、`legacyRenderAlmanacCalendar`。
- 删除 `almSetSheet`、`almNavMonth` 中 return 之后的不可达旧实现。
- 删除无读者的 `_almSyncPending`、`captureCalendarDraft` 和旧月份复制函数；月份复制现在由 `business/axis/manager.js` 直接完成。
- 删除根目录 `ledger.js` 旧实现；生产入口改由 `business/ledger/repository.js` 提供。
- 未修改 `business/lines` 及 index 中线模块业务。

## 刻度公开入口（供后续行为诊断）

- capture：`createLedgerCaptureController().run()`，普通/首次扫描、来源稳定性、批次追溯、原子提交与 owner/abort/chat guard 均在 `business/ledger/capture.js`。
- judge：`createLedgerJudgeController().run()`，候选筛选、日期差、strict parse、状态动作和逐条保存均在 `business/ledger/judge.js`。
- inject：`createLedgerInjectionController().refresh()`，gate、选择、正文/key/depth、echo 与刷新均在 `business/ledger/inject.js`。
- UI/actions/events/snapshot：分别见 `business/ledger/inline.js`、`actions.js`、`events.js`、`snapshot.js`；滚动恢复见 `business/axis/panel.js`，index 只提供宿主环境和事件薄桥。

## 验证

- 本地契约测试与全量测试：通过；known-fail 仍为既有 TODO 2 项，新增失败 0。
- 全仓库 JS/MJS `node --check`：通过。
- `node --check index.js`、关键 axis 模块检查：通过。
- `git diff --check`：通过。
- 静态残留搜索：未发现 `_almSyncPending`、legacy almanac host、旧 calendar manager/render/template 函数体或旧刻度 controller 业务体。

## Reviewer 复核修正记录

1. 修正 `business/ledger/repository.js` 到 `public/scripts/extensions.js` 的生产相对导入路径。
2. `buildDateJudgePrompt` 改从 `business/axis/date-detection.js` 导入，故事时钟模块不再承载日期判定 prompt。
3. `point/controller.js` 的手动触发改为直接调用同一 controller 内部 `runGenerate`，不再依赖未注入的 `env.runGenerate`。
4. capture 的 `LEDGER_EVENT_TYPES`、`LEDGER_FIELD_SPEC` 恢复为基线完整文本，并注入生产 prompt；新增逐字关键段契约断言。
5. ledger close action 保持入口差异：panel close 只刷新 panel，inline close 才刷新 injection 与 inline；inline 通过 `{ inline: true, panel: false }` 保持原入口刷新范围。
6. `_floorSig` 恢复基线 `SDC_START_RE`/`SDC_END_RE` 规则，未改线业务。
7. `ledger-capture-contract.test.mjs` 已加入 `run.mjs` baseline/all，all 输出包含该测试并通过；known-fail self-test 通过。

本轮继续归位：`business/axis/actions.js` 承载轴条目锁定/删除/高亮计算，`manager.saveDraft()` 承载草稿读取、校验、事务提交和 manager 状态，`business/axis/editor.js` 承载星期/跨度提示计算，`business/ledger/inline.js` 承载刻度列表格式化；panel 滚动捕获入口已导出用于完整契约测试。

本轮还恢复了 `axis/ui.js` 的 `calendarSummary` / `calendarConflicts` named exports，并新增 `production-linkage-contract.test.mjs`：这是“静态直接依赖检查”，只检查 index 中本地 business named imports 能在目标模块找到，并不冒充完整 ESM smoke。该检查已加入 baseline/all。rebuild 工作树若直接导入完整 index，首先会因工作树目录层级缺少宿主相对路径的 `public/scripts/extensions.js` 阻断；实际 SillyTavern master 安装目录继续向后解析后，才会因本机缺少 `public/lib.core.bundle.js` 阻断。全量 runner 因此只执行隔离的生产纯模块契约测试。

滚动恢复由 `business/axis/panel.js` 单一持有：它负责 identity、邻行、行内 offset、generation 与最终 scrollTop fallback。`business/ledger/events.js` 只负责事件与重绘，不再自行 capture 或通过 RAF restore，避免一次交互重复恢复。

真实导入 smoke 受本地 SillyTavern 缺失 `public/lib.core.bundle.js` 阻断（宿主 `extensions.js` 的既有运行时依赖），已保留 node-check 与本地隔离 runner 验证证据；未安装或补造宿主依赖。

## 后续单独诊断项

本报告不改变既有行为。多层聊天楼删除后来源楼层保留，以及刻度手动更新 toast 可见性，属于后续行为诊断，不在本次机械重构中处理。
