// 固定聊天目标的 metadata-only patch seam。绝不调用 saveMetadata/saveChat 或 force。
const REQUIRED = [
    'resolveChatStateTarget', 'runSerializedChatWrite', 'buildChatMetadataPatchOperationsAsync',
    'getRequestHeaders', 'getChatMetadataSnapshot', 'seedChatMetadataSnapshot',
    'applyIntegrityFromWritePayloadToTarget', 'invalidateChatWriteSnapshot',
];
const OWNED_ROOTS = ['/sp-store', '/sp-ledger'];

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function featureCheck(api) { return REQUIRED.every(name => typeof api?.[name] === 'function'); }
function validIntegrity(value) { return typeof value === 'string' && value.trim().length > 0; }
function ownedPath(path, roots = OWNED_ROOTS) { return roots.some(root => path === root || path.startsWith(`${root}/`)); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function pointer(key) { return String(key).replace(/~/g, '~0').replace(/\//g, '~1'); }

// 只对 owned root 的子键生成 patch。故意不产生 /sp-store 或 /sp-ledger
// 本身的 replace，避免把同一 root 下其它插件的键一起抹掉。
function ownedDiff(before, after, path, out = []) {
    if (same(before, after)) return out;
    if ((path === '/sp-store' || path === '/sp-ledger') && after && typeof after === 'object' && !Array.isArray(after)) {
        for (const key of Object.keys(after)) {
            if (!before || !(key in before)) out.push({ op: 'add', path: `${path}/${pointer(key)}`, value: clone(after[key]) });
            else ownedDiff(before[key], after[key], `${path}/${pointer(key)}`, out);
        }
        for (const key of Object.keys(before || {})) if (!(key in after)) out.push({ op: 'remove', path: `${path}/${pointer(key)}` });
        return out;
    }
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const key of keys) {
            const child = `${path}/${pointer(key)}`;
            if (!(key in after)) out.push({ op: 'remove', path: child });
            else if (!(key in before)) out.push({ op: 'add', path: child, value: clone(after[key]) });
            else ownedDiff(before[key], after[key], child, out);
        }
        return out;
    }
    out.push({ op: path === '/sp-store' || path === '/sp-ledger' ? 'replace' : 'replace', path, value: clone(after) });
    return out;
}

function changedOwnedKeys(before, after, roots = OWNED_ROOTS) {
    // metadata object 使用 `sp-store`，JSON Pointer 才使用 `/sp-store`。
    return roots.flatMap(root => {
        const key = root.slice(1);
        return ownedDiff(before?.[key], after?.[key], root);
    });
}

function readPointer(value, path) {
    const parts = String(path).split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let current = value;
    for (const part of parts) { if (current == null || !(part in Object(current))) return undefined; current = current[part]; }
    return current;
}

function setPointer(value, path, next, remove = false) {
    const parts = String(path).split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!parts.length) return value;
    let current = value;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part] || typeof current[part] !== 'object') current[part] = {};
        current = current[part];
    }
    const last = parts.at(-1);
    if (remove) { if (Array.isArray(current)) current.splice(Number(last), 1); else delete current[last]; }
    else current[last] = clone(next);
    return value;
}

function expandRootOperations(operations, previous, next, allowRootAdds = new Set(), roots = OWNED_ROOTS) {
    const expanded = [];
    for (const operation of operations || []) {
        if (roots.includes(operation?.path)) {
            if (operation.op === 'test') { expanded.push(operation); continue; }
            const key = operation.path.slice(1);
            if (operation.op === 'add' && allowRootAdds.has(operation.path) && !(key in previous) && key in next) {
                expanded.push({ op: 'add', path: operation.path, value: clone(next[key]) });
            } else {
                expanded.push(...ownedDiff(previous?.[key], next?.[key], operation.path));
            }
        } else expanded.push(operation);
    }
    return expanded;
}

function validateBusinessOperations(operations, allowedRootAdds = new Set(), roots = OWNED_ROOTS) {
    for (const operation of operations || []) {
        if (operation?.op === 'test') {
            if (!(operation.path === '/integrity' || (ownedPath(operation?.path, roots) && !roots.includes(operation.path))) || 'from' in operation) return false;
            continue;
        }
        if (!['add', 'remove', 'replace'].includes(operation?.op)) return false;
        const rootAdd = operation?.op === 'add' && allowedRootAdds.has(operation?.path);
        if (!ownedPath(operation?.path, roots) || (roots.includes(operation.path) && !rootAdd)) return false;
        if ('from' in operation) return false;
    }
    return true;
}

export function createTargetMetadataSaver({ coreModule = null, fetchImpl = globalThis.fetch, ownedRoots = OWNED_ROOTS } = {}) {
    const roots = [...new Set((ownedRoots || OWNED_ROOTS).map(root => String(root).startsWith('/') ? String(root) : `/${root}`))];
    const api = coreModule;
    if (!api) return { supported: false, reason: 'core-module-required' };
    if (!featureCheck(api) || typeof fetchImpl !== 'function') return { supported: false, reason: 'unsupported-core-contract' };
    const invalidate = target => { try { api.invalidateChatWriteSnapshot(target); } catch { /* cache invalidation is best effort */ } };

    function capture(target, afterMetadata) {
        const fixedTarget = api.resolveChatStateTarget(target);
        const before = clone(api.getChatMetadataSnapshot(fixedTarget));
        const expectedIntegrity = before?.integrity;
        const validTarget = fixedTarget?.is_group
            ? typeof fixedTarget.id === 'string' && fixedTarget.id.length > 0
            : typeof fixedTarget?.avatar_url === 'string' && fixedTarget.avatar_url.length > 0
                && typeof fixedTarget?.file_name === 'string' && fixedTarget.file_name.length > 0
                && typeof fixedTarget?.char_name === 'string' && fixedTarget.char_name.length > 0;
        if (!validTarget || !before || !validIntegrity(expectedIntegrity) || !afterMetadata || typeof afterMetadata !== 'object') return null;
        // after 缺少一个此前存在的 root 不是“清空”意图，直接拒绝；仅在
        // before root 缺失且 after 提供对象时，才生成必要 child add。
        if (roots.some(root => !(root.slice(1) in afterMetadata) && (root.slice(1) in before))) return null;
        const changes = changedOwnedKeys(before, afterMetadata, roots);
        if (!changes.length) return null;
        return { target: clone(fixedTarget), before, after: clone(afterMetadata), expectedIntegrity, changes };
    }

    async function dispatch(captured, { isCurrent = () => true } = {}) {
        if (!captured || !captured.changes?.length || !isCurrent()) return { ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'stale-before-queue' };
        try {
            return await api.runSerializedChatWrite(async () => {
            if (!isCurrent()) return { ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'stale-before-fetch' };
            const latest = clone(api.getChatMetadataSnapshot(captured.target));
            const integrity = latest?.integrity;
            if (!latest || !validIntegrity(integrity)) return { ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'missing-latest-integrity' };
            const rebased = clone(latest);
            const allowedRootAdds = new Set();
            for (const root of roots) {
                const key = root.slice(1);
                const beforeHas = key in captured.before;
                const latestHas = key in latest;
                if (beforeHas && !latestHas && key in captured.after) return { ok: false, dispatched: false, commitState: 'conflict', reason: 'owned-root-conflict', path: root };
                if (!beforeHas && !latestHas && key in captured.after) allowedRootAdds.add(root);
            }
            for (const change of captured.changes) {
                const beforeValue = readPointer(captured.before, change.path);
                const latestValue = readPointer(latest, change.path);
                const afterValue = change.op === 'remove' ? undefined : change.value;
                // 其它写入已达到目标值时可安全吸收；否则只有 latest 仍等于
                // capture-before 才能套用，避免静默覆盖并发的同一 owned 子键。
                if (!same(latestValue, beforeValue) && !same(latestValue, afterValue)) {
                    return { ok: false, dispatched: false, commitState: 'conflict', reason: 'owned-conflict', path: change.path };
                }
                if (!same(latestValue, afterValue)) setPointer(rebased, change.path, afterValue, change.op === 'remove');
            }
            const built = await api.buildChatMetadataPatchOperationsAsync(latest, rebased);
            if (!isCurrent()) return { ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'stale-after-build' };
            if ((built || []).some(op => roots.includes(op?.path) && ['replace', 'remove'].includes(op?.op))) return { ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'invalid-operation' };
            let businessOperations = expandRootOperations(built.filter(op => op?.path !== '/integrity'), latest, rebased, allowedRootAdds, roots);
            // 服务端 fast-json-patch 要求父对象先存在；root 原本缺失时以一个
            // 受控 root add 承载本事务内容，不能再跟随重复 child add。
            for (const root of allowedRootAdds) {
                const key = root.slice(1);
                businessOperations = businessOperations.filter(op => op.path !== root && !op.path?.startsWith(`${root}/`));
                businessOperations.push({ op: 'add', path: root, value: clone(rebased[key]) });
            }
            const hasMutation = businessOperations.some(op => ['add', 'remove', 'replace'].includes(op?.op));
            const validOperations = validateBusinessOperations(businessOperations, allowedRootAdds, roots);
            if (!validOperations || !hasMutation) return { ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'invalid-operation' };
            const operations = [{ op: 'test', path: '/integrity', value: integrity }, ...businessOperations];
            const headers = api.getRequestHeaders();
            const body = captured.target.is_group
                ? { id: captured.target.id, operations, integrity, force: false }
                : { ch_name: captured.target.char_name, file_name: captured.target.file_name, avatar_url: captured.target.avatar_url, operations, integrity, force: false };
            let response;
            try {
                response = await fetchImpl(captured.target.is_group ? '/api/chats/group/meta/patch' : '/api/chats/meta/patch', { method: 'POST', cache: 'no-cache', headers, body: JSON.stringify(body) });
            } catch (error) {
                invalidate(captured.target);
                return { ok: false, dispatched: true, commitState: 'unknown', reason: 'network', error };
            }
            if (!response?.ok) { invalidate(captured.target); const status = response?.status || 0; return { ok: false, dispatched: true, commitState: status === 409 ? 'not-dispatched' : 'unknown', reason: `http-${status}` }; }
            const payload = await response.json().catch(() => null);
            const nextIntegrity = payload?.integrity;
            if (payload?.created === true || payload?.ok !== true || !validIntegrity(nextIntegrity)) {
                invalidate(captured.target);
                return { ok: false, dispatched: true, commitState: 'unknown', reason: payload?.created === true ? 'created-response' : 'invalid-success-payload' };
            }
            const committed = { ...rebased, integrity: nextIntegrity };
            try {
                api.applyIntegrityFromWritePayloadToTarget(payload, captured.target, committed);
                api.seedChatMetadataSnapshot(captured.target, committed);
            } catch (error) {
                invalidate(captured.target);
                return { ok: false, dispatched: true, commitState: 'unknown', reason: 'cache-helper-error', error };
            }
            return { ok: true, dispatched: true, commitState: 'confirmed', target: captured.target, integrity: nextIntegrity };
            });
        } catch (error) {
            invalidate(captured.target);
            return { ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'adapter-error', error };
        }
    }
    async function confirm(captured) {
        if (!captured?.target || typeof api.refreshChatWriteSnapshotsFromServer !== 'function') return { confirmed: false, available: false, reason: 'read-confirm-unavailable' };
        try {
            await api.refreshChatWriteSnapshotsFromServer(captured.target);
            const latest = clone(api.getChatMetadataSnapshot(captured.target));
            if (!latest) return { confirmed: false, available: false, reason: 'read-confirm-empty' };
            const states = (captured.changes || []).map(change => {
                const before = readPointer(captured.before, change.path);
                const after = change.op === 'remove' ? undefined : change.value;
                const current = readPointer(latest, change.path);
                return same(current, after) ? 'after' : same(current, before) ? 'before' : 'third';
            });
            const allAfter = states.length > 0 && states.every(state => state === 'after');
            const allBefore = states.length > 0 && states.every(state => state === 'before');
            return { confirmed: allAfter, submitted: allAfter ? true : allBefore ? false : null, available: true, integrity: latest.integrity };
        } catch (error) { return { confirmed: false, available: false, reason: 'read-confirm-failed', error }; }
    }
    return { supported: true, capture, dispatch, confirm };
}

export const targetMetadataCoreContract = Object.freeze({ required: REQUIRED.slice(), ownedRoots: OWNED_ROOTS.slice() });

// 官方 host 没有固定目标 patch contract 时的 best-effort 保存；结果明确标记为未确认。
export function createBestEffortMetadataSaver({ context = () => null } = {}) {
    return {
        supported: true,
        mode: 'legacy-unconfirmed',
        async commit(boundContext = null, options = {}) {
            const ctx = boundContext || context?.();
            const ownerGuard = typeof options.ownerGuard === 'function' ? options.ownerGuard : () => true;
            const target = options.target;
            if (!ctx?.chatId || typeof ctx.saveMetadata !== 'function') return { ok: false, reason: 'official-saveMetadata-unavailable', commitState: 'not-dispatched', dispatched: false };
            if (target?.chatId && target.chatId !== ctx.chatId) return { ok: false, reason: 'target-chat-mismatch', commitState: 'not-dispatched', dispatched: false };
            if (!ownerGuard()) return { ok: false, reason: 'stale-before-save', commitState: 'not-dispatched', dispatched: false };
            const result = ctx.saveMetadata();
            if (result?.then) await result;
            if (!ownerGuard()) return { ok: true, stale: true, reason: 'stale-after-save', commitState: 'legacy-unconfirmed', dispatched: true, bestEffort: true };
            return { ok: true, reason: 'official-saveMetadata-best-effort', commitState: 'legacy-unconfirmed', dispatched: true, bestEffort: true };
        },
    };
}
