# 2026-07-19 加"使用柏宝书作为记忆源"开关

## 起因
承接前一天（2026-07-18）的 days-mode 柏宝书接入。用户想更进一步：如果装了柏宝书，让 7dayscal 直接消费柏宝书的记忆，不再跑自己的 L0/L1 那套。

用户的边界：
- 开则**完全走**柏宝书，**不 fallback** 到内置
- 关则**完全走**内置
- 柏宝书没就绪 + 开关 ON 的组合 → 不塞历史（宁可空也不误报）

## 方案
新增 `useBaiBaiBook` setting，控制整套 memory 路径的走向：

### 分派：`getMemText()`（index.js）
新加一个函数在 `buildMessages` 上面，把 `index.js:1486` 原来直接调 `memory.getMemoryContext()` 的那一句换掉。

```js
function getMemText() {
    const s = getSettings();
    if (s.useBaiBaiBook) {
        const api = globalThis.STBaiBaiBook;
        if (!api?.getInjectedHistory) {
            // console.info 一次，返回空字符串（不 fallback）
            return '';
        }
        try { return api.getInjectedHistory()?.relativeText || ''; }
        catch { return ''; }
    }
    return memory.getMemoryContext();
}
```

### 内置 memory 五个 handler 加统一守卫（memory.js）
`onCharacterMessageRendered` / `onMessageMutated` (swipe & edit 复用) / `onChatChanged` / 匿名 MESSAGE_DELETED 顶部一律加：
```js
if (_getSettings().useBaiBaiBook) return;
```
`getMemoryContext` 顶部也加一句同款——belt & suspenders，防止有别的路径漏改。

`initMemory` callback 里多 forward 一个 `useBaiBaiBook: !!s.useBaiBaiBook` 字段。

### UI
`index.js:680-728` 那段整段包一层 `<div id="sp-mem-internal">`，顶部加：
```html
<label class="sp-mode-opt sp-mem-source-toggle">
    <input type="checkbox" id="sp-mem-source-bbb">
    <span>使用柏宝书作为记忆源</span>
</label>
<div id="sp-mem-bbb-status" class="sp-cfg-hint" style="display:none"></div>
```

`renderMemorySection` 里根据 `useBaiBaiBook` 分派：
- ON：`#sp-mem-internal` 隐藏，`#sp-mem-bbb-status` 显示（读 `getInjectedHistory().coverage.complete/missingAiFloors.length` 做提示）
- OFF：反过来，走原来的分层记忆参数 + 健康报告

事件绑定在 `bindMemoryHandlers` 顶部加 `#sp-mem-source-bbb` change 处理：切到 ON 时顺手 `memory.abortRebuild()` 停正在跑的重建。

## 验证时踩到一个坑
用户切到柏宝书后点"事件线 → 重新生成"，弹了"记忆库不完整"警告。

**根因**：`memoryPreCheckConfirm`（index.js:1169）无脑读 `memory.getHealthReport()`。柏宝书模式下内置队列不再处理 CHARACTER_MESSAGE_RENDERED（被守卫短路），所以 `pending` 永远不为 0，永远误报。

**修**：precheck 顶部先看 useBaiBaiBook，若为 true 则走柏宝书自己的完整性检查：
- 柏宝书 API 不在 → "柏宝书未就绪"提示
- `getInjectedHistory().coverage.complete === false` → "柏宝书记忆未覆盖完整"，告诉用户缺几楼
- 都 OK → 直接返回 true（不弹）

顺手把 `loadingHtml`（index.js:1224）的 `memory.isMemoryBusy()` 也套一层 `!useBaiBaiBook && ...`——柏宝书模式没内置队列，别再说"正在补全记忆并…"。

## 冒烟测试（node 单跑 getMemText）
```
useBaiBaiBook=false                         → 内置摘要
useBaiBaiBook=true, no api                  → '' + console.info 一次
useBaiBaiBook=true, api throws              → '' + console.warn
useBaiBaiBook=true, empty response          → ''
useBaiBaiBook=true, api ready               → 柏宝书 relativeText
```

## 用户实测验证
用户对着 `🐛 AI 输入` 抽屉看到 `【故事记忆库】` 段后半截换成了柏宝书格式（不是 `━ 早期章节 ━` / `【第 X - Y 楼】` 那种内置标签）——路径验证过关。

## 未做（延后）
- 用柏宝书 `getSnapshot()` 里的 `vars/items/plans/scenes/npcs` 支撑大纲/事件线的其他维度（当前只接了 history 那部分）
- 开关切回内置时自动 `fillMissing`：用户可以自己点"补齐缺失"按钮
- 切到 BBB 时清空正在跑的 `_queue`：目前只 abortRebuild，队列里已有任务会跑完（浪费一次 API 但不出错）

## 关键改动
- `index.js`：DEFAULT_SETTINGS、initMemory callback、`getMemText`、`buildMessages` 的 memText 出处、UI HTML、`renderMemorySection`、`bindMemoryHandlers`、`memoryPreCheckConfirm`、`loadingHtml`
- `memory.js`：5 个 handler + `getMemoryContext` 顶部加守卫
