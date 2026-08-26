// 人工纯文本编辑共用规范：换行与连续空白只在保存值上折叠，不改变其他字段。
export function normalizeEditableText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function validatePointDescription(value) {
    return String(value ?? '').includes('|') ? '点描述不能包含半角竖线「|」' : '';
}
