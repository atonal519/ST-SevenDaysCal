import { parseLines, serializeLines } from './schema.js';
import { stripInternalLineLines, ticketFromCue } from './vectors/codec.js';
import { adultPromptGuidance } from './adult.js';

export function prepareLinesInspirationContext(context = {}) { return context; }
export const LINE_NEXT_RELEASE_CONTRACT = 'Next: 一句前瞻信号或 stall=true 的恢复条件';
function trackedLinesForPrompt(previousRaw, vectorContext = {}) {
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
        return `- 临时票据 ID=${ticketId}${poolLabel ? `（${poolLabel}）` : ''}：${ticket.selections.map(item => `${item.label}（${item.prompt}）`).join('；')}${adultText}`;
    };
    const indexed = freshTickets.map((ticket, index) => ({ ticket, index }));
    const hasPools = indexed.some(({ ticket }) => ticket.adultPool);
    const fresh = indexed.map(({ ticket, index }) => renderFresh(ticket, index, ticket.adultPool === 'nsfw' ? 'NSFW 新线' : ticket.adultPool === 'sfw' ? 'SFW 新线' : '')).join('\n');
    const poolContract = hasPools ? '票据上的 SFW/NSFW 类型由本地确定，不可改写；具体选材遵守上方成人追加合同。' : '';
    const reroll = vectorContext.intent === 'reroll';
    const rerollNote = reroll ? '本轮刷新不要求返回旧自动线；锁线仍只作背景。' : '';
    return `\n【机器数据：本轮真实唯一 Ticket 与 6×3 Cue】\n每张票的三项影响角度作用于该线实际选择的主动方与事件，只是影响角度，不是确定结果；不得自行换票、改标签或造票。${poolContract}\n${fresh || '（无）'}\n新建非终态线可从以上 ${freshTickets.length} 张票中选择任意不重复子集并调整输出顺序；每条新线恰好使用一张真实 Ticket，不适合的票可以不用。Ticket 不得缺失、重复、改写或伪造；旧线不得使用 Ticket。${rerollNote}\n【本地锁线只读背景】\n${pinnedBackground}\n锁线已由本地完整保留，不输出、不改写、不终结、不分票。\n【旧线既有 Cue】\n${retained}\n【旧线无 Cue】\n${legacy}`;
}
export function buildLinesPrompt(userName = '用户', charName = '角色', perspective = 'user', previousRaw = '', scale = 'auto', vectorContext = {}, adultMode = 'off') {
    const promptContext = prepareLinesInspirationContext({ userName, charName, perspective, previousRaw, scale, vectorContext });
    ({ userName, charName, perspective, previousRaw, scale, vectorContext } = promptContext);
    const seedRun = vectorContext.intent === 'initial' || vectorContext.intent === 'reroll';
    const scaleContract = (scale === 'macro' ? '关注势力、世界与长期局势。' : scale === 'micro' ? '关注人物当下行动、关系与短期催化。' : '兼顾人物、事件与世界局势，保持可推进的粒度。')
        + '“冲突”也可包含关系张力、彼此试探、索取关注或立场摩擦，不等于必须升级伤害。阶段只描述生命周期位置，不构成必须升级的命令；下一变化允许维持、缓和、转向、解决或消散。没有连续正文证据与充分动机时，不得突然扩大伤害或制造不可逆后果。';
    const countContract = seedRun
        ? '首次生成或刷新可按证据输出 1–8 条自动线；不必用完票据，不为凑数硬编。'
        : '自然推进必须逐条原名、完整返回每条旧未锁活线（包括本轮刚进入终态者），可按证据自由新建；提交后的未锁非终态自动线不得超过 8 条。旧线进入终态会腾出容量；除此不设主动方、类型或单轮出生配额。';
    const oldFormatContract = vectorContext.intent === 'reroll' ? '刷新不要求返回旧自动线。' : '旧线保持原名并完整输出 Line、Desc、Next，改名、漏写或重复续写均违规。';
    return `请依据当前正文、记忆与世界设定推演全局平行事件线。${userName}与${charName}只是既有参与者，不是固定叙事中心。只输出结构化结果，不要解释、前言或代码块外文字。\n\n【一、选材】${scaleContract}只追踪已有证据支持、当前真正活跃且值得后续观察的事件。主动方可以是 ${userName}、${charName}、既有配角、群体、势力、机构，或能自行变化的制度/环境因素；不得凭空创造陌生人物、阴谋、灾难或极端冲突。除非剧情证据确实高度集中于 ${userName}，不要让 ${userName} 成为绝大多数线的主动方或所有线的唯一落点。\n同一主体、时间窗、现实触发事件与核心目标的后续步骤合并为同一条线，上下游分别写入 Desc / Next；互斥结果保留为同一条线的未决走向。只有核心目标、冲突源或独立生命周期实质不同才另建；Cue 不同本身不构成新线理由。\n\n【二、主动方与 agency】每条线选择当下真正掌握推动力的既有主体。agency=player 仅表示下一步必须等待 ${userName} 的选择或行动；agency=world 表示其他人物、势力、机构或环境即使 ${userName} 暂不参与也能自行推进。不要因为事件将来可能影响 ${userName} 就标 player。Desc 只写当前状态、背景与有关各方位置；Next 写真正主动方紧邻的下一步，或事件自行发生的下一变化，不强制写成 ${userName} 的反应。\n\n【三、推进与生命周期】${countContract}${oldFormatContract}\n五个阶段共用同一生命周期：起线＝刚进入追踪；延展＝继续发展或维持；成形＝影响变得明确，而非冲突极端化；收束＝解决、和解、形成新平衡或事务落定；淡出＝不再值得持续追踪。收束、淡出是终态，只用于输入中已有且本轮刚结束追踪的线；不要把已经结束的历史事件新建为终态线。新线必须是非终态并值得继续追踪。${adultPromptGuidance(adultMode)}\n\n【四、理想机器结构】输出一对闭合的 <storylines_widget>...</storylines_widget>。type 使用冲突或推进；stage 只使用起线、延展、成形、收束、淡出；agency 使用 player 或 world；stall、pin 使用 true 或 false。pin 是本地保留位，AI 一律输出 pin=false。\n每条线包含以下业务字段；新线额外带本轮临时 Ticket：\nLine: 名称|类型|阶段|时间锚点|agency|stall|pin\nTicket: <本轮列出的临时票据 ID>（仅新线）\nDesc: 当前状态、背景、有关各方位置\nNext: ${LINE_NEXT_RELEASE_CONTRACT.replace('Next: ', '')}\n名称、时间锚点、Desc、Next 和新线 Ticket 不得省略；不要截断。\n\n【当前已追踪】\n${trackedLinesForPrompt(previousRaw, vectorContext)}${vectorPromptContext(vectorContext)}`.replace(/\{\{user\}\}/g, userName).replace(/\{\{char\}\}/g, charName);
}
