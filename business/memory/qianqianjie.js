export const QIANQIANJIE_BRIDGE_KEY = 'qqj_v3_public_bridge_v1';
export const QIANQIANJIE_READ_TIMEOUT_MS = 15000;
const clean = (value, maximum = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
const text = value => typeof value === 'string' ? value.trim() : '';
const characterLimit = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(40000, Math.floor(Number(value)))) : 12000;
function clip(value, limit, tail = false) {
    if (limit <= 0) return '';
    const result = tail ? value.slice(-limit) : value.slice(0, limit);
    return tail ? result.replace(/^[\udc00-\udfff]/, '') : result.replace(/[\ud800-\udbff]$/, '');
}
function topicQuery(query, recentText) {
    const current = clip(text(query), 8000, true);
    const recent = clip(text(recentText), 8000 - current.length - (current ? 2 : 0), true);
    return [current, recent].filter(Boolean).join('\n\n');
}
function selectPeople(items, query) {
    const people = items.filter(person => typeof person?.entityId === 'string' && person.entityId);
    const ids = new Set();
    for (const role of ['user', 'char']) {
        const candidates = [...new Set(people.filter(person => person.specialRole === role).map(person => person.entityId))];
        if (candidates.length === 1) ids.add(candidates[0]);
    }
    const byName = new Map();
    for (const person of people) for (const name of [person.displayName, person.entityDisplayName, person.profile?.name, ...(Array.isArray(person.aliases) ? person.aliases : [])].map(text).filter(Boolean)) {
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(person.entityId);
    }
    const names = [...byName.keys()].sort((a, b) => b.length - a.length);
    const word = value => /[a-z0-9_]/i.test(value || '');
    for (let at = 0; at < query.length;) {
        const name = names.find(value => query.startsWith(value, at)
            && !(word(value[0]) && word(query[at - 1])) && !(word(value.at(-1)) && word(query[at + value.length])));
        if (!name) { at += query.codePointAt(at) > 0xffff ? 2 : 1; continue; }
        const candidates = byName.get(name);
        if (candidates.size === 1) ids.add([...candidates][0]);
        at += name.length;
    }
    return { ids: [...ids], names: new Map(people.map(person => [person.entityId, text(person.displayName) || text(person.profile?.name) || person.entityId])) };
}
function formatSections(sections, maximum) {
    let output = '';
    for (const [heading, body] of sections) {
        if (!text(body)) continue;
        const separator = output ? '\n\n' : '', prefix = `${separator}${heading}\n`;
        if (maximum - output.length <= prefix.length) break;
        output += prefix + clip(text(body), maximum - output.length - prefix.length);
        if (output.length >= maximum) break;
    }
    return output;
}
function formatContext(value, selected, maximum) {
    const sections = [['【千千结｜作者侧背景；不代表人物均已知】', text(value.routerText)]];
    for (const actor of Array.isArray(value.actors) ? value.actors : []) {
        if (!selected.ids.includes(actor?.entityId)) continue;
        const parts = [['档案', actor.profileText], ['状态', actor.stateText], ['本人经历', actor.memoryText]].filter(([, body]) => text(body));
        if (parts.length) sections.push([`【人物：${selected.names.get(actor.entityId) || actor.entityId}｜仅该人物的资料】`, parts.map(([label, body]) => `${label}：\n${text(body)}`).join('\n')]);
    }
    return formatSections(sections, maximum);
}
function formatHistory(floors, maxFloor, maximum) {
    const eligible = floors.filter(floor => Number.isSafeInteger(floor?.messageIndex) && floor.messageIndex >= 0 && floor.messageIndex <= maxFloor && text(floor.summary))
        .sort((a, b) => b.messageIndex - a.messageIndex);
    return formatSections(eligible.map(floor => [`【千千结｜第${floor.messageIndex}楼${Number.isSafeInteger(floor.assistantSeq) ? ` / AI #${floor.assistantSeq}` : ''}｜${floor.summarySource === 'user' ? '人工摘要' : '楼层摘要'}；作者侧背景，不代表人物均已知】`, floor.summary]), maximum);
}

export function captureQianQianJieHostIdentity(context) {
    const characterId = context?.characterId;
    const character = Array.isArray(context?.characters) ? context.characters[characterId] : context?.characters?.[characterId];
    return Object.freeze({
        hostChatId: String(context?.chatId ?? context?.getCurrentChatId?.() ?? '').trim(),
        characterLocator: String(character?.avatar ?? context?.characterAvatar ?? '').trim(),
        personaLocator: String(context?.userAvatar ?? context?.personaAvatar ?? '').trim(),
    });
}

export function sameQianQianJieHostIdentity(left, right) {
    return !!left && !!right
        && left.hostChatId === right.hostChatId
        && left.characterLocator === right.characterLocator
        && (!left.personaLocator || !right.personaLocator || left.personaLocator === right.personaLocator);
}

function emptyResult(status, message, extra = {}) {
    return Object.freeze({ status, text: '', message: clean(message), ...extra });
}
const directBridge = api => api?.schemaVersion === 1 && api.kind === 'qqj-public-memory-bridge' && typeof api.readContext === 'function' && typeof api.getPeopleSnapshot === 'function';
const sourceMatches = (identity, host) => !identity || identity.hostChatId === host.hostChatId
    && identity.characterLocator === host.characterLocator && (!host.personaLocator || identity.personaLocator === host.personaLocator);

export function createQianQianJieMemoryAccess({ globalRef = globalThis, contextProvider, participantIdentityProvider = () => null, sourceEpochProvider = () => 0, isSelected = () => true, readTimeoutMs = QIANQIANJIE_READ_TIMEOUT_MS } = {}) {
    if (typeof contextProvider !== 'function') throw new TypeError('千千结记忆适配器缺少宿主上下文');
    const selected = () => { try { return isSelected() === true; } catch { return false; } };
    const currentBridge = () => globalRef?.[QIANQIANJIE_BRIDGE_KEY];
    const currentSourceEpoch = () => { try { return sourceEpochProvider(); } catch { return null; } };
    const captureIdentity = () => ({ host: captureQianQianJieHostIdentity(contextProvider()), participant: Object.freeze({ ...(participantIdentityProvider() || {}) }) });
    const participantKeys = ['chatId', 'characterId', 'characterKey', 'personaKey', 'userName', 'charName', 'boundaryEpoch'];
    const sameRequest = (left, right) => sameQianQianJieHostIdentity(left?.host, right?.host)
        && participantKeys.every(key => String(left?.participant?.[key] ?? '') === String(right?.participant?.[key] ?? ''));

    function status() {
        const api = currentBridge();
        if (!directBridge(api)) return emptyResult('api-unavailable', '检测不到千千结按题记忆接口');
        if (typeof api.getStatus !== 'function') return emptyResult('ready', '千千结只读接口已就绪', { reader: api });
        try {
            const value = api.getStatus();
            return emptyResult(value?.status || 'not-ready', value?.message || (value?.status === 'ready' ? '千千结只读接口已就绪' : '千千结当前尚未就绪'), { identity: value?.identity ?? null, reader: api });
        } catch { return emptyResult('not-ready', '千千结只读接口暂未就绪'); }
    }

    async function result({ query = '', recentText = '', maxCharacters = 12000, maxFloor = null, signal = null, timeoutMs = readTimeoutMs } = {}) {
        const sourceEpoch = currentSourceEpoch(), before = captureIdentity(), api = currentBridge();
        const extra = { identity: before.host, reader: api };
        if (!directBridge(api)) return emptyResult('api-unavailable', '检测不到千千结按题记忆接口', extra);
        if (!selected()) return emptyResult('stale', '记忆源已切换', extra);
        if (signal?.aborted) return emptyResult('cancelled', '本次记忆读取已取消', extra);
        const current = () => selected() && currentBridge() === api && currentSourceEpoch() === sourceEpoch && sameRequest(before, captureIdentity());
        const maximum = characterLimit(maxCharacters), topic = topicQuery(query, recentText);
        let formatted = '', readPending = true;
        const read = async () => {
            if (maxFloor !== null && maxFloor !== undefined) {
                if (!Number.isSafeInteger(maxFloor)) return { status: 'unavailable', message: '当前请求缺少有效的截止楼号' };
                if (typeof api.getSnapshot !== 'function') return { status: 'api-unavailable', message: '千千结当前接口不支持按截止楼读取已存摘要' };
                const value = await api.getSnapshot();
                if (!readPending || signal?.aborted || !current()) return { status: 'stale', message: '读取期间当前聊天或记忆源已变化' };
                if (value?.status !== 'ready' || !sourceMatches(value.identity, before.host)) return value;
                if (value.memory?.status !== 'ready') return { status: value.memory?.status || 'not-ready', identity: value.identity, message: '千千结已存摘要尚未就绪' };
                formatted = formatHistory(Array.isArray(value.memory.floors) ? value.memory.floors : [], maxFloor, maximum);
                return { status: 'ready', identity: value.identity };
            }
            const people = await api.getPeopleSnapshot();
            if (people?.status !== 'ready' || !sourceMatches(people.identity, before.host)) return people;
            if (!readPending || signal?.aborted || !current()) return { status: 'stale', message: '读取期间当前聊天或记忆源已变化' };
            const participants = selectPeople(Array.isArray(people.people?.items) ? people.people.items : [], topic);
            const value = await api.readContext({ query: topic, entityIds: participants.ids, maxCharacters: maximum });
            if (value?.status === 'ready') formatted = formatContext(value, participants, maximum);
            return value;
        };
        let value;
        try {
            value = await new Promise((resolve, reject) => {
                let settled = false, timer;
                const finish = (callback, payload) => {
                    if (settled) return;
                    settled = true; readPending = false; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); callback(payload);
                };
                const onAbort = () => finish(reject, Object.assign(new Error('qqj-memory-read-cancelled'), { name: 'AbortError' }));
                timer = setTimeout(() => finish(reject, Object.assign(new Error('qqj-memory-read-timeout'), { name: 'TimeoutError' })), Math.max(1, Number(timeoutMs) || QIANQIANJIE_READ_TIMEOUT_MS));
                signal?.addEventListener?.('abort', onAbort, { once: true });
                Promise.resolve(read()).then(resultValue => finish(resolve, resultValue), error => finish(reject, error));
            });
        } catch (error) {
            if (error?.name === 'AbortError' || signal?.aborted) return emptyResult('cancelled', '本次记忆读取已取消', extra);
            if (!current()) return emptyResult('stale', '读取期间当前聊天或记忆源已变化', extra);
            const timedOut = error?.name === 'TimeoutError';
            return emptyResult(timedOut ? 'timed-out' : 'read-failed', timedOut ? '等待千千结记忆超时' : `千千结记忆读取失败：${clean(error?.message || '未知错误')}`, extra);
        }
        if (signal?.aborted) return emptyResult('cancelled', '本次记忆读取已取消', extra);
        if (!current()) return emptyResult('stale', '读取期间当前聊天或记忆源已变化', extra);
        if (!sourceMatches(value?.identity, before.host)) return emptyResult('stale', '千千结返回的宿主聊天身份已变化', extra);
        const finalExtra = { identity: value?.identity ?? before.host, reader: api };
        if (value?.status !== 'ready') return emptyResult(value?.status || 'not-ready', value?.message || '千千结当前尚未就绪', finalExtra);
        if (!formatted) return emptyResult('empty', '当前话题暂无千千结已存记忆材料', finalExtra);
        return Object.freeze({ status: 'ready', text: formatted, cached: false, cachePersisted: false, message: '千千结已存记忆材料已就绪', ...finalExtra });
    }
    return Object.freeze({ status, result, reader: currentBridge, async text(options) { return (await result(options)).text; } });
}

export function qianQianJieMemoryDiagnostic(result) {
    switch (result?.status) {
        case 'ready': return result?.cached ? result.message : '千千结记忆材料已就绪';
        case 'api-unavailable': return '检测不到千千结轻量记忆接口：请确认千千结已启用且支持 readContext';
        case 'disabled': return '千千结当前已关闭';
        case 'not-ready': return result?.message || '千千结尚未准备好当前聊天';
        case 'empty':
        case 'unavailable': return result?.message || '当前聊天暂无千千结可用记忆材料';
        case 'stale': return '当前聊天或记忆源已变化，请重新生成';
        case 'cancelled': return '本次千千结记忆读取已取消';
        case 'timed-out': return '等待千千结记忆超时';
        case 'read-failed':
        case 'error': {
            const message = result?.message ? String(result.message) : '';
            return message.startsWith('千千结记忆读取失败') ? message : message ? `千千结记忆读取失败：${message}` : '千千结记忆读取失败';
        }
        default: return result?.message || '千千结记忆状态未知';
    }
}
