import { icon } from '../../utils/icons.js';
// 楼内统一渲染窗口：宿主只注入内容 builder、快照与运行时依赖。
// 这里不保存业务数据；DOM 生命周期与观察器由本 feature 独占。

const BOX_SELECTOR = '.sp-inline-box';
const RENDER_DEPTH_FALLBACK = 6;

export function createInlineFeature(env = {}) {
    const getSettings = env.getSettings || (() => ({}));
    const pluginEnabled = env.pluginEnabled || (() => true);
    const extensionSettings = env.extensionSettings || {};
    const doc = env.documentRef || globalThis.document;
    const win = env.windowRef || globalThis.window;
    let inlineObserver = null;
    let chatObserver = null;
    let refreshTimer = null;
    let chatMutationTimer = null;
    let chatRetryTimer = null;
    let initialized = false;
    let delegated = false;
    let pendingExpandScroll = null;
    const getContext = env.getContext;
    const loadAlmanac = env.loadAlmanac;
    const almTodayAnchor = env.almTodayAnchor;
    const loadCalDesc = env.loadCalDesc;
    const almWeekdayRef = env.almWeekdayRef;
    const almDayOfYear = env.almDayOfYear;
    const almWeekdayFor = env.almWeekdayFor;
    const ALM_WEEKDAYS = env.ALM_WEEKDAYS;
    const escapeHtml = env.escapeHtml;
    const calMonthName = env.calMonthName;
    const getDateAnchor = env.getDateAnchor;
    const charStableKey = env.charStableKey;
    const readCacheRaw = env.readCacheRaw;
    const getCacheKey = env.getCacheKey;
    const parseCalendar = env.parseCalendar;
    const weatherGlyph = env.weatherGlyph;
    const calHasEra = env.calHasEra;
    const validRealDate = env.validRealDate;
    const formatStoryClockHeadParts = env.formatStoryClockHeadParts;
    const storyClockEnabled = env.storyClockEnabled;
    const latestStoryClock = env.latestStoryClock;
    const readStore = env.readStore;
    const getLinesCacheKey = env.getLinesCacheKey;
    const parseLines = env.parseLines;
    const linesFeature = env.linesFeature;
    const snapshot = env.snapshot;
    const keyDesc = env.keyDesc;
    const createWeekdayConsumerContext = env.createWeekdayConsumerContext;
    const storyWeekdayRefPure = env.storyWeekdayRefPure;
    const ALM_CHAT_SCAN_LIMIT = env.ALM_CHAT_SCAN_LIMIT;
    const pointInlineRenderer = env.pointInlineRenderer;
    const axisInlineRenderer = env.axisInlineRenderer;
    const $ = env.$;
    const _buildLedgerBlockHtml = env._buildLedgerBlockHtml;

    // 轴块的历法渲染由 axisInlineRenderer 持有；最新楼读实时数据，历史楼使用快照。
    const _buildAlmanacBlockHtml = (...args) => axisInlineRenderer.buildAlmanacBlock(...args);
    // 点块委托给 pointInlineRenderer；最新楼读当前用户数据，历史楼读快照且只读。
    const _buildScheduleBlockHtml = (...args) => pointInlineRenderer.buildScheduleBlock(...args);

    // 日程条：某一天(dayKey='0'|'1'|…|'future') 的就地详情 HTML（点某格时填进 .sp-sch-sday）。
    // 每次都重读 raw（点 raw 会被重算/锁定改写），按天筛事件；空 → 「这天没有安排」。
    // dayKey='0'|'1'|…|'future'。rawArg=null 读 canonical user 活缓存（最新楼）；字符串=快照 raw（历史楼）。
    // readOnly=true 时 drawer 去掉注入/删除按钮（历史楼只读）。

    // 日程条 per-day tap：点某格 → 下方就地展开当天事件（再点同格收起、点别格切换）。委托到 document、
    // 只注册一次——块会被 #chat observer 反复重建，不能绑在块自身上；只对 .sp-sch-strip-live 生效。
    function initScheduleStripDelegation() {
        pointInlineRenderer.bindScheduleStripDelegation({ $, inlineTapContext: inlineTapContext });
    }

    // 每个实际渲染出的顶层子模块在末尾提供同一枚原生收起按钮。事件委托挂在 document，
    // 因此楼层重绘后无需逐节点重绑；历史只读楼也允许执行这项纯显示操作。
    function initRegionCollapseDelegation() {
        $(doc).on('click.spinlineregioncollapse', '.sp-inline-box.sp-dash > .sp-dash-body > details.sp-dash-region > .sp-inline-region-collapse', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const region = this.closest?.('details.sp-dash-region');
            if (!region) return;
            region.open = false;
            const summary = region.querySelector?.(':scope > summary');
            if (!summary?.focus) return;
            try { summary.focus({ preventScroll: true }); }
            catch { summary.focus(); }
        });
    }

    const requestFrame = callback => {
        if (typeof win?.requestAnimationFrame === 'function') return { type: 'window', id: win.requestAnimationFrame(callback) };
        if (typeof globalThis.requestAnimationFrame === 'function') return { type: 'global', id: globalThis.requestAnimationFrame(callback) };
        return { type: 'timer', id: setTimeout(callback, 0) };
    };
    const cancelFrame = frame => {
        if (!frame) return;
        if (frame.type === 'window') win?.cancelAnimationFrame?.(frame.id);
        else if (frame.type === 'global') globalThis.cancelAnimationFrame?.(frame.id);
        else clearTimeout(frame.id);
    };
    const cancelExpandScroll = () => {
        const pending = pendingExpandScroll;
        if (!pending) return;
        pendingExpandScroll = null;
        cancelFrame(pending.frame);
        for (const type of pending.intentEvents) pending.chat.removeEventListener?.(type, pending.cancelOnIntent, true);
    };
    const expandScrollStillCurrent = pending => {
        if (pendingExpandScroll !== pending || !initialized) return false;
        if (!pluginEnabled() || getSettings().inlineRenderEnabled === false) return false;
        if (doc?.querySelector?.('#chat') !== pending.chat) return false;
        if ((getContext().chatId ?? null) !== pending.chatId) return false;
        if (pending.details.open !== true || pending.summary.parentElement !== pending.details) return false;
        if (pending.summary.isConnected === false || !pending.chat.contains?.(pending.summary)) return false;
        return true;
    };
    const runExpandScrollFrame = pending => {
        pending.frame = null;
        if (!expandScrollStillCurrent(pending)) { cancelExpandScroll(); return; }
        const currentTop = Number(pending.summary.getBoundingClientRect?.().top);
        const scrollTop = Number(pending.chat.scrollTop);
        const scrollHeight = Number(pending.chat.scrollHeight);
        const clientHeight = Number(pending.chat.clientHeight);
        if (![currentTop, scrollTop, scrollHeight, clientHeight].every(Number.isFinite)) { cancelExpandScroll(); return; }
        const delta = currentTop - pending.top;
        const maxScroll = Math.max(0, scrollHeight - clientHeight);
        const nextScroll = Math.min(maxScroll, Math.max(0, scrollTop + delta));
        if (Math.abs(delta) >= 0.5 && Math.abs(nextScroll - scrollTop) >= 0.5) pending.chat.scrollTop = nextScroll;
        pending.framesLeft -= 1;
        if (pending.framesLeft <= 0) cancelExpandScroll();
        else pending.frame = requestFrame(() => runExpandScrollFrame(pending));
    };
    const initExpandScrollDelegation = () => {
        const selector = '.sp-inline-box.sp-dash > summary, .sp-inline-box.sp-dash > .sp-dash-body > details.sp-dash-region[data-seg] > summary, .sp-inline-box.sp-dash details.sp-alm-event > summary';
        $(doc).on('click.spinlinescroll', selector, function (event) {
            cancelExpandScroll();
            if (event.defaultPrevented || event.isDefaultPrevented?.()) return;
            if (event.target?.closest?.('a, button, input, select, textarea, [contenteditable], [role="button"]')) return;
            const summary = this;
            const details = summary.parentElement;
            if (!details || details.open === true) return;
            const chat = doc?.querySelector?.('#chat');
            if (!chat?.contains?.(summary)) return;
            const top = Number(summary.getBoundingClientRect?.().top);
            if (!Number.isFinite(top)) return;
            const pending = {
                summary,
                details,
                chat,
                chatId: getContext().chatId ?? null,
                top,
                framesLeft: 2,
                frame: null,
                intentEvents: ['wheel', 'touchmove', 'pointerdown', 'keydown'],
                cancelOnIntent: null,
            };
            pending.cancelOnIntent = () => { if (pendingExpandScroll === pending) cancelExpandScroll(); };
            for (const type of pending.intentEvents) chat.addEventListener?.(type, pending.cancelOnIntent, { capture: true, passive: type !== 'keydown' });
            pendingExpandScroll = pending;
            pending.frame = requestFrame(() => runExpandScrollFrame(pending));
        });
    };

    // 楼内块按轴、标注池、点、线顺序组合；最新楼读实时数据，历史楼读快照并只读。
    function dashAnchor(snap) {
        return (snap?.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
            ? { month: +snap.anchor.month, day: +snap.anchor.day, ...(Number.isInteger(+snap.anchor.year) ? { year: +snap.anchor.year } : {}), ...(typeof snap.anchor.eraLabel === 'string' && snap.anchor.eraLabel.trim() ? { eraLabel: snap.anchor.eraLabel.trim() } : {}) }
            : almTodayAnchor();
    }

    // 日期上下文来自锚点、历条目或点数据；没有日期和任何内容时不显示楼内块。
    function hasDateContext(snap) {
        if (snap) return !!((Array.isArray(snap.almanac) && snap.almanac.length) || snap.point || snap.anchor);
        let pinned = false;
        try { pinned = !!getDateAnchor(charStableKey(getContext())); } catch { pinned = false; }
        if (pinned) return true;
        try { if (loadAlmanac().length) return true; } catch { /* 忽略 */ }
        try { if (readCacheRaw(getCacheKey('user', ''))) return true; } catch { /* 忽略 */ }
        return false;
    }

    // 折叠态（整框收成一小条）的摘要内层：当前日期/星期/天气/时刻与真实模块计数。
    // 当前日期和天气是该楼的时间身份，只要拿得到日期就恒显——不受点/线/历子开关影响
    // （子开关只管展开面板里那几个区显不显，日期/天气来自剧情锚点+点数据，与显示开关无关）。
    // chips 则跟着子开关走：只给「开着且有内容」的区计数（关掉的区不该在摘要里冒计数）。
    // flat=true：整框只剩这一条（点线历都关但有日期）→ 用 <div> 包、无折叠箭头、不可展开。
    // 时间戳·窄条抬戳：最新楼扫到戳时，戳「抬」成当天身份（end 优先）——
    //   数字戳（2024-10-08 15:10 / 10月8日 …）→ 解析成规整「年月日 周几」，把「时」挪到天气之后；
    //   古风/无法解析（谷雨亥时 / 霜月初三）→ 原样抬（无周几）；完全无戳/关/历史楼 → 锚点兜底日期。
    //   星期沿已确认结构戳或该楼锚点，不猜未知星期。
    //   与展开区 storyClockBarHtml（带标签+起→止）互补。
    // 从戳原文抠数字日期/时刻。返回 {year?,month,day,time?}；抠不出数字日期 → null（交回原样抬）。
    function stampDate(stamp) {
        const s = String(stamp || '');
        let year = null, month = null, day = null, time = '';
        let m;
        if ((m = s.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/))) {
            year = +m[1]; month = +m[2]; day = +m[3];
        } else if ((m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/))) {
            month = +m[1]; day = +m[2];
        }
        if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;   // 非数字日期 → 原样抬
        if (year != null && !validRealDate(year, month, day)) return null;                  // 严格拒绝 Date 自动归一化日期
        if ((m = s.match(/(\d{1,2})\s*[:：]\s*(\d{2})/)))   time = `${+m[1]}:${m[2]}`;
        else if ((m = s.match(/(\d{1,2})\s*[时點点]/)))     time = `${+m[1]}时`;
        return { year, month, day, time };
    }
    // 组窄条「今 …」那截：自定义历法只信通过当前月序/日数校验的结构化戳；
    // 越界或无精确日期时回退已确认锚点，不能把 raw/公历数字回退冒充成今天。
    function clockHeadParts(isLatest, a, anchorWd, floorClock = null, calendarOverride = undefined) {
        const renderCalendar = calendarOverride === undefined ? loadCalDesc() : calendarOverride;
        const format = (options = {}) => {
            const parts = formatStoryClockHeadParts({ anchor: a, anchorWeekday: anchorWd, calendar: renderCalendar, monthName: calMonthName, escapeHtml, ...options });
            const date = options.clockMeta || options.stampDate || a;
            const displayedEra = String(date?.eraLabel || (renderCalendar?.displayStyle === 'classical' ? renderCalendar?.era : '') || '').trim();
            if (calHasEra(renderCalendar) && renderCalendar.era !== displayedEra && !String(options.rawStamp || '').includes(renderCalendar.era)) parts.todayHtml += `<span class="sp-dash-sum-era">${escapeHtml(renderCalendar.era)}</span>`;
            return parts;
        };
        const fallback = format();
        if (!storyClockEnabled()) return fallback;
        let clk = floorClock;
        if (isLatest) {
            try { clk = latestStoryClock(); } catch { clk = null; }
        }
        const stamp = clk && (clk.end || clk.start);
        if (!stamp) return fallback;
        const tip = '时间戳·主楼 AI 每楼隐形打点读回';
        const clockMeta = clk?.endMeta?.valid ? clk.endMeta : (clk?.startMeta?.valid ? clk.startMeta : null);
        if (clockMeta) {
            const weekdayText = clockMeta.weekdayIndex == null ? (anchorWd || '星期未记录') : (ALM_WEEKDAYS[clockMeta.weekdayIndex] || '星期未记录');
            return format({ clockMeta: { ...clockMeta, weekdayText }, tip });
        }
        const customCalendar = renderCalendar
            && renderCalendar.kind !== 'gregorian'
            && renderCalendar.id !== 'default-gregorian';
        if (customCalendar) return fallback;
        const p = stampDate(stamp);
        if (!p) return format({ rawStamp: stamp, tip });   // 古风/无法解析 → 原样抬
        return format({ stampDate: p, tip });
    }
    function dashSummaryHtml(snap, hasDate, almOn, schOn, linesOn, flat = false, isLatest = false, floorClock = null, calendarOverride = undefined, weekdayRefOverride = undefined, ledgerOn = false) {
        const renderCalendar = calendarOverride === undefined ? loadCalDesc() : calendarOverride;
        let head = '';
        if (hasDate) {
            const a = dashAnchor(snap);
            let wd = '星期未记录';
            try {
                const meta = floorClock?.endMeta?.valid ? floorClock.endMeta : (floorClock?.startMeta?.valid ? floorClock.startMeta : null);
                const localRef = weekdayRefOverride !== undefined ? weekdayRefOverride : (meta?.weekdayIndex == null ? (!snap ? almWeekdayRef(renderCalendar) : null) : { refDoy: almDayOfYear(meta.month, meta.day, renderCalendar), refWd: meta.weekdayIndex });
                const wdIndex = almWeekdayFor(a.month, a.day, localRef, renderCalendar);
                if (wdIndex != null) wd = ALM_WEEKDAYS[wdIndex] || '星期未记录';
            } catch { /* unknown */ }
            // 天气：从点当天格（days[0].weather）拿，与大头 masthead 同源；拿不到就不显。历史楼用快照点 raw。
            let wxHtml = '';
            try {
                const raw = snap ? (snap.point || '') : readCacheRaw(getCacheKey('user', ''));
                if (raw) {
                const wx = String(parseCalendar(raw, renderCalendar).days?.[0]?.weather || '').trim();
                    if (wx) wxHtml = `<span class="sp-dash-sum-wx">${weatherGlyph(wx)}</span>`;
                }
            } catch { /* 天气拿不到就不显 */ }
            const parts = clockHeadParts(isLatest, a, wd, floorClock, renderCalendar);
            head = `${parts.todayHtml}${wxHtml}${parts.timeHtml}`;
        }
        const chips = [];
        if (almOn) {
            const items = snap ? (snap.almanac || []) : loadAlmanac();
            chips.push(`<span class="sp-dash-sum-chip">轴${Array.isArray(items) ? items.length : 0}</span>`);
        }
        if (schOn) {
            let n = 0;
            try {
                const raw = snap ? (snap.point || '') : readCacheRaw(getCacheKey('user', ''));
                const { days, future } = parseCalendar(raw || '', renderCalendar);
                n = (days || []).reduce((s, d) => s + (d.events?.length || 0), 0) + (future?.events?.length || 0);
            } catch { n = 0; }
            chips.push(`<span class="sp-dash-sum-chip">点${n}</span>`);
        }
        if (linesOn) {
            let n = 0;
            try {
                const raw = snap ? (snap.line || '') : (readStore(getLinesCacheKey())?.raw || '');
                n = parseLines(raw).length;
            } catch { n = 0; }
            chips.push(`<span class="sp-dash-sum-chip">线${n}</span>`);
        }
        if (ledgerOn) chips.push('<span class="sp-dash-sum-chip">标注池</span>');
        const chipsHtml = chips.length ? `<span class="sp-dash-sum-chips">${chips.join('')}</span>` : '';
        // 时间戳已抬进 head 的「今 …」那截（见 clockHeadParts），此处不再单列一段。
        const inner = `${head}${chipsHtml}`;
        // 只有日期没有任何区 → 纯日期条：<div> 包、无箭头、不可折叠（点了也没东西展开）。
        if (flat) return `<div class="sp-dash-summary sp-dash-summary-flat">${inner}</div>`;
        return `<summary class="sp-dash-summary">${inner}${icon("chevron-down", "sp-dash-sum-caret")}</summary>`;
    }

    // 组合轴、标注池、点、线内容；只有日期或内容均为空时才不挂楼内块。
    function composeInlineBox(snap, isLatest, floorClock = null, floor = null, coldItems = null) {
        const readOnly = !isLatest;
        const fallbackRecord = readStore(keyDesc('caldesc-fallback', 'user', ''));
        const resolvedResult = isLatest ? { resolved: true, calendar: loadCalDesc() } : snapshot.resolveSnapshotCalendar(snap, { fallback: fallbackRecord, marker: !!fallbackRecord, current: loadCalDesc() });
        const resolvedCalendar = resolvedResult.calendar;
        if (!resolvedCalendar) return '<div class="sp-inline-box sp-dash sp-inline-box-ro"><div class="sp-dash-summary sp-dash-summary-flat">历法未知 / 日期未知</div></div>';
        // 轴渲染返回标题与全量事项；点、线和标注池返回内容或空字符串。
        const localWeekdayRef = isLatest ? undefined : createWeekdayConsumerContext({ snapshotRef: snap?.weekdayRef, floor, resolveLocal: f => storyWeekdayRefPure(getContext(), resolvedCalendar, ALM_CHAT_SCAN_LIMIT, f) }).weekdayRef;
        const alm        = _buildAlmanacBlockHtml(snap ? (snap.almanac || []) : null, snap ? snap.anchor : null, resolvedCalendar);
        const schInner   = _buildScheduleBlockHtml(snap ? (snap.point || '') : null, readOnly, resolvedCalendar, localWeekdayRef);
        const linesInner = linesFeature.inlineHtml(snap ? (snap.line || '') : null, readOnly, coldItems ?? snap?.cold);
        // 标注池：AI 楼实际打捞到的暗历条目（快照 pool 字段驱动；最新楼读活账，空则不出块）。
        const ledgerInner = _buildLedgerBlockHtml(snap ? (snap.pool || []) : null, readOnly, resolvedCalendar);

        // 日期上下文和各区内容共同决定折叠摘要与纯日期条。
        const hasDateData = hasDateContext(snap);
        if (!alm && !schInner && !linesInner && !ledgerInner && !hasDateData) return '';

        const collapseControl = label => `<button type="button" class="sp-inline-region-collapse" aria-label="收起${label}" title="收起${label}">${icon("chevron-up")}<span>收起</span></button>`;
        const region = (cls, seg, label, inner) => inner
            ? `<details class="${cls} sp-dash-region" data-seg="${seg}" open>${inner}${collapseControl(label)}</details>`
            : '';

        // 日期只留外层摘要，轴内每个事项按当前历法显示自己的日期范围。
        const top = alm ? region('sp-almanac-inline', 'almanac', '轴模块', `${alm.summary}${alm.itemsHtml}`) : '';
        const schRegion   = region('sp-schedule-inline', 'schedule', '点模块', schInner);
        const linesRegion = region('sp-lines-inline', 'lines', '线模块', linesInner);
        const ledgerRegion = region('sp-ledger-inline', 'ledger', '标注池模块', ledgerInner);

        // 段序：轴 → 标注池 → 点 → 线。标注池紧贴轴，点/线在其下。
        const body = `${top}${ledgerRegion}${schRegion}${linesRegion}`;
        // 没有可展开区域但有日期数据时显示纯日期条。
        if (!body) {
            const flatBar = dashSummaryHtml(snap, true, false, false, false, true, isLatest, floorClock, resolvedCalendar, localWeekdayRef);
            const cls = 'sp-inline-box sp-dash sp-dash-flat' + (readOnly ? ' sp-inline-box-ro' : '');
            return `<div class="${cls}">${flatBar}</div>`;
        }

        const summary = dashSummaryHtml(snap, hasDateData, !!alm, !!schInner, !!linesInner, false, isLatest, floorClock, resolvedCalendar, localWeekdayRef, !!ledgerInner);
        const cls = 'sp-inline-box sp-dash' + (readOnly ? ' sp-inline-box-ro' : '');
        // 面板默认折叠，摘要显示日期与当前存在的区域。
        return `<details class="${cls}">${summary}<div class="sp-dash-body">${body}</div></details>`;
    }

    // 用户楼「召回框」：外壳复用 .sp-inline-box/.sp-dash（与 AI 楼一摸一样形式），内含本回合召回注入回显（丰富版）。
    // snap：历史用户楼传快照（读 snap.recall [{id,事由,类型,起始锚,现状}]）；当前最后一楼若是用户楼则传 null → 读 injection controller echo。
    // 字段照召回闭环：类型胶囊(上色) + 事由 + 起始 + 推测应至状态(现状)。纯只读——召回是给用户核对「AI 这轮收到了啥」，无逐条操作。
    // 空召回 → 返回 ''（该用户楼不挂框；关注入/无召回的楼天然无此块）。
    // strip 委托（历/点的 per-day tap）共用：从被点元素回溯它所在的框，判断是否历史楼只读框，
    // 若是则取该楼快照，供 drawer 用快照数据渲染（历史楼 tap 展开看到的是那层楼当时的态，非活缓存）。
    // 返回 { readOnly, snap }：readOnly=false（当前最后一楼）时 snap=null，drawer 各 helper 退回读活缓存。
    function inlineTapContext(el) {
        const box = el.closest?.('.sp-inline-box-ro');
        if (!box) return { readOnly: false, snap: null, resolvedCalendar: loadCalDesc(), resolution: { resolved: true, source: 'live-current' } };
        const mesEl = el.closest('.mes');
        const mid = mesEl?.getAttribute('mesid');
        const snap = mid != null ? snapshot.readSnapshot(Number(mid)) : null;
        const fallback = readStore(keyDesc('caldesc-fallback', 'user', ''));
        const resolution = snapshot.resolveSnapshotCalendar(snap, { fallback, marker: !!fallback, current: loadCalDesc() });
        const localWeekdayRef = createWeekdayConsumerContext({ snapshotRef: snap?.weekdayRef, floor: mid == null ? null : Number(mid), resolveLocal: f => storyWeekdayRefPure(getContext(), resolution.calendar || loadCalDesc(), ALM_CHAT_SCAN_LIMIT, f) }).weekdayRef;
        return { readOnly: true, snap, resolvedCalendar: resolution.calendar, resolution, localWeekdayRef };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  楼内渲染窗口控制器（render_depth 深度窗 + IntersectionObserver 视口懒挂）
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // 当前窗口由深度与视口共同决定；超窗只留 message.extra 快照，不挂 DOM，滑回再重建。
    //
    // 插件设置为正数时使用它；否则取酒馆助手的正数深度；两者都无效时回退 6 层 AI 楼。
    // inlineRenderDepth>0 时优先使用插件设置，否则读取酒馆助手深度。
    // 视口：IntersectionObserver 观察每层 AI 楼，进视口才真正 build DOM、离开视口卸 DOM（省重排）。
    //   深度窗外的楼直接不观察、不挂（连快照都不建 DOM，只静静躺在 extra 里）。
    //
    // 深度按最近 N 个 AI 楼确定，但窗口覆盖其间用户楼；仅当前最后一个可见楼读活态出口，其余一律读各自快照。
    const renderedBoxes = new Map();
    let renderedChatId = Symbol('unbound-chat');

    const syncRenderedChat = () => {
        const chatId = getContext().chatId ?? null;
        if (chatId === renderedChatId) return;
        cancelExpandScroll();
        renderedBoxes.clear();
        renderedChatId = chatId;
    };
    const renderedBoxKey = el => `${el.getAttribute('is_user') === 'true' ? 'user' : 'assistant'}:${el.getAttribute('mesid') ?? ''}`;
    const syncRenderedOpen = rendered => {
        if (!rendered?.node) return;
        if (typeof rendered.node.open === 'boolean') rendered.open = rendered.node.open;
        rendered.regions = Object.fromEntries([...rendered.node.querySelectorAll(':scope > .sp-dash-body > details.sp-dash-region[data-seg]')]
            .map(region => [region.getAttribute('data-seg'), region.open === true]));
        rendered.items = Object.fromEntries([...rendered.node.querySelectorAll('details.sp-alm-event[data-alm-id]')]
            .filter(item => item.getAttribute('data-alm-id')).map(item => [item.getAttribute('data-alm-id'), item.open === true]));
    };
    const releaseRenderedBox = rendered => {
        if (!rendered) return;
        syncRenderedOpen(rendered);
        delete rendered.node;
        delete rendered.html;
        delete rendered.isLatest;
    };

    const clearTimer = key => { if (key) clearTimeout(key); };
    const clearLegacy = () => {
        doc?.querySelectorAll?.('#chat .sp-lines-inline, #chat .sp-dashed-inline, #chat .sp-almanac-inline, #chat .sp-schedule-inline')
            ?.forEach(el => el.remove());
        env.removeLegacy?.();
    };
    const clear = () => {
        cancelExpandScroll();
        syncRenderedChat();
        renderedBoxes.forEach(releaseRenderedBox);
        doc?.querySelectorAll?.('#chat ' + BOX_SELECTOR)?.forEach(el => el.remove());
        clearLegacy();
    };
    const computeRenderDepth = () => {
        const own = Number(getSettings().inlineRenderDepth);
        if (Number.isFinite(own) && own > 0) return Math.floor(own);
        let th = 0;
        try { th = Number(extensionSettings?.tavern_helper?.render?.depth) || 0; } catch {}
        return th > 0 ? Math.floor(th) : RENDER_DEPTH_FALLBACK;
    };
    const ignoreHidden = () => {
        try {
            const value = extensionSettings?.tavern_helper?.render?.depth_ignore_hidden;
            return value === undefined ? true : !!value;
        } catch { return true; }
    };
    const computeWindow = (messageFloors = null) => {
        const hidden = ignoreHidden();
        const chatFloors = messageFloors ? [...messageFloors] : [...(doc?.querySelectorAll?.('#chat .mes') || [])];
        const all = hidden ? chatFloors.filter(el => el.getAttribute('is_system') !== 'true') : chatFloors;
        const ai = all.filter(el => el.getAttribute('is_user') !== 'true');
        const users = all.filter(el => el.getAttribute('is_user') === 'true');
        const latestAiEl = ai.at(-1) || null;
        const latestUserEl = users.at(-1) || null;
        const currentEl = [...all].reverse().find(el => el.getAttribute('is_system') !== 'true') || null;
        const depth = computeRenderDepth();
        let floors = all;
        if (depth > 0 && ai.length > depth) {
            const start = all.indexOf(ai[ai.length - depth]);
            floors = start >= 0 ? all.slice(start) : all;
        }
        return { winSet: new Set(floors), latestAiEl, latestUserEl, currentEl, chatFloors, renderFloors: chatFloors.filter(el => el.getAttribute('is_system') !== 'true') };
    };
    const inViewport = el => {
        if (!el?.getBoundingClientRect) return true;
        const rect = el.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < (win?.innerHeight || doc?.documentElement?.clientHeight || 0);
    };
    const unmount = el => {
        if (pendingExpandScroll && el?.contains?.(pendingExpandScroll.summary)) cancelExpandScroll();
        syncRenderedChat();
        releaseRenderedBox(renderedBoxes.get(renderedBoxKey(el)));
        el?.querySelectorAll?.(BOX_SELECTOR)?.forEach(box => box.remove());
    };
    const directBoxes = msg => [...(msg?.querySelectorAll?.(':scope > ' + BOX_SELECTOR) || [])];
    const mount = (el, isLatest, { freezeSnapshots = true } = {}) => {
        if (!pluginEnabled() || !el) return;
        syncRenderedChat();
        const msg = el.querySelector?.('.mes_text');
        if (!msg) return;
        const isUser = el.getAttribute('is_user') === 'true';
        const mid = el.getAttribute('mesid');
        const renderKey = renderedBoxKey(el);
        let snap = null, coldItems = null;
        if (isLatest) {
            const frozen = freezeSnapshots ? env.freezeSnapshot?.(mid) : env.readSnapshot?.(Number(mid));
            if (!isUser && Array.isArray(frozen?.cold)) coldItems = frozen.cold;
        }
        else {
            snap = mid != null ? env.readSnapshot?.(Number(mid)) : null;
            if (!snap) { unmount(el); return; }
        }
        const floor = Number(mid);
        const recall = !isLatest && snap ? env.resolveSnapshotCalendar?.(snap) : null;
        const floorCalendar = recall?.resolved === false ? recall : recall?.calendar;
        const floorClock = !isLatest && !isUser ? env.parseStoryClock?.(env.chatMessage?.(floor) || '', floorCalendar) : null;
        const html = isUser
            ? (recall && !recall.calendar ? '<div class="sp-inline-box sp-dash sp-inline-box-ro"><div class="sp-dash-summary sp-dash-summary-flat">历法未知 / 日期未知</div></div>' : env.buildUserRecall?.(snap, isLatest, recall?.calendar))
            : composeInlineBox(snap, isLatest, floorClock, floor, coldItems);
        const boxes = directBoxes(msg);
        const rendered = renderedBoxes.get(renderKey);
        syncRenderedOpen(rendered);
        if (!html) { releaseRenderedBox(rendered); boxes.forEach(box => box.remove()); return; }
        // 宿主重绘可能留下多个同级框：统一收敛为一个。正文逐字相同才保留首个，保住展开态。
        const existing = boxes[0];
        if (rendered && rendered.node === existing && rendered.html === html && rendered.isLatest === isLatest) {
            boxes.slice(1).forEach(box => box.remove());
            return;
        }
        boxes.forEach(box => box.remove());
        const holder = doc.createElement('div');
        holder.innerHTML = html;
        const box = holder.firstElementChild;
        if (!box) return;
        if (typeof box.open === 'boolean') box.open = rendered?.open === true;
        box.querySelectorAll(':scope > .sp-dash-body > details.sp-dash-region[data-seg]').forEach(region => {
            const seg = region.getAttribute('data-seg');
            if (Object.hasOwn(rendered?.regions || {}, seg)) region.open = rendered.regions[seg] === true;
        });
        box.querySelectorAll('details.sp-alm-event[data-alm-id]').forEach(item => {
            const id = item.getAttribute('data-alm-id');
            if (id && Object.hasOwn(rendered?.items || {}, id)) item.open = rendered.items[id] === true;
        });
        const nextRendered = { node: box, html, isLatest, open: box.open === true, regions: rendered?.regions, items: rendered?.items };
        renderedBoxes.set(renderKey, nextRendered);
        box.addEventListener('toggle', () => {
            const current = renderedBoxes.get(renderKey);
            if (current?.node === box) current.open = box.open === true;
        });
        msg.appendChild(box);
        env.syncTheme?.(doc, box);
    };
    const ensureInlineObserver = () => {
        if (inlineObserver || typeof globalThis.IntersectionObserver !== 'function') return;
        inlineObserver = new globalThis.IntersectionObserver(entries => {
            const current = computeWindow();
            for (const entry of entries) {
                const el = entry.target;
                const latest = el === current.currentEl;
                if (entry.isIntersecting) mount(el, latest, { freezeSnapshots: false });
                else if (!latest) unmount(el);
            }
        }, { root: null, rootMargin: '200px 0px', threshold: 0 });
    };
    const recompute = (shared = null) => {
        if (!pluginEnabled() || getSettings().inlineRenderEnabled === false) { clear(); return; }
        ensureInlineObserver();
        const current = shared?.window || computeWindow(shared?.floors);
        const floors = current.renderFloors;
        for (const el of floors) {
            const latest = el === current.currentEl;
            if (current.winSet.has(el)) {
                inlineObserver?.observe(el);
                if (latest || inViewport(el)) mount(el, latest, { freezeSnapshots: shared?.freezeSnapshots !== false });
            } else {
                inlineObserver?.unobserve(el);
                unmount(el);
            }
        }
    };
    let refreshInput = null;
    const refresh = (immediate = false, shared = null) => {
        if (!pluginEnabled()) { clear(); return; }
        clearTimer(refreshTimer);
        refreshTimer = null;
        if (immediate) recompute(shared);
        else {
            refreshInput = shared;
            refreshTimer = setTimeout(() => { refreshTimer = null; const input = refreshInput; refreshInput = null; recompute(input); }, 120);
        }
    };
    const bindChatObserver = () => {
        const chat = doc?.querySelector?.('#chat');
        if (!chat) {
            clearTimer(chatRetryTimer);
            chatRetryTimer = setTimeout(() => { chatRetryTimer = null; bindChatObserver(); }, 600);
            return;
        }
        if (chatObserver) return;
        chatObserver = new globalThis.MutationObserver(() => {
            clearTimer(chatMutationTimer);
            chatMutationTimer = setTimeout(() => {
                chatMutationTimer = null;
                const floors = [...(doc?.querySelectorAll?.('#chat .mes') || [])];
                const context = env.getContext?.() || {};
                const window = computeWindow(floors);
                env.coordinateChanged?.({ floors, context });
                if (!env.isStreaming?.()) refresh(true, { floors, context, window, freezeSnapshots: false });
            }, 400);
        });
        chatObserver.observe(chat, { childList: true, subtree: true });
    };
    const init = () => {
        if (initialized) return;
        initialized = true;
        ensureInlineObserver();
        bindChatObserver();
        if (!delegated) {
            if ($) { initScheduleStripDelegation(); initRegionCollapseDelegation(); initExpandScrollDelegation(); }
            delegated = true;
        }
    };
    const destroy = () => {
        initialized = false;
        inlineObserver?.disconnect?.();
        chatObserver?.disconnect?.();
        inlineObserver = null;
        chatObserver = null;
        clearTimer(refreshTimer); clearTimer(chatMutationTimer); clearTimer(chatRetryTimer);
        refreshTimer = chatMutationTimer = chatRetryTimer = null;
        refreshInput = null;
        cancelExpandScroll();
        if ($) $(doc).off('.spschstrip').off('.spinlineregioncollapse').off('.spinlinescroll');
        delegated = false;
        clear();
        renderedBoxes.clear();
    };
    return { init, refresh, clear, destroy, computeWindow, mount, unmount, computeRenderDepth };
}
