// The creator accounts a server connects (Twitch, TikTok): approving, keeping the tokens sealed, and keeping them working.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AccountError, createAccounts } from '../server/accounts.js';
import { Database } from '../server/db.js';
import { Logger } from '../server/logger.js';
import { createSealer } from '../server/secrets.js';
import { pretendProviders } from './helpers/providers.js';

const MIN = 60_000;
const G = '111';
const H = '222';
const CONFIG = {
  baseUrl: 'https://bot.example.com', clientSecret: 'discord-secret', tokenKey: '',
  integrations: { youtube: '', twitch: { clientId: 'tw-id', clientSecret: 'tw-secret' }, tiktok: { clientKey: 'tt-key', clientSecret: 'tt-secret' } },
};

describe('connected accounts', () => {
  let db; let net; let accounts; let t; let logger;
  const build = (config = CONFIG, extra = {}) => {
    db = new Database(':memory:');
    logger = new Logger({ console: false });
    net = pretendProviders();
    t = Date.UTC(2026, 0, 1);
    accounts = createAccounts({ config, db, fetch: net.fetch, now: () => t, logger, ...extra });
  };
  beforeEach(() => build());
  const rejects = (promise, pattern) => assert.rejects(promise, (e) => { assert.ok(e instanceof AccountError, `not an AccountError: ${e?.stack}`); assert.match(e.message, pattern); return true; });

  describe('the approval page', () => {
    it('Twitch: asks only for the follower permission, and sends the person back to this server\'s address', () => {
      const url = new URL(accounts.authorizeUrl('twitch', 'STATE1'));
      assert.equal(`${url.origin}${url.pathname}`, 'https://id.twitch.tv/oauth2/authorize');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        client_id: 'tw-id', redirect_uri: 'https://bot.example.com/auth/twitch/callback', response_type: 'code', scope: 'moderator:read:followers', state: 'STATE1', force_verify: 'true',
      });
    });

    it('TikTok: asks for the basic profile and the stats, with the client key', () => {
      const url = new URL(accounts.authorizeUrl('tiktok', 'STATE2'));
      assert.equal(`${url.origin}${url.pathname}`, 'https://www.tiktok.com/v2/auth/authorize/');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        client_key: 'tt-key', scope: 'user.info.basic,user.info.stats', response_type: 'code', redirect_uri: 'https://bot.example.com/auth/tiktok/callback', state: 'STATE2',
      });
    });

    it('is refused, in plain words, when the bot operator has not set the platform up — and for a platform that does not exist', () => {
      build({ ...CONFIG, integrations: { youtube: '', twitch: { clientId: '', clientSecret: '' }, tiktok: { clientKey: 'k', clientSecret: '' } } });
      assert.throws(() => accounts.authorizeUrl('twitch', 's'), (e) => e instanceof AccountError && /Twitch has not been set up by the bot operator/.test(e.message));
      assert.throws(() => accounts.authorizeUrl('tiktok', 's'), /TikTok has not been set up/);
      assert.throws(() => accounts.authorizeUrl('myspace', 's'), /not been set up/);
      assert.deepEqual(accounts.list(G).map((a) => [a.provider, a.configured]), [['twitch', false], ['tiktok', false]]);
    });
  });

  describe('connecting', () => {
    it('Twitch: trades the code for tokens, learns whose account it is, and keeps the tokens sealed', async () => {
      const done = await accounts.complete(G, 'twitch', 'u1', 'good-code');
      assert.deepEqual(done, { provider: 'twitch', account: 'Streamer' });
      const exchange = net.calls.find((c) => c.path === '/oauth2/token');
      assert.deepEqual(exchange.body, { client_id: 'tw-id', client_secret: 'tw-secret', code: 'good-code', grant_type: 'authorization_code', redirect_uri: 'https://bot.example.com/auth/twitch/callback' });
      const row = db.getAccount(G, 'twitch');
      assert.equal(row.accountId, '555');
      assert.equal(row.accountLogin, 'streamer');
      assert.equal(row.connectedBy, 'u1');
      assert.equal(row.status, 'ok');
      for (const sealed of [row.accessSealed, row.refreshSealed]) assert.match(sealed, /^v1\./);
      assert.ok(!JSON.stringify(row).includes('tw-access') && !JSON.stringify(row).includes('tw-refresh'), 'no token in plain text');
      assert.deepEqual(accounts.flags(G), { twitch: true, tiktok: false });
    });

    it('TikTok: the same, with the client key and the open id', async () => {
      const done = await accounts.complete(G, 'tiktok', 'u1', 'good-code');
      assert.deepEqual(done, { provider: 'tiktok', account: 'Dancer' });
      assert.deepEqual(net.calls.find((c) => c.path === '/v2/oauth/token/').body, {
        client_key: 'tt-key', client_secret: 'tt-secret', code: 'good-code', grant_type: 'authorization_code', redirect_uri: 'https://bot.example.com/auth/tiktok/callback',
      });
      assert.equal(db.getAccount(G, 'tiktok').accountId, 'tt-open-1');
      assert.deepEqual(accounts.flags(G), { twitch: false, tiktok: true });
    });

    it('what the dashboard is shown never contains a token', async () => {
      await accounts.complete(G, 'twitch', 'u1', 'good-code');
      const shown = JSON.stringify([accounts.list(G), db.listAccounts(G)]);
      assert.ok(!/tw-access|tw-refresh|v1\./.test(shown), shown);
      assert.deepEqual(accounts.list(G).find((a) => a.provider === 'twitch'), { provider: 'twitch', label: 'Twitch', configured: true, connected: true, status: 'ok', account: 'Streamer', connectedAt: t });
      assert.equal(accounts.list(G).find((a) => a.provider === 'tiktok').connected, false);
    });

    it('a code the platform does not accept connects nothing', async () => {
      await rejects(accounts.complete(G, 'twitch', 'u1', 'old-code'), /did not accept the approval/);
      await rejects(accounts.complete(G, 'tiktok', 'u1', 'old-code'), /did not accept the approval/);
      assert.deepEqual(db.listAccounts(G), []);
    });

    it('is refused when the platform did not give the follower permission (an unticked box)', async () => {
      net.state.twitch.scope = [];
      await rejects(accounts.complete(G, 'twitch', 'u1', 'good-code'), /did not give the permission to read the follower count/);
      net.state.tiktok.scope = 'user.info.basic';
      await rejects(accounts.complete(G, 'tiktok', 'u1', 'good-code'), /did not give the permission/);
      assert.deepEqual(db.listAccounts(G), []);
    });

    it('is refused when the operator\'s keys are wrong', async () => {
      const original = net.fetch;
      net.fetch = async (url, o) => (String(url).includes('/oauth2/token') ? { status: 403, text: '{"message":"invalid client secret"}' } : original(url, o));
      accounts = createAccounts({ config: CONFIG, db, fetch: net.fetch, now: () => t, logger });
      await rejects(accounts.complete(G, 'twitch', 'u1', 'good-code'), /refused the bot operator’s Client ID or Secret/);
    });

    it('each server has its own connection, and connecting again replaces it', async () => {
      await accounts.complete(G, 'twitch', 'u1', 'good-code');
      assert.deepEqual(accounts.flags(H), { twitch: false, tiktok: false });
      net.state.twitch.user = { id: '999', login: 'other', display_name: 'Other' };
      await accounts.complete(G, 'twitch', 'u2', 'good-code');
      assert.equal(db.listAccounts(G).length, 1);
      assert.equal(db.getAccount(G, 'twitch').accountName, 'Other');
      assert.equal(db.getAccount(G, 'twitch').connectedBy, 'u2');
    });

    it('connecting another account lets go of the old one at the platform', async () => {
      await accounts.complete(G, 'twitch', 'u1', 'good-code');
      const oldToken = [...net.live.twitch][0];
      net.state.twitch.user = { id: '999', login: 'other', display_name: 'Other' };
      await accounts.complete(G, 'twitch', 'u1', 'good-code');
      await new Promise((r) => setImmediate(r));
      assert.ok(net.calls.some((c) => c.path === '/oauth2/revoke' && c.body.token === oldToken), 'the old token was revoked');
      assert.ok(!net.live.twitch.has(oldToken));
    });
  });

  describe('using the tokens', () => {
    beforeEach(async () => { await accounts.complete(G, 'twitch', 'u1', 'good-code'); net.calls.length = 0; });

    it('hands out the token without asking the platform while it is good for a while', async () => {
      const a = await accounts.access(G, 'twitch');
      assert.equal(a.accountId, '555');
      assert.equal(a.accountName, 'Streamer');
      assert.equal(a.accountLogin, 'streamer');
      assert.ok(net.live.twitch.has(a.token));
      t += 30 * MIN;
      assert.equal((await accounts.access(G, 'twitch')).token, a.token);
      assert.equal(net.calls.length, 0);
    });

    it('renews a token that is about to end, and keeps the NEW refresh token the platform returned', async () => {
      const first = await accounts.access(G, 'twitch');
      t += 59 * MIN; // a token lives an hour: two minutes before the end it is renewed
      const second = await accounts.access(G, 'twitch');
      assert.notEqual(second.token, first.token);
      assert.equal(net.calls.filter((c) => c.body.grant_type === 'refresh_token').length, 1);
      assert.ok(net.live.twitch.has(second.token));
      t += 59 * MIN;
      const third = await accounts.access(G, 'twitch'); // only works if the rotated refresh token was kept
      assert.notEqual(third.token, second.token);
      assert.equal(db.getAccount(G, 'twitch').status, 'ok');
    });

    it('renews on request (the platform just refused the token)', async () => {
      const first = await accounts.access(G, 'twitch');
      const fresh = await accounts.access(G, 'twitch', { fresh: true });
      assert.notEqual(fresh.token, first.token);
    });

    it('renews ONCE when many looks need a token at the same moment (refresh tokens work once)', async () => {
      t += 59 * MIN;
      const all = await Promise.all(Array.from({ length: 8 }, () => accounts.access(G, 'twitch')));
      assert.equal(net.calls.filter((c) => c.body.grant_type === 'refresh_token').length, 1, 'one refresh request');
      assert.equal(new Set(all.map((a) => a.token)).size, 1, 'everyone got the same new token');
      assert.equal(db.getAccount(G, 'twitch').status, 'ok');
    });

    it('a refresh the platform refuses marks the account “connect again”, and nothing more is asked', async () => {
      t += 59 * MIN;
      net.state.twitch.failRefresh = true;
      await rejects(accounts.access(G, 'twitch'), /no longer accepts this connection/);
      assert.equal(db.getAccount(G, 'twitch').status, 'expired');
      assert.deepEqual(accounts.flags(G), { twitch: false, tiktok: false });
      assert.equal(accounts.list(G).find((a) => a.provider === 'twitch').status, 'expired');
      net.calls.length = 0;
      await rejects(accounts.access(G, 'twitch'), /needs to be connected again/);
      assert.equal(net.calls.length, 0, 'no more requests while it is expired');
      assert.ok(logger.recent(G, 20).some((l) => l.level === 'warn' && /must be connected again/.test(l.message)));
    });

    it('a hiccup (the platform is down, or the network) does not disconnect anything', async () => {
      t += 59 * MIN;
      const real = net.fetch;
      const flaky = createAccounts({ config: CONFIG, db, fetch: async () => { throw new Error('The site took too long to answer.'); }, now: () => t, logger });
      await assert.rejects(flaky.access(G, 'twitch'), /took too long/);
      assert.equal(db.getAccount(G, 'twitch').status, 'ok');
      const down = createAccounts({ config: CONFIG, db, fetch: async () => ({ status: 503, text: '' }), now: () => t, logger });
      await rejects(down.access(G, 'twitch'), /answered with an error \(503\)/);
      assert.equal(db.getAccount(G, 'twitch').status, 'ok');
      assert.ok((await createAccounts({ config: CONFIG, db, fetch: real, now: () => t, logger }).access(G, 'twitch')).token, 'and it works again afterwards');
    });

    it('wrong operator keys on a refresh are not the creator\'s fault: the account stays connected', async () => {
      t += 59 * MIN;
      const wrong = createAccounts({ config: CONFIG, db, fetch: async () => ({ status: 400, text: '{"status":400,"message":"invalid client"}' }), now: () => t, logger });
      await rejects(wrong.access(G, 'twitch'), /refused the bot operator’s Client ID or Secret/);
      assert.equal(db.getAccount(G, 'twitch').status, 'ok');
    });

    it('says so when nothing is connected, and when it was sealed with a key that is gone', async () => {
      await rejects(accounts.access(H, 'twitch'), /No Twitch account is connected to this server/);
      await rejects(accounts.access(G, 'tiktok'), /No TikTok account is connected/);
      const rekeyed = createAccounts({ config: { ...CONFIG, tokenKey: 'a-completely-different-key' }, db, fetch: net.fetch, now: () => t, logger });
      await rejects(rekeyed.access(G, 'twitch'), /needs to be connected again/);
      assert.equal(db.getAccount(G, 'twitch').status, 'expired');
    });

    it('a sealed token moved to another server\'s row does not open', async () => {
      const mine = db.getAccount(G, 'twitch');
      db.saveAccount({ ...mine, guildId: H }); // as if someone copied the row in the database file
      await rejects(accounts.access(H, 'twitch'), /needs to be connected again/);
      assert.equal(db.getAccount(H, 'twitch').status, 'expired');
    });

    it('a dedicated key and the fallback both work, and tokens survive a restart', async () => {
      const sealer = createSealer({ key: 'dedicated-key-for-tests', fallback: 'x' });
      const dedicated = createAccounts({ config: { ...CONFIG, tokenKey: 'dedicated-key-for-tests' }, db, fetch: net.fetch, now: () => t, logger });
      await dedicated.complete(H, 'twitch', 'u1', 'good-code');
      assert.equal(sealer.open(db.getAccount(H, 'twitch').accessSealed, `${H}|twitch`) !== null, true);
      const restarted = createAccounts({ config: { ...CONFIG, tokenKey: 'dedicated-key-for-tests' }, db, fetch: net.fetch, now: () => t, logger });
      assert.ok((await restarted.access(H, 'twitch')).token);
    });

    it('expire() puts an account into “connect again” (when the platform keeps refusing it)', async () => {
      accounts.expire(G, 'twitch', 'because');
      assert.equal(db.getAccount(G, 'twitch').status, 'expired');
      assert.deepEqual(accounts.flags(G).twitch, false);
      accounts.expire(G, 'twitch'); // nothing to do the second time, and no second log line
      assert.equal(logger.recent(G, 20).filter((l) => /must be connected again/.test(l.message)).length, 1);
      accounts.expire(H, 'twitch'); // a server with nothing connected: nothing happens
    });
  });

  describe('TikTok tokens', () => {
    beforeEach(async () => { await accounts.complete(G, 'tiktok', 'u1', 'good-code'); net.calls.length = 0; });

    it('last a day, renew with the client key, and keep a rotated refresh token', async () => {
      const first = await accounts.access(G, 'tiktok');
      t += 23 * 3600_000 + 59 * MIN;
      const second = await accounts.access(G, 'tiktok');
      assert.notEqual(second.token, first.token);
      assert.deepEqual(net.calls.find((c) => c.body.grant_type === 'refresh_token').body, { client_key: 'tt-key', client_secret: 'tt-secret', grant_type: 'refresh_token', refresh_token: net.calls[0].body.refresh_token });
      t += 23 * 3600_000 + 59 * MIN;
      assert.ok((await accounts.access(G, 'tiktok')).token);
    });

    it('a refresh token TikTok no longer accepts means “connect again”', async () => {
      t += 24 * 3600_000;
      net.state.tiktok.failRefresh = true;
      await rejects(accounts.access(G, 'tiktok'), /TikTok no longer accepts this connection/);
      assert.equal(db.getAccount(G, 'tiktok').status, 'expired');
    });
  });

  describe('disconnecting', () => {
    beforeEach(async () => { await accounts.complete(G, 'twitch', 'u1', 'good-code'); await accounts.complete(G, 'tiktok', 'u1', 'good-code'); net.calls.length = 0; });

    it('tells the platform to drop the permission, then forgets everything', async () => {
      const token = (await accounts.access(G, 'twitch')).token;
      net.calls.length = 0;
      assert.equal(await accounts.disconnect(G, 'twitch'), true);
      assert.deepEqual(net.calls.map((c) => [c.path, c.body.token]), [['/oauth2/revoke', token]]);
      assert.equal(db.getAccount(G, 'twitch'), null);
      assert.equal(db.getAccount(G, 'tiktok').status, 'ok', 'the other one is untouched');
      assert.equal(await accounts.disconnect(G, 'twitch'), false, 'nothing left to disconnect');
    });

    it('still disconnects when the platform cannot be reached', async () => {
      const offline = createAccounts({ config: CONFIG, db, fetch: async () => { throw new Error('offline'); }, now: () => t, logger });
      assert.equal(await offline.disconnect(G, 'twitch'), true);
      assert.equal(db.getAccount(G, 'twitch'), null);
    });

    it('a server the bot left loses every connected account (and only that server\'s)', async () => {
      await accounts.complete(H, 'twitch', 'u1', 'good-code');
      await accounts.removeGuild(G);
      assert.deepEqual(db.listAccounts(G), []);
      assert.equal(db.listAccounts(H).length, 1);
      assert.ok(net.calls.some((c) => c.path === '/oauth2/revoke') && net.calls.some((c) => c.path === '/v2/oauth/revoke/'), 'both were revoked');
    });
  });
});
