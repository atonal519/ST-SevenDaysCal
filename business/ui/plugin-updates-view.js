export function createPluginUpdatesView({ updates, dialog, documentRef = globalThis.document, renderMarkdown, notifyUser = notification => globalThis.toastr?.[notification.kind]?.(notification.text) } = {}) {
  const element = (tag, className = '', text = '') => { const node = documentRef.createElement(tag); node.className = className; node.textContent = text; return node; };
  const controls = element('div', 'sp-update-controls');
  const status = element('button', 'sp-update-status'); status.type = 'button';
  controls.append(status);
  const feedback = element('p', 'sp-update-feedback'); feedback.setAttribute('role', 'status');
  const noticeButton = element('button', 'sp-update-notice-button', '查看公告'); noticeButton.type = 'button';
  controls.append(noticeButton);
  const sync = state => {
    status.textContent = ({ unchecked: '检查更新', checking: '检查中', available: '可更新', stable: '稳定版本', updating: '更新中', error: '检查失败' })[state.status];
    status.dataset.state = state.status; const busy = ['checking', 'updating'].includes(state.status); status.disabled = busy;
    feedback.textContent = state.error ?? ''; feedback.hidden = !state.error;
  };
  sync(updates.getState()); const unsubscribe = updates.subscribe(sync);
  const openNotice = async available => {
    const content = element('div', 'sp-update-notice', '正在读取更新公告…');
    const choice = dialog.custom({ title: available ? '构画更新公告' : '已安装版本公告', content, confirmText: available ? '更新' : '关闭', cancelText: available ? '暂不更新' : '', submit: () => true });
    void updates.readNotice(available ? 'available' : 'installed').then(notice => {
      if (notice.ok && typeof renderMarkdown === 'function') { content.innerHTML = renderMarkdown(notice.markdown); for (const link of content.querySelectorAll?.('a') ?? []) { link.target = '_blank'; link.rel = 'noopener noreferrer'; } }
      else content.textContent = notice.ok ? notice.markdown : notice.message;
    });
    if (await choice && available) {
      try { await updates.update(); notifyUser({ kind: 'success', text: '构画已更新，请刷新酒馆后使用' }); }
      catch (error) { notifyUser({ kind: 'error', text: error.message }); }
    }
  };
  status.addEventListener('click', () => updates.getState().status === 'available' ? openNotice(true) : updates.check());
  noticeButton.addEventListener('click', () => openNotice(false));
  return Object.freeze({ controls, feedback, noticeButton, dispose: unsubscribe });
}
