import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bindLedgerCapture, ledgerLatestAiFloorId, ledgerNarrativeMessage } from '../business/ledger/capture.js';
import { createLedgerDeletedHandler } from '../business/ledger/events.js';
import { ledgerGenerationBlock } from '../business/ledger/settings.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function region(startMarker, endMarker) {
    const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `production region: ${startMarker}`);
    return source.slice(start, end);
}
const declarations = region('let   ledgerLastCapturedMsgId = -1;', '// 历·API 兜底判定的间隔');
const callbacks = ['genStart', 'genEnd', 'genStopped', 'ledgerCapture', 'ledgerJudge']
    .map(name => region(`    _stListeners.${name} =`, '\n    };') + '\n    };').join('\n');
const chatReset = region('        ledgerLastCapturedMsgId = lastSeen;', "        currentView = 'user';");
const generationSteps = region('const runLedgerCaptureStep', 'const ledgerInjectionController') + region('const runLedgerJudgeStep', 'const ledgerInlineRenderer');
const ai = text => ({ is_user: false, mes: text });
const user = text => ({ is_user: true, mes: text });

function harness({ interval = 1, captureCounter = 0, judgeCounter = 0 } = {}) {
    const ctx = { chatId: 'synthetic-ledger', chat: [user('u0'), ai('a1'), user('u2'), ai('a3'), user('u4'), ai('a5')] };
    const calls = [], deleted = { cancelled: 0, reconciled: 0 };
    const settings = { ledgerCaptureEnabled: true, notifyMode: 'off' };
    const toasts = [];
    bindLedgerCapture({ context: () => ctx });
    const sandbox = vm.createContext({
        _stListeners: {}, getContext: () => ctx, pluginEnabled: () => true,
        getSettings: () => settings, ledgerGenerationBlock,
        getLedgerCaptureInterval: () => interval, getLedgerJudgeInterval: () => interval,
        ledgerLatestAiFloorId, ledgerNarrativeMessage,
        isAutomationSuppressed: () => false, AUTOMATION_MODULES: { LEDGER_CAPTURE: 'capture', LEDGER_JUDGE: 'judge' },
        runLedgerCaptureWithFeedback: async () => { calls.push('capture'); return { status: 'unchanged' }; },
        runLedgerJudgeWithFeedback: async () => { calls.push('judge'); return { status: 'unchanged' }; },
        formatLedgerCaptureFeedback: () => ({ message: '' }), showToast: message => toasts.push(message), refreshStoryClockInjection() {},
        linesFeature: { onGenerationStarted() {}, onGenerationEnded() {} },
    });
    vm.runInContext(`${declarations}\n${generationSteps}\n${callbacks}\n
        ledgerLastCapturedMsgId = ledgerLastJudgedMsgId = getContext().chat.length - 1;
        ledgerCaptureCounter = ${captureCounter}; ledgerJudgeCounter = ${judgeCounter};
        globalThis.state = () => ({ captureLast: ledgerLastCapturedMsgId, judgeLast: ledgerLastJudgedMsgId, captureCounter: ledgerCaptureCounter, judgeCounter: ledgerJudgeCounter });
        globalThis.drain = () => ledgerAutomationQueue;
        globalThis.invalidateOnDelete = rewindLedgerAutomationAfterDeletion;
        globalThis.queueStale = task => enqueueLedgerAutomation(task);
        globalThis.runManual = () => Promise.all([runLedgerCaptureStep(true), runLedgerJudgeStep(true)]);
        globalThis.resetChat = lastSeen => { ${chatReset} };
    `, sandbox);
    const onDeleted = createLedgerDeletedHandler({
        cancel: () => { deleted.cancelled++; }, onDeleted: sandbox.invalidateOnDelete,
        reconcile: async () => { deleted.reconciled++; return { summary: { changed: false } }; },
    });
    const schedule = async (id = ctx.chat.length - 1, type) => {
        await sandbox._stListeners.ledgerCapture(id, type);
        await sandbox._stListeners.ledgerJudge(id, type);
    };
    const render = async (...args) => {
        await schedule(...args);
        await sandbox.drain();
    };
    const remove = async (from = ctx.chat.length - 1) => { ctx.chat.splice(from); await onDeleted(from, { kind: 'delete' }); };
    return {
        ctx, calls, deleted, render, remove, settings, toasts, runManual: sandbox.runManual, schedule, drain: sandbox.drain,
        state: () => JSON.parse(JSON.stringify(sandbox.state())),
        start: (type = 'normal', dryRun = false) => sandbox._stListeners.genStart(type, {}, dryRun),
        end: () => sandbox._stListeners.genEnd(), stop: () => sandbox._stListeners.genStopped(),
        queueStale: sandbox.queueStale,
        changeChat: () => { ctx.chatId = 'another-synthetic-chat'; ctx.chat = [user('u0'), ai('a1'), user('u2'), ai('a3'), user('u4'), ai('a5')]; sandbox.resetChat(5); },
        appendReply: async () => { ctx.chat.push(user('next user'), ai('next reply')); await render(); },
    };
}

test('the ledger switch blocks manual capture and update before their preparation, until re-enabled', async () => {
    const h = harness();
    h.settings.ledgerCaptureEnabled = false;
    await h.runManual();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.toasts, ['请先开启刻度功能', '请先开启刻度功能']);
    h.settings.ledgerCaptureEnabled = true;
    await h.runManual();
    assert.deepEqual(h.calls, ['capture', 'judge']);
});

test('queued ledger automation checks the switch at execution and quietly skips while disabled', async () => {
    const h = harness();
    let release;
    const prior = new Promise(resolve => { release = resolve; });
    const blocker = h.queueStale(() => prior);
    h.ctx.chat.push(user('next user'), ai('next reply'));
    await h.schedule();
    assert.notEqual(h.drain(), blocker, 'the reply queued work before the switch was disabled');
    h.settings.ledgerCaptureEnabled = false;
    release();
    await h.drain();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.toasts, []);
});

for (const { interval, endBeforeRender, renderType } of [
    { interval: 1, endBeforeRender: true },
    { interval: 4, endBeforeRender: false, renderType: 'regenerate' },
]) {
    test(`same-floor rerolls preserve both counters with ${endBeforeRender ? 'END' : 'render'} first`, async () => {
        const h = interval === 1 ? harness() : harness({ interval, captureCounter: 2, judgeCounter: 1 });
        const before = h.state();
        for (const text of ['first replacement', 'second replacement']) {
            h.start('regenerate'); await h.remove(); h.ctx.chat.push(ai(text));
            if (endBeforeRender) h.end();
            await h.render(5, renderType);
            if (!endBeforeRender) h.end();
            assert.deepEqual(h.state(), before);
        }
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.deleted, { cancelled: 2, reconciled: 2 });
    });
}

test('new replies preserve the separate partial interval counts after rerolls', async () => {
    const h = harness({ interval: 4, captureCounter: 2, judgeCounter: 1 });
    h.start('regenerate'); await h.remove(); h.ctx.chat.push(ai('replacement')); h.end(); await h.render();
    await h.appendReply();
    assert.equal(h.state().captureCounter, 3); assert.equal(h.state().judgeCounter, 2); assert.deepEqual(h.calls, []);
    await h.appendReply(); assert.deepEqual(h.calls, ['capture']);
    await h.appendReply(); assert.deepEqual(h.calls, ['capture', 'judge']);
});

test('ordinary deletion and deletion during a normal generation still rewind and reconcile', async () => {
    for (const generating of [false, true]) {
        const h = harness();
        if (generating) h.start('normal');
        await h.remove(3); h.ctx.chat.push(ai('new reply after true deletion')); await h.render();
        assert.deepEqual(h.calls, ['capture', 'judge']);
        assert.equal(h.deleted.cancelled, 1); assert.equal(h.deleted.reconciled, 1);
    }
});

test('a real deletion of another floor during regenerate is not swallowed by generation state', async () => {
    const h = harness(); h.start('regenerate'); await h.remove(3);
    h.ctx.chat.push(ai('new reply at another floor')); await h.render();
    assert.deepEqual(h.calls, ['capture', 'judge']);
});

test('a matching reroll deletion invalidates old queued work but still reconciles sources', async () => {
    const h = harness({ interval: 4, captureCounter: 2, judgeCounter: 1 }); let staleRuns = 0;
    const pending = h.queueStale(() => { staleRuns++; });
    h.start('regenerate'); await h.remove(); await pending;
    assert.equal(staleRuns, 0); assert.equal(h.deleted.reconciled, 1);
    assert.equal(h.state().captureCounter, 2); assert.equal(h.state().judgeCounter, 1);
});

for (const nextType of ['normal', 'regenerate']) {
    test(`STOP before replacement leaves the next ${nextType} reply countable`, async () => {
        const h = harness();
        h.start('regenerate'); await h.remove(); h.stop();
        h.start(nextType); h.ctx.chat.push(ai('first actual new reply')); h.end(); await h.render(5, nextType);
        assert.deepEqual(h.calls, ['capture', 'judge']);
    });
}

test('STOP after an AI replacement does not turn that same floor into another contribution', async () => {
    const h = harness(); h.start('regenerate'); await h.remove(); h.ctx.chat.push(ai('replacement')); h.stop(); await h.render();
    assert.deepEqual(h.calls, []);
    await h.appendReply(); assert.deepEqual(h.calls, ['capture', 'judge']);
});

test('dry-run and quiet starts do not arm replacement handling or alter existing counts', async () => {
    for (const [type, dryRun] of [['regenerate', true], ['quiet', false]]) {
        const h = harness({ interval: 4, captureCounter: 2, judgeCounter: 1 }), before = h.state();
        h.start(type, dryRun); h.end(); assert.deepEqual(h.state(), before);
        await h.remove(); h.ctx.chat.push(ai('real reply')); await h.render();
        assert.equal(h.state().captureCounter, 3); assert.equal(h.state().judgeCounter, 2);
    }
});

test('chat reset clears replacement intent before an ordinary same-index deletion in the next chat', async () => {
    const h = harness(); h.start('regenerate'); h.changeChat();
    await h.remove(); h.ctx.chat.push(ai('new chat reply')); await h.render();
    assert.deepEqual(h.calls, ['capture', 'judge']);
});

for (const ending of ['end', 'stop', 'quiet-end']) for (const phase of ['before-delete', 'after-delete', 'empty-placeholder']) {
    test(`an early ${ending} at ${phase} preserves the same-floor reroll`, async () => {
        const h = harness({ interval: 4, captureCounter: 2, judgeCounter: 1 });
        const before = h.state();
        h.start('regenerate');
        if (phase !== 'before-delete') await h.remove();
        if (phase === 'empty-placeholder') h.ctx.chat.push(ai(''));
        if (ending === 'quiet-end') h.start('quiet');
        if (ending === 'stop') h.stop(); else h.end();
        if (phase === 'before-delete') await h.remove();
        if (phase === 'empty-placeholder') h.ctx.chat[5].mes = 'same-floor replacement published after the early end';
        else h.ctx.chat.push(ai('same-floor replacement published after the early end'));
        await h.render(5, ending === 'quiet-end' ? undefined : 'regenerate');
        h.end();
        assert.deepEqual(h.state(), before);
        assert.deepEqual(h.calls, []);
        h.start('normal'); await h.appendReply(); h.end();
        assert.equal(h.state().captureCounter, 3);
        assert.equal(h.state().judgeCounter, 2);
        assert.deepEqual(h.calls, []);
    });
}

test('an ended reroll with no replacement leaves the next real generation countable', async () => {
    const h = harness();
    h.start('regenerate'); await h.remove(); h.end();
    h.start('normal'); h.ctx.chat.push(ai('actual new reply after failed reroll'));
    await h.render(); h.end();
    assert.deepEqual(h.calls, ['capture', 'judge']);
});
