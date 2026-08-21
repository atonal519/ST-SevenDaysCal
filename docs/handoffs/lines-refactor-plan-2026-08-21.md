# 线模块重构计划与止损线

## 已确认产品语义

- `linesEnabled` 控制自动生成/推进与潜伏注入。
- `linesInlineEnabled` 独立控制楼内显示。
- `已爆发` 是终态。
- canonical 正式数据固定为 `lines-user`。
- 旧 `lines-char-*` 保留，不自动迁移。
- 线自由文本日期不作为“今天”权威来源。

## 已完成：Phase 1

- 纯 schema/mutations/prompt/view-model/state/generation seam。
- 新 AI 输出 strict validation，旧 raw legacy parsing。
- 失败不覆盖旧数据。
- baseline revision 与 task owner。
- 删除、pin、prompt、主面板 view-model 接入生产。
- CHAT_CHANGED/plugin close/store clear 的 owner 清理。

## 可选后续：Phase 2（不要自动扩大）

只有确认实际 UI 行为稳定后再考虑：

- 将 CMR/MESSAGE_SWIPED/MESSAGE_EDITED/MESSAGE_SENT 汇入薄 lines controller。
- swipe 临时层按 chat/floor 清理，不再全局清除。
- days 模式首次观察只立基线，不误推进。
- 只有 confirmed commit 才消费 counter、弹自动推进成功。
- 加强 floor signature/hash。

停止条件：任何旧 raw、历史 snapshot 或 swipe 结果漂移时立即停止。

## 可选后续：Phase 3 UI/CSS

- 双挂新旧类后逐步迁移：
  - `.sp-line-stage`
  - `.sp-line-level`
  - `.sp-line-type`
  - `.sp-line-title`
  - `.sp-line-desc`
- 保留当前已验证胶囊宽度效果。
- 给 lines 容器单独做 280/320/390/500px 响应式检查。
- 不把全局拖拽/resize shell 混入线业务模块。

## 明确不建议在本轮做

- 完整 schema v2。
- 稳定事件 ID。
- pipe codec 懒迁移。
- target metadata transaction 绑定。
- 大规模 DOM 重写。
- 删除旧 char scope。
- 为了减少 `index.js` 行数而机械搬迁没有独立职责的代码。

## 历史设计参考

- `debug-sessions/2026-07-10-storylines-feature.md`
- `debug-sessions/2026-07-11-storylines-tuning.md`
- 轴模块拆分历史：`ba9b352`、`8e82bbf`、`182c5a7`、`71ca504`

推荐继续沿用“纯逻辑 → 薄 facade → controller → UI/CSS”的小步顺序。
