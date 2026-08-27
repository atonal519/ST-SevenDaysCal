import { extractWidgets } from './schema.js';

export function createSpaceRenderer(env = {}) {
    const escape = value => env.escapeHtml?.(String(value ?? '')) ?? String(value ?? '');
    const widgetCard = (kind, body, wid, editIdx = null) => {
        if (kind === 'schedule_widget') {
            const line = body.split('\n').find(item => /^Event\s*:/i.test(item)) || '';
            const [type, title, desc, time, location, dynamic] = line.replace(/^Event\s*:\s*/i, '').split('|').map(item => item.trim());
            const types = { main: { label: '明线', color: '#d6b85a' }, hidden: { label: '暗线', color: '#a06fd6' }, bond: { label: '红线', color: '#d67f6f' } };
            const meta = types[type] || { label: type || '?', color: '#9aa6b2' };
            return `<div class="sp-space-widget-card" data-wid="${wid}" data-kind="schedule">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge" style="background:${meta.color}22;color:${meta.color};border-color:${meta.color}">
                    <i class="fa-regular fa-calendar"></i> ${editIdx != null ? `建议改点·第 ${editIdx} 条` : '建议加到点'}（${escape(meta.label)}）
                </span>
            </div>
            <div class="sp-space-widget-body">
                <div class="sp-space-widget-title">${escape(title || '(未命名)')}</div>
                ${desc ? `<div class="sp-space-widget-desc">${escape(desc)}</div>` : ''}
                <div class="sp-space-widget-meta">
                    ${time ? `<span><i class="fa-regular fa-clock"></i> ${escape(time)}</span>` : ''}
                    ${location ? `<span><i class="fa-solid fa-location-dot"></i> ${escape(location)}</span>` : ''}
                </div>
                ${dynamic ? `<div class="sp-space-widget-dynamic">🧵 ${escape(dynamic)}</div>` : ''}
            </div>
            <div class="sp-space-widget-actions">
                <button class="sp-space-widget-apply" data-wid="${wid}"><i class="fa-solid ${editIdx != null ? 'fa-pen' : 'fa-plus'}"></i> ${editIdx != null ? `替换第 ${editIdx} 条` : '应用到点'}</button>
            </div>
        </div>`;
        }
        if (kind === 'line_widget') {
            const rows = body.split('\n');
            const lineRow = rows.find(item => /^Line\s*:/i.test(item)) || '';
            const descRow = rows.find(item => /^Desc\s*:/i.test(item)) || '';
            const nextRow = rows.find(item => /^Next\s*:/i.test(item)) || '';
            const [name, lineType, stage, , when, agency, stall] = lineRow.replace(/^Line\s*:\s*/i, '').split('|').map(item => item.trim());
            const desc = descRow.replace(/^Desc\s*:\s*/i, '').trim();
            const next = nextRow.replace(/^Next\s*:\s*/i, '').trim();
            const stalled = String(stall).toLowerCase() === 'true';
            return `<div class="sp-space-widget-card" data-wid="${wid}" data-kind="line">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge sp-space-widget-badge-line">
                    <i class="fa-solid fa-diagram-project"></i> ${editIdx != null ? `建议改线·第 ${editIdx} 条` : '建议加到线'}
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
                <button class="sp-space-widget-apply" data-wid="${wid}"><i class="fa-solid ${editIdx != null ? 'fa-pen' : 'fa-plus'}"></i> ${editIdx != null ? `替换第 ${editIdx} 条` : '应用到线'}</button>
            </div>
        </div>`;
        }
        if (kind === 'almanac_widget') {
            const items = env.parseAlmanac?.(body) || [];
            if (!items.length) return '';
            const calendar = env.loadCalendar?.();
            const labels = { festival: '节日', birthday: '生日', anniversary: '纪念日', custom: '自定义' };
            return items.map((item, index) => {
                const date = item.displayDate || `${env.calendarMonthName?.(calendar, item.month) ?? item.month}${item.day}日`;
                return `<div class="sp-space-widget-card" data-wid="${wid}" data-kind="almanac">
                <div class="sp-space-widget-head">
                    <span class="sp-space-widget-badge sp-space-widget-badge-almanac">
                        <i class="fa-regular fa-calendar-check"></i> 建议加到历
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
                    <button class="sp-space-widget-apply" data-wid="${wid}" data-idx="${index}"><i class="fa-solid fa-plus"></i> 应用到轴</button>
                </div>
            </div>`;
            }).join('');
        }
        if (kind === 'era_widget') {
            const desc = env.parseEra?.(body);
            if (!desc) return '';
            const months = desc.months.map(month => `<span class="sp-space-widget-eramonth">${escape(month.name)}·${month.days}天</span>`).join('');
            return `<div class="sp-space-widget-card" data-wid="${wid}" data-kind="era">
            <div class="sp-space-widget-head">
                <span class="sp-space-widget-badge sp-space-widget-badge-era">
                    <i class="fa-regular fa-calendar-days"></i> 建议应用历法
                </span>
            </div>
            <div class="sp-space-widget-body">
                <div class="sp-space-widget-title">${escape(desc.era || '自定义历法')}</div>
                <div class="sp-space-widget-desc">一年 ${env.calendarMonthCount?.(desc)} 个月、共 ${env.calendarYearLength?.(desc)} 天</div>
                <div class="sp-space-widget-eramonths">${months}</div>
            </div>
            <div class="sp-space-widget-actions">
                <button class="sp-space-widget-apply" data-wid="${wid}"><i class="fa-solid fa-calendar-check"></i> 应用历法</button>
            </div>
        </div>`;
        }
        return '';
    };

    const message = (role, content, historyIndex, registerWidget) => {
        const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
        const wrapClass = role === 'user' ? 'sp-chat-msg-wrap-user' : role === 'ai' ? 'sp-chat-msg-wrap-ai' : 'sp-chat-msg-wrap-system';
        const canAct = role !== 'system' && Number.isInteger(historyIndex);
        let contentHtml;
        let widgetCards = '';
        if (role === 'ai') {
            const parsed = extractWidgets(content);
            contentHtml = parsed.text ? env.formatAi?.(parsed.text) ?? escape(parsed.text).replace(/\n/g, '<br>') : '';
            widgetCards = parsed.widgets.map(widget => {
                const wid = registerWidget?.(widget);
                return widgetCard(widget.kind, widget.body, wid, widget.editIdx);
            }).join('');
        } else {
            contentHtml = escape(content).replace(/\n/g, '<br>');
        }
        const edit = role === 'user' ? '<button class="sp-chat-msg-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>' : '';
        const actions = canAct
            ? `<div class="sp-chat-msg-actions">${edit}<button class="sp-chat-msg-copy" title="复制"><i class="fa-solid fa-copy"></i></button><button class="sp-chat-msg-delete" title="删除"><i class="fa-solid fa-trash"></i></button></div>`
            : '';
        return Object.freeze({ cls, wrapClass, canAct, contentHtml, widgetCards, actions });
    };
    return Object.freeze({ widgetCard, message });
}
