import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { encodeStoreEntry } from './store-codec.js';
import { gzipSync } from '../vendor/fflate-gzip.mjs';

test('production index/store applies ordinary chat metadata immediately without waiting for host ACK', async () => {
    const repo = path.resolve(new URL('..', import.meta.url).pathname);
    const malformedDiagnostics = { codec: 'stsc-gzip-base64', version: 1, payload: Buffer.from(gzipSync(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, unexpected: 'x'.repeat(1000) })))).toString('base64') };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'st7cal-local-applied-'));
    const indexUrl = pathToFileURL(path.join(repo, 'index.js')).href;
    const loader = path.join(dir, 'loader.mjs');
    const runner = path.join(dir, 'runner.mjs');
    const harness = path.join(dir, 'extensions.mjs');
    const script = path.join(dir, 'script.mjs');
    const utils = path.join(dir, 'utils.mjs');
    const world = path.join(dir, 'world-info.mjs');
    const slashParser = path.join(dir, 'slash-parser.mjs');
    const slashCommand = path.join(dir, 'slash-command.mjs');
    try {
        await fs.writeFile(harness, `let context = null; export const extension_settings = {}; export const extensionNames = []; export const extensionTypes = {}; export function getContext() { return context; } export function setContext(value) { context = value; }\n`);
        await fs.writeFile(utils, `export const equalsIgnoreCaseAndAccents = (a,b) => String(a).toLowerCase() === String(b).toLowerCase(); export const getCharaFilename = () => '';\n`);
        await fs.writeFile(world, `export let selected_world_info = null; export const world_info = {}; export async function checkWorldInfo() { return { allActivatedEntries: new Set() }; }\n`);
        await fs.writeFile(slashParser, `export class SlashCommandParser { static addCommandObject(command) { (globalThis.__slashCommands ??= []).push(command); } }\n`);
        await fs.writeFile(slashCommand, `export class SlashCommand { static fromProps(props) { return props; } }\n`);
        await fs.writeFile(script, `export const eventSource = { on() {}, removeListener() {}, makeLast() {} }; export const event_types = {}; export const system_message_types = {}; export function saveSettingsDebounced() {} export function saveSettings() {} export function substituteParams(value) { return String(value ?? ''); } export let isChatSaving = false; export function getRequestHeaders() { return {}; }\n`);
        await fs.writeFile(loader, `
const index = ${JSON.stringify(indexUrl)};
const fixtures = new Map([
  ['lib.js', 'data:text/javascript,export const showdown=undefined,DOMPurify=undefined;'],
  ['extensions.js', ${JSON.stringify(pathToFileURL(harness).href)}], ['script.js', ${JSON.stringify(pathToFileURL(script).href)}],
  ['world-info.js', ${JSON.stringify(pathToFileURL(world).href)}], ['utils.js', ${JSON.stringify(pathToFileURL(utils).href)}],
  ['SlashCommandParser.js', ${JSON.stringify(pathToFileURL(slashParser).href)}], ['SlashCommand.js', ${JSON.stringify(pathToFileURL(slashCommand).href)}],
]);
export async function resolve(specifier, context, nextResolve) { const hit = [...fixtures].find(([name]) => specifier.endsWith('/' + name) || specifier === name); if (hit) return { url: hit[1], shortCircuit: true }; return nextResolve(specifier, context); }
export async function load(url, context, nextLoad) { const loaded = await nextLoad(url, context); if (url.split('?')[0] !== index) return loaded; return { ...loaded, source: String(loaded.source) + '\\n;globalThis.__hostSaveSeam = { writeStoreConfirmed, writeStore, writeRaw: store.writeRaw, writeBatch: store.writeBatch, writeData: store.writeData, readStore, keyDesc, snapshotWrite: snapshot.writeSnapshot, commitPortableImport, buildPortableChatPackage, buildCurrentChatDiagnosticPackage, storeKinds: store.KINDS, usageByKind: store.usageByKind, clearKind: store.clearKind, addLedgerEntries: ledger.addEntriesAtomic, buildMessages, getSettings, dailyMenuController, abortBackground: _abortAllBackground, preparePluginDisable: () => { theaterFeature ??= { onPluginDisabled() {} }; }, memory, openDailyMenuDialog, openQuickReplyShortcut, openSidebarView, openSchedule, handleViewButtonClick, setCurrentViewForTest: value => { currentView = value; }, registerShortcutCommandForTest: () => registerQuickReplyShortcutCommand({ parser: SlashCommandParser, commandClass: SlashCommand, open: openQuickReplyShortcut, notify: (message, isError) => showToast(message, null, isError) }), setLastMainViewForTest: value => { _lastMainView = value; }, shortcutState: () => ({ outlineMode, linesMode, spaceMode, theaterMode, almanacMode: axisState.almanacMode, almanacSheet: axisState._almanacSheet, linesSheet: linesFeature.sheet, settingsOpen, currentView, lastMainView: _lastMainView }), setShortcutUiForTest: value => { _spShadow = value; }, prepareShortcutViewDependencies: () => { theaterFeature ??= { busy: false, leave() {}, open() {}, onPanelClosed() {}, onPluginDisabled() {} }; coordinateRuntime ??= { feature: { open() {}, close() {} } }; }, setSettingsOpenForTest: value => { settingsOpen = value; }, renderDailyMenuCard, bindDailyMenuDialogEvents, renderSchedule, pointScheduleEmptyHtml, setDialogShadow: value => { _spDialogShadow = value; }, setDailyMenuController: value => { dailyMenuController = value; }, setThemeForTest: value => { currentTheme = value; } }; globalThis.__hostSaveSeam.showToast = showToast; globalThis.__hostSaveSeam.timeTravelDirectionLoadErrorText = timeTravelDirectionLoadErrorText; globalThis.__hostSaveSeam.memoryPreCheckConfirm = memoryPreCheckConfirm; globalThis.__hostSaveSeam.renderMemorySection = renderMemorySection; globalThis.__hostSaveSeam.bindLedgerBusyForTest = chat => bindLedgerEvents({ almanac: { on() { return this; }, off() { return this; } }, chat, $: globalThis.jQuery, settings: getSettings, saveSettings() {}, capture: { run: async () => ({ status: "unchanged" }), abort() {} }, judge: { run: async () => ({ status: "unchanged" }) }, captureState: () => ({ busy: true }), actions: {}, render() {}, refreshInline() {}, identity: () => null, isCurrentIdentity: () => true, editor: {}, archive: {}, batch: { scopes: [], scope() {}, selected() { return new Set(); }, reset() {}, ids() { return []; }, exec() {} }, toast: showToast });\\n', shortCircuit: true }; }
`);
        await fs.writeFile(runner, `
import { setContext } from ${JSON.stringify(pathToFileURL(harness).href)};
const shortcutButton = {}; const settingsLayer = { tagName: 'DETAILS', open: false, parentElement: null }; const memorySection = { tagName: 'DETAILS', open: false, parentElement: settingsLayer, scrollIntoView() {} };
const shortcutUi = { querySelector(selector) { if (selector.startsWith('.sp-side-tab.sp-view-btn')) return shortcutButton; if (selector === '#sp-mem-section') return memorySection; return null; }, querySelectorAll() { return []; } };
globalThis.shortcutTriggerCalls = 0; globalThis.shortcutPanelVisible = true; const jqChain = (length, selector) => { let chain; chain = new Proxy({ length }, { get(target, key) { if (key === 'length') return target.length; if (key === 'is') return query => selector === '#sp-modal-root' ? globalThis.shortcutPanelVisible : true; if (key === 'first') return () => chain; if (key === 'hasClass') return () => false; if (key === 'trigger') return () => { globalThis.shortcutTriggerCalls++; return chain; }; return (...values) => chain; } }); return chain; };
globalThis.jQuery = Object.assign((...args) => jqChain(args[0] === shortcutButton ? 1 : 0, args[0]), { fn: {} }); globalThis.$ = globalThis.jQuery;
globalThis.window = { innerWidth: 1024, innerHeight: 768, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, visualViewport: null };
globalThis.document = { documentElement: { style: { setProperty() {} }, insertAdjacentHTML() {} }, body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} }, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' }); globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.MutationObserver = class { observe() {} disconnect() {} }; globalThis.ResizeObserver = class { observe() {} disconnect() {} }; globalThis.IntersectionObserver = class { observe() {} disconnect() {} }; globalThis.toastr = null;
await import(${JSON.stringify(indexUrl)} + '?local-applied-test=' + Date.now());
const seam = globalThis.__hostSaveSeam;
globalThis.__feedbackCapture = { toastMarkup: [], statusHtml: [], confirmMarkup: '', confirmOk: null, confirmCancel: null };
const baseJQuery = globalThis.jQuery;
const feedbackChain = { length: 1, 0: {}, append() { return this; }, addClass() { return this; }, removeClass() { return this; }, css() { return this; }, on() { return this; }, remove() { return this; }, show() { return this; }, hide() { return this; }, toggle() { return this; }, prop() { return this; }, val() { return this; }, text() { return this; }, html(value) { if (value !== undefined) globalThis.__feedbackCapture.statusHtml.push({ selector: this.__feedbackSelector, value }); return this; }, attr() { return this; }, trigger() { return this; }, off() { return this; } };
globalThis.jQuery = globalThis.$ = Object.assign(input => {
  if (input && typeof input === 'string' && input.startsWith('<div class="sp-toast')) { globalThis.__feedbackCapture.toastMarkup.push(input); return feedbackChain; }
  if (input && typeof input === 'string' && input.includes('<div id="sp-confirm"')) {
    globalThis.__feedbackCapture.confirmMarkup = input;
    return { 0: {}, find(selector) { return { on(_event, handler) { if (selector === '.sp-confirm-ok') globalThis.__feedbackCapture.confirmOk = handler; if (selector === '.sp-confirm-cancel') globalThis.__feedbackCapture.confirmCancel = handler; return this; } }; }, on() { return this; }, addClass() { return this; }, remove() { return this; } };
  }
  if (input?.__feedbackSelector) return Object.assign(Object.create(feedbackChain), { __feedbackSelector: input.__feedbackSelector });
  return baseJQuery(input);
}, { ...baseJQuery, fn: baseJQuery.fn });
seam.registerShortcutCommandForTest();
if (!seam.storeKinds.includes('daily-menu')) throw new Error('daily menu is missing from store statistics/clear kinds');
let saveCalls = 0; let settleSave; let fetchCalls = 0; const hostPayloadBytes = [];
globalThis.fetch = async () => { fetchCalls++; throw new Error('ordinary local-applied path must not fetch'); };
const never = new Promise((resolve, reject) => { settleSave = { resolve, reject }; });
function context(chatId, metadata, target, save = never) { return { chatId, ...(target.is_group ? { groupId: target.id } : { characterId: 0, characters: [{ name: target.char_name || 'Role', avatar: target.avatar_url || 'role.png' }] }), chat: [], chatMetadata: metadata, saveMetadata() { saveCalls++; hostPayloadBytes.push(new TextEncoder().encode(JSON.stringify(metadata)).byteLength); return save; } }; }
setContext(context('qr-shortcut-route', {}, { is_group: false, file_name: 'qr-shortcut-route', char_name: 'Role', avatar_url: 'role.png' }));
seam.setShortcutUiForTest(shortcutUi);
seam.prepareShortcutViewDependencies();
seam.setSettingsOpenForTest(true);
seam.setLastMainViewForTest('space');
seam.setCurrentViewForTest('user');
seam.handleViewButtonClick({ data: () => 'char', hasClass: name => name === 'sp-sub-btn' || name === 'sp-ta-trigger' });
if (seam.shortcutState().currentView !== 'char') throw new Error('production TA trigger click did not toggle into its char view');
const registeredShortcut = globalThis.__slashCommands?.find(command => command.name === 'gouhua-open');
if (!registeredShortcut) throw new Error('production index did not register /gouhua-open');
const routeCases = [
  ['point', 'schedule'], ['axis-upcoming', 'almanac'], ['axis-calendar', 'almanac'], ['axis-ticks', 'almanac'],
  ['lines-events', 'lines'], ['lines-dashed', 'lines'], ['outline', 'outline'], ['space', 'space'],
  ['theater', 'theater'], ['coordinate', 'anchor'],
];
for (const [key, expected] of routeCases) {
  globalThis.shortcutPanelVisible = false;
  const result = await registeredShortcut.callback({}, key);
  const state = seam.shortcutState();
  if (result !== '' || state.lastMainView !== expected) throw new Error('production shortcut route failed for ' + key + ': ' + JSON.stringify(state));
  if (key.startsWith('axis-')) {
    const sheet = { 'axis-upcoming': 'upcoming', 'axis-calendar': 'calendar', 'axis-ticks': 'ledger' }[key];
    if (state.almanacSheet !== sheet) throw new Error('axis shortcut chose the wrong existing sheet for ' + key);
  }
  if (key.startsWith('lines-')) {
    const sheet = key === 'lines-events' ? 'events' : 'dashed';
    if (state.linesSheet !== sheet) throw new Error('line shortcut chose the wrong existing sheet for ' + key);
  }
}
globalThis.shortcutPanelVisible = true;
seam.setLastMainViewForTest('space');
await registeredShortcut.callback({}, 'point');
if (seam.shortcutState().lastMainView !== 'schedule') throw new Error('visible-panel point shortcut restored a stale module instead of the point view');
const shortcutSettings = seam.getSettings();
shortcutSettings.pluginEnabled = false;
for (const visible of [false, true]) {
  globalThis.shortcutPanelVisible = visible;
  seam.setLastMainViewForTest('schedule');
  await registeredShortcut.callback({}, 'axis-calendar');
  await registeredShortcut.callback({}, 'daily-menu');
  if (seam.shortcutState().lastMainView !== 'schedule') throw new Error('business shortcut bypassed the plugin master switch with panel visible=' + visible);
}
shortcutSettings.pluginEnabled = true;
shortcutSettings.characterExcludeAvatars = ['role.png'];
for (const visible of [false, true]) {
  globalThis.shortcutPanelVisible = visible;
  seam.setLastMainViewForTest('schedule');
  await registeredShortcut.callback({}, 'lines-events');
  if (seam.shortcutState().lastMainView !== 'schedule') throw new Error('business shortcut bypassed the excluded-card gate with panel visible=' + visible);
  seam.setSettingsOpenForTest(false);
  await registeredShortcut.callback({}, 'settings');
  await registeredShortcut.callback({}, 'settings');
  await registeredShortcut.callback({}, 'memory');
  if (!seam.shortcutState().settingsOpen || !memorySection.open) throw new Error('excluded-card setting shortcuts were blocked with panel visible=' + visible);
}
shortcutSettings.characterExcludeAvatars = [];
globalThis.shortcutPanelVisible = true;
seam.setLastMainViewForTest('space');
seam.openSchedule();
if (seam.shortcutState().lastMainView !== 'space' || !seam.shortcutState().spaceMode || globalThis.shortcutTriggerCalls !== 0) throw new Error('openSchedule did not restore through the shared direct route');
await registeredShortcut.callback({}, 'settings');
await registeredShortcut.callback({}, 'settings');
await registeredShortcut.callback({}, 'memory');
await registeredShortcut.callback({}, 'memory');
if (!seam.shortcutState().settingsOpen || !memorySection.open || !settingsLayer.open) throw new Error('settings/memory shortcuts did not remain open when repeated');
if (await registeredShortcut.callback({}, 'daily-menu') !== '') throw new Error('daily-menu shortcut did not return an empty command result');
if (await registeredShortcut.callback({}, 'unknown') !== '') throw new Error('unknown shortcut did not return an empty command result');
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
const nowBeforeRetention = Date.now; let retentionNow = 1_800_000_000_000; Date.now = () => retentionNow;
const linesValue = { raw: 'current story line '.repeat(4000), ts: 101, history: Array.from({ length: 10 }, (_, index) => ({ raw: 'history-' + index + ' history '.repeat(1200), id: 'line-' + index, locked: index === 3 })) };
const qqjValue = { recallText: 'QQJ fallback memory '.repeat(900), sourceKey: 'l0-7', savedAt: 777 };
const diagnosticValues = { schemaVersion: 1, floors: [{ replyId: 'success-reply', floor: 1, attempts: { lines: { requestId: 'success', finishedAt: retentionNow - 600_000, messages: [{ role: 'user', content: 'expired request body' }], rawResponse: 'retained raw', result: { commit: 'local-applied' } } } }, { replyId: 'pending-reply', floor: 2, attempts: { point: { requestId: 'pending', messages: [{ role: 'user', content: 'pending request body' }], result: { processing: 'pending', commit: 'pending', ui: 'pending' } } } }] };
const largeMetadata = { 'sp-store': { version: 1, data: { 'lines-user': linesValue, 'qqj-prompt-cache-user': qqjValue, 'diagnostics-v1': diagnosticValues } } };
setContext(context('codec-production-chat', largeMetadata, { is_group: false, file_name: 'codec-production-chat', char_name: 'Role', avatar_url: 'role.png' }));
const beforeCodecBytes = new TextEncoder().encode(JSON.stringify(largeMetadata)).byteLength;
seam.writeStore(seam.keyDesc('schedule', 'user', ''), { raw: 'trigger existing normal save', ts: 2 });
Date.now = nowBeforeRetention;
const packedLines = largeMetadata['sp-store'].data['lines-user'];
const packedQqj = largeMetadata['sp-store'].data['qqj-prompt-cache-user'];
const packedDiagnostics = largeMetadata['sp-store'].data['diagnostics-v1'];
if (packedLines?.codec !== 'stsc-gzip-base64' || packedQqj?.codec !== 'stsc-gzip-base64' || packedDiagnostics?.codec !== 'stsc-gzip-base64') throw new Error('production ordinary save did not encode all present large target keys');
if ('dashed-user' in largeMetadata['sp-store'].data) throw new Error('production save created the absent dashed key');
if (JSON.stringify(seam.readStore(seam.keyDesc('lines', 'user', ''))) !== JSON.stringify(linesValue)) throw new Error('production read changed current line or recoverable history data');
if (JSON.stringify(seam.readStore(seam.keyDesc('qqj-prompt-cache', 'user', ''))) !== JSON.stringify(qqjValue)) throw new Error('production QQJ fallback read changed cache data');
const decodedDiagnostics = await import(${JSON.stringify(pathToFileURL(path.join(repo, 'runtime/chat-storage.js')).href)});
const retainedDiagnostics = decodedDiagnostics.getChatDiagnostics();
if (Object.hasOwn(retainedDiagnostics[0].attempts.lines, 'messages') || retainedDiagnostics[0].attempts.lines.rawResponse !== 'retained raw') throw new Error('production TTL did not remove only expired request messages');
if (retainedDiagnostics[1].attempts.point.messages?.[0]?.content !== 'pending request body') throw new Error('production TTL removed an unresolved request');
const portableBuilt = seam.buildPortableChatPackage({ selectedModules: ['lines'], roots: { 'sp-store': largeMetadata['sp-store'] }, exportedAt: 'fixed' });
const portableLines = portableBuilt.package?.modules?.lines?.entries?.['lines-user'];
if (!portableBuilt.ok || portableLines?.codec || JSON.stringify(portableLines) !== JSON.stringify(linesValue)) throw new Error('portable export did not restore the complete plain line history');
const diagnosticPackage = await seam.buildCurrentChatDiagnosticPackage();
if (diagnosticPackage.business['sp-store'].data['lines-user']?.codec || diagnosticPackage.business['sp-store'].data['lines-user']?.history?.length !== 10) throw new Error('diagnostic export did not restore the complete plain business root');
if (diagnosticPackage.diagnostics[1].attempts.point.messages?.[0]?.content !== 'pending request body') throw new Error('diagnostic export omitted pending input');
const afterCodecBytes = new TextEncoder().encode(JSON.stringify(largeMetadata)).byteLength;
if (!(afterCodecBytes < beforeCodecBytes) || hostPayloadBytes.at(-1) !== afterCodecBytes) throw new Error('captured ordinary save body does not reflect actual codec/TTL metadata bytes');
const packedDiagnosticsAfterFirstSave = largeMetadata['sp-store'].data['diagnostics-v1'];
const packedDiagnosticsPayloadAfterFirstSave = packedDiagnosticsAfterFirstSave.payload;
seam.writeStore(seam.keyDesc('schedule', 'user', ''), { raw: 'second unchanged save', ts: 3 });
if (largeMetadata['sp-store'].data['diagnostics-v1'] !== packedDiagnosticsAfterFirstSave || largeMetadata['sp-store'].data['diagnostics-v1'].payload !== packedDiagnosticsPayloadAfterFirstSave) throw new Error('unchanged diagnostics were decoded and recompressed on the next normal save');
const sameValueImport = await seam.commitPortableImport({
  identity: { chatId: 'codec-production-chat' },
  originalRoots: { 'sp-store': structuredClone(largeMetadata['sp-store']) },
  portablePackage: portableBuilt.package,
  selectedModules: ['lines'],
});
if (sameValueImport.reason !== 'no-change' || saveCalls !== 5) throw new Error('same-value portable import unexpectedly saved (reason=' + sameValueImport.reason + ', calls=' + saveCalls + ')');
if (saveCalls !== 5 || fetchCalls !== 0) throw new Error('codec and TTL must reuse exactly one ordinary save per write');

const rejectChecks = [];
for (const [kind, key] of [['dashed', 'dashed-user'], ['lines', 'lines-user'], ['qqj-prompt-cache', 'qqj-prompt-cache-user']]) {
  const rejectedMetadata = { 'sp-store': { version: 1, data: {
    'dashed-user': { raw: '冷知识。'.repeat(700) },
    'lines-user': { raw: '线历史。'.repeat(900), history: [{ raw: '可恢复历史。'.repeat(300), locked: true }] },
    'qqj-prompt-cache-user': { recallText: '缓存回退。'.repeat(700), sourceKey: 'l0-7' },
    'diagnostics-v1': {
      schemaVersion: 1,
      floors: [{
        replyId: 'pending',
        attempts: { lines: { requestId: 'pending', messages: [{ role: 'user', content: '未决输入。'.repeat(600) }], result: { processing: 'pending', commit: 'pending', ui: 'pending' } } },
      }],
    },
  } } };
  const rejected = Promise.reject(new Error('synthetic async save rejection'));
  setContext(context('reject-' + kind, rejectedMetadata, { is_group: false, file_name: 'reject-' + kind, char_name: 'Role', avatar_url: 'role.png' }, rejected));
  let callback = null;
  const result = await seam.writeStoreConfirmed(seam.keyDesc(kind, 'user', ''), { raw: 'new owned ' + kind + ' value '.repeat(400) }, { onPersistenceError: (error, details) => { callback = { errorClass: error.name, key: details.key }; } });
  await new Promise(resolve => setImmediate(resolve));
  if (result.commitState !== 'local-applied' || callback?.errorClass !== 'Error' || callback.key !== key) throw new Error('packed ordinary value lost its async save rejection callback for ' + kind);
  if (Object.values(rejectedMetadata['sp-store'].data).filter(value => value?.codec === 'stsc-gzip-base64').length !== 4) throw new Error('async reject fixture did not pack all four known keys');
  rejectChecks.push(kind);
}
if (rejectChecks.length !== 3 || saveCalls !== 8 || fetchCalls !== 0) throw new Error('packed async rejection checks must each use one ordinary save');

const futurePack = { codec: 'stsc-gzip-base64-v2', version: 2, payload: 'future-format' };
const damagedPack = { codec: 'stsc-gzip-base64', version: 1, payload: 'broken' };
const protectedMetadata = { 'sp-store': { version: 1, data: {
  'schedule-user': { raw: 'must survive failed batch', ts: 1 },
  'lines-user': futurePack,
  'qqj-prompt-cache-user': damagedPack,
  'diagnostics-v1': { codec: 'stsc-gzip-base64', version: 1, payload: 'broken' },
} } };
setContext(context('damaged-pack-chat', protectedMetadata, { is_group: false, file_name: 'damaged-pack-chat', char_name: 'Role', avatar_url: 'role.png' }));
for (const attempt of [
  () => seam.writeData('lines', 'user', '', { raw: 'overwrite future pack' }),
  () => seam.writeBatch([{ kind: 'schedule', view: 'user', charName: '', value: { raw: 'batch partial write', ts: 2 } }, { kind: 'lines', view: 'user', charName: '', value: { raw: 'overwrite future pack' } }]),
  () => seam.writeRaw('qqj-prompt-cache-user', { recallText: 'overwrite damaged pack' }),
  () => seam.writeRaw('diagnostics-v1', { floors: [] }),
]) {
  try { attempt(); throw new Error('damaged or future wrapper was silently overwritten'); }
  catch (error) { if (error.message === 'damaged or future wrapper was silently overwritten') throw error; if (!/无法识别|损坏/.test(error.message)) throw error; }
}
if (protectedMetadata['sp-store'].data['schedule-user'].ts !== 1 || protectedMetadata['sp-store'].data['lines-user'] !== futurePack || protectedMetadata['sp-store'].data['qqj-prompt-cache-user'] !== damagedPack || protectedMetadata['sp-store'].data['diagnostics-v1'].payload !== 'broken') throw new Error('failed direct/batch writes replaced protected physical values');
for (const key of ['lines-user', 'qqj-prompt-cache-user']) {
  try { seam.readStore(seam.keyDesc(key === 'lines-user' ? 'lines' : 'qqj-prompt-cache', 'user', '')); throw new Error('bad wrapper read as an ordinary value'); }
  catch (error) { if (error.message === 'bad wrapper read as an ordinary value') throw error; }
}
const malformedDiagnosticRoot = { 'sp-store': { version: 1, data: { 'diagnostics-v1': ${JSON.stringify(malformedDiagnostics)} } } };
const malformedDiagnosticContext = context('bad-diagnostics-chat', malformedDiagnosticRoot, { is_group: false, file_name: 'bad-diagnostics-chat', char_name: 'Role', avatar_url: 'role.png' });
malformedDiagnosticContext.chat = [{ is_user: false, is_system: false, mes: 'diagnostic structure probe' }];
setContext(malformedDiagnosticContext);
const originalMalformedDiagnostics = malformedDiagnosticRoot['sp-store'].data['diagnostics-v1'];
try { decodedDiagnostics.getChatDiagnostics(); throw new Error('bad diagnostic wrapper read as an empty value'); }
catch (error) { if (error.message === 'bad diagnostic wrapper read as an empty value') throw error; }
try { decodedDiagnostics.refreshDiagnosticRetention(); throw new Error('diagnostic update silently replaced malformed storage'); }
catch (error) { if (error.message === 'diagnostic update silently replaced malformed storage') throw error; }
try { await seam.buildCurrentChatDiagnosticPackage(); throw new Error('diagnostic export accepted a malformed packed value'); }
catch (error) { if (error.message === 'diagnostic export accepted a malformed packed value') throw error; }
if (malformedDiagnosticRoot['sp-store'].data['diagnostics-v1'] !== originalMalformedDiagnostics) throw new Error('diagnostic update replaced its malformed physical wrapper');

for (const legacyDiagnostics of [{}, { marker: 'retain' }]) {
  const legacyRoot = { 'sp-store': { version: 1, data: { 'diagnostics-v1': legacyDiagnostics } } };
  const legacyContext = context('legacy-diagnostics-chat', legacyRoot, { is_group: false, file_name: 'legacy-diagnostics-chat', char_name: 'Role', avatar_url: 'role.png' });
  setContext(legacyContext);
  if (decodedDiagnostics.getChatDiagnostics().length !== 0) throw new Error('legacy plain diagnostics without floors lost the empty-list fallback');
  if (legacyRoot['sp-store'].data['diagnostics-v1'] !== legacyDiagnostics) throw new Error('reading legacy plain diagnostics rewrote its stored value');
}
const legacyLargeDiagnostics = { marker: 'old diagnostic shape '.repeat(1000) };
const legacyLargeRoot = { 'sp-store': { version: 1, data: { 'diagnostics-v1': legacyLargeDiagnostics } } };
setContext(context('legacy-large-diagnostics-chat', legacyLargeRoot, { is_group: false, file_name: 'legacy-large-diagnostics-chat', char_name: 'Role', avatar_url: 'role.png' }));
seam.writeStore(seam.keyDesc('schedule', 'user', ''), { raw: 'normal save preserves legacy diagnostic shape', ts: 4 });
if (legacyLargeRoot['sp-store'].data['diagnostics-v1'] !== legacyLargeDiagnostics || decodedDiagnostics.getChatDiagnostics().length !== 0) throw new Error('normal save packed or broke a legacy diagnostic value without floors');

const snapshotCalendar = { kind: 'custom', id: 'snapshot-save-test', revision: 1, weekdayCycle: 7, era: '纪', months: [{ name: '一月', days: 30 }, { name: '二月', days: 30 }] };
const snapshotValue = { point: 'p', line: 'l', almanac: [], pool: [], recall: [], calendar: snapshotCalendar, anchor: { month: 1, day: 2 } };
let snapshotDebouncedCalls = 0;
const snapshotTargetMetadata = { 'sp-store': { version: 1, data: { 'lines-user': { raw: 'snapshot target line '.repeat(1000) } } } };
const snapshotTarget = context('snapshot-target', snapshotTargetMetadata, { is_group: false, file_name: 'snapshot-target', char_name: 'Role', avatar_url: 'role.png' });
snapshotTarget.chat = [{ is_user: false, extra: {}, swipe_id: 0, swipe_info: [{ extra: {} }] }];
snapshotTarget.saveChatDebounced = () => { snapshotDebouncedCalls++; };
setContext(snapshotTarget);
if (!seam.snapshotWrite(0, snapshotValue)) throw new Error('snapshot save integration did not update the latest floor');
if (snapshotDebouncedCalls !== 1 || snapshotTargetMetadata['sp-store'].data['lines-user']?.codec !== 'stsc-gzip-base64') throw new Error('snapshot debounced save did not prepare its current normal metadata once');

let snapshotFallbackCalls = 0;
const fallbackMetadata = { 'sp-store': { version: 1, data: { 'lines-user': { raw: 'fallback snapshot target '.repeat(1000) } } } };
const snapshotFallbackTarget = context('snapshot-fallback-target', fallbackMetadata, { is_group: false, file_name: 'snapshot-fallback-target', char_name: 'Role', avatar_url: 'role.png' });
snapshotFallbackTarget.chat = [{ is_user: false, extra: {}, swipe_id: 0, swipe_info: [{ extra: {} }] }];
snapshotFallbackTarget.saveChat = () => { snapshotFallbackCalls++; };
setContext(snapshotFallbackTarget);
if (!seam.snapshotWrite(0, snapshotValue)) throw new Error('snapshot fallback did not update its target floor');
await new Promise(resolve => setTimeout(resolve, 250));
if (snapshotFallbackCalls !== 1 || fallbackMetadata['sp-store'].data['lines-user']?.codec !== 'stsc-gzip-base64') throw new Error('snapshot fallback did not use its existing single-target prepare and save');

const ledgerMetadata = {};
const fetchCallsBeforeLedger = fetchCalls;
setContext(context('ledger-chat', ledgerMetadata, { is_group: false, file_name: 'ledger-chat', char_name: 'Role', avatar_url: 'role.png' }));
const ledgerEntries = await seam.addLedgerEntries([{ 事由: '现场事务', 类型: '持续状态', 现状: '仍在持续。' }]);
if (ledgerEntries.length !== 1 || ledgerMetadata['sp-ledger']?.entries?.[0]?.事由 !== '现场事务') throw new Error('ordinary ledger batch was not applied to the live root');
if (saveCalls !== 10 || fetchCalls !== fetchCallsBeforeLedger) throw new Error('ordinary ledger batch must make one standard host save without adding GET/PATCH: ' + saveCalls + '/' + fetchCalls);
const ledgerThrowMetadata = {};
setContext(context('ledger-throw-chat', ledgerThrowMetadata, { is_group: false, file_name: 'ledger-throw-chat', char_name: 'Role', avatar_url: 'role.png' }, () => { saveCalls++; throw new Error('synthetic synchronous host save failure'); }));
const thrownLedger = await seam.addLedgerEntries([{ 事由: '已应用事项', 类型: '持续状态', 现状: '仍在本地。' }]);
if (thrownLedger.length !== 1 || ledgerThrowMetadata['sp-ledger']?.entries?.[0]?.事由 !== '已应用事项') throw new Error('ordinary ledger batch rolled back after host save threw');
globalThis.fetch = async url => { throw new Error('ordinary memory must not request a storage backend: ' + String(url)); };
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
if (saveCalls !== 12 || !memoryProgress.some(item => item.current === 1 && item.done === false)) throw new Error('manual memory did not progress immediately after one standard save');
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
if (await registeredShortcut.callback({}, 'daily-menu') !== '') throw new Error('daily-menu slash command did not return an empty result');
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
const originalSetTimeout = globalThis.setTimeout; const toastDelays = [];
globalThis.setTimeout = (_callback, delay) => { toastDelays.push(delay); return 1; };
globalThis.toastr = null; delete globalThis.__zmerUniversalToastThemeCleanup;
seam.showToast('状态提示', null, 'info'); seam.showToast('成功提示'); seam.showToast('失败提示', null, true); seam.showToast('旧 truthy 失败提示', null, 'legacy');
const customToastMarkup = globalThis.__feedbackCapture.toastMarkup.slice(-4);
if (!customToastMarkup[0].includes('sp-toast-info') || !customToastMarkup[0].includes('data-sp-icon="info-circle"')) throw new Error('custom info toast did not render the informational style/icon');
if (customToastMarkup[1].includes('sp-toast-error') || customToastMarkup[1].includes('sp-toast-info') || !customToastMarkup[1].includes('data-sp-icon="calendar-check"')) throw new Error('custom success toast changed its existing success style');
if (!customToastMarkup[2].includes('sp-toast-error') || !customToastMarkup[3].includes('sp-toast-error')) throw new Error('true and legacy truthy toast arguments must retain failure styling');
const visibleToastDelays = toastDelays.filter(delay => delay === 4000 || delay === 10000);
if (JSON.stringify(visibleToastDelays) !== JSON.stringify([4000, 4000, 10000, 10000])) throw new Error('custom toast duration changed the success/info/error contract');
const toastrCalls = [];
globalThis.toastr = Object.fromEntries(['info', 'success', 'error'].map(type => [type, (...args) => toastrCalls.push({ type, args })]));
globalThis.__zmerUniversalToastThemeCleanup = () => {};
seam.showToast('info', null, 'info'); seam.showToast('success'); seam.showToast('error', null, true); seam.showToast('legacy truthy', null, 'legacy');
if (JSON.stringify(toastrCalls.map(call => call.type)) !== JSON.stringify(['info', 'success', 'error', 'error'])) throw new Error('toastr info/success/error routing changed');
if (toastrCalls[0].args[2].timeOut !== 4000 || toastrCalls[1].args[2].timeOut !== undefined || toastrCalls[2].args[2].timeOut !== 10000 || toastrCalls[3].args[2].timeOut !== 10000) throw new Error('toastr toast timeout contract changed');
delete globalThis.__zmerUniversalToastThemeCleanup; globalThis.toastr = null;
const memorySettings = seam.getSettings(); memorySettings.useQianQianJie = false; memorySettings.useBaiBaiBook = false; memorySettings.useAnima = false; memorySettings.useDatabase = true; memorySettings.databaseWorldbookName = 'Feedback Test Book';
setContext(context('feedback-test-chat', {}, { is_group: false, file_name: 'feedback-test-chat', char_name: 'Role', avatar_url: 'role.png' }));
seam.setDialogShadow({ querySelector() { return null; }, appendChild() {} });
async function checkDatabasePreflight(helper, title, decision = true) {
  globalThis.TavernHelper = helper;
  globalThis.__feedbackCapture.confirmMarkup = ''; globalThis.__feedbackCapture.confirmOk = null; globalThis.__feedbackCapture.confirmCancel = null;
  const pending = seam.memoryPreCheckConfirm();
  for (let index = 0; index < 12 && !globalThis.__feedbackCapture.confirmOk; index++) await Promise.resolve();
  if (!globalThis.__feedbackCapture.confirmMarkup.includes('<div class="sp-confirm-head">' + title + '</div>')) throw new Error('production database preflight displayed the wrong title: ' + globalThis.__feedbackCapture.confirmMarkup);
  const callback = decision ? globalThis.__feedbackCapture.confirmOk : globalThis.__feedbackCapture.confirmCancel;
  if (!callback) throw new Error('production database preflight did not render the expected confirmation choice');
  callback();
  const result = await pending;
  if (decision ? result?.proceed !== true : result !== false) throw new Error('database preflight did not preserve its existing continue/cancel decision');
}
await checkDatabasePreflight({ getWorldbook: async () => [] }, '数据库记忆为空');
await checkDatabasePreflight({}, '数据库记忆不可用');
await checkDatabasePreflight({ getWorldbook: async () => { throw new Error('mock read failure'); } }, '数据库记忆读取失败', false);
memorySettings.useDatabase = false; memorySettings.useBaiBaiBook = true;
seam.setShortcutUiForTest({ querySelector(selector) { return selector.startsWith('#sp-mem-') ? { __feedbackSelector: selector } : null; }, querySelectorAll() { return []; } });
globalThis.__feedbackCapture.statusHtml = [];
globalThis.STBaiBaiBook = { getInjectedHistory() { throw new Error('mock coverage read failure'); } };
seam.renderMemorySection();
let bbbStatus = globalThis.__feedbackCapture.statusHtml.filter(item => item.selector === '#sp-mem-bbb-status').at(-1)?.value || '';
if (!bbbStatus.includes('读取状态失败') || bbbStatus.includes('circle-check') || bbbStatus.includes('已就绪')) throw new Error('production BaiBaiBook status hid a read exception as success');
globalThis.STBaiBaiBook = { getInjectedHistory() { return { coverage: { complete: true } }; } };
seam.renderMemorySection();
bbbStatus = globalThis.__feedbackCapture.statusHtml.filter(item => item.selector === '#sp-mem-bbb-status').at(-1)?.value || '';
if (!bbbStatus.includes('柏宝书已就绪（覆盖完整）') || !bbbStatus.includes('circle-check')) throw new Error('production BaiBaiBook status changed the successful coverage path');
globalThis.STBaiBaiBook = { getInjectedHistory() { return {}; } };
seam.renderMemorySection();
bbbStatus = globalThis.__feedbackCapture.statusHtml.filter(item => item.selector === '#sp-mem-bbb-status').at(-1)?.value || '';
if (!bbbStatus.includes('柏宝书已就绪（覆盖完整）')) throw new Error('production BaiBaiBook status changed the existing missing-coverage contract');
let inlineCaptureHandler = null;
const fakeChat = { off() {}, on(_event, selector, handler) { if (selector === '.sp-inline-ledger-capture') inlineCaptureHandler = handler; return this; } };
seam.bindLedgerBusyForTest(fakeChat);
if (!inlineCaptureHandler) throw new Error('production ledger inline capture route was not bound');
const busyResult = await inlineCaptureHandler.call({}, { stopPropagation() {} });
if (busyResult?.status !== 'busy' || !globalThis.__feedbackCapture.toastMarkup.at(-1)?.includes('sp-toast-info')) throw new Error('inline ledger busy status did not use the production informational toast');
if (seam.timeTravelDirectionLoadErrorText({ diagnosticCode: 'config-missing' }) !== '请先在设置中填写自定义 API 的 URL 和 Key；也可以返回后直接采用。') throw new Error('time-travel picker did not retain the actionable API configuration guidance');
const safeDirectionError = seam.timeTravelDirectionLoadErrorText(Object.assign(new Error('raw upstream body with private data'), { status: 401 }));
if (!safeDirectionError.includes('读取 AI 推演方向失败') || !safeDirectionError.includes('检查 Key') || safeDirectionError.includes('raw upstream body')) throw new Error('time-travel picker did not map auth failures to safe operation-specific guidance');
globalThis.setTimeout = originalSetTimeout;
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
