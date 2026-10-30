import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

test('production index/store merges two overlapping dish references through ordinary chat metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gouhua-menu-image-store-'));
    const repo = path.resolve(import.meta.dirname, '..');
    const entry = pathToFileURL(path.join(repo, 'index.js')).href;
    const fixture = path.join(dir, 'host.mjs');
    const loader = path.join(dir, 'loader.mjs');
    const runner = path.join(dir, 'runner.mjs');
    try {
        await fs.writeFile(fixture, `
export const extension_settings = {};
export const extensionNames = []; export const extensionTypes = {};
export let saveCalls = 0; export let ctx = { chatId: 'menu-image-fixture', chat: [], chatMetadata: {}, saveMetadata(){ saveCalls++; } };
export const getContext = () => ctx;
export const eventSource = { on() {}, removeListener() {}, makeLast() {} };
export const event_types = {}; export const system_message_types = {};
export function saveSettingsDebounced() {} export function saveSettings() {}
export const substituteParams = value => String(value ?? '');
export const getRequestHeaders = () => ({});
export const equalsIgnoreCaseAndAccents = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
export const getCharaFilename = () => '';
export const world_info = {}; export const selected_world_info = [];
export class SlashCommandParser { static addCommandObject() {} }
export class SlashCommand { static fromProps(value) { return value; } }
export const showdown = undefined; export const DOMPurify = undefined;
`);
        await fs.writeFile(loader, `
const fixture = ${JSON.stringify(pathToFileURL(fixture).href)};
const entry = ${JSON.stringify(entry)};
const hostNames = ['extensions.js','script.js','utils.js','world-info.js','SlashCommandParser.js','SlashCommand.js','lib.js'];
export async function resolve(specifier, context, nextResolve) {
  if (hostNames.some(name => specifier.endsWith('/' + name) || specifier === name)) return { url: fixture, shortCircuit: true };
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  const value = await nextLoad(url, context);
  if (url.split('?')[0] !== entry) return value;
  return { ...value, source: String(value.source) + '\\n;globalThis.menuImageStore = { dailyMenuImageController, writeStoreConfirmed, readStore, keyDesc };', shortCircuit: true };
}
`);
        await fs.writeFile(runner, `
import { writeSync } from 'node:fs';
const chain = new Proxy({ length: 0 }, { get: (value, key) => key === 'length' ? 0 : () => chain });
globalThis.jQuery = Object.assign(() => chain, { fn: {} }); globalThis.$ = globalThis.jQuery;
globalThis.window = { innerWidth: 1024, innerHeight: 768, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
globalThis.document = { documentElement: { style: { setProperty() {} }, insertAdjacentHTML() {} }, body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} }, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }) };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' }); globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.MutationObserver = class { observe() {} disconnect() {} }; globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ enabled: false }) });
await Promise.race([import(${JSON.stringify(entry)}), new Promise((_, reject) => setTimeout(() => reject(new Error('production index did not import')), 2500))]);
const { ctx } = await import(${JSON.stringify(pathToFileURL(fixture).href)});
const seam = globalThis.menuImageStore;
ctx.chatMetadata['sp-store'] = { version: 1, data: { 'daily-menu-user': { title: 'Lunch', generatedAt: 123, items: [{ name: 'Soup', category: 'soup', description: 'Creamy pumpkin soup' }, { name: 'Fish', category: 'main', description: 'Grilled fish' }] } } };
let imageCalls = 0;
globalThis.STBaiBaiImage = { apiVersion: 1, getBackendStatus: () => ({ configured: true }), generate: async () => ({ path: '/user/images/menu/external-' + (++imageCalls) + '.png', dataUrl: 'data:image/png;base64,HUGE' }) };
const results = await Promise.race([Promise.all([seam.dailyMenuImageController.run(0), seam.dailyMenuImageController.run(1)]), new Promise((_, reject) => setTimeout(() => reject(new Error('overlapping image references did not finish')), 2500))]);
const saved = seam.readStore(seam.keyDesc('daily-menu', 'user', ''));
if (imageCalls !== 2 || results.some(result => result.status !== 'updated') || saved.items[0].image?.path !== '/user/images/menu/external-1.png' || saved.items[1].image?.path !== '/user/images/menu/external-2.png') throw new Error('overlapping menu image references failed: ' + JSON.stringify({ results, saved }));
if (JSON.stringify(saved).includes('data:image')) throw new Error('chat payload did not preserve only the final gallery references');
// Sync output also reaches the parent under Node 26 hosts that drop async pipe writes.
writeSync(1, 'MENU_IMAGE_CHAT_SAVE ' + JSON.stringify({ results: results.map(result => result.status), paths: saved.items.map(item => item.image.path), savedToChat: true }) + '\\n');
`);
        const result = await new Promise(resolve => {
            const child = spawn(process.execPath, ['--experimental-loader', loader, runner], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
            child.once('error', error => resolve({ code: -1, stdout, stderr: String(error) }));
            child.once('close', code => resolve({ code, stdout, stderr }));
        });
        assert.equal(result.code, 0, result.stderr + result.stdout);
        const evidence = result.stdout.match(/MENU_IMAGE_CHAT_SAVE .+/);
        assert.ok(evidence, 'chat save fixture did not reach its final assertion: ' + result.stderr + result.stdout);
        console.log(evidence[0]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
