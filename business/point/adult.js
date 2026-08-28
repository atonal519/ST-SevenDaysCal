// 点域局部成人票：不依赖线域 allocator，保证每次点请求从空自动池独立签发。
export const POINT_ADULT_MODES = Object.freeze(['off', 'mixed', 'dominant']);
const TARGET = Object.freeze({ off: 0, mixed: 0.3, dominant: 0.7 });
const SELECTIONS = Object.freeze([
    '明确边界后由主动方推进具体亲密行为，另一方当场回应并共同调整节奏',
    '在私密独处中把压抑的欲望落实为双方自愿的连续行为，并产生即时关系变化',
    '当场成人行为持续推进，另一方明确回应后改变参与者当下的选择和依恋压力',
]);
const PROOF_KINDS = Object.freeze(['sexual-contact', 'sexual-penetration', 'sexual-oral', 'sexual-manual']);
const ACTION_PATTERNS = Object.freeze({
    'sexual-contact': /(?:触摸|抚摸|揉捏|摩擦).*(?:乳房|乳头|性器|阴部)|(?:乳房|乳头|性器|阴部).*(?:触摸|抚摸|揉捏|摩擦)/i,
    'sexual-penetration': /(?:插入|进入|深入).*(?:阴道|体内|阴部|性器)|(?:阴道|体内|阴部|性器).*(?:插入|进入|深入)|(?:性交|交合|做爱)/i,
    'sexual-oral': /(?:口交|含住|舔舐).*(?:阴茎|阴部|性器|乳头)|(?:阴茎|阴部|性器|乳头).*(?:口交|含住|舔舐)/i,
    'sexual-manual': /(?:抚弄|揉捏|套弄|摩擦).*(?:阴茎|阴部|性器|乳房|乳头)|(?:阴茎|阴部|性器|乳房|乳头).*(?:抚弄|揉捏|套弄|摩擦)/i,
});
const RESPONSE_WORDS = /(?:主动迎合|主动回应|明确回应|自愿回应|迎合|回握|张开双腿|呻吟|喘息|主动配合|引导节奏|缠住.*手腕)/i;
const CONSENT_WORDS = /(?:自愿|同意|允许|主动回应|明确回应|双方愿意|没有拒绝|引导节奏|缠住.*手腕)/i;
export function normalizePointAdultMode(mode) {
    return POINT_ADULT_MODES.includes(mode) ? mode : 'off';
}

export function allocatePointAdultPools(mode, count) {
    const target = TARGET[normalizePointAdultMode(mode)];
    if (!Number.isInteger(count) || count < 1 || target === 0) return Object.freeze(Array.from({ length: Math.max(0, count || 0) }, () => 'sfw'));
    let adult = 0;
    return Object.freeze(Array.from({ length: Math.min(11, count) }, (_, index) => {
        const total = index + 1;
        const adultDistance = Math.abs((adult + 1) / total - target);
        const sfwDistance = Math.abs(adult / total - target);
        const value = adultDistance < sfwDistance ? 'nsfw' : 'sfw';
        if (value === 'nsfw') adult++;
        return value;
    }));
}

export function pointTicketPlan(mode, count) {
    const pools = allocatePointAdultPools(mode, count);
    return Object.freeze(pools.map((pool, index) => Object.freeze({ id: `POINT-TICKET-${index + 1}`, pool, adult: pool === 'nsfw', selection: pool === 'nsfw' ? SELECTIONS[index % SELECTIONS.length] : '' })));
}

export function parsePointAdultProof(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text || /^NONE$/i.test(text)) return null;
    const match = text.match(/^AdultProof:\s*kind=([a-z-]+)\s*;\s*action=([^;]+?)\s*;\s*response=([^;]+?)\s*;\s*impact=([^;]+?)\s*$/i);
    if (!match || !PROOF_KINDS.includes(match[1].toLowerCase())) return null;
    return Object.freeze({ kind: match[1].toLowerCase(), action: match[2].trim(), response: match[3].trim(), impact: match[4].trim() });
}

export function verifyPointAdultProof(event, proof) {
    if (!event || !proof || !PROOF_KINDS.includes(String(proof.kind || '').toLowerCase())) return false;
    const action = String(proof.action || '').trim(), response = String(proof.response || '').trim(), impact = String(proof.impact || '').trim();
    if (!action || !response || !impact) return false;
    const evidence = `${String(event.desc || '')} ${String(event.npcAction || '')}`;
    if ([action, response, impact].some(part => !evidence.includes(part))) return false;
    const actionSentences = [];
    for (let from = 0; from < evidence.length;) {
        const index = evidence.indexOf(action, from); if (index < 0) break;
        const startBoundary = Math.max(evidence.lastIndexOf('。', index - 1), evidence.lastIndexOf('！', index - 1), evidence.lastIndexOf('!', index - 1), evidence.lastIndexOf('？', index - 1), evidence.lastIndexOf('?', index - 1), evidence.lastIndexOf('\n', index - 1));
        const endCandidates = ['。', '！', '!', '？', '?', '\n'].map(mark => evidence.indexOf(mark, index + action.length)).filter(value => value >= 0);
        const end = endCandidates.length ? Math.min(...endCandidates) : evidence.length;
        actionSentences.push(evidence.slice(startBoundary + 1, end)); from = index + action.length;
    }
    const actionCancellation = sentence => /(?:未|没有|并未|尚未|并没有|并非)\s*(?:发生\s*)?(?:实际接触|成人行为|性行为|抚弄|性交|交合|做爱)/i.test(sentence)
        || /(?:未|没有|并未|尚未|并没有|并非)\s*(?:开始|实施|进行)\s*(?:任何\s*)?(?:实际\s*)?(?:行为|成人行为|性行为)/i.test(sentence)
        || /(?:提及|讨论|回忆|幻想|计划|准备|打算|假设|比较)[^。！？!?\n]*(?:抚弄|性交|交合|做爱|性行为|成人行为)/i.test(sentence)
        || /(?:抚弄|性交|交合|做爱|性行为|成人行为)[^。！？!?\n]{0,24}(?:只是|仅是|提及|讨论|回忆|幻想|计划|准备|打算|假设|比较)/i.test(sentence)
        || /(?:但|却|然而|不过|只是)[^。！？!?\n]*(?:未|没有|并未|尚未|并没有|并非)[^。！？!?\n]*(?:实际接触|成人行为|性行为|抚弄|性交|交合|做爱|发生|开始|实施|进行)/i.test(sentence);
    const responseSentences = [];
    for (let from = 0; from < evidence.length;) {
        const index = evidence.indexOf(response, from); if (index < 0) break;
        const startBoundary = Math.max(evidence.lastIndexOf('。', index - 1), evidence.lastIndexOf('！', index - 1), evidence.lastIndexOf('!', index - 1), evidence.lastIndexOf('？', index - 1), evidence.lastIndexOf('?', index - 1), evidence.lastIndexOf('\n', index - 1));
        const endCandidates = ['。', '！', '!', '？', '?', '\n'].map(mark => evidence.indexOf(mark, index + response.length)).filter(value => value >= 0);
        const end = endCandidates.length ? Math.min(...endCandidates) : evidence.length;
        responseSentences.push(evidence.slice(startBoundary + 1, end)); from = index + response.length;
    }
    const responseCancellation = sentence => /(?:未|没有|并未|尚未|并非|并没有)\s*(?:明确|主动|自愿)?(?:作?回应|迎合|配合|回握|引导节奏)/i.test(sentence)
        || /(?<!没有)(?<!并未)(?<!未)(?:明确拒绝|抗拒|推开|制止|要求停止)/i.test(sentence);
    if (!actionSentences.length || actionSentences.every(actionCancellation) || !responseSentences.length || responseSentences.every(responseCancellation) || !ACTION_PATTERNS[proof.kind]?.test(action) || !RESPONSE_WORDS.test(response) || !CONSENT_WORDS.test(`${response} ${evidence}`)) return false;
    if (!/(?:关系|身体|节奏|变化|影响|痕迹|高潮|满足|依恋|喘息|呼吸)/i.test(impact)) return false;
    if (!/(?:对方|另一方|伴侣|两人|双方)/i.test(`${response} ${evidence}`)) return false;
    return true;
}

export function verifyPointAdultContent(event) {
    if (!event) return false;
    const evidence = `${String(event.desc || '')} ${String(event.npcAction || '')}`;
    const sentences = evidence.split(/[。！？!?\n]/).map(value => value.trim()).filter(Boolean);
    const cancelled = sentence => /(?:未|没有|并未|尚未|并没有|并非)\s*(?:发生\s*)?(?:实际接触|成人行为|性行为|抚弄|性交|交合|做爱)/i.test(sentence)
        || /(?:不含性意味|没有性意味|非性行为|无性意味)/i.test(sentence)
        || /(?:提及|讨论|回忆|幻想|计划|准备|打算|假设|比较)[^，,；;]*?(?:抚弄|性交|交合|做爱|性行为|成人行为)/i.test(sentence)
        || /(?:抚弄|性交|交合|做爱|性行为|成人行为)[^，,；;]{0,24}(?:只是|仅是|提及|讨论|回忆|幻想|计划|准备|打算|假设|比较)/i.test(sentence)
        || /(?:性行为|交合|性交|做爱)[^。！？!?\n]{0,20}(?:之后|后|事后)[^。！？!?\n]*(?:照料|喂水|换药|护理|整理)/i.test(sentence)
        || /(?:比|相比|相较|不如)[^。！？!?\n]{0,24}(?:性行为|交合|性交|做爱)[^。！？!?\n]*(?:更|重要|深|胜过)/i.test(sentence);
    return sentences.some(sentence => {
        if (cancelled(sentence)) return false;
        const direct = /(?:性行为|交合|性交|做爱)/i.test(sentence);
        const manual = /(?:衣物下摆|衣物下|衣物内|衣襟下|解衣后|脱衣后)[^。！？!?\n]{0,100}(?:揉捏|抚弄|摩擦)/i.test(sentence)
            && /(?:吻|回吻|情欲|欲望|身体接触|主动回应|自愿回应|迎合|喘息|呻吟|引导)/i.test(sentence);
        const entry = /(?:情欲|欲望)[^。！？!?\n]{0,60}(?:解衣|解开衣领|脱衣|褪去衣物)[^。！？!?\n]{0,60}(?:进入|插入|深入)|(?:解衣|解开衣领|脱衣|褪去衣物)[^。！？!?\n]{0,60}(?:情欲|欲望)[^。！？!?\n]{0,60}(?:进入|插入|深入)/i.test(sentence);
        return (direct || manual || entry) && /(?:对方|另一方|伴侣|两人|双方|回应|迎合|主动|自愿|关系|节奏|依恋|变化)/i.test(sentence);
    });
}

export function isPointAdultMode(mode) { return normalizePointAdultMode(mode) !== 'off'; }
