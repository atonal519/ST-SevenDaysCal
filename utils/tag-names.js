// 标签名规则：纯函数，不依赖酒馆运行时，供设置 UI 与运行时清洗共同使用。
// 首字符必须是 Unicode 字母；后续主体可含字母、组合附加符号、数字、下划线、连字符。
// 可有一个「~」分隔符，允许位于末尾；非空后缀须先有字母/数字/下划线，
// 随后可含组合附加符号，且继续按保守合同拒绝后缀连字符。
export const TAG_NAME_SOURCE = String.raw`[\p{L}][\p{L}\p{M}\p{N}_-]*(?:~(?:[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*)?)?`;
export const TAG_NAME_RE = new RegExp(`^${TAG_NAME_SOURCE}$`, 'u');
export const LITERAL_DOUBLE_BRACKET_RULE = '[[...]]';
const PAIRED_BRACKET_RULE_RE = new RegExp(`^\\[(${TAG_NAME_SOURCE})\\]\\.\\.\\.\\[\\/\\1\\]$`, 'iu');

function unwrapTagName(value) {
    const trimmed = String(value).trim();
    const bracketed = /^<\s*([^<>]+?)\s*>$/u.exec(trimmed);
    return (bracketed ? bracketed[1] : trimmed).trim();
}

export function normalizeTagNames(csv) {
    return String(csv || '').split(',')
        .map(value => unwrapTagName(value).toLowerCase())
        .filter(value => TAG_NAME_RE.test(value));
}

// 包裹符设置沿用标签名的保守合同，只额外接受两种明确的成对占位语法。
// 方括号名与双中括号中的三个点都是配置占位，不代表正文必须写三个点。
export function normalizeTagRules(csv) {
    return String(csv || '').split(',')
        .map(value => String(value).trim())
        .map(value => {
            if (value === LITERAL_DOUBLE_BRACKET_RULE) return value;
            const paired = PAIRED_BRACKET_RULE_RE.exec(value);
            if (paired) return `[${paired[1].toLowerCase()}]...[/${paired[1].toLowerCase()}]`;
            return unwrapTagName(value).toLowerCase();
        })
        .filter(value => value === LITERAL_DOUBLE_BRACKET_RULE || PAIRED_BRACKET_RULE_RE.test(value) || TAG_NAME_RE.test(value));
}
