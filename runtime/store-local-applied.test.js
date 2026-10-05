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
export async function load(url, context, nextLoad) { const loaded = await nextLoad(url, context); if (url.split('?')[0] !== index) return loaded; return { ...loaded, source: String(loaded.source) + '\\n;globalThis.__hostSaveSeam = { writeStoreConfirmed, writeStore, readStore, keyDesc, commitPortableImport, storeKinds: store.KINDS, usageByKind: store.usageByKind, clearKind: store.clearKind, addLedgerEntries: ledger.addEntriesAtomic, buildMessages, getSettings, dailyMenuController, abortBackground: _abortAllBackground, preparePluginDisable: () => { theaterFeature ??= { onPluginDisabled() {} }; }, memory, openDailyMenuDialog, renderDailyMenuCard, bindDailyMenuDialogEvents, renderSchedule, pointScheduleEmptyHtml, setDialogShadow: value => { _spDialogShadow = value; }, setDailyMenuController: value => { dailyMenuController = value; }, setThemeForTest: value => { currentTheme = value; } };\\n', shortCircuit: true }; }
`);
        await fs.writeFile(runner, `
import { setContext } from ${JSON.stringify(pathToFileURL(harness).href)};
globalThis.jQuery = Object.assign((...args) => new Proxy({ length: 0 }, { get: (target, key) => key === 'length' ? 0 : (...values) => target }), { fn: {} }); globalThis.$ = globalThis.jQuery;
globalThis.window = { innerWidth: 1024, innerHeight: 768, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, visualViewport: null };
globalThis.document = { documentElement: { style: { setProperty() {} }, insertAdjacentHTML() {} }, body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} }, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' }); globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.MutationObserver = class { observe() {} disconnect() {} }; globalThis.ResizeObserver = class { observe() {} disconnect() {} }; globalThis.IntersectionObserver = class { observe() {} disconnect() {} }; globalThis.toastr = null;
await import(${JSON.stringify(indexUrl)} + '?local-applied-test=' + Date.now());
const seam = globalThis.__hostSaveSeam;
if (!seam.storeKinds.includes('daily-menu')) throw new Error('daily menu is missing from store statistics/clear kinds');
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
const menuMetadata = { 'sp-store': { version: 1, data: { 'daily-menu-user': { title: '保留菜单', items: [{ name: '汤' }] }, 'lines-user': { raw: '保留线' } } } };
setContext(context('menu-kind-chat', menuMetadata, { is_group: false, file_name: 'menu-kind-chat', char_name: 'Role', avatar_url: 'role.png' }));
if (!(seam.usageByKind()['daily-menu'] > 0)) throw new Error('daily menu is missing from storage usage statistics');
if (seam.clearKind('daily-menu') !== 1 || 'daily-menu-user' in menuMetadata['sp-store'].data || !menuMetadata['sp-store'].data['lines-user']) throw new Error('daily menu kind clear removed the wrong data');
const menuContext = {
  chatId: 'menu-context-chat', characterId: 0, name1: 'User Context', name2: 'Character Context',
  characters: [{ avatar: 'menu-role.png', description: 'CHARACTER_CONTEXT_MARKER', personality: '', scenario: '', data: { character_book: { name: 'Story Book', entries: [{ uid: 1, key: ['*'], comment: 'Menu lore', content: 'WORLD_BOOK_MARKER', enabled: true }] } } }],
  powerUserSettings: { persona_description: 'PERSONA_CONTEXT_MARKER' }, chatMetadata: { note_prompt: 'AUTHOR_NOTE_MARKER' },
  chat: [1, 2, 3, 4].map(n => ({ is_user: false, name: 'Character Context', mes: 'AI_FLOOR_' + n })), getRequestHeaders: () => ({}),
  simulateWorldInfoActivation: async () => ({ activatedEntries: [{ world: 'Story Book', uid: 1 }] }),
};
setContext(menuContext);
const settings = seam.getSettings();
settings.useBaiBaiBook = true; settings.apiUrl = 'https://mock.invalid'; settings.apiKey = 'mock-key'; settings.apiModel = 'mock-model';
let memoryReads = 0;
globalThis.STBaiBaiBook = { getInjectedHistory: () => { memoryReads++; return { relativeText: 'MEMORY_CONTEXT_MARKER' }; } };
const menuMessages = await seam.buildMessages(menuContext, 'MENU_PROMPT', 'User Context', 'Character Context', 3, { includeMemory: false });
const menuSystem = menuMessages.find(message => message.role === 'system')?.content || '';
if (memoryReads !== 0 || menuSystem.includes('MEMORY_CONTEXT_MARKER')) throw new Error('menu buildMessages read or included story memory');
for (const marker of ['CHARACTER_CONTEXT_MARKER', 'PERSONA_CONTEXT_MARKER', 'AUTHOR_NOTE_MARKER', 'WORLD_BOOK_MARKER']) if (!menuSystem.includes(marker)) throw new Error('menu context omitted ' + marker);
const menuFloors = menuMessages.filter(message => message.role === 'assistant').map(message => message.content);
if (JSON.stringify(menuFloors) !== JSON.stringify(['AI_FLOOR_2', 'AI_FLOOR_3', 'AI_FLOOR_4'])) throw new Error('menu context did not preserve the latest three AI floors: ' + JSON.stringify(menuFloors));
const normalMessages = await seam.buildMessages(menuContext, 'NORMAL_PROMPT', 'User Context', 'Character Context', 3, {});
if (memoryReads !== 1 || !(normalMessages[0]?.content || '').includes('MEMORY_CONTEXT_MARKER')) throw new Error('default buildMessages memory behavior changed');
const beforeMenu = { title: 'Existing menu', intro: '按舰上当前食材调配，今晚来点新鲜搭配 😊', items: [{ name: 'Existing dish', category: 'main', description: 'kept' }] };
menuContext.chatMetadata['sp-store'] = { version: 1, data: { 'daily-menu-user': beforeMenu } };
const introWrite = await seam.writeStoreConfirmed(seam.keyDesc('daily-menu', 'user', ''), beforeMenu);
if (introWrite?.commitState !== 'local-applied' || seam.readStore(seam.keyDesc('daily-menu', 'user', ''))?.intro !== beforeMenu.intro) throw new Error('production ordinary store failed to immediately preserve the optional menu intro');
let requestSignal = null;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/diagnostics.local.json')) return { ok: true, json: async () => ({ enabled: false }) };
  if (String(url).includes('/private-diagnostics/')) return { ok: false, status: 404, json: async () => ({}) };
  if (String(url) === '/api/backends/chat-completions/generate') return new Promise((_resolve, reject) => { requestSignal = options.signal; options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); });
  throw new Error('unexpected mocked request: ' + String(url));
};
const menuRequest = seam.dailyMenuController.run();
for (let i = 0; i < 100 && !requestSignal; i++) await new Promise(resolve => setTimeout(resolve, 10));
if (!requestSignal) throw new Error('menu request did not reach mocked API');
if (memoryReads !== 1) throw new Error('actual menu API call did not skip memory before request dispatch');
seam.preparePluginDisable();
seam.abortBackground();
const menuAbortResult = await Promise.race([menuRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('total gate did not cancel menu request')), 1000))]);
if (!requestSignal.aborted || menuAbortResult?.status !== 'cancelled') throw new Error('plugin total gate failed to cancel menu request');
if (menuContext.chatMetadata['sp-store'].data['daily-menu-user'] !== beforeMenu) throw new Error('plugin total gate allowed menu write after cancellation');
if (typeof seam.readStore !== 'function') throw new Error('production read seam missing');
const scheduleWithMenu = seam.renderSchedule('not a calendar', 'UI probe');
const menuButtonIndex = scheduleWithMenu.indexOf('sp-open-daily-menu'); const refreshButtonIndex = scheduleWithMenu.indexOf('sp-refresh-schedule');
if (refreshButtonIndex < 0 || menuButtonIndex < refreshButtonIndex || !scheduleWithMenu.includes('aria-label="今日菜单"')) throw new Error('real schedule renderer omitted or misplaced menu entry');
if (!seam.pointScheduleEmptyHtml().includes('sp-open-daily-menu')) throw new Error('real point empty state omitted menu entry');
let popup = null; const menuContent = { innerHTML: '' }; const uiHandlers = {};
const closeButton = { focus() { this.focused = true; } };
const eventHost = {
  addEventListener(type, handler) { uiHandlers[type] = handler; },
  appendChild(node) { popup = node; node.closest = selector => selector === '#sp-daily-menu-dialog' ? node : null; node.getAttribute = name => node.attributes[name]; node.querySelector = selector => selector === '[data-daily-menu-close]' ? closeButton : null; node.remove = () => { if (popup === node) popup = null; }; },
};
const dialogShadow = {
  querySelector(selector) { return selector === '#sp-dialog-overlay-host' ? eventHost : selector === '#sp-daily-menu-dialog' ? popup : selector === '#sp-daily-menu-content' && popup ? menuContent : null; },
};
const originalCreateElement = document.createElement;
document.createElement = () => { const attributes = {}; return { attributes, setAttribute(name, value) { attributes[name] = value; }, focus() {}, remove() {} }; };
seam.setDialogShadow(dialogShadow);
seam.bindDailyMenuDialogEvents();
let openFetches = 0; const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { openFetches++; throw new Error('opening the menu must not request generation'); };
seam.openDailyMenuDialog();
if (!popup || popup.getAttribute?.('role') !== 'dialog' || !menuContent.innerHTML.includes('Existing dish') || !closeButton.focused) throw new Error('real menu opener did not show stored menu in an accessible dialog');
if (openFetches !== 0) throw new Error('opening menu invoked API');
popup.remove(); seam.renderDailyMenuCard();
if (popup) throw new Error('closed menu render callback reopened the dialog');
seam.writeStore(seam.keyDesc('daily-menu', 'user', ''), { title: 'Latest menu', items: [{ name: 'Latest dish', category: 'main', description: 'newly saved' }] });
seam.openDailyMenuDialog();
if (!menuContent.innerHTML.includes('Latest dish')) throw new Error('reopening the menu did not read the latest stored value');
const latestOverlay = popup;
uiHandlers.click({ target: { closest: selector => selector === '[data-daily-menu-close]' ? closeButton : selector === '#sp-daily-menu-dialog' ? latestOverlay : null } });
if (popup) throw new Error('close control did not close the menu popup');
globalThis.fetch = originalFetch;
let uiRequestSignal = null; let uiRequestCount = 0;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith('/diagnostics.local.json')) return { ok: true, json: async () => ({ enabled: false }) };
  if (String(url).includes('/private-diagnostics/')) return { ok: false, status: 404, json: async () => ({}) };
  if (String(url) === '/api/backends/chat-completions/generate') { uiRequestCount++; return new Promise((_resolve, reject) => { uiRequestSignal = options.signal; options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); }); }
  throw new Error('unexpected menu popup request: ' + String(url));
};
const uiRequest = seam.dailyMenuController.run();
for (let i = 0; i < 100 && !uiRequestSignal; i++) await new Promise(resolve => setTimeout(resolve, 10));
if (!uiRequestSignal) throw new Error('menu lifecycle probe did not reach mocked API');
seam.openDailyMenuDialog();
if (!menuContent.innerHTML.includes('Latest dish') || !menuContent.innerHTML.includes('取消生成') || uiRequestCount !== 1) throw new Error('popup did not show saved menu/busy action or opened another request');
const activeOverlay = popup;
uiHandlers.click({ target: { closest: selector => selector === '[data-daily-menu-close]' ? closeButton : selector === '#sp-daily-menu-dialog' ? activeOverlay : null } });
if (popup || uiRequestSignal.aborted || !seam.dailyMenuController.busy()) throw new Error('closing popup cancelled the running menu task');
seam.renderDailyMenuCard();
if (popup) throw new Error('closed popup was recreated by a task redraw');
seam.openDailyMenuDialog();
if (!menuContent.innerHTML.includes('取消生成')) throw new Error('reopening popup did not recover the current busy state');
const runningOverlay = popup;
uiHandlers.click({ target: runningOverlay });
if (popup || uiRequestSignal.aborted || !seam.dailyMenuController.busy()) throw new Error('outside click did more than close popup');
seam.openDailyMenuDialog();
uiHandlers.keydown({ key: 'Escape', target: { closest: selector => selector === '#sp-daily-menu-dialog' ? popup : null } });
if (popup || uiRequestSignal.aborted) throw new Error('Escape did more than close popup');
seam.openDailyMenuDialog();
uiHandlers.click({ target: { closest: selector => selector === '.sp-daily-menu-generate, .sp-daily-menu-cancel' ? { classList: { contains: name => name === 'sp-daily-menu-cancel' } } : selector === '#sp-daily-menu-dialog' ? popup : null } });
const cancelledUiRequest = await uiRequest;
if (!uiRequestSignal.aborted || cancelledUiRequest?.status !== 'cancelled') throw new Error('popup cancel button did not cancel the menu task');
let generateClicks = 0;
seam.setDailyMenuController({ busy: () => false, run: () => { generateClicks++; return Promise.resolve(); }, cancel() { throw new Error('unexpected cancel action'); } });
seam.renderDailyMenuCard();
uiHandlers.click({ target: { closest: selector => selector === '.sp-daily-menu-generate, .sp-daily-menu-cancel' ? { classList: { contains: () => false } } : selector === '#sp-daily-menu-dialog' ? popup : null } });
if (generateClicks !== 1) throw new Error('popup generation button is not wired to the controller');
popup.remove();
seam.getSettings().themeMode = 'auto'; seam.setThemeForTest('night');
seam.openDailyMenuDialog();
if (!popup.className.includes('sp-root') || !popup.className.includes('sp-night') || popup.className.includes('sp-forced-night')) throw new Error('auto-theme popup did not use current palette classes');
popup.remove();
seam.getSettings().themeMode = 'day'; seam.setThemeForTest('day');
seam.openDailyMenuDialog();
if (!popup.className.includes('sp-root') || !popup.className.includes('sp-day') || !popup.className.includes('sp-forced-day')) throw new Error('forced-theme popup did not use the selected forced palette class');
document.createElement = originalCreateElement;
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
