# 2026-07-19 更名"构画" + UI 改点线面 + 加"间"局外聊天 tab

## 起因
用户想把插件从"日程表 / 日程 / 大纲 / 事件线"整体重新定位成"构画：点 / 线 / 面 / 间"，其中"间"是全新的**局外聊天（OOC）**功能，用来跟 AI 讨论剧情、设定、关系推演、创作技巧、现实知识等，不推进剧情。

## 边界（用户拍板）
1. **代码名保持不变**：`linesMode/outlineMode/schedule-planner` 内部符号全都不动。cache key 前缀不变（`sp-cache-*-outline-*`、`sp-cache-*-creative-chat-*` 等），用户已有的 localStorage 数据零迁移。
2. **manifest `name` 保持** `schedule-planner`——改了会丢用户所有 settings 和 cache。**只改 `display_name`** 到"构画"。
3. **间的行为**：创作顾问 + 知识帮手（"万事屈臣"）。系统提示词明确"不推进剧情、不扮演角色、不输出 `<outline_widget>`"。
4. **间的上下文**：跟其他 tab 一致（面 + 世界书 + 记忆），走 `getMemText` 分派（柏宝书开着就用柏宝书）。

## 顺序
sidebar 从 `日程 / 大纲 / 线` 改成 `点 → 线 → 面 → 间`——面在线下头，"点线面"逻辑顺。

## 图标
- 点：▤ 
- 线：⁝
- 面：¶
- 间：**‖**（双平行竖线，"端到端之间"意象）——最初写的 ◇ 太中性，用户挑了这个

## 用户可见文字批量替换
一共约 20 处编辑：content-title、toast、按钮标签、空状态、confirm body、placeholder、extension 菜单项、fab 标题、【日程参考】/【事件线参考】等注入模板、BBB 提示语。

**明确保留**：
- LLM prompt 里的"大纲/事件线"字样（在 `buildOutlinePrompt` / `buildLinesPrompt` / `buildSchedulePrompt` 的 template literal 里）——那些是喂给 LLM 的术语，改了会影响模型对任务的理解
- 代码里的英文 term（`outline/lines/schedule`）、变量名、函数名、注释
- `// ─── Storylines (事件线) ───` 之类代码分区注释

## "间" tab 实现
**独立顶层 tab**（不是大纲的 sub-mode）。基本上是照抄 outline chat 的结构做一份平行的：

**新状态变量**：`spaceMode / spaceChatHistory / isSpaceChatting / spaceChatAbortController`

**新 cache key**：`sp-cache-{chatId}-space-chat-{view}`——`state.js` 加 `buildSpaceChatHistoryKey`

**新 system prompt**：`state.js` 加 `buildSpaceChatSystemPrompt({userName,charName,outlineRaw,wiContext,memText})`——注意跟 `buildCreativeChatSystemPrompt` 的差异：
- 明确"局外聊天""不推进剧情"
- 五段结构：角色定位、行为契约、面参考、世界书、记忆库
- 不引导输出 `<outline_widget>`

**新函数**（挂在 outline chat 系列旁边）：
- `getSpaceChatHistoryKey / loadSpaceChatHistory / saveSpaceChatHistory`
- `renderSpaceChatHistory / appendSpaceChatMsg`
- `startSpaceInlineEdit`（`startInlineEdit` 是 outline 专用的，写死了 `outlineChatHistory` 和 `sendOutlineChat`，复制一份改用 space 引用最省事）
- `buildSpaceChatMessages`（这里调 `getMemText()` 拿记忆——outline chat 目前不拿记忆，间要拿，跟其他 tab 对齐）
- `sendSpaceChat`（跟 `sendOutlineChat` 骨架一致，**去掉** `<outline_widget>` 检测和"应用此面"按钮）

**HTML** 挂在 `sp-lines-wrap` 后面：
```html
<div class="sp-space-wrap sp-outline-chat" id="sp-space-wrap"
     style="display:none;flex-direction:column;flex:1;min-height:0">
    <div class="sp-chat-msgs" id="sp-space-msgs"></div>
    <div class="sp-chat-input-row">
        <button id="sp-space-clear">…</button>
        <input id="sp-space-input" placeholder="局外聊聊：剧情、设定、关系、知识…">
        <button id="sp-space-send">…</button>
    </div>
</div>
```
复用 `sp-outline-chat` class + inline `flex-direction:column;flex:1;min-height:0` 让它作为独立 wrap 也能正常伸展（不用动 style.css）。

**view-switch handler**：加 `if (view === 'space')` 分支，跟 outline/lines 平级；三个已有分支各加一句 `$('#sp-space-wrap').hide()` / `spaceMode=false`，schedule 分支同理。

**CHAT_CHANGED reset**：加 `spaceMode=false; spaceChatHistory=[]; spaceChatAbortController?.abort()`，视图可见时 `#sp-space-msgs` 也要 empty。

**事件绑定**：跟 outline chat 一样的四组——`#sp-space-send` click、`#sp-space-input` Enter、`#sp-space-msgs` 上的 delete/edit 事件委托、`#sp-space-clear` click。

## 注入路径
`【日程参考】` → `【点参考】`；`【事件线参考】` → `【线参考】`。这两段会通过 `injectToST` 注入到 ST 聊天框，用户可见。改名让引用标签跟新术语一致。

## 关键文件
- `manifest.json` — `display_name` + `description`
- `state.js` — 加 `buildSpaceChatHistoryKey` / `buildSpaceChatSystemPrompt` / `getSpaceChatPlaceholder`；`getCreativeChatPlaceholder` 里"大纲"改"面"
- `index.js` — 
  - top import 加 space 三件
  - 状态变量：`spaceMode/spaceChatHistory/isSpaceChatting/spaceChatAbortController`
  - `CHAT_CHANGED` reset 加 space
  - sidebar tab HTML 重排 + 改标签 + 加 space
  - `sp-space-wrap` HTML 块
  - view-switch handler 加 space case + 现有三 case 补 space wrap 隐藏
  - space chat 六个函数
  - space chat 事件绑定
  - ~20 处用户可见文字替换（LLM prompt 内部保留）

## 未做（下次可能）
- 抽 outline chat 和 space chat 的公共基座：目前有 ~150 行是复制粘贴（load/save/render/append/sendXxx 结构镜像）。等第三个 chat-like tab 出现再重构，避免过早抽象
- 代码内部符号统一到"点线面间"命名：本次用户明确说了只改 UI
- style.css 里的 `.sp-outline-chat` 现在被两个 wrap 共用；如果视觉上出现"间"独有的问题（比如输入栏位置、消息列滚动），得单独拆一个 `.sp-space-chat` class

## 提交
单次 commit：`fe6dd70..HEAD` 只包含本次改动。commit 信息用中文，技术 token 保留（详见 git log）。
