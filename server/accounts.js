// The creator accounts (Twitch, TikTok) that a server has connected: stored with sealed tokens, kept fresh, and handed to the watchers.
// A server may connect several accounts of the same platform; a Followers trigger names one (or takes the first that works).
//
// A token is only ever opened here, for one request at a time. Refreshing is single-flight per account, because Twitch and TikTok may give back a
// NEW refresh token on each refresh and the old one then stops working: two refreshes at once would lose the connection.
import { accountFlagsFrom } from '../shared/platforms.js';
import { AccountError } from './accounts/common.js';
import { tiktokAccount } from './accounts/tiktok.js';
import { twitchAccount } from './accounts/twitch.js';
import { createSealer } from './secrets.js';

export { AccountError };

const PROVIDERS = { twitch: twitchAccount, tiktok: tiktokAccount };
const REFRESH_MARGIN_MS = 2 * 60_000; // a token that ends within two minutes is renewed before it is used
// A sealed token is bound to its server, platform and account. Tokens sealed before several accounts were allowed were bound to server and platform only.
const aadOf = (guildId, provider, accountId) => `${guildId}|${provider}|${accountId}`;
const legacyAadOf = (guildId, provider) => `${guildId}|${provider}`;

export const accountProviders = () => Object.keys(PROVIDERS);

/**
 * @param {{config: object, db: object, fetch: Function, now?: () => number, logger?: object, sealer?: object}} deps
 *   `fetch(url, options)` is the guarded fetcher (server/net/safe-fetch.js), or a pretend one in tests.
 */
export function createAccounts({ config, db, fetch, now = () => Date.now(), logger = null, sealer = createSealer({ key: config.tokenKey, fallback: config.clientSecret }) }) {
  const keys = config.integrations;
  const redirectUri = (provider) => `${config.baseUrl}/auth/${provider}/callback`;
  const ctx = (provider) => ({ fetch, keys, redirectUri: redirectUri(provider) });
  const refreshing = new Map(); // "guild|provider|account" → the refresh in progress
  const seen = new Map(); // "guild|provider|account" → { count, at }: what the last look at the platform found (memory only; the next look fills it again)
  const log = (guildId, level, message) => { try { logger?.log(guildId, level, message); } catch { /* never let logging break a refresh */ } };
  const provider = (id) => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null);
  const reconnect = (p) => new AccountError(`${p.label} needs to be connected again. Open “Accounts” and press Connect ${p.label}.`, { expired: true });
  const tokenOf = (sealed, row) => sealer.open(sealed, aadOf(row.guildId, row.provider, row.accountId)) ?? sealer.open(sealed, legacyAadOf(row.guildId, row.provider));

  /** What the dashboard shows: for each platform, the accounts connected and whether each works. Never a token. */
  function list(guildId) {
    const rows = db.listAccounts(guildId);
    return Object.values(PROVIDERS).map((p) => ({
      provider: p.id, label: p.label, configured: p.configured(keys),
      accounts: rows.filter((r) => r.provider === p.id).map((r) => {
        const last = seen.get(`${guildId}|${p.id}|${r.accountId}`);
        return { id: r.accountId, name: r.accountName, login: r.accountLogin, status: r.status, connectedAt: r.createdAt, count: last?.count ?? null, checkedAt: last?.at ?? null };
      }),
    }));
  }

  /** `{ twitch: true, tiktok: false, ids: { twitch: ['555'], tiktok: [] } }` — an account counts only while it works (not when it must be connected again). */
  function flags(guildId) {
    return accountFlagsFrom(db.listAccounts(guildId).map((r) => ({ provider: r.provider, id: r.accountId, status: r.status })));
  }

  /** A look at the platform found this count for this account (shown in the dashboard). */
  function noteCount(guildId, id, accountId, count) {
    if (Number.isFinite(count)) seen.set(`${guildId}|${id}|${accountId}`, { count, at: now() });
  }

  function authorizeUrl(id, state) {
    const p = provider(id);
    if (!p || !p.configured(keys)) throw new AccountError(`${p?.label ?? 'That platform'} has not been set up by the bot operator.`, { code: 'unavailable' });
    return p.authorizeUrl({ keys, redirectUri: redirectUri(id), state });
  }

  /** The creator approved: trade the code for tokens, find out whose account it is, and keep it for this server (added, or renewed if it was already there). */
  async function complete(guildId, id, userId, code) {
    const p = provider(id);
    if (!p || !p.configured(keys)) throw new AccountError(`${p?.label ?? 'That platform'} has not been set up by the bot operator.`, { code: 'unavailable' });
    const tokens = await p.exchange(ctx(id), code);
    if (!p.requiredScopes.every((s) => tokens.scopes.includes(s))) {
      throw new AccountError(`${p.label} did not give the permission to read the follower count. Press Connect ${p.label} again and leave every box ticked.`, { code: 'scope' });
    }
    const who = await p.identify(ctx(id), tokens.accessToken);
    const before = db.getAccount(guildId, id, who.id);
    const aad = aadOf(guildId, id, who.id);
    db.saveAccount({
      guildId, provider: id, accountId: who.id, accountName: who.name, accountLogin: who.login ?? '', accessSealed: sealer.seal(tokens.accessToken, aad), refreshSealed: sealer.seal(tokens.refreshToken, aad),
      expiresAt: now() + tokens.expiresIn * 1000, scopes: tokens.scopes.join(' '), status: 'ok', connectedBy: userId,
    }, now());
    // (no revoking of the older tokens when the same account connects again: on TikTok that ends the whole permission, including the new one)
    return { provider: id, account: who.name, accountId: who.id, added: !before };
  }

  async function revokeSealed(p, row) {
    const token = tokenOf(row.accessSealed, row);
    if (token) await p.revoke(ctx(p.id), token).catch(() => {});
  }

  /**
   * A token that works right now (renewed first when it is about to end, or when `fresh` says the platform just refused it). `accountId` picks one
   * of the connected accounts; without it the first one that works is used.
   */
  async function access(guildId, id, { accountId = '', fresh = false } = {}) {
    const p = provider(id);
    if (!p) throw new AccountError('Unknown platform.');
    const row = db.getAccount(guildId, id, accountId);
    if (!row) {
      throw new AccountError(accountId
        ? `That ${p.label} account is not connected to this server any more. Open “Accounts” and connect it again, or pick another one in the trigger.`
        : `No ${p.label} account is connected to this server. Open “Accounts” and press Connect ${p.label}.`, { expired: true });
    }
    if (row.status !== 'ok') throw reconnect(p);
    const token = tokenOf(row.accessSealed, row);
    const refreshToken = tokenOf(row.refreshSealed, row);
    if (!token || !refreshToken) { db.setAccountStatus(guildId, id, row.accountId, 'expired', now()); throw reconnect(p); } // sealed with another key
    const who = { accountId: row.accountId, accountName: row.accountName, accountLogin: row.accountLogin };
    if (!fresh && row.expiresAt - now() > REFRESH_MARGIN_MS) return { token, ...who };
    return { token: (await refresh(p, row, refreshToken)).accessToken, ...who };
  }

  function refresh(p, row, refreshToken) {
    const key = `${row.guildId}|${p.id}|${row.accountId}`;
    let pending = refreshing.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const t = await p.refresh(ctx(p.id), refreshToken);
          const aad = aadOf(row.guildId, p.id, row.accountId); // re-sealed under the current binding, whatever the old one was
          db.saveAccount({
            guildId: row.guildId, provider: p.id, accountId: row.accountId, accountName: row.accountName, accountLogin: row.accountLogin, accessSealed: sealer.seal(t.accessToken, aad),
            refreshSealed: sealer.seal(t.refreshToken || refreshToken, aad), expiresAt: now() + t.expiresIn * 1000, scopes: t.scopes.length ? t.scopes.join(' ') : row.scopes, status: 'ok',
          }, now());
          return { accessToken: t.accessToken };
        } catch (err) {
          if (err instanceof AccountError && err.expired) {
            db.setAccountStatus(row.guildId, p.id, row.accountId, 'expired', now());
            log(row.guildId, 'warn', `The connected ${p.label} account “${row.accountName}” must be connected again: ${err.message}`);
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
  function expire(guildId, id, accountId, reason = '') {
    const p = provider(id);
    const row = p ? db.getAccount(guildId, id, accountId) : null;
    if (!row || row.status !== 'ok') return;
    db.setAccountStatus(guildId, id, row.accountId, 'expired', now());
    log(guildId, 'warn', `The connected ${p.label} account “${row.accountName}” must be connected again${reason ? `: ${reason}` : '.'}`);
  }

  /** Disconnect on purpose: tell the platform to drop the permission (best effort), then forget everything about that account. */
  async function disconnect(guildId, id, accountId) {
    const p = provider(id);
    const row = p && accountId ? db.getAccount(guildId, id, accountId) : null;
    if (!row) return false;
    await revokeSealed(p, row);
    db.deleteAccount(guildId, id, row.accountId);
    seen.delete(`${guildId}|${id}|${row.accountId}`);
    return true;
  }

  /** The bot left this server: its accounts are no longer anyone's to read. */
  async function removeGuild(guildId) {
    for (const row of db.listAccounts(guildId)) await disconnect(guildId, row.provider, row.accountId).catch(() => {});
    db.deleteGuildAccounts(guildId);
  }

  return { list, flags, noteCount, authorizeUrl, complete, access, expire, disconnect, removeGuild, redirectUri, providers: () => Object.keys(PROVIDERS) };
}
