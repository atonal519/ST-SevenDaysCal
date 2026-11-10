// 主窗口两端均按浏览器可视视口定位，尺寸不受聊天区或输入栏影响。
export function readPanelViewport(win = globalThis.window) {
  const visual = win.visualViewport;
  return { left: Number(visual?.offsetLeft) || 0, top: Number(visual?.offsetTop) || 0,
    width: Math.max(0, Number(visual?.width) || win.innerWidth), height: Math.max(0, Number(visual?.height) || win.innerHeight) };
}

// 宿主 html 的 transform 会把 fixed 定位改为相对文档根；先测原点，再补偿滚动偏移。
export function syncDialogViewport(host, win = globalThis.window) {
  const view = readPanelViewport(win);
  Object.assign(host.style, { left: '0px', top: '0px', right: 'auto', bottom: 'auto',
    width: `${view.width}px`, height: `${view.height}px` });
  const origin = host.getBoundingClientRect();
  host.style.left = `${view.left - origin.left}px`;
  host.style.top = `${view.top - origin.top}px`;
}

// down/up 两端均在外侧才关闭，拖选、滚动、取消的手势不转换成关闭。
export function bindOutsideClose({ target, panel, close, canClose = () => true, nativeDialog = false }) {
  let gesture = null;
  const outside = event => {
    if (nativeDialog) {
      if (event.target !== panel) return false;
      const rect = panel.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.left + rect.width || event.clientY < rect.top || event.clientY > rect.top + rect.height;
    }
    const path = event.composedPath?.();
    const host = panel.getRootNode?.().host;
    const foreignWindow = path?.some(node => node?.nodeType === 11 && node.host !== host
      && panel.ownerDocument?.defaultView?.getComputedStyle?.(node.host)?.position === 'fixed');
    return !foreignWindow && !(path?.includes(panel) ?? panel.contains(event.target));
  };
  const down = event => {
    gesture = event.button === 0 && event.isPrimary !== false && outside(event) && canClose()
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, up: false, moved: false } : null;
  };
  const move = event => {
    if (gesture?.id === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) gesture.moved = true;
  };
  const up = event => {
    if (gesture?.id !== event.pointerId) { gesture = null; return; }
    move(event);
    gesture.up = outside(event);
  };
  const reset = () => { gesture = null; };
  const click = event => {
    const dismiss = gesture?.up && !gesture.moved && outside(event) && canClose();
    reset();
    if (dismiss) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      close();
    }
  };
  const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', reset], ['click', click]];
  for (const [type, listener] of listeners) target.addEventListener(type, listener, true);
  return () => { reset(); for (const [type, listener] of listeners) target.removeEventListener(type, listener, true); };
}

export function fitDesktopPanel(view, savedSize = null, savedPosition = null) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const maxWidth = Math.max(0, view.width - 20), maxHeight = Math.max(0, view.height - 20);
  const preferredWidth = Number(savedSize?.width) > 0 ? Number(savedSize.width) : 360;
  const preferredHeight = Number(savedSize?.height) > 0 ? Number(savedSize.height) : 600;
  const width = clamp(preferredWidth, Math.min(280, maxWidth), maxWidth);
  const height = clamp(preferredHeight, Math.min(300, maxHeight), maxHeight);
  const left = clamp(Number.isFinite(savedPosition?.left) ? savedPosition.left : view.left + view.width - width - 20, view.left + 10, view.left + view.width - width - 10);
  // Match QQJ's desktop default while keeping an explicitly saved position authoritative.
  const top = clamp(Number.isFinite(savedPosition?.top) ? savedPosition.top : view.top + 70, view.top + 10, view.top + view.height - height - 10);
  return { left, top, width, height };
}
