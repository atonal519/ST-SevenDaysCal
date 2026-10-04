import test from 'node:test';
import assert from 'node:assert/strict';

test('local diagnostics persist a bounded module result without prompts or credentials', async () => {
    const originalFetch = globalThis.fetch;
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/diagnostics.local.json')) return { ok: true, json: async () => ({ enabled: true }) };
        if (options.method === 'PUT') {
            writes.push({ url: String(url), body: JSON.parse(options.body) });
            return { ok: true, status: 200, json: async () => ({ revision: 1 }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    try {
        const diagnostics = await import(`./local-diagnostics.js?test=${Date.now()}`);
        diagnostics.bindLocalDiagnosticsContext(() => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'host-session-header' }) }));
        diagnostics.captureLocalGenerationDiagnostic({
            requestId: 'req-local-test', module: 'lines', startedAt: 123, floor: 8, replyId: 'reply-local-test',
            transport: { status: 'success' }, rawResponse: '<lines>bounded result</lines>',
            event: { event: 'generation-accepted', status: 'accepted' },
        });
        diagnostics.captureLocalGenerationDiagnostic({
            requestId: 'req-local-test', module: 'lines',
            event: { event: 'generation-locally-applied', status: 'local-applied', phase: 'save' },
        });
        diagnostics.captureLocalGenerationDiagnostic({
            requestId: 'req-local-test', module: 'lines',
            event: { event: 'generation-ui-displayed', status: 'displayed', phase: 'ui' },
        });
        await new Promise((resolve, reject) => {
            const start = Date.now();
            const poll = () => writes.length ? resolve() : Date.now() - start > 1500 ? reject(new Error('diagnostic sidechannel did not flush')) : setTimeout(poll, 20);
            poll();
        });
        const { url, body } = writes[0];
        assert.match(url, /\/records\/st-sevendayscal\/private-diagnostics\/generation-live$/);
        assert.equal(body.expectedRevision, 0);
        const attempt = body.data.attempts.lines;
        assert.equal(attempt.requestId, 'req-local-test');
        assert.equal(attempt.transport.status, 'success');
        assert.equal(attempt.result.processing, 'accepted');
        assert.equal(attempt.result.commit, 'local-applied');
        assert.equal(attempt.result.ui, 'displayed');
        assert.equal(attempt.rawResponse, '<lines>bounded result</lines>');
        const serialized = JSON.stringify(body);
        assert.doesNotMatch(serialized, /host-session-header|api.?key|messages|prompt/i);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('local diagnostics keep the newest attempt while late results update bounded history', async () => {
    const originalFetch = globalThis.fetch;
    let written = null;
    let puts = 0;
    let reads = 0;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/diagnostics.local.json')) return { ok: true, json: async () => ({ enabled: true }) };
        if (options.method === 'PUT') {
            puts += 1;
            written = JSON.parse(options.body);
            return puts === 1
                ? { ok: false, status: 409, json: async () => ({}) }
                : { ok: true, status: 200, json: async () => ({ revision: 8 }) };
        }
        reads += 1;
        return reads === 1
            ? { ok: false, status: 404, json: async () => ({}) }
            : {
                ok: true, status: 200,
                json: async () => ({
                    revision: 7,
                    data: {
                        attempts: {
                            outline: {
                                requestId: 'req-server', module: 'outline', startedAt: 150,
                                result: { processing: 'response-received', commit: 'not-requested', ui: 'not-requested', events: [] },
                            },
                        },
                    },
                }),
            };
    };
    try {
        const diagnostics = await import(`./local-diagnostics.js?history=${Date.now()}`);
        diagnostics.captureLocalGenerationDiagnostic({ requestId: 'req-old', runId: 'run-old', module: 'outline', startedAt: 100, result: { processing: 'preparing', ui: 'not-requested', commit: 'not-requested', events: [] } });
        diagnostics.captureLocalGenerationDiagnostic({ requestId: 'req-new', runId: 'run-new', module: 'outline', startedAt: 200, event: { event: 'generation-accepted', status: 'accepted' } });
        diagnostics.captureLocalGenerationDiagnostic({ requestId: 'req-old', module: 'outline', startedAt: 100, event: { event: 'generation-ui-failed', status: 'failed', phase: 'ui', reasonCode: 'render-failed' } });
        diagnostics.captureLocalGenerationDiagnostic({ requestId: 'req-old', module: 'outline', startedAt: 100, event: { event: 'generation-ui-displayed', status: 'displayed', phase: 'ui' } });
        diagnostics.captureLocalGenerationDiagnostic({ runId: 'run-memory-batch', module: 'memory', startedAt: 300, result: { processing: 'preparing', commit: 'not-requested', ui: 'not-requested', events: [] } });
        diagnostics.captureLocalGenerationDiagnostic({ runId: 'run-memory-batch', requestId: 'req-memory-1', module: 'memory', startedAt: 310, rawResponse: 'first raw' });
        diagnostics.captureLocalGenerationDiagnostic({ runId: 'run-memory-batch', requestId: 'req-memory-2', module: 'memory', startedAt: 320, rawResponse: 'second raw' });
        diagnostics.captureLocalGenerationDiagnostic({ requestId: 'req-memory-1', module: 'memory', startedAt: 310, transport: { status: 'success' } });
        await new Promise((resolve, reject) => {
            const start = Date.now();
            const poll = () => written ? resolve() : Date.now() - start > 1500 ? reject(new Error('history sidechannel did not flush')) : setTimeout(poll, 20);
            poll();
        });
        assert.equal(written.data.attempts.outline.requestId, 'req-new');
        assert.equal(written.data.attempts.outline.result.processing, 'accepted');
        assert.equal(written.data.recentAttempts.outline.length, 2);
        assert.equal(written.data.recentAttempts.outline[0].requestId, 'req-server');
        assert.equal(written.data.recentAttempts.outline[1].requestId, 'req-old');
        assert.equal(written.data.recentAttempts.outline[1].result.ui, 'failed');
        assert.equal(written.data.attempts.memory.requestId, 'req-memory-2');
        assert.equal(written.data.attempts.memory.rawResponse, 'second raw');
        assert.equal(written.data.recentAttempts.memory[0].requestId, 'req-memory-1');
        assert.equal(written.data.recentAttempts.memory[0].transport.status, 'success');
        assert.equal(puts, 2);
    } finally { globalThis.fetch = originalFetch; }
});

test('local diagnostics retry a transient write failure without another event', async () => {
    const originalFetch = globalThis.fetch;
    let puts = 0;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/diagnostics.local.json')) return { ok: true, json: async () => ({ enabled: true }) };
        if (options.method === 'PUT') {
            puts += 1;
            return puts === 1
                ? { ok: false, status: 503, json: async () => ({}) }
                : { ok: true, status: 200, json: async () => ({ revision: 1 }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    try {
        const diagnostics = await import(`./local-diagnostics.js?retry=${Date.now()}`);
        diagnostics.captureLocalGenerationDiagnostic({ runId: 'run-retry', module: 'axis', startedAt: 300, event: { event: 'generation-rejected', status: 'rejected', phase: 'prepare', reasonCode: 'prepare-failed' } });
        await new Promise((resolve, reject) => {
            const start = Date.now();
            const poll = () => puts >= 2 ? resolve() : Date.now() - start > 3000 ? reject(new Error('diagnostic retry did not flush')) : setTimeout(poll, 20);
            poll();
        });
        assert.equal(puts, 2);
    } finally { globalThis.fetch = originalFetch; }
});

test('local diagnostics backfill a successful server merge before flushing concurrent events', async () => {
    const originalFetch = globalThis.fetch;
    const writes = [];
    let diagnostics;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/diagnostics.local.json')) return { ok: true, json: async () => ({ enabled: true }) };
        if (options.method === 'PUT') {
            writes.push(JSON.parse(options.body));
            if (writes.length === 1) {
                diagnostics.captureLocalGenerationDiagnostic({ requestId: 'req-old', module: 'lines', startedAt: 100, event: { event: 'generation-ui-failed', status: 'failed', phase: 'ui', reasonCode: 'late-ui-failed' } });
            }
            return { ok: true, status: 200, json: async () => ({ revision: writes.length + 4 }) };
        }
        return { ok: true, status: 200, json: async () => ({
            revision: 4,
            data: {
                attempts: { lines: { requestId: 'req-server', module: 'lines', startedAt: 200, result: { processing: 'accepted', commit: 'not-requested', ui: 'not-requested', events: [] } } },
                recentAttempts: { lines: [{ requestId: 'req-old', module: 'lines', startedAt: 100, result: { processing: 'accepted', commit: 'not-requested', ui: 'not-requested', events: [] } }] },
            },
        }) };
    };
    try {
        diagnostics = await import(`./local-diagnostics.js?put-backfill=${Date.now()}`);
        diagnostics.captureLocalGenerationDiagnostic({ requestId: 'req-old', module: 'lines', startedAt: 100, event: { event: 'generation-accepted', status: 'accepted' } });
        await new Promise((resolve, reject) => {
            const start = Date.now();
            const poll = () => writes.length >= 2 ? resolve() : Date.now() - start > 2500 ? reject(new Error('concurrent diagnostic event did not flush')) : setTimeout(poll, 20);
            poll();
        });
        assert.equal(writes[1].data.attempts.lines.requestId, 'req-server');
        assert.equal(writes[1].data.recentAttempts.lines.find(item => item.requestId === 'req-old').result.ui, 'failed');
    } finally { globalThis.fetch = originalFetch; }
});
