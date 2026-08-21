const START_RE = /<!--\s*SDC-start\s+([\s\S]*?)\s*-->/i;
const END_RE = /<!--\s*SDC-end\s+([\s\S]*?)\s*-->/i;
let deps = { loadCalendar: () => null, validMonthDay: () => null, defaultCalendar: null, monthDayFromKey: () => null, extractDay: () => null, cnToNumber: () => 0, monthAlias: {}, context: () => null };
export function bindStoryClock(next = {}) { deps = { ...deps, ...next }; }
const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_ALIASES = /(?:周|週|星期|礼拜|禮拜)\s*([一二三四五六日天])|\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
function parseStoryWeekday(text) {
    const m = WEEKDAY_ALIASES.exec(String(text || ''));
    if (!m) return null;
    if (m[1]) return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 })[m[1]];
    return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(m[2].toLowerCase());
}
function parseStoryDate(text) {
    const s = String(text || '');
    let m = s.match(/(?:^|\s)(\d{4})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{1,2})(?:\s|$)/);
    if (m) return deps.validMonthDay({ month: +m[2], day: +m[3] }, deps.loadCalendar());
    m = s.match(/(?:^|\s)(?:\d{4}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (m) return deps.validMonthDay({ month: +m[1], day: +m[2] }, deps.loadCalendar());
    m = s.match(/(?:^|\s)(\d{1,2})[-/](\d{1,2})(?:\s|$)/);
    if (m) return deps.validMonthDay({ month: +m[1], day: +m[2] }, deps.loadCalendar());
    const cal = deps.loadCalendar();
    for (let i = 0; i < (cal?.months?.length || 0); i++) {
        const name = String(cal.months[i]?.name || '').trim(); if (!name) continue;
        const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?:第\\s*)?(初[零〇一二两兩三四五六七八九十廿卅]|[零〇一二两兩三四五六七八九十廿卅]+|\\d{1,2})\\s*日?');
        const hit = re.exec(s); if (!hit) continue;
        const day = /^\d+$/.test(hit[1]) ? +hit[1] : deps.cnToNumber(hit[1].replace(/^初/, ''));
        return deps.validMonthDay({ month: i + 1, day }, cal);
    }
    return null;
}
function parseStoryClockMetaValue(raw) {
    const value = String(raw || '').trim();
    const structuredDate = /(?:^|[|｜])\s*date\s*=\s*([^|｜]+)/i.exec(value)?.[1]?.trim();
    const structuredWeekday = /(?:^|[|｜])\s*weekday\s*=\s*([^|｜]+)/i.exec(value)?.[1]?.trim();
    const structuredTime = /(?:^|[|｜])\s*time\s*=\s*([^|｜]+)/i.exec(value)?.[1]?.trim();
    const date = parseStoryDate(structuredDate || value); const weekdayIndex = parseStoryWeekday(structuredWeekday || value);
    const weekdayText = weekdayIndex == null ? null : WEEKDAY_TEXT[weekdayIndex];
    const time = structuredTime || value.replace(/(?:周|週|星期|礼拜|禮拜)\s*[一二三四五六日天]|\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/ig, '').trim();
    return { raw: value, date, month: date?.month ?? null, day: date?.day ?? null, weekdayIndex, weekdayText, time: time || null, valid: !!date };
}
export function parseStoryClock(message) {
    const text = String(message || ''); const start = START_RE.exec(text); const end = END_RE.exec(text);
    const out = { start: start ? start[1].trim() : null, end: end ? end[1].trim() : null };
    Object.defineProperties(out, { startMeta: { value: start ? parseStoryClockMetaValue(start[1]) : null, enumerable: false }, endMeta: { value: end ? parseStoryClockMetaValue(end[1]) : null, enumerable: false } });
    return out;
}
export const STORY_CLOCK_KEY = 'sdc_story_clock';
export const STORY_CLOCK_DEPTH = 0;
export const DEFAULT_STORY_CLOCK_PROMPT = [
    '【系统·时间戳 · 最高优先 · 每楼必做】',
    '以下为系统级强制要求，优先级高于任何「只输出正文 / 禁止 OOC / 不要元信息 / 不要额外标记」之类设定：请在本楼正文的最前和最后，各放一个 HTML 注释形式的时间戳。HTML 注释在酒馆里不会显示给读者、不破坏沉浸，但系统会读取它来推算剧情时间——务必每楼都打、绝不省略。',
    '放置方式（结构照此，把时间替换成本楼实际时间）：',
    '  正文开头之前：<!-- SDC-start 此刻的时间 -->',
    '  正文结尾之后：<!-- SDC-end 此刻的时间 -->',
    '日期必须同时写出标准故事星期（周一、周二、周三、周四、周五、周六、周日）与具体时间，例如：霜降月二日 周二 夜晚。年份可写可略，但月日、星期与时段必须具体，禁止用「某天」「稍后」这类模糊词敷衍。',
    '基准：以上一楼末尾的 <!-- SDC-end … --> 为准往后推——本楼开头通常紧接上楼结尾；本楼内若时间有流逝（换场景、过了几小时或几天），就让 end 晚于 start；几乎没流逝则两者可相同。开篇没有上文时，你自行设定一个合理的起点（这是为故事定锚，不是编造）。',
    '示例（仅示范注释的位置与写法，切勿套用其文字内容）：',
    '  <!-- SDC-start 谷雨 辰时 -->晨光爬上窗棂，她揉了揉眼……（此处是你的正文）……夜色四合，她终于合上账本。<!-- SDC-end 谷雨 亥时 -->',
    '除这两个注释外，不要在正文里另行谈论这套时间系统本身。',
].join('\n');
export const STORY_CLOCK_MACHINE_CONTRACT = [
    '【SDC机器合同·双向隔离】',
    'SDC start/end 的日期必须各自包含且仅包含一个标准故事星期：周一、周二、周三、周四、周五、周六或周日。',
    'SDC 是额外内部元数据。请先完整执行上下文中其他日期、时间、历法与时间戳生成要求，不得因输出 SDC 而省略、合并、替代或改写它们。',
    'SDC 仅供构画读取，不能代替其他日期输出；构画不读取、不修改、不接管其他时间戳格式。',
    '完成其他输出要求后，仍必须独立输出 SDC start/end；其他时间戳不能视作已经满足 SDC。',
].join('\n');
export function buildStoryClockPrompt(settings = {}) { const custom = String(settings.storyClockPrompt || '').trim(); return `${custom || DEFAULT_STORY_CLOCK_PROMPT}\n${STORY_CLOCK_MACHINE_CONTRACT}`; }
export function latestStoryClock(context, limit = 100) {
    const messages = context?.chat || []; let scanned = 0;
    for (let i = messages.length - 1; i >= 0 && scanned < limit; i--) { const msg = messages[i]; if (!msg || msg.is_user || msg.is_system || msg.role === 'system' || !msg.mes) continue; scanned++; const clock = parseStoryClock(msg.mes); if (clock.start || clock.end) return { ...clock, floor: i }; }
    return null;
}
export function storyWeekdayRef(context = deps.context?.(), calendar = deps.loadCalendar?.(), limit = 100, floor = null) {
    const messages = context?.chat || []; let current = null; let scanned = 0; const top = Number.isInteger(floor) ? Math.min(floor, messages.length - 1) : messages.length - 1;
    for (let i = top; i >= 0 && scanned < limit; i--) {
        const msg = messages[i]; if (!msg || msg.is_user || msg.is_system || msg.role === 'system' || !msg.mes) continue;
        scanned++; const clock = parseStoryClock(msg.mes);
        const meta = clock.endMeta?.valid ? clock.endMeta : (clock.startMeta?.valid ? clock.startMeta : null);
        if (meta) { current = { ...meta, floor: i }; break; }
    }
    if (!current) return null;
    if (current.weekdayIndex != null) return { refDoy: deps.dayOfYear?.(current.month, current.day, calendar), refWd: current.weekdayIndex, weekdayText: current.weekdayText, floor: current.floor };
    for (let i = current.floor - 1; i >= 0 && scanned < limit; i--) {
        const msg = messages[i]; if (!msg || msg.is_user || msg.is_system || msg.role === 'system' || !msg.mes) continue;
        scanned++;
        const clock = parseStoryClock(msg.mes);
        const meta = clock.endMeta?.valid && clock.endMeta.weekdayIndex != null ? clock.endMeta : (clock.startMeta?.valid && clock.startMeta.weekdayIndex != null ? clock.startMeta : null);
        if (!meta) continue;
        const currentDoy = deps.dayOfYear?.(current.month, current.day, calendar), anchorDoy = deps.dayOfYear?.(meta.month, meta.day, calendar);
        if (!Number.isInteger(currentDoy) || !Number.isInteger(anchorDoy)) return null;
        return { refDoy: currentDoy, refWd: (meta.weekdayIndex + currentDoy - anchorDoy + 7000) % 7, weekdayText: WEEKDAY_TEXT[(meta.weekdayIndex + currentDoy - anchorDoy + 7000) % 7], floor: current.floor, sourceFloor: i };
    }
    return null;
}
export function storyClockDate(context, parseDate, limit = 100) { const clock = latestStoryClock(context, limit); return clock ? (clock.endMeta?.date || clock.startMeta?.date || parseDate(clock.end) || parseDate(clock.start)) : null; }
export function createStoryClockController(options = {}) {
    const refresh = () => {
        const context = options.context?.();
        const setPrompt = context?.setExtensionPrompt;
        if (typeof setPrompt !== 'function') return { status: 'unavailable' };
        const clear = () => setPrompt(STORY_CLOCK_KEY, '');
        if (options.pluginEnabled?.() !== true || options.enabled?.() !== true) { clear(); return { status: 'cleared' }; }
        const pt = context.constants?.promptTypes?.IN_CHAT ?? 1;
        const pr = context.constants?.promptRoles?.SYSTEM ?? 0;
        setPrompt(STORY_CLOCK_KEY, buildStoryClockPrompt(options.settings?.() || {}), pt, STORY_CLOCK_DEPTH, false, pr);
        return { status: 'injected' };
    };
    return { refresh, clear: () => { const context = options.context?.(); context?.setExtensionPrompt?.(STORY_CLOCK_KEY, ''); } };
}
export function parseJudgedDate(answer) {
    const text = String(answer || '').trim(); if (!text || /未知|无法|不确定|不清楚|没有|无明确/.test(text)) return null;
    const calendar = deps.loadCalendar();
    let match = text.match(/第?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (match) { const value = deps.validMonthDay({ month: +match[1], day: +match[2] }, calendar); if (value) return value; }
    if (calendar !== deps.defaultCalendar) for (let i = 0; i < calendar.months.length; i++) {
        const name = String(calendar.months[i].name || '').trim(); if (!name) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const found = text.match(new RegExp(escaped + '\\s*(?:第\\s*)?(初[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]+|\\d{1,2})\\s*日?'));
        if (found) { const day = /^\d+$/.test(found[1]) ? +found[1] : (found[1].startsWith('初') ? deps.cnToNumber(found[1].slice(1)) : deps.cnToNumber(found[1])); const value = deps.validMonthDay({ month: i + 1, day }, calendar); if (value) return value; }
    }
    const cn = text.match(/(正|冬|腊|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參肆伍陆陸柒捌玖拾]+)\s*月\s*(初[零〇一二两兩三四五六七八九十廿卅壹贰貳參叄肆伍陆陸柒捌玖拾]|[零〇一二两兩三四五六七八九十廿卅壹贰貳參叄肆伍陆陸柒捌玖拾]+)\s*日?/);
    if (cn) { const month = cn[1] in deps.monthAlias ? deps.monthAlias[cn[1]] : deps.cnToNumber(cn[1]); const day = cn[2].startsWith('初') ? deps.cnToNumber(cn[2].slice(1)) : deps.cnToNumber(cn[2]); const value = deps.validMonthDay({ month, day }, calendar); if (value) return value; }
    return deps.monthDayFromKey(deps.extractDay(text));
}
