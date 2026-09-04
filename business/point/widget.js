// 间→点 widget 应用：保持 canonical schedule raw 与 Future 追加/就地替换规则。
import { isCompletePointEvent } from './parse.js';

export function createPointWidgetActions(env) {
    return function applyScheduleWidget(body, button, editIndex = null) {
        const eventBlock = env.firstPointEventBlock(body); const event = eventBlock ? env.parsePointEventRecord(eventBlock) : null;
        if (!isCompletePointEvent(event)) { env.showToast('卡片格式不完整（Event 需要标题、描述、时间和地点），无法应用', null, true); return; }
        const key = env.getCacheKey('user', ''); if (!key) { env.showToast('当前 chat 没有可写入的待办缓存', null, true); return; }
        const saved = env.readStore(key); let raw = saved?.raw || '';
        const cleanEvent = { ...event, pin: false, adult: false };
        const cleanEventBlock = `Event: ${cleanEvent.type || 'main'}|${cleanEvent.title || ''}|${cleanEvent.desc || ''}|${cleanEvent.time || ''}|${cleanEvent.location || ''}|${cleanEvent.npcAction || ''}`;
        if (editIndex != null) {
            const next = raw ? env.replaceNthEventLine(raw, editIndex - 1, cleanEventBlock) : null;
            if (next == null) { env.showToast(`找不到第 ${editIndex} 条点，请刷新面板后重试`, null, true); return; } raw = next;
        } else if (!raw) raw = `<calendar_widget>\nFuture:\n${cleanEventBlock}\n</calendar_widget>`;
        else {
            const match = raw.match(/<calendar_widget[^>]*>[\s\S]*?<\/calendar_widget>/i);
            if (match) {
                const inner = match[0].replace(/^<calendar_widget[^>]*>|<\/calendar_widget>$/gi, '');
                const nextInner = /^\s*Future\s*:/im.test(inner) ? inner.replace(/(Future\s*:[^\n]*\n?)([\s\S]*)$/i, (_m, head, tail) => `${head}${tail}${tail.endsWith('\n') || !tail ? '' : '\n'}${cleanEventBlock}\n`) : `${inner.replace(/\s+$/, '')}\nFuture:\n${cleanEventBlock}\n`;
                raw = raw.replace(match[0], `<calendar_widget>${nextInner}</calendar_widget>`);
        } else raw = `<calendar_widget>\n${raw}\nFuture:\n${cleanEventBlock}\n</calendar_widget>`;
        }
        const subject = env.getUserName(); env.writeStore(key, { raw, userName: subject, ts: Date.now() });
        if (env.currentView() === 'user') { const html = env.renderSchedule(raw, subject, 'user', env.loadCalendar()); env.setCached(html); if (env.shouldShowPanel()) env.setBody(html); }
        env.syncLatestScheduleBlock(); button?.prop?.('disabled', true).html(`<i class="fa-solid fa-check"></i> ${editIndex != null ? `已改第 ${editIndex} 条` : '已加到点·未来列'}`);
        env.showToast(editIndex != null ? `已替换点·第 ${editIndex} 条` : '已加到点：请去"未来"列查看');
    };
}
