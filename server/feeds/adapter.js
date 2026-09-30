// The "New Feed Item" watcher, in the shape the Watchers service expects of every kind of watcher:
//   prepare(settings)            → { key, everyMs, label }   what to look at and how often (throws a FeedSettingError when the settings are unusable)
//   fetch(target, context)       → result | { unchanged: true }   one look at the outside world (throws an Error with a plain message)
//   evaluate(state, result, sub) → { state, fire: [{ data, label }], log: [{ level, message }] }   what is new since the last look
// `evaluate` is pure: it gets what was remembered and what was seen, and says what to remember next and which runs to start.
import { feedSettings } from '../../shared/feeds.js';
import { parseFeed } from './parse.js';

export const MAX_PER_CHECK = 5; // more new posts than this at once: only the newest few are announced (the rest are still marked as seen)
export const MAX_SEEN = 300; // how many post ids are remembered per watched feed
const ACCEPT = 'application/atom+xml, application/rss+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5';

/** Oldest first, so a burst of posts is announced in the order they were written. */
function oldestFirst(items) {
  const times = items.map((i) => Date.parse(i.published));
  if (times.every(Number.isFinite)) return [...items].sort((a, b) => Date.parse(a.published) - Date.parse(b.published));
  return [...items].reverse(); // no dates to go by: feeds list the newest first
}

export const feedAdapter = {
  type: 'trigger.feed.item',

  prepare(settings, { minMinutes }) {
    const { url, everyMs } = feedSettings(settings, { minMinutes });
    return { key: url, everyMs, label: url };
  },

  async fetch(target, { fetch }) {
    const headers = { accept: ACCEPT };
    if (target.meta.etag) headers['if-none-match'] = target.meta.etag;
    if (target.meta.lastModified) headers['if-modified-since'] = target.meta.lastModified;
    const res = await fetch(target.key, { headers });
    if (res.status === 304) return { unchanged: true };
    if (res.status === 404 || res.status === 410) throw new Error('The feed was not found at that address (404). Check the address.');
    if (res.status === 429) throw new Error('The site says we are asking too often (429).');
    if (res.status >= 400) throw new Error(`The site answered with an error (${res.status}).`);
    const feed = parseFeed(res.text); // a FeedError says what was wrong with it
    target.meta.etag = res.headers.get('etag') ?? '';
    target.meta.lastModified = res.headers.get('last-modified') ?? '';
    return { feed };
  },

  evaluate(state, { feed }, sub) {
    const name = feed.title || sub.label;
    const ids = feed.items.map((i) => i.id);
    if (!state?.baselined || state.url !== sub.key) {
      // the first look only remembers what is already there, so switching a flow on does not announce the whole back catalogue
      return {
        state: { url: sub.key, baselined: true, seen: ids.slice(0, MAX_SEEN) }, fire: [],
        log: [{ level: 'info', message: `Now watching “${name}”. The ${feed.items.length} post(s) already there are not announced; new ones will be.` }],
      };
    }
    const seen = new Set(state.seen);
    const fresh = feed.items.filter((i) => !seen.has(i.id));
    if (!fresh.length) return { state, fire: [], log: [] };
    let announce = oldestFirst(fresh);
    const log = [];
    if (announce.length > MAX_PER_CHECK) {
      log.push({ level: 'warn', message: `“${name}” got ${announce.length} new posts at once; only the newest ${MAX_PER_CHECK} are announced.` });
      announce = announce.slice(-MAX_PER_CHECK);
    }
    const remembered = [...ids, ...state.seen.filter((id) => !ids.includes(id))].slice(0, MAX_SEEN);
    return {
      state: { url: sub.key, baselined: true, seen: remembered },
      fire: announce.map((i) => ({
        label: `Feed “${name}”: ${i.title || i.link || i.id}`.slice(0, 200),
        data: { feed: { id: i.id, title: i.title, link: i.link, author: i.author, summary: i.summary, published: i.published, image: i.image, name } },
      })),
      log,
    };
  },
};
