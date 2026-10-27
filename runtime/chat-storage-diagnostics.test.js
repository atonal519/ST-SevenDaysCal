import test from 'node:test';
import assert from 'node:assert/strict';
import { getChatDiagnostics, recordDiagnosticAttempt, recordDiagnosticResult, recordDiagnosticTransport, refreshDiagnosticRetention, registerChatStorageContext } from './chat-storage.js';
import { safeSaveDiagnosticFields } from './diagnostic-trace.js';

test('diagnostics-v1 keeps UI failure sticky and accepts local-applied commit state', () => {
    const originalFetch = globalThis.fetch;
    const ctx = {
        chatId: 'diagnostics-projection-test',
        chatMetadata: { 'sp-store': { version: 1, data: {} } },
        chat: [{ mes: 'in-memory reply', name: 'character' }],
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ enabled: false }) });
    try {
        registerChatStorageContext(() => ctx);
        recordDiagnosticAttempt({ requestId: 'diag-test-1', module: 'lines' });
        recordDiagnosticResult({ requestId: 'diag-test-1', module: 'lines', event: 'generation-ui-failed', status: 'failed', phase: 'ui' });
        recordDiagnosticResult({ requestId: 'diag-test-1', module: 'lines', event: 'generation-ui-displayed', status: 'displayed', phase: 'ui' });
        const attempt = getChatDiagnostics()[0].attempts.lines;
        assert.equal(attempt.result.ui, 'failed');
        assert.equal(safeSaveDiagnosticFields({ commitState: 'local-applied' }).commitState, 'local-applied');
    } finally {
        globalThis.fetch = originalFetch;
        registerChatStorageContext(() => null);
    }
});

test('successful request messages expire ten minutes after completion during the next diagnostic update', () => {
    const originalNow = Date.now; let now = 1_800_000_000_000; Date.now = () => now;
    const ctx = { chatId: 'diagnostics-success-retention', chatMetadata: { 'sp-store': { version: 1, data: {} } }, chat: [{ mes: 'reply' }] };
    try {
        registerChatStorageContext(() => ctx);
        recordDiagnosticAttempt({ requestId: 'success-retention', module: 'lines', messages: [{ role: 'user', content: 'full input' }] });
        recordDiagnosticTransport({ requestId: 'success-retention', module: 'lines', ok: true, rawResponse: 'raw result', httpStatus: 200 });
        let attempt = getChatDiagnostics()[0].attempts.lines;
        assert.equal(attempt.finishedAt, undefined, 'HTTP 200 alone is not terminal');
        assert.deepEqual(attempt.messages, [{ role: 'user', content: 'full input' }]);
        recordDiagnosticResult({ requestId: 'success-retention', module: 'lines', event: 'generation-accepted', status: 'accepted', reasonCode: 'lines-valid' });
        assert.equal(getChatDiagnostics()[0].attempts.lines.finishedAt, undefined, 'ordinary accepted validation is still awaiting its result');
        recordDiagnosticResult({ requestId: 'success-retention', module: 'lines', event: 'generation-locally-applied', status: 'local-applied' });
        const finishedAt = getChatDiagnostics()[0].attempts.lines.finishedAt;
        assert.equal(finishedAt, now);

        now += 10 * 60 * 1000 - 1;
        recordDiagnosticAttempt({ requestId: 'other-module', module: 'point', messages: [{ role: 'user', content: 'other input' }] });
        attempt = getChatDiagnostics()[0].attempts.lines;
        assert.deepEqual(attempt.messages, [{ role: 'user', content: 'full input' }]);
        assert.equal(attempt.finishedAt, finishedAt, 'another module update does not renew this attempt');

        now += 1;
        recordDiagnosticTransport({ requestId: 'other-module', module: 'point', ok: true, httpStatus: 200 });
        attempt = getChatDiagnostics()[0].attempts.lines;
        assert.equal(Object.hasOwn(attempt, 'messages'), false);
        assert.equal(attempt.rawResponse, 'raw result');
        assert.equal(attempt.result.commit, 'local-applied');
        assert.equal(attempt.finishedAt, finishedAt);
        assert.equal(getChatDiagnostics()[0].attempts.point.messages[0].content, 'other input', 'the pending other request stays available');
    } finally {
        Date.now = originalNow;
        registerChatStorageContext(() => null);
    }
});

test('failed requests retain inputs for 24 hours, while fallback and incomplete responses remain unresolved', () => {
    const originalNow = Date.now; let now = 1_810_000_000_000; Date.now = () => now;
    const ctx = { chatId: 'diagnostics-failure-retention', chatMetadata: { 'sp-store': { version: 1, data: {} } }, chat: [{ mes: 'reply' }] };
    try {
        registerChatStorageContext(() => ctx);
        recordDiagnosticAttempt({ requestId: 'transport-failure', module: 'point', messages: [{ role: 'user', content: 'failed input' }] });
        recordDiagnosticTransport({ requestId: 'transport-failure', module: 'point', ok: false, rawResponse: 'failure raw', errorClass: 'upstream-timeout', httpStatus: 200 });
        const finishedAt = getChatDiagnostics()[0].attempts.point.finishedAt;
        assert.equal(finishedAt, now, 'an explicit transport failure ends even when status code was HTTP 200');
        assert.deepEqual(getChatDiagnostics()[0].attempts.point.messages, [{ role: 'user', content: 'failed input' }]);

        recordDiagnosticAttempt({ requestId: 'response-only', module: 'space', messages: [{ role: 'user', content: 'unresolved input' }] });
        recordDiagnosticTransport({ requestId: 'response-only', module: 'space', ok: true, rawResponse: 'response raw', httpStatus: 200 });
        recordDiagnosticAttempt({ requestId: 'fallback-only', module: 'theater', messages: [{ role: 'user', content: 'fallback input' }] });
        recordDiagnosticResult({ requestId: 'fallback-only', module: 'theater', event: 'generation-fallback', status: 'fallback' });
        recordDiagnosticAttempt({ requestId: 'unknown-save', module: 'judge', messages: [{ role: 'user', content: 'unknown save input' }] });
        recordDiagnosticResult({ requestId: 'unknown-save', module: 'judge', event: 'generation-rejected', status: 'failed', phase: 'save', commitState: 'unknown' });
        assert.equal(getChatDiagnostics()[0].attempts.judge.finishedAt, undefined, 'unknown save outcome is not a completed failure');
        recordDiagnosticAttempt({ requestId: 'resolved-after-unknown', module: 'outline', messages: [{ role: 'user', content: 'resolved later' }] });
        recordDiagnosticResult({ requestId: 'resolved-after-unknown', module: 'outline', event: 'generation-locally-applied', status: 'local-applied' });
        const previousSuccessAt = getChatDiagnostics()[0].attempts.outline.finishedAt;
        now += 11 * 60 * 1000;
        recordDiagnosticResult({ requestId: 'resolved-after-unknown', module: 'outline', event: 'generation-rejected', status: 'failed', phase: 'save', commitState: 'unknown' });
        assert.deepEqual(getChatDiagnostics()[0].attempts.outline.messages, [{ role: 'user', content: 'resolved later' }]);
        recordDiagnosticResult({ requestId: 'resolved-after-unknown', module: 'outline', event: 'generation-locally-applied', status: 'local-applied' });
        assert.equal(getChatDiagnostics()[0].attempts.outline.finishedAt, now, 'resolving a prior unknown state starts a fresh retention window');
        assert.notEqual(getChatDiagnostics()[0].attempts.outline.finishedAt, previousSuccessAt);
        now += 3 * 24 * 60 * 60 * 1000;
        recordDiagnosticAttempt({ requestId: 'retention-trigger', module: 'axis', messages: [{ role: 'user', content: 'trigger' }] });
        const attempts = getChatDiagnostics()[0].attempts;
        assert.equal(Object.hasOwn(attempts.point, 'messages'), false);
        assert.equal(attempts.point.rawResponse, 'failure raw');
        assert.equal(attempts.point.transport.errorClass, 'upstream-timeout');
        assert.equal(attempts.space.finishedAt, undefined);
        assert.equal(attempts.space.messages[0].content, 'unresolved input', 'HTTP success without terminal processing stays retained');
        assert.equal(attempts.theater.finishedAt, undefined);
        assert.equal(attempts.theater.messages[0].content, 'fallback input', 'recoverable fallback alone is not a terminal failure');
        assert.equal(attempts.judge.finishedAt, undefined);
        assert.equal(attempts.judge.messages[0].content, 'unknown save input', 'unknown save outcome remains available beyond either TTL');
        recordDiagnosticResult({ requestId: 'unknown-save', module: 'judge', event: 'generation-locally-applied', status: 'local-applied' });
        assert.equal(getChatDiagnostics()[0].attempts.judge.finishedAt, now, 'a later explicit resolution starts the appropriate TTL');
    } finally {
        Date.now = originalNow;
        registerChatStorageContext(() => null);
    }
});

test('accepted-only no-ops get a success TTL, and legacy terminal inputs start their TTL when first observed', () => {
    const originalNow = Date.now; let now = 1_820_000_000_000; Date.now = () => now;
    const ctx = { chatId: 'diagnostics-legacy-retention', chatMetadata: { 'sp-store': { version: 1, data: {} } }, chat: [{ mes: 'reply' }] };
    try {
        registerChatStorageContext(() => ctx);
        for (const [module, reasonCode] of [['outline-judge', 'no-advance'], ['ledger-provenance', 'provenance-valid'], ['axis-date', 'date-explicit-unknown']]) {
            const requestId = `noop-${module}`;
            recordDiagnosticAttempt({ requestId, module, messages: [{ role: 'user', content: requestId }] });
            recordDiagnosticResult({ requestId, module, event: 'generation-accepted', status: 'accepted', reasonCode });
            assert.equal(getChatDiagnostics()[0].attempts[module].finishedAt, now);
        }

        const legacyAttempt = { requestId: 'legacy-complete', startedAt: now - 5 * 24 * 60 * 60 * 1000, model: 'old', messages: [{ role: 'user', content: 'legacy input' }], rawResponse: 'legacy raw', transport: { status: 'success' }, result: { processing: 'accepted', commit: 'committed', ui: 'displayed', events: [] } };
        refreshDiagnosticRetention(ctx);
        const currentReplyId = getChatDiagnostics()[0]?.replyId;
        ctx.chatMetadata['sp-store'].data['diagnostics-v1'] = { schemaVersion: 1, floors: [{ replyId: currentReplyId, floor: 0, attempts: { lines: legacyAttempt } }] };
        refreshDiagnosticRetention(ctx);
        let retained = getChatDiagnostics()[0].attempts.lines;
        assert.equal(retained.finishedAt, now, 'legacy has no reliable end timestamp, so first observation starts its retention window');
        assert.deepEqual(retained.messages, [{ role: 'user', content: 'legacy input' }]);
        now += 10 * 60 * 1000;
        recordDiagnosticAttempt({ requestId: 'legacy-trigger', module: 'other', messages: [] });
        retained = getChatDiagnostics()[0].attempts.lines;
        assert.equal(Object.hasOwn(retained, 'messages'), false);
        assert.equal(retained.rawResponse, 'legacy raw');
        assert.equal(retained.result.commit, 'committed');
    } finally {
        Date.now = originalNow;
        registerChatStorageContext(() => null);
    }
});

test('a later real UI failure switches a previously completed success to the 24-hour window once', () => {
    const originalNow = Date.now; let now = 1_830_000_000_000; Date.now = () => now;
    const ctx = { chatId: 'diagnostics-ui-transition', chatMetadata: { 'sp-store': { version: 1, data: {} } }, chat: [{ mes: 'reply' }] };
    try {
        registerChatStorageContext(() => ctx);
        recordDiagnosticAttempt({ requestId: 'late-ui', module: 'space', messages: [{ role: 'user', content: 'space input' }] });
        recordDiagnosticResult({ requestId: 'late-ui', module: 'space', event: 'generation-locally-applied', status: 'local-applied' });
        const successAt = getChatDiagnostics()[0].attempts.space.finishedAt;
        now += 60_000;
        recordDiagnosticResult({ requestId: 'late-ui', module: 'space', event: 'generation-ui-failed', status: 'failed', phase: 'ui' });
        const failedAt = getChatDiagnostics()[0].attempts.space.finishedAt;
        assert.equal(failedAt, now);
        assert.notEqual(failedAt, successAt);
        now += 24 * 60 * 60 * 1000 - 1;
        recordDiagnosticAttempt({ requestId: 'failure-trigger', module: 'axis', messages: [] });
        let attempt = getChatDiagnostics()[0].attempts.space;
        assert.deepEqual(attempt.messages, [{ role: 'user', content: 'space input' }]);
        assert.equal(attempt.finishedAt, failedAt, 'repeated updates do not restart failure retention');
        now += 1;
        recordDiagnosticResult({ requestId: 'failure-trigger', module: 'axis', event: 'generation-accepted', status: 'accepted', reasonCode: 'axis-valid' });
        attempt = getChatDiagnostics()[0].attempts.space;
        assert.equal(Object.hasOwn(attempt, 'messages'), false);
        assert.equal(attempt.result.ui, 'failed');
    } finally {
        Date.now = originalNow;
        registerChatStorageContext(() => null);
    }
});
