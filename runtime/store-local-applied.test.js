import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('production index/store applies ordinary chat metadata immediately without waiting for host ACK', async () => {
    const repo = path.resolve(new URL('..', import.meta.url).pathname);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'st7cal-local-applied-'));
    const indexUrl = pathToFileURL(path.join(repo, 'index.js')).href;
    const loader = path.join(dir, 'loader.mjs');
    const runner = path.join(dir, 'runner.mjs');
    const harness = path.join(dir, 'extensions.mjs');
    const script = path.join(dir, 'script.mjs');
    const utils = path.join(dir, 'utils.mjs');
    const world = path.join(dir, 'world-info.mjs');
    try {
        await fs.writeFile(harness, `let context = null; export const extension_settings = {}; export const extensionNames = []; export function getContext() { return context; } export function setContext(value) { context = value; }\n`);
        await fs.writeFile(utils, `export const equalsIgnoreCaseAndAccents = (a,b) => String(a).toLowerCase() === String(b).toLowerCase(); export const getCharaFilename = () => '';\n`);
        await fs.writeFile(world, `export let selected_world_info = null; export const world_info = {}; export async function checkWorldInfo() { return { allActivatedEntries: new Set() }; }\n`);
        await fs.writeFile(script, `export const eventSource = { on() {}, removeListener() {}, makeLast() {} }; export const event_types = {}; export const system_message_types = {}; export function saveSettingsDebounced() {} export function saveSettings() {} export function substituteParams(value) { return String(value ?? ''); } export let isChatSaving = false; export function getRequestHeaders() { return {}; }\n`);
        await fs.writeFile(loader, `
const index = ${JSON.stringify(indexUrl)};
const fixtures = new Map([
  ['extensions.js', ${JSON.stringify(pathToFileURL(harness).href)}], ['script.js', ${JSON.stringify(pathToFileURL(script).href)}],
  ['world-info.js', ${JSON.stringify(pathToFileURL(world).href)}], ['utils.js', ${JSON.stringify(pathToFileURL(utils).href)}],
]);
export async function resolve(specifier, context, nextResolve) { const hit = [...fixtures].find(([name]) => specifier.endsWith('/' + name) || specifier === name); if (hit) return { url: hit[1], shortCircuit: true }; return nextResolve(specifier, context); }
export async function load(url, context, nextLoad) { const loaded = await nextLoad(url, context); if (url.split('?')[0] !== index) return loaded; return { ...loaded, source: String(loaded.source) + '\\n;globalThis.__hostSaveSeam = { writeStoreConfirmed, writeStore, readStore, keyDesc, commitPortableImport, addLedgerEntries: ledger.addEntriesAtomic, memory };\\n', shortCircuit: true }; }
`);
        await fs.writeFile(runner, `
import { setContext } from ${JSON.stringify(pathToFileURL(harness).href)};
globalThis.jQuery = Object.assign((...args) => new Proxy({ length: 0 }, { get: (target, key) => key === 'length' ? 0 : (...values) => target }), { fn: {} }); globalThis.$ = globalThis.jQuery;
globalThis.window = { innerWidth: 1024, innerHeight: 768, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, visualViewport: null };
globalThis.document = { documentElement: { style: { setProperty() {} }, insertAdjacentHTML() {} }, body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} }, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' }); globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.MutationObserver = class { observe() {} disconnect() {} }; globalThis.ResizeObserver = class { observe() {} disconnect() {} }; globalThis.IntersectionObserver = class { observe() {} disconnect() {} }; globalThis.toastr = null;
await import(${JSON.stringify(indexUrl)} + '?local-applied-test=' + Date.now());
const seam = globalThis.__hostSaveSeam;
let saveCalls = 0; let settleSave; let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('ordinary local-applied path must not fetch'); };
const never = new Promise((resolve, reject) => { settleSave = { resolve, reject }; });
function context(chatId, metadata, target, save = never) { return { chatId, ...(target.is_group ? { groupId: target.id } : { characterId: 0, characters: [{ name: target.char_name || 'Role', avatar: target.avatar_url || 'role.png' }] }), chat: [], chatMetadata: metadata, saveMetadata() { saveCalls++; return save; } }; }
for (const target of [{ is_group: false, file_name: 'role-chat', char_name: 'Role', avatar_url: 'role.png' }, { is_group: true, id: 'group-chat' }]) {
  const chatId = target.is_group ? target.id : target.file_name;
  const metadata = { 'sp-store': { version: 1, data: { 'schedule-user': { raw: 'old' }, 'outline-user': { raw: 'keep' }, 'diagnostics-v1': { marker: 'retain' } } } };
  setContext(context(chatId, metadata, target));
  const result = await Promise.race([
    seam.writeStoreConfirmed(seam.keyDesc('schedule', 'user', ''), { raw: 'local-' + chatId, ts: 2 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('local write waited for host promise')), 100)),
  ]);
  if (result?.commitState !== 'local-applied' || result.ok !== true) throw new Error('ordinary store did not return local-applied: ' + JSON.stringify(result));
  if (metadata['sp-store'].data['schedule-user'].raw !== 'local-' + chatId) throw new Error('local candidate is not immediately readable');
  if (metadata['sp-store'].data['outline-user'].raw !== 'keep' || metadata['sp-store'].data['diagnostics-v1'].marker !== 'retain') throw new Error('sibling/diagnostic data changed');
}
if (saveCalls !== 2 || fetchCalls !== 0) throw new Error('expected only one same-stack host save per ordinary write and no plugin GET/PATCH: ' + saveCalls + '/' + fetchCalls);
const importMetadata = { 'sp-store': { version: 1, data: { 'schedule-user': { raw: 'preserved' }, 'lines-user': { raw: 'before' } } } };
setContext(context('import-chat', importMetadata, { is_group: false, file_name: 'import-chat', char_name: 'Role', avatar_url: 'role.png' }));
const importResult = await seam.commitPortableImport({
  identity: { chatId: 'import-chat' },
  originalRoots: { 'sp-store': structuredClone(importMetadata['sp-store']), 'sp-theater': undefined },
  portablePackage: { selectedModules: ['lines'], modules: { lines: { entries: { 'lines-user': { raw: 'after' } } } } },
  selectedModules: ['lines'],
});
if (importResult.commitState !== 'local-applied' || importResult.ok !== true) throw new Error('ordinary import did not return local-applied: ' + JSON.stringify(importResult));
if (importMetadata['sp-store'].data['lines-user'].raw !== 'after' || importMetadata['sp-store'].data['schedule-user'].raw !== 'preserved') throw new Error('ordinary import failed to replace only selected module roots');
if (saveCalls !== 3 || fetchCalls !== 0) throw new Error('ordinary import must make one standard host save and no GET/PATCH: ' + saveCalls + '/' + fetchCalls);
const ledgerMetadata = {};
setContext(context('ledger-chat', ledgerMetadata, { is_group: false, file_name: 'ledger-chat', char_name: 'Role', avatar_url: 'role.png' }));
const ledgerEntries = await seam.addLedgerEntries([{ 事由: '现场事务', 类型: '持续状态', 现状: '仍在持续。' }]);
if (ledgerEntries.length !== 1 || ledgerMetadata['sp-ledger']?.entries?.[0]?.事由 !== '现场事务') throw new Error('ordinary ledger batch was not applied to the live root');
if (saveCalls !== 4 || fetchCalls !== 0) throw new Error('ordinary ledger batch must make one standard host save and no GET/PATCH: ' + saveCalls + '/' + fetchCalls);
const ledgerThrowMetadata = {};
setContext(context('ledger-throw-chat', ledgerThrowMetadata, { is_group: false, file_name: 'ledger-throw-chat', char_name: 'Role', avatar_url: 'role.png' }, () => { saveCalls++; throw new Error('synthetic synchronous host save failure'); }));
const thrownLedger = await seam.addLedgerEntries([{ 事由: '已应用事项', 类型: '持续状态', 现状: '仍在本地。' }]);
if (thrownLedger.length !== 1 || ledgerThrowMetadata['sp-ledger']?.entries?.[0]?.事由 !== '已应用事项') throw new Error('ordinary ledger batch rolled back after host save threw');
let diagnosticWrite = null;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/diagnostics.local.json')) return { ok: true, json: async () => ({ enabled: true }) };
  if (String(url).includes('/private-diagnostics/')) {
    if (options.method === 'PUT') { diagnosticWrite = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ revision: 1 }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  }
  throw new Error('unexpected request in in-memory memory test: ' + String(url));
};
const memoryMetadata = { 'sp-memory': { version: 3, L0: {}, L1: [], failed: {}, system: { paused: false, consecutiveFails: 0, lastError: null } } };
const memoryContext = context('memory-chat', memoryMetadata, { is_group: false, file_name: 'memory-chat', char_name: 'Role', avatar_url: 'role.png' });
memoryContext.chat = [
  { name: 'Role', mes: '第一段剧情正文足够长，用于验证手动记忆摘要会真实更新并立即显示。' },
  { name: 'Role', mes: '第二段剧情正文足够长，用于作为最新楼并保留一组稳定记忆来源。' },
];
setContext(memoryContext);
seam.memory.initMemory({ getSettings: () => ({ pluginEnabled: true, memoryEnabled: true, memoryL0Group: 1, memorySkipShort: 1, keepTags: 'content', extraTags: '', useBaiBaiBook: false, useAnima: false, useDatabase: false, useQianQianJie: false }), callApi: async (_messages, _signal, sink) => { sink({ requestId: 'req-memory-local-test' }); return '事件：角色回顾了第一段经历，随后继续推进了当前安排。'; } });
const memoryProgress = [];
const memoryResult = await Promise.race([
  seam.memory.fillMissing(progress => memoryProgress.push(progress)),
  new Promise((_, reject) => setTimeout(() => reject(new Error('manual memory waited for never-settling host save')), 200)),
]);
if (memoryResult.aborted || !memoryMetadata['sp-memory'].L0['0-0']?.text) throw new Error('manual memory did not locally apply its generated summary');
if (saveCalls !== 6 || !memoryProgress.some(item => item.current === 1 && item.done === false)) throw new Error('manual memory did not progress immediately after one standard save');
await new Promise((resolve, reject) => { const start = Date.now(); const poll = () => diagnosticWrite ? resolve() : Date.now() - start > 1500 ? reject(new Error('manual memory diagnostic did not flush')) : setTimeout(poll, 20); poll(); });
const memoryAttempt = diagnosticWrite.data.attempts.memory;
if (memoryAttempt.result.processing !== 'accepted' || memoryAttempt.result.commit !== 'local-applied' || memoryAttempt.result.ui !== 'displayed') throw new Error('manual memory diagnostic is missing its terminal stages: ' + JSON.stringify(memoryAttempt.result));
let callbackCount = 0;
const oldMetadata = { 'sp-store': { version: 1, data: {} } };
setContext(context('old-chat', oldMetadata, { is_group: false, file_name: 'old-chat', char_name: 'Role', avatar_url: 'role.png' }));
const failing = seam.writeStoreConfirmed(seam.keyDesc('lines', 'user', ''), { raw: 'still-local' }, { onPersistenceError: () => { callbackCount++; } });
await failing;
const newMetadata = { 'sp-store': { version: 1, data: {} } };
setContext(context('new-chat', newMetadata, { is_group: false, file_name: 'new-chat', char_name: 'Role', avatar_url: 'role.png' }));
settleSave.reject(new Error('synthetic host failure'));
await new Promise(resolve => setImmediate(resolve));
if (callbackCount !== 1) throw new Error('late host-save error was hidden by a removed chat-identity veto');
if (oldMetadata['sp-store'].data['lines-user'].raw !== 'still-local') throw new Error('host failure rolled back local content');
let rejectCurrent; const currentFailure = new Promise((_, reject) => { rejectCurrent = reject; });
const currentMetadata = { 'sp-store': { version: 1, data: {} } };
setContext(context('current-chat', currentMetadata, { is_group: false, file_name: 'current-chat', char_name: 'Role', avatar_url: 'role.png' }, currentFailure));
let currentCallback = 0;
const currentResult = await seam.writeStoreConfirmed(seam.keyDesc('lines', 'user', ''), { raw: 'visible-after-reject' }, { onPersistenceError: () => { currentCallback++; } });
if (currentResult.commitState !== 'local-applied' || currentMetadata['sp-store'].data['lines-user'].raw !== 'visible-after-reject') throw new Error('current-chat content was not applied before host rejection');
rejectCurrent(new Error('current synthetic host failure'));
await new Promise(resolve => setImmediate(resolve));
if (currentCallback !== 1 || currentMetadata['sp-store'].data['lines-user'].raw !== 'visible-after-reject') throw new Error('current host failure was not surfaced without reverting local value');
let rejectReplaced; const replacedSave = new Promise((_, reject) => { rejectReplaced = reject; });
const replacedMetadata = { 'sp-store': { version: 1, data: {} } };
setContext(context('same-value-chat', replacedMetadata, { is_group: false, file_name: 'same-value-chat', char_name: 'Role', avatar_url: 'role.png' }, replacedSave));
let replacedCallback = 0;
const originalValue = { raw: 'same-value' };
await seam.writeStoreConfirmed(seam.keyDesc('lines', 'user', ''), originalValue, { onPersistenceError: () => { replacedCallback++; } });
const takeoverValue = { raw: 'same-value' };
if (takeoverValue === originalValue || JSON.stringify(takeoverValue) !== JSON.stringify(originalValue)) throw new Error('test setup must use a distinct same-value object');
seam.writeStore(seam.keyDesc('lines', 'user', ''), takeoverValue);
if (replacedMetadata['sp-store'].data['lines-user'] !== takeoverValue) throw new Error('ordinary same-value takeover did not replace the live object');
rejectReplaced(new Error('old save rejected after same-value takeover'));
await new Promise(resolve => setImmediate(resolve));
if (replacedCallback !== 0) throw new Error('same-value ordinary takeover received an old save error');
if (typeof seam.readStore !== 'function') throw new Error('production read seam missing');
`);
        const result = await new Promise(resolve => {
            const child = spawn(process.execPath, ['--experimental-loader', loader, runner], { cwd: dir, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = ''; let stdout = '';
            child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
            child.once('error', error => resolve({ code: -1, stdout, stderr: String(error) }));
            child.once('close', code => resolve({ code, stdout, stderr }));
        });
        assert.equal(result.code, 0, result.stderr + result.stdout);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
