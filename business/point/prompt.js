// ─── 点（日程）域 · 生成 prompt ───────────────────────────────────────────────
// 从 index.js 机械搬移 buildPrompt：纯字符串拼装，无 DOM / store / 历法依赖。
export function buildPrompt(userName, charName, perspective = 'user', pinned = null) {
    const subject   = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    const pins = Array.isArray(pinned) ? pinned.filter(e => e?.title?.trim()) : [];
    const pinnedBlock = pins.length
        ? `\n【已锁定事件·必须保留】\n以下事件已被用户锁定，你必须在新日程中原样保留（标题不可改动），可顺势推进其时间/描述，但严禁删除、改名或替换：\n${pins.map((e, i) => `${i + 1}. ${e.title}${e.time ? `（${e.time}）` : ''}`).join('\n')}\n`
        : '';
    // char 目标天然与 user 关系密切，无需额外提示；非-char 目标（重要 NPC / 其他人物）
    // 生成的日程常与 user 关联过弱，这里加一段「软约束」，让 AI 适度考虑潜在关联，
    // 但不硬绑、不默认爱情、不逼所有事件都围绕 user。
    const relationHint = perspective === 'char'
        ? ''
        : `\n【与 ${companion} 的潜在关联·软提示】\n${subject} 若是重要 NPC / 非主角人物，其日程可以适度体现与 ${companion} 的潜在关联——可以是复仇、陷害、交易、试探、监视、利用、牵制、误导、协作、冲突等多种走向，也可能只是间接波及。请根据剧情自然带出，不必每条事件都围绕 ${companion}，更不要默认写成爱情关系；${subject} 仍应有独立于 ${companion} 的生活与目标。\n`;
    return `请暂停角色扮演，以旁观者视角根据以上剧情，为 ${subject} 生成日程。
【重要】所有输出必须使用中文（人名、地名可保留原文）。
【人称】你是旁观者，不要扮演任何角色。所有文字（含 description 与线头动态）必须以第三人称叙述，直呼 ${subject} 的名字，严禁使用"我""我们"等第一人称，也不要用第二人称"你"。

事件分三类：
- main（明线）：${subject} 直接卷入、正在推进的事件
- hidden（暗线）：隐含的伏笔、悬而未决的走向
- bond（红线）：${subject} 与某人之间可能发生或加深的事件（不限于 ${companion}，可以是任意重要人物）

${subject} 和 ${companion} 都有各自独立的生活，事件可以涉及任意 NPC 和第三方，不必每条都围绕两人互动。
${relationHint}
输出顺序必须严格为 Day 1 → Day 2 → Day 3 → Future → </calendar_widget>，中间不得省略任何块；Day 1-3 每天生成 1 到 3 个事件，Future 块必须生成 5 到 10 个事件，时间跨度不限。预算紧张时缩短说明文字，也不得省略 Future 或结束标签。

【天气说明】
每个 Day 的日头请附带当天天气与温度，格式 Day: N|天气|温度（如 Day: 1|晴|3℃）。
天气是氛围点缀，请结合剧情季节/地域/时间合理"推测"，无需真实准确——晴/多云/阴/小雨/雷阵雨/小雪/大雪/雾 等皆可，温度给摄氏度区间或单值（如 -2℃ / 12~18℃）。
若剧情完全无从判断季节地域，可给一个自洽的温和天气。Future 块不需要天气。

【字段说明】
格式：Event: type|title|description|time|location|线头动态
- type 只能是 main / hidden / bond
- description：以第三人称客观记述 ${subject} 这天经历的事，生活化口吻，直呼其名，不用第一人称，30字以上
- 线头动态：与此事件相关的其他角色同期动态，可以是任意 NPC 或第三方，30字以上；若无关联角色可留空

【日期说明】
Day 1 应从剧情当前时间节点开始，向后推演。如剧情中能明确推断出当前日期则填写 StartDate，否则省略。不要回填已经发生过的日期，Day 1 必须是剧情"现在"或之后的时间。
${pinnedBlock}
【输出格式（严格遵守，只输出以下结构）】
<!-- 日程思考：（结合剧情推演安排，100字以上） -->
<calendar_widget>
StartDate: YYYY-MM-DD（可从剧情推断则填写，否则省略此行）
Day: 1|天气|温度
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Day: 2|天气|温度
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Day: 3|天气|温度
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Future:
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
Event: type|title|description|time|location|线头动态
</calendar_widget>

【Future 说明】
Future 块收录剧情中出现的未来事项，时间不限。
允许基于剧情走向合理推测，但不能凭空捏造剧情中从未提及的约定或承诺。`;
}
