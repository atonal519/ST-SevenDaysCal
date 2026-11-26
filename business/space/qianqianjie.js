import { captureQianQianJieHostIdentity, QIANQIANJIE_BRIDGE_KEY, QIANQIANJIE_READ_TIMEOUT_MS } from '../memory/qianqianjie.js';
import { createDeadlineSignal, waitForSignal } from '../../runtime/deadline.js';

const QIANSHI_BRIDGE_KEY = 'qqj_qianshi_backend_v1';
const MODULES = { memory: '千结', people: '千人', affairs: '千事', prompt: '正文召回与前情', worldbook: '千千结可读世界书' };
const PROFILE_FIELDS = {
    name: '姓名', aliases: '别名', gender: '性别', age: '年龄', birthday: '生日', bloodType: '血型', zodiac: '星座', species: '种族', notes: '备注',
    height: '身高', weight: '体重', build: '体型', face: '面容', hair: '头发', eyes: '眼睛', distinctiveFeatures: '辨识特征', clothingStyle: '衣着', appearance: '外貌',
    occupation: '职业', organization: '所属', socialIdentity: '社会身份', background: '经历背景', identityRelations: '身份关系',
    nationality: '国籍', birthplace: '出生地', residence: '常住地', languages: '使用语言', skills: '技能与能力',
    personality: '性格', conduct: '处事方式', expression: '表达习惯', likes: '喜好', dislikes: '厌恶', principles: '原则',
    mbti: 'MBTI', enneagram: '九型人格', alignment: '道德阵营', nsfw: '成人资料',
};
const STATE_LABELS = { core: '核心', adaptive: '经历变化', situational: '情境' };
const VISIBILITY = { authorial: '作者侧', private: '本人私密', shared: '已共享', expressed: '已表达', observable: '可观察' };
const ACTIONS = { add: '增加', update: '更新', refine: '调整', remove: '移除' };
const EVENT_STATUS = { planned: '计划中', inProgress: '进行中', completed: '已完成', occurred: '已发生', cancelled: '已取消', abandoned: '已放弃', unknown: '未知' };
const MAX_EVIDENCE = 7000;
const MAX_ROWS = 22;
const text = value => typeof value === 'string' ? value.trim() : '';
const list = value => Array.isArray(value) ? value : [];
const validFloor = value => Number.isSafeInteger(value) && value >= 0;
const note = value => String(value ?? '').slice(0, 1000).replace(/[\uD800-\uDBFF]$/, '');
const usableBridge = (bridge, kind) => bridge?.schemaVersion === 1 && bridge.kind === kind && typeof bridge.getSnapshot === 'function';
const sameHost = (a, b) => a?.hostChatId === b?.hostChatId && a?.characterLocator === b?.characterLocator && a?.personaLocator === b?.personaLocator;
const matchesHost = (identity, host) => !!identity?.qqjChatId && identity.hostChatId === host.hostChatId
    && identity.characterLocator === host.characterLocator && (!host.personaLocator || identity.personaLocator === host.personaLocator);
const sameSource = (left, right) => sameHost(left, right) && left?.qqjChatId === right?.qqjChatId;

const MODULE_NAMES = /千千结|千结|千人|千事/gu;
const NO_LOOKUP = /(?:不用|无需|无须|不必|别|不要|先不|没让你)\s*(?:(?:去|帮我|再)\s*)?(?:查|看|翻|读|调取|搜索|用)|(?:不要|别|不用|无需|不必)\s*(?:用|看|查)?\s*(?:千千结|千结|千人|千事)/u;
const HELP = /(?:千千结|千结|千人|千事)\s*(?:(?:这个|的)\s*)?(?:插件|功能|模块|用法)?\s*(?:是什么|什么意思|(?:怎么|如何)(?:安装|配置|启用|使用|用|打开)|设置在哪|开关在哪|插件版本|能(?:不)?能读取)|(?:安装|配置|启用|更新|关闭)(?:一下)?(?:千千结|千结|千人|千事)(?:插件)?[。！!？?]?$/u;
const NAMED_LOOKUP = /(?:查(?:看|找|阅|询|一?下|一查|查)?|核对|考证|检索|搜索|调取|翻(?:看|找|一下|一翻)|读(?:取|一读|一下)|从|根据|用|参考|看看|看一下)\s*(?:一下\s*)?(?:千千结|千结|千人|千事)|(?:千千结|千结|千人|千事)\s*(?:的?\s*)?(?:资料|记录|记载|档案|摘要|变化|状态|事项|事件|里|中|上|记了|有什么|有哪些|有记录)|(?:去|到)\s*(?:千千结|千结|千人|千事)[^。！？?，]{0,20}(?:查|看|找|有没有|是否)[^。！？?，]{0,20}(?:档案|记录|资料|摘要|事件|事项|状态)/u;
const STORY_LOOKUP = /^(?:请(?:帮我)?|帮我|麻烦(?:你)?|能不能)?\s*(?:查(?:一下|一查|查)|查阅|翻(?:一下|看|找)|核对一下|搜一下)[^。！？?]*(?:旧楼|来源楼|历史剧情|已存(?:记忆|摘要|事件|档案)|之前发生|以前发生|(?:记得|讲过|答应过|已经发生).{0,12}(?:什么|哪|谁))/u;
const OTHER_SOURCE = /(?:查|核对|翻|搜)(?:一?下)?\s*(?:世界书|日历|历法|刻度|日程|大纲|冷知识|坐标|天气|网络|网页|百度|谷歌|系统设置)/u;
const CITATION = /(?:出处|来源|几楼|哪一?个?楼|源楼|哪一?层|哪一?条记录)/u;
const FOLLOW_UP = /(?:后来|之后|然后|接着|此前|之前|随后|结果|当时|那时|这些|这(?:个|件|条|段)|那(?:件|个|条|段|人|笔|次|天|本)|刚才|上面|刚说|前面|说过|答应|还记得|还知道|为什么|最后|怎么了|结局|出处|来源|几楼|哪一?楼|第\s*\d+\s*楼|(?:^|[，。\s])(?:他|她|它|他们|她们)(?:也|还|又|的|是|有|曾|当|后|去|说|做|为|知|答))/u;
const CHANGE_TOPIC = /(?:换(?:个|一个)话题|聊点别的|不聊(?:了|这)|先不说|话说回来|说点别的)/u;
const CREATIVE_REQUEST = /(?:帮我|请|再|接着|然后|^)(?:写(?:一段|一个|个)|续写|生成|想(?:个|一个)|设计|润色|翻译|检查(?:错别字|语法))/u;
const FILLER = /请帮我|麻烦你|能不能|可以吗|告诉我|帮我|查查看|查一下|查一查|查查|核对一下|看看|看一下|查阅|检索|调取|查|查询|记录(?:里|中)?|里面|资料|一下|一下子|有没有|是什么|什么|怎么|怎么样|哪(?:些|个|条|次)|哪个|谁|为何|为什么|怎样|第\s*\d+\s*楼|AI\s*#?\s*\d+|后来|之后|然后|之前|当时|这件事|那件事|这次|那个|这个|最近|最新|当前|目前|所有|全部|过去|以前|此事|的|吗|呢|呀|啊/giu;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
function terms(value) {
    const clean = text(value).toLowerCase().replace(MODULE_NAMES, ' ').replace(CHANGE_TOPIC, ' ').replace(FILLER, ' ');
    const words = segmenter ? [...segmenter.segment(clean)].filter(part => part.isWordLike).map(part => part.segment) : clean.match(/[\p{L}\p{N}]+/gu) || [];
    const pairs = (clean.match(/\p{Script=Han}{2,}/gu) || []).flatMap(sequence => {
        const chars = [...sequence];
        return chars.slice(1).map((char, index) => chars[index] + char);
    });
    return [...new Set([...words.filter(word => word.length > 1), ...pairs])].slice(0, 36);
}

function lookupRequest(message, prior) {
    if (NO_LOOKUP.test(message) || HELP.test(message)) return null;
    const lookupText = message.replace(/(?:[零〇一二两三四五六七八九十百]|\d)千人/gu, '');
    const names = [];
    if (/千结/u.test(lookupText.replace(/千千结/gu, ''))) names.push('memory');
    if (/千人/u.test(lookupText)) names.push('people');
    if (/千事/u.test(lookupText)) names.push('affairs');
    const named = names.length > 0 || /千千结/u.test(lookupText);
    const recent = /(?:上(?:一)?[次轮回]|刚才|最近一轮)/u.test(message);
    const asksMaterial = /(?:召回|前情|提示词材料)/u.test(message) && /(?:用了|带了|纳入|注入|取材|哪些|是什么|查|看|列出)/u.test(message);
    const prompt = recent && (asksMaterial || /(?:正文|主楼)(?:实际|到底)?(?:用了|读了|带了|注入了)(?:哪些|什么|啥)/u.test(message));
    const floorQuery = /(?:\d+\s*楼|AI\s*#?\s*\d+)/iu.test(message);
    const newTopic = lookupText.replace(/^\s*(?:换(?:个|一个)话题|话说回来)[，,：:\s]*/u, '');
    const identifiesFromWorldbook = /千千结/u.test(message) && /世界书/u.test(message) && /辨认|识别|区分.{0,8}角色/u.test(message);
    const asksAvatar = /(?:^|[，。！？])\s*(?:请(?:帮我)?|帮我|我想)?\s*(?:看|看看|看一下|查看|描述)[^，。！？?]{0,20}头像|头像[^，。！？?]{0,12}(?:有吗|有没有|什么样|长什么样|是啥样|什么颜色)/u.test(message);
    const avatarPresence = /有没有(?:保存)?头像|是否(?:有|保存了?)头像|有(?:保存(?:的)?|已存(?:的)?)头像|头像(?:还在吗|有吗|有没有)/u.test(message);
    if (prompt || identifiesFromWorldbook || asksAvatar || NAMED_LOOKUP.test(lookupText) || !OTHER_SOURCE.test(message) && STORY_LOOKUP.test(newTopic) || named && floorQuery) {
        const modules = prompt ? ['prompt'] : identifiesFromWorldbook ? ['worldbook'] : names.length ? names : asksAvatar ? ['people'] : floorQuery ? ['memory', 'affairs'] : ['memory', 'people', 'affairs'];
        const avatar = modules.includes('people') && /头像/u.test(message);
        return { modules, query: prior?.modules.includes('people') && /这张头像/u.test(message) ? prior.query : note(message), avatar, viewAvatar: avatar && asksAvatar && !avatarPresence, prior: null };
    }
    if (!prior || CHANGE_TOPIC.test(message) || CREATIVE_REQUEST.test(message) || !FOLLOW_UP.test(message)) return null;
    const words = terms(message);
    const relevantWords = terms(prior.query);
    const anchored = words.some(word => relevantWords.includes(word) || prior.material.toLowerCase().includes(word));
    const implicit = /^(?:(?:那|所以|以及|另外)\s*)?(?:(?:他|她|它|这(?:些|件事|个)?|那(?:件事|个人|条|个))\s*)?(?:后来|之后|然后|接着|刚才|当时|最后|结果|出处|来源|为什么|还|又|(?:在|是)?\s*(?:第?几楼|哪一?楼))/u.test(message);
    if (!anchored && !(implicit && words.length <= 2)) return null;
    const citation = CITATION.test(message) && words.length <= 2 && !/还有|另外|最早|最后|然后|后续|之前/u.test(message);
    const modules = [...new Set([...prior.modules, ...(/答应|承诺|得知|私下|行动/u.test(message) ? ['memory'] : [])])];
    return { modules, query: prior.query, avatar: false, prior, citation };
}

function historicMemoryRows(value, query, locate) {
    const section = text(value).split('[长期剧情记忆]')[1]?.split(/\n\s*\[/u)[0] || '';
    const rows = [];
    let source = null;
    for (const line of section.split('\n')) {
        const heading = /^- AI\s*#(\d+)(?:（(.*?)）)?/u.exec(line);
        if (heading) {
            source = locate(null, null, Number(heading[1]));
            if (heading[2] && /时间锚|纪年|剧情时间|哪[天日]|何时/u.test(query)) rows.push({ title: '长期记忆的时间锚', body: heading[2] + line.slice(heading[0].length), source });
        } else if (source && /未结线索|未结事项|开放线索|没结的线索/u.test(query) && /^\s+- 未结事项/u.test(line)) {
            rows.push({ title: '来源楼当时的未结线索', body: line.trim().slice(2), source });
        }
    }
    const subject = query.replace(/长期记忆|时间锚|纪年|剧情时间|何时|哪[天日]|未结线索|未结事项|开放线索|没结的线索|有(?:哪些|什么)/gu, '');
    return rankRows(rows, subject).slice(0, 6);
}

function sourceLookup(main, affairs) {
    const ids = new Map(), sequences = new Map();
    const add = (id, seq, index) => {
        if (!validFloor(index)) return;
        if (id) ids.set(id, ids.has(id) && ids.get(id) !== index ? null : index);
        if (validFloor(seq)) sequences.set(seq, sequences.has(seq) && sequences.get(seq) !== index ? null : index);
    };
    for (const floor of [...list(main.memory?.floors), ...list(main.cse?.floors)]) add(floor.floorId, floor.assistantSeq, floor.messageIndex);
    for (const event of list(affairs?.events)) if (!event.frozen) add(event.sourceFloorId, event.sourceAssistantSeq, event.sourceMessageIndex);
    const locate = (index, id, seq, archived = false) => {
        const floor = validFloor(index) ? index : archived ? null : (id ? ids.get(id) : sequences.get(seq));
        return { floor, seq, label: `${validFloor(floor) ? `${archived ? '归档原聊天' : '宿主'}第 ${floor} 楼` : '宿主楼号未知'}${validFloor(seq) ? `（AI #${seq}）` : ''}` };
    };
    const withFloors = value => text(value).replace(/（(AI\s*#\d+(?:、AI\s*#\d+)*)(?=[；）])/gu,
        (_match, label) => `（${label.replace(/AI\s*#(\d+)/gu, (_seq, seq) => locate(null, null, Number(seq)).label)}`);
    return { locate, withFloors };
}

function rankRows(rows, query, { recent = false } = {}) {
    const words = terms(query);
    const normalized = query.toLowerCase();
    const floor = /(?:第\s*)?(\d+)\s*楼/u.exec(query);
    const seq = /AI\s*#?\s*(\d+)/iu.exec(query);
    return rows.flatMap((row, index) => {
        if (floor && row.source?.floor !== Number(floor[1]) || seq && row.source?.seq !== Number(seq[1])) return [];
        const title = row.title.toLowerCase(), corpus = `${title}\n${row.body.toLowerCase()}`;
        const exact = list(row.keywords).filter(word => word && normalized.includes(word.toLowerCase())).length;
        const score = words.reduce((sum, word) => sum + (title.includes(word) ? 3 : corpus.includes(word) ? 1 : 0), exact * 10);
        return score || floor || seq || !words.length || recent ? [{ row, index, score }] : [];
    }).sort((a, b) => b.score - a.score || (b.row.source?.floor ?? -1) - (a.row.source?.floor ?? -1) || a.index - b.index).map(item => item.row);
}

function peopleForQuery(people, query) {
    const normalized = query.toLowerCase();
    const names = new Map();
    for (const person of people) for (const name of [person.displayName, person.entityDisplayName, person.profile?.name, ...list(person.aliases)].map(value => text(value).toLowerCase()).filter(Boolean)) {
        if (!names.has(name)) names.set(name, new Set());
        names.get(name).add(person.entityId);
    }
    const candidates = [...names.keys()].sort((left, right) => right.length - left.length);
    const ids = new Set();
    const word = value => /[a-z0-9_]/iu.test(value || '');
    for (let at = 0; at < normalized.length;) {
        const name = candidates.find(value => normalized.startsWith(value, at)
            && !(word(value[0]) && word(normalized[at - 1])) && !(word(value.at(-1)) && word(normalized[at + value.length])));
        if (!name) { at += normalized.codePointAt(at) > 0xffff ? 2 : 1; continue; }
        const owners = names.get(name);
        if (owners.size === 1) ids.add([...owners][0]);
        at += name.length;
    }
    return [...ids];
}

function profileRows(people, namedIds, locate, query) {
    return people.filter(person => !namedIds.length || namedIds.includes(person.entityId)).flatMap(person => {
        const name = text(person.displayName) || text(person.entityDisplayName);
        if (!name) return [];
        const manual = new Set(list(person.profile?.manualFields));
        const fields = Object.entries(PROFILE_FIELDS).map(([field, label]) => {
            const value = text(person.profile?.[field]);
            return value || manual.has(field) ? { field, label, value: `${label}${manual.has(field) ? '（人工）' : ''}：${value || '已明确清空'}` } : null;
        }).filter(Boolean).sort((a, b) => Number(query.includes(b.label)) - Number(query.includes(a.label)));
        const aliases = list(person.aliases).filter(value => text(value)).join('、');
        const brief = !fields.some(row => !['name', 'aliases'].includes(row.field)) ? text(person.identityBrief) : '';
        const lines = fields.map(row => row.value);
        if (brief) lines.push(`作者侧简介：${brief}（${person.identityBriefSource?.legacy ? '历史简介，未保存引文' : locate(null, person.identityBriefSource?.sourceFloorId).label}）`);
        const header = `人物档案：${name}${aliases ? `（别名：${aliases}）` : ''}`;
        return [{ title: header, body: lines.join('\n') || '暂无已存文字档案' }];
    });
}

function stateRows(main, locate, namedIds, query) {
    const names = new Map(list(main.people?.items).map(person => [person.entityId, person.displayName]));
    const stateDetail = item => {
        if (!text(item?.text)) return '';
        const range = value => Number.isFinite(value) && value >= 0 && value <= 100;
        const { strength, emotions = {}, expression } = item.quantification || {};
        const emotionLabel = Object.entries(emotions).filter(([, value]) => range(value)).map(([name, value]) => `${name}${value}`).join('、');
        const toward = text(item.towardDisplayName) || names.get(item.towardEntityId) || (item.towardEntityId ? '已指向特定人物，名称未提供' : '');
        return [text(item.text), VISIBILITY[item.visibility], toward && `对象：${toward}`, text(item.reason) && `依据：${item.reason}`,
            range(strength) && `倾向强度：${strength}`, emotionLabel && `情绪强度：${emotionLabel}`, range(expression) && `外露程度：${expression}`].filter(Boolean).join('｜');
    };
    const namesMatch = id => !namedIds.length || namedIds.includes(id);
    const current = list(main.cse?.currentSubjects).filter(person => namesMatch(person.subjectEntityId)).flatMap(person => Object.entries(STATE_LABELS).flatMap(([key, label]) => list(person[key]).map(item => ({
        title: `${person.displayName}的${main.cse?.ready === true ? '当前状态' : '已存状态（覆盖未齐）'} · ${label}`, body: stateDetail(item), source: locate(null, item.sourceFloorId, item.sourceAssistantSeq),
    }))));
    const history = list(main.cse?.floors).flatMap(floor => {
        const source = locate(floor.messageIndex, floor.floorId, floor.assistantSeq);
        if (floor.changesKnown !== true || !list(floor.changes).length) {
            if (!/(?:\d+\s*楼|AI\s*#?\s*\d+)/iu.test(query)) return [];
            const snapshots = list(floor.savedSubjects).filter(person => namesMatch(person.subjectEntityId)).flatMap(person => Object.entries(STATE_LABELS).flatMap(([key, label]) => list(person[key]).map(item => `${person.displayName} · ${label}：${stateDetail(item)}`)));
            return [{ title: '该楼状态变化', body: [floor.changesKnown === true ? '已确认无变化' : '未保存逐项变化，变化未知', snapshots.length ? `这楼保存的状态（历史）\n${snapshots.join('\n')}` : ''].filter(Boolean).join('\n'), source }];
        }
        return list(floor.changes).filter(person => namesMatch(person.subjectEntityId)).flatMap(person => list(person.changes).map(change => ({
            title: `${person.displayName}的历史变化 · ${STATE_LABELS[change.category] || change.category} · ${ACTIONS[change.action] || change.action}`,
            body: [stateDetail(change.before) && `此前：${stateDetail(change.before)}`, stateDetail(change.after) && `此后：${stateDetail(change.after)}`].filter(Boolean).join('\n'), source,
        })));
    });
    return { current, history };
}

function affairRows(snapshot, query, locate) {
    const eventRows = list(snapshot.events).filter(event => !event.followingReviewOfEventId).map(event => ({
        id: event.id, matterId: event.matterId, title: text(event.title) || '已存事件', source: locate(event.sourceMessageIndex, event.sourceFloorId, event.sourceAssistantSeq, event.frozen),
        body: [text(event.description), text(event.object), list(event.people).map(person => text(person.name)).filter(Boolean).join('、'),
            text(event.storyTime) && `记载时间：${event.storyTime}`, text(event.scheduledTime) && `计划／期限：${event.scheduledTime}`,
            (event.actionStatus || event.status) && `动作状态：${EVENT_STATUS[event.actionStatus || event.status] || event.actionStatus || event.status}`].filter(Boolean).join('｜'),
    }));
    const byId = new Map(eventRows.map(row => [row.id, row]));
    const matters = list(snapshot.matters).filter(matter => matter.following || matter.origin?.eventId !== matter.currentNarrativeEventId || matter.currentEventId || list(matter.recordIds || matter.eventIds).length > 1)
        .map(matter => ({ title: `事项：${matter.title}`, matter, body: [matter.description, matter.origin?.description, matter.object,
            list(matter.people).map(person => person.name).join('、'), matter.storyTime, matter.scheduledTime].filter(Boolean).join('｜'),
        source: byId.get(matter.currentEventId || matter.currentNarrativeEventId)?.source || locate(null, matter.sourceFloorId, matter.sourceAssistantSeq) }));
    const following = /还在跟进|正跟进|仍在跟进|仍关注|还在关注|当前跟进|跟进事项|哪些(?:在)?跟进/u.test(query);
    const incomplete = /没完成|未完成|没了结|未了结|尚未完成|还没做完|未办完|待办|进行中/u.test(query);
    const stateFilter = following || incomplete;
    const activeMatters = following ? matters.filter(row => row.matter.following === true)
        : incomplete ? matters.filter(row => ['planned', 'inProgress'].includes(row.matter.status)) : matters;
    const subjectQuery = query.replace(/(?:还有|都有|还|都|有)?哪些|还有什么|还在|仍在|仍|当前|跟进(?:事项)?|正跟进|关注|没完成|尚未完成|未完成|没了结|未了结|还没做完|未办完|待办|进行中/gu, '');
    const asksLatest = /(?:最[新近]|近来)(?:发生了?(?:的事件|的事|什么|哪些)?|的事件|有什么|有哪些)/u;
    if (!stateFilter && asksLatest.test(query)) {
        const timeline = snapshot.timeline;
        if (timeline?.hasGlobalLatest) {
            const groups = list(timeline.segments).flatMap(segment => list(segment.groups));
            const latest = groups.findIndex(group => group.id === timeline.globalLatestGroupId);
            for (let index = latest; index >= 0; index--) {
                const group = groups[index];
                const found = rankRows(list(group.eventIds).map(id => byId.get(id)).filter(Boolean), query.replace(asksLatest, ''));
                if (found.length) return found.slice(0, 8);
            }
        }
    }
    const events = stateFilter ? [] : rankRows(eventRows, query, { recent: /最新|最近/u.test(query) }).slice(0, 6);
    const matchedMatters = new Set(events.map(event => event.matterId).filter(Boolean));
    const selectedMatters = [...new Set([...activeMatters.filter(row => matchedMatters.has(row.matter.matterId)), ...rankRows(activeMatters, stateFilter ? subjectQuery : query)])].slice(0, 4);
    const result = [...events];
    for (const { title, matter, source } of selectedMatters) {
        result.push({ title, body: [text(matter.description), matter.status && `整线状态：${EVENT_STATUS[matter.status] || matter.status}`,
            matter.following === true ? '仍在跟进' : '未关注', text(matter.scheduledTime) && `计划／期限：${matter.scheduledTime}`].filter(Boolean).join('｜'), source });
        const ids = list(matter.recordIds || matter.eventIds);
        for (const id of new Set([matter.origin?.eventId, ...ids.slice(-3), matter.currentEventId, matter.currentNarrativeEventId])) {
            const row = byId.get(id);
            if (row && !result.includes(row)) result.push(row);
        }
    }
    const selected = new Set(result.map(row => row.id).filter(Boolean));
    const discardedRelations = new Set(list(snapshot.diagnostics?.discardedOrderRelations));
    for (const relation of list(snapshot.relations)) {
        if (discardedRelations.has(relation.id)) continue;
        const from = byId.get(relation.fromEventId), to = byId.get(relation.toEventId);
        if (!from || !to || !selected.has(from.id) && !selected.has(to.id)) continue;
        const type = relation.type === 'before' ? '先于' : relation.type === 'progress' ? '后续进展' : '';
        if (type) result.push({ title: '已存事件关系', body: `${from.title}（${from.source.label}） → ${type} → ${to.title}（${to.source.label}）${relation.certainty ? `｜${relation.certainty === 'explicit' ? '明确' : '强关联'}` : ''}` });
    }
    return result;
}

function formatModules(sections) {
    let used = 0, hasRows = false;
    const nonempty = sections.filter(section => section.rows?.some(row => text(row.body)));
    const material = sections.map(({ module, rows = [], problem = '' }, index) => {
        const heading = `【${MODULES[module]}】`;
        const later = sections.slice(index + 1);
        const reserve = later.filter(section => nonempty.includes(section)).length * 1200 + later.length * 100;
        const remaining = MAX_EVIDENCE - used - reserve - 120;
        let body = '';
        for (const row of rows.slice(0, MAX_ROWS)) {
            if (!text(row.body)) continue;
            const label = `\n${row.title}${row.source ? `｜${row.source.label}` : ''}\n`;
            const room = remaining - body.length - label.length;
            if (row.body.length <= room) body += label + row.body;
            else if (!body && room > 120) body = `${label}${row.body.slice(0, room - 6).replace(/[\uD800-\uDBFF]$/, '')}…（摘录）`;
        }
        hasRows ||= !!body;
        const rendered = `${heading}${body || '\n本轮未找到可支持该问题的已存资料。'}${problem ? `\n${problem}` : ''}`;
        used += rendered.length + 2;
        return rendered;
    }).join('\n\n');
    return { material, hasRows };
}

const unavailable = (modules, reason) => formatModules(modules.map(module => ({ module, problem: reason }))).material;
export function normalizeSpaceQianQianJieEvidence(value) {
    if (!text(value?.id) || !text(value.identity?.hostChatId) || !text(value.identity?.qqjChatId) || !text(value.query) || !text(value.material)) return null;
    const modules = [...new Set(list(value.modules).filter(module => Object.hasOwn(MODULES, module)))];
    if (!modules.length) return null;
    const { hostChatId, characterLocator, personaLocator, qqjChatId } = value.identity;
    return { id: text(value.id).slice(0, 100), identity: { hostChatId, characterLocator: text(characterLocator), personaLocator: text(personaLocator), qqjChatId },
        modules, query: note(value.query), material: text(value.material).slice(0, MAX_EVIDENCE).replace(/[\uD800-\uDBFF]$/, '') };
}

export function createSpaceQianQianJieReader({ globalRef = globalThis, contextProvider, timeoutMs = QIANQIANJIE_READ_TIMEOUT_MS } = {}) {
    return async ({ message, target, ctx, priorEvidence, signal }) => {
        const host = captureQianQianJieHostIdentity(ctx);
        const prior = normalizeSpaceQianQianJieEvidence(priorEvidence);
        const request = lookupRequest(message, prior && matchesHost(prior.identity, host) ? prior : null);
        if (!request || signal?.aborted) return null;
        const current = () => !signal?.aborted && sameHost(host, captureQianQianJieHostIdentity(contextProvider?.() || ctx));
        if (!host.hostChatId || ctx.groupId || ctx.group_id || (target?.chatId && target.chatId !== host.hostChatId) || !current()) {
            return { material: unavailable(request.modules, '当前单聊身份不可核对。') };
        }
        const bridge = globalRef[QIANQIANJIE_BRIDGE_KEY];
        const stillCurrent = () => current() && bridge === globalRef[QIANQIANJIE_BRIDGE_KEY];
        const readStatus = () => {
            try { return bridge?.getStatus?.(); } catch { return null; }
        };
        if (request.citation) {
            const status = readStatus();
            if (!stillCurrent() || status?.status === 'ready' && !sameSource(status.identity, prior.identity)) {
                return { material: unavailable(request.modules, '上次查阅的资料已无法与当前千千结聊天核对。') };
            }
            return { material: `【上次查到的来源】\n${prior.material}`, evidenceRef: prior.id };
        }
        if (!usableBridge(bridge, 'qqj-public-memory-bridge')) return { material: unavailable(request.modules, '当前没有可用的千千结只读接口。') };
        const deadline = createDeadlineSignal({ signal, timeoutMs });
        const read = async reader => {
            if (!reader || deadline.signal.aborted) return null;
            try { return await waitForSignal(reader(), deadline.signal); }
            catch { return null; }
        };
        try {
            const needMemorySnapshot = request.modules.some(module => module === 'memory' || module === 'people');
            const snapshot = (!needMemorySnapshot && readStatus()) || await read(() => bridge.getSnapshot());
            if (!stillCurrent() || snapshot?.status !== 'ready' || !matchesHost(snapshot.identity, host)) {
                return { material: unavailable(request.modules, '已存资料未就绪或不属于当前聊天。') };
            }
            const identity = snapshot.identity;
            const query = request.prior ? `${request.query}\n${note(message)}` : request.query;
            const people = list(snapshot.people?.items);
            const namedIds = peopleForQuery(people, query);
            const qianshi = globalRef[QIANSHI_BRIDGE_KEY];
            const needsLongMemory = request.modules.includes('memory') && /时间锚|未结线索|未结事项|开放线索|没结的线索/u.test(message);
            const [rawAffairs, context, prompt, avatars, worldbook, historicMemory] = await Promise.all([
                request.modules.includes('affairs') && usableBridge(qianshi, 'qqj-qianshi-backend-bridge') ? read(() => qianshi.getSnapshot()) : null,
                request.modules.includes('memory') && typeof bridge.readContext === 'function' ? read(() => bridge.readContext({ query, focusQuery: message, entityIds: namedIds, participantNames: [ctx.name1, ctx.name2].filter(Boolean), maxCharacters: MAX_EVIDENCE, maxSummaries: 10, summaryCharacters: 3000 })) : null,
                request.modules.includes('prompt') && typeof bridge.getPromptSnapshot === 'function' ? read(() => bridge.getPromptSnapshot()) : null,
                request.avatar && namedIds.length && typeof bridge.getPeopleAvatars === 'function' ? read(() => bridge.getPeopleAvatars(namedIds)) : null,
                request.modules.includes('worldbook') && typeof bridge.readWorldInfo === 'function' ? read(() => bridge.readWorldInfo()) : null,
                needsLongMemory && typeof bridge.readMemory === 'function' ? read(() => bridge.readMemory()) : null,
            ]);
            const after = readStatus();
            if (!stillCurrent() || after?.status === 'ready' && !sameSource(after.identity, identity)) return null;
            const belongs = value => value?.status === 'ready' && sameSource(identity, value.identity);
            const affairs = rawAffairs?.status === 'ready' && rawAffairs.identity?.qqjChatId === identity.qqjChatId && qianshi === globalRef[QIANSHI_BRIDGE_KEY] ? rawAffairs : null;
            const { locate, withFloors } = sourceLookup(snapshot, affairs);
            const images = [];
            const sections = request.modules.map(module => {
                if (module === 'affairs') return { module, rows: affairs ? affairRows(affairs, query, locate) : [], problem: affairs ? '' : '当前聊天的千事资料不可用。' };
                if (module === 'prompt') return { module, rows: belongs(prompt) ? [{ title: '上次实际准备的召回', body: text(prompt.recall?.text) }, { title: '上次实际准备的前情', body: text(prompt.prequel?.text) }] : [] };
                if (module === 'worldbook') {
                    const rows = belongs(worldbook) ? list(worldbook.worldbook).map(entry => ({ title: text(entry.comment) || `条目 ${entry.uid}`, body: text(entry.content), keywords: list(entry.keys).map(text) })) : [];
                    return { module, rows: rankRows(rows, `${query} ${ctx.name2 || ''}`).slice(0, 7) };
                }
                const { current: states, history } = stateRows(snapshot, locate, namedIds, query);
                if (module === 'people') {
                    const peopleQuery = query.replace(/档案|人物|资料|记录|头像|是否已经保存|有没有保存/gu, '');
                    const rows = [...rankRows(profileRows(people, namedIds, locate, query), peopleQuery, { recent: !!namedIds.length }).slice(0, 5), ...rankRows(states, query).slice(0, 8)];
                    if (request.avatar && belongs(avatars)) for (const person of people.filter(person => namedIds.includes(person.entityId))) {
                        if (!Object.hasOwn(avatars.avatarsByEntityId || {}, person.entityId)) continue;
                        const image = avatars.avatarsByEntityId[person.entityId];
                        if (request.viewAvatar && /^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/iu.test(image || '') && images.length < 4) {
                            images.push({ name: person.displayName, url: image });
                        }
                        rows.unshift({ title: `${person.displayName}的头像`, body: image ? '有已保存头像' : '没有已保存头像' });
                    }
                    return { module, rows };
                }
                const summaries = rankRows(list(snapshot.memory?.floors).map(floor => ({ title: floor.summarySource === 'user' ? '人工摘要' : '楼层摘要', body: typeof floor.summary === 'string' ? floor.summary : '', source: locate(floor.messageIndex, floor.floorId, floor.assistantSeq) })), query, { recent: /最新|最近/u.test(query) }).slice(0, 8);
                const changes = rankRows(history, query).slice(0, 7);
                const experiences = belongs(context) ? list(context.actors).filter(actor => !namedIds.length || namedIds.includes(actor.entityId)).flatMap(actor => text(actor.memoryText).split('\n').filter(Boolean).map(body => ({ title: `${actor.displayName}的本人经历或知情记录`, body: withFloors(body) }))) : [];
                const fallback = !summaries.length && belongs(context) && text(context.routerText) ? [{ title: '作者侧已发生背景', body: withFloors(context.routerText) }] : [];
                const selectedStates = rankRows(states, query).slice(0, 5);
                const rows = /私下|私密|心里|承诺|答应|知道|得知|行动|做过/u.test(message) ? [...experiences, ...summaries, ...changes, ...selectedStates]
                    : /变化|变成|改变/u.test(message) ? [...changes, ...summaries, ...experiences, ...selectedStates]
                        : [...summaries, ...changes, ...experiences, ...selectedStates];
                const historic = belongs(historicMemory) ? historicMemoryRows(historicMemory.text, query, locate) : [];
                return { module, rows: [...historic, ...rows, ...fallback] };
            });
            const { material, hasRows } = formatModules(sections);
            const evidence = hasRows ? normalizeSpaceQianQianJieEvidence({ id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
                identity, modules: request.modules, query, material }) : null;
            return { material, evidence, images };
        } finally { deadline.dispose(); }
    };
}
