import { parseLines, TERMINAL_LINE_STAGES } from './schema.js';
import { prefixNext } from './inline.js';

export const TERMINAL_STAGES = TERMINAL_LINE_STAGES;

export function createAdvanceStrategy({ mode = 'turns', interval = 1, dayAnchor = null, previousDay = null, counter = 0 } = {}) {
    if (mode === 'manual') return { shouldAdvance: false, counter };
    if (mode === 'days') {
        const nextDay = dayAnchor == null ? null : String(dayAnchor);
        if (nextDay == null || previousDay == null) return { shouldAdvance: false, counter, day: nextDay };
        return { shouldAdvance: nextDay !== String(previousDay), counter, day: nextDay };
    }
    const step = Number.isFinite(Number(interval)) && Number(interval) >= 1 ? Math.floor(Number(interval)) : 1;
    const nextCounter = Number(counter || 0) + 1;
    return { shouldAdvance: nextCounter >= step, counter: nextCounter >= step ? 0 : nextCounter };
}

export function chooseSwipeLayer({ pendingGeneration = false, swipeId = 0, stored = null, baseline = '' } = {}) {
    if (pendingGeneration) return { action: 'wait', swipeId: Number(swipeId) || 0 };
    const raw = stored?.swipes?.[String(Number(swipeId) || 0)];
    return raw == null ? { action: 'baseline', raw: baseline } : { action: 'restore', raw };
}

export function markEditedFloor({ messageId, signature } = {}) {
    const id = Number(messageId);
    return Number.isFinite(id) ? { messageId: id, signature: String(signature ?? '') } : null;
}

export function floorToFinalize({ chat = [], insertAt } = {}) {
    const upto = Number.isFinite(Number(insertAt)) ? Number(insertAt) : chat.length;
    for (let i = Math.min(upto, chat.length) - 1; i >= 0; i--) if (!chat[i]?.is_user) return i;
    return null;
}

export function activeLines(raw, { includeTerminal = false } = {}) {
    const lines = parseLines(raw);
    return lines.filter(line => line.name && (includeTerminal || !TERMINAL_STAGES.has(line.stage)));
}

export function buildLinesInjection(lines, { prefix = '【潜伏的伏笔·仅供你把握暗线走向，切勿直接引用或点破】' } = {}) {
    const items = (Array.isArray(lines) ? lines : []).map(line => {
        const when = String(line.when || '').trim();
        const parts = [`- ${line.name}（${line.stage}${when ? `·${when}` : ''}${line.stall ? '·停滞' : ''}）`];
        if (line.desc) parts.push(`  当前状态：${line.desc}`);
        if (line.next) parts.push(`  ${prefixNext(line.next, line.stall)}`);
        return parts.join('\n');
    });
    return [
        prefix,
        '下一步或恢复条件是待发生方向，只供推演，不得当作既成事实或提前兑现；玩家尚未作出的关键选择保持开放。',
        ...items,
    ].filter(Boolean).join('\n');
}
