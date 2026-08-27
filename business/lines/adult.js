export const ADULT_MODES = Object.freeze(['off', 'mixed', 'dominant']);
export const ADULT_MODE_LABELS = Object.freeze({ off: '关闭', mixed: '混合', dominant: '成人主导' });
const ADULT_SELECTIONS = Object.freeze([
    Object.freeze({ id: 'desire-escalation', drive: '参与者压抑已久的欲望在私下重逢时突破克制', behavior: '由一名参与者先提出并推进更直接的身体亲密，其他参与者明确回应并继续配合', pacing: '先试探、得到回应后逐步加快', scene: '独处且可随时暂停的私密空间', consequence: '身体疲惫与满足并存，参与者对下一次主动联系的预期更明确' }),
    Object.freeze({ id: 'role-reversal', drive: '关系中的权力与主动权暂时反转', behavior: '主动方提出角色互换与具体身体互动，其他参与者用明确动作回应并共同调整节奏', pacing: '先慢后快，在回应变化处停顿确认', scene: '有足够时间和隐私、可协商边界的场景', consequence: '参与者获得新的掌控感，彼此的信任或依赖出现可观察变化' }),
    Object.freeze({ id: 'lingering-touch', drive: '一次告别或擦肩机会放大了未说出口的身体吸引', behavior: '借由持续触碰和脱衣/重新靠近把吸引落实为具体行为，参与者主动回应', pacing: '从短促接触延长为连续推进，节奏随回应升高', scene: '临别前的短暂独处或刚结束社交后的空档', consequence: '离开时留下身体余韵与关系压力，下一次见面更难维持原距离' }),
    Object.freeze({ id: 'aftercare-bond', drive: '成人行为后的照料需求改变了参与者的关系计算', behavior: '一名参与者主动提出继续的亲密行为或照料方式，其他参与者明确回应并选择留下/继续', pacing: '从余韵中的缓慢照料转入第二轮具体推进', scene: '行为结束后仍能保持私密的休息空间', consequence: '身体恢复、情绪依恋或关系承诺出现即时变化，而非只写留宿' }),
    Object.freeze({ id: 'risk-and-reward', drive: '现实风险与强烈欲望同时存在，迫使参与者做出成人选择', behavior: '参与者先确认风险与边界，再由主动方推进具体行为，其他参与者以行动回应', pacing: '短促确认后集中推进，风险变化时即时调整', scene: '有时间限制但仍能确认自愿的隐蔽机会', consequence: '即时满足伴随暴露、嫉妒或关系筹码变化，下一步选择更具体' }),
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
    if (normalized === 'mixed') return `
【成人剧情素材·混合模式】仅对明确成年且自愿的虚构角色生效。成人选材票上的具体驱动力、行为、节奏、场景与后果是本轮临时素材；可从本轮真实唯一票据中选择合适子集，不适合的票可以不用。使用到 NSFW 票时，该新线必须落实对应成人素材；SFW 新线不得成人化。对带成人选材的新建线和已有成人线，Next 必须写具体玩法/行为、主动方与对方的主动回应、以及即时身体或关系后果；高潮、虚脱、留宿、遣回、依赖加深、关系升温只能作为后果，不能单独构成 Next。普通非成人线继续使用普通 Next。成人素材须结合人物动机与剧情因果，不得凭空改变角色边界。`;
    const guidance = `
【成人剧情素材·成人主导模式】仅对明确成年且自愿的虚构角色生效。成人选材票上的具体驱动力、行为、节奏、场景与后果是本轮临时素材。若本轮标出 SFW/NSFW 分池，SFW 新线不得成人化，NSFW 新线必须由成人欲望、成人场景或成人互动本身驱动，所有新建 NSFW 线都必须绑定成人选材；NSFW 池合同要求所有新建线都必须绑定成人选材，SFW 池是明确例外，不得把普通权谋、任务或交易线仅在 Next 尾部强行性化。比例是本地 allocator 的目标，证据不足时允许少于目标，不得串味凑数。对带成人选材的新建线和已有成人线，Next 必须写具体玩法/行为、主动方与对方的主动回应、以及即时身体或关系后果；高潮、虚脱、留宿、遣回、依赖加深、关系升温只能作为后果，不能单独构成 Next；不得用暧昧、含糊或淡出回避实际推进。同名保留的已有非成人线继续使用普通 Next，不得强行性化。成人线可使用 1v1、1vN 或 NvN；参与者必须是明确成年、自愿的虚构角色。`;
    return guidance;
}

export function adultPromptGuidance(mode) {
    const normalized = normalizeAdultMode(mode);
    const base = baseAdultPromptGuidance(normalized);
    if (normalized === 'off') return base;
    return `${base}\n【成人 Next 单步护栏】成人票的驱动力、行为、节奏、场景与后果供后续多轮展开，不要求一条 Next 全部兑现。先依据最近正文判断亲密进度，每条 Next 只落实当前情境紧邻的一个关系节点或一个连续时间节点：零身体接触或无明确双向回应时，最远写到首次明确邀请/接触及对方当下回应；已处于互动进行中时，只写一个紧接当前动作的玩法变化、主动选择或节奏转折及即时回应/当下影响；已接近结束或刚结束时，只写收束、照料、边界确认或即时关系反应中的一个。不得同条跨越接触前、进行中、事后两个以上区间，不得同时包办结束、事后照料、第二轮和下次预期。即时后果仅指所选动作当场产生的身体感受、选择变化或关系压力；旧 Next 若含多个动作，只取第一个有效节点。仍须明确玩法/行为与双方回应，不得退化为纯氛围暗示。`;
}

export function adultInjectionGuidance(mode) {
    const normalized = normalizeAdultMode(mode);
    if (normalized === 'off') return '';
    const pacing = '先依据最近正文判断亲密进度，每次只落实当前情境紧邻的一个关系节点或一个连续时间节点：零身体接触/无明确双向回应时最远到首次明确邀请或接触及当下回应；互动进行中只写一个紧接当前动作的具体行为/玩法变化、主动选择或节奏转折及即时回应；接近结束或刚结束时只写收束、照料、边界确认或即时关系反应中的一个。不得同条跨越接触前、进行中、事后两个以上区间，不得同时包办结束、事后照料、第二轮和下次预期。仍须保留明确玩法/行为与双方回应，不得退化为纯氛围暗示。';
    if (normalized === 'mixed') return `成人模式已开启：若当前线涉及明确成年且自愿的亲密发展，可把欲望与实际行为推进落实到剧情中，不要只停留在暧昧暗示。${pacing}即时后果仅指所选动作当场产生的身体感受、选择变化或关系压力；旧 Next 若含多个动作，只取第一个有效节点。温和收尾不能单独交差。仍请把伏笔当作暗流，不要生硬提及、不要让角色直接谈论、更不要一次抖开。`;
    return `成人主导模式已开启：请把明确成年且自愿的成人行为推进作为主要叙事方向，落实实际行为与人物主动选择；只落实内容本身已经成人化的线，普通/SFW 线不得强行成人化。${pacing}即时后果仅指所选动作当场产生的身体感受、选择变化或关系压力；旧 Next 若含多个动作，只取第一个有效节点。不得用含糊暧昧或淡出回避已建立的成人线。仍请把伏笔当作暗流，不要生硬提及、不要让角色直接谈论、更不要一次抖开。`;
}

export function adultModeForCharacter(settings = {}, key = '') {
    const map = settings.adultMode;
    return normalizeAdultMode(map && typeof map === 'object' ? map[key] : 'off');
}
