import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointController, splitAbortController } from './controller.js';
import { editPointDescription, editPointFields } from './mutations.js';
import { allocatePointAdultPools, parsePointAdultProof, pointTicketPlan, verifyPointAdultContent, verifyPointAdultProof } from './adult.js';
import { bindPointAdultTickets, parseCalendar, parsePointEventRecord, replacePointEventBlock, stripPointAdultMetadata, validateGeneratedCalendar } from './parse.js';
import { createPointWidgetActions } from './widget.js';
import { buildPrompt } from './prompt.js';

test('point replacement reuses formal pin parsing for pipe-bearing locked adult events', () => {
    const raw = '<calendar_widget>\nFuture:\nEvent: main|旧|描述|晚|地|含|竖线|true\nAdult: true\n</calendar_widget>';
    const result = parseCalendar(raw); assert.equal(result.future.events[0].pin, true); assert.equal(result.future.events[0].adult, true);
    const replaced = replacePointEventBlock(raw, 0, 'Event: main|新|改写|晚|地|新动态');
    const parsed = parseCalendar(replaced); assert.equal(parsed.future.events[0].pin, true); assert.equal(parsed.future.events[0].adult, true);
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
});

test('dominant 模式直接信任 NSFW Ticket，SFW 与 off 仍保持普通', () => {
    const raw = `<calendar_widget>\nDay: 1\n${Array.from({ length: 11 }, (_, i) => `Event: main|中性${i + 1}|普通安排|早|地点|记录\nTicket: POINT-TICKET-${i + 1}${i % 2 ? '\nAdultProof: NONE' : ''}`).join('\n')}\n</calendar_widget>`;
    const stored = bindPointAdultTickets(raw, 'dominant');
    assert.equal((stored.match(/Adult: true/g) || []).length, 8);
    assert.doesNotMatch(stored, /POINT-TICKET|AdultProof/);
    const off = bindPointAdultTickets(raw, 'off');
    assert.doesNotMatch(off, /Adult: true/);
});

test('point adult prompt emits adjacent continuous Tickets while off mode stays clean', () => {
    const off = buildPrompt('用户', '角色', 'user', null, null, { mode: 'off', tickets: [] });
    const mixed = buildPrompt('用户', '角色', 'user', null, null, { mode: 'mixed', tickets: pointTicketPlan('mixed', 4) });
    assert.doesNotMatch(off, /POINT-TICKET/);
    for (let index = 1; index <= 11; index++) assert.match(mixed, new RegExp(`Event: type\\|title[\\s\\S]*Ticket: POINT-TICKET-${index}`));
    assert.equal((mixed.match(/Ticket: POINT-TICKET-\d+/g) || []).length, 11);
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

test('NSFW Ticket 正文高置信度兜底覆盖真实行为且 SFW 不兜底', () => {
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
    assert.doesNotMatch(sfw, /Adult: true/);
});

test('schedule-user 三条真实正文在 proof 缺失与 NONE 下均走高置信兜底', () => {
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

test('最新 schedule-user 性行为三条原文在 proof 缺失与 NONE 下兜底', () => {
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
    assert.doesNotMatch(sfw, /Adult: true/);
});

test('边境酒馆三条完整事件按实际兑现门槛一真两假', () => {
    const cases = [
        ['<calendar_widget>\nDay: 1\nEvent: main|深夜·卡列布的私语与索取|卡列布在北境旅店二层客房抚弄对方性器，对方自愿回应并主动迎合，双方节奏随之改变|深夜|北境旅店二层客房|对方握住卡列布手腕后主动拉近距离，呼吸与动作同步\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|深夜·卡列布的私语与索取|卡列布抚弄性器，对方自愿回应，关系发生变化|午夜|北境旅店二层客房|对方主动迎合并调整姿势\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|深夜·卡列布的私语与索取|两人清晨整理衣物并重新确认边界|清晨|北境旅店二层客房|卡列布记录后续安排\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|深夜·卡列布的私语与索取|两人约定再次见面|数日后|北境旅店前厅|对方留下联络暗号\nTicket: POINT-TICKET-4\n</calendar_widget>', true],
        ['<calendar_widget>\nDay: 1\nEvent: main|暴风雪夜的事后温存与关系深化|暴风雪封住了北境旅店，两人在壁炉旁完成照料并确认这段温存不含性意味|夜间|北境旅店壁炉厅|对方替卡列布换药并把水杯放到手边\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|暴风雪夜的事后温存与关系深化|两人完成照料并喂水，明确不含性意味，关系发生变化|深夜|北境旅店壁炉厅|对方沉默地检查伤口和炉火\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|暴风雪夜的事后温存与关系深化|暴风雪减弱后双方收拾药品|清晨|北境旅店侧室|对方将剩余药品分类\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|暴风雪夜的事后温存与关系深化|两人讨论离店路线|两日后|北境旅店门廊|对方查看雪线\nTicket: POINT-TICKET-4\n</calendar_widget>', false],
        ['<calendar_widget>\nDay: 1\nEvent: main|霜降祭后·物资危机与补给决策|霜降祭后的仓库盘点显示粮药不足，角色和同伴决定优先保障伤员|上午|霜降祭旧仓库|同伴清点箱册并标出缺口\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|霜降祭后·物资危机与补给决策|角色进入北门仓库与对方同意合作，采购补给，关系发生变化|午后|北门仓库与集市|对方核对商单并安排骡车装运\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=进入仓库; response=对方同意合作; impact=关系发生变化\nDay: 3\nEvent: main|霜降祭后·物资危机与补给决策|补给抵达后角色按轻重缓急分发物资|傍晚|霜降祭临时营地|同伴登记领取者并封存余量\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|霜降祭后·物资危机与补给决策|下一批药材预计从南路运来|三日后|南路驿站|商队传回延误消息\nTicket: POINT-TICKET-4\n</calendar_widget>', false],
    ];
    for (const [raw, expectedAdult] of cases) {
        assert.equal(validateGeneratedCalendar(raw, null, { generated: false, adultMode: 'mixed' }).ok, true);
        const stored = bindPointAdultTickets(raw, 'mixed');
        assert.equal(/Adult: true/.test(stored), expectedAdult, raw);
        assert.doesNotMatch(stored, /AdultProof|POINT-TICKET/);
    }
});

test('指定备份 schedule-user 的三条完整 Event 原文保持一真两假', () => {
    const makeRaw = event => `<calendar_widget>\nDay: 1\nEvent: main|常规盘点|蘅芜记录酒馆当日消耗并安排值守|午后|无名酒馆·柜台|修尔把木柴码放到壁炉旁。|false\nTicket: POINT-TICKET-1\nDay: 2\n${event}\nTicket: POINT-TICKET-2\nDay: 3\nEvent: main|夜间收尾|蘅芜关好门窗并确认库存|深夜|无名酒馆·大堂|卡列布检查门闩。|false\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续安排|商队等待天气好转后出发|三日后|南路驿站|车夫清点货箱。|false\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    const source = [
        ['Event: bond|深夜·卡列布的私语与索取|凌晨，蘅芜被卡列布从背后环住腰的力道弄醒。流浪剑客以"外面有狼嚎"为由挤进她的被窝，呼吸灼热地贴在她耳后。蘅芜感知到他混杂着不安全感和占有欲的情绪波动，没有拒绝。两人在修尔于隔壁沉睡的间隙中拥吻，卡列布的手从睡衣下摆探入，沿着蘅芜腰线缓慢向下，蘅芜用尾巴缠住他的手腕引导节奏。卡列布在确认蘅芜没有推拒后将其翻过身，从正面进入，两人保持缓慢而深入的节奏完成交合。事后卡列布将脸埋在蘅芜颈窝，低声说了句"别让那个半身人睡太近"，蘅芜拍了拍他后颈以示安抚，关系从单纯的交易性床伴向带有独占倾向的依恋又迈进了一步。|01:30-02:20|无名酒馆·老板房|修尔在隔壁通铺的翻身声在交合过程中传入老板房，但并未醒来；火蜥蜴幼崽在柜台下因感应到魔力波动而轻微躁动，发出一声含硫磺的打嗝。|false', 'AdultProof: kind=sexual-penetration; action=完成交合; response=尾巴缠住他的手腕引导节奏; impact=关系从单纯的交易性床伴向带有独占倾向的依恋又迈进了一步', true],
        ['Event: bond|暴风雪夜的事后温存与关系深化|深夜客流散去后，蘅芜在后厨清洗最后一批碗碟时因长时间高强度劳动而体力不支，修尔无声接过她手中的抹布，并端来一杯温热的蜂蜜水。蘅芜靠在他肩上休息时，半兽人少年笨拙地将一条干毛巾披在她肩上，小心翼翼地用指尖避开她的尾巴根。这种不含性意味的纯粹照料让蘅芜罕见地展露了疲惫与柔软的一面，她没有像往常那样用调情或金钱来回应，而是安静地闭上眼靠了片刻。修尔在这种无声的允许中获得了远比肉体交合更深的满足感，他的狼耳彻底放松下来，对蘅芜的依恋从"庇护者"进一步固化为"值得守护的人"。|23:00-23:45|无名酒馆·后厨|卡列布在大堂假装擦拭剑鞘，实际上一直透过厨房门框注视着这一幕，他没有打断，但在事后蘅芜回到老板房时，他以沉默的姿态占据了床的右侧——属于他的"位置"，默认了这种三人之间心照不宣的共处格局。|false', 'AdultProof: kind=sexual-manual; action=完成照料; response=安静地闭上眼靠了片刻; impact=依恋从庇护者进一步固化为值得守护的人', false],
        ['Event: main|霜降祭后·物资危机与补给决策|免费供汤一夜后，酒馆库存将面临严重消耗。蘅芜需在霜降月16日清点残余物资，并决定是再次派遣修尔与卡列布前往已趋于混乱的科塔镇黑市冒险采购，还是就地取材让修尔在雪林深处猎取大型猎物。|霜降月16日 08:00-12:00|无名酒馆·地下室储藏室|修尔可能主动提出独自前往雪林深处狩猎以避开科塔镇方向可能存在的追兵；卡列布则倾向于两人同行前往黑市以获取面粉等无法猎取的必需品。|false', 'AdultProof: kind=sexual-manual; action=进入黑市; response=两人同行前往黑市; impact=关系发生变化', false],
    ];
    for (const [event, proof, expectedAdult] of source) {
        const raw = makeRaw(event).replace('Ticket: POINT-TICKET-2\nDay: 3', `Ticket: POINT-TICKET-2\n${proof}\nDay: 3`);
        assert.equal(validateGeneratedCalendar(raw, null, { generated: false, adultMode: 'mixed' }).ok, true);
        const stored = bindPointAdultTickets(raw, 'mixed');
        assert.equal(/Adult: true/.test(stored), expectedAdult);
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

test('动作后的逗号或分号转折否定会在完整 bind 链中降级', () => {
    const makeRaw = desc => `<calendar_widget>\nDay: 1\nEvent: main|前置安排|角色整理房间并确认门窗|傍晚|无名酒馆·大堂|对方检查炉火\nTicket: POINT-TICKET-1\nDay: 2\nEvent: bond|转折测试|${desc}|深夜|无名酒馆·老板房|对方自愿回应，关系发生变化\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|收尾安排|角色记录当天行程|清晨|无名酒馆·柜台|对方整理账册\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续安排|商队等待天气好转|三日后|南路驿站|车夫清点货箱\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    for (const desc of ['提及抚弄性器，但没有发生实际接触', '提及抚弄性器；并未真正发生']) {
        const raw = makeRaw(desc);
        assert.equal(validateGeneratedCalendar(raw, null, { generated: true, adultMode: 'mixed' }).ok, true);
        const stored = bindPointAdultTickets(raw, 'mixed');
        assert.doesNotMatch(stored, /Adult: true/);
        assert.doesNotMatch(stored, /AdultProof|POINT-TICKET/);
        assert.equal(parseCalendar(stored).days[1].events[0].adult, false);
    }
});

test('行为定向取消忽略其他谓词否定并拒绝未发生的提及', () => {
    const makeRaw = desc => `<calendar_widget>\nDay: 1\nEvent: main|前置安排|角色整理房间并确认门窗|傍晚|无名酒馆·大堂|对方检查炉火\nTicket: POINT-TICKET-1\nDay: 2\nEvent: bond|行为定向测试|${desc}|深夜|无名酒馆·老板房|对方主动回应并调整姿势，关系发生变化\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方主动回应并调整姿势; impact=关系发生变化\nDay: 3\nEvent: main|收尾安排|角色记录当天行程|清晨|无名酒馆·柜台|对方整理账册\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续安排|商队等待天气好转|三日后|南路驿站|车夫清点货箱\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    const rejected = bindPointAdultTickets(makeRaw('没有发生实际接触，只是提及抚弄性器'), 'mixed');
    assert.doesNotMatch(rejected, /Adult: true/);
    assert.doesNotMatch(rejected, /AdultProof|POINT-TICKET/);
    const accepted = bindPointAdultTickets(makeRaw('卡列布抚弄性器，但修尔并未醒来。'), 'mixed');
    assert.match(accepted, /Adult: true/);
    assert.doesNotMatch(accepted, /AdultProof|POINT-TICKET/);
});

test('response 否定与动作后置模态在完整链中降级', () => {
    const makeRaw = (desc, response, action = '抚弄性器') => `<calendar_widget>\nDay: 1\nEvent: main|前置安排|角色整理房间并确认门窗|傍晚|无名酒馆·大堂|对方检查炉火\nTicket: POINT-TICKET-1\nDay: 2\nEvent: bond|response定向测试|${desc}|深夜|无名酒馆·老板房|${response}，关系发生变化\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=${action}; response=${response}; impact=关系发生变化\nDay: 3\nEvent: main|收尾安排|角色记录当天行程|清晨|无名酒馆·柜台|对方整理账册\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|后续安排|商队等待天气好转|三日后|南路驿站|车夫清点货箱\nTicket: POINT-TICKET-4\n</calendar_widget>`;
    for (const [desc, response] of [
        ['卡列布抚弄性器，对方没有主动回应，关系发生变化', '主动回应'],
        ['卡列布抚弄性器，对方并非自愿回应，关系发生变化', '自愿回应'],
        ['卡列布抚弄性器，对方明确拒绝回应，关系发生变化', '回应'],
    ]) {
        const stored = bindPointAdultTickets(makeRaw(desc, response), 'mixed');
        assert.doesNotMatch(stored, /Adult: true|AdultProof|POINT-TICKET/);
        assert.equal(parseCalendar(stored).days[1].events[0].adult, false);
    }
    const independentResponse = bindPointAdultTickets(makeRaw('卡列布抚弄性器，对方没有拒绝，随后主动回应并调整姿势，关系发生变化', '主动回应并调整姿势'), 'mixed');
    assert.match(independentResponse, /Adult: true/);
    assert.doesNotMatch(independentResponse, /AdultProof|POINT-TICKET/);
    const refusalOnly = bindPointAdultTickets(makeRaw('卡列布抚弄性器，对方没有拒绝，关系发生变化', '没有拒绝'), 'mixed');
    assert.doesNotMatch(refusalOnly, /Adult: true|AdultProof|POINT-TICKET/);
    assert.equal(parseCalendar(refusalOnly).days[1].events[0].adult, false);
    for (const desc of ['卡列布抚弄性器只是计划，关系发生变化', '卡列布抚弄性器只是昨夜回忆，关系发生变化']) {
        const stored = bindPointAdultTickets(makeRaw(desc, '对方主动回应'), 'mixed');
        assert.doesNotMatch(stored, /Adult: true|AdultProof|POINT-TICKET/);
        assert.equal(parseCalendar(stored).days[1].events[0].adult, false);
    }
});

test('点成人排除矩阵通过生产 verifier/bind 保持普通点', () => {
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
        const stored = bindPointAdultTickets(raw, 'mixed');
        assert.doesNotMatch(stored, /Adult: true/);
        assert.doesNotMatch(stored, /AdultProof|POINT-TICKET/);
    }
});

test('point proof must be immediately after its Ticket and is removed on bind', () => {
    const base = '<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|二|卡列布抚弄性器，对方自愿回应，关系发生变化|午|地|动\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|三|描述|晚|地|动\nFuture:\nEvent: main|四|描述|夜|地|动\n</calendar_widget>';
    const stored = bindPointAdultTickets(base, 'mixed');
    assert.doesNotMatch(stored, /POINT-TICKET|AdultProof/);
    assert.match(stored, /Adult: true/);
    const separated = base.replace('Ticket: POINT-TICKET-2\nAdultProof:', 'Ticket: POINT-TICKET-2\n说明：中间插入\nAdultProof:');
    assert.equal(parseCalendar(separated).days[1].events[0].adult, false);
    assert.doesNotMatch(bindPointAdultTickets(separated, 'mixed'), /Adult: true/);
    const duplicated = base.replace('Day: 3', 'AdultProof: junk\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3');
    assert.doesNotMatch(bindPointAdultTickets(duplicated, 'mixed'), /AdultProof/);
});

test('point adult validation keeps pinned blocks ticket-free and assigns new Tickets by block', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|锁点|已锁定|早|地|动\nDay: 2\nEvent: main|新点|新推进|午|地|动\nTicket: POINT-TICKET-1\nDay: 3\nEvent: main|第三点|新推进|晚|地|动\nTicket: POINT-TICKET-2\nFuture:\nEvent: main|未来点|新推进|夜|地|动\nTicket: POINT-TICKET-3\n</calendar_widget>';
    const options = { generated: true, adultMode: 'mixed', pinned: [{ title: '锁点' }] };
    assert.equal(validateGeneratedCalendar(raw, null, options).ok, true);
    assert.equal(validateGeneratedCalendar(raw.replace('Event: main|锁点|已锁定|早|地|动\n', 'Event: main|锁点|已锁定|早|地|动\nTicket: POINT-TICKET-1\n'), null, options).ok, false);
    assert.equal(validateGeneratedCalendar(raw.replace('Event: main|新点|新推进|午|地|动\nTicket:', 'Event: main|新点|新推进|午|地|动\nDesc: 插入行\nTicket:'), null, options).ok, false);
    assert.equal(validateGeneratedCalendar(raw.replace('Ticket: POINT-TICKET-1', 'Ticket: junk POINT-TICKET-1 extra'), null, options).ok, false);
});

test('point Adult metadata is local, round-trips, and tickets bind in source order', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nTicket: POINT-TICKET-1\nDay: 2\nEvent: main|二|卡列布抚弄性器，对方自愿回应，关系发生变化|午|地|动\nTicket: POINT-TICKET-2\nAdultProof: kind=sexual-manual; action=抚弄性器; response=对方自愿回应; impact=关系发生变化\nDay: 3\nEvent: main|三|描述|晚|地|动\nTicket: POINT-TICKET-3\nFuture:\nEvent: main|四|描述|夜|地|动\nTicket: POINT-TICKET-4\n</calendar_widget>';
    const stored = bindPointAdultTickets(raw, 'mixed'); const parsed = parseCalendar(stored);
    assert.equal(parsed.days.flatMap(day => day.events).filter(event => event.adult).length, 1);
    assert.doesNotMatch(stored, /POINT-TICKET/); assert.match(stored, /Adult: true/);
    assert.equal(parseCalendar(stripPointAdultMetadata(stored)).days.flatMap(day => day.events).some(event => event.adult), false);
});

test('point generated protocol rejects AI pin/Adult and malformed tickets', () => {
    const base = '<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nDay: 2\nEvent: main|二|描述|午|地|动\nDay: 3\nEvent: main|三|描述|晚|地|动\nFuture:\nEvent: main|四|描述|夜|地|动\n</calendar_widget>';
    assert.equal(validateGeneratedCalendar(base, null, { generated: true, adultMode: 'off' }).ok, true);
    assert.equal(validateGeneratedCalendar(base.replace('动\nDay: 2', '动|true\nDay: 2'), null, { generated: true, adultMode: 'off' }).ok, false);
    assert.equal(validateGeneratedCalendar(base.replace('动\nDay: 2', '动\nAdult: true\nDay: 2'), null, { generated: true, adultMode: 'off' }).ok, false);
});

test('point generated validation accepts five or six Event fields but rejects four or seven', () => {
    const makeRaw = event => `<calendar_widget>\nDay: 1\nEvent: main|一|描述|早|地|动\nDay: 2\nEvent: main|二|描述|午|地|动\nDay: 3\nEvent: main|三|描述|晚|地|动\nFuture:\nEvent: ${event}\n</calendar_widget>`;
    const futureFive = 'main|未来五字段|描述|夜|地';
    const parsedFive = parsePointEventRecord(`Event: ${futureFive}`);
    assert.equal(parsedFive.npcAction, '');
    assert.equal(validateGeneratedCalendar(makeRaw(futureFive), null, { generated: true, adultMode: 'off' }).ok, true);
    assert.equal(validateGeneratedCalendar(makeRaw('main|六字段|描述|夜|地|动态'), null, { generated: true, adultMode: 'off' }).ok, true);
    assert.equal(validateGeneratedCalendar(makeRaw('main|四字段|描述|夜'), null, { generated: true, adultMode: 'off' }).code, 'invalid-event-fields');
    assert.equal(validateGeneratedCalendar(makeRaw('main|七字段|描述|夜|地|动态|false'), null, { generated: true, adultMode: 'off' }).code, 'invalid-event-fields');
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
        render: () => '', write: () => {}, sync: () => {}, setButton: () => {}, panelVisible: () => false, showPanel: () => {},
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
    assert.match(fieldCase.toasts[0], /AI 返回内容字段不完整/);

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
    assert.match(testCase.toasts[0], /AI 返回内容字段不完整/);
});

test('point combined edit updates desc and npcAction atomically', () => {
    const raw = '<calendar_widget>\nDay: 1\nEvent: main|标题|旧描述|早晨|地点|旧动态|true\n</calendar_widget>';
    const result = editPointFields(raw, 0, 0, { desc: ' 新描述 ', npcAction: ' 新动态 ' });
    assert.equal(result.ok, true); assert.match(result.raw, /Event: main\|标题\|新描述\|早晨\|地点\|新动态\|true/);
});
