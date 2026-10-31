import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bindLedgerCapture, ledgerLatestAiFloorId, ledgerNarrativeMessage } from '../business/ledger/capture.js';
import { createLedgerDeletedHandler } from '../business/ledger/events.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function region(startMarker, endMarker) {
    const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `production region: ${startMarker}`);
    return source.slice(start, end);
}
const declarations = region('let   ledgerLastCapturedMsgId = -1;', '// 历·API 兜底判定的间隔');
const callbacks = [
    ['genStart', 'GENERATION_STARTED'], ['genEnd', 'GENERATION_ENDED'], ['genStopped', 'GENERATION_STOPPED'],
    ['ledgerCapture', 'CHARACTER_MESSAGE_RENDERED'], ['ledgerJudge', 'CHARACTER_MESSAGE_RENDERED'],
].map(([name]) => region(`    _stListeners.${name} =`, '\n    };') + '\n    };').join('\n');
const chatReset = region('        ledgerLastCapturedMsgId = lastSeen;', "        currentView = 'user';");
const ai = text => ({ is_user: false, mes: text });
const user = text => ({ is_user: true, mes: text });

function harness({ interval = 1, captureCounter = 0, judgeCounter = 0 } = {}) {
    const ctx = { chatId: 'synthetic-ledger', chat: [user('u0'), ai('a1'), user('u2'), ai('a3'), user('u4'), ai('a5')] };
    const calls = [], deleted = { cancelled: 0, reconciled: 0 };
    bindLedgerCapture({ context: () => ctx });
    const sandbox = vm.createContext({
        _stListeners: {}, getContext: () => ctx, pluginEnabled: () => true,
        getSettings: () => ({ ledgerCaptureEnabled: true, notifyMode: 'off' }),
        getLedgerCaptureInterval: () => interval, getLedgerJudgeInterval: () => interval,
        ledgerLatestAiFloorId, ledgerNarrativeMessage,
        isAutomationSuppressed: () => false, AUTOMATION_MODULES: { LEDGER_CAPTURE: 'capture', LEDGER_JUDGE: 'judge' },
        runLedgerCaptureStep: async () => { calls.push('capture'); return { status: 'unchanged' }; },
        runLedgerJudgeStep: async () => { calls.push('judge'); return { status: 'unchanged' }; },
        formatLedgerCaptureFeedback: () => ({ message: '' }), showToast() {}, refreshStoryClockInjection() {},
        linesFeature: { onGenerationStarted() {}, onGenerationEnded() {} },
    });
    vm.runInContext(`${declarations}\n${callbacks}\n
        ledgerLastCapturedMsgId = ledgerLastJudgedMsgId = getContext().chat.length - 1;
        ledgerCaptureCounter = ${captureCounter}; ledgerJudgeCounter = ${judgeCounter};
        globalThis.state = () => ({ captureLast: ledgerLastCapturedMsgId, judgeLast: ledgerLastJudgedMsgId, captureCounter: ledgerCaptureCounter, judgeCounter: ledgerJudgeCounter });
        globalThis.drain = () => ledgerAutomationQueue;
        globalThis.invalidateOnDelete = rewindLedgerAutomationAfterDeletion;
        globalThis.queueStale = task => enqueueLedgerAutomation(task);
        globalThis.resetChat = lastSeen => { ${chatReset} };
    `, sandbox);
    const onDeleted = createLedgerDeletedHandler({
        cancel: () => { deleted.cancelled++; }, onDeleted: sandbox.invalidateOnDelete,
        reconcile: async () => { deleted.reconciled++; return { summary: { changed: false } }; },
    });
    const render = async (id = ctx.chat.length - 1, type) => {
        await sandbox._stListeners.ledgerCapture(id, type);
        await sandbox._stListeners.ledgerJudge(id, type);
        await sandbox.drain();
    };
    const remove = async (from = ctx.chat.length - 1) => { ctx.chat.splice(from); await onDeleted(from, { kind: 'delete' }); };
    return {
        ctx, calls, deleted, render, remove,
        state: () => JSON.parse(JSON.stringify(sandbox.state())),
        start: (type = 'normal', dryRun = false) => sandbox._stListeners.genStart(type, {}, dryRun),
        end: () => sandbox._stListeners.genEnd(), stop: () => sandbox._stListeners.genStopped(),
        queueStale: sandbox.queueStale,
        changeChat: () => { ctx.chatId = 'another-synthetic-chat'; ctx.chat = [user('u0'), ai('a1'), user('u2'), ai('a3'), user('u4'), ai('a5')]; sandbox.resetChat(5); },
        appendReply: async () => { ctx.chat.push(user('next user'), ai('next reply')); await render(); },
    };
}

for (const interval of [1, 4]) for (const endBeforeRender of [false, true]) for (const typed of [false, true]) {
    test(`same-floor regenerate never contributes: interval=${interval}, END-first=${endBeforeRender}, typed=${typed}`, async () => {
        const h = harness({ interval, captureCounter: interval === 4 ? 2 : 0, judgeCounter: interval === 4 ? 1 : 0 });
        const before = h.state();
        for (let i = 0; i < 4; i++) {
            h.start('regenerate'); await h.remove(); h.ctx.chat.push(ai(`reroll ${i}`));
            if (endBeforeRender) h.end();
            await h.render(5, typed ? 'regenerate' : undefined);
            if (!endBeforeRender) h.end();
            assert.deepEqual(h.state(), before);
        }
        assert.deepEqual(h.calls, []);
        assert.equal(h.deleted.cancelled, 4); assert.equal(h.deleted.reconciled, 4);
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

for (const nextType of ['normal', 'regenerate']) for (const interval of [1, 4]) {
    test(`STOP before replacement leaves the next real reply countable: ${nextType}, interval=${interval}`, async () => {
        const h = harness({ interval, captureCounter: interval === 4 ? 2 : 0, judgeCounter: interval === 4 ? 1 : 0 });
        h.start('regenerate'); await h.remove(); h.stop();
        h.start(nextType); h.ctx.chat.push(ai('first actual new reply')); h.end(); await h.render(5, nextType);
        if (interval === 1) assert.deepEqual(h.calls, ['capture', 'judge']);
        else { assert.equal(h.state().captureCounter, 3); assert.equal(h.state().judgeCounter, 2); assert.deepEqual(h.calls, []); }
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

test('regenerate with a user as the last message produces a normal countable AI reply', async () => {
    const h = harness(); h.ctx.chat.push(user('user is last'));
    h.start('regenerate'); h.ctx.chat.push(ai('new AI, no prior AI replaced')); h.end(); await h.render(7, 'regenerate');
    assert.deepEqual(h.calls, ['capture', 'judge']);
});

test('chat reset clears replacement intent before an ordinary same-index deletion in the next chat', async () => {
    const h = harness(); h.start('regenerate'); h.changeChat();
    await h.remove(); h.ctx.chat.push(ai('new chat reply')); await h.render();
    assert.deepEqual(h.calls, ['capture', 'judge']);
});
