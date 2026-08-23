// 标签名规则：纯函数，不依赖酒馆运行时，供设置 UI 与运行时清洗共同使用。
export const TAG_NAME_RE = /^[\p{L}][\p{L}\p{N}_-]*~?$/u;
export function normalizeTagNames(csv) {
    return String(csv || '').split(',').map(value => String(value).trim().toLowerCase())
        .filter(value => TAG_NAME_RE.test(value) && !/~~|~.+/.test(value));
}
