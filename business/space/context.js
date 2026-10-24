import { buildSpaceChatSystemPrompt, buildSpaceHelpText } from './prompts.js';
import { compactLineBaselines, compactPointBaselines, latestSpaceWidget, spacePageId, stripWidgetsForApi } from './schema.js';

export const LEDGER_READ_KEYWORDS = Object.freeze(['刻度', '暗历', '暗账', '状态', '伤', '病', '孕', '约定', '周期', '待办', '身心', '现在怎', '好了没', '没了结']);

const includesAny = (message, words) => words.some(word => message.includes(word));
const EDIT_ACTION_SOURCE = '(?:改|修改|调整|重做|重写|插入|新增|增加|删除|移除|重排|调换|对调|移动|挪|丰富|扩写|补充|细化)';
const EDIT_ACTION_RX = new RegExp(EDIT_ACTION_SOURCE, 'u');
const NODE_MENTION_RX = /节点/u;
const OUTLINE_NODE_MENTION_RX = /(?:面|大纲|剧情).{0,16}节点|节点.{0,16}(?:面|大纲|剧情)/u;
const CURRENT_OUTLINE_SOURCE_RX = /(?:当前|现在|现有|正式)(?:的)?(?:剧情大纲|大纲|剧情|面)|面(?:里|中)(?:的)?节点/u;
const PREVIOUS_DRAFT_REFERENCE_RX = /(?:刚才|方才|上一张|前一张|前一条|这张|那张|刚刚|草稿|候选)/u;
const EDIT_DIRECTIVE_RX = new RegExp(`节点.{0,24}${EDIT_ACTION_SOURCE}(?:一下|下|吧|一个|一(?:个|条)?|到|为|成|掉|进去|出来)|${EDIT_ACTION_SOURCE}.{0,16}节点(?:一下|下|吧)?`, 'u');
const SPACE_MATERIAL_RX = Object.freeze({
    outline: /(?:大纲|面规划|当前面|下一面|面节点|规划到哪)/,
    points: /(?:日程|日历|待办|点卡片?|已有的点|当前点)/,
    lines: /(?:事件线|剧情线|线索|伏笔线|线卡片?|当前线|已有线)/,
    ledger: /(?:刻度|暗历|暗账|伤情|病情|怀孕|孕期|约定|周期|待办|身心状态|伤好了没|没了结)/,
    date: /(?:故事日期|剧情日期|当前故事时间|今天几月|当前日期|几月几日|哪一天|节日|生日|纪念日|周年)/,
    calendar: /(?:历法|纪年|年号|月名|每月几天|几个月|历法月份)/,
    cold: /(?:冷知识|边角知识|已存知识|冷门知识)/,
    menu: /(?:今日菜单|菜单|吃什么|菜品|上次的菜)/,
    theater: /(?:棱|小剧场|棱作品|棱模板|已存作品|已保存作品|作品列表|模板列表)/,
    coordinate: /(?:坐标|收藏夹|收藏楼|收藏的楼|已存坐标|坐标收藏|锚点收藏|展开第\s*\d+\s*楼坐标正文)/,
});

export function requestedSpaceMaterials(message) {
    const text = String(message || '');
    return Object.freeze(Object.fromEntries(Object.entries(SPACE_MATERIAL_RX).map(([key, rx]) => [key, rx.test(text)])));
}
const WRITE_RX = /(?:生成|新增|添加|新建|创建|记录|记下|保存|落地|安排|做成|写成|做(?:一|一个|一条|个|条)|加(?:一|个|条)?|改(?:成|一下|为)?|修改|调整|设置|设(?:为|成)|重做|重写|换成|挪到|插入|移除|删除|重排|调换|对调|来一(?:张|个|条)|给我(?:做|来)?一(?:张|个|条))/;
const VIEW_RX = /(?:查看|看看|看下|列出|列表|有哪些|哪几|有几(?:个|条)|多少(?:个|条)|当前|现有|已有|现在(?:有|的)|第\s*\d+\s*条)/;
const RECENT_EDIT_RX = /(?:刚才|方才|上一张|这张|那张|卡片).*(?:改|换|挪|调整|重做|重写|简短|详细|短些|长些)|^(?:把)?(?:时间|地点|标题|描述|类型|阶段|日期|纪年|年号|月份|天数|备注|持续时间).{0,8}(?:改成|换成|挪到|调整为|设为|变成)|^(?:再)?(?:改成|换成|挪到|调整|重做|重写|简短|详细)|节点.{0,16}(?:新增|插入|增加|删除|移除|重排|调换|对调|移动|挪)|(?:新增|插入|增加|删除|移除|重排|调换|对调|移动|挪).{0,16}节点/;
const FORMAT_CORRECTION_RX = /(?:卡片格式.{0,8}(?:不对|错误|不正确|不行|有问题)|(?:按|用).{0,10}(?:正确|标准)?卡片格式.{0,8}(?:重新|再)?(?:输出|生成|做|写)|重新输出|按正确卡片格式|(?:去看|看看).{0,10}(?:点和线|点|线).{0,10}(?:替换|格式).{0,8}(?:还)?不行)/;
const APPLICATION_FAILURE_RXS = Object.freeze([
    /(?:应用按钮|输出按钮|应用卡片).{0,10}(?:点不了|没出(?:来|现|输出)?|没有|不显示|没显示|是不是.{0,6}(?:格式|有问题))/,
    /没(?:有)?(?:输出|出现|显示).{0,10}(?:应用按钮|输出按钮|按钮)/,
    /(?:点不了|没出(?:来|现|输出)?|没有|不显示|没显示).{0,10}(?:应用按钮|输出按钮|应用卡片)/,
    /(?:方案|卡片|按钮).{0,10}(?:无法应用|应用失败|内容不完整|不完整|点不了)/,
    /(?:无法应用|应用失败|内容不完整).{0,10}(?:方案|卡片|按钮)/,
]);
const isFormatCorrection = message => FORMAT_CORRECTION_RX.test(message) || APPLICATION_FAILURE_RXS.some(rx => rx.test(message));
const isNodeEditRequest = message => NODE_MENTION_RX.test(message) && EDIT_ACTION_RX.test(message)
    && EDIT_DIRECTIVE_RX.test(message)
    && !NO_WRITE_RX.test(message)
    && !PURE_DISCUSSION_RX.test(message)
    && !EXPLICIT_EXPLANATION_RX.test(message);
const isOutlineNodeEditRequest = message => isNodeEditRequest(message) && OUTLINE_NODE_MENTION_RX.test(message);
const isRecentEditRequest = message => RECENT_EDIT_RX.test(message)
    || (PREVIOUS_DRAFT_REFERENCE_RX.test(message) && EDIT_ACTION_RX.test(message))
    || isNodeEditRequest(message);
const FORMAT_TARGET_RX = /(点(?:卡片?)?|线(?:卡片?)?|(?:轴(?:日期)?|历法)(?:卡片?)?|面(?:方案|规划|草稿)?)(?=格式)/gu;
const FORMAT_DESTINATION_RX = /(?:改成|改为|换成|换为|转成|转为|生成|新建|新增|创建|做成|写成|输出成|输出为|重新输出)(?:一|一个|一条|一张|个|条|张)?\s*(点(?:卡片?)?|线(?:卡片?)?|轴(?:日期)?(?:卡片?)?|历法(?:卡片?)?|面(?:方案|规划|草稿)?)/gu;
const SPACE_WIDGET_KINDS = Object.freeze(['schedule_widget', 'line_widget', 'almanac_widget', 'era_widget', 'outline_widget']);
const widgetKindFromLabel = target => {
    if (target.startsWith('点')) return 'schedule_widget';
    if (target.startsWith('线')) return 'line_widget';
    if (target.startsWith('轴')) return 'almanac_widget';
    if (target.startsWith('历法')) return 'era_widget';
    if (target.startsWith('面')) return 'outline_widget';
    return null;
};
const matchedWidgetKind = (message, rx, captureIndex = 0) => {
    const matches = [...String(message).matchAll(new RegExp(rx.source, rx.flags))];
    return widgetKindFromLabel(matches.at(-1)?.[captureIndex] || '');
};
const formatTargetKind = message => matchedWidgetKind(message, FORMAT_TARGET_RX);
const formatDestinationKind = message => matchedWidgetKind(message, FORMAT_DESTINATION_RX, 1);
const POINT_RX = /(?:日程|日历|待办|点卡片?|第\s*\d+\s*条\s*点|(?:当前|现有|已有|所有)(?:的)?点(?=$|[\s，。？！、；：]|要|里|再|改|修|调|重|简|详|短|长)|(?:有哪些|有几(?:个|条)|多少(?:个|条))点|(?:这个|那个)点(?=(?:$|[\s，。？！、；：]|要怎么|怎么|如何|显示|加|改|删|存|落地))|(?:往|向)点里|(?:做|新建|加|新增|添加|创建|生成|记录|保存|落地|安排|修改|查看|看看|列出|给我(?:做|来)?|来)(?:一|一个|一条|个|条)?点(?=$|[\s，。？！、；：]|然后|并|再|和))/;
const LINE_RX = /(?:事件线|剧情线|线索|伏笔|线卡片?|第\s*\d+\s*条\s*线|(?:当前|现有|已有|所有)(?:的)?线(?=$|[\s，。？！、；：]|要|里|再|改|修|调|重|简|详|短|长)|(?:有哪些|有几(?:个|条)|多少(?:个|条))线|(?:这个|那个)线(?=(?:$|[\s，。？！、；：]|要怎么|怎么|如何|显示|加|改|删|存|落地))|(?:往|向)线里|(?:做|新建|加|新增|添加|创建|生成|记录|保存|落地|修改|查看|看看|列出|给我(?:做|来)?|来)(?:一|一个|一条|个|条)?线(?=$|[\s，。？！、；：]|然后|并|再|和))/;
const ERA_RX = /(?:整套(?:的)?历|历法|纪年|年号|月名|月份结构|月份数量|月(?:份)?数|一年(?:有|几|多少|改成|设为|调整为)?[一二三四五六七八九十百\d]*个月|每(?:个)?月(?:都)?(?:天数|(?:有|几|多少)天|(?:(?:改|调整|设置|设)(?:为|成))?[零〇一二两三四五六七八九十百\d]+天)|历法卡片?)/;
const UNIQUE_HELP_RX = /(?:悬浮球|悬浮按钮|潜伏注入|构画设置|构画开关|构画功能|模块教程)/;
const HELP_MODULE_RX = /(?:构画|点卡片?|线卡片?|事件线|轴模块|轴(?:历)?卡片|刻度|面模块|间模块|棱|坐标|历法)/;
const BARE_HELP_MODULE_RX = /(?:^|[\s，。？！、；：])(?:点|线)(?=(?:要|应该)?(?:怎么|如何|怎样)|会(?:不会)?自动|能不能|可以吗|在哪|没反应|没生效|不生效|没出现|不显示)|(?:怎么|如何|怎样)(?:往|向)(?:点|线)里|(?:怎么|如何|怎样)给(?:点|线)(?:里)?(?:加|添加|新增|写|记录|保存|放)|(?:这个|那个)(?:点|线).{0,8}(?:显示|出现|生效|找不到)/;
const BARE_HELP_MODULE_MENTION_RX = /(?:^|[\s，。？！、；：]|给|往|向|到|在)(?:点|线)(?=$|[\s，。？！、；：]|里|中|内|上|的|要|应该|该|加|添加|新增|写|记录|保存|放|修改|显示|使用|打开|关闭)/;
const HELP_ACTION_RX = /(?:加|添加|新增|写|记录|保存|放|修改|显示|使用|打开|关闭)/;
const OPERATION_HELP_RX = /(?:怎么|如何|怎样|在哪|能不能|可以吗|会(?:不会)?自动|支持|自动|后台|没反应|没生效|不生效|没出现|不显示|显示不出来|找不到|怎么弄|啥用|什么用)/;
const WHY_OPERATION_RX = /(?:为什么|为何|为啥).{0,16}(?:显示|出现|生效|找到|添加|新增|生成|使用|打开|关闭)|(?:显示|出现|生效|找到|添加|新增|生成|使用|打开|关闭).{0,16}(?:为什么|为何|为啥)/;
const SETTINGS_HELP_RX = /(?:设置|开关|注入).{0,12}(?:怎么|如何|在哪|没反应|没生效|不生效|找不到)|(?:怎么|如何|在哪|没反应|没生效|不生效|找不到).{0,12}(?:设置|开关|注入)/;
const CANONICAL_ITEM_RX = /(?:第\s*\d+\s*条\s*(?:点|线)|(?:这个|那个|当前|现有|已有)(?:的)?(?:点|线)|(?:当前|现有|已有).{0,8}(?:日程|日历|待办|事件线|剧情线|线索|伏笔))/;
const CURRENT_POINT_ITEM_RX = /(?:第\s*\d+\s*条\s*点|(?:这个|那个|当前|现有|已有)(?:的)?点)/u;
const CURRENT_LINE_ITEM_RX = /(?:第\s*\d+\s*条\s*线|(?:这个|那个|当前|现有|已有)(?:的)?线)/u;
const APPLICATION_BUTTON_REQUEST_RX = /(?:给我|请|想要|需要)?(?:一个|一份|对应的)?应用按钮|(?:应用到哪|要应用什么|哪种应用卡)/;
const CANONICAL_ITEM_REFERENCE_SOURCE = '(?:(?:当前|现有|已有)(?:的)?(?:点|线)(?:第\\s*\\d+\\s*条)?|第\\s*\\d+\\s*条\\s*(?:点|线))';
const CANONICAL_EDIT_RX = new RegExp(`(?:${CANONICAL_ITEM_REFERENCE_SOURCE}).{0,12}(?:${EDIT_ACTION_SOURCE}|简短|详细|短些|长些)(?!了|好|完)(?:一下|下|些|点)?|^(?:把|将|请|帮我|给我)?${EDIT_ACTION_SOURCE}.{0,16}(?:${CANONICAL_ITEM_REFERENCE_SOURCE})`, 'u');
const isCanonicalEditRequest = message => CANONICAL_EDIT_RX.test(message)
    && !NO_WRITE_RX.test(message)
    && !PURE_DISCUSSION_RX.test(message)
    && !EXPLICIT_EXPLANATION_RX.test(message);
const canonicalItemKind = message => CURRENT_POINT_ITEM_RX.test(message) ? 'schedule_widget'
    : CURRENT_LINE_ITEM_RX.test(message) ? 'line_widget' : null;
const LOOSE_POINT_RX = /(?:^|[^\p{L}\p{N}_])点(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|(?:一|一个|一条|个|条|张)点(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])/u;
const LOOSE_LINE_RX = /(?:^|[^\p{L}\p{N}_])线(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|(?:一|一个|一条|个|条|张)线(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])/u;
const LOOSE_ALMANAC_RX = /(?:^|[^\p{L}\p{N}_])历(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|(?:一|一个|一条|个|条|张)历(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])/u;
const DIRECT_POINT_REQUEST_RX = /(?:写|生|插|做|弄|生成|创建|输出|整理|转换?)(?:成|为)?(?:一|一个|一条|个|条|张)?点(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|(?:给我|帮我|替我|为我|请)(?:出|来)(?:一|一个|一条|个|条|张)?点(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|点(?:卡片)?(?:给我|帮我|替我|为我|安排|来|做)/u;
const DIRECT_LINE_REQUEST_RX = /(?:写|生|插|做|弄|生成|创建|输出|整理|转换?)(?:成|为)?(?:一|一个|一条|个|条|张)?线(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|(?:给我|帮我|替我|为我|请)(?:出|来)(?:一|一个|一条|个|条|张)?线(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|线(?:卡片)?(?:给我|帮我|替我|为我|安排|来|做)/u;
const DIRECT_ALMANAC_REQUEST_RX = /(?:写|生|做|弄|生成|创建|输出|整理|转换?)(?:成|为)?(?:一|一个|一条|个|条|张)?历(?!法)(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|(?:给我|帮我|替我|为我|请)(?:出|来)(?:一|一个|一条|个|条|张)?历(?!法)(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|历(?:卡片)?(?:给我|帮我|替我|为我|安排|来|做)/u;
const DIRECT_AXIS_CARD_REQUEST_RX = /(?:写|生|做|弄|生成|创建|输出|整理|转换?)(?:成|为)?(?:一|一个|一条|个|条|张)?轴(?:历)?卡片(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|(?:给我|帮我|替我|为我|请)(?:出|来)(?:一|一个|一条|个|条|张)?轴(?:历)?卡片(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])|轴(?:历)?卡片(?:给我|帮我|替我|为我|安排|来|做)/u;
const OUTLINE_REQUEST_RX = /(?:生成|整理|梳理|写|做|改|修改|调整|重做|重写|更新|转换|产出|输出).{0,16}(?:完整)?(?:正式)?(?:剧情)?(?:大纲|面)(?:方案|草稿)?|(?:给我|帮我|替我|为我|请)(?:来|出)(?:一版|一份|一个|一条|一|个|条)(?:大纲|面)(?:方案|草稿)?(?=$|[\s，。？！、；：,:;!?）)」』】”’])|(?:大纲|面)(?:方案|草稿).{0,12}(?:生成|整理|修改|调整|重做|重写|更新|应用)|(?:把|将).{0,32}(?:整理成|做成|生成|改成|修改成).{0,24}(?:可应用到面|面方案|大纲)(?:的)?(?:完整)?(?:方案|草稿)?|可应用到面(?:的)?(?:完整)?(?:方案|草稿)?/;
const DESIRED_POINT_RX = /(?:我要|我想要|我可以要|想要|需要)(?:一|一个|一条|个|条|张)?点(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])/u;
const DESIRED_LINE_RX = /(?:我要|我想要|我可以要|想要|需要)(?:一|一个|一条|个|条|张)?线(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])/u;
const DESIRED_ALMANAC_RX = /(?:我要|我想要|我可以要|想要|需要)(?:一|一个|一条|个|条|张)?历(?!法)(?:卡片)?(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])/u;
const DESIRED_AXIS_CARD_RX = /(?:我要|我想要|我可以要|想要|需要)(?:一|一个|一条|个|条|张)?轴(?:历)?卡片(?=$|[吗呢吧呀啊嘛呗]|[^\p{L}\p{N}_])/u;
const NEGATED_DISCOURSE_THEN_CARD_RX = /(?:别|不要|不用|无需|不必|请勿|先别|暂(?:时)?不)(?:再)?(?:讨论|解释|分析|寒暄|评价|说明|聊聊|说说)(?:[，。？！；：,:;!?\s]*直接)*[，。？！；：,:;!?\s]*(?:给我|帮我|替我|为我|请)?(?:写|出|生|插|做|弄|生成|创建|输出|整理|转换?)(?:成|为)?(?:一|一个|一条|个|条|张)?(?:点|线|历法?|面)(?:卡片)?/;
const SEMANTIC_CARD_RX = /结构化卡片|(?:历|历法)卡片/;
const PURE_DISCUSSION_RX = /(?:为什么|为何|为啥|是不是|是否|怎么看|如何理解|什么意思|意味着|象征|合理(?:吗|么)|成立(?:吗|么)|怎么样|怎么回事|[？?]|吗$|呢$)/;
const PURE_EXPLANATION_RX = /^\s*(?:我)?(?:只是|只|单纯)?(?:想)?(?:问|了解|请教|听听解释)/;
const EXPLICIT_EXPLANATION_RX = /^\s*(?:(?:请|麻烦|劳驾|帮我|给我)\s*)?(?:解释|说明|释义|解读|讲解|分析理解)(?:一下|下)?/;
const REQUEST_LANGUAGE_RX = /(?:给我|帮我|请|我要|我想|想要|需要|替我|为我|生成|新增|添加|新建|创建|记录|记下|保存|落地|安排|做|写|出|生|插|来|弄|输出|整理|转成|转换|改|修改|调整|设置|重做|重写)/;
const NO_WRITE_RX = /(?:不要|别|不用|无需|不必|请勿|先别|暂(?:时)?不).{0,12}(?:生成|新增|添加|新建|创建|记录|记下|保存|落地|安排|做|写|出|生|插|弄|整理|转换|改|修改|调整|重做|重写|插入|删除|移除|重排|调换|对调|移动|挪|丰富|扩写|补充|细化|卡片)|我不(?:想|需要|要).{0,8}(?:点|线|历|面|卡片)/;
const DELEGATED_REQUEST_RX = /(?:给我|帮我|替我|为我|我要|我想|想要|我可以要|能不能.{0,4}给我|可以.{0,4}给我)/;
const QUOTED_CARD_MENTION_RX = /(?:例如|比如|例子|举例|引用)[^"“‘\n]{0,16}["“‘][^"”’\n]{0,80}(?:点|线|历|卡片)[^"”’\n]{0,80}["”’]|["“‘][^"”’\n]{0,80}(?:点|线|历|卡片)[^"”’\n]{0,80}["”’].{0,32}(?:这句话|这个词|例子|引用|说法|表达|意思|说明|句式|比喻|你觉得|怎么回答|不用执行|不要执行)/;
const MENTION_ONLY_RX = /(?:只是|仅仅|仅是|不过是).{0,12}(?:提到|提及|说到|谈到|引用)|(?:这里|此处).{0,12}(?:比喻|词语|说法|含义)/;
const EVALUATION_RX = /(?:写得|做得|设计得|设定得?).{0,10}(?:好|巧|妙|温馨|独特|不错|有趣|自然)|(?:很好|巧妙|温馨|独特|不错|有趣|很自然)[。！!~～]*$/;
const EXPLICIT_GREETING_RX = /^\s*(?:你好|您好|嗨|哈(?:喽|啰|罗)|早上好|上午好|中午好|下午好|晚上好|晚安|在吗|谢谢|感谢|辛苦了)[呀啊哦哈嘛吗！!。,.，~～\s]*$/;
const GENERAL_REQUEST_RX = /^\s*(?:请|麻烦|劳驾|帮|给|把|替|为|我要|我想|想要|需要|能否|可否|可以|生成|新增|添加|新建|创建|记录|记下|保存|安排|修改|调整|重做|重写|整理|梳理|归纳|总结|铺)/;

const ROUTE_TARGETS = Object.freeze([
    ['schedule_widget', /(?:日程|日历|待办|点(?:卡片?)?)(?=$|[\s，。？！、；：,:;!?）)\]」』”’"']|和|及|与|然后|并|改|修改|调整|转|转换|变成|整理|梳理|生成|做成|写成)/u],
    ['line_widget', /(?:事件线|剧情线|线索|伏笔|线(?:卡片?)?)(?=$|[\s，。？！、；：,:;!?）)\]」』”’"']|和|及|与|然后|并|改|修改|调整|转|转换|变成|整理|梳理|生成|做成|写成)/u],
    ['almanac_widget', /(?:重要日期|具体日期|节日|生日|纪念日|年历|轴(?:日期)?(?:卡片)?)(?=$|[\s，。？！、；：,:;!?）)\]」』”’"']|和|及|与|然后|并|改|修改|调整|转|转换|变成|整理|梳理|生成|做成|写成)/u],
    ['era_widget', /(?:历法|纪年|年号)(?=$|[\s，。？！、；：,:;!?）)\]」』”’"']|和|及|与|然后|并|改|修改|调整|转|转换|变成|整理|梳理|生成|做成|写成)/u],
    ['outline_widget', /(?:大纲|面(?:方案|规划|草稿)?)(?=$|[\s，。？！、；：,:;!?）)\]」』”’"']|和|及|与|然后|并|改|修改|调整|转|转换|变成|整理|梳理|生成|做成|写成|丰富|扩写|补充|细化)/u],
]);
const ROUTE_ACTION_RX = /(?:整理(?:成|为)|梳理(?:成|为)|转换(?:成|为)|转(?:成|为)|变成|改(?:成|为)|修改(?:成|为)|调整(?:成|为)|输出(?:成|为)|生成|新建|创建|制作|做成|写成|产出|整理|梳理|转换|转|改|修改|调整|做|写|插|输出)/gu;
const SOURCE_REFERENCE_RX = /(?:(?:把|将)\s*)?(?:刚才|方才|上一张|前一张|前一条|这张|那张|刚刚)([\s\S]{0,24}?)(?:改|修改|调整|转(?:成|为)?|转换(?:成|为)|变成|整理(?:成|为)|梳理(?:成|为)|生成|做成|写成|丰富|扩写|补充|细化)/u;

const sourceReference = message => {
    const match = SOURCE_REFERENCE_RX.exec(message);
    if (!match) return { found: false, kind: null };
    const source = match[1].trim().replace(/^(?:的|那|这)(?:(?:一)?(?:张|条|个))?/u, '');
    for (const [kind, targetRx] of ROUTE_TARGETS) {
        const target = targetRx.exec(source);
        if (target && target.index === 0) return { found: true, kind };
    }
    return { found: true, kind: null };
};

const explicitTargetRoutes = message => {
    if (EXPLICIT_EXPLANATION_RX.test(message) && !DELEGATED_REQUEST_RX.test(message)) return [];
    const isQuoted = index => [['“', '”'], ['"', '"'], ['「', '」'], ['『', '』'], ['‘', '’']].some(([open, close]) => {
        const start = message.lastIndexOf(open, index);
        if (open === close) return start >= 0 && message.indexOf(close, start + 1) > index;
        return start >= 0 && start > message.lastIndexOf(close, index) && message.indexOf(close, start + open.length) > index;
    });
    const matches = [];
    for (const action of message.matchAll(ROUTE_ACTION_RX)) {
        if (isQuoted(action.index)) continue;
        const clauseStart = Math.max(...['，', ',', '。', '；', ';', '！', '!', '？', '?', '\n'].map(separator => message.lastIndexOf(separator, action.index - 1) + 1));
        const clausePrefix = message.slice(clauseStart, action.index);
        if (/(?:不要|别|不用|无需|不必|请勿|先别|暂(?:时)?不)(?:再|继续|去)?|我不(?:想|需要|要)|不\s*$/u.test(clausePrefix)) continue;
        const isHelpQuestion = /(?:怎么|如何|怎样|在哪|能不能|可以吗|支持|没反应|没生效|不生效|找不到)\s*$/u.test(clausePrefix);
        const actionEnd = action.index + action[0].length;
        const tail = message.slice(actionEnd).match(/^\s*(?:(?:到|成|为)\s*)?(?:(?:一个|一条|一张|一|个|条|张)\s*)?/u)?.[0] || '';
        const targetStart = actionEnd + tail.length;
        const rest = message.slice(targetStart);
        let found = false;
        for (const [kind, targetRx] of ROUTE_TARGETS) {
            const target = targetRx.exec(rest);
            if (target && target.index === 0) {
                matches.push({ kind, end: targetStart + target[0].length, help: isHelpQuestion });
                found = true;
                break;
            }
        }
        if (!found) continue;
        const after = message.slice(matches.at(-1).end);
        const coordinated = after.match(/^\s*(?:和|及|与|、)\s*/u)?.[0];
        if (coordinated) {
            const coordinatedStart = matches.at(-1).end + coordinated.length;
            const remainder = message.slice(coordinatedStart);
            for (const [kind, targetRx] of ROUTE_TARGETS) {
                const target = targetRx.exec(remainder);
                if (target && target.index === 0) matches.push({ kind, end: coordinatedStart + target[0].length, help: isHelpQuestion });
            }
        }
    }
    return matches;
};

const makeWriteIntent = ({ kind, faq, message, latestWidget }) => {
    const hasSourceReference = SOURCE_REFERENCE_RX.test(message);
    const sourceWidget = hasSourceReference && latestWidget?.kind !== kind ? latestWidget : null;
    const editExisting = isCanonicalEditRequest(message) && !sourceWidget
        && (!canonicalItemKind(message) || canonicalItemKind(message) === kind);
    return Object.freeze({
        action: 'write', kind, faq,
        pointContext: kind === 'schedule_widget',
        lineContext: kind === 'line_widget',
        recentWidget: null,
        ...(sourceWidget ? { sourceWidget } : {}),
        ...(editExisting ? { editExisting: true } : {}),
        reason: '',
    });
};

const moduleMatches = message => {
    // “轴/轴历卡片”默认指具体日期 almanac_widget；只有明确出现历法、纪年或月份结构时才归入
    // era_widget。该优先级先于后续歧义判断，避免同一句被识别为两种轴卡。
    const era = ERA_RX.test(message);
    const explicitObject = CANONICAL_ITEM_RX.test(message);
    const almanac = /(?:重要日期|具体日期|节日|生日|纪念日|年历)/.test(message)
        || (!era && /(?:历卡片?|轴(?:历)?卡片)/.test(message))
        || (!era && !explicitObject && /日期/.test(message));
    return Object.freeze({ schedule_widget: POINT_RX.test(message), line_widget: LINE_RX.test(message), almanac_widget: almanac, era_widget: era });
};

const previousFormatTarget = (history, latestWidget, widgetParsers) => {
    let kind = null;
    for (let index = (Array.isArray(history) ? history.length : 0) - 1; index >= 0; index -= 1) {
        const item = history[index];
        if (item?.role === 'assistant') {
            if (!SPACE_WIDGET_KINDS.includes(item.expectedWidgetKind)) {
                if (kind) break;
                continue;
            }
            if (kind && item.expectedWidgetKind !== kind) break;
            kind ||= item.expectedWidgetKind;
            continue;
        }
        if (item?.role !== 'user' || !kind) continue;
        const request = String(item.content || '');
        if (isFormatCorrection(request)) continue;
        const intent = classifySpaceIntent(request, [], widgetParsers);
        if (['write', 'revise-recent'].includes(intent.action) && intent.kind === kind) {
            return { kind, originalRequest: request, recentWidget: latestSpaceWidget(history, kind, widgetParsers) };
        }
    }
    return kind ? { kind, originalRequest: '', recentWidget: latestSpaceWidget(history, kind, widgetParsers) }
        : latestWidget ? { kind: latestWidget.kind, originalRequest: '', recentWidget: latestWidget } : null;
};

export function classifySpaceIntent(userMsg, historySnapshot = [], widgetParsers = {}) {
    const message = String(userMsg || '').trim();
    if (widgetParsers.pageId) {
        const scoped = historySnapshot.map(item => spacePageId(item) === widgetParsers.pageId ? item : null);
        if (latestSpaceWidget(scoped, sourceReference(message).kind, widgetParsers)) historySnapshot = scoped;
    }
    const requestedMaterials = requestedSpaceMaterials(message);
    const routedTargets = explicitTargetRoutes(message);
    let routedKinds = [...new Set(routedTargets.map(({ kind }) => kind))];
    const routedHelpQuestion = routedTargets.length > 0 && routedTargets.every(({ help }) => help);
    const modules = moduleMatches(message);
    if (modules.era_widget && /轴(?:历)?卡片/.test(message) && routedKinds.includes('almanac_widget')) {
        routedKinds = routedKinds.map(kind => kind === 'almanac_widget' ? 'era_widget' : kind);
    }
    const semanticModules = Object.freeze({
        schedule_widget: modules.schedule_widget || (isCanonicalEditRequest(message) && CURRENT_POINT_ITEM_RX.test(message)) || LOOSE_POINT_RX.test(message) || DIRECT_POINT_REQUEST_RX.test(message) || DESIRED_POINT_RX.test(message),
        line_widget: modules.line_widget || (isCanonicalEditRequest(message) && CURRENT_LINE_ITEM_RX.test(message)) || LOOSE_LINE_RX.test(message) || DIRECT_LINE_REQUEST_RX.test(message) || DESIRED_LINE_RX.test(message),
        almanac_widget: modules.almanac_widget || LOOSE_ALMANAC_RX.test(message) || DIRECT_ALMANAC_REQUEST_RX.test(message) || DESIRED_ALMANAC_RX.test(message) || (!modules.era_widget && (DIRECT_AXIS_CARD_REQUEST_RX.test(message) || DESIRED_AXIS_CARD_RX.test(message))),
        era_widget: modules.era_widget,
        outline_widget: OUTLINE_REQUEST_RX.test(message) || isOutlineNodeEditRequest(message),
    });
    const semanticKinds = Object.keys(semanticModules).filter(kind => semanticModules[kind]);
    const source = sourceReference(message);
    const latestWidget = latestSpaceWidget(historySnapshot, source.kind, widgetParsers);
    const operationalQuestion = OPERATION_HELP_RX.test(message) || WHY_OPERATION_RX.test(message);
    const composedModuleHelp = BARE_HELP_MODULE_MENTION_RX.test(message) && HELP_ACTION_RX.test(message) && operationalQuestion;
    const faqCandidate = UNIQUE_HELP_RX.test(message)
        || SETTINGS_HELP_RX.test(message)
        || ((HELP_MODULE_RX.test(message) || BARE_HELP_MODULE_RX.test(message) || modules.schedule_widget || modules.line_widget) && operationalQuestion)
        || composedModuleHelp;
    const noWrite = (NO_WRITE_RX.test(message)
        || /(?:^|[，,。；;！!？?\s])不(?:要|再|继续)?(?:生成|新增|添加|新建|创建|出|插|写|做|整理|转换|改).{0,12}(?:点|线|历|面|卡片)/u.test(message))
        && !NEGATED_DISCOURSE_THEN_CARD_RX.test(message) && !routedKinds.length;
    const asksForExplanation = EXPLICIT_EXPLANATION_RX.test(message) || /^(?:为什么|为何|为啥)/u.test(message);
    if (isFormatCorrection(message) && !noWrite && !asksForExplanation) {
        const priorExpected = previousFormatTarget(historySnapshot, latestWidget, widgetParsers);
        const destinationKind = formatDestinationKind(message);
        if (!destinationKind && (semanticKinds.length > 1 || routedKinds.length > 1)) {
            return Object.freeze({ action: 'clarify', kind: null, faq: false, pointContext: false, lineContext: false, recentWidget: null, reason: 'ambiguous-widget-kind' });
        }
        const kind = destinationKind || (semanticKinds.length === 1 ? semanticKinds[0]
            : routedKinds.length === 1 ? routedKinds[0]
                : formatTargetKind(message) || priorExpected?.kind || null);
        if (!kind || !SPACE_WIDGET_KINDS.includes(kind)) {
            return Object.freeze({ action: 'clarify', kind: null, faq: false, pointContext: false, lineContext: false, recentWidget: null, reason: 'missing-format-widget-kind' });
        }
        const originalIntent = priorExpected?.kind === kind && priorExpected.originalRequest
            ? classifySpaceIntent(priorExpected.originalRequest, [])
            : null;
        const explicitNewRequest = /(?:新建|新增|新生成|另建|再建|创建|生成(?:一|个|条|张|点|线|历|轴|面))/u.test(message);
        const explicitTargetChange = Boolean(destinationKind && /(?:改成|改为|换成|换为|转成|转为)/u.test(message));
        const editExisting = CANONICAL_ITEM_RX.test(message)
            || (!explicitNewRequest && !explicitTargetChange && originalIntent?.kind === kind && originalIntent.editExisting === true);
        return Object.freeze({
            action: 'write', kind, faq: false,
            pointContext: kind === 'schedule_widget', lineContext: kind === 'line_widget',
            recentWidget: priorExpected?.recentWidget || (latestWidget?.kind === kind ? latestWidget : null), formatRepair: true,
            ...(editExisting ? { editExisting: true } : {}), reason: '',
        });
    }
    const delegatedCardRequest = !noWrite && semanticKinds.length > 0 && DELEGATED_REQUEST_RX.test(message);
    const hasPositiveRoute = routedTargets.some(({ help }) => !help);
    const faq = faqCandidate && !delegatedCardRequest && !hasPositiveRoute;
    if (!noWrite && APPLICATION_BUTTON_REQUEST_RX.test(message) && !semanticKinds.length) {
        return Object.freeze({ action: 'clarify', kind: null, faq, pointContext: false, lineContext: false, recentWidget: null, reason: 'missing-widget-kind' });
    }
    const helpQuestion = routedHelpQuestion || (faq && operationalQuestion && !delegatedCardRequest && !hasPositiveRoute);
    const hasWrite = routedKinds.length > 0 || WRITE_RX.test(message) || isCanonicalEditRequest(message);
    const writeKinds = !helpQuestion && !noWrite && hasWrite
        ? (routedKinds.length ? routedKinds : Object.keys(semanticModules).filter(kind => semanticModules[kind])) : [];
    if (source.kind && !latestWidget && writeKinds.length) {
        return Object.freeze({ action: 'clarify', kind: null, faq, pointContext: false, lineContext: false, recentWidget: null, reason: 'missing-source-widget' });
    }
    const directAxisCardRequest = !noWrite && (!routedKinds.length || routedKinds.includes('almanac_widget')) && !modules.era_widget && (DIRECT_AXIS_CARD_REQUEST_RX.test(message) || DESIRED_AXIS_CARD_RX.test(message));
    const directAxisEraRequest = !helpQuestion && !noWrite && (!routedKinds.length || routedKinds.includes('era_widget')) && modules.era_widget && /轴(?:历)?卡片/.test(message) && REQUEST_LANGUAGE_RX.test(message);
    const directOutlineRequest = !noWrite && !asksForExplanation && (!routedKinds.length || routedKinds.includes('outline_widget')) && OUTLINE_REQUEST_RX.test(message) && REQUEST_LANGUAGE_RX.test(message);
    const directSemanticRequest = directOutlineRequest
        || routedKinds.length > 0
        || DIRECT_POINT_REQUEST_RX.test(message)
        || DIRECT_LINE_REQUEST_RX.test(message)
        || DIRECT_ALMANAC_REQUEST_RX.test(message)
        || directAxisCardRequest
        || DESIRED_POINT_RX.test(message)
        || DESIRED_LINE_RX.test(message)
        || DESIRED_ALMANAC_RX.test(message)
        || (SEMANTIC_CARD_RX.test(message) && REQUEST_LANGUAGE_RX.test(message));
    const explicitStructuredLanding = directSemanticRequest || (hasWrite && semanticKinds.length > 0);
    if (writeKinds.length > 1 || (!routedKinds.length && !helpQuestion && !noWrite && (hasWrite || directSemanticRequest || delegatedCardRequest) && semanticKinds.length > 1)) {
        return Object.freeze({ action: 'clarify', kind: null, faq, pointContext: false, lineContext: false, recentWidget: null, reason: 'ambiguous-widget-kind' });
    }
    // 明确引用当前正式面时，以正式稿作为本轮修改来源；旧候选和已完成的删改叙述只作历史上下文。
    if (!helpQuestion && !noWrite && (!routedKinds.length || (routedKinds.length === 1 && routedKinds[0] === 'outline_widget'))
        && CURRENT_OUTLINE_SOURCE_RX.test(message) && isNodeEditRequest(message)) {
        return makeWriteIntent({ kind: 'outline_widget', faq, message, latestWidget });
    }
    if (!helpQuestion && directOutlineRequest) {
        return makeWriteIntent({ kind: 'outline_widget', faq, message, latestWidget });
    }
    if (!helpQuestion && !noWrite && (!routedKinds.length || (routedKinds.length === 1 && routedKinds[0] === 'outline_widget')) && isOutlineNodeEditRequest(message)) {
        if (latestWidget?.kind === 'outline_widget') {
            return Object.freeze({ action: 'revise-recent', kind: 'outline_widget', faq, pointContext: false, lineContext: false, recentWidget: latestWidget, reason: '' });
        }
        return makeWriteIntent({ kind: 'outline_widget', faq, message, latestWidget });
    }
    if (!helpQuestion && directAxisCardRequest) {
        return makeWriteIntent({ kind: 'almanac_widget', faq, message, latestWidget });
    }
    if (directAxisEraRequest) {
        return makeWriteIntent({ kind: 'era_widget', faq, message, latestWidget });
    }
    if (!helpQuestion && !noWrite && isRecentEditRequest(message)) {
        const explicitKind = writeKinds[0] || null;
        const canReviseLatest = latestWidget && (!explicitKind || explicitKind === latestWidget.kind) && !CANONICAL_ITEM_RX.test(message);
        if (canReviseLatest) {
            const editExisting = ['schedule_widget', 'line_widget'].includes(latestWidget.kind) && latestWidget.editIdx != null;
            return Object.freeze({ action: 'revise-recent', kind: latestWidget.kind, faq, pointContext: latestWidget.kind === 'schedule_widget', lineContext: latestWidget.kind === 'line_widget', recentWidget: latestWidget, ...(editExisting ? { editExisting: true } : {}), reason: '' });
        }
        if (!latestWidget && !explicitKind) {
            return Object.freeze({ action: 'clarify', kind: null, faq, pointContext: false, lineContext: false, recentWidget: null, reason: 'missing-recent-widget' });
        }
    }
    if (writeKinds.length === 1) {
        const kind = writeKinds[0];
        return makeWriteIntent({ kind, faq, message, latestWidget });
    }
    const pointContext = modules.schedule_widget && VIEW_RX.test(message);
    const lineContext = modules.line_widget && VIEW_RX.test(message);
    if (pointContext || lineContext) {
        return Object.freeze({ action: 'view', kind: null, faq, pointContext, lineContext, recentWidget: null, reason: '' });
    }
    const semanticCardCandidate = semanticKinds.length > 0 || SEMANTIC_CARD_RX.test(message);
    const reliableDiscussion = helpQuestion
        || noWrite
        || QUOTED_CARD_MENTION_RX.test(message)
        || MENTION_ONLY_RX.test(message)
        || EVALUATION_RX.test(message)
        || EXPLICIT_GREETING_RX.test(message)
        || (PURE_EXPLANATION_RX.test(message) && !explicitStructuredLanding)
        || (EXPLICIT_EXPLANATION_RX.test(message) && !explicitStructuredLanding)
        || (PURE_DISCUSSION_RX.test(message) && !directSemanticRequest && !delegatedCardRequest);
    const uncertainRequest = semanticCardCandidate || GENERAL_REQUEST_RX.test(message);
    return Object.freeze({
        action: uncertainRequest && !reliableDiscussion ? 'semantic-route' : 'discuss',
        kind: null,
        faq,
        pointContext: false,
        lineContext: false,
        recentWidget: null,
        allowedWidgetKinds: uncertainRequest && !reliableDiscussion
            ? semanticKinds.length === 1 ? semanticKinds
                : semanticKinds.length === 0 && requestedMaterials.outline ? ['outline_widget'] : []
            : [],
        reason: '',
    });
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

const pointOwnerHeading = (scope, userName) => scope.view === 'char'
    ? `【TA｜人物：${scope.charName}｜view="char" char="${String(scope.charName || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"】`
    : `【我｜人物：${userName}｜view="user"】`;

export function numberedSpacePointGroups(scopes, numberedPoints, userName = '用户') {
    return (Array.isArray(scopes) ? scopes : []).map(scope => {
        const list = numberedPoints?.(scope.raw) || '';
        return list ? `${pointOwnerHeading(scope, userName)}\n${list}` : '';
    }).filter(Boolean).join('\n\n');
}

export function createSpaceContext(env = {}) {
    const buildMessages = async ({ target, userMsg, historySnapshot, pageId = '1', pages = ['1'] }) => {
        const ctx = env.context?.() || {};
        const userName = ctx.name1 || '用户';
        const charName = ctx.name2 || '角色';
        const message = String(userMsg || '');
        const intent = classifySpaceIntent(message, historySnapshot, {
            pageId,
            parseAlmanac: env.parseAlmanac,
            parseEra: env.parseEra,
        });
        const requested = requestedSpaceMaterials(message);
        const outlineEdit = intent.kind === 'outline_widget' && ['write', 'revise-recent'].includes(intent.action);
        const outlineCandidateAllowed = outlineEdit || (intent.action === 'semantic-route' && requested.outline);
        const outlineRaw = outlineCandidateAllowed
            ? env.readOutlineDraftSnapshot?.(target)?.raw || ''
            : requested.outline ? env.readOutline?.(target) || '' : '';
        const outlineRawToken = outlineCandidateAllowed ? (env.rawToken?.(outlineRaw) || null) : null;
        let pointScopes = requested.points || intent.pointContext ? env.readPointScopes?.(target) : [];
        if (!Array.isArray(pointScopes)) {
            const legacyPointRaw = String(env.readPointRaw?.(target) || '');
            pointScopes = legacyPointRaw.trim() ? [{ view: 'user', charName: '', raw: legacyPointRaw, ts: null }] : [];
        }
        const pointList = numberedSpacePointGroups(pointScopes, env.numberedPoints, userName);
        const lineRaw = requested.lines || intent.lineContext ? env.readLineRaw?.(target) || '' : '';
        const lineList = requested.lines || intent.lineContext
            ? numberedSpaceLineList(lineRaw, env.parseLines)
            : '';
        const lineBaselines = [...compactLineBaselines(lineRaw, env.parseLines)];
        if (intent.action === 'revise-recent' && intent.recentWidget?.kind === 'line_widget'
            && Number.isInteger(intent.recentWidget.editIdx) && intent.recentWidget.lineLocator) {
            lineBaselines[intent.recentWidget.editIdx - 1] = intent.recentWidget.lineLocator;
        }
        const ledgerList = requested.ledger || includesAny(message, LEDGER_READ_KEYWORDS) ? env.readLedgerText?.(target) || '' : '';
        const settings = env.settings?.() || {};
        const useCharacterPersona = settings.spaceUseCharacterPersona === true;
        const faqText = intent.faq ? buildSpaceHelpText(settings) : '';
        const characterData = env.readCharacterData?.(ctx) || '';
        const storyDate = requested.date ? env.readStoryDate?.(ctx) || '' : '';
        const needsAlmanac = requested.date || (intent.kind === 'almanac_widget' && ['write', 'revise-recent'].includes(intent.action));
        const needsCalendar = requested.calendar || requested.date
            || (['write', 'revise-recent'].includes(intent.action) && ['almanac_widget', 'era_widget'].includes(intent.kind));
        const almanacText = needsAlmanac ? env.readAlmanacText?.(target) || '' : '';
        const calDescText = needsCalendar ? env.readCalendarText?.(target) || '' : '';
        const readMaterial = (enabled, label, reader) => {
            if (!enabled) return '';
            try { return Promise.resolve(reader?.()).catch(() => `【${label}读取失败】本轮暂时无法读取这项资料。`); }
            catch { return `【${label}读取失败】本轮暂时无法读取这项资料。`; }
        };
        const materialReads = [
            readMaterial(requested.cold, '冷知识', env.readColdKnowledge),
            readMaterial(requested.menu, '今日菜单', env.readDailyMenu),
            readMaterial(requested.theater, '棱作品与模板', () => env.readTheater?.(target, ctx, message)),
            readMaterial(requested.coordinate, '坐标', () => env.readCoordinates?.(target, ctx, message)),
        ];
        const materialText = (await Promise.all(materialReads)).filter(Boolean).join('\n\n');
        const memText = await env.readMemory?.(ctx, outlineEdit ? message : undefined) || '';
        const recentCtx = await env.readRecent?.(ctx) || '';
        const { personaDesc = '', authorNote = '' } = env.readCardExtras?.(ctx) || {};
        const personaOverride = useCharacterPersona ? '' : String(settings.spacePersona || '').trim();
        const historyMessages = stripWidgetsForApi(historySnapshot);
        const lastHistory = historyMessages.at(-1);
        if (lastHistory?.role === 'user' && String(lastHistory.content ?? '').trim() === message.trim()) historyMessages.pop();
        const titleSupplementText = [
            message,
            ...historyMessages.map(item => String(item?.content ?? '')),
            intent.formatRepair ? intent.recentWidget?.body : '',
            intent.action === 'revise-recent' ? intent.recentWidget?.body : '',
            intent.action === 'write' ? intent.sourceWidget?.body : '',
            intent.action === 'revise-recent'
                && intent.recentWidget?.kind === 'schedule_widget'
                && intent.recentWidget.editIdx != null
                && intent.recentWidget.owner?.view === 'char'
                ? intent.recentWidget.owner.charName : '',
            outlineRaw,
            pointList,
            lineList,
            ledgerList,
            memText,
            recentCtx,
            personaDesc,
            characterData,
            authorNote,
            almanacText,
            calDescText,
            storyDate,
            materialText,
            personaOverride,
        ].filter(Boolean).join('\n\n');
        // 宿主仍只按本轮问题扫描关键词；人物标题补充只读本轮真正投喂的动态材料。
        const wiContext = await env.readWorldInfo?.(ctx, message, historySnapshot.slice(0, -1), titleSupplementText) || '';
        const system = buildSpaceChatSystemPrompt({
            userName,
            charName,
            personaDesc,
            characterData,
            authorNote,
            storyDate,
            outlineRaw,
            wiContext,
            memText,
            recentCtx,
            pointList,
            lineList,
            ledgerList,
            almanacText,
            calDescText,
            materialText,
            requestedMaterials: requested,
            faqText,
            personaOverride,
            useCharacterPersona,
            preferences: env.preferences?.(ctx) || { direction: env.lineDirection?.(ctx) || 'natural' },
            intent,
        });
        const sharedPages = pages.length > 1 || historySnapshot.some(item => spacePageId(item) === '2');
        const pageNote = sharedPages ? `\n【讨论窗口】当前在窗口${pageId}。以下两窗口记录按实际先后共享；窗口标记表示来源，不表示连续问答。` : '';
        const apiHistory = sharedPages ? historyMessages.map((item, index) => ({ ...item, content: `【窗口${spacePageId(historySnapshot[index])}】\n${item.content}` })) : historyMessages;
        const messages = [{ role: 'system', content: system + pageNote }, ...apiHistory, { role: 'user', content: userMsg }];
        Object.defineProperty(messages, 'pointBaselines', { value: compactPointBaselines(pointScopes), enumerable: false });
        Object.defineProperty(messages, 'lineBaselines', { value: Object.freeze(lineBaselines), enumerable: false });
        // 本地 transport 元数据，不发送给 API；冻结本轮唯一允许应用的卡型。
        const expectedWidgetKind = ['write', 'revise-recent'].includes(intent.action) ? intent.kind : null;
        if (expectedWidgetKind) Object.defineProperty(messages, 'expectedWidgetKind', { value: expectedWidgetKind, enumerable: false });
        const allowedWidgetKinds = expectedWidgetKind ? [expectedWidgetKind]
            : intent.action === 'semantic-route' ? [...(intent.allowedWidgetKinds || [])] : [];
        Object.defineProperty(messages, 'allowedWidgetKinds', { value: Object.freeze(allowedWidgetKinds), enumerable: false });
        if (allowedWidgetKinds.includes('outline_widget') && outlineRawToken) Object.defineProperty(messages, 'outlineRawToken', { value: outlineRawToken, enumerable: false });
        return messages;
    };
    return Object.freeze({ buildMessages });
}
