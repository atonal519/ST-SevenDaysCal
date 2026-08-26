import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLinesResponse, parseLines, serializeLines } from './schema.js';
import { buildLinesPrompt, LINE_NEXT_RELEASE_CONTRACT } from './prompt.js';
import { createLinesGenerationController } from './controller.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { createLinesLifecycle } from './lifecycle.js';
import { createLinesInjectionController } from './injection.js';
import { createSwipeLinesStore } from './swipe-store.js';
import { createLinesActions } from './actions.js';
import { mergePinned, editLineDescription, editLineFields } from './mutations.js';
import { activeLines, buildLinesInjection } from './strategy.js';
import { adultInjectionGuidance, adultModeForCharacter, drawAdultSelections } from './adult.js';
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
import { enforceLineCapacity } from './capacity.js';
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
test('controller commits dominant 2+5 adult provenance in output order', async () => {
    const owners = createTaskOwnerManager(); let saved = { raw: '', ts: 1 };
    const response = `<storylines_widget>\n${Array.from({ length: 7 }, (_, index) => `Line: 线${index + 1}|推进|筹备|1|今天|world|false|false\nDesc: d${index + 1}\nNext: n${index + 1}`).join('\n')}\n</storylines_widget>`;
    const result = await createLinesGenerationController({ owners, chatId: () => 'adult-chat', cacheKey: () => 'adult-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => saved, drawTickets: () => drawTickets(7, { seed: 'adult-controller' }), vectorCapacity: 8, adultMode: () => 'dominant', buildPrompt: (...args) => buildLinesPrompt('用户', '角色', 'user', ...args), callApi: async () => responseWithCount(7), commit: raw => { saved = { raw, ts: 2 }; }, cleanup: owner => { owner.status = 'finished'; }, runtime: { start() {}, finish() {} } }).run();
    assert.equal(result.status, 'updated');
    assert.deepEqual(parseLines(saved.raw).map(line => line.adult), [false, false, true, true, true, true, true]);
});
test('dominant pool accepts free output order but enforces ticket set and strips transient id', () => {
    const tickets = drawTickets(7, { seed: 'pool-binding' }).map((ticket, index) => ({ ...ticket, ticketId: `TICKET-${index + 1}`, adultPool: index < 2 ? 'sfw' : 'nsfw', ...(index >= 2 ? { adultSelection: { behavior: `b${index}` } } : {}) }));
    const generated = [5, 0, 2, 1, 4, 3, 6].map((index, lineIndex) => ({ name: `new-${lineIndex}`, type: '推进', stage: '筹备', level: '1', when: '今天', agency: 'world', stall: false, pin: false, desc: 'd', next: 'n', ticketId: tickets[index].ticketId }));
    const bound = bindVectorTickets({ generatedLines: generated, freshTickets: tickets });
    assert.deepEqual(bound.map(line => line.adult), [true, false, true, false, true, true, true]);
    assert.ok(bound.every(line => !Object.hasOwn(line, 'ticketId')));
    for (const bad of [[1, 2, 3, 4, 5, 6], [0, 1, 2, 4, 5, 6], [0, 1, 2, 3, 4, 6]]) {
        const invalid = bad.map((index, lineIndex) => ({ ...generated[lineIndex], ticketId: tickets[index].ticketId }));
        assert.throws(() => bindVectorTickets({ generatedLines: invalid, freshTickets: tickets }));
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
test('release prompt keeps flexible count, Next contract, and local 6x3 cues', () => {
    const prompt = buildLinesPrompt('用户', '角色', 'user', '', 'auto', { freshTickets: [{ selections: [{ label: '时机', prompt: '近日' }] }] });
    assert.match(prompt, /条目数量按当前剧情证据灵活决定/);
    assert.match(prompt, new RegExp(LINE_NEXT_RELEASE_CONTRACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(prompt, /本轮本地预掷影响角度/);
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
    assert.match(mixed, /至少保留一张.*真实新线/);
    assert.match(mixed, /成人选材票上的具体驱动力/);
    assert.match(dominant, /NSFW 新线必须由成人欲望、成人场景或成人互动本身驱动/);
    assert.match(dominant, /具体玩法\/行为/);
    assert.match(dominant, /主动方与对方的主动回应/);
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
    for (const [mode, expected] of [['off', 0], ['mixed', 1], ['dominant', 5]]) {
        const owners = createTaskOwnerManager(); let captured = null; let calls = 0;
        const controller = createLinesGenerationController({
            owners, adultMode: () => mode, chatId: () => 'adult-chat', cacheKey: () => 'adult-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }),
            drawTickets: async count => drawTickets(count, { seed: mode }), vectorCapacity: 8, buildPrompt: (_previous, _travel, vectorContext) => { captured = vectorContext; return 'p'; },
            callApi: async () => { calls++; return mode === 'dominant' ? responseWithCount(7) : freshRaw; }, commit: () => {}, runtime: { start() {}, finish() {} },
        });
        const result = await controller.run();
        assert.equal(result.status, 'updated'); assert.equal(calls, 1);
        assert.equal(captured.adultSelections.length, expected);
        assert.equal(captured.freshTickets.filter(ticket => ticket.adultSelection).length, expected);
        assert.equal(captured.freshTickets.every(ticket => ticket.cue == null), true);
        if (mode !== 'off') assert.ok(captured.freshTickets.filter(ticket => ticket.adultSelection).every(ticket => ticket.adultSelection.behavior && ticket.adultSelection.consequence));
    }
});

test('dominant initial/reroll uses a temporary 2 SFW plus 5 NSFW pool in one request', async () => {
    const owners = createTaskOwnerManager(); let captured = null; let drawn = 0; let calls = 0;
    const seven = drawTickets(7, { seed: 17 });
    const controller = createLinesGenerationController({
        owners, adultMode: () => 'dominant', chatId: () => 'pool-chat', cacheKey: () => 'pool-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }),
        drawTickets: async count => { drawn = count; return seven; }, vectorCapacity: 8,
        buildPrompt: (_previous, _travel, context) => { captured = context; return buildLinesPrompt('用户', '角色', 'user', '', 'auto', context, 'dominant'); },
        callApi: async () => { calls++; return responseWithCount(7); }, commit: () => {}, runtime: { start() {}, finish() {} },
    });
    const result = await controller.run(false, { reroll: true });
    assert.equal(result.status, 'updated'); assert.equal(drawn, 7); assert.equal(calls, 1);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'sfw').length, 2);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultPool === 'nsfw').length, 5);
    assert.equal(captured.freshTickets.filter(ticket => ticket.adultSelection).length, 5);
    const prompt = buildLinesPrompt('用户', '角色', 'user', '', 'auto', captured, 'dominant');
    assert.match(prompt, /输出顺序自由，不要求先 SFW 后 NSFW/);
    assert.match(prompt, /同一主角或同一组参与者可以重复/);
    assert.match(prompt, /场景、关系结构、互动机制、节奏或即时身体\/关系后果之一有实质差异/);
    assert.match(prompt, /1v1、1vN 或 NvN/);
    assert.match(prompt, /最多输出 7 条新线/);
    assert.doesNotMatch(prompt, /超过票数仍可输出/);
});

test('dominant automatic advance keeps existing ticket sizing and does not force seven new lines', async () => {
    const owners = createTaskOwnerManager(); let drawn = 0; let captured = null;
    const old = '<storylines_widget>\nLine: 旧线|推进|萌芽|1|今天|world|false|false\nDesc: 状态\nNext: 下一步\n</storylines_widget>';
    const controller = createLinesGenerationController({
        owners, adultMode: () => 'dominant', chatId: () => 'advance-chat', cacheKey: () => 'advance-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: old, ts: 1 }),
        drawTickets: async count => { drawn = count; return drawTickets(count, { seed: 18 }); }, vectorCapacity: 8,
        buildPrompt: (_previous, _travel, context) => { captured = context; return buildLinesPrompt('用户', '角色', 'user', old, 'auto', context, 'dominant'); }, callApi: async () => freshRaw, commit: () => {}, runtime: { start() {}, finish() {} },
    });
    const result = await controller.run();
    assert.equal(result.status, 'updated'); assert.equal(drawn, 8); assert.equal(captured.intent, 'advance');
    assert.equal(captured.freshTickets.some(ticket => ticket.adultPool), false);
    assert.doesNotMatch(buildLinesPrompt('用户', '角色', 'user', old, 'auto', captured, 'dominant'), /2 条 SFW \+ 5 条 NSFW|2\+5/);
});

test('mixed production prompt keeps every fresh ticket while attaching only one adult selection', async () => {
    const owners = createTaskOwnerManager(); let prompt = '';
    const tickets = drawTickets(8, { seed: 'mixed-all' });
    const controller = createLinesGenerationController({ owners, adultMode: () => 'mixed', chatId: () => 'mixed-chat', cacheKey: () => 'mixed-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }), drawTickets: async () => tickets, vectorCapacity: 8, buildPrompt: (_previous, _travel, context) => { prompt = buildLinesPrompt('用户', '角色', 'user', '', 'auto', context, 'mixed'); return prompt; }, callApi: async () => freshRaw, commit: () => {}, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run()).status, 'updated');
    for (const ticket of tickets) for (const item of ticket.selections) assert.match(prompt, new RegExp(item.label));
    assert.doesNotMatch(prompt, /SFW 新线|NSFW 新线|2 条 SFW/);
});

test('dominant pinned reroll retains pinned identity then applies the 2+5 pool', async () => {
    const owners = createTaskOwnerManager(); let captured = null;
    const pinned = '<storylines_widget>\nLine: 锁线|推进|萌芽|1|今天|world|false|true\nDesc: 已锁定\nNext: 继续\n</storylines_widget>';
    const controller = createLinesGenerationController({ owners, adultMode: () => 'dominant', chatId: () => 'pin-chat', cacheKey: () => 'pin-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: pinned, ts: 1 }), drawTickets: async count => drawTickets(count, { seed: 'pin-pool' }), vectorCapacity: 8, buildPrompt: (_previous, _travel, context) => { captured = context; return buildLinesPrompt('用户', '角色', 'user', pinned, 'auto', context, 'dominant'); }, callApi: async () => responseWithCount(7), commit: () => {}, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run(false, { reroll: true })).status, 'updated');
    assert.equal(captured.retained.length, 0, '无 Cue 的 pinned 线仍应进入 legacy 身份区');
    assert.equal(captured.legacyWithoutCue[0], '锁线');
    assert.deepEqual(captured.freshTickets.slice(0, 2).map(ticket => ticket.adultPool), ['sfw', 'sfw']);
    assert.equal(captured.freshTickets.slice(2).every(ticket => ticket.adultPool === 'nsfw'), true);
});

test('dominant pool allows only trailing NSFW reduction and real binding commits all returned cues', async () => {
    const owners = createTaskOwnerManager(); let committed = ''; const tickets = drawTickets(7, { seed: 'bind-pool' });
    const controller = createLinesGenerationController({ owners, adultMode: () => 'dominant', chatId: () => 'bind-chat', cacheKey: () => 'bind-key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }), drawTickets: async count => { assert.equal(count, 7); return tickets; }, vectorCapacity: 8, buildPrompt: () => 'p', callApi: async () => responseWithCount(6), commit: value => { committed = value; }, runtime: { start() {}, finish() {} } });
    assert.equal((await controller.run(false, { reroll: true })).status, 'updated');
    const parsed = parseLines(committed);
    assert.equal(parsed.length, 6);
    assert.equal(parsed.every(line => line.cue), true);
    for (let index = 0; index < 6; index++) assert.equal(parsed[index].cue, serializeVectorCue(tickets[index]));
    assert.equal(parsed.some(line => line.cue === serializeVectorCue(tickets[6])), false);
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
    assert.equal(merged.model.find(line => line.name === '旧线')?.pin, true);
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
    assert.deepEqual(result.model.map(line => line.name), [...old.map(line => line.name), '新0', '新1']);
    const tenOld = Array.from({ length: 10 }, (_, i) => ({ name: `旧${i}`, pin: false }));
    assert.equal(enforceLineCapacity({ previousLines: tenOld, mergedLines: [...tenOld, { name: '新', pin: false }] }).model.length, 10);
    const pinned = enforceLineCapacity({ previousLines: tenOld, mergedLines: [...tenOld, { name: '锁', pin: true }, { name: '锁2', pin: true }] });
    assert.equal(pinned.model.filter(line => !line.pin).length, 10);
    assert.deepEqual(pinned.model.filter(line => line.pin).map(line => line.name), ['锁', '锁2']);
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
    assert.ok(results.every(result => result.status === 'updated' || result.status === 'cancelled'));
    assert.ok(committed <= 1, '旧 owner 不得提交');
});
