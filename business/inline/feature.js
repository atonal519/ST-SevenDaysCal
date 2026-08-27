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
    const parseJudgedDate = env.parseJudgedDate;
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
    const buildUserRecall = env.buildUserRecall;

    // ─── 历·楼内七天条（只读，反映历+锚点，无生成）─────────────────────────────────
    // 与线块平行、共存于最新 AI 楼。外壳（标题条）仿线：一个 <details>，收起时是扁扁的
    // 「历 · N个日程」条，点整条即展开——配色/圆角/边框全走线的 .sp-inline-* 类。
    // 展开后的内容是历自己的「往后六天」条：6 格（周X + M/D，从明天起，今天已在大头日期块里、
    // 这里不重复），覆盖到历条目的日子高亮打点；窗口内有节日则每格可点、点下方就地展开当天安排（.sp-alm-sday）。
    // 纯读 loadAlmanac()+锚点，不请求 API、不受 linesEnabled 影响，只受 almanacInlineEnabled 开关控制。
    // itemsArg：null=读当前活历 loadAlmanac()（最新楼）；数组=快照里的历条目（历史楼）。
    // anchorArg：null=读当前锚点 almTodayAnchor()；{month,day}=快照锚点。历本就只读，无按钮需 gate。
    // 楼内轴渲染统一由 axisInlineRenderer 提供。

    // 历楼内只读渲染由 axis inline seam 持有；宿主仅提供实时数据与纯历法 helper。
    const _buildAlmanacBlockHtml = (...args) => axisInlineRenderer.buildAlmanacBlock(...args);
    const _almanacStripDayHtml = (...args) => axisInlineRenderer.buildAlmanacDay(...args);

    // 七天条 per-day tap：点某格 → 下方就地展开当天安排（再点同格收起、点别格切换）。委托到 document、
    // 只注册一次——块会被 #chat observer 反复重建，不能绑在块自身上；只对 .sp-alm-strip-live 可交互条生效。
    // 注：格子在 <details> 的 body 内，点它不触发 summary 的展开/收起，两套交互互不打架。
    function initAlmanacStripDelegation() {
        $(doc).on('click.spalmstrip', '.sp-dash .sp-alm-strip-live .sp-alm-scell', function (e) {
            e.preventDefault();
            e.stopPropagation();   // 别冒泡到 ST 的楼层点击（编辑等）
            const wrap = this.closest('.sp-alm-strip-live');
            if (!wrap) return;
            const sday = wrap.querySelector('.sp-alm-sday');
            if (!sday) return;
            if (this.classList.contains('sp-alm-scell-open')) {   // 点已展开的格 → 收起
                this.classList.remove('sp-alm-scell-open');
                sday.hidden = true;
                sday.innerHTML = '';
                return;
            }
            wrap.querySelectorAll('.sp-alm-scell-open').forEach(c => c.classList.remove('sp-alm-scell-open'));
            this.classList.add('sp-alm-scell-open');
            const { snap, resolvedCalendar, resolution, readOnly } = inlineTapContext(this);
            if (readOnly && !resolution?.resolved) { sday.innerHTML = '<div class="sp-alm-sday-empty">历法未知 / 日期未知</div>'; sday.hidden = false; return; }
            sday.innerHTML = _almanacStripDayHtml(Number(this.dataset.doy), snap ? (snap.almanac || []) : null, resolvedCalendar, inlineTapContext(this).localWeekdayRef);
            sday.hidden = false;
        });
    }

    // 清掉所有 AI 楼里的历七天条（维持「只挂最新楼」的单副本）。
    function _removeAllAlmanacBlocks() {
        doc.querySelectorAll('#chat .sp-almanac-inline').forEach(el => el.remove());
    }

    // 历改动 / 新楼 / swipe / 切聊天 都汇流到这。渲染改由 refresh() 统一负责（最新楼冻快照+重挂）。
    function syncLatestAlmanacBlock(expectedChatId = null) {
        if (expectedChatId != null && getContext().chatId !== expectedChatId) return;
        refresh(true);
    }

    // ─── 点·楼内日程条（只读，反映当前视角的点，无生成）──────────────────────────────
    // 与线块/历条平行、共存于最新 AI 楼。收起态是扁扁的「点 · N件待办」条，点整条展开是「日程条」：
    // 每个 Day 一格（周X + 日期 + 天气图标 + 待办数），Future 另起一格；点某格就地展开当天事件（标题+时间）。
    // 纯读楼内 canonical 点 raw（schedule-user），不请求 API、不受 linesEnabled 影响，只受 scheduleInlineEnabled 控制。
    // 外壳/标题条走线的 .sp-inline-* 类，与线块/历条一致；只有条内格子用独立的 .sp-sch-* 类。
    // rawArg：null=读 canonical user 活缓存（最新楼）；字符串=用快照里的点 raw（历史楼）。
    // readOnly：true=历史楼，drawer 去掉注入/删除/锁定按钮（在旧楼改点语义矛盾）。
    const _buildScheduleBlockHtml = (...args) => pointInlineRenderer.buildScheduleBlock(...args);

    // 日程条：某一天(dayKey='0'|'1'|…|'future') 的就地详情 HTML（点某格时填进 .sp-sch-sday）。
    // 每次都重读 raw（点 raw 会被重算/锁定改写），按天筛事件；空 → 「这天没有安排」。
    // dayKey='0'|'1'|…|'future'。rawArg=null 读 canonical user 活缓存（最新楼）；字符串=快照 raw（历史楼）。
    // readOnly=true 时 drawer 去掉注入/删除按钮（历史楼只读）。

    const _scheduleStripDayHtml = (...args) => pointInlineRenderer.buildScheduleDay(...args);

    // 日程条 per-day tap：点某格 → 下方就地展开当天事件（再点同格收起、点别格切换）。委托到 document、
    // 只注册一次——块会被 #chat observer 反复重建，不能绑在块自身上；只对 .sp-sch-strip-live 生效。
    function initScheduleStripDelegation() {
        pointInlineRenderer.bindScheduleStripDelegation({ $, inlineTapContext: inlineTapContext });
    }

    function _removeAllScheduleBlocks() {
        doc.querySelectorAll('#chat .sp-schedule-inline').forEach(el => el.remove());
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  楼内仪表盘（今头 + 历/点/线三区·融进一个面板·最新楼全功能 / 历史楼只读）
    // ═══════════════════════════════════════════════════════════════════════════
    //
    // 结构（对齐用户手绘图，不是三段并列）：以「今」为主心骨的一个面板。
    //   ┌─────────────────────────────────────────────┐
    //   │ ┌───────┐  历区（即将到来 ≡ + 未来七天格）     │  ← 顶行：今头 + 历
    //   │ │今 M/D │                                     │
    //   │ │周X ☀  │                                     │
    //   │ └───────┘                                     │
    //   │ 点区（今日待办）                               │
    //   │ 线区（活跃事件线）                             │
    //   └─────────────────────────────────────────────┘
    //
    // 铁律「模块可拆」：历/点/线各自独立开关（各 builder 自门控，关/空→返回 ''）。
    //   某区关 → 面板里根本没这区、其余区流式补位、不留空洞。
    //   今头的日期来源是历/点的锚点 → 历、点全无 → 今头连带收起，面板退成纯线区。
    //   三区全空 → 返回 ''（该楼不挂框）。
    //
    // snap=null → 最新楼：读活缓存、全功能（注入/删除/推进/锁定按钮都在）。
    // snap=对象 → 历史楼：读该楼快照、只读（各 builder 收到 readOnly=true，剥掉可变按钮）。

    // 今头/摘要共用的锚点解析：快照有合法锚点用快照，否则退活锚点。
    function dashAnchor(snap) {
        return (snap?.anchor && Number.isFinite(+snap.anchor.month) && Number.isFinite(+snap.anchor.day))
            ? { month: +snap.anchor.month, day: +snap.anchor.day }
            : almTodayAnchor();
    }

    // 「是否真有日期上下文」——与点/线/历三个显示开关无关，只看底层数据在不在：钉了锚点、
    // 或有历条目、或有点 raw。用来决定：三区全关（或都空）时，最扁的折叠条是否仍值得显「今 M/D 周X ☀」。
    // 全空（新聊天、没数据）→ false，别硬造个「今 1/1」噪声条。历史楼看快照自带的 almanac/point/anchor。
    function hasDateContext(snap) {
        if (snap) return !!((Array.isArray(snap.almanac) && snap.almanac.length) || snap.point || snap.anchor);
        let pinned = false;
        try { pinned = !!getDateAnchor(charStableKey(getContext())); } catch { pinned = false; }
        if (pinned) return true;
        try { if (loadAlmanac().length) return true; } catch { /* 忽略 */ }
        try { if (readCacheRaw(getCacheKey('user', ''))) return true; } catch { /* 忽略 */ }
        return false;
    }

    // 今头（masthead）：大日期块。月/日 + 周几为主体；天气取点当天格；纪年名(era)由日历描述符驱动，
    // 有则点亮、无则不撑（公历默认无 era）。anchor 缺则退活锚点。
    function dashMastheadHtml(snap, floorClock = null, calendarOverride = undefined, weekdayRefOverride = undefined) {
        let anchor = dashAnchor(snap);
        if (storyClockEnabled() && floorClock) {
            const floorDate = parseJudgedDate(floorClock.end) || parseJudgedDate(floorClock.start);
            if (floorDate) anchor = floorDate;
        }
        const cal = calendarOverride === undefined ? loadCalDesc() : calendarOverride;
        let wd = '星期未记录';
        try {
            const meta = floorClock?.endMeta?.valid ? floorClock.endMeta : (floorClock?.startMeta?.valid ? floorClock.startMeta : null);
            const localRef = weekdayRefOverride !== undefined ? weekdayRefOverride : (meta?.weekdayIndex == null ? (!snap ? almWeekdayRef(cal) : null) : { refDoy: almDayOfYear(meta.month, meta.day, cal), refWd: meta.weekdayIndex });
            const wdIndex = almWeekdayFor(anchor.month, anchor.day, localRef, cal);
            if (wdIndex != null) wd = ALM_WEEKDAYS[wdIndex] || '星期未记录';
        } catch { /* unknown */ }
        // 天气：从点当天格（days[0].weather）拿；拿不到留空。历史楼用快照点 raw。
        let wxHtml = '';
        try {
            const raw = snap ? (snap.point || '') : readCacheRaw(getCacheKey('user', ''));
            if (raw) {
                const wx = String(parseCalendar(raw, cal).days?.[0]?.weather || '').trim();
                if (wx) wxHtml = `<span class="sp-dash-today-wx">${weatherGlyph(wx)}</span>`;
            }
        } catch { /* 天气拿不到就不显 */ }
        // 纪年位：日历描述符带 era（纪年名）时点亮，无则不撑。
        const eraHtml = calHasEra(cal) ? `<span class="sp-dash-today-era">${escapeHtml(cal.era)}</span>` : '';
        return `<div class="sp-dash-today">
            <span class="sp-dash-today-md"><span class="sp-dash-today-month">${escapeHtml(calMonthName(cal, anchor.month))}</span><span class="sp-dash-today-day">${anchor.day}日</span></span>
            <span class="sp-dash-today-wd">${wd}</span>
            ${(wxHtml || eraHtml) ? `<span class="sp-dash-today-meta">${wxHtml}${eraHtml}</span>` : ''}
        </div>`;
    }

    // 折叠态（整框收成一小条）的摘要内层：今 M/D 周X ☀ + 计数 chips（历N 点N 线N）。
    // 「今 M/D 周X + 天气」是今天的身份标识，只要拿得到日期就恒显——不受点/线/历子开关影响
    // （子开关只管展开面板里那几个区显不显，日期/天气来自剧情锚点+点数据，与显示开关无关）。
    // chips 则跟着子开关走：只给「开着且有内容」的区计数（关掉的区不该在摘要里冒计数）。
    // flat=true：整框只剩这一条（点线历都关但有日期）→ 用 <div> 包、无折叠箭头、不可展开。
    // 时间戳·窄条抬戳：最新楼扫到戳时，戳「抬」成当天身份（end 优先）——
    //   数字戳（2024-10-08 15:10 / 10月8日 …）→ 解析成规整「年月日 周几」，把「时」挪到天气之后；
    //   古风/无法解析（谷雨亥时 / 霜月初三）→ 原样抬（无周几）；完全无戳/关/历史楼 → 锚点兜底日期。
    //   周几：有年且公历按真年算(JS Date)，否则用与锚点同源的年-free 周几（自定义历法也走这条）。
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
    // 组窄条「今 …」那截：{ todayHtml(含 .sp-dash-sum-today 壳), timeHtml(时刻尾巴，贴天气后) }。
    function clockHeadParts(isLatest, a, anchorWd, floorClock = null, calendarOverride = undefined) {
        const renderCalendar = calendarOverride === undefined ? loadCalDesc() : calendarOverride;
        const format = options => formatStoryClockHeadParts({ anchor: a, anchorWeekday: anchorWd, calendar: renderCalendar, monthName: calMonthName, escapeHtml, ...options });
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
        const p = stampDate(stamp);
        if (!p) return format({ rawStamp: stamp, tip });   // 古风/无法解析 → 原样抬
        return format({ stampDate: p, tip });
    }
    function dashSummaryHtml(snap, hasDate, almOn, schOn, linesOn, flat = false, isLatest = false, floorClock = null, calendarOverride = undefined, weekdayRefOverride = undefined) {
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
        const chipsHtml = chips.length ? `<span class="sp-dash-sum-chips">${chips.join('')}</span>` : '';
        // 时间戳已抬进 head 的「今 …」那截（见 clockHeadParts），此处不再单列一段。
        const inner = `${head}${chipsHtml}`;
        // 只有日期没有任何区 → 纯日期条：<div> 包、无箭头、不可折叠（点了也没东西展开）。
        if (flat) return `<div class="sp-dash-summary sp-dash-summary-flat">${inner}</div>`;
        return `<summary class="sp-dash-summary">${inner}<i class="fa-solid fa-chevron-down sp-dash-sum-caret"></i></summary>`;
    }

    // 组一个仪表盘的完整 HTML（含外壳）。三区全空且无日期 → 返回 ''（该楼不挂框）。
    // 外壳是 <details>：收起 = 一小条摘要（今 M/D 周X ☀ · 历N 点N 线N），展开 = 完整面板。
    // 面板内点/线各自是 <details> 可折叠；历区顶行（今头+即将到来）+ 满宽六格条构成一组。
    // 「今 M/D 周X ☀」在折叠条里恒显（只要有日期数据，与三个显示开关无关）；三区全关但有日期
    // → 退成纯日期扁条（不可展开）。isLatest=true：最新楼、全功能；false：历史楼、只读。
    function composeInlineBox(snap, isLatest, floorClock = null, floor = null) {
        const readOnly = !isLatest;
        const fallbackRecord = readStore(keyDesc('caldesc-fallback', 'user', ''));
        const resolvedResult = isLatest ? { resolved: true, calendar: loadCalDesc() } : snapshot.resolveSnapshotCalendar(snap, { fallback: fallbackRecord, marker: !!fallbackRecord, current: loadCalDesc() });
        const resolvedCalendar = resolvedResult.calendar;
        if (!resolvedCalendar) return '<div class="sp-inline-box sp-dash sp-inline-box-ro"><div class="sp-dash-summary sp-dash-summary-flat">历法未知 / 日期未知</div></div>';
        // 历区返回结构 {summary,upHtml,stripHtml}|null；点/线返回内层字符串或 ''。各自门控开关/空态。
        const localWeekdayRef = isLatest ? undefined : createWeekdayConsumerContext({ snapshotRef: snap?.weekdayRef, floor, resolveLocal: f => storyWeekdayRefPure(getContext(), resolvedCalendar, ALM_CHAT_SCAN_LIMIT, f) }).weekdayRef;
        const alm        = _buildAlmanacBlockHtml(snap ? (snap.almanac || []) : null, snap ? snap.anchor : null, resolvedCalendar, localWeekdayRef);
        const schInner   = _buildScheduleBlockHtml(snap ? (snap.point || '') : null, readOnly, resolvedCalendar, localWeekdayRef);
        const linesInner = linesFeature.inlineHtml(snap ? (snap.line || '') : null, readOnly);
        // 标注池：AI 楼实际打捞到的暗历条目（快照 pool 字段驱动；最新楼读活账，空则不出块）。
        const ledgerInner = _buildLedgerBlockHtml(snap ? (snap.pool || []) : null, readOnly, resolvedCalendar);

        // 日期是否真实存在（与显示开关无关）：决定折叠条头 + 纯日期扁条兜底。
        const hasDateData = hasDateContext(snap);
        if (!alm && !schInner && !linesInner && !ledgerInner && !hasDateData) return '';   // 啥也没有 → 不挂框

        // 展开面板里的大头 masthead：仅当有「历/点」区在场时出现（线独存时不显大头——edge case A）。
        const hasDateRegion = !!alm || !!schInner;

        const region = (cls, seg, inner) => inner
            ? `<details class="${cls} sp-dash-region" data-seg="${seg}" open>${inner}</details>`
            : '';

        // 顶行 + 历满宽条：历在场 → 顶行 [方形今头 + 历(summary+即将到来清单)]，六格条满宽落在顶行下方。
        // 无历但有点 → 顶行只放今头（点提供日期）。历/点全无 → 无顶行（面板从点/线区起）。
        let top = '', almStripRow = '';
        if (alm) {
            // 历整块：满宽 summary 头（点它折叠整个历单元）+ [方形今头 + 即将到来清单] 行 + 满宽六格条。
            // summary 提到顶行上方通栏铺满（原来缩在右列、今头上方左侧留空白）；今头与清单/六格条一起
            // 挂在 details 内，随历折叠一并收起——原生 <details> 折叠即隐藏，不再需要 :has() 联动隐藏六格条。
            const dashTop  = `<div class="sp-dash-top">${dashMastheadHtml(snap, floorClock, resolvedCalendar, localWeekdayRef)}<div class="sp-inline-body sp-alm-inline-body">${alm.upHtml}</div></div>`;
            const stripRow = alm.stripHtml ? `<div class="sp-alm-strip-region">${alm.stripHtml}</div>` : '';
            top = `<details class="sp-almanac-inline sp-dash-region" data-seg="almanac" open>${alm.summary}${dashTop}${stripRow}</details>`;
        } else if (hasDateRegion) {
            top = `<div class="sp-dash-top sp-dash-top-noalm">${dashMastheadHtml(snap, floorClock, resolvedCalendar, localWeekdayRef)}</div>`;
        }
        const schRegion   = region('sp-schedule-inline', 'schedule', schInner);
        const linesRegion = region('sp-lines-inline', 'lines', linesInner);
        const ledgerRegion = region('sp-ledger-inline', 'ledger', ledgerInner);

        // 段序：轴(top) → 标注池 → 点 → 线。标注池与日历同属「轴」范畴，紧贴轴放；点/线在其下。
        const body = `${top}${almStripRow}${ledgerRegion}${schRegion}${linesRegion}`;
        // 面板体为空但有日期数据（三区都关，只剩日期）→ 纯日期扁条：不可折叠，只显今头缩写。
        if (!body) {
            const flatBar = dashSummaryHtml(snap, true, false, false, false, true, isLatest, floorClock, resolvedCalendar, localWeekdayRef);
            const cls = 'sp-inline-box sp-dash sp-dash-flat' + (readOnly ? ' sp-inline-box-ro' : '');
            return `<div class="${cls}">${flatBar}</div>`;
        }

        const summary = dashSummaryHtml(snap, hasDateData, !!alm, !!schInner, !!linesInner, false, isLatest, floorClock, resolvedCalendar, localWeekdayRef);
        const cls = 'sp-inline-box sp-dash' + (readOnly ? ' sp-inline-box-ro' : '');
        // 默认折叠成一小条（不带 open）：只显摘要「今 M/D 周X ☀ · 历N 点N 线N」，点开才展开完整面板。
        return `<details class="${cls}">${summary}<div class="sp-dash-body">${body}</div></details>`;
    }

    // 用户楼「召回框」：外壳复用 .sp-inline-box/.sp-dash（与 AI 楼一摸一样形式），内含本回合召回注入回显（丰富版）。
    // snap：历史用户楼传快照（读 snap.recall [{id,事由,类型,起始锚,现状}]）；最新用户楼传 null → 读 injection controller echo。
    // 字段照召回闭环：类型胶囊(上色) + 事由 + 起始 + 推测应至状态(现状)。纯只读——召回是给用户核对「AI 这轮收到了啥」，无逐条操作。
    // 空召回 → 返回 ''（该用户楼不挂框；关注入/无召回的楼天然无此块）。
    // strip 委托（历/点的 per-day tap）共用：从被点元素回溯它所在的框，判断是否历史楼只读框，
    // 若是则取该楼快照，供 drawer 用快照数据渲染（历史楼 tap 展开看到的是那层楼当时的态，非活缓存）。
    // 返回 { readOnly, snap }：readOnly=false（最新楼）时 snap=null，drawer 各 helper 退回读活缓存。
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
    // 取代旧的「三套 syncLatest*/ensureLatest*/backfill* + anchor #chat MutationObserver 打地鼠」：
    // 只在「深度窗口 ∩ 视口」内的 AI 楼挂统一框，超窗只留 message.extra 快照、不挂 DOM，滑回秒重建。
    //
    // 深度窗口：最新 N 层 AI 楼（N=有效 render_depth）。N=0（跟随酒馆助手且它设 0=全渲）→ 不设上限、全挂。
    //   inlineRenderDepth>0 → 用它；=0 → 跟随酒馆助手 render.depth；读不到/为 0 → 用兜底常量。
    // 视口：IntersectionObserver 观察每层 AI 楼，进视口才真正 build DOM、离开视口卸 DOM（省重排）。
    //   深度窗外的楼直接不观察、不挂（连快照都不建 DOM，只静静躺在 extra 里）。
    //
    // 最新楼（chat 里最后一条 AI 楼）= 全功能、读活缓存；其余窗内楼 = 只读、读各自快照。




    const clearTimer = key => { if (key) clearTimeout(key); };
    const clearLegacy = () => {
        doc?.querySelectorAll?.('#chat .sp-lines-inline, #chat .sp-dashed-inline, #chat .sp-almanac-inline, #chat .sp-schedule-inline')
            ?.forEach(el => el.remove());
        env.removeLegacy?.();
    };
    const clear = () => {
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
    const computeWindow = () => {
        const hidden = ignoreHidden();
        const allSelector = hidden ? '#chat .mes:not([is_system="true"])' : '#chat .mes';
        const aiSelector = hidden ? '#chat .mes:not([is_user="true"]):not([is_system="true"])' : '#chat .mes:not([is_user="true"])';
        const all = [...(doc?.querySelectorAll?.(allSelector) || [])];
        const ai = [...(doc?.querySelectorAll?.(aiSelector) || [])];
        const users = all.filter(el => el.getAttribute('is_user') === 'true');
        const latestAiEl = ai.at(-1) || null;
        const latestUserEl = users.at(-1) || null;
        const depth = computeRenderDepth();
        let floors = all;
        if (depth > 0 && ai.length > depth) {
            const start = all.indexOf(ai[ai.length - depth]);
            floors = start >= 0 ? all.slice(start) : all;
        }
        return { winSet: new Set(floors), latestAiEl, latestUserEl };
    };
    const inViewport = el => {
        if (!el?.getBoundingClientRect) return true;
        const rect = el.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < (win?.innerHeight || doc?.documentElement?.clientHeight || 0);
    };
    const boxSignature = (html, isLatest) => `${isLatest ? 'L' : 'H'}:${html.length}:${html.slice(0, 24)}:${html.slice(-24)}`;
    const unmount = el => el?.querySelectorAll?.(BOX_SELECTOR)?.forEach(box => box.remove());
    const directBoxes = msg => [...(msg?.querySelectorAll?.(':scope > ' + BOX_SELECTOR) || [])];
    const mount = (el, isLatest) => {
        if (!pluginEnabled() || !el) return;
        const msg = el.querySelector?.('.mes_text');
        if (!msg) return;
        const isUser = el.getAttribute('is_user') === 'true';
        const mid = el.getAttribute('mesid');
        let snap = null;
        if (isLatest) env.freezeSnapshot?.(mid);
        else {
            snap = mid != null ? env.readSnapshot?.(Number(mid)) : null;
            if (!snap) { unmount(el); return; }
        }
        const floor = Number(mid);
        const floorClock = !isLatest && !isUser ? env.parseStoryClock?.(env.chatMessage?.(floor) || '') : null;
        const recall = !isLatest && snap ? env.resolveSnapshotCalendar?.(snap) : null;
        const html = isUser
            ? (recall && !recall.calendar ? '<div class="sp-inline-box sp-dash sp-inline-box-ro"><div class="sp-dash-summary sp-dash-summary-flat">历法未知 / 日期未知</div></div>' : env.buildUserRecall?.(snap, isLatest, recall?.calendar))
            : composeInlineBox(snap, isLatest, floorClock, floor);
        const boxes = directBoxes(msg);
        if (!html) { boxes.forEach(box => box.remove()); return; }
        const sig = boxSignature(html, isLatest);
        // 宿主重绘可能留下多个同级框：统一收敛为一个。相同签名保留首个，保住展开态。
        const existing = boxes[0];
        if (existing?.dataset?.sig === sig) {
            boxes.slice(1).forEach(box => box.remove());
            return;
        }
        boxes.forEach(box => box.remove());
        const holder = doc.createElement('div');
        holder.innerHTML = html;
        const box = holder.firstElementChild;
        if (!box) return;
        box.dataset.sig = sig;
        msg.appendChild(box);
        env.syncTheme?.(doc, box);
    };
    const ensureInlineObserver = () => {
        if (inlineObserver || typeof globalThis.IntersectionObserver !== 'function') return;
        inlineObserver = new globalThis.IntersectionObserver(entries => {
            const current = computeWindow();
            for (const entry of entries) {
                const el = entry.target;
                const latest = el === current.latestAiEl || el === current.latestUserEl;
                if (entry.isIntersecting) mount(el, latest);
                else if (!latest) unmount(el);
            }
        }, { root: null, rootMargin: '200px 0px', threshold: 0 });
    };
    const recompute = () => {
        if (!pluginEnabled() || getSettings().inlineRenderEnabled === false) { clear(); return; }
        ensureInlineObserver();
        const current = computeWindow();
        const floors = doc?.querySelectorAll?.('#chat .mes:not([is_system="true"])') || [];
        for (const el of floors) {
            const latest = el === current.latestAiEl || el === current.latestUserEl;
            if (current.winSet.has(el)) {
                inlineObserver?.observe(el);
                if (latest || inViewport(el)) mount(el, latest);
            } else {
                inlineObserver?.unobserve(el);
                unmount(el);
            }
        }
    };
    const refresh = (immediate = false) => {
        if (!pluginEnabled()) { clear(); return; }
        clearTimer(refreshTimer);
        refreshTimer = null;
        if (immediate) recompute();
        else refreshTimer = setTimeout(() => { refreshTimer = null; recompute(); }, 120);
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
                env.coordinateChanged?.();
                if (!env.isStreaming?.()) refresh(false);
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
            if ($) { initAlmanacStripDelegation(); initScheduleStripDelegation(); }
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
        if ($) $(doc).off('.spalmstrip').off('.spschstrip');
        delegated = false;
        clear();
    };
    return { init, refresh, clear, destroy, computeWindow, mount, unmount, computeRenderDepth };
}
