import { _cnToNumber, _CN_MONTH_ALIAS, normalizeCnDateDigits } from '../../utils/cn-date.js';
const CLOCK_NAMESPACES = Object.freeze(['SDC', 'QQJ', 'myknots']);
let deps = { loadCalendar: () => null, validMonthDay: () => null, validRealDate: null, defaultCalendar: null, monthDayFromKey: () => null, extractDay: () => null, cnToNumber: () => 0, monthAlias: {}, explicitWeekdayDate: () => null, context: () => null };
export function bindStoryClock(next = {}) { deps = { ...deps, ...next }; }
const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_ALIASES = /(?:周|週|星期|礼拜|禮拜)\s*([一二三四五六日天])|\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
function parseStoryWeekday(text) {
    const m = WEEKDAY_ALIASES.exec(String(text || ''));
    if (!m) return null;
    if (m[1]) return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 })[m[1]];
    return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(m[2].toLowerCase());
}
const STORY_NUMERAL = '[0-9０-９零〇一二两兩三四五六七八九十百千廿卄卅卌壹贰貳叁參叄肆伍陆陸柒捌玖拾佰仟万萬亿億]+';
const STORY_DIGITS = /^[0-9零〇一二两兩三四五六七八九壹贰貳叁參叄肆伍陆陸柒捌玖]+$/;
const escapePattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function storyNumber(value) {
    const token = normalizeCnDateDigits(value).trim().replace(/^初/, '');
    if (/^\d+$/.test(token)) return Number(token);
    // 数字只在年月日词元里归一；纪年标签和正式月名保持原文。
    if (STORY_DIGITS.test(token)) return Number([...token].map(ch => /\d/.test(ch) ? ch : _cnToNumber(ch)).join(''));
    return _cnToNumber(token);
}
function storyYear(value, calendar, structured) {
    const text = String(value).trim();
    const labels = [...new Set([calendar?.title, calendar?.era].map(x => String(x || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
    const numberPattern = new RegExp(`^(?:元|${STORY_NUMERAL})$`);
    let eraLabel = ''; let number = text; let explicit = false;
    const known = labels.find(label => text.startsWith(label) && numberPattern.test(text.slice(label.length).trim()));
    if (known) { eraLabel = known; number = text.slice(known.length).trim(); }
    else {
        const bracket = /^【([^】]+)】\s*(.*)$/.exec(text);
        if (bracket) { eraLabel = bracket[1]; number = bracket[2]; explicit = true; }
        else {
            const parts = new RegExp(`^(.*?)(元|${STORY_NUMERAL})$`).exec(text);
            if (!parts) return null;
            eraLabel = parts[1].trim(); number = parts[2];
        }
    }
    if (/[<>【】{}|｜,，;；\n]/.test(eraLabel)) return null;
    if (!structured && eraLabel && !known && !explicit) {
        // 旧自由文本仍要求明确短年号；不把叙述连接词当纪年。
        if (/^(?:截至|来到|來到|后来|後來|我们|我們|此时|此時|时至|時至)$/.test(eraLabel)) return null;
        if (!/^[\u3400-\u9fff]{2}$/.test(eraLabel)) return null;
    }
    const year = storyNumber(number);
    if (!Number.isInteger(year) || year < 0 || year > 9999) return null;
    return { year, eraLabel, absoluteYear: !eraLabel || eraLabel === String(calendar?.title || '').trim() };
}
function parseStoryDate(text, calendarOverride = null, { structured = false } = {}) {
    if (calendarOverride?.resolved === false) return null;
    const s = String(text || '').trim();
    const calendar = calendarOverride?.resolved === true ? calendarOverride.calendar : calendarOverride || deps.loadCalendar();
    if (!s || /<\/?bbs_end\s*>/i.test(s)) return null;
    const descriptors = (calendar?.months || []).map((month, index) => ({ index, name: String(month?.name || '').trim() })).filter(x => x.name).sort((a, b) => b.name.length - a.name.length);
    // 正式月名是当前历法的原子词元，优先于“四月”等数字月别名。
    const monthPattern = [...descriptors.map(x => escapePattern(x.name)), `(?:正|冬|腊|臘|${STORY_NUMERAL})\\s*月`].join('|');
    const end = structured ? '\\s*$' : '(?=$|[Tt\\s|｜,，]|周|週|星期|礼拜|禮拜)';
    const chinese = new RegExp(`^(?:([^\\n|｜,，;；]+?)\\s*年\\s*)?(${monthPattern})\\s*(?:第\\s*)?(初?${STORY_NUMERAL})\\s*日?${end}`);
    const digits = '[0-9０-９]';
    const yearWidth = structured ? '+' : '{4}'; // 明确字段按数值校验；旧自由文本保四位 ISO 入口边界。
    const numeric = new RegExp(`^(?:(${digits}${yearWidth})\\s*[-/.]\\s*)?(${digits}{1,2})\\s*[-/.]\\s*(${digits}{1,2})(?:[Tt]\\d{1,2}:\\d{2}(?::\\d{2})?(?:[Zz]|[+-]\\d{2}:?\\d{2})?)?${end}`);
    const validate = (month, day, yearPart = null) => {
        const md = deps.validMonthDay({ month, day }, calendar); if (!md) return null;
        const gregorian = calendar == null || calendar === deps.defaultCalendar || calendar.kind === 'gregorian' || calendar.id === 'default-gregorian' || (!calendar.kind && !calendar.id);
        if (yearPart && gregorian && yearPart.absoluteYear && typeof deps.validRealDate === 'function' && !deps.validRealDate(yearPart.year, month, day)) return null;
        return { ...md, ...(yearPart ? { year: yearPart.year } : {}), ...(yearPart?.eraLabel ? { eraLabel: yearPart.eraLabel } : {}) };
    };
    const parseCandidate = candidate => {
        let match = numeric.exec(candidate);
        if (match) {
            const year = match[1] == null ? null : storyYear(match[1], calendar, structured);
            if (match[1] != null && !year) return null;
            return validate(storyNumber(match[2]), storyNumber(match[3]), year);
        }
        match = chinese.exec(candidate); if (!match) return undefined;
        const year = match[1] == null ? null : storyYear(match[1], calendar, structured);
        if (match[1] != null && !year) return year;
        const formalMonth = descriptors.find(x => x.name === match[2]);
        const monthWord = match[2].replace(/\s*月$/, '');
        const month = formalMonth ? formalMonth.index + 1 : (_CN_MONTH_ALIAS[monthWord] ?? storyNumber(monthWord));
        return validate(month, storyNumber(match[3]), year);
    };
    if (structured) return parseCandidate(s) || null;
    // 旧 compact 戳和日期判定只从原有分隔边界找候选，仍交同一词元/校验流程。
    const starts = [0, ...[...s.matchAll(/[\s|｜,，=＝]+/g)].map(match => match.index + match[0].length)];
    for (const start of starts) {
        const parsed = parseCandidate(s.slice(start));
        if (parsed !== undefined) return parsed;
    }
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
function parseStoryClockMetaValue(raw, calendarOverride = null) {
    const value = String(raw || '').trim();
    const field = name => new RegExp(`(?:^|[|｜,，;；\\n])\\s*(?:${name})\\s*[=＝:]\\s*([^|｜,，;；\\n}]*)`, 'i').exec(value)?.[1]?.trim();
    const structuredDate = field('date');
    const structuredWeekday = field('weekday|星期');
    const structuredTime = field('time');
    const structured = structuredDate != null || structuredWeekday != null || structuredTime != null;
    const date = structured ? (structuredDate ? parseStoryDate(structuredDate, calendarOverride, { structured: true }) : null) : parseStoryDate(value, calendarOverride);
    const weekdayIndex = /^[一二三四五六日天]$/.test(String(structuredWeekday || '').trim())
        ? ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 })[String(structuredWeekday).trim()]
        : parseStoryWeekday(structuredWeekday || value);
    const weekdayText = weekdayIndex == null ? null : WEEKDAY_TEXT[weekdayIndex];
    const dirtyStructuredTime = structuredTime && /(?:^|\s)[^=＝:|｜,，;；\n]+\s*(?:[=＝]|:(?=\s*[^\d]))/.test(structuredTime);
    const time = dirtyStructuredTime ? null : parseStoryTime(structuredTime || value, { structured: !!structuredTime });
    return { raw: value, structured, dateText: structuredDate ?? null, date, month: date?.month ?? null, day: date?.day ?? null, year: date?.year ?? null, eraLabel: date?.eraLabel ?? null, weekdayIndex, weekdayText, time: time || null, valid: !!date, complete: !!date && weekdayIndex != null && !!time };
}
// Literal format examples contain no time metadata; leave real incomplete/duplicate markers visible to validation.
const CLOCK_TEMPLATE_VALUE = /^\s*[|｜]?\s*date\s*[=＝:]\s*(?:…+|\.{3})\s*[|｜]\s*weekday\s*[=＝:]\s*(?:周x|…+|\.{3})\s*[|｜]\s*time\s*[=＝:]\s*(?:…+|\.{3})\s*$/i;
function storyClockMarkers(text, namespace, edge) {
    return [...text.matchAll(new RegExp(`<!--\\s*${namespace}-${edge}\\s+([\\s\\S]*?)\\s*-->`, 'ig'))]
        .filter(match => !CLOCK_TEMPLATE_VALUE.test(match[1]));
}
export function parseStoryClock(message, calendarOverride = null) {
    const text = String(message || '');
    const candidates = CLOCK_NAMESPACES.map(namespace => {
        const starts = storyClockMarkers(text, namespace, 'start');
        const ends = storyClockMarkers(text, namespace, 'end');
        if (!starts.length && !ends.length) return null;
        const start = starts[0]; const end = ends[0];
        const startMeta = start ? parseStoryClockMetaValue(start[1], calendarOverride) : null; const endMeta = end ? parseStoryClockMetaValue(end[1], calendarOverride) : null;
        const duplicate = starts.length !== 1 || ends.length !== 1;
        const complete = !duplicate && !!start && !!end && end.index >= start.index + start[0].length && !!startMeta?.complete && !!endMeta?.complete;
        return { namespace, starts, ends, start, end, startMeta, endMeta, duplicate, complete, sourceIndex: Math.min(start?.index ?? Infinity, end?.index ?? Infinity) };
    }).filter(Boolean).sort((left, right) => Number(right.complete) - Number(left.complete) || left.sourceIndex - right.sourceIndex);
    const selected = candidates[0] ?? null; const start = selected?.start; const end = selected?.end;
    const out = { start: start ? start[1].trim() : null, end: end ? end[1].trim() : null };
    Object.defineProperties(out, { duplicate: { value: selected ? selected.duplicate : true, enumerable: false }, namespace: { value: selected?.namespace ?? null, enumerable: false }, startMeta: { value: selected?.startMeta ?? null, enumerable: false }, endMeta: { value: selected?.endMeta ?? null, enumerable: false } });
    return out;
}
export function storyClockNarrativeBody(message) {
    const text = String(message || '');
    const parsed = parseStoryClock(text);
    const namespace = parsed.namespace ?? 'SDC';
    const start = storyClockMarkers(text, namespace, 'start')[0];
    const end = storyClockMarkers(text, namespace, 'end')[0];
    return start && end && end.index >= start.index + start[0].length
        ? text.slice(start.index + start[0].length, end.index)
        : text;
}
export const STORY_CLOCK_KEY = 'sdc_story_clock';
export const STORY_CLOCK_CALENDAR_KEY = 'sdc_story_clock_calendar';
export const STORY_CLOCK_DEPTH = 0;
export const DEFAULT_STORY_CLOCK_PROMPT = [
    '【故事时间戳 SDC｜每楼附加元数据】',
    '在本楼正文最前与最后各放一个 HTML 注释，作为本楼附加时间元数据，不显示给读者。',
    '沿用正文既有纪年、历法和计时方式；通常以上一楼 end 推进，本楼已有可靠事实时按本楼填写。没有参考时依据剧情合理填写；除此之外不在正文讨论 SDC。',
    '<!-- SDC-start | date=… | weekday=周X | time=… -->正文<!-- SDC-end | date=… | weekday=周X | time=… -->',
].join('\n');
export const STORY_CLOCK_MACHINE_CONTRACT = [
    '【SDC机器合同·双向隔离】',
    'SDC-start 与 SDC-end 必须各自使用 date=… | weekday=… | time=… 三个字段，weekday 只能是周一、周二、周三、周四、周五、周六或周日。有可靠故事年份或纪年时，date 必须携带完整年份并沿用原有年号与历法；开局没有已有可靠纪年时，先依据开场白和本轮生效的世界书设定；中途没有可靠故事年份或纪年时，先依据已经发生的正文和本轮生效的世界书确定合理纪年。上述材料仍无可用纪年时，再结合上下文创作符合世界观的故事年份或纪年，并写入 start 与 end。年份可用纪元年、中文数字、阿拉伯数字或世界观自定义纪年表达，不限四位公历格式；不能使用系统或服务器现实年份。Gregorian 必须使用数字月份；文学季节词不能替代月份。自定义历法仅允许当前 calendar.months 中实际存在的正式月名，不能臆造或猜测未配置月份。',
    'SDC 是额外内部元数据。请先完整执行上下文中其他世界书的日期、历法、状态栏、时间与时间戳要求，不得因输出 SDC 而省略、合并、替代或改写它们。',
    'SDC 仅供构画读取，不能代替其他日期输出；构画不读取、不修改、不接管其他时间戳格式。',
    '完成其他输出要求后，仍必须独立输出含完整 date/weekday/time 的 SDC start/end；其他时间戳不能视作已经满足 SDC。',
].join('\n');
export const STORY_CLOCK_PROMPT_VERSION = 2;
export function buildStoryClockPrompt(settings = {}) {
    const raw = typeof settings.storyClockPrompt === 'string' ? settings.storyClockPrompt : '';
    if (!raw.trim()) return `${DEFAULT_STORY_CLOCK_PROMPT}\n${STORY_CLOCK_MACHINE_CONTRACT}`;
    return raw;
}
export function buildStoryClockCalendarContext(description = '') {
    const text = String(description || '').trim();
    if (!text) return '';
    return [
        '【现行历法｜故事时间戳实时数据】',
        text,
        '本楼故事时间戳的日期字段须使用上面实际配置的正式月名和日数，并保留既有时间戳格式。若上方给出历法时间戳名称，日期中的年份前须紧接该名称，例如「王国历1686年10月4日」；纪年名仍按正文原有格式使用。每月最后一天的下一天进入下一个配置月；正文已经明确写出合法日期时，各时间戳边界须分别与对应正文时刻一致，不得保留上一月的越界日期。',
    ].join('\n');
}
export function latestStoryClock(context, limit = 100) {
    const messages = context?.chat || []; let scanned = 0;
    for (let i = messages.length - 1; i >= 0 && scanned < limit; i--) { const msg = messages[i]; if (!msg || msg.is_user || msg.is_system || msg.role === 'system' || !msg.mes) continue; scanned++; const clock = parseStoryClock(msg.mes, deps.calendarForFloor?.(i, context)); const out = { start: clock.start, end: clock.end, floor: i }; Object.defineProperties(out, { duplicate: { value: clock.duplicate, enumerable: false }, startMeta: { value: clock.startMeta, enumerable: false }, endMeta: { value: clock.endMeta, enumerable: false } }); return out; }
    return null;
}
export function completeStoryClock(clock) { return !!clock && !clock.duplicate && !!clock.startMeta?.complete && !!clock.endMeta?.complete; }
function storyWeekdayResult(refDoy, refWd, weekdayText, floor, source, sourceFloor = floor) {
    const out = { refDoy, refWd, weekdayText, floor };
    Object.defineProperties(out, {
        source: { value: source, enumerable: false },
        sourceFloor: { value: sourceFloor, enumerable: false },
    });
    return out;
}
function sameStoryDate(left, right) {
    if (!left || !right || left.month !== right.month || left.day !== right.day) return false;
    if (left.year != null && right.year != null && left.year !== right.year) return false;
    if (left.eraLabel != null && right.eraLabel != null && left.eraLabel !== right.eraLabel) return false;
    return true;
}
function storyTextWithoutClockMetadata(message) {
    return String(message || '')
        .replace(/<!--\s*(?:SDC|QQJ|myknots)-(?:start|end)\s+[\s\S]*?\s*-->/ig, ' ')
        // 未闭合的 HTML 注释从标记处直到楼尾都仍属于注释元数据；不能让其中
        // 的 date/weekday 泄漏成正文显式证据。
        .replace(/<!--\s*(?:SDC|QQJ|myknots)-(?:start|end)\b[\s\S]*$/i, ' ');
}
export function storyWeekdayRef(context = deps.context?.(), calendar = deps.loadCalendar?.(), limit = 100, floor = null, currentDate = null) {
    const messages = context?.chat || []; const top = Number.isInteger(floor) ? Math.min(floor, messages.length - 1) : messages.length - 1;
    let aiFloor = null; let scanned = 0;
    for (let i = top; i >= 0 && scanned < limit; i--) {
        const msg = messages[i]; if (!msg || msg.is_user || msg.is_system || msg.role === 'system' || !msg.mes) continue;
        scanned++; aiFloor = i; break;
    }
    if (!Number.isInteger(aiFloor)) return null;
    const clock = parseStoryClock(messages[aiFloor].mes, deps.calendarForFloor?.(aiFloor, context));
    if (completeStoryClock(clock)) {
        const meta = clock.endMeta;
        const refDoy = deps.dayOfYear?.(meta.month, meta.day, calendar);
        return Number.isInteger(refDoy) ? storyWeekdayResult(refDoy, meta.weekdayIndex, meta.weekdayText, aiFloor, 'sdc') : null;
    }

    // 只读当前 AI 楼正文里的显式「日期 + 星期」组合。先剥掉残缺/重复 SDC，
    // 避免其中单侧 weekday 字段伪装成正文证据；解析能力由既有保守 helper 提供。
    const explicit = deps.explicitWeekdayDate?.(storyTextWithoutClockMetadata(messages[aiFloor].mes), calendar);
    if (explicit && Number.isInteger(explicit.wd)) {
        const md = deps.validMonthDay?.({ month: explicit.month, day: explicit.day }, calendar);
        const refDoy = md ? deps.dayOfYear?.(md.month, md.day, calendar) : null;
        if (Number.isInteger(refDoy)) return storyWeekdayResult(refDoy, explicit.wd, WEEKDAY_TEXT[explicit.wd], aiFloor, 'explicit');
    }

    // 半残 SDC 只能贡献日期相位，不能贡献星期；无可用日期时再使用调用方已经
    // 确认的当前日期锚。重复 SDC 不作为日期证据，以免两份互相冲突的标签抢占。
    const clockDate = !clock.duplicate
        ? (clock.endMeta?.valid ? clock.endMeta.date : (clock.startMeta?.valid ? clock.startMeta.date : null))
        : null;
    const effectiveDate = clockDate || currentDate;
    if (!effectiveDate) return null;

    for (let i = aiFloor - 1; i >= 0 && scanned < limit; i--) {
        const msg = messages[i]; if (!msg || msg.is_user || msg.is_system || msg.role === 'system' || !msg.mes) continue;
        scanned++;
        const historical = parseStoryClock(msg.mes, deps.calendarForFloor?.(i, context));
        if (!completeStoryClock(historical)) continue;
        const meta = historical.endMeta;
        // 只允许最近一份完整历史 SDC 作证；它一旦不同日/纪年不相容，
        // 就立即未知，不能越过它捞取更老的同日记录。
        if (!sameStoryDate(effectiveDate, meta?.date)) return null;
        const refDoy = deps.dayOfYear?.(meta.month, meta.day, calendar);
        return Number.isInteger(refDoy) ? storyWeekdayResult(refDoy, meta.weekdayIndex, meta.weekdayText, aiFloor, 'history-same-day', i) : null;
    }
    return null;
}
export function storyClockDate(context, parseDate, limit = 100) { const clock = latestStoryClock(context, limit); return clock ? (clock.endMeta?.date || clock.startMeta?.date || parseDate(clock.end) || parseDate(clock.start)) : null; }
export function createStoryClockController(options = {}) {
    const refresh = () => {
        const context = options.context?.();
        const setPrompt = context?.setExtensionPrompt;
        if (typeof setPrompt !== 'function') return { status: 'unavailable' };
        const managesCalendarContext = typeof options.calendarContext === 'function';
        const clear = () => {
            setPrompt(STORY_CLOCK_KEY, '');
            if (managesCalendarContext) setPrompt(STORY_CLOCK_CALENDAR_KEY, '');
        };
        const settings = options.settings?.() || {};
        const active = options.pluginEnabled?.() === true && options.enabled?.() === true;
        const custom = typeof settings.storyClockPrompt === 'string' && settings.storyClockPrompt.trim().length > 0;
        const peer = options.peerState?.() || {};
        if (!active) { clear(); return { status: 'cleared', inject: false }; }
        const pt = context.constants?.promptTypes?.IN_CHAT ?? 1;
        const pr = context.constants?.promptRoles?.SYSTEM ?? 0;
        const calendarPrompt = managesCalendarContext ? buildStoryClockCalendarContext(options.calendarContext?.()) : '';
        if (managesCalendarContext) setPrompt(STORY_CLOCK_CALENDAR_KEY, calendarPrompt, pt, STORY_CLOCK_DEPTH, false, pr);
        if (!custom && peer.active === true && peer.custom === true) {
            setPrompt(STORY_CLOCK_KEY, '');
            return { status: 'adapted-peer-custom', inject: false, calendarInject: !!calendarPrompt };
        }
        setPrompt(STORY_CLOCK_KEY, buildStoryClockPrompt(settings), pt, STORY_CLOCK_DEPTH, false, pr);
        return { status: custom ? 'custom' : 'injected', inject: true, calendarInject: !!calendarPrompt };
    };
    return { refresh, clear: () => {
        const context = options.context?.();
        context?.setExtensionPrompt?.(STORY_CLOCK_KEY, '');
        if (typeof options.calendarContext === 'function') context?.setExtensionPrompt?.(STORY_CLOCK_CALENDAR_KEY, '');
    } };
}
export function extensionStoryClockState({ extensionNames = [], disabledExtensions = [], extensionSuffix, peerSettings } = {}) {
    const extensionId = extensionNames.find(name => String(name).endsWith(extensionSuffix)) || null;
    const active = !!(extensionId && !disabledExtensions.includes(extensionId) && peerSettings && peerSettings.pluginEnabled !== false && peerSettings.storyClockEnabled !== false);
    return { active, custom: active && typeof peerSettings.storyClockPrompt === 'string' && peerSettings.storyClockPrompt.trim().length > 0 };
}
export function parseJudgedDate(answer, calendarOverride = null) {
    const text = String(answer || '').trim(); if (!text || /未知|无法|不确定|不清楚|没有|无明确/.test(text)) return null;
    if (calendarOverride?.resolved === false) return null;
    const calendar = calendarOverride?.resolved === true ? calendarOverride.calendar : calendarOverride || deps.loadCalendar();
    const shared = parseStoryDate(text, calendar);
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
    return deps.monthDayFromKey(deps.extractDay(text), calendar);
}
