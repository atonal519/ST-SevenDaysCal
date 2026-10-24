import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

test('production index/store merges two overlapping dish references through external CAS', async () => {
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
export let ctx = { chatId: 'menu-image-fixture', chat: [], chatMetadata: { 'sp-storage': { provider: 'st-bainiaodata', schemaVersion: 1, collection: 'menu-image-fixture', currentRecord: 'current', diagnosticsRecord: 'diagnostics' } } };
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
  return { ...value, source: String(value.source) + '\\n;globalThis.menuImageStore = { dailyMenuImageController, writeStoreConfirmed, readStore, keyDesc, bindExternalChatStorage, loadExternalChat };', shortCircuit: true };
}
`);
        await fs.writeFile(runner, `
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
let revision = 1; const writes = [];
const initial = { schemaVersion: 1, roots: { 'sp-store': { version: 1, data: { 'daily-menu-user': { title: 'Lunch', generatedAt: 123, items: [{ name: 'Soup', category: 'soup', description: 'Creamy orange pumpkin soup' }, { name: 'Fish', category: 'main', description: 'Golden grilled fish' }] } } } } };
seam.bindExternalChatStorage({ getContext: () => ctx, fetchImpl: async (url, options = {}) => {
 if (String(url).endsWith('/health')) return { ok: true, status: 200, json: async () => ({ apiVersion: 1, records: true, recordList: true, optimisticRevision: true, atomicReplace: true }) };
 if (String(url).endsWith('/menu-image-fixture')) return { ok: true, status: 200, json: async () => [{ recordId: 'current', revision: 1, data: initial }, { recordId: 'diagnostics', revision: 1, data: { schemaVersion: 1, floors: [] } }] };
 if (String(url).endsWith('/menu-image-fixture/current') && options.method === 'PUT') {
   const body = JSON.parse(options.body); writes.push(body); await new Promise(resolve => setTimeout(resolve, 20));
   if (body.expectedRevision !== revision) return { ok: false, status: 409, json: async () => ({}) };
   return { ok: true, status: 200, json: async () => ({ revision: ++revision }) };
 }
 throw new Error('unexpected external fixture URL: ' + url);
} });
const status = await seam.loadExternalChat({ force: true });
if (status.status !== 'ready') throw new Error('external fixture did not load');
let imageCalls = 0;
globalThis.STBaiBaiImage = { apiVersion: 1, getBackendStatus: () => ({ configured: true }), generate: async () => ({ path: '/user/images/menu/external-' + (++imageCalls) + '.png', dataUrl: 'data:image/png;base64,HUGE' }) };
const results = await Promise.race([Promise.all([seam.dailyMenuImageController.run(0), seam.dailyMenuImageController.run(1)]), new Promise((_, reject) => setTimeout(() => reject(new Error('overlapping external image references did not finish')), 2500))]);
const saved = seam.readStore(seam.keyDesc('daily-menu', 'user', ''));
if (imageCalls !== 2 || results.some(result => result.status !== 'updated') || saved.items[0].image?.path !== '/user/images/menu/external-1.png' || saved.items[1].image?.path !== '/user/images/menu/external-2.png') throw new Error('overlapping external menu image references failed: ' + JSON.stringify({ results, saved }));
if (JSON.stringify(writes.at(-1).data.roots['sp-store'].data['daily-menu-user']) !== JSON.stringify(saved) || JSON.stringify(saved).includes('data:image')) throw new Error('external payload did not preserve only the final gallery references');
process.stdout.write('MENU_IMAGE_EXTERNAL_CAS ' + JSON.stringify({ results: results.map(result => result.status), paths: saved.items.map(item => item.image.path), expectedRevisions: writes.map(write => write.expectedRevision) }) + '\\n');
`);
        const result = await new Promise(resolve => {
            const child = spawn(process.execPath, ['--experimental-loader', loader, runner], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
            child.once('error', error => resolve({ code: -1, stdout, stderr: String(error) }));
            child.once('close', code => resolve({ code, stdout, stderr }));
        });
        assert.equal(result.code, 0, result.stderr + result.stdout);
        const evidence = result.stdout.match(/MENU_IMAGE_EXTERNAL_CAS .+/);
        assert.ok(evidence, 'external CAS fixture did not reach its final assertion: ' + result.stderr + result.stdout);
        console.log(evidence[0]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
