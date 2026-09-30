// The Schedule trigger, end to end on a fake clock: "every …", "at a set time" and cron, in a time zone, through the real Runtime.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetLimits } from '../shared/limits.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { edge, fakeGuild, node } from './helpers/fakes.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

/** A clock and one timer we control: `advance` moves time forward and runs the timer whenever it comes due, like a real clock. */
function fakeClock(start) {
  let t = start;
  const timers = [];
  const live = () => timers.filter((x) => !x.off && !x.done);
  return {
    clock: {
      now: () => t,
      setTimer: (fn, ms) => { const timer = { fn, at: t + ms, off: false, done: false, unref() {} }; timers.push(timer); return timer; },
      clearTimer: (timer) => { timer.off = true; },
    },
    now: () => t,
    set(ms) { t = ms; },
    waiting: () => live().length,
    nextAt: () => live().map((x) => x.at).sort((a, b) => a - b)[0],
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = live().sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        t = Math.max(t, next.at); next.done = true;
        await next.fn();
      }
      t = end;
    },
  };
}

describe('Schedule node validation', () => {
  const problems = (data) => validateFlow(normalizeGraph({ nodes: [node('s', 'trigger.schedule', data), node('m', 'action.message.send', { target: 'channel', channelId: '1', content: 'x' })], edges: [edge('s', 'm')] }), { intents: { members: true, messageContent: true } })
    .filter((i) => i.nodeId === 's' && i.level === 'error').map((i) => i.message);

  it('accepts every mode with sensible settings', () => {
    assert.deepEqual(problems({}), [], 'the defaults');
    assert.deepEqual(problems({ mode: 'every', every: 3, unit: 'hours' }), []);
    assert.deepEqual(problems({ mode: 'time', time: '09:00', days: ['mon'], timezone: 'Europe/London' }), []);
    assert.deepEqual(problems({ mode: 'cron', cron: '0 9 * * 1-5', timezone: 'Asia/Tokyo' }), []);
    assert.deepEqual(problems({ mode: undefined, every: 5, unit: 'minutes' }), [], 'saved before modes existed');
  });
  it('accepts the current, the old and the unlisted name of a zone', () => {
    for (const timezone of ['Asia/Kolkata', 'Asia/Calcutta', 'US/Pacific', 'Europe/Kyiv', 'Etc/UTC', 'UTC']) {
      assert.deepEqual(problems({ mode: 'time', time: '09:00', timezone }), [], timezone);
    }
  });
  it('says what is wrong, once, in words', () => {
    assert.deepEqual(problems({ mode: 'time', time: '25:00' }), ['Write the time on a 24-hour clock, for example 09:30 or 18:00.']);
    assert.deepEqual(problems({ mode: 'time', time: '' }), ['Write the time on a 24-hour clock, for example 09:30 or 18:00.']);
    assert.deepEqual(problems({ mode: 'cron', cron: '' }), ['Write a cron expression, for example 0 9 * * 1-5 (09:00 on weekdays).']);
    assert.match(problems({ mode: 'cron', cron: '* * *' })[0], /5 fields/);
    assert.match(problems({ mode: 'cron', cron: '0 0 31 2 *' })[0], /never runs/);
    assert.match(problems({ mode: 'time', time: '09:00', timezone: 'Mars/Base' })[0], /“Mars\/Base” is not a time zone/);
    assert.match(problems({ every: 0 }).join(' '), /Interval must be at least 1/);
    assert.match(problems({ mode: 'every', every: 9999, unit: 'days' }).join(' '), /longer than 10 years/);
  });
  it('ignores settings of the modes that are not chosen', () => {
    assert.deepEqual(problems({ mode: 'every', every: 5, unit: 'minutes', cron: 'nonsense', time: 'later', timezone: 'Mars/Base' }), []);
    assert.deepEqual(problems({ mode: 'cron', cron: '* * * * *', every: 0, time: 'later' }), []);
  });
});

describe('Schedule trigger', () => {
  let db; let logger; let runtime; let time; let guild; let channel;
  const said = () => channel.sent.map((p) => p.content);
  const setup = (start) => {
    resetLimits();
    db = new Database(':memory:');
    logger = new Logger({ console: false });
    time = fakeClock(start);
    runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true }, clock: time.clock });
    guild = fakeGuild({ id: '111111' });
    channel = guild.addChannel({ name: 'general' });
    runtime.attachClient(guild.client);
  };
  /** A flow: Schedule → post `text` in #general. */
  const install = (data, text = 'ran', { name = 'Sched', g = guild, ch = channel } = {}) => {
    const flow = db.createFlow({
      guildId: g.id, name,
      graph: { nodes: [node('s', 'trigger.schedule', data), node('m', 'action.message.send', { target: 'channel', channelId: ch.id, content: text })], edges: [edge('s', 'm')] },
    });
    runtime.loadGuild(g.id);
    return flow;
  };
  const run = async (ms) => { await time.advance(ms); await settle(); };
  const logs = () => logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);

  describe('at a set time', () => {
    beforeEach(() => setup(utc(2026, 9, 30, 8, 58, 20))); // Wednesday

    it('runs once, in the minute it names, and not again until tomorrow', async () => {
      install({ mode: 'time', time: '09:00', timezone: 'UTC' });
      await run(MIN); // 08:59
      assert.deepEqual(said(), [], 'not yet');
      await run(2 * MIN); // 09:00 and 09:01
      assert.deepEqual(said(), ['ran'], 'at 09:00, once');
      await run(23 * HOUR); // to 08:01 the next day
      assert.equal(said().length, 1, 'nothing more until 09:00 again');
      await run(2 * HOUR);
      assert.equal(said().length, 2, 'and again the next morning');
    });

    it('checks at the start of each minute, with one timer for everything', async () => {
      install({ mode: 'time', time: '09:00', timezone: 'UTC' });
      install({ mode: 'cron', cron: '*/5 * * * *' }, 'five', { name: 'Two' });
      assert.equal(time.waiting(), 1, 'one timer, however many schedules');
      assert.equal(time.nextAt(), utc(2026, 9, 30, 8, 59, 0) + 250, 'just after the next minute begins');
    });

    it('only on the chosen days', async () => {
      setup(utc(2026, 9, 29, 8, 0, 0)); // Tuesday
      install({ mode: 'time', time: '09:00', days: ['mon', 'fri'], timezone: 'UTC' });
      await run(7 * DAY);
      assert.equal(said().length, 2, 'Friday 2 October and Monday 5 October');
    });

    it('reads the time on the wall clock of the zone it names', async () => {
      setup(utc(2026, 9, 29, 20, 0, 0));
      install({ mode: 'time', time: '09:00', timezone: 'Asia/Tokyo' }, 'tokyo', { name: 'Tokyo' });
      install({ mode: 'time', time: '09:00', timezone: 'UTC' }, 'utc', { name: 'Utc' });
      install({ mode: 'time', time: '09:00', timezone: 'Asia/Kolkata' }, 'kolkata', { name: 'Kolkata' });
      await run(5 * HOUR); // 01:00 UTC: Tokyo's 09:00 was at 00:00
      assert.deepEqual(said(), ['tokyo']);
      await run(5 * HOUR); // 06:00 UTC: Kolkata's 09:00 is 03:30 UTC
      assert.deepEqual(said(), ['tokyo', 'kolkata']);
      await run(4 * HOUR); // 10:00 UTC
      assert.deepEqual(said(), ['tokyo', 'kolkata', 'utc']);
    });

    it('a time that does not exist is skipped that day, and one that happens twice runs once', async () => {
      // New York: on 8 March 2026 the clocks jump 02:00 → 03:00; on 1 November they go back 02:00 → 01:00
      setup(utc(2026, 3, 8, 5, 0, 0)); // 00:00 EST
      install({ mode: 'time', time: '02:30', timezone: 'America/New_York' });
      await run(5 * HOUR); // to 05:00 EDT (10:00 UTC) — 02:30 never came
      assert.deepEqual(said(), []);
      await run(24 * HOUR); // 02:30 EDT the next day
      assert.equal(said().length, 1);

      setup(utc(2026, 11, 1, 4, 0, 0)); // 00:00 EDT
      install({ mode: 'time', time: '01:30', timezone: 'America/New_York' });
      await run(4 * HOUR); // covers 01:30 EDT (05:30 UTC) and 01:30 EST (06:30 UTC)
      assert.equal(said().length, 1, 'once, not twice');
    });

    it('a minute is never run twice, however often it is asked', async () => {
      install({ mode: 'time', time: '09:00', timezone: 'UTC' });
      await time.advance(90 * MIN); // to 10:28, ticks run on their own
      await settle();
      assert.equal(said().length, 1);
      await runtime.runScheduleTick(utc(2026, 9, 30, 9, 0, 40));
      await runtime.runScheduleTick(utc(2026, 9, 30, 9, 0, 55));
      await settle();
      assert.equal(said().length, 1);
    });
  });

  describe('cron', () => {
    beforeEach(() => setup(utc(2026, 9, 30, 10, 0, 5)));

    it('every 15 minutes', async () => {
      install({ mode: 'cron', cron: '*/15 * * * *', timezone: 'UTC' });
      await run(HOUR); // 10:15, 10:30, 10:45, 11:00
      assert.equal(said().length, 4);
    });

    it('weekday mornings in a zone', async () => {
      setup(utc(2026, 10, 1, 0, 0, 0)); // Thursday, 08:00 in Kuala Lumpur
      install({ mode: 'cron', cron: '0 9 * * 1-5', timezone: 'Asia/Kuala_Lumpur' });
      await run(7 * DAY);
      assert.equal(said().length, 5, 'Thu, Fri, Mon, Tue, Wed');
    });

    it('day of month OR day of week when both are given (like classic cron)', async () => {
      setup(utc(2026, 11, 1, 0, 0, 0)); // Sunday 1 November
      install({ mode: 'cron', cron: '0 12 13 * FRI', timezone: 'UTC' });
      await run(14 * DAY); // Fridays 6th and 13th; the 13th is also the day of month
      assert.equal(said().length, 2);
    });

    it('a schedule saved in the minute it names does not run for that minute', async () => {
      setup(utc(2026, 9, 30, 9, 0, 30));
      install({ mode: 'time', time: '09:00', timezone: 'UTC' });
      await run(5 * MIN);
      assert.deepEqual(said(), []);
    });

    it('runs with the channel it was given as context', async () => {
      const other = guild.addChannel({ name: 'announcements' });
      const flow = db.createFlow({
        guildId: guild.id, name: 'Ctx',
        graph: { nodes: [node('s', 'trigger.schedule', { mode: 'cron', cron: '* * * * *', channelId: other.id }), node('m', 'action.message.send', { target: 'channel', channelId: channel.id, content: 'in #{{channel.name}} of {{guild.name}}' })], edges: [edge('s', 'm')] },
      });
      assert.ok(flow);
      runtime.loadGuild(guild.id);
      await run(MIN);
      assert.deepEqual(said(), [`in #announcements of ${guild.name}`]);
    });
  });

  describe('every … minutes, hours or days', () => {
    beforeEach(() => setup(utc(2026, 9, 30, 10, 0, 20)));

    it('keeps its cadence', async () => {
      install({ mode: 'every', every: 5, unit: 'minutes' });
      await run(16 * MIN);
      assert.equal(said().length, 3, '10:05, 10:10, 10:15');
      await run(4 * MIN);
      assert.equal(said().length, 4);
    });

    it('a node saved before the modes existed still means "every"', async () => {
      install({ mode: undefined, every: 2, unit: 'minutes' });
      assert.equal(runtime.schedules.size, 1);
      await run(9 * MIN);
      assert.equal(said().length, 4);
    });

    it('is not restarted by saving other flows in the same server', async () => {
      install({ mode: 'every', every: 60, unit: 'minutes' });
      await run(50 * MIN);
      db.createFlow({ guildId: guild.id, name: 'Unrelated', graph: { nodes: [node('t', 'trigger.command', { name: 'hi' })], edges: [] } });
      runtime.loadGuild(guild.id); // what saving any flow does
      db.createFlow({ guildId: guild.id, name: 'Unrelated 2', graph: { nodes: [node('t', 'trigger.command', { name: 'ho' })], edges: [] } });
      runtime.loadGuild(guild.id);
      await run(11 * MIN); // 11:01: the hour is up
      assert.equal(said().length, 1, 'it still ran on time (it used to start over at every save)');
    });

    it('starts over when its own settings change', async () => {
      const flow = install({ mode: 'every', every: 60, unit: 'minutes' });
      await run(50 * MIN);
      const graph = { ...flow.graph, nodes: flow.graph.nodes.map((n) => (n.type === 'trigger.schedule' ? { ...n, data: { ...n.data, every: 30 } } : n)) };
      db.updateFlow(guild.id, flow.id, { graph });
      runtime.loadGuild(guild.id);
      await run(25 * MIN);
      assert.deepEqual(said(), [], 'the new 30 minutes are counted from the change');
      await run(6 * MIN);
      assert.equal(said().length, 1);
    });

    it('works for intervals longer than 24.8 days (it used to be cut short)', async () => {
      install({ mode: 'every', every: 30, unit: 'days' });
      time.set(time.now() + 30 * DAY - 2 * MIN);
      await runtime.runScheduleTick(time.now());
      await settle();
      assert.deepEqual(said(), []);
      time.set(time.now() + 3 * MIN);
      await runtime.runScheduleTick(time.now());
      await settle();
      assert.equal(said().length, 1, 'on day 30');
    });
  });

  describe('downtime and stalls', () => {
    beforeEach(() => setup(utc(2026, 9, 30, 10, 0, 10)));

    it('makes up a minute a stalled event loop skipped, but never replays a long gap', async () => {
      install({ mode: 'cron', cron: '* * * * *' });
      time.set(utc(2026, 9, 30, 10, 2, 40));
      await runtime.runScheduleTick(time.now()); // 10:01 and 10:02 are due
      await settle();
      assert.equal(said().length, 2);
      time.set(utc(2026, 9, 30, 12, 0, 30));
      await runtime.runScheduleTick(time.now()); // two hours passed: only the latest few minutes count
      await settle();
      assert.equal(said().length, 5, 'three more, not a hundred and twenty');
    });

    it('a restarted bot starts from now: nothing missed while it was off is run', async () => {
      install({ mode: 'time', time: '09:00', timezone: 'UTC' });
      setup(utc(2026, 9, 30, 9, 30, 0)); // "restart" half an hour after the time
      install({ mode: 'time', time: '09:00', timezone: 'UTC' });
      await run(HOUR);
      assert.deepEqual(said(), []);
    });
  });

  describe('being switched off', () => {
    beforeEach(() => setup(utc(2026, 9, 30, 8, 58, 20)));

    it('a schedule that cannot work is not active, and says why', async () => {
      install({ mode: 'cron', cron: '* * *' });
      install({ mode: 'time', time: '25:99' }, 'x', { name: 'Bad time' });
      install({ mode: 'cron', cron: '0 0 31 2 *' }, 'x', { name: 'Never' });
      install({ mode: 'time', time: '09:00', timezone: 'Mars/Base' }, 'x', { name: 'Bad zone' });
      assert.equal(runtime.schedules.size, 0);
      assert.equal(time.waiting(), 0, 'no timer for nothing');
      const l = logs().join('\n');
      assert.match(l, /“Schedule” in “Sched” is not active: A cron expression has 5 fields/);
      assert.match(l, /“Schedule” in “Bad time” is not active: Write the time on a 24-hour clock/);
      assert.match(l, /“Schedule” in “Never” is not active: This schedule never runs/);
      assert.match(l, /“Schedule” in “Bad zone” is not active: .*invalid value|“Schedule” in “Bad zone” is not active: “Mars\/Base” is not a time zone/);
      await run(HOUR);
      assert.deepEqual(said(), []);
    });

    it('a flow that is switched off does not run', async () => {
      const flow = install({ mode: 'time', time: '09:00', timezone: 'UTC' });
      db.updateFlow(guild.id, flow.id, { enabled: false });
      runtime.loadGuild(guild.id);
      assert.equal(runtime.schedules.size, 0);
      assert.equal(time.waiting(), 0);
      await run(HOUR);
      assert.deepEqual(said(), []);
    });

    it('deleting the schedule node or the flow stops it, and other servers carry on', async () => {
      const other = fakeGuild({ id: '222222' });
      const otherChannel = other.addChannel({ name: 'general' });
      other.client.guilds.cache.set(guild.id, guild); // one bot, two servers
      guild.client.guilds.cache.set(other.id, other);
      install({ mode: 'time', time: '09:00', timezone: 'UTC' }, 'one');
      install({ mode: 'time', time: '09:00', timezone: 'UTC' }, 'two', { g: other, ch: otherChannel });
      assert.equal(time.waiting(), 1);
      runtime.unloadGuild(guild.id);
      assert.equal(runtime.schedules.size, 1);
      assert.equal(time.waiting(), 1, 'the other server still needs the timer');
      await run(3 * MIN);
      assert.deepEqual(otherChannel.sent.map((p) => p.content), ['two']);
      assert.deepEqual(said(), [], 'the unloaded server did not run');
      runtime.unloadGuild(other.id);
      assert.equal(runtime.schedules.size, 0);
      assert.equal(time.waiting(), 0, 'the last one out stops the timer');
    });

    it('stopping the bot stops everything', async () => {
      install({ mode: 'time', time: '09:00', timezone: 'UTC' });
      await runtime.stop();
      assert.equal(runtime.schedules.size, 0);
      assert.equal(time.waiting(), 0);
      await run(HOUR);
      assert.deepEqual(said(), []);
    });

    it('one schedule that breaks cannot stop the others', async () => {
      install({ mode: 'cron', cron: '* * * * *' }, 'fine');
      runtime.schedules.set('broken', { key: 'broken', guildId: guild.id, flow: { id: 'x', name: 'Broken' }, node: { id: 'n', data: {} }, schedule: { mode: 'cron', tz: 'Nowhere/Land', cron: { minute: new Set([0]), hour: new Set(), dom: new Set(), month: new Set(), dow: new Set() } }, signature: 'x', due: 0, lastKey: '' });
      await run(MIN);
      assert.deepEqual(said(), ['fine']);
      assert.equal(runtime.schedules.has('broken'), false, 'the broken one was dropped');
      assert.ok(logs().some((l) => /^warn: The schedule in “Broken” was switched off/.test(l)), logs().join('\n'));
    });

    it('does nothing (and does not crash) while the bot is not connected', async () => {
      install({ mode: 'cron', cron: '* * * * *' });
      runtime.attachClient(null);
      await run(3 * MIN);
      assert.deepEqual(said(), []);
    });
  });
});
