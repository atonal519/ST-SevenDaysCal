import { _cnToNumber, _CN_MONTH_ALIAS, normalizeCnDateDigits } from '../../utils/cn-date.js';
const START_RE = /<!--\s*SDC-start\s+([\s\S]*?)\s*-->/i;
const END_RE = /<!--\s*SDC-end\s+([\s\S]*?)\s*-->/i;
let deps = { loadCalendar: () => null, validMonthDay: () => null, validRealDate: null, defaultCalendar: null, monthDayFromKey: () => null, extractDay: () => null, cnToNumber: () => 0, monthAlias: {}, context: () => null };
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
    const s = normalizeCnDateDigits(text);
    if (/<\/?bbs_end\s*>/i.test(s)) return null;
    // 显式数字纪年一旦出现但越界，不能降级成“无年”的月日，避免 0/10000 年被静默吞掉。
    if (/(?:^|[\s|｜,，=＝])\d{1,}\s*年\s*(?:正|冬|腊|臘|\d{1,2}|[零〇一二两兩三四五六七八九十廿卄卅卌壹贰貳叁參叄肆伍陆陸柒捌玖拾佰仟]+)\s*月/.test(s)) {
        const explicit = s.match(/(?:^|[\s|｜,，=＝])(\d{1,})\s*年/);
        if (explicit && (+explicit[1] < 1 || +explicit[1] > 9999)) return null;
    }
    const cn = '[零〇一二两兩三四五六七八九十廿卄卅卌壹贰貳叁參叄肆伍陆陸柒捌玖拾佰仟]+';
    const toNumber = value => { const primary = deps.cnToNumber ? deps.cnToNumber(value) : null; return primary == null || Number.isNaN(Number(primary)) ? _cnToNumber(value) : primary; };
    const cnYear = s.match(new RegExp(`(?:^|[\\s|｜,，=＝])(${cn})\\s*年`));
    if (cnYear && (!Number.isInteger(toNumber(cnYear[1])) || toNumber(cnYear[1]) < 1 || toNumber(cnYear[1]) > 9999)) return null;
    const valid = (month, day, year = null, eraLabel = null) => {
        const md = deps.validMonthDay({ month, day }, deps.loadCalendar());
        if (!md) return null;
        if (year != null && (!Number.isInteger(year) || year < 1 || year > 9999)) return null;
        const cal = deps.loadCalendar();
        const gregorian = cal == null || cal === deps.defaultCalendar || cal.kind === 'gregorian' || cal.id === 'default-gregorian' || (!cal.kind && !cal.id);
        if (year != null && !eraLabel && gregorian && typeof deps.validRealDate === 'function' && !deps.validRealDate(year, month, day)) return null;
        return { ...md, ...(year != null ? { year } : {}), ...(eraLabel ? { eraLabel } : {}) };
    };
    let m = s.match(/(?:^|[\s|｜,，])(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?=$|[Tt\s|｜,，]|周|週|星期|礼拜|禮拜)/);
    if (m) return valid(+m[2], +m[3], +m[1]);
    m = s.match(new RegExp(`(?:^|[\\s|｜,，=＝])(${cn})\\s*年\\s*(正|冬|腊|臘|\\d{1,2}|${cn})\\s*月\\s*(初(?:${cn})|\\d{1,2}|${cn})\\s*日?(?=$|[\\s|｜,，]|周|週|星期|礼拜|禮拜)`));
    if (m) { const year = toNumber(m[1]); const month = _CN_MONTH_ALIAS[m[2]] ?? toNumber(m[2]); const day = m[3].startsWith('初') ? toNumber(m[3].slice(1)) : toNumber(m[3]); if (year != null && month != null && day != null) return valid(month, day, year); }
    // 显式故事纪年：保留年号原文；边界只允许字段分隔符，避免吞正文中的任意“某某年”。
    // 机器字段中的无界定符年号采用严格短 token（两字）；较长年号必须显式用【年号】界定。
    const eraYear = `(?:(?:【([^】]{1,20})】)|([\\u3400-\\u9fff]{2}))(\\d{1,4}|${cn})\\s*年`;
    m = s.match(new RegExp(`(?:^|[\\s|｜,，=＝])${eraYear}\\s*(正|冬|腊|臘|\\d{1,2}|${cn})\\s*月\\s*(初(?:${cn})|\\d{1,2}|${cn})\\s*日?(?=$|[\\s|｜,，]|周|週|星期|礼拜|禮拜)`));
    if (m) {
        const eraLabel = m[1] || m[2] || null; const year = /^\d{1,4}$/.test(m[3]) ? +m[3] : toNumber(m[3]);
        // 无界定符的短年号仅在字段起点作为紧凑 token 使用；常见叙述连接词
        // 即使恰好两字也不能被当作年号，长/不确定标签应使用【年号】语法。
        if (eraLabel && !m[1] && /^(?:截至|来到|來到|后来|後來|我们|我們|此时|此時|时至|時至)$/.test(eraLabel)) return null;
        const month = _CN_MONTH_ALIAS[m[4]] ?? toNumber(m[4]); const day = m[5].startsWith('初') ? toNumber(m[5].slice(1)) : toNumber(m[5]);
        if (year != null && month != null && day != null) return valid(month, day, year, eraLabel);
    }
    // 自定义正式命名月也允许完整纪年；月名只能来自当前 calendar.months allowlist。
    const descriptors = (deps.loadCalendar()?.months || []).map((month, index) => ({ index, name: String(month?.name || '').trim() })).filter(x => x.name).sort((a, b) => b.name.length - a.name.length);
    for (const { index, name } of descriptors) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cm = s.match(new RegExp(`(?:^|[\\s|｜,，=＝])(?:(?:【([^】]{1,20})】)|([\\u3400-\\u9fff]{2}))?(\\d{1,4}|${cn})\\s*年\\s*${escaped}\\s*(初(?:${cn})|\\d{1,2}|${cn})\\s*日?(?=$|[\\s|｜,，]|周|週|星期|礼拜|禮拜)`));
        if (!cm) continue;
        const year = /^\\d{1,4}$/.test(cm[3]) ? +cm[3] : toNumber(cm[3]); const day = cm[4].startsWith('初') ? toNumber(cm[4].slice(1)) : toNumber(cm[4]);
        const value = valid(index + 1, day, year, cm[1] || cm[2] || null); if (value) return value;
    }
    const cal = deps.loadCalendar();
    const monthDescriptors = (cal?.months || [])
        .map((month, index) => ({ index, name: String(month?.name || '').trim() }))
        .filter(month => month.name)
        .sort((a, b) => b.name.length - a.name.length);
    for (const { index, name } of monthDescriptors) {
        const re = new RegExp('(?:^|[\\s|｜,，=＝])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?:第\\s*)?(初' + cn + '|\\d{1,2}|' + cn + ')\\s*日?(?=$|[\\s|｜,，]|周|週|星期|礼拜|禮拜)');
        const hit = re.exec(s); if (!hit) continue;
        const day = /^\d+$/.test(hit[1]) ? +hit[1] : toNumber(hit[1].replace(/^初/, ''));
        if (day != null) return deps.validMonthDay({ month: index + 1, day }, cal);
    }
    m = s.match(new RegExp(`(?:^|[\\s|｜,，])(正|冬|腊|臘|\\d{1,2}|${cn})\\s*月\\s*(初(?:${cn})|\\d{1,2}|${cn})\\s*日?`));
    if (m) { const month = _CN_MONTH_ALIAS[m[1]] ?? toNumber(m[1]); const day = m[2].startsWith('初') ? toNumber(m[2].slice(1)) : toNumber(m[2]); if (month != null && day != null) return valid(month, day); }
    m = s.match(new RegExp(`(?:^|[\\s|｜,，])(\\d{1,4})\\s*年\\s*(正|冬|腊|臘|\\d{1,2}|${cn})\\s*月\\s*(初(?:${cn})|\\d{1,2}|${cn})\\s*日?(?=$|[\\s|｜,，]|周|週|星期|礼拜|禮拜)`));
    if (m) { const month = _CN_MONTH_ALIAS[m[2]] ?? toNumber(m[2]); const day = m[3].startsWith('初') ? toNumber(m[3].slice(1)) : toNumber(m[3]); if (month != null && day != null) return valid(month, day, +m[1]); }
    m = s.match(/(?:^|[\s|｜,，])(?:\d{1,4}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (m) return valid(+m[1], +m[2]);
    m = s.match(/(?:^|[\s|｜,，])(\d{1,2})[-/.](\d{1,2})(?=$|[Tt\s|｜,，]|周|週|星期|礼拜|禮拜)/);
    if (m) return deps.validMonthDay({ month: +m[1], day: +m[2] }, deps.loadCalendar());
    return null;
}
function parseStoryTime(raw, { structured = false } = {}) {
    const value = String(raw || '').trim();
    if (!value) return null;
    const dateLike = /\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}/;
    const offsetOnly = /(?:UTC|GMT)?\s*[+-]\s*\d{1,2}\s*[:：]\s*\d{2}/i;
    const weekdayToken = '(?:周|週|星期|礼拜|禮拜)[一二三四五六日天]|(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
    const clockPattern = '(\\d{1,2})\\s*[:：]\\s*(\\d{2})(?:\\s*[:：]\\s*(\\d{2}))?';
    const readClock = (match, label = null, offset = 0) => {
        let hour = Number(match[1 + offset]); const minute = Number(match[2 + offset]); const second = match[3 + offset] == null ? null : Number(match[3 + offset]);
        if (label) { if (hour < 1 || hour > 12) return null; const pm = label === '下午' || label === '中午'; hour = (hour % 12) + (pm ? 12 : 0); }
        if (hour > 23 || minute > 59 || (second != null && second > 59)) return null;
        return `${hour}:${String(minute).padStart(2, '0')}${second == null ? '' : `:${String(second).padStart(2, '0')}`}`;
    };
    const safeContext = (index, length) => {
        const before = value.slice(0, index); const after = value.slice(index + length);
        const left = before.trimEnd(); const right = after.trimStart();
        const leftSafe = !before || /[\s|｜,，]$/.test(before) || new RegExp(`(?:${weekdayToken})$`, 'i').test(left);
        const rightSafe = !after || /^[\s|｜,，]/.test(after) || new RegExp(`^(?:${weekdayToken})(?=$|[\s|｜,，])`, 'i').test(right);
        return leftSafe && rightSafe;
    };
    if (structured) {
        if (dateLike.test(value) || offsetOnly.test(value)) return null;
        const meridiem = new RegExp(`^(上午|下午|凌晨|中午)\\s*${clockPattern}$`).exec(value);
        if (meridiem) return safeContext(0, value.length) ? readClock(meridiem, meridiem[1], 1) : null;
        const numeric = new RegExp(`^${clockPattern}$`).exec(value);
        if (numeric) return readClock(numeric);
        if (/[：:]\s*\d|\d{1,2}\s*时\s*\d|\d/.test(value)) return null;
        return value;
    }
    const iso = new RegExp(`\\d{4}\\s*[-/.]\\s*\\d{1,2}\\s*[-/.]\\s*\\d{1,2}\\s*[Tt]\\s*${clockPattern}(?:\\s*[Zz]|\\s*[+-]\\s*\\d{1,2}\\s*[:：]\\s*\\d{2})?`).exec(value);
    // ISO 的 Z/偏移属于完整日期时间的一部分；仅有 +08:00/UTC+08:00
    // 仍由 offsetOnly 安全闸拒绝，避免把时区当成剧情时刻。
    if (iso) return readClock(iso);
    if (offsetOnly.test(value)) return null;
    const meridiem = new RegExp(`(上午|下午|凌晨|中午)\\s*${clockPattern}`).exec(value);
    if (meridiem) return safeContext(meridiem.index, meridiem[0].length) ? readClock(meridiem, meridiem[1], 1) : null;
    const numericRe = new RegExp(clockPattern, 'g'); const numeric = numericRe.exec(value);
    if (numeric) {
        if (!safeContext(numeric.index, numeric[0].length)) return null;
        return readClock(numeric);
    }
    if (dateLike.test(value) || /[：:]\s*\d|\d{1,2}\s*时\s*\d/.test(value)) return null;
    return value.split(/[|｜,，\s]+/).filter(part => part && !WEEKDAY_ALIASES.test(part) && !/[年月日\d\-/.]/.test(part)).join(' ').trim() || null;
}
function parseStoryClockMetaValue(raw) {
    const value = String(raw || '').trim();
    const field = name => new RegExp(`(?:^|[|｜,，;；\\n])\\s*(?:${name})\\s*[=＝:]\\s*([^|｜,，;；\\n}]+)`, 'i').exec(value)?.[1]?.trim();
    const structuredDate = field('date');
    const structuredWeekday = field('weekday|星期');
    const structuredTime = field('time');
    const date = parseStoryDate(structuredDate || value);
    const weekdayIndex = /^[一二三四五六日天]$/.test(String(structuredWeekday || '').trim())
        ? ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 })[String(structuredWeekday).trim()]
        : parseStoryWeekday(structuredWeekday || value);
    const weekdayText = weekdayIndex == null ? null : WEEKDAY_TEXT[weekdayIndex];
    const dirtyStructuredTime = structuredTime && /(?:^|\s)[^=＝:|｜,，;；\n]+\s*(?:[=＝]|:(?=\s*[^\d]))/.test(structuredTime);
    const time = dirtyStructuredTime ? null : parseStoryTime(structuredTime || value, { structured: !!structuredTime });
    return { raw: value, date, month: date?.month ?? null, day: date?.day ?? null, year: date?.year ?? null, eraLabel: date?.eraLabel ?? null, weekdayIndex, weekdayText, time: time || null, valid: !!date, complete: !!date && weekdayIndex != null && !!time };
}
export function parseStoryClock(message) {
    const text = String(message || ''); const starts = [...text.matchAll(new RegExp(START_RE.source, 'ig'))]; const ends = [...text.matchAll(new RegExp(END_RE.source, 'ig'))]; const start = starts[0]; const end = ends[0];
    const out = { start: start ? start[1].trim() : null, end: end ? end[1].trim() : null };
    Object.defineProperties(out, { duplicate: { value: starts.length !== 1 || ends.length !== 1, enumerable: false }, startMeta: { value: start ? parseStoryClockMetaValue(start[1]) : null, enumerable: false }, endMeta: { value: end ? parseStoryClockMetaValue(end[1]) : null, enumerable: false } });
    return out;
}
export function storyClockNarrativeBody(message) {
    const text = String(message || '');
    const start = START_RE.exec(text);
    const end = END_RE.exec(text);
    return start && end && end.index > start.index + start[0].length
        ? text.slice(start.index + start[0].length, end.index)
        : text;
}
export const STORY_CLOCK_KEY = 'sdc_story_clock';
export const STORY_CLOCK_DEPTH = 0;
export const DEFAULT_STORY_CLOCK_PROMPT = [
    '【故事时间戳 SDC｜每楼附加元数据】',
    '请在本楼正文最前与最后各放一个 HTML 注释，作为本楼的附加故事时间元数据。HTML 注释不会显示给读者。',
    '唯一格式示例（请替换为本楼实际内容）：',
    '  <!-- SDC-start | date=熙宁十四年十月十四日 | weekday=周二 | time=辰时 -->正文<!-- SDC-end | date=熙宁十四年十月十四日 | weekday=周二 | time=亥时 -->',
    'start 与 end 都必须同时填写 date、weekday、time；weekday 只能使用周一至周日。上下文已有完整故事纪年时，date 原样复制年号与年份；未知年份时只写月日，不得猜现实年份。Gregorian 默认使用数字月份（三月/3月），不得把暮春、仲夏、深秋、惊蛰等文学称呼当作月份；自定义历法仅可使用当前 calendar.months 中实际配置的正式月名。无效或未配置月份不得猜测。日期、历法、状态栏、时间戳等其他世界书要求仍须完整执行，SDC 不替代、不合并、不改写它们。',
    '通常以上一楼 end 为参考推进本楼时间；若本楼没有可用参考，按当前剧情设定合理填写。除这两个注释外，不要在正文中讨论 SDC。',
].join('\n');
export const STORY_CLOCK_MACHINE_CONTRACT = [
    '【SDC机器合同·双向隔离】',
    'SDC-start 与 SDC-end 必须各自使用 date=… | weekday=… | time=… 三个字段，weekday 只能是周一、周二、周三、周四、周五、周六或周日。上下文已有完整故事纪年时，date 必须原样携带；未知年份允许月日，但不得编造现实年份。Gregorian 必须使用数字月份；文学季节词不能替代月份。自定义历法仅允许当前 calendar.months 中实际存在的正式月名，不能臆造或猜测未配置月份。',
    'SDC 是额外内部元数据。请先完整执行上下文中其他世界书的日期、历法、状态栏、时间与时间戳要求，不得因输出 SDC 而省略、合并、替代或改写它们。',
    'SDC 仅供构画读取，不能代替其他日期输出；构画不读取、不修改、不接管其他时间戳格式。',
    '完成其他输出要求后，仍必须独立输出含完整 date/weekday/time 的 SDC start/end；其他时间戳不能视作已经满足 SDC。',
].join('\n');
export const STORY_CLOCK_PROMPT_VERSION = 2;
export function buildStoryClockPrompt(settings = {}) {
    const raw = typeof settings.storyClockPrompt === 'string' ? settings.storyClockPrompt : '';
    if (!raw.trim()) return `${DEFAULT_STORY_CLOCK_PROMPT}\n${STORY_CLOCK_MACHINE_CONTRACT}`;
    if (Number(settings.storyClockPromptVersion) >= STORY_CLOCK_PROMPT_VERSION) return raw;
    return `${raw.trim()}\n${STORY_CLOCK_MACHINE_CONTRACT}`;
}
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
    const shared = parseStoryDate(text);
    if (shared) return shared;
    // 含“年…月”的完整纪年却未通过严格结构解析时，不得退化成无年月日，
    // 否则自然语言前缀或越界年份会被误认作普通月日。
    if (/(?:年\s*[^\n|｜,，]{0,12}?月\s*[^\n|｜,，]{0,8}?日?)/.test(text)) return null;
    let match = text.match(/第?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (match) { const value = deps.validMonthDay({ month: +match[1], day: +match[2] }, calendar); if (value) return value; }
    if (calendar !== deps.defaultCalendar) for (let i = 0; i < calendar.months.length; i++) {
        const name = String(calendar.months[i].name || '').trim(); if (!name) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const found = text.match(new RegExp(escaped + '\\s*(?:第\\s*)?(初[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]+|\\d{1,2})\\s*日?'));
        if (found) { const cnNumber = deps.cnToNumber || _cnToNumber; const day = /^\d+$/.test(found[1]) ? +found[1] : (found[1].startsWith('初') ? cnNumber(found[1].slice(1)) : cnNumber(found[1])); const value = deps.validMonthDay({ month: i + 1, day }, calendar); if (value) return value; }
    }
    const cn = text.match(/(正|冬|腊|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參肆伍陆陸柒捌玖拾]+)\s*月\s*(初[零〇一二两兩三四五六七八九十廿卅壹贰貳參叄肆伍陆陸柒捌玖拾]|[零〇一二两兩三四五六七八九十廿卅壹贰貳參叄肆伍陆陸柒捌玖拾]+)\s*日?/);
    if (cn) { const cnNumber = deps.cnToNumber || _cnToNumber; const month = cn[1] in deps.monthAlias ? deps.monthAlias[cn[1]] : cnNumber(cn[1]); const day = cn[2].startsWith('初') ? cnNumber(cn[2].slice(1)) : cnNumber(cn[2]); const value = deps.validMonthDay({ month, day }, calendar); if (value) return value; }
    return deps.monthDayFromKey(deps.extractDay(text));
}
