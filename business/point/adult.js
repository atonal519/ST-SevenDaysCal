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
const PROOF_IGNORED_CHAR = /[\s\p{P}]/u;
const ACTIVE_PROOF_RESPONSE = /(?:转而[^。！？!?\n]*回应[^。！？!?\n]*动作|反手扣住|扣住[^。！？!?\n]*(?:加深|回应)|任由[^。！？!?\n]*(?:律动|动作)|半推半就[^。！？!?\n]*(?:扣住|迎合)|默许)/i;
const SHARED_ADULT_RESULT = /(?:两人|双方)[^。！？!?\n]{0,32}(?:共同)?完成(?:释放|高潮|结合)(?=$|[，,；;])/i;
const UNDER_CLOTHING_CONTACT = /(?:衣物|裤|腰线)[^。！？!?\n]{0,32}(?:探入|伸入)[^。！？!?\n]{0,24}(?:揉捏|抚摸|摩擦)[^。！？!?\n]{0,12}(?:臀部|性器|阴部)/i;
const EXPLICIT_REAL_ADULT_ACTION = /(?:性行为|性交|交合|做爱|口交)/i;
const CLEARLY_NONSEXUAL_PROOF_ACTION = /(?:进入(?:房间|工作状态|资料库)|拿起水杯|普通(?:亲吻|接吻)|裸体休息|替[^。！？!?\n]{0,12}洗澡|按摩(?:肩|背)|事后[^。！？!?\n]{0,20}(?:喂水|换药|护理)|工程师[^。！？!?\n]{0,24}(?:补丁|资料库)|(?:补丁|文档|修改意见|释放版本))/i;

// proof 的引用核验只忽略标点与空白；不做同义词、相似度或任意删词匹配。
function normalizedProofSource(value) {
    const source = String(value || '');
    let text = '';
    const starts = [], ends = [];
    for (let offset = 0; offset < source.length;) {
        const char = String.fromCodePoint(source.codePointAt(offset));
        const end = offset + char.length;
        if (!PROOF_IGNORED_CHAR.test(char)) {
            text += char;
            for (let index = 0; index < char.length; index++) { starts.push(offset); ends.push(end); }
        }
        offset = end;
    }
    return { source, text, starts, ends };
}

function proofSourceSentences(evidence, part) {
    const haystack = normalizedProofSource(evidence);
    const needle = normalizedProofSource(part).text;
    if (!needle) return [];
    const sentences = [];
    for (let from = 0; from <= haystack.text.length - needle.length;) {
        const index = haystack.text.indexOf(needle, from);
        if (index < 0) break;
        const originalStart = haystack.starts[index];
        const originalEnd = haystack.ends[index + needle.length - 1];
        const startBoundary = Math.max(...['。', '！', '!', '？', '?', '\n'].map(mark => haystack.source.lastIndexOf(mark, originalStart - 1)));
        const endCandidates = ['。', '！', '!', '？', '?', '\n'].map(mark => haystack.source.indexOf(mark, originalEnd)).filter(value => value >= 0);
        const endBoundary = endCandidates.length ? Math.min(...endCandidates) : haystack.source.length;
        const sentence = haystack.source.slice(startBoundary + 1, endBoundary);
        if (!sentences.includes(sentence)) sentences.push(sentence);
        from = index + Math.max(1, needle.length);
    }
    return sentences;
}

function matchesAnyAdultAction(value) {
    return Object.values(ACTION_PATTERNS).some(pattern => pattern.test(String(value || '')));
}

function cancelledAdultAction(sentence) {
    return /(?:未|没有|并未|尚未|并没有|并非)\s*(?:发生\s*)?(?:实际接触|成人行为|性行为|抚弄|性交|交合|做爱)/i.test(sentence)
        || /(?:未|没有|并未|尚未|并没有|并非)\s*(?:开始|实施|进行)\s*(?:任何\s*)?(?:实际\s*)?(?:行为|成人行为|性行为)/i.test(sentence)
        || /(?:提及|讨论|回忆|幻想|计划|准备|打算|假设|比较)[^。！？!?\n]*(?:抚弄|性交|交合|做爱|性行为|成人行为)/i.test(sentence)
        || /(?:抚弄|性交|交合|做爱|性行为|成人行为)[^。！？!?\n]{0,24}(?:只是|仅是|提及|讨论|回忆|幻想|计划|准备|打算|假设|比较)/i.test(sentence)
        || /(?:但|却|然而|不过|只是)[^。！？!?\n]*(?:未|没有|并未|尚未|并没有|并非)[^。！？!?\n]*(?:实际接触|成人行为|性行为|抚弄|性交|交合|做爱|发生|开始|实施|进行)/i.test(sentence)
        || /(?:未|没有|并未|尚未|拒绝|停止|制止|推开)[^。！？!?\n]{0,16}(?:插入|进入|深入|触摸|抚摸|揉捏|摩擦|抚弄|套弄)/i.test(sentence)
        || /(?:提及|讨论|回忆|幻想|计划|准备|打算|假设)[^。！？!?\n]{0,40}(?:插入|进入|深入|触摸|抚摸|揉捏|摩擦|抚弄|套弄)/i.test(sentence);
}

function hardRejectedAdultResponse(sentence) {
    return /(?<!没有)(?<!并未)(?<!未)(?:明确拒绝|抗拒|推开|制止|要求停止)/i.test(sentence);
}

function cancelledAdultResponse(sentence) {
    return /(?:未|没有|并未|尚未|并非|并没有)\s*(?:明确|主动|自愿)?(?:作?回应|迎合|配合|回握|引导节奏)/i.test(sentence)
        || hardRejectedAdultResponse(sentence);
}

function nonsexualClinicalOrTrainingContext(sentence, requireAdultAction = true) {
    const text = String(sentence || '');
    const clinicalRoleOrTool = /(?:医生|护士|患者|导管)/i.test(text);
    const procedureOrTraining = /(?:检查|治疗|训练|教学)/i.test(text);
    const simulatedObject = /(?:模型(?!室)|教具|标本)/i.test(text);
    const concreteContact = [ACTION_PATTERNS['sexual-contact'], ACTION_PATTERNS['sexual-oral'], ACTION_PATTERNS['sexual-manual']]
        .some(pattern => pattern.test(text)) || UNDER_CLOTHING_CONTACT.test(text);
    const adultActionMention = EXPLICIT_REAL_ADULT_ACTION.test(text) || concreteContact || matchesAnyAdultAction(text);
    const didacticFrame = /(?:课堂|教学)/i.test(text) && /(?:讲解|说明|讨论|介绍|演示)/i.test(text);
    const clinicalProcedure = /(?:检查|治疗)(?!室)/i;
    const clinicalFrame = /(?:医生|护士)/i.test(text) && (/(?:患者|导管)/i.test(text) || clinicalProcedure.test(text))
        && clinicalProcedure.test(text);
    const frameEnded = /(?:检查|治疗|训练|教学)结束后/i.test(text);
    const actualPartnerAction = /与伴侣[^。！？!?\n]{0,48}(?:解衣|脱衣|性交|交合|做爱|抚弄|揉捏)/i.test(text);
    if (frameEnded && actualPartnerAction) return false;
    if (requireAdultAction && !adultActionMention) return false;
    if (didacticFrame) return true;
    if (clinicalFrame) return true;
    if (simulatedObject && (clinicalRoleOrTool || procedureOrTraining)) return true;
    return false;
}

function structuredProofCounterevidence(sentence) {
    const text = String(sentence || '');
    return cancelledAdultAction(text)
        || hardRejectedAdultResponse(text)
        || (cancelledAdultResponse(text) && !ACTIVE_PROOF_RESPONSE.test(text))
        || nonsexualClinicalOrTrainingContext(text, false)
        || /(?:提及|讨论|回忆|幻想|计划|准备|打算|假设|比较)/i.test(text)
        || /(?:不含性意味|没有性意味|非性行为|无性意味)/i.test(text)
        || /(?:性行为|交合|性交|做爱)[^。！？!?\n]{0,20}(?:之后|后|事后)[^。！？!?\n]*(?:照料|喂水|换药|护理|整理)/i.test(text)
        || /(?:比|相比|相较|不如)[^。！？!?\n]{0,24}(?:性行为|交合|性交|做爱)[^。！？!?\n]*(?:更|重要|深|胜过)/i.test(text)
        || CLEARLY_NONSEXUAL_PROOF_ACTION.test(text);
}
export function normalizePointAdultMode(mode) {
    return POINT_ADULT_MODES.includes(mode) ? mode : 'off';
}

export function allocatePointAdultPools(mode, count) {
    const target = TARGET[normalizePointAdultMode(mode)];
    if (!Number.isInteger(count) || count < 1 || target === 0) return Object.freeze(Array.from({ length: Math.max(0, Math.min(14, count || 0)) }, () => 'sfw'));
    let adult = 0;
    return Object.freeze(Array.from({ length: Math.min(14, count) }, (_, index) => {
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

export function verifyPointAdultProof(event, proof, options = {}) {
    if (!event || !proof || !PROOF_KINDS.includes(String(proof.kind || '').toLowerCase())) return false;
    const action = String(proof.action || '').trim(), response = String(proof.response || '').trim(), impact = String(proof.impact || '').trim();
    if (!action || !response || !impact) return false;
    const evidence = `${String(event.desc || '')} ${String(event.npcAction || '')}`;
    const actionSentences = proofSourceSentences(evidence, action);
    const responseSentences = proofSourceSentences(evidence, response);
    const impactSentences = proofSourceSentences(evidence, impact);
    if (!actionSentences.length || !responseSentences.length || !impactSentences.length) return false;
    const validActionSentences = actionSentences.filter(sentence => !structuredProofCounterevidence(sentence));
    const validResponseSentences = responseSentences.filter(sentence => !structuredProofCounterevidence(sentence));
    const validImpactSentences = impactSentences.filter(sentence => !structuredProofCounterevidence(sentence));
    if (!validActionSentences.length || !validResponseSentences.length || !validImpactSentences.length) return false;
    const normalizedAction = normalizedProofSource(action).text;
    const actionFamily = matchesAnyAdultAction(normalizedAction)
        && validActionSentences.some(sentence => !nonsexualClinicalOrTrainingContext(sentence));
    const responseIsExplicit = RESPONSE_WORDS.test(response) && CONSENT_WORDS.test(`${response} ${evidence}`);
    const impactIsExplicit = /(?:关系|身体|节奏|变化|影响|痕迹|高潮|满足|依恋|喘息|呼吸)/i.test(impact);
    if (actionFamily && responseIsExplicit && impactIsExplicit && /(?:对方|另一方|伴侣|两人|双方)/i.test(`${response} ${evidence}`)) return true;
    if (!options.nsfwTicket) return false;
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
    const structuredAdjacent = sentences.some((actionSentence, index) => {
        if (cancelledAdultAction(actionSentence)) return false;
        if (!UNDER_CLOTHING_CONTACT.test(actionSentence)) return false;
        const responseSentence = sentences[index + 1] || '';
        if (!responseSentence || cancelledAdultResponse(responseSentence)) return false;
        const response = RESPONSE_WORDS.test(responseSentence) || ACTIVE_PROOF_RESPONSE.test(responseSentence);
        return response && SHARED_ADULT_RESULT.test(responseSentence)
            && /(?:对方|另一方|伴侣|两人|双方)/i.test(`${actionSentence} ${responseSentence}`);
    });
    if (structuredAdjacent) return true;
    return sentences.some(sentence => {
        if (cancelled(sentence) || nonsexualClinicalOrTrainingContext(sentence)) return false;
        const direct = /(?:性行为|交合|性交|做爱)/i.test(sentence);
        const manual = /(?:衣物下摆|衣物下|衣物内|衣襟下|解衣后|脱衣后)[^。！？!?\n]{0,100}(?:揉捏|抚弄|摩擦)/i.test(sentence)
            && /(?:吻|回吻|情欲|欲望|身体接触|主动回应|自愿回应|迎合|喘息|呻吟|引导)/i.test(sentence);
        const entry = /(?:情欲|欲望)[^。！？!?\n]{0,60}(?:解衣|解开衣领|脱衣|褪去衣物)[^。！？!?\n]{0,60}(?:进入|插入|深入)|(?:解衣|解开衣领|脱衣|褪去衣物)[^。！？!?\n]{0,60}(?:情欲|欲望)[^。！？!?\n]{0,60}(?:进入|插入|深入)/i.test(sentence);
        return (direct || manual || entry) && /(?:对方|另一方|伴侣|两人|双方|回应|迎合|主动|自愿|关系|节奏|依恋|变化)/i.test(sentence);
    });
}

export function isPointAdultMode(mode) { return normalizePointAdultMode(mode) !== 'off'; }
