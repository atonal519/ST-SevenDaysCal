import test from 'node:test';
import assert from 'node:assert/strict';
import { getExternalDiagnostics, recordDiagnosticAttempt, recordDiagnosticResult, registerExternalStorageContext } from './external-chat-storage.js';
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
        registerExternalStorageContext(() => ctx);
        recordDiagnosticAttempt({ requestId: 'diag-test-1', module: 'lines' });
        recordDiagnosticResult({ requestId: 'diag-test-1', module: 'lines', event: 'generation-ui-failed', status: 'failed', phase: 'ui' });
        recordDiagnosticResult({ requestId: 'diag-test-1', module: 'lines', event: 'generation-ui-displayed', status: 'displayed', phase: 'ui' });
        const attempt = getExternalDiagnostics()[0].attempts.lines;
        assert.equal(attempt.result.ui, 'failed');
        assert.equal(safeSaveDiagnosticFields({ commitState: 'local-applied' }).commitState, 'local-applied');
    } finally {
        globalThis.fetch = originalFetch;
        registerExternalStorageContext(() => null);
    }
});
