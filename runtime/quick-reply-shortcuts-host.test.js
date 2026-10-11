import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('native QuickReplySet.executeWithOptions dispatches the registered shortcut slash command', async () => {
    const runtimeDir = path.dirname(new URL(import.meta.url).pathname);
    const extensionDir = path.resolve(runtimeDir, '..');
    const repo = path.resolve(runtimeDir, '../../../../../..');
    const qrSetUrl = pathToFileURL(path.join(repo, 'public/scripts/extensions/quick-reply/src/QuickReplySet.js')).href;
    const shortcutUrl = pathToFileURL(path.join(extensionDir, 'runtime/quick-reply-shortcuts.js')).href;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'st7cal-qr-host-'));
    const loader = path.join(dir, 'loader.mjs');
    const runner = path.join(dir, 'runner.mjs');
    const fixture = pathToFileURL(path.join(dir, 'fixture.mjs')).href;
    await fs.writeFile(path.join(dir, 'fixture.mjs'), `
export function getRequestHeaders() { return {}; }
export function substituteParams(value) { return String(value ?? ''); }
export const Popup = {}; export const POPUP_RESULT = {}; export const POPUP_TYPE = {};
export class SlashCommandScope {}
export class SlashCommandParser {
  static commands = {};
  static addCommandObject(command) { this.commands[command.name] = command; (globalThis.__commands ??= []).push(command); }
}
export async function executeSlashCommandsWithOptions(input, options) {
  globalThis.__hostSlashExecutions.push({ path: 'with-options', input, source: options.source });
  return executeInput(input, options);
}
export async function executeSlashCommandsOnChatInput(input, options) {
  globalThis.__hostSlashExecutions.push({ path: 'chat-input', input, source: options.source });
  return executeInput(input, options);
}
async function executeInput(input, options) {
  const [name, ...parts] = input.trim().split(/\\s+/);
  const command = globalThis.__commands.find(item => item.name === name.slice(1));
  if (!command) throw new Error('host slash parser could not resolve ' + name);
  return { pipe: await command.callback({}, parts.join(' ')) };
}
export function debounceAsync(fn, timeout = 300) { let timer; let promise; let resolvePromise; return (...args) => { clearTimeout(timer); if (!promise) promise = new Promise(resolve => { resolvePromise = resolve; }); timer = setTimeout(() => { resolvePromise(fn.apply(this, args)); promise = null; }, timeout); return promise; }; } export function warn() {}
export class QuickReply { static from(props) { return props; } }
`);
    await fs.writeFile(loader, `
const fixture = ${JSON.stringify(fixture)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/script.js') || specifier.endsWith('/popup.js') || specifier.endsWith('/slash-commands.js') || specifier.endsWith('/SlashCommandScope.js') || specifier.endsWith('/SlashCommandParser.js') || specifier.endsWith('/index.js') || specifier.endsWith('/QuickReply.js')) return { url: fixture, shortCircuit: true };
  return nextResolve(specifier, context);
}
`);
    await fs.writeFile(runner, `
import { QuickReplySet } from ${JSON.stringify(qrSetUrl)};
import { QUICK_REPLY_SHORTCUT_SET, createQuickReplyShortcutSync, quickReplyShortcutMessage, registerQuickReplyShortcutCommand } from ${JSON.stringify(shortcutUrl)};
import { SlashCommandParser } from ${JSON.stringify(fixture)};
globalThis.__hostSlashExecutions = [];
const opened = [];
registerQuickReplyShortcutCommand({ parser: SlashCommandParser, commandClass: { fromProps: value => value }, open: key => opened.push(key), notify: () => {} });
globalThis.document = { querySelector: () => ({ value: '' }) };
const set = QuickReplySet.from({ name: 'native-host-test', disableSend: false, injectInput: false, idIndex: 1 });
const result = await set.executeWithOptions({ label: '轴日历入口', message: quickReplyShortcutMessage('axis-calendar') });
if (result !== '') throw new Error('QuickReplySet did not return an empty pipe for the command');
if (JSON.stringify(opened) !== JSON.stringify(['axis-calendar'])) throw new Error('registered production callback was not called: ' + JSON.stringify(opened));
if (globalThis.__hostSlashExecutions.length !== 1 || globalThis.__hostSlashExecutions[0].path !== 'chat-input' || globalThis.__hostSlashExecutions[0].input !== '/gouhua-open axis-calendar ') throw new Error('native QuickReplySet did not use its button-click slash-command path');
const persistenceCalls = [];
globalThis.fetch = async (url, options) => { persistenceCalls.push({ url, body: JSON.parse(options.body) }); return { ok: true }; };
const storedSet = QuickReplySet.from({ name: QUICK_REPLY_SHORTCUT_SET, disableSend: true, idIndex: 3 });
storedSet.qrList = [{ label: '点', message: quickReplyShortcutMessage('point'), automationId: '' }];
QuickReplySet.list = [storedSet];
const api = {
  settings: { config: { hasSet: candidate => candidate === storedSet } },
  getSetByName: name => name === QUICK_REPLY_SHORTCUT_SET ? storedSet : null,
  removeGlobalSet: () => {},
  deleteQuickReply: (_name, label) => storedSet.removeQuickReply(storedSet.qrList.find(qr => qr.label === label)),
  deleteSet: async () => storedSet.delete(),
};
const syncErrors = [];
await createQuickReplyShortcutSync({ getApi: () => api, notify: error => syncErrors.push(error) })([]);
if (persistenceCalls.length !== 2 || persistenceCalls[0].url !== '/api/quick-replies/save' || persistenceCalls[1].url !== '/api/quick-replies/delete' || persistenceCalls[0].body.qrList.length !== 0) throw new Error('native debounced final save did not complete before set deletion: ' + JSON.stringify({ persistenceCalls, syncErrors, qrList: storedSet.qrList }));
`);
    try {
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, runner], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = ''; let stderr = '';
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', error => resolve({ code: -1, stdout: '', stderr: error.stack }));
            child.on('close', code => resolve({ code, stdout, stderr }));
        });
        assert.equal(result.code, 0, `child exit ${result.code}\n${result.stdout}${result.stderr}`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
