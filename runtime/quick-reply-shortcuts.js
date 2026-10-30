export const QUICK_REPLY_SHORTCUT_SET = '构画快捷入口';
export const QUICK_REPLY_SHORTCUT_COMMAND = 'gouhua-open';

export const QUICK_REPLY_SHORTCUTS = Object.freeze([
    { key: 'point', label: '点', view: 'schedule' },
    { key: 'axis-upcoming', label: '轴 · 即将到来', view: 'almanac', sheet: 'upcoming' },
    { key: 'axis-calendar', label: '轴 · 日历', view: 'almanac', sheet: 'calendar' },
    { key: 'axis-ticks', label: '轴 · 刻度', view: 'almanac', sheet: 'ledger' },
    { key: 'lines-events', label: '线 · 平行事件', view: 'lines', sheet: 'events' },
    { key: 'lines-dashed', label: '线 · 冷知识', view: 'lines', sheet: 'dashed' },
    { key: 'outline', label: '面', view: 'outline' },
    { key: 'space', label: '间', view: 'space' },
    { key: 'theater', label: '棱', view: 'theater' },
    { key: 'coordinate', label: '坐标', view: 'anchor' },
    { key: 'settings', label: '设置', mode: 'settings' },
    { key: 'memory', label: '记忆', mode: 'memory' },
    { key: 'daily-menu', label: '吃啥', mode: 'daily-menu' },
    { key: 'wardrobe', label: '穿啥', mode: 'wardrobe' },
]);

const byKey = new Map(QUICK_REPLY_SHORTCUTS.map(shortcut => [shortcut.key, shortcut]));

export function quickReplyShortcutMessage(key) {
    if (!byKey.has(key)) return '';
    return `/${QUICK_REPLY_SHORTCUT_COMMAND} ${key}`;
}

export function registerQuickReplyShortcutCommand({ parser, commandClass, open, notify }) {
    if (Object.hasOwn(parser.commands ?? {}, QUICK_REPLY_SHORTCUT_COMMAND)) {
        notify('构画快捷命令已被占用，快捷按钮无法执行', true);
        return false;
    }
    parser.addCommandObject(commandClass.fromProps({
        name: QUICK_REPLY_SHORTCUT_COMMAND,
        helpString: '打开构画的一个界面入口。',
        splitUnnamedArgument: true,
        splitUnnamedArgumentCount: 1,
        callback: async (_named, unnamed) => {
            const raw = Array.isArray(unnamed) ? unnamed[0] : unnamed;
            const key = String(raw ?? '').trim().split(/\s+/, 1)[0];
            if (!byKey.has(key)) {
                notify('未知的构画快捷入口', true);
                return '';
            }
            try {
                await open(key);
                return '';
            } catch (error) {
                notify('构画快捷入口打开失败，请检查对应页面后重试。', true);
                return '';
            }
        },
    }));
    return true;
}

export function createQuickReplyShortcutSync({ getApi, notify = () => {} }) {
    let pending = Promise.resolve();

    async function reconcile(keys) {
        const selected = [...new Set((Array.isArray(keys) ? keys : []).filter(key => byKey.has(key)))];
        if (!selected.length && !getApi?.()) return;

        const api = getApi?.();
        if (!api) {
            if (selected.length) notify('快捷入口未同步：Quick Replies 尚未加载', true);
            return;
        }
        let set = api.getSetByName(QUICK_REPLY_SHORTCUT_SET);
        if (!set && !selected.length) return;
        const createdHere = !set;
        if (!set) set = await api.createSet(QUICK_REPLY_SHORTCUT_SET);

        const expected = new Map(QUICK_REPLY_SHORTCUTS.map(item => [item.label, quickReplyShortcutMessage(item.key)]));
        const existingOwned = new Set();
        const oldMenu = (set.qrList ?? []).filter(qr => qr.label === '今日菜单' && qr.message === quickReplyShortcutMessage('daily-menu') && !qr.automationId);
        if (oldMenu.length) existingOwned.add('今日菜单');
        for (const qr of set.qrList ?? []) {
            const message = expected.get(qr.label);
            if (message !== undefined && qr.message === message && !qr.automationId) {
                existingOwned.add(qr.label);
            }
            if (expected.has(qr.label) && !(message === qr.message && !qr.automationId)) {
                notify('快捷入口同步暂停：同名 Quick Reply 组含有未识别按钮，请先改组名', true);
                return;
            }
        }

        const active = api.settings?.config?.hasSet?.(set) === true;
        if (!selected.length && !existingOwned.size) return;
        if (!existingOwned.size && (set.qrList?.length ?? 0) > 0) {
            notify('快捷入口同步暂停：同名 Quick Reply 组含有未识别按钮，请先改组名', true);
            return;
        }
        if (!existingOwned.size && !createdHere) {
            notify('快捷入口同步暂停：同名 Quick Reply 组无法确认归属，请先改组名', true);
            return;
        }

        // 只迁移旧菜单的确切自有入口；原生更新保留ID及用户改过的按钮设置。
        if (oldMenu.length) {
            if (oldMenu.some(qr => !Number.isInteger(qr.id)) && (set.qrList ?? []).filter(qr => qr.label === '今日菜单').length > 1) {
                notify('快捷入口同步暂停：旧菜单按钮无法唯一确认，请先整理同名按钮', true);
                return;
            }
            const menuLabel = byKey.get('daily-menu').label;
            let duplicateStart = 0;
            if (!existingOwned.has(menuLabel)) {
                const qr = oldMenu[0];
                api.updateQuickReply(QUICK_REPLY_SHORTCUT_SET, Number.isInteger(qr.id) ? qr.id : qr.label, {
                    newLabel: menuLabel,
                    ...(qr.title === '打开构画「今日菜单」' ? { title: `打开构画「${menuLabel}」` } : {}),
                });
                existingOwned.add(menuLabel);
                duplicateStart = 1;
            }
            for (const qr of oldMenu.slice(duplicateStart)) api.deleteQuickReply(QUICK_REPLY_SHORTCUT_SET, Number.isInteger(qr.id) ? qr.id : qr.label);
            existingOwned.delete('今日菜单');
        }

        for (const item of QUICK_REPLY_SHORTCUTS) {
            const present = existingOwned.has(item.label);
            const wanted = selected.includes(item.key);
            if (wanted && !present) {
                api.createQuickReply(QUICK_REPLY_SHORTCUT_SET, item.label, {
                    message: quickReplyShortcutMessage(item.key),
                    title: `打开构画「${item.label}」`,
                    showLabel: true,
                    executeOnStartup: false,
                    executeOnUser: false,
                    executeOnAi: false,
                    executeOnChatChange: false,
                    executeOnGroupMemberDraft: false,
                    executeOnNewChat: false,
                    executeBeforeGeneration: false,
                    automationId: '',
                });
            } else if (!wanted && present) {
                api.deleteQuickReply(QUICK_REPLY_SHORTCUT_SET, item.label);
            }
        }

        const remaining = (set.qrList ?? []).filter(qr => !expected.has(qr.label) || selected.includes(QUICK_REPLY_SHORTCUTS.find(item => item.label === qr.label)?.key));
        if (selected.length && !active) api.addGlobalSet(QUICK_REPLY_SHORTCUT_SET, true);
        if (!selected.length && active && remaining.length === 0) api.removeGlobalSet(QUICK_REPLY_SHORTCUT_SET);
        // An empty generated group is deleted so a later same-name user group cannot be mistaken for ours.
        if (!selected.length && remaining.length === 0) {
            // Flush QuickReplySet's debounced final removal before deleting its set record.
            await set.save?.();
            await api.deleteSet(QUICK_REPLY_SHORTCUT_SET);
        }
    }

    return keys => {
        const task = pending.then(() => reconcile(keys));
        pending = task.catch(() => notify('快捷入口同步失败，请检查 Quick Replies 后重试。', true));
        return pending;
    };
}
