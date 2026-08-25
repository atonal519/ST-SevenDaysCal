import { parseLines, serializeLines } from './schema.js';
import { stripVectorCueLines, ticketFromCue } from './vectors/codec.js';
import { adultPromptGuidance } from './adult.js';

export function prepareLinesInspirationContext(context = {}) { return context; }
export const LINE_NEXT_RELEASE_CONTRACT = 'Next: 一句前瞻信号或 stall=true 的恢复条件';
function trackedLinesForPrompt(previousRaw, vectorContext = {}) {
    if (!previousRaw) return vectorContext.intent === 'initial' ? '（无；本轮目标为 2 条 SFW 新线 + 5 条 NSFW 新线）' : '（无，基于当前剧情新建 1-4 条）';
    const tracked = parseLines(previousRaw);
    if (!tracked.length) return stripVectorCueLines(previousRaw);
    return serializeLines(tracked.map(line => ({ ...line, pin: false })), { includeCue: false });
}
function vectorPromptContext(vectorContext = {}) {
    const retained = (vectorContext.retained || []).map(line => { const ticket = ticketFromCue(line.cue); return ticket ? `- ${line.name}：${ticket.selections.map(item => `${item.label}（${item.prompt}）`).join('；')}（沿用已有三项影响角度）` : null; }).filter(Boolean).join('\n') || '（无）';
    const legacy = (vectorContext.legacyWithoutCue || []).map(name => `- ${name}`).join('\n') || '（无）';
    const freshTickets = vectorContext.freshTickets || [];
    const renderFresh = (ticket, index, poolLabel = '') => {
        const adult = ticket.adultSelection;
        const adultText = adult ? `；【成人选材】驱动力：${adult.drive}；行为：${adult.behavior}；节奏：${adult.pacing}；场景：${adult.scene}；后果：${adult.consequence}` : '';
        return `- 新票 ${index + 1}${poolLabel ? `（${poolLabel}）` : ''}：${ticket.selections.map(item => `${item.label}（${item.prompt}）`).join('；')}${adultText}`;
    };
    const indexed = freshTickets.map((ticket, index) => ({ ticket, index }));
    const hasPools = indexed.some(({ ticket }) => ticket.adultPool);
    const fresh = hasPools ? [['SFW 新线', indexed.filter(({ ticket }) => ticket.adultPool === 'sfw')], ['NSFW 新线', indexed.filter(({ ticket }) => ticket.adultPool === 'nsfw')]].flatMap(([label, entries]) => entries.map(({ ticket, index }) => renderFresh(ticket, index, label))).join('\n') : indexed.map(({ ticket, index }) => renderFresh(ticket, index)).join('\n');
    const poolContract = hasPools ? '\n本轮新线领取顺序固定为：先输出并领取 SFW 新线，再输出并领取 NSFW 新线；旧线始终先于全部新线。目标为 2 条 SFW + 5 条 NSFW；质量优先时只能从末尾 NSFW 票开始减少，可输出 2+4、2+3 等，不得少给 SFW 后继续输出 NSFW。SFW 新线不得成人化，NSFW 新线必须以成人欲望、成人场景或成人互动本身为核心，不得把普通权谋、任务或交易线只在 Next 尾部强行性化。同一主角或同一组参与者可以重复；成人线至少在场景、关系结构、互动机制、节奏或即时身体/关系后果之一有实质差异，不得为换人物凭空发明无关角色。' : '';
    const overflowContract = hasPools ? '最多输出 7 条新线。' : '余票可忽略，不要凑数，超过票数仍可输出但不附组合。';
    return `\n【本轮本地预掷影响角度】\n以下三项已由本地确定，不要自行随机、换票、创造标签或复述票号。它们只是克制的影响角度，不是确定剧情结果。${poolContract}\n${fresh || '（无）'}\n【有组合的旧线】\n${retained}\n【无组合的旧线】\n${legacy}\n旧线必须先输出；新线按最终输出出现顺序领取新票；继续旧线必须保持原 Line 名称，改名视为新线；${overflowContract}禁止凭空制造人物、阴谋、灾难或极端冲突。`;
}
export function buildLinesPrompt(userName = '用户', charName = '角色', perspective = 'user', previousRaw = '', scale = 'auto', vectorContext = {}, adultMode = 'off') {
    const promptContext = prepareLinesInspirationContext({ userName, charName, perspective, previousRaw, scale, vectorContext });
    ({ userName, charName, perspective, previousRaw, scale, vectorContext } = promptContext);
    const subject = perspective === 'char' ? charName : userName;
    const poolRun = adultMode === 'dominant' && (vectorContext.intent === 'initial' || vectorContext.intent === 'reroll');
    const countContract = poolRun ? '本轮目标输出 2 条 SFW 新线 + 5 条 NSFW 新线；质量不足时只能从末尾 NSFW 新线开始减少。' : '条目数量按当前剧情证据灵活决定（1 条或多条均可，不要为凑数硬编）。';
    return `请根据当前剧情与记忆提炼平行事件线，叙事主体为${subject}。这是结构化输出，不要输出解释、前言或代码块外文字。\n\n【推进尺度】${scale === 'macro' ? '关注势力、世界与长期局势。' : scale === 'micro' ? '关注人物当下行动、关系与短期催化。' : '兼顾人物、事件与世界局势，保持可推进的粒度。'}${adultPromptGuidance(adultMode)}\n\n【正式类型】type 只能是冲突或推进。stage 只能是：萌芽、发酵、逼近、已爆发、已消散、筹备、执行、关键、已完成、已失败。level 只能是 1、2、3、4。agency 只能是 player 或 world；stall、pin 只能是 true 或 false。pin 是构画内部保留位，不由 AI 决定，所有条目必须输出 pin=false。\n\n【终态】已爆发、已消散、已完成、已失败均为终态；终态只用于当前输入中已有、且在本轮刚刚收束的线。不要把正文里已经结束的历史事件新建为终态线；新建线必须处于非终态，并且值得后续继续追踪。已终态事件不再推进、不作为潜伏注入候选。\n\n【严格格式】必须输出完整闭合的 <storylines_widget>...</storylines_widget>，${countContract}每条严格按以下顺序输出三行：\nLine: 名称|类型|阶段|等级|时间锚点|agency|stall|pin\nDesc: 当前状态、背景、人物/势力立场（写现在，不写下一步）\nNext: ${LINE_NEXT_RELEASE_CONTRACT.replace('Next: ', '')}\n字段内禁止裸 |，不要省略 Desc/Next，不得截断；Line 字段必须恰好 8 段。\n\n【当前已追踪】\n${trackedLinesForPrompt(previousRaw, vectorContext)}${vectorPromptContext(vectorContext)}`.replace(/\{\{user\}\}/g, userName).replace(/\{\{char\}\}/g, charName);
}
