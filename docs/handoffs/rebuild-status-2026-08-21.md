# `rebuild` 分支交接（2026-08-21）

## 分支与发布状态

- 基线：`ea75885 release: v3.3.2`
- 开发分支：`rebuild`
- `manifest.json` 仍为 `3.3.2`
- 本分支不是正式发布：没有 tag、Release 或 master 合并

## 已完成并经只读 reviewer 验收

### 通用异步任务边界

- 新增 `runtime/task-owner.js` 与 `runtime/task-orchestration.js`。
- 点的手动生成、自动同步具备 token/chatId/chatRevision/abort/owner-only cleanup。
- 切聊天、插件关闭、旧 finally、旧 toast/timer 不再污染新聊天任务。

### CalendarDate 与点

- 新增 `business/calendar/*`、`business/point/date-context.js`、`business/point/mutations.js`。
- 默认公历闰年、真实 weekday、多年加减已修正。
- 自定义历法支持 13 月、单月超过 31 日及 exact-or-unknown。
- 点渲染、楼内日期、锁定和删除保留 StartDate、空 Day、Future、天气与 pin。

### Chat-local dateAnchor 与 snapshot 最小闭环

- dateAnchor 使用当前聊天本地记录，不再在失败时写回角色全局值。
- `state:auto`、显式 legacy claim/cancel、失败提示已接入。
- snapshot v2 携带完整 calendar；旧 v1 使用 write-once fallback。
- 历史历/点/masthead/story-clock/ledger/recall 及 drawer 使用 resolved calendar。
- 本分支不追求 DB 级 ACID 或可确认磁盘耐久性。

### 固定目标 metadata saver 地基

- 新增 `runtime/target-metadata-save.js`。
- 精确 owned 子路径 delta、latest rebase、integrity test、固定单聊/群聊 target。
- 409/网络不确定状态和 cache 处理已有测试。
- **尚未接入 `commitCalendarDesc`**；不得宣称历法联合迁移已经生产启用。

### 线模块 Phase 1

- 新增 `business/lines/schema.js`、`mutations.js`、`prompt.js`、`render.js`、`state.js`、`generation.js`。
- 旧 5/7/8 字段 raw 宽容读取；新 AI response 严格校验完整 widget 与三行顺序。
- 手动 replace 不预删旧数据；失败、abort、stale、非法或容量超限均保留旧 raw/cache/DOM。
- 生成提交前检查 `{raw,ts}` baseline；旧任务不能覆盖用户刚做的 pin/delete。
- `lines-generation` task owner 已接入；CHAT_CHANGED 立即 abort/清 busy。
- `已爆发` 纳入终态；线自由文本日期不再作为轴“今天”的权威来源。
- 最终超过 6 条时整次拒绝，不静默删除锁定线。

### 视觉小修

- `style.css` 保留已人工验证的线阶段胶囊/珠子容器宽度修复。

## 自动化验证

测试套件目前位于服务器仓库外：

```text
/home/admin/ST-SevenDaysCal-local-tests
```

它没有包含在本插件 Git 分支中。最后一次结果：

- baseline：14/14 通过；
- known-fail：2 个预期 ledger TODO；
- all：通过；
- TODO harness 自测：通过；
- 修改/新增 JS/MJS `node --check`：通过；
- `git diff --check`：通过。

服务器验证命令：

```bash
node /home/admin/ST-SevenDaysCal-local-tests/run.mjs \
  --group all \
  --repo /home/admin/sillytavern/public/scripts/extensions/third-party/ST-SevenDaysCal
```

回家环境如需继续使用测试，应单独复制该目录，或在明确决定后迁入开发分支专用目录；不要直接放入扩展发布资源。

## 明确保留的 TODO / 止损边界

- ledger 跨 cycle 的完整 exact-or-unknown。
- ledger 深层事务回滚。
- `commitCalendarDesc` 尚未启用 metadata saver/calendar transaction。
- 不做数据库级 ACID、跨聊天全局唯一 anchor claim 或宿主磁盘成功确认。
- 旧 `lines-char-*` 保留，不自动迁移、合并或删除。
- 线本轮不做 schema v2、稳定 ID、pipe codec 迁移。
- swipe/CMR/controller 大迁移和 CSS 全量语义类改名尚未开始。
- GLM 偶发截断/finish_reason 诊断尚未实施。
- `{{user}}` 偶尔未替换尚未排查。

## 建议人工冒烟

### 点/轴

- A 生成中切 B；B 立即生成。
- 生成中关闭并重新开启插件。
- 自定义 13 月 40 日：渲染、锁定、删除。
- 同角色 A/B 聊天分别设置 dateAnchor。
- 历史楼主块与 drawer 使用同一旧历法。
- legacy anchor 的领取、取消与写失败提示。

### 线

- 有旧线时重新生成，模拟 API 缺失/失败/中止。
- 生成中切聊天。
- 生成期间修改 pin，迟到结果应 stale 拒绝。
- 6 条结果加缺失 pinned，应拒绝并保留旧 raw。
- `已爆发` 不再潜伏注入或自动推进。
- `linesEnabled=false` 时自动化停止；`linesInlineEnabled` 仍独立控制楼内显示。

## 注意事项

- 当前工作树包含多个阶段的联合改动，不要用 `git reset --hard`、`checkout --` 或整目录覆盖处理冲突。
- 后续继续按“小阶段 + 本地测试 + 独立 reviewer”推进。
- 发布时另行决定版本号、manifest、tag 与 master 合并；不要从本开发分支直接冒充 release。
