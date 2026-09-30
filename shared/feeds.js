// What a "New Feed Item" trigger is set up with, and the address checks for it. Pure (no Node-only imports), so the editor and the server
// judge an address the same way. The server's guarded fetcher (server/net/safe-fetch.js) applies these rules again, and then more, before connecting.

export const MIN_FEED_MINUTES = 5;
export const DEFAULT_FEED_MINUTES = 15;
export const FEED_SOURCES = [['url', 'Any feed address'], ['youtube', 'YouTube channel'], ['reddit', 'Reddit subreddit'], ['bluesky', 'Bluesky account']];

/** Something wrong with what a person typed in the trigger, worded so it can be shown as it is. */
export class FeedSettingError extends Error {}

const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|home\.arpa)$/i;

/** Checks that `input` is a public https website address, and returns it as a URL. Throws a FeedSettingError that says what is wrong. */
export function parsePublicHttpsUrl(input) {
  const text = String(input ?? '').trim();
  const fail = (m) => { throw new FeedSettingError(m); };
  if (!text) fail('Enter an address (it starts with https://).');
  if (text.length > 2000) fail('That address is too long.');
  let url;
  try { url = new URL(text); } catch { fail(`“${text.slice(0, 80)}” is not a valid address. It should look like https://example.com/feed.xml`); }
  if (url.protocol !== 'https:') fail('Only https:// addresses are allowed.');
  if (url.username || url.password) fail('The address must not contain a user name or password.');
  if (url.port) fail('Only the standard https port is allowed (leave the :port out).');
  const host = url.hostname; // the URL parser has already turned 0x7f.1, 2130706433 and friends into 127.0.0.1
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) fail('Use the website’s name (like example.com), not a raw IP address.');
  if (!host.includes('.') || LOCAL_NAME.test(host)) fail('That is not a public website name.');
  return url;
}

const youtubeUrl = (v) => {
  const id = /(?:channel\/|channel_id=)?(UC[\w-]{22})\b/.exec(v)?.[1];
  if (!id) throw new FeedSettingError('A YouTube channel ID starts with UC and has 24 characters (in YouTube: your channel → About → Share → Copy channel ID).');
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
};
const redditUrl = (v) => {
  const sub = /^(?:https?:\/\/(?:www\.)?reddit\.com)?\/?(?:r\/)?([A-Za-z0-9_]{2,21})\/?$/.exec(v)?.[1];
  if (!sub) throw new FeedSettingError('Enter a subreddit name such as gaming (or r/gaming).');
  return `https://www.reddit.com/r/${sub}/new/.rss`;
};
const blueskyUrl = (v) => {
  const handle = v.replace(/^@/, '').replace(/^https?:\/\/bsky\.app\/profile\//i, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(handle)) throw new FeedSettingError('Enter a Bluesky handle such as name.bsky.social.');
  return `https://bsky.app/profile/${handle}/rss`;
};

/** The feed address for a trigger's settings (`source`, plus `url`, `channel`, `subreddit` or `handle`). Throws a FeedSettingError. */
export function feedUrlOf(d = {}) {
  const say = (k) => String(d[k] ?? '').trim();
  switch (d.source) {
    case 'youtube': return youtubeUrl(say('channel'));
    case 'reddit': return redditUrl(say('subreddit'));
    case 'bluesky': return blueskyUrl(say('handle'));
    default: return say('url');
  }
}

/** The validated address, and how often to look: everything the watcher needs to know from the settings. Throws a FeedSettingError. */
export function feedSettings(d = {}, { minMinutes = MIN_FEED_MINUTES } = {}) {
  const url = parsePublicHttpsUrl(feedUrlOf(d)).href;
  const minutes = Number(d.minutes);
  if (!Number.isFinite(minutes) || minutes < MIN_FEED_MINUTES) throw new FeedSettingError(`Check no more often than every ${MIN_FEED_MINUTES} minutes (the feed's owner will thank you).`);
  return { url, everyMs: Math.max(minMinutes, minutes) * 60_000 };
}
