import { normalizeOutlineResponse } from '../outline/schema.js';
import { parseLineCard } from '../lines/schema.js';
import { firstPointEventBlock, isCompletePointEvent, parsePointEventRecord } from '../point/parse.js';

export const spacePageId = message => message?.pageId === '2' ? '2' : '1';

export function normalizeSpaceHistory(saved) {
    const rows = Array.isArray(saved) ? saved : saved?.version === 1 ? saved.messages : [];
    return Array.isArray(rows) ? rows.filter(item => item?.role && item?.content) : [];
}

export function normalizeSpaceDocument(saved) {
    const messages = normalizeSpaceHistory(saved);
    const secondPage = saved?.version === 1 && saved.pages?.includes?.('2') || messages.some(message => spacePageId(message) === '2');
    return { version: 1, pages: secondPage ? ['1', '2'] : ['1'], messages };
}

export function appendSpaceUser(history, content, pageId = '1') {
    return Object.freeze({ history: [...history, { role: 'user', content, pageId }] });
}

export function appendSpaceAssistant(history, content, context = null) {
    let savedContent = content;
    if (context?.expectedWidgetKind === 'outline_widget' || context?.allowedWidgetKinds?.includes?.('outline_widget')) {
        const normalized = normalizeOutlineResponse(content);
        if (normalized) savedContent = normalized;
    }
    const message = { role: 'assistant', content: savedContent, ...(context?.pageId ? { pageId: context.pageId } : {}) };
    if (Array.isArray(context?.pointBaselines)) message.pointBaselines = context.pointBaselines;
    if (Array.isArray(context?.lineBaselines)) message.lineBaselines = context.lineBaselines;
    // 预期卡型随 assistant 历史保存，刷新或重绘仍按原请求校验；旧历史缺字段时保持宽松兼容。
    if (['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'].includes(context?.expectedWidgetKind)) {
        message.expectedWidgetKind = context.expectedWidgetKind;
    }
    if (Array.isArray(context?.allowedWidgetKinds)) message.allowedWidgetKinds = [...new Set(context.allowedWidgetKinds.filter(kind => ['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget'].includes(kind)))];
    if ((context?.expectedWidgetKind === 'outline_widget' || context?.allowedWidgetKinds?.includes?.('outline_widget')) && typeof context.outlineRawToken === 'string') {
        message.outlineRawToken = context.outlineRawToken;
    }
    return [...history, message];
}

const lineLocatorFields = line => ({
    name: String(line?.name || ''), stage: String(line?.stage || ''), when: String(line?.when || ''),
    agency: String(line?.agency || ''), stall: line?.stall === true,
    desc: String(line?.desc || ''), next: String(line?.next || ''), cue: String(line?.cue || ''),
});

export function compactLineBaselines(raw, parseLines) {
    const counts = new Map();
    return Object.freeze((parseLines?.(raw) || []).map(line => {
        const fields = lineLocatorFields(line);
        const signature = JSON.stringify(fields);
        const occurrence = counts.get(signature) || 0;
        counts.set(signature, occurrence + 1);
        return Object.freeze({ ...fields, occurrence });
    }));
}

const SPACE_WIDGET_RX = /<(schedule_widget|line_widget|almanac_widget|era_widget|outline_widget)([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

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

export function latestSpaceWidget(history, kind = null, parsers = {}) {
    if (!Array.isArray(history)) return null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role !== 'assistant') continue;
        if (message.portableReadonly === true) continue;
        let widgets = extractWidgets(message.content).widgets.filter(widget => widget.body);
        if (!widgets.length && (message.expectedWidgetKind === 'outline_widget' || message.allowedWidgetKinds?.includes?.('outline_widget'))) {
            const normalized = normalizeOutlineResponse(message.content);
            if (normalized) widgets = [Object.freeze({ kind: 'outline_widget', body: normalized, editIdx: null, owner: null })];
        }
        if (Array.isArray(message.allowedWidgetKinds)) widgets = widgets.filter(widget => message.allowedWidgetKinds.includes(widget.kind));
        if (message.expectedWidgetKind) widgets = widgets.filter(widget => widget.kind === message.expectedWidgetKind);
        widgets = widgets.filter(widget => {
            if (widget.kind === 'schedule_widget') {
                const block = firstPointEventBlock(`<schedule_widget>${widget.body}</schedule_widget>`);
                return isCompletePointEvent(block ? parsePointEventRecord(block) : null);
            }
            if (widget.kind === 'line_widget') return !!parseLineCard(widget.body);
            if (widget.kind === 'almanac_widget') return typeof parsers.parseAlmanac === 'function' && parsers.parseAlmanac(widget.body).length > 0;
            if (widget.kind === 'era_widget') return typeof parsers.parseEra === 'function' && !!parsers.parseEra(widget.body);
            if (widget.kind === 'outline_widget') return !!normalizeOutlineResponse(widget.body);
            return true;
        });
        if (!widgets.length) {
            if (kind) continue;
            return null;
        }
        const widget = kind ? widgets.filter(item => item.kind === kind).at(-1) : widgets.at(-1);
        if (!widget) {
            if (kind) continue;
            return null;
        }
        const snapshot = {
            kind: widget.kind,
            body: widget.body,
            editIdx: widget.editIdx,
            historyIndex: index,
        };
        if (widget.kind === 'line_widget') {
            const locator = Number.isInteger(widget.editIdx) ? message.lineBaselines?.[widget.editIdx - 1] : null;
            if (locator) snapshot.lineLocator = locator;
        }
        if (widget.kind === 'schedule_widget') {
            snapshot.owner = widget.owner;
            snapshot.pointBaselines = Array.isArray(message.pointBaselines) ? message.pointBaselines : null;
        }
        if (widget.kind === 'outline_widget') snapshot.outlineRawToken = message.outlineRawToken || null;
        return Object.freeze(snapshot);
    }
    return null;
}

export function stripWidgetsForApi(history) {
    return history.map(message => {
        let cleaned = String(message.content || '');
        if (message.role === 'assistant') {
            cleaned = cleaned
                .replace(/<schedule_widget[^>]*>[\s\S]*?<\/schedule_widget\s*>/gi, '【此前回复含点卡片候选（不代表已应用）】')
                .replace(/<line_widget[^>]*>[\s\S]*?<\/line_widget\s*>/gi, '【此前回复含线卡片候选（不代表已应用）】')
                .replace(/<almanac_widget[^>]*>[\s\S]*?<\/almanac_widget\s*>/gi, '【此前回复含轴日期候选（不代表已应用）】')
                .replace(/<era_widget[^>]*>[\s\S]*?<\/era_widget\s*>/gi, '【此前回复含完整历法候选（不代表已应用）】')
                .replace(/<outline_widget[^>]*>[\s\S]*?<\/outline_widget\s*>/gi, '【此前回复含面草稿候选（不代表已应用）】');
            if ((message.expectedWidgetKind === 'outline_widget' || message.allowedWidgetKinds?.includes?.('outline_widget')) && !/<outline_widget\b/i.test(String(message.content || ''))
                && normalizeOutlineResponse(message.content)) {
                cleaned = '【此前回复含面草稿候选（不代表已应用）】';
            }
        }
        const apiMessage = { ...message, content: cleaned };
        delete apiMessage.pageId;
        delete apiMessage.pointBaselines;
        delete apiMessage.lineBaselines;
        delete apiMessage.expectedWidgetKind;
        delete apiMessage.allowedWidgetKinds;
        delete apiMessage.outlineRawToken;
        delete apiMessage.portableReadonly;
        return apiMessage;
    });
}

export function spaceMessagePlainText(message) {
    if (!message) return '';
    const raw = String(message.content ?? '');
    return message.role === 'assistant' ? extractWidgets(raw).text : raw;
}
