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
    const legacyTime = structuredTime ? null : value.split(/[|｜,，\s]+/).filter(part => part && !/(?:周|週|星期|礼拜|禮拜)\s*[一二三四五六日天]|\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(part) && !/[年月日\d\-\/]/.test(part)).join(' ').trim();
    const time = structuredTime || legacyTime || null;
    return { raw: value, date, month: date?.month ?? null, day: date?.day ?? null, weekdayIndex, weekdayText, time: time || null, valid: !!date, complete: !!date && weekdayIndex != null && !!time };
}
export function parseStoryClock(message) {
    const text = String(message || ''); const starts = [...text.matchAll(new RegExp(START_RE.source, 'ig'))]; const ends = [...text.matchAll(new RegExp(END_RE.source, 'ig'))]; const start = starts[0]; const end = ends[0];
    const out = { start: start ? start[1].trim() : null, end: end ? end[1].trim() : null };
    Object.defineProperties(out, { duplicate: { value: starts.length !== 1 || ends.length !== 1, enumerable: false }, startMeta: { value: start ? parseStoryClockMetaValue(start[1]) : null, enumerable: false }, endMeta: { value: end ? parseStoryClockMetaValue(end[1]) : null, enumerable: false } });
    return out;
}
export const STORY_CLOCK_KEY = 'sdc_story_clock';
export const STORY_CLOCK_DEPTH = 0;
export const DEFAULT_STORY_CLOCK_PROMPT = [
    '【故事时间戳 SDC｜每楼附加元数据】',
    '请在本楼正文最前与最后各放一个 HTML 注释，作为本楼的附加故事时间元数据。HTML 注释不会显示给读者。',
    '唯一格式示例（请替换为本楼实际内容）：',
    '  <!-- SDC-start | date=霜降月二日 | weekday=周二 | time=辰时 -->正文<!-- SDC-end | date=霜降月二日 | weekday=周二 | time=亥时 -->',
    'start 与 end 都必须同时填写 date、weekday、time；weekday 只能使用周一至周日。日期、历法、状态栏、时间戳等其他世界书要求仍须完整执行，SDC 不替代、不合并、不改写它们。',
    '通常以上一楼 end 为参考推进本楼时间；若本楼没有可用参考，按当前剧情设定合理填写。除这两个注释外，不要在正文中讨论 SDC。',
].join('\n');
export const STORY_CLOCK_MACHINE_CONTRACT = [
    '【SDC机器合同·双向隔离】',
    'SDC-start 与 SDC-end 必须各自使用 date=… | weekday=… | time=… 三个字段，weekday 只能是周一、周二、周三、周四、周五、周六或周日。',
    'SDC 是额外内部元数据。请先完整执行上下文中其他世界书的日期、历法、状态栏、时间与时间戳要求，不得因输出 SDC 而省略、合并、替代或改写它们。',
    'SDC 仅供构画读取，不能代替其他日期输出；构画不读取、不修改、不接管其他时间戳格式。',
    '完成其他输出要求后，仍必须独立输出含完整 date/weekday/time 的 SDC start/end；其他时间戳不能视作已经满足 SDC。',
].join('\n');
export function buildStoryClockPrompt(settings = {}) { const custom = String(settings.storyClockPrompt || '').trim(); return `${custom || DEFAULT_STORY_CLOCK_PROMPT}\n${STORY_CLOCK_MACHINE_CONTRACT}`; }
export function latestStoryClock(context, limit = 100) {
    const messages = context?.chat || []; let scanned = 0;
    for (let i = messages.length - 1; i >= 0 && scanned < limit; i--) { const msg = messages[i]; if (!msg || msg.is_user || msg.is_system || msg.role === 'system' || !msg.mes) continue; scanned++; const clock = parseStoryClock(msg.mes); const out = { start: clock.start, end: clock.end, floor: i }; Object.defineProperties(out, { duplicate: { value: clock.duplicate, enumerable: false }, startMeta: { value: clock.startMeta, enumerable: false }, endMeta: { value: clock.endMeta, enumerable: false } }); return out; }
    return null;
}
export function completeStoryClock(clock) { return !!clock && !clock.duplicate && !!clock.startMeta?.complete && !!clock.endMeta?.complete; }
export function storyWeekdayRef(context = deps.context?.(), calendar = deps.loadCalendar?.(), limit = 100, floor = null) {
    const messages = context?.chat || []; const top = Number.isInteger(floor) ? Math.min(floor, messages.length - 1) : messages.length - 1;
    let aiFloor = null; let scanned = 0;
    for (let i = top; i >= 0 && scanned < limit; i--) {
        const msg = messages[i]; if (!msg || msg.is_user || msg.is_system || msg.role === 'system' || !msg.mes) continue;
        aiFloor = i; break;
    }
    if (!Number.isInteger(aiFloor)) return null;
    const clock = parseStoryClock(messages[aiFloor].mes);
    if (!completeStoryClock(clock)) return null;
    const meta = clock.endMeta;
    if (!meta) return null;
    const refDoy = deps.dayOfYear?.(meta.month, meta.day, calendar);
    return Number.isInteger(refDoy) ? { refDoy, refWd: meta.weekdayIndex, weekdayText: meta.weekdayText, floor: aiFloor } : null;
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
