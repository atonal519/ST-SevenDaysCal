# 2026-07-13 — 全局代码审阅 + 严重/中级/轻级 bug 修复

**Project**: ST-SevenDaysCal
**Repo**: git@github.com:atonal519/ST-SevenDaysCal.git (master)
**Commits**: `d6f39d4`（严重级 8 处）, `7501947`（中级 + 轻级清理）

---

## Session goals

代码总量到 ~5000 行（index.js 2731 + memory.js 529 + state.js 44 + style.css 1727）。用户想做全局审阅，找出垃圾代码和潜在 bug，然后按优先级修。

## 审阅方法

用 general-purpose subagent 完整读了 4 个源文件（含 CSS），生成分级报告：
- 【严重】8 处
- 【中】15 处
- 【轻】11 处
- 3 个架构性建议

## 严重级修复（commit d6f39d4）

| # | 位置 | 问题 |
|---|---|---|
| #5 | index.js:139 | `lastDetectedDay` 是隐式全局；模块变量 `_lastDetectedDay` 永远不清空 |
| #6 | index.js:234 | `detectInGameDayChange` 签名缺 `excludeCurrent` 参数，行为与调用点注释相反 |
| #2 | index.js:910 | `setView('user')` 不清 `charViewName`，全靠下游 view 判断兜底脆弱 |
| #3 | index.js:1728,1549 | `runGenerateLines/Outline` 无 chatIdSnap 守卫，跨 chat 会串数据 |
| #8 | index.js:1671 | `renderOutline` 输出异常时静默截断，加 `<details>` 兜底展示 raw |
| #7 | index.js:1034 | `spConfirm` Promise 无 CHAT_CHANGED / panel close 清理，await 挂死 |
| #4 | memory.js | `callMemoryApi` 无 signal；加共享 `_jobAbortController`，chat 切换时 abort+重建；runL0/L1 加 chatIdSnap 守卫和写入前校验 |
| #1 | index.js 顶层 + memory.js `initMemory` | 事件监听器无卸载路径；改为 handle-保存 + 幂等 off→on；MutationObserver 用模块级变量 disconnect 重建 |

## 中级修复（commit 7501947）

- **#9 state.js 抽公共**：`buildCacheKey(chatId, kind, view, charName)`，四个 builder 各变一行 delegate
- **#13 postChatCompletion 单一 fetch 封装**：callCustomApi / callMemoryApi / sendOutlineChat 统一走它
- **#14 outlineChatHistory 滑窗上限 20 条**，防 localStorage 膨胀
- **#15 sendOutlineChat 加 AbortController + chatId 守卫**，CHAT_CHANGED 时 abort
- **#19 parseCalendar 用 `replace(/<!--[\s\S]*?-->/g, '')` 处理多行注释**，取代 line-level `startsWith`

## 轻级修复（commit 7501947）

- `toggleOutlineMode` 死代码删除，唯一 caller（runGenerateOutline toast）改用 view-btn.trigger('click')
- `restorePositionAndSize` 死代码删除（无 caller）
- memory.js `_saveSettings` 未用参数删除，index.js 对应 `saveSettings: ()=>` 也删
- CSS：`sp-settings-panel` / `sp-ext-row` / `sp-toggle-label` 老 UI 类删除
- CSS：`#sp-open-btn` selector 更名为 `#sp_open_wand`（wand button 已取代旧按钮）

## 未做的（用户拍板暂缓）

- 架构 B：runGeneration 骨架抽取 —— 用户理由是"未来拓展时再重构"
- 架构 A：更进一步的 ApiClient 类（现有 postChatCompletion 已经够用）
- 架构 C：拆 index.js 到 views/ 目录
- 轻级 #18 guessCharName 缓存
- 轻级 #29 visualViewport 事件解绑
- 轻级 #30 `_injectTexts` GC

## Notes

- **8 个严重 bug 全部修完**，其中 #5 是一个 typo（`lastDetectedDay` 缺下划线），存在很久没被发现，说明缺 lint
- **原报告说架构 B 能顺手修的 bug** 在批 1 里已经通过单独加 chatIdSnap 手动修完了，所以架构 B 现在只剩纯 DRY 收益 → 用户合理选择暂缓
- audit 报告本身是通过 general-purpose subagent 生成的，效果很好；未来大代码审阅可以复用这个 pattern
- 修复顺序：严重（一次 push）→ 中+轻（一次 push），中间用户验证过一次没回归
- **对未来的自己**：如果 index.js 又涨到 3000+ 行，认真考虑架构 C（拆 views/）；如果又要加一种新的生成（比如"角色关系分析"、"世界地图"这种）就顺手做架构 B
