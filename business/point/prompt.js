// ─── 点（日程）域 · 生成 prompt ───────────────────────────────────────────────
// 提示词与锁点输入投影；不依赖 DOM、store 或历法运行态。
import { narrativePreferenceContract } from '../narrative-preferences.js';

function pointPinsFromParsed(parsed) {
    const pins = [];
    // allDays retains empty calendar days, so a missing Day 2 cannot relabel Day 3.
    for (const day of parsed?.allDays || parsed?.days || []) {
        for (const event of day.events || []) if (event.pin) pins.push({ ...event, section: `Day ${day.dayNumber}` });
    }
    for (const event of parsed?.future?.events || []) if (event.pin) pins.push({ ...event, section: 'Future' });
    return pins;
}

export { pointPinsFromParsed };

export function buildPrompt(userName, charName, perspective = 'user', pinned = null, calendar = null, adultContext = null, preferences = {}) {
    const subject = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    const pins = Array.isArray(pinned) ? pinned.filter(event => event?.title?.trim()) : [];
    const pinnedBlock = pins.length
        ? `\n【已锁定事件】\n以下事件保留原栏目名额。标题逐字保留；其他字段有新证据才推进，否则沿用原意。锁点不附 Ticket 或 AdultProof。\n${pins.map(event => `${event.section || '原栏目未知'}：${[
            event.type, event.title, event.desc, event.time, event.location, event.npcAction,
        ].map(value => String(value || '')).join('|')}`).join('\n')}\n`
        : '';
    const adultBlock = adultContext?.mode && adultContext.mode !== 'off' ? `
【成人选材 Ticket（仅本轮有效）】
K = 本轮新建事件数（不含锁定事件）。锁定事件不附 Ticket 或 AdultProof；新 Event 按最终输出顺序使用前 K 张 Ticket，从 1 连续编号，不能跳票、重排或凑成人：
${(adultContext.tickets || []).map(ticket => `${ticket.id}｜${ticket.pool === 'nsfw' ? 'NSFW' : 'SFW'}${ticket.selection ? `｜素材：${ticket.selection}` : ''}`).join('\n')}
${adultContext.mode === 'mixed' ? '混合模式的成人比例只是情境适合时的选材倾向，不是最低数量。缺少当前关系或情境依据时可全部为普通事件；NSFW票提供的素材可以不采用，仍保留对应Ticket并写AdultProof: NONE。只有实际采用成人素材时才按下列合同写proof。\n采用的 ' : ''}NSFW 票只适用于明确成年且自愿的虚构角色；对应 Event 必须落实具体行为、主动方、明确回应与当场影响，并紧邻完整「AdultProof: kind=sexual-contact; action=原文子串; response=原文子串; impact=原文子串」。SFW 票不得成人化，紧邻「AdultProof: NONE」。这里“兑现”只指 description／线头动态是否写出该 NSFW 素材，与故事时间是否已经发生无关；点本来就是未来规划，未来规划不等于未兑现，Day 2、Day 3、Future 不得因此写 NONE。三个原文子串必须来自该 Event 的 description 或线头动态，不得引用 title；不得输出 Adult 行或其他票。拒绝、沉默、回忆、计划、假设、比较、普通亲昵、留宿、洗澡按摩、单纯裸体、事后照料不得作为 NSFW 票内容。
成人票不得跨越接触前、互动进行中、事后三个阶段中的多个区间；成人点仍须有明确成年、自愿和当前剧情证据。
` : '';
    const eventTemplate = adultContext?.mode && adultContext.mode !== 'off'
        ? 'Event: type|title|description|time|location|线头动态\nTicket: POINT-TICKET-N\nAdultProof: 按上方对应 Ticket 的 SFW／NSFW 合同填写'
        : 'Event: type|title|description|time|location|线头动态';
    const adultExampleNote = adultContext?.mode && adultContext.mode !== 'off'
        ? '格式例中的 Ticket／AdultProof 仅用于新 Event；Ticket 按新 Event 顺序从 1 连续编号，票型与 proof 只服从上方完整票据表。\n'
        : '';
    return `请按已给剧情和设定，为 ${subject} 从当前故事日期开始规划 Day 1、Day 2、Day 3 及更远事项。只输出一个 <calendar_widget>，不附解释。叙事字段用中文、第三人称，不用“我／我们／你”叙述；人名、地名可保留原文，结构键和 type 值保持英文。description 用 ${subject} 的姓名记述具体行动；线头动态写同期其他角色的动作或回应。

以 ${subject} 自身目标和既有因果为核心，有依据时才涉及 ${companion} 或第三方，不默认爱情。type 仅 main／hidden／bond：分别表示主体直接卷入的推进、伏笔或未决走向、关系变化（不限爱情）。
${narrativePreferenceContract(preferences)}
每项写清该时段将推进的具体行动及可能改变；推演不是既成事实，玩家尚未作出的关键选择保持开放。同一长期目标可跨日分阶段推进，但各日有不同动作或局面变化，不靠换标题重复。${adultBlock}
依次写 Day 1、Day 2、Day 3、Future，目标数量为 3、3、3、5 条，锁点占原栏目名额。可写有依据且真正独立的自身事务、第三方、阵营或生活事项，不拆碎、换名复述或凑数。Day 1 从当前剧情向后，不回填已发生的事；Future 仅收 Day 3 后或时间未定的事项，不重复前三天，不编造既定约定或承诺。

每条 Event 独占一行，保留六个字段，用竖线分隔。title 是稳定事件身份；同一主体、触发、核心目标和连续时段的上下游合为一项。description 写一个连续时段的具体推进，生活化口吻，30 字以上；线头动态仅写同期关联角色动作，30 字以上或留空，不写下一轮清单。time 写时间或时段；location 未知可空，空字段仍保留分隔符。

每个 Day 写天气及温度：按季节、地域和剧情合理推测，温度用摄氏单值或范围；线索不足时用自洽的温和天气。Future 无天气。
${pinnedBlock}
以下仅为格式例，各栏目按上述目标填写：
${adultExampleNote}<calendar_widget>
Day: 1|天气|温度
${eventTemplate}
Day: 2|天气|温度
${eventTemplate}
Day: 3|天气|温度
${eventTemplate}
Future:
${eventTemplate}
</calendar_widget>`;
}
