// "Connect Twitch / TikTok" through the real web app: starting, coming back from the platform, and disconnecting.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { resetLimits } from '../shared/limits.js';
import { A, B, ORIGIN, startHarness } from './helpers/harness.js';
import { pretendProviders } from './helpers/providers.js';

const KEYS = { youtube: '', twitch: { clientId: 'tw-id', clientSecret: 'tw-secret' }, tiktok: { clientKey: 'tt-key', clientSecret: 'tt-secret' } };
const stateOf = (url) => new URL(url).searchParams.get('state');
const cookieOf = (res) => (res.res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('fc_conn='));

describe('connecting an account from the dashboard', () => {
  let h; let net;
  const boot = async (integrations = KEYS) => { net = pretendProviders(); h = await startHarness({ config: { integrations, accountsFetch: net.fetch } }); };
  beforeEach(async () => { resetLimits(); await boot(); });
  afterEach(async () => { resetLimits(); mock.timers.reset(); await h.close(); });

  const start = (provider = 'twitch', gid = A, opts = {}) => h.call('POST', `/api/guilds/${gid}/accounts/${provider}/start`, opts);
  const back = (provider, query, { cookieState, sid } = {}) => h.call('GET', `/auth/${provider}/callback?${new URLSearchParams(query)}`, { origin: null, sid, headers: cookieState ? { cookie: `fc_conn=${cookieState}` } : {} });
  const location = (r) => r.res.headers.get('location');
  /** A whole successful connection, up to the platform sending the person back. */
  async function approve(provider = 'twitch', gid = A) {
    const s = await start(provider, gid);
    assert.equal(s.status, 200, s.text);
    const state = stateOf(s.json.url);
    return { state, cookie: cookieOf(s), done: () => back(provider, { code: 'good-code', state }, { cookieState: state }) };
  }

  describe('starting', () => {
    it('gives the platform\'s approval page, and a single-use cookie that only the callback path sees', async () => {
      const s = await start('twitch');
      assert.equal(s.status, 200, s.text);
      const url = new URL(s.json.url);
      assert.equal(url.host, 'id.twitch.tv');
      assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/auth/twitch/callback`);
      const state = url.searchParams.get('state');
      assert.match(state, /^[0-9a-f]{48}$/);
      assert.equal(cookieOf(s), `fc_conn=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600`);
      assert.equal(new URL((await start('tiktok')).json.url).host, 'www.tiktok.com');
    });

    it('every start gets its own state', async () => {
      const a = stateOf((await start()).json.url);
      const b = stateOf((await start()).json.url);
      assert.notEqual(a, b);
    });

    it('needs a signed-in person, a same-origin request, and permission to manage that server', async () => {
      assert.equal((await start('twitch', A, { sid: null })).status, 401);
      assert.equal((await start('twitch', A, { origin: 'https://evil.example' })).status, 403);
      const stranger = h.session([A], 'u2'); // signed in, but not a manager of the server
      assert.equal((await start('twitch', A, { sid: stranger })).status, 403);
      assert.equal((await start('twitch', '999999')).status, 403, 'a server this person cannot see');
      assert.equal((await h.call('GET', `/api/guilds/${A}/accounts`, { sid: stranger })).status, 403);
    });

    it('says plainly when the platform is unknown or the bot operator has not set it up', async () => {
      assert.equal((await start('myspace')).status, 404);
      await h.close();
      await boot({ youtube: '', twitch: { clientId: '', clientSecret: '' }, tiktok: { clientKey: '', clientSecret: '' } });
      const r = await start('tiktok');
      assert.equal(r.status, 400);
      assert.match(r.json.error, /TikTok has not been set up by the bot operator/);
    });

    it('is limited, so nobody can use it to hammer the platforms', async () => {
      let last;
      for (let i = 0; i < 21; i += 1) last = await start();
      assert.equal(last.status, 429);
      assert.match(last.json.error, /Too many connect attempts/);
    });
  });

  describe('coming back from the platform', () => {
    it('connects the account, sends the person to that server\'s page, and shows it (never the tokens)', async () => {
      const { done } = await approve('twitch');
      const r = await done();
      assert.equal(r.status, 302);
      assert.equal(location(r), `/?connect=ok&provider=twitch#/g/${A}`);
      assert.match((r.res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('fc_conn=')) ?? '', /^fc_conn=; .*Max-Age=0/, 'the cookie is cleared');

      const list = await h.call('GET', `/api/guilds/${A}/accounts`);
      assert.equal(list.status, 200);
      assert.deepEqual(list.json.find((x) => x.provider === 'twitch'), { provider: 'twitch', label: 'Twitch', configured: true, connected: true, status: 'ok', account: 'Streamer', connectedAt: list.json[0].connectedAt });
      assert.deepEqual(list.json.find((x) => x.provider === 'tiktok').connected, false);
      assert.ok(!/tw-access|tw-refresh|v1\./.test(list.text), 'no token in the answer');
      assert.ok(h.logger.recent(A, 10).some((l) => l.level === 'info' && /Twitch account “Streamer” was connected/.test(l.message)));
    });

    it('keeps the tokens sealed in the database', async () => {
      await (await approve('tiktok')).done();
      const row = h.db.getAccount(A, 'tiktok');
      assert.equal(row.accountName, 'Dancer');
      assert.ok(!JSON.stringify(row).includes('tt-access') && !JSON.stringify(row).includes('tt-refresh'));
      assert.match(row.accessSealed, /^v1\./);
    });

    it('is another server\'s business only for that server', async () => {
      await (await approve('twitch', A)).done();
      assert.equal((await h.call('GET', `/api/guilds/${B}/accounts`)).json.find((x) => x.provider === 'twitch').connected, false);
      assert.deepEqual(h.accounts.flags(B), { twitch: false, tiktok: false });
    });

    it('does nothing without the matching cookie (someone else\'s link, or a forged callback)', async () => {
      const { state } = await approve();
      const noCookie = await back('twitch', { code: 'good-code', state });
      assert.equal(location(noCookie), '/?connect=failed&provider=twitch');
      const wrongCookie = await back('twitch', { code: 'good-code', state }, { cookieState: 'f'.repeat(48) });
      assert.equal(location(wrongCookie), '/?connect=failed&provider=twitch');
      assert.deepEqual(h.db.listAccounts(A), []);
      assert.equal(net.calls.filter((c) => c.path === '/oauth2/token').length, 0, 'the platform was never asked to trade the code');
    });

    it('does nothing for a state it never made', async () => {
      const forged = 'a'.repeat(48);
      const r = await back('twitch', { code: 'good-code', state: forged }, { cookieState: forged });
      assert.equal(location(r), '/?connect=failed&provider=twitch');
      assert.deepEqual(h.db.listAccounts(A), []);
    });

    it('works once: the same link cannot be used twice', async () => {
      const { state, done } = await approve();
      assert.match(location(await done()), /connect=ok/);
      h.db.deleteAccount(A, 'twitch');
      const again = await back('twitch', { code: 'good-code', state }, { cookieState: state });
      assert.equal(location(again), '/?connect=failed&provider=twitch');
      assert.deepEqual(h.db.listAccounts(A), []);
    });

    it('does nothing for another provider\'s state (a TikTok approval cannot finish a Twitch connection)', async () => {
      const { state } = await approve('tiktok');
      const r = await back('twitch', { code: 'good-code', state }, { cookieState: state });
      assert.equal(location(r), '/?connect=failed&provider=twitch');
      assert.deepEqual(h.db.listAccounts(A), []);
    });

    it('does nothing when someone else is signed in by the time it comes back', async () => {
      const { state } = await approve();
      const other = h.session([A], 'u2');
      h.state.managers.add(`${A}:u2`);
      const r = await back('twitch', { code: 'good-code', state }, { cookieState: state, sid: other });
      assert.equal(location(r), '/');
      assert.deepEqual(h.db.listAccounts(A), []);
    });

    it('does nothing when nobody is signed in', async () => {
      const { state } = await approve();
      const r = await back('twitch', { code: 'good-code', state }, { cookieState: state, sid: null });
      assert.equal(location(r), '/');
      assert.deepEqual(h.db.listAccounts(A), []);
    });

    it('does nothing when the person lost the right to manage the server in the meantime', async () => {
      const { done } = await approve();
      h.state.managers.delete(`${A}:u1`);
      const r = await done();
      assert.equal(location(r), `/?connect=failed&provider=twitch#/g/${A}`);
      assert.deepEqual(h.db.listAccounts(A), []);
    });

    it('does nothing after ten minutes', async () => {
      const { done } = await approve();
      const later = Date.now() + 11 * 60_000;
      const spy = mock.method(Date, 'now', () => later);
      try {
        assert.equal(location(await done()), '/?connect=failed&provider=twitch');
      } finally { spy.mock.restore(); }
      assert.deepEqual(h.db.listAccounts(A), []);
    });

    it('is told so when the creator said no', async () => {
      const { state } = await approve();
      const r = await back('twitch', { error: 'access_denied', state }, { cookieState: state });
      assert.equal(location(r), `/?connect=denied&provider=twitch#/g/${A}`);
      assert.deepEqual(h.db.listAccounts(A), []);
    });

    it('is told what went wrong when the platform will not trade the code, and nothing is kept', async () => {
      const { state } = await approve();
      const r = await back('twitch', { code: 'stale-code', state }, { cookieState: state });
      const url = new URL(location(r), ORIGIN);
      assert.equal(url.searchParams.get('connect'), 'failed');
      assert.match(url.searchParams.get('reason'), /did not accept the approval/);
      assert.equal(url.hash, `#/g/${A}`);
      assert.deepEqual(h.db.listAccounts(A), []);
      assert.ok(h.logger.recent(A, 10).some((l) => l.level === 'warn' && /Connecting twitch failed/.test(l.message)));
    });

    it('never puts a surprise in the message when something unexpected breaks', async () => {
      await h.close();
      net = pretendProviders();
      h = await startHarness({ config: { integrations: KEYS, accountsFetch: async () => { throw new Error('secret internal detail 10.0.0.5'); } } });
      const { state } = await approve();
      const r = await back('twitch', { code: 'good-code', state }, { cookieState: state });
      const reason = new URL(location(r), ORIGIN).searchParams.get('reason');
      assert.match(reason, /Something went wrong while connecting/);
      assert.ok(!location(r).includes('10.0.0.5'));
    });

    it('needs a code', async () => {
      const { state } = await approve();
      assert.match(location(await back('twitch', { state }, { cookieState: state })), /connect=failed/);
    });

    it('leaves other /auth addresses alone', async () => {
      assert.equal((await h.call('GET', '/auth/myspace/callback', { origin: null })).status, 404);
    });
  });

  describe('disconnecting', () => {
    beforeEach(async () => { await (await approve('twitch')).done(); net.calls.length = 0; });

    it('asks the platform to drop the permission and forgets the account', async () => {
      const r = await h.call('DELETE', `/api/guilds/${A}/accounts/twitch`);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json, { ok: true, removed: true });
      assert.equal(h.db.getAccount(A, 'twitch'), null);
      assert.ok(net.calls.some((c) => c.path === '/oauth2/revoke'));
      assert.equal((await h.call('GET', `/api/guilds/${A}/accounts`)).json.find((x) => x.provider === 'twitch').connected, false);
    });

    it('needs the same rights as connecting', async () => {
      assert.equal((await h.call('DELETE', `/api/guilds/${A}/accounts/twitch`, { origin: 'https://evil.example' })).status, 403);
      assert.equal((await h.call('DELETE', `/api/guilds/${A}/accounts/twitch`, { sid: null })).status, 401);
      assert.equal((await h.call('DELETE', `/api/guilds/${A}/accounts/twitch`, { sid: h.session([A], 'u2') })).status, 403);
      assert.equal((await h.call('DELETE', `/api/guilds/${A}/accounts/myspace`)).status, 404);
      assert.equal(h.db.getAccount(A, 'twitch').status, 'ok');
    });

    it('only touches its own server', async () => {
      await (await approve('twitch', B)).done();
      await h.call('DELETE', `/api/guilds/${A}/accounts/twitch`);
      assert.equal(h.db.getAccount(B, 'twitch').status, 'ok');
    });
  });
});
