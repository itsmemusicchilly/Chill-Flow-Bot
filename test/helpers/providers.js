// A pretend Twitch and TikTok for the tests about connected accounts: it answers like the real services do (token exchange, refresh with a
// rotating refresh token, identity, follower counts, revoke) and remembers every request, so a test can say exactly what was asked.
const json = (status, body) => ({ status, text: JSON.stringify(body), headers: new Headers(), url: '' });

export function pretendProviders({ now = () => Date.now() } = {}) {
  const calls = [];
  const state = {
    twitch: { followers: 100, counts: {}, latest: 'Newest Fan', user: { id: '555', login: 'streamer', display_name: 'Streamer' }, scope: ['moderator:read:followers'], accessLife: 3600, refreshes: 0, failRefresh: false, rejectAccess: false, status: null },
    tiktok: { followers: 2000, counts: {}, user: { open_id: 'tt-open-1', display_name: 'Dancer' }, scope: 'user.info.basic,user.info.stats', accessLife: 86_400, refreshes: 0, failRefresh: false, rejectAccess: false, errorCode: null, status: null },
  };
  const live = { twitch: new Set(), tiktok: new Set() }; // access tokens that currently work
  const refreshTokens = { twitch: new Set(), tiktok: new Set() };
  const owner = new Map(); // access or refresh token → the account it belongs to (a refresh keeps the account)
  let n = 0;
  const mint = (kind) => { n += 1; return `${kind}-${n}`; };

  async function fetch(url, options = {}) {
    const u = new URL(url);
    const body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : {};
    const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method: options.method ?? 'GET', url: String(url), host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers });
    await Promise.resolve();
    const bearer = String(headers.authorization ?? '').replace(/^Bearer /, '');

    // ---- Twitch ----
    if (u.host === 'id.twitch.tv' && u.pathname === '/oauth2/token') {
      const t = state.twitch;
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'good-code') return json(400, { status: 400, message: 'Invalid authorization code' });
        const access = mint('tw-access'); const refresh = mint('tw-refresh');
        live.twitch.add(access); refreshTokens.twitch.add(refresh);
        owner.set(access, t.user); owner.set(refresh, t.user);
        return json(200, { access_token: access, refresh_token: refresh, expires_in: t.accessLife, scope: t.scope, token_type: 'bearer' });
      }
      if (body.grant_type === 'refresh_token') {
        t.refreshes += 1;
        if (t.failRefresh || !refreshTokens.twitch.has(body.refresh_token)) return json(401, { status: 401, message: 'Invalid refresh token' });
        refreshTokens.twitch.delete(body.refresh_token); // a refresh token works once: the answer carries the next one
        const access = mint('tw-access'); const refresh = mint('tw-refresh');
        live.twitch.add(access); refreshTokens.twitch.add(refresh);
        owner.set(access, owner.get(body.refresh_token)); owner.set(refresh, owner.get(body.refresh_token));
        return json(200, { access_token: access, refresh_token: refresh, expires_in: t.accessLife, scope: t.scope, token_type: 'bearer' });
      }
    }
    if (u.host === 'id.twitch.tv' && u.pathname === '/oauth2/revoke') { live.twitch.delete(body.token); return json(200, {}); }
    if (u.host === 'api.twitch.tv' && u.pathname === '/helix/users') {
      if (!live.twitch.has(bearer)) return json(401, { status: 401, message: 'Invalid OAuth token' });
      return json(200, { data: [owner.get(bearer) ?? state.twitch.user] });
    }
    if (u.host === 'api.twitch.tv' && u.pathname === '/helix/channels/followers') {
      if (state.twitch.status) return json(state.twitch.status, { message: 'nope' });
      if (state.twitch.rejectAccess || !live.twitch.has(bearer)) return json(401, { status: 401, message: 'Invalid OAuth token' });
      const total = state.twitch.counts[u.searchParams.get('broadcaster_id')] ?? state.twitch.followers;
      return json(200, { total, data: state.twitch.latest ? [{ user_id: '9', user_login: 'newest_fan', user_name: state.twitch.latest, followed_at: '2026-01-01T00:00:00Z' }] : [], pagination: {} });
    }

    // ---- TikTok ----
    if (u.host === 'open.tiktokapis.com' && u.pathname === '/v2/oauth/token/') {
      const t = state.tiktok;
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'good-code') return json(400, { error: 'invalid_grant', error_description: 'Authorization code is expired or invalid.' });
        const access = mint('tt-access'); const refresh = mint('tt-refresh');
        live.tiktok.add(access); refreshTokens.tiktok.add(refresh);
        owner.set(access, t.user); owner.set(refresh, t.user);
        return json(200, { access_token: access, refresh_token: refresh, expires_in: t.accessLife, refresh_expires_in: 31_536_000, open_id: t.user.open_id, scope: t.scope, token_type: 'Bearer' });
      }
      if (body.grant_type === 'refresh_token') {
        t.refreshes += 1;
        if (t.failRefresh || !refreshTokens.tiktok.has(body.refresh_token)) return json(400, { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' });
        refreshTokens.tiktok.delete(body.refresh_token);
        const access = mint('tt-access'); const refresh = mint('tt-refresh');
        live.tiktok.add(access); refreshTokens.tiktok.add(refresh);
        owner.set(access, owner.get(body.refresh_token)); owner.set(refresh, owner.get(body.refresh_token));
        return json(200, { access_token: access, refresh_token: refresh, expires_in: t.accessLife, refresh_expires_in: 31_536_000, open_id: t.user.open_id, scope: t.scope, token_type: 'Bearer' });
      }
    }
    if (u.host === 'open.tiktokapis.com' && u.pathname === '/v2/oauth/revoke/') { live.tiktok.delete(body.token); return json(200, { error: { code: 'ok' } }); }
    if (u.host === 'open.tiktokapis.com' && u.pathname === '/v2/user/info/') {
      const t = state.tiktok;
      if (t.status) return json(t.status, { error: { code: 'internal_error', message: 'x' } });
      if (t.errorCode) return json(200, { data: {}, error: { code: t.errorCode, message: 'x', log_id: 'l' } });
      if (t.rejectAccess || !live.tiktok.has(bearer)) return json(401, { data: {}, error: { code: 'access_token_invalid', message: 'The access token is invalid or not found in the request.', log_id: 'l' } });
      const wanted = String(u.searchParams.get('fields') ?? '').split(',');
      const who = owner.get(bearer) ?? t.user;
      const user = {};
      if (wanted.includes('open_id')) user.open_id = who.open_id;
      if (wanted.includes('display_name')) user.display_name = who.display_name;
      if (wanted.includes('follower_count')) user.follower_count = t.counts[who.open_id] ?? t.followers;
      return json(200, { data: { user }, error: { code: 'ok', message: '', log_id: 'l' } });
    }
    return json(404, { message: `the pretend providers do not know ${url}` });
  }

  return { fetch, calls, state, live, refreshTokens, now };
}
