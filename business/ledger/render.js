// ─── 刻度（ledger）域 · 渲染 / 编辑 / 批量交互 ────────────────────────────────
// 从 index.js 迁入「暗账页」（历面板第三 sheet）整套：条目行/内联编辑窗/批量条/暗账列表。
// 按 Lead 裁定 Option B 独立成 ledger 渲染子模块；ledger 数据层仍在 ../../ledger.js（不混入 axis）。
// axis 编排器（axis/panel 的 renderAlmanacPanel）经本模块导出的 renderLedgerSheet/renderLedgerEditor 调用；
// 本模块反向经 env 调 renderAlmanacPanel（避免与 axis/panel 形成 ESM 循环 import）。
//
// 依赖：
//  · 直接 import（叶子/姊妹纯模块，无循环）：utils/dom(转义)、runtime/settings(getSettings)、
//    axis/state(axisState)、axis/data(历法/日历/almanac 读写)、ledger.js(数据 CRUD)。
//  · env 注入（index.js 宿主：shadow 查询/toast/确认框/中文列表切分/主楼同步/面板重绘/间隔与忙碌态）：
//    $in, showToast, splitCnList, spConfirm, syncLatestAlmanacBlock, renderAlmanacPanel,
//    getLedgerCaptureInterval, isCapturingLedger(), isJudgingLedger()
//
// 【bug 修复·迁移完整性】原 renderLedgerSheet 内 `${on ? ...}` 的 `on` 为未定义标识符
//  （渲染刻度页即抛 ReferenceError，属所迁移 runtime 链路的现有阻断 bug）。按 sp-ledger-auto-toggle
//  的 change 处理器（写 getSettings().ledgerCaptureEnabled）判定，正确来源为 s.ledgerCaptureEnabled，
//  已在迁移时修正。除此之外行为逐字节保持不变。

import { escapeHtml, escapeAttr } from '../../utils/dom.js';
import { getSettings } from '../../runtime/settings.js';
import { axisState } from '../axis/state.js';
import { calMonthName, calMonthCount, calMonthDays, loadCalDesc, loadAlmanac, saveAlmanacItems } from '../axis/data.js';
import * as ledger from '../../ledger.js';

let env = null;
export function bindLedgerRender(e) { env = e; }

// ── 本模块自持的刻度渲染态（原 index.js 模块级变量，随渲染层一并迁入）──
let _ledgerEditor = null;       // { id, advanced } 内联编辑窗，null=未开
let _ledgerArchiveOpen = false; // 归档折叠区展开态
let _batchScope = null;         // 当前批量 scope（null=未进入批量）
let _batchSelected = new Set(); // 批量选中 id 集
// 退出批量并清空选择（供 execBatch 收尾、以及外部 CHAT_CHANGED 复位调用）。
export function batchReset() { _batchScope = null; _batchSelected = new Set(); }
// 整体复位刻度渲染态（供 index.js 的 CHAT_CHANGED / 切档 / 退面板复位调用，等价原 index.js
// `_ledgerEditor=null; _ledgerArchiveOpen=false; batchReset();` 三连）。
export function resetLedgerRenderState() { _ledgerEditor = null; _ledgerArchiveOpen = false; batchReset(); }
// 批量态访问器（供 axis/panel 的事件层读写：进入/退出/勾选/全选）。
export function getBatchScope() { return _batchScope; }
export function setBatchScope(s) { _batchScope = s; }
export function getBatchSelected() { return _batchSelected; }
export function isLedgerArchiveOpen() { return _ledgerArchiveOpen; }
export function toggleLedgerArchiveOpen() { _ledgerArchiveOpen = !_ledgerArchiveOpen; }
export function getLedgerEditor() { return _ledgerEditor; }

const LEDGER_TYPE_CLASS = { '持续状态': 'state', '约定待办': 'todo', '周期': 'cycle' };
export function ledgerTypeClass(t) { return LEDGER_TYPE_CLASS[t] || 'state'; }
// 锚里的历日期 {month,day} → 「霜月8日」。缺/坏 → 空串。
export function fmtLedgerAnchorDate(md, cal) {
    if (!md || typeof md !== 'object' || !Number.isFinite(+md.month) || !Number.isFinite(+md.day)) return '';
    return `${calMonthName(cal, +md.month)}${+md.day}日`;
}
export function ledgerRowHtml(e, cal, archived = false) {
    const badge = `<span class="sp-ledger-type">${escapeHtml(e.类型)}</span>`;
    const start = fmtLedgerAnchorDate(e.起始锚?.历日期, cal);
    const startTag = start ? `<span class="sp-ledger-meta">起 ${escapeHtml(start)}</span>` : '';
    const cyc = e.周期长度 ? `<span class="sp-ledger-meta">周期${e.周期长度}天</span>` : '';
    const due = e.到期锚?.历日期 ? `<span class="sp-ledger-meta">终 ${escapeHtml(fmtLedgerAnchorDate(e.到期锚.历日期, cal))}</span>` : '';
    const locked = e.锁 === '用户锁';
    const paused = e.静音 === true;   // 暂停埋入
    // 牵扯人物上提到第一行（跟类型徽章同排、填首行空档）；标签仍留末行。
    const who = (e.牵扯 || []).length ? `<span class="sp-ledger-who">${escapeHtml(e.牵扯.join('、'))}</span>` : '';
    const tags = (e.标签 || []).map(t => `<span class="sp-ledger-tag">${escapeHtml(t)}</span>`).join('');
    const r3 = tags ? `<div class="sp-ledger-r3">${tags}</div>` : '';
    // 行操作钮组（照点/面紧凑范式，靠右）。归档条走「捞回 / 彻底删」；活跃条走「编辑 / 锁解锁 / 暂停埋入 / 了结」。
    const acts = archived
        ? `<span class="sp-ledger-actions">`
            + `<button class="sp-ledger-reopen" title="捞回 · 回到活跃、判定车重新跟进"><i class="fa-solid fa-rotate-left"></i></button>`
            + `<button class="sp-ledger-remove" title="彻底删除 · 不可恢复"><i class="fa-solid fa-trash"></i></button>`
            + `</span>`
        : `<span class="sp-ledger-actions">`
            + `<button class="sp-ledger-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>`
            + `<button class="sp-ledger-lock-toggle" title="${locked ? '已锁定 · AI 判定不动（点击解锁）' : '锁定 · 锁后 AI 判定不动'}"><i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>`
            + `<button class="sp-ledger-mute-toggle" title="${paused ? '已暂停埋入 · 不再注入主楼（点击恢复）' : '暂停埋入 · 暂不注入主楼、但仍保留跟进'}"><i class="fa-solid ${paused ? 'fa-bell-slash' : 'fa-bell'}"></i></button>`
            + `<button class="sp-ledger-close" title="了结 · 从活跃移除（可在归档捞回）"><i class="fa-solid fa-check"></i></button>`
            + `</span>`;
    // 起/周期/终固定独占一行：这仨凑一起（尤其古风长日期「大梁二十九年十一月廿六未时」）放进事由那行会挤爆，
    // 无条件挪到第二行、换行标准统一（不再靠 flex-wrap 超出才折）。三者全空则整行不渲染。
    const dates = `${startTag}${cyc}${due}`;
    const r15 = dates ? `<div class="sp-ledger-dates">${dates}</div>` : '';
    // 批量模式：归档条对应 'ledger-archive'、活跃条对应 'ledger-active'。命中当前 scope 才出勾选框、隐藏行操作钮。
    const batchScope = archived ? 'ledger-archive' : 'ledger-active';
    const batchOn = _batchScope === batchScope;
    const checked = batchOn && _batchSelected.has(e.id);
    const checkbox = batchOn
        ? `<input type="checkbox" class="sp-batch-check" ${checked ? 'checked' : ''} aria-label="选择此条">`
        : '';
    // 第一行＝元信息头（类型 + 人物 + 操作钮）；事由独占整行放在头下方，长了就自己逐行换、不再挤钮组。
    const cls = `sp-ledger-row sp-ledger-${ledgerTypeClass(e.类型)}${locked ? ' sp-ledger-locked' : ''}${paused ? ' sp-ledger-paused' : ''}${archived ? ' sp-ledger-archived' : ''}${batchOn ? ' sp-batch-row' : ''}${checked ? ' sp-batch-checked' : ''}`;
    return `<div class="${cls}" data-id="${escapeAttr(e.id)}">
        <div class="sp-ledger-r1">${checkbox}${badge}${who}${batchOn ? '' : acts}</div>
        <div class="sp-ledger-gist-row"><span class="sp-ledger-gist">${escapeHtml(e.事由)}</span></div>
        ${r15}
        <div class="sp-ledger-r2">${escapeHtml(e.现状 || '（无现状）')}</div>
        ${r3}
    </div>`;
}
// ── 暗历·内联编辑窗（照 _almanacEditor 同款：渲进 #sp-almanac-wrap，不用弹窗，跟 CHAT_CHANGED 一起清）──
// 只改现有条目（新增走 AI 标注，不在此手加）。保存即上「用户锁」——判定车 gate 掉锁条、不再动你手改的。
// 起始锚是底账·判定车算「距今几天」的基准，默认折叠只读、advanced 才可改，防手滑改崩时间基线。
export function openLedgerEditor(id) {
    if (!ledger.getEntry(id)) { env.showToast('条目已不存在', null, true); return; }
    _ledgerEditor = { id, advanced: false };
    if (axisState.almanacMode) env.renderAlmanacPanel();
}
export function closeLedgerEditor() {
    _ledgerEditor = null;
    if (axisState.almanacMode) env.renderAlmanacPanel();
}
// {month,day} → "3/15" 紧凑输入回填用；缺/坏 → 空串。
export function ledgerMdToInput(md) {
    if (!md || typeof md !== 'object' || !Number.isFinite(+md.month) || !Number.isFinite(+md.day)) return { m: '', d: '' };
    return { m: String(+md.month), d: String(+md.day) };
}
export function renderLedgerEditor() {
    const e = ledger.getEntry(_ledgerEditor.id);
    if (!e) { closeLedgerEditor(); return ''; }
    const adv = !!_ledgerEditor.advanced;
    const cal = loadCalDesc();
    const mc = calMonthCount(cal);
    const typeOpts = ledger.TYPES.map(t => `<option value="${t}"${e.类型 === t ? ' selected' : ''}>${t}</option>`).join('');
    const start = ledgerMdToInput(e.起始锚?.历日期);
    const due = ledgerMdToInput(e.到期锚?.历日期);
    // 起始锚：默认只读展示 + 「改起始锚」链接展开；advanced 时给月/日输入。
    const startBlock = adv
        ? `<div class="sp-led-field-row">
                <label class="sp-led-field sp-led-field-sm"><span>起始·月</span><input type="number" id="sp-led-f-start-m" min="1" max="${mc}" value="${escapeAttr(start.m)}"></label>
                <label class="sp-led-field sp-led-field-sm"><span>日</span><input type="number" id="sp-led-f-start-d" min="1" max="31" value="${escapeAttr(start.d)}"></label>
                <span class="sp-led-adv-warn">改起始锚＝改「距今几天」基准，慎改</span>
           </div>`
        : `<div class="sp-led-adv-row"><span class="sp-led-adv-label">起始：${escapeHtml(fmtLedgerAnchorDate(e.起始锚?.历日期, cal) || '未记')}</span><button class="sp-led-adv-open" type="button">改起始锚</button></div>`;
    return `<div class="sp-alm-editor-head">
        <button class="sp-icon-btn sp-led-editor-back" title="返回"><i class="fa-solid fa-arrow-left"></i></button>
        <span class="sp-alm-editor-title">编辑刻度条目</span>
    </div>
    <div class="sp-alm-body">
        <div class="sp-alm-editor-body">
            <label class="sp-led-field"><span>事由</span><input type="text" id="sp-led-f-gist" maxlength="60" placeholder="一句话说清是什么事" value="${escapeAttr(e.事由)}"></label>
            <label class="sp-led-field"><span>类型</span><select id="sp-led-f-type">${typeOpts}</select></label>
            <label class="sp-led-field"><span>现状 <small>此刻状态一句话</small></span><textarea id="sp-led-f-now" rows="2" maxlength="200" placeholder="如「伤口已结痂，隐隐作痒」">${escapeHtml(e.现状 || '')}</textarea></label>
            <label class="sp-led-field"><span>牵扯 <small>涉及的人，顿号分隔</small></span><input type="text" id="sp-led-f-who" maxlength="80" placeholder="如 阿露、店主" value="${escapeAttr((e.牵扯 || []).join('、'))}"></label>
            <label class="sp-led-field"><span>标签 <small>检索关键词，顿号分隔</small></span><input type="text" id="sp-led-f-tags" maxlength="80" placeholder="如 伤、左手、身体" value="${escapeAttr((e.标签 || []).join('、'))}"></label>
            <div class="sp-led-field-row">
                <label class="sp-led-field sp-led-field-sm"><span>到期·月 <small>选填</small></span><input type="number" id="sp-led-f-due-m" min="1" max="${mc}" value="${escapeAttr(due.m)}"></label>
                <label class="sp-led-field sp-led-field-sm"><span>日</span><input type="number" id="sp-led-f-due-d" min="1" max="31" value="${escapeAttr(due.d)}"></label>
                <label class="sp-led-field sp-led-field-sm"><span>周期天数 <small>仅周期</small></span><input type="number" id="sp-led-f-cyc" min="1" max="366" value="${e.周期长度 || ''}"></label>
            </div>
            ${startBlock}
            <p class="sp-cfg-hint" style="opacity:.7">保存后此条会<b>上锁</b>，AI 判定车不再自动改动它（可在行上点锁图标解锁）。</p>
        </div>
        <div class="sp-alm-editor-actions">
            <button class="sp-mini-btn sp-led-editor-cancel">取消</button>
            <button class="sp-gen-btn sp-led-editor-save">保存</button>
        </div>
    </div>`;
}
// 读窗内月/日两框 → {month,day} 或 null（两者都要有效才成锚；越界按历法夹取）。
export function ledgerReadMd(mSel, dSel, cal) {
    // 调用方传的是 #sp-led-* 选择器串（刻度编辑器输入框在 shadow 内）→ 必须 $in 查 shadowRoot
    const m = parseInt(env.$in(mSel).val(), 10);
    const d = parseInt(env.$in(dSel).val(), 10);
    if (!Number.isFinite(m) || !Number.isFinite(d) || m < 1 || d < 1) return null;
    const mm = Math.min(Math.max(1, m), calMonthCount(cal));
    const dd = Math.min(Math.max(1, d), calMonthDays(cal, mm));
    return { month: mm, day: dd };
}
export function saveLedgerEditor() {
    if (!_ledgerEditor) return;
    const e = ledger.getEntry(_ledgerEditor.id);
    if (!e) { closeLedgerEditor(); return; }
    const gist = String(env.$in('#sp-led-f-gist').val() || '').trim();
    if (!gist) { env.showToast('请填写事由', null, true); env.$in('#sp-led-f-gist').trigger('focus'); return; }
    const cal = loadCalDesc();
    const type = ledger.TYPES.includes(env.$in('#sp-led-f-type').val()) ? env.$in('#sp-led-f-type').val() : e.类型;
    const patch = {
        事由: gist,
        类型: type,
        现状: String(env.$in('#sp-led-f-now').val() || '').trim(),
        牵扯: env.splitCnList(env.$in('#sp-led-f-who').val()),
        标签: env.splitCnList(env.$in('#sp-led-f-tags').val()),
        锁: '用户锁',   // 手改即锁，判定车不再动
    };
    // 周期天数：仅周期类有意义；填了就写，清空则置 null。
    const cyc = parseInt(env.$in('#sp-led-f-cyc').val(), 10);
    patch.周期长度 = (Number.isFinite(cyc) && cyc > 0) ? cyc : null;
    // 到期锚：两框都有效则成锚，否则清空（约定/周期可留空＝未定档）。
    const dueMd = ledgerReadMd('#sp-led-f-due-m', '#sp-led-f-due-d', cal);
    patch.到期锚 = dueMd ? { 历日期: dueMd } : null;
    // 起始锚：仅 advanced 展开时才读、才改；未展开保持原值不动（防手滑改基准）。
    if (_ledgerEditor.advanced) {
        const startMd = ledgerReadMd('#sp-led-f-start-m', '#sp-led-f-start-d', cal);
        if (startMd) patch.起始锚 = { 楼层: e.起始锚?.楼层 ?? null, 历日期: startMd };
    }
    ledger.updateEntry(e.id, patch);
    closeLedgerEditor();
}

// 批量操作条（可复用框架）：进入某 scope 后渲在列表顶部。执行动作文案/危险度由调用方按 scope 传入。
//   scope: 当前列表 scope 串；total: 该列表条目数；actionLabel: 执行钮文案（如「批量归档」「批量删除」）；danger: 执行钮是否红。
// 未进入该 scope 时返回「进入批量」入口钮；进入后返回「全选 + 计数 + 执行 + 退出」条。
export function batchBarHtml(scope, total, actionLabel, danger) {
    if (total <= 0) return '';
    if (_batchScope !== scope) {
        return `<div class="sp-batch-bar"><button class="sp-mini-btn sp-batch-enter" data-scope="${escapeAttr(scope)}"><i class="fa-solid fa-list-check"></i> 批量</button></div>`;
    }
    const n = _batchSelected.size;
    const allChecked = n > 0 && n >= total;
    return `<div class="sp-batch-bar sp-batch-active">
        <label class="sp-batch-all"><input type="checkbox" class="sp-batch-selall" ${allChecked ? 'checked' : ''}><span>全选</span></label>
        <span class="sp-batch-count">已选 ${n} / ${total}</span>
        <span class="sp-batch-bar-actions">
            <button class="sp-mini-btn sp-batch-exit">退出</button>
            <button class="sp-mini-btn ${danger ? 'sp-mini-btn-danger' : ''} sp-batch-exec" data-scope="${escapeAttr(scope)}" ${n ? '' : 'disabled'}>${escapeHtml(actionLabel)}</button>
        </span>
    </div>`;
}

// 批量模式允许的三个 scope（严格限定入口：不接 'calendar' 模板批量删除）。
export const BATCH_SCOPES = ['almanac', 'ledger-active', 'ledger-archive'];

// 当前 scope 内的全部条目 id（供「全选」与执行过滤）。
export function batchScopeIds(scope) {
    if (scope === 'almanac') return loadAlmanac().map(it => it.id);
    if (scope === 'ledger-active') return ledger.listEntries().map(e => e.id);
    if (scope === 'ledger-archive') return ledger.listEntries({ includeClosed: true }).filter(e => e.状态 === '已了结').map(e => e.id);
    return [];
}

// 按 scope 执行批量动作。动作彼此独立、确认后机械写回，随后退批并刷新面板。
export async function execBatch(scope, ids) {
    if (!ids.length) return;
    if (scope === 'almanac') {
        const list = loadAlmanac();
        const ok = await env.spConfirm({ title: '批量删除日期', body: `确定删除选中的 ${ids.length} 个日期条目？不可恢复。`, confirmText: '删除', cancelText: '取消' });
        if (!ok) return;
        saveAlmanacItems(list.filter(x => !ids.includes(x.id)));
        batchReset();
        if (axisState.almanacMode) env.renderAlmanacPanel();
        env.syncLatestAlmanacBlock();
        env.showToast(`已删除 ${ids.length} 个日期条目`);
    } else if (scope === 'ledger-active') {
        const ok = await env.spConfirm({ title: '批量归档', body: `把选中的 ${ids.length} 个活跃刻度移入归档？可在归档里捞回。`, confirmText: '归档', cancelText: '取消' });
        if (!ok) return;
        ids.forEach(id => ledger.closeEntry(id));
        batchReset();
        if (axisState.almanacMode) env.renderAlmanacPanel();
        env.showToast(`已归档 ${ids.length} 个刻度条目`);
    } else if (scope === 'ledger-archive') {
        const ok = await env.spConfirm({ title: '批量删除', body: `选中的 ${ids.length} 个已归档刻度将被永久删除，无法恢复。确定？`, confirmText: '删除', cancelText: '取消' });
        if (!ok) return;
        ids.forEach(id => ledger.removeEntry(id));
        batchReset();
        if (axisState.almanacMode) env.renderAlmanacPanel();
        env.showToast(`已删除 ${ids.length} 个刻度条目`);
    }
}

export function renderLedgerSheet() {
    const s = getSettings();
    const iv = env.getLedgerCaptureInterval();
    const busy = env.isCapturingLedger();
    const judging = env.isJudgingLedger();
    const on = s.ledgerCaptureEnabled;   // 【bug 修复】原为裸未定义 `on`；正源＝自动标注开关设置
    const ctrl = `<div class="sp-ledger-ctrl">
        <label class="sp-ledger-auto">
            <input type="checkbox" class="sp-ledger-auto-toggle" ${on ? 'checked' : ''}>
            <span>每</span>
            <input type="number" class="sp-input sp-interval-input sp-ledger-interval" min="1" max="30" value="${iv}">
            <span>楼自动标注</span>
        </label>
        <button class="sp-mini-btn sp-ledger-pill sp-ledger-capture-now" title="立即标注一次" ${busy ? 'disabled' : ''}>${busy ? '标注中…' : '标注'}</button>
        <button class="sp-mini-btn sp-ledger-pill sp-ledger-judge-now" title="立即判定一次（更新现状 / 了结）" ${judging ? 'disabled' : ''}>${judging ? '更新中…' : '更新'}</button>
    </div>`;
    const entries = ledger.listEntries();
    const cal = loadCalDesc();
    const closed = ledger.listEntries({ includeClosed: true }).filter(e => e.状态 === '已了结');
    // 归档折叠区：有已了结条目才渲染。默认收起，点标题条 _ledgerArchiveOpen 切换。
    const archive = closed.length
        ? `<div class="sp-ledger-archive">
                <button class="sp-ledger-archive-head" title="${_ledgerArchiveOpen ? '收起归档' : '展开已了结条目'}">
                    <i class="fa-solid fa-chevron-${_ledgerArchiveOpen ? 'down' : 'right'}"></i>
                    <span>已了结 ${closed.length} 条</span>
                </button>
                ${_ledgerArchiveOpen ? batchBarHtml('ledger-archive', closed.length, '批量删除', true) + `<div class="sp-ledger-list sp-ledger-archive-list">${closed.map(e => ledgerRowHtml(e, cal, true)).join('')}</div>` : ''}
           </div>`
        : '';
    if (!entries.length) {
        const hint = busy ? '正在标注…'
            : `暂无活跃刻度条目。聊几楼后${on ? '自动标注' : '（先勾上「自动标注」）'}，或点右上「立即标注」。`;
        return ctrl + `<div class="sp-ledger-empty">${hint}</div>` + archive;
    }
    return ctrl + batchBarHtml('ledger-active', entries.length, '批量归档', false) + `<div class="sp-ledger-list">${entries.map(e => ledgerRowHtml(e, cal)).join('')}</div>` + archive;
}
