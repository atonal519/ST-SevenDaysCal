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
import { mergePinned } from './mutations.js';
import { activeLines, buildLinesInjection } from './strategy.js';

const raw = '<storylines_widget>\nLine: 主线|推进|萌芽|1|今天|player|false|false\nDesc: 当前状态\nNext: 下一步信号\n</storylines_widget>';
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
test('release prompt keeps flexible count, Next contract, and local 6x3 cues', () => {
    const prompt = buildLinesPrompt('用户', '角色', 'user', '', 'auto', { freshTickets: [{ selections: [{ label: '时机', prompt: '近日' }] }] });
    assert.match(prompt, /条目数量按当前剧情证据灵活决定/);
    assert.match(prompt, new RegExp(LINE_NEXT_RELEASE_CONTRACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(prompt, /本轮本地预掷影响角度/);
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
        drawTickets: async () => [], vectorCapacity: 8, buildPrompt: () => 'release prompt', callApi: async () => { calls++; return raw; },
        commit: value => { committed = value; }, runtime: { start() {}, finish() {} },
    });
    const result = await controller.run(false, { reroll: true });
    assert.equal(result.status, 'updated'); assert.equal(calls, 1); assert.match(committed, /storylines_widget/);
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
    const controller = createLinesInjectionController({ context: { setExtensionPrompt: (...args) => calls.push(args) }, enabled: () => true, settings: () => ({ linesEnabled: true, linesInject: true }), readRaw: () => raw });
    controller.refresh();
    assert.match(calls.at(-1)[1], /活线/);
    assert.doesNotMatch(calls.at(-1)[1], /终线/);
});

test('concurrent generation entry is owned once and stale owner cannot commit', async () => {
    const owners = createTaskOwnerManager(); let calls = 0; let committed = 0; let release;
    const pending = new Promise(resolve => { release = resolve; });
    const env = { owners, chatId: () => 'chat', cacheKey: () => 'key', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 1 }), drawTickets: async () => [], vectorCapacity: 8, buildPrompt: () => 'p', callApi: async () => { calls++; await pending; return raw; }, commit: () => { committed++; }, runtime: { start() {}, finish() {} } };
    const first = createLinesGenerationController(env).run();
    const second = createLinesGenerationController(env).run();
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1, '并发入口最终只能让当前 owner 调用一次 API');
    assert.ok(results.every(result => result.status === 'updated' || result.status === 'cancelled'));
    assert.ok(committed <= 1, '旧 owner 不得提交');
});
