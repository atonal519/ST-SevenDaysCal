const TAG_TOKEN = /<\s*(\/?)\s*([\p{L}_][\p{L}\p{N}_.:-]*)(?:\s+(?:"[^"]*"|'[^']*'|[^"'<>])*)?\s*(\/?)>/gu;

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Normalize only complete, same-name wrappers for fields explicitly owned by the caller.
export function normalizeKnownFieldWrappers(value, { colonFields = [], bareFields = [] } = {}) {
    const source = String(value ?? '');
    if (!source) return source;
    const names = new Map([...colonFields, ...bareFields].map(name => [String(name).toLowerCase(), String(name)]));
    const colonNames = new Set(colonFields.map(name => String(name).toLowerCase()));
    const bareNames = new Set(bareFields.map(name => String(name).toLowerCase()));
    if (!names.size) return source;

    const normalizeLine = line => {
        const colon = /^[\t ]*<\s*([^<>:\s：]+)\s*[:：]([\s\S]*)$/.exec(line);
        const bare = colon ? null : /^[\t ]*<\s*([^<>:\s：]+)\s*>([\s\S]*)$/.exec(line);
        const match = colon || bare;
        if (!match) return line;
        const lowerName = match[1].toLowerCase();
        const fieldName = names.get(lowerName);
        if (!fieldName || (colon && !colonNames.has(lowerName)) || (bare && !bareNames.has(lowerName))) return line;
        const closer = new RegExp(`<\\s*\\/\\s*${escapeRegex(match[1])}\\s*>[\\t ]*$`, 'i').exec(match[2]);
        if (!closer) return line;
        const rawValue = match[2].slice(0, closer.index);
        if (new RegExp(`<\\s*\\/\\s*${escapeRegex(match[1])}\\s*>`, 'i').test(rawValue)) return line;
        const fieldValue = rawValue.replace(/^[\t ]*/, '');
        return `${line.match(/^[\t ]*/)[0]}${fieldName}: ${fieldValue}`;
    };

    return source.split(/(\r?\n)/).map((part, index) => index % 2 ? part : normalizeLine(part)).join('');
}

function tagTokens(source) {
    const tokens = [];
    for (const match of source.matchAll(TAG_TOKEN)) {
        tokens.push({
            start: match.index,
            end: match.index + match[0].length,
            name: match[2].toLowerCase(),
            closing: Boolean(match[1]),
            selfClosing: Boolean(match[3]),
            pair: null,
        });
    }
    const openByName = new Map();
    for (const token of tokens) {
        if (!token.closing && !token.selfClosing) {
            const stack = openByName.get(token.name) || [];
            stack.push(token);
            openByName.set(token.name, stack);
            continue;
        }
        if (!token.closing) continue;
        const opener = openByName.get(token.name)?.pop();
        if (opener) { opener.pair = token; token.pair = opener; }
    }
    return tokens;
}

function sourceLines(source) {
    const lines = [];
    let start = 0;
    while (start <= source.length) {
        const newline = source.indexOf('\n', start);
        const end = newline < 0 ? source.length : newline;
        lines.push({ start, end, text: source.slice(start, end).replace(/\r$/, '') });
        if (newline < 0) break;
        start = newline + 1;
    }
    return lines;
}

function analysisView(source) {
    return source.replace(TAG_TOKEN, token => token.replace(/[\r\n]/g, ' '));
}

function tagRuns(line, tokens) {
    const inLine = tokens.filter(token => token.start >= line.start && token.end <= line.end);
    const runs = [];
    for (let index = 0; index < inLine.length;) {
        const run = [inLine[index++]];
        while (index < inLine.length && /^\s*$/.test(sourceSlice(line, run.at(-1).end, inLine[index].start))) run.push(inLine[index++]);
        runs.push(run);
    }
    return runs;
}

function sourceSlice(line, start, end) {
    return line.text.slice(start - line.start, end - line.start);
}

// 只裁业务记录边界上的标签壳。包装名来自输入本身；业务模块只提供自己的字段/记录锚判断。
export function stripRecordWrappers(value, classifyBusinessAnchor, isCompleteStructure = kinds => kinds.includes('record')) {
    const source = String(value ?? '');
    if (!source || typeof classifyBusinessAnchor !== 'function') return source;
    const analysis = analysisView(source);
    const tokens = tagTokens(analysis);
    if (!tokens.length) return source;
    const lines = sourceLines(analysis);
    const runsByLine = lines.map(line => tagRuns(line, tokens));
    const removed = new Set();
    const breaks = new Set();
    const anchorKind = text => classifyBusinessAnchor(String(text || '')) || null;
    const anchorCandidates = [];
    for (const [lineIndex, line] of lines.entries()) {
        const direct = anchorKind(line.text);
        if (direct) anchorCandidates.push({ position: line.start, kind: direct, lineIndex });
        for (const run of runsByLine[lineIndex]) {
            const kind = anchorKind(sourceSlice(line, run.at(-1).end, line.end));
            if (kind) anchorCandidates.push({ position: run.at(-1).end, kind, lineIndex });
        }
    }
    const lineHasAnchor = (line, runs) => {
        if (anchorKind(line.text)) return true;
        return runs.some(run => {
            const before = sourceSlice(line, line.start, run[0].start);
            const after = sourceSlice(line, run.at(-1).end, line.end);
            return /^[\s|｜>#*\-]*$/.test(before) && Boolean(anchorKind(after));
        });
    };
    const tagOnly = (line, runs) => {
        const inLine = runs.flat();
        if (!inLine.length) return false;
        let cursor = line.start;
        for (const token of inLine) {
            if (!/^\s*$/.test(sourceSlice(line, cursor, token.start))) return false;
            cursor = token.end;
        }
        return /^\s*$/.test(sourceSlice(line, cursor, line.end));
    };
    const nextSemanticLine = index => {
        for (let cursor = index + 1; cursor < lines.length; cursor++) {
            if (!lines[cursor].text.trim() || tagOnly(lines[cursor], runsByLine[cursor])) continue;
            return cursor;
        }
        return -1;
    };
    const completeWrapper = token => {
        if (!token.pair) return true;
        const kinds = anchorCandidates
            .filter(candidate => candidate.position >= token.end && candidate.position < token.pair.start)
            .map(candidate => candidate.kind);
        return Boolean(isCompleteStructure(kinds));
    };
    const markLeadingRun = run => {
        for (const token of run) {
            if ((!token.closing && !token.selfClosing && completeWrapper(token)) || (token.closing && !token.pair)) removed.add(token);
        }
    };
    const hasStructuralCloser = run => run.some(token => token.closing && (!token.pair || removed.has(token.pair)));
    const markTrailingRun = run => {
        const boundary = hasStructuralCloser(run);
        for (const token of run) {
            if ((token.closing && !token.pair) || (boundary && !token.closing && !token.selfClosing)) removed.add(token);
        }
    };

    for (const [lineIndex, line] of lines.entries()) {
        const runs = runsByLine[lineIndex];
        for (const run of runs) {
            const before = sourceSlice(line, line.start, run[0].start);
            const after = sourceSlice(line, run.at(-1).end, line.end);
            if (!anchorKind(after)) continue;
            const cleanPrefix = /^[\s|｜>#*\-]*$/.test(before);
            if (!cleanPrefix && !hasStructuralCloser(run)) continue;
            markLeadingRun(run);
            if (!cleanPrefix) breaks.add(run.at(-1).end);
        }

        const next = nextSemanticLine(lineIndex);
        const followedByAnchor = next < 0 || lineHasAnchor(lines[next], runsByLine[next]);
        if (!followedByAnchor) continue;
        if (tagOnly(line, runs)) {
            for (const run of runs) markLeadingRun(run);
            continue;
        }
        const trailing = runs.findLast(run => /^\s*$/.test(sourceSlice(line, run.at(-1).end, line.end)));
        if (trailing) markTrailingRun(trailing);
    }

    for (const token of [...removed]) {
        if (!token.closing && token.pair) removed.add(token.pair);
    }
    if (!removed.size && !breaks.size) return source;
    let output = '';
    let cursor = 0;
    for (const token of tokens) {
        output += source.slice(cursor, token.start);
        if (!removed.has(token)) output += source.slice(token.start, token.end);
        cursor = token.end;
        if (breaks.has(cursor)) output += '\n';
    }
    return output + source.slice(cursor);
}
