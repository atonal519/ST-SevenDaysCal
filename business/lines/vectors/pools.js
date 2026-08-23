// 6×3 第一阶段词表：只描述影响角度，不预设剧情结果。
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

const definitions = {
    subject: {
        id: 'subject', label: '主体动因', tags: [
            ['self-goal', '自我目标', '围绕自身目标推进', 'neutral', 2], ['identity-duty', '身份责任', '履行所处身份带来的责任', 'neutral', 2],
            ['survival-stability', '生存安稳', '维持基本安全与稳定', 'warm', 1], ['belonging', '归属需要', '寻找被接纳或保持归属', 'warm', 1],
            ['curiosity', '求知欲', '了解未知信息或规律', 'neutral', 1], ['prove-self', '证明自己', '展示能力或确认价值', 'tense', 2],
            ['protect-someone', '守护对象', '照看重要的人或事物', 'warm', 2], ['make-amends', '弥补过失', '修补此前留下的亏欠', 'warm', 2],
            ['seek-freedom', '摆脱束缚', '减少限制并争取自主', 'tense', 2], ['keep-dignity', '保持体面', '维持公开形象与尊严', 'neutral', 2],
            ['seek-change', '寻求改变', '推动现状出现变化', 'neutral', 2], ['maintain-status-quo', '维持现状', '避免既有安排被打破', 'neutral', 1],
        ],
    },
    relation: {
        id: 'relation', label: '关系动态', tags: [
            ['mutual-probing', '互相试探', '双方观察彼此的边界与反应', 'neutral', 2], ['tacit-understanding', '默契形成', '双方逐步形成无需明说的配合', 'warm', 1],
            ['trust-shifting', '信任松动', '原有信任程度出现变化', 'tense', 2], ['stance-misaligned', '立场错位', '双方对目标或位置的理解不完全一致', 'tense', 2],
            ['interest-cooperation', '利益协作', '双方围绕共同收益协同行动', 'neutral', 1], ['favor-exchange', '人情往来', '双方交换帮助、承诺或情面', 'warm', 1],
            ['one-sided-reliance', '单向依赖', '一方更多依靠另一方支持', 'tense', 2], ['boundary-negotiation', '边界协商', '双方重新讨论相处范围', 'neutral', 2],
            ['misunderstanding-open', '误解待解', '双方之间存在尚未澄清的理解差异', 'tense', 2], ['old-grievance-ripple', '旧怨余波', '过往摩擦仍影响当前互动', 'tense', 2],
            ['competition-coexists', '竞争并存', '合作与比较同时存在', 'neutral', 2], ['secret-sharing', '秘密共享', '双方共同掌握不公开的信息', 'warm', 2],
        ],
    },
    setting: {
        id: 'setting', label: '场域环境', tags: [
            ['private-space', '私密空间', '较少受到外部视线影响的空间', 'warm', 1], ['public-place', '公共场合', '多人可见或可进入的场合', 'neutral', 1],
            ['familiar-base', '熟悉据点', '一方熟悉并有固定安排的地点', 'warm', 1], ['unfamiliar-area', '陌生区域', '参与者缺少经验的地点', 'tense', 2],
            ['regulated-place', '规则场所', '行为受到明确制度约束的地点', 'neutral', 2], ['transit-zone', '过渡地带', '处在离开或进入之间的区域', 'neutral', 1],
            ['remote-contact', '远程联络', '参与者通过远程方式保持联系', 'neutral', 1], ['temporary-meetup', '临时聚点', '为当前事项临时形成的地点', 'neutral', 1],
            ['enclosed-environment', '封闭环境', '出入或信息流动受到限制的环境', 'tense', 2], ['crowd-attention', '人群视线', '周围人群对互动形成可见压力', 'tense', 2],
            ['power-center', '权力中心', '接近资源分配或规则制定的位置', 'tense', 2], ['marginal-corner', '边缘角落', '远离中心、资源较少的位置', 'neutral', 1],
        ],
    },
    timing: {
        id: 'timing', label: '时机节奏', tags: [
            ['daily-gap', '日常间隙', '发生在常规安排之间的短暂时段', 'neutral', 1], ['deadline-near', '截止将近', '可用时间正在接近边界', 'tense', 2],
            ['delayed-effect', '延迟生效', '当前行动的影响不会立即显现', 'neutral', 1], ['cycle-return', '周期再现', '类似节奏或事项按周期再次出现', 'neutral', 1],
            ['unexpected-early', '意外提前', '预期事项比原计划更早出现', 'tense', 2], ['forced-wait', '被迫等待', '行动暂时受到外部条件牵制', 'tense', 2],
            ['missed-window', '错过窗口', '原本可用的时机已经缩小或过去', 'tense', 2], ['handover-before-after', '交接前后', '处在责任或信息交接的前后阶段', 'neutral', 1],
            ['message-just-arrived', '信息刚到', '新信息刚刚进入当前决策范围', 'neutral', 1], ['emotional-afterglow', '情绪余温', '此前情绪仍在影响当前节奏', 'warm', 2],
            ['sequence-shift', '时序错位', '事件先后与原有预期不完全相同', 'tense', 2], ['brief-opportunity', '短暂机会', '可行动的窗口存在时间有限', 'neutral', 2],
        ],
    },
    resource: {
        id: 'resource', label: '资源条件', tags: [
            ['key-message', '关键消息', '掌握可能影响判断的信息', 'neutral', 1], ['limited-time', '有限时间', '可投入的时间或节奏受到限制', 'tense', 2],
            ['network-channel', '人脉渠道', '可以借助既有联系获得支持', 'warm', 1], ['professional-skill', '专业能力', '具备处理当前事项所需的能力', 'neutral', 1],
            ['legitimate-access', '正当权限', '拥有被规则认可的访问或行动权限', 'neutral', 1], ['hidden-leverage', '隐性筹码', '掌握未公开但可影响判断的条件', 'tense', 2],
            ['public-evidence', '公开证据', '已有可被他人查看的依据', 'neutral', 1], ['ambiguous-clue', '模糊线索', '信息存在但指向尚不清晰', 'tense', 1],
            ['supply-gap', '物资缺口', '当前需要的实体资源并不充足', 'tense', 2], ['reputation-credit', '声誉信用', '过去积累的可信度可以被调用', 'warm', 1],
            ['prior-commitment', '旧有承诺', '已有承诺对当前选择形成约束', 'neutral', 2], ['alternative-plan', '替代方案', '存在可转换的备用安排', 'warm', 1],
        ],
    },
    external: {
        id: 'external', label: '外部变量', tags: [
            ['policy-adjustment', '制度调整', '相关制度或执行方式发生变化', 'neutral', 2], ['public-opinion-shift', '舆论变化', '周围人的公开看法出现变化', 'tense', 2],
            ['weather-impact', '天候影响', '天气条件改变行动安排', 'neutral', 1], ['supply-demand-shift', '供需变化', '外部供给或需求出现变化', 'neutral', 2],
            ['authority-intervention', '权威介入', '更高层级的角色或机构加入事项', 'tense', 2], ['group-movement', '群体动向', '周围群体的选择影响当前环境', 'neutral', 2],
            ['sudden-malfunction', '突发故障', '设备或流程出现未预期的技术问题', 'tense', 2], ['route-blocked', '路线受阻', '原定移动或传递路径受到影响', 'tense', 2],
            ['third-party-request', '第三方请求', '外部参与者提出新的请求或条件', 'neutral', 1], ['regional-change', '地域变化', '所处区域的条件或边界发生变化', 'neutral', 1],
            ['information-spread', '信息扩散', '原本有限的信息被更多人知晓', 'tense', 2], ['chance-coincidence', '偶发巧合', '独立事项在时间或条件上偶然重合', 'warm', 1],
        ],
    },
};

export const POOLS = freeze(Object.fromEntries(Object.entries(definitions).map(([id, pool]) => [id, {
    id, label: pool.label,
    tags: pool.tags.map(([tagId, label, prompt, tone, intensity]) => ({ id: tagId, label, prompt, tone, intensity })),
}])));
export const POOL_IDS = Object.freeze(Object.keys(POOLS));
export const RELATION_POOL_ID = 'relation';
export const RELATION_POOL = POOLS[RELATION_POOL_ID];
