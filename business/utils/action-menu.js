import { icon } from '../../utils/icons.js';
export function renderActionMenu(menuId, items = [], escapeHtml = value => String(value ?? ''), escapeAttr = value => String(value ?? '')) {
    const rows = items.map(item => `<button type="button" class="sp-action-menu-item" data-action="${escapeAttr(item.action)}" title="${escapeAttr(item.title)}">${icon(escapeAttr(item.icon))}<span>${escapeHtml(item.label)}</span></button>`).join('');
    return `<div class="sp-action-menu" data-menu-id="${escapeAttr(menuId)}"><button type="button" class="sp-icon-btn sp-action-menu-toggle" title="更多操作" aria-label="更多操作" aria-expanded="false">${icon("dots-vertical")}</button><div class="sp-action-menu-list" hidden>${rows}</div></div>`;
}
