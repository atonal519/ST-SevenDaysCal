import { parseLines, serializeLines } from './schema.js';
import { stripVectorCueLines } from './vectors/codec.js';
import { ticketFromCue } from './vectors/codec.js';

export function prepareLinesInspirationContext(context = {}) { return context; }

function trackedLinesForPrompt(previousRaw) {
    if (!previousRaw) return '（无，基于当前剧情新建 1-4 条）';
    const tracked = parseLines(previousRaw);
    if (!tracked.length) return stripVectorCueLines(previousRaw);
    // pin 是本地面板的内部状态，不把真实用户锁暴露给模型，避免模型照抄。
    return serializeLines(tracked.map(line => ({ ...line, pin: false })), { includeCue: false });
}

function vectorPromptContext(vectorContext = {}) {
    const retained = (vectorContext.retained || []).map(line => { const ticket = ticketFromCue(line.cue); return ticket ? `- ${line.name}：${ticket.selections.map(item => `${item.label}（${item.prompt}）`).join('；')}（沿用已有三项影响角度）` : null; }).filter(Boolean).join('\n') || '（无）';
    const legacy = (vectorContext.legacyWithoutCue || []).map(name => `- ${name}`).join('\n') || '（无）';
    const fresh = (vectorContext.freshTickets || []).map((ticket, index) => `- 新票 ${index + 1}：${ticket.selections.map(item => `${item.label}（${item.prompt}）`).join('；')}`).join('\n') || '（无）';
    return `\n【本轮本地预掷影响角度】\n以下三项已由本地确定，不要自行随机、换票、创造标签或复述票号。它们只是克制的影响角度，不是确定剧情结果。\n${fresh}\n【有组合的旧线】\n${retained}\n【无组合的旧线】\n${legacy}\n新线按最终输出出现顺序领取新票；继续旧线必须保持原 Line 名称，改名视为新线；余票可忽略，不要凑数，超过票数仍可输出但不附组合。禁止凭空制造人物、阴谋、灾难或极端冲突。`;
}

export function buildLinesPrompt(userName = '用户', charName = '角色', perspective = 'user', previousRaw = '', scale = 'auto', vectorContext = {}) {
    const promptContext = prepareLinesInspirationContext({ userName, charName, perspective, previousRaw, scale, vectorContext });
    ({ userName, charName, perspective, previousRaw, scale, vectorContext } = promptContext);
    const subject = perspective === 'char' ? charName : userName;
    return `请根据当前剧情与记忆提炼平行事件线，叙事主体为${subject}。这是结构化输出，不要输出解释、前言或代码块外文字。\n
【推进尺度】${scale === 'macro' ? '关注势力、世界与长期局势。' : scale === 'micro' ? '关注人物当下行动、关系与短期催化。' : '兼顾人物、事件与世界局势，保持可推进的粒度。'}\n
【正式类型】type 只能是冲突或推进。stage 只能是：萌芽、发酵、逼近、已爆发、已消散、筹备、执行、关键、已完成、已失败。level 只能是 1、2、3、4。agency 只能是 player 或 world；stall、pin 只能是 true 或 false。pin 是构画内部保留位，不由 AI 决定，所有条目必须输出 pin=false。\n
【终态】已爆发、已消散、已完成、已失败均为终态；终态只用于当前输入中已有、且在本轮刚刚收束的线。不要把正文里已经结束的历史事件新建为终态线；新建线必须处于非终态，并且值得后续继续追踪。已终态事件不再推进、不作为潜伏注入候选。\n
【严格格式】必须输出完整闭合的 <storylines_widget>...</storylines_widget>，条目数量按当前剧情证据灵活决定（1 条或多条均可，不要为凑数硬编）。每条严格按以下顺序输出三行：\nLine: 名称|类型|阶段|等级|时间锚点|agency|stall|pin\nDesc: 当前状态、背景、人物/势力立场（写现在，不写下一步）\nNext: 一句前瞻信号或 stall=true 的恢复条件\n字段内禁止裸 |，不要省略 Desc/Next，不得截断；Line 字段必须恰好 8 段。\n
【当前已追踪】\n${trackedLinesForPrompt(previousRaw)}${vectorPromptContext(vectorContext)}`.replace(/\{\{user\}\}/g, userName).replace(/\{\{char\}\}/g, charName);
}
