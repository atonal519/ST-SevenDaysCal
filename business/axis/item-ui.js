export function createAxisItemUi(env = {}) {
    const rowHtml = (it, ctx) => {
        const meta = env.typeMeta(it.type);
        const wdIndex = env.weekdayFor(it.month, it.day, ctx?.wkRef, ctx?.cal);
        const wd = wdIndex == null ? '星期未记录' : env.weekdays?.[wdIndex];
        const days = env.clampInt(it.days, 1, env.yearLength(ctx?.cal), 1);
        const spanTag = days > 1 ? `<span class="sp-alm-span-tag">共${days}天</span>` : '';
        const active = days > 1 && ctx?.todayDoy != null && env.itemCoversDoy(it, ctx.todayDoy, ctx?.cal);
        const activeTag = active ? '<span class="sp-alm-active-tag">进行中</span>' : '';
        const srcTag = it.source === 'user' ? '<span class="sp-alm-src-tag">自填</span>' : '';
        const batchOn = env.batchScope?.() === 'almanac';
        const checked = batchOn && env.batchSelected?.().has(it.id);
        const checkbox = batchOn ? `<input type="checkbox" class="sp-batch-check" ${checked ? 'checked' : ''} aria-label="选择此条">` : '';
        return `<div class="sp-alm-item sp-alm-type-${meta.cls}${it.pin ? ' sp-alm-pinned' : ''}${batchOn ? ' sp-batch-row' : ''}${checked ? ' sp-batch-checked' : ''}" data-id="${it.id}">
        <div class="sp-alm-top">
            ${checkbox}<i class="fa-solid ${meta.icon} sp-alm-date-icon"></i>
            <span class="sp-alm-date-txt">${env.escapeHtml(env.dateLabel(it, ctx?.cal))}</span>
            <span class="sp-alm-wd">${wd}</span>${spanTag}
            ${batchOn ? '' : `<span class="sp-alm-acts">
                <button class="sp-icon-btn sp-alm-pin" data-id="${it.id}" title="${it.pin ? '已锁定 · 生成时保留（点击解锁）' : '锁定 · 生成时保留'}"><i class="fa-solid ${it.pin ? 'fa-lock' : 'fa-lock-open'}"></i></button>
                <button class="sp-icon-btn sp-alm-edit" data-id="${it.id}" title="编辑"><i class="fa-solid fa-pen"></i></button>
                <button class="sp-icon-btn sp-alm-del" data-id="${it.id}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </span>`}
        </div>
        <div class="sp-alm-meta"><span class="sp-alm-name">${env.escapeHtml(it.name)}</span><span class="sp-alm-type-tag">${meta.label}</span>${srcTag}${activeTag}</div>
        ${it.note ? `<div class="sp-alm-note">${env.escapeHtml(it.note)}</div>` : ''}
    </div>`;
    };
    const emptyHtml = () => `<div class="sp-empty sp-alm-empty">
        <span class="sp-alm-empty-glyph"><i class="fa-regular fa-calendar"></i></span>
        <p>还没有历法数据</p>
        <p class="sp-alm-empty-hint">点「生成节日」让 AI 按当前世界观铺满一整年，或「添加」手动录入生日、纪念日等</p>
        <div class="sp-alm-empty-actions"><button class="sp-gen-btn sp-alm-gen">生成节日</button><button class="sp-alm-add-link sp-alm-add">手动添加</button></div>
    </div>`;
    return { rowHtml, emptyHtml };
}
