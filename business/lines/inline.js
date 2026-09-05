import { parseLines, TERMINAL_LINE_STAGES } from './schema.js';

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

export function buildLineInjectText(line = {}) {
    const when = String(line.when ?? '').trim();
    const nextText = line.nextText || (line.next ? prefixNext(line.next, line.stall) : '');
    return [
        `【线参考】${line.name}（${line.stage}${line.stall ? '·停滞' : ''}）`,
        when ? `时间锚点：${when}` : '',
        line.desc,
        nextText,
    ].filter(Boolean).join('\n');
}

export function selectInlineLines(raw, { readOnly = false, max = Number.POSITIVE_INFINITY } = {}) {
    const parsed = parseLines(raw);
    // 展示层不截断已落库的线；旧数据或未来合同扩展都应完整呈现。
    const visible = parsed.slice(0, max);
    return visible.map((line, index) => ({ ...line, index, readOnly, nextText: line.next ? prefixNext(line.next, line.stall) : '' }));
}

export function buildInlineLineText(raw, { readOnly = false, max = Number.POSITIVE_INFINITY } = {}) {
    return selectInlineLines(raw, { readOnly, max }).filter(line => !TERMINAL_LINE_STAGES.has(line.stage)).map(buildLineInjectText).join('\n\n');
}

export function inlineState(raw, { readOnly = false, max = Number.POSITIVE_INFINITY } = {}) {
    const lines = selectInlineLines(raw, { readOnly, max });
    const activeCount = lines.filter(line => !TERMINAL_LINE_STAGES.has(line.stage)).length;
    const settledCount = lines.length - activeCount;
    return {
        lines,
        count: lines.length,
        activeCount,
        settledCount,
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
