import test from 'node:test';
import assert from 'node:assert/strict';
import { bindStoryClock, parseStoryClock, parseJudgedDate, completeStoryClock, storyClockNarrativeBody } from './story-clock.js';
import { _cnToNumber } from '../../utils/cn-date.js';

const gregorian = { kind: 'gregorian', months: [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].map(days => ({ days })) };
const named = { kind: 'custom', months: [{ name: '始月', days: 30 }, { name: '霜月', days: 30 }] };
bindStoryClock({
    loadCalendar: () => gregorian, defaultCalendar: gregorian, cnToNumber: _cnToNumber,
    validMonthDay: ({ month, day }, calendar) => Number.isInteger(month) && Number.isInteger(day) && day >= 1 && day <= (calendar.months[month - 1]?.days || 0) ? { month, day } : null,
    validRealDate: (year, month, day) => {
        const date = new Date(0); date.setUTCFullYear(year, month - 1, day);
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    },
});
const marker = (date, edge = 'start', time = '06:00') => `<!-- SDC-${edge} | date=${date} | weekday=周一 | time=${time} -->`;

test('structured dates use one era and numeral grammar independent of label length', () => {
    for (const eraLabel of ['历', '太初历', '北域联盟共同纪元', '第三远征纪元', '第２远征纪元']) {
        for (const date of [`${eraLabel}三千四百一十二年四月初八`, `${eraLabel}３４１２年４月０８日`, `${eraLabel}叁仟肆佰壹拾贰年肆月初捌`, `${eraLabel}三四一二年四月八日`, `${eraLabel}3412年四月8日`, `${eraLabel}三千四百一十二年4月初八`]) {
            const clock = parseStoryClock(marker(date) + '正文' + marker(date, 'end'));
            assert.deepEqual(clock.startMeta.date, { month: 4, day: 8, year: 3412, eraLabel }, date);
            assert.equal(clock.startMeta.dateText, date);
            assert.equal(clock.startMeta.structured, true);
            assert.equal(completeStoryClock(clock), true);
        }
    }
    for (const date of ['太初历二〇二六年4月初八', '太初历二零二六年四月8日', '太初历贰零贰陆年肆月捌日', '太初历2〇二６年四月初八']) assert.deepEqual(parseStoryClock(marker(date)).startMeta.date, { month: 4, day: 8, year: 2026, eraLabel: '太初历' }, date);
});

test('formal month names win over numeric aliases and calendar year semantics remain distinct', () => {
    const calendar = { kind: 'custom', months: [{ name: '四月', days: 20 }, { name: '月影之月', days: 35 }] };
    assert.deepEqual(parseStoryClock(marker('太初历三千四百一十二年四月初八'), calendar).startMeta.date, { month: 1, day: 8, year: 3412, eraLabel: '太初历' });
    assert.deepEqual(parseStoryClock(marker('太初历3412年月影之月三十五日'), calendar).startMeta.date, { month: 2, day: 35, year: 3412, eraLabel: '太初历' });
    assert.equal(parseStoryClock(marker('太初历3412年雾月初八'), calendar).startMeta.date, null);
    assert.equal(parseStoryClock(marker('公历标记2025年2月29日'), { ...gregorian, title: '公历标记' }).startMeta.date, null);
    assert.deepEqual(parseStoryClock(marker('纪元标记2025年2月29日'), { ...gregorian, era: '纪元标记' }).startMeta.date, { month: 2, day: 29, year: 2025, eraLabel: '纪元标记' });
    assert.deepEqual(parseStoryClock(marker('743-11-30')).startMeta.date, { month: 11, day: 30, year: 743 });
    assert.equal(parseStoryClock(marker('10000-11-30')).startMeta.date, null);
    for (const date of ['太初历10000年4月8日', '太初历十千年4月8日', '太初历三千四百一十二年13月8日', '太初历三千四百一十二年4月31日']) assert.equal(parseStoryClock(marker(date)).startMeta.date, null, date);
});

test('year zero uses the shared numeral grammar and preserves calendar and legacy era boundaries', () => {
    for (const year of ['0', '零', '〇', '０', '0000']) {
        const date = `天历${year}年2月29日`;
        const clock = parseStoryClock(marker(date) + '正文' + marker(date, 'end'));
        assert.deepEqual(clock.startMeta.date, { month: 2, day: 29, year: 0, eraLabel: '天历' }, date);
        assert.equal(completeStoryClock(clock), true, date);
    }
    for (const date of ['0000-02-29', '0-2-29', '零年2月29日']) {
        assert.deepEqual(parseStoryClock(marker(date)).startMeta.date, { month: 2, day: 29, year: 0 }, date);
    }
    const titled = { ...gregorian, title: '王国历' };
    assert.deepEqual(parseStoryClock(marker('王国历零年2月29日'), titled).startMeta.date, { month: 2, day: 29, year: 0, eraLabel: '王国历' });
    assert.deepEqual(parseStoryClock(marker('长纪元零年霜月30日'), named).startMeta.date, { month: 2, day: 30, year: 0, eraLabel: '长纪元' });
    for (const date of ['0000-02-29T09:00:00', '零年2月29日', '天历〇年2月29日', '【太初历】0年2月29日']) {
        const expected = { month: 2, day: 29, year: 0, ...(date.includes('天历') ? { eraLabel: '天历' } : date.includes('太初历') ? { eraLabel: '太初历' } : {}) };
        assert.deepEqual(parseStoryClock(`<!-- SDC-start ${date} 周六 09:00 -->`).startMeta.date, expected, date);
        assert.deepEqual(parseJudgedDate(date), expected, date);
    }
    assert.deepEqual(parseJudgedDate('王国历零年2月29日', titled), { month: 2, day: 29, year: 0, eraLabel: '王国历' });
    assert.equal(parseJudgedDate('太初历0年2月29日'), null, '旧长纪年仍要求登记或括号');
    for (const date of ['0000-02-30', '-0001-01-01', '10000-01-01']) assert.equal(parseStoryClock(marker(date)).startMeta.date, null, date);
});

test('legacy compact clocks share validated dates without broadening free text era recognition', () => {
    for (const date of ['2026-04-08', '2026-04-08T09:00:00', '4月8日', '4/8']) {
        const clock = parseStoryClock(`<!-- SDC-start ${date} 周六 09:00 -->`);
        assert.equal(clock.startMeta.month, 4, date);
        assert.equal(clock.startMeta.day, 8, date);
        assert.equal(clock.startMeta.weekdayText, '周六', date);
        assert.equal(clock.startMeta.time, date.includes('T') ? '9:00:00' : '9:00', date);
    }
    assert.deepEqual(parseJudgedDate('天历三千四百一十二年四月初八'), { month: 4, day: 8, year: 3412, eraLabel: '天历' });
    assert.deepEqual(parseJudgedDate('【太初历】三千四百一十二年四月初八'), { month: 4, day: 8, year: 3412, eraLabel: '太初历' });
    assert.equal(parseJudgedDate('太初历三千四百一十二年四月初八'), null, '旧自由文本仍需已登记或明确括号的长纪年');
    for (const date of ['太初历3412年 四月初八', '太初历10000年 四月初八', '10000年 四月初八', '天历10000年 四月初八']) {
        assert.equal(parseStoryClock(`<!-- SDC-start ${date} 周六 09:00 -->`).startMeta.date, null, date);
        assert.equal(parseJudgedDate(date), null, date);
    }
    assert.equal(parseJudgedDate('截至三年四月初八'), null);
    assert.equal(parseJudgedDate('2025年2月29日'), null);
    for (const date of ['2月30日', '2026-04-08坏尾巴', '他走到4月8日街口']) assert.equal(parseStoryClock(`<!-- SDC-start ${date} 周六 09:00 -->`).startMeta.date, null, date);
    assert.equal(parseStoryClock(marker('太初历三千四百一十二年雾月初八'), named).startMeta.date, null);
});

test('invalid structured dates retain display fields without becoming date anchors', () => {
    const clock = parseStoryClock(marker('太初历三千四百一十二年四月三十一日'));
    assert.equal(clock.startMeta.date, null);
    assert.equal(clock.startMeta.dateText, '太初历三千四百一十二年四月三十一日');
    assert.equal(clock.startMeta.weekdayText, '周一');
    assert.equal(clock.startMeta.time, '6:00');
    assert.equal(clock.startMeta.valid, false);
    assert.equal(clock.startMeta.complete, false);
    assert.equal(parseStoryClock(marker('太初历三千四百一十二年四月初八', 'start', '24:99')).startMeta.time, null);
    assert.equal(parseStoryClock(marker('太初历三千四百一十二年四月初八'), { resolved: false }).startMeta.date, null);
});

test('the reported Chinese era timestamp retains its date, weekday and time', () => {
    const clock = parseStoryClock('<!-- SDC-start | date=天历七百四十三年11月30日 | weekday=周一 | time=06:00 -->');
    assert.deepEqual(clock.startMeta.date, { month: 11, day: 30, year: 743, eraLabel: '天历' });
    assert.equal(clock.startMeta.weekdayIndex, 1);
    assert.equal(clock.startMeta.time, '6:00');
    assert.equal(clock.startMeta.complete, true);
    assert.equal(completeStoryClock(clock), false, 'a valid start alone does not become a complete pair');
});

test('hundreds and thousands keep connecting-zero tails in ordinary and financial numerals', () => {
    for (const [text, year] of [['七百零三', 703], ['一千零一', 1001], ['七千零四十三', 7043], ['七佰零三', 703], ['壹仟零壹', 1001], ['一千零三百零二', 1302], ['七百〇三', 703]]) {
        assert.equal(_cnToNumber(text), year, text);
        assert.deepEqual(parseStoryClock(marker(`天历${text}年11月30日`)).startMeta.date, { month: 11, day: 30, year, eraLabel: '天历' }, text);
    }
    for (const [text, value] of [['廿三', 23], ['卅一', 31], ['四十三', 43], ['743', 743], ['７４３', 743]]) assert.equal(_cnToNumber(text), value, text);
});

test('shared numeral recognition reaches configured labels, unconfigured eras and year-only dates', () => {
    for (const [date, calendar, year, eraLabel] of [
        ['王国历一千七百四十三年11月30日', { ...gregorian, title: '王国历' }, 1743, '王国历'],
        ['天历七百四十三年11月30日', { ...gregorian, era: '天历' }, 743, '天历'],
        ['宁和壹仟柒佰肆拾叁年11月30日', gregorian, 1743, '宁和'],
        ['一千七百四十三年11月30日', gregorian, 1743, null],
        ['七佰四十三年11月30日', gregorian, 743, null],
        ['天历743年11月30日', gregorian, 743, '天历'],
        ['743年11月30日', gregorian, 743, null],
    ]) {
        assert.deepEqual(parseStoryClock(marker(date), calendar).startMeta.date, { month: 11, day: 30, year, ...(eraLabel ? { eraLabel } : {}) }, date);
    }
});

test('Chinese years also work with allowlisted formal month names', () => {
    for (const [date, calendar, year] of [
        ['王国历一千零一年霜月30日', { ...named, title: '王国历' }, 1001],
        ['天历七百四十三年霜月30日', named, 743],
        ['天历七佰四十三年霜月30日', named, 743],
        ['天历743年霜月30日', named, 743],
    ]) assert.deepEqual(parseStoryClock(marker(date), calendar).startMeta.date, { month: 2, day: 30, year, eraLabel: calendar.title || '天历' }, date);
});

test('recognized Chinese years preserve date bounds and the complete-clock contract', () => {
    for (const date of ['十千年11月30日', '10000年11月30日', '天历十千年11月30日', '天历七百四十三年13月1日', '天历七百四十三年11月31日', '七百四十三年2月29日']) {
        assert.equal(parseStoryClock(marker(date)).startMeta.date, null, date);
    }
    assert.equal(parseStoryClock(marker('天历七百四十三年雾月1日'), named).startMeta.date, null);
    const start = marker('天历七百四十三年11月30日');
    const end = marker('天历七百四十三年11月30日', 'end');
    assert.equal(completeStoryClock(parseStoryClock(start + '正文' + end)), true);
    assert.equal(completeStoryClock(parseStoryClock(start + marker('天历七百四十三年11月30日', 'end', '25:00'))), false);
    assert.equal(completeStoryClock(parseStoryClock(start + start + end)), false);
});


test('草稿中的纯占位格式例不覆盖正文真实跨午夜时间戳，正文截取用同一真实对', () => {
    const template = '<draft>格式检查：<!-- SDC-start | date=… | weekday=周X | time=… -->示例正文<!-- SDC-end | date=… | weekday=周X | time=… --></draft>';
    const start = '<!-- SDC-start | date=2025-05-15 | weekday=周四 | time=23:56 -->';
    const end = '<!-- SDC-end | date=2025-05-16 | weekday=周五 | time=00:20 -->';
    const raw = '<content>' + template + start + '真正的正文' + end + '</content>';
    const clock = parseStoryClock(raw);
    assert.equal(completeStoryClock(clock), true);
    assert.equal(clock.duplicate, false);
    assert.equal(clock.startMeta.day, 15);
    assert.equal(clock.endMeta.day, 16);
    assert.equal(clock.endMeta.time, '0:20');
    assert.equal(storyClockNarrativeBody(raw), '真正的正文');
    for (const weekday of ['…', '...']) {
        const actualShape = raw.replaceAll('weekday=周X', `weekday=${weekday}`);
        assert.equal(completeStoryClock(parseStoryClock(actualShape)), true);
        assert.equal(storyClockNarrativeBody(actualShape), '真正的正文');
    }
    const asciiTemplate = template.replaceAll('…', '...').replaceAll('周X', '...');
    assert.equal(completeStoryClock(parseStoryClock(asciiTemplate + start + '正文' + end)), true);
    assert.equal(completeStoryClock(parseStoryClock(template.replaceAll('周X', '周四') + start + '正文' + end)), false);
    assert.equal(completeStoryClock(parseStoryClock(template)), false);
    assert.equal(completeStoryClock(parseStoryClock(template + start + start + '正文' + end)), false);
    const malformed = '<!-- SDC-start | date=2025-05-15 | weekday=周四 | time=未知 -->';
    assert.equal(completeStoryClock(parseStoryClock(malformed + start + '正文' + end)), false);
});
