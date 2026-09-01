// ─── 点（日程）域 · 生成 prompt ───────────────────────────────────────────────
// 从 index.js 机械搬移 buildPrompt：纯字符串拼装，无 DOM / store / 历法依赖。
export function buildPrompt(userName, charName, perspective = 'user', pinned = null, calendar = null, adultContext = null) {
    const subject   = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    const pins = Array.isArray(pinned) ? pinned.filter(e => e?.title?.trim()) : [];
    const pinnedBlock = pins.length
        ? `\n【已锁定事件】\n以下事件必须占用对应栏目的展示名额：标题逐字保留；其他字段可按新剧情推进，没有新证据则沿用原意。严禁删除、改名或替换。锁定事件不附 Ticket 或 AdultProof。\n${pins.map((e, i) => `${i + 1}. ${e.title}${e.time ? `（${e.time}）` : ''}`).join('\n')}\n`
        : '';
    const adultBlock = adultContext?.mode && adultContext.mode !== 'off' ? `
【成人选材 Ticket（仅本轮有效）】
K = 本轮新建事件数（不含锁定事件）。锁定事件不附 Ticket 或 AdultProof；新 Event 按最终输出顺序使用前 K 张 Ticket，从 1 连续编号，不能跳票、重排或凑成人：
${(adultContext.tickets || []).map(ticket => `${ticket.id}｜${ticket.pool === 'nsfw' ? 'NSFW' : 'SFW'}${ticket.selection ? `｜素材：${ticket.selection}` : ''}`).join('\n')}
NSFW 票只适用于明确成年且自愿的虚构角色；对应 Event 必须落实具体行为、主动方、明确回应与当场影响，并紧邻完整「AdultProof: kind=sexual-contact; action=原文子串; response=原文子串; impact=原文子串」。SFW 票不得成人化，紧邻「AdultProof: NONE」。这里“兑现”只指 description／线头动态是否写出该 NSFW 素材，与故事时间是否已经发生无关；点本来就是未来规划，未来规划不等于未兑现，Day 2、Day 3、Future 不得因此写 NONE。三个原文子串必须来自该 Event 的 description 或线头动态，不得引用 title；不得输出 Adult 行或其他票。拒绝、沉默、回忆、计划、假设、比较、普通亲昵、留宿、洗澡按摩、单纯裸体、事后照料不得作为 NSFW 票内容。
` : '';
    const eventTemplate = adultContext?.mode && adultContext.mode !== 'off'
        ? () => 'Event: type|title|description|time|location|线头动态\nTicket: POINT-TICKET-N\nAdultProof: 按上方对应 Ticket 的 SFW／NSFW 合同填写'
        : () => 'Event: type|title|description|time|location|线头动态';
    return `请暂停角色扮演，以旁观者视角根据以上剧情，为 ${subject} 生成日程。
【重要】所有输出必须使用中文（人名、地名可保留原文）。
【人称】你是旁观者，不要扮演任何角色。所有文字（含 description 与线头动态）必须以第三人称叙述，直呼 ${subject} 的名字，严禁使用"我""我们"等第一人称，也不要用第二人称"你"。

事件分三类：
- main（明线）：${subject} 直接卷入、正在推进的事件
- hidden（暗线）：隐含的伏笔、悬而未决的走向
- bond（红线）：${subject} 与某人的关系变化，不限爱情，也可包括亲情、盟友、敌意、债务或依赖

以 ${subject} 自身目标为核心，可按剧情证据涉及 ${companion} 或第三方；不强绑互动，不默认爱情。
${adultBlock}
输出顺序必须严格为 Day 1 → Day 2 → Day 3 → Future → </calendar_widget>，中间不得省略任何块。最终总展示数量固定为 14 条：Day 1、Day 2、Day 3 各 3 条，Future 5 条；已锁定事件也占对应栏目的名额。不得把同一事件拆碎、换标题复述或凭空凑数；可从 ${subject} 自身事务、第三方行动、阵营或生活层面扩展真正独立的事项。

【天气说明】
每个 Day 的日头请附带当天天气与温度，格式 Day: N|天气|温度（如 Day: 1|晴|3℃）。
天气是氛围点缀，请结合剧情季节/地域/时间合理"推测"，无需真实准确——晴/多云/阴/小雨/雷阵雨/小雪/大雪/雾 等皆可，温度给摄氏度区间或单值（如 -2℃ / 12~18℃）。
若剧情完全无从判断季节地域，可给一个自洽的温和天气。Future 块不需要天气。

【字段说明】
格式：Event: type|title|description|time|location|线头动态
- 每个 Event 必须独占一行；字段内容不得包含半角竖线「|」。location 或线头动态为空时，仍须保留空字段位置。
- type 只能是 main / hidden / bond
- title 是单一、可识别的事件身份；同一主体、触发、核心目标和连续时间窗的上下游必须合并。
- description：只写一个连续时间节点内的具体推进，以第三人称客观记述 ${subject} 这天经历的事，生活化口吻，直呼其名，不用第一人称，30字以上
- 线头动态：与此事件同一时段同步发生的其他角色动作/回应，可以是任意第三方，30字以上；若无关联角色可留空，不要写下一轮清单
- time：事件发生的时间或时间段；location：事件发生的具体地点，无法确定时留空
- 成人票不得跨越接触前、互动进行中、事后三个阶段中的多个区间；成人点仍必须遵守明确成年、自愿和当前剧情证据。

【日期说明】
Day 1 从剧情当前时间节点开始，向后推演；不要回填已经发生过的时间。
${pinnedBlock}
【输出格式（严格遵守）】
内部完成去重与排序，最终只输出以下 widget。
${adultContext?.mode && adultContext.mode !== 'off' ? '模板中的 Ticket／AdultProof 两行仅供新 Event 使用：N 按新 Event 顺序从 1 连续，锁定 Event 省略这两行；具体票型与 proof 只服从上方本轮票据表。\n' : ''}<calendar_widget>
Day: 1|天气|温度
${eventTemplate(1)}
${eventTemplate(2)}
${eventTemplate(3)}
Day: 2|天气|温度
${eventTemplate(4)}
${eventTemplate(5)}
${eventTemplate(6)}
Day: 3|天气|温度
${eventTemplate(7)}
${eventTemplate(8)}
${eventTemplate(9)}
Future:
${eventTemplate(10)}
${eventTemplate(11)}
${eventTemplate(12)}
${eventTemplate(13)}
${eventTemplate(14)}
</calendar_widget>

【Future 说明】
Future 收录 Day 3 之后或时间尚未确定的事项，不得重复 Day 1-3 已安排的同一事件；允许基于剧情走向合理推测，但不能凭空捏造从未提及的约定或承诺。`;
}
