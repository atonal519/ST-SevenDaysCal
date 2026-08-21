export function createLedgerActions(options = {}) {
    const refresh = flags => { if (flags?.inject) options.refreshInject?.(); if (flags?.inline) options.refreshInline?.(true); if (flags?.panel !== false) options.refreshPanel?.(); };
    const toggleLock = (id, flags = {}) => { const item = options.get?.(id); if (!item) return; if (item.锁 === '用户锁') { options.unlock?.(id); options.toast?.('已解锁 · AI 判定可再更新此条'); } else { options.lock?.(id); options.toast?.('已锁定 · AI 判定不再改动此条'); } refresh(flags); };
    const toggleMute = (id, flags = {}) => { const item = options.get?.(id); if (!item) return; if (item.静音 === true) { options.unmute?.(id); options.toast?.('已恢复埋入 · 重新参与注入'); } else { options.mute?.(id); options.toast?.('已暂停埋入 · 保留跟进、暂不注入主楼'); } refresh({ inject: true, ...flags }); };
    const close = async (id, flags = {}) => { const item = options.get?.(id); if (!item) return; const ok = await options.confirm?.({ title: '了结条目', body: `把「${item.事由}」移出活跃刻度？${flags.inline ? '可在刻度页归档里捞回。' : '可在归档里捞回。'}`, confirmText: '了结', cancelText: '取消' }); if (!ok) return; options.close?.(id); if (flags.inline) { options.refreshInject?.(); options.refreshInline?.(true); if (flags.panel !== false) options.refreshPanel?.(); } else refresh({ panel: true }); };
    const reopen = (id, flags = {}) => { if (!options.get?.(id)) return; options.reopen?.(id); if (!flags.silent) options.toast?.('已捞回 · 回到活跃、判定车重新跟进'); refresh(flags); };
    const remove = async (id, flags = {}) => { const item = options.get?.(id); if (!item) return; const ok = await options.confirm?.({ title: '彻底删除', body: `「${item.事由}」将被永久删除，无法恢复。确定？`, confirmText: '删除', cancelText: '取消' }); if (!ok) return; options.remove?.(id); refresh(flags); };
    return { toggleLock, toggleMute, close, reopen, remove };
}
