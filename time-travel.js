export const TIME_TRAVEL_MARKER = '【时间变更】';
export const TIME_TRAVEL_BLOCK_OPEN = '<time-change>';
export const TIME_TRAVEL_BLOCK_CLOSE = '</time-change>';

// 栈式配对让残缺外层中的完整内层仍能独立识别；未配对标签一律保留为用户文本。
export function findTimeTravelBlocks(value) {
    const text = String(value ?? '');
    const stack = [];
    const ranges = [];
    let cursor = 0;
    while (cursor < text.length) {
        const openAt = text.indexOf(TIME_TRAVEL_BLOCK_OPEN, cursor);
        const closeAt = text.indexOf(TIME_TRAVEL_BLOCK_CLOSE, cursor);
        if (openAt < 0 && closeAt < 0) break;
        if (openAt >= 0 && (closeAt < 0 || openAt < closeAt)) {
            stack.push(openAt);
            cursor = openAt + TIME_TRAVEL_BLOCK_OPEN.length;
            continue;
        }
        const start = stack.pop();
        const end = closeAt + TIME_TRAVEL_BLOCK_CLOSE.length;
        if (Number.isInteger(start)) ranges.push({ start, end });
        cursor = end;
    }
    return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function hasTimeTravelBlock(value) {
    return findTimeTravelBlocks(value).length > 0;
}

export function removeTimeTravelBlocks(value) {
    const text = String(value ?? '');
    const ranges = findTimeTravelBlocks(text);
    if (!ranges.length) return text;
    const merged = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
    }
    let result = '';
    let cursor = 0;
    for (const range of merged) {
        result += text.slice(cursor, range.start);
        cursor = range.end;
    }
    return result + text.slice(cursor);
}

export const TIME_TRAVEL_DIRECTION_OPTIONS = Object.freeze([
    Object.freeze({ value: 'none', label: '不指定', prompt: '' }),
    Object.freeze({ value: 'daily', label: '日常', prompt: '日常' }),
    Object.freeze({ value: 'growth', label: '成长', prompt: '成长' }),
    Object.freeze({ value: 'sweet', label: '甜向', prompt: '甜向' }),
    Object.freeze({ value: 'angst', label: '虐向', prompt: '虐向' }),
    Object.freeze({ value: 'custom', label: '自定义', prompt: '', custom: true }),
]);

function cleanDate(value) {
    const month = Number(value?.month);
    const day = Number(value?.day);
    if (!Number.isInteger(month) || month < 1 || !Number.isInteger(day) || day < 1) return null;
    return { month, day };
}

export function sameMonthDay(a, b) {
    const left = cleanDate(a);
    const right = cleanDate(b);
    return !!left && !!right && left.month === right.month && left.day === right.day;
}

export function formatTravelDate(date, calendar) {
    const md = cleanDate(date);
    if (!md) return '';
    const name = String(calendar?.months?.[md.month - 1]?.name || `${md.month}月`).trim() || `${md.month}月`;
    const month = name === `${md.month}月` ? name : `${name}（第${md.month}月）`;
    return `${month}${md.day}日`;
}

// 纪念日的跨月、跨年覆盖与区间位置仍由历模块提供的既有算法判断；本模块只整理正文需要的字段。
export function collectTravelAnniversaries(items, targetDate, calendar, resolveCoverage, resolveTypeLabel) {
    const md = cleanDate(targetDate);
    if (!md || !Array.isArray(items) || typeof resolveCoverage !== 'function' || typeof resolveTypeLabel !== 'function') return [];
    return items.map(item => {
        const coverage = resolveCoverage(item, md, calendar);
        if (!coverage) return null;
        const startDate = cleanDate(coverage.startDate || item);
        const endDate = cleanDate(coverage.endDate || item);
        const days = Math.max(1, Number.parseInt(coverage.days ?? item?.days, 10) || 1);
        const dayIndex = Math.min(days, Math.max(1, Number.parseInt(coverage.dayIndex, 10) || 1));
        return {
            name: String(item?.name || '').trim(),
            type: String(resolveTypeLabel(item?.type, item) || '').trim(),
            days,
            dayIndex,
            startDate,
            endDate,
            displayDate: String(item?.displayDate || '').trim(),
            note: String(item?.note || '').trim(),
        };
    }).filter(item => item?.name && item.startDate && item.endDate);
}

export function buildTravelAnniversaryText(item, calendar, weekday = '') {
    const start = formatTravelDate(item?.startDate, calendar);
    const end = formatTravelDate(item?.endDate, calendar);
    const days = Math.max(1, Number.parseInt(item?.days, 10) || 1);
    const dayIndex = Math.min(days, Math.max(1, Number.parseInt(item?.dayIndex, 10) || 1));
    const details = [String(item?.type || '').trim()].filter(Boolean);
    const displayDate = String(item?.displayDate || '').trim();
    if (displayDate) details.push(displayDate);
    if (String(weekday || '').trim()) details.push(String(weekday).trim());
    if (days > 1) {
        details.push(`起始 ${start}`, `结束 ${end}`, `持续 ${days} 天`, `目标日是第 ${dayIndex} 天`);
    }
    const note = String(item?.note || '').trim();
    return `${String(item?.name || '').trim()}（${details.join('，')}）${note ? `：${note}` : ''}`;
}

export function buildTravelNarrativeInstruction({ linesInjected = false, outlineInjected = false, ledgerInjected = false } = {}) {
    const instructions = [
        '- 正文主要场景发生在时间终点的日期，时间变化的中间经过如有必要，最多用开头一小段概括，不要从起点开始逐日或分阶段铺写整个时间区间。',
    ];
    const injected = [];
    if (linesInjected) injected.push('暗线');
    if (outlineInjected) injected.push('剧情大纲');
    if (ledgerInjected) injected.push('时间账');
    if (injected.length) {
        instructions.push(`- ${injected.join('、')}的当前状态为位于时间起点或其之前的状态，而非时间终点时的新状态。`);
    }
    return instructions.join('\n');
}

export function buildTravelStoryPrompt({ sourceDate, targetDate, direction = '', anniversaries = [], calendar, targetWeekday = '', injectionState = {} } = {}) {
    const lines = [
        TIME_TRAVEL_BLOCK_OPEN,
        TIME_TRAVEL_MARKER,
        '',
        `时间起点：${formatTravelDate(sourceDate, calendar)}`,
        `时间终点：${formatTravelDate(targetDate, calendar)}`,
    ];
    if (anniversaries.length) {
        lines.push('', '【当天日期】');
        for (const item of anniversaries) {
            lines.push(`- ${buildTravelAnniversaryText(item, calendar, targetWeekday)}`);
        }
    }
    if (String(direction || '').trim()) lines.push('', `剧情方向：${String(direction).trim()}`);
    lines.push('', buildTravelNarrativeInstruction(injectionState));
    lines.push('请结合当前剧情、人物状态和上述日期信息，自然续写时间变更后的剧情。');
    lines.push(TIME_TRAVEL_BLOCK_CLOSE);
    return lines.join('\n');
}

export function buildTravelPromptAddon({ sourceDate, destinationDate, direction = '', calendar } = {}) {
    const lines = [
        '【本次时间变更】',
        `时间起点：${formatTravelDate(sourceDate, calendar)}`,
        `时间终点：${formatTravelDate(destinationDate, calendar)}`,
    ];
    if (String(direction || '').trim()) lines.push(`剧情方向：${String(direction).trim()}`);
    lines.push('', '以上用于说明本次正文的时间范围与剧情方向。');
    return lines.join('\n');
}

export function buildTravelPlanningContext({ outline = [], outlineCursor = 1, lines = [] } = {}) {
    const blocks = [];
    if (Array.isArray(outline) && outline.length) {
        const cursor = Number.isFinite(Number(outlineCursor)) ? Math.floor(Number(outlineCursor)) : 1;
        blocks.push(`【剧情大纲规划】\n${outline.map((beat, index) => {
            const current = index + 1 === cursor ? '（当前节点）' : '';
            const head = `${index + 1}${current}. ${beat?.time ? `${beat.time} · ` : ''}${beat?.title || '未命名节点'}`;
            const details = [beat?.type, beat?.scene, beat?.outcome].filter(Boolean).join('；');
            return `${head}${details ? `\n   ${details}` : ''}`;
        }).join('\n')}`);
    }
    if (Array.isArray(lines) && lines.length) {
        blocks.push(`【事件线参考】\n${lines.map((line, index) => {
            const meta = [line?.type, line?.stage, line?.when, line?.agency, line?.stall ? '停滞中' : '推进中'].filter(Boolean).join(' / ');
            return `${index + 1}. ${line?.name || '未命名事件线'}${meta ? `（${meta}）` : ''}${line?.desc ? `\n   现状：${line.desc}` : ''}${line?.next ? `\n   下一步：${line.next}` : ''}`;
        }).join('\n')}`);
    }
    return blocks.join('\n\n');
}

export function buildTravelDirectionPrompt({ sourceDate, targetDate, anniversaries = [], calendar, targetWeekday = '', preference = '', excluded = [], outline = [], outlineCursor = 1, lines = [] } = {}) {
    const planningBlock = buildTravelPlanningContext({ outline, outlineCursor, lines });
    const planningNames = [];
    if (Array.isArray(outline) && outline.length) planningNames.push('剧情大纲');
    if (Array.isArray(lines) && lines.length) planningNames.push('事件线');
    const planningRule = planningNames.length
        ? `推演方向发生在本次推演任务时间终点的日期。${planningNames.join('和')}的当前状态为位于时间起点或其之前的状态，而非时间终点时的新状态。`
        : '推演方向发生在本次推演任务时间终点的日期。';
    const preferenceText = String(preference || '').trim();
    const preferenceBlock = preferenceText
        ? `用户偏好的推演方向：${preferenceText}`
        : '';
    const excludedBlock = Array.isArray(excluded) && excluded.length
        ? `\n【本次已经展示过的方向】\n${excluded.map((item, index) => `${index + 1}. ${String(item || '').trim()}`).join('\n')}\n新结果不得重复或改写复述以上方向。`
        : '';
    const anniversaryBlock = Array.isArray(anniversaries) && anniversaries.length
        ? `\n【目标日日期】\n${anniversaries.map(item => `- ${buildTravelAnniversaryText(item, calendar, targetWeekday)}`).join('\n')}`
        : '';
    return `请根据当前剧情，为一次时间变化预推演三个差异明确、可直接用于续写的剧情方向。
${planningBlock ? `\n${planningBlock}\n` : ''}
【推演任务】
时间起点：${formatTravelDate(sourceDate, calendar)}
时间终点：${formatTravelDate(targetDate, calendar)}${anniversaryBlock}
${preferenceBlock ? `${preferenceBlock}\n` : ''}${excludedBlock}

【推演规则】
1. ${planningRule}
2. 只为上述时间变化后的日期构思方向，严格输出三个方向，每个方向 40—80 字、一行一个；只说明核心冲突、人物选择和发展可能，不展开完整场景和具体动作，不直接续写正文，不要解释或重复。`;
}

export function parseTravelDirections(raw, excluded = []) {
    const old = new Set((Array.isArray(excluded) ? excluded : []).map(item => String(item || '').trim()).filter(Boolean));
    const seen = new Set();
    const out = [];
    for (const line of String(raw || '').split('\n')) {
        const text = line.trim().replace(/^[-*•\s]+/, '').replace(/^\d+[.、)）]\s*/, '').trim();
        if (!text || old.has(text) || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
        if (out.length >= 3) break;
    }
    return out;
}

// 只认最新 AI 楼及其之前最近的有效用户楼，系统消息可以夹在两者之间。
export function findTravelReply(chat, messageId) {
    if (!Array.isArray(chat)) return null;
    const mid = Number(messageId);
    if (!Number.isInteger(mid) || mid !== chat.length - 1) return null;
    const reply = chat[mid];
    if (!reply || reply.is_user || reply.is_system) return null;
    let userId = mid - 1;
    while (userId >= 0 && chat[userId]?.is_system) userId--;
    const user = chat[userId];
    if (!user?.is_user || !hasTimeTravelBlock(user.mes)) return null;
    return { messageId: mid, userMessageId: userId };
}

// 控制器只维护单次会话的内存状态和执行顺序；具体 API、存储、UI 与通知由调用方适配。
export function createTimeTravelController({ getChatId, getChat, resolveDestinationDate, getCalendar, onStateChange, onStepResult, onSequenceEnd, steps = [] } = {}) {
    let state = null;
    let sequenceAbort = null;
    let sessionSeq = 0;

    const snapshot = () => state ? { ...state, sourceDate: { ...state.sourceDate }, selectedTargetDate: { ...state.selectedTargetDate } } : null;
    const reportState = reason => {
        try { onStateChange?.({ state: snapshot(), reason }); }
        catch (error) { console.error('[SP 时光旅行] 状态刷新失败', error); }
    };

    function begin({ chatId, sourceDate, selectedTargetDate, direction = '' } = {}) {
        const source = cleanDate(sourceDate);
        const target = cleanDate(selectedTargetDate);
        if (!chatId || !source || !target) return false;
        sequenceAbort?.abort();
        sequenceAbort = null;
        const chat = getChat?.();
        state = {
            phase: 'waiting',
            sessionId: ++sessionSeq,
            chatId,
            waitingAfterMessageId: Array.isArray(chat) ? chat.length - 1 : -1,
            sourceDate: source,
            selectedTargetDate: target,
            direction: String(direction || '').trim(),
        };
        reportState('waiting');
        return true;
    }

    function clear() {
        const hadState = !!state;
        sequenceAbort?.abort();
        sequenceAbort = null;
        state = null;
        if (hadState) reportState('cleared');
    }

    function isInitialFloor(messageId) {
        if (state?.phase !== 'waiting' || state.chatId !== getChatId?.()) return false;
        const reply = findTravelReply(getChat?.(), messageId);
        return !!reply
            && reply.messageId > state.waitingAfterMessageId
            && reply.userMessageId > state.waitingAfterMessageId;
    }

    async function handleRendered(messageId) {
        if (!isInitialFloor(messageId)) {
            const chat = getChat?.();
            const mid = Number(messageId);
            const latest = Array.isArray(chat) && Number.isInteger(mid) && mid === chat.length - 1 && !chat[mid]?.is_user && !chat[mid]?.is_system;
            if (state?.phase === 'waiting'
                && state.chatId === getChatId?.()
                && latest
                && mid > state.waitingAfterMessageId) {
                state = null;
                reportState('cancelled');
            }
            return false;
        }
        const active = state;
        active.phase = 'syncing';
        reportState('syncing');
        const myAbort = sequenceAbort = new AbortController();
        try {
            const destinationDate = cleanDate(await resolveDestinationDate?.({
                messageId: Number(messageId),
                chatId: active.chatId,
                sourceDate: active.sourceDate,
                selectedTargetDate: active.selectedTargetDate,
                signal: myAbort.signal,
            }));
            if (!destinationDate) throw new Error('无法读取正文生成后的日期锚点');
            const calendar = getCalendar?.();
            const promptAddon = buildTravelPromptAddon({
                sourceDate: active.sourceDate,
                destinationDate,
                direction: active.direction,
                calendar,
            });
            for (const step of steps) {
                if (myAbort.signal.aborted) break;
                let result = { status: 'skipped' };
                try {
                    result = await step.run({
                        messageId: Number(messageId),
                        destinationDate,
                        promptAddon,
                    }) || { status: 'skipped' };
                } catch (error) {
                    try { step.onError?.(error); }
                    catch (reportError) { console.error('[SP 时光旅行] 步骤错误处理失败', reportError); }
                    result = { status: error?.name === 'AbortError' ? 'cancelled' : 'failed', error };
                }
                try {
                    await onStepResult?.({ key: step.key || '', result, messageId: Number(messageId), destinationDate });
                } catch (error) {
                    console.error('[SP 时光旅行] 步骤结果处理失败', error);
                }
            }
        } finally {
            if (sequenceAbort === myAbort) sequenceAbort = null;
            if (state === active) {
                state = null;
                reportState('completed');
            }
            try {
                await onSequenceEnd?.({ messageId: Number(messageId), chatId: active.chatId, sessionId: active.sessionId });
            } catch (error) {
                console.error('[SP 时光旅行] 流程收尾失败', error);
            }
        }
        return true;
    }

    return Object.freeze({ begin, clear, getState: snapshot, isInitialFloor, handleRendered });
}
