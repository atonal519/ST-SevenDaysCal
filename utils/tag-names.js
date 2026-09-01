// 标签名规则：纯函数，不依赖酒馆运行时，供设置 UI 与运行时清洗共同使用。
// 允许单个「~」作为分隔符（konatan_planning~、konatan_planning~now 皆可），
// 拒绝「~~」、多个「~」及以「~」开头。条目标注可带或省略首尾 <>（自动剥除）。
export const TAG_NAME_RE = /^[\p{L}][\p{L}\p{N}_-]*(?:~[\p{L}\p{N}_]*)?$/u;
export function normalizeTagNames(csv) {
    return String(csv || '').split(',').map(value => String(value).trim().replace(/^\s*<\s*|\s*>\s*$/g, '').toLowerCase())
        .filter(value => TAG_NAME_RE.test(value));
}
