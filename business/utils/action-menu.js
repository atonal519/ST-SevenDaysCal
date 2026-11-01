import { icon } from '../../utils/icons.js';

const PLACEMENT_STYLES = ['top', 'right', 'bottom', 'left', 'maxWidth', 'maxHeight', 'overflowY'];
export function clearActionMenuPlacement(menu) {
    const list = menu?.querySelector('.sp-action-menu-list');
    if (list) for (const key of PLACEMENT_STYLES) list.style[key] = '';
}

export function positionActionMenu(menu) {
    const list = menu?.querySelector('.sp-action-menu-list');
    const view = menu?.ownerDocument?.defaultView;
    if (!list || list.hidden || !view?.getComputedStyle) return;
    clearActionMenuPlacement(menu);
    const anchor = menu.getBoundingClientRect();
    const natural = list.getBoundingClientRect();
    const preferUp = natural.bottom <= anchor.top;
    const preferLeft = Math.abs(natural.left - anchor.left) <= Math.abs(natural.right - anchor.right);
    const gap = Math.max(0, preferUp ? anchor.top - natural.bottom : natural.top - anchor.bottom);
    const viewport = view.visualViewport;
    let left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    let right = left + (viewport?.width ?? view.innerWidth), bottom = top + (viewport?.height ?? view.innerHeight);
    const parent = node => node.parentElement ?? node.parentNode?.host ?? null;
    // 复用菜单原 DOM；可见区域取视口与实际裁切祖先的 client box 交集。
    for (let node = parent(menu); node; node = parent(node)) {
        if (!node.getBoundingClientRect) continue;
        const style = view.getComputedStyle(node), rect = node.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
            const edge = rect.left + node.clientLeft;
            left = Math.max(left, edge); right = Math.min(right, edge + node.clientWidth);
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
            const edge = rect.top + node.clientTop;
            top = Math.max(top, edge); bottom = Math.min(bottom, edge + node.clientHeight);
        }
    }
    // UI 字号/控件尺寸都从实际几何读取；比例只处理祖先 CSS transform。
    const menuCss = view.getComputedStyle(menu);
    const scaleX = anchor.width / (parseFloat(menuCss?.width) || anchor.width) || 1;
    const scaleY = anchor.height / (parseFloat(menuCss?.height) || anchor.height) || 1;
    list.style.maxWidth = `${Math.max(0, right - left) / scaleX}px`;
    const measured = list.getBoundingClientRect();
    const above = Math.max(0, anchor.top - top - gap), below = Math.max(0, bottom - anchor.bottom - gap);
    const preferred = preferUp ? above : below, opposite = preferUp ? below : above;
    const up = measured.height > preferred && opposite > preferred ? !preferUp : preferUp;
    list.style.maxHeight = `${(up ? above : below) / scaleY}px`;
    list.style.overflowY = 'auto';
    const fitted = list.getBoundingClientRect();
    const x = Math.max(left, Math.min(preferLeft ? anchor.left : anchor.right - fitted.width, right - fitted.width));
    const y = Math.max(top, Math.min(up ? anchor.top - gap - fitted.height : anchor.bottom + gap, bottom - fitted.height));
    list.style.right = 'auto'; list.style.bottom = 'auto';
    list.style.left = `${(x - anchor.left) / scaleX}px`;
    list.style.top = `${(y - anchor.top) / scaleY}px`;
}

export function renderActionMenu(menuId, items = [], escapeHtml = value => String(value ?? ''), escapeAttr = value => String(value ?? '')) {
    const rows = items.map(item => `<button type="button" class="sp-action-menu-item" data-action="${escapeAttr(item.action)}" title="${escapeAttr(item.title)}">${icon(escapeAttr(item.icon))}<span>${escapeHtml(item.label)}</span></button>`).join('');
    return `<div class="sp-action-menu" data-menu-id="${escapeAttr(menuId)}"><button type="button" class="sp-icon-btn sp-action-menu-toggle" title="更多操作" aria-label="更多操作" aria-expanded="false">${icon("dots-vertical")}</button><div class="sp-action-menu-list" hidden>${rows}</div></div>`;
}
