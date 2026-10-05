// Discord OAuth2 login. The access token is used once to read identity + server list, then revoked and
// discarded; the session only remembers who you are and which servers you could manage at login.
// Every server-scoped API call re-checks permissions live through the bot (see api.js).
import crypto from 'node:crypto';
import express from 'express';
import { RateLimiter } from './engine/rate-limit.js';

const DISCORD = 'https://discord.com';
const API = `${DISCORD}/api/v10`;
// Where a visitor may be sent back to after logging in: only a public page of this site (never an arbitrary URL).
export const NEXT_RE = /^\/s\/\d{5,25}\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const VISITOR_TTL_MS = 24 * 3600 * 1000;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore junk */ } }
  }
  return out;
}

export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

export function createAuth({ config, db, fetchImpl = fetch, log = () => {} }) {
  const origin = new URL(config.baseUrl).origin;
  const secure = origin.startsWith('https:');
  const redirectUri = `${config.baseUrl}/auth/callback`;
  const attempts = new RateLimiter(20, 10 * 60 * 1000);
  const attrs = (maxAge) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  function attachSession(req, _res, next) {
    const sid = parseCookies(req.headers.cookie).fc_session;
    const s = sid ? db.getSession(sid) : null;
    if (s && !s.data.visitor) req.session = { id: sid, userId: s.userId, data: s.data }; // a visitor session is never a dashboard session
    next();
  }
  /** Public-page visitors: a separate cookie and session kind that can never reach /api. */
  function attachVisitor(req, _res, next) {
    const sid = parseCookies(req.headers.cookie).fc_visitor;
    const s = sid ? db.getSession(sid) : null;
    if (s?.data.visitor === true) req.visitor = { sessionId: sid, id: s.userId, name: s.data.user.name, avatar: s.data.user.avatar };
    next();
  }
  /** Form token bound to this visitor session, page and form (not guessable without the server secret). */
  const csrfToken = (sessionId, pageId, blockId) => crypto.createHmac('sha256', config.clientSecret).update(`${sessionId}|${pageId}|${blockId}`).digest('hex');
  const csrfValid = (token, sessionId, pageId, blockId) => typeof token === 'string' && safeEqual(token, csrfToken(sessionId, pageId, blockId));
  function requireSession(req, res, next) {
    if (!req.session) return res.status(401).json({ error: 'Not signed in.' });
    return next();
  }
  /** CSRF defence for state-changing requests (on top of SameSite=Lax cookies). */
  function requireOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const o = req.headers.origin;
    if (o ? o === origin : req.headers['sec-fetch-site'] === 'same-origin') return next();
    return res.status(403).json({ error: 'Cross-origin request blocked.' });
  }

  async function discord(path, init = {}) {
    const res = await fetchImpl(`${API}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Discord ${path} responded ${res.status}`);
    return res.json();
  }

  const router = express.Router();

  router.get('/auth/login', (req, res) => {
    if (!attempts.take(req.ip)) return res.status(429).send('Too many login attempts. Try again in a few minutes.');
    const state = crypto.randomBytes(16).toString('hex');
    res.append('Set-Cookie', `fc_state=${state}; ${attrs(600)}`);
    const url = new URL(`${DISCORD}/oauth2/authorize`);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'identify guilds', state, prompt: 'none' }).toString();
    return res.redirect(url.toString());
  });

  router.get('/auth/visitor/login', (req, res) => {
    if (!attempts.take(req.ip)) return res.status(429).send('Too many login attempts. Try again in a few minutes.');
    const state = `v.${crypto.randomBytes(16).toString('hex')}`; // the "v." marks this as a visitor login
    const next = typeof req.query.next === 'string' && NEXT_RE.test(req.query.next) ? req.query.next : '/';
    res.append('Set-Cookie', `fc_state=${state}; ${attrs(600)}`);
    res.append('Set-Cookie', `fc_next=${encodeURIComponent(next)}; ${attrs(600)}`);
    const url = new URL(`${DISCORD}/oauth2/authorize`);
    // visitors only share their identity — no server list
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'identify', state, prompt: 'none' }).toString();
    return res.redirect(url.toString());
  });

  router.get('/auth/callback', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const expected = cookies.fc_state;
    const isVisitor = typeof expected === 'string' && expected.startsWith('v.');
    res.append('Set-Cookie', `fc_state=; ${attrs(0)}`); // single use
    res.append('Set-Cookie', `fc_next=; ${attrs(0)}`);
    const { code, state, error } = req.query;
    if (error) return res.redirect('/?login=denied');
    if (typeof code !== 'string' || typeof state !== 'string' || !safeEqual(state, expected)) return res.redirect('/?login=failed');
    try {
      const token = await discord('/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      });
      const bearer = { headers: { Authorization: `Bearer ${token.access_token}` } };
      const revoke = () => discord('/oauth2/token/revoke', { // best effort: we never need this token again
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, token: token.access_token }),
      }).catch(() => {});

      if (isVisitor) {
        const user = await discord('/users/@me', bearer);
        revoke();
        const sid = db.createSession(user.id, { visitor: true, user: { id: user.id, name: user.global_name || user.username, avatar: user.avatar } }, VISITOR_TTL_MS);
        res.append('Set-Cookie', `fc_visitor=${sid}; ${attrs(Math.floor(VISITOR_TTL_MS / 1000))}`);
        const next = cookies.fc_next && NEXT_RE.test(cookies.fc_next) ? cookies.fc_next : '/';
        return res.redirect(next);
      }

      const [user, guilds] = await Promise.all([discord('/users/@me', bearer), discord('/users/@me/guilds?limit=200', bearer)]);
      revoke();

      const manageable = guilds.filter((g) => {
        const perms = BigInt(g.permissions || 0);
        return g.owner || (perms & ADMINISTRATOR) !== 0n || (config.minPermission === 'ManageGuild' && (perms & MANAGE_GUILD) !== 0n);
      }).map((g) => ({ id: g.id, name: g.name, icon: g.icon }));

      const sid = db.createSession(user.id, {
        user: { id: user.id, name: user.global_name || user.username, avatar: user.avatar },
        guilds: manageable,
      }, config.sessionTtlMs);
      res.append('Set-Cookie', `fc_session=${sid}; ${attrs(Math.floor(config.sessionTtlMs / 1000))}`);
      return res.redirect('/');
    } catch (err) {
      log(`OAuth login failed: ${err.message}`);
      return res.redirect('/?login=failed');
    }
  });

  router.post('/auth/logout', attachSession, requireOrigin, (req, res) => {
    if (req.session) db.deleteSession(req.session.id);
    res.append('Set-Cookie', `fc_session=; ${attrs(0)}`);
    res.json({ ok: true });
  });

  router.post('/auth/visitor/logout', express.urlencoded({ extended: false, limit: '4kb' }), attachVisitor, requireOrigin, (req, res) => {
    if (req.visitor) db.deleteSession(req.visitor.sessionId);
    res.append('Set-Cookie', `fc_visitor=; ${attrs(0)}`);
    const next = typeof req.body?.next === 'string' && NEXT_RE.test(req.body.next) ? req.body.next : '/';
    res.redirect(303, next);
  });

  return { router, attachSession, attachVisitor, requireSession, requireOrigin, csrfToken, csrfValid };
}
