// "Connect Twitch / TikTok": the creator is sent to the platform to approve reading their follower count, and comes back here.
//
// Starting is a dashboard request (POST /api/guilds/:gid/accounts/:provider/start — session, same-origin and manage-server checks all apply). It
// remembers who started it and for which server, and sets a single-use cookie. The callback (GET /auth/<provider>/callback) only continues when
// the cookie matches the `state` the platform sends back, the same signed-in person is still here, and they can still manage that server.
import crypto from 'node:crypto';
import express from 'express';
import { AccountError } from './accounts.js';
import { parseCookies, safeEqual } from './auth.js';
import { RateLimiter } from './engine/rate-limit.js';

const COOKIE = 'fc_conn';
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;

export function createConnect({ config, auth, accounts, bot, runtime, logger, now = () => Date.now() }) {
  const secure = new URL(config.baseUrl).origin.startsWith('https:');
  const attrs = (maxAge) => `Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const attempts = new RateLimiter(20, 10 * 60_000, now);
  const pending = new Map(); // state → { guildId, userId, provider, expires }

  /** Begin a connection: returns the platform's approval page address and sets the single-use cookie. Throws AccountError when it cannot start. */
  function begin(res, { guildId, userId, provider }) {
    if (!attempts.take(userId)) throw new AccountError('Too many connect attempts. Try again in a few minutes.');
    const state = crypto.randomBytes(24).toString('hex');
    const url = accounts.authorizeUrl(provider, state);
    for (const [k, v] of pending) if (v.expires <= now()) pending.delete(k);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    pending.set(state, { guildId, userId, provider, expires: now() + PENDING_TTL_MS });
    res.append('Set-Cookie', `${COOKIE}=${state}; ${attrs(Math.floor(PENDING_TTL_MS / 1000))}`);
    return url;
  }

  const router = express.Router();
  router.get('/auth/:provider/callback', auth.attachSession, async (req, res, next) => {
    const provider = req.params.provider;
    if (!accounts.providers().includes(provider)) return next();
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    res.append('Set-Cookie', `${COOKIE}=; ${attrs(0)}`); // single use
    const { code, state, error } = req.query;
    const entry = typeof state === 'string' ? pending.get(state) : undefined;
    if (entry) pending.delete(state);
    const trusted = entry && safeEqual(state, cookie) && entry.provider === provider && entry.expires > now();
    if (!trusted) return res.redirect(`/?connect=failed&provider=${provider}`);
    if (req.session?.userId !== entry.userId) return res.redirect('/');
    const back = (result, reason = '') => res.redirect(`/?connect=${result}&provider=${provider}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}#/g/${entry.guildId}`);
    if (error) return back('denied');
    if (typeof code !== 'string' || !code) return back('failed');
    if (!bot.hasGuild(entry.guildId) || !(await bot.canManage(entry.guildId, entry.userId))) return back('failed');
    try {
      const done = await accounts.complete(entry.guildId, provider, entry.userId, code);
      runtime.loadGuild(entry.guildId); // flows that were waiting for this account start now
      logger.log(entry.guildId, 'info', `${accounts.list(entry.guildId).find((a) => a.provider === provider)?.label ?? provider} account “${done.account}” was ${done.added ? 'connected' : 'connected again'}.`);
      return back('ok');
    } catch (err) {
      const message = err instanceof AccountError ? err.message : 'Something went wrong while connecting. Try again.';
      logger.log(entry.guildId, 'warn', `Connecting ${provider} failed: ${err?.message ?? err}`);
      return back('failed', message);
    }
  });

  return { router, begin };
}
