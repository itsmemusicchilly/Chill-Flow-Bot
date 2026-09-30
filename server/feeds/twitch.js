// "Twitch channel went live": asks Twitch's API which of the watched channels are live (one request for up to 100 channels, however many servers
// watch them) with an app token from the operator's free Twitch developer application. It announces each new broadcast once.
//
// Followers are not offered: Twitch only tells an app the follower list with a token the streamer grants themselves, so there is no legitimate
// way to watch someone else's followers from here — use the Webhook trigger with StreamElements, Streamlabs or Zapier for that.
import { twitchSettings } from '../../shared/platforms.js';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const STREAMS_URL = 'https://api.twitch.tv/helix/streams';
const MAX_LOGINS = 100;

export function createTwitchAdapter() {
  const tokens = new Map(); // client id → { token, secret, expiresAt }

  async function appToken({ fetch, keys, now }, { fresh = false } = {}) {
    const { clientId, clientSecret } = keys.twitch;
    const cached = tokens.get(clientId);
    if (!fresh && cached && cached.secret === clientSecret && cached.expiresAt > now + 60_000) return cached.token;
    const res = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('Twitch refused the bot operator’s Client ID or Secret.');
    if (res.status !== 200) throw new Error(`Twitch answered with an error (${res.status}).`);
    let json;
    try { json = JSON.parse(res.text); } catch { throw new Error('Twitch’s answer could not be read.'); }
    if (!json?.access_token) throw new Error('Twitch’s answer could not be read.');
    tokens.set(clientId, { token: json.access_token, secret: clientSecret, expiresAt: now + (Number(json.expires_in) || 3600) * 1000 });
    return json.access_token;
  }

  async function streams(ctx, logins) {
    const ask = async (token) => ctx.fetch(`${STREAMS_URL}?first=${MAX_LOGINS}&${logins.map((l) => `user_login=${encodeURIComponent(l)}`).join('&')}`, {
      headers: { accept: 'application/json', 'client-id': ctx.keys.twitch.clientId, authorization: `Bearer ${token}` },
    });
    let res = await ask(await appToken(ctx));
    if (res.status === 401) res = await ask(await appToken(ctx, { fresh: true })); // the token expired or was revoked: one fresh try
    if (res.status === 429) throw new Error('Twitch says the bot is asking too often (429).');
    if (res.status !== 200) throw new Error(`Twitch answered with an error (${res.status}).`);
    try { return JSON.parse(res.text).data ?? []; } catch { throw new Error('Twitch’s answer could not be read.'); }
  }

  return {
    type: 'trigger.twitch.live',

    prepare(settings, { minMinutes: _ } = {}) {
      const { login, everyMs } = twitchSettings(settings);
      return { key: login, everyMs, label: `Twitch ${login}` };
    },

    async fetchMany(targets, ctx) {
      const out = new Map();
      for (let i = 0; i < targets.length; i += MAX_LOGINS) {
        const chunk = targets.slice(i, i + MAX_LOGINS);
        const live = await streams(ctx, chunk.map((t) => t.key));
        for (const t of chunk) out.set(t.key, { live: live.find((s) => String(s?.user_login ?? '').toLowerCase() === t.key && (s.type === 'live' || !s.type)) ?? null });
      }
      return out;
    },

    evaluate(state, { live }, sub) {
      const login = sub.key;
      if (!state?.baselined) {
        return {
          state: { baselined: true, lastId: live ? String(live.id) : '' }, fire: [],
          log: [{ level: 'info', message: `Now watching Twitch channel “${login}” (${live ? 'live right now — this broadcast is not announced' : 'offline'}). Each new broadcast will be.` }],
        };
      }
      if (!live || String(live.id) === state.lastId) return { state, fire: [], log: [] }; // offline, or still the broadcast we already announced (a reconnect keeps its id)
      const thumb = String(live.thumbnail_url ?? '').replace('{width}', '1280').replace('{height}', '720');
      return {
        state: { baselined: true, lastId: String(live.id) },
        fire: [{
          label: `Twitch “${live.user_name || login}” went live`,
          data: {
            twitch: {
              user: String(live.user_name ?? login), login, title: String(live.title ?? ''), game: String(live.game_name ?? ''), viewers: Number(live.viewer_count) || 0,
              url: `https://www.twitch.tv/${login}`, thumbnail: thumb.startsWith('https://') ? thumb : '', started: String(live.started_at ?? ''), id: String(live.id),
            },
          },
        }],
        log: [],
      };
    },
  };
}

export const twitchAdapter = createTwitchAdapter();
