import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeTagRules } from '../utils/tag-names.js';
import { stripTags } from '../memory.js';
import { selectVisibleChatHistory } from '../business/lines/history.js';
import { sanitizeGenerationContextText } from '../runtime/generation-context.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');

function productionRegion(startMarker, endMarker) {
    const start = indexSource.indexOf(startMarker);
    const end = indexSource.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `production source region found: ${startMarker}`);
    return indexSource.slice(start, end);
}

test('paired named wrappers normalize into canonical rules', () => {
    assert.deepEqual(normalizeTagRules(' [DRAFT]...[/DRAFT], [状态]...[/状态], think, [[...]]'), [
        '[draft]...[/draft]', '[状态]...[/状态]', 'think', '[[...]]',
    ]);
    assert.deepEqual(normalizeTagRules('[draft]..[/draft], [draft]... [ /draft], [a.b]...[/a.b]'), []);
});

test('configured paired wrappers remove complete multiline blocks including kept content', () => {
    const raw = '前[DRAFT]草稿一\n<content>重复正文</content>\n[/dRaFt]中[状态]私有\n内容[/状态]后';
    assert.equal(stripTags(raw, { extraTags: '[draft]...[/draft],[状态]...[/状态]' }), '前中后');
});

test('configured paired wrappers handle adjacent and nested blocks with keep-list priority', () => {
    const raw = '前[DRAFT]外层[DRAFT]内层[/draft]尾声[/DRAFT][状态]隐私[/状态]后';
    assert.equal(stripTags(raw, { extraTags: '[draft]...[/draft],[状态]...[/状态]' }), '前后');
    assert.equal(stripTags(raw, {
        keepTags: '[DRAFT]...[/DRAFT]',
        extraTags: '[draft]...[/draft],[状态]...[/状态]',
    }), '前外层内层尾声后');
});

test('paired wrapper rules are opt in and leave unclosed wrappers intact', () => {
    const raw = '前[DRAFT]<content>正文</content>[/DRAFT]后';
    assert.equal(stripTags(raw), '前[DRAFT]正文[/DRAFT]后');
    assert.equal(stripTags('前[DRAFT]未闭合\n后文', { extraTags: '[draft]...[/draft]' }), '前[DRAFT]未闭合\n后文');
});

test('XML closing tags do not close a same-named bracket wrapper', () => {
    assert.equal(stripTags('[draft]甲</draft>乙[/draft]', { extraTags: '[draft]...[/draft]' }), '');
});

test('unclosed bracket wrappers inside stripped XML follow rescue-only rendering', () => {
    assert.equal(stripTags('<thinking>普通噪音[draft]更多噪音</thinking>', {
        extraTags: 'thinking,[draft]...[/draft]',
    }), '');
    assert.equal(stripTags('<thinking>[draft]普通噪音<content>保留正文</content></thinking>', {
        extraTags: 'thinking,[draft]...[/draft]',
    }), '保留正文');
});

test('paired wrapper rule keeps legacy XML rescue and double bracket contracts', () => {
    assert.equal(stripTags('<thinking><content>旧正文</content></thinking>', { extraTags: 'thinking' }), '旧正文');
    assert.equal(stripTags('前[[旧正文]]后', { keepTags: '[[...]]' }), '前旧正文后');
    assert.equal(stripTags('前[[隐藏]]后', { extraTags: '[[...]]' }), '前后');
    assert.equal(stripTags('前[[噪音<content>救回</content>]]后', {
        keepTags: 'content', extraTags: '[[...]]',
    }), '前救回后');
});

test('settings input and change persist normalized wrapper syntax and refill the field', () => {
    const region = productionRegion('function sanitizeTagList(raw) {', "$in('#sp-custom-prompt')");
    const handlers = {};
    const settings = { extraTags: '' };
    let saves = 0;
    const input = {
        on: (event, handler) => { handlers[`#sp-mem-extratags:${event}`] = handler; return input; },
    };
    const bind = vm.runInNewContext(`${region}\nbindTagField`, {
        $in: () => input,
        getSettings: () => settings,
        normalizeTagRules,
        saveSettingsDebounced: () => { saves++; },
        stSaveSettings() {},
    });
    bind('#sp-mem-extratags', 'extraTags');
    const field = { value: ' [DRAFT]...[/DRAFT], think ' };
    handlers['#sp-mem-extratags:input'].call(field);
    assert.equal(settings.extraTags, '[draft]...[/draft],think');
    handlers['#sp-mem-extratags:change'].call(field);
    assert.equal(field.value, '[draft]...[/draft],think');
    assert.equal(settings.extraTags, field.value);
    assert.equal(saves, 2);

    const readback = productionRegion("$in('#sp-mem-keeptags').val(typeof s.keepTags", "$in('#sp-custom-prompt')");
    const rendered = {};
    vm.runInNewContext(`const s = getSettings();\n${readback}`, {
        getSettings: () => settings,
        $in: selector => ({ val: value => { rendered[selector] = value; } }),
    });
    assert.equal(rendered['#sp-mem-extratags'], '[draft]...[/draft],think');
});

test('production recent generation history excludes configured draft blocks from AI material', () => {
    const region = productionRegion('function buildRecentGenerationHistory(ctx, historyLimit, opts = {}) {', 'function outlineWorldInfoTriggerText(history) {');
    const build = vm.runInNewContext(`${region}\nbuildGenerationHistoryContext`, {
        getSettings: () => ({ keepTags: 'content', extraTags: '[draft]...[/draft]' }),
        selectVisibleChatHistory,
        substituteParams: value => String(value ?? ''),
        sanitizeGenerationContextText,
        memory: { stripTags },
    });
    const history = build({ chat: [{ mes: '开头[DRAFT]草稿<content>重复材料</content>[/DRAFT]结尾' }] }, 6).history;
    assert.deepEqual(JSON.parse(JSON.stringify(history)), [{ role: 'assistant', content: '开头结尾' }]);
});
