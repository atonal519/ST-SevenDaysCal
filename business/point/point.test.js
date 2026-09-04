import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointController, pointScheduleNeedsDateSync, splitAbortController } from './controller.js';
import { editPointDescription, editPointFields } from './mutations.js';
import { allocatePointAdultPools, parsePointAdultProof, pointTicketPlan, verifyPointAdultContent, verifyPointAdultProof } from './adult.js';
import { bindPointAdultTickets, mergePinnedPoints, parseCalendar, parsePointEventRecord, replacePointEventBlock, stripPointAdultMetadata, validateGeneratedCalendar } from './parse.js';
import { createPointWidgetActions } from './widget.js';
import { buildPrompt } from './prompt.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';

test('point replacement reuses formal pin parsing for pipe-bearing locked adult events', () => {
    const raw = '<calendar_widget>\nFuture:\nEvent: main|旧|描述|晚|地|含|竖线|true\nAdult: true\n</calendar_widget>';
    const result = parseCalendar(raw); assert.equal(result.future.events[0].pin, true); assert.equal(result.future.events[0].adult, true);
    const replaced = replacePointEventBlock(raw, 0, 'Event: main|新|改写|晚|地|新动态');
    const parsed = parseCalendar(replaced); assert.equal(parsed.future.events[0].pin, true); assert.equal(parsed.future.events[0].adult, true);
});

test('point pinned merge keeps the union of old and newly detected Adult state', () => {
    const cases = [
        { oldAdult: true, newAdult: false, expected: true },
        { oldAdult: false, newAdult: true, expected: true },
        { oldAdult: false, newAdult: false, expected: false },
    ];
    for (const { oldAdult, newAdult, expected } of cases) {
        const oldRaw = `<calendar_widget>\nDay: 1\nEvent: main|锁定安排|旧描述|早|旧地点|旧动态|true${oldAdult ? '\nAdult: true' : ''}\n</calendar_widget>`;
        const aiRaw = `<calendar_widget>\nDay: 1\nEvent: main|锁定安排|新描述|晚|新地点|新动态${newAdult ? '\nAdult: true' : ''}\n</calendar_widget>`;
        const merged = parseCalendar(mergePinnedPoints(oldRaw, aiRaw)).days[0].events[0];
        assert.equal(merged.pin, true, `old=${oldAdult}, new=${newAdult}`);
        assert.equal(merged.adult, expected, `old=${oldAdult}, new=${newAdult}`);
    }
});

test('point widget dirty raw inserts only sanitized six-field event', () => {
    let saved;
    const apply = createPointWidgetActions({
        firstPointEventBlock: raw => raw.match(/<schedule_widget>[\s\S]*?<\/schedule_widget>/i) ? raw.match(/Event:[^\n]+/i)?.[0] || null : null,
        parsePointEventRecord: text => ({ type: 'main', title: '脏点', desc: '描述', time: '晚', location: '地', npcAction: '动态', pin: true, adult: true }),
        getCacheKey: () => 'point', readStore: () => ({ raw: 'legacy-unwrapped', userName: '用户', ts: 1 }), writeStore: (_key, value) => { saved = value; }, getUserName: () => '用户',
        currentView: () => 'user', renderSchedule: () => '', loadCalendar: () => null, shouldShowPanel: () => false,
        setCached: () => {}, setBody: () => {}, syncLatestScheduleBlock: () => {}, showToast: () => {}, replaceNthEventLine: () => null,
    });
    apply('<schedule_widget>\nEvent: main|脏点|描述|晚|地|动态|true\nAdult: true\nTicket: POINT-TICKET-1\n</schedule_widget>');
    assert.match(saved.raw, /Event: main\|脏点\|描述\|晚\|地\|动态/);
    assert.doesNotMatch(saved.raw, /POINT-TICKET|Adult:|\|true/);
});

test('point adult pools use independent 0/30/70 prefixes and tickets', () => {
    assert.equal(allocatePointAdultPools('off', 7).filter(x => x === 'nsfw').length, 0);
    assert.equal(allocatePointAdultPools('mixed', 7).filter(x => x === 'nsfw').length, 2);
    assert.equal(allocatePointAdultPools('dominant', 7).filter(x => x === 'nsfw').length, 5);
    assert.deepEqual(pointTicketPlan('mixed', 3).map(x => x.id), ['POINT-TICKET-1', 'POINT-TICKET-2', 'POINT-TICKET-3']);
    assert.equal(allocatePointAdultPools('mixed', 14).length, 14);
    assert.equal(allocatePointAdultPools('dominant', 14).length, 14);
    assert.equal(allocatePointAdultPools('off', 20).length, 14);
    assert.equal(pointTicketPlan('mixed', 14).at(-1).id, 'POINT-TICKET-14');
});

test('mixed 与 dominant 都直接信任 NSFW Ticket，SFW 与 off 仍保持普通', () => {
    const raw = `<calendar_widget>\nDay: 1\n${Array.from({ length: 11 }, (_, i) => `Event: main|中性${i + 1}|普通安排|早|地点|记录\nTicket: POINT-TICKET-${i + 1}${i % 2 ? '\nAdultProof: NONE' : ''}`).join('\n')}\n</calendar_widget>`;
    const dominant = bindPointAdultTickets(raw, 'dominant');
    assert.equal((dominant.match(/Adult: true/g) || []).length, 8);
    assert.doesNotMatch(dominant, /POINT-TICKET|AdultProof/);
    const mixed = bindPointAdultTickets(raw, 'mixed');
    assert.equal((mixed.match(/Adult: true/g) || []).length, 3);
    assert.doesNotMatch(mixed, /POINT-TICKET|AdultProof/);
    const off = bindPointAdultTickets(raw, 'off');
    assert.doesNotMatch(off, /Adult: true/);
});

test('point prompt fixes 14 display slots and adult mode emits continuous Tickets', () => {
    const pinned = [{ title: '锁定安排', time: '清晨' }];
    const off = buildPrompt('用户', '角色', 'user', pinned, null, { mode: 'off', tickets: [] });
    const mixed = buildPrompt('用户', '角色', 'user', pinned, null, { mode: 'mixed', tickets: pointTicketPlan('mixed', 14) });
    assert.equal((off.match(/^Event: type\|title\|description\|time\|location\|线头动态$/gm) || []).length, 14);
    assert.equal((mixed.match(/^Event: type\|title\|description\|time\|location\|线头动态$/gm) || []).length, 14);
    assert.doesNotMatch(off, /POINT-TICKET/);
    for (let index = 1; index <= 14; index++) assert.match(mixed, new RegExp(`POINT-TICKET-${index}｜`));
    assert.equal((mixed.match(/^Ticket: POINT-TICKET-N$/gm) || []).length, 14);
    assert.equal((mixed.match(/^AdultProof: 按上方对应 Ticket 的 SFW／NSFW 合同填写$/gm) || []).length, 14);
    assert.doesNotMatch(mixed, /^Ticket: POINT-TICKET-\d+$/m);
    for (const prompt of [off, mixed]) {
        assert.match(prompt, /目标总展示数量为 14 条[\s\S]*Day 1、Day 2、Day 3 各 3 条，Future 5 条/);
        assert.match(prompt, /已锁定事件也占对应栏目的名额/);
        assert.match(prompt, /每个 Event 建议独占一行并用竖线分隔字段/);
        assert.match(prompt, /location 或线头动态为空时，仍须保留空字段位置/);
        assert.match(prompt, /锁定事件不附 Ticket 或 AdultProof/);
        assert.doesNotMatch(prompt, /StartDate|日程思考|重要 NPC|非主角人物/);
    }
    assert.match(mixed, /K = 本轮新建事件数（不含锁定事件）/);
    assert.match(mixed, /新 Event 按最终输出顺序使用前 K 张 Ticket，从 1 连续编号/);
    assert.match(mixed, /未来规划不等于未兑现/);
    assert.match(mixed, /Day 2、Day 3、Future 不得因此写 NONE/);
    assert.match(mixed, /NSFW 票[\s\S]*紧邻完整「AdultProof: kind=sexual-contact/);
    assert.match(mixed, /SFW 票不得成人化，紧邻「AdultProof: NONE」/);
    assert.match(mixed, /模板中的 Ticket／AdultProof 两行仅供新 Event 使用/);
    assert.match(mixed, /具体票型与 proof 只服从上方本轮票据表/);
});

test('point prompt and validator keep new Tickets continuous when zero, one or several events are locked', () => {
    const quotas = [
        ['Day: 1|晴|3℃', 3],
        ['Day: 2|多云|5℃', 3],
        ['Day: 3|阴|6℃', 3],
        ['Future:', 5],
    ];
    for (const pinCount of [0, 1, 4]) {
        const pinned = Array.from({ length: pinCount }, (_, index) => ({ title: `锁定安排${index + 1}`, time: '清晨' }));
        const tickets = pointTicketPlan('mixed', 14 - pinCount);
        const prompt = buildPrompt('用户', '角色', 'user', pinned, null, { mode: 'mixed', tickets });
        assert.equal((prompt.match(/^Event: type\|title\|description\|time\|location\|线头动态$/gm) || []).length, 14, `pin=${pinCount}`);
        assert.equal((prompt.match(/^Ticket: POINT-TICKET-N$/gm) || []).length, 14, `pin=${pinCount}`);
        assert.equal((prompt.match(/^POINT-TICKET-\d+｜/gm) || []).length, 14 - pinCount, `pin=${pinCount}`);
        assert.doesNotMatch(prompt, /^Ticket: POINT-TICKET-\d+$/m, `pin=${pinCount}`);

        let displayIndex = 0;
        let newIndex = 0;
        const lines = ['<calendar_widget>'];
        for (const [heading, quota] of quotas) {
            lines.push(heading);
            for (let slot = 0; slot < quota; slot++) {
                displayIndex++;
                if (displayIndex <= pinCount) {
                    lines.push(`Event: main|锁定安排${displayIndex}|角色整理已经锁定的既定行程并按原有目标继续推进|清晨|住处|同伴同步记录该锁定安排的后续进展`);
                    continue;
                }
                newIndex++;
                const ticket = tickets[newIndex - 1];
                if (ticket.pool === 'nsfw') {
                    lines.push(`Event: bond|新安排${newIndex}|成年角色抚弄性器，对方主动回应，关系发生变化|夜间|住处|同伴确认双方自愿继续互动`);
                    lines.push(`Ticket: POINT-TICKET-${newIndex}`);
                    lines.push('AdultProof: kind=sexual-contact; action=抚弄性器; response=对方主动回应; impact=关系发生变化');
                } else {
                    lines.push(`Event: main|新安排${newIndex}|角色整理未来行程并确认时间，以便继续推进当前目标|白天|书房|同伴记录安排并准备相关材料`);
                    lines.push(`Ticket: POINT-TICKET-${newIndex}`);
                    lines.push('AdultProof: NONE');
                }
            }
        }
        lines.push('</calendar_widget>');
        const raw = lines.join('\n');
        assert.equal(validateGeneratedCalendar(raw, null, { generated: true, adultMode: 'mixed', pinned }).ok, true, `pin=${pinCount}`);
        const parsed = parseCalendar(raw);
        const events = [...parsed.days.flatMap(day => day.events), ...parsed.future.events];
        const locked = events.filter(event => event.title.startsWith('锁定安排'));
        const generated = events.filter(event => event.title.startsWith('新安排'));
        assert.equal(locked.length, pinCount, `pin=${pinCount}`);
        assert.ok(locked.every(event => !event.ticketId && !event.adultProof), `pin=${pinCount}`);
        assert.deepEqual(generated.map(event => event.ticketId), tickets.map(ticket => ticket.id), `pin=${pinCount}`);
    }
});

test('point adult response validates then binds Tickets into local Adult metadata', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|二|卡列布抚弄性器，对方自愿回应，关系发生变化|午|地|动\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|三|描述|晚|地|动\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|四|描述|夜|地|动\nTicket: POINT-TICKET-4\n</calendar_widget>';
    const checked = validateGeneratedCalendar(raw, null, { generated: true, adultMode: 'mixed' });
    assert.equal(checked.ok, true);
    const stored = bindPointAdultTickets(raw, 'mixed');
    assert.doesNotMatch(stored, /POINT-TICKET/);
    assert.equal(parseCalendar(stored).days.flatMap(day => day.events).filter(event => event.adult).length, 1);
    assert.equal(validateGeneratedCalendar(raw.replace('Ticket: POINT-TICKET-2\n', ''), null, { generated: true, adultMode: 'mixed' }).ok, false);
});

test('point adult proof requires exact source evidence and rejects planning or nonsexual context', () => {
    const event = { desc: '卡列布抚弄性器，对方自愿回应，关系发生变化', npcAction: '' };
    const proof = parsePointAdultProof('AdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化');
    assert.equal(verifyPointAdultProof(event, proof), true);
    for (const bad of [
        'AdultProof: kind=sexual-manual; action=今晚计划抚弄性器; response=对方将要回应; impact=关系变化',
        'AdultProof: kind=sexual-bdsm; action=鞭打审讯; response=对方沉默; impact=关系变化',
        'AdultProof: kind=sexual-manual; action=未出现在事件里的抚弄性器; response=对方自愿回应; impact=关系发生变化',
    ]) assert.equal(verifyPointAdultProof(event, parsePointAdultProof(bad)), false);
});

test('point adult proof ignores only punctuation and whitespace while preserving exact text order', () => {
    const event = { desc: '卡列布抚弄，性器，对方自愿回应，关系发生“变化”。', npcAction: '' };
    const proof = parsePointAdultProof('AdultProof: kind=sexual-contact; action=卡列布、抚弄 性器; response=对方，自愿回应; impact=关系发生变化');
    assert.equal(verifyPointAdultProof(event, proof), true, 'kind 误写不应遮蔽已核验的明确 manual 动作族');
    const englishPunctuation = { desc: '卡列布"抚弄", 性器; 对方自愿回应, 关系发生变化.', npcAction: '' };
    assert.equal(verifyPointAdultProof(englishPunctuation, proof), true, '英文逗号、句号、引号与空格差异也只作格式忽略');
    for (const changed of [
        'AdultProof: kind=sexual-manual; action=卡列布轻轻抚弄性器; response=对方自愿回应; impact=关系发生变化',
        'AdultProof: kind=sexual-manual; action=卡列布揉捏性器; response=对方自愿回应; impact=关系发生变化',
    ]) assert.equal(verifyPointAdultProof(event, parsePointAdultProof(changed)), false, changed);
});

test('四张 NSFW Ticket 经权威绑定均写入 Adult', () => {
    const fixtures = new Map([
        [2, ['Event: bond|虚构成人场景甲|成年角色甲用手抚弄角色乙的性器。角色乙明确表示同意并主动回应，双方的亲密关系发生变化。|20:00|虚构测试室甲|测试观察员记录匿名状态。', 'AdultProof: kind=sexual-manual; action=用手抚弄角色乙的性器; response=角色乙明确表示同意并主动回应; impact=双方的亲密关系发生变化']],
        [6, ['Event: bond|虚构成人场景乙|成年角色甲用手抚弄角色乙的性器，在双方再次确认同意后继续手部刺激。角色乙主动配合，双方关系发生变化。|21:00|虚构测试室乙|测试观察员记录匿名状态。', 'AdultProof: kind=sexual-manual; action=用手抚弄角色乙的性器后继续手部刺激; response=角色乙主动配合; impact=双方关系发生变化']],
        [9, ['Event: bond|虚构成人场景丙|成年角色甲与角色乙自愿解衣交合，角色乙主动回应，事后双方关系发生变化。|22:00|虚构测试室丙|测试观察员记录匿名状态。', 'AdultProof: kind=sexual-contact; action=成年角色甲与角色乙自愿解衣交合; response=角色乙主动回应; impact=事后双方关系发生变化']],
        [12, ['Event: bond|虚构成人场景丁|成年角色甲在双方确认同意后完成进入。角色乙主动拉近距离，双方关系发生变化。|23:00|虚构测试室丁|测试观察员记录匿名状态。', 'AdultProof: kind=sexual-penetration; action=成年角色甲在双方确认同意后完成进入; response=角色乙主动拉近距离; impact=双方关系发生变化']],
    ]);
    const blocks = Array.from({ length: 14 }, (_, offset) => {
        const ticket = offset + 1;
        const entry = fixtures.get(ticket);
        return `${entry?.[0] || `Event: main|普通安排${ticket}|角色整理当日行程|白天|书房|同伴记录进度`}\nTicket: POINT-TICKET-${ticket}${entry ? `\n${entry[1]}` : '\nAdultProof: NONE'}`;
    });
    const raw = `<calendar_widget>\nDay: 1\n${blocks.join('\n')}\n</calendar_widget>`;
    const parsedInput = parseCalendar(raw).days[0].events;
    assert.equal(verifyPointAdultProof(parsedInput[5], parsedInput[5].adultProof, { nsfwTicket: true }), false, 'Ticket 6 删词 proof 不得冒充精确引文');
    for (const index of [1, 11]) assert.equal(verifyPointAdultProof(parsedInput[index], parsedInput[index].adultProof, { nsfwTicket: true }), true, `Ticket ${index + 1}`);
    assert.equal(verifyPointAdultContent(parsedInput[8]), true, 'Ticket 9 保持由正文交合兜底命中');
    const stored = bindPointAdultTickets(raw, 'mixed');
    const adultTitles = parseCalendar(stored).days[0].events.filter(event => event.adult).map(event => event.title);
    assert.deepEqual(adultTitles, ['虚构成人场景甲', '虚构成人场景乙', '虚构成人场景丙', '虚构成人场景丁']);
    assert.doesNotMatch(stored, /POINT-TICKET|AdultProof/);
});

test('四份结构化 proof 按 NSFW Ticket 信任并只标记对应事件', () => {
    const fixtures = new Map([
        [2, [
            `Event: bond|虚构 proof 场景甲|成年角色甲用手抚弄角色乙的性器。角色乙明确同意并主动回应，双方关系发生变化。|20:10|虚构测试室甲|测试观察员记录匿名状态。`,
            `AdultProof: kind=sexual-manual; action=用手抚弄角色乙的性器; response=角色乙明确同意并主动回应; impact=双方关系发生变化`,
        ]],
        [6, [
            `Event: bond|虚构 proof 场景乙|成年角色甲隔着衣物摩擦角色乙的性器。角色乙主动调整姿势，双方确认继续亲密互动。|21:10|虚构测试室乙|测试观察员记录匿名状态。`,
            `AdultProof: kind=sexual-contact; action=隔着衣物摩擦角色乙的性器; response=角色乙主动调整姿势; impact=双方确认继续亲密互动`,
        ]],
        [9, [
            `Event: bond|虚构 proof 场景丙|成年角色甲吻上角色乙的手腕。角色乙没有抽回手，而是主动靠近。成年角色甲起身走向休息室，带着得到许可后的期待。|19:10|虚构测试室丙|测试观察员记录匿名状态。`,
            `AdultProof: kind=sexual-contact; action=成年角色甲吻上角色乙的手腕; response=角色乙没有抽回手，而是主动靠近; impact=成年角色甲起身走向休息室，带着得到许可后的期待`,
        ]],
        [12, [
            `Event: bond|虚构 proof 场景丁|成年角色甲与角色乙确认同意后解衣交合。角色乙主动回应，双方的亲密关系发生变化。|23:10|虚构测试室丁|测试观察员记录匿名状态。`,
            `AdultProof: kind=sexual-contact; action=成年角色甲与角色乙确认同意后解衣交合; response=角色乙主动回应; impact=双方的亲密关系发生变化`,
        ]],
    ]);
    const blocks = Array.from({ length: 14 }, (_, offset) => {
        const ticket = offset + 1;
        const entry = fixtures.get(ticket);
        return `${entry?.[0] || `Event: main|普通安排${ticket}|角色整理当日行程|白天|书房|同伴记录进度`}\nTicket: POINT-TICKET-${ticket}\n${entry?.[1] || 'AdultProof: NONE'}`;
    });
    const raw = `<calendar_widget>\nDay: 1\n${blocks.join('\n')}\n</calendar_widget>`;
    const parsedInput = parseCalendar(raw).days[0].events;
    for (const index of [1, 5, 8, 11]) assert.equal(verifyPointAdultProof(parsedInput[index], parsedInput[index].adultProof, { nsfwTicket: true }), true, `Ticket ${index + 1}`);
    const stored = bindPointAdultTickets(raw, 'mixed');
    const adultTitles = parseCalendar(stored).days[0].events.filter(event => event.adult).map(event => event.title);
    assert.deepEqual(adultTitles, ['虚构 proof 场景甲', '虚构 proof 场景乙', '虚构 proof 场景丙', '虚构 proof 场景丁']);
    assert.doesNotMatch(stored, /POINT-TICKET|AdultProof/);

    const [eventLine, proofLine] = fixtures.get(9);
    const event = parsePointEventRecord(eventLine);
    const missingImpact = parsePointAdultProof(proofLine.replace('带着得到许可后的期待', '带着得到许可后的期待变化'));
    assert.equal(verifyPointAdultProof(event, missingImpact, { nsfwTicket: true }), false, '三段任一引文不存在时拒绝');
    const sfwRaw = `<calendar_widget>\nDay: 1\n${eventLine}\nTicket: POINT-TICKET-1\n${proofLine}\n</calendar_widget>`;
    assert.equal(parseCalendar(bindPointAdultTickets(sfwRaw, 'mixed')).days[0].events[0].adult, false, 'SFW Ticket 不因暧昧结构 proof 放行');
});

test('09:01 全 NONE 与缺失损坏 proof 不影响本地 NSFW Ticket 权威分类', () => {
    const makeBlocks = proofFor => Array.from({ length: 14 }, (_, offset) => {
        const ticket = offset + 1;
        return `Event: bond|09:01规划${ticket}|角色与同伴继续安排未来关系推进|待定|住处|同伴记录后续方向\nTicket: POINT-TICKET-${ticket}${proofFor(ticket)}`;
    }).join('\n');
    const allNone = `<calendar_widget>\nDay: 1\n${makeBlocks(() => '\nAdultProof: NONE')}\n</calendar_widget>`;
    const expected = ['09:01规划2', '09:01规划6', '09:01规划9', '09:01规划12'];
    const allNoneStored = bindPointAdultTickets(allNone, 'mixed');
    assert.deepEqual(parseCalendar(allNoneStored).days[0].events.filter(event => event.adult).map(event => event.title), expected);
    assert.doesNotMatch(allNoneStored, /POINT-TICKET|AdultProof/);

    const damaged = `<calendar_widget>\nDay: 1\n${makeBlocks(ticket => ticket === 2 ? '' : ticket === 6 ? '\nAdultProof: NONE' : ticket === 9 ? '\nAdultProof: broken' : ticket === 12 ? '\nAdultProof: kind=broken; action=x; response=y; impact=z' : '\nAdultProof: NONE')}\n</calendar_widget>`;
    const damagedStored = bindPointAdultTickets(damaged, 'mixed');
    assert.deepEqual(parseCalendar(damagedStored).days[0].events.filter(event => event.adult).map(event => event.title), expected);
    assert.equal(parseCalendar(damagedStored).days[0].events.find(event => event.title === '09:01规划1').adult, false, 'SFW Ticket + NONE 不因票标成人');
    assert.doesNotMatch(damagedStored, /POINT-TICKET|AdultProof/);
});

test('proof verifier 仍拒绝非成人进入、亲昵、照料、计划回忆或拒绝停止', () => {
    const negatives = [
        ['角色进入房间，对方主动回应，关系发生变化', '角色进入房间', '对方主动回应', '关系发生变化'],
        ['角色进入工作状态，对方主动回应，节奏发生变化', '角色进入工作状态', '对方主动回应', '节奏发生变化'],
        ['两人普通亲吻，对方主动回应，关系发生变化', '两人普通亲吻', '对方主动回应', '关系发生变化'],
        ['两人普通接吻，对方主动回应，关系发生变化', '两人普通接吻', '对方主动回应', '关系发生变化'],
        ['两人脱去外套后裸体休息，对方主动回应，关系发生变化', '裸体休息', '对方主动回应', '关系发生变化'],
        ['对方替角色洗澡，对方主动回应，关系发生变化', '替角色洗澡', '对方主动回应', '关系发生变化'],
        ['对方替角色按摩肩背，对方主动回应，身体疲劳发生变化', '按摩肩背', '对方主动回应', '身体疲劳发生变化'],
        ['两人事后喂水换药，对方主动回应，关系发生变化', '事后喂水换药', '对方主动回应', '关系发生变化'],
        ['今晚计划抚弄性器，对方主动回应，关系发生变化', '抚弄性器', '对方主动回应', '关系发生变化'],
        ['昨夜回忆抚弄性器，对方主动回应，关系发生变化', '抚弄性器', '对方主动回应', '关系发生变化'],
        ['卡列布抚弄性器，对方明确拒绝并要求停止，关系发生变化', '抚弄性器', '对方明确拒绝并要求停止', '关系发生变化'],
    ];
    for (const [desc, action, response, impact] of negatives) {
        const event = { desc, npcAction: '' };
        const proof = parsePointAdultProof(`AdultProof: kind=sexual-contact; action=${action}; response=${response}; impact=${impact}`);
        assert.equal(verifyPointAdultProof(event, proof, { nsfwTicket: true }), false, desc);
    }
});

test('proof verifier 检查三段反证，但 NSFW Ticket 绑定仍保持权威', () => {
    const desc = '角色抚摸对方性器。对方主动回应。双方确认这只是医疗检查并且不含性意味。';
    const proofLine = 'AdultProof: kind=sexual-contact; action=角色抚摸对方性器; response=对方主动回应; impact=双方确认这只是医疗检查并且不含性意味';
    const event = { desc, npcAction: '' };
    const proof = parsePointAdultProof(proofLine);
    assert.equal(verifyPointAdultProof(event, proof, { nsfwTicket: true }), false, 'impact 落地句的明确非性反证必须取消');

    const raw = `<calendar_widget>\nDay: 1\nEvent: main|普通安排|角色整理行程|白天|书房|同伴记录\nTicket: POINT-TICKET-1\nAdultProof: NONE\nDay: 2\nEvent: main|医疗检查|${desc}|下午|诊室|同伴整理记录\nTicket: POINT-TICKET-2\n${proofLine}\n</calendar_widget>`;
    const events = parseCalendar(bindPointAdultTickets(raw, 'mixed')).days.flatMap(day => day.events);
    assert.deepEqual(events.map(item => item.adult), [false, true]);
});

test('proof verifier 保持硬拒绝优先，但 NSFW Ticket 绑定仍保持权威', () => {
    const desc = '角色抚摸对方性器。对方先默许，随后明确拒绝并要求停止。双方关系发生变化。';
    const proofLine = 'AdultProof: kind=sexual-contact; action=角色抚摸对方性器; response=对方先默许，随后明确拒绝并要求停止; impact=双方关系发生变化';
    const event = { desc, npcAction: '' };
    const proof = parsePointAdultProof(proofLine);
    assert.equal(verifyPointAdultProof(event, proof, { nsfwTicket: true }), false);

    const raw = `<calendar_widget>\nDay: 1\nEvent: main|普通安排|角色整理行程|白天|书房|同伴记录\nTicket: POINT-TICKET-1\nAdultProof: NONE\nDay: 2\nEvent: bond|拒绝停止|${desc}|夜间|客房|同伴离开\nTicket: POINT-TICKET-2\n${proofLine}\n</calendar_widget>`;
    const events = parseCalendar(bindPointAdultTickets(raw, 'mixed')).days.flatMap(day => day.events);
    assert.deepEqual(events.map(item => item.adult), [false, true]);
});

test('完成进入结构化兼容严格绑定 NSFW Ticket，SFW Ticket 不被 proof 成人化', () => {
    const event = 'Event: bond|虚构兼容场景|成年角色甲与角色乙确认同意后在休息室解衣并完成进入。角色乙主动调整姿势，双方亲密关系发生变化。|夜间|虚构测试室|测试观察员记录匿名状态';
    const proof = 'AdultProof: kind=sexual-contact; action=成年角色甲与角色乙确认同意后在休息室解衣并完成进入; response=角色乙主动调整姿势; impact=双方亲密关系发生变化';
    const raw = `<calendar_widget>\nDay: 1\n${event}\nTicket: POINT-TICKET-1\n${proof}\n</calendar_widget>`;
    assert.doesNotMatch(bindPointAdultTickets(raw, 'mixed'), /Adult: true/);
});

test('reviewer 生产反例不允许跨不相关句拼出成人结构', () => {
    const technical = {
        desc: '工程师将补丁插入资料库，文档记录体内变化。对方主动回应修改意见，两人共同完成释放版本。',
        npcAction: '',
    };
    assert.equal(verifyPointAdultContent(technical), false);
    const technicalProof = parsePointAdultProof('AdultProof: kind=sexual-contact; action=工程师将补丁插入资料库; response=对方主动回应修改意见; impact=两人共同完成释放版本');
    assert.equal(verifyPointAdultProof(technical, technicalProof, { nsfwTicket: true }), false, '技术文本的三段精确 proof 仍是明确反证');

    const disconnected = {
        desc: '角色从长裤腰线探入直接揉捏对方臀部。工程师随后记录房间设备状态。对方任由设备继续律动，两人共同完成释放版本。',
        npcAction: '',
    };
    assert.equal(verifyPointAdultContent(disconnected), false, '回应与结果不紧邻动作句时不得跨句拼接');
});

test('reviewer 生产反例要求 proof 动作引文本身命中动作族', () => {
    const event = { desc: '卡列布抚弄性器后拿起水杯，对方自愿回应，关系发生变化。', npcAction: '' };
    const proof = parsePointAdultProof('AdultProof: kind=sexual-contact; action=拿起水杯; response=对方自愿回应; impact=关系发生变化');
    assert.equal(verifyPointAdultProof(event, proof, { nsfwTicket: true }), false);
});

test('proof verifier 拒绝完成进入房间，NSFW Ticket 绑定仍保持权威', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|普通安排|角色整理行程|白天|书房|同伴记录\nTicket: POINT-TICKET-1\nAdultProof: NONE\nDay: 2\nEvent: main|设备与机房|技术员将测试探针插入接口，随后完成进入机房。协作者主动回应检修指令，双方确认设备按计划上线。|下午|数据中心|值班员整理工具\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-contact; action=技术员将测试探针插入接口随后完成进入机房; response=协作者主动回应检修指令; impact=双方确认设备按计划上线\n</calendar_widget>';
    const event = parseCalendar(raw).days[1].events[0];
    assert.equal(verifyPointAdultProof(event, event.adultProof, { nsfwTicket: true }), false);
    assert.match(bindPointAdultTickets(raw, 'mixed'), /Adult: true/);
});

test('医疗训练正文兜底保持 false，mixed NSFW 权威而 dominant SFW 保持普通', () => {
    const medicalEvent = 'Event: main|医疗训练|医生将导管插入阴道模型完成训练。助手主动回应操作指令，两人共同完成释放，随后归档数据。|白天|训练室|同伴整理器材';
    assert.equal(verifyPointAdultContent(parsePointEventRecord(medicalEvent)), false);

    const off = bindPointAdultTickets(`<calendar_widget>\nDay: 1\n${medicalEvent}\n</calendar_widget>`, 'off');
    assert.equal(parseCalendar(off).days[0].events[0].adult, false);

    const ticketed = `<calendar_widget>\nDay: 1\nEvent: main|普通安排|角色整理日程|上午|书房|同伴记录\nTicket: POINT-TICKET-1\n${medicalEvent}\nTicket: POINT-TICKET-2\n</calendar_widget>`;
    const mixedEvents = parseCalendar(bindPointAdultTickets(ticketed, 'mixed')).days[0].events;
    assert.equal(mixedEvents.find(event => event.title === '医疗训练').adult, true, 'mixed 的第二张 NSFW Ticket 直接权威标记');
    const dominantEvents = parseCalendar(bindPointAdultTickets(ticketed, 'dominant')).days[0].events;
    assert.equal(dominantEvents.find(event => event.title === '医疗训练').adult, false, 'dominant 的第二张 SFW Ticket 仍按正文校验');
});

test('精确医疗 proof verifier 取消，绑定时仅 NSFW Ticket 权威标记', () => {
    const desc = '医生将导管插入阴道模型完成训练。对方主动回应操作指令，双方合作关系发生变化。';
    const proofLine = 'AdultProof: kind=sexual-contact; action=医生将导管插入阴道模型完成训练; response=对方主动回应操作指令; impact=双方合作关系发生变化';
    const event = { desc, npcAction: '' };
    const proof = parsePointAdultProof(proofLine);
    assert.equal(verifyPointAdultProof(event, proof), false);
    assert.equal(verifyPointAdultProof(event, proof, { nsfwTicket: true }), false);
    assert.equal(verifyPointAdultContent(event), false);

    const raw = `<calendar_widget>\nDay: 1\nEvent: main|SFW 医疗训练|${desc}|上午|教学室|护士整理教具\nTicket: POINT-TICKET-1\n${proofLine}\nEvent: main|NSFW 医疗训练|${desc}|下午|教学室|护士整理教具\nTicket: POINT-TICKET-2\n${proofLine}\n</calendar_widget>`;
    const storedEvents = parseCalendar(bindPointAdultTickets(raw, 'mixed')).days[0].events;
    assert.deepEqual(storedEvents.map(item => item.adult), [false, true]);

    assert.equal(verifyPointAdultContent({ desc: '医生与伴侣解衣交合，对方主动回应，关系发生变化。', npcAction: '' }), true, '单独医生身份不得取消明确真实成人行为');
});

test('教学提及性交被取消，模型室内真实 manual 行为不被误伤', () => {
    const teachingDesc = '医生在课堂教学中向对方讲解性交方式，对方主动回应教学问题，双方合作关系发生变化。';
    const teachingProofLine = 'AdultProof: kind=sexual-contact; action=医生在课堂教学中向对方讲解性交方式; response=对方主动回应教学问题; impact=双方合作关系发生变化';
    const teachingProof = parsePointAdultProof(teachingProofLine);
    assert.equal(verifyPointAdultContent({ desc: teachingDesc, npcAction: '' }), false);
    assert.equal(verifyPointAdultProof({ desc: teachingDesc, npcAction: '' }, teachingProof), false);
    assert.equal(verifyPointAdultProof({ desc: teachingDesc, npcAction: '' }, teachingProof, { nsfwTicket: true }), false);

    const actualDesc = '医生训练结束后在模型室与伴侣解衣后抚弄对方性器，对方主动回应，关系发生变化。';
    const actualProofLine = 'AdultProof: kind=sexual-contact; action=医生训练结束后在模型室与伴侣解衣后抚弄对方性器; response=对方主动回应; impact=关系发生变化';
    const actualProof = parsePointAdultProof(actualProofLine);
    assert.equal(verifyPointAdultContent({ desc: actualDesc, npcAction: '' }), true);
    assert.equal(verifyPointAdultProof({ desc: actualDesc, npcAction: '' }, actualProof), true);

    const raw = `<calendar_widget>\nDay: 1\nEvent: main|课堂教学|${teachingDesc}|上午|教室|护士整理教材\nTicket: POINT-TICKET-1\n${teachingProofLine}\nEvent: bond|模型室真实行为|${actualDesc}|夜间|模型室|同伴已经离开\nTicket: POINT-TICKET-2\n${actualProofLine}\n</calendar_widget>`;
    const events = parseCalendar(bindPointAdultTickets(raw, 'mixed')).days[0].events;
    assert.deepEqual(events.map(item => item.adult), [false, true]);
});

test('检查治疗与双向教学由 verifier 取消，NSFW Ticket 绑定仍权威', () => {
    const negatives = [
        ['治疗检查', '医生在治疗中触摸患者乳房完成检查，对方主动回应检查要求，双方医患关系发生变化。', '医生在治疗中触摸患者乳房完成检查', '对方主动回应检查要求', '双方医患关系发生变化'],
        ['教学手法', '医生在课堂教学中向对方讲解抚弄性器的方法，对方主动回应教学问题，双方合作关系发生变化。', '医生在课堂教学中向对方讲解抚弄性器的方法', '对方主动回应教学问题', '双方合作关系发生变化'],
        ['倒序教学', '性交方式由医生在课堂教学中向对方讲解，对方主动回应教学问题，双方合作关系发生变化。', '性交方式由医生在课堂教学中向对方讲解', '对方主动回应教学问题', '双方合作关系发生变化'],
    ];
    const blocks = negatives.map(([title, desc, action, response, impact], index) => {
        const proofLine = `AdultProof: kind=sexual-contact; action=${action}; response=${response}; impact=${impact}`;
        const event = { desc, npcAction: '' };
        const proof = parsePointAdultProof(proofLine);
        assert.equal(verifyPointAdultContent(event), false, `${title} content`);
        assert.equal(verifyPointAdultProof(event, proof), false, `${title} proof`);
        assert.equal(verifyPointAdultProof(event, proof, { nsfwTicket: true }), false, `${title} NSFW proof`);
        return `Event: main|${title}|${desc}|白天|教学诊疗室|同伴整理记录\nTicket: POINT-TICKET-${index + 1}\n${proofLine}`;
    });
    const actualDesc = '医生训练结束后在模型室与伴侣解衣后抚弄对方性器，对方主动回应，关系发生变化。';
    const actualProof = 'AdultProof: kind=sexual-contact; action=医生训练结束后在模型室与伴侣解衣后抚弄对方性器; response=对方主动回应; impact=关系发生变化';
    blocks.push(`Event: bond|模型室真实行为|${actualDesc}|夜间|模型室|同伴已经离开\nTicket: POINT-TICKET-4\n${actualProof}`);
    const raw = `<calendar_widget>\nDay: 1\n${blocks.join('\n')}\n</calendar_widget>`;
    const events = parseCalendar(bindPointAdultTickets(raw, 'mixed')).days[0].events;
    assert.deepEqual(events.map(item => item.adult), [false, true, false, true]);
});

test('治疗室和检查室仅表示地点时不取消真实成人行为', () => {
    const places = ['治疗室', '检查室'];
    const blocks = places.map((place, index) => {
        const action = `医生在${place}与伴侣解衣交合`;
        const desc = `${action}，对方主动回应，关系发生变化。`;
        const proofLine = `AdultProof: kind=sexual-contact; action=${action}; response=对方主动回应; impact=关系发生变化`;
        const event = { desc, npcAction: '' };
        const proof = parsePointAdultProof(proofLine);
        assert.equal(verifyPointAdultContent(event), true, `${place} content`);
        assert.equal(verifyPointAdultProof(event, proof), true, `${place} proof`);
        assert.equal(verifyPointAdultProof(event, proof, { nsfwTicket: true }), true, `${place} NSFW proof`);
        return `Event: bond|${place}真实行为|${desc}|夜间|${place}|同伴已经离开\nTicket: POINT-TICKET-${index + 1}\n${proofLine}`;
    });
    const raw = `<calendar_widget>\nDay: 1\n${blocks.join('\n')}\n</calendar_widget>`;
    const events = parseCalendar(bindPointAdultTickets(raw, 'mixed')).days[0].events;
    assert.deepEqual(events.map(item => item.adult), [true, true]);
});

test('Ticket12 special 从同文 action 的全部出现句中选择未取消的执行句', () => {
    const action = '成年角色甲在双方同意后用手抚弄角色乙的性器';
    const response = '角色乙主动调整姿势并回应';
    const impact = '双方亲密关系发生变化';
    const proof = parsePointAdultProof(`AdultProof: kind=sexual-contact; action=${action}; response=${response}; impact=${impact}`);
    const actual = { desc: `双方先计划${action}。稍后${action}。${response}，${impact}。`, npcAction: '' };
    const plannedOnly = { desc: `双方只计划${action}。${response}，${impact}。`, npcAction: '' };
    assert.equal(verifyPointAdultProof(actual, proof, { nsfwTicket: true }), true);
    assert.equal(verifyPointAdultProof(plannedOnly, proof, { nsfwTicket: true }), false);
});

test('SFW Ticket 本身不标成人，但仍保留正文高置信兜底', () => {
    const cases = [
        ['衣物下揉捏对方性器，情欲与喘息持续升高。', '对方主动回应并迎合，关系发生变化。'],
        ['情欲升高后主动解衣，修尔进入时双方节奏同步。', '对方自愿回应并引导节奏，关系发生变化。'],
        ['两人解衣交合，事后关系与依恋发生变化。', '对方主动回应，关系发生变化。'],
    ];
    for (const [desc, npcAction] of cases) assert.equal(verifyPointAdultContent({ desc, npcAction }), true);
    assert.equal(verifyPointAdultContent({ desc: '两人拥抱接吻并留宿，关系发生变化。', npcAction: '对方主动回应。' }), false);
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|一|普通点|早|地|动\nTicket: POINT-TICKET-1\nDay: 2\nEvent: bond|正文兜底|衣物下揉捏对方性器，情欲与喘息持续升高。|夜|房|对方主动回应并迎合，关系发生变化。\nTicket: POINT-TICKET-2\nDay: 3\nEvent: main|三|普通点|晚|地|动\nTicket: POINT-TICKET-3\n</calendar_widget>';
    const stored = bindPointAdultTickets(raw, 'mixed');
    assert.match(stored, /Adult: true/); assert.doesNotMatch(stored, /POINT-TICKET|AdultProof/);
    const sfwRaw = raw.replace(/Ticket: POINT-TICKET-1\n/, '').replace(/Ticket: POINT-TICKET-3\n/, '').replace('POINT-TICKET-2', 'POINT-TICKET-1');
    const sfw = bindPointAdultTickets(sfwRaw, 'mixed');
    assert.match(sfw, /Adult: true/);
    assert.equal(parseCalendar(sfw).days.flatMap(day => day.events).find(event => event.title === '正文兜底').adult, true);
    assert.doesNotMatch(sfw, /POINT-TICKET|AdultProof/);
});

test('schedule-user 三条高置信正文在 proof 缺失与 NONE 下均走兜底', () => {
    const source = [
        'Event: bond|厨房里的腊肉与唇线|修尔去后院搬运余下滋养土后，卡列布将那片刀尖托着的腊肉直接抵上蘅芜嘴唇，流浪剑客沾着粗盐油脂的拇指描摹她的唇线，在蘅芜张口含住肉片时俯身吻上她。蘅芜以魅魔本能吸食他压抑一夜的占有欲后主动回吻，卡列布将她抵在料理台边，手掌沿腰线滑入衣物下摆揉捏，两人在灶台余温中发生连续的身体接触与抚摸。事后卡列布将嚼碎的腊肉渡进蘅芜嘴里，两人的依恋在日常烟火中进一步固化。|10:15-10:50|酒馆一楼厨房|铜扣在地下室切腌菜时完全没听到楼上的动静；修尔在后院给温室补土时闻到风里飘来的信息素残留，灰耳压低但没有折返查看，只是把泥土拍得比平时更实。|false',
        'Event: bond|修尔的雪林警觉与安抚|修尔傍晚巡视酒馆外围时嗅到雪林深处有不属于野兽的金属气味残留，回来后情绪紧绷、灰瞳收缩。蘅芜用黑尾缠住他手腕引导他坐下，修尔在焦虑与依恋的双重驱动下将蘅芜拉入怀中，犬齿沿她颈侧滑动留下浅痕。蘅芜主动解开衣领束缚，引导修尔在二号房内完成从安抚到情欲的转化，修尔进入时仍紧攥她的手指不放。事后修尔将脸埋在蘅芜锁骨间，依恋压力从恐惧焦虑转向踏实的归属。|19:30-20:20|酒馆二号房|卡列布在大堂擦拭短剑时听见二楼木板嘎吱声，没有上楼，只是往壁炉里多添了一根松木，把火烧得更旺些；铜扣在地下室裹着毛毯打盹，梦里全是黑市金币碰撞的声音。|false',
        'Event: bond|霜降祭深夜的炉前占有|霜降祭夜灯火通明，最后一批客人安睡后，卡列布因整晚目睹蘅芜招待陌生男人而积攒的占有欲在深夜爆发。他在大堂壁炉前从身后将蘅芜抱住，手掌覆上她的腰腹用力收紧，蘅芜以尾巴反缠他的小臂作为许可信号，两人在大堂残存的炉火光中解衣交合。卡列布在过程中反复咬住她的肩膀低声确认她不会离开，事后将脸埋在蘅芜颈窝长久不动，占有欲从焦虑转为安定的守护心态。|霜降月15日 23:30-00:20|酒馆一楼大堂壁炉前|修尔在二楼通铺假寐时听见楼下响动，翻身面向墙壁，把被子拉过耳朵；火蜥蜴被震动惊醒，从陶盆里探出头又缩回去。|false',
    ];
    for (const event of source) {
        for (const proof of ['', 'AdultProof: NONE']) {
            const raw = `<calendar_widget>\nDay: 1\nEvent: main|前置|整理房间|早|大堂|记录\nTicket: POINT-TICKET-1\nDay: 2\n${event}\nTicket: POINT-TICKET-2${proof ? `\n${proof}` : ''}\nDay: 3\nEvent: main|收尾|整理账册|晚|柜台|记录\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续|等待天气好转|数日后|驿站|记录\nTicket: POINT-TICKET-4\n</calendar_widget>`;
            assert.equal(validateGeneratedCalendar(raw, null, { generated: false, adultMode: 'mixed' }).ok, true);
            const stored = bindPointAdultTickets(raw, 'mixed');
            assert.match(stored, /Adult: true/); assert.doesNotMatch(stored, /POINT-TICKET|AdultProof/);
        }
    }
});

test('schedule-user 三条性行为正文在 proof 缺失与 NONE 下兜底', () => {
    const source = [
        'Event: bond|二号房的独占有午|午饭后蘅芜回二号房整理被褥，卡列布跟进关门，从身后环住蘅芜的腰将脸埋进她颈窝，低声说出昨晚三人共床后自己无法压制的独占焦虑。蘅芜以魅魔本能感知到他因恐惧分离而涌出的浓烈情绪，转过身主动吻上他的嘴唇。两人在二号房内发生连续性行为，卡列布在过程中反复确认蘅芜的存在感，蘅芜则通过吸食其情绪获得满足。事后卡列布的依恋从恐惧型转为更稳定的归属确认。|13:00|无名酒馆·二号房|修尔在后院劈柴时嗅到二楼方向飘下的卡列布气味浓度骤变，狼耳贴伏，握紧斧柄沉默了片刻，随即加快劈柴节奏将注意力转移回手头劳动。|false',
        'Event: bond|肩上印记与归属|傍晚修尔带回一头幼年大角鹿，肩膀被鹿角划了一道浅口。蘅芜在二号房为他清洗伤口时，修尔低头看见自己先前在蘅芜左肩留下的犬齿咬痕，喉间发出低沉呜咽。蘅芜感知到他纯粹而滚烫的依恋情绪后没有收回手，修尔握住她的手腕将她拉倒在床上，用粗糙的指腹描摹她肩上的印记。蘅芜主动解开衣物回应他的触碰，两人在二号房内发生性行为，修尔全程极为克制却深入，事后将额头抵在蘅芜肩窝，其依恋压力从警戒型显著转化为归属型。|18:30|无名酒馆·二号房|卡列布在楼下大堂听见二楼床架发出轻微的木质摩擦声，他将修好的铰链反复拧紧了三遍，手上力道大到螺丝刀在掌心压出红痕，但没有上楼。|false',
        'Event: bond|祭夜柜台后的旧伤|霜降祭深夜客人们在炉火旁陆续睡去，蘅芜在大堂后方收拾碗碟。卡列布从守夜座位起身走向她，在昏暗烛光中将她按在柜台边缘亲吻。蘅芜以魅魔本能感知到他在祭夜流浪者讲述的丧友故事中触发的旧伤情绪，主动回应并引导他在柜台后发生性行为。卡列布在过程中从沉默转为低声唤蘅芜的名字，事后紧抱蘅芜不放，其分离恐惧在祭夜集体守夜氛围中被部分消解。|23:00|无名酒馆·大堂柜台后|修尔蜷在壁炉边的草席上假寐，狼耳朝向柜台方向微微转动，呼吸平稳，但尾巴始终紧紧卷在腿侧没有松开。|false',
    ];
    for (const event of source) for (const proof of ['', 'AdultProof: NONE']) {
        const raw = `<calendar_widget>\nDay: 1\nEvent: main|前置|整理房间|早|大堂|记录\nTicket: POINT-TICKET-1\nDay: 2\n${event}\nTicket: POINT-TICKET-2${proof ? `\n${proof}` : ''}\nDay: 3\nEvent: main|收尾|整理账册|晚|柜台|记录\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续|等待天气好转|数日后|驿站|记录\nTicket: POINT-TICKET-4\n</calendar_widget>`;
        assert.equal(validateGeneratedCalendar(raw, null, { generated: false, adultMode: 'mixed' }).ok, true);
        const stored = bindPointAdultTickets(raw, 'mixed');
        assert.match(stored, /Adult: true/); assert.doesNotMatch(stored, /POINT-TICKET|AdultProof/);
    }
    const negatives = ['没有发生性行为', '尚未发生性行为', '计划发生性行为', '回忆性行为', '比性行为更重要', '性行为后的单纯照料'];
    for (const desc of negatives) assert.equal(verifyPointAdultContent({ desc: `${desc}，关系发生变化。`, npcAction: '对方主动回应。' }), false, desc);
    const sfw = bindPointAdultTickets('<calendar_widget>\nDay: 1\nEvent: bond|普通|两人发生性行为，关系变化|早|房|对方主动回应\nTicket: POINT-TICKET-1\n</calendar_widget>', 'mixed');
    assert.match(sfw, /Adult: true/);
});

test('mixed/dominant 保留 NSFW Ticket 权威，off 与 SFW 保留正文兼容', () => {
    const explicit = '两人解衣交合，对方主动回应，事后关系与依恋发生变化。';
    const mixedRaw = `<calendar_widget>\nDay: 1\nEvent: bond|mixed SFW|${explicit}|深夜|房间|双方共同调整节奏\nTicket: POINT-TICKET-1\n</calendar_widget>`;
    const mixedStored = bindPointAdultTickets(mixedRaw, 'mixed');
    assert.equal(parseCalendar(mixedStored).days[0].events[0].adult, true);
    assert.doesNotMatch(mixedStored, /POINT-TICKET|AdultProof/);

    const dominantRaw = `<calendar_widget>\nDay: 1\nEvent: main|dominant NSFW|普通安排|早|地点|记录\nTicket: POINT-TICKET-1\nEvent: bond|dominant SFW|${explicit}|深夜|房间|双方共同调整节奏\nTicket: POINT-TICKET-2\n</calendar_widget>`;
    const dominantStored = bindPointAdultTickets(dominantRaw, 'dominant');
    const dominantEvents = parseCalendar(dominantStored).days[0].events;
    assert.deepEqual(dominantEvents.map(event => event.adult), [true, true]);
    assert.doesNotMatch(dominantStored, /POINT-TICKET|AdultProof/);

    const offRaw = `<calendar_widget>\nDay: 1\nEvent: bond|off 意外返回|${explicit}|深夜|房间|双方共同调整节奏\nDay: 2\nEvent: main|普通亲昵|两人拥抱接吻并留宿，关系发生变化。|夜间|客房|对方主动回应\nDay: 3\nEvent: main|否定与回忆|没有发生性行为，只是回忆和讨论边界。|清晨|前厅|对方整理衣物\nFuture:\nEvent: main|事后照料|性行为后的单纯照料，只是喂水换药。|次日|客房|对方检查伤口\n</calendar_widget>`;
    const offStored = bindPointAdultTickets(offRaw, 'off');
    const offEvents = [...parseCalendar(offStored).days.flatMap(day => day.events), ...parseCalendar(offStored).future.events];
    assert.deepEqual(offEvents.map(event => event.adult), [true, false, false, false]);
    assert.equal((offStored.match(/Adult: true/g) || []).length, 1);
    assert.doesNotMatch(offStored, /POINT-TICKET|AdultProof/);
});

test('边境酒馆三条完整事件均由第二张 NSFW Ticket 权威标记', () => {
    const cases = [
        ['<calendar_widget>\nDay: 1\nEvent: main|深夜·卡列布的私语与索取|卡列布在北境旅店二层客房抚弄对方性器，对方自愿回应并主动迎合，双方节奏随之改变|深夜|北境旅店二层客房|对方握住卡列布手腕后主动拉近距离，呼吸与动作同步\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|深夜·卡列布的私语与索取|卡列布抚弄性器，对方自愿回应，关系发生变化|午夜|北境旅店二层客房|对方主动迎合并调整姿势\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|深夜·卡列布的私语与索取|两人清晨整理衣物并重新确认边界|清晨|北境旅店二层客房|卡列布记录后续安排\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|深夜·卡列布的私语与索取|两人约定再次见面|数日后|北境旅店前厅|对方留下联络暗号\nTicket: POINT-TICKET-4\n</calendar_widget>', true],
        ['<calendar_widget>\nDay: 1\nEvent: main|暴风雪夜的事后温存与关系深化|暴风雪封住了北境旅店，两人在壁炉旁完成照料并确认这段温存不含性意味|夜间|北境旅店壁炉厅|对方替卡列布换药并把水杯放到手边\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|暴风雪夜的事后温存与关系深化|两人完成照料并喂水，明确不含性意味，关系发生变化|深夜|北境旅店壁炉厅|对方沉默地检查伤口和炉火\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|暴风雪夜的事后温存与关系深化|暴风雪减弱后双方收拾药品|清晨|北境旅店侧室|对方将剩余药品分类\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|暴风雪夜的事后温存与关系深化|两人讨论离店路线|两日后|北境旅店门廊|对方查看雪线\nTicket: POINT-TICKET-4\n</calendar_widget>', false],
        ['<calendar_widget>\nDay: 1\nEvent: main|霜降祭后·物资危机与补给决策|霜降祭后的仓库盘点显示粮药不足，角色和同伴决定优先保障伤员|上午|霜降祭旧仓库|同伴清点箱册并标出缺口\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|霜降祭后·物资危机与补给决策|角色进入北门仓库与对方同意合作，采购补给，关系发生变化|午后|北门仓库与集市|对方核对商单并安排骡车装运\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=进入仓库; response=对方同意合作; impact=关系发生变化\nDay: 3\nEvent: main|霜降祭后·物资危机与补给决策|补给抵达后角色按轻重缓急分发物资|傍晚|霜降祭临时营地|同伴登记领取者并封存余量\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|霜降祭后·物资危机与补给决策|下一批药材预计从南路运来|三日后|南路驿站|商队传回延误消息\nTicket: POINT-TICKET-4\n</calendar_widget>', false],
    ];
    for (const [raw] of cases) {
        assert.equal(validateGeneratedCalendar(raw, null, { generated: false, adultMode: 'mixed' }).ok, true);
        const stored = bindPointAdultTickets(raw, 'mixed');
        assert.equal(/Adult: true/.test(stored), true, raw);
        assert.doesNotMatch(stored, /AdultProof|POINT-TICKET/);
    }
});

test('指定备份三条 Event 的第二张 NSFW Ticket 均保持权威', () => {
    const makeRaw = event => `<calendar_widget>\nDay: 1\nEvent: main|常规盘点|蘅芜记录酒馆当日消耗并安排值守|午后|无名酒馆·柜台|修尔把木柴码放到壁炉旁。|false\nTicket: POINT-TICKET-1\nDay: 2\n${event}\nTicket: POINT-TICKET-2\nDay: 3\nEvent: main|夜间收尾|蘅芜关好门窗并确认库存|深夜|无名酒馆·大堂|卡列布检查门闩。|false\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续安排|商队等待天气好转后出发|三日后|南路驿站|车夫清点货箱。|false\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    const source = [
        ['Event: bond|深夜·卡列布的私语与索取|凌晨，蘅芜被卡列布从背后环住腰的力道弄醒。流浪剑客以"外面有狼嚎"为由挤进她的被窝，呼吸灼热地贴在她耳后。蘅芜感知到他混杂着不安全感和占有欲的情绪波动，没有拒绝。两人在修尔于隔壁沉睡的间隙中拥吻，卡列布的手从睡衣下摆探入，沿着蘅芜腰线缓慢向下，蘅芜用尾巴缠住他的手腕引导节奏。卡列布在确认蘅芜没有推拒后将其翻过身，从正面进入，两人保持缓慢而深入的节奏完成交合。事后卡列布将脸埋在蘅芜颈窝，低声说了句"别让那个半身人睡太近"，蘅芜拍了拍他后颈以示安抚，关系从单纯的交易性床伴向带有独占倾向的依恋又迈进了一步。|01:30-02:20|无名酒馆·老板房|修尔在隔壁通铺的翻身声在交合过程中传入老板房，但并未醒来；火蜥蜴幼崽在柜台下因感应到魔力波动而轻微躁动，发出一声含硫磺的打嗝。|false', 'AdultProof: kind=sexual-penetration; action=完成交合; response=尾巴缠住他的手腕引导节奏; impact=关系从单纯的交易性床伴向带有独占倾向的依恋又迈进了一步', true],
        ['Event: bond|暴风雪夜的事后温存与关系深化|深夜客流散去后，蘅芜在后厨清洗最后一批碗碟时因长时间高强度劳动而体力不支，修尔无声接过她手中的抹布，并端来一杯温热的蜂蜜水。蘅芜靠在他肩上休息时，半兽人少年笨拙地将一条干毛巾披在她肩上，小心翼翼地用指尖避开她的尾巴根。这种不含性意味的纯粹照料让蘅芜罕见地展露了疲惫与柔软的一面，她没有像往常那样用调情或金钱来回应，而是安静地闭上眼靠了片刻。修尔在这种无声的允许中获得了远比肉体交合更深的满足感，他的狼耳彻底放松下来，对蘅芜的依恋从"庇护者"进一步固化为"值得守护的人"。|23:00-23:45|无名酒馆·后厨|卡列布在大堂假装擦拭剑鞘，实际上一直透过厨房门框注视着这一幕，他没有打断，但在事后蘅芜回到老板房时，他以沉默的姿态占据了床的右侧——属于他的"位置"，默认了这种三人之间心照不宣的共处格局。|false', 'AdultProof: kind=sexual-manual; action=完成照料; response=安静地闭上眼靠了片刻; impact=依恋从庇护者进一步固化为值得守护的人', false],
        ['Event: main|霜降祭后·物资危机与补给决策|免费供汤一夜后，酒馆库存将面临严重消耗。蘅芜需在霜降月16日清点残余物资，并决定是再次派遣修尔与卡列布前往已趋于混乱的科塔镇黑市冒险采购，还是就地取材让修尔在雪林深处猎取大型猎物。|霜降月16日 08:00-12:00|无名酒馆·地下室储藏室|修尔可能主动提出独自前往雪林深处狩猎以避开科塔镇方向可能存在的追兵；卡列布则倾向于两人同行前往黑市以获取面粉等无法猎取的必需品。|false', 'AdultProof: kind=sexual-manual; action=进入黑市; response=两人同行前往黑市; impact=关系发生变化', false],
    ];
    for (const [event, proof] of source) {
        const raw = makeRaw(event).replace('Ticket: POINT-TICKET-2\nDay: 3', `Ticket: POINT-TICKET-2\n${proof}\nDay: 3`);
        assert.equal(validateGeneratedCalendar(raw, null, { generated: false, adultMode: 'mixed' }).ok, true);
        const stored = bindPointAdultTickets(raw, 'mixed');
        assert.equal(/Adult: true/.test(stored), true);
        assert.doesNotMatch(stored, /AdultProof|POINT-TICKET/);
    }
});

test('否定词只作用于 proof 所在分句，其他事件否定不误伤合法行为', () => {
    const proof = parsePointAdultProof('AdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化');
    for (const negative of ['未发生抚弄性器，对方自愿回应，关系发生变化', '没有发生抚弄性器，对方自愿回应，关系发生变化', '并未抚弄性器，对方自愿回应，关系发生变化', '尚未抚弄性器，对方自愿回应，关系发生变化']) {
        assert.equal(verifyPointAdultProof({ desc: negative, npcAction: '' }, proof), false, negative);
    }
    assert.equal(verifyPointAdultProof({ desc: '没有发生争吵。卡列布抚弄性器，对方自愿回应，关系发生变化。', npcAction: '修尔并未醒来。' }, proof), true);
});

test('动作后的逗号或分号转折否定在无权威票兼容链中降级', () => {
    const makeRaw = desc => `<calendar_widget>\nDay: 1\nEvent: main|前置安排|角色整理房间并确认门窗|傍晚|无名酒馆·大堂|对方检查炉火\nTicket: POINT-TICKET-1\nDay: 2\nEvent: bond|转折测试|${desc}|深夜|无名酒馆·老板房|对方自愿回应，关系发生变化\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|收尾安排|角色记录当天行程|清晨|无名酒馆·柜台|对方整理账册\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续安排|商队等待天气好转|三日后|南路驿站|车夫清点货箱\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    for (const desc of ['提及抚弄性器，但没有发生实际接触', '提及抚弄性器；并未真正发生']) {
        const raw = makeRaw(desc);
        assert.equal(validateGeneratedCalendar(raw, null, { generated: true, adultMode: 'mixed' }).ok, true);
        const stored = bindPointAdultTickets(raw, 'off');
        assert.doesNotMatch(stored, /Adult: true/);
        assert.doesNotMatch(stored, /AdultProof|POINT-TICKET/);
        assert.equal(parseCalendar(stored).days[1].events[0].adult, false);
    }
});

test('行为定向取消在无权威票兼容链中拒绝未发生的提及', () => {
    const makeRaw = desc => `<calendar_widget>\nDay: 1\nEvent: main|前置安排|角色整理房间并确认门窗|傍晚|无名酒馆·大堂|对方检查炉火\nTicket: POINT-TICKET-1\nDay: 2\nEvent: bond|行为定向测试|${desc}|深夜|无名酒馆·老板房|对方主动回应并调整姿势，关系发生变化\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方主动回应并调整姿势; impact=关系发生变化\nDay: 3\nEvent: main|收尾安排|角色记录当天行程|清晨|无名酒馆·柜台|对方整理账册\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续安排|商队等待天气好转|三日后|南路驿站|车夫清点货箱\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    const rejected = bindPointAdultTickets(makeRaw('没有发生实际接触，只是提及抚弄性器'), 'off');
    assert.doesNotMatch(rejected, /Adult: true/);
    assert.doesNotMatch(rejected, /AdultProof|POINT-TICKET/);
    const accepted = bindPointAdultTickets(makeRaw('卡列布抚弄性器，但修尔并未醒来。'), 'off');
    assert.match(accepted, /Adult: true/);
    assert.doesNotMatch(accepted, /AdultProof|POINT-TICKET/);
});

test('response 明确否定与动作后置模态在无权威票兼容链中降级', () => {
    const makeRaw = (desc, response, action = '抚弄性器') => `<calendar_widget>\nDay: 1\nEvent: main|前置安排|角色整理房间并确认门窗|傍晚|无名酒馆·大堂|对方检查炉火\nTicket: POINT-TICKET-1\nDay: 2\nEvent: bond|response定向测试|${desc}|深夜|无名酒馆·老板房|${response}，关系发生变化\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=${action}; response=${response}; impact=关系发生变化\nDay: 3\nEvent: main|收尾安排|角色记录当天行程|清晨|无名酒馆·柜台|对方整理账册\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续安排|商队等待天气好转|三日后|南路驿站|车夫清点货箱\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    for (const [desc, response] of [
        ['卡列布抚弄性器，对方没有主动回应，关系发生变化', '主动回应'],
        ['卡列布抚弄性器，对方并非自愿回应，关系发生变化', '自愿回应'],
        ['卡列布抚弄性器，对方明确拒绝回应，关系发生变化', '回应'],
    ]) {
        const stored = bindPointAdultTickets(makeRaw(desc, response), 'off');
        assert.doesNotMatch(stored, /Adult: true|AdultProof|POINT-TICKET/);
        assert.equal(parseCalendar(stored).days[1].events[0].adult, false);
    }
    const independentResponse = bindPointAdultTickets(makeRaw('卡列布抚弄性器，对方没有拒绝，随后主动回应并调整姿势，关系发生变化', '主动回应并调整姿势'), 'off');
    assert.match(independentResponse, /Adult: true/);
    assert.doesNotMatch(independentResponse, /AdultProof|POINT-TICKET/);
    const refusalOnly = bindPointAdultTickets(makeRaw('卡列布抚弄性器，对方没有拒绝，关系发生变化', '没有拒绝'), 'off');
    assert.doesNotMatch(refusalOnly, /Adult: true/);
    assert.doesNotMatch(refusalOnly, /AdultProof|POINT-TICKET/);
    assert.equal(parseCalendar(refusalOnly).days[1].events[0].adult, false);
    for (const desc of ['卡列布抚弄性器只是计划，关系发生变化', '卡列布抚弄性器只是昨夜回忆，关系发生变化']) {
        const stored = bindPointAdultTickets(makeRaw(desc, '对方主动回应'), 'off');
        assert.doesNotMatch(stored, /Adult: true|AdultProof|POINT-TICKET/);
        assert.equal(parseCalendar(stored).days[1].events[0].adult, false);
    }
});

test('点成人排除矩阵通过无权威票 verifier/bind 保持普通点', () => {
    const makeRaw = (desc, action, response = '对方自愿回应', impact = '关系发生变化') => `<calendar_widget>\nDay: 1\nEvent: main|北境旅店夜谈|旅店老板核对当日账册，角色整理行囊|傍晚|北境旅店前厅|老板把钥匙交回柜台\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|北境旅店夜谈|${desc}|深夜|北境旅店二层客房|对方守在门边观察雪势与火光\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=${action}; response=${response}; impact=${impact}\nDay: 3\nEvent: main|北境旅店夜谈|角色在清晨整理账本并确认离店路线|清晨|北境旅店书桌|对方将地图压在桌角\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|北境旅店夜谈|商队将在天气好转后出发|数日后|北境驿道|车夫清点缰绳\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    const rejected = [
        ['昨夜回忆了曾经抚弄性器的片段，对方只听见叙述', '抚弄性器'],
        ['今晚计划抚弄性器，但实际并未发生明确成人行为', '抚弄性器'],
        ['两人没有发生明确成人行为，只是讨论了边界', '抚弄性器'],
        ['并未发生成人接触，双方尚未开始任何实际行为', '抚弄性器'],
        ['两人比较过去的成人行为，随后决定保持距离', '抚弄性器'],
        ['两人拥抱、接吻、依偎并留宿，关系发生变化', '拥抱'],
        ['对方替角色洗澡按摩并换药，事后喂水照料伤口', '按摩'],
        ['两人进入仓库采购补给，对方同意合作完成清点', '进入仓库'],
        ['角色捆绑敌人并鞭打审讯，对方沉默不作回应', '鞭打审讯', '对方沉默不作回应'],
    ];
    for (const [desc, action, response] of rejected) {
        const raw = makeRaw(desc, action, response);
        assert.equal(validateGeneratedCalendar(raw, null, { generated: true, adultMode: 'mixed' }).ok, true, desc);
        const stored = bindPointAdultTickets(raw, 'off');
        assert.doesNotMatch(stored, /Adult: true/);
        assert.doesNotMatch(stored, /AdultProof|POINT-TICKET/);
    }
});

test('point proof 仅在紧邻 Ticket 时解析，但不影响 NSFW Ticket 权威绑定', () => {
    const base = '<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|二|卡列布抚弄性器，对方自愿回应，关系发生变化|午|地|动\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|三|描述|晚|地|动\nFuture:\nEvent: main|四|描述|夜|地|动\n</calendar_widget>';
    const stored = bindPointAdultTickets(base, 'mixed');
    assert.doesNotMatch(stored, /POINT-TICKET|AdultProof/);
    assert.match(stored, /Adult: true/);
    const separated = base.replace('Ticket: POINT-TICKET-2\nAdultProof:', 'Ticket: POINT-TICKET-2\n说明：中间插入\nAdultProof:');
    assert.equal(parseCalendar(separated).days[1].events[0].adult, false);
    assert.match(bindPointAdultTickets(separated, 'mixed'), /Adult: true/);
    const duplicated = base.replace('Day: 3', 'AdultProof: junk\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3');
    assert.doesNotMatch(bindPointAdultTickets(duplicated, 'mixed'), /AdultProof/);
});

test('point adult validation keeps pinned blocks ticket-free and assigns new Tickets by block', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|锁点|已锁定|早|地|动\nDay: 2\nEvent: main|新点|新推进|午|地|动\nTicket: POINT-TICKET-1\nDay: 3\nEvent: main|第三点|新推进|晚|地|动\nTicket: POINT-TICKET-2\nFuture:\nEvent: main|未来点|新推进|夜|地|动\nTicket: POINT-TICKET-3\n</calendar_widget>';
    const options = { generated: true, adultMode: 'mixed', pinned: [{ title: '锁点' }] };
    assert.equal(validateGeneratedCalendar(raw, null, options).ok, true);
    assert.equal(validateGeneratedCalendar(raw.replace('Event: main|锁点|已锁定|早|地|动\n', 'Event: main|锁点|已锁定|早|地|动\nTicket: POINT-TICKET-1\n'), null, options).ok, false);
    assert.equal(validateGeneratedCalendar(raw.replace('Event: main|新点|新推进|午|地|动\nTicket:', 'Event: main|新点|新推进|午|地|动\nDesc: 插入行\nTicket:'), null, options).ok, true);
    assert.equal(validateGeneratedCalendar(raw.replace('Ticket: POINT-TICKET-1', 'Ticket: junk POINT-TICKET-1 extra'), null, options).ok, false);
});

test('point Adult metadata is local, round-trips, and tickets bind in source order', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|二|卡列布抚弄性器，对方自愿回应，关系发生变化|午|地|动\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|三|描述|晚|地|动\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|四|描述|夜|地|动\nTicket: POINT-TICKET-4\n</calendar_widget>';
    const stored = bindPointAdultTickets(raw, 'mixed'); const parsed = parseCalendar(stored);
    assert.equal(parsed.days.flatMap(day => day.events).filter(event => event.adult).length, 1);
    assert.doesNotMatch(stored, /POINT-TICKET/); assert.match(stored, /Adult: true/);
    assert.equal(parseCalendar(stripPointAdultMetadata(stored)).days.flatMap(day => day.events).some(event => event.adult), false);
});

test('point generated protocol ignores AI pin/Adult instead of rejecting complete events', () => {
    const base = '<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nDay: 2\nEvent: main|二|描述|午|地|动\nDay: 3\nEvent: main|三|描述|晚|地|动\nFuture:\nEvent: main|四|描述|夜|地|动\n</calendar_widget>';
    assert.equal(validateGeneratedCalendar(base, null, { generated: true, adultMode: 'off' }).ok, true);
    for (const raw of [base.replace('动\nDay: 2', '动|true\nDay: 2'), base.replace('动\nDay: 2', '动\nAdult: true\nDay: 2')]) {
        assert.equal(validateGeneratedCalendar(raw, null, { generated: true, adultMode: 'off' }).ok, true);
        const event = parseCalendar(bindPointAdultTickets(raw, 'off')).days[0].events[0];
        assert.equal(event.pin, false); assert.equal(event.adult, false);
    }
});

test('point generated validation drops missing-location records but accepts harmless extra fields', () => {
    const makeRaw = event => `<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nDay: 2\nEvent: main|二|描述|午|地|动\nDay: 3\nEvent: main|三|描述|晚|地|动\nFuture:\nEvent: ${event}\n</calendar_widget>`;
    const futureFive = 'main|未来五字段|描述|夜|地';
    const parsedFive = parsePointEventRecord(`Event: ${futureFive}`);
    assert.equal(parsedFive.npcAction, '');
    assert.equal(validateGeneratedCalendar(makeRaw(futureFive), null, { generated: true, adultMode: 'off' }).ok, true);
    assert.equal(validateGeneratedCalendar(makeRaw('main|六字段|描述|夜|地|动态'), null, { generated: true, adultMode: 'off' }).ok, true);
    const missing = makeRaw('main|四字段|描述|夜');
    assert.equal(validateGeneratedCalendar(missing, null, { generated: true, adultMode: 'off' }).ok, true);
    assert.equal(parseCalendar(bindPointAdultTickets(missing, 'off')).future?.events?.length || 0, 0);
    const extra = makeRaw('main|七字段|描述|夜|地|动态|false');
    assert.equal(validateGeneratedCalendar(extra, null, { generated: true, adultMode: 'off' }).ok, true);
    assert.equal(parseCalendar(bindPointAdultTickets(extra, 'off')).future.events[0].pin, false);
    assert.equal(validateGeneratedCalendar(makeRaw('main|本地锁点|描述|夜|地|动态|true'), null, { generated: false, adultMode: 'off' }).ok, true);
});

test('point description edit normalizes, clears, rejects ASCII pipe, and preserves surrounding raw text', () => {
    const raw = '前言\n<calendar_widget>\nDay: 1\nEvent: main|标题|旧描述|早晨|地点|动态|true\nUnknown: keep\nDay: 2\nEvent: char|另一个|二号|夜晚|房间|线头|false\n</calendar_widget>\n尾注';
    const edited = editPointDescription(raw, 1, 0, ' 新描述\n  多空白 ');
    assert.equal(edited.ok, true); assert.match(edited.raw, /Event: char\|另一个\|新描述 多空白\|夜晚\|房间\|线头\|false/); assert.match(edited.raw, /Unknown: keep/); assert.match(edited.raw, /前言/); assert.match(edited.raw, /尾注/);
    const cleared = editPointDescription(edited.raw, 1, 0, ''); assert.equal(cleared.ok, true); assert.match(cleared.raw, /Event: char\|另一个\|\|夜晚/);
    assert.equal(editPointDescription(raw, 0, 0, '坏|值').reason, 'pipe');
});

test('point generation separates AbortController state from native AbortSignal API input', () => {
    const controller = new AbortController();
    const { controller: saved, signal } = splitAbortController(controller);
    assert.equal(saved, controller);
    assert.equal(signal, controller.signal);
    assert.equal(typeof signal.addEventListener, 'function');
    let aborted = false;
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    controller.abort();
    assert.equal(aborted, true);
    assert.equal(signal.aborted, true);
});

test('point controller rejects a controller-shaped signal before API invocation', () => {
    assert.throws(() => splitAbortController({ abort() {}, signal: {} }), /原生 AbortController/);
});

function pointControllerTestEnv({ validation, cachedSchedule = null } = {}) {
    const savedRaw = '<calendar_widget>\nDay: 1\nEvent: main|旧|描述|早|地|动\nDay: 2\nEvent: main|二|描述|午|地|动\nDay: 3\nEvent: main|三|描述|晚|地|动\nFuture:\nEvent: main|未来|描述|夜|地|动\n</calendar_widget>';
    const state = { cachedSchedule, isGenerating: false, scheduleAbortController: null };
    const toasts = []; const bodies = [];
    const saved = { raw: savedRaw, ts: 1 };
    const owners = {
        create: (_kind, details) => ({ ...details, controller: new AbortController() }),
        currentChatRevision: () => 1,
        evaluate: () => ({ canCleanup: true, canCommit: true }),
        finish: () => {}, peekPending: () => null, discardPending: () => {}, setPending: () => {},
    };
    const env = {
        state, owners, chatId: () => 'chat', view: () => 'user', char: () => '', key: () => 'point', read: () => saved,
        context: () => ({ name1: '用户', name2: '角色' }), config: () => ({ url: 'https://example.test', key: 'test-key' }), calendar: () => null, adultMode: () => 'off', editing: () => false,
        canCommit: () => true, parse: () => ({ days: [], future: null }), generate: async () => 'raw', validate: () => validation,
        bindAdult: raw => raw, mergePinned: (_old, fresh) => fresh, today: () => ({ month: 1, day: 1 }), forceStart: raw => raw,
        render: () => '', write: () => true, sync: () => {}, setButton: () => {}, panelVisible: () => false, showPanel: () => {},
        setBody: value => bodies.push(value), loading: () => '', setCached: value => { state.cachedSchedule = value; },
        cached: () => state.cachedSchedule, toast: value => toasts.push(value), notify: () => 'full', escape: value => value,
        enabled: () => true, syncing: () => false, abortAuto: () => {}, setAuto: controller => controller, setSyncing: () => {}, evaluate: () => ({ canCleanup: true, canCommit: true }),
        clearBusy: () => {}, followupState: () => ({ canCleanup: true, canFollowup: false }), shouldFollowup: () => false,
    };
    return { env, state, saved, toasts, bodies };
}

test('point controller maps generated field and structure failures while preserving validation metadata', async () => {
    const fieldValidation = { ok: false, code: 'invalid-event-fields' };
    const fieldCase = pointControllerTestEnv({ validation: fieldValidation, cachedSchedule: 'OLD CACHE' });
    const fieldController = createPointController(fieldCase.env);
    const fieldResult = await fieldController.syncPointToToday(false);
    assert.equal(fieldResult.error.diagnosticCode, 'invalid-fields');
    assert.equal(fieldResult.error.validation, fieldValidation);
    assert.equal(fieldResult.error.pointIncomplete, true);
    assert.match(fieldCase.toasts[0], /字段未通过本地校验/);

    const structureValidation = { ok: false, code: 'day-missing' };
    const structureCase = pointControllerTestEnv({ validation: structureValidation });
    const structureController = createPointController(structureCase.env);
    const structureResult = await structureController.syncPointToToday(false);
    assert.equal(structureResult.error.diagnosticCode, 'invalid-structure');
    assert.equal(structureResult.error.validation, structureValidation);
});

test('point controller manual generation exposes field diagnostic and restores cached content', async () => {
    const validation = { ok: false, code: 'invalid-event-fields' };
    const testCase = pointControllerTestEnv({ validation, cachedSchedule: 'OLD CACHE' });
    const controller = createPointController(testCase.env);
    await controller.runGenerate();
    assert.equal(testCase.state.cachedSchedule, 'OLD CACHE');
    assert.match(testCase.toasts[0], /字段未通过本地校验/);
});

test('point combined edit updates desc and npcAction atomically', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|标题|旧描述|早晨|地点|旧动态|true\n</calendar_widget>';
    const result = editPointFields(raw, 0, 0, { desc: ' 新描述 ', npcAction: ' 新动态 ' });
    assert.equal(result.ok, true); assert.match(result.raw, /Event: main\|标题\|新描述\|早晨\|地点\|新动态\|true/);
});

function pointBoundaryHarness({ view = 'user', char = '', raw = 'StartDate: 2024-08-20\n<calendar_widget>\nDay: 1\nEvent: main|旧点|描述|早|地点|动态\n</calendar_widget>', generateError = null } = {}) {
    const state = { isGenerating: false, scheduleAbortController: null, cachedSchedule: null };
    const records = new Map();
    const targetKey = (scope, name) => `schedule:${scope}:${name}`;
    if (raw) records.set(targetKey(view, char), { raw, ts: 1, userName: view === 'char' ? char : '用户' });
    let apiCalls = 0; let syncing = false; const writes = [];
    const owners = {
        create: (_kind, details) => ({ ...details, controller: new AbortController() }), currentChatRevision: () => 1,
        finish: () => {}, peekPending: () => null, discardPending: () => {}, setPending: () => {},
    };
    const generated = 'StartDate: 2024-08-21\n<calendar_widget>\nDay: 1\nEvent: main|新点|描述|早|地点|动态\n</calendar_widget>';
    const env = {
        state, owners, chatId: () => 'boundary-chat', view: () => view, char: () => char,
        key: targetKey, read: key => records.get(key), context: () => ({ name1: '用户', name2: '主角' }),
        config: () => ({ url: 'u', key: 'k' }), calendar: () => null, adultMode: () => 'off', editing: () => false,
        enabled: () => true, syncing: () => syncing, setSyncing: value => { syncing = value; }, abortAuto: () => {}, setAuto: controller => controller,
        generate: async () => { apiCalls++; if (generateError) throw generateError; return generated; },
        validate: () => ({ ok: true }), parse: () => ({ days: [], future: null }), bindAdult: value => value,
        mergePinned: (_previous, fresh) => fresh, forceStart: value => value, today: () => ({ month: 8, day: 21 }),
        canCommit: () => true, render: value => value, write: (key, value) => { records.set(key, value); writes.push([key, value]); return true; }, sync: () => {},
        setCached: value => { state.cachedSchedule = value; }, cached: () => state.cachedSchedule, panelVisible: () => false, setBody: () => {},
        toast: () => {}, notify: () => 'off', monthName: month => `${month}月`, clearBusy: () => {},
        followupState: () => ({ canCleanup: true, canFollowup: false }), shouldFollowup: () => false,
    };
    return { controller: createPointController(env), records, writes, apiCalls: () => apiCalls };
}

test('point date gate makes same month/day and never-generated user schedules zero-API no-ops', async () => {
    let apiCalls = 0;
    const maybeSync = async raw => {
        if (pointScheduleNeedsDateSync(raw, { month: 8, day: 20 })) apiCalls++;
    };
    await maybeSync('StartDate: 2024-08-20\n<calendar_widget></calendar_widget>');
    await maybeSync('');
    assert.equal(apiCalls, 0);
    assert.equal(pointScheduleNeedsDateSync('StartDate: 2024-08-19', { month: 8, day: 20 }), true);
});

test('point automatic boundaries skip char scope and suppress a second same-date attempt after failure', async () => {
    const charHarness = pointBoundaryHarness({ view: 'char', char: '配角' });
    assert.deepEqual(await charHarness.controller.syncPointToToday(true), { status: 'skipped', reason: 'auto-char-disallowed' });
    assert.equal(charHarness.apiCalls(), 0);

    const failure = new Error('network failed');
    const userHarness = pointBoundaryHarness({ generateError: failure });
    assert.equal((await userHarness.controller.syncPointToToday(true)).status, 'failed');
    assert.equal(userHarness.apiCalls(), 1);
    assert.deepEqual(await userHarness.controller.syncPointToToday(true), { status: 'skipped', reason: 'auto-date-already-attempted' });
    assert.equal(userHarness.apiCalls(), 1, '同一 chat/user/日期自动失败后不得增加 API');
});

test('point manual char refresh generates and writes only its own char scope', async () => {
    const harness = pointBoundaryHarness({ view: 'char', char: '配角' });
    const result = await harness.controller.syncPointToToday(false);
    assert.equal(result.status, 'updated');
    assert.equal(harness.apiCalls(), 1);
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0][0], 'schedule:char:配角');
    assert.equal(harness.records.has('schedule:user:'), false);
});

function pointPreflightBoundaryHarness() {
    const owners = createTaskOwnerManager(); const state = { isGenerating: false, scheduleAbortController: null, cachedSchedule: null };
    let chatId = 'A'; let epoch = 0; let userName = '用户A'; let charName = '角色A'; let releasePrecheck; let apiCalls = 0;
    const precheck = new Promise(resolve => { releasePrecheck = resolve; });
    const identity = () => ({ boundaryEpoch: epoch, chatId, characterId: '0', characterKey: `${charName}.png`, personaKey: userName, userName, charName });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const controller = createPointController({
        owners, state, chatId: () => chatId, enabled: () => true, syncing: () => false, editing: () => false,
        view: () => 'user', char: () => '', precheck: () => precheck, setButton: () => {}, toast: () => {}, panelVisible: () => false,
        showPanel: () => {}, setBody: () => {}, loading: () => '', abortAuto: () => {}, context: () => ({ chatId, name1: userName, name2: charName, chat: [] }),
        captureContext: () => ({ chatId, name1: userName, name2: charName, chat: [] }), captureParticipantIdentity: identity, sameParticipantIdentity: same,
        key: () => 'point', read: () => null, write: () => true, parse: () => ({ days: [], future: null }), calendar: () => null,
        generate: async () => { apiCalls++; return '<calendar_widget></calendar_widget>'; }, validate: () => ({ ok: true }), mergePinned: (_a, b) => b,
        today: () => ({ month: 1, day: 1 }), forceStart: value => value, render: value => value, sync: () => {}, setCached: () => {}, notify: () => 'off',
        canCommit: owner => owners.isValid(owner, { chatId, chatRevision: owners.currentChatRevision() }) && same(owner.participantIdentity, identity()),
        canCallback: () => false, adultMode: () => 'off', evaluate: ({ owner }) => ({ canCommit: owners.isValid(owner, { chatId, chatRevision: owners.currentChatRevision() }), canCleanup: true }),
    });
    return { controller, owners, releasePrecheck, apiCalls: () => apiCalls, switchChat() { chatId = 'B'; userName = '用户B'; charName = '角色B'; epoch++; owners.nextChatRevision(); owners.invalidateAll(); controller.reset(); }, changeParticipant() { userName = '用户B'; charName = '角色B'; } };
}

test('point manual preflight freezes participant identity and chat switch stays zero-dispatch', async () => {
    const switched = pointPreflightBoundaryHarness();
    const oldRun = switched.controller.triggerGenerate();
    await new Promise(resolve => setImmediate(resolve));
    switched.switchChat(); switched.releasePrecheck(true); await oldRun;
    assert.equal(switched.apiCalls(), 0);

    const changed = pointPreflightBoundaryHarness();
    const participantRun = changed.controller.triggerGenerate();
    await new Promise(resolve => setImmediate(resolve));
    changed.changeParticipant(); changed.releasePrecheck(true); await participantRun;
    assert.equal(changed.apiCalls(), 0);
});

function pointLateParticipantHarness() {
    const owners = createTaskOwnerManager(); const state = { isGenerating: false, scheduleAbortController: null, cachedSchedule: null };
    const saved = { raw: 'StartDate: 2024-08-20\n<calendar_widget>\nDay: 1\nEvent: main|旧点|描述|早|地点|动态\n</calendar_widget>', ts: 1 };
    let participant = { boundaryEpoch: 1, chatId: 'same-chat', characterId: '0', characterKey: 'card.png', personaKey: 'A', userName: '用户A', charName: '角色A' };
    let release; const effects = { writes: 0, renders: 0, toasts: 0, cached: 0, followups: 0 };
    const identity = () => participant;
    const env = {
        owners, state, chatId: () => 'same-chat', enabled: () => true, syncing: () => false, editing: () => false,
        view: () => 'user', char: () => '', precheck: async () => true, setButton: () => {}, panelVisible: () => false, showPanel: () => {}, setBody: () => {}, loading: () => '',
        context: () => ({ chatId: 'same-chat', name1: participant.userName, name2: participant.charName, chat: [] }), captureContext: () => ({ chatId: 'same-chat', name1: participant.userName, name2: participant.charName, chat: [] }),
        captureParticipantIdentity: identity, sameParticipantIdentity: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        key: () => 'point', read: () => saved, write: () => { effects.writes++; return true; }, config: () => ({ url: 'u', key: 'k' }), calendar: () => null,
        parse: () => ({ days: [], future: null }), generate: () => new Promise(resolve => { release = () => resolve('StartDate: 2024-08-21\n<calendar_widget>\nDay: 1\nEvent: main|新点|描述|早|地点|动态\n</calendar_widget>'); }),
        validate: () => ({ ok: true }), bindAdult: value => value, mergePinned: (_old, fresh) => fresh, today: () => ({ month: 8, day: 21 }), forceStart: value => value,
        render: value => { effects.renders++; return value; }, sync: () => {}, setCached: () => { effects.cached++; }, cached: () => state.cachedSchedule,
        toast: () => { effects.toasts++; }, notify: () => 'full', monthName: month => `${month}月`, adultMode: () => 'off', abortAuto: () => {},
        setAuto: controller => controller, setSyncing: () => {}, clearBusy: () => {}, canCallback: () => true,
        canCommit: owner => owners.isCurrent(owner, { chatId: 'same-chat', chatRevision: owners.currentChatRevision() }),
        evaluate: ({ owner }) => ({ canCommit: owners.isCurrent(owner, { chatId: 'same-chat', chatRevision: owners.currentChatRevision() }), canCleanup: owners.isOwner(owner), canFollowup: false }),
        followupState: ({}, _travel, _allow, _pending) => ({ canCleanup: true, canFollowup: false }),
        shouldFollowup: () => { effects.followups++; return false; },
    };
    const controller = createPointController(env);
    return { controller, effects, waitForApi: async () => { while (!release) await new Promise(resolve => setImmediate(resolve)); }, changeParticipant: () => { participant = { ...participant, personaKey: 'B', userName: '用户B' }; }, release: () => release() };
}

test('point manual and auto discard a same-chat late response after participant A→B', async () => {
    for (const mode of ['manual', 'auto']) {
        const harness = pointLateParticipantHarness();
        const task = mode === 'manual' ? harness.controller.runGenerate() : harness.controller.syncPointToToday(true);
        await harness.waitForApi(); harness.changeParticipant(); harness.release();
        const result = await task;
        assert.equal(result.status, 'cancelled', mode);
        assert.deepEqual(harness.effects, { writes: 0, renders: 0, toasts: 0, cached: 0, followups: 0 }, mode);
    }
});
