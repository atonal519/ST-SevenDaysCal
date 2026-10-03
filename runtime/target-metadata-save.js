// 固定聊天目标的 metadata-only patch seam。绝不调用 saveMetadata/saveChat 或 force。
import { waitForSignal } from './deadline.js';
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

// undefined 也是有效旧值；保留每条路径的 own-key，不能把缺键当作 snapshot baseline。
export function captureMetadataIntentBefore(metadata, paths) {
    if (!metadata || typeof metadata !== 'object' || !Array.isArray(paths)) return null;
    return Object.fromEntries(paths.map(path => [path, clone(readPointer(metadata, path))]));
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

    function capture(target, afterMetadata, { intentPaths, intentBefore } = {}) {
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
        // 窄事务把一个业务子键作为完整版本比较；诊断或其它模块的 live 差异不属于本次意图。
        // 显式路径无效时拒绝，不能退回整根 diff 扩大写入范围。
        if (intentPaths !== undefined && (!Array.isArray(intentPaths) || !intentPaths.length
            || intentPaths.some(path => typeof path !== 'string' || !ownedPath(path, roots) || roots.includes(path)
                || !intentBefore || !Object.prototype.hasOwnProperty.call(intentBefore, path)))) return null;
        const activeRoots = intentPaths ? roots.filter(root => intentPaths.some(path => ownedPath(path, [root]))) : roots;
        if (activeRoots.some(root => !(root.slice(1) in afterMetadata) && (root.slice(1) in before))) return null;
        // 固定 live 的旧版本必须跨 refresh 保持；远端第三值不能成为候选的合法 before。
        if (intentPaths) for (const path of intentPaths) {
            const previous = intentBefore[path];
            if (previous !== undefined || readPointer(before, path) !== undefined) setPointer(before, path, previous, previous === undefined);
        }
        const changes = intentPaths ? [...new Set(intentPaths)].flatMap(path => {
            const previous = readPointer(before, path);
            const next = readPointer(afterMetadata, path);
            // 即使旧值等于候选也保留检查意图，不能因缓存无 diff 去刷新并覆盖第三值。
            return [{ op: next === undefined ? 'remove' : previous === undefined ? 'add' : 'replace', path, ...(next === undefined ? {} : { value: clone(next) }) }];
        }) : changedOwnedKeys(before, afterMetadata, roots);
        if (!changes.length) return null;
        return { target: clone(fixedTarget), before, after: clone(afterMetadata), expectedIntegrity, changes, roots: activeRoots };
    }

    async function dispatch(captured, { isCurrent = () => true, signal = null, deadlineAt = Infinity, reportPhase = () => {} } = {}) {
        const current = () => !signal?.aborted && Date.now() < deadlineAt && isCurrent();
        let callbackStarted = false;
        let fetchDispatched = false;
        const notDispatched = reason => ({ ok: false, dispatched: false, commitState: 'not-dispatched', reason });
        const unknown = (reason, error = null) => {
            invalidate(captured?.target);
            return { ok: false, dispatched: true, commitState: 'unknown', reason, ...(error ? { error } : {}) };
        };
        if (!captured || !captured.changes?.length || !current()) return notDispatched('stale-before-queue');
        try {
            const work = api.runSerializedChatWrite(async () => {
            if (!current()) return notDispatched('stale-before-queue-callback');
            callbackStarted = true;
            let latest;
            try { latest = clone(await waitForSignal(api.getChatMetadataSnapshot(captured.target), signal)); }
            catch (error) { return current() ? notDispatched('snapshot-read-failed') : notDispatched('stale-before-fetch'); }
            const integrity = latest?.integrity;
            if (!current()) return notDispatched('stale-before-rebase');
            if (!latest || !validIntegrity(integrity)) return notDispatched('missing-latest-integrity');
            const rebased = clone(latest);
            const allowedRootAdds = new Set();
            for (const root of captured.roots || roots) {
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
            // 首次创建根时只补存储版本基础，不夹带 staging 中其它业务键。
            for (const root of allowedRootAdds) {
                const key = root.slice(1);
                if (captured.after[key]?.version !== undefined && rebased[key]?.version === undefined) rebased[key].version = clone(captured.after[key].version);
            }
            try { reportPhase('save-patch'); } catch {}
            let built;
            try { built = await waitForSignal(api.buildChatMetadataPatchOperationsAsync(latest, rebased), signal); }
            catch (error) { return current() ? notDispatched('patch-build-failed') : notDispatched('stale-after-build'); }
            if (!current()) return notDispatched('stale-after-build');
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
            if (!validOperations || !hasMutation) return notDispatched('invalid-operation');
            const operations = [{ op: 'test', path: '/integrity', value: integrity }, ...businessOperations];
            const headers = api.getRequestHeaders();
            const body = captured.target.is_group
                ? { id: captured.target.id, operations, integrity, force: false }
                : { ch_name: captured.target.char_name, file_name: captured.target.file_name, avatar_url: captured.target.avatar_url, operations, integrity, force: false };
            if (!current()) return notDispatched('stale-before-fetch');
            try { reportPhase('save-fetch'); } catch {}
            let response;
            try {
                fetchDispatched = true;
                response = await waitForSignal(fetchImpl(captured.target.is_group ? '/api/chats/group/meta/patch' : '/api/chats/meta/patch', { method: 'POST', cache: 'no-cache', headers, body: JSON.stringify(body), signal }), signal);
            } catch (error) {
                if (signal?.aborted || Date.now() >= deadlineAt) return unknown('save-interrupted-after-dispatch', error);
                return unknown('network', error);
            }
            if (signal?.aborted || Date.now() >= deadlineAt) return unknown('save-interrupted-after-dispatch');
            if (!response?.ok) { invalidate(captured.target); const status = response?.status || 0; return { ok: false, dispatched: true, commitState: status === 409 ? 'not-dispatched' : 'unknown', reason: `http-${status}`, status }; }
            let payload;
            try { reportPhase('save-receipt'); } catch {}
            try { payload = await waitForSignal(response.json(), signal); }
            catch (error) { return unknown('response-body-unconfirmed', error); }
            if (signal?.aborted || Date.now() >= deadlineAt) return unknown('response-body-unconfirmed');
            const nextIntegrity = payload?.integrity;
            if (payload?.created === true || payload?.ok !== true || !validIntegrity(nextIntegrity)) {
                invalidate(captured.target);
                return { ok: false, dispatched: true, commitState: 'unknown', reason: payload?.created === true ? 'created-response' : 'invalid-success-payload' };
            }
            const committed = { ...rebased, integrity: nextIntegrity };
            if (!isCurrent()) {
                invalidate(captured.target);
                return { ok: true, stale: true, dispatched: true, commitState: 'confirmed', reason: 'confirmed-after-owner-stale', target: captured.target, integrity: nextIntegrity };
            }
            try {
                api.applyIntegrityFromWritePayloadToTarget(payload, captured.target, committed);
                api.seedChatMetadataSnapshot(captured.target, committed);
            } catch (error) {
                invalidate(captured.target);
                return { ok: false, dispatched: true, commitState: 'unknown', reason: 'cache-helper-error', error };
            }
            return { ok: true, dispatched: true, commitState: 'confirmed', target: captured.target, integrity: nextIntegrity };
            });
            try { return callbackStarted ? await work : await waitForSignal(work, signal); }
            catch (error) {
                if (signal?.aborted || Date.now() >= deadlineAt) return fetchDispatched
                    ? unknown('save-interrupted-after-dispatch', error)
                    : notDispatched(callbackStarted ? 'save-interrupted-before-dispatch' : 'cancelled-while-queued');
                throw error;
            }
        } catch (error) {
            invalidate(captured.target);
            return { ok: false, dispatched: false, commitState: 'not-dispatched', reason: 'adapter-error', error };
        }
    }
    async function confirm(captured, { signal = null, deadlineAt = Infinity } = {}) {
        if (!captured?.target || typeof api.refreshChatWriteSnapshotsFromServer !== 'function') return { confirmed: false, available: false, reason: 'read-confirm-unavailable' };
        try {
            await waitForSignal(api.refreshChatWriteSnapshotsFromServer(captured.target), signal);
            if (signal?.aborted || Date.now() >= deadlineAt) { invalidate(captured.target); return { confirmed: false, available: false, reason: 'read-confirm-interrupted' }; }
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

// Cancellation-safe full-chat refresh for callers that must not invoke the host refresher,
// whose late completion seeds shared metadata/message caches without an abort guard.
export function createTargetSnapshotRefresher({ coreModule, fetchImpl = globalThis.fetch, syncActiveIntegrity } = {}) {
    const core = coreModule;
    if (!core || typeof fetchImpl !== 'function' || typeof core.resolveChatStateTarget !== 'function'
        || typeof core.getRequestHeaders !== 'function' || typeof core.runSerializedChatWrite !== 'function'
        || typeof core.seedChatMetadataSnapshot !== 'function') return null;
    const cloneJson = value => {
        try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
    };
    const sameTarget = (left, right) => {
        if (!left || !right || Boolean(left.is_group) !== Boolean(right.is_group)) return false;
        return left.is_group ? String(left.id || '') === String(right.id || '')
            : String(left.avatar_url || '') === String(right.avatar_url || '') && String(left.file_name || '') === String(right.file_name || '');
    };
    return async (target, { signal = null, deadlineAt = Infinity, isCurrent = () => true } = {}) => {
        const resolved = core.resolveChatStateTarget(target);
        const current = () => !signal?.aborted && Date.now() < deadlineAt && isCurrent()
            && sameTarget(resolved, core.resolveChatStateTarget());
        const run = async () => {
            if (!resolved || !current()) return null;
            const url = resolved.is_group ? '/api/chats/group/get' : '/api/chats/get';
            const body = resolved.is_group ? { id: resolved.id } : {
                ch_name: String(resolved.char_name || '').trim(), file_name: resolved.file_name, avatar_url: resolved.avatar_url,
            };
            if (!resolved.is_group && !body.ch_name) return null;
            const response = await waitForSignal(fetchImpl(url, {
                method: 'POST', cache: 'no-cache', headers: core.getRequestHeaders(), body: JSON.stringify(body), signal,
            }), signal);
            if (!current() || !response?.ok) return null;
            const payload = await waitForSignal(response.json(), signal);
            if (!current()) return null;
            const rows = Array.isArray(payload) ? payload : [];
            const rawMetadata = rows[0]?.chat_metadata && typeof rows[0].chat_metadata === 'object' && !Array.isArray(rows[0].chat_metadata)
                ? rows[0].chat_metadata : {};
            const metadata = cloneJson(rawMetadata);
            const messages = cloneJson(rows.slice(1).filter(message => message && typeof message === 'object'));
            if (!metadata || !Array.isArray(messages) || !current()) return null;
            for (const message of messages) core.ensureMessageMediaIsArray?.(message);
            core.seedChatMetadataSnapshot(resolved, metadata);
            core.seedChatMessageSnapshot?.(resolved, messages);
            syncActiveIntegrity?.(resolved, metadata);
            return { target: resolved, metadata, messages };
        };
        // Keep the cancellable read inside the host's shared chat-write queue.
        return core.runSerializedChatWrite(() => run());
    };
}

export const targetMetadataCoreContract = Object.freeze({ required: REQUIRED.slice(), ownedRoots: OWNED_ROOTS.slice() });

export async function dispatchTargetMetadataWithRefresh({ saver, target, afterMetadata, refresh, isCurrent = () => true, signal = null, deadlineAt = Infinity, reportPhase, intentPaths, intentBefore } = {}) {
    const captureOptions = { intentPaths, intentBefore: intentBefore && Object.fromEntries(Object.entries(intentBefore).map(([path, value]) => [path, clone(value)])) };
    let captured = saver?.capture?.(target, afterMetadata, captureOptions); let saveReason = captured ? 'snapshot-current' : 'snapshot-empty';
    if (!captured && typeof refresh === 'function') {
        try {
            if (signal?.aborted || Date.now() >= deadlineAt || !isCurrent()) throw signal?.reason || new DOMException('The operation was aborted.', 'AbortError');
            await waitForSignal(refresh(target, { signal, deadlineAt, isCurrent }), signal);
            if (signal?.aborted || Date.now() >= deadlineAt || !isCurrent()) throw signal?.reason || new DOMException('The operation was aborted.', 'AbortError');
            captured = saver.capture(target, afterMetadata, captureOptions); saveReason = captured ? 'snapshot-refreshed' : 'snapshot-refresh-empty';
        }
        catch { saveReason = 'snapshot-refresh-failed'; }
    }
    if (!captured) return { ok: false, reason: 'metadata-capture-failed', saveReason, dispatched: false, commitState: 'not-dispatched' };
    if (signal?.aborted || Date.now() >= deadlineAt || !isCurrent()) return { ok: false, reason: 'stale-before-dispatch', saveReason, dispatched: false, commitState: 'not-dispatched' };
    const result = await saver.dispatch(captured, { isCurrent, signal, deadlineAt, reportPhase });
    return { ...result, saveReason: result.saveReason || saveReason, dispatched: result.dispatched ?? false, confirm: () => saver.confirm?.(captured, { signal, deadlineAt }) };
}

// 官方 host 没有固定目标 patch contract 时的 best-effort 保存；结果明确标记为未确认。
export function createBestEffortMetadataSaver({ context = () => null } = {}) {
    return {
        supported: true,
        mode: 'legacy-unconfirmed',
        async commit(boundContext = null, options = {}) {
            const ctx = boundContext || context?.();
            const ownerGuard = typeof options.ownerGuard === 'function' ? options.ownerGuard : () => true;
            const target = options.target;
            // A confirmed generation write must not fall back to the host's unbounded
            // saveMetadata queue when its caller has a cancellation/deadline contract.
            if (options.signal || Number.isFinite(Number(options.deadlineAt))) {
                return { ok: false, reason: 'unsupported-core-contract', commitState: 'not-dispatched', dispatched: false };
            }
            if (!ctx?.chatId || typeof ctx.saveMetadata !== 'function') return { ok: false, reason: 'official-saveMetadata-unavailable', commitState: 'not-dispatched', dispatched: false };
            if (target?.chatId && target.chatId !== ctx.chatId) return { ok: false, reason: 'target-chat-mismatch', commitState: 'not-dispatched', dispatched: false };
            if (!ownerGuard()) return { ok: false, reason: 'stale-before-save', commitState: 'not-dispatched', dispatched: false };
            const rootKey = String(options.rootKey || 'sp-store');
            const stagedMetadata = ctx.chatMetadata;
            const liveMetadata = options.liveMetadata;
            const swapRoot = liveMetadata && stagedMetadata && liveMetadata !== stagedMetadata;
            const liveRootExisted = swapRoot && Object.prototype.hasOwnProperty.call(liveMetadata, rootKey);
            const liveRoot = swapRoot ? liveMetadata[rootKey] : undefined;
            const stagedRoot = stagedMetadata?.[rootKey];
            const stagedSnapshot = clone(stagedRoot);
            const publication = options.publication && typeof options.publication === 'object' ? options.publication : null;
            let result;
            try {
                if (swapRoot) {
                    if (Object.prototype.hasOwnProperty.call(stagedMetadata, rootKey)) liveMetadata[rootKey] = stagedRoot;
                    else delete liveMetadata[rootKey];
                    if (publication) { publication.root = stagedRoot; publication.installed = true; }
                }
                result = ctx.saveMetadata({ withMetadata: { [rootKey]: stagedRoot } });
                if (result?.then) result = await result;
            } finally {
                // 宿主可能在 await 后才读取全局 metadata。仅当本次临时 root 的
                // 引用和内容都仍归本次操作所有时还原；并发普通写已经改动它时保留新值。
                const installedRootStillOwned = publication?.isOwned ? publication.isOwned() : same(stagedRoot, stagedSnapshot);
                if (swapRoot && liveMetadata[rootKey] === stagedRoot && installedRootStillOwned) {
                    if (liveRootExisted) liveMetadata[rootKey] = liveRoot;
                    else delete liveMetadata[rootKey];
                }
                if (publication) publication.installed = swapRoot && liveMetadata[rootKey] === stagedRoot;
            }
            if (result === false || (result && typeof result === 'object' && result.ok === false)) {
                return { ...(result && typeof result === 'object' ? result : {}), ok: false, reason: result?.reason || 'official-saveMetadata-failed', commitState: result?.commitState || 'legacy-unconfirmed', dispatched: result?.dispatched ?? true, bestEffort: true };
            }
            if (!ownerGuard()) return { ok: true, stale: true, reason: 'stale-after-save', commitState: 'legacy-unconfirmed', dispatched: true, bestEffort: true };
            return { ok: true, reason: 'official-saveMetadata-best-effort', commitState: 'legacy-unconfirmed', dispatched: true, bestEffort: true };
        },
    };
}
