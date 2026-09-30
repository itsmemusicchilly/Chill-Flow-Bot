// Settings of the triggers that use a platform's own API (YouTube subscribers, Twitch live) — and which of them the bot operator has set up.
// Pure, so the editor and the server read the settings the same way. Every problem is a FeedSettingError worded for the person editing the flow.
import { FeedSettingError, youtubeChannelId } from './feeds.js';

export const MIN_YOUTUBE_MINUTES = 15; // YouTube's API has a daily quota shared by every server; this keeps one flow from eating it
export const DEFAULT_YOUTUBE_MINUTES = 60;
export const MIN_TWITCH_MINUTES = 1;
export const DEFAULT_TWITCH_MINUTES = 2;

/** What a trigger needs the bot operator to have set up in the server's environment (`needs` in the catalog). */
export const INTEGRATIONS = {
  youtube: 'a YouTube API key (YOUTUBE_API_KEY)',
  twitch: 'a Twitch application (TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET)',
};

const minutesOf = (d, min) => {
  const minutes = Number(d.minutes);
  if (!Number.isFinite(minutes) || minutes < min) throw new FeedSettingError(`Check no more often than every ${min} minute${min === 1 ? '' : 's'}.`);
  return minutes;
};

export function youtubeSettings(d = {}) {
  const channelId = youtubeChannelId(String(d.channel ?? '').trim());
  const step = Number(d.step);
  if (!Number.isInteger(step) || step < 1) throw new FeedSettingError('“Every … subscribers” must be a whole number, 1 or more.');
  return { channelId, step, everyMs: minutesOf(d, MIN_YOUTUBE_MINUTES) * 60_000 };
}

/** A Twitch channel name from what was typed: the name, @name, or a twitch.tv link. */
export function twitchLogin(v) {
  const s = String(v ?? '').trim().replace(/^@/, '').replace(/^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\//i, '').replace(/[/?#].*$/, '');
  if (!/^[A-Za-z0-9_]{3,25}$/.test(s)) throw new FeedSettingError('Enter a Twitch channel name such as shroud (letters, numbers and _; or a twitch.tv link).');
  return s.toLowerCase();
}

export function twitchSettings(d = {}, { minMinutes = MIN_TWITCH_MINUTES } = {}) {
  return { login: twitchLogin(d.login), everyMs: Math.max(minMinutes, minutesOf(d, MIN_TWITCH_MINUTES)) * 60_000 };
}

/** Which integrations the bot operator has set up, as the plain yes/no map the editor is given (never the keys themselves). */
export function integrationFlags(integrations = {}) {
  return { youtube: Boolean(integrations?.youtube), twitch: Boolean(integrations?.twitch?.clientId && integrations?.twitch?.clientSecret) };
}
