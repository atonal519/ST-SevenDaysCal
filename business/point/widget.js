// 间→点 widget 应用：按人物 scope 保持 canonical raw，并沿用 Future 追加/就地替换规则。
import { isCompletePointEvent } from './parse.js';

const normalizeOwner = owner => owner?.view === 'char' && String(owner.charName || '').trim()
    ? { view: 'char', charName: String(owner.charName).trim() }
    : owner?.view === 'user'
        ? { view: 'user', charName: '' }
        : null;

export function createPointWidgetActions(env) {
    const participantCurrent = participant => !participant || env.sameParticipantIdentity?.(participant, env.captureParticipantIdentity?.()) !== false;
    const sameBaseline = (saved, baseline) => !!baseline
        && env.pointRawToken?.(saved?.raw || '') === baseline.rawToken
        && (Number(saved?.ts) || null) === (Number(baseline.ts) || null);
    const ownerLabel = owner => owner.view === 'char' ? `${owner.charName}（TA）` : `${env.getUserName()}（我）`;

    return async function applyScheduleWidget(body, button, target = null) {
        const options = Number.isInteger(target) ? { editIndex: target, legacyPointOwner: true } : (target || {});
        const editIndex = Number.isInteger(options.editIndex) ? options.editIndex : null;
        const eventBlock = env.firstPointEventBlock(body);
        const event = eventBlock ? env.parsePointEventRecord(eventBlock) : null;
        if (!isCompletePointEvent(event)) {
            env.showToast('卡片格式不完整（Event 需要标题、描述、时间和地点），无法应用', null, true);
            return false;
        }

        const chatId = env.chatId?.();
        const participant = env.captureParticipantIdentity?.() || null;
        let owner = normalizeOwner(options.owner);
        if (editIndex == null || !owner) {
            owner = normalizeOwner(await env.selectOwner?.({ edit: editIndex != null, currentOwner: owner }));
            if (!owner) return false;
        }
        if ((env.chatId && env.chatId() !== chatId) || !participantCurrent(participant)) return false;

        const key = env.getCacheKey(owner.view, owner.charName);
        if (!key) {
            env.showToast('当前聊天没有可写入的点存档', null, true);
            return false;
        }
        const saved = env.readStore(key);
        let raw = saved?.raw || '';
        if (editIndex != null && Array.isArray(options.pointBaselines)) {
            const baseline = options.pointBaselines.find(item => item?.view === owner.view && (owner.view !== 'char' || item.charName === owner.charName));
            if (!sameBaseline(saved, baseline)) {
                env.showToast(`${ownerLabel(owner)}的点已变化，请在「间」重新生成修改卡`, null, true);
                return false;
            }
        }

        const cleanEvent = { ...event, pin: false, adult: false };
        const cleanEventBlock = `Event: ${cleanEvent.type || 'main'}|${cleanEvent.title || ''}|${cleanEvent.desc || ''}|${cleanEvent.time || ''}|${cleanEvent.location || ''}|${cleanEvent.npcAction || ''}`;
        if (editIndex != null) {
            const next = raw ? env.replaceNthEventLine(raw, editIndex - 1, cleanEventBlock) : null;
            if (next == null) {
                env.showToast(`找不到${ownerLabel(owner)}的第 ${editIndex} 条点，请重新生成修改卡`, null, true);
                return false;
            }
            raw = next;
        } else if (!raw) {
            raw = `<calendar_widget>\nFuture:\n${cleanEventBlock}\n</calendar_widget>`;
        } else {
            const match = raw.match(/<calendar_widget[^>]*>[\s\S]*?<\/calendar_widget>/i);
            if (match) {
                const inner = match[0].replace(/^<calendar_widget[^>]*>|<\/calendar_widget>$/gi, '');
                const nextInner = /^\s*Future\s*:/im.test(inner)
                    ? inner.replace(/(Future\s*:[^\n]*\n?)([\s\S]*)$/i, (_match, head, tail) => `${head}${tail}${tail.endsWith('\n') || !tail ? '' : '\n'}${cleanEventBlock}\n`)
                    : `${inner.replace(/\s+$/, '')}\nFuture:\n${cleanEventBlock}\n`;
                raw = raw.replace(match[0], `<calendar_widget>${nextInner}</calendar_widget>`);
            } else {
                raw = `<calendar_widget>\n${raw}\nFuture:\n${cleanEventBlock}\n</calendar_widget>`;
            }
        }

        if ((env.chatId && env.chatId() !== chatId) || !participantCurrent(participant)) return false;
        const subject = owner.view === 'char' ? owner.charName : env.getUserName();
        if (env.writeStore(key, { ...(saved || {}), raw, userName: subject, ts: Date.now() }) === false) {
            env.showToast('点保存失败，请重试', null, true);
            return false;
        }
        if (env.currentView() === owner.view && (owner.view !== 'char' || env.currentChar?.() === owner.charName)) {
            const html = env.renderSchedule(raw, subject, owner.view, env.loadCalendar());
            env.setCached(html);
            if (env.shouldShowPanel()) env.setBody(html);
        }
        if (owner.view === 'user') env.syncLatestScheduleBlock();
        button?.prop?.('disabled', true).html(`<i class="fa-solid fa-check"></i> ${editIndex != null ? `已改 ${ownerLabel(owner)} · 第 ${editIndex} 条` : `已加入 ${ownerLabel(owner)} · 未来`}`);
        env.showToast(editIndex != null
            ? `已替换${ownerLabel(owner)}的第 ${editIndex} 条点`
            : `已加到${ownerLabel(owner)}的点·未来列`);
        return true;
    };
}
