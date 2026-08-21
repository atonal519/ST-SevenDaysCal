export function buildLinesPrompt(userName = '用户', charName = '角色', perspective = 'user', previousRaw = '', scale = 'auto') {
    const subject = perspective === 'char' ? charName : userName;
    return `请根据当前剧情与记忆提炼平行事件线，叙事主体为${subject}。这是结构化输出，不要输出解释、前言或代码块外文字。\n
【推进尺度】${scale === 'macro' ? '关注势力、世界与长期局势。' : scale === 'micro' ? '关注人物当下行动、关系与短期催化。' : '兼顾人物、事件与世界局势，保持可推进的粒度。'}\n
【正式类型】type 只能是冲突或推进。stage 只能是：萌芽、发酵、逼近、已爆发、已消散、筹备、执行、关键、已完成、已失败。level 只能是 1、2、3、4。agency 只能是 player 或 world；stall、pin 只能是 true 或 false。\n
【终态】已爆发、已消散、已完成、已失败均为终态；已终态事件不再推进、不作为潜伏注入候选。\n
【严格格式】必须输出完整闭合的 <storylines_widget>...</storylines_widget>，总数 1-6 条。每条严格按以下顺序输出三行：\nLine: 名称|类型|阶段|等级|时间锚点|agency|stall|pin\nDesc: 当前状态、背景、人物/势力立场（写现在，不写下一步）\nNext: 一句前瞻信号或 stall=true 的恢复条件\n字段内禁止裸 |，不要省略 Desc/Next，不得截断；Line 字段必须恰好 8 段。\n
【当前已追踪】\n${previousRaw || '（无，基于当前剧情新建 1-4 条）'}`.replace(/\{\{user\}\}/g, userName).replace(/\{\{char\}\}/g, charName);
}
