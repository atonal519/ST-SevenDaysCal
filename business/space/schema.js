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
    const allKinds = Array.isArray(context?.allowedWidgetKinds) && context.allowedWidgetKinds.length === SPACE_WIDGET_KINDS.length
        && SPACE_WIDGET_KINDS.every(kind => context.allowedWidgetKinds.includes(kind));
    const resolved = Array.isArray(context?.allowedWidgetKinds) || context?.expectedWidgetKind
        ? resolveSpaceWidgets(content, context, context?.widgetParsers) : null;
    const actualKinds = resolved && !resolved.ambiguous ? [...new Set(resolved.widgets.map(widget => widget.kind))] : [];
    const actualKind = !context?.expectedWidgetKind && actualKinds.length === 1 ? actualKinds[0] : null;
    const expectedWidgetKind = context?.expectedWidgetKind || actualKind;
    const allowedWidgetKinds = actualKind && allKinds ? [actualKind] : context?.allowedWidgetKinds;
    if (expectedWidgetKind === 'outline_widget' && (!resolved?.ambiguous || context?.expectedWidgetKind === 'outline_widget')) {
        const selected = resolved?.widgets.filter(widget => widget.kind === 'outline_widget') || [];
        const normalized = normalizeOutlineResponse(selected.length
            ? selected.map(widget => `<outline_widget>\n${widget.body}\n</outline_widget>`).join('\n') : content);
        if (normalized) savedContent = normalized;
    }
    const message = { role: 'assistant', content: savedContent, ...(context?.pageId ? { pageId: context.pageId } : {}) };
    if (Array.isArray(context?.pointBaselines)) message.pointBaselines = context.pointBaselines;
    if (Array.isArray(context?.lineBaselines)) message.lineBaselines = context.lineBaselines;
    // 预期卡型随 assistant 历史保存，刷新或重绘仍按原请求校验；旧历史缺字段时保持宽松兼容。
    if (SPACE_WIDGET_KINDS.includes(expectedWidgetKind)) {
        message.expectedWidgetKind = expectedWidgetKind;
    }
    if (Array.isArray(allowedWidgetKinds)) message.allowedWidgetKinds = [...new Set(allowedWidgetKinds.filter(kind => SPACE_WIDGET_KINDS.includes(kind)))];
    if (expectedWidgetKind === 'outline_widget' && typeof context.outlineRawToken === 'string') {
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

export const SPACE_WIDGET_KINDS = Object.freeze(['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget']);

function validSpaceWidget(widget, parsers = {}) {
    if (!widget?.body || !SPACE_WIDGET_KINDS.includes(widget.kind)) return false;
    if (widget.kind === 'schedule_widget') {
        const block = firstPointEventBlock(`<schedule_widget>${widget.body}</schedule_widget>`);
        return isCompletePointEvent(block ? parsePointEventRecord(block) : null);
    }
    if (widget.kind === 'line_widget') return !!parseLineCard(widget.body);
    if (widget.kind === 'almanac_widget') {
        try { return typeof parsers.parseAlmanac === 'function' && parsers.parseAlmanac(widget.body).length > 0; } catch { return false; }
    }
    if (widget.kind === 'era_widget') {
        try { return typeof parsers.parseEra === 'function' && !!parsers.parseEra(widget.body); } catch { return false; }
    }
    if (widget.kind === 'outline_widget') return !!normalizeOutlineResponse(widget.body);
    return false;
}

function expandSpaceWidget(widget) {
    if (widget?.kind !== 'schedule_widget') return [widget];
    const lines = String(widget.body || '').split(/\r?\n/);
    const starts = lines.map((line, index) => /^\s*Event\s*[:：]/i.test(line) ? index : -1).filter(index => index >= 0);
    if (starts.length <= 1) return [widget];
    return starts.map((start, offset) => ({ ...widget, body: lines.slice(start, starts[offset + 1] ?? lines.length).join('\n').trim(), editIdx: widget.editIdx }));
}

function bareSpaceWidgets(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const boundary = /^(?:Event|Line|Item|Month|Era|Style|Beat)\s*[:：]/i;
    const blocks = (rx, keepAll = false, stopRx = boundary) => {
        const starts = lines.map((line, index) => rx.test(line) ? index : -1).filter(index => index >= 0);
        if (!starts.length) return [];
        if (keepAll) {
            const start = starts[0];
            const end = lines.findIndex((line, index) => index > start && stopRx.test(line));
            return [lines.slice(start, end < 0 ? lines.length : end).join('\n')];
        }
        return starts.map(start => {
            const end = lines.findIndex((line, index) => index > start && boundary.test(line));
            return lines.slice(start, end < 0 ? lines.length : end).join('\n');
        });
    };
    return [
        ...blocks(/^Event\s*[:：]/i).map(body => ({ kind: 'schedule_widget', body, editIdx: null, owner: null })),
        ...blocks(/^Line\s*[:：]/i).map(body => ({ kind: 'line_widget', body, editIdx: null, owner: null })),
        ...blocks(/^Item\s*[:：]/i).map(body => ({ kind: 'almanac_widget', body, editIdx: null, owner: null })),
        ...blocks(/^(?:Era|Style|Month)\s*[:：]/i, true, /^(?:Event|Line|Item|Beat)\s*[:：]/i).map(body => ({ kind: 'era_widget', body, editIdx: null, owner: null })),
        ...blocks(/^Beat\s*[:：]/i, true, /^(?:Event|Line|Item|Month|Era|Style)\s*[:：]/i).map(body => ({ kind: 'outline_widget', body, editIdx: null, owner: null })),
    ];
}

// One parser contract for persistence, rendering and history lookup. `expected`
// is the legacy per-request selector; an all-five allow list lets the actual
// valid response choose its sole kind, while mixed valid kinds remain ambiguous.
export function resolveSpaceWidgets(raw, policy = {}, parsers = {}) {
    const extracted = extractWidgets(raw);
    const allowed = Array.isArray(policy.allowedWidgetKinds) ? policy.allowedWidgetKinds.filter(kind => SPACE_WIDGET_KINDS.includes(kind)) : null;
    const expected = SPACE_WIDGET_KINDS.includes(policy.expectedWidgetKind) ? policy.expectedWidgetKind : null;
    const eligible = widget => (!expected || widget.kind === expected) && (!allowed || allowed.includes(widget.kind));
    const wrappedValid = extracted.widgets.flatMap(expandSpaceWidget).filter(widget => eligible(widget) && validSpaceWidget(widget, parsers));
    let widgets = wrappedValid;
    if (!wrappedValid.length) widgets = bareSpaceWidgets(extracted.text).filter(widget => eligible(widget) && validSpaceWidget(widget, parsers));
    if (!widgets.length && (!expected || expected === 'outline_widget') && (!allowed || allowed.includes('outline_widget'))) {
        const normalized = normalizeOutlineResponse(extracted.text);
        if (normalized) widgets = [{ kind: 'outline_widget', body: normalized, editIdx: null, owner: null }];
    }
    if (expected) widgets = widgets.filter(widget => widget.kind === expected);
    else if (allowed) {
        widgets = widgets.filter(widget => allowed.includes(widget.kind));
        const kinds = [...new Set(widgets.map(widget => widget.kind))];
        if (allowed.length === SPACE_WIDGET_KINDS.length && kinds.length > 1) return Object.freeze({ widgets: Object.freeze([]), ambiguous: true });
    }
    return Object.freeze({ widgets: Object.freeze(widgets), ambiguous: false });
}

export function latestSpaceWidget(history, kind = null, parsers = {}) {
    if (!Array.isArray(history)) return null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role !== 'assistant') continue;
        if (message.portableReadonly === true) continue;
        const resolved = resolveSpaceWidgets(message.content, message, parsers);
        if (resolved.ambiguous) continue;
        const widgets = resolved.widgets;
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

export function stripWidgetsForApi(history, { preserveCandidates = false } = {}) {
    return history.map(message => {
        let cleaned = String(message.content || '');
        if (message.role === 'assistant') {
            if (preserveCandidates) {
                if (SPACE_WIDGET_KINDS.includes(message.expectedWidgetKind) || extractWidgets(cleaned).widgets.length || normalizeOutlineResponse(cleaned)) cleaned = `【历史卡片候选｜应用状态以当前正式资料为准】\n${cleaned}`;
            } else {
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
        }
        return { role: message.role, content: cleaned };
    });
}

export function spaceMessagePlainText(message) {
    if (!message) return '';
    const raw = String(message.content ?? '');
    return message.role === 'assistant' ? extractWidgets(raw).text : raw;
}
