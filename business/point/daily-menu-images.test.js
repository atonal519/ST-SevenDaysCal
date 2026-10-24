import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyMenu, buildDailyMenuPrompt, renderDailyMenuHtml } from './daily-menu.js';
import { createDailyMenuImageController, dailyMenuContentKey } from './daily-menu-images.js';
import { createTaskOwnerManager } from '../../runtime/task-owner.js';
import { buildPortableChatPackage, createPortableImportPlan, parsePortableChatPackage } from '../../runtime/portable-chat-data.js';

const dish = (name = '南瓜汤') => ({ name, category: '汤品', description: '南瓜切块慢炖，打成柔滑浓汤。盛在白瓷碗里，表面撒少许香草。', imagePrompt: 'pumpkin soup in a white porcelain bowl, creamy orange surface, herb garnish' });
const menu = () => ({ title: '暖意午餐', intro: '利用时令食材。', storyDate: '秋日', generatedAt: 123, items: [dish(), dish('烤鱼')] });
function harness(generate, writeError = null) {
    let value = menu(); const calls = [], writes = [], notices = [];
    const controller = createDailyMenuImageController({ owners: createTaskOwnerManager(), api: () => ({ apiVersion: 1, getBackendStatus: () => ({ configured: true }), generate: async (...args) => { calls.push(args); return generate(...args); } }), capture: () => ({ characterName: '当前角色卡', read: () => value, write: async next => { if (writeError) throw writeError; writes.push(next); value = next; return { ok: true, commitState: 'local-applied' }; } }), render() {}, toast: message => notices.push(message) });
    return { controller, calls, writes, notices, read: () => value, replace: next => { value = next; } };
}

test('menu parses explicitly bound hidden image descriptions and retains old dish columns', () => {
    const parsed = parseDailyMenu('Image: orphan\nTitle: 午餐\nDish: 汤 | 汤品 | 橙色浓汤\nImage: creamy orange pumpkin soup\nDish: 鱼 | 主菜 | 烤至金黄 | 配柠檬\n其他包装\nImage: unbound image\nDish: 菜 | 配菜 | 青翠\n绘图描述：green vegetables on a plate');
    assert.equal(parsed.items[0].imagePrompt, 'creamy orange pumpkin soup');
    assert.equal(parsed.items[1].description, '烤至金黄 | 配柠檬');
    assert.equal(parsed.items[1].imagePrompt, undefined);
    assert.equal(parsed.items[2].imagePrompt, 'green vegetables on a plate');
    const prompt = buildDailyMenuPrompt();
    assert.match(prompt, /Dish用1–2句写清主要与辅助食材、可见调味、关键处理和烹调方式及成菜口感/); assert.match(prompt, /Image:/); assert.match(prompt, /Image用中文/);
    const html = renderDailyMenuHtml(parsed);
    assert.equal((html.match(/class="sp-daily-menu-image-toggle/g) || []).length, 3);
    assert.doesNotMatch(html, /<details|<summary|>菜品配图</);
    assert.doesNotMatch(html, /creamy orange|green vegetables|unbound image|<img|<details[^>]*\sopen/);
});

test('one manual dish request saves only its gallery reference and preserves other dishes', async () => {
    const h = harness(async () => ({ path: '/user/images/menu/soup.png', seed: 42, dataUrl: 'data:image/png;base64,HUGE' }));
    assert.equal(h.calls.length, 0);
    const before = h.read(); const result = await h.controller.run(0);
    assert.equal(result.status, 'updated'); assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 1);
    const [request, options] = h.calls[0];
    assert.equal(request.prompt, `food, still life, a single finished dish, ${before.items[0].imagePrompt}, plated food, no people, no text, no menu lettering`);
    assert.equal(request.prompt.split(before.items[0].imagePrompt).length - 1, 1);
    assert.equal(Object.hasOwn(request, 'nl'), false);
    assert.equal(request.save, true); assert.equal(request.character, '当前角色卡');
    assert.equal(request.characters, undefined); assert.ok(options.signal);
    assert.deepEqual(h.read().items[0].image, { path: '/user/images/menu/soup.png', seed: 42 });
    assert.deepEqual(h.read().items[1], before.items[1]); assert.doesNotMatch(JSON.stringify(h.read()), /data:image|HUGE/);
    const exported = buildPortableChatPackage({ selectedModules: ['points'], roots: { 'sp-store': { version: 1, data: { 'daily-menu-user': h.read() } } } });
    const parsed = parsePortableChatPackage(JSON.stringify(exported.package));
    const imported = createPortableImportPlan({ roots: {}, portablePackage: parsed.package, selectedModules: ['points'], targetChatId: 'fixture' });
    assert.deepEqual(imported.replacementRoots['sp-store'].data['daily-menu-user'], h.read());
    for (let redraw = 0; redraw < 2; redraw++) assert.equal((await h.controller.run(0)).status, 'updated');
    assert.equal(h.calls.length, 3); assert.equal(h.writes.length, 3);
    assert.deepEqual(h.calls.map(([next]) => next), [request, request, request]);
    assert.equal(h.read().items[0].imagePrompt, before.items[0].imagePrompt);
    assert.equal(h.read().items[0].description, before.items[0].description);
});

test('old menu generates directly from its existing dish without an extra text call', async () => {
    const h = harness(async () => ({ path: '/user/images/menu/old.png' }));
    delete h.read().items[0].imagePrompt;
    await h.controller.run(0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0].prompt, `food, still life, a single finished dish, ${h.read().items[0].name}。${h.read().items[0].description}, plated food, no people, no text, no menu lettering`);
    assert.equal(Object.hasOwn(h.calls[0][0], 'nl'), false);
    assert.equal(h.read().items[0].imagePrompt, undefined);
});

test('gallery save failure and generation failure keep the previous image', async () => {
    const h = harness(async () => ({ path: null, dataUrl: 'data:image/png;base64,HUGE' }));
    h.read().items[0].image = { path: '/user/images/menu/kept.png', seed: 1 };
    assert.equal((await h.controller.run(0)).status, 'failed'); assert.equal(h.writes.length, 0);
    assert.equal(h.read().items[0].image.path, '/user/images/menu/kept.png');
    assert.match(h.controller.state(h.read(), 0).message, /未保存到柏宝绘图库/);
    const failing = harness(async () => { throw Object.assign(new Error('sensitive backend detail'), { code: 'backend_error' }); });
    failing.read().items[0].image = { path: '/user/images/menu/kept.png' };
    await failing.controller.run(0); assert.equal(failing.writes.length, 0);
    assert.equal(failing.read().items[0].image.path, '/user/images/menu/kept.png');
    assert.doesNotMatch(failing.controller.state(failing.read(), 0).message, /sensitive/);
});

test('parallel dish completion merges the current menu, and a real replacement menu is not overwritten', async () => {
    const pending = [];
    const h = harness(() => new Promise(resolve => pending.push(resolve)));
    const first = h.controller.run(0), second = h.controller.run(1);
    pending[1]({ path: '/user/images/menu/fish.png' }); await second;
    pending[0]({ path: '/user/images/menu/soup.png' }); await first;
    assert.equal(h.read().items[0].image.path, '/user/images/menu/soup.png');
    assert.equal(h.read().items[1].image.path, '/user/images/menu/fish.png');
    const third = h.controller.run(0), replacement = { ...menu(), generatedAt: 456, title: '新菜单' };
    h.replace(replacement); pending[2]({ path: '/user/images/menu/obsolete.png' });
    assert.equal((await third).status, 'changed'); assert.equal(h.read(), replacement); assert.equal(h.writes.length, 2);
    assert.notEqual(dailyMenuContentKey(replacement), dailyMenuContentKey(menu()));
});

test('missing provider/configuration gives an actionable local error without a request', async () => {
    let calls = 0; const value = menu();
    const controller = createDailyMenuImageController({ owners: createTaskOwnerManager(), api: () => null, capture: () => ({ read: () => value }), render() {}, toast() {} });
    await controller.run(0); assert.match(controller.state(value, 0).message, /柏宝绘/); assert.equal(calls, 0);
});

test('visible dish drawers retain their actual storage index after an incomplete legacy item', () => {
    const html = renderDailyMenuHtml({ items: [{ name: '残缺旧行' }, dish()] });
    assert.match(html, /data-menu-image-index="1"/);
    assert.doesNotMatch(html, /data-menu-image-index="0"/);
});

test('a thrown reference save error reports the saved gallery image rather than generation failure', async () => {
    const h = harness(async () => ({ path: '/user/images/menu/new.png' }), new Error('disk failure'));
    h.read().items[0].image = { path: '/user/images/menu/old.png' };
    assert.equal((await h.controller.run(0)).reason, 'save');
    assert.match(h.controller.state(h.read(), 0).message, /图片已保存在柏宝绘图库.*未能关联到菜单/);
    assert.equal(h.read().items[0].image.path, '/user/images/menu/old.png');
});

test('overlapping asynchronous reference saves serialize only merge/write, without delaying image requests', async () => {
    let value = menu(); const writes = [], releases = []; let requests = 0;
    const controller = createDailyMenuImageController({
        owners: createTaskOwnerManager(), api: () => ({ apiVersion: 1, getBackendStatus: () => ({ configured: true }), generate: async () => ({ path: `/user/images/menu/${++requests}.png` }) }),
        capture: () => ({ read: () => value, write: next => { writes.push(next); return new Promise(resolve => releases.push(() => { value = next; resolve({ ok: true, commitState: 'confirmed' }); })); } }), render() {}, toast() {},
    });
    const first = controller.run(0), second = controller.run(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests, 2); assert.equal(writes.length, 1);
    releases[0](); await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes.length, 2); releases[1](); await second;
    assert.equal(value.items[0].image.path, '/user/images/menu/1.png');
    assert.equal(value.items[1].image.path, '/user/images/menu/2.png');
});

test('manual cancellation settles its message even when a gallery upload returns after the signal', async () => {
    let complete; const h = harness(() => new Promise(resolve => { complete = resolve; }));
    const pending = h.controller.run(0);
    assert.equal(h.controller.cancel(h.read(), 0), true);
    complete({ path: '/user/images/menu/late.png' });
    assert.equal((await pending).status, 'cancelled');
    assert.equal(h.writes.length, 0);
    assert.equal(h.controller.state(h.read(), 0).busy, false);
    assert.equal(h.controller.state(h.read(), 0).message, '已取消本次操作');
});

test('a previously opened drawer settles controls while folded without initializing or loading hidden content', async () => {
    const { refreshDailyMenuImageDrawer } = await import('../../ui/point/daily-menu-images.js');
    const svg = { innerHTML: '', dataset: {} };
    const action = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelector: () => svg };
    const status = {};
    const body = { querySelector(selector) {
        if (selector === '.sp-daily-menu-image-status') return status;
        if (selector === '.sp-daily-menu-image-empty') return {};
        throw new Error('folded drawer must not read or load the image preview');
    } };
    const drawer = { dataset: { menuImageIndex: '0' }, querySelector(selector) {
        if (selector === '.sp-daily-menu-image-body') return body;
        if (selector === '.sp-daily-menu-image-action') return action;
        if (selector === '.sp-daily-menu-image-toggle') return { getAttribute: () => 'false' };
        throw new Error('unexpected drawer access');
    } };
    refreshDailyMenuImageDrawer(drawer, menu(), { state: () => ({ busy: false, message: '图片已保存在柏宝绘图库，但未能关联到菜单' }) }, String);
    assert.match(action.className, /sp-daily-menu-image-generate/);
    assert.doesNotMatch(action.className, /sp-daily-menu-image-cancel/);
    assert.match(status.textContent, /未能关联到菜单/);
    const untouched = { querySelector: () => null, set innerHTML(_value) { throw new Error('closed unprepared drawer must stay uninitialized'); } };
    refreshDailyMenuImageDrawer({ ...drawer, querySelector: selector => selector === '.sp-daily-menu-image-body' ? untouched : drawer.querySelector(selector) }, menu(), { state: () => ({}) }, String);
});

test('dish image actions share the title row and the image region starts hidden after its description', () => {
    const html = renderDailyMenuHtml(menu());
    assert.equal((html.match(/sp-daily-menu-image-tools/g) || []).length, 2);
    const firstDish = html.match(/<article\b[\s\S]*?<\/article>/)?.[0];
    assert.match(firstDish, /sp-daily-menu-item-head[\s\S]*南瓜汤[\s\S]*sp-daily-menu-image-toggle[\s\S]*sp-daily-menu-image-generate[\s\S]*<\/header><p[\s\S]*sp-daily-menu-image-body[^>]*aria-hidden="true"/);
    assert.match(html, /aria-label="生成南瓜汤的配图"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /<summary|>生成图片<|>重新生成</);
});

test('menu title pills show saved image state separately from the explicit generation action', () => {
    const value = menu(); value.items[0].image = { path: '/user/images/menu/saved.png' };
    const html = renderDailyMenuHtml(value);
    assert.match(html, /sp-daily-menu-image-toggle[^>]*>已生成<\/button>/);
    assert.match(html, /sp-daily-menu-image-toggle[^>]*>未生成<\/button>/);
    assert.equal((html.match(/>生图<\/button>/g) || []).length, 2);
    assert.doesNotMatch(html, /data-sp-icon="(?:chef-hat|chevron-down|chevron-up)"/);
    assert.match(html, /role="region"[^>]*aria-hidden="true" inert/);
});
