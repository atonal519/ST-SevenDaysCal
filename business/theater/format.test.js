import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTheaterHtmlResponse, safePlainTextHtml } from './html.js';
import { createTheaterGeneration } from './generation.js';
import { createTheaterTemplates, parseTemplateText } from './templates.js';

test('theater HTML reader accepts a clear fragment or one HTML fence and rejects ambiguous prose', () => {
    assert.equal(extractTheaterHtmlResponse('<article><p>正文</p><hr><p>后文</p></article>'), '<article><p>正文</p><hr><p>后文</p></article>');
    assert.equal(extractTheaterHtmlResponse('<p title="1 > 0">正文</p>'), '<p title="1 > 0">正文</p>');
    assert.equal(extractTheaterHtmlResponse('排版结果：\n```html\n<div><p>正文</p></div>\n```\n以上是结果。'), '<div><p>正文</p></div>');
    assert.equal(extractTheaterHtmlResponse('这是一段解释，不是 HTML。'), null);
    assert.equal(extractTheaterHtmlResponse('```html\n<div>一</div>\n```\n```html\n<div>二</div>\n```'), null);
    assert.equal(extractTheaterHtmlResponse('```text\n<div>正文</div>\n```'), null);
    assert.equal(extractTheaterHtmlResponse('<div><p>不完整</div>'), null);
});

test('theater generation preserves raw and uses full escaped source when formatting is not clear HTML', async () => {
    let sanitizeCalls = 0;
    const generate = createTheaterGeneration({
        write: async () => '第一行\n<危险内容> & 保留', beautify: async () => '排版说明：没给出 HTML',
        buildWriteMessages: () => [], buildBeautifyMessages: () => [], sanitize: value => { sanitizeCalls++; return value; },
        plainTextFallback: safePlainTextHtml, makeId: () => 'format-fallback',
    });
    const piece = await generate('需求');
    assert.equal(piece.raw, '第一行\n<危险内容> & 保留');
    assert.equal(piece.html, '<div class="sp-theater-prose"><p>第一行<br>&lt;危险内容&gt; &amp; 保留</p></div>');
    assert.equal(sanitizeCalls, 0);
});

test('template import accepts explicit English/Chinese fields and counts only created entries', async () => {
    assert.deepEqual(parseTemplateText('title: English\n\ncontent: first\nsecond\n\ntitle：中文\n\n内容：正文\n续行'), [
        { title: 'English', text: 'first\nsecond' }, { title: '中文', text: '正文\n续行' },
    ]);
    const data = { entries: {} }; let uid = 0; let saves = 0;
    const templates = createTheaterTemplates({ context: () => ({
        async loadWorldInfo() { return data; },
        async saveWorldInfo() { saves++; },
        worldInfoEntry: { create(_name, book) { if (uid++ === 1) return undefined; const entry = { uid: uid - 1 }; book.entries[entry.uid] = entry; return entry; } },
    }) });
    assert.equal(await templates.addBatch([{ title: '一', text: '甲' }, { title: '跳过', text: '乙' }, { title: '三', text: '丙' }]), 2);
    assert.equal(saves, 1);
    assert.deepEqual(Object.values(data.entries).map(entry => [entry.comment, entry.content]), [['一', '甲'], ['三', '丙']]);
});
