// "YouTube Subscribers" and "Twitch Channel Live": triggers that use a platform's own API with the bot operator's keys. Through the real Runtime, on a
// fake clock, with a pretend network and a fake Discord — and through the real Express app for what the editor is told.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NODE_TYPES } from '../shared/catalog.js';
import { resetLimits } from '../shared/limits.js';
import { FeedSettingError } from '../shared/feeds.js';
import { INTEGRATIONS, integrationFlags, twitchLogin, twitchSettings, youtubeSettings } from '../shared/platforms.js';
import { validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { fakeClock } from './helpers/clock.js';
import { edge, fakeGuild, node } from './helpers/fakes.js';
import { A, startHarness } from './helpers/harness.js';

const MIN = 60_000;
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const problem = (fn) => { try { fn(); return ''; } catch (e) { assert.ok(e instanceof FeedSettingError, `not a FeedSettingError: ${e?.stack}`); return e.message; } };
const UC_A = `UC${'a'.repeat(22)}`;
const UC_B = `UC${'b'.repeat(22)}`;
const KEYS = { youtube: 'SECRET-YT-KEY', twitch: { clientId: 'twitch-id', clientSecret: 'SECRET-TWITCH-SECRET' } };

describe('the settings of the platform triggers', () => {
  it('YouTube: a channel, a whole-number step and an interval that respects YouTube\'s allowance', () => {
    assert.deepEqual(youtubeSettings({ channel: UC_A, step: 1000, minutes: 60 }), { channelId: UC_A, step: 1000, everyMs: 60 * MIN });
    assert.equal(youtubeSettings({ channel: `https://www.youtube.com/channel/${UC_A}`, step: '500', minutes: '15' }).channelId, UC_A, 'a link, and numbers typed as text');
    assert.match(problem(() => youtubeSettings({ channel: '@name', step: 1000, minutes: 60 })), /starts with UC/);
    for (const step of [0, -5, 1.5, '', 'many', undefined]) assert.match(problem(() => youtubeSettings({ channel: UC_A, step, minutes: 60 })), /whole number, 1 or more/, String(step));
    for (const minutes of [1, 14, 0, '', undefined]) assert.match(problem(() => youtubeSettings({ channel: UC_A, step: 100, minutes })), /no more often than every 15 minutes/, String(minutes));
  });

  it('Twitch: a channel name from a name, @name or a link', () => {
    for (const v of ['Shroud', '@shroud', ' shroud ', 'https://www.twitch.tv/Shroud', 'twitch.tv/shroud/', 'https://m.twitch.tv/shroud?ref=x', 'https://twitch.tv/shroud/videos']) assert.equal(twitchLogin(v), 'shroud', v);
    for (const v of ['', 'ab', 'a b c', 'x'.repeat(26), 'name!', 'https://evil.example/shroud', '../etc']) assert.match(problem(() => twitchLogin(v)), /Twitch channel name/, v);
    assert.deepEqual(twitchSettings({ login: 'Shroud', minutes: 2 }), { login: 'shroud', everyMs: 2 * MIN });
    assert.match(problem(() => twitchSettings({ login: 'shroud', minutes: 0 })), /no more often than every 1 minute/);
  });

  it('which platforms are set up, as plain yes/no', () => {
    assert.deepEqual(integrationFlags(KEYS), { youtube: true, twitch: true });
    assert.deepEqual(integrationFlags({}), { youtube: false, twitch: false });
    assert.deepEqual(integrationFlags(undefined), { youtube: false, twitch: false });
    assert.deepEqual(integrationFlags({ youtube: '', twitch: { clientId: 'x', clientSecret: '' } }), { youtube: false, twitch: false }, 'half a Twitch application is not one');
  });

  it('a trigger that needs a platform is an error until the operator has set it up', () => {
    const graph = { nodes: [node('y', 'trigger.youtube.subscribers', { channel: UC_A, step: 1000 }), node('t', 'trigger.twitch.live', { login: 'shroud' })], edges: [] };
    const errors = (integrations) => validateFlow(graph, { integrations }).filter((i) => i.level === 'error' && i.kind === 'intent').map((i) => [i.nodeId, i.message]);
    assert.deepEqual(errors({ youtube: false, twitch: false }).map(([id]) => id), ['y', 't']);
    assert.match(errors({ youtube: false, twitch: true })[0][1], /YOUTUBE_API_KEY/);
    assert.match(errors({ youtube: true, twitch: false })[0][1], /TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET/);
    assert.deepEqual(errors({ youtube: true, twitch: true }), []);
    assert.deepEqual(errors(undefined), [], 'nobody said what is set up: nothing to complain about');
    assert.deepEqual(Object.keys(INTEGRATIONS), ['youtube', 'twitch']);
  });

  it('the node settings are checked with the same rules', () => {
    const check = (type, data) => NODE_TYPES[type].check(data);
    assert.deepEqual(check('trigger.youtube.subscribers', { channel: UC_A, step: 1000, minutes: 60 }), []);
    assert.match(check('trigger.youtube.subscribers', { channel: 'nope', step: 1000, minutes: 60 })[0], /starts with UC/);
    assert.deepEqual(check('trigger.twitch.live', { login: 'shroud', minutes: 2 }), []);
    assert.match(check('trigger.twitch.live', { login: '', minutes: 2 })[0], /Twitch channel name/);
  });
});

describe('platform triggers, running', () => {
  let db; let logger; let runtime; let time; let guild; let channel; let net; let calls;
  const said = () => channel.sent.map((p) => p.content);
  const logs = () => logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);

  /** The pretend network: `net(url, options)` answers `{status, text, headers}` (or throws). Every request is remembered in `calls`. */
  const fetcher = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body });
    const answer = await net(url, options);
    const { status = 200, text = '', headers = {} } = answer ?? { status: 404, text: 'nope' };
    return { status, headers: new Headers(headers), text, body: Buffer.from(text) };
  };
  const json = (body, status = 200) => ({ status, text: JSON.stringify(body) });

  const boot = (options = {}) => {
    resetLimits();
    db ??= new Database(':memory:');
    logger = new Logger({ console: false });
    time = fakeClock(utc(2026, 9, 30, 10, 0, 20));
    runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true }, clock: time.clock, fetcher, integrations: KEYS, ...options });
    guild = fakeGuild({ id: '111111111111111111' });
    channel = guild.addChannel({ name: 'announcements' });
    runtime.attachClient(guild.client);
  };
  beforeEach(() => { db = null; net = () => null; calls = []; boot(); });
  afterEach(() => resetLimits());

  const run = async (ms) => { await time.advance(ms); await runtime.watchers.idle(); await settle(); };
  /** Time passing minute by minute, the way it really does (each round of looking finishes before the next minute comes). */
  const crawl = async (minutes) => { for (let i = 0; i < minutes; i += 1) { await time.advance(MIN); await runtime.watchers.idle(); } await settle(); };
  const install = (type, data, { g = guild, ch = channel, name = 'Alert', content } = {}) => {
    const flow = db.createFlow({
      guildId: g.id, name,
      graph: { nodes: [node('t', type, data), node('m', 'action.message.send', { target: 'channel', channelId: ch.id, content })], edges: [edge('t', 'm')] },
    });
    runtime.loadGuild(g.id);
    return flow;
  };
  const other = () => { const g = fakeGuild({ id: '222222222222222222' }); const ch = g.addChannel({ name: 'news' }); guild.client.guilds.cache.set(g.id, g); return { g, ch }; };

  // ---- YouTube -------------------------------------------------------------------------------------------------------------------------
  describe('YouTube subscribers', () => {
    const say = '{{youtube.channelTitle}}: {{youtube.milestone}} (now {{youtube.subscribers}}, was {{youtube.previous}}) {{youtube.url}} {{youtube.channelId}}';
    const yt = (...rows) => json({ items: rows.map(([id, title, subs, hidden]) => ({ id, snippet: { title }, statistics: { subscriberCount: String(subs ?? 0), hiddenSubscriberCount: Boolean(hidden) } })) });
    const idsIn = (url) => new URL(url).searchParams.get('id').split(',');
    const watch = (data = {}, over = {}) => install('trigger.youtube.subscribers', { channel: UC_A, step: 1000, minutes: 60, ...data }, { content: say, ...over });
    const setCount = (n, hidden = false) => { net = () => yt([UC_A, 'Sam Plays', n, hidden]); };

    it('notes the count when switched on, then announces each new milestone once, with the details', async () => {
      setCount(9420);
      watch();
      await run(MIN);
      assert.deepEqual(said(), [], 'nothing for a count that is already there');
      assert.ok(logs().some((l) => /^info: Now watching “Sam Plays”: 9,420 subscribers\. It will be announced at every 1,000 \(next: 10,000\)\./.test(l)), logs().join('\n'));
      setCount(9990);
      await run(60 * MIN);
      assert.deepEqual(said(), []);
      setCount(10_050);
      await run(60 * MIN);
      assert.deepEqual(said(), [`Sam Plays: 10000 (now 10050, was 9990) https://www.youtube.com/channel/${UC_A} ${UC_A}`]);
      setCount(10_900);
      await run(60 * MIN);
      assert.equal(said().length, 1, 'still the same milestone');
    });

    it('a count that dips and recovers does not announce the same milestone twice, and a big jump is announced once, at the highest', async () => {
      setCount(10_100);
      watch();
      await run(MIN);
      setCount(9_990);
      await run(60 * MIN);
      setCount(10_010);
      await run(60 * MIN);
      assert.deepEqual(said(), [], '10,000 was already reached before it was switched on');
      setCount(13_500);
      await run(60 * MIN);
      assert.deepEqual(said().map((m) => /: (\d+) \(now/.exec(m)[1]), ['13000'], 'one message, for 13,000');
      setCount(20_500);
      await run(60 * MIN);
      assert.equal(said().length, 2, 'and 20,000 is the next');
    });

    it('starts again from the current count when the step is changed', async () => {
      setCount(9_400);
      const flow = watch({ step: 1000 });
      await run(MIN);
      const graph = structuredClone(db.getFlow(guild.id, flow.id).graph);
      graph.nodes.find((n) => n.id === 't').data.step = 500;
      db.updateFlow(guild.id, flow.id, { graph });
      runtime.loadGuild(guild.id);
      await run(60 * MIN);
      assert.deepEqual(said(), [], 'the new step starts from what is there now');
      assert.ok(logs().some((l) => /every 500 \(next: 9,500\)/.test(l)), logs().join('\n'));
      setCount(9_520);
      await run(60 * MIN);
      assert.equal(said().length, 1);
    });

    it('a channel that hides its count says so once, announces nothing, and goes on working when it shows it again', async () => {
      setCount(0, true);
      watch();
      await run(MIN);
      await run(60 * MIN);
      await run(60 * MIN);
      assert.deepEqual(said(), []);
      assert.equal(logs().filter((l) => /hides its subscriber count/.test(l)).length, 1, 'said once, not every hour');
      setCount(4_300);
      await run(60 * MIN);
      assert.deepEqual(said(), [], 'the first count seen is only noted');
      setCount(5_100);
      await run(60 * MIN);
      assert.equal(said().length, 1);
      assert.match(said()[0], /: 5000 \(now 5100, was 4300\)/);
    });

    it('a milestone reached while the count was hidden is announced when it shows again', async () => {
      setCount(4_900);
      watch();
      await run(MIN);
      setCount(0, true);
      await run(60 * MIN);
      setCount(5_200);
      await run(60 * MIN);
      assert.equal(said().length, 1);
      assert.match(said()[0], /: 5000 \(now 5200, was 4900\)/);
    });

    it('asks YouTube once for every channel being watched, whichever server watches them (and 50 at a time)', async () => {
      const { g, ch } = other();
      net = (url) => yt(...idsIn(url).map((id) => [id, `Channel ${id.slice(2, 4)}`, 500]));
      watch({ channel: UC_A }, { name: 'One' });
      watch({ channel: UC_A }, { name: 'Same channel' });
      watch({ channel: UC_B }, { name: 'Two' });
      watch({ channel: UC_A }, { g, ch, name: 'Other server' });
      await run(MIN);
      assert.equal(calls.length, 1, 'four flows, two channels, one request');
      assert.deepEqual(idsIn(calls[0].url).sort(), [UC_A, UC_B]);
      assert.match(calls[0].url, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/channels\?part=snippet,statistics&maxResults=50&id=/);
      assert.ok(calls[0].url.includes('key=SECRET-YT-KEY'), 'the key travels to YouTube, only');
    });

    it('splits a big round into requests of 50 channels', async () => {
      net = (url) => yt(...idsIn(url).map((id) => [id, 'X', 10]));
      for (let i = 0; i < 51; i += 1) watch({ channel: `UC${String(i).padStart(22, '0')}` }, { name: `Flow ${i}` });
      await run(MIN);
      assert.deepEqual(calls.map((c) => idsIn(c.url).length).sort((a, b) => a - b), [1, 50]);
    });

    it('looks about as often as asked and the operator\'s key never shows in the log', async () => {
      setCount(500);
      watch({ minutes: 30 });
      await run(95 * MIN);
      assert.equal(calls.length, 4, 'minute 1, then every 30 minutes');
      net = () => json({ error: { errors: [{ reason: 'keyInvalid' }], message: 'API key not valid: SECRET-YT-KEY' } }, 400);
      await run(4 * 60 * MIN);
      assert.ok(logs().some((l) => /YouTube refused the bot operator’s API key\./.test(l)), logs().join('\n'));
      assert.ok(!logs().join('\n').includes('SECRET-YT-KEY'));
    });

    it('explains what YouTube said when it is not a normal answer', async () => {
      const cases = [
        [json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403), /daily limit for this bot is used up/],
        [json({ error: { errors: [{ reason: 'accessNotConfigured' }] } }, 403), /does not have the YouTube Data API switched on/],
        [{ status: 500, text: 'oops' }, /YouTube answered with an error \(500\)/],
        [{ status: 200, text: '<html>not json</html>' }, /answer could not be read/],
        [yt(), /channel was not found/],
      ];
      for (const [answer, message] of cases) {
        db = null; calls = []; boot();
        net = () => answer;
        watch();
        await run(MIN);
        assert.ok(logs().some((l) => new RegExp(`^warn: “YouTube ${UC_A}” could not be read: .*${message.source}`).test(l)), `${message}\n${logs().join('\n')}`);
        assert.deepEqual(said(), []);
      }
    });

    it('is not active when the operator has not set up a YouTube key (and never touches the network)', async () => {
      db = null; boot({ integrations: { youtube: '', twitch: KEYS.twitch } });
      watch();
      await run(5 * MIN);
      assert.equal(calls.length, 0);
      assert.ok(logs().some((l) => /^warn: “YouTube Subscribers” in “Alert” is not active: This trigger needs a YouTube API key \(YOUTUBE_API_KEY\)/.test(l)), logs().join('\n'));
    });

    it('a channel that is not a channel ID is not watched, and the flow shows why', async () => {
      watch({ channel: '@somebody' });
      await run(5 * MIN);
      assert.equal(calls.length, 0);
      assert.equal(runtime.watchers.size, 0);
    });
  });

  // ---- Twitch --------------------------------------------------------------------------------------------------------------------------
  describe('Twitch channel live', () => {
    const say = '{{twitch.user}} is live: {{twitch.title}} — {{twitch.game}} ({{twitch.viewers}}) {{twitch.url}} {{twitch.thumbnail}} {{twitch.started}} #{{twitch.id}} {{twitch.login}}';
    const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
    let live; let tokenCalls; let token; let tokenAnswer; let expiresIn; let streamStatus;
    const stream = (login, over = {}) => ({
      id: `9${login.length}00`, user_login: login, user_name: login[0].toUpperCase() + login.slice(1), type: 'live', title: 'Speedrun time', game_name: 'Celeste', viewer_count: 321,
      started_at: '2026-09-30T10:05:00Z', thumbnail_url: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-{width}x{height}.jpg`, ...over,
    });
    beforeEach(() => {
      live = {}; tokenCalls = 0; token = 'tok1'; tokenAnswer = null; expiresIn = 3600; streamStatus = null;
      net = (url, options) => {
        if (url === TOKEN_URL) { tokenCalls += 1; return tokenAnswer ?? json({ access_token: token, expires_in: expiresIn, token_type: 'bearer' }); }
        const u = new URL(url);
        if (u.origin + u.pathname !== 'https://api.twitch.tv/helix/streams') return null;
        if (streamStatus) return { status: streamStatus, text: '{}' };
        if (options.headers.authorization !== `Bearer ${token}`) return { status: 401, text: '{"message":"Invalid OAuth token"}' };
        return json({ data: u.searchParams.getAll('user_login').map((l) => live[l]).filter(Boolean) });
      };
    });
    const watch = (data = {}, over = {}) => install('trigger.twitch.live', { login: 'shroud', minutes: 2, ...data }, { content: say, ...over });

    it('announces a new broadcast once, with the details — but not one that was already running when it was switched on', async () => {
      live.shroud = stream('shroud', { id: '1' });
      watch();
      await run(MIN);
      assert.deepEqual(said(), [], 'already live: not announced');
      assert.ok(logs().some((l) => /^info: Now watching Twitch channel “shroud” \(live right now — this broadcast is not announced\)/.test(l)), logs().join('\n'));
      await run(10 * MIN);
      assert.deepEqual(said(), [], 'still the same broadcast');
      delete live.shroud;
      await run(10 * MIN);
      live.shroud = stream('shroud', { id: '2' });
      await run(4 * MIN);
      assert.deepEqual(said(), ['Shroud is live: Speedrun time — Celeste (321) https://www.twitch.tv/shroud https://static-cdn.jtvnw.net/previews-ttv/live_user_shroud-1280x720.jpg 2026-09-30T10:05:00Z #2 shroud']);
      await run(30 * MIN);
      assert.equal(said().length, 1, 'once for the broadcast, however long it lasts');
    });

    it('a channel that was offline when switched on is announced when it goes live', async () => {
      watch();
      await run(MIN);
      assert.ok(logs().some((l) => /Now watching Twitch channel “shroud” \(offline\)/.test(l)));
      live.shroud = stream('shroud', { id: '5' });
      await run(2 * MIN);
      assert.equal(said().length, 1);
    });

    it('a stream that drops out and reconnects under the same broadcast id is not announced again', async () => {
      watch();
      await run(MIN);
      live.shroud = stream('shroud', { id: '7' });
      await run(2 * MIN);
      delete live.shroud;
      await run(2 * MIN);
      live.shroud = stream('shroud', { id: '7' });
      await run(2 * MIN);
      assert.equal(said().length, 1);
      delete live.shroud;
      await run(2 * MIN);
      live.shroud = stream('shroud', { id: '8' });
      await run(2 * MIN);
      assert.equal(said().length, 2, 'a genuinely new broadcast is');
    });

    it('a rerun is not a live stream, and a thumbnail that is not https is dropped', async () => {
      watch();
      await run(MIN);
      live.shroud = stream('shroud', { id: '3', type: 'rerun' });
      await run(2 * MIN);
      assert.deepEqual(said(), []);
      live.shroud = stream('shroud', { id: '4', thumbnail_url: 'http://insecure.example/x.jpg' });
      await run(2 * MIN);
      assert.equal(said().length, 1);
      assert.match(said()[0], /\(321\) https:\/\/www\.twitch\.tv\/shroud {2}2026/, 'the picture is left blank');
    });

    it('a title that looks like a template or a mention is just text', async () => {
      watch({}, { content: '{{twitch.title}}' });
      await run(MIN);
      live.shroud = stream('shroud', { id: '6', title: '{{user.name}} @everyone {{guild.name}}' });
      await run(2 * MIN);
      assert.deepEqual(said(), ['{{user.name}} @everyone {{guild.name}}']);
      assert.ok(!(channel.sent[0].allowedMentions?.parse ?? []).includes('everyone'));
    });

    it('takes a channel name in any of the ways people write it', async () => {
      watch({ login: 'https://www.twitch.tv/Shroud' });
      await run(MIN);
      live.shroud = stream('shroud', { id: '1' });
      await run(2 * MIN);
      assert.equal(said().length, 1);
      assert.ok(calls.some((c) => c.url.includes('user_login=shroud')));
    });

    it('asks for an app token once and keeps using it until shortly before it expires', async () => {
      watch();
      await crawl(30);
      assert.equal(calls.filter((c) => c.url.includes('/helix/streams')).length, 15, 'every 2 minutes');
      assert.equal(tokenCalls, 1, 'not a token per check');
      const tokenRequest = calls.find((c) => c.url === TOKEN_URL);
      assert.equal(tokenRequest.method, 'POST');
      const form = new URLSearchParams(tokenRequest.body);
      assert.deepEqual([form.get('client_id'), form.get('client_secret'), form.get('grant_type')], ['twitch-id', 'SECRET-TWITCH-SECRET', 'client_credentials']);
      assert.ok(!tokenRequest.url.includes('SECRET'), 'the secret is in the body, never the address');
      const streamsCall = calls.find((c) => c.url.includes('/helix/streams'));
      assert.deepEqual([streamsCall.headers['client-id'], streamsCall.headers.authorization], ['twitch-id', 'Bearer tok1']);
      await crawl(40);
      assert.equal(tokenCalls, 2, 'a fresh one after the hour');
    });

    it('gets a fresh token once when Twitch says the old one is no good, and carries on', async () => {
      watch();
      await run(MIN);
      token = 'tok2'; // Twitch revoked tok1
      live.shroud = stream('shroud', { id: '9' });
      await run(2 * MIN);
      assert.equal(tokenCalls, 2);
      assert.equal(said().length, 1, 'no announcement lost');
      assert.ok(!logs().some((l) => /could not be read/.test(l)), logs().join('\n'));
    });

    it('says plainly when Twitch refuses the operator\'s application, without repeating itself or leaking the secret', async () => {
      tokenAnswer = json({ status: 400, message: 'invalid client secret SECRET-TWITCH-SECRET' }, 400);
      watch();
      await run(MIN);
      await run(3 * 60 * MIN);
      const warned = logs().filter((l) => /Twitch refused the bot operator’s Client ID or Secret/.test(l));
      assert.equal(warned.length, 1, logs().join('\n'));
      assert.ok(!logs().join('\n').includes('SECRET-TWITCH-SECRET'));
      assert.match(warned[0], /Trying again in \d+ minute/);
      assert.deepEqual(said(), []);
    });

    it('explains the other things that can go wrong', async () => {
      streamStatus = 429;
      watch();
      await run(MIN);
      assert.ok(logs().some((l) => /Twitch says the bot is asking too often \(429\)/.test(l)), logs().join('\n'));
      db = null; calls = []; boot(); streamStatus = 503;
      watch();
      await run(MIN);
      assert.ok(logs().some((l) => /Twitch answered with an error \(503\)/.test(l)), logs().join('\n'));
    });

    it('asks Twitch once for every channel being watched, across servers (and 100 at a time)', async () => {
      const { g, ch } = other();
      watch({ login: 'shroud' }, { name: 'One' });
      watch({ login: 'shroud' }, { name: 'Same' });
      watch({ login: 'ninja' }, { name: 'Two' });
      watch({ login: 'shroud' }, { g, ch, name: 'Other server' });
      await run(MIN);
      const asked = calls.filter((c) => c.url.includes('/helix/streams'));
      assert.equal(asked.length, 1);
      assert.deepEqual(new URL(asked[0].url).searchParams.getAll('user_login').sort(), ['ninja', 'shroud']);
      live.shroud = stream('shroud', { id: '11' });
      await run(2 * MIN);
      assert.equal(said().length, 2, 'both flows in this server');
      assert.equal(ch.sent.length, 1, 'and the other server');
    });

    it('splits a big round into requests of 100 channels', async () => {
      for (let i = 0; i < 101; i += 1) watch({ login: `streamer${String(i).padStart(3, '0')}` }, { name: `Flow ${i}` });
      await run(MIN);
      const sizes = calls.filter((c) => c.url.includes('/helix/streams')).map((c) => new URL(c.url).searchParams.getAll('user_login').length);
      assert.deepEqual(sizes.sort((a, b) => a - b), [1, 100]);
      assert.equal(tokenCalls, 1);
    });

    it('is not active when the operator has not set up a Twitch application', async () => {
      for (const twitch of [{ clientId: '', clientSecret: '' }, { clientId: 'id', clientSecret: '' }]) {
        db = null; calls = []; boot({ integrations: { youtube: KEYS.youtube, twitch } });
        watch();
        await run(5 * MIN);
        assert.equal(calls.length, 0);
        assert.ok(logs().some((l) => /is not active: This trigger needs a Twitch application \(TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET\)/.test(l)), logs().join('\n'));
      }
    });

    it('the memory survives a restart: nothing repeated, and a broadcast that started meanwhile is announced', async () => {
      watch();
      await run(MIN);
      live.shroud = stream('shroud', { id: '20' });
      await run(2 * MIN);
      assert.equal(said().length, 1);
      live.shroud = stream('shroud', { id: '21' }); // the bot is off; a new broadcast starts
      time = fakeClock(utc(2026, 9, 30, 12, 0, 20));
      runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true }, clock: time.clock, fetcher, integrations: KEYS });
      runtime.attachClient(guild.client);
      runtime.loadGuild(guild.id);
      await run(MIN);
      assert.equal(said().length, 2);
      assert.match(said()[1], /#21 shroud$/);
    });
  });
});

describe('what the editor is told about the platforms', () => {
  let h;
  beforeEach(async () => { resetLimits(); h = await startHarness({ config: { integrations: KEYS } }); });
  afterEach(async () => { resetLimits(); await h.close(); });

  it('only whether each is set up — never the keys', async () => {
    const me = await h.call('GET', '/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.meta.integrations, { youtube: true, twitch: true });
    for (const secret of ['SECRET-YT-KEY', 'SECRET-TWITCH-SECRET', 'twitch-id']) assert.ok(!me.text.includes(secret), `${secret} leaked to the browser`);
  });

  it('a platform the operator has not set up is reported as such, and a flow that uses it is shown the problem', async () => {
    await h.close();
    h = await startHarness({ config: { integrations: { youtube: '', twitch: { clientId: '', clientSecret: '' } } } });
    const me = await h.call('GET', '/api/me');
    assert.deepEqual(me.json.meta.integrations, { youtube: false, twitch: false });
    const graph = { nodes: [node('t', 'trigger.twitch.live', { login: 'shroud' })], edges: [] };
    const created = await h.call('POST', `/api/guilds/${A}/flows`, { body: { name: 'Live alert', graph } });
    assert.equal(created.status, 201, created.text);
    const errorsOf = (r) => r.json.flow.issues.filter((i) => i.level === 'error');
    assert.ok(errorsOf(created).some((i) => /Twitch application/.test(i.message)), created.text);
    const saved = await h.call('PUT', `/api/guilds/${A}/flows/${created.json.flow.id}`, { body: { graph } });
    assert.equal(saved.status, 200, 'it can still be saved (it is a warning to the editor, not a refusal)');
    const problems = errorsOf(saved);
    assert.ok(problems.some((i) => /Twitch application/.test(i.message)), saved.text);
  });
});
