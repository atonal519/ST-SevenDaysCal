import test from 'node:test';
import assert from 'node:assert/strict';
import { createAxisPromptBuilder } from './prompts.js';

function prompts(gregorian) {
    const cal = { months: Array.from({ length: gregorian ? 12 : 6 }, (_, i) => ({ name: `配置月${i + 1}`, days: 30 })) };
    return createAxisPromptBuilder({
        loadCalDesc: () => cal, calMonthCount: value => value.months.length,
        calYearLen: value => value.months.reduce((sum, month) => sum + month.days, 0),
        isGregorianCalendar: () => gregorian,
        getCalDescInjectText: () => '六个配置月，每月三十天',
    });
}

test('整年节庆数量要求同时适用于公历与自定义历法，生日和纪念日不充当节日配额', () => {
    for (const gregorian of [true, false]) {
        const prompt = prompts(gregorian).buildAlmanacPrompt('用户', '角色');
        assert.match(prompt, /节日[^\n]*至少\s*12\s*个/);
        assert.match(prompt, /通常\s*12[–—~-]24\s*个/);
        assert.match(prompt, /生日[^\n]*纪念日[^\n]*不计入/);
        assert.match(prompt, /逐月/);
        assert.match(prompt, /(?:超过|多于)\s*24[^\n]*(?:保留|完整)/);
        assert.match(prompt, /生日只在有依据且能明确推断时填写/);
        assert.match(prompt, /已发生重大事件/);
    }
});

test('架空节庆可以合理创作，配置的日期范围与人物既有经历仍明确', () => {
    for (const gregorian of [true, false]) {
        const prompt = prompts(gregorian).buildAlmanacPrompt('用户', '角色');
        assert.match(prompt, /架空[^\n]*合理创作[^\n]*节日/);
        assert.match(prompt, /角色[^\n]*参与[^\n]*已发生剧情/);
        assert.doesNotMatch(prompt, /没有设定依据时留空/);
    }
    const custom = prompts(false).buildAlmanacPrompt('用户', '角色');
    assert.match(custom, /完整一整年（6 个月、180 天）/);
    assert.match(custom, /month 为 1–6/);
    assert.match(custom, /严格使用配置的月份和日数/);
    const modern = prompts(true).buildAlmanacPrompt('用户', '角色');
    assert.match(modern, /完整覆盖当地全年基础法定及公共假日/);
});

test('纪念日补录继续只补已发生的事项，不继承整历节日下限', () => {
    const supplement = prompts(false).buildAnniversarySupplementPrompt('用户', '角色', '已有纪念日');
    assert.match(supplement, /只补已经发生/);
    assert.match(supplement, /通常 0–2 条、最多 3 条/);
    assert.doesNotMatch(supplement, /至少\s*12|通常\s*12[–—~-]24|合理创作/);
});
