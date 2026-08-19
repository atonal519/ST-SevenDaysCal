// ─── 点（日程）域 · 文本 codec / 存取辅助（纯函数，零跨域依赖）────────────────────
// 从 index.js 机械搬移。全部为 <calendar_widget>「七天条」的 文本↔对象 互转与读写辅助，
// 无 DOM / store / 历法(axis) 依赖。渲染层（renderSchedule 等）见 ./render.js，生成 prompt 见 ./prompt.js。

// 点 Event 行 → 逐行文本（供提示词 / 编辑冲突检测等读取用）
export function pointEventLines(raw) {
    const src = String(raw || '');
    const m = src.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const inner = (m ? m[1] : src).replace(/<!--[\s\S]*?-->/g, '');
    return inner.split('\n').map(l => l.trim()).filter(l => /^Event\s*:/i.test(l));
}

// 点 → 编号列表（编辑冲突检测 / 提示词辅助）
export function numberedPointList(raw) {
    const TYPE_LABEL = { user: '用户线', char: '角色线', main: '明线', hidden: '暗线', bond: '红线' };
    return pointEventLines(raw).map((l, i) => {
        const [type, title, desc, time, location, dynamic] = l.replace(/^Event\s*:\s*/i, '').split('|').map(s => s.trim());
        const bits = [`#${i + 1}`, `【${TYPE_LABEL[(type || '').toLowerCase()] || type || '?'}】`, title || '(未命名)'];
        if (time)     bits.push(`｜时间:${time}`);
        if (location) bits.push(`｜地点:${location}`);
        if (desc)     bits.push(`｜${desc}`);
        if (dynamic)  bits.push(`｜线头:${dynamic}`);
        return bits.join(' ');
    }).join('\n');
}

// <calendar_widget> 文本 → {days, future, startDate}（days 已过滤空天；future 可为 null）
export function parseCalendar(raw) {
    const m = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    // Strip HTML comments across the whole widget body before splitting into lines.
    // LLM often emits multi-line <!-- 日程思考: ... --> blocks; per-line startsWith
    // would only skip the first line and treat the rest as content.
    const content = (m ? m[1] : raw).replace(/<!--[\s\S]*?-->/g, '');

    const dateMatch = content.match(/^StartDate:\s*(\d{4}-\d{2}-\d{2})/m);
    let startDate = null;
    if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) startDate = d;
    }

    const days = []; let cur = null; let inFuture = false; let future = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/^Day\s*:?\s*\d+/i.test(t) || /^第[一二三四五六七\d]+天/.test(t)) {
            if (cur && !inFuture) days.push(cur);
            // 日头可带天气：Day: N|天气|温度（旧数据无管道段 → 天气/温度为空，退化为旧行为）
            const dayParts = t.split('|').slice(1).map(s => s.trim());
            cur = { events: [], weather: dayParts[0] || '', temp: dayParts[1] || '' };
            inFuture = false; continue;
        }
        if (/^Future\s*:/i.test(t) || /^未来\s*:/i.test(t)) {
            if (cur && !inFuture) days.push(cur);
            future = { events: [] }; cur = future; inFuture = true; continue;
        }
        if (/^Event\s*:/i.test(t)) {
            if (!cur) cur = { events: [] };
            const parts = t.replace(/^Event\s*:\s*/i, '').split('|');
            if (parts.length >= 4) cur.events.push({
                type: (parts[0]||'user').trim().toLowerCase(), title: (parts[1]||'').trim(),
                desc: (parts[2]||'').trim(), time: (parts[3]||'').trim(),
                location: (parts[4]||'').trim(), npcAction: (parts[5]||'').trim(),
                pin: (parts[6]||'').trim().toLowerCase() === 'true',   // F5：pin 存 raw 第7段（AI 只出前6段→false），机制对齐线
            });
        }
    }
    if (cur && !inFuture) days.push(cur);
    return { days: days.filter(d => d.events.length > 0), future, startDate };
}

// ─── 点·锁定（F5，机制对齐「线」）──────────────────────────────────────────────
// 点是 AI 每轮从零重写的 raw 文本、事件无 id，故照抄线：身份认 title（如线认 name），
// pin 直接写进 raw（Event 行第 7 段），重算时 mergePinnedPoints(oldRaw, aiRaw) 从旧 raw
// 读锁定项、按 title 回并到新 raw——与 mergePinnedLines 完全对称。历因是稳定结构化存储
//（条目不被整段重写）用真 id 存 pin，天然不同，故不在此列。
export function samePoint(a, b) {
    if (!a || !b) return false;
    const ta = String(a.title || '').trim();
    const tb = String(b.title || '').trim();
    return !!ta && ta === tb;
}

// Event 行序列化：type|title|desc|time|location|npcAction|pin。pin 是第 7 段（AI 只出前 6
// 段→解析为 false；仅本函数在用户手动锁定 / 回并后写出 true），与线 linesToRaw 写 pin 同理。
export function pointEventToRawLine(ev) {
    return `Event: ${ev.type || 'main'}|${ev.title || ''}|${ev.desc || ''}|${ev.time || ''}|${ev.location || ''}|${ev.npcAction || ''}|${ev.pin ? 'true' : 'false'}`;
}

// {days, future, startDate} → 规范 <calendar_widget> 文本（锁定回并 / 手动切换后重序列化用）。
export function serializeCalendar(days, future, startDate) {
    const out = ['<calendar_widget>'];
    if (startDate instanceof Date && !isNaN(startDate)) {
        const y  = startDate.getFullYear();
        const mo = String(startDate.getMonth() + 1).padStart(2, '0');
        const da = String(startDate.getDate()).padStart(2, '0');
        out.push(`StartDate: ${y}-${mo}-${da}`);
    }
    (days || []).forEach((d, i) => {
        // 天气随日头走回 raw：Day: N|天气|温度。缺则退回纯 Day: N（旧行为），mergePinnedPoints 才不会丢天气。
        const w  = String(d.weather || '').trim();
        const tp = String(d.temp || '').trim();
        out.push((w || tp) ? `Day: ${i + 1}|${w}|${tp}` : `Day: ${i + 1}`);
        for (const ev of (d.events || [])) out.push(pointEventToRawLine(ev));
    });
    if (future && Array.isArray(future.events) && future.events.length) {
        out.push('Future:');
        for (const ev of future.events) out.push(pointEventToRawLine(ev));
    }
    out.push('</calendar_widget>');
    return out.join('\n');
}

// C·点永远从「今天」起排：固定闰年做基准，只借它的月/日与周几——年份在楼内点条 / 面板都不渲染
// （_buildScheduleBlockHtml 只显示 月/日/周几），故 2024 对用户不可见，纯为拿到确定的周几与闰日 2/29。
export const POINT_ANCHOR_YEAR = 2024;

// 把点的 StartDate 强钉到给定 month/day，保留天数 / 天气 / 事件 / 锁定——让点整体平移到「今天」。
export function forceStartDate(raw, month, day) {
    const { days, future } = parseCalendar(raw);
    return serializeCalendar(days, future, new Date(POINT_ANCHOR_YEAR, month - 1, day));
}

// 合并锁定（对齐 mergePinnedLines(oldRaw, aiRaw)）：从旧 raw 读出被锁事件（连同原所在天），
// 按 title 在 AI 新 raw 里找——找到就重标 pin（采纳 AI 的推进）；AI 删了就按旧位置就近补回
// （future/越界 → 未来块或最后一天）。有锁定项即重新序列化（把 pin 落回 raw），无则原样返回。
export function mergePinnedPoints(oldRaw, aiRaw) {
    const oldParsed = parseCalendar(oldRaw);
    const oldPinned = [];
    oldParsed.days.forEach((d, i) => d.events.forEach(ev => { if (ev.pin) oldPinned.push({ ev, dayIndex: i }); }));
    if (oldParsed.future) oldParsed.future.events.forEach(ev => { if (ev.pin) oldPinned.push({ ev, dayIndex: 'future' }); });
    if (!oldPinned.length) return aiRaw;

    const parsed = parseCalendar(aiRaw);
    const all = [];
    for (const d of parsed.days) for (const ev of d.events) all.push(ev);
    if (parsed.future) for (const ev of parsed.future.events) all.push(ev);
    const used = new Set();

    for (const p of oldPinned) {
        const hitIndex = all.findIndex((ev, idx) => !used.has(idx) && samePoint(ev, p.ev));
        if (hitIndex >= 0) {
            all[hitIndex].pin = true;
            used.add(hitIndex);
            continue;
        }   // AI 保留 → 采纳推进，重标 pin；同名多锁点按“逐个消耗匹配”保留，不再反复命中同一条
        const clone = { ...p.ev, pin: true };     // AI 删了 → 原样并回（保命）
        if (p.dayIndex === 'future' || !Number.isInteger(p.dayIndex) || p.dayIndex >= parsed.days.length) {
            if (parsed.future) parsed.future.events.push(clone);
            else if (parsed.days.length) parsed.days[parsed.days.length - 1].events.push(clone);
            else parsed.days.push({ events: [clone] });
        } else if (p.dayIndex >= 0) {
            parsed.days[p.dayIndex].events.push(clone);
        } else if (parsed.days.length) {
            parsed.days[0].events.push(clone);
        } else {
            parsed.days.push({ events: [clone] });
        }
    }
    return serializeCalendar(parsed.days, parsed.future, parsed.startDate);
}

// 单个点 → 注入参考文本（注入卡 / 楼内块抽屉用）
export function buildPointInjectText(ev, weather = '', temp = '', dateLabel = '') {
    const w  = String(weather || '').trim();
    const tp = String(temp || '').trim();
    const dl = String(dateLabel || '').trim();
    const parts = ['【点参考】'];
    if (dl)           parts.push(`日期：${dl}`);
    if (w || tp)      parts.push(`天气：${w}${tp ? ' ' + tp : ''}`);
    if (ev.time)      parts.push(`时间：${ev.time}`);
    parts.push(ev.title);
    if (ev.desc)      parts.push(ev.desc);
    if (ev.location)  parts.push(`地点：${ev.location}`);
    if (ev.npcAction) parts.push(`线头：${ev.npcAction}`);
    return parts.join('\n');
}
