import { TYPE_META } from '../point/presentation.js';
import { icon } from '../../utils/icons.js';
import { extractWidgets, resolveSpaceWidgets } from './schema.js';
import { parseLineCard } from '../lines/schema.js';
import { firstPointEventBlock, isCompletePointEvent, parsePointEventRecord } from '../point/parse.js';
import { normalizeOutlineResponse, parseOutline } from '../outline/schema.js';

export function createSpaceRenderer(env = {}) {
    const escape = value => env.escapeHtml?.(String(value ?? '')) ?? String(value ?? '');
    const widgetName = kind => ({
        schedule_widget: '点卡片', line_widget: '线卡片', almanac_widget: '轴（历）卡片', era_widget: '历法卡片', outline_widget: '面方案',
    }[kind] || '结构化卡片');
    const invalidWidgetCard = (kind, body, message = '') => `<div class="sp-space-widget-card sp-space-widget-card-error" data-kind="error">
        <div class="sp-space-widget-head"><span class="sp-space-widget-badge">${icon("alert-triangle")} ${escape(widgetName(kind))}无法应用</span></div>
        <div class="sp-space-widget-body">
            <div class="sp-space-widget-desc">${escape(message || '这次方案内容不完整，无法应用；可补充要求或编辑问题重发。')}</div>
            ${String(body || '').trim() ? `<details class="sp-raw"><summary>查看原始回复</summary><pre>${escape(body)}</pre></details>` : ''}
        </div>
    </div>`;
    const noWidgetCard = () => `<div class="sp-space-widget-card sp-space-widget-card-status" data-kind="status">
        <div class="sp-space-widget-desc">本次回复没有可应用卡片</div>
    </div>`;
    const parseAlmanacBody = body => {
        try { return env.parseAlmanac?.(body) || []; } catch { return []; }
    };
    const parseEraBody = body => {
        try { return env.parseEra?.(body) || null; } catch { return null; }
    };
    const parsePointBody = body => {
        const first = firstPointEventBlock(body);
        const event = first ? parsePointEventRecord(first) : null;
        return isCompletePointEvent(event) ? event : null;
    };
    const parseLineWidgetBody = body => {
        try { return parseLineCard(body); } catch { return null; }
    };
    const widgetBodyValid = widget => {
        if (widget.kind === 'schedule_widget') return !!parsePointBody(widget.body);
        if (widget.kind === 'line_widget') return !!parseLineWidgetBody(widget.body);
        if (widget.kind === 'almanac_widget') return parseAlmanacBody(widget.body).length > 0;
        if (widget.kind === 'era_widget') return !!parseEraBody(widget.body);
        if (widget.kind === 'outline_widget') return !!normalizeOutlineResponse(widget.body);
        return true;
    };
    const widgetCard = (kind, body, wid, editIdx = null, owner = null, legacyPointOwner = false, readOnly = false, messageContext = {}) => {
        const readOnlyAction = readOnly
            ? `<div class="sp-space-widget-readonly">${icon("lock")} 这份历史方案仅供查看</div>`
            : null;
        if (kind === 'schedule_widget') {
            const event = parsePointBody(body) || {};
            const { type, title, desc, time, location, npcAction: dynamic } = event;
            const meta = TYPE_META[type] || { label: type || '?', cls: 'sp-type-unknown' };
            const userName = String(env.getUserName?.() || '我').trim() || '我';
            const ownerLabel = editIdx == null
                ? '应用时选择人物'
                : owner?.view === 'char'
                    ? `${owner.charName}（TA）`
                    : owner?.view === 'user' || legacyPointOwner
                        ? `${userName}（我）`
                        : '人物待确认';
            return `<div class="sp-space-widget-card${readOnly ? ' sp-space-widget-card-readonly' : ''}" data-wid="${wid}" data-kind="schedule">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge ${meta.cls}">
                    ${icon("calendar")} ${editIdx != null ? `建议改点·第 ${editIdx} 条` : '建议加到点'}（${escape(meta.label)}）
                </span>
            </div>
            <div class="sp-space-widget-body">
                <div class="sp-space-widget-title">${escape(title || '(未命名)')}</div>
                ${desc ? `<div class="sp-space-widget-desc">${escape(desc)}</div>` : ''}
                <div class="sp-space-widget-meta">
                    <span>${icon("user")} ${escape(ownerLabel)}</span>
                    ${time ? `<span>${icon("clock")} ${escape(time)}</span>` : ''}
                    ${location ? `<span>${icon("map-pin")} ${escape(location)}</span>` : ''}
                </div>
                ${dynamic ? `<div class="sp-space-widget-dynamic">${icon('message-circle')} ${escape(dynamic)}</div>` : ''}
            </div>
            <div class="sp-space-widget-actions">
                ${readOnlyAction || `<button class="sp-space-widget-apply" data-wid="${wid}">${icon(editIdx != null ? 'pencil' : 'plus')} ${editIdx != null ? `替换 ${escape(ownerLabel)} · 第 ${editIdx} 条` : '选择人物并应用'}</button>`}
            </div>
        </div>`;
        }
        if (kind === 'line_widget') {
            const { name, type: lineType, stage, when, agency, stall, desc, next } = parseLineWidgetBody(body) || {};
            const stalled = stall === true;
            return `<div class="sp-space-widget-card${readOnly ? ' sp-space-widget-card-readonly' : ''}" data-wid="${wid}" data-kind="line">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge sp-space-widget-badge-line">
                    ${icon("line")} ${editIdx != null ? `建议改线·第 ${editIdx} 条` : '建议加到线'}
                </span>
            </div>
            <div class="sp-space-widget-body">
                <div class="sp-space-widget-title">${escape(name || '(未命名)')}</div>
                <div class="sp-space-widget-meta">
                    ${lineType ? `<span>${escape(lineType)}</span>` : ''}
                    ${stage ? `<span>${escape(stage)}${stalled ? ' · 停滞' : ''}</span>` : ''}
                    ${when ? `<span>${escape(when)}</span>` : ''}
                    ${agency ? `<span>${agency === 'player' ? '需推动' : '自演化'}</span>` : ''}
                </div>
                ${desc ? `<div class="sp-space-widget-desc">${escape(desc)}</div>` : ''}
                ${next ? `<div class="sp-space-widget-next">→ ${escape(next)}</div>` : ''}
            </div>
            <div class="sp-space-widget-actions">
                ${readOnlyAction || `<button class="sp-space-widget-apply" data-wid="${wid}">${icon(editIdx != null ? 'pencil' : 'plus')} ${editIdx != null ? `替换第 ${editIdx} 条` : '应用到线'}</button>`}
            </div>
        </div>`;
        }
        if (kind === 'almanac_widget') {
            const items = parseAlmanacBody(body);
            if (!items.length) return invalidWidgetCard(kind, body);
            const calendar = env.loadCalendar?.();
            const labels = { festival: '节日', birthday: '生日', anniversary: '纪念日', custom: '自定义' };
            return items.map((item, index) => {
                const date = item.displayDate || `${env.calendarMonthName?.(calendar, item.month) ?? item.month}${item.day}日`;
                return `<div class="sp-space-widget-card${readOnly ? ' sp-space-widget-card-readonly' : ''}" data-wid="${wid}" data-kind="almanac">
                <div class="sp-space-widget-head">
                    <span class="sp-space-widget-badge sp-space-widget-badge-almanac">
                        ${icon("calendar-check")} 建议加到历
                    </span>
                </div>
                <div class="sp-space-widget-body">
                    <div class="sp-space-widget-almrow">
                        <span class="sp-space-widget-almdate">${escape(date)}</span>
                        <span class="sp-space-widget-almname">${escape(item.name)}</span>
                        <span class="sp-space-widget-almtype">${escape(labels[item.type] || '自定义')}</span>
                    </div>
                </div>
                <div class="sp-space-widget-actions">
                    ${readOnlyAction || `<button class="sp-space-widget-apply" data-wid="${wid}" data-idx="${index}">${icon("plus")} 应用到轴</button>`}
                </div>
            </div>`;
            }).join('');
        }
        if (kind === 'era_widget') {
            const desc = parseEraBody(body);
            if (!desc) return invalidWidgetCard(kind, body);
            const months = desc.months.map(month => `<span class="sp-space-widget-eramonth">${escape(month.name)}·${month.days}天</span>`).join('');
            return `<div class="sp-space-widget-card${readOnly ? ' sp-space-widget-card-readonly' : ''}" data-wid="${wid}" data-kind="era">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge sp-space-widget-badge-era">
                    ${icon("calendar-week")} 建议应用历法
                </span>
            </div>
            <div class="sp-space-widget-body">
                <div class="sp-space-widget-title">${escape(desc.era || '自定义历法')}</div>
                <div class="sp-space-widget-desc">一年 ${env.calendarMonthCount?.(desc)} 个月、共 ${env.calendarYearLength?.(desc)} 天</div>
                <div class="sp-space-widget-eramonths">${months}</div>
            </div>
            <div class="sp-space-widget-actions">
                ${readOnlyAction || `<button class="sp-space-widget-apply" data-wid="${wid}">${icon("calendar-check")} 应用历法</button>`}
            </div>
        </div>`;
        }
        if (kind === 'outline_widget') {
            const normalized = normalizeOutlineResponse(body);
            const beats = normalized ? parseOutline(normalized) : [];
            if (!beats.length) return invalidWidgetCard(kind, body);
            const items = beats.map(beat => `<li><strong>${escape(beat.title || '未命名')}</strong><span>${escape(beat.time || '')}</span><p>${escape(beat.scene || '')}</p></li>`).join('');
            const current = normalizeOutlineResponse(messageContext.currentOutlineRaw || '');
            const same = current && current === normalized;
            return `<div class="sp-space-widget-card${readOnly ? ' sp-space-widget-card-readonly' : ''}" data-wid="${wid}" data-kind="outline">
                <div class="sp-space-widget-head"><span class="sp-space-widget-badge">${icon("polygon")} 面草稿 · ${beats.length} 个节点</span></div>
                <ol class="sp-space-outline-preview">${items}</ol>
                <div class="sp-space-widget-actions">${readOnlyAction || `<button class="sp-space-widget-apply" data-wid="${wid}">${icon("check")} 应用到面</button>`}</div>
                ${same ? '<div class="sp-space-widget-desc">与当前面内容一致</div>' : ''}
            </div>`;
        }
        return '';
    };

    const renderWidget = (widget, registerWidget, messageContext) => {
        if (widget.kind === 'almanac_widget') {
            return parseAlmanacBody(widget.body).map(item => {
                const itemBody = `<almanac_widget>Item: ${item.name}|${item.type}|${item.month}|${item.day}|${item.days}|${item.displayDate || ''}|${item.note || ''}</almanac_widget>`;
                const itemWidget = { ...widget, body: itemBody };
                if (!widgetBodyValid(itemWidget)) return invalidWidgetCard(widget.kind, itemBody);
                const wid = registerWidget?.(itemWidget, messageContext);
                return widgetCard(widget.kind, itemBody, wid, widget.editIdx, widget.owner, messageContext.legacyPointOwner === true, messageContext.readOnly === true, messageContext);
            }).join('');
        }
        const wid = registerWidget?.(widget, messageContext);
        return widgetCard(widget.kind, widget.body, wid, widget.editIdx, widget.owner, messageContext.legacyPointOwner === true, messageContext.readOnly === true, messageContext);
    };

    const message = (role, content, historyIndex, registerWidget, messageContext = {}) => {
        const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
        const wrapClass = role === 'user' ? 'sp-chat-msg-wrap-user' : role === 'ai' ? 'sp-chat-msg-wrap-ai' : 'sp-chat-msg-wrap-system';
        const canAct = role !== 'system' && Number.isInteger(historyIndex);
        let contentHtml;
        let widgetCards = '';
        const actions = canAct
            ? `<div class="sp-chat-msg-actions">${role === 'user' ? `<button class="sp-chat-msg-edit" title="编辑">${icon("pencil")}</button>` : ''}<button class="sp-chat-msg-copy" title="复制">${icon("copy")}</button><button class="sp-chat-msg-delete" title="删除">${icon("trash")}</button></div>`
            : '';
        if (role === 'ai') {
            const parsed = extractWidgets(content);
            contentHtml = parsed.text ? env.formatAi?.(parsed.text) ?? escape(parsed.text).replace(/\n/g, '<br>') : '';
            const expected = messageContext.expectedWidgetKind;
            const hasPolicy = Array.isArray(messageContext.allowedWidgetKinds);
            const allowed = hasPolicy ? messageContext.allowedWidgetKinds : null;
            const allKinds = hasPolicy && !expected && allowed.length === 5;
            if (allKinds) {
                const resolved = resolveSpaceWidgets(content, messageContext, {
                    parseAlmanac: env.parseAlmanac,
                    parseEra: env.parseEra,
                });
                if (resolved.ambiguous || !resolved.widgets.length) {
                    const hasStructured = extractWidgets(content).widgets.length > 0 || !!normalizeOutlineResponse(content);
                    if (!hasStructured) return Object.freeze({ cls, wrapClass, canAct, contentHtml, widgetCards: '', actions });
                    const reason = resolved.ambiguous ? '本次回复包含多种可应用卡片，未擅自选择。' : '本次回复包含结构化内容，但没有完整可应用卡片。';
                    widgetCards = `<div class="sp-space-widget-card sp-space-widget-card-error" data-kind="status"><div class="sp-space-widget-desc">${escape(reason)}</div><details class="sp-raw"><summary>查看原始回复</summary><pre>${escape(content)}</pre></details></div>`;
                    return Object.freeze({ cls, wrapClass, canAct, contentHtml: '', widgetCards, actions });
                }
                if (resolved.widgets.length) {
                    if (!parsed.widgets.some(widget => widget.kind === resolved.widgets[0].kind && widgetBodyValid(widget))) contentHtml = '';
                    widgetCards = resolved.widgets.map(widget => renderWidget(widget, registerWidget, messageContext)).join('');
                }
                return Object.freeze({ cls, wrapClass, canAct, contentHtml, widgetCards, actions });
            }
            if (hasPolicy && allowed.length === 0 && parsed.widgets.length) {
                widgetCards = parsed.widgets.map(widget => invalidWidgetCard(widget.kind, widget.body, `本轮没有要求生成可应用卡片；${widgetName(widget.kind)}未开放应用。`)).join('');
            } else if (expected || (hasPolicy && allowed.length)) {
                const resolvedPolicy = resolveSpaceWidgets(content, messageContext, {
                    parseAlmanac: env.parseAlmanac,
                    parseEra: env.parseEra,
                });
                let matching = resolvedPolicy.widgets.filter(widget => hasPolicy
                    ? allowed.includes(widget.kind) && (!expected || widget.kind === expected)
                    : widget.kind === expected);
                if ((expected === 'outline_widget' || allowed?.includes?.('outline_widget')) && !matching.length) {
                    const normalized = normalizeOutlineResponse(content);
                    if (normalized && (!hasPolicy || allowed.includes('outline_widget')) && (!expected || expected === 'outline_widget')) {
                        matching = [{ kind: 'outline_widget', body: normalized, editIdx: null, owner: null }];
                    }
                }
                const matchingKinds = new Set(matching.map(widget => widget.kind));
                const wrong = parsed.widgets.filter(widget => !matchingKinds.has(widget.kind));
                if (!matching.length) {
                    widgetCards = wrong.length
                        ? wrong
                        .map(widget => invalidWidgetCard(expected || widget.kind, widget.body, `本轮没有开放${widgetName(widget.kind)}；该卡片未开放应用。`))
                        .join('')
                        : parsed.widgets.length
                            ? invalidWidgetCard(expected || allowed[0], '', `本轮没有可用的${widgetName(expected || allowed[0])}卡片；可编辑原问题后重发。`)
                            : noWidgetCard();
                } else {
                    if (!parsed.widgets.some(widget => matchingKinds.has(widget.kind) && widgetBodyValid(widget))) contentHtml = '';
                    const validMatching = matching.filter(widgetBodyValid);
                    const applicable = validMatching.map(widget => {
                        if (widget.kind !== 'outline_widget') return widget;
                        return { ...widget, body: normalizeOutlineResponse(widget.body) };
                    });
                    widgetCards = applicable.map(widget => renderWidget(widget, registerWidget, messageContext)).join('');
                }
            } else if (!hasPolicy) {
                // 旧历史没有本轮白名单，继续兼容其原有卡型展示；仍用正式解析器校验。
                widgetCards = parsed.widgets.map(widget => {
                    if (!widgetBodyValid(widget)) return invalidWidgetCard(widget.kind, widget.body);
                    return renderWidget(widget, registerWidget, messageContext);
                }).join('');
            }
        } else {
            contentHtml = escape(content).replace(/\n/g, '<br>');
        }
        return Object.freeze({ cls, wrapClass, canAct, contentHtml, widgetCards, actions });
    };
    return Object.freeze({ widgetCard, message });
}
