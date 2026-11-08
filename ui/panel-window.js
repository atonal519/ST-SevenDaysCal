// 主窗口只使用聊天区域中当前可见的一部分，输入栏不属于可用区域。
export function readChatBounds(doc, win = doc.defaultView) {
  const visual = win.visualViewport;
  const view = { left: Number(visual?.offsetLeft) || 0, top: Number(visual?.offsetTop) || 0,
    width: Math.max(0, Number(visual?.width) || win.innerWidth), height: Math.max(0, Number(visual?.height) || win.innerHeight) };
  for (const id of ['chat', 'sheld']) {
    const rect = doc.getElementById(id)?.getBoundingClientRect();
    if (!(rect?.width > 0 && rect?.height > 0)) continue;
    const left = Math.max(view.left, rect.left), top = Math.max(view.top, rect.top);
    const right = Math.min(view.left + view.width, rect.left + rect.width);
    let bottom = Math.min(view.top + view.height, rect.top + rect.height);
    if (id === 'sheld') for (const inputId of ['form_sheld', 'send_form']) {
      const input = doc.getElementById(inputId)?.getBoundingClientRect();
      if (input?.height > 0 && input.top > top) bottom = Math.min(bottom, input.top);
    }
    if (right > left && bottom > top) return { left, top, width: right - left, height: bottom - top };
  }
  return view;
}

export function observeChatBounds(doc, refresh) {
  const Observer = doc.defaultView?.ResizeObserver;
  if (!Observer) return () => {};
  const observer = new Observer(refresh);
  for (const id of ['chat', 'sheld', 'form_sheld', 'send_form']) {
    const element = doc.getElementById(id);
    if (element) observer.observe(element);
  }
  return () => observer.disconnect();
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
    return !(event.composedPath?.().includes(panel) ?? panel.contains(event.target));
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
    if (dismiss) close();
  };
  const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', reset], ['click', click]];
  for (const [type, listener] of listeners) target.addEventListener(type, listener);
  return () => { reset(); for (const [type, listener] of listeners) target.removeEventListener(type, listener); };
}

export function fitDesktopPanel(view, savedSize = null, savedPosition = null) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const maxWidth = Math.max(0, view.width - 20), maxHeight = Math.max(0, view.height - 20);
  const preferredWidth = Number(savedSize?.width) > 0 ? Number(savedSize.width) : 360;
  const preferredHeight = Number(savedSize?.height) > 0 ? Number(savedSize.height) : Math.min(600, view.height * .85);
  const width = clamp(preferredWidth, Math.min(280, maxWidth), maxWidth);
  const height = clamp(preferredHeight, Math.min(300, maxHeight), maxHeight);
  const left = clamp(Number.isFinite(savedPosition?.left) ? savedPosition.left : view.left + view.width - width - 20, view.left + 10, view.left + view.width - width - 10);
  const top = clamp(Number.isFinite(savedPosition?.top) ? savedPosition.top : view.top + 80, view.top + 10, view.top + view.height - height - 10);
  return { left, top, width, height };
}
