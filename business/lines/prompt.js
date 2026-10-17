import { parseLines, serializeLines, TERMINAL_LINE_STAGES } from './schema.js';
import { AUTO_LINE_CAPACITY } from './capacity.js';
import { stripInternalLineLines, ticketFromCue } from './vectors/codec.js';
import { adultPromptGuidance } from './adult.js';
import { lineDirectionContract } from './direction.js';
import { narrativePaceContract, narrativeScaleGuidance } from '../narrative-preferences.js';

export const LINE_NEXT_RELEASE_CONTRACT = 'Next: 一句前瞻信号或 stall=true 的恢复条件';
export const LINE_RELATIONSHIP_AGENCY_GUIDE = '【人物自主与相互回应】按各自已有动机、边界与处境写主动选择；非玩家人物可主动提议、行动、拒绝、协商或提出有据冲突。未发生的回应不写成事实。角色卡中的强势/服从设定不自动把日常安排、照顾、亲近或一次让步扩写为持续控制、奖惩、依附或承诺；既成事实照实保留，后续不沿标签加码。';
export const LINE_OUTPUT_REVIEW_GUIDE = '【输出前复核】拟稿后自问：计划是否被写成事实？是否替玩家决定未作出的选择？是否把普通互动夸成持续控制或奖惩？有问题就修正。只输出约定结构，不展示复核过程。';
function trackedLinesForPrompt(previousRaw) {
    if (!previousRaw) return '（无）';
    const tracked = parseLines(previousRaw);
    if (!tracked.length) return stripInternalLineLines(previousRaw);
    return serializeLines(tracked.map(line => ({ ...line, pin: false })), { includeCue: false, includeAdult: false });
}
function vectorPromptContext(vectorContext = {}) {
    const pinnedBackground = (vectorContext.pinnedBackground || []).map(line => `- ${line.name}：当前 ${line.desc || '暂无描述'}；后续 ${line.next || '暂无安排'}（本地已保留）`).join('\n') || '（无）';
    const retained = (vectorContext.retained || []).map(line => { const ticket = ticketFromCue(line.cue); return ticket ? `- ${line.name}：${ticket.selections.map(item => `${item.label}（${item.prompt}）`).join('；')}（沿用已有三项影响角度）` : null; }).filter(Boolean).join('\n') || '（无）';
    const legacy = (vectorContext.legacyWithoutCue || []).map(name => `- ${name}`).join('\n') || '（无）';
    const freshTickets = vectorContext.freshTickets || [];
    const renderFresh = (ticket, index, poolLabel = '') => {
        const adult = ticket.adultSelection;
        const adultText = adult ? `；【成人选材】驱动力：${adult.drive}；行为：${adult.behavior}；节奏：${adult.pacing}；场景：${adult.scene}；后果：${adult.consequence}` : '';
        const ticketId = ticket.ticketId || `TICKET-${index + 1}`;
        return `- 临时票据 ID=${ticketId}；分类：${poolLabel || '普通'}；影响角度：${ticket.selections.map(item => `${item.label}（${item.prompt}）`).join('；')}${adultText}`;
    };
    const indexed = freshTickets.map((ticket, index) => ({ ticket, index }));
    const hasPools = indexed.some(({ ticket }) => ticket.adultPool);
    const fresh = indexed.map(({ ticket, index }) => renderFresh(ticket, index, ticket.adultPool === 'nsfw' ? 'NSFW 新线' : ticket.adultPool === 'sfw' ? 'SFW 新线' : '')).join('\n');
    const poolContract = hasPools ? '票据上的 SFW/NSFW 类型由本地确定，不可改写；具体选材遵守上方成人追加合同。' : '';
    const reroll = vectorContext.intent === 'reroll';
    const rerollNames = reroll
        ? (vectorContext.rerollNames || []).map(name => `- ${String(name || '').trim()}`).filter(name => name !== '- ').join('\n') || '（无）'
        : '';
    const rerollAvoidance = reroll ? `\n【上一版自动线主题·仅名称避重】\n${rerollNames}\n以上名称只用于降低上一版主题的优先级、寻找有正文依据的替代角度，不是待推进清单，不得据此还原或照抄旧描述。若连续正文证据确实只支持其中的必要主线，可以保留该主题；不得为了避重编造无依据的人物或事件。` : '';
    return `\n【机器数据：本轮真实唯一 Ticket 与 6×3 Cue】\n票据 Cue 只是影响角度，不能换票、改标签或据票造事。${poolContract}\n${fresh || '（无）'}\n每条新线只用一张不同的本轮真实 Ticket；旧线不填 Ticket。Ticket 不得缺失、重复、改写或伪造 ID。${rerollAvoidance}\n【本地锁线只读背景】\n${pinnedBackground}\n锁线已由本地完整保留，不输出、不改写、不终结、不分票。\n【旧线既有 Cue】\n${retained}\n【旧线无 Cue】\n${legacy}`;
}
export function buildLinesPrompt(userName = '用户', charName = '角色', perspective = 'user', previousRaw = '', scale = 'auto', vectorContext = {}, adultMode = 'off', direction = 'natural', narrativePace = 'free') {
    const seedRun = vectorContext.firstRun === true || vectorContext.intent === 'initial';
    const activeCount = parseLines(previousRaw).filter(line => !line.pin && !TERMINAL_LINE_STAGES.has(line.stage)).length;
    const scaleContract = `【叙事尺度·观察焦点】${narrativeScaleGuidance(scale)}`
        + '尺度只决定观察焦点，不决定冲突强度或故事时间速度；宏观不等于阴谋或冲突，中观不等于组织对抗，微观不等于恋爱。'
        + '用户本轮明确的创作要求优先。以已有正文、记忆与世界设定确立的事实，以及既有主体的动机、资源、行动条件和实际经过的故事时间为依据，自由判断下一变化应当激化、维持、缓和、转向、解决或淡出。既有人物、势力、机构或环境可以在场外合理推进自身进展；正文暂未提及或当前主角未参与不等于停滞，普通场外推演也不等于凭空编造。不要求每条线每轮都变化或升级阶段；分歧、关系张力、彼此试探或立场摩擦不等于必须扩大伤害。阶段只描述生命周期位置，不构成升级命令。没有充分依据时，不得突然扩大伤害或制造不可逆后果；时间跨度须符合已有进程依据。';
    const countContract = seedRun
        ? `首次最多输出 ${AUTO_LINE_CAPACITY} 条；数量按当前剧情证据决定（可为 0 至 ${AUTO_LINE_CAPACITY} 条，不要为凑数硬编）。`
        : vectorContext.intent === 'reroll'
            ? '刷新数量按当前剧情证据决定（可为 0 或多条，不要为凑数硬编）。'
            : `本轮有 ${activeCount} 条未锁且未终态线；数量按当前剧情证据决定（可为 0 或多条，不要为凑数硬编）。`;
    const oldFormatContract = seedRun
        ? ''
        : vectorContext.intent === 'reroll'
            ? '刷新不要求延续旧自动线；旧名只作避重参考，锁线仅作背景。'
            : 'Cue 由本地继承。';
    const progressionContract = vectorContext.intent === 'advance' && activeCount > 0
        ? '\n以更新旧线为主，先合并重复、清退不再独立的旧线。仍有独立后续的未决旧线可维持；暂未提及本身不作退出理由。目标完成可收束，失去独立价值或并线可淡出/省略。新增从少，只补旧线 Desc/Next 无法承载的必要独立事件，票不必用尽。凡本轮新增，须同轮实际省略至少一条确已结束、失去独立追踪价值或已并入其他线的未锁旧线；只标收束/淡出却仍输出不算减少。不要求一换一，但无可合理减旧线时仅更新；不伪造完结，不动锁线。\n'
        : '';
    const returnedLinesContract = progressionContract ? '旧线可续写、标本轮终态，或按上述条件省略；未返回的旧线须有确实清退依据。' : '';
    return `请依据当前正文、记忆与世界设定推演全局平行事件线。${userName}与${charName}只是既有参与者，不是固定叙事中心。只输出结构化结果，不要解释、前言或代码块外文字。\n\n【一、选材】${scaleContract}只追踪有证据支持、当前活跃且值得后续观察的事件。主动方可以是 ${userName}、${charName}、既有配角、群体、势力、机构，或能自行变化的制度/环境因素；不得凭空创造陌生人物、阴谋、灾难或极端对抗。除非剧情证据确实高度集中于 ${userName}，不要让 ${userName} 成为绝大多数线的主动方或所有线的唯一落点。\n例①：巡桥人今天发现护栏松动，已通知维修员，明早复查；不要拆成发现、通知、复查三线。Desc 写今天发现并已通知，Next 写明早复查后是否限行；参与者、措辞或 Cue 改变不另起线。\n例②：旧计划周五交方案，今天只收到草稿；不要把交付、签字写成已发生。Desc 写草稿已到，Next 写团队补齐资料后由实际签署方决定是否签字，影响周五交付。\n${lineDirectionContract(direction)}\n${narrativePaceContract(narrativePace)}\n${LINE_RELATIONSHIP_AGENCY_GUIDE}\n\n【二、主动方与 agency】每条线选择当下真正掌握推动力的既有主体。agency=player 仅表示下一步必须等待 ${userName} 的选择或行动；agency=world 表示其他人物、势力、机构或环境即使 ${userName} 暂不参与也能自行推进。不要因为事件将来可能影响 ${userName} 就标 player。Desc 写当前状态与有关各方位置；Next 写有依据的下一变化，不强制写成 ${userName} 的反应。\n\n【三、推进与生命周期】${countContract}${progressionContract}${oldFormatContract}\n起线＝开始追踪；延展＝继续或维持；成形＝影响明确；收束＝解决、和解、新平衡或事务落定；淡出＝不再值得追踪。收束/淡出只用于本轮刚结束追踪的输入旧线；不要把已结束的历史事件新建为终态线。新线必须非终态且值得继续追踪。${adultPromptGuidance(adultMode)}\n\n【四、理想机器结构】输出一对闭合的 <storylines_widget>...</storylines_widget>。stage 只使用起线、延展、成形、收束、淡出；agency 使用 player 或 world；stall、pin 使用 true 或 false。pin 是本地保留位，AI 一律输出 pin=false。\n每条线包含以下业务字段；新线额外带本轮临时 Ticket：\nLine: 名称|阶段|时间锚点|player或world|true或false|false\n新拟线名不超过10字；旧线沿用原名。\nTicket: <本轮列出的临时票据 ID>\nDesc: 当前状态、背景、有关各方位置\nNext: ${LINE_NEXT_RELEASE_CONTRACT.replace('Next: ', '')}\n新线才填写 Ticket，且字段中只写纯编号（例如 TICKET-1），不要附分类括号或解释；分类仅是上方本地票据清单的说明。示例编号必须替换为本轮实际列出的 Ticket。${returnedLinesContract}各字段须完整，不得省略或截断。\n\n【当前已追踪】\n${trackedLinesForPrompt(previousRaw)}${vectorPromptContext(vectorContext)}\n${LINE_OUTPUT_REVIEW_GUIDE}`.replace(/\{\{user\}\}/g, userName).replace(/\{\{char\}\}/g, charName);
}
