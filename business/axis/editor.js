import { axisState } from './state.js';

export function openAxisEditor(id, prefill, render) {
    axisState._almanacEditor = { id: id || null, prefill: prefill || null };
    if (axisState.almanacMode) render();
}

export function closeAxisEditor(render) {
    axisState._almanacEditor = null;
    if (axisState.almanacMode) render();
}

export function setAxisSheet(sheet, render, resetBatch) {
    if (axisState._almanacSheet === sheet) return;
    axisState._almanacSheet = sheet;
    axisState._almanacCalDay = null;
    resetBatch?.();
    render();
}

export function navigateAxisMonth(delta, monthCount, currentMonth, render) {
    const mc = monthCount();
    axisState._almanacCalMonth = (currentMonth() + delta + mc) % mc;
    axisState._almanacCalDay = null;
    render();
}

export function createAxisEditorController(env = {}) {
    const save = () => {
        const editor = axisState._almanacEditor;
        if (!editor) return { ok: false, reason: 'closed' };
        const fields = env.read?.();
        if (!fields?.name) return { ok: false, reason: 'name' };
        const existing = editor.id ? env.load?.().find(item => item.id === editor.id) : null;
        const record = env.normalize?.({ id: existing?.id || env.id?.(), name: fields.name, type: fields.type, month: fields.month, day: fields.day, days: fields.days, displayDate: fields.displayDate, note: fields.note, pin: existing ? existing.pin : true, source: existing ? existing.source : 'user' });
        const list = env.load?.() || [];
        const index = existing ? list.findIndex(item => item.id === existing.id) : -1;
        if (index >= 0) list[index] = record; else list.push(record);
        const stored = env.persist?.(list);
        if (stored === false) return { ok: false, reason: 'persist' };
        axisState._almanacEditor = null;
        env.render?.(); env.afterSave?.();
        return { ok: true, record };
    };
    return { save };
}

export function renderAxisEditor(env = {}) {
    const editor = axisState._almanacEditor; if (!editor) return '';
    const cal = env.calendar();
    const current = editor.id ? env.items().find(item => item.id === editor.id) : null;
    const item = current || { name: '', type: 'custom', month: editor.prefill?.month || (env.monthIndex() + 1), day: editor.prefill?.day || (editor.prefill ? 1 : env.today().day), days: 1, displayDate: '', note: '', pin: true, source: 'user' };
    const typeOptions = env.types.map(type => `<option value="${type}"${item.type === type ? ' selected' : ''}>${env.typeLabel(type)}</option>`).join('');
    return `<div class="sp-alm-editor-head"><button class="sp-icon-btn sp-alm-editor-back" title="返回"><i class="fa-solid fa-arrow-left"></i></button><span class="sp-alm-editor-title">${current ? '编辑日期' : '添加日期'}</span></div><div class="sp-alm-body"><div class="sp-alm-editor-body"><label class="sp-alm-field"><span>名称</span><input type="text" id="sp-alm-f-name" maxlength="40" placeholder="如 元宵节 / 阿露的生日" value="${env.escapeAttr(item.name)}"></label><label class="sp-alm-field"><span>类型</span><select id="sp-alm-f-type">${typeOptions}</select></label><div class="sp-alm-field-row"><label class="sp-alm-field sp-alm-field-sm"><span>月</span><input type="number" id="sp-alm-f-month" min="1" max="${env.monthCount(cal)}" value="${item.month}"></label><label class="sp-alm-field sp-alm-field-sm"><span>日</span><input type="number" id="sp-alm-f-day" min="1" max="${env.monthDays(cal, item.month)}" value="${item.day}"></label><label class="sp-alm-field sp-alm-field-sm"><span>天数</span><input type="number" id="sp-alm-f-days" min="1" max="${env.yearLength(cal)}" value="${item.days || 1}"></label></div><div class="sp-alm-wd-hint" id="sp-alm-f-wdhint"></div><label class="sp-alm-field"><span>风味日期 <small>选填，如"正月十五"</small></span><input type="text" id="sp-alm-f-disp" maxlength="40" placeholder="留空则显示 M月D日" value="${env.escapeAttr(item.displayDate)}"></label><label class="sp-alm-field"><span>说明 <small>选填</small></span><textarea id="sp-alm-f-note" rows="2" maxlength="200" placeholder="这个日子的意义 / 习俗">${env.escapeHtml(item.note)}</textarea></label></div><div class="sp-alm-editor-actions"><button class="sp-mini-btn sp-alm-editor-cancel">取消</button><button class="sp-gen-btn sp-alm-editor-save">保存</button></div></div>`;
}

export function renderAxisWeekdayHint(env = {}) {
    const cal = env.calendar();
    const month = env.clamp(env.monthValue(), 1, env.monthCount(cal), 1);
    const day = env.clamp(env.dayValue(), 1, env.monthDays(cal, month), 1);
    const days = env.clamp(env.durationValue(), 1, env.yearLength(cal), 1);
    const ref = env.weekdayRef(cal); const wdIndex = env.weekdayFor(month, day, ref, cal); const wd = wdIndex == null ? '星期未记录' : env.weekdays[wdIndex];
    if (days > 1) { const end = env.endMonthDay({ month, day, days }, cal); const endIndex = env.weekdayFor(end.month, end.day, ref, cal); const ewd = endIndex == null ? '星期未记录' : env.weekdays[endIndex]; return `${env.monthName(cal, month)}${day}日 ${wd} · 共 ${days} 天，至 ${env.monthName(cal, end.month)}${end.day}日 ${ewd}`; }
    return `${env.monthName(cal, month)}${day}日 · ${wd}`;
}
