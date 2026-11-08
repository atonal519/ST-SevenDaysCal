import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { addCalendarDays, calendarDate, dateFromOrdinal, daysInMonth, formatCalendarDate, ordinalOf, parseCalendarDate, validateCalendarDate, weekdayFor } from './date.js';
import { calendarDayOrdinal, daysBetweenCalendarDates } from '../axis/full-ordinal.js';

test('calendar date construction distinguishes explicit zero from unknown and invalid years', () => {
    for (const year of [0, '0', '0000', ' 0 ']) {
        const date = calendarDate(year, 1, 1);
        assert.equal(date.year, 0);
        assert.equal(validateCalendarDate(date), true);
    }
    for (const year of [null, undefined, '', ' ', '\t\n', false, true]) {
        const date = calendarDate(year, 1, 1);
        assert.equal(date.year, null, String(year));
        assert.equal(validateCalendarDate(date), false, String(year));
    }
    for (const year of ['unknown', NaN, {}, []]) {
        const date = calendarDate(year, 1, 1);
        assert.equal(Number.isNaN(date.year), true, String(year));
        assert.equal(validateCalendarDate(date), false, String(year));
    }
});

test('Gregorian year zero keeps leap days, weekdays and ordinal round trips', () => {
    const leap = { year: 0, month: 2, day: 29 };
    assert.equal(validateCalendarDate(leap), true);
    assert.equal(daysInMonth(null, 2, 0), 29);
    assert.equal(weekdayFor({ year: 0, month: 1, day: 1 }), 6);
    assert.equal(ordinalOf(leap), 60);
    assert.deepEqual(dateFromOrdinal(60, null, 0), leap);
    assert.deepEqual(parseCalendarDate(formatCalendarDate(leap)), leap);
    assert.equal(calendarDayOrdinal({ year: 0, month: 1, day: 1 }, { kind: 'gregorian' }), -719528);
    assert.equal(daysBetweenCalendarDates({ year: 0, month: 12, day: 31 }, { year: 1, month: 1, day: 1 }, { kind: 'gregorian' }), 1);
    assert.equal(validateCalendarDate({ year: 0, month: 2, day: 30 }), false);
    assert.equal(validateCalendarDate({ year: 1, month: 2, day: 29 }), false);
    assert.equal(validateCalendarDate({ year: -1, month: 1, day: 1 }), false);
});

test('calendar arithmetic crosses zero to one and stops at the nonnegative year boundary', () => {
    assert.deepEqual(addCalendarDays({ year: 0, month: 12, day: 31 }, 1), { year: 1, month: 1, day: 1 });
    assert.deepEqual(addCalendarDays({ year: 1, month: 1, day: 1 }, -1), { year: 0, month: 12, day: 31 });
    assert.deepEqual(addCalendarDays({ year: 0, month: 2, day: 28 }, 1), { year: 0, month: 2, day: 29 });
    assert.equal(addCalendarDays({ year: 0, month: 1, day: 1 }, -1), null);
    const custom = { kind: 'custom', months: [{ name: '始月', days: 30 }, { name: '末月', days: 20 }], epochYear: 0, epochWeekday: 2 };
    const last = { year: 0, month: 2, day: 20 };
    assert.deepEqual(addCalendarDays(last, 1, custom), { year: 1, month: 1, day: 1 });
    assert.equal(addCalendarDays({ year: 0, month: 1, day: 1 }, -1, custom), null);
    assert.equal(weekdayFor({ year: 0, month: 1, day: 1 }, custom), 2);
    assert.deepEqual(dateFromOrdinal(ordinalOf(last, custom), custom, 0), last);
});

test('axis day keys retain zero in numeric and Chinese keys through the real data module', async () => {
    const dataUrl = new URL('../axis/data.js', import.meta.url).href;
    const stubs = {
        '../../store.js': 'export const keyDesc = () => ""; export const readStore = () => null; export const writeStore = () => true; export const writeStoreConfirmed = async () => ({ ok: true });',
        '../../runtime/settings.js': 'export const getSettings = () => ({});',
        '../../../../../../script.js': 'export const saveSettingsDebounced = () => {};',
        '../../../../../extensions.js': 'export const getContext = () => ({});',
    };
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
        if (context.parentURL === dataUrl && Object.hasOwn(stubs, specifier)) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
        return nextResolve(specifier, context);
    } });
    try {
        const { monthDayFromDayKey } = await import(dataUrl);
        for (const key of ['0000-02-29', '0-2-29', 'cn-0-2-29']) assert.deepEqual(monthDayFromDayKey(key), { month: 2, day: 29, year: 0 }, key);
        assert.deepEqual(monthDayFromDayKey('2026-4-8'), { month: 4, day: 8, year: 2026 });
        assert.equal(monthDayFromDayKey('cn-0-2-30'), null);
    } finally { hooks.deregister(); }
});
