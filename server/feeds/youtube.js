// "YouTube subscriber milestone": watches a channel's public subscriber count through YouTube's Data API (one small request looks at up to 50
// channels at once, however many servers watch them) and fires when the count passes the next multiple of N.
//
// YouTube shows (and reports) subscriber counts rounded to three significant figures once a channel has more than 1,000, and a channel may hide
// the count altogether — so this suits milestones that are much bigger than the rounding (every 100 for a small channel, every 10,000 for a big one).
import { youtubeSettings } from '../../shared/platforms.js';

const API = 'https://www.googleapis.com/youtube/v3/channels';
const MAX_IDS = 50;

/** A plain sentence for what YouTube answered when it was not a normal answer. */
function apiError(res) {
  let reason = '';
  try { reason = JSON.parse(res.text)?.error?.errors?.[0]?.reason ?? ''; } catch { /* not JSON */ }
  if (res.status === 400 && /keyInvalid/i.test(reason)) return 'YouTube refused the bot operator’s API key.';
  if (res.status === 403 && /quota|dailyLimit|rateLimit/i.test(reason)) return 'YouTube’s daily limit for this bot is used up; it will try again later.';
  if (res.status === 403 && /accessNotConfigured|forbidden/i.test(reason)) return 'The bot operator’s API key does not have the YouTube Data API switched on.';
  return `YouTube answered with an error (${res.status}).`;
}

/** Looks at up to 50 channels per request; shared by every trigger that reads a channel's subscriber count. */
export async function fetchYoutubeChannels(targets, { fetch, keys }) {
  const out = new Map();
  for (let i = 0; i < targets.length; i += MAX_IDS) {
    const chunk = targets.slice(i, i + MAX_IDS);
    const url = `${API}?part=snippet,statistics&maxResults=${MAX_IDS}&id=${chunk.map((t) => t.key).join(',')}&key=${encodeURIComponent(keys.youtube)}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status !== 200) { for (const t of chunk) out.set(t.key, new Error(apiError(res))); continue; }
    let items;
    try { items = JSON.parse(res.text).items ?? []; } catch { for (const t of chunk) out.set(t.key, new Error('YouTube’s answer could not be read.')); continue; }
    for (const t of chunk) {
      const item = items.find((x) => x?.id === t.key);
      if (!item) { out.set(t.key, new Error('That YouTube channel was not found. Check the channel ID.')); continue; }
      const count = Number(item.statistics?.subscriberCount);
      out.set(t.key, { channel: { id: t.key, title: String(item.snippet?.title ?? '').slice(0, 100), hidden: Boolean(item.statistics?.hiddenSubscriberCount) || !Number.isFinite(count), subscribers: Number.isFinite(count) ? count : null } });
    }
  }
  return out;
}

export const youtubeAdapter = {
  type: 'trigger.youtube.subscribers',

  prepare(settings) {
    const { channelId, step, everyMs } = youtubeSettings(settings);
    return { key: channelId, everyMs, label: `YouTube ${channelId}`, step };
  },

  fetchMany: fetchYoutubeChannels,

  evaluate(state, { channel }, sub) {
    const { step } = sub.plan;
    const name = channel.title || sub.label;
    if (channel.hidden) {
      if (state?.hiddenNoted) return { state, fire: [], log: [] };
      return { state: { ...(state ?? {}), hiddenNoted: true }, fire: [], log: [{ level: 'warn', message: `“${name}” hides its subscriber count, so there is nothing to watch.` }] };
    }
    const count = channel.subscribers;
    const level = Math.floor(count / step) * step;
    if (!state?.baselined || state.step !== step) {
      return {
        state: { baselined: true, step, top: level, count }, fire: [],
        log: [{ level: 'info', message: `Now watching “${name}”: ${count.toLocaleString('en-US')} subscribers. It will be announced at every ${step.toLocaleString('en-US')} (next: ${(level + step).toLocaleString('en-US')}).` }],
      };
    }
    if (level > state.top) {
      return {
        state: { ...state, top: level, count, hiddenNoted: false },
        fire: [{
          label: `YouTube “${name}” reached ${level.toLocaleString('en-US')} subscribers`,
          data: { youtube: { subscribers: count, milestone: level, previous: state.count, channelTitle: name, channelId: channel.id, url: `https://www.youtube.com/channel/${channel.id}` } },
        }],
        log: [],
      };
    }
    // a count that goes down and up again never announces the same milestone twice (`top` only ever rises)
    return { state: count === state.count && !state.hiddenNoted ? state : { ...state, count, hiddenNoted: false }, fire: [], log: [] };
  },
};
