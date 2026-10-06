import { narrativePaceContract, narrativePreferenceContract } from '../narrative-preferences.js';

export const OUTLINE_INJECT_KEY = 'sp_outline_step';
export const OUTLINE_INJECT_DEPTH = 4;

export function buildOutlineInjectionText(beats, cursor, cleanText = value => String(value || ''), preferences = {}) {
    const current = beats[cursor - 1];
    const next = beats[cursor];
    const format = beat => `${beat.time ? beat.time + '·' : ''}《${beat.title}》${beat.type ? '·' + beat.type : ''}`;
    const parts = [
        '【剧情大纲·当前进度参考·仅供你把握走向，切勿直接引用或点破】',
        '请把下面的「当前节点」当作此刻所处的阶段；大纲只提供阶段方向，不规定故事推进速度。',
        '自然、含蓄地顺着它叙事；把「下个节点」当作隐约的方向，不要生硬跳进、不要提前抖开。',
        narrativePreferenceContract(preferences),
        `当前节点：${format(current)}` + (current.scene ? `\n  ${cleanText(current.scene)}` : ''),
    ];
    if (next) parts.push(`下个节点（仅供未来方向）：${format(next)}` + (next.scene ? `\n  ${cleanText(next.scene)}` : ''));
    else parts.push('已是大纲最后一个节点，可从容收束。');
    return parts.join('\n');
}

export function buildOutlineJudgePrompt(current, next, currentScene, nextScene) {
    return `请暂停角色扮演，作为剧情分析助手，判断上面的最近对话是否已经把剧情推进到了「下一个节点」。
当前节点：${current}${currentScene ? '（' + currentScene + '）' : ''}
下一个节点：${next}${nextScene ? '（' + nextScene + '）' : ''}
只有当最近剧情已经明确进入或跨过「下一个节点」所描述的阶段时，才算推进。
若剧情仍停留在当前节点、或在写与主线无关的日常/支线，都算「没推进」。
只回答一个词：推进 或 未推进。不要解释。`;
}

export function buildOutlineRelocationPrompt(beats, current, promptAddon = '', cleanText = value => String(value || '')) {
    const nodes = beats.map((beat, index) => `${index + 1}. ${beat.time ? beat.time + '·' : ''}《${beat.title}》${beat.scene ? `：${cleanText(beat.scene)}` : ''}`).join('\n');
    return `请暂停角色扮演，作为剧情分析助手，根据最近正文判断故事在以下既有大纲节点中最符合哪一个。\n\n【既有节点】\n${nodes}\n\n当前游标：${current}\n\n只能回答一个已有节点编号。允许选择当前节点、之前节点或之后节点；不得新增、改写、合并或删除节点。证据不足时回答当前游标编号。\n\n${promptAddon}`;
}

export function buildOutlineCreationContract(preferences = {}) {
    return `【完整面创作合同】
- 动笔前先在内部判断当前状态、核心驱动力、主要角色或势力、已有故事线与自然走向；这些判断只用于创作，不要另写分析作文。
- 节点代表阶段跨度，不是日程或单镜头；时间依材料与目标推演，观察尺度不等于速度。
- 例：桥检方案草稿已到，复检未做，是否限行待复检结果与值班决定；误写成已封桥。维修队可先核对资料，后续阶段依复检结果规划；复检证据与决定再改变安排，平静待定也能延续。
- 节点数量由当前素材、故事阶段与创作目标自由决定；宁可少而完整，也不要凑数。未来尚未确定时，只提出既有材料容许且有动机、条件与因果支撑的合理分支；未确定本身不是凭空增加冲突、阴谋或灾难的理由。
- 故事线随证据设置：有外部目标、任务或核心对抗才设【主线】，纯关系/日常/成长不造外部线；推进可进退，不套模板。强度依材料，平静阶段可持续。
- Scene：精炼写清这一阶段发生什么、故事整体推进到哪里，着眼阶段走向而非单个镜头。
- Subtext：写成文学化的题记或引言，不复述 Scene；形式与长度随内容自然生发。
- Think：简短说明该节点为何成立，以及它承担的叙事作用或转折逻辑；不要写成逐项答题。
- title 是凝练点题的小标题，可用意象、动作、一个词或半句话，贴合节点气质即可。

${narrativePreferenceContract(preferences)}
${narrativePaceContract(preferences.narrativePace)}

【理想机器结构】
- 完整输出使用一对闭合的 <outline_widget>...</outline_widget>。
- 每个节点包含 Beat、Scene、Subtext、Think 四项业务内容，建议按 Beat → Scene → Subtext → Think 排列。
- Beat 包含五个字段，以竖线分隔：Beat: 推演时间|标题|类型|所属故事线|结果
- 推演时间使用相对、粗略的时间锚，跨度依已有材料和故事阶段合理确定，不精确到某一天。
- 每项填写真实内容，不得用省略号、占位符或“后续同理”代替节点，不得中途截断。

<outline_widget>
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: 这一阶段发生什么、故事整体推进到哪里
Subtext: 文学化题记或引言
Think: 节点成立原因、叙事作用或转折逻辑
</outline_widget>`;
}

export function buildOutlinePrompt(userName, charName, perspective = 'user', preferences = {}) {
    const subject = perspective === 'char' ? charName : userName;
    return `请暂停角色扮演，以编剧顾问身份根据以上剧情，为当前故事生成大纲。
【重要】除固定的机器字段名外，创作正文必须使用中文（人名、地名可保留原文）。
【人称】以编剧顾问的第三人称视角撰写，直呼角色名字，不要扮演角色，严禁使用"我""我们"等第一人称。
【创作关注】请结合 ${subject} 与其他关键角色的现状、动机、关系和既有设定，写出符合人物行为逻辑的长期走向。戏剧强度依材料，不要求升级冲突；平静阶段可以持续。

${buildOutlineCreationContract(preferences)}`;
}
