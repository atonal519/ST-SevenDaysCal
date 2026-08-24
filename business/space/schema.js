export const SPACE_HISTORY_CAP = 20;

export function normalizeSpaceHistory(saved) {
    return Array.isArray(saved) ? saved.filter(item => item?.role && item?.content) : [];
}

export function appendSpaceUser(history, content, cap = SPACE_HISTORY_CAP) {
    const next = [...history, { role: 'user', content }];
    const overflow = Math.max(0, next.length - cap);
    return Object.freeze({ history: overflow ? next.slice(overflow) : next, trimmed: overflow > 0 });
}

export function appendSpaceAssistant(history, content) {
    return [...history, { role: 'assistant', content }];
}

const SPACE_WIDGET_RX = /<(schedule_widget|line_widget|almanac_widget|era_widget)([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

export function extractWidgets(raw) {
    const widgets = [];
    const source = String(raw || '');
    const rx = new RegExp(SPACE_WIDGET_RX.source, SPACE_WIDGET_RX.flags);
    let match;
    while ((match = rx.exec(source)) !== null) {
        const edit = (match[2] || '').match(/\bedit\s*=\s*["']?\s*(\d+)/i);
        widgets.push(Object.freeze({
            kind: match[1].toLowerCase(),
            body: match[3].trim(),
            editIdx: edit ? parseInt(edit[1], 10) : null,
        }));
    }
    return Object.freeze({ text: source.replace(rx, '').trim(), widgets });
}

export function stripWidgetsForApi(history) {
    return history.map(message => {
        if (message.role !== 'assistant') return message;
        const cleaned = String(message.content || '')
            .replace(/<schedule_widget[^>]*>[\s\S]*?<\/schedule_widget\s*>/gi, '【已输出一张点卡片（内容以当前面板为准）】')
            .replace(/<line_widget[^>]*>[\s\S]*?<\/line_widget\s*>/gi, '【已输出一张线卡片（内容以当前面板为准）】')
            .replace(/<almanac_widget[^>]*>[\s\S]*?<\/almanac_widget\s*>/gi, '【已输出一张历卡片（内容以当前面板为准）】')
            .replace(/<era_widget[^>]*>[\s\S]*?<\/era_widget\s*>/gi, '【已输出一张历法卡片（内容以当前面板为准）】');
        return cleaned === message.content ? message : { ...message, content: cleaned };
    });
}

export function spaceMessagePlainText(message) {
    if (!message) return '';
    const raw = String(message.content ?? '');
    return message.role === 'assistant' ? extractWidgets(raw).text : raw;
}
