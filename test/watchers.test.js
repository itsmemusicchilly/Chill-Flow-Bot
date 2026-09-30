// "New Feed Item": a feed gets a post → a flow runs. Through the real Runtime, on a fake clock, with a pretend network and a fake Discord.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { SafeFetchError } from '../server/net/safe-fetch.js';
import { edge, fakeGuild, node } from './helpers/fakes.js';

const MIN = 60_000;
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

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
    waiting: () => live().length,
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

const post = (id, title, at, extra = '') => `<item><guid>${id}</guid><title>${title}</title><link>https://blog.example/${id}</link><dc:creator>Sam</dc:creator><pubDate>${new Date(at).toUTCString()}</pubDate><description>Text of ${id}</description>${extra}</item>`;
const rss = (...items) => `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Sam’s Blog</title>${items.join('')}</channel></rss>`;
const FEED = 'https://blog.example/feed.xml';

describe('New Feed Item', () => {
  let db; let logger; let runtime; let time; let guild; let channel; let web; let calls;
  const said = () => channel.sent.map((p) => p.content);
  const logs = () => logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);

  /** The pretend network: `web` maps an address to what it answers; a function answers dynamically; an Error is thrown. */
  const fetcher = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {} });
    const answer = typeof web[url] === 'function' ? web[url](options) : web[url];
    if (answer instanceof Error) throw answer;
    if (!answer) return { status: 404, headers: new Headers(), text: 'nope', body: Buffer.from('nope') };
    const { status = 200, text = '', headers = {} } = answer;
    return { status, headers: new Headers(headers), text, body: Buffer.from(text) };
  };

  const boot = (start = utc(2026, 9, 30, 10, 0, 20), options = {}) => {
    resetLimits();
    db ??= new Database(':memory:');
    logger = new Logger({ console: false });
    time = fakeClock(start);
    runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true }, clock: time.clock, fetcher, ...options });
    guild = fakeGuild({ id: '111111111111111111' });
    channel = guild.addChannel({ name: 'announcements' });
    runtime.attachClient(guild.client);
  };
  beforeEach(() => { db = null; web = {}; calls = []; boot(); });

  const settings = (over = {}) => ({ source: 'url', url: FEED, minutes: 15, ...over });
  const install = (data = {}, { g = guild, ch = channel, name = 'Announcer', content = 'New: {{feed.title}} — {{feed.link}} by {{feed.author}}' } = {}) => {
    const flow = db.createFlow({
      guildId: g.id, name,
      graph: { nodes: [node('f', 'trigger.feed.item', settings(data)), node('m', 'action.message.send', { target: 'channel', channelId: ch.id, content })], edges: [edge('f', 'm')] },
    });
    runtime.loadGuild(g.id);
    return flow;
  };
  const run = async (ms) => { await time.advance(ms); await runtime.watchers.idle(); await settle(); };

  describe('what it announces', () => {
    it('remembers what is already there on the first look, then announces each new post once, with its details', async () => {
      web[FEED] = { text: rss(post('a', 'Old post', utc(2026, 9, 1))) };
      install();
      await run(MIN);
      assert.deepEqual(said(), [], 'nothing from the back catalogue');
      assert.ok(logs().some((l) => /^info: Now watching “Sam’s Blog”\. The 1 post\(s\) already there are not announced/.test(l)), logs().join('\n'));
      web[FEED] = { text: rss(post('b', 'Hello world', utc(2026, 9, 30, 10, 5)), post('a', 'Old post', utc(2026, 9, 1))) };
      await run(15 * MIN);
      assert.deepEqual(said(), ['New: Hello world — https://blog.example/b by Sam']);
      await run(60 * MIN);
      assert.deepEqual(said(), ['New: Hello world — https://blog.example/b by Sam'], 'the same post is never announced again');
    });

    it('gives the flow every detail as {{feed.*}}', async () => {
      web[FEED] = { text: rss() };
      install({}, { content: '{{feed.id}}|{{feed.title}}|{{feed.link}}|{{feed.author}}|{{feed.summary}}|{{feed.published}}|{{feed.image}}|{{feed.name}}' });
      await run(MIN);
      web[FEED] = { text: rss(post('b', 'Hello', utc(2026, 9, 30, 10, 5), '<enclosure url="https://blog.example/p.png" type="image/png"/>')) };
      await run(15 * MIN);
      assert.deepEqual(said(), ['b|Hello|https://blog.example/b|Sam|Text of b|2026-09-30T10:05:00.000Z|https://blog.example/p.png|Sam’s Blog']);
    });

    it('announces a burst oldest first, at most five, and says when it left some out', async () => {
      web[FEED] = { text: rss(post('z', 'Base', utc(2026, 9, 1))) };
      install();
      await run(MIN);
      web[FEED] = { text: rss(...[8, 7, 6, 5, 4, 3, 2, 1].map((n) => post(`p${n}`, `Post ${n}`, utc(2026, 9, 30, 10, n))), post('z', 'Base', utc(2026, 9, 1))) };
      await run(15 * MIN);
      assert.deepEqual(said().map((m) => m.slice(0, 11)), ['New: Post 4 ', 'New: Post 5 ', 'New: Post 6 ', 'New: Post 7 ', 'New: Post 8 '].map((m) => m.slice(0, 11)), 'the newest five, in the order they were written');
      assert.ok(logs().some((l) => /^warn: “Sam’s Blog” got 8 new posts at once; only the newest 5 are announced/.test(l)));
      await run(60 * MIN);
      assert.equal(said().length, 5, 'the three left out are not announced later');
    });

    it('a feed without dates is announced newest-last as listed (feeds list the newest first)', async () => {
      const bare = (id) => `<item><guid>${id}</guid><title>${id}</title></item>`;
      web[FEED] = { text: rss(bare('x')) };
      install({}, { content: 'T:{{feed.title}}' });
      await run(MIN);
      web[FEED] = { text: rss(bare('c'), bare('b'), bare('x')) };
      await run(15 * MIN);
      assert.deepEqual(said(), ['T:b', 'T:c']);
    });

    it('never announces the same post twice across a restart, and does not lose one that arrived while the bot was off', async () => {
      web[FEED] = { text: rss(post('a', 'One', utc(2026, 9, 1))) };
      install();
      await run(MIN);
      web[FEED] = { text: rss(post('b', 'Two', utc(2026, 9, 30, 10, 5)), post('a', 'One', utc(2026, 9, 1))) };
      await run(15 * MIN);
      assert.equal(said().length, 1);
      // the bot restarts: a brand new runtime on the same database
      web[FEED] = { text: rss(post('c', 'Three', utc(2026, 9, 30, 11, 0)), post('b', 'Two', utc(2026, 9, 30, 10, 5)), post('a', 'One', utc(2026, 9, 1))) };
      time = fakeClock(utc(2026, 9, 30, 12, 0, 20));
      runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true }, clock: time.clock, fetcher }); // same database, same server
      runtime.attachClient(guild.client);
      runtime.loadGuild(guild.id);
      await run(MIN);
      assert.deepEqual(said(), ['New: Two — https://blog.example/b by Sam', 'New: Three — https://blog.example/c by Sam'], '“Two” once (before the restart), “Three” once (after): nothing repeated, nothing lost');
    });

    it('post text that looks like a template or a mention is just text', async () => {
      web[FEED] = { text: rss() };
      install({}, { content: '{{feed.title}}' });
      await run(MIN);
      web[FEED] = { text: rss(post('b', '{{user.name}} @everyone {{guild.name}}', utc(2026, 9, 30, 10, 5))) };
      await run(15 * MIN);
      assert.deepEqual(said(), ['{{user.name}} @everyone {{guild.name}}'], 'shown as written, not evaluated');
      assert.ok(!(channel.sent[0].allowedMentions?.parse ?? []).includes('everyone'), 'and it does not ping anyone');
    });

    it('uses the context channel when one is given', async () => {
      web[FEED] = { text: rss() };
      const other = guild.addChannel({ name: 'news' });
      install({ channelId: other.id }, { content: 'in #{{channel.name}}' });
      await run(MIN);
      web[FEED] = { text: rss(post('b', 'x', utc(2026, 9, 30, 10, 5))) };
      await run(15 * MIN);
      assert.deepEqual(said(), ['in #news']);
    });
  });

  describe('how often, and how politely', () => {
    it('looks about as often as asked (and no more), starting at the next minute', async () => {
      web[FEED] = { text: rss() };
      install({ minutes: 20 });
      await run(50 * MIN);
      assert.equal(calls.length, 3, 'minute 1, then 20 and 40 minutes later');
    });

    it('never looks more often than the operator allows', async () => {
      boot(utc(2026, 9, 30, 10, 0, 20), { feedMinMinutes: 30 });
      web[FEED] = { text: rss() };
      install({ minutes: 10 });
      await run(65 * MIN);
      assert.equal(calls.length, 3, 'every 30 minutes, not every 10');
    });

    it('fetches an address ONCE however many flows and servers are watching it, and each flow keeps its own memory', async () => {
      web[FEED] = { text: rss() };
      const second = fakeGuild({ id: '222222222222222222' });
      const secondChannel = second.addChannel({ name: 'news' });
      guild.client.guilds.cache.set(second.id, second);
      install({}, { name: 'One' });
      install({}, { g: second, ch: secondChannel, name: 'Two' });
      install({}, { name: 'Three', content: 'three: {{feed.title}}' });
      await run(MIN);
      assert.equal(calls.length, 1, 'three flows, one request');
      web[FEED] = { text: rss(post('b', 'News', utc(2026, 9, 30, 10, 5))) };
      await run(15 * MIN);
      assert.equal(calls.length, 2);
      assert.deepEqual(said().sort(), ['New: News — https://blog.example/b by Sam', 'three: News'], 'both flows in this server ran');
      assert.deepEqual(secondChannel.sent.map((p) => p.content), ['New: News — https://blog.example/b by Sam'], 'and the other server\'s flow');
    });

    it('asks only for what changed, and a 304 is a quiet no-news', async () => {
      web[FEED] = { text: rss(post('a', 'One', utc(2026, 9, 1))), headers: { etag: '"v1"', 'last-modified': 'Tue, 01 Sep 2026 00:00:00 GMT' } };
      install();
      await run(MIN);
      web[FEED] = (options) => (options.headers['if-none-match'] === '"v1"' ? { status: 304 } : { text: 'wrong' });
      await run(15 * MIN);
      assert.equal(calls[1].headers['if-none-match'], '"v1"');
      assert.equal(calls[1].headers['if-modified-since'], 'Tue, 01 Sep 2026 00:00:00 GMT');
      assert.deepEqual(said(), []);
      assert.ok(!logs().some((l) => /could not be read/.test(l)));
    });
  });

  describe('when something goes wrong', () => {
    it('tells the server\'s log once, waits longer each time, and says when it works again', async () => {
      web[FEED] = new SafeFetchError('The site took too long to answer.', 'ETIMEOUT');
      install();
      await run(MIN);
      assert.equal(logs().filter((l) => /could not be read/.test(l)).length, 1);
      assert.ok(logs().some((l) => /^warn: “https:\/\/blog\.example\/feed\.xml” could not be read: The site took too long to answer\. Trying again in 15 minute\(s\)\./.test(l)), logs().join('\n'));
      const before = calls.length;
      await run(14 * MIN);
      assert.equal(calls.length, before, 'it waits');
      await run(2 * MIN); // second failure: same message, no second log line; the wait doubles to 30 minutes
      assert.equal(logs().filter((l) => /could not be read/.test(l)).length, 1, 'the same problem is not repeated in the log');
      const second = calls.length;
      await run(28 * MIN); // the second failure was at 10:16, so the next try is at 10:46
      assert.equal(calls.length, second);
      await run(2 * MIN);
      assert.equal(calls.length, second + 1, 'after 30 minutes it tries again');
      web[FEED] = { text: rss(post('a', 'One', utc(2026, 9, 1))) };
      await run(70 * MIN);
      assert.equal(logs().filter((l) => /can be read again/.test(l)).length, 1);
    });

    it('explains a missing feed, a site error and a page that is not a feed', async () => {
      web[FEED] = { status: 404 };
      install();
      await run(MIN);
      assert.ok(logs().some((l) => /not found at that address \(404\)/.test(l)));
      db = null; boot();
      web[FEED] = { status: 503 };
      install();
      await run(MIN);
      assert.ok(logs().some((l) => /answered with an error \(503\)/.test(l)));
      db = null; boot();
      web[FEED] = { text: '<!DOCTYPE html><html><body>Not a feed</body></html>' };
      install();
      await run(MIN);
      assert.ok(logs().some((l) => /web page, not a feed/.test(l)));
    });

    it('a problem with one feed does not stop another', async () => {
      const good = 'https://good.example/feed';
      web[FEED] = new Error('boom');
      web[good] = { text: rss() };
      install();
      install({ url: good }, { name: 'Good' });
      await run(MIN);
      web[good] = { text: rss(post('n', 'Fine', utc(2026, 9, 30, 10, 5))) };
      await run(15 * MIN);
      assert.equal(said().length, 1);
    });

    it('settings that cannot work are not watched, and the log says why', async () => {
      for (const bad of [{ url: 'http://blog.example/feed' }, { url: 'https://127.0.0.1/feed' }, { url: '' }, { minutes: 2 }, { source: 'youtube', channel: 'nope' }]) install(bad);
      assert.equal(runtime.watchers.size, 0);
      assert.equal(time.waiting(), 0, 'no timer for nothing');
      await run(30 * MIN);
      assert.equal(calls.length, 0);
      assert.ok(logs().some((l) => /not active: Only https/.test(l)));
    });

    it('nothing is announced, and nothing is forgotten, while the bot is not connected to the server', async () => {
      web[FEED] = { text: rss(post('a', 'One', utc(2026, 9, 1))) };
      install();
      await run(MIN);
      web[FEED] = { text: rss(post('b', 'Two', utc(2026, 9, 30, 10, 5)), post('a', 'One', utc(2026, 9, 1))) };
      runtime.attachClient(null);
      await run(15 * MIN);
      assert.deepEqual(said(), []);
      runtime.attachClient(guild.client);
      await run(15 * MIN);
      assert.deepEqual(said(), ['New: Two — https://blog.example/b by Sam'], 'announced once it is back');
    });
  });

  describe('switching things on, off and around', () => {
    it('a flow that is switched off is not watched; deleting it forgets what it had seen', async () => {
      web[FEED] = { text: rss(post('a', 'One', utc(2026, 9, 1))) };
      const flow = install();
      await run(MIN);
      assert.ok(db.getWatch(guild.id, flow.id, 'f'), 'it remembers');
      db.updateFlow(guild.id, flow.id, { enabled: false });
      runtime.loadGuild(guild.id);
      assert.equal(runtime.watchers.size, 0);
      assert.equal(time.waiting(), 0);
      assert.equal(db.getWatch(guild.id, flow.id, 'f'), null, 'and forgets when it is off');
    });

    it('changing the address starts fresh: the new feed\'s existing posts are not announced', async () => {
      const other = 'https://other.example/feed';
      web[FEED] = { text: rss(post('a', 'One', utc(2026, 9, 1))) };
      web[other] = { text: rss(post('q', 'Other one', utc(2026, 8, 1)), post('r', 'Other two', utc(2026, 8, 2))) };
      const flow = install();
      await run(MIN);
      const graph = { ...flow.graph, nodes: flow.graph.nodes.map((n) => (n.type === 'trigger.feed.item' ? { ...n, data: { ...n.data, url: other } } : n)) };
      db.updateFlow(guild.id, flow.id, { graph });
      runtime.loadGuild(guild.id);
      await run(2 * MIN);
      assert.deepEqual(said(), [], 'nothing from the new feed\'s back catalogue');
      web[other] = { text: rss(post('s', 'Other three', utc(2026, 9, 30, 10, 20)), post('q', 'x', utc(2026, 8, 1)), post('r', 'y', utc(2026, 8, 2))) };
      await run(15 * MIN);
      assert.deepEqual(said(), ['New: Other three — https://blog.example/s by Sam']);
    });

    it('saving other flows does not restart the watching', async () => {
      web[FEED] = { text: rss(post('a', 'One', utc(2026, 9, 1))) };
      install();
      await run(MIN);
      const seen = calls.length;
      db.createFlow({ guildId: guild.id, name: 'Unrelated', graph: { nodes: [node('t', 'trigger.command', { name: 'hi' })], edges: [] } });
      runtime.loadGuild(guild.id);
      await run(5 * MIN);
      assert.equal(calls.length, seen, 'not asked again just because something else was saved');
    });

    it('unloading a server or stopping the bot ends it all', async () => {
      web[FEED] = { text: rss() };
      install();
      runtime.unloadGuild(guild.id);
      assert.equal(runtime.watchers.size, 0);
      assert.equal(time.waiting(), 0);
      install();
      assert.equal(time.waiting(), 1);
      await runtime.stop();
      assert.equal(runtime.watchers.size, 0);
      assert.equal(time.waiting(), 0);
      await run(60 * MIN);
      assert.equal(calls.length, 0);
    });

    it('the operator can cap how many feeds a server watches', async () => {
      applyLimits({ feedsPerGuild: 1 });
      web[FEED] = { text: rss() };
      web['https://second.example/feed'] = { text: rss() };
      install({}, { name: 'First' });
      install({ url: 'https://second.example/feed' }, { name: 'Second' });
      assert.equal(runtime.watchers.size, 1);
      assert.ok(logs().some((l) => /^warn: “Second” is not watching anything: this server reached its limit of 1 watched feeds/.test(l)), logs().join('\n'));
      resetLimits();
    });
  });
});
