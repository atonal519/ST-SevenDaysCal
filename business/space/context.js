import { buildSpaceChatSystemPrompt, buildSpaceHelpText } from './prompts.js';
import { stripWidgetsForApi } from './schema.js';

export const EDIT_POINT_KEYWORDS = Object.freeze(['日程', '日历', '待办', '点']);
export const EDIT_LINE_KEYWORDS = Object.freeze(['事件线', '线索', '伏笔', '线']);
export const LEDGER_READ_KEYWORDS = Object.freeze(['刻度', '暗历', '暗账', '状态', '伤', '病', '孕', '约定', '周期', '待办', '身心', '现在怎', '好了没', '没了结']);
export const SPACE_HELP_KEYWORDS = Object.freeze(['悬浮球', '悬浮按钮', '开关', '在哪', '怎么开', '怎么用', '怎么设', '为什么', '为啥', '没反应', '没生效', '不生效', '注入', '没出现', '不显示', '设置在', '功能', '干嘛', '干什么', '啥用', '什么用', '怎么弄', '找不到', '能不能', '可以吗', '能吗', '会吗', '支持', '自动', '后台', '纪念日', '补录']);

const includesAny = (message, words) => words.some(word => message.includes(word));

export function numberedSpaceLineList(raw, parseLines) {
    return (parseLines?.(raw) || []).map((line, index) => {
        const bits = [`#${index + 1}`, line.name || '(未命名)'];
        if (line.type) bits.push(`｜${line.type}`);
        if (line.stage) bits.push(`｜${line.stage}${line.stall ? '(停滞)' : ''}`);
        if (line.when) bits.push(`｜${line.when}`);
        bits.push(`｜${line.agency === 'player' ? '需推动' : '自演化'}`);
        if (line.desc) bits.push(`｜${line.desc}`);
        if (line.next) bits.push(`｜下一步:${line.next}`);
        return bits.join(' ');
    }).join('\n');
}

export function createSpaceContext(env = {}) {
    const buildMessages = async ({ target, userMsg, historySnapshot }) => {
        const ctx = env.context?.() || {};
        const userName = ctx.name1 || '用户';
        const charName = ctx.name2 || '角色';
        const message = String(userMsg || '');
        const outlineRaw = env.readOutline?.(target) || '';
        const pointList = includesAny(message, EDIT_POINT_KEYWORDS)
            ? env.numberedPoints?.(env.readPointRaw?.(target) || '') || ''
            : '';
        const lineList = includesAny(message, EDIT_LINE_KEYWORDS)
            ? numberedSpaceLineList(env.readLineRaw?.(target) || '', env.parseLines)
            : '';
        const ledgerList = includesAny(message, LEDGER_READ_KEYWORDS) ? env.readLedgerText?.(target) || '' : '';
        const faqText = includesAny(message, SPACE_HELP_KEYWORDS) ? buildSpaceHelpText(env.settings?.() || {}) : '';
        const wiContext = await env.readWorldInfo?.(ctx) || '';
        const memText = await env.readMemory?.(ctx) || '';
        const recentCtx = await env.readRecent?.(ctx) || '';
        const { personaDesc = '', authorNote = '' } = env.readCardExtras?.(ctx) || {};
        const system = buildSpaceChatSystemPrompt({
            userName,
            charName,
            personaDesc,
            authorNote,
            outlineRaw,
            wiContext,
            memText,
            recentCtx,
            pointList,
            lineList,
            ledgerList,
            almanacText: env.readAlmanacText?.(target) || '',
            calDescText: env.readCalendarText?.(target) || '',
            faqText,
            personaOverride: String(env.settings?.()?.spacePersona || '').trim(),
        });
        return [{ role: 'system', content: system }, ...stripWidgetsForApi(historySnapshot), { role: 'user', content: userMsg }];
    };
    return Object.freeze({ buildMessages });
}
