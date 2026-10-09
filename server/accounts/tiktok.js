// TikTok accounts: "Connect TikTok" is TikTok's own Login Kit. The creator approves, on TikTok, that this bot's app may read their
// follower count. The bot operator needs a TikTok developer app (and TikTok has to approve it before strangers can connect).
import { AccountError, form, json } from './common.js';

const AUTHORIZE = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const USER = 'https://open.tiktokapis.com/v2/user/info/';
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.stats'];

function tokensFrom(res, { refreshing = false } = {}) {
  let body = null;
  try { body = JSON.parse(res.text); } catch { /* not JSON */ }
  const code = String(body?.error ?? '');
  if (res.status !== 200 || code) {
    if (/invalid_client|unauthorized_client/i.test(code)) throw new AccountError('TikTok refused the bot operator’s Client Key or Secret.', { code: 'keys' });
    if (refreshing && /invalid_grant/i.test(code)) throw new AccountError('TikTok no longer accepts this connection. Connect TikTok again.', { expired: true });
    if (res.status === 400 || res.status === 401) throw new AccountError('TikTok did not accept the approval (it may have run out). Press Connect TikTok again.', { code: 'approval' });
    throw new AccountError(`TikTok answered with an error (${res.status}).`, { code: 'platform' });
  }
  if (!body?.access_token || !body?.refresh_token) throw new AccountError('TikTok’s answer could not be read.', { code: 'platform' });
  return { accessToken: String(body.access_token), refreshToken: String(body.refresh_token), expiresIn: Number(body.expires_in) || 86_400, scopes: String(body.scope ?? '').split(/[ ,]+/).filter(Boolean), openId: String(body.open_id ?? '') };
}

export const tiktokAccount = {
  id: 'tiktok',
  label: 'TikTok',
  requiredScopes: TIKTOK_SCOPES,
  configured: (keys) => Boolean(keys.tiktok?.clientKey && keys.tiktok?.clientSecret),

  authorizeUrl({ keys, redirectUri, state }) {
    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({ client_key: keys.tiktok.clientKey, scope: TIKTOK_SCOPES.join(','), response_type: 'code', redirect_uri: redirectUri, state }).toString();
    return url.toString();
  },

  async exchange({ fetch, keys, redirectUri }, code) {
    const { clientKey, clientSecret } = keys.tiktok;
    return tokensFrom(await fetch(TOKEN, form({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri })));
  },

  /** TikTok may hand back a different refresh token: the caller must keep the one in the answer. */
  async refresh({ fetch, keys }, refreshToken) {
    const { clientKey, clientSecret } = keys.tiktok;
    return tokensFrom(await fetch(TOKEN, form({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken })), { refreshing: true });
  },

  async identify({ fetch }, accessToken) {
    const res = await fetch(`${USER}?fields=open_id,display_name`, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } });
    if (res.status !== 200) throw new AccountError(`TikTok answered with an error (${res.status}).`, { code: 'platform' });
    const v = json(res, 'TikTok');
    const user = v.data?.user;
    if ((v.error?.code && v.error.code !== 'ok') || !user?.open_id) throw new AccountError('TikTok’s answer could not be read.', { code: 'platform' });
    return { id: String(user.open_id), name: String(user.display_name || user.open_id) };
  },

  async revoke({ fetch, keys }, accessToken) {
    const { clientKey, clientSecret } = keys.tiktok;
    await fetch(REVOKE, form({ client_key: clientKey, client_secret: clientSecret, token: accessToken }));
  },
};
