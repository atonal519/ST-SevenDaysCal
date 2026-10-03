import { createDeadlineSignal, waitForSignal } from './deadline.js';

const STORE_ROOT = '/sp-store';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function readIntent(metadata, path) {
    const match = /^\/sp-store\/data\/([^/]+)$/.exec(String(path || ''));
    if (!match) return null;
    const key = match[1].replace(/~1/g, '/').replace(/~0/g, '~');
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') return null;
    const data = metadata?.['sp-store']?.data;
    return { key, had: own(data, key), value: clone(data?.[key]) };
}

function writeIntent(metadata, intent) {
    const rootKey = STORE_ROOT.slice(1);
    const currentRoot = metadata[rootKey];
    const root = currentRoot && typeof currentRoot === 'object' && !Array.isArray(currentRoot)
        ? clone(currentRoot)
        : { version: 1, data: {} };
    if (!root.data || typeof root.data !== 'object' || Array.isArray(root.data)) root.data = {};
    if (intent.candidateHad) root.data[intent.key] = clone(intent.candidate);
    else delete root.data[intent.key];
    return root;
}

function captureTarget(context) {
    if (!context?.chatId || !context.chatMetadata || typeof context.chatMetadata !== 'object') return null;
    const chatId = String(context.chatId);
    if (context.groupId !== null && context.groupId !== undefined && String(context.groupId) !== '') {
        return Object.freeze({ kind: 'group', groupId: String(context.groupId), chatId, chat: context.chat, metadata: context.chatMetadata });
    }
    const characterId = context.characterId;
    const character = context.characters?.[characterId];
    const characterName = String(character?.name ?? '');
    // Match TT's saveCharacterChatMetadata caller: preserve its raw avatar field,
    // using avatar_url only for hosts that expose no avatar value.
    const avatarUrl = String(character?.avatar ?? character?.avatar_url ?? '');
    if (characterId === null || characterId === undefined || !characterName.trim() || !avatarUrl.trim()) return null;
    return Object.freeze({ kind: 'character', characterId: String(characterId), characterName, avatarUrl, fileName: chatId, chatId, chat: context.chat, metadata: context.chatMetadata });
}

function sameTarget(left, right) {
    if (!left || !right || left.kind !== right.kind || left.chatId !== right.chatId || left.chat !== right.chat) return false;
    return left.kind === 'group'
        ? left.groupId === right.groupId
        : left.characterId === right.characterId && left.characterName === right.characterName
            && left.avatarUrl === right.avatarUrl && left.fileName === right.fileName;
}

function notDispatched(reason) { return { ok: false, reason, commitState: 'not-dispatched', dispatched: false }; }

export function createTauriTavernMetadataSaver({ host, enqueueChatSave, persistedChatMetadata, getContext, loadTransport } = {}) {
    const supported = !!host && typeof enqueueChatSave === 'function' && typeof persistedChatMetadata === 'function'
        && typeof getContext === 'function' && typeof loadTransport === 'function';
    if (!supported) return { supported: false, reason: 'unsupported-core-contract' };

    const commitWithSignal = async (stagedContext, options = {}) => {
            const signal = options.signal || null;
            const deadlineAt = Number.isFinite(Number(options.deadlineAt)) ? Number(options.deadlineAt) : Infinity;
            const ownerGuard = typeof options.ownerGuard === 'function' ? options.ownerGuard : () => true;
            const intentOwnerGuard = typeof options.intentOwnerGuard === 'function' ? options.intentOwnerGuard : () => true;
            const liveMetadata = options.liveMetadata;
            const target = captureTarget(getContext());
            const paths = options.intentPaths;
            if (!target || !liveMetadata || liveMetadata !== target.metadata) return notDispatched('tt-target-unavailable');
            if (!Array.isArray(paths) || paths.length !== 1) return notDispatched('unsupported-core-contract');
            const path = paths[0];
            const baseline = readIntent(liveMetadata, path);
            const candidate = readIntent(stagedContext?.chatMetadata, path);
            if (!baseline || !candidate) return notDispatched('unsupported-core-contract');
            const intentBefore = options.intentBefore;
            if (!intentBefore || !own(intentBefore, path)) return notDispatched('unsupported-core-contract');
            const expectedValue = clone(intentBefore[path]);
            const intent = Object.freeze({ key: baseline.key, beforeHad: baseline.had, before: baseline.value, candidateHad: candidate.had, candidate: candidate.value, expectedValue });
            const stillCurrent = () => {
                const current = getContext();
                const currentTarget = captureTarget(current);
                return !signal?.aborted && Date.now() < deadlineAt && ownerGuard()
                    && current?.chatMetadata === liveMetadata && sameTarget(target, currentTarget);
            };
            const entryStillCurrent = () => {
                const now = readIntent(liveMetadata, path);
                return !!now && now.had === intent.beforeHad && equal(now.value, intent.before)
                    && equal(intent.expectedValue, intent.before);
            };
            if (!stillCurrent()) return notDispatched('tt-target-unavailable');
            if (!intentOwnerGuard() || !entryStillCurrent()) return { ok: false, reason: 'tt-intent-conflict', commitState: 'conflict', dispatched: false };

            let transport;
            try { transport = await waitForSignal(loadTransport(), signal); }
            catch (error) { return signal?.aborted || Date.now() >= deadlineAt ? notDispatched('cancelled-while-queued') : { ...notDispatched('unsupported-core-contract'), error }; }
            if (!stillCurrent()) return notDispatched('cancelled-while-queued');
            const saveCharacter = transport?.saveCharacterChatMetadata;
            const saveGroup = transport?.saveGroupChatMetadata;
            if ((target.kind === 'group' && typeof saveGroup !== 'function') || (target.kind === 'character' && typeof saveCharacter !== 'function')) return notDispatched('unsupported-core-contract');

            let dispatched = false;
            let callbackStarted = false;
            let queuePromiseReturned = false;
            let resolveCallback;
            const callbackResult = new Promise(resolve => { resolveCallback = resolve; });
            const queued = Promise.resolve().then(() => {
                const hostResult = enqueueChatSave(async () => {
                // The TT callback is the single host queue entry: never call saveMetadata from here,
                // which would enqueue behind itself. An IPC already dispatched cannot be cancelled;
                // keep awaiting it so later host saves cannot overtake an unknown write.
                callbackStarted = true;
                let result;
                try {
                    if (!stillCurrent()) result = notDispatched('cancelled-while-queued');
                    else if (!intentOwnerGuard() || !entryStillCurrent()) result = { ok: false, reason: 'tt-intent-conflict', commitState: 'conflict', dispatched: false };
                    else {
                        const latestRoot = writeIntent(liveMetadata, intent);
                        const overrides = { [STORE_ROOT.slice(1)]: latestRoot };
                        let chatMetadata;
                        try { chatMetadata = await persistedChatMetadata(overrides); }
                        catch (error) { result = { ...notDispatched('tt-metadata-build-failed'), error }; }
                        if (!result && !stillCurrent()) result = notDispatched('cancelled-while-queued');
                        if (!result && (!intentOwnerGuard() || !entryStillCurrent())) result = { ok: false, reason: 'tt-intent-conflict', commitState: 'conflict', dispatched: false };
                        if (!result) {
                            dispatched = true;
                            const response = target.kind === 'group'
                                ? await saveGroup({ id: target.chatId, chatMetadata })
                                : await saveCharacter({ characterName: target.characterName, avatarUrl: target.avatarUrl, fileName: target.fileName, chatMetadata });
                            result = response === false || (response && typeof response === 'object' && response.ok === false)
                                ? { ok: false, reason: 'tt-transport-rejected', commitState: 'unknown', dispatched: true }
                                : { ok: true, reason: 'tt-metadata-saved', commitState: 'confirmed', dispatched: true };
                        }
                    }
                } catch (error) {
                    result = dispatched
                        ? { ok: false, reason: 'tt-transport-failed', commitState: 'unknown', dispatched: true, error }
                        : { ...notDispatched('tt-queue-failed'), error };
                }
                resolveCallback(result);
                return result;
                });
                queuePromiseReturned = !!hostResult && typeof hostResult.then === 'function';
                return hostResult;
            });
            // Some TT builds expose a promise that resolves to void; a void return itself does not
            // carry the save result, which is captured separately from the actual callback.
            queued.then(() => { if (queuePromiseReturned && !callbackStarted) resolveCallback(notDispatched('tt-queue-failed')); }, error => {
                resolveCallback(dispatched
                    ? { ok: false, reason: 'tt-transport-failed', commitState: 'unknown', dispatched: true, error }
                    : { ...notDispatched('tt-queue-failed'), error });
            });
            try {
                return await waitForSignal(callbackResult, signal);
            } catch (error) {
                return dispatched
                    ? { ok: false, reason: 'save-interrupted-after-dispatch', commitState: 'unknown', dispatched: true }
                    : notDispatched('cancelled-while-queued');
            }
        };
    return {
        supported: true,
        mode: 'tauritavern-confirmed',
        async commit(stagedContext, options = {}) {
            const bounded = createDeadlineSignal({ signal: options.signal || null, deadlineAt: options.deadlineAt, reason: 'tt-save-timeout' });
            try { return await commitWithSignal(stagedContext, { ...options, signal: bounded.signal, deadlineAt: bounded.deadlineAt }); }
            finally { bounded.dispose(); }
        },
    };
}
