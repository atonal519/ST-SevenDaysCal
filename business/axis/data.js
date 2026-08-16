// business/axis/data.js — Phase 2b-1: axis 低风险纯数据函数/常量/helper（机械搬移，逻辑零改动）
import { keyDesc, readStore, writeStore } from '../../store.js';
import { getSettings } from '../../runtime/settings.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { extractDayFromTime } from '../../utils/cn-date.js';
import { getContext } from '../../../../../extensions.js';
const ALM_TYPES = ['festival', 'birthday', 'anniversary', 'custom'];

function almId() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function getAlmanacKey() { return keyDesc('almanac', 'user', ''); }  // 固定 user scope，与当前视角无关

function almClampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}

function normalizeAlmItem(it, cal = loadCalDesc()) {
    if (!it || typeof it !== 'object') return null;
    const name = String(it.name || '').trim();
    if (!name) return null;
    const month = almClampInt(it.month, 1, calMonthCount(cal), 1);
    return {
        id: it.id || almId(),
        name,
        type: ALM_TYPES.includes(it.type) ? it.type : 'custom',
        month,
        day: almClampInt(it.day, 1, calMonthDays(cal, month), 1),
        days: almClampInt(it.days, 1, calYearLen(cal), 1),   // 持续天数：单日=1，多日节假日>1（缺失退化为 1，向后兼容）
        displayDate: String(it.displayDate || '').trim(),
        note: String(it.note || '').trim(),
        pin: !!it.pin,
        source: it.source === 'user' ? 'user' : 'ai',
    };
}

function loadAlmanac() {
    const saved = readStore(getAlmanacKey());
    const items = Array.isArray(saved?.items) ? saved.items : [];
    // 必须 arrow 包一层：裸传 normalizeAlmItem 会让 map 把「下标」当第二参 cal 传进去，
    // 第 2 条起下标为真值数字 → calMonthCount 里 (1).months.length 抛 undefined，全模块生成崩。
    return items.map(it => normalizeAlmItem(it)).filter(Boolean);
}

function saveAlmanacItems(items) { writeStore(getAlmanacKey(), { items, ts: Date.now() }); }

function almTypeMeta(type) {
    switch (type) {
        case 'festival':    return { label: '节日',   cls: 'festival',    icon: 'fa-champagne-glasses' };
        case 'birthday':    return { label: '生日',   cls: 'birthday',    icon: 'fa-cake-candles' };
        case 'anniversary': return { label: '纪念日', cls: 'anniversary', icon: 'fa-heart' };
        default:            return { label: '自定义', cls: 'custom',      icon: 'fa-star' };
    }
}

function almDateLabel(it, cal = loadCalDesc()) {
    if (it.displayDate) return it.displayDate;
    const days = almClampInt(it.days, 1, calYearLen(cal), 1);
    if (days > 1) { const e = almEndMonthDay(it, cal); return `${calMonthName(cal, it.month)}${it.day}日–${calMonthName(cal, e.month)}${e.day}日`; }
    return `${calMonthName(cal, it.month)}${it.day}日`;
}

function monthDayFromDayKey(key, cal = loadCalDesc()) {
    if (!key) return null;
    let m;
    if ((m = String(key).match(/^(\d+)-(\d+)-(\d+)$/)) || (m = String(key).match(/^cn-(\d+)-(\d+)-(\d+)$/))) {
        return almValidMonthDay({ month: +m[2], day: +m[3] }, cal);   // 严格按当前历校验；越界=不可信来源，返回 null 让链继续
    }
    return null;
}

function almValidMonthDay(md, cal = loadCalDesc()) {
    if (!md) return null;
    const mo = md.month, da = md.day;
    if (!Number.isFinite(mo) || !Number.isFinite(da)) return null;
    if (mo < 1 || mo > calMonthCount(cal)) return null;
    if (da < 1 || da > calMonthDays(cal, mo)) return null;
    return { month: mo, day: da };
}

const ALM_CHAT_SCAN_LIMIT = 40;

function almDayOfYear(month, day, cal = loadCalDesc()) {
    const m = almClampInt(month, 1, calMonthCount(cal), 1);
    let doy = almClampInt(day, 1, calMonthDays(cal, m), 1);
    for (let i = 1; i < m; i++) doy += calMonthDays(cal, i);
    return doy;
}

const ALM_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];  // 周日索引，对齐 JS getDay() / renderSchedule

function parseWeekdayToken(text) {
    const s = String(text || '');
    let m = s.match(/(?:周|週|星期|禮拜|礼拜)\s*([一二三四五六日天])/);
    if (m) return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[m[1]];
    m = s.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (m) return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(m[1].toLowerCase());
    return null;
}

const _WEEKDAY_ADJ_RE = /\d{1,2}\s*[日号]?[\s·.,，、｜|/／~〜—\-]{0,3}(?:(?:星期|週|周|礼拜|禮拜)\s*([一二三四五六日天])|\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b)/i;

function weekdayAdjacent(text) {
    const m = _WEEKDAY_ADJ_RE.exec(String(text || ''));
    if (!m) return null;
    if (m[1] != null) return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[m[1]];
    if (m[2]) return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(m[2].toLowerCase());
    return null;
}

function calRealWeekdayRef(timeStr, cal = loadCalDesc()) {
    if (cal !== DEFAULT_CAL) return null;                                     // 自定义历法：现实公历周几无意义
    const m = /^(\d+)-(\d+)-(\d+)$/.exec(extractDayFromTime(timeStr) || '');  // 纯阿拉伯 YYYY-M-D，排除 day-N / cn-
    if (!m) return null;
    const refDoy = almDayOfYear(+m[2], +m[3], cal);
    const tok = weekdayAdjacent(timeStr);            // 时间串里紧贴日期写死的周几：剧情自洽 > 真实公历，压过 getDay()
    if (tok != null) return { refDoy, refWd: tok };
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (isNaN(d)) return null;
    return { refDoy, refWd: d.getDay() };
}

function almMonthDayFromDoy(doy, cal = loadCalDesc()) {
    const total = calYearLen(cal);
    const mc = calMonthCount(cal);
    let d = ((Math.round(doy) - 1) % total + total) % total + 1; // 归一到 1..年长
    for (let m = 1; m <= mc; m++) {
        const dim = calMonthDays(cal, m);
        if (d <= dim) return { month: m, day: d };
        d -= dim;
    }
    return { month: mc, day: calMonthDays(cal, mc) };
}

function almEndMonthDay(it, cal = loadCalDesc()) {
    const days = almClampInt(it.days, 1, calYearLen(cal), 1);
    if (days <= 1) return { month: it.month, day: it.day };
    return almMonthDayFromDoy(almDayOfYear(it.month, it.day, cal) + days - 1, cal);
}

function almItemCoversDoy(it, doy, cal = loadCalDesc()) {
    const total = calYearLen(cal);
    const start = almDayOfYear(it.month, it.day, cal);
    const len = almClampInt(it.days, 1, total, 1);
    return ((doy - start) % total + total) % total < len;
}

function getCalDescInjectText() {
    const cal = loadCalDesc();
    if (cal === DEFAULT_CAL) return '';
    const months = cal.months.map((m, i) => `${i + 1}=${m.name}(${m.days}天)`).join('、');
    return `${cal.era ? '纪年：' + cal.era + '；' : ''}一年 ${calMonthCount(cal)} 个月、共 ${calYearLen(cal)} 天；各月：${months}`;
}

function almMapType(t) {
    const s = String(t || '').toLowerCase().trim();
    if (['festival', '节日', '节庆', 'holiday', '节假日'].includes(s)) return 'festival';
    if (['birthday', '生日', '诞辰'].includes(s)) return 'birthday';
    if (['anniversary', '纪念日', '纪念'].includes(s)) return 'anniversary';
    return 'custom';
}

function parseAlmanacWidget(raw) {
    const s = String(raw || '');
    const m = s.match(/<almanac_widget>([\s\S]*?)<\/almanac_widget>/i);
    const body = m ? m[1] : s;
    const out = [];
    for (const line of body.split('\n')) {
        const mm = line.match(/^\s*Item\s*:\s*(.+)$/i);
        if (!mm) {
            // 续行救援：提示词要求「说明单行不换行」，但模型对长说明常忍不住折行。
            // 非 Item 行不是垃圾，而是上一条说明被换行截断的尾巴——接回上一条 note，
            // 别再像旧版那样静默丢弃（老症状：几条较长的纪念日说明只显示到折行处）。
            const cont = line.trim();
            if (cont && out.length) out[out.length - 1].note = (out[out.length - 1].note + cont).trim();
            continue;
        }
        const parts = mm[1].split('|').map(x => x.trim());
        const [name, type, month, day, days, displayDate, ...noteRest] = parts;
        const it = normalizeAlmItem({
            name, type: almMapType(type), month, day, days, displayDate,
            note: noteRest.join('|').trim(), source: 'ai', pin: false,
        });
        if (it) out.push(it);
    }
    return out;
}

function parseEraWidget(raw) {
    const s = String(raw || '');
    const m = s.match(/<era_widget>([\s\S]*?)<\/era_widget>/i);
    const body = m ? m[1] : s;
    let era = '';
    const months = [];
    for (const line of body.split('\n')) {
        const em = line.match(/^\s*Era\s*:\s*(.+)$/i);
        if (em) { era = em[1].trim(); continue; }
        const mm = line.match(/^\s*Month\s*:\s*(.+)$/i);
        if (!mm) continue;
        const [name, days] = mm[1].split('|').map(x => x.trim());
        months.push({ name, days });
    }
    return normalizeCalDesc({ era, months });
}

function almDedupKey(it) { return `${it.name.toLowerCase()}|${it.month}|${it.day}`; }

function mergeAlmanac(oldItems, aiItems) {
    const kept = oldItems.filter(it => it.pin || it.source === 'user');
    const seen = new Set(kept.map(almDedupKey));
    const merged = [...kept];
    for (const it of aiItems) {
        const k = almDedupKey(it);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(it);
    }
    return merged;
}

function loadCalDesc() { return normalizeCalDesc(readStore(getCalDescKey())) || DEFAULT_CAL; }

function getCalDescKey() { return keyDesc('caldesc', 'user', ''); }   // 固定 user scope，与视角无关（镜像 getAlmanacKey）

function normalizeCalDesc(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const era = String(raw.era || '').trim().slice(0, 24);
    const months = (Array.isArray(raw.months) ? raw.months : [])
        .slice(0, 60)   // 最多 60 个月，防滥用撑爆
        .map((m, i) => ({
            name: (String(m?.name || '').trim().slice(0, 12)) || `${i + 1}月`,
            days: almClampInt(m?.days, 1, 60, 30),
        }));
    if (!months.length) return null;                                   // 无月 → 不成历法，退默认
    if (months.reduce((a, b) => a + b.days, 0) > 2000) return null;    // 年过长 → 视为无效
    return { era, months };
}

function saveCalDesc(desc) {
    const n = normalizeCalDesc(desc);
    if (!n) return false;
    writeStore(getCalDescKey(), { ...n, ts: Date.now() });
    return true;
}

const ALM_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const DEFAULT_CAL = Object.freeze({
    era   : '',
    months: Object.freeze(ALM_DAYS_IN_MONTH.map((d, i) => Object.freeze({ name: `${i + 1}月`, days: d }))),
});

function _cal(cal) { return (cal && Array.isArray(cal.months) && cal.months.length) ? cal : DEFAULT_CAL; }

function calYearLen(cal)     { return _cal(cal).months.reduce((a, b) => a + b.days, 0); }

function calMonthCount(cal)  { return _cal(cal).months.length; }

function calMonthDays(cal, m){ const M = _cal(cal).months; return M[almClampInt(m, 1, M.length, 1) - 1].days; }

function calMonthName(cal, m){ const M = _cal(cal).months; const i = almClampInt(m, 1, M.length, 1) - 1; return M[i].name || `${i + 1}月`; }

function calHasEra(cal)      { return !!String(_cal(cal).era || '').trim(); }

const CALENDAR_LIMITS = Object.freeze({
    eraNameLength: 24,
    monthNameLength: 12,
    monthCount: 60,
    monthDaysMin: 1,
    monthDaysMax: 60,
    yearDays: 2000,
    defaultMonthDays: 30,
});

const CALENDAR_TEMPLATE_NAME_LENGTH = 40;

function cloneCalDesc(cal) {
    return { era: String(cal.era || ''), months: cal.months.map(month => ({ name: String(month.name), days: Number(month.days) })) };
}

function validateCalendarDesc(raw) {
    const era = String(raw?.era || '').trim();
    if (era.length > CALENDAR_LIMITS.eraNameLength) return { error: `纪年名最多 ${CALENDAR_LIMITS.eraNameLength} 个字` };
    const months = Array.isArray(raw?.months) ? raw.months : [];
    if (!months.length) return { error: '至少需要一个月份' };
    if (months.length > CALENDAR_LIMITS.monthCount) return { error: `最多只能有 ${CALENDAR_LIMITS.monthCount} 个月份` };
    const out = [];
    for (let index = 0; index < months.length; index++) {
        const name = String(months[index]?.name || '').trim();
        const days = Number(months[index]?.days);
        if (!name) return { error: `第 ${index + 1} 个月需要填写名称` };
        if (name.length > CALENDAR_LIMITS.monthNameLength) return { error: `第 ${index + 1} 个月名称最多 ${CALENDAR_LIMITS.monthNameLength} 个字` };
        if (!Number.isInteger(days) || days < CALENDAR_LIMITS.monthDaysMin || days > CALENDAR_LIMITS.monthDaysMax) return { error: `${name}的天数必须是 ${CALENDAR_LIMITS.monthDaysMin}–${CALENDAR_LIMITS.monthDaysMax} 的整数` };
        out.push({ name, days });
    }
    if (out.reduce((sum, month) => sum + month.days, 0) > CALENDAR_LIMITS.yearDays) return { error: `全年总天数不能超过 ${CALENDAR_LIMITS.yearDays} 天` };
    return { value: { era, months: out } };
}

function loadCalendarTemplates() {
    const list = Array.isArray(getSettings().calendarTemplates) ? getSettings().calendarTemplates : [];
    return list.map(item => {
        const cal = validateCalendarDesc(item).value;
        const id = String(item?.id || '');
        const name = String(item?.name || '').trim();
        return cal && id && name ? { ...cal, id, name, createdAt: Number(item.createdAt) || 0, updatedAt: Number(item.updatedAt) || 0 } : null;
    }).filter(Boolean);
}

function saveCalendarTemplates(list) {
    getSettings().calendarTemplates = list.map(item => ({
        id: item.id,
        name: item.name,
        era: item.era,
        months: item.months.map(month => ({ name: month.name, days: month.days })),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
    }));
    saveSettingsDebounced();
}

// Phase 2b-2: 次一级数据函数 / 模板绑定簇（纯数据，无跨域依赖）
function calendarTemplateId() { return 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function renameCalendarTemplate(list, id, name) {
    return list.map(item => item.id === id ? { ...item, name, updatedAt: Date.now() } : item);
}

function calendarTemplateBindings() {
    const settings = getSettings();
    if (!settings.calendarTemplateBindings || typeof settings.calendarTemplateBindings !== 'object' || Array.isArray(settings.calendarTemplateBindings)) settings.calendarTemplateBindings = {};
    return settings.calendarTemplateBindings;
}

function sortCalendarTemplatesForCurrent(list, currentTemplateId) {
    return list.map((template, index) => ({ template, index }))
        .sort((a, b) => Number(b.template.id === currentTemplateId) - Number(a.template.id === currentTemplateId) || a.index - b.index)
        .map(item => item.template);
}

// Phase 2b-3: 独立的数据/注入层函数（扫聊天取最近日期；无跨域污染源）
// 从最新楼往回扫、命中即返回 → 取到的是「最近一处」写明的日期，贴合「现在」；扫描上限兜住超长聊天。
function almDateFromChat() {
    const msgs = getContext().chat || [];
    let scanned = 0;
    for (let i = msgs.length - 1; i >= 0 && scanned < ALM_CHAT_SCAN_LIMIT; i--) {
        const msg = msgs[i];
        if (!msg || msg.is_user || !msg.mes) continue;
        scanned++;
        const raw = String(msg.mes);
        const key = extractDayFromTime(raw);
        const md  = monthDayFromDayKey(key);
        if (!md) continue;
        let date = null;
        const ymd = /^(\d+)-(\d+)-(\d+)$/.exec(String(key));  // 纯阿拉伯 → 带真实年，可取现实周几；排除 cn-
        if (ymd) { const d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]); if (!isNaN(d)) date = d; }
        // 同楼里紧贴日期的「状态栏周几」token：供上层压过真实 getDay()（写死的剧情周几 > 公历）。缺则 null，退回 getDay。
        const wd = weekdayAdjacent(raw);
        return { month: md.month, day: md.day, date, wd };
    }
    return null;
}

export {
    ALM_TYPES,
    almId,
    getAlmanacKey,
    almClampInt,
    normalizeAlmItem,
    loadAlmanac,
    saveAlmanacItems,
    almTypeMeta,
    almDateLabel,
    monthDayFromDayKey,
    almValidMonthDay,
    ALM_CHAT_SCAN_LIMIT,
    almDayOfYear,
    ALM_WEEKDAYS,
    parseWeekdayToken,
    _WEEKDAY_ADJ_RE,
    weekdayAdjacent,
    calRealWeekdayRef,
    almMonthDayFromDoy,
    almEndMonthDay,
    almItemCoversDoy,
    getCalDescInjectText,
    almMapType,
    parseAlmanacWidget,
    parseEraWidget,
    almDedupKey,
    mergeAlmanac,
    loadCalDesc,
    getCalDescKey,
    normalizeCalDesc,
    saveCalDesc,
    ALM_DAYS_IN_MONTH,
    DEFAULT_CAL,
    _cal,
    calYearLen,
    calMonthCount,
    calMonthDays,
    calMonthName,
    calHasEra,
    CALENDAR_LIMITS,
    CALENDAR_TEMPLATE_NAME_LENGTH,
    cloneCalDesc,
    validateCalendarDesc,
    loadCalendarTemplates,
    saveCalendarTemplates,
    calendarTemplateId,
    renameCalendarTemplate,
    calendarTemplateBindings,
    sortCalendarTemplatesForCurrent,
    almDateFromChat,
};
