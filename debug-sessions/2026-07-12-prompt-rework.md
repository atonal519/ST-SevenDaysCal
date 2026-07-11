# 2026-07-12 — 事件线 prompt 强化 + agency 分类 + 同步与堆积修复

**Project**: ST-SevenDaysCal
**Repo**: git@github.com:atonal519/ST-SevenDaysCal.git (master)

---

## Session goals

上一次会话之后用户反馈：
1. 面板重新生成后消息内联块不同步（still stale）
2. 平行事件太多"废话事件线"、缺乏挑选真正伏笔的能力
3. 希望区分"需 {{user}} 推动 vs 世界自演化"两类
4. 提议参考 World Engine (DlSNlGHT/World) 的 prompt 结构

---

## Changes

### 1. Q1 同步 bug 修复
`runGenerateLines` 生成完成后只更新面板 body，最新一楼的 `.sp-lines-inline` 块没同步刷新——必须刷新页面才能看到新数据。新增 `syncLatestInlineBlock()`，在 `runGenerateLines` 成功回调里调用，用 `_buildLinesBlockHtml()` 重刷。

### 2. Q2 prompt 强化（参考 World Engine）
把 `buildLinesPrompt` 从 25 行扩到 60+ 行，抄了 World Engine 的关键机制（不抄骰子/信息传播链等重量级模块）：

- **推进属性 agency**（新字段）：
  - `player` = 事件推进依赖 {{user}} 主动行动
  - `world` = 世界/NPC/势力层面自演
- **创建门槛 5 条**（必须同时满足）：未闭合 / 有持续主体 / 需外部演化 / 至少两种走向 / 有实际依据
- **禁止清单**：已完成事项、只有余波气氛的事、当前场景可收束的日常、仅凭"可能引发"的推测、同一主事项拆多条
- **归并规则**：共享 时间/范围/主体/原因/目标 之一 → 更新原条不新建
- **stall 状态**（新字段）：没进展信号时必须 `stall=true`，desc 写恢复条件——给 LLM 合法出口，不必臆造
- **终局判定**：终局不得回退

### 3. Q2 数据结构 + 迁移
输出格式加两字段：
```
Line: 名称|类型|阶段|等级|时间|agency(player/world)|stall(true/false)
Desc: 当前状态（40-70字）
Next: 前瞻信号（15-30字，stall 时写恢复条件，否则写下一步）
```
旧数据兜底：无 agency → world；无 stall → false；无 next → 不显示 next 行。

### 4. Q2 UI
- 面板卡片右侧加 **agency SVG 图标**（人头 = player, 地球 = world），纯 stroke + `currentColor`，跟随字色，跟插件其他 FA 图标风格一致
- stall = true 时卡片标题/描述去饱和 + "停滞" 圆角标签
- 新增 **Next 单行**：`→ 下一步：xxx` 或 `⏸ 恢复条件：xxx`，用户能一眼扫出哪些在动/哪些卡着
- 消息内联折叠块同步：agency 图标缩到 13px，Next 行字号缩一档
- Next 行背景是中性 6% 灰（用户反馈"绿色太扎眼"），只用边条+标签色区分状态

### 5. 多楼堆积修复
`appendLinesInlineBlock`（由 `CHARACTER_MESSAGE_RENDERED` 触发）每轮只追加不清旧楼——最初的"只钉最新一楼"约束被绕过。新增 `_removeAllInlineBlocks()`，在 `append` / `backfill` / `syncLatestInlineBlock` 每次调用前扫全局清一次，保证任何时刻只有最新一层带块。

### 6. 注入到聊天时同步
`makeInjectBtn` 生成的【事件线参考】文本里带上 stall 标记和 Next 内容（"恢复条件：" 或 "下一步："），LLM 拿到能看懂当前是停滞还是推进。

---

## Files Changed

| File | Change |
|------|--------|
| `index.js` | ~147 lines net changed |
| `style.css` | ~94 lines net changed |

---

## Notes

- `latent` (第三类 agency) 讨论过后放弃——用户的记忆插件（story-oracle / tavern-notes 等）已经处理"伏笔"这一层，我们不重复造轮子
- agency 图标是 20×20 viewBox 纯 stroke SVG（人头/地球），未走 FA，因为 FA 里合适的 person + globe 组合视觉重量不匹配
- World Engine 的 `stall` 概念很关键——给 LLM"什么都没变"的合法字段，实测能显著减少"为凑数瞎推"的行为
- 用户提议保留 `latent` 一起走完流程但真实需求不足，最后简化为 player/world 二分
