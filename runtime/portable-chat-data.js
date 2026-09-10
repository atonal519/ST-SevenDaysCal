export const PORTABLE_CHAT_FORMAT = 'st-sevendayscal-portable';
export const PORTABLE_CHAT_VERSION = 1;
export const PORTABLE_CHAT_MAX_BYTES = 8 * 1024 * 1024;

export const PORTABLE_MODULES = Object.freeze([
    Object.freeze({ id: 'points', label: '点（全部人物、固定/最近人物）' }),
    Object.freeze({ id: 'lines', label: '线（含虚线）' }),
    Object.freeze({ id: 'outline', label: '面（含面讨论）' }),
    Object.freeze({ id: 'space', label: '间' }),
    Object.freeze({ id: 'calendar', label: '日历／历法' }),
    Object.freeze({ id: 'theater', label: '已保存小剧场' }),
]);

const MODULE_IDS = new Set(PORTABLE_MODULES.map(item => item.id));
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const SPACE_WIDGET_RX = /<(?:schedule_widget|line_widget|almanac_widget|era_widget)\b[\s\S]*?<\/(?:schedule_widget|line_widget|almanac_widget|era_widget)\s*>/i;
const PERSISTENT_ROOT_KEYS = Object.freeze(['sp-store', 'sp-memory', 'sp-theater', 'sp-ledger']);

const KEY_MATCHERS = Object.freeze({
    points: key => key === 'schedule-user' || key.startsWith('schedule-char-') || key === 'charnames-recent' || key === 'char-pins',
    lines: key => key === 'lines-user' || key === 'dashed-user',
    outline: key => key === 'outline-user' || key.startsWith('outline-char-') || key === 'creative-chat-user' || key.startsWith('creative-chat-char-'),
    space: key => key === 'space-chat-user',
    calendar: key => ['almanac-user', 'caldesc-user', 'caldesc-fallback-user', 'date-anchor-user'].includes(key),
});
const ARRAY_ENTRY_KEYS = Object.freeze({
    points: key => key === 'charnames-recent' || key === 'char-pins',
    outline: key => key === 'creative-chat-user' || key.startsWith('creative-chat-char-'),
    space: key => key === 'space-chat-user',
});

function fail(reason, message) {
    return { ok: false, reason, message };
}

function exactKeys(value, expected) {
    return isObject(value) && Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isDefaultPersistentRoot(key, value) {
    if (value === undefined) return true;
    if (key === 'sp-store') {
        return exactKeys(value, ['version', 'data']) && value.version === 1 && isObject(value.data) && Object.keys(value.data).length === 0;
    }
    if (key === 'sp-memory') {
        const system = value?.system;
        return exactKeys(value, ['version', 'L0', 'L1', 'failed', 'system'])
            && value.version === 3
            && isObject(value.L0) && Object.keys(value.L0).length === 0
            && Array.isArray(value.L1) && value.L1.length === 0
            && isObject(value.failed) && Object.keys(value.failed).length === 0
            && exactKeys(system, ['paused', 'consecutiveFails', 'lastError'])
            && system.paused === false && system.consecutiveFails === 0 && system.lastError === null;
    }
    if (key === 'sp-theater') {
        return exactKeys(value, ['version', 'saved']) && value.version === 1 && Array.isArray(value.saved) && value.saved.length === 0;
    }
    if (key === 'sp-ledger') {
        return exactKeys(value, ['version', 'entries', 'seq']) && value.version === 1 && Array.isArray(value.entries) && value.entries.length === 0 && value.seq === 0;
    }
    return false;
}

export function persistentChatRootsAreBlank(roots = {}) {
    if (!isObject(roots)) return false;
    return PERSISTENT_ROOT_KEYS.every(key => isDefaultPersistentRoot(key, roots[key]));
}

function moduleHasContent(id, value) {
    if (id === 'theater') return Array.isArray(value?.saved) && value.saved.length > 0;
    const entries = value?.entries;
    if (!isObject(entries) || !Object.keys(entries).length) return false;
    if (id === 'space') return Array.isArray(entries['space-chat-user']) && entries['space-chat-user'].length > 0;
    return Object.values(entries).some(item => {
        if (Array.isArray(item)) return item.length > 0;
        if (isObject(item)) {
            if (typeof item.raw === 'string') return item.raw.trim().length > 0;
            if (Array.isArray(item.items)) return item.items.length > 0;
            return Object.keys(item).length > 0;
        }
        return item != null && String(item).length > 0;
    });
}

function moduleFromRoots(id, roots = {}) {
    if (id === 'theater') {
        const root = isObject(roots['sp-theater']) ? roots['sp-theater'] : null;
        return { saved: Array.isArray(root?.saved) ? clone(root.saved) : [] };
    }
    const data = isObject(roots['sp-store']?.data) ? roots['sp-store'].data : {};
    const entries = {};
    for (const [key, value] of Object.entries(data)) if (KEY_MATCHERS[id]?.(key)) entries[key] = clone(value);
    return { entries };
}

export function buildPortableChatPackage({ selectedModules, roots, exportedAt = new Date().toISOString() } = {}) {
    const selected = [...new Set((Array.isArray(selectedModules) ? selectedModules : []).map(String))];
    if (!selected.length) return fail('empty-selection', '请至少选择一个要导出的模块');
    if (selected.some(id => !MODULE_IDS.has(id))) return fail('unknown-module', '导出选择包含不支持的模块');
    const modules = {};
    const emptyModules = [];
    for (const id of selected) {
        const value = moduleFromRoots(id, roots);
        if (moduleHasContent(id, value)) modules[id] = value;
        else emptyModules.push(id);
    }
    const included = Object.keys(modules);
    if (!included.length) return { ...fail('no-content', '所选模块在当前聊天中都没有可导出的内容'), emptyModules };
    return {
        ok: true,
        emptyModules,
        package: {
            format: PORTABLE_CHAT_FORMAT,
            version: PORTABLE_CHAT_VERSION,
            exportedAt: String(exportedAt),
            selectedModules: included,
            modules,
        },
    };
}

function validateModule(id, value) {
    if (!isObject(value)) return fail('invalid-module', `模块 ${id} 的结构不正确`);
    if (id === 'theater') {
        if (!Array.isArray(value.saved)) return fail('invalid-theater', '已保存小剧场不是列表');
        return { ok: true, value: { saved: clone(value.saved) } };
    }
    if (!isObject(value.entries)) return fail('invalid-entries', `模块 ${id} 缺少数据条目`);
    const entries = {};
    for (const [key, item] of Object.entries(value.entries)) {
        if (!KEY_MATCHERS[id]?.(key)) return fail('illegal-module-key', `模块 ${id} 包含不允许的条目：${key}`);
        const expectsArray = ARRAY_ENTRY_KEYS[id]?.(key) === true;
        if (expectsArray ? !Array.isArray(item) : !isObject(item)) return fail('invalid-entry', `模块 ${id} 的条目 ${key} 顶层结构不正确`);
        entries[key] = clone(item);
    }
    return { ok: true, value: { entries } };
}

export function parsePortableChatPackage(text, { maxBytes = PORTABLE_CHAT_MAX_BYTES } = {}) {
    const source = String(text ?? '');
    if (new TextEncoder().encode(source).byteLength > maxBytes) return fail('file-too-large', `文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 限制`);
    if (!source.trim()) return fail('empty-file', '文件是空的');
    let raw;
    try { raw = JSON.parse(source); }
    catch { return fail('invalid-json', '文件不是有效的 JSON'); }
    if (!isObject(raw) || raw.format !== PORTABLE_CHAT_FORMAT) return fail('invalid-format', '这不是构画按模块导出的数据包');
    if (raw.version !== PORTABLE_CHAT_VERSION) return fail('unsupported-version', `暂不支持此数据包版本：${String(raw.version ?? '未知')}`);
    if (!Array.isArray(raw.selectedModules) || !raw.selectedModules.length || !isObject(raw.modules)) return fail('invalid-header', '数据包头缺少模块清单');
    const selected = [...new Set(raw.selectedModules.map(String))];
    if (selected.some(id => !MODULE_IDS.has(id))) return fail('unknown-module', '数据包声明了不支持的模块');
    const moduleKeys = Object.keys(raw.modules);
    if (moduleKeys.some(id => !MODULE_IDS.has(id)) || moduleKeys.length !== selected.length || selected.some(id => !Object.prototype.hasOwnProperty.call(raw.modules, id))) {
        return fail('module-list-mismatch', '数据包模块清单与实际内容不一致');
    }
    const modules = {};
    for (const id of selected) {
        const checked = validateModule(id, raw.modules[id]);
        if (!checked.ok) return checked;
        if (!moduleHasContent(id, checked.value)) return fail('empty-module', `模块 ${id} 没有可导入的内容`);
        modules[id] = checked.value;
    }
    return { ok: true, package: { format: raw.format, version: raw.version, exportedAt: String(raw.exportedAt || ''), selectedModules: selected, modules } };
}

export function markImportedSpaceHistory(value) {
    if (!Array.isArray(value)) return [];
    return clone(value).map(message => {
        if (message?.role !== 'assistant' || !SPACE_WIDGET_RX.test(String(message.content || ''))) return message;
        return { ...message, portableReadonly: true };
    });
}

export function rebindImportedDateAnchor(value, targetChatId) {
    const next = clone(value);
    if (!isObject(next)) return next;
    const clean = (node, insideCalibration = false) => {
        if (!isObject(node)) return;
        delete node.claimMarker;
        delete node.ownerChatId;
        if (insideCalibration) {
            delete node.floor;
            delete node.sourceFloor;
            delete node.swipe;
        }
        for (const [key, child] of Object.entries(node)) if (isObject(child)) clean(child, insideCalibration || key === 'calibration');
    };
    clean(next);
    next.chatId = String(targetChatId || '');
    if (isObject(next.anchor)) next.anchor.chatId = String(targetChatId || '');
    return next;
}

function existingModule(id, roots) {
    return moduleHasContent(id, moduleFromRoots(id, roots));
}

export function createPortableImportPlan({ roots = {}, portablePackage, selectedModules, targetChatId } = {}) {
    const available = new Set(portablePackage?.selectedModules || []);
    const selected = [...new Set((Array.isArray(selectedModules) ? selectedModules : []).map(String))];
    if (!selected.length) return fail('empty-selection', '请至少选择一个要导入的模块');
    if (selected.some(id => !available.has(id) || !MODULE_IDS.has(id))) return fail('missing-module', '选择中包含数据包没有的模块');
    const expectedRoots = {};
    const replacementRoots = {};
    const existingModules = selected.filter(id => existingModule(id, roots));
    const storeSelected = selected.filter(id => id !== 'theater');
    if (storeSelected.length) {
        const before = isObject(roots['sp-store']) ? clone(roots['sp-store']) : { version: 1, data: {} };
        const after = clone(before);
        if (!isObject(after.data)) after.data = {};
        for (const id of storeSelected) {
            for (const key of Object.keys(after.data)) if (KEY_MATCHERS[id]?.(key)) delete after.data[key];
            for (const [key, value] of Object.entries(portablePackage.modules[id].entries)) {
                after.data[key] = id === 'space'
                    ? markImportedSpaceHistory(value)
                    : id === 'calendar' && key === 'date-anchor-user'
                        ? rebindImportedDateAnchor(value, targetChatId)
                        : clone(value);
            }
        }
        expectedRoots['sp-store'] = isObject(roots['sp-store']) ? clone(roots['sp-store']) : undefined;
        replacementRoots['sp-store'] = after;
    }
    if (selected.includes('theater')) {
        const before = isObject(roots['sp-theater']) ? clone(roots['sp-theater']) : { version: 1, saved: [] };
        expectedRoots['sp-theater'] = isObject(roots['sp-theater']) ? clone(roots['sp-theater']) : undefined;
        replacementRoots['sp-theater'] = { ...before, version: Number(before.version) || 1, saved: clone(portablePackage.modules.theater.saved) };
    }
    return { ok: true, selectedModules: selected, existingModules, expectedRoots, replacementRoots };
}

export function rebasePortableImportPlan({ originalRoots = {}, freshRoots = {}, portablePackage, selectedModules, targetChatId } = {}) {
    const selected = [...new Set((Array.isArray(selectedModules) ? selectedModules : []).map(String))];
    for (const id of selected) {
        if (!MODULE_IDS.has(id) || JSON.stringify(moduleFromRoots(id, originalRoots)) !== JSON.stringify(moduleFromRoots(id, freshRoots))) {
            return { ok: false, reason: 'module-conflict', module: id, commitState: 'conflict' };
        }
    }
    return createPortableImportPlan({ roots: freshRoots, portablePackage, selectedModules: selected, targetChatId });
}

export function portableModuleLabel(id) {
    return PORTABLE_MODULES.find(item => item.id === id)?.label || String(id || '');
}

export function portableModuleBaseline(roots, id) {
    return MODULE_IDS.has(String(id || '')) ? moduleFromRoots(String(id), roots) : null;
}

export const __portableChatDataTestSeams = Object.freeze({ KEY_MATCHERS, PERSISTENT_ROOT_KEYS, moduleFromRoots, moduleHasContent, isDefaultPersistentRoot });
