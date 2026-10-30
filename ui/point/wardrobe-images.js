import { wardrobeContentKey } from '../../business/point/wardrobe-images.js';
import { renderWardrobeHtml } from '../../business/point/wardrobe.js';

function updateWardrobeImageHeight(body) {
    const drawer = body.closest('.sp-wardrobe-image');
    const expanded = drawer?.querySelector('.sp-wardrobe-image-toggle')?.getAttribute('aria-expanded') === 'true';
    const inner = body.querySelector('.sp-wardrobe-image-inner');
    const height = expanded && inner ? inner.getBoundingClientRect().height : 0;
    body.style.height = `${height}px`;
}

export function disposeWardrobeImages(host) {
    for (const body of host?.querySelectorAll?.('.sp-wardrobe-image-body') || []) {
        body.spWardrobeImageObserver?.disconnect();
        delete body.spWardrobeImageObserver;
    }
}

export function setWardrobeImageExpanded(drawer, expanded) {
    const toggle = drawer?.querySelector('.sp-wardrobe-image-toggle');
    const body = drawer?.querySelector('.sp-wardrobe-image-body');
    if (!toggle || !body) return;
    toggle.setAttribute('aria-expanded', String(!!expanded));
    const name = drawer.querySelector('.sp-wardrobe-item-title strong')?.textContent || '这个人';
    toggle.title = expanded ? '收起配图' : '查看配图';
    toggle.setAttribute('aria-label', `${expanded ? '收起' : '查看'}${name}的配图`);
    body.setAttribute('aria-hidden', String(!expanded));
    body.inert = !expanded;
    updateWardrobeImageHeight(body);
}

export function refreshWardrobeImageDrawer(drawer, wardrobe, controller, escapeHtml) {
    if (!drawer) return;
    const index = Number(drawer.dataset.wardrobeImageIndex);
    const item = wardrobe?.items?.[index];
    if (!item) return;
    const body = drawer.querySelector('.sp-wardrobe-image-body');
    if (!body) return;
    const state = controller?.state(wardrobe, index) || {};
    const action = drawer.querySelector('.sp-wardrobe-image-action');
    const label = state.busy ? '取消本次操作' : item.image?.path ? '重新生成' : '生成图片';
    action.className = `sp-wardrobe-image-pill sp-wardrobe-image-action ${state.busy ? 'sp-wardrobe-image-cancel' : 'sp-wardrobe-image-generate'}`;
    action.title = label;
    action.setAttribute('aria-label', state.busy ? `取消${item.name}的配图生成` : `${item.image?.path ? '重新生成' : '生成'}${item.name}的配图`);
    action.textContent = state.busy ? '停止' : '生图';
    const toggle = drawer.querySelector('.sp-wardrobe-image-toggle');
    toggle.textContent = item.image?.path ? '已生成' : '未生成';
    const expanded = drawer.querySelector('.sp-wardrobe-image-toggle')?.getAttribute('aria-expanded') === 'true';
    if (!body.querySelector('.sp-wardrobe-image-status')) {
        if (!expanded) return;
        body.innerHTML = '<div class="sp-wardrobe-image-inner"><p class="sp-wardrobe-image-status" role="status" aria-live="polite"></p><p class="sp-wardrobe-image-empty" hidden>尚未生成配图</p><div class="sp-wardrobe-image-preview"></div></div>';
        const inner = body.querySelector('.sp-wardrobe-image-inner');
        body.spWardrobeImageObserver = new ResizeObserver(() => updateWardrobeImageHeight(body));
        body.spWardrobeImageObserver.observe(inner);
    }
    const status = body.querySelector('.sp-wardrobe-image-status');
    status.textContent = state.message || '';
    status.hidden = !state.message;
    body.querySelector('.sp-wardrobe-image-empty').hidden = !!item.image?.path || !!state.message;
    if (!expanded) return;
    const preview = body.querySelector('.sp-wardrobe-image-preview');
    const path = String(item.image?.path || '').trim();
    if (preview.dataset.path !== path) {
        preview.dataset.path = path;
        preview.innerHTML = path ? `<img class="sp-wardrobe-image-picture" src="${escapeHtml(path)}" alt="${escapeHtml(String(item.name))}的配图" decoding="async"><p class="sp-wardrobe-image-error" role="status" hidden>图片无法显示，可重新生成</p>` : '';
    }
    updateWardrobeImageHeight(body);
}

export function renderWardrobeView(host, wardrobe, { escapeHtml, busy = false, controller = null, index = null } = {}) {
    if (!host) return;
    const key = wardrobeContentKey(wardrobe);
    // 同一方案的进度与其他人物配图完成时，保留已打开的抽屉、
    // 已加载图片、键盘焦点和滚动位置。
    if (host.wardrobeContentKey !== key || !host.querySelector?.('.sp-wardrobe-card')) {
        disposeWardrobeImages(host);
        host.innerHTML = renderWardrobeHtml(wardrobe, { escapeHtml, busy });
        host.wardrobeContentKey = key;
    } else {
        const action = host.querySelector('.sp-wardrobe-generate, .sp-wardrobe-cancel');
        if (action) {
            action.className = `sp-gen-btn ${busy ? 'sp-wardrobe-cancel' : 'sp-wardrobe-generate'}`;
            action.textContent = busy ? '取消生成' : wardrobe ? '重新生成' : '生成方案';
        }
    }
    const selector = index == null ? '.sp-wardrobe-image' : `.sp-wardrobe-image[data-wardrobe-image-index="${index}"]`;
    for (const drawer of host.querySelectorAll?.(selector) || []) refreshWardrobeImageDrawer(drawer, wardrobe, controller, escapeHtml);
}

export function showWardrobeImageError(image) {
    if (!image?.classList?.contains('sp-wardrobe-image-picture')) return;
    image.hidden = true;
    const message = image.parentElement?.querySelector('.sp-wardrobe-image-error');
    if (message) message.hidden = false;
}
