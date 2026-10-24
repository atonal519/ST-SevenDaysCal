import { dailyMenuContentKey } from '../../business/point/daily-menu-images.js';
import { renderDailyMenuHtml } from '../../business/point/daily-menu.js';

function updateDailyMenuImageHeight(body) {
    const drawer = body.closest('.sp-daily-menu-image');
    const expanded = drawer?.querySelector('.sp-daily-menu-image-toggle')?.getAttribute('aria-expanded') === 'true';
    const inner = body.querySelector('.sp-daily-menu-image-inner');
    const height = expanded && inner ? inner.getBoundingClientRect().height : 0;
    body.style.height = `${height}px`;
}

export function disposeDailyMenuImages(host) {
    for (const body of host?.querySelectorAll?.('.sp-daily-menu-image-body') || []) {
        body.spMenuImageObserver?.disconnect();
        delete body.spMenuImageObserver;
    }
}

export function setDailyMenuImageExpanded(drawer, expanded) {
    const toggle = drawer?.querySelector('.sp-daily-menu-image-toggle');
    const body = drawer?.querySelector('.sp-daily-menu-image-body');
    if (!toggle || !body) return;
    toggle.setAttribute('aria-expanded', String(!!expanded));
    const name = drawer.querySelector('.sp-daily-menu-item-title strong')?.textContent || '这道菜';
    toggle.title = expanded ? '收起配图' : '查看配图';
    toggle.setAttribute('aria-label', `${expanded ? '收起' : '查看'}${name}的配图`);
    body.setAttribute('aria-hidden', String(!expanded));
    body.inert = !expanded;
    updateDailyMenuImageHeight(body);
}

export function refreshDailyMenuImageDrawer(drawer, menu, controller, escapeHtml) {
    if (!drawer) return;
    const index = Number(drawer.dataset.menuImageIndex);
    const item = menu?.items?.[index];
    if (!item) return;
    const body = drawer.querySelector('.sp-daily-menu-image-body');
    if (!body) return;
    const state = controller?.state(menu, index) || {};
    const action = drawer.querySelector('.sp-daily-menu-image-action');
    const label = state.busy ? '取消本次操作' : item.image?.path ? '重新生成' : '生成图片';
    action.className = `sp-daily-menu-image-pill sp-daily-menu-image-action ${state.busy ? 'sp-daily-menu-image-cancel' : 'sp-daily-menu-image-generate'}`;
    action.title = label;
    action.setAttribute('aria-label', state.busy ? `取消${item.name}的配图生成` : `${item.image?.path ? '重新生成' : '生成'}${item.name}的配图`);
    action.textContent = state.busy ? '停止' : '生图';
    const toggle = drawer.querySelector('.sp-daily-menu-image-toggle');
    toggle.textContent = item.image?.path ? '已生成' : '未生成';
    const expanded = drawer.querySelector('.sp-daily-menu-image-toggle')?.getAttribute('aria-expanded') === 'true';
    if (!body.querySelector('.sp-daily-menu-image-status')) {
        if (!expanded) return;
        body.innerHTML = '<div class="sp-daily-menu-image-inner"><p class="sp-daily-menu-image-status" role="status" aria-live="polite"></p><p class="sp-daily-menu-image-empty" hidden>尚未生成配图</p><div class="sp-daily-menu-image-preview"></div></div>';
        const inner = body.querySelector('.sp-daily-menu-image-inner');
        body.spMenuImageObserver = new ResizeObserver(() => updateDailyMenuImageHeight(body));
        body.spMenuImageObserver.observe(inner);
    }
    const status = body.querySelector('.sp-daily-menu-image-status');
    status.textContent = state.message || '';
    status.hidden = !state.message;
    body.querySelector('.sp-daily-menu-image-empty').hidden = !!item.image?.path || !!state.message;
    if (!expanded) return;
    const preview = body.querySelector('.sp-daily-menu-image-preview');
    const path = String(item.image?.path || '').trim();
    if (preview.dataset.path !== path) {
        preview.dataset.path = path;
        preview.innerHTML = path ? `<img class="sp-daily-menu-image-picture" src="${escapeHtml(path)}" alt="${escapeHtml(String(item.name))}的配图" decoding="async"><p class="sp-daily-menu-image-error" role="status" hidden>图片无法显示，可重新生成</p>` : '';
    }
    updateDailyMenuImageHeight(body);
}

export function renderDailyMenuView(host, menu, { escapeHtml, busy = false, controller = null, index = null } = {}) {
    if (!host) return;
    const key = dailyMenuContentKey(menu);
    // Same-menu progress and another dish's completion keep existing drawers,
    // loaded images, keyboard focus and the content scroller in place.
    if (host.dailyMenuContentKey !== key || !host.querySelector?.('.sp-daily-menu-card')) {
        disposeDailyMenuImages(host);
        host.innerHTML = renderDailyMenuHtml(menu, { escapeHtml, busy });
        host.dailyMenuContentKey = key;
    } else {
        const action = host.querySelector('.sp-daily-menu-generate, .sp-daily-menu-cancel');
        if (action) {
            action.className = `sp-gen-btn ${busy ? 'sp-daily-menu-cancel' : 'sp-daily-menu-generate'}`;
            action.textContent = busy ? '取消生成' : menu?.items?.length ? '换一份' : '生成菜单';
        }
    }
    const selector = index == null ? '.sp-daily-menu-image' : `.sp-daily-menu-image[data-menu-image-index="${index}"]`;
    for (const drawer of host.querySelectorAll?.(selector) || []) refreshDailyMenuImageDrawer(drawer, menu, controller, escapeHtml);
}

export function showDailyMenuImageError(image) {
    if (!image?.classList?.contains('sp-daily-menu-image-picture')) return;
    image.hidden = true;
    const message = image.parentElement?.querySelector('.sp-daily-menu-image-error');
    if (message) message.hidden = false;
}
