import { parseLines, serializeLines } from './schema.js';
import { stripInternalLineLines, ticketFromCue } from './vectors/codec.js';
import { adultPromptGuidance } from './adult.js';

export function prepareLinesInspirationContext(context = {}) { return context; }
export const LINE_NEXT_RELEASE_CONTRACT = 'Next: 一句前瞻信号或 stall=true 的恢复条件';
function trackedLinesForPrompt(previousRaw, vectorContext = {}) {
    if (!previousRaw) return vectorContext.intent === 'initial' ? '（无；本轮按票据比例逐槽选择 SFW / NSFW 新线）' : '（无，基于当前剧情新建 1-4 条）';
    const tracked = parseLines(previousRaw);
    if (!tracked.length) return stripInternalLineLines(previousRaw);
    return serializeLines(tracked.map(line => ({ ...line, pin: false })), { includeCue: false, includeAdult: false });
}
function vectorPromptContext(vectorContext = {}) {
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
    const poolContract = hasPools ? '\n本轮票据表严格按 allocator 原始签发顺序列出；每张票的 SFW/NSFW 类型不可改写。新线最终输出顺序可以调整，但实际使用的票据必须严格等于前 K 张，不能跳号、断层、重复或使用 K 之后的票。SFW 新线不得成人化，NSFW 新线必须以成人欲望、成人场景或成人互动本身为核心，不得把普通权谋、任务或交易线只在 Next 尾部强行性化。同一主角或同一组参与者可以重复；成人线至少在场景、关系结构、互动机制、节奏或即时身体/关系后果之一有实质差异，不得为换人物凭空发明无关角色。' : '';
    const overflowContract = `最多输出 ${freshTickets.length} 条新线；每条新线都必须携带一张本轮签发且未使用的票据 ID，不得无票输出。`;
    return `\n【本轮本地预掷影响角度】\n以下三项已由本地确定，不要自行随机、换票或创造标签；只照抄对应的临时票据 ID。它们只是克制的影响角度，不是确定剧情结果。${poolContract}\n${fresh || '（无）'}\n【有组合的旧线】\n${retained}\n【无组合的旧线】\n${legacy}\n旧线必须先输出；继续旧线必须保持原 Line 名称，改名视为新线；旧线不得输出 Ticket。每张新票只能使用一次：新线必须在 Line: 后输出 Ticket: <该票据 ID>，可以调整新线最终顺序，但不得改写、重复、伪造或遗漏票据 ID；终态新线不得输出 Ticket。${overflowContract}禁止凭空制造人物、阴谋、灾难或极端冲突。`;
}
export function buildLinesPrompt(userName = '用户', charName = '角色', perspective = 'user', previousRaw = '', scale = 'auto', vectorContext = {}, adultMode = 'off') {
    const promptContext = prepareLinesInspirationContext({ userName, charName, perspective, previousRaw, scale, vectorContext });
    ({ userName, charName, perspective, previousRaw, scale, vectorContext } = promptContext);
    const subject = perspective === 'char' ? charName : userName;
    const seedRun = vectorContext.intent === 'initial' || vectorContext.intent === 'reroll';
    const countContract = seedRun ? '本轮最多输出 4 条自动种子线，按票据前缀和剧情证据灵活决定数量，不要为凑数硬编。' : '自然推进不设自动线总数上限；旧未锁活线必须逐条原名输出，默认最多出生 1 条真正独立的新线，每有 1 条旧未锁活线明确进入终态，额外释放 1 个出生名额，单轮新生最多 4 条；改名、漏写、重复续写均视为违规。';
    return `请根据当前剧情与记忆提炼平行事件线，叙事主体为${subject}。这是结构化输出，不要输出解释、前言或代码块外文字。\n\n【推进尺度】${scale === 'macro' ? '关注势力、世界与长期局势。' : scale === 'micro' ? '关注人物当下行动、关系与短期催化。' : '兼顾人物、事件与世界局势，保持可推进的粒度。'}${adultPromptGuidance(adultMode)}\n\n【普通线身份收敛】同一主体、同一时间窗、同一现实触发事件、同一核心目标的后续步骤必须合并为同一条线，并把上下游步骤分别写入这条线的 Desc / Next；互斥的可能结果也保留为同一条线的未决走向，不要分别新建。只有核心目标、冲突源或独立生命周期实质不同才另建；Cue 不同本身不构成新线理由。真正独立且可并行成立的目标不必强行合并。\n\n【正式类型】type 只能是冲突或推进。stage 只能是：萌芽、发酵、逼近、已爆发、已消散、筹备、执行、关键、已完成、已失败。level 只能是 1、2、3、4。agency 只能是 player 或 world；stall、pin 只能是 true 或 false。pin 是构画内部保留位，不由 AI 决定，所有条目必须输出 pin=false。\n\n【终态】已爆发、已消散、已完成、已失败均为终态；终态只用于当前输入中已有、且在本轮刚刚收束的线。不要把正文里已经结束的历史事件新建为终态线；新建线必须处于非终态，并且值得后续继续追踪。已终态事件不再推进、不作为潜伏注入候选。\n\n【严格格式】必须输出完整闭合的 <storylines_widget>...</storylines_widget>，${countContract}旧线严格输出三行 Line/Desc/Next；新线严格输出四行，顺序固定为：\nLine: 名称|类型|阶段|等级|时间锚点|agency|stall|pin\nTicket: <本轮列出的临时票据 ID>\nDesc: 当前状态、背景、人物/势力立场（写现在，不写下一步）\nNext: ${LINE_NEXT_RELEASE_CONTRACT.replace('Next: ', '')}\n旧线保持原名且不得输出 Ticket；新建非终局线必须输出本轮签发且未使用的 Ticket。不得改写、重复、伪造或遗漏 ID；终态新线不得附 Ticket。字段内禁止裸 |，不要省略 Desc/Next，不得截断；Line 字段必须恰好 8 段。\n\n【当前已追踪】\n${trackedLinesForPrompt(previousRaw, vectorContext)}${vectorPromptContext(vectorContext)}`.replace(/\{\{user\}\}/g, userName).replace(/\{\{char\}\}/g, charName);
}
