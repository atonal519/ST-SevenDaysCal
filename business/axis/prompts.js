export function createAxisPromptBuilder(env = {}) {
    const { loadCalDesc, calMonthCount, calYearLen, isGregorianCalendar, getCalDescInjectText } = env;
function buildAlmanacPrompt(userName, charName) {
    const cal = loadCalDesc();
    const monthCount = calMonthCount(cal);
    const yearLen = calYearLen(cal);
    const maxDim = Math.max(...cal.months.map(month => month.days));
    const gregorian = isGregorianCalendar(cal);
    const calendarRule = gregorian
        ? '按故事世界设定使用公历月日；现实背景依据有据的地域与时代判断节庆，古代、架空、幻想或科幻背景即使沿用公历网格，也按该世界设定构建自洽节令，不套用无关地区节日。'
        : `本世界使用现行自定义历法：${getCalDescInjectText()}；严格使用配置的月份和日数，不套公历日期或现实地区节日。`;
    const dateRange = gregorian
        ? 'month 为 1–12，day 为该公历月的合法日期。'
        : `month 为 1–${monthCount}，day 为该配置月的合法日期（最多 ${maxDim}）。`;
    const holidayRule = gregorian
        ? '现实背景先完整覆盖当地全年基础法定及公共假日，再补充有依据的重要文化节庆，并逐月核对遗漏；不要因为剧情未提及、角色没有参与或没有庆祝，就漏掉基础假日。地域不明时只写有依据的跨文化节庆，不猜国家；故事年份有依据时，浮动节日按该年落到月日。生日和剧情周年纪念另列，不代替节庆覆盖'
        : '按世界观、地域与时代完整覆盖有设定依据的基础节令，再补充重要文化节庆，并逐月核对遗漏；不要因为剧情未提及、角色没有参与或没有庆祝，就漏掉已确立的基础节令。没有设定依据时留空，不套用现实节庆。生日和剧情周年纪念另列，不代替节庆覆盖';
    return `请暂停角色扮演，依据角色卡、世界书、${userName}与${charName}的设定及故事记忆，整理当前世界完整一整年（${monthCount} 个月、${yearLen} 天）的重要日期。${calendarRule}

${holidayRule}。生日只在有依据且能明确推断时填写。另找故事专属的周年纪念：通常 3–6 条，素材不足可为 0，特别丰富时至多 8 条；只收角色或群体会逐年纪念、庆祝、悼念或举行仪式的已发生重大事件。普通日常不收，同一里程碑不拆分，未发生事项不编造。

每条按日期排序，type 只能是 festival、birthday、anniversary、custom；${dateRange} days 为持续天数（单日填 1），displayDate 可空，note 用一行说明日期来由、相关人物及习俗。只输出以下完整 widget，不解释：
<almanac_widget>
Item: 名称|type|month|day|days|displayDate|说明句
</almanac_widget>`;
}

function buildAnniversarySupplementPrompt(userName, charName, existingList) {
    const cal = loadCalDesc();
    const monthCount = calMonthCount(cal);
    const maxDim = Math.max(...cal.months.map(month => month.days));
    const calendarRule = isGregorianCalendar(cal)
        ? '使用公历月日。'
        : `使用现行自定义历法：${getCalDescInjectText()}；月序为 1-${monthCount}，day 不超过该月配置日数（最多 ${maxDim}），不套公历。`;
    const already = existingList?.trim()
        ? `【已在历上】不要重复这些条目；措辞不同但指向同一事件或同一天也算重复：\n${existingList}\n`
        : '【历上暂无条目】仍只补符合条件的纪念日。\n';
    return `请暂停角色扮演，依据${userName}、${charName}的完整剧情、设定和故事记忆，为现有日期轴补录新浮现的里程碑；不要重做整历。${calendarRule}

${already}只补已经发生、可确定或合理推断日期、尚未入历且值得每年纪念的周年纪念或自定义纪念日（type 为 anniversary 或 custom）。节日、生日、普通日常、连续剧情步骤、未发生的计划与假设均不补；没有合适事项就输出空 widget。通常 0–2 条、最多 3 条是提示目标，不要凑数。日期符合现行历法，单日 days=1；displayDate 可空；note 用一行说明事件、相关人物及纪念理由并以标点结束。只输出：
<almanac_widget>
Item: 名称|type|month|day|days|displayDate|说明句
</almanac_widget>`;
}

// 补录由 createAxisGenerationController / 现行生成控制器统一管理互斥与状态，
// 但合并阶段走**纯追加去重**（非 mergeAlmanac）+ pin=true，且补 0 条时给出「没有够格」的正常态提示、不报错。

    return { buildAlmanacPrompt, buildAnniversarySupplementPrompt };
}
