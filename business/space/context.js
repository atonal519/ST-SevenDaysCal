import { buildSpaceChatSystemPrompt, buildSpaceHelpText } from './prompts.js';
import { compactLineBaselines, compactPointBaselines, spacePageId, stripWidgetsForApi, SPACE_WIDGET_KINDS } from './schema.js';
const SPACE_MATERIAL_RX = Object.freeze({
    outline: /(?:大纲|面规划|当前面|下一面|面节点|规划到哪)/,
    points: /(?:日程|日历|待办|点卡片?|已有的点|当前点)/,
    lines: /(?:事件线|剧情线|线索|伏笔线|线卡片?|当前线|已有线)/,
    ledger: /(?:刻度|暗历|暗账|伤情|病情|怀孕|孕期|约定|周期|待办|身心状态|伤好了没|没了结)/,
    date: /(?:故事日期|剧情日期|当前故事时间|今天几月|当前日期|几月几日|哪一天|节日|生日|纪念日|周年)/,
    calendar: /(?:历法|纪年|年号|月名|每月几天|几个月|历法月份)/,
    cold: /(?:冷知识|边角知识|已存知识|冷门知识)/,
    menu: /(?:今天吃点啥|今日菜单|菜单|吃什么|菜品|上次的菜)/,
    theater: /(?:棱|小剧场|棱作品|棱模板|已存作品|已保存作品|作品列表|模板列表)/,
    coordinate: /(?:坐标|收藏夹|收藏楼|收藏的楼|已存坐标|坐标收藏|锚点收藏|展开第\s*\d+\s*楼坐标正文)/,
});

export function requestedSpaceMaterials(message) {
    const text = String(message || '');
    return Object.freeze(Object.fromEntries(Object.entries(SPACE_MATERIAL_RX).map(([key, rx]) => [key, rx.test(text)])));
}

export function classifySpaceIntent() {
    return Object.freeze({ action: 'semantic-route', kind: null, faq: true, pointContext: false, lineContext: false, recentWidget: null, allowedWidgetKinds: [...SPACE_WIDGET_KINDS], reason: '' });
}

export function numberedSpaceLineList(raw, parseLines) {
    return (parseLines?.(raw) || []).map((line, index) => {
        const bits = [`#${index + 1}`, line.name || '(未命名)'];
        if (line.type) bits.push(`｜${line.type}`);
        if (line.stage) bits.push(`｜${line.stage}${line.stall ? '(停滞)' : ''}`);
        if (line.when) bits.push(`｜${line.when}`);
        bits.push(`｜${line.agency === 'player' ? '等待用户' : '世界推进'}`);
        if (line.desc) bits.push(`｜${line.desc}`);
        if (line.next) bits.push(`｜下一步:${line.next}`);
        return bits.join(' ');
    }).join('\n');
}

const pointOwnerHeading = (scope, userName) => scope.view === 'char'
    ? `【TA｜人物：${scope.charName}｜view="char" char="${String(scope.charName || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"】`
    : `【我｜人物：${userName}｜view="user"】`;

export function numberedSpacePointGroups(scopes, numberedPoints, userName = '用户') {
    return (Array.isArray(scopes) ? scopes : []).map(scope => {
        const list = numberedPoints?.(scope.raw) || '';
        return list ? `${pointOwnerHeading(scope, userName)}\n${list}` : '';
    }).filter(Boolean).join('\n\n');
}

const readWithStatus = async (reader, label, ...args) => {
    try {
        const value = await reader?.(...args);
        return value ? String(value) : `【${label}未提供】本轮没有可用的${label}资料。`;
    } catch {
        return `【${label}读取失败】本轮无法读取${label}，不得据此编造或覆盖正式内容。`;
    }
};

const readOutlineSource = async (snapshotReader, projectionReader, target) => {
    if (snapshotReader) {
        try {
            const snapshot = await snapshotReader(target);
            const raw = typeof snapshot?.raw === 'string' ? snapshot.raw : '';
            return { raw, status: raw ? '' : '【当前正式面为空】本轮没有可供修改的正式节点，不能据此编造节点。', failed: false };
        } catch {
            return { raw: '', status: '【正式面读取失败】本轮无法读取完整正式面，不得据此编造或覆盖正式内容。', failed: true };
        }
    }
    if (projectionReader) {
        try {
            const raw = String(await projectionReader(target) || '');
            return { raw, status: raw ? '' : '【当前正式面为空】本轮没有可供修改的正式节点，不能据此编造节点。', failed: false };
        } catch {
            return { raw: '', status: '【正式面读取失败】本轮无法读取正式面，不得据此编造或覆盖正式内容。', failed: true };
        }
    }
    return { raw: '', status: '【正式面未提供】本轮没有正式面 reader，不能据此编造正式内容。', failed: true };
};

export function createSpaceContext(env = {}) {
    const buildMessages = async ({ target, userMsg, historySnapshot = [], pageId = '1', pages = ['1'] }) => {
        const ctx = env.context?.() || {};
        const userName = ctx.name1 || '用户';
        const charName = ctx.name2 || '角色';
        const message = String(userMsg || '');
        const intent = classifySpaceIntent(message, historySnapshot, { pageId, parseAlmanac: env.parseAlmanac, parseEra: env.parseEra });
        const requested = requestedSpaceMaterials(message);
        const outlineSource = await readOutlineSource(env.readOutlineDraftSnapshot, env.readOutline, target);
        const outlineRaw = outlineSource.raw;
        const outlineStatus = outlineSource.status;
        const outlineRawToken = !outlineSource.failed && typeof env.rawToken === 'function' ? env.rawToken(outlineRaw) : null;
        let pointScopes = await env.readPointScopes?.(target);
        if (!Array.isArray(pointScopes)) {
            const legacyPointRaw = String(env.readPointRaw?.(target) || '');
            pointScopes = legacyPointRaw.trim() ? [{ view: 'user', charName: '', raw: legacyPointRaw, ts: null }] : [];
        }
        const pointList = numberedSpacePointGroups(pointScopes, env.numberedPoints, userName);
        const lineRaw = String(await env.readLineRaw?.(target) || '');
        const lineList = numberedSpaceLineList(lineRaw, env.parseLines);
        const lineBaselines = [...compactLineBaselines(lineRaw, env.parseLines)];
        const ledgerList = await readWithStatus(env.readLedgerText, '刻度', target);
        const storyDate = await readWithStatus(env.readStoryDate, '故事日期', ctx);
        const almanacText = await readWithStatus(env.readAlmanacText, '轴日期', target);
        const calDescText = await readWithStatus(env.readCalendarText, '现行历法', target);
        const calDescForContract = calDescText.startsWith('【现行历法') ? '' : calDescText;
        const materialText = (await Promise.all([
            readWithStatus(env.readColdKnowledge, '冷知识'),
            readWithStatus(env.readDailyMenu, '今天吃点啥'),
            readWithStatus(env.readWardrobe, '衣橱'),
            readWithStatus(env.readTheater, '棱作品与模板', target, ctx, message),
            readWithStatus(env.readCoordinates, '坐标', target, ctx, message),
        ])).concat([outlineStatus, calDescText.startsWith('【现行历法') ? calDescText : '']).filter(Boolean).join('\n\n');
        const settings = env.settings?.() || {};
        const faqText = buildSpaceHelpText(settings);
        const characterData = env.readCharacterData?.(ctx) || '';
        const memText = await env.readMemory?.(ctx, message) || '';
        const recentCtx = await env.readRecent?.(ctx) || '';
        const { personaDesc = '', authorNote = '' } = env.readCardExtras?.(ctx) || {};
        const useCharacterPersona = settings.spaceUseCharacterPersona === true;
        const personaOverride = useCharacterPersona ? '' : String(settings.spacePersona || '').trim();
        const historyMessages = stripWidgetsForApi(historySnapshot, { preserveCandidates: true });
        const lastHistory = historyMessages.at(-1);
        if (lastHistory?.role === 'user' && String(lastHistory.content ?? '').trim() === message.trim()) historyMessages.pop();
        const titleSupplementText = [message, ...historyMessages.map(item => String(item?.content ?? '')), outlineRaw, pointList, lineList, ledgerList, memText, recentCtx, personaDesc, characterData, authorNote, almanacText, calDescText, storyDate, materialText, personaOverride].filter(Boolean).join('\n\n');
        const wiContext = await env.readWorldInfo?.(ctx, message, historySnapshot.slice(0, -1), titleSupplementText) || '';
        const system = buildSpaceChatSystemPrompt({ userName, charName, personaDesc, characterData, authorNote, storyDate, outlineRaw, wiContext, memText, recentCtx, pointList, lineList, ledgerList, almanacText, calDescText: calDescForContract, materialText, requestedMaterials: requested, faqText, personaOverride, useCharacterPersona, preferences: env.preferences?.(ctx) || { direction: env.lineDirection?.(ctx) || 'natural' }, intent });
        const sharedPages = pages.length > 1 || historySnapshot.some(item => spacePageId(item) === '2');
        const pageNote = sharedPages ? `\n【讨论窗口】当前在窗口${pageId}。以下两窗口记录按实际先后共享；窗口标记表示来源，不表示连续问答。` : '';
        const apiHistory = sharedPages ? historyMessages.map((item, index) => ({ ...item, content: `【窗口${spacePageId(historySnapshot[index])}】\n${item.content}` })) : historyMessages;
        const messages = [{ role: 'system', content: system + pageNote }, ...apiHistory, { role: 'user', content: userMsg }];
        Object.defineProperty(messages, 'pointBaselines', { value: compactPointBaselines(pointScopes), enumerable: false });
        Object.defineProperty(messages, 'lineBaselines', { value: Object.freeze(lineBaselines), enumerable: false });
        Object.defineProperty(messages, 'allowedWidgetKinds', { value: Object.freeze([...SPACE_WIDGET_KINDS]), enumerable: false });
        if (outlineRawToken) Object.defineProperty(messages, 'outlineRawToken', { value: outlineRawToken, enumerable: false });
        return messages;
    };
    return Object.freeze({ buildMessages });
}
