import { parseLines } from './schema.js';

export function prefixNext(next, stall = false) {
    let clean = String(next || '').trim();
    let previous;
    do {
        previous = clean;
        clean = clean.replace(/^(\*\*|__|\*|_)\s*(下一步|恢复条件)\s*[:：]?\s*\1\s*[:：]?\s*/, '').trim();
        clean = clean.replace(/^\s*(下一步|恢复条件)\s*[:：]\s*/, '').trim();
    } while (clean !== previous);
    return `${stall ? '恢复条件：' : '下一步：'}${clean}`;
}

export function selectInlineLines(raw, { readOnly = false, max = 6 } = {}) {
    return parseLines(raw).slice(0, max).map((line, index) => ({ ...line, index, readOnly, nextText: line.next ? prefixNext(line.next, line.stall) : '' }));
}

export function buildInlineLineText(raw, { readOnly = false, max = 6 } = {}) {
    return selectInlineLines(raw, { readOnly, max }).map(line => [
        `【线参考】${line.name}（${line.type}·${line.stage}${line.stall ? '·停滞' : ''}）`,
        line.desc,
        line.nextText,
    ].filter(Boolean).join('\n')).join('\n\n');
}

export function inlineState(raw, { readOnly = false, max = 6 } = {}) {
    const lines = selectInlineLines(raw, { readOnly, max });
    return {
        lines,
        count: lines.length,
        empty: lines.length === 0,
        readOnly,
        hasActions: !readOnly && lines.length > 0,
        summaryActions: !readOnly && lines.length > 0 ? ['refresh', 'advance'] : [],
        lineActions: readOnly ? [] : ['inject', 'delete'],
        dashed: { enabled: !readOnly, host: 'lines-body' },
        injectText: buildInlineLineText(raw, { readOnly, max }),
        emptyState: lines.length === 0 ? { title: '暂无', hasBody: false } : null,
    };
}
