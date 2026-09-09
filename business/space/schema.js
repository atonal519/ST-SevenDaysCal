export const SPACE_HISTORY_CAP = 20;

export function normalizeSpaceHistory(saved) {
    return Array.isArray(saved) ? saved.filter(item => item?.role && item?.content) : [];
}

export function appendSpaceUser(history, content, cap = SPACE_HISTORY_CAP) {
    const next = [...history, { role: 'user', content }];
    const overflow = Math.max(0, next.length - cap);
    return Object.freeze({ history: overflow ? next.slice(overflow) : next, trimmed: overflow > 0 });
}

export function appendSpaceAssistant(history, content, context = null) {
    const message = { role: 'assistant', content };
    if (Array.isArray(context?.pointBaselines)) message.pointBaselines = context.pointBaselines;
    return [...history, message];
}

const SPACE_WIDGET_RX = /<(schedule_widget|line_widget|almanac_widget|era_widget)([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

const decodeCodePoint = (match, code, radix) => {
    const value = parseInt(code, radix);
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
};

const decodeAttribute = value => String(value || '')
    .replace(/&#(\d+);/g, (match, code) => decodeCodePoint(match, code, 10))
    .replace(/&#x([\da-f]+);/gi, (match, code) => decodeCodePoint(match, code, 16))
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');

function widgetAttribute(raw, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(raw || '').match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, 'i'));
    return match ? decodeAttribute(match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

export function normalizeScheduleOwner(view, charName = '') {
    const scope = String(view || '').trim().toLowerCase();
    const name = String(charName || '').trim();
    if (scope === 'user' && !name) return Object.freeze({ view: 'user', charName: '' });
    if (scope === 'char' && name) return Object.freeze({ view: 'char', charName: name });
    return null;
}

export function pointRawToken(raw) {
    const source = String(raw || '');
    let first = 2166136261; let second = 2246822507;
    for (const ch of source) {
        const code = ch.codePointAt(0);
        first = Math.imul(first ^ code, 16777619);
        second = Math.imul(second ^ code, 3266489917);
    }
    return `${source.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

export function compactPointBaselines(scopes = []) {
    return Object.freeze((Array.isArray(scopes) ? scopes : []).filter(scope => String(scope?.raw || '').trim()).map(scope => Object.freeze({
        view: scope.view === 'char' ? 'char' : 'user',
        charName: scope.view === 'char' ? String(scope.charName || '').trim() : '',
        rawToken: pointRawToken(scope.raw),
        ts: Number(scope.ts) || null,
    })));
}

export function extractWidgets(raw) {
    const widgets = [];
    const source = String(raw || '');
    const rx = new RegExp(SPACE_WIDGET_RX.source, SPACE_WIDGET_RX.flags);
    let match;
    while ((match = rx.exec(source)) !== null) {
        const edit = (match[2] || '').match(/\bedit\s*=\s*["']?\s*(\d+)/i);
        const view = widgetAttribute(match[2], 'view');
        const charName = widgetAttribute(match[2], 'char');
        widgets.push(Object.freeze({
            kind: match[1].toLowerCase(),
            body: match[3].trim(),
            editIdx: edit ? parseInt(edit[1], 10) : null,
            owner: match[1].toLowerCase() === 'schedule_widget' ? normalizeScheduleOwner(view, charName) : null,
        }));
    }
    return Object.freeze({ text: source.replace(rx, '').trim(), widgets });
}

export function latestSpaceWidget(history) {
    if (!Array.isArray(history)) return null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role !== 'assistant') continue;
        const widgets = extractWidgets(message.content).widgets.filter(widget => widget.body);
        if (!widgets.length) return null;
        const widget = widgets.at(-1);
        const snapshot = {
            kind: widget.kind,
            body: widget.body,
            editIdx: widget.editIdx,
            historyIndex: index,
        };
        if (widget.kind === 'schedule_widget') {
            snapshot.owner = widget.owner;
            snapshot.pointBaselines = Array.isArray(message.pointBaselines) ? message.pointBaselines : null;
        }
        return Object.freeze(snapshot);
    }
    return null;
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
