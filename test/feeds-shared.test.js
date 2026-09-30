// The feed trigger's settings: which address they mean, and whether it is acceptable. Shared by the editor and the server.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FEED_MINUTES, FEED_SOURCES, FeedSettingError, MIN_FEED_MINUTES, feedSettings, feedUrlOf, parsePublicHttpsUrl } from '../shared/feeds.js';

const UC = 'UC1234567890abcdefghijkl';
const problem = (fn) => { try { fn(); return ''; } catch (e) { assert.ok(e instanceof FeedSettingError, `not a FeedSettingError: ${e?.stack}`); return e.message; } };

describe('the address for each ready-made source', () => {
  it('YouTube: a channel ID, or a link that contains one', () => {
    const want = `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`;
    for (const channel of [UC, ` ${UC} `, `https://www.youtube.com/channel/${UC}`, `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`]) assert.equal(feedUrlOf({ source: 'youtube', channel }), want, channel);
    for (const channel of ['@somehandle', '', 'UCshort', 'https://www.youtube.com/@name']) assert.match(problem(() => feedUrlOf({ source: 'youtube', channel })), /starts with UC/, channel);
  });

  it('Reddit: a subreddit name, r/name or a link', () => {
    for (const subreddit of ['gaming', 'r/gaming', '/r/gaming/', 'https://www.reddit.com/r/gaming', 'https://reddit.com/r/gaming/']) assert.equal(feedUrlOf({ source: 'reddit', subreddit }), 'https://www.reddit.com/r/gaming/new/.rss', subreddit);
    for (const subreddit of ['not a sub!', 'a/../b', '', 'x']) assert.match(problem(() => feedUrlOf({ source: 'reddit', subreddit })), /subreddit name/, subreddit);
  });

  it('Bluesky: a handle, @handle or a profile link', () => {
    for (const handle of ['alice.bsky.social', '@alice.bsky.social', 'https://bsky.app/profile/alice.bsky.social', 'https://bsky.app/profile/alice.bsky.social/']) assert.equal(feedUrlOf({ source: 'bluesky', handle }), 'https://bsky.app/profile/alice.bsky.social/rss', handle);
    for (const handle of ['alice', 'a.b/../../x', '', 'a b.c']) assert.match(problem(() => feedUrlOf({ source: 'bluesky', handle })), /Bluesky handle/, handle);
  });

  it('any other address is used as typed (and judged next)', () => {
    assert.equal(feedUrlOf({ source: 'url', url: ' https://blog.example/feed.xml ' }), 'https://blog.example/feed.xml');
    assert.equal(feedUrlOf({ url: 'https://blog.example/x' }), 'https://blog.example/x', 'a node saved without a source means "any address"');
    assert.equal(feedUrlOf({}), '');
  });

  it('only the field of the chosen source matters', () => {
    assert.equal(feedUrlOf({ source: 'reddit', subreddit: 'gaming', url: 'http://bad', channel: 'junk', handle: 'x' }), 'https://www.reddit.com/r/gaming/new/.rss');
  });

  it('the sources offered are the ones understood', () => {
    assert.deepEqual(FEED_SOURCES.map(([id]) => id), ['url', 'youtube', 'reddit', 'bluesky']);
  });
});

describe('a public https address', () => {
  it('accepts ordinary websites', () => {
    for (const ok of ['https://example.com/feed.xml', 'https://www.youtube.com/feeds/videos.xml?channel_id=x', 'https://mastodon.social/@a.rss', 'https://a.b.c.example.co.uk/x?y=1#z']) assert.equal(parsePublicHttpsUrl(ok).href, new URL(ok).href, ok);
  });

  it('refuses the rest, saying why (the same rules the fetcher applies)', () => {
    const bad = [
      ['', /Enter an address/], ['nonsense', /not a valid address/], ['http://example.com/', /Only https/], ['ftp://example.com/', /Only https/], ['javascript:alert(1)', /Only https/],
      ['https://u:p@example.com/', /user name or password/], ['https://example.com:8443/', /standard https port/],
      ['https://127.0.0.1/', /raw IP/], ['https://[::1]/', /raw IP/], ['https://2130706433/', /raw IP/], ['https://0x7f.1/', /raw IP/], ['https://169.254.169.254/', /raw IP/],
      ['https://localhost/', /not a public website name/], ['https://box.local/', /not a public website name/], ['https://intranet/', /not a public website name/], ['https://a.internal/', /not a public website name/],
      [`https://example.com/${'x'.repeat(2100)}`, /too long/],
    ];
    for (const [input, message] of bad) assert.match(problem(() => parsePublicHttpsUrl(input)), message, input.slice(0, 50));
  });
});

describe('what the watcher needs from the settings', () => {
  it('the address and how often, never more often than the floor', () => {
    assert.deepEqual(feedSettings({ source: 'url', url: 'https://blog.example/feed', minutes: 15 }), { url: 'https://blog.example/feed', everyMs: 15 * 60_000 });
    assert.equal(feedSettings({ source: 'url', url: 'https://blog.example/feed', minutes: 15 }, { minMinutes: 30 }).everyMs, 30 * 60_000, 'the operator\'s floor is respected');
    assert.equal(feedSettings({ source: 'url', url: 'https://blog.example/feed', minutes: '20' }).everyMs, 20 * 60_000, 'a number typed as text');
  });

  it('refuses a bad address or an interval that is too short', () => {
    assert.match(problem(() => feedSettings({ source: 'url', url: 'http://x.example/', minutes: 15 })), /Only https/);
    for (const minutes of [1, 4, 0, -5, '', 'soon', undefined, NaN]) assert.match(problem(() => feedSettings({ source: 'url', url: 'https://blog.example/f', minutes })), /no more often than every 5 minutes/, String(minutes));
  });

  it('the defaults are sane', () => {
    assert.ok(DEFAULT_FEED_MINUTES >= MIN_FEED_MINUTES);
    assert.equal(MIN_FEED_MINUTES, 5);
  });
});
