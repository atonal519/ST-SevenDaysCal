// ─── 点（日程）域 · 文本 codec / 存取辅助（纯函数，零跨域依赖）────────────────────
// 从 index.js 机械搬移。全部为 <calendar_widget> 点日程结构的文本↔对象互转与读写辅助，
// 无 DOM / store / 历法(axis) 依赖。渲染层（renderSchedule 等）见 ./render.js，生成 prompt 见 ./prompt.js。
import { calendarDate, formatCalendarDate, isGregorian, parseCalendarDate, validateCalendarDate } from '../calendar/date.js';
import { stripRecordWrappers } from '../utils/record-wrappers.js';
import { normalizePointAdultMode, parsePointAdultProof, pointTicketPlan, verifyPointAdultContent, verifyPointAdultProof } from './adult.js';

const cleanPointLine = value => {
    let text = String(value || '').trim();
    if (/^[|｜].*[|｜]$/.test(text)) text = text.slice(1, -1).trim();
    return text.replace(/^[>#*\-\s]+/, '').replace(/\*+/g, '').trim();
};
const pointFieldValue = (value, name) => String(value || '').replace(new RegExp(`^${name}\\s*[:：]\\s*`, 'i'), '').trim();
const pointAnchorKind = value => {
    const text = cleanPointLine(value);
    if (pointDayHeading(text) || /^(?:Future|未来)\s*[:：]/i.test(text)) return 'context';
    if (/^Event\s*[:：]/i.test(text)) return 'event';
    return /^(?:StartDate|Ticket|AdultProof|Adult)\s*[:：]/i.test(text) ? 'field' : null;
};
const completePointStructure = kinds => kinds.includes('context') || kinds.includes('event');
const normalizePointType = value => {
    const text = String(value || '').trim().toLowerCase();
    if (['main', 'hidden', 'bond', 'user', 'char'].includes(text)) return text;
    if (/暗|隐藏|伏笔/.test(text)) return 'hidden';
    if (/红|关系|情感|羁绊/.test(text)) return 'bond';
    return 'main';
};
export const isCompletePointEvent = event => Boolean(
    event
    && String(event.title || '').trim()
    && String(event.desc || '').trim()
    && String(event.time || '').trim()
    && String(event.location || '').trim()
);

function pointDayHeading(value) {
    const text = String(value || '').trim();
    if (!/^(?:Day\b|第[^\s|｜]{1,8}天)/i.test(text)) return null;
    const match = /^(?:Day\s*[:：]?\s*(\d+)|第([一二三四五六七]|\d+)天)/i.exec(text);
    const chineseDay = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
    const dayNumber = match ? Number(match[1] || chineseDay[match[2]] || match[2]) : NaN;
    return { dayNumber: Number.isInteger(dayNumber) && dayNumber > 0 ? dayNumber : null };
}

export function parsePointEventRecord(text) {
    const source = stripRecordWrappers(text, pointAnchorKind, completePointStructure);
    const lines = source.split('\n').map(cleanPointLine);
    const adult = lines.some(line => /^Adult\s*[:：]\s*true\s*$/i.test(line));
    const ticketId = lines.find(line => /^Ticket\s*[:：]/i.test(line))?.match(/^Ticket\s*[:：]\s*(POINT-TICKET-\d+)\s*$/i)?.[1]?.toUpperCase() || undefined;
    const proof = lines.find(line => /^AdultProof\s*[:：]/i.test(line));
    const parts = pointFieldValue(lines.filter(line => !/^(?:Adult|Ticket|AdultProof)\s*[:：]/i.test(line)).join('\n'), 'Event').split(/[|｜]/).map(s => s.trim());
    if (parts.length < 4 || !parts[1]) return null;
    const tail = parts.slice(5);
    const hasPin = tail.length > 0 && /^(?:true|false|是|否)$/i.test(tail[tail.length - 1]);
    return {
        type: normalizePointType(parts[0]), title: parts[1] || '', desc: parts[2] || '', time: parts[3] || '',
        location: parts[4] || '', npcAction: tail.slice(0, hasPin ? -1 : undefined).join('|'),
        pin: hasPin && /^(?:true|是)$/i.test(tail[tail.length - 1]),
        adult,
        ...(proof ? { adultProof: parsePointAdultProof(proof) } : {}),
        ...(ticketId ? { ticketId } : {}),
    };
}

function bufferedPointEventLines(inner) {
    return pointEventBlocksFromInner(inner).map(block => block.map(line => line.trim()).filter(Boolean).join(' '));
}

function pointEventBlocksFromInner(inner) {
    const out = [];
    let buffer = [];
    const flush = () => { if (buffer.length) out.push(buffer); buffer = []; };
    for (const rawLine of stripRecordWrappers(inner, pointAnchorKind, completePointStructure).split('\n')) {
        const line = cleanPointLine(rawLine);
        if (/^Event\s*[:：]/i.test(line)) { flush(); buffer = [line]; continue; }
        if (/^(?:Day\s*[:：]?\s*\d+|第[一二三四五六七\d]+天|Future\s*[:：]|未来\s*[:：]|<\/(?:calendar|schedule)_widget>)/i.test(line)) { flush(); continue; }
        if (buffer.length) buffer.push(line);
    }
    flush();
    return out;
}

function generatedPointEventRecordsFromInner(inner) {
    const out = [];
    let block = [];
    let hasContext = false;
    let blockHasContext = false;
    const flush = () => {
        if (block.length) out.push({ block, hasContext: blockHasContext });
        block = [];
    };
    for (const rawLine of stripRecordWrappers(inner, pointAnchorKind, completePointStructure).split('\n')) {
        const line = cleanPointLine(rawLine);
        const day = pointDayHeading(line);
        if (day) { flush(); hasContext = day.dayNumber != null; continue; }
        if (/^(?:Future|未来)\s*[:：]/i.test(line)) { flush(); hasContext = true; continue; }
        if (/^Event\s*[:：]/i.test(line)) { flush(); block = [line]; blockHasContext = hasContext; continue; }
        if (/^<\/(?:calendar|schedule)_widget>/i.test(line)) { flush(); hasContext = false; continue; }
        if (block.length) block.push(line);
    }
    flush();
    return out;
}

// 从间的 schedule_widget body 提取第一条完整 Event（含所有续行）。
export function firstPointEventBlock(raw) {
    const src = String(raw || '');
    const m = src.match(/<schedule_widget[^>]*>([\s\S]*?)<\/schedule_widget>/i);
    const inner = m ? m[1] : src;
    const block = pointEventBlocksFromInner(inner)[0];
    if (!block) return null;
    const text = block.join('\n').trim();
    return parsePointEventRecord(text) ? text : null;
}

// 用与解析器完全相同的 Event 边界替换整块，避免旧续行残留。
export function replacePointEventBlock(raw, idx0, newEventText) {
    const src = String(raw || '');
    const m = src.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const inner = m ? m[1] : src;
    const lines = inner.split('\n');
    let blocks = [], current = null;
    const flush = end => { if (current) { current.end = end; blocks.push(current); current = null; } };
    lines.forEach((line, index) => {
        const t = cleanPointLine(line);
        if (/^Event\s*:/i.test(t)) { flush(index); current = { start: index, end: index + 1 }; return; }
        if (/^(?:Day\s*:?\s*\d+|第[一二三四五六七\d]+天|Future\s*:|未来\s*:|<\/(?:calendar|schedule)_widget>)/i.test(t)) { flush(index); return; }
        if (current) current.end = index + 1;
    });
    flush(lines.length);
    const block = blocks[idx0];
    if (!block) return null;
    const indent = (lines[block.start].match(/^\s*/) || [''])[0];
    const originalMetadata = lines.slice(block.start + 1, block.end).filter(line => /^\s*Adult\s*:\s*true\s*$/i.test(line));
    const originalEvent = parsePointEventRecord(lines[block.start]);
    const replacement = String(newEventText || '').split('\n').map((line, i) => {
        if (i || !/^\s*Event\s*:/i.test(line) || !originalEvent?.pin) return i ? line : indent + line.trim();
        const clean = line.trim().replace(/^Event\s*:\s*/i, '');
        return `${indent}Event: ${clean}|true`;
    });
    if (originalMetadata.length && !replacement.some(line => /^\s*Adult\s*:/i.test(line))) replacement.push(...originalMetadata);
    lines.splice(block.start, block.end - block.start, ...replacement);
    const newInner = lines.join('\n');
    return m ? src.replace(m[0], m[0].replace(m[1], newInner)) : newInner;
}

// 点 Event 行 → 逻辑记录文本（供提示词 / 编辑冲突等读取，兼容字段折行）
export function pointEventLines(raw) {
    const src = String(raw || '');
    const m = src.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const inner = (m ? m[1] : src).replace(/<!--[\s\S]*?-->/g, '');
    return bufferedPointEventLines(inner);
}

// 点 → 编号列表（编辑冲突检测 / 提示词辅助）
export function numberedPointList(raw) {
    const TYPE_LABEL = { user: '用户线', char: '角色线', main: '明线', hidden: '暗线', bond: '红线' };
    const parsed = parseCalendar(String(raw || ''));
    const events = [...(parsed.days || []).flatMap(day => day.events || []), ...(parsed.future?.events || [])];
    return events.map((event, i) => {
        const { type, title, desc, time, location, npcAction: dynamic } = event;
        const bits = [`#${i + 1}`, `【${TYPE_LABEL[(type || '').toLowerCase()] || type || '?'}】`, title || '(未命名)'];
        if (event.adult) bits.push('【成人】');
        if (time)     bits.push(`｜时间:${time}`);
        if (location) bits.push(`｜地点:${location}`);
        if (desc)     bits.push(`｜${desc}`);
        if (dynamic)  bits.push(`｜线头:${dynamic}`);
        return bits.join(' ');
    }).join('\n');
}

// <calendar_widget> 文本 → {days, future, startDate}（days 已过滤空天；future 可为 null）
export function parseCalendar(raw, calendar = null) {
    const m = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    // Strip HTML comments across the whole widget body before splitting into lines.
    // LLM often emits multi-line <!-- 日程思考: ... --> blocks; per-line startsWith
    // would only skip the first line and treat the rest as content.
    const content = stripRecordWrappers((m ? m[1] : raw).replace(/<!--[\s\S]*?-->/g, ''), pointAnchorKind, completePointStructure);

    const dateMatch = content.match(/^StartDate:\s*((?:\d{4}|null)-\d{1,2}-\d{1,2})/m);
    let startDate = null;
    if (dateMatch) {
        const parsedDate = parseCalendarDate(dateMatch[1], calendar) || (Number(dateMatch[1].slice(5, 7)) > 12 ? calendarDate(+dateMatch[1].slice(0, 4), +dateMatch[1].slice(5, 7), +dateMatch[1].slice(8, 10)) : null);
        if (parsedDate && isGregorian(calendar)) {
            const d = new Date(0); d.setHours(0, 0, 0, 0); d.setFullYear(parsedDate.year, parsedDate.month - 1, parsedDate.day);
            if (d.getFullYear() === parsedDate.year && d.getMonth() === parsedDate.month - 1 && d.getDate() === parsedDate.day) startDate = d;
        } else if (parsedDate && validateCalendarDate(parsedDate, calendar)) startDate = parsedDate;
    }

    const days = []; let cur = null; let inFuture = false; let future = null; let eventBuffer = ''; let eventMeta = null; let proofEligible = false;
    const flushEvent = () => {
        if (!eventBuffer || !cur) { eventBuffer = ''; return; }
        const ev = parsePointEventRecord(eventBuffer);
        if (ev) cur.events.push(Object.assign(ev, eventMeta || {}));
        eventBuffer = '';
        eventMeta = null;
    };
    for (const line of content.split('\n')) {
        const t = cleanPointLine(line);
        if (!t) continue;
        if (/^```/.test(t)) continue;
        if (eventBuffer && !/^Ticket\s*[:：]/i.test(t) && !/^AdultProof\s*[:：]/i.test(t)) proofEligible = false;
        const dayHeader = pointDayHeading(t);
        if (dayHeader) {
            flushEvent();
            if (cur && !inFuture) days.push(cur);
            // 日头可带天气：Day: N|天气|温度（旧数据无管道段 → 天气/温度为空，退化为旧行为）
            const dayParts = t.split(/[|｜]/).slice(1).map(s => s.trim());
            cur = dayHeader.dayNumber == null ? null : { dayNumber: dayHeader.dayNumber, events: [], weather: dayParts[0] || '', temp: dayParts[1] || '' };
            inFuture = false; continue;
        }
        if (/^Future\s*[:：]/i.test(t) || /^未来\s*[:：]/i.test(t)) {
            flushEvent();
            if (cur && !inFuture) days.push(cur);
            future = { events: [] }; cur = future; inFuture = true; continue;
        }
        if (/^Event\s*[:：]/i.test(t)) {
            flushEvent();
            if (!cur) { eventMeta = null; proofEligible = false; continue; }
            eventBuffer = t;
            eventMeta = {};
            proofEligible = false;
            continue;
        }
        if (eventBuffer && /^Adult\s*[:：]\s*true\s*$/i.test(t)) { eventMeta.adult = true; continue; }
        if (eventBuffer && /^Adult\s*[:：]\s*false\s*$/i.test(t)) { eventMeta.adult = false; continue; }
        if (eventBuffer && /^Ticket\s*[:：]\s*(POINT-TICKET-\d+)\s*$/i.test(t)) { eventMeta.ticketId = t.match(/^Ticket\s*[:：]\s*(POINT-TICKET-\d+)\s*$/i)[1].toUpperCase(); proofEligible = true; continue; }
        if (eventBuffer && /^AdultProof\s*[:：]/i.test(t)) { if (proofEligible) eventMeta.adultProof = parsePointAdultProof(t.replace(/^AdultProof\s*：/i, 'AdultProof:')); proofEligible = false; continue; }
        if (eventBuffer) eventBuffer += ` ${t}`;
    }
    flushEvent();
    if (cur && !inFuture) days.push(cur);
    return { days: days.filter(d => d.events.length > 0), allDays: days, future, startDate, startDateToken: dateMatch?.[1] || null };
}

// 生成响应写入前的结构闸门：数量是建议，结构与核心事件才是硬门槛。
// 这是原始模型响应的业务闸门；没有完整事件时，锁定回并也不能替模型凭空补内容。
export function validateGeneratedCalendar(raw, calendar = null, options = {}) {
    const text = String(raw || '');
    const widget = text.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const eventRecords = widget ? generatedPointEventRecordsFromInner(widget[1]) : [];
    const validEventRecords = eventRecords.map(record => ({ ...record, event: parsePointEventRecord(record.block.join('\n')) }))
        .filter(record => record.hasContext && isCompletePointEvent(record.event));
    const strictEvents = validEventRecords.length > 0;
    const parsed = parseCalendar(text, calendar);
    const coreDays = (parsed.allDays || parsed.days).filter(day => [1, 2, 3].includes(day.dayNumber));
    const counts = new Map([1, 2, 3].map(n => [n, coreDays.filter(x => x.dayNumber === n).length]));
    const dayMarkers = [1, 2, 3].every(n => counts.get(n) === 1)
        && coreDays.map(day => day.dayNumber).join(',') === '1,2,3'
        && coreDays.every(day => day.events.length > 0);
    const hasClosing = /<\/calendar_widget\s*>/i.test(text);
    const hasFuture = /(?:^|\n)\s*(?:Future\s*[:：]|未来\s*[:：])/im.test(text);
    const validFutureEvents = parsed.future?.events?.filter(ev => ev && ev.title).length || 0;
    const dayMissing = [1, 2, 3].find(n => !counts.get(n));
    const dayDuplicate = [1, 2, 3].find(n => counts.get(n) > 1);
    const dayEmpty = coreDays.find(day => [1, 2, 3].includes(day.dayNumber) && !day.events.length);
    const reason = !hasClosing ? 'missing-closing-tag' : !widget ? 'missing-widget' : !strictEvents ? 'invalid-event-fields' : null;
    if (!reason && options.generated) {
        if (normalizePointAdultMode(options.adultMode) !== 'off') {
            const pinnedTitles = new Map();
            for (const event of (options.pinned || [])) { const title = String(event?.title || '').trim(); if (title) pinnedTitles.set(title, (pinnedTitles.get(title) || 0) + 1); }
            const tickets = [];
            const usedTickets = new Set();
            const ticketPlan = new Map(pointTicketPlan(options.adultMode, 14).map(ticket => [ticket.id, ticket]));
            for (const { block, event } of validEventRecords) {
                const title = String(event.title || '').trim();
                const ticketFields = block.filter(value => /^Ticket\s*[:：]/i.test(String(value).trim()));
                const available = pinnedTitles.get(title) || 0;
                if (available > 0) {
                    pinnedTitles.set(title, available - 1);
                    if (ticketFields.length) return { ok: false, code: 'invalid-point-tickets', reason: 'invalid-point-tickets', strictEvents, diagnostics: { eventCount: eventRecords.length, tickets } };
                    continue;
                }
                if (ticketFields.length !== 1) return { ok: false, code: 'invalid-point-tickets', reason: 'invalid-point-tickets', strictEvents, diagnostics: { eventCount: eventRecords.length, tickets } };
                const ticket = ticketFields[0].match(/^Ticket\s*[:：]\s*(POINT-TICKET-\d+)\s*$/i)?.[1]?.toUpperCase();
                if (!ticketPlan.has(ticket) || usedTickets.has(ticket)) return { ok: false, code: 'invalid-point-tickets', reason: 'invalid-point-tickets', strictEvents, diagnostics: { eventCount: eventRecords.length, tickets: [...tickets, ticket] } };
                usedTickets.add(ticket);
                tickets.push(ticket);
            }
        }
    }
    return {
        ok: !reason,
        code: reason,
        reason,
        dayMarkers,
        dayCount: parsed.days.length,
        hasClosing,
        hasFuture,
        futureCount: validFutureEvents,
        strictEvents,
        diagnostics: { eventCount: eventRecords.length, validEventCount: validEventRecords.length, rejectedEventCount: eventRecords.length - validEventRecords.length, dayCounts: Object.fromEntries(counts), futureCount: validFutureEvents, dayMissing, dayDuplicate, dayEmpty: dayEmpty?.dayNumber || null },
    };
}

// 将本轮 Ticket 绑定为本地 Adult 元数据；Ticket 永不进入正式 raw。
export function bindPointAdultTickets(raw, mode = 'off', calendar = null) {
    const normalized = normalizePointAdultMode(mode);
    const text = String(raw || '');
    const parsed = parseCalendar(text, calendar);
    for (const day of parsed.allDays || parsed.days) day.events = (day.events || []).filter(isCompletePointEvent);
    if (parsed.future) parsed.future.events = (parsed.future.events || []).filter(isCompletePointEvent);
    const events = [];
    for (const day of parsed.allDays || parsed.days) events.push(...(day.events || []));
    if (parsed.future) events.push(...(parsed.future.events || []));
    const ticketed = events.filter(event => event.ticketId);
    const plan = normalized === 'off' ? [] : pointTicketPlan(normalized, 14);
    const planById = new Map(plan.map(ticket => [ticket.id, ticket]));
    const seenTicketIds = new Set();
    if (normalized !== 'off') {
        for (const event of ticketed) {
            if (!planById.has(event.ticketId) || seenTicketIds.has(event.ticketId)) throw new Error('点成人票无效或重复');
            seenTicketIds.add(event.ticketId);
        }
    }
    const tickets = new Map(ticketed.map(event => [event, planById.get(event.ticketId)]));
    events.forEach(event => {
        const ticket = tickets.get(event);
        const trustedNsfwTicket = Boolean(ticket?.adult);
        event.pin = false;
        // Adult 只由本地票据与正文核验得出；忽略模型自报的 Adult，同时保留旧有正文识别兼容。
        event.adult = Boolean(trustedNsfwTicket || verifyPointAdultProof(event, event.adultProof) || verifyPointAdultContent(event));
        delete event.ticketId;
        delete event.adultProof;
    });
    return serializeCalendar(parsed.allDays || parsed.days, parsed.future, parsed.startDate, calendar, parsed.startDateToken);
}

export function stripPointAdultMetadata(raw) {
    return String(raw || '').replace(/^\s*Adult\s*:\s*(?:true|false)\s*\r?\n?/gim, '');
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
    const line = `Event: ${ev.type || 'main'}|${ev.title || ''}|${ev.desc || ''}|${ev.time || ''}|${ev.location || ''}|${ev.npcAction || ''}|${ev.pin ? 'true' : 'false'}`;
    return ev.adult ? `${line}\nAdult: true` : line;
}

// {days, future, startDate} → 规范 <calendar_widget> 文本（锁定回并 / 手动切换后重序列化用）。
export function serializeCalendar(days, future, startDate, calendar = null, startDateToken = null) {
    const out = ['<calendar_widget>'];
    if (startDate instanceof Date && !isNaN(startDate)) {
        const y  = startDate.getFullYear();
        const mo = String(startDate.getMonth() + 1).padStart(2, '0');
        const da = String(startDate.getDate()).padStart(2, '0');
        out.push(`StartDate: ${y}-${mo}-${da}`);
    } else if (startDate && formatCalendarDate(startDate)) {
        out.push(`StartDate: ${formatCalendarDate(startDate)}`);
    } else if (typeof startDateToken === 'string' && startDateToken.trim()) {
        out.push(`StartDate: ${startDateToken.trim()}`);
    }
    (days || []).forEach((d, i) => {
        // 天气随日头走回 raw：Day: N|天气|温度。缺则退回纯 Day: N（旧行为），mergePinnedPoints 才不会丢天气。
        const w  = String(d.weather || '').trim();
        const tp = String(d.temp || '').trim();
        const dayNumber = Number.isInteger(d.dayNumber) ? d.dayNumber : i + 1;
        out.push((w || tp) ? `Day: ${dayNumber}|${w}|${tp}` : `Day: ${dayNumber}`);
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
export function forceStartDate(raw, month, day, calendar = null) {
    const { days, allDays, future } = parseCalendar(raw, calendar);
    const startDate = isGregorian(calendar) ? new Date(POINT_ANCHOR_YEAR, month - 1, day) : calendarDate(null, month, day);
    return serializeCalendar(allDays || days, future, startDate, calendar);
}

// 合并锁定（对齐 mergePinnedLines(oldRaw, aiRaw)）：从旧 raw 读出被锁事件（连同原所在天），
// 按 title 在 AI 新 raw 里找——找到就重标 pin（采纳 AI 的推进）；AI 删了就按旧位置就近补回
// （future/越界 → 未来块或最后一天）。有锁定项即重新序列化（把 pin 落回 raw），无则原样返回。
export function mergePinnedPoints(oldRaw, aiRaw, calendar = null) {
    const oldParsed = parseCalendar(oldRaw, calendar);
    const oldPinned = [];
    (oldParsed.allDays || oldParsed.days).forEach((d, i) => d.events.forEach(ev => { if (ev.pin) oldPinned.push({ ev, dayIndex: i }); }));
    if (oldParsed.future) oldParsed.future.events.forEach(ev => { if (ev.pin) oldPinned.push({ ev, dayIndex: 'future' }); });
    if (!oldPinned.length) return aiRaw;

    const parsed = parseCalendar(aiRaw, calendar);
    const targetDays = parsed.allDays || parsed.days;
    const all = [];
    for (const d of parsed.days) for (const ev of d.events) all.push(ev);
    if (parsed.future) for (const ev of parsed.future.events) all.push(ev);
    const used = new Set();

    for (const p of oldPinned) {
        const hitIndex = all.findIndex((ev, idx) => !used.has(idx) && samePoint(ev, p.ev));
        if (hitIndex >= 0) {
            all[hitIndex].pin = true;
            all[hitIndex].adult = Boolean(p.ev.adult || all[hitIndex].adult);
            used.add(hitIndex);
            continue;
        }   // AI 保留 → 采纳推进，重标 pin；同名多锁点按“逐个消耗匹配”保留，不再反复命中同一条
        const clone = { ...p.ev, pin: true };     // AI 删了 → 原样并回（保命）
        if (p.dayIndex === 'future' || !Number.isInteger(p.dayIndex) || p.dayIndex >= targetDays.length) {
            if (parsed.future) parsed.future.events.push(clone);
            else if (targetDays.length) targetDays[targetDays.length - 1].events.push(clone);
            else targetDays.push({ events: [clone] });
        } else if (p.dayIndex >= 0) {
            targetDays[p.dayIndex].events.push(clone);
        } else if (targetDays.length) {
            targetDays[0].events.push(clone);
        } else {
            targetDays.push({ events: [clone] });
        }
    }
    return serializeCalendar(targetDays, parsed.future, parsed.startDate, calendar, parsed.startDateToken);
}

// 单个点 → 注入参考文本（注入卡 / 楼内块抽屉用）
export function buildPointInjectText(ev, weather = '', temp = '', dateLabel = '') {
    const w  = String(weather || '').trim();
    const tp = String(temp || '').trim();
    const dl = String(dateLabel || '').trim();
    const parts = [ev?.adult ? '【成人点参考】' : '【点参考】'];
    if (dl)           parts.push(`日期：${dl}`);
    if (w || tp)      parts.push(`天气：${w}${tp ? ' ' + tp : ''}`);
    if (ev.time)      parts.push(`时间：${ev.time}`);
    parts.push(ev.title);
    if (ev.desc)      parts.push(ev.desc);
    if (ev.location)  parts.push(`地点：${ev.location}`);
    if (ev.npcAction) parts.push(`线头：${ev.npcAction}`);
    return parts.join('\n');
}
