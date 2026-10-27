import { narrativePaceContract, narrativePreferenceContract } from '../narrative-preferences.js';

export const OUTLINE_INJECT_KEY = 'sp_outline_step';
export const OUTLINE_INJECT_DEPTH = 4;

export function buildOutlineInjectionText(beats, cursor, cleanText = value => String(value || '')) {
    const current = beats[cursor - 1];
    const next = beats?.[cursor] || null;
    const format = beat => `${beat.time ? beat.time + '·' : ''}《${beat.title}》${beat.type ? '·' + beat.type : ''}`;
    const parts = [
        '【剧情大纲·当前进度参考·仅供你把握走向，切勿直接引用或点破】',
        '请把下面的「当前节点」当作此刻所处的阶段；大纲只提供阶段方向，不规定故事推进速度。',
        '自然、含蓄地顺着它叙事；把「下个节点」当作隐约的方向，不要生硬跳进、不要提前抖开。',
        `当前节点：${format(current)}` + (current.scene ? `\n  ${cleanText(current.scene)}` : ''),
    ];
    if (next) parts.push(`下个节点（仅供未来方向）：${format(next)}` + (next.scene ? `\n  ${cleanText(next.scene)}` : ''));
    else if (current && cursor >= (beats?.length || 0)) parts.push('已是大纲最后一个节点，可从容收束。');
    return parts.join('\n');
}

export function buildOutlineJudgePrompt(current, next, currentScene, nextScene) {
    return `请暂停角色扮演，作为剧情分析助手，判断上面的最近对话是否已经把剧情推进到了「下一个节点」。
当前节点：${current}${currentScene ? '（' + currentScene + '）' : ''}
下一个节点：${next}${nextScene ? '（' + nextScene + '）' : ''}
只有当最近剧情已经明确进入或跨过「下一个节点」所描述的阶段时，才算推进。
若剧情仍停留在当前节点、或在写与主线无关的日常/支线，都算「没推进」。
只回答一个标准值：推进、未推进、没推进、不推进、无推进。不要解释。`;
}

export function buildOutlineRelocationPrompt(beats, current, promptAddon = '', cleanText = value => String(value || '')) {
    const nodes = beats.map((beat, index) => `${index + 1}. ${beat.time ? beat.time + '·' : ''}《${beat.title}》${beat.scene ? `：${cleanText(beat.scene)}` : ''}`).join('\n');
    return `请暂停角色扮演，作为剧情分析助手，根据最近正文判断故事在以下既有大纲节点中最符合哪一个。\n\n【既有节点】\n${nodes}\n\n当前游标：${current}\n\n只能回答一个已有节点编号。允许选择当前节点、之前节点或之后节点；不得新增、改写、合并或删除节点。证据不足时回答当前游标编号。\n\n${promptAddon}`;
}

export function buildOutlineCreationContract(preferences = {}) {
    return `节点是阶段而非逐日流水；按已有状态、人物动机、行动因果与可能变化安排走向，数量随素材浮动，不凑数。平静、关系、成长可以持续；没有外部目标或对抗时不硬造主线。玩家尚未作出的关键决定保持开放，推演不写作既成事实。

${narrativePreferenceContract(preferences)}
${narrativePaceContract(preferences.narrativePace)}

只输出一对闭合的 <outline_widget>...</outline_widget>。每节点按以下顺序逐行填写四项，不留空、不用占位符；Beat 的五值以 | 分隔：
Beat: 粗略推演时间|凝练标题|类型|所属故事线|可能达到的阶段局面
Scene: 该阶段可推动的行动与局面变化
Subtext: 不复述 Scene 的文学化题记
Think: 节点成立的依据与叙事作用

<outline_widget>
Beat: 推演时间|标题|类型|所属故事线|结果
Scene: 行动与局面变化
Subtext: 文学化题记
Think: 成立依据与叙事作用
</outline_widget>`;
}

export function buildOutlinePrompt(userName, charName, perspective = 'user', preferences = {}) {
    const subject = perspective === 'char' ? charName : userName;
    return `请暂停角色扮演，以编剧顾问第三人称视角，用中文直呼角色姓名，不用第一人称；根据以上剧情和设定为 ${subject} 所在故事规划阶段大纲，不续写正文。

${buildOutlineCreationContract(preferences)}`;
}
