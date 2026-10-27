import test from 'node:test';
import assert from 'node:assert/strict';
import { bindStoryClock, parseStoryClock, completeStoryClock } from './story-clock.js';
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
    for (const date of ['零年11月30日', '十千年11月30日', '10000年11月30日', '天历0年11月30日', '天历十千年11月30日', '天历七百四十三年13月1日', '天历七百四十三年11月31日', '七百四十三年2月29日']) {
        assert.equal(parseStoryClock(marker(date)).startMeta.date, null, date);
    }
    assert.equal(parseStoryClock(marker('天历七百四十三年雾月1日'), named).startMeta.date, null);
    const start = marker('天历七百四十三年11月30日');
    const end = marker('天历七百四十三年11月30日', 'end');
    assert.equal(completeStoryClock(parseStoryClock(start + '正文' + end)), true);
    assert.equal(completeStoryClock(parseStoryClock(start + marker('天历七百四十三年11月30日', 'end', '25:00'))), false);
    assert.equal(completeStoryClock(parseStoryClock(start + start + end)), false);
});
