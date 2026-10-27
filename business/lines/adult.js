export const ADULT_MODES = Object.freeze(['off', 'mixed', 'dominant']);
export const ADULT_MODE_LABELS = Object.freeze({ off: '关闭', mixed: '混合', dominant: '成人主导' });
const ADULT_SELECTIONS = Object.freeze([
    Object.freeze({ id: 'desire-escalation', drive: '参与者压抑已久的欲望在私下重逢时突破克制', behavior: '由一名参与者先提出并推进更直接的身体亲密，其他参与者明确回应并继续配合', pacing: '先试探、得到回应后逐步加快', scene: '独处且可随时暂停的私密空间', consequence: '身体疲惫与满足并存，参与者对下一次主动联系的预期更明确' }),
    Object.freeze({ id: 'role-reversal', drive: '互动中主动与回应的方式暂时互换', behavior: '主动方提出角色互换与具体身体互动，其他参与者用明确动作回应并共同调整节奏', pacing: '先慢后快，在回应变化处停顿确认', scene: '有足够时间和隐私、可协商边界的场景', consequence: '双方对主动与回应方式及互动边界的理解出现可观察变化' }),
    Object.freeze({ id: 'lingering-touch', drive: '一次告别或擦肩机会放大了未说出口的身体吸引', behavior: '借由持续触碰和脱衣/重新靠近把吸引落实为具体行为，参与者主动回应', pacing: '从短促接触延长为连续推进，节奏随回应升高', scene: '临别前的短暂独处或刚结束社交后的空档', consequence: '离开时留下身体余韵与关系压力，下一次见面更难维持原距离' }),
    Object.freeze({ id: 'aftercare-bond', drive: '成人互动后的照料需求与双方对照料方式的期待', behavior: '一名参与者主动提出继续的亲密行为或照料方式，其他参与者明确回应并选择留下/继续', pacing: '从余韵中的缓慢照料转入第二轮具体推进', scene: '行为结束后仍能保持私密的休息空间', consequence: '身体恢复状况与双方对照料方式的即时感受更明确' }),
    Object.freeze({ id: 'risk-and-reward', drive: '强烈欲望与现实风险并存，参与者共同权衡是否以及如何推进', behavior: '参与者先确认风险与边界，再由主动方推进具体行为，其他参与者以行动回应', pacing: '短促确认后集中推进，风险变化时即时调整', scene: '有时间限制但仍能确认自愿的隐蔽机会', consequence: '即时感受与现实风险影响双方后续安排，下一步按事实重新权衡' }),
]);

export function normalizeAdultMode(value) {
    return ADULT_MODES.includes(value) ? value : 'off';
}

export function allocateAdultPools(mode, count, { activeCount = 0, activeAdultCount = 0 } = {}) {
    const normalized = normalizeAdultMode(mode);
    if (!Number.isInteger(count) || count < 1) return Object.freeze([]);
    const target = normalized === 'dominant' ? 0.7 : normalized === 'mixed' ? 0.3 : 0;
    let total = Math.max(0, Number(activeCount) || 0);
    let adult = Math.max(0, Math.min(total, Number(activeAdultCount) || 0));
    const result = [];
    for (let index = 0; index < count; index++) {
        const choose = candidateAdult => {
            const ratio = (adult + (candidateAdult ? 1 : 0)) / Math.max(1, total + 1);
            return Math.abs(ratio - target);
        };
        const adultDistance = choose(true); const sfwDistance = choose(false);
        const useAdult = target > 0 && adultDistance < sfwDistance;
        result.push(useAdult ? 'nsfw' : 'sfw');
        total += 1; if (useAdult) adult += 1;
    }
    return Object.freeze(result);
}

export function drawAdultSelections(mode, count = 0, { random = Math.random, seed = 0 } = {}) {
    const normalized = normalizeAdultMode(mode);
    if (normalized === 'off' || !Number.isInteger(count) || count < 1) return Object.freeze([]);
    const size = count;
    let state = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : 0;
    const roll = () => {
        if (typeof random === 'function') {
            const value = random();
            if (Number.isFinite(value) && value >= 0 && value < 1) return value;
        }
        state = (Math.imul(state ^ 0x9e3779b9, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const available = ADULT_SELECTIONS.slice(); const result = [];
    for (let index = 0; index < size; index++) {
        if (!available.length) available.push(...ADULT_SELECTIONS);
        result.push(available.splice(Math.floor(roll() * available.length), 1)[0]);
    }
    return Object.freeze(result.map((selection, index) => Object.freeze({ ...selection, index })));
}

function baseAdultPromptGuidance(mode) {
    const normalized = normalizeAdultMode(mode);
    if (normalized === 'off') return '';
    const label = normalized === 'dominant' ? '成人主导模式' : '混合模式';
    const target = normalized === 'dominant' ? '70%' : '30%';
    return `
【成人追加合同·${label}】本地分池目标约 ${target} 成人线；这是选材目标，不是硬配额，证据不足允许低于目标，不为比例造人、串味或凑数。仅适用于明确成年且自愿的虚构角色。SFW 票不得成人化；先按独立事件选材：同次成人互动中的玩法、感受、回应与正常事后照料属于同一生命周期，沿原线展开，不因票内素材另起线或预建未开始阶段；成人场景中的普通职责/事务按其核心目标归类，不因此占用成人新票。新成人线仍须由成人欲望、场景或互动本身驱动，并落实票内的驱动力、行为、节奏、场景与后果。已有非成人线不得强行成人化。成人 Next 写具体玩法/行为、主动方和有据的回应与即时影响。仍有具体目标时不得以含糊或暧昧措辞回避推进，目标完成或失去独立追踪价值时按通用规则退出。高潮、虚脱、留宿、遣回、依赖加深或关系升温只能作为后果，不能单独构成 Next。成人线可为 1v1、1vN 或 NvN，但不得凭空改变人物边界。`;
}

function adultNextStepGuidance() {
    return '【成人 Next 单步护栏】每条 Next 只写当前紧邻的一个关系/时间节点，不必兑现整张票。零接触时可写一次有据邀请或接触及真实当下回应；参与者均非玩家时照写实际回应。仅涉及玩家且玩家尚未回应时留出选择，不代写同意、拒绝或配合；已明确自愿时可据此推进。互动中写一个相邻动作/节奏变化及有据影响；临近或结束后择一写收束、照料或即时反应。可写有据未来动作或待发生回应，不能冒充事实；不得跨两个以上区间或同条包办事后和下次预期。';
}

export function adultPromptGuidance(mode) {
    const normalized = normalizeAdultMode(mode);
    const base = baseAdultPromptGuidance(normalized);
    if (normalized === 'off') return base;
    return `${base}\n${adultNextStepGuidance()}`;
}

export function adultModeForCharacter(settings = {}, key = '') {
    const map = settings.adultMode;
    const configured = map && typeof map === 'object' ? map[key] : undefined;
    return configured === undefined ? 'mixed' : normalizeAdultMode(configured);
}
