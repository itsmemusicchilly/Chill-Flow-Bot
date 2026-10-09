// Settings of the triggers that use a platform's own API (YouTube subscribers, Twitch live) — and which of them the bot operator has set up.
// Pure, so the editor and the server read the settings the same way. Every problem is a FeedSettingError worded for the person editing the flow.
import { FeedSettingError, youtubeChannelId } from './feeds.js';

export const MIN_YOUTUBE_MINUTES = 15; // YouTube's API has a daily quota shared by every server; this keeps one flow from eating it
export const DEFAULT_YOUTUBE_MINUTES = 60;
export const MIN_TWITCH_MINUTES = 1;
export const DEFAULT_TWITCH_MINUTES = 2;
// the count triggers (subscribers / followers gained): how often each platform is asked
export const DEFAULT_YOUTUBE_COUNT_MINUTES = 30;
export const MIN_TWITCH_FOLLOWER_MINUTES = 1;
export const DEFAULT_TWITCH_FOLLOWER_MINUTES = 5;
export const MIN_TIKTOK_MINUTES = 5;
export const DEFAULT_TIKTOK_MINUTES = 15;

/** What a trigger needs the bot operator to have set up in the server's environment (`needs` in the catalog). */
export const INTEGRATIONS = {
  youtube: 'a YouTube API key (YOUTUBE_API_KEY)',
  twitch: 'a Twitch application (TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET)',
  tiktok: 'a TikTok developer app (TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET)',
};

/** Accounts a server owner can connect in the dashboard ("Connected accounts"): the creator approves on the platform itself. */
export const CONNECTIONS = {
  twitch: 'Twitch',
  tiktok: 'TikTok',
};

/**
 * Why a connection did not work, as the short code that comes back to the browser in the address (never free text: a link must not be able to make
 * the dashboard say whatever it likes). `{label}` is the platform's name.
 */
export const CONNECT_FAILURES = {
  keys: '{label} refused the bot operator’s keys. Tell whoever runs the bot.',
  approval: '{label} did not accept the approval (it may have run out). Press Connect {label} again.',
  scope: '{label} did not give the permission to read the follower count. Press Connect {label} again and leave every box ticked.',
  platform: '{label} could not be reached, or answered with an error. Try again in a moment.',
  unavailable: '{label} has not been set up by the bot operator.',
  other: '{label} could not be connected. Try again.',
};
export const connectFailureText = (code, label) => CONNECT_FAILURES[Object.hasOwn(CONNECT_FAILURES, code) ? code : 'other'].replaceAll('{label}', label);

/**
 * What the address says when the person comes back from “Connect Twitch / TikTok” (`?connect=ok|denied|failed&provider=…&reason=<code>`), or null when
 * this is not such a visit. Only known words are ever turned into text.
 */
export function connectResultFrom(search) {
  const q = new URLSearchParams(search);
  const result = q.get('connect');
  if (!result) return null;
  const provider = q.get('provider');
  const label = Object.hasOwn(CONNECTIONS, provider) ? CONNECTIONS[provider] : 'The account'; // own names only: “__proto__” is not a platform
  if (result === 'ok') return { result: 'ok', message: `${label} connected.`, error: false };
  if (result === 'denied') return { result: 'denied', message: `${label} was not connected: the approval was cancelled.`, error: true };
  return { result: 'failed', message: connectFailureText(q.get('reason'), label), error: true };
}

/** What a count trigger does: fire each time the count rises, or every time it changes (for a live counter). */
export const COUNT_MODES = [['gain', 'Each time it goes up'], ['change', 'Every time it changes (for counters)']];

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

/** Settings every count trigger shares: when to fire, and how often to look (`min` differs per platform). */
export function countSettings(d = {}, { min }) {
  const mode = d.fire ?? 'gain';
  if (!COUNT_MODES.some(([value]) => value === mode)) throw new FeedSettingError('Choose when it should run: each time it goes up, or every time it changes.');
  return { mode, everyMs: minutesOf(d, min) * 60_000 };
}

/** The connected account a Followers trigger reads: blank = the first one that works. Ids are the platform's own (digits for Twitch; letters, digits, - and _ for TikTok). */
export const ACCOUNT_ID_RE = /^[\w-]{1,100}$/;
export function accountOf(d = {}) {
  const v = String(d.account ?? '').trim();
  if (v && !ACCOUNT_ID_RE.test(v)) throw new FeedSettingError('Pick one of the connected accounts from the list (or leave it blank to use the first one).');
  return v;
}

/**
 * Which creator accounts a server has, from rows of `{ provider, id, status }`: `{ twitch: true, tiktok: false, ids: { twitch: ['555'], tiktok: [] } }`.
 * Only accounts that work (status “ok”) count; an account that must be connected again is as good as missing.
 */
export function accountFlagsFrom(rows) {
  const flags = Object.fromEntries(Object.keys(CONNECTIONS).map((p) => [p, false]));
  const ids = Object.fromEntries(Object.keys(CONNECTIONS).map((p) => [p, []]));
  for (const r of rows ?? []) {
    if (r.status !== 'ok' || !Object.hasOwn(flags, r.provider)) continue;
    flags[r.provider] = true;
    ids[r.provider].push(r.id);
  }
  return { ...flags, ids };
}

/** The YouTube count trigger: a channel plus the shared count settings. */
export function youtubeCountSettings(d = {}) {
  return { channelId: youtubeChannelId(String(d.channel ?? '').trim()), ...countSettings(d, { min: MIN_YOUTUBE_MINUTES }) };
}

/** Which integrations the bot operator has set up, as the plain yes/no map the editor is given (never the keys themselves). */
export function integrationFlags(integrations = {}) {
  return {
    youtube: Boolean(integrations?.youtube),
    twitch: Boolean(integrations?.twitch?.clientId && integrations?.twitch?.clientSecret),
    tiktok: Boolean(integrations?.tiktok?.clientKey && integrations?.tiktok?.clientSecret),
  };
}
