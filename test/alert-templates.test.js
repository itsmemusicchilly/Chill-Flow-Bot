// The five starter flows for alerts from other platforms: each one is offered, needs only what its description says, and really works when switched on.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resetLimits } from '../shared/limits.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { fakeClock } from './helpers/clock.js';
import { fakeGuild } from './helpers/fakes.js';
import { A, startHarness } from './helpers/harness.js';

const MIN = 60_000;
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const KEYS = { youtube: 'key', twitch: { clientId: 'id', clientSecret: 'secret' } };
const IDS = ['youtube-upload', 'post-announcer', 'twitch-live', 'youtube-milestone', 'webhook-alert'];
const UC = `UC${'a'.repeat(22)}`;

const template = (id) => TEMPLATES.find((t) => t.id === id).build();
const errorsOf = (graph) => validateFlow(normalizeGraph(graph), { intents: { members: true, messageContent: true }, integrations: { youtube: true, twitch: true } }).filter((i) => i.level === 'error');

describe('the alert starter flows', () => {
  it('are offered, described, and valid once the person has said what to watch and where to post', () => {
    for (const id of IDS) {
      const t = TEMPLATES.find((x) => x.id === id);
      assert.ok(t, `${id} is in the list`);
      assert.ok(t.name.length > 3 && t.description.length > 40, id);
      const graph = template(id);
      assert.equal(hasStructureErrors(validateFlow(normalizeGraph(graph))), false, `${id} can be saved`);
      const trigger = graph.nodes.find((x) => x.id === 't1');
      const send = graph.nodes.find((x) => x.id === 'm1');
      const missing = errorsOf(graph).map((i) => i.nodeId);
      assert.ok(missing.every((nodeId) => nodeId === 't1' || nodeId === 'm1'), `${id}: only the trigger's target and the channel are left to fill in`);
      assert.ok(missing.includes('m1'), `${id}: the channel is for the person to pick`);
      // …and once they have, nothing is left
      Object.assign(trigger.data, { channel: UC, subreddit: 'gaming', login: 'shroud' });
      send.data.channelId = '123456789012345678';
      assert.deepEqual(errorsOf(graph), [], id);
    }
  });

  it('each names what the person has to do, and the platforms it needs', () => {
    const say = (id) => TEMPLATES.find((t) => t.id === id).description;
    assert.match(say('youtube-upload'), /channel ID/);
    assert.match(say('post-announcer'), /Mastodon/);
    assert.match(say('twitch-live'), /Twitch application/);
    assert.match(say('youtube-milestone'), /YouTube API key/);
    assert.match(say('webhook-alert'), /secret address/);
  });

  it('every template id is unique', () => {
    const ids = TEMPLATES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('the alert starter flows, running', () => {
  let db; let logger; let runtime; let time; let guild; let channel; let net; let calls;
  const said = () => channel.sent.map((p) => p.content);
  const embed = (i = 0) => channel.sent[i].embeds[0].data;
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    const { status = 200, text = '' } = (await net(url, options)) ?? { status: 404, text: '' };
    return { status, headers: new Headers(), text, body: Buffer.from(text) };
  };
  beforeEach(() => {
    resetLimits();
    db = new Database(':memory:'); logger = new Logger({ console: false }); calls = []; net = () => null;
    time = fakeClock(utc(2026, 9, 30, 10, 0, 20));
    runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true }, clock: time.clock, fetcher, integrations: KEYS });
    guild = fakeGuild({ id: '111111111111111111' });
    channel = guild.addChannel({ name: 'announcements' });
    runtime.attachClient(guild.client);
  });
  afterEach(() => resetLimits());

  const crawl = async (minutes) => { for (let i = 0; i < minutes; i += 1) { await time.advance(MIN); await runtime.watchers.idle(); } await settle(); };
  /** Uses a template the way a person would: says what to watch, picks the channel, saves it, switches it on. */
  const use = (id, trigger = {}) => {
    const graph = template(id);
    Object.assign(graph.nodes.find((x) => x.id === 't1').data, trigger);
    graph.nodes.find((x) => x.id === 'm1').data.channelId = channel.id;
    const flow = db.createFlow({ guildId: guild.id, name: id, graph, enabled: true });
    runtime.loadGuild(guild.id);
    return flow;
  };
  const atom = (title, ...entries) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><title>${title}</title>${entries.join('')}</feed>`;
  const video = (id, name, at) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><title>${name}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><author><name>Sam Plays</name></author><published>${new Date(at).toISOString()}</published><media:group><media:thumbnail url="https://i.ytimg.com/vi/${id}/hqdefault.jpg"/></media:group></entry>`;

  it('YouTube upload announcer: a link for each new video (so Discord shows the player), none for the old ones', async () => {
    const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`;
    net = (url) => (url === feed ? { text: atom('Sam Plays', video('old1', 'Older', utc(2026, 9, 1))) } : null);
    use('youtube-upload', { channel: UC });
    await crawl(2);
    assert.deepEqual(said(), []);
    net = (url) => (url === feed ? { text: atom('Sam Plays', video('new1', 'Big Run', utc(2026, 9, 30, 10, 5)), video('old1', 'Older', utc(2026, 9, 1))) } : null);
    await crawl(15);
    assert.deepEqual(said(), ['📺 **Sam Plays** uploaded a new video!\nhttps://www.youtube.com/watch?v=new1']);
  });

  it('Post announcer: an embed with the title, the text, a link, the picture and where it came from', async () => {
    const feed = 'https://www.reddit.com/r/gaming/new/.rss';
    net = (url) => (url === feed ? { text: atom('gaming') } : null);
    use('post-announcer', { subreddit: 'r/gaming' });
    await crawl(2);
    net = (url) => (url === feed ? { text: atom('gaming', `<entry><id>t3_1</id><title>My setup</title><link href="https://www.reddit.com/r/gaming/comments/1/"/><author><name>/u/sam</name></author><updated>${new Date(utc(2026, 9, 30, 10, 5)).toISOString()}</updated><content type="html">&lt;p&gt;Look at this desk&lt;/p&gt;</content><media:thumbnail url="https://i.redd.it/x.png"/></entry>`) } : null);
    await crawl(15);
    assert.equal(channel.sent.length, 1);
    const data = embed();
    assert.equal(data.title, 'My setup');
    assert.match(data.description, /^Look at this desk\n\n\[Open the post\]\(https:\/\/www\.reddit\.com\/r\/gaming\/comments\/1\/\)$/);
    assert.equal(data.footer.text, 'gaming');
    assert.equal(data.image?.url, 'https://i.redd.it/x.png');
  });

  it('Post announcer: a post without a picture still posts (no broken empty image)', async () => {
    const feed = 'https://bsky.app/profile/alice.bsky.social/rss';
    net = (url) => (url === feed ? { text: '<rss version="2.0"><channel><title>Alice</title></channel></rss>' } : null);
    use('post-announcer', { source: 'bluesky', handle: 'alice.bsky.social' });
    await crawl(2);
    net = (url) => (url === feed ? { text: '<rss version="2.0"><channel><title>Alice</title><item><guid>p1</guid><title>Hello sky</title><link>https://bsky.app/profile/alice.bsky.social/post/p1</link></item></channel></rss>' } : null);
    await crawl(15);
    assert.equal(channel.sent.length, 1, logger.recent(guild.id).map((l) => l.message).join('\n'));
    assert.equal(embed().title, 'Hello sky');
    assert.ok(!embed().image, 'no image at all');
  });

  it('Twitch live alert: title, game and link — once per broadcast', async () => {
    let live = null;
    net = (url) => {
      if (url.startsWith('https://id.twitch.tv/')) return { text: JSON.stringify({ access_token: 't', expires_in: 3600 }) };
      return { text: JSON.stringify({ data: live ? [live] : [] }) };
    };
    use('twitch-live', { login: 'shroud' });
    await crawl(3);
    live = { id: '1', user_login: 'shroud', user_name: 'Shroud', type: 'live', title: 'Ranked grind', game_name: '', viewer_count: 5, started_at: '2026-09-30T10:05:00Z', thumbnail_url: '' };
    await crawl(4);
    assert.deepEqual(said(), ['🔴 **Shroud** is live: **Ranked grind**\nPlaying something fun\nhttps://www.twitch.tv/shroud']);
    await crawl(10);
    assert.equal(said().length, 1);
  });

  it('YouTube subscriber milestone: a celebration with the number written with commas', async () => {
    let subs = 9_990;
    net = () => ({ text: JSON.stringify({ items: [{ id: UC, snippet: { title: 'Sam Plays' }, statistics: { subscriberCount: String(subs) } }] }) });
    use('youtube-milestone', { channel: UC });
    await crawl(2);
    subs = 10_040;
    await crawl(60);
    assert.equal(channel.sent.length, 1);
    assert.equal(embed().title, '🎉 10,000 subscribers!');
    assert.match(embed().description, /^\*\*Sam Plays\*\* just passed \*\*10,000\*\* subscribers\. Thank you all!\nhttps:\/\/www\.youtube\.com\/channel\/UC/);
  });
});

describe('the webhook alert starter flow, running', () => {
  let h; let channel;
  beforeEach(async () => { resetLimits(); h = await startHarness(); });
  afterEach(async () => { resetLimits(); await h.close(); });

  const install = async () => {
    channel = h.guilds[A].addChannel({ name: 'alerts' });
    const graph = template('webhook-alert');
    graph.nodes.find((x) => x.id === 'm1').data.channelId = channel.id;
    const flow = h.db.createFlow({ guildId: A, name: 'Alert', graph, enabled: true });
    h.runtime.loadGuild(A);
    const made = await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/webhook`, { body: { nodeId: 't1' } });
    assert.equal(made.status, 200, made.text);
    return new URL(made.json.url).pathname;
  };
  const post = (path, body) => h.call('POST', path, { sid: null, origin: null, body });

  it('posts what the other tool sent, and has a sensible title when it sent none', async () => {
    const path = await install();
    assert.equal((await post(path, { title: 'New X post', message: 'We shipped it!', url: 'https://x.example/status/1' })).status, 202);
    assert.equal((await post(path, { message: 'No title here' })).status, 202);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(channel.sent.length, 2);
    assert.equal(channel.sent[0].embeds[0].data.title, 'New X post');
    assert.equal(channel.sent[0].embeds[0].data.description, 'We shipped it!\nhttps://x.example/status/1');
    assert.equal(channel.sent[1].embeds[0].data.title, 'New alert');
  });
});
