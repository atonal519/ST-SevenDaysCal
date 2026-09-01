// runtime/settings.js — 设置数据读写 + 开关 + API 预设。Phase 0 从 index.js 机械搬移（业务逻辑不变）。
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

export const PLUGIN_ID  = 'schedule-planner';

export const DEFAULT_SETTINGS = {
    apiUrl  : '',
    apiKey  : '',
    apiModel: '',
    // API 存储快切：把整套 API 配置存成命名预设，多套之间切换。
    // 每项 {id,name,url,key,model,excludeParams,timeoutSec,stream}——即 loadCfg 的完整快照。
    // 与上面扁平的 apiUrl/apiKey/... 并存：那六个字段仍是「当前生效」的唯一真源，
    // 预设是命名快照；切换后立即填入并应用。
    apiPresets       : [],
    apiPresetActiveId: '',   // 上次选中的预设 id，纯 UI 高亮/回显用，不代表已生效
    // 机械任务分流：把「记忆摘要 / 大纲推进判定」这类机械调用路由到某个预设（如便宜小模型），
    // 生成类（点/线/面/间/棱/历）始终走上面主 API。空=不分流、全走主 API（与旧版行为一致）。
    // 存的是预设 id；指向的预设被删或缺 url/key 时，loadUtilityCfg() 自动退回主 API。
    utilityPresetId  : '',
    fabShow : true,
    // 插件总开关：false = 构画完全隐身（藏悬浮球 / 楼内块 / 锚点收藏入口，停一切后台判定与潜伏注入），如同未安装；
    // 设置面板仍可从酒馆魔杖菜单进入以重新开启。默认开。
    pluginEnabled: true,
    // 潜伏注入总闸（受 pluginEnabled 统辖）：false = 线 / 面 / 刻度不注入主楼 AI（不影响楼内展示与手动生成）。默认开。
    injectEnabled: true,
    // 时间戳·时间锚点体系（只受 pluginEnabled + 自身开关统辖，独立于线/面注入闸）：强制主楼 AI 每楼正文首尾打时间戳
    // <!-- SDC-start … --> / <!-- SDC-end … -->，构画回读作时间源。默认开——全插件时间地基。
    storyClockEnabled: true,
    storyClockPrompt : '',       // 时间戳提示词正文；空=用内置完整默认，非空按 storyClockPromptVersion 解释
    storyClockPromptVersion: 0,  // 0/缺省=旧版基础正文+机器合同；2=用户编辑的完整文本，按原样注入
    themeMode: 'auto',   // 'auto' | 'day' | 'night' — 'auto' follows ST theme; day/night force
    uiScale: 1.0,        // 界面字号缩放倍率：--sp-scale 的持久值（设置里 −/＋ 步进，默认 1.0＝100%），脱钩酒馆 Font Scale
    adultBlurEnabled: true, // 成人点线默认模糊（纯显示偏好）
    uiFontUrl   : 'https://fontsapi.zeoseven.com/387/main/result.css',  // 字体 CSS(@font-face) 的 URL：经动态 <link> 引入。默认＝zeoseven 387 有爱圆体(Nowar Rounded TW Wc)，unicode-range 分片、移动端友好。留空=不加载网络字体、只用系统栈
    uiFontFamily: 'Nowar Rounded TW Wc',                                // 生效字体 family 名：写进 --sp-font-user。须与 uiFontUrl 那份 CSS 里 @font-face 声明的 font-family 完全一致，否则加载了也不生效
    notifyMode: 'lite',  // 通知提醒档：'off'=全静音 / 'lite'(默认)=仅你手动生成·刷新时提示 / 'full'=另在后台自动改动点线面历时提示（真改动才弹）
    linesEnabled : true, // master switch: false disables line generation/advance and latent injection; inline display is independently controlled
    linesInterval: 2,
    linesMode: 'turns',  // 'turns' | 'days' | 'manual'
    linesInject: false,  // 潜伏注入：活跃线隐形注入主楼 AI（IN_CHAT/SYSTEM）；默认关（改 AI 行为+token 成本，opt-in）
    dashedEnabled: false, // 冷知识自动生成/楼层展示：跟线多生成两条；历史与面板手动生成不受此开关删除或阻断
    dashedCleanupEnabled: true, // 冷知识历史自动清理：只限制未锁条目，锁定项不计入数量
    dashedKeepCount: 15,
    outlineInject: false,       // 大纲自动注入：开启后每 N 楼独立判定剧情推进到哪个节点，把当前/下个节点隐形注入主楼 AI。多判定 API 调用，默认关 opt-in
    outlineJudgeInterval: 3,    // 大纲推进判定节奏：每几条 AI 回复跑一次推进判定（独立于线的 linesInterval，不耦合）
    almanacInlineEnabled: true, // 历·日程块：最新 AI 楼底部挂一块折叠条——标题条仿线块，点开是今天头和往后六天格；只读，独立于线主开关；默认开，关掉即不注入聊天
    linesInlineEnabled  : true, // 线·楼内块：最新 AI 楼底部展示活跃线块（只读展示，独立于线主开关 linesEnabled）；默认开，关掉只隐藏楼内块、不影响线的推进与隐形注入
    scheduleInlineEnabled: true, // 点·楼内日程条：最新 AI 楼底部挂一块折叠条——标题条仿线块，点开是每天一格（周X+日期+天气+待办数，可点开看当天事件）；只读，反映当前视角的点，默认开
    ledgerInlineEnabled : true, // 标注池·楼内框开关：AI 楼挂「标注池」（活跃暗历条目 + 打捞/更新/锁定/归档操作）；与注入 ledgerInject 解耦、与用户楼召回(recallInlineEnabled)各自独立；默认开
    recallInlineEnabled : true, // 召回·楼内框开关：用户楼挂「召回」框（本回合注入回显·丰富版：类型+标题+起始+推测应至状态）；与 AI 楼标注池独立、与注入解耦；默认开
    inlineRenderEnabled : true, // 楼内渲染框·主开关：关掉则整框不渲（点/线/轴/标注池/召回子开关一并失效）；默认开。子开关只在主开关开时才起作用
    // 楼内仪表盘：布局固定（今头 + 历/点/线三区），无需配序；旧的 inlineOrder 已随仪表盘重构退役。
    // 楼内统一框·渲染深度：按最近 N 个 AI 楼确定窗口，窗口覆盖其间用户楼；最新 AI/用户楼读活态，其余读快照。
    // 0 或缺 = 跟随酒馆助手 render_depth（读不到再退 INLINE_RENDER_DEPTH_FALLBACK）。默认 0=跟随。
    inlineRenderDepth: 0,
    // 剧情日期检测（写共享 dateAnchor[charKey]，见 getDateAnchor）：戳优先——戳开时每楼直读戳落地「今天」，零 API；
    // 读不到戳（漏打 / 「谷雨」无月日）才由 almanacAutoDetect 决定是否隔 N 楼调一次 API 兜底。点纯下游连带跟随，无独立判定。
    almanacAutoDetect    : true,  // 读不到戳时用 API 兜底判定（戳关时＝历自动判定总开关，回落老行为）
    almanacJudgeInterval : 3,     // API 兜底节奏：每几条 AI 回复兜底一次
    scheduleAutoDetect   : false, // 点·后台自动跟随「今天」：开＝历今天变了自动重排点（多一次 API）；关（默认）＝只手动刷新点时对齐今天
    // 暗账·标注：每 N 楼构画 AI 从正文捞「需按时间追踪」的新事件写入 sp-ledger（伤情/身心/约定/周期）。
    // 独立开关+间隔，关掉即不触发 API；默认关（opt-in，多一路后台判定+API 成本，照 outlineInject 的克制）。
    ledgerCaptureEnabled : false, // 暗账标注：默认关
    ledgerCaptureInterval: 5,     // 标注节奏：每几条 AI 回复捞一次新事件
    ledgerJudgeInterval  : 4,     // 判定节奏：每几条 AI 回复重算一次现状（与标注同受 ledgerCaptureEnabled 总闸）
    ledgerInject         : false, // 暗历潜伏注入主楼 AI：默认关（opt-in，多一路注入+略增 token，照 linesInject/outlineInject 的克制）
    // Memory system
    memoryEnabled  : true,
    memoryL0Group  : 5,    // AI floors per L0 entry
    memoryL1Group  : 10,   // L0 entries per L1 chapter
    memorySkipShort: 50,   // skip AI floors shorter than N chars
    useBaiBaiBook  : false, // if true, pull history from 柏宝书 getInjectedHistory() and skip built-in memory entirely
    useAnima       : false, // if true, read summaries from Anima's chat-bound worldbook (anima_summary entries) and skip built-in memory
    useDatabase    : false, // if true, retrieve raw TavernDB summary entries from the selected/default worldbook
    databaseWorldbookName: '', // empty follows the character primary worldbook; otherwise freeze this exact host book name
    animaRecallCount: 20,
    // Tag sanitizer (used by memory.js:stripTags AND anywhere else that reads
    // AI floor content). Both are comma-separated Unicode tag names; optional surrounding <> are normalized away.
    keepTags       : 'content',  // protect list — contents inside these tags survive stripping
    extraTags      : '',         // extra strip list — forcibly delete these tags + their content
    customPrompt   : '',         // 创作链自定义写作规范；机械链只使用统一基础处理层
    spacePersona   : '',         // 间·人格覆盖：空=用内置默认语气（ADVISOR_TONE_GUIDE）；非空=换间的语气/行文/人格（顾问身份恒保留、不可覆盖）
    // 棱（小剧场）
    theaterStylePrompt   : '',   // 写作 agent 文风提示词
    theaterBeautifyPrompt: '',   // 美化 agent 提示词（空=用内置默认）
    // 坐标（收藏楼层）
    anchorInlineBtn      : true,               // 楼层头部显示「收藏此楼」入口（关掉则只能从别处收藏，暂无）
    anchorSizeWarnBytes  : 8 * 1024 * 1024,    // 坐标收藏占用预警阈值（快照带样式偏大，给足余量）
    // 历法模板保存可复用描述符；绑定表以角色 avatar 精确映射模板 id。
    calendarTemplates    : [],
    calendarTemplateBindings: {},
};

export function getSettings() {
    const s = extension_settings[PLUGIN_ID] ??= { ...DEFAULT_SETTINGS };
    // 老用户的设置段可能缺后加字段（如 customPrompt）：逐一补默认值，只补缺失、不覆盖已有值。
    for (const k in DEFAULT_SETTINGS) if (!(k in s)) s[k] = DEFAULT_SETTINGS[k];
    // 展开默认对象时数组仍会共享引用；设置层必须持有自己的容器。
    if (s.calendarTemplates === DEFAULT_SETTINGS.calendarTemplates) s.calendarTemplates = [];
    if (s.calendarTemplateBindings === DEFAULT_SETTINGS.calendarTemplateBindings) s.calendarTemplateBindings = {};
    return s;
}

export function parseExcludeParams(text) {
    return [...new Set(String(text || '').split(/[\n,，]/).map(s => s.trim()).filter(Boolean))];
}

export function normalizeApiTimeout(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 5 && n <= 600 ? n : 180;
}

export function loadCfg() {
    const s = getSettings();
    return {
        url          : s.apiUrl   || '',
        key          : s.apiKey   || '',
        model        : s.apiModel || '',
        excludeParams: Array.isArray(s.apiExcludeParams) ? s.apiExcludeParams : [],
        // 单次请求超时（秒），默认 180；覆盖建连+读取全程，防 socket hang up 卡死
        timeoutSec   : normalizeApiTimeout(s.apiTimeoutSec),
        stream       : s.apiStream === true,
    };
}

export function loadUtilityCfg() {
    const id = getSettings().utilityPresetId || '';
    if (!id) return loadCfg();
    const p = loadApiPresets().find(x => x.id === id);
    if (!p || !p.url || !p.key) return loadCfg();   // 预设被删/缺 url/key → 退回主 API
    return {
        url          : p.url   || '',
        key          : p.key   || '',
        model        : p.model || '',
        excludeParams: Array.isArray(p.excludeParams) ? p.excludeParams : [],
        timeoutSec   : normalizeApiTimeout(p.timeoutSec),
        stream       : p.stream === true,
    };
}

export function saveCfg(c) {
    const s = getSettings();
    s.apiUrl           = c.url   || '';
    s.apiKey           = c.key   || '';
    s.apiModel         = c.model || '';
    s.apiExcludeParams = Array.isArray(c.excludeParams) ? c.excludeParams : [];
    s.apiTimeoutSec    = normalizeApiTimeout(c.timeoutSec);
    s.apiStream        = c.stream === true;
    saveSettingsDebounced();
}

export function loadApiPresets() {
    const arr = getSettings().apiPresets;
    return Array.isArray(arr) ? arr : [];
}

export function genPresetId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function upsertApiPreset(name, cfg, id) {
    const list = loadApiPresets();
    const timeout = normalizeApiTimeout(cfg?.timeoutSec);
    const snap = {
        name         : String(name || '').trim() || '未命名',
        url          : cfg.url   || '',
        key          : cfg.key   || '',
        model        : cfg.model || '',
        excludeParams: Array.isArray(cfg.excludeParams) ? cfg.excludeParams : [],
        timeoutSec   : timeout,
        stream       : cfg.stream === true,
    };
    const existing = id ? list.find(p => p.id === id) : null;
    if (existing) { Object.assign(existing, snap); }
    else { snap.id = genPresetId(); list.push(snap); id = snap.id; }
    getSettings().apiPresets = list;
    getSettings().apiPresetActiveId = id;
    saveSettingsDebounced();
    return id;
}

export function deleteApiPreset(id) {
    const list = loadApiPresets().filter(p => p.id !== id);
    getSettings().apiPresets = list;
    if (getSettings().apiPresetActiveId === id) getSettings().apiPresetActiveId = '';
    saveSettingsDebounced();
}

export function renameApiPreset(id, name) {
    const p = loadApiPresets().find(x => x.id === id);
    if (!p) return;
    const nm = String(name || '').trim();
    if (nm) p.name = nm;
    saveSettingsDebounced();
}

export function fabEnabled() { return getSettings().fabShow !== false; }

export function pluginEnabled() { return getSettings().pluginEnabled !== false; }

export function injectEnabled() { return pluginEnabled() && getSettings().injectEnabled !== false; }

export function getLinesInterval() {
    const v = parseInt(getSettings().linesInterval, 10);
    return Number.isFinite(v) && v >= 1 ? v : 2;
}

export function saveLinesInterval(n) {
    getSettings().linesInterval = Math.max(1, parseInt(n, 10) || 2);
    saveSettingsDebounced();
}

export function getLinesMode() {
    const m = getSettings().linesMode;
    return m === 'days' || m === 'manual' ? m : 'turns';
}

export function saveLinesMode(mode) {
    const valid = (mode === 'days' || mode === 'manual') ? mode : 'turns';
    getSettings().linesMode = valid;
    saveSettingsDebounced();
}
