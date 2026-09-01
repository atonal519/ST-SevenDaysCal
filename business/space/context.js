import { buildSpaceChatSystemPrompt, buildSpaceHelpText } from './prompts.js';
import { latestSpaceWidget, stripWidgetsForApi } from './schema.js';

export const LEDGER_READ_KEYWORDS = Object.freeze(['刻度', '暗历', '暗账', '状态', '伤', '病', '孕', '约定', '周期', '待办', '身心', '现在怎', '好了没', '没了结']);

const includesAny = (message, words) => words.some(word => message.includes(word));
const WRITE_RX = /(?:生成|新增|添加|新建|创建|记录|记下|保存|落地|安排|做成|写成|做(?:一|一个|一条|个|条)|加(?:一|个|条)?|改(?:成|一下|为)?|修改|调整|设置|设(?:为|成)|重做|重写|换成|挪到|来一(?:张|个|条)|给我(?:做|来)?一(?:张|个|条))/;
const VIEW_RX = /(?:查看|看看|看下|列出|列表|有哪些|哪几|有几(?:个|条)|多少(?:个|条)|当前|现有|已有|现在(?:有|的)|第\s*\d+\s*条)/;
const RECENT_EDIT_RX = /(?:刚才|方才|上一张|这张|那张|卡片).*(?:改|换|挪|调整|重做|重写|简短|详细|短些|长些)|^(?:把)?(?:时间|地点|标题|描述|类型|阶段|等级|日期|纪年|年号|月份|天数|备注|持续时间).{0,8}(?:改成|换成|挪到|调整为|设为|变成)|^(?:再)?(?:改成|换成|挪到|调整|重做|重写|简短|详细)/;
const POINT_RX = /(?:日程|日历|待办|点卡片?|第\s*\d+\s*条\s*点|(?:当前|现有|已有|所有)(?:的)?点(?=$|[\s，。？！、；：]|要|里|再|改|修|调|重|简|详|短|长)|(?:有哪些|有几(?:个|条)|多少(?:个|条))点|(?:这个|那个)点(?=(?:$|[\s，。？！、；：]|要怎么|怎么|如何|显示|加|改|删|存|落地))|(?:往|向)点里|(?:做|新建|加|新增|添加|创建|生成|记录|保存|落地|安排|修改|查看|看看|列出|给我(?:做|来)?|来)(?:一|一个|一条|个|条)?点(?=$|[\s，。？！、；：]|然后|并|再|和))/;
const LINE_RX = /(?:事件线|剧情线|线索|伏笔|线卡片?|第\s*\d+\s*条\s*线|(?:当前|现有|已有|所有)(?:的)?线(?=$|[\s，。？！、；：]|要|里|再|改|修|调|重|简|详|短|长)|(?:有哪些|有几(?:个|条)|多少(?:个|条))线|(?:这个|那个)线(?=(?:$|[\s，。？！、；：]|要怎么|怎么|如何|显示|加|改|删|存|落地))|(?:往|向)线里|(?:做|新建|加|新增|添加|创建|生成|记录|保存|落地|修改|查看|看看|列出|给我(?:做|来)?|来)(?:一|一个|一条|个|条)?线(?=$|[\s，。？！、；：]|然后|并|再|和))/;
const ERA_RX = /(?:整套(?:的)?历|历法|纪年|年号|月名|月份结构|月份数量|月(?:份)?数|一年(?:有|几|多少|改成|设为|调整为)?[一二三四五六七八九十百\d]*个月|每(?:个)?月(?:都)?(?:天数|(?:有|几|多少)天|(?:(?:改|调整|设置|设)(?:为|成))?[零〇一二两三四五六七八九十百\d]+天)|历法卡片?)/;
const UNIQUE_HELP_RX = /(?:悬浮球|悬浮按钮|潜伏注入|构画设置|构画开关|构画功能|模块教程)/;
const HELP_MODULE_RX = /(?:构画|点卡片?|线卡片?|事件线|轴模块|刻度|面模块|间模块|棱|坐标|历法)/;
const BARE_HELP_MODULE_RX = /(?:^|[\s，。？！、；：])(?:点|线)(?=(?:要|应该)?(?:怎么|如何|怎样)|会(?:不会)?自动|能不能|可以吗|在哪|没反应|没生效|不生效|没出现|不显示)|(?:怎么|如何|怎样)(?:往|向)(?:点|线)里|(?:怎么|如何|怎样)给(?:点|线)(?:里)?(?:加|添加|新增|写|记录|保存|放)|(?:这个|那个)(?:点|线).{0,8}(?:显示|出现|生效|找不到)/;
const BARE_HELP_MODULE_MENTION_RX = /(?:^|[\s，。？！、；：]|给|往|向|到|在)(?:点|线)(?=$|[\s，。？！、；：]|里|中|内|上|的|要|应该|该|加|添加|新增|写|记录|保存|放|修改|显示|使用|打开|关闭)/;
const HELP_ACTION_RX = /(?:加|添加|新增|写|记录|保存|放|修改|显示|使用|打开|关闭)/;
const OPERATION_HELP_RX = /(?:怎么|如何|怎样|在哪|能不能|可以吗|会(?:不会)?自动|支持|自动|后台|没反应|没生效|不生效|没出现|不显示|显示不出来|找不到|怎么弄|啥用|什么用)/;
const WHY_OPERATION_RX = /(?:为什么|为何|为啥).{0,16}(?:显示|出现|生效|找到|添加|新增|生成|使用|打开|关闭)|(?:显示|出现|生效|找到|添加|新增|生成|使用|打开|关闭).{0,16}(?:为什么|为何|为啥)/;
const SETTINGS_HELP_RX = /(?:设置|开关|注入).{0,12}(?:怎么|如何|在哪|没反应|没生效|不生效|找不到)|(?:怎么|如何|在哪|没反应|没生效|不生效|找不到).{0,12}(?:设置|开关|注入)/;
const CANONICAL_ITEM_RX = /(?:第\s*\d+\s*条\s*(?:点|线)|(?:这个|那个|当前|现有|已有)(?:的)?(?:点|线)|(?:当前|现有|已有).{0,8}(?:日程|日历|待办|事件线|剧情线|线索|伏笔))/;
const NO_WRITE_RX = /(?:(?:别|不要|不用|无需|不必|不(?:需要|想|打算|要)|请勿|先别|暂(?:时)?不|取消|停止|禁止).{0,12}|不(?:再)?)(?:生成|新增|添加|新建|创建|记录|保存|落地|安排|做|加|改|修改|调整|设置|设|重做|重写)|(?:只|先)(?:分析|讨论|聊聊|说说|解释)/;
const CANONICAL_EDIT_RX = /(?:第\s*\d+\s*条\s*(?:点|线)|(?:当前|现有|已有)(?:的)?(?:点|线)).{0,12}(?:改|修改|调整|重做|重写|简短|详细|短些|长些)/;

const moduleMatches = message => {
    const era = ERA_RX.test(message);
    const almanac = /(?:重要日期|具体日期|节日|生日|纪念日|年历|历卡片?)/.test(message) || (!era && /日期/.test(message));
    return Object.freeze({ schedule_widget: POINT_RX.test(message), line_widget: LINE_RX.test(message), almanac_widget: almanac, era_widget: era });
};

export function classifySpaceIntent(userMsg, historySnapshot = []) {
    const message = String(userMsg || '').trim();
    const modules = moduleMatches(message);
    const latestWidget = latestSpaceWidget(historySnapshot);
    const operationalQuestion = OPERATION_HELP_RX.test(message) || WHY_OPERATION_RX.test(message);
    const composedModuleHelp = BARE_HELP_MODULE_MENTION_RX.test(message) && HELP_ACTION_RX.test(message) && operationalQuestion;
    const faq = UNIQUE_HELP_RX.test(message)
        || SETTINGS_HELP_RX.test(message)
        || ((HELP_MODULE_RX.test(message) || BARE_HELP_MODULE_RX.test(message) || modules.schedule_widget || modules.line_widget) && operationalQuestion)
        || composedModuleHelp;
    const helpQuestion = faq && operationalQuestion;
    const noWrite = NO_WRITE_RX.test(message);
    const hasWrite = WRITE_RX.test(message) || CANONICAL_EDIT_RX.test(message);
    const writeKinds = !helpQuestion && !noWrite && hasWrite ? Object.keys(modules).filter(kind => modules[kind]) : [];
    if (writeKinds.length > 1) {
        return Object.freeze({ action: 'clarify', kind: null, faq, pointContext: false, lineContext: false, recentWidget: null, reason: 'ambiguous-widget-kind' });
    }
    if (!helpQuestion && !noWrite && RECENT_EDIT_RX.test(message)) {
        const explicitKind = writeKinds[0] || null;
        const canReviseLatest = latestWidget && (!explicitKind || explicitKind === latestWidget.kind) && !CANONICAL_ITEM_RX.test(message);
        if (canReviseLatest) {
            return Object.freeze({ action: 'revise-recent', kind: latestWidget.kind, faq, pointContext: latestWidget.kind === 'schedule_widget', lineContext: latestWidget.kind === 'line_widget', recentWidget: latestWidget, reason: '' });
        }
        if (!latestWidget && !explicitKind) {
            return Object.freeze({ action: 'clarify', kind: null, faq, pointContext: false, lineContext: false, recentWidget: null, reason: 'missing-recent-widget' });
        }
    }
    if (writeKinds.length === 1) {
        const kind = writeKinds[0];
        return Object.freeze({ action: 'write', kind, faq, pointContext: kind === 'schedule_widget', lineContext: kind === 'line_widget', recentWidget: null, reason: '' });
    }
    const pointContext = modules.schedule_widget && VIEW_RX.test(message);
    const lineContext = modules.line_widget && VIEW_RX.test(message);
    return Object.freeze({ action: pointContext || lineContext ? 'view' : 'discuss', kind: null, faq, pointContext, lineContext, recentWidget: null, reason: '' });
}

export function numberedSpaceLineList(raw, parseLines) {
    return (parseLines?.(raw) || []).map((line, index) => {
        const bits = [`#${index + 1}`, line.name || '(未命名)'];
        if (line.type) bits.push(`｜${line.type}`);
        if (line.stage) bits.push(`｜${line.stage}${line.stall ? '(停滞)' : ''}`);
        if (line.when) bits.push(`｜${line.when}`);
        bits.push(`｜${line.agency === 'player' ? '等待用户' : '世界推进'}`);
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
        const intent = classifySpaceIntent(message, historySnapshot);
        const outlineRaw = env.readOutline?.(target) || '';
        const pointList = intent.pointContext
            ? env.numberedPoints?.(env.readPointRaw?.(target) || '') || ''
            : '';
        const lineList = intent.lineContext
            ? numberedSpaceLineList(env.readLineRaw?.(target) || '', env.parseLines)
            : '';
        const ledgerList = ['write', 'revise-recent'].includes(intent.action)
            ? ''
            : (includesAny(message, LEDGER_READ_KEYWORDS) ? env.readLedgerText?.(target) || '' : '');
        const faqText = intent.faq ? buildSpaceHelpText(env.settings?.() || {}) : '';
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
            intent,
        });
        return [{ role: 'system', content: system }, ...stripWidgetsForApi(historySnapshot), { role: 'user', content: userMsg }];
    };
    return Object.freeze({ buildMessages });
}
