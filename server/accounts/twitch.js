// Twitch accounts: "Connect Twitch" asks the streamer to approve one permission (reading their follower count) on Twitch itself.
// The bot never sees a password. Twitch only tells an application a channel's followers with a token the streamer (or a moderator) granted.
import { AccountError, form, json } from './common.js';

const AUTHORIZE = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN = 'https://id.twitch.tv/oauth2/token';
const REVOKE = 'https://id.twitch.tv/oauth2/revoke';
const USERS = 'https://api.twitch.tv/helix/users';
export const TWITCH_SCOPE = 'moderator:read:followers';

const messageOf = (res) => { try { return String(JSON.parse(res.text)?.message ?? ''); } catch { return ''; } };

function tokensFrom(res, { refreshing = false } = {}) {
  if (res.status !== 200) {
    const message = messageOf(res);
    if (res.status === 403 || /invalid client/i.test(message)) throw new AccountError('Twitch refused the bot operator’s Client ID or Secret.');
    if (refreshing && (res.status === 401 || /refresh token/i.test(message))) throw new AccountError('Twitch no longer accepts this connection. Connect Twitch again.', { expired: true });
    if (res.status === 400 || res.status === 401) throw new AccountError('Twitch did not accept the approval (it may have run out). Press Connect Twitch again.');
    throw new AccountError(`Twitch answered with an error (${res.status}).`);
  }
  const v = json(res, 'Twitch');
  if (!v.access_token || !v.refresh_token) throw new AccountError('Twitch’s answer could not be read.');
  return { accessToken: String(v.access_token), refreshToken: String(v.refresh_token), expiresIn: Number(v.expires_in) || 3600, scopes: Array.isArray(v.scope) ? v.scope.map(String) : String(v.scope ?? '').split(/[ ,]+/).filter(Boolean) };
}

export const twitchAccount = {
  id: 'twitch',
  label: 'Twitch',
  requiredScopes: [TWITCH_SCOPE],
  configured: (keys) => Boolean(keys.twitch?.clientId && keys.twitch?.clientSecret),

  authorizeUrl({ keys, redirectUri, state }) {
    const url = new URL(AUTHORIZE);
    // force_verify: Twitch asks again which account to use, instead of silently reusing whoever is logged in on that browser
    url.search = new URLSearchParams({ client_id: keys.twitch.clientId, redirect_uri: redirectUri, response_type: 'code', scope: TWITCH_SCOPE, state, force_verify: 'true' }).toString();
    return url.toString();
  },

  async exchange({ fetch, keys, redirectUri }, code) {
    const { clientId, clientSecret } = keys.twitch;
    return tokensFrom(await fetch(TOKEN, form({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri })));
  },

  async refresh({ fetch, keys }, refreshToken) {
    const { clientId, clientSecret } = keys.twitch;
    return tokensFrom(await fetch(TOKEN, form({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken })), { refreshing: true });
  },

  async identify({ fetch, keys }, accessToken) {
    const res = await fetch(USERS, { headers: { accept: 'application/json', 'client-id': keys.twitch.clientId, authorization: `Bearer ${accessToken}` } });
    if (res.status !== 200) throw new AccountError(`Twitch answered with an error (${res.status}).`);
    const user = json(res, 'Twitch').data?.[0];
    if (!user?.id) throw new AccountError('Twitch’s answer could not be read.');
    return { id: String(user.id), name: String(user.display_name || user.login || user.id), login: String(user.login ?? '').toLowerCase() };
  },

  async revoke({ fetch, keys }, accessToken) {
    await fetch(REVOKE, form({ client_id: keys.twitch.clientId, token: accessToken }));
  },
};
