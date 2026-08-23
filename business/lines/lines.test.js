import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLinesResponse, parseLines } from './schema.js';
import { mergePinned } from './mutations.js';
import { createAdvanceStrategy, classifyRenderedFloor, chooseSwipeLayer, activeLines } from './strategy.js';
import { prefixNext } from './inline.js';
import { createLinesGenerationController } from './controller.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { createLinesLifecycle } from './lifecycle.js';
import { createSwipeLinesStore } from './swipe-store.js';
import { createLinesInjectionController } from './injection.js';
import { createLinesFeature } from './feature.js';
import { createLinesRuntime } from './runtime.js';
import { parseLineWidget, addLineWidget, editLineWidget, commitLineWidget } from './widget.js';

const strict = '<storylines_widget>\nLine: 主线|冲突|萌芽|1|今天|world|false|true\nDesc: 当前\nNext: 继续\n</storylines_widget>';
const legacy5 = 'Line: 旧线|冲突|萌芽|1|今天\nDesc: 旧状态\nNext: 旧下一步';
const legacy7 = 'Line: 旧线|冲突|萌芽|1|今天|world|true\nDesc: 旧状态\nNext: 旧下一步';

test('strict output clears AI pin while legacy 5/7/8 fields remain readable', () => {
    assert.equal(validateLinesResponse(strict).ok, true);
    assert.equal(validateLinesResponse(strict).model[0].pin, false);
    assert.equal(parseLines(legacy5).length, 1);
    assert.equal(parseLines(legacy7).length, 1);
    assert.equal(parseLines(strict).length, 1);
});

test('pinned merge retains old lock and accepts seven or more valid lines', () => {
    const old = parseLines(strict)[0];
    const fresh = Array.from({ length: 7 }, (_, i) => `Line: n${i}|推进|筹备|1|今天|world|false|false\nDesc: d\nNext: n`).join('\n');
    const result = mergePinned(strict, `<storylines_widget>\n${fresh}\n</storylines_widget>`);
    assert.equal(result.ok, true);
    assert.equal(result.model.length, 8);
    assert.equal(old.pin, true);
});

test('advance strategy preserves first observation, accumulation and manual gate', () => {
    assert.deepEqual(createAdvanceStrategy({ mode: 'turns', interval: 2, counter: 0 }), { shouldAdvance: false, counter: 1 });
    assert.deepEqual(createAdvanceStrategy({ mode: 'turns', interval: 2, counter: 1 }), { shouldAdvance: true, counter: 0 });
    assert.equal(createAdvanceStrategy({ mode: 'manual', interval: 1, counter: 0 }).shouldAdvance, false);
    assert.equal(createAdvanceStrategy({ mode: 'days', dayAnchor: '2-3', previousDay: '2-2' }).shouldAdvance, true);
});

test('render strategy distinguishes reroll, swipe and stored layer', () => {
    assert.equal(classifyRenderedFloor({ messageId: 2, lastSeen: 2, contentChanged: true }).shouldRebuild, true);
    assert.deepEqual(chooseSwipeLayer({ pendingGeneration: true, swipeId: 1 }), { action: 'wait', swipeId: 1 });
    assert.deepEqual(chooseSwipeLayer({ swipeId: 1, stored: { swipes: { '1': 'raw' } }, baseline: 'base' }), { action: 'restore', raw: 'raw' });
});

test('active filter and inline prefix preserve terminal and stall semantics', () => {
    assert.equal(activeLines(strict).length, 1);
    assert.equal(prefixNext('**下一步：** 继续', false), '下一步：继续');
    assert.equal(prefixNext('恢复条件：解除', true), '恢复条件：解除');
});

test('generation controller commits success and rejects invalid or missing API without writing', async () => {
    let saved = { raw: strict, ts: 1 };
    let writes = 0;
    const make = (config, response) => createLinesGenerationController({
        owners: createTaskOwnerManager(), chatId: () => 'chat-1', loadConfig: () => config,
        readSaved: () => saved, buildPrompt: () => 'prompt', callApi: async () => response,
        commit: raw => { saved = { raw, ts: 2 }; writes++; }, cleanup: owner => owner.status = 'finished',
    });
    assert.equal((await make({ url: 'u', key: 'k' }, strict).run()).status, 'updated');
    assert.equal(writes, 1);
    assert.equal((await make({ url: 'u', key: 'k' }, 'bad').run()).status, 'failed');
    assert.equal((await make({}, strict).run()).status, 'failed');
    assert.equal(writes, 1);
});

test('lifecycle CMR matrix: new floor advances once, reroll and pending swipe latch once', () => {
    const life = createLinesLifecycle();
    assert.deepEqual(life.advanceCounter({ mode: 'turns', interval: 2 }), { shouldAdvance: false, counter: 1 });
    assert.deepEqual(life.advanceCounter({ mode: 'turns', interval: 2 }), { shouldAdvance: true, counter: 0 });
    life.markPendingSwipe(8);
    assert.equal(life.consumePendingSwipe(7), false);
    assert.equal(life.consumePendingSwipe(8), true);
    assert.equal(life.consumePendingSwipe(8), false);
    life.markGenerationStarted({ reroll: true, excludedAssistant: { mesId: 8 }, now: 100 });
    assert.equal(life.streamUntil, 3100);
    assert.equal(life.consumePendingReroll(), true);
    assert.equal(life.consumePendingReroll(), false);
    life.markToken({ now: 2000 });
    assert.equal(life.streamUntil, 3500);
    life.endGeneration();
    assert.equal(life.streamUntil, 0);
});

test('lifecycle owns day cursor and chat reset clears stream/reroll state', () => {
    const life = createLinesLifecycle();
    const decide = ({ previousDay }) => ({ shouldAdvance: previousDay !== '2-2' });
    assert.equal(life.detectInGameDayChange({ day: '2-2', decide }), true);
    assert.equal(life.detectInGameDayChange({ day: '2-2', decide }), false);
    life.markGenerationStarted({ reroll: true, excludedAssistant: { mesId: 3 }, now: 10 });
    life.markToken({ now: 20 });
    life.resetChat();
    assert.equal(life.lastDay, null);
    assert.equal(life.streamUntil, 0);
    assert.equal(life.pendingReroll, false);
    assert.equal(life.rerollExcludedAssistant, null);
});

test('swipe store clears only the selected chat and preserves raw payload', () => {
    const values = new Map();
    const storage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const store = createSwipeLinesStore({ storage });
    store.write('chat-a', 2, { baseline: 'B0', swipes: { '1': 'A' } });
    store.write('chat-b', 2, { baseline: 'B1', swipes: { '1': 'B' } });
    assert.deepEqual(store.read('chat-a', 2), { baseline: 'B0', swipes: { '1': 'A' } });
    assert.equal(store.clearAll('chat-a'), 1);
    assert.equal(store.read('chat-a', 2), null);
    assert.deepEqual(store.read('chat-b', 2), { baseline: 'B1', swipes: { '1': 'B' } });
});

test('injection matrix clears for disabled/plugin-off/empty/terminal and is idempotent', () => {
    const calls = [];
    const context = { setExtensionPrompt: (...args) => calls.push(args) };
    const controller = createLinesInjectionController({ context, enabled: () => true, settings: () => ({ linesEnabled: true, linesInject: true }), readRaw: () => strict, promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } });
    controller.refresh(); controller.refresh();
    assert.equal(calls.filter(x => x[1]).length, 2);
    const disabled = createLinesInjectionController({ context, enabled: () => false, settings: () => ({ linesEnabled: true, linesInject: true }), readRaw: () => strict });
    disabled.refresh();
    assert.equal(calls.at(-1)[1], '');
    const terminal = createLinesInjectionController({ context, enabled: () => true, settings: () => ({ linesEnabled: true, linesInject: true }), readRaw: () => '<storylines_widget>\nLine: 终线|冲突|已爆发|1|今|world|false|false\nDesc: d\nNext: n\n</storylines_widget>' });
    terminal.refresh();
    assert.equal(calls.at(-1)[1], '');
});

test('widget add/edit/commit keeps pin and rejects malformed fields', () => {
    const added = addLineWidget('', 'Line: 新线|冲突|萌芽|1|今天|world|false\nDesc: 描述\nNext: 下一步');
    assert.equal(added.ok, true);
    assert.equal(parseLines(added.raw)[0].pin, true);
    const edited = editLineWidget(added.raw, 0, 'Line: 改线|推进|发酵|2|明天|world|true\nDesc: 新描述\nNext: 新下一步');
    assert.equal(edited.ok, true);
    assert.equal(parseLines(edited.raw)[0].name, '改线');
    assert.equal(parseLines(edited.raw)[0].pin, true);
    assert.equal(commitLineWidget(edited.raw, 'Line: x|y|z|1|今|world|false|false\nDesc: d\nNext: n', { editIndex: 9 }).ok, false);
    assert.equal(parseLineWidget('Line: bad|only|three'), null);
});

test('production lines feature composes runtime and all injected owners', () => {
    const context = { chatId: 'test', constants: { promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } }, setExtensionPrompt() {} };
    const feature = createLinesFeature({
        injectionEnv: { context: () => context, enabled: () => true, settings: () => ({ linesEnabled: true, linesInject: false }), readRaw: () => '', promptTypes: { IN_CHAT: 1 }, promptRoles: { SYSTEM: 0 } },
        dashedEnv: { keyDesc: () => 'dashed-test', readStore: () => null, writeStore() {}, removeStore() {}, getSettings: () => ({ dashedEnabled: false, dashedCleanupEnabled: true, dashedKeepCount: 2 }), context: () => context, chatId: () => context.chatId, loadConfig: () => ({}), callApi: async () => '', filterRerollItems: x => x, dialog: { selectMany: async () => null, confirm: async () => true }, escapeHtml: String, escapeAttr: String },
        generationEnv: { chatId: () => context.chatId, loadConfig: () => ({}), readSaved: () => ({ raw: '' }), buildPrompt: () => '', callApi: async () => '', commit() {} },
        actionsEnv: { isBusy: () => false, readSaved: () => ({ raw: '' }), readRaw: () => '', write() {}, remove() {}, confirm: async () => false, render: () => '', setCached() {}, refreshPanel() {}, refreshInline() {}, resetCounter() {}, runGenerate: async () => {}, precheck: async () => true, silent: () => true },
    });
    assert.equal(typeof feature.runtime.start, 'function');
    assert.equal(typeof feature.generation.run, 'function');
    assert.equal(typeof feature.actions.pin, 'function');
    assert.equal(typeof feature.dashed.run, 'function');
    assert.equal(typeof feature.injection.refresh, 'function');
    assert.equal(typeof feature.lifecycle.resetChat, 'function');
    assert.equal(typeof feature.swipeStore.read, 'function');
});

test('production event facade owns CMR, swipe, edit, sent and generation sequence', async () => {
    const calls = [];
    const chat = [{ mes: 'u' }, { mes: 'assistant' }];
    const feature = createLinesFeature({
        pluginEnabled: () => true, getSettings: () => ({ linesEnabled: true, notifyMode: 'off' }), getMode: () => 'manual',
        floorSignature: id => `s${id}`, messageText: id => chat[id]?.mes, chat: () => chat, chatId: () => 'c',
        cacheKey: () => 'k', readRaw: () => '', writeStore() {}, refreshInlineWindow: () => calls.push('refresh'),
        freezeSnapshot: id => calls.push(`freeze:${id}`), floorSignature: id => `s${id}`,
        injectionEnv: { context: () => ({ chatId: 'c', setExtensionPrompt() {} }), enabled: () => false, settings: () => ({}), readRaw: () => '' },
        dashedEnv: { keyDesc: () => 'd', readStore: () => null, writeStore() {}, removeStore() {}, getSettings: () => ({}), context: () => ({ chatId: 'c' }), chatId: () => 'c' },
    });
    await feature.onCharacterRendered({ messageId: 1, type: 'normal' });
    feature.onGenerationStarted({ genType: 'regenerate' }); feature.onToken(); feature.onGenerationEnded();
    feature.onEdited({ mesId: 1 }); feature.onSent({ insertAt: 2 });
    assert.equal(feature.lifecycle.lastSeenMaxMesId, 1);
    assert.equal(feature.lifecycle.streamUntil, 0);
    assert.ok(calls.includes('freeze:1'));
});

test('feature inline contract keeps controls, progress beads, stall and dashed composition', () => {
    const feature = createLinesFeature({
        getSettings: () => ({ linesInlineEnabled: true }), readRaw: () => strict,
        escapeHtml: value => String(value), escapeAttr: value => String(value), cleanText: value => String(value),
        stageColors: { 萌芽: '#d6b85a' }, makeInjectBtn: value => `<button data-inject="${value}">注入</button>`,
        dashed: { inlineHtml: () => '<div class="sp-dashed-inline-sub">dashed</div>' },
    });
    const html = feature.inlineHtml(strict);
    assert.match(html, /sp-inline-refresh-lines/);
    assert.match(html, /sp-inline-advance-lines/);
    assert.match(html, /sp-bead-on/);
    assert.match(html, /sp-line-del-one/);
    assert.equal(typeof feature.rerunSwipe, 'function');
});

test('never-settling generation abort clears owner and runtime synchronously', async () => {
    let chatId = 'never'; let restores = 0;
    const feature = createLinesFeature({
        chatId: () => chatId, cacheKey: () => 'k',
        restoreBaseline: () => { restores++; }, pluginEnabled: () => true, getSettings: () => ({ linesEnabled: true }),
        generationEnv: { chatId: () => 'never', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '', ts: 0 }), buildPrompt: () => '', callApi: () => new Promise(() => {}), commit: () => {} },
    });
    const pending = feature.generation.run();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(feature.runtime.busy, true);
    chatId = 'new-chat';
    feature.onChatChanged({ lastSeen: 0 });
    assert.equal(restores, 0);
    assert.equal(feature.runtime.busy, false);
    chatId = 'never';
    feature.abortGeneration();
    assert.equal(feature.runtime.busy, false);
    await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 10))]);
});

test('feature-owned counter resets after deleting the final line', async () => {
    let saved = { raw: strict }; let confirmed = false;
    const feature = createLinesFeature({
        getSettings: () => ({ linesInlineEnabled: true }), readRaw: () => saved?.raw || '',
        actionsEnv: { readSaved: () => saved, readRaw: () => saved?.raw || '', write: value => { saved = value; }, remove: () => { saved = null; }, confirm: async () => { confirmed = true; return true; }, toast() {}, precheck: async () => true, silent: () => true },
    });
    feature.lifecycle.counter = 5;
    await feature.actions.delete(0);
    assert.equal(confirmed, true);
    assert.equal(feature.lifecycle.counter, 0);
});

test('generation start refreshes panel with loading contract before abort', async () => {
    const panels = []; const feature = createLinesFeature({
        chatId: () => 'panel', cacheKey: () => 'k', readRaw: () => '', isPanelActive: () => true,
        renderPanelDom: panel => panels.push(panel), loading: () => '<div id="sp-abort-lines">loading</div>', empty: () => 'empty',
        renderEvents: () => 'events', escapeHtml: String, escapeAttr: String, makeInjectBtn: String,
        generationEnv: { chatId: () => 'panel', loadConfig: () => ({ url: 'u', key: 'k' }), readSaved: () => ({ raw: '' }), buildPrompt: () => '', callApi: () => new Promise(() => {}), commit: () => {} },
    });
    feature.generation.run();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(String(panels.at(-1)?.body), /sp-abort-lines/);
    feature.abortGeneration();
    assert.equal(feature.runtime.busy, false);
});
