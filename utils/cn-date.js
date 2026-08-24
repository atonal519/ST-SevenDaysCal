// utils/cn-date.js — 中文日期纯函数（无状态）。Phase 0 从 index.js 机械搬移。


export const _CN_NUM_MAP = { 零:0, 〇:0, 一:1, 二:2, 两:2, 兩:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10, 廿:20, 卄:20, 卅:30, 卌:40,
    壹:1, 贰:2, 貳:2, 叁:3, 參:3, 叄:3, 肆:4, 伍:5, 陆:6, 陸:6, 柒:7, 捌:8, 玖:9, 拾:10, 佰:100, 仟:1000 };

export const _CN_MONTH_ALIAS = { 正:1, 冬:11, 腊:12, 臘:12 };
export function normalizeCnDateDigits(value) { return String(value ?? '').replace(/[０-９]/g, ch => String(ch.charCodeAt(0) - 0xFF10)); }

export function _cnToNumber(s) {
    if (!s) return null;
    if (s === '元') return 1;
    s = normalizeCnDateDigits(s);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.length === 1) return _CN_NUM_MAP[s] ?? null;   // 单字含 廿=20 / 卅=30
    // 廿三=23 / 卅一=31（农历日常写 廿一~廿九，偶见卅）：首字定 20/30，其后为个位。
    if (s[0] === '廿' || s[0] === '卄' || s[0] === '卅') {
        const ones = _CN_NUM_MAP[s.slice(1)];
        if (ones != null && ones < 10) return _CN_NUM_MAP[s[0]] + ones;
        return null;
    }
    const t = s.replace(/拾/g, '十').replace(/佰/g, '百').replace(/仟/g, '千');
    if (t.includes('千') || t.includes('百')) {
        let total = 0; let rest = t;
        for (const [unit, factor] of [['千', 1000], ['百', 100]]) {
            const parts = rest.split(unit);
            if (parts.length > 1) { total += (parts[0] ? (_CN_NUM_MAP[parts[0]] ?? Number(parts[0])) : 1) * factor; rest = parts.slice(1).join(unit); }
        }
        if (rest) { const tail = _cnToNumber(rest); if (tail != null) total += tail; }
        return total || null;
    }
    if (t.includes('十')) {
        const [a, b] = t.split('十');
        const tens = a === '' ? 1 : _CN_NUM_MAP[a];
        const ones = b === '' ? 0 : _CN_NUM_MAP[b];
        if (tens != null && ones != null) return tens * 10 + ones;
    }
    return null;
}

export function extractDayFromTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    let m;
    // 阿拉伯：YYYY年M月D日
    if ((m = timeStr.match(/(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/))) return `${+m[1]}-${+m[2]}-${+m[3]}`;
    // 阿拉伯：YYYY/M/D、YYYY-M-D、YYYY.M.D
    if ((m = timeStr.match(/(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/))) return `${+m[1]}-${+m[2]}-${+m[3]}`;
    // 纪元年名 + 数字月/日：如「天河四十二年/03/19」「大梁三年-12-5」——年是非数字纪元名（前两条数字年
    // 已先行匹配），故只截其后的数字 M/D，年当无（cn- 占位 0）。年后须紧跟标点分隔符，挡掉「去年 3/4」这类。
    if ((m = timeStr.match(/年\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/))) return `cn-0-${+m[1]}-${+m[2]}`;
    // 相对天数：第N天/日
    if ((m = timeStr.match(/第\s*(\d+)\s*[天日]/))) return `day-${+m[1]}`;
    // day N
    if ((m = timeStr.match(/day\s*(\d+)/i))) return `day-${+m[1]}`;
    // 古代中文：<cn年>年<cn月/正/冬/腊>月<初X/cn日>[日]?
    m = timeStr.match(/(元|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]+)\s*年\s*(正|冬|腊|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]+)\s*月\s*(初[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]|[零〇一二两兩三四五六七八九十廿卅壹贰貳叁參叄肆伍陆陸柒捌玖拾]+)/);
    if (m) {
        const year  = _cnToNumber(m[1]);
        const month = (m[2] in _CN_MONTH_ALIAS) ? _CN_MONTH_ALIAS[m[2]] : _cnToNumber(m[2]);
        const day   = m[3].startsWith('初') ? _cnToNumber(m[3].slice(1)) : _cnToNumber(m[3]);
        if (year != null && month != null && day != null) return `cn-${year}-${month}-${day}`;
    }
    return null;
}
