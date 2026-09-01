import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLinesResponse, parseLines, serializeLines } from './schema.js';
import { buildLinesPrompt, LINE_NEXT_RELEASE_CONTRACT } from './prompt.js';
import { createLinesGenerationController } from './controller.js';
import { createLinesFeature } from './feature.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { createLinesLifecycle } from './lifecycle.js';
import { createLinesInjectionController } from './injection.js';
import { createSwipeLinesStore } from './swipe-store.js';
import { createLinesActions } from './actions.js';
import { mergePinned, editLineDescription, editLineFields } from './mutations.js';
import { activeLines, buildLinesInjection } from './strategy.js';
import { adultInjectionGuidance, adultModeForCharacter, drawAdultSelections, allocateAdultPools } from './adult.js';
import { drawTickets } from './vectors/draw.js';
import { serializeVectorCue } from './vectors/codec.js';

test('line combined edit updates Desc and Next in one raw mutation', () => {
    const raw = '<storylines_widget>\nLine: A|推进|执行|1|今天|world|false|false\nDesc: 旧描述\nNext: 旧下一步\n</storylines_widget>';
    const result = editLineFields(raw, 0, { desc: ' 新描述 ', next: ' 新下一步 ' });
    assert.equal(result.ok, true); assert.match(result.raw, /Desc: 新描述\nNext: 新下一步/);
});
test('line edit keeps Next inside the selected Line block and handles empty fields', () => {
    const raw = '<storylines_widget>\nLine: A|推进|执行|1|今天|world|false|false\nDesc:\nNext:\nLine: B|推进|执行|1|今天|world|false|false\nDesc: B desc\nNext: B next\n</storylines_widget>';
    const filled = editLineFields(raw, 0, { desc: 'A desc', next: 'A next' });
    assert.equal(filled.ok, true);
    assert.match(filled.raw, /Desc: A desc\nNext: A next\nLine: B/);
    assert.match(filled.raw, /Desc: B desc\nNext: B next/);
    const cleared = editLineFields(filled.raw, 0, { desc: '', next: '' });
    assert.equal(cleared.ok, true);
    assert.doesNotMatch(cleared.raw, /Desc: A desc|Next: A next/);
    assert.match(cleared.raw, /Desc: B desc\nNext: B next/);
});
import { bindVectorTickets } from './vectors/bind.js';
import { enforceLineCapacity, AUTO_LINE_CAPACITY, AUTO_LINE_SEED_CAPACITY } from './capacity.js';
import { auditLineEvolution } from './evolution.js';
import { inlineState } from './inline.js';

const raw = '<storylines_widget>\nLine: 主线|推进|萌芽|1|今天|player|false|false\nDesc: 当前状态\nNext: 下一步信号\n</storylines_widget>';
function responseWithCount(count) { return `<storylines_widget>\n${Array.from({ length: count }, (_, index) => `Line: 线${index + 1}|推进|萌芽|1|今天|world|false|false\nTicket: TICKET-${index + 1}\nDesc: 状态${index + 1}\nNext: 下一步${index + 1}`).join('\n')}\n</storylines_widget>`; }
const freshRaw = '<storylines_widget>\nLine: 主线|推进|萌芽|1|今天|player|false|false\nTicket: TICKET-1\nDesc: 当前状态\nNext: 下一步信号\n</storylines_widget>';
test('line description edit only changes Desc and normalizes whitespace while preserving identity fields', () => {
    const source = serializeLines([{ name: '线', type: '冲突', stage: '执行', level: '3', when: '今天', agency: 'player', stall: true, pin: true, adult: true, cue: 'bad', desc: '旧', next: '下一步' }]);
    const result = editLineDescription(source, 0, ' 新的\n  描述 '); assert.equal(result.ok, true); const line = parseLines(result.raw)[0];
    assert.equal(line.desc, '新的 描述'); assert.equal(line.name, '线'); assert.equal(line.type, '冲突'); assert.equal(line.stage, '执行'); assert.equal(line.stall, true); assert.equal(line.pin, true); assert.equal(line.adult, true); assert.equal(line.next, '下一步');
});
test('release schema accepts complete output and preserves uncapped narrative', () => {
    const result = validateLinesResponse(raw);
    assert.equal(result.ok, true);
    assert.equal(result.model[0].desc, '当前状态');
    const long = `<storylines_widget>\nLine: 长线|推进|萌芽|1|今天|world|false|false\nDesc: ${'甲'.repeat(300)}\nNext: ${'乙'.repeat(240)}\n</storylines_widget>`;
    const longResult = validateLinesResponse(long);
    assert.equal(longResult.ok, true);
    assert.equal(longResult.model[0].desc.length, 300);
    assert.equal(longResult.model[0].next.length, 240);
});
test('release schema extracts one complete widget from outer response noise without relaxing inner validation', () => {
    for (const response of [
        `正文状态栏\n${raw}`,
        `${raw}\n以上是生成结果。`,
        `正文状态栏\n${raw}\n以上是生成结果。`,
        `正文状态栏\n\`\`\`xml\n${raw}\n\`\`\`\n以上是生成结果。`,
        `正文状态栏\n${raw.replace('<storylines_widget>', '<storylines_widget version="1">')}`,
    ]) {
        const result = validateLinesResponse(response);
        assert.equal(result.ok, true);
        assert.equal(result.raw, raw);
        assert.doesNotMatch(result.raw, /正文状态栏|以上是生成结果|```/);
    }

    for (const response of [
        `${raw}\n${raw}`,
        `<storylines_widget>\n${raw}\n</storylines_widget>`,
        `<storylines_widget>\n<storylines_widget>\nLine: 主线|推进|萌芽|1|今天|player|false|false\nDesc: 当前状态\nNext: 下一步信号\n</storylines_widget>`,
        `${raw}\n</storylines_widget>`,
        `<storylines_widget>\n正文状态栏\nLine: 主线|推进|萌芽|1|今天|player|false|false\nDesc: 当前状态\nNext: 下一步信号\n</storylines_widget>`,
        `${raw}\n<storylines_widget`,
    ]) assert.equal(validateLinesResponse(response).ok, false);

    for (const malformedOpen of [
        '<storylines_widget!garbage>',
        '<storylines_widget/>',
        '<storylines_widget=garbage>',
        '<storylines_widget正文>',
        '<storylines_widget\n正文状态栏\n>',
    ]) assert.equal(validateLinesResponse(raw.replace('<storylines_widget>', malformedOpen)).ok, false, malformedOpen);
});
test('incomplete model output is rejected without placeholder text', () => {
    const result = validateLinesResponse('<storylines_widget>\nLine: 缺失|推进|萌芽|1|今天|world|false|false\nDesc: 只有当前\n</storylines_widget>');
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /当前状态待补充|后续方向待补充/);
});
test('adult provenance is local-only and survives storage round trip', () => {
    const adult = { name: '成人线', type: '推进', stage: '萌芽', level: '1', when: '今天', agency: 'world', desc: 'd', next: 'n', adult: true };
    const ordinary = { ...adult, name: '普通线', adult: false };
    const rawStored = serializeLines([adult, ordinary]);
    assert.match(rawStored, /Adult: true/);
    assert.equal(parseLines(rawStored)[0].adult, true);
    assert.equal(parseLines(rawStored)[1].adult, false);
    assert.equal(parseLines(rawStored.replace(/\nAdult: true/g, ''))[0].adult, false);
    assert.equal(validateLinesResponse(rawStored).ok, false, 'AI response must not be allowed to provide Adult');
    const bound = bindVectorTickets({ generatedLines: [{ ...ordinary, ticketId: 'TICKET-1' }, { ...ordinary, ticketId: 'TICKET-2' }], freshTickets: [{ ticketId: 'TICKET-1', adultSelection: {} }, { ticketId: 'TICKET-2' }] });
    assert.deepEqual(bound.map(line => line.adult), [true, false]);
});
test('adult Next guidance enforces one adjacent step in every context', () => {
    const prompt = buildLinesPrompt('用户', '角色', 'user', '', 'auto', {}, 'dominant');
    for (const phrase of ['零身体接触', '互动进行中', '接近结束或刚结束', '不得同条跨越', '不要求一条 Next 全部兑现']) assert.match(prompt, new RegExp(phrase));
});
test('adult pool allocator follows 0/30/70 targets by slot and current active ratio', () => {
    assert.equal(allocateAdultPools('off', 10).filter(pool => pool === 'nsfw').length, 0);
    assert.equal(allocateAdultPools('mixed', 10).filter(pool => pool === 'nsfw').length, 3);
    assert.equal(allocateAdultPools('dominant', 7).filter(pool => pool === 'nsfw').length, 5);
    assert.deepEqual(allocateAdultPools('dominant', 2, { activeCount: 6, activeAdultCount: 0 }), ['nsfw', 'nsfw']);
});
test('controller commits dominant 70 percent adult provenance in ticket order', async () => {
    const owners = createTaskOwnerManager(); let saved = { raw: '', ts: 1 };
    const result = await createLinesGenerationController({ owners, chatId: () => 'adult-chat', cacheKey: () => 'adult-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => saved, drawTickets: () => drawTickets(8, { seed: 'adult-controller' }), vectorCapacity: 8, adultMode: () => 'dominant', buildPrompt: (...args) => buildLinesPrompt('用户', '角色', 'user', ...args), callApi: async () => responseWithCount(8), commit: raw => { saved = { raw, ts: 2 }; }, cleanup: owner => { owner.status = 'finished'; }, runtime: { start() {}, finish() {} } }).run();
    assert.equal(result.status, 'updated');
    assert.equal(parseLines(saved.raw).filter(line => line.adult).length, 6);
});
test('dominant reroll with seven existing adult lines still allocates from an empty pool', async () => {
    const owners = createTaskOwnerManager(); let captured = null;
    const old = `<storylines_widget>\n${Array.from({ length: 7 }, (_, index) => `Line: 旧成人${index + 1}|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n\nAdult: true`).join('\n')}\n</storylines_widget>`;
    const controller = createLinesGenerationController({ owners, adultMode: () => 'dominant', chatId: () => 'adult-reroll-chat', cacheKey: () => 'adult-reroll-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: old, ts: 1 }), drawTickets: async count => drawTickets(count, { seed: 'adult-reroll' }), vectorCapacity: 8, buildPrompt: (_previous, _travel, context) => { captured = context; return 'p'; }, callApi: async () => responseWithCount(4), commit: () => {}, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run(false, { reroll: true })).status, 'updated');
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'sfw').length, 2);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'nsfw').length, 6);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultSelection).length, 6);
});
test('mixed reroll ignores an overfull adult old pool when allocating new tickets', async () => {
    const owners = createTaskOwnerManager(); let captured = null;
    const old = `<storylines_widget>\n${Array.from({ length: 8 }, (_, index) => `Line: 旧成人${index + 1}|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n\nAdult: true`).join('\n')}\n</storylines_widget>`;
    const response = '<storylines_widget>\nLine: 新线|推进|筹备|1|今天|world|false|false\nTicket: TICKET-1\nDesc: d\nNext: n\n</storylines_widget>';
    const controller = createLinesGenerationController({ owners, adultMode: () => 'mixed', chatId: () => 'mixed-reroll-chat', cacheKey: () => 'mixed-reroll-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: old, ts: 1 }), drawTickets: async count => drawTickets(count, { seed: 'mixed-reroll' }), vectorCapacity: 8, buildPrompt: (_previous, _travel, context) => { captured = context; return 'p'; }, callApi: async () => response, commit: () => {}, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run(false, { reroll: true })).status, 'updated');
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'nsfw').length, 2);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'sfw').length, 6);
});
test('dominant pool accepts free output order but enforces ticket set and strips transient id', () => {
    const tickets = drawTickets(7, { seed: 'pool-binding' }).map((ticket, index) => ({ ...ticket, ticketId: `TICKET-${index + 1}`, adultPool: index < 2 ? 'sfw' : 'nsfw', ...(index >= 2 ? { adultSelection: { behavior: `b${index}` } } : {}) }));
    const generated = [5, 0, 2, 1, 4, 3, 6].map((index, lineIndex) => ({ name: `new-${lineIndex}`, type: '推进', stage: '筹备', level: '1', when: '今天', agency: 'world', stall: false, pin: false, desc: 'd', next: 'n', ticketId: tickets[index].ticketId }));
    const bound = bindVectorTickets({ generatedLines: generated, freshTickets: tickets });
    assert.deepEqual(bound.map(line => line.adult), [true, false, true, false, true, true, true]);
    assert.ok(bound.every(line => !Object.hasOwn(line, 'ticketId')));
    for (const selected of [[1], [0, 3], [3, 1]]) {
        const subset = selected.map((index, lineIndex) => ({ ...generated[lineIndex], ticketId: tickets[index].ticketId }));
        const subsetBound = bindVectorTickets({ generatedLines: subset, freshTickets: tickets });
        assert.deepEqual(subsetBound.map(line => line.cue), selected.map(index => serializeVectorCue(tickets[index])));
    }
});
test('ticket protocol rejects missing duplicate unknown and old-line IDs without committing', async () => {
    const ticket = { ...drawTickets(1, { seed: 'protocol' })[0], ticketId: 'TICKET-1' };
    const fresh = { name: 'new', type: '推进', stage: '筹备', level: '1', when: '今天', agency: 'world', stall: false, pin: false, desc: 'd', next: 'n' };
    for (const generated of [
        [{ ...fresh }],
        [{ ...fresh, ticketId: 'TICKET-1' }, { ...fresh, name: 'new-2', ticketId: 'TICKET-1' }],
        [{ ...fresh, ticketId: 'TICKET-X' }],
    ]) assert.throws(() => bindVectorTickets({ generatedLines: generated, freshTickets: [ticket] }));
    assert.throws(() => bindVectorTickets({ previousLines: [{ ...fresh, name: 'old', adult: true }], generatedLines: [{ ...fresh, name: 'old', ticketId: 'TICKET-1' }], freshTickets: [ticket] }));
    let commits = 0;
    const c = createLinesGenerationController({ owners: createTaskOwnerManager(), chatId: () => 'protocol-chat', cacheKey: () => 'protocol-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }), drawTickets: () => [ticket], buildPrompt: () => 'p', callApi: async () => '<storylines_widget>\nLine: new|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n\n</storylines_widget>', commit: () => { commits++; }, cleanup: owner => { owner.status = 'finished'; } });
    assert.equal((await c.run()).status, 'failed'); assert.equal(commits, 0);
});
test('release prompt defines global agency, total capacity, machine format, and local 6x3 cues without old quotas', () => {
    const prompt = buildLinesPrompt('用户', '角色', 'user', '', 'auto', { freshTickets: [{ selections: [{ label: '时机', prompt: '近日' }] }] });
    for (const phrase of ['全局平行事件线', '不是固定叙事中心', '既有配角、群体、势力、机构', 'agency=player 仅表示下一步必须等待', 'agency=world 表示', '不要因为事件将来可能影响 用户 就标 player', '未锁非终态自动线不得超过 8 条', '不设主动方、类型或单轮出生配额', '完整闭合', 'Line 必须恰好 8 段', '字段内禁止裸 |']) assert.match(prompt, new RegExp(phrase));
    for (const obsolete of ['叙事主体为用户', '默认最多出生 1 条', '单轮新生最多 4 条', '每有 1 条旧未锁活线']) assert.doesNotMatch(prompt, new RegExp(obsolete));
    assert.match(prompt, new RegExp(LINE_NEXT_RELEASE_CONTRACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(prompt, /本轮真实唯一 Ticket 与 6×3 Cue/);
});
test('Ticket is transient and absent from serialized storage/model', () => {
    const checked = validateLinesResponse('<storylines_widget>\nLine: 新线|推进|筹备|1|今天|world|false|false\nTicket: TICKET-1\nDesc: d\nNext: n\n</storylines_widget>');
    assert.equal(checked.ok, true); assert.equal(checked.model[0].ticketId, 'TICKET-1');
    assert.doesNotMatch(serializeLines(checked.model), /Ticket:|ticketId/);
    const bound = bindVectorTickets({ generatedLines: checked.model, freshTickets: [{ ...drawTickets(1, { seed: 'transient' })[0], ticketId: 'TICKET-1' }] });
    assert.doesNotMatch(JSON.stringify(bound), /ticketId/);
});
test('adult line modes keep off unchanged and reserve explicit adult candidates', () => {
    const off = buildLinesPrompt('用户', '角色', 'user', '', 'auto', {}, 'off');
    const mixed = buildLinesPrompt('用户', '角色', 'user', '', 'auto', {}, 'mixed');
    const dominant = buildLinesPrompt('用户', '角色', 'user', '', 'auto', {}, 'dominant');
    assert.doesNotMatch(off, /成人剧情素材|实际性行为/);
    assert.match(mixed, /目标约 30% 成人线/);
    assert.match(dominant, /目标约 70% 成人线/);
    assert.match(dominant, /证据不足允许低于目标/);
    assert.match(dominant, /使用 NSFW 票的新线必须由成人欲望、成人场景或成人互动本身驱动/);
    assert.match(dominant, /具体玩法\/行为/);
    assert.match(dominant, /实际主动方、其他参与者的明确主动回应/);
    assert.match(dominant, /只能作为后果/);
    assert.match(off, /Next: 一句前瞻信号或 stall=true 的恢复条件/);
    assert.match(dominant, /不得用.*淡出/);
    assert.equal(adultModeForCharacter({ adultMode: { c: 'mixed' } }, 'c'), 'mixed');
    assert.equal(adultModeForCharacter({ adultMode: { c: 'invalid' } }, 'c'), 'off');
});
test('legacy storage keeps Cue and pinned local state', () => {
    const stored = serializeLines([{ name: '锁线', type: '推进', stage: '萌芽', level: '1', when: '今天', agency: 'world', pin: true, desc: 'd', next: 'n', cue: 'lines-vector-v1:subject:survival-stability|relation:mutual-probing|setting:public-place' }]);
    const parsed = parseLines(stored);
    assert.equal(parsed[0].pin, true);
    assert.match(parsed[0].cue, /^lines-vector-v1:/);
});
test('controller uses one API call for manual reroll and commits valid output', async () => {
    let calls = 0; let committed = null;
    const controller = createLinesGenerationController({
        owners: { currentChatRevision: () => 1, isCurrent: () => true, create: () => ({ id: 'o1', controller: new AbortController() }) },
        chatId: () => 'chat', cacheKey: () => 'key', loadConfig: () => ({ url: 'mock', key: 'mock' }), readSaved: () => ({}),
        drawTickets: async () => drawTickets(1, { seed: 'manual' }), vectorCapacity: 8, buildPrompt: () => 'release prompt', callApi: async () => { calls++; return freshRaw; },
        commit: value => { committed = value; }, runtime: { start() {}, finish() {} },
    });
    const result = await controller.run(false, { reroll: true });
    assert.equal(result.status, 'updated'); assert.equal(calls, 1); assert.match(committed, /storylines_widget/);
});

test('controller attaches temporary adult selections to fresh tickets by mode without touching Cue storage', async () => {
    for (const [mode, expected] of [['off', 0], ['mixed', 2], ['dominant', 6]]) {
        const owners = createTaskOwnerManager(); let captured = null; let calls = 0;
        const controller = createLinesGenerationController({
            owners, adultMode: () => mode, chatId: () => 'adult-chat', cacheKey: () => 'adult-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }),
            drawTickets: async count => drawTickets(count, { seed: mode }), vectorCapacity: 8, buildPrompt: (_previous, _travel, vectorContext) => { captured = vectorContext; return 'p'; },
            callApi: async () => { calls++; return mode === 'dominant' ? responseWithCount(8) : freshRaw; }, commit: () => {}, runtime: { start() {}, finish() {} },
        });
        const result = await controller.run();
        assert.equal(result.status, 'updated'); assert.equal(calls, 1);
        assert.equal(captured.adultSelections.length, expected);
        assert.equal(captured.freshTickets.filter(ticket => ticket.adultSelection).length, expected);
        assert.equal(captured.freshTickets.every(ticket => ticket.cue == null), true);
        if (mode !== 'off') assert.ok(captured.freshTickets.filter(ticket => ticket.adultSelection).every(ticket => ticket.adultSelection.behavior && ticket.adultSelection.consequence));
    }
});

test('dominant initial/reroll signs eight tickets with a temporary 2 SFW plus 6 NSFW pool', async () => {
    const owners = createTaskOwnerManager(); let captured = null; let drawn = 0; let calls = 0;
    const eight = drawTickets(8, { seed: 17 });
    const controller = createLinesGenerationController({
        owners, adultMode: () => 'dominant', chatId: () => 'pool-chat', cacheKey: () => 'pool-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }),
        drawTickets: async count => { drawn = count; return eight; }, vectorCapacity: 8,
        buildPrompt: (_previous, _travel, context) => { captured = context; return buildLinesPrompt('用户', '角色', 'user', '', 'auto', context, 'dominant'); },
        callApi: async () => { calls++; return responseWithCount(8); }, commit: () => {}, runtime: { start() {}, finish() {} },
    });
    const result = await controller.run(false, { reroll: true });
    assert.equal(result.status, 'updated'); assert.equal(drawn, 8); assert.equal(calls, 1);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'sfw').length, 2);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'nsfw').length, 6);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultSelection).length, 6);
    const prompt = buildLinesPrompt('用户', '角色', 'user', '', 'auto', captured, 'dominant');
    assert.match(prompt, /选择任意不重复子集/);
    assert.match(prompt, /1v1、1vN 或 NvN/);
    assert.match(prompt, /首次生成或刷新可按证据输出 1–8 条自动线/);
    assert.doesNotMatch(prompt, /超过票数仍可输出/);
});

test('dominant automatic advance signs full capacity without forcing all tickets to be used', async () => {
    const owners = createTaskOwnerManager(); let drawn = 0; let captured = null;
    const old = '<storylines_widget>\nLine: 旧线|推进|萌芽|1|今天|world|false|false\nDesc: 状态\nNext: 下一步\n</storylines_widget>';
    const advanceResponse = '<storylines_widget>\nLine: 旧线|推进|萌芽|1|今天|world|false|false\nDesc: 新状态\nNext: 新下一步\nLine: 新线|推进|萌芽|1|今天|world|false|false\nTicket: TICKET-1\nDesc: 新建状态\nNext: 新建下一步\n</storylines_widget>';
    const controller = createLinesGenerationController({
        owners, adultMode: () => 'dominant', chatId: () => 'advance-chat', cacheKey: () => 'advance-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: old, ts: 1 }),
        drawTickets: async count => { drawn = count; return drawTickets(count, { seed: 18 }); }, vectorCapacity: 8,
        buildPrompt: (_previous, _travel, context) => { captured = context; return buildLinesPrompt('用户', '角色', 'user', old, 'auto', context, 'dominant'); }, callApi: async () => advanceResponse, commit: () => {}, runtime: { start() {}, finish() {} },
    });
    const result = await controller.run();
    assert.equal(result.status, 'updated'); assert.equal(drawn, 8); assert.equal(captured.intent, 'advance');
    assert.equal(captured.freshTickets.some(ticket => ticket.adultPool), true);
    assert.doesNotMatch(buildLinesPrompt('用户', '角色', 'user', old, 'auto', captured, 'dominant'), /2 条 SFW \+ 5 条 NSFW|2\+5/);
});

test('mixed production prompt keeps every fresh ticket with local ratio allocation', async () => {
    const owners = createTaskOwnerManager(); let prompt = '';
    const tickets = drawTickets(8, { seed: 'mixed-all' });
    const controller = createLinesGenerationController({ owners, adultMode: () => 'mixed', chatId: () => 'mixed-chat', cacheKey: () => 'mixed-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }), drawTickets: async () => tickets, vectorCapacity: 8, buildPrompt: (_previous, _travel, context) => { prompt = buildLinesPrompt('用户', '角色', 'user', '', 'auto', context, 'mixed'); return prompt; }, callApi: async () => freshRaw, commit: () => {}, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run()).status, 'updated');
    for (const ticket of tickets) for (const item of ticket.selections) assert.match(prompt, new RegExp(item.label));
    assert.match(prompt, /SFW 新线|NSFW 新线/);
});

test('dominant pinned reroll retains pinned identity then applies the ratio pool', async () => {
    const owners = createTaskOwnerManager(); let captured = null;
    const pinned = '<storylines_widget>\nLine: 锁线|推进|萌芽|1|今天|world|false|true\nDesc: 已锁定\nNext: 继续\n</storylines_widget>';
    const controller = createLinesGenerationController({ owners, adultMode: () => 'dominant', chatId: () => 'pin-chat', cacheKey: () => 'pin-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: pinned, ts: 1 }), drawTickets: async count => drawTickets(count, { seed: 'pin-pool' }), vectorCapacity: 8, buildPrompt: (_previous, _travel, context) => { captured = context; return buildLinesPrompt('用户', '角色', 'user', pinned, 'auto', context, 'dominant'); }, callApi: async () => responseWithCount(4), commit: () => {}, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run(false, { reroll: true })).status, 'updated');
    assert.equal(captured.retained.length, 0);
    assert.deepEqual(captured.legacyWithoutCue, []);
    assert.equal(captured.pinnedBackground[0].name, '锁线');
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'nsfw').length, 6);
});

test('dominant pool allows only trailing NSFW reduction and real binding commits all returned cues', async () => {
    const owners = createTaskOwnerManager(); let committed = ''; const tickets = drawTickets(8, { seed: 'bind-pool' });
    const controller = createLinesGenerationController({ owners, adultMode: () => 'dominant', chatId: () => 'bind-chat', cacheKey: () => 'bind-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }), drawTickets: async count => { assert.equal(count, 8); return tickets; }, vectorCapacity: 8, buildPrompt: () => 'p', callApi: async () => responseWithCount(8), commit: value => { committed = value; }, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run(false, { reroll: true })).status, 'updated');
    const parsed = parseLines(committed);
    assert.equal(parsed.length, 8);
    assert.equal(parsed.every(line => line.cue), true);
    for (let index = 0; index < 8; index++) assert.equal(parsed[index].cue, serializeVectorCue(tickets[index]));
});

test('long-lived lifecycle keeps swipe/reroll ownership and stopped cleanup semantics', () => {
    const life = createLinesLifecycle();
    assert.deepEqual(life.advanceCounter({ mode: 'turns', interval: 2 }), { shouldAdvance: false, counter: 1 });
    assert.deepEqual(life.advanceCounter({ mode: 'turns', interval: 2 }), { shouldAdvance: true, counter: 0 });
    life.markPendingSwipe(8);
    assert.equal(life.consumePendingSwipe(7), false);
    assert.equal(life.consumePendingSwipe(8), true);
    life.markGenerationStarted({ reroll: true, excludedAssistant: { mesId: 8 }, now: 100 });
    life.endGeneration();
    assert.equal(life.consumePendingReroll(), true, '自然结束不应吞掉待处理 reroll');
    life.markGenerationStarted({ reroll: true, excludedAssistant: { mesId: 9 }, now: 200 });
    life.endGeneration({ stopped: true });
    assert.equal(life.consumePendingReroll(), false, '明确停止必须清理待处理 reroll');
});

test('pinned merge retains user locks while AI cannot create a new lock', () => {
    const oldRaw = '<storylines_widget>\nLine: 旧线|推进|萌芽|1|今天|player|false|true\nDesc: d\nNext: n\n</storylines_widget>';
    const freshRaw = '<storylines_widget>\nLine: 旧线|推进|发酵|2|明天|world|true|false\nDesc: fresh\nNext: next\nLine: 新线|关系|萌芽|1|今天|world|true|false\nDesc: new\nNext: next\n</storylines_widget>';
    const merged = mergePinned(oldRaw, freshRaw);
    assert.equal(merged.ok, true);
    assert.equal(merged.model.filter(line => line.name === '旧线' && line.pin).length, 1);
    assert.equal(merged.model.find(line => line.name === '新线')?.pin, false);
});

test('formal validation strips AI-created pin before persistence', () => {
    const result = validateLinesResponse('<storylines_widget>\nLine: AI锁|推进|萌芽|1|今天|world|false|true\nDesc: d\nNext: n\n</storylines_widget>');
    assert.equal(result.ok, true);
    assert.equal(result.model[0].pin, false);
    assert.equal(parseLines(result.raw)[0].pin, false);
});

test('actions runExclusive invokes precheck and generation only once under concurrency', async () => {
    let prechecks = 0; let generations = 0; let release;
    const pending = new Promise(resolve => { release = resolve; });
    const actions = createLinesActions({ isBusy: () => false, precheck: async () => { prechecks++; return true; }, runGenerate: async () => { generations++; await pending; return 'ok'; } });
    const first = actions.reroll(); const second = actions.reroll();
    await new Promise(resolve => setImmediate(resolve));
    release();
    assert.equal(await first, 'ok'); assert.equal(await second, undefined);
    assert.equal(prechecks, 1); assert.equal(generations, 1);
});

test('line preflight is invalidated by chat change before a delayed precheck can dispatch', async () => {
    const owners = createTaskOwnerManager(); let chatId = 'A'; let release; let generations = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const feature = createLinesFeature({
        owners, chatId: () => chatId, dayAnchor: () => null,
        generation: { run: async () => { generations++; return { status: 'updated' }; } },
        actionsEnv: { precheck: () => pending, isBusy: () => false },
    });
    const task = feature.reroll();
    await new Promise(resolve => setImmediate(resolve));
    chatId = 'B'; owners.nextChatRevision(); feature.onChatChanged({ lastSeen: -1 });
    release(true);
    assert.equal((await task).reason, 'stale-preflight');
    assert.equal(generations, 0);
    assert.equal(feature.actions.isPreparing(), false);
});

test('late line API that ignores abort cannot refresh or freeze the new chat', async () => {
    const owners = createTaskOwnerManager(); let chatId = 'A'; let epoch = 0; let releaseApi; let apiStarted = false;
    const effects = [];
    const feature = createLinesFeature({
        owners, chatId: () => chatId, boundaryEpoch: () => epoch, dayAnchor: () => null,
        loadConfig: () => ({ url: 'u', key: 'k' }), swipeId: () => 0,
        refreshInlineWindow: () => effects.push(['refresh', chatId]), freezeSnapshot: messageId => effects.push(['freeze', chatId, messageId]),
        generationEnv: {
            chatId: () => chatId, loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }),
            drawTickets: () => drawTickets(1, { seed: 'late-boundary' }), vectorCapacity: 8, buildPrompt: () => 'p',
            callApi: async () => { apiStarted = true; return new Promise(resolve => { releaseApi = () => resolve(freshRaw); }); },
            commit: () => effects.push(['commit', chatId]), runtime: { start() {}, finish() {} },
        },
    });
    const task = feature.appendInlineBlock(0, true);
    while (!apiStarted) await new Promise(resolve => setImmediate(resolve));
    chatId = 'B'; epoch++; owners.nextChatRevision(); feature.onChatChanged({ lastSeen: 0 });
    const afterSwitch = effects.length;
    releaseApi();
    const result = await task;
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(effects.slice(afterSwitch), [], 'A 的迟到 cancelled 不得 refresh/freeze/commit B');
});

test('inline append effects follow the production generation status matrix', async () => {
    const cases = [
        { shouldAdvance: false, status: 'updated', expected: ['refresh', 'freeze'], calls: 0 },
        { shouldAdvance: true, status: 'updated', expected: ['refresh', 'freeze'], calls: 1 },
        { shouldAdvance: true, status: 'cancelled', expected: [], calls: 1 },
        { shouldAdvance: true, status: 'stale', expected: [], calls: 1 },
        { shouldAdvance: true, status: 'failed', expected: [], calls: 1 },
        { shouldAdvance: true, status: 'skipped', expected: [], calls: 1 },
    ];
    for (const entry of cases) {
        const effects = []; let calls = 0;
        const feature = createLinesFeature({
            runtime: { busy: false }, chatId: () => 'matrix-chat', boundaryEpoch: () => 0,
            loadConfig: () => ({ url: 'u', key: 'k' }), swipeId: () => 0,
            generation: { run: async () => { calls++; return { status: entry.status }; } },
            refreshInlineWindow: () => effects.push('refresh'), freezeSnapshot: () => effects.push('freeze'),
        });
        await feature.appendInlineBlock(0, entry.shouldAdvance);
        assert.equal(calls, entry.calls, `${entry.shouldAdvance}/${entry.status} generation calls`);
        assert.deepEqual(effects, entry.expected, `${entry.shouldAdvance}/${entry.status} effects`);
    }
});

test('swipe storage clears only the selected chat and preserves raw layers', () => {
    const values = new Map();
    const storage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const store = createSwipeLinesStore({ storage });
    store.write('chat-a', 2, { baseline: 'A', swipes: { '1': 'A1' } });
    store.write('chat-b', 2, { baseline: 'B', swipes: { '1': 'B1' } });
    assert.deepEqual(store.read('chat-a', 2), { baseline: 'A', swipes: { '1': 'A1' } });
    assert.equal(store.clearAll('chat-a'), 1);
    assert.equal(store.read('chat-a', 2), null);
    assert.deepEqual(store.read('chat-b', 2), { baseline: 'B', swipes: { '1': 'B1' } });
});

test('injection excludes terminal lines and preserves the hidden-line contract', () => {
    const raw = '<storylines_widget>\nLine: 活线|推进|萌芽|1|今天|world|false|false\nDesc: 状态\nNext: 下一步\nLine: 终线|推进|已完成|1|今天|world|false|false\nDesc: 不应注入\nNext: 结束\n</storylines_widget>';
    assert.equal(activeLines(raw).length, 1);
    assert.match(buildLinesInjection(activeLines(raw)), /活线/);
    assert.doesNotMatch(buildLinesInjection(activeLines(raw)), /终线/);
    const calls = [];
    const controller = createLinesInjectionController({ context: { setExtensionPrompt: (...args) => calls.push(args) }, enabled: () => true, adultMode: () => 'off', settings: () => ({ linesEnabled: true, linesInject: true }), readRaw: () => raw });
    controller.refresh();
    assert.match(calls.at(-1)[1], /活线/);
    assert.doesNotMatch(calls.at(-1)[1], /终线/);
    controller.refresh();
    assert.doesNotMatch(calls.at(-1)[1], /成人模式/);
});

test('capacity keeps prior queue identities before new lines and preserves pinned extras', () => {
    const old = Array.from({ length: 8 }, (_, i) => ({ name: `旧${i}`, pin: false }));
    const fresh = [...old, ...Array.from({ length: 4 }, (_, i) => ({ name: `新${i}`, pin: false }))];
    const result = enforceLineCapacity({ previousLines: old, mergedLines: fresh });
    assert.deepEqual(result.model.map(line => line.name), old.map(line => line.name));
    assert.equal(result.dropped, 4);
    const tenOld = Array.from({ length: 10 }, (_, i) => ({ name: `旧${i}`, pin: false }));
    assert.equal(enforceLineCapacity({ previousLines: tenOld, mergedLines: [...tenOld, { name: '新', pin: false }] }).model.length, 8);
    const pinned = enforceLineCapacity({ previousLines: tenOld, mergedLines: [...tenOld, { name: '锁', pin: true }, { name: '锁2', pin: true }] });
    assert.equal(pinned.model.filter(line => !line.pin).length, 8);
    assert.deepEqual(pinned.model.filter(line => line.pin).map(line => line.name), ['锁', '锁2']);
    const settled = enforceLineCapacity({ mergedLines: [...old, { name: '刚收束', stage: '已完成', pin: false }, { name: '锁', stage: '萌芽', pin: true }] });
    assert.equal(settled.model.filter(line => !line.pin && line.stage !== '已完成').length, 8);
    assert.equal(settled.model.some(line => line.name === '刚收束'), true);
    assert.equal(settled.model.some(line => line.name === '锁'), true);
});

test('evolution audit preserves identities and applies only the eight-line active pool math', () => {
    const old = [{ name: '活线', stage: '萌芽', pin: false }, { name: '锁线', stage: '萌芽', pin: true }];
    const ticket = id => ({ ticketId: `TICKET-${id}` });
    const continued = { name: '活线', stage: '执行', ticketId: undefined };
    const newborn = id => ({ name: `新${id}`, stage: '萌芽', ticketId: `TICKET-${id}` });
    assert.equal(auditLineEvolution({ previousLines: old, generatedLines: [continued, newborn(1)], freshTickets: [ticket(1)], intent: 'advance' }).ok, true);
    assert.equal(auditLineEvolution({ previousLines: old, generatedLines: [newborn(1)], freshTickets: [ticket(1)], intent: 'advance' }).reason, 'evolution-old-line-missing');
    assert.equal(auditLineEvolution({ previousLines: old, generatedLines: [{ name: '活线', stage: '已完成' }, newborn(1), newborn(2)], freshTickets: [ticket(1), ticket(2)], intent: 'advance' }).ok, true);
    assert.equal(auditLineEvolution({ previousLines: old, generatedLines: [continued, newborn(1), newborn(2)], freshTickets: [ticket(1), ticket(2)], intent: 'advance' }).ok, true, '没有单轮出生配额');
    assert.equal(auditLineEvolution({ previousLines: old, generatedLines: [{ name: '锁线', stage: '已完成' }], freshTickets: [], intent: 'advance' }).reason, 'evolution-pinned-terminal');
    const eight = Array.from({ length: 8 }, (_, index) => newborn(index + 1));
    assert.equal(auditLineEvolution({ previousLines: [], generatedLines: eight, freshTickets: Array.from({ length: 8 }, (_, index) => ticket(index + 1)), intent: 'initial' }).ok, true);
    assert.equal(auditLineEvolution({ previousLines: [], generatedLines: [...eight, newborn(9)], freshTickets: Array.from({ length: 9 }, (_, index) => ticket(index + 1)), intent: 'initial' }).reason, 'evolution-auto-capacity-overflow');
    const sevenOld = Array.from({ length: 7 }, (_, index) => ({ name: `旧${index + 1}`, stage: '萌芽', pin: false }));
    const sevenContinued = sevenOld.map(line => ({ ...line, stage: '执行' }));
    assert.equal(auditLineEvolution({ previousLines: sevenOld, generatedLines: [...sevenContinued, newborn(1)], freshTickets: [ticket(1)], intent: 'advance' }).ok, true);
    const eightOld = [...sevenOld, { name: '旧8', stage: '萌芽', pin: false }];
    const eightContinued = eightOld.map(line => ({ ...line, stage: '执行' }));
    assert.equal(auditLineEvolution({ previousLines: eightOld, generatedLines: [...eightContinued, newborn(1)], freshTickets: [ticket(1)], intent: 'advance' }).reason, 'evolution-auto-capacity-overflow');
    const oneSettled = [{ ...eightContinued[0], stage: '已完成' }, ...eightContinued.slice(1), newborn(1)];
    assert.equal(auditLineEvolution({ previousLines: eightOld, generatedLines: oneSettled, freshTickets: [ticket(1)], intent: 'advance' }).ok, true, '旧线终态为新线腾出一格');
    assert.equal(auditLineEvolution({ previousLines: [...eightOld, { name: '锁线', stage: '萌芽', pin: true }], generatedLines: [...eightContinued, { name: '锁线', stage: '执行' }], freshTickets: [], intent: 'advance' }).activeAutoCount, 8, '锁线即使被模型回显也不占自动池');
});

test('production controller signs and binds eight tickets, accepts terminal turnover, and rejects a ninth active line', async () => {
    const makeOld = (count, stage = '萌芽') => serializeLines(Array.from({ length: count }, (_, index) => ({ name: `旧${index + 1}`, type: '推进', stage, level: '1', when: '今天', agency: 'world', desc: '旧状态', next: '旧下一步' })));
    const oldBlock = (index, stage = '执行') => `Line: 旧${index}|推进|${stage}|1|今天|world|false|false\nDesc: 新状态${index}\nNext: 新下一步${index}`;
    const newBlock = index => `Line: 新${index}|推进|萌芽|1|今天|world|false|false\nTicket: TICKET-${index}\nDesc: 新生状态${index}\nNext: 新生下一步${index}`;
    const widget = blocks => `<storylines_widget>\n${blocks.join('\n')}\n</storylines_widget>`;

    for (const scenario of [
        { name: 'terminal-only', savedRaw: makeOld(1, '已完成'), response: widget(Array.from({ length: 8 }, (_, index) => newBlock(index + 1))), expectedStatus: 'updated', expectedActive: 8, expectedTotal: 8 },
        { name: 'terminal-turnover', savedRaw: makeOld(8), response: widget([...Array.from({ length: 8 }, (_, index) => oldBlock(index + 1, '已完成')), ...Array.from({ length: 8 }, (_, index) => newBlock(index + 1))]), expectedStatus: 'updated', expectedActive: 8, expectedTotal: 16 },
        { name: 'ninth-rejected', savedRaw: '', response: widget(Array.from({ length: 9 }, (_, index) => newBlock(index + 1))), expectedStatus: 'failed', expectedReason: 'evolution-auto-capacity-overflow' },
    ]) {
        let saved = { raw: scenario.savedRaw, ts: 1 }; let drawn = 0; let captured = null; let commits = 0;
        const controller = createLinesGenerationController({
            owners: createTaskOwnerManager(), chatId: () => scenario.name, cacheKey: () => scenario.name,
            loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => saved,
            drawTickets: count => { drawn = count; return drawTickets(count, { seed: scenario.name }); }, vectorCapacity: 8,
            buildPrompt: (_previous, _travel, context) => { captured = context; return 'p'; }, callApi: async () => scenario.response,
            commit: raw => { commits++; saved = { raw, ts: 2 }; }, runtime: { start() {}, finish() {} },
        });
        const result = await controller.run();
        assert.equal(result.status, scenario.expectedStatus, scenario.name);
        assert.equal(drawn, AUTO_LINE_CAPACITY, `${scenario.name} ticket count`);
        assert.equal(captured.freshTickets.length, AUTO_LINE_CAPACITY, `${scenario.name} prompt tickets`);
        if (scenario.expectedStatus === 'updated') {
            const model = parseLines(saved.raw);
            assert.equal(commits, 1, scenario.name);
            assert.equal(model.filter(line => !line.pin && !['已爆发', '已消散', '已完成', '已失败'].includes(line.stage)).length, scenario.expectedActive, scenario.name);
            assert.equal(model.length, scenario.expectedTotal, scenario.name);
            assert.equal(model.filter(line => line.name.startsWith('新')).every(line => line.cue), true, `${scenario.name} cues`);
        } else {
            assert.equal(result.reason, scenario.expectedReason, scenario.name);
            assert.equal(commits, 0, scenario.name);
        }
    }
});

test('controller treats terminal-only history as advance and preserves same-name pin queues', async () => {
    const terminal = serializeLines([{ name: '旧终态', type: '推进', stage: '已完成', level: '1', when: '今天', agency: 'world', desc: 'd', next: 'n' }]);
    let saved = { raw: terminal, ts: 1 }; let captured = null; let drawn = 0;
    const instance = createLinesGenerationController({ owners: createTaskOwnerManager(), chatId: () => 'terminal-only', cacheKey: () => 'terminal-only', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => saved, drawTickets: count => { drawn = count; return drawTickets(count, { seed: 'terminal-only' }); }, buildPrompt: (_raw, _travel, context) => { captured = context; return 'p'; }, callApi: async () => responseWithCount(1), commit: raw => { saved = { raw, ts: 2 }; }, runtime: { start() {}, finish() {} } });
    assert.equal((await instance.run()).status, 'updated'); assert.equal(captured.intent, 'advance'); assert.equal(drawn, AUTO_LINE_SEED_CAPACITY); assert.equal(parseLines(saved.raw).length, 1);

    const sameResponse = '<storylines_widget>\nLine: 同名|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n\nLine: 同名|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n\n</storylines_widget>';
    for (const source of [
        [{ name: '同名', cue: 'lines-vector-v1:relation:mutual-probing|subject:survival-stability|timing:daily-gap', pin: false, adult: false }, { name: '同名', cue: null, pin: true, adult: true }],
        [{ name: '同名', cue: null, pin: true, adult: true }, { name: '同名', cue: 'lines-vector-v1:relation:mutual-probing|subject:survival-stability|timing:daily-gap', pin: false, adult: false }],
    ]) {
        const old = serializeLines(source.map(item => ({ ...item, type: '推进', stage: '筹备', level: '1', when: '今天', agency: 'world', desc: 'd', next: 'n' })));
        let current = { raw: old, ts: 1 };
        const c = createLinesGenerationController({ owners: createTaskOwnerManager(), chatId: () => 'same-name', cacheKey: () => 'same-name', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => current, drawTickets: count => drawTickets(count, { seed: 'same-name' }), buildPrompt: () => 'p', callApi: async () => sameResponse, commit: raw => { current = { raw, ts: 2 }; }, runtime: { start() {}, finish() {} } });
        const resultStatus = await c.run(); assert.equal(resultStatus.status, 'updated', resultStatus.error?.stack || JSON.stringify(resultStatus));
        const result = parseLines(current.raw); assert.equal(result.length, 2); const expected = [...source].sort((a, b) => Number(a.pin) - Number(b.pin)); assert.deepEqual(result.map(item => [item.pin, item.adult, item.cue]), expected.map(item => [item.pin, item.adult, item.cue]));
    }
});

test('controller preserves omitted same-name pinned lines after active identity matching', async () => {
    const cue = 'lines-vector-v1:relation:mutual-probing|subject:survival-stability|timing:daily-gap';
    const response = '<storylines_widget>\nLine: 同名|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n\n</storylines_widget>';
    for (const source of [
        [{ name: '同名', cue, pin: false, adult: false }, { name: '同名', cue: null, pin: true, adult: true }],
        [{ name: '同名', cue: null, pin: true, adult: true }, { name: '同名', cue, pin: false, adult: false }],
    ]) {
        const old = serializeLines(source.map(item => ({ ...item, type: '推进', stage: '筹备', level: '1', when: '今天', agency: 'world', desc: 'd', next: 'n' })));
        let current = { raw: old, ts: 1 };
        const controller = createLinesGenerationController({ owners: createTaskOwnerManager(), chatId: () => 'omitted-pin', cacheKey: () => 'omitted-pin', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => current, drawTickets: count => drawTickets(count, { seed: 'omitted-pin' }), buildPrompt: () => 'p', callApi: async () => response, commit: raw => { current = { raw, ts: 2 }; }, runtime: { start() {}, finish() {} } });
        assert.equal((await controller.run()).status, 'updated');
        const result = parseLines(current.raw);
        assert.equal(result.length, 2);
        assert.deepEqual(result.map(item => [item.name, item.pin, item.adult, item.cue]), [['同名', false, false, cue], ['同名', true, true, null]]);
    }
});

test('controller restores distinct active and pinned identities when model omits pinned lines', async () => {
    const [cueActiveA, cuePinnedA, cueActiveB, cuePinnedB] = drawTickets(4, { seed: 'distinct-identities' }).map(serializeVectorCue);
    const source = [
        { name: '重复线', cue: cueActiveA, pin: false, adult: false },
        { name: '重复线', cue: cuePinnedA, pin: true, adult: true },
        { name: '重复线', cue: cueActiveB, pin: false, adult: true },
        { name: '重复线', cue: cuePinnedB, pin: true, adult: false },
    ];
    const old = serializeLines(source.map(item => ({ ...item, type: '推进', stage: '筹备', level: '1', when: '今天', agency: 'world', desc: 'd', next: 'n' })));
    const response = '<storylines_widget>\nLine: 重复线|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n\nLine: 重复线|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n\n</storylines_widget>';
    let current = { raw: old, ts: 1 };
    const controller = createLinesGenerationController({ owners: createTaskOwnerManager(), chatId: () => 'duplicate-pin', cacheKey: () => 'duplicate-pin', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => current, drawTickets: count => drawTickets(count, { seed: 'duplicate-pin' }), buildPrompt: () => 'p', callApi: async () => response, commit: raw => { current = { raw, ts: 2 }; }, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run()).status, 'updated');
    const result = parseLines(current.raw);
    assert.equal(result.length, 4);
    assert.equal(result.filter(item => !item.pin).length, 2);
    assert.equal(result.filter(item => item.pin).length, 2);
    assert.deepEqual(result.filter(item => !item.pin).map(item => [item.cue, item.adult]), [
        [source[0].cue, false], [source[2].cue, true],
    ]);
    assert.deepEqual(result.filter(item => item.pin).map(item => [item.cue, item.adult]), [
        [source[1].cue, true], [source[3].cue, false],
    ]);
});

test('inline state separates active and settled lines while retaining settled cards', () => {
    const source = serializeLines([
        ...Array.from({ length: 7 }, (_, i) => ({ name: `活${i}`, type: '推进', stage: '萌芽', level: '1', when: '今天', agency: 'world', desc: '状态', next: '下一步' })),
        ...Array.from({ length: 3 }, (_, i) => ({ name: `收${i}`, type: '推进', stage: '已完成', level: '1', when: '今天', agency: 'world', desc: '状态', next: '结束' })),
    ]);
    const state = inlineState(source);
    assert.equal(state.activeCount, 7); assert.equal(state.settledCount, 3); assert.equal(state.count, 10);
    assert.equal(state.lines.length, 10); assert.match(state.injectText, /活0/); assert.doesNotMatch(state.injectText, /收0/);
});
test('adult injection guidance varies by mode without changing line storage', () => {
    const lines = activeLines(raw);
    assert.equal(adultInjectionGuidance('off'), '');
    assert.match(adultInjectionGuidance('mixed'), /实际行为推进/);
    assert.match(adultInjectionGuidance('dominant'), /主要叙事方向/);
    assert.doesNotMatch(buildLinesInjection(lines), /成人模式/);
    assert.match(buildLinesInjection(lines, { adultMode: 'dominant' }), /成人主导模式/);
    assert.match(buildLinesInjection(lines, { adultMode: 'dominant' }), /不要生硬提及、不要让角色直接谈论、更不要一次抖开/);
    assert.match(buildLinesInjection(lines, { adultMode: 'dominant' }), /具体行为\/玩法/);
});

test('injection controller refreshes adult guidance immediately after mode changes', () => {
    const calls = []; let mode = 'off';
    const controller = createLinesInjectionController({ context: { setExtensionPrompt: (...args) => calls.push(args) }, enabled: () => true, adultMode: () => mode, settings: () => ({ linesEnabled: true, linesInject: true }), readRaw: () => raw });
    controller.refresh();
    assert.doesNotMatch(calls.at(-1)[1], /成人模式/);
    mode = 'dominant'; controller.refresh();
    assert.match(calls.at(-1)[1], /成人主导模式/);
});

test('concurrent generation entry is owned once and stale owner cannot commit', async () => {
    const owners = createTaskOwnerManager(); let calls = 0; let committed = 0; let release;
    const pending = new Promise(resolve => { release = resolve; });
    const env = { owners, chatId: () => 'chat', cacheKey: () => 'key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }), drawTickets: async () => drawTickets(1, { seed: 'concurrent' }), vectorCapacity: 8, buildPrompt: () => 'p', callApi: async () => { calls++; await pending; return freshRaw; }, commit: () => { committed++; }, runtime: { start() {}, finish() {} } };
    const first = createLinesGenerationController(env).run();
    const second = createLinesGenerationController(env).run();
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1, '并发入口最终只能让当前 owner 调用一次 API');
    assert.deepEqual(results.map(result => result.status), ['updated', 'skipped']);
    assert.equal(committed, 1, '第一轮必须保留 owner 并完成唯一提交');
});

test('cross-instance generation lease skips the second run for the same chat without aborting the first', async () => {
    let calls = 0; let release; let firstSignal = null;
    const pending = new Promise(resolve => { release = resolve; });
    const makeController = () => createLinesGenerationController({
        owners: createTaskOwnerManager(), chatId: () => 'shared-chat', cacheKey: () => 'shared-key',
        loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }),
        drawTickets: async () => drawTickets(1, { seed: 'cross-instance' }), vectorCapacity: 8, buildPrompt: () => 'p',
        callApi: async (_prompt, signal) => { calls++; firstSignal ||= signal; await pending; return freshRaw; },
        commit: () => {}, runtime: { start() {}, finish() {} },
    });
    const first = makeController().run();
    while (calls === 0) await new Promise(resolve => setImmediate(resolve));
    const second = await makeController().run();
    assert.deepEqual(second, { status: 'skipped', reason: 'busy' });
    assert.equal(calls, 1);
    assert.equal(firstSignal.aborted, false, '第二个实例不得中止第一轮请求');
    release();
    assert.equal((await first).status, 'updated');
});

test('cross-instance generation leases are isolated by chat id', async () => {
    let calls = 0; const releases = [];
    const makeController = chatId => createLinesGenerationController({
        owners: createTaskOwnerManager(), chatId: () => chatId, cacheKey: () => `${chatId}-key`,
        loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }),
        drawTickets: async () => drawTickets(1, { seed: chatId }), vectorCapacity: 8, buildPrompt: () => 'p',
        callApi: async () => { calls++; await new Promise(resolve => releases.push(resolve)); return freshRaw; },
        commit: () => {}, runtime: { start() {}, finish() {} },
    });
    const first = makeController('lease-chat-a').run();
    const second = makeController('lease-chat-b').run();
    while (calls < 2) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, '不同 chat 必须能各自进入 API');
    releases.splice(0).forEach(resolve => resolve());
    assert.deepEqual((await Promise.all([first, second])).map(result => result.status), ['updated', 'updated']);
});

test('line participant drift blocks dispatch and a stale same-chat lease cannot block a new revision', async () => {
    let participant = { boundaryEpoch: 0, chatId: 'identity-chat', userName: 'A', charName: 'A' };
    let releaseDraw; let apiCalls = 0;
    const identityOwners = createTaskOwnerManager();
    const identityController = createLinesGenerationController({
        owners: identityOwners, chatId: () => 'identity-chat', participantIdentity: () => participant,
        sameParticipantIdentity: (a, b) => JSON.stringify(a) === JSON.stringify(b), contextSnapshot: () => ({ chat: [], name1: 'A', name2: 'A' }),
        cacheKey: () => 'identity-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }),
        drawTickets: () => new Promise(resolve => { releaseDraw = () => resolve(drawTickets(1, { seed: 'identity' })); }), vectorCapacity: 8,
        buildPrompt: () => 'p', callApi: async () => { apiCalls++; return freshRaw; }, commit: () => {}, runtime: { start() {}, finish() {} },
    });
    const identityRun = identityController.run();
    await new Promise(resolve => setImmediate(resolve)); participant = { ...participant, userName: 'B' }; releaseDraw();
    assert.equal((await identityRun).status, 'cancelled'); assert.equal(apiCalls, 0);

    const oldOwners = createTaskOwnerManager(); const newOwners = createTaskOwnerManager(); newOwners.nextChatRevision();
    let releaseOld; let leaseCalls = 0; let oldCommits = 0; let newCommits = 0;
    const base = owners => ({ owners, chatId: () => 'same-chat-revision', cacheKey: () => 'key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }), drawTickets: () => drawTickets(1, { seed: 'revision' }), vectorCapacity: 8, buildPrompt: () => 'p', runtime: { start() {}, finish() {} } });
    const oldRun = createLinesGenerationController({ ...base(oldOwners), callApi: async () => { leaseCalls++; await new Promise(resolve => { releaseOld = resolve; }); return freshRaw; }, commit: () => { oldCommits++; } }).run();
    while (!releaseOld) await new Promise(resolve => setImmediate(resolve));
    oldOwners.nextChatRevision(); oldOwners.invalidateAll();
    const freshRun = await createLinesGenerationController({ ...base(newOwners), callApi: async () => { leaseCalls++; return freshRaw; }, commit: () => { newCommits++; } }).run();
    assert.equal(freshRun.status, 'updated'); assert.equal(newCommits, 1); assert.equal(leaseCalls, 2);
    releaseOld(); assert.equal((await oldRun).status, 'cancelled'); assert.equal(oldCommits, 0);
});

function automaticLinesFeature(status, { mode = 'turns' } = {}) {
    const toasts = []; let calls = 0;
    const feature = createLinesFeature({
        runtime: { busy: false },
        generation: { run: async () => { calls++; return { status }; } },
        pluginEnabled: () => true,
        getSettings: () => ({ linesEnabled: true, notifyMode: 'full' }),
        getMode: () => mode,
        getInterval: () => 1,
        loadConfig: () => ({ url: 'u', key: 'k' }),
        chatId: () => 'feature-chat',
        chat: () => [{ is_user: false, is_system: false, mes: '正文' }],
        floorSignature: () => 'sig',
        swipeId: () => 0,
        toast: value => toasts.push(value),
        dayAnchor: () => '1-1',
        dayAdvance: ({ dayAnchor, previousDay }) => ({ shouldAdvance: dayAnchor !== previousDay }),
    });
    return { feature, toasts, calls: () => calls };
}

test('automatic line success toast is emitted only for an updated generation result', async () => {
    for (const status of ['failed', 'cancelled', 'skipped', 'updated']) {
        const harness = automaticLinesFeature(status);
        assert.equal(harness.feature.onMessageReceived({ messageId: 0, type: 'normal' }), true);
        await harness.feature.onCharacterRendered({ messageId: 0, type: 'normal' });
        assert.equal(harness.calls(), 1);
        assert.equal(harness.toasts.filter(value => /线已随剧情自动推进/.test(value)).length, status === 'updated' ? 1 : 0, status);
    }
});

test('date aftermath uses the generation result and repeated same-floor CMR does not call the API twice', async () => {
    const failed = automaticLinesFeature('failed', { mode: 'days' });
    failed.feature.onMessageReceived({ messageId: 0, type: 'normal' });
    await failed.feature.onCharacterRendered({ messageId: 0, type: 'normal' });
    await failed.feature.onDateAftermath({ chatId: 'feature-chat', messageId: 0, day: '1-2' });
    assert.equal(failed.calls(), 1);
    assert.equal(failed.toasts.some(value => /线已随剧情自动推进/.test(value)), false);

    const replay = automaticLinesFeature('updated');
    replay.feature.onMessageReceived({ messageId: 0, type: 'normal' });
    await replay.feature.onCharacterRendered({ messageId: 0, type: 'normal' });
    await replay.feature.onCharacterRendered({ messageId: 0, type: 'normal' });
    assert.equal(replay.calls(), 1, '同楼 CMR 重放不得再次生成');
    assert.equal(replay.toasts.filter(value => /线已随剧情自动推进/.test(value)).length, 1);
});
