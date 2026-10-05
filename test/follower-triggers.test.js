// "YouTube Subscribers Gained", "Twitch Followers" and "TikTok Followers": the count triggers, and the live-counter starter flows. Through the real
// Runtime on a fake clock, with a pretend YouTube / Twitch / TikTok and a fake Discord.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NODE_TYPES } from '../shared/catalog.js';
import { FeedSettingError } from '../shared/feeds.js';
import { resetLimits } from '../shared/limits.js';
import { countSettings, youtubeCountSettings } from '../shared/platforms.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { createAccounts } from '../server/accounts.js';
import { Database } from '../server/db.js';
import { ChannelEdits } from '../server/engine/channel-edits.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { fakeClock } from './helpers/clock.js';
import { edge, fakeGuild, node } from './helpers/fakes.js';
import { pretendProviders } from './helpers/providers.js';

const MIN = 60_000;
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const UC = `UC${'a'.repeat(22)}`;
const KEYS = { youtube: 'yt-key', twitch: { clientId: 'tw-id', clientSecret: 'tw-secret' }, tiktok: { clientKey: 'tt-key', clientSecret: 'tt-secret' } };
const CONFIG = { baseUrl: 'https://bot.example.com', clientSecret: 'discord-secret', tokenKey: '', integrations: KEYS };
const problem = (fn) => { try { fn(); return ''; } catch (e) { assert.ok(e instanceof FeedSettingError, `not a FeedSettingError: ${e?.stack}`); return e.message; } };

describe('the settings of the count triggers', () => {
  it('one rule for “when”, and each platform\'s own shortest interval', () => {
    assert.deepEqual(countSettings({ fire: 'change', minutes: 5 }, { min: 1 }), { mode: 'change', everyMs: 5 * MIN });
    assert.deepEqual(countSettings({ minutes: '2' }, { min: 1 }), { mode: 'gain', everyMs: 2 * MIN }, 'gain is the default, and minutes can be typed as text');
    assert.match(problem(() => countSettings({ fire: 'sometimes', minutes: 5 }, { min: 1 })), /each time it goes up, or every time it changes/);
    assert.match(problem(() => countSettings({ minutes: 0 }, { min: 1 })), /no more often than every 1 minute/);
    assert.match(problem(() => countSettings({ minutes: 4 }, { min: 5 })), /no more often than every 5 minutes/);
    assert.match(problem(() => countSettings({ minutes: 'soon' }, { min: 5 })), /no more often than every 5 minutes/);
  });

  it('YouTube also needs a channel, and respects YouTube\'s allowance', () => {
    assert.deepEqual(youtubeCountSettings({ channel: UC, fire: 'gain', minutes: 30 }), { channelId: UC, mode: 'gain', everyMs: 30 * MIN });
    assert.match(problem(() => youtubeCountSettings({ channel: '@name', minutes: 30 })), /starts with UC/);
    assert.match(problem(() => youtubeCountSettings({ channel: UC, minutes: 14 })), /no more often than every 15 minutes/);
  });

  it('the nodes check their settings with the same rules, and a blank YouTube channel is reported once (as “required”)', () => {
    const check = (type, data) => NODE_TYPES[type].check(data);
    assert.deepEqual(check('trigger.twitch.followers', { fire: 'gain', minutes: 5 }), []);
    assert.match(check('trigger.twitch.followers', { fire: 'gain', minutes: 0 })[0], /every 1 minute/);
    assert.match(check('trigger.tiktok.followers', { fire: 'gain', minutes: 1 })[0], /every 5 minutes/);
    assert.deepEqual(check('trigger.youtube.gained', { channel: ' ', minutes: 30 }), []);
    assert.match(check('trigger.youtube.gained', { channel: 'nope', minutes: 30 })[0], /starts with UC/);
  });

  it('the triggers are described, need the right platform and account, and say which variables they give', () => {
    for (const [type, needs, connect, ns] of [['trigger.youtube.gained', 'youtube', undefined, 'youtube'], ['trigger.twitch.followers', 'twitch', 'twitch', 'twitch'], ['trigger.tiktok.followers', 'tiktok', 'tiktok', 'tiktok']]) {
      const d = NODE_TYPES[type];
      assert.equal(d.needs, needs, type);
      assert.equal(d.connect, connect, type);
      assert.equal(d.isTrigger, true);
      const vars = d.provides({}).map(([name]) => name);
      for (const v of ['gained', 'change', 'previous']) assert.ok(vars.includes(`${ns}.${v}`), `${type} gives ${ns}.${v}`);
      assert.ok(d.description.length > 80, type);
    }
    assert.ok(NODE_TYPES['trigger.twitch.followers'].provides({}).some(([n]) => n === 'twitch.followers'));
    assert.ok(NODE_TYPES['trigger.tiktok.followers'].provides({}).some(([n]) => n === 'tiktok.followers'));
    assert.ok(NODE_TYPES['trigger.youtube.gained'].provides({}).some(([n]) => n === 'youtube.subscribers'));
  });
});

describe('telling the editor an account must be connected first', () => {
  const graph = { nodes: [node('t', 'trigger.twitch.followers', {}), node('k', 'trigger.tiktok.followers', {}), node('y', 'trigger.youtube.gained', { channel: UC })], edges: [] };
  const intents = (integrations, accounts) => validateFlow(graph, { integrations, accounts }).filter((i) => i.level === 'error' && i.kind === 'intent').map((i) => [i.nodeId, i.message]);
  const ALL = { youtube: true, twitch: true, tiktok: true };

  it('is an error on the node until the account is connected, and says where to do it', () => {
    const found = intents(ALL, { twitch: false, tiktok: false });
    assert.deepEqual(found.map(([id]) => id), ['t', 'k']);
    assert.match(found[0][1], /Connect a Twitch account first: open “Accounts” in the top bar and press Connect Twitch/);
    assert.match(found[1][1], /Connect a TikTok account first/);
    assert.deepEqual(intents(ALL, { twitch: true, tiktok: false }).map(([id]) => id), ['k']);
    assert.deepEqual(intents(ALL, { twitch: true, tiktok: true }), []);
  });

  it('is not said when nobody told it which accounts are connected, so older callers see no change', () => {
    assert.deepEqual(intents(ALL, undefined), []);
  });

  it('is said once: when the bot operator has not set the platform up, that is the reason that is given', () => {
    const found = intents({ youtube: true, twitch: false, tiktok: true }, { twitch: false, tiktok: false });
    assert.deepEqual(found.map(([id]) => id), ['t', 'k']);
    assert.match(found[0][1], /Twitch application \(TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET\), which the bot operator has not set up/);
    assert.match(found[1][1], /Connect a TikTok account first/);
  });

  it('never stops the flow from being saved (it is not a structure error)', () => {
    assert.equal(hasStructureErrors(validateFlow(graph, { integrations: ALL, accounts: { twitch: false, tiktok: false } })), false);
  });
});

describe('the count triggers, running', () => {
  let db; let logger; let runtime; let time; let guild; let channel; let counter; let net; let accounts; let yt; let ytCalls;
  const G = () => guild.id;
  const said = () => channel.sent.map((p) => p.content);
  const renames = () => counter.calls.filter((c) => c[0] === 'edit').map((c) => c[1].name);
  const logs = () => logger.recent(guild.id, 100).map((l) => `${l.level}: ${l.message}`);
  const asked = (path) => net.calls.filter((c) => c.path === path);

  /** YouTube is answered here; Twitch and TikTok by the pretend providers. */
  const fetcher = async (url, options = {}) => {
    const answer = String(url).includes('googleapis.com') ? yt(url) : await net.fetch(url, options);
    return { status: answer.status, text: answer.text, headers: new Headers(), body: Buffer.from(answer.text) };
  };
  const ytAnswer = (...rows) => ({ status: 200, text: JSON.stringify({ items: rows.map(([id, title, subs, hidden]) => ({ id, snippet: { title }, statistics: { subscriberCount: String(subs), hiddenSubscriberCount: Boolean(hidden) } })) }) });

  beforeEach(() => {
    resetLimits();
    db = new Database(':memory:');
    logger = new Logger({ console: false });
    time = fakeClock(utc(2026, 9, 30, 10, 0, 20));
    net = pretendProviders();
    ytCalls = [];
    yt = (url) => { ytCalls.push(url); return ytAnswer([UC, 'Sam Plays', 1000]); };
    accounts = createAccounts({ config: CONFIG, db, fetch: fetcher, now: time.now, logger });
    runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true }, clock: time.clock, fetcher, integrations: KEYS, accounts });
    runtime.services.channelEdits = new ChannelEdits({ now: time.now, setTimer: time.clock.setTimer, clearTimer: time.clock.clearTimer });
    guild = fakeGuild({ id: '111111111111111111' });
    channel = guild.addChannel({ name: 'announcements' });
    counter = guild.addChannel({ name: 'counter' });
    runtime.attachClient(guild.client);
  });
  afterEach(() => resetLimits());

  const run = async (ms) => { await time.advance(ms); await runtime.watchers.idle(); await settle(); };
  const crawl = async (minutes) => { for (let i = 0; i < minutes; i += 1) { await time.advance(MIN); await runtime.watchers.idle(); } await settle(); };
  const connect = async (provider) => { await accounts.complete(G(), provider, 'u1', 'good-code'); runtime.loadGuild(G()); };
  const install = (type, data, content, name = 'Alert') => {
    const flow = db.createFlow({ guildId: G(), name, graph: { nodes: [node('t', type, data), node('m', 'action.message.send', { target: 'channel', channelId: channel.id, content })], edges: [edge('t', 'm')] } });
    runtime.loadGuild(G());
    return flow;
  };
  const installTemplate = (id) => {
    const t = TEMPLATES.find((x) => x.id === id).build();
    t.nodes.find((x) => x.id === 'u1').data.channelId = counter.id; // the one thing the person using the template picks
    db.createFlow({ guildId: G(), name: id, graph: t });
    runtime.loadGuild(G());
  };

  describe('Twitch followers', () => {
    const say = '{{twitch.name}} ({{twitch.login}}): +{{twitch.gained}} = {{twitch.followers}} (was {{twitch.previous}}, change {{twitch.change}}) {{twitch.url}}';
    const watch = (data = {}, name) => install('trigger.twitch.followers', { minutes: 5, ...data }, say, name);

    it('does nothing — and says why in the log — until a Twitch account is connected, then starts at once', async () => {
      watch();
      await run(MIN);
      assert.equal(net.calls.length, 0, 'no request without an account');
      assert.ok(logs().some((l) => /is not active: Connect a Twitch account first/.test(l)), logs().join('\n'));
      await connect('twitch');
      await run(MIN);
      assert.equal(asked('/helix/channels/followers').length, 1);
    });

    it('notes the count when switched on, then runs for each rise with how many were gained', async () => {
      await connect('twitch');
      watch();
      await run(MIN);
      assert.deepEqual(said(), [], 'the followers that are already there are not announced');
      assert.ok(logs().some((l) => /^info: Now watching Twitch “Streamer”: 100 followers\. It will run each time the count goes up\./.test(l)), logs().join('\n'));
      net.state.twitch.followers = 103;
      await crawl(5);
      assert.deepEqual(said(), ['Streamer (streamer): +3 = 103 (was 100, change 3) https://www.twitch.tv/streamer']);
      await crawl(5);
      assert.equal(said().length, 1, 'nothing new, nothing said');
      net.state.twitch.followers = 104;
      await crawl(5);
      assert.equal(said().at(-1), 'Streamer (streamer): +1 = 104 (was 103, change 1) https://www.twitch.tv/streamer');
    });

    it('asks Twitch the right way: the connected channel\'s id, the creator\'s token, the operator\'s client id, as often as it was told to', async () => {
      await connect('twitch');
      watch({ minutes: 5 });
      await crawl(12);
      const calls = asked('/helix/channels/followers');
      assert.equal(calls.length, 3, 'once at the start, then every 5 minutes');
      assert.deepEqual(calls[0].query, { broadcaster_id: '555', first: '1' });
      assert.equal(calls[0].headers['client-id'], 'tw-id');
      assert.ok(net.live.twitch.has(calls[0].headers.authorization.replace('Bearer ', '')), 'with a token that Twitch gave');
      assert.ok(!calls[0].url.includes('tw-secret'), 'the secret is never sent to the API');
    });

    it('a fall is remembered but does not run a “gain” flow; the next rise does', async () => {
      await connect('twitch');
      watch();
      await run(MIN);
      net.state.twitch.followers = 90;
      await crawl(5);
      assert.deepEqual(said(), []);
      net.state.twitch.followers = 92;
      await crawl(5);
      assert.deepEqual(said(), ['Streamer (streamer): +2 = 92 (was 90, change 2) https://www.twitch.tv/streamer']);
    });

    it('one look per server however many flows use it, and each flow keeps its own memory', async () => {
      await connect('twitch');
      watch({}, 'First');
      await run(MIN);
      net.state.twitch.followers = 105;
      await crawl(5);
      assert.equal(said().length, 1);
      watch({}, 'Second'); // switched on later: it has not seen the earlier count
      net.calls.length = 0;
      await crawl(5);
      assert.equal(asked('/helix/channels/followers').length, 1, 'one request for both flows');
      net.state.twitch.followers = 106;
      await crawl(5);
      assert.equal(said().length, 3, 'First: 105→106 and Second: noted 105, then 106');
    });

    it('renews the token by itself, for as long as the flow runs', async () => {
      await connect('twitch');
      watch({ minutes: 30 });
      await crawl(30);
      assert.equal(net.state.twitch.refreshes, 0, 'half an hour in, the token still has plenty of time');
      await crawl(33);
      assert.equal(net.state.twitch.refreshes, 1, 'the hour-long token was renewed once, shortly before it ended');
      net.state.twitch.followers = 120;
      await crawl(30);
      assert.equal(said().length, 1, 'and the count was still read');
    });

    it('when Twitch refuses the token once, it takes a fresh one and goes on', async () => {
      await connect('twitch');
      watch();
      await run(MIN);
      net.live.twitch.clear(); // revoked behind our back: the saved token is dead, the refresh token is not
      net.state.twitch.followers = 110;
      await crawl(5);
      assert.deepEqual(said(), ['Streamer (streamer): +10 = 110 (was 100, change 10) https://www.twitch.tv/streamer']);
      assert.equal(accounts.flags(G()).twitch, true);
    });

    it('when Twitch keeps refusing, the account is marked “connect again”, the log says so, and the bot stops asking', async () => {
      await connect('twitch');
      watch();
      await run(MIN);
      net.state.twitch.rejectAccess = true;
      await crawl(5);
      assert.equal(db.getAccount(G(), 'twitch').status, 'expired');
      assert.ok(logs().some((l) => /warn: .*Twitch.* must be connected again/.test(l)), logs().join('\n'));
      assert.ok(logs().some((l) => /could not be read: Twitch no longer accepts this connection/.test(l)), logs().join('\n'));
      const before = asked('/helix/channels/followers').length;
      await crawl(30);
      assert.equal(asked('/helix/channels/followers').length, before, 'nothing more is asked of Twitch');
      // connecting again brings it back
      net.state.twitch.rejectAccess = false;
      net.state.twitch.followers = 150;
      await connect('twitch');
      await crawl(5);
      assert.equal(said().at(-1), 'Streamer (streamer): +50 = 150 (was 100, change 50) https://www.twitch.tv/streamer');
    });

    it('when Twitch does not allow reading the followers (403), it says so and marks the account', async () => {
      await connect('twitch');
      watch();
      net.state.twitch.status = 403;
      await run(MIN);
      assert.equal(db.getAccount(G(), 'twitch').status, 'expired');
      assert.ok(logs().some((l) => /Twitch did not allow reading the followers/.test(l)), logs().join('\n'));
    });

    it('a busy Twitch (429) or a broken one is only a hiccup: tried again later, the account stays', async () => {
      await connect('twitch');
      watch();
      net.state.twitch.status = 429;
      await run(MIN);
      assert.ok(logs().some((l) => /asking too often \(429\)/.test(l)));
      net.state.twitch.status = 500;
      await crawl(30);
      assert.ok(logs().some((l) => /answered with an error \(500\)/.test(l)));
      assert.equal(db.getAccount(G(), 'twitch').status, 'ok');
      net.state.twitch.status = null;
      await crawl(400);
      assert.ok(logs().some((l) => /can be read again/.test(l)), logs().join('\n'));
    });

    it('disconnecting stops it at once', async () => {
      await connect('twitch');
      watch();
      await run(MIN);
      await accounts.disconnect(G(), 'twitch');
      runtime.loadGuild(G());
      net.calls.length = 0;
      net.state.twitch.followers = 500;
      await crawl(10);
      assert.equal(net.calls.length, 0);
      assert.deepEqual(said(), []);
    });

    it('a server only ever sees its own account', async () => {
      const g2 = fakeGuild({ id: '222222222222222222' });
      guild.client.guilds.cache.set(g2.id, g2);
      await connect('twitch');
      watch();
      db.createFlow({ guildId: g2.id, name: 'Other', graph: { nodes: [node('t', 'trigger.twitch.followers', { minutes: 5 }), node('m', 'action.message.send', { target: 'channel', channelId: g2.addChannel({ name: 'x' }).id, content: 'x' })], edges: [edge('t', 'm')] } });
      runtime.loadGuild(g2.id);
      await run(MIN);
      assert.ok(logger.recent(g2.id, 20).some((l) => /Connect a Twitch account first/.test(l.message)), 'the other server has nothing connected');
      assert.equal(asked('/helix/channels/followers').length, 1, 'only this server\'s account was looked at');
    });

    it('the live counter starter flow renames a channel at once, then on every change, with the number formatted', async () => {
      await connect('twitch');
      installTemplate('twitch-counter');
      await run(MIN);
      assert.deepEqual(renames(), ['💜 Followers: 100']);
      net.state.twitch.followers = 1234;
      await crawl(5);
      assert.deepEqual(renames(), ['💜 Followers: 100', '💜 Followers: 1,234']);
      await crawl(5);
      assert.equal(renames().length, 2, 'no change, no rename');
      net.state.twitch.followers = 1200; // a fall counts too, for a counter
      await crawl(10 * 5);
      assert.equal(renames().at(-1), '💜 Followers: 1,200');
    });
  });

  describe('TikTok followers', () => {
    const say = '{{tiktok.name}}: +{{tiktok.gained}} = {{tiktok.followers}} (was {{tiktok.previous}}, change {{tiktok.change}})';
    const watch = (data = {}) => install('trigger.tiktok.followers', { minutes: 15, ...data }, say);

    it('does nothing until a TikTok account is connected', async () => {
      watch();
      await run(MIN);
      assert.equal(net.calls.length, 0);
      assert.ok(logs().some((l) => /is not active: Connect a TikTok account first/.test(l)));
    });

    it('notes the count, then runs for each rise with how many were gained', async () => {
      await connect('tiktok');
      watch();
      await run(MIN);
      assert.deepEqual(said(), []);
      assert.ok(logs().some((l) => /Now watching TikTok “Dancer”: 2,000 followers/.test(l)), logs().join('\n'));
      net.state.tiktok.followers = 2042;
      await crawl(15);
      assert.deepEqual(said(), ['Dancer: +42 = 2042 (was 2000, change 42)']);
    });

    it('asks TikTok the right way: the follower count and name, with the creator\'s token, every 15 minutes', async () => {
      await connect('tiktok');
      watch();
      await crawl(31);
      const calls = asked('/v2/user/info/').filter((c) => c.query.fields.includes('follower_count'));
      assert.equal(calls.length, 3);
      assert.equal(calls[0].query.fields, 'open_id,display_name,follower_count');
      assert.ok(net.live.tiktok.has(calls[0].headers.authorization.replace('Bearer ', '')));
      assert.ok(!calls[0].url.includes('tt-secret'));
    });

    it('renews the day-long token by itself', async () => {
      await connect('tiktok');
      watch({ minutes: 60 });
      await crawl(60 * 24 + 1);
      assert.equal(net.state.tiktok.refreshes, 1);
      net.state.tiktok.followers = 2100;
      await crawl(60);
      assert.equal(said().length, 1);
    });

    it('when TikTok keeps refusing the token, or no longer allows the stats, the account is marked “connect again”', async () => {
      await connect('tiktok');
      watch();
      await run(MIN);
      net.state.tiktok.rejectAccess = true;
      await crawl(15);
      assert.equal(db.getAccount(G(), 'tiktok').status, 'expired');
      assert.ok(logs().some((l) => /TikTok no longer accepts this connection/.test(l)), logs().join('\n'));

      net.state.tiktok.rejectAccess = false;
      await connect('tiktok');
      net.state.tiktok.errorCode = 'scope_not_authorized';
      await crawl(15 * 3);
      assert.equal(db.getAccount(G(), 'tiktok').status, 'expired');
      assert.ok(logs().some((l) => /TikTok did not allow reading the follower count/.test(l)), logs().join('\n'));
    });

    it('a busy or broken TikTok is only a hiccup', async () => {
      await connect('tiktok');
      watch();
      net.state.tiktok.errorCode = 'rate_limit_exceeded';
      await run(MIN);
      assert.ok(logs().some((l) => /TikTok says the bot is asking too often/.test(l)));
      net.state.tiktok.errorCode = null;
      net.state.tiktok.status = 500;
      await crawl(60);
      assert.ok(logs().some((l) => /TikTok answered with an error/.test(l)));
      assert.equal(db.getAccount(G(), 'tiktok').status, 'ok');
    });

    it('the live counter starter flow renames a channel at once and on every change', async () => {
      await connect('tiktok');
      installTemplate('tiktok-counter');
      await run(MIN);
      assert.deepEqual(renames(), ['🎵 Followers: 2,000']);
      net.state.tiktok.followers = 8765;
      await crawl(15);
      assert.deepEqual(renames(), ['🎵 Followers: 2,000', '🎵 Followers: 8,765']);
    });
  });

  describe('YouTube subscribers gained', () => {
    const say = '{{youtube.channelTitle}}: +{{youtube.gained}} = {{youtube.subscribers}} (was {{youtube.previous}}, change {{youtube.change}}) {{youtube.url}}';
    const watch = (data = {}, name) => install('trigger.youtube.gained', { channel: UC, minutes: 30, ...data }, say, name);
    const setCount = (n, hidden = false) => { yt = (url) => { ytCalls.push(url); return ytAnswer([UC, 'Sam Plays', n, hidden]); }; };

    it('notes the count, then runs for each rise with how many were gained', async () => {
      setCount(250);
      watch();
      await run(MIN);
      assert.deepEqual(said(), []);
      assert.ok(logs().some((l) => /Now watching “Sam Plays”: 250 subscribers\. It will run each time the count goes up\./.test(l)), logs().join('\n'));
      setCount(262);
      await crawl(30);
      assert.deepEqual(said(), [`Sam Plays: +12 = 262 (was 250, change 12) https://www.youtube.com/channel/${UC}`]);
    });

    it('uses the operator\'s API key, one request for every watching flow, and no more often than asked', async () => {
      setCount(250);
      watch({}, 'One');
      watch({}, 'Two');
      await crawl(61);
      assert.equal(ytCalls.length, 3, 'at the start and every 30 minutes, for both flows together');
      assert.ok(ytCalls[0].includes('key=yt-key') && ytCalls[0].includes(`id=${UC}`));
    });

    it('does not disturb the milestone trigger watching the same channel', async () => {
      setCount(990);
      watch({}, 'Gains');
      install('trigger.youtube.subscribers', { channel: UC, step: 1000, minutes: 30 }, 'Milestone {{youtube.milestone}}', 'Milestones');
      await run(MIN);
      setCount(1010);
      await crawl(30);
      assert.deepEqual(said().sort(), [`Milestone 1000`, `Sam Plays: +20 = 1010 (was 990, change 20) https://www.youtube.com/channel/${UC}`].sort());
    });

    it('a hidden count is said once, and watching goes on when it is shown again', async () => {
      setCount(0, true);
      watch();
      await crawl(61);
      assert.equal(logs().filter((l) => /hides its subscriber count/.test(l)).length, 1);
      setCount(300);
      await crawl(30);
      assert.deepEqual(said(), [], 'the first count it can see is only noted');
      setCount(305);
      await crawl(30);
      assert.equal(said().length, 1);
    });

    it('“every change” makes a counter: right at once, up and down', async () => {
      setCount(12_300);
      installTemplate('youtube-counter');
      const flow = db.listFlows(G()).find((f) => f.name === 'youtube-counter');
      flow.graph.nodes.find((n) => n.id === 't1').data.channel = UC;
      db.updateFlow?.(G(), flow.id, { graph: flow.graph });
      runtime.loadGuild(G());
      await run(MIN);
      assert.deepEqual(renames(), ['▶️ Subscribers: 12,300']);
      setCount(12_400);
      await crawl(30);
      assert.deepEqual(renames(), ['▶️ Subscribers: 12,300', '▶️ Subscribers: 12,400']);
    });
  });
});

describe('the counter starter flows', () => {
  const ALL = { youtube: true, twitch: true, tiktok: true };
  const intents = { members: true, messageContent: true };

  it('are offered, described, and only need what the description says', () => {
    for (const [id, provider] of [['youtube-counter', 'YouTube'], ['twitch-counter', 'Twitch'], ['tiktok-counter', 'TikTok']]) {
      const t = TEMPLATES.find((x) => x.id === id);
      assert.ok(t, `${id} is in the list`);
      assert.match(t.description, new RegExp(provider));
      const graph = t.build();
      assert.equal(hasStructureErrors(validateFlow(normalizeGraph(graph))), false, `${id} can be saved`);
      const trigger = graph.nodes.find((n) => n.id === 't1');
      assert.equal(trigger.data.fire, 'change', `${id} is a counter: it runs on every change`);
      const update = graph.nodes.find((n) => n.id === 'u1');
      assert.equal(update.type, 'action.channel.update');
      assert.match(update.data.name, /\| commas/);
      const left = validateFlow(normalizeGraph(graph), { intents, integrations: ALL, accounts: { twitch: true, tiktok: true } }).filter((i) => i.level === 'error').map((i) => i.nodeId);
      assert.ok(left.every((id2) => id2 === 't1' || id2 === 'u1'), `${id}: only the channel to rename${id === 'youtube-counter' ? ' and the YouTube channel are' : ' is'} left to fill in`);
    }
  });

  it('the Twitch and TikTok ones wait for an account, the YouTube one does not', () => {
    const errorsOf = (id) => validateFlow(normalizeGraph(TEMPLATES.find((x) => x.id === id).build()), { intents, integrations: ALL, accounts: { twitch: false, tiktok: false } }).filter((i) => i.nodeId === 't1' && i.kind === 'intent');
    assert.equal(errorsOf('twitch-counter').length, 1);
    assert.equal(errorsOf('tiktok-counter').length, 1);
    assert.equal(errorsOf('youtube-counter').length, 0);
  });
});
