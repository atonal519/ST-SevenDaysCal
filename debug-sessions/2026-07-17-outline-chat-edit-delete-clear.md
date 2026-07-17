# 2026-07-17 — 大纲聊天加"删/改/清"三件套

**Project**: ST-SevenDaysCal
**Repo**: git@github.com:atonal519/ST-SevenDaysCal.git (master)

---

## Session goal

用户要给日程表插件的"大纲"tab 里那个和 AI 讨论大纲的迷你聊天窗补三个交互：
1. **删除单条消息**（AI 或自己的都能删；只删这一条，不牵连后续）
2. **编辑自己发过的用户消息**（改完立刻用新内容重发，丢弃从这条起之后的历史）
3. **清空对话**（弹确认框，只清 outline chat 历史，不动大纲本身）

## 设计要点

- `appendChatMsg(role, content, historyIndex)` 加第三个参数；user/ai 消息挂 hover-only 的 `.sp-chat-msg-actions`（user 有编辑✎+删除🗑，ai 只有删除🗑）；system/thinking dots 不挂
- 事件全走委托绑在 `#sp-chat-msgs` 上，一次绑定覆盖以后所有渲染
- 编辑态：把 `.sp-chat-msg-content` 替换成 textarea，actions 换成"保存并重发/取消"；保存 = `splice(idx)` 截断历史 + `sendOutlineChat(newText)`；取消 = `renderCreativeChatHistory()` 还原
- 清屏走已有的 `spConfirm`（index.js:1099），不新造对话框
- CSS：`.sp-chat-msg` 改 flex（content + actions 并排）；system/thinking/apply-row 各自 `display: block` 覆盖回块级；`@media (hover: none)` 触屏常显但更淡

## 踩坑

### 坑 1：sliding window trim 会让 DOM 的 data-idx 集体错位
**根因**：`sendOutlineChat` 里 `OUTLINE_HISTORY_CAP = 20` 触发时从头 splice。之前已经 render 的气泡 `data-idx` 是旧值，历史砍掉前 N 条之后就对不上了。

**修复**：trim 发生时改走全量重渲，不 append：
```js
let trimmed = false;
if (outlineChatHistory.length > OUTLINE_HISTORY_CAP) {
    outlineChatHistory.splice(0, outlineChatHistory.length - OUTLINE_HISTORY_CAP);
    trimmed = true;
}
if (trimmed) renderCreativeChatHistory();
else appendChatMsg('user', userMsg, outlineChatHistory.length - 1);
```

### 坑 2：pm2 restart 撞上 saveChat（严重事故）
**症状**：restart sillytavern 后用户发现"恶女重生"档（1091 楼）内容"清空"了。

**根因**：[[sillytavern_lag_root_cause]] 讲过 saveChat 是同步 I/O。restart 那一瞬间正好撞上一次 save 正在写 jsonl，写入被截断成 2 行 15KB；前端拿到空档后又反写一次锁死。

**救援**：`data/default-user/backups/` 是 SillyTavern 自带的滚动备份（每次 save 一份）。按大小/mtime 排序找到最后一个健康版本 `20260717-204422.jsonl`（32.8MB, 1091 行），确认 metadata 里能看到 `恶女重生：终局之舞` 后：
1. 把当前坏档改名保底：`狗！.jsonl.corrupt-20260717-2054`
2. 从备份复制回来
3. 让用户强刷验证

**教训 → memory `feedback_st_restart_protocol`**：以后 restart sillytavern 前先跟用户打招呼，让活跃 chat 页面暂停/切走。用户表示他也会配合暂停打字。

## 决策记录

| 决策 | 结论 | 备注 |
|---|---|---|
| 编辑消息后是否立刻重发 | 是（`sendOutlineChat(newText)`） | 用户选"改完立刻重发" |
| 删除 AI 消息范围 | 只删这一条 | 不牵连之后；语义清晰 |
| 清屏是否弹确认框 | 是（走 spConfirm） | 防误触 |
| 编辑后 assistant 那条怎么办 | splice 截断一起丢 | 语义："从这里重新开始"，避免"回答旧问题的 AI 残留" |
| history sliding window 如何维护 index | trim 时全量重渲 | append 分支需重新计算 |

## 相关 memory
- `feedback_sillytavern_policy` — own ST 走 develop-local；本次走服务器直改（ST-SevenDaysCal 历史模式如此，`debug-sessions/` 就是佐证）
- `feedback_deploy_verify_first` — 用户强刷验证 → 才 commit（本次遵循）
- `feedback_commit_language` — commit 用中文（本次遵循）
- `feedback_st_restart_protocol`（新增） — restart 前打招呼
- `suzhi_pwa_cache_first` — 提醒用户强刷清 SW
