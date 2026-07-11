# 2026-07-11 — 事件线功能微调 + 设置页重构 + 世界书筛选

**Project**: ST-SevenDaysCal
**Repo**: git@github.com:atonal519/ST-SevenDaysCal.git (master)

---

## Session goals

Follow-up on 昨天 (2026-07-10) 的事件线功能上线后的迭代：
1. 平行事件推进过激（LLM 倾向拟造冲突升级）
2. 消息内联渲染框刷新后最新一楼没有
3. 世界书读取逻辑需要按条目选择性传给 AI
4. 设置界面粗糙，需要分区
5. 手机端窗口宽度无法拉伸

---

## Changes

### 1. Prompt 克制约束 (index.js `buildLinesPrompt`)
新增「叙事节奏约束」段落：
- 禁止臆造未发生的冲突升级
- 一次推进不能跳两个阶段
- 无进展信号则保持原阶段，Desc 注明"暂无变化"
- 初次生成冲突类事件线等级不宜超过 2

### 2. 消息内联渲染框持久化 (`backfillLinesInlineBlocks`)
之前把 10 条历史 AI 消息都注入渲染框——被删除或刷新后掉最新那条。
改为：只钉最新一条 AI 消息，历史消息不再冗余注入。用户明确说过往历史不需要看，看不好可以刷掉。

### 3. 世界书源修正 (`getCharBookEntries` / `buildWorldInfoContext`)
- **错误做法**: 读 `character.data.character_book`（角色卡打包时的静态快照，不反映当前编辑）
- **正确做法**: 通过 `character.data.extensions.world` 拿到当前绑定的世界书文件名，用 `ctx.loadWorldInfo(name)` 拉实时状态
- 无外链 world 时才回退到 embedded `character_book`

条目开关按角色卡持久化：`extension_settings[PLUGIN_ID].wiFilter[characterId] = [key, ...]`，key 格式 `worldName::uid` 避免同名冲突。

### 4. 设置页重构 (index.js + style.css `sp-settings-overlay`)
- 旧的内联 slideDown 面板改成全覆盖 overlay（`position: absolute; inset: 0` on `.sp-sheet`）
- 三个 `<details>` 分区: **API 配置** / **功能设置** / **世界书筛选**
- 世界书条目卡片式：整卡可点切换开关，独立的眼睛按钮弹层看全文
- 分组按 world source (世界书文件名)

### 5. 手机端 resize 修复 (`onResizeMove` + resize handlers)
根因：CSS media query 里 `.sp-sheet { max-width: min(340px, calc(100dvw - 20px)) }` 硬压着 inline `width`，纯设 width 无效。
修复：手机场景下同步覆盖 inline `maxWidth`，上限 500px。

### 6. UI 收尾
- 线面板加"平行事件"标题（对齐我/TA 面板 chip 排版）
- 设置 overlay 内容能滚 (`.sp-settings-body { min-height: 0 }` — flex + overflow 的必要条件)
- resize handle z-index 从 10 升到 25，跨过 overlay(z:20) 但在全文弹层(z:30) 之下
- 全局字体：撤掉 Roboto 网络字体，改用系统栈 + CJK 兜底 (`--sp-font: -apple-system, ..., 'PingFang SC', 'HarmonyOS Sans SC', 'Noto Sans SC', ...`)。Roboto Mono 保留用于日期/等宽字段。
- `renderWiList` 性能优化：一次性 innerHTML + 事件委托（原来 per-card 绑 3 个 handler，几十条起明显卡）

---

## Files Changed

| File | Change |
|------|--------|
| `index.js` | ~460 lines net changed |
| `style.css` | ~388 lines net changed |

---

## Notes

- 世界书筛选作用域按 `characterId` 存，不是聊天/全局。用户明确要求：每张卡的世界书不同，全局做没意义
- 外部挂载的独立世界书文件 (`selected_world_info`) 默认不读——用户表态"外部世界书可以统一默认不读"
- 世界书条目的"禁用"是插件层面的过滤，不改动世界书文件本身
