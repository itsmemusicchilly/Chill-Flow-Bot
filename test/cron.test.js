// Cron expressions, "at a set time" and time zones: the rules the Schedule trigger runs on.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CronError, cronMatches, formatInZone, isValidTimeZone, localTimeZone, nextRuns, parseCron, scheduleOf, timeToCron, timeZoneNames, zonedParts,
} from '../shared/cron.js';

const sorted = (set) => [...set].sort((a, b) => a - b);
const at = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
/** The runs as `YYYY-MM-DD HH:MM` on the wall clock of `tz`, so the expectations read like a calendar. */
const local = (expr, tz, from, count) => nextRuns(parseCron(expr), tz, from, count).map((t) => zonedParts(t, tz).key);

describe('parseCron', () => {
  it('understands stars, lists, ranges and steps', () => {
    const c = parseCron('*/15 9-17/4 1,15,31 * *');
    assert.deepEqual(sorted(c.minute), [0, 15, 30, 45]);
    assert.deepEqual(sorted(c.hour), [9, 13, 17]);
    assert.deepEqual(sorted(c.dom), [1, 15, 31]);
    assert.equal(c.month.size, 12);
    assert.equal(c.dow.size, 7);
    assert.deepEqual(sorted(parseCron('10-40/5 * * * *').minute), [10, 15, 20, 25, 30, 35, 40]);
    assert.deepEqual(sorted(parseCron('5/15 * * * *').minute), [5, 20, 35, 50], '"5/15" means from 5 onwards, every 15');
    assert.deepEqual(sorted(parseCron('0 0 * * */2').dow), [0, 2, 4, 6]);
  });

  it('understands month and day names in any case, and 7 as Sunday', () => {
    assert.deepEqual(sorted(parseCron('0 0 * jan,MAR mon-fri').month), [1, 3]);
    assert.deepEqual(sorted(parseCron('0 0 * * Mon-Fri').dow), [1, 2, 3, 4, 5]);
    assert.deepEqual(sorted(parseCron('0 0 * * sat,SUN').dow), [0, 6]);
    assert.deepEqual(sorted(parseCron('0 0 * * 7').dow), [0]);
    assert.deepEqual(sorted(parseCron('0 0 * * 5-7').dow), [0, 5, 6]);
  });

  it('knows the shortcuts', () => {
    const expect = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@ANNUALLY': '0 0 1 1 *' };
    for (const [short, long] of Object.entries(expect)) assert.equal(parseCron(short).source, long, short);
  });

  it('tolerates extra spaces and surrounding whitespace', () => {
    assert.deepEqual(sorted(parseCron('  30   9  *   * 1  ').minute), [30]);
  });

  it('explains what is wrong, in words', () => {
    const bad = [
      ['', /Write a cron expression/],
      ['* * * *', /has 5 fields .* has 4\./],
      ['* * * * * *', /has 6\./],
      ['61 * * * *', /minute field has 61, but minutes go from 0 to 59/],
      ['* 24 * * *', /hour field has 24, but hours go from 0 to 23/],
      ['* * 0 * *', /day of month field has 0/],
      ['* * * 13 *', /month field has 13/],
      ['* * * * 8', /day of week field has 8/],
      ['a * * * *', /minute field has “a”, which is not a number\./],
      ['* * * foo *', /month field has “foo”, which is not a number or a name/],
      ['5-1 * * * *', /goes backwards/],
      ['* * * * FRI-MON', /goes backwards/],
      ['1- * * * *', /not a valid range/],
      ['1-2-3 * * * *', /not a valid range/],
      ['*/0 * * * *', /bad step/],
      ['*/x * * * *', /bad step/],
      ['1/2/3 * * * *', /bad step/],
      ['1,,2 * * * *', /empty item/],
      ['@sometimes', /not a known shortcut/],
      ['x'.repeat(300), /at most 200 characters/],
    ];
    for (const [input, message] of bad) {
      assert.throws(() => parseCron(input), (e) => e instanceof CronError && message.test(e.message), `${input.slice(0, 30)} → ${message}`);
    }
  });

  it('a day field that starts with * is not "restricted"', () => {
    assert.deepEqual([parseCron('0 0 * * *').domStar, parseCron('0 0 * * *').dowStar], [true, true]);
    assert.deepEqual([parseCron('0 0 */2 * *').domStar, parseCron('0 0 1 * FRI').dowStar], [true, false]);
    assert.deepEqual([parseCron('0 0 13 * FRI').domStar, parseCron('0 0 13 * FRI').dowStar], [false, false]);
  });
});

describe('cronMatches (day-of-month and day-of-week work like classic cron)', () => {
  const on = (expr, y, mo, d) => cronMatches(parseCron(expr), zonedParts(at(y, mo, d), 'UTC'));
  it('both restricted: either one matches', () => {
    // Friday the 13th of November 2026, and Friday the 6th, and Sunday the 13th of December
    assert.equal(on('0 0 13 * FRI', 2026, 11, 13), true);
    assert.equal(on('0 0 13 * FRI', 2026, 11, 6), true, 'any Friday');
    assert.equal(on('0 0 13 * FRI', 2026, 12, 13), true, 'any 13th');
    assert.equal(on('0 0 13 * FRI', 2026, 11, 7), false);
  });
  it('only one restricted: only that one counts', () => {
    assert.equal(on('0 0 13 * *', 2026, 11, 6), false);
    assert.equal(on('0 0 13 * *', 2026, 12, 13), true);
    assert.equal(on('0 0 * * FRI', 2026, 11, 6), true);
    assert.equal(on('0 0 * * FRI', 2026, 11, 13), true);
    assert.equal(on('0 0 * * FRI', 2026, 11, 14), false);
  });
  it('a starred day field with a step still means "and"', () => {
    assert.equal(on('0 0 */2 * FRI', 2026, 11, 13), true, 'odd day and a Friday');
    assert.equal(on('0 0 */2 * FRI', 2026, 11, 6), false, 'even day');
    assert.equal(on('0 0 */2 * FRI', 2026, 11, 7), false, 'not a Friday');
  });
  it('the month and the time of day must always match', () => {
    assert.equal(on('0 0 1 6 *', 2026, 5, 1), false);
    assert.equal(cronMatches(parseCron('30 9 * * *'), zonedParts(at(2026, 9, 30, 9, 30), 'UTC')), true);
    assert.equal(cronMatches(parseCron('30 9 * * *'), zonedParts(at(2026, 9, 30, 9, 31), 'UTC')), false);
    assert.equal(cronMatches(parseCron('30 9 * * *'), zonedParts(at(2026, 9, 30, 10, 30), 'UTC')), false);
  });
});

describe('timeToCron ("at a set time")', () => {
  it('makes the equivalent cron expression', () => {
    assert.equal(timeToCron({ time: '09:30' }), '30 9 * * *');
    assert.equal(timeToCron({ time: '9:05', days: [] }), '5 9 * * *');
    assert.equal(timeToCron({ time: ' 18:00 ', days: ['fri', 'mon'] }), '0 18 * * MON,FRI', 'canonical order, whatever order was clicked');
    assert.equal(timeToCron({ time: '00:00', days: ['sat', 'sun'] }), '0 0 * * SAT,SUN');
    assert.equal(timeToCron({ time: '12:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }), '0 12 * * *', 'every day chosen = every day');
    assert.equal(parseCron(timeToCron({ time: '23:59', days: ['sun'] })).dow.has(0), true);
  });
  it('refuses times and days that are not real', () => {
    for (const time of ['', '24:00', '9:5', '09-30', 'noon', '12:60', undefined]) {
      assert.throws(() => timeToCron({ time }), (e) => e instanceof CronError && /24-hour clock/.test(e.message), String(time));
    }
    assert.throws(() => timeToCron({ time: '09:00', days: ['funday'] }), /“funday” is not a day of the week/);
  });
});

describe('time zones', () => {
  it('reads the wall clock of any zone, half-hour and quarter-hour zones included', () => {
    const t = at(2026, 9, 30, 22, 12); // Wednesday
    assert.deepEqual(pick(zonedParts(t, 'UTC')), ['2026-09-30 22:12', 3]);
    assert.deepEqual(pick(zonedParts(t, 'America/New_York')), ['2026-09-30 18:12', 3]);
    assert.deepEqual(pick(zonedParts(t, 'Asia/Kolkata')), ['2026-10-01 03:42', 4]);
    assert.deepEqual(pick(zonedParts(t, 'Asia/Kathmandu')), ['2026-10-01 03:57', 4]);
    assert.deepEqual(pick(zonedParts(t, 'Pacific/Kiritimati')), ['2026-10-01 12:12', 4]);
    function pick(p) { return [p.key, p.dow]; }
  });
  it('midnight is hour 0, never 24', () => {
    const p = zonedParts(at(2026, 1, 1, 0, 0), 'UTC');
    assert.deepEqual([p.hour, p.minute, p.day, p.key], [0, 0, 1, '2026-01-01 00:00']);
    assert.equal(zonedParts(at(2026, 1, 1, 15, 0), 'Asia/Tokyo').key, '2026-01-02 00:00');
  });
  it('knows which zone names are real', () => {
    for (const z of ['UTC', 'Asia/Tokyo', 'America/Argentina/Buenos_Aires', 'Europe/London']) assert.equal(isValidTimeZone(z), true, z);
    for (const z of ['Mars/Base', '', undefined, null, 5, {}, 'Not/AZone']) assert.equal(isValidTimeZone(z), false, String(z));
  });
  it('lists zones with UTC first and exactly once', () => {
    const zones = timeZoneNames();
    assert.equal(zones[0], 'UTC');
    assert.equal(zones.filter((z) => z === 'UTC').length, 1);
    assert.ok(zones.includes('Europe/London') && zones.includes('Asia/Kuala_Lumpur') && zones.length > 100);
    assert.ok(zones.every(isValidTimeZone));
  });
  it('offers the current names of zones the platform still lists under old ones, and accepts both', () => {
    const zones = timeZoneNames();
    for (const [current, old] of [['Asia/Kolkata', 'Asia/Calcutta'], ['Asia/Kathmandu', 'Asia/Katmandu'], ['Europe/Kyiv', 'Europe/Kiev'], ['Asia/Ho_Chi_Minh', 'Asia/Saigon'], ['Asia/Yangon', 'Asia/Rangoon']]) {
      assert.ok(zones.includes(current), `${current} is offered`);
      assert.ok(!zones.includes(old), `${old} is not offered twice`);
      assert.equal(isValidTimeZone(current) && isValidTimeZone(old), true, `${current} and ${old} both work`);
    }
    assert.equal(new Set(zones).size, zones.length, 'no repeats');
    assert.deepEqual(zones.slice(1), [...zones.slice(1)].sort(), 'in order after UTC');
    assert.equal(isValidTimeZone('US/Pacific'), true, 'names that are not offered still work when typed into a saved flow');
  });
  it('finds a usable local zone', () => {
    assert.equal(isValidTimeZone(localTimeZone()), true);
  });
  it('formats a moment the way people read it', () => {
    assert.equal(formatInZone(at(2026, 9, 30, 1, 0), 'UTC'), 'Wed 30 Sep 2026, 01:00');
    assert.equal(formatInZone(at(2026, 9, 30, 1, 0), 'Asia/Kuala_Lumpur'), 'Wed 30 Sep 2026, 09:00');
    assert.equal(formatInZone(at(2026, 12, 31, 23, 59), 'UTC'), 'Thu 31 Dec 2026, 23:59');
  });
});

describe('nextRuns', () => {
  const from = at(2026, 9, 30, 1, 0); // Wednesday 30 September 2026, 01:00 UTC

  it('lists the coming runs in order, each strictly after "from"', () => {
    assert.deepEqual(local('0 9 * * 1-5', 'UTC', from, 4), ['2026-09-30 09:00', '2026-10-01 09:00', '2026-10-02 09:00', '2026-10-05 09:00']);
    assert.deepEqual(local('0 1 * * *', 'UTC', from, 2), ['2026-10-01 01:00', '2026-10-02 01:00'], 'a run exactly at "from" is not "next"');
    assert.deepEqual(local('* * * * *', 'UTC', from, 3), ['2026-09-30 01:01', '2026-09-30 01:02', '2026-09-30 01:03']);
    assert.deepEqual(local('*/20 * * * *', 'UTC', from + 30_000, 3), ['2026-09-30 01:20', '2026-09-30 01:40', '2026-09-30 02:00']);
  });
  it('respects the zone, including half-hour zones', () => {
    assert.deepEqual(local('0 9 * * *', 'Asia/Kuala_Lumpur', from, 2), ['2026-10-01 09:00', '2026-10-02 09:00'], 'from is exactly 09:00 there, so the next is tomorrow');
    assert.equal(nextRuns(parseCron('0 9 * * *'), 'Asia/Kolkata', from, 1)[0], at(2026, 9, 30, 3, 30));
    assert.equal(nextRuns(parseCron('0 9 * * *'), 'Asia/Kathmandu', from, 1)[0], at(2026, 9, 30, 3, 15));
    assert.equal(nextRuns(parseCron('0 9 * * *'), 'America/New_York', from, 1)[0], at(2026, 9, 30, 13, 0));
  });
  it('the same expression happens at different real moments in different zones', () => {
    const [a] = nextRuns(parseCron('0 9 * * *'), 'Europe/London', from, 1);
    const [b] = nextRuns(parseCron('0 9 * * *'), 'Asia/Tokyo', from, 1);
    assert.equal(new Date(a).getUTCHours(), 8, '09:00 BST');
    assert.equal(new Date(b).getUTCHours(), 0, '09:00 JST');
  });
  it('finds rare dates: 29 February, the 31st, month ends', () => {
    assert.deepEqual(local('0 0 29 2 *', 'UTC', from, 2), ['2028-02-29 00:00', '2032-02-29 00:00']);
    assert.deepEqual(local('0 0 31 * *', 'UTC', from, 4), ['2026-10-31 00:00', '2026-12-31 00:00', '2027-01-31 00:00', '2027-03-31 00:00']);
    assert.deepEqual(local('0 0 1 1 *', 'UTC', from, 1), ['2027-01-01 00:00']);
  });
  it('returns nothing for a date that never exists, and does not hang on it', () => {
    const started = Date.now();
    assert.deepEqual(nextRuns(parseCron('0 0 31 2 *'), 'UTC', from, 3), []);
    assert.deepEqual(nextRuns(parseCron('0 0 30 2 *'), 'America/New_York', from, 3), []);
    assert.ok(Date.now() - started < 2000, 'searching years ahead is quick');
  });
  it('spring forward: a time that does not exist is skipped that day', () => {
    // New York, clocks jump 02:00 → 03:00 on Sunday 8 March 2026
    assert.deepEqual(local('30 2 * * *', 'America/New_York', at(2026, 3, 7, 12), 3), ['2026-03-09 02:30', '2026-03-10 02:30', '2026-03-11 02:30']);
    assert.deepEqual(local('30 3 * * *', 'America/New_York', at(2026, 3, 7, 12), 2), ['2026-03-08 03:30', '2026-03-09 03:30']);
  });
  it('spring forward does not make it skip the first hour of the following day', () => {
    assert.deepEqual(local('30 0 * * MON', 'America/New_York', at(2026, 3, 6, 12), 2), ['2026-03-09 00:30', '2026-03-16 00:30']);
    assert.deepEqual(local('30 0 * * MON', 'Europe/London', at(2026, 3, 20, 12), 2), ['2026-03-23 00:30', '2026-03-30 00:30']);
  });
  it('fall back: a time that happens twice is listed once', () => {
    // New York, clocks go back 02:00 → 01:00 on Sunday 1 November 2026: 01:30 happens twice
    const runs = nextRuns(parseCron('30 1 * * *'), 'America/New_York', at(2026, 10, 31, 12), 3);
    assert.deepEqual(runs, [at(2026, 11, 1, 5, 30), at(2026, 11, 2, 6, 30), at(2026, 11, 3, 6, 30)], 'the first 01:30 only');
  });
  it('honours the horizon', () => {
    assert.deepEqual(nextRuns(parseCron('0 0 29 2 *'), 'UTC', from, 1, { horizonDays: 100 }), []);
  });
});

describe('scheduleOf (a Schedule node\'s settings)', () => {
  it('a node saved before modes existed is an "every" schedule', () => {
    assert.deepEqual(scheduleOf({ every: 5, unit: 'minutes' }), { mode: 'every', ms: 5 * 60_000 });
    assert.deepEqual(scheduleOf({ mode: 'every', every: 2, unit: 'hours' }), { mode: 'every', ms: 2 * 3_600_000 });
    assert.deepEqual(scheduleOf({ every: 1, unit: 'days' }), { mode: 'every', ms: 86_400_000 });
    assert.equal(scheduleOf({ every: 1, unit: 'nonsense' }).ms, 60_000, 'an unknown unit means minutes, as before');
    assert.equal(scheduleOf({ every: '3', unit: 'minutes' }).ms, 180_000, 'numbers typed as text');
    assert.equal(scheduleOf({ every: 1.5, unit: 'minutes' }).ms, 90_000);
  });
  it('long intervals are allowed (no more silent cut at 24.8 days)', () => {
    assert.equal(scheduleOf({ every: 30, unit: 'days' }).ms, 30 * 86_400_000);
    assert.equal(scheduleOf({ every: 365, unit: 'days' }).ms, 365 * 86_400_000);
  });
  it('refuses intervals that are not real', () => {
    for (const every of [0, -5, '', 'abc', undefined, 0.5]) assert.throws(() => scheduleOf({ every, unit: 'minutes' }), /Interval must be at least 1/, String(every));
    assert.throws(() => scheduleOf({ every: 4000, unit: 'days' }), /longer than 10 years/);
    assert.throws(() => scheduleOf({ every: Infinity, unit: 'days' }), /longer than 10 years/);
    assert.throws(() => scheduleOf({ every: 1e999, unit: 'days' }), /longer than 10 years/);
  });
  it('"at a set time" becomes a cron expression in its zone', () => {
    const s = scheduleOf({ mode: 'time', time: '18:00', days: ['fri'], timezone: 'Asia/Tokyo' });
    assert.deepEqual([s.mode, s.tz, s.source], ['time', 'Asia/Tokyo', '0 18 * * FRI']);
    assert.equal(s.cron.hour.has(18), true);
    assert.equal(scheduleOf({ mode: 'time', time: '06:00' }).tz, 'UTC', 'no zone means UTC');
  });
  it('a cron node uses its expression and zone', () => {
    const s = scheduleOf({ mode: 'cron', cron: '*/10 * * * *', timezone: 'Europe/London' });
    assert.deepEqual([s.mode, s.tz, s.source], ['cron', 'Europe/London', '*/10 * * * *']);
  });
  it('every problem is a CronError with a message fit to show', () => {
    const cases = [
      [{ mode: 'cron', cron: '' }, /Write a cron expression/],
      [{ mode: 'cron', cron: '* * *' }, /5 fields/],
      [{ mode: 'time', time: '' }, /24-hour clock/],
      [{ mode: 'time', time: '9:00', timezone: 'Mars/Base' }, /“Mars\/Base” is not a time zone/],
      [{ mode: 'cron', cron: '* * * * *', timezone: 'Nope' }, /not a time zone/],
    ];
    for (const [data, message] of cases) assert.throws(() => scheduleOf(data), (e) => e instanceof CronError && message.test(e.message), JSON.stringify(data));
  });
});
