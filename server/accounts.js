// The creator accounts (Twitch, TikTok) that a server has connected: stored with sealed tokens, kept fresh, and handed to the watchers.
//
// A token is only ever opened here, for one request at a time. Refreshing is single-flight per server and provider, because Twitch and TikTok
// may give back a NEW refresh token on each refresh and the old one then stops working: two refreshes at once would lose the connection.
import { AccountError } from './accounts/common.js';
import { tiktokAccount } from './accounts/tiktok.js';
import { twitchAccount } from './accounts/twitch.js';
import { createSealer } from './secrets.js';

export { AccountError };

const PROVIDERS = { twitch: twitchAccount, tiktok: tiktokAccount };
const REFRESH_MARGIN_MS = 2 * 60_000; // a token that ends within two minutes is renewed before it is used
const aadOf = (guildId, provider) => `${guildId}|${provider}`;

export const accountProviders = () => Object.keys(PROVIDERS);

/**
 * @param {{config: object, db: object, fetch: Function, now?: () => number, logger?: object, sealer?: object}} deps
 *   `fetch(url, options)` is the guarded fetcher (server/net/safe-fetch.js), or a pretend one in tests.
 */
export function createAccounts({ config, db, fetch, now = () => Date.now(), logger = null, sealer = createSealer({ key: config.tokenKey, fallback: config.clientSecret }) }) {
  const keys = config.integrations;
  const redirectUri = (provider) => `${config.baseUrl}/auth/${provider}/callback`;
  const ctx = (provider) => ({ fetch, keys, redirectUri: redirectUri(provider) });
  const refreshing = new Map(); // "guild|provider" → the refresh in progress
  const log = (guildId, level, message) => { try { logger?.log(guildId, level, message); } catch { /* never let logging break a refresh */ } };
  const provider = (id) => PROVIDERS[id] ?? null;
  const reconnect = (p) => new AccountError(`${p.label} needs to be connected again. Open “Accounts” and press Connect ${p.label}.`, { expired: true });

  /** What the dashboard shows: which accounts exist and whether each works. Never a token. */
  function list(guildId) {
    const rows = new Map(db.listAccounts(guildId).map((r) => [r.provider, r]));
    return Object.values(PROVIDERS).map((p) => {
      const row = rows.get(p.id);
      return { provider: p.id, label: p.label, configured: p.configured(keys), connected: Boolean(row), status: row?.status ?? 'none', account: row ? row.accountName : null, connectedAt: row?.createdAt ?? null };
    });
  }

  /** `{ twitch: true, tiktok: false }` — an account counts only while it works (not when it needs to be connected again). */
  function flags(guildId) {
    const rows = new Map(db.listAccounts(guildId).map((r) => [r.provider, r]));
    return Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, rows.get(id)?.status === 'ok']));
  }

  function authorizeUrl(id, state) {
    const p = provider(id);
    if (!p || !p.configured(keys)) throw new AccountError(`${p?.label ?? 'That platform'} has not been set up by the bot operator.`);
    return p.authorizeUrl({ keys, redirectUri: redirectUri(id), state });
  }

  /** The creator approved: trade the code for tokens, find out whose account it is, and keep it for this server. */
  async function complete(guildId, id, userId, code) {
    const p = provider(id);
    if (!p || !p.configured(keys)) throw new AccountError(`${p?.label ?? 'That platform'} has not been set up by the bot operator.`);
    const tokens = await p.exchange(ctx(id), code);
    if (!p.requiredScopes.every((s) => tokens.scopes.includes(s))) {
      throw new AccountError(`${p.label} did not give the permission to read the follower count. Press Connect ${p.label} again and leave every box ticked.`);
    }
    const who = await p.identify(ctx(id), tokens.accessToken);
    const before = db.getAccount(guildId, id);
    const aad = aadOf(guildId, id);
    db.saveAccount({
      guildId, provider: id, accountId: who.id, accountName: who.name, accountLogin: who.login ?? '', accessSealed: sealer.seal(tokens.accessToken, aad), refreshSealed: sealer.seal(tokens.refreshToken, aad),
      expiresAt: now() + tokens.expiresIn * 1000, scopes: tokens.scopes.join(' '), status: 'ok', connectedBy: userId,
    }, now());
    if (before && before.accountId !== who.id) revokeSealed(p, before).catch(() => {}); // another account replaced it: let go of the old one
    return { provider: id, account: who.name };
  }

  async function revokeSealed(p, row) {
    const token = sealer.open(row.accessSealed, aadOf(row.guildId, row.provider));
    if (token) await p.revoke(ctx(p.id), token).catch(() => {});
  }

  /** A token that works right now (renewed first when it is about to end, or when `fresh` says the platform just refused it). */
  async function access(guildId, id, { fresh = false } = {}) {
    const p = provider(id);
    if (!p) throw new AccountError('Unknown platform.');
    const row = db.getAccount(guildId, id);
    if (!row) throw new AccountError(`No ${p.label} account is connected to this server. Open “Accounts” and press Connect ${p.label}.`, { expired: true });
    if (row.status !== 'ok') throw reconnect(p);
    const aad = aadOf(guildId, id);
    const token = sealer.open(row.accessSealed, aad);
    const refreshToken = sealer.open(row.refreshSealed, aad);
    if (!token || !refreshToken) { db.setAccountStatus(guildId, id, 'expired', now()); throw reconnect(p); } // sealed with another key
    const who = { accountId: row.accountId, accountName: row.accountName, accountLogin: row.accountLogin };
    if (!fresh && row.expiresAt - now() > REFRESH_MARGIN_MS) return { token, ...who };
    return { token: (await refresh(p, row, refreshToken)).accessToken, ...who };
  }

  function refresh(p, row, refreshToken) {
    const key = aadOf(row.guildId, p.id);
    let pending = refreshing.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const t = await p.refresh(ctx(p.id), refreshToken);
          const aad = key;
          db.saveAccount({
            guildId: row.guildId, provider: p.id, accountId: row.accountId, accountName: row.accountName, accountLogin: row.accountLogin, accessSealed: sealer.seal(t.accessToken, aad),
            refreshSealed: sealer.seal(t.refreshToken || refreshToken, aad), expiresAt: now() + t.expiresIn * 1000, scopes: t.scopes.length ? t.scopes.join(' ') : row.scopes, status: 'ok',
          }, now());
          return { accessToken: t.accessToken };
        } catch (err) {
          if (err instanceof AccountError && err.expired) {
            db.setAccountStatus(row.guildId, p.id, 'expired', now());
            log(row.guildId, 'warn', `The connected ${p.label} account (${row.accountName}) must be connected again: ${err.message}`);
          }
          throw err;
        } finally {
          refreshing.delete(key);
        }
      })();
      refreshing.set(key, pending);
    }
    return pending;
  }

  /** The platform keeps refusing this account's token: stop using it until someone connects it again. */
  function expire(guildId, id, reason = '') {
    const p = provider(id);
    if (!p || db.getAccount(guildId, id)?.status !== 'ok') return;
    db.setAccountStatus(guildId, id, 'expired', now());
    log(guildId, 'warn', `The connected ${p.label} account must be connected again${reason ? `: ${reason}` : '.'}`);
  }

  /** Disconnect on purpose: tell the platform to drop the permission (best effort), then forget everything. */
  async function disconnect(guildId, id) {
    const p = provider(id);
    const row = db.getAccount(guildId, id);
    if (!p || !row) return false;
    await revokeSealed(p, row);
    db.deleteAccount(guildId, id);
    return true;
  }

  /** The bot left this server: its accounts are no longer anyone's to read. */
  async function removeGuild(guildId) {
    for (const row of db.listAccounts(guildId)) await disconnect(guildId, row.provider).catch(() => {});
    db.deleteGuildAccounts(guildId);
  }

  return { list, flags, authorizeUrl, complete, access, expire, disconnect, removeGuild, redirectUri, providers: () => Object.keys(PROVIDERS) };
}
