// The one-time state of a “Connect Twitch / TikTok” in progress is kept in the database (as a hash): it survives a restart of the bot.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { createAccounts } from '../server/accounts.js';
import { createAuth } from '../server/auth.js';
import { createConnect } from '../server/connect.js';
import { Database } from '../server/db.js';
import { Logger } from '../server/logger.js';
import { pretendProviders } from './helpers/providers.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const G = '111';
const KEYS = { youtube: '', twitch: { clientId: 'tw-id', clientSecret: 'tw-secret' }, tiktok: { clientKey: 'k', clientSecret: 's' } };
const CONFIG = { baseUrl: 'https://bot.example.com', clientSecret: 'discord', tokenKey: '', integrations: KEYS, sessionTtlMs: 3600e3 };

describe('the database part', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());
  const entry = (over = {}) => ({ guildId: G, userId: 'u1', provider: 'twitch', expiresAt: 1000, ...over });

  it('hands a state back once, and only once', () => {
    db.putConnectState('h1', entry());
    assert.deepEqual(db.takeConnectState('h1'), { guildId: G, userId: 'u1', provider: 'twitch', expiresAt: 1000 });
    assert.equal(db.takeConnectState('h1'), null);
    assert.equal(db.takeConnectState('never-seen'), null);
  });

  it('forgets the ones that ran out', () => {
    db.putConnectState('old', entry({ expiresAt: 500 }));
    db.putConnectState('current', entry({ expiresAt: 5000 }));
    db.pruneConnectStates(1000);
    assert.equal(db.takeConnectState('old'), null);
    assert.ok(db.takeConnectState('current'));
  });

  it('never keeps more than a few hundred, dropping the ones that would run out first', () => {
    for (let i = 0; i < 12; i += 1) db.putConnectState(`h${i}`, entry({ expiresAt: 1000 + i }), 5);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM connect_pending').get().n, 5);
    assert.equal(db.takeConnectState('h0'), null);
    assert.ok(db.takeConnectState('h11'));
  });
});

describe('across a restart', () => {
  let db; let net; let server; let base; let calls; let t;
  const accountsFor = () => createAccounts({ config: CONFIG, db, fetch: net.fetch, now: () => t, logger: new Logger({ console: false }) });
  /** A bot that has just started: nothing in memory from before, only the database. */
  async function startBot() {
    const auth = createAuth({ config: CONFIG, db });
    const accounts = accountsFor();
    const connect = createConnect({ config: CONFIG, db, auth, accounts, bot: { hasGuild: () => true, canManage: async () => true }, runtime: { loadGuild: (g) => calls.push(g) }, logger: new Logger({ console: false }), now: () => t });
    const app = express();
    app.use(connect.router);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    return { connect, accounts };
  }
  const stopBot = () => new Promise((r) => server.close(r));

  beforeEach(() => { db = new Database(':memory:'); net = pretendProviders(); calls = []; t = Date.UTC(2026, 0, 1); });
  afterEach(async () => { await stopBot().catch(() => {}); db.close(); });

  it('a connection started before the bot restarted can be finished after it', async () => {
    const before = await startBot();
    const res = { headers: [], append(k, v) { this.headers.push([k, v]); } };
    const url = before.connect.begin(res, { guildId: G, userId: 'u1', provider: 'twitch' });
    const state = new URL(url).searchParams.get('state');
    await stopBot(); // the bot restarts: everything in its memory is gone
    await startBot();
    const sid = db.createSession('u1', { user: { id: 'u1', name: 'Mia', avatar: null }, guilds: [{ id: G, name: 'g', icon: null }] }, 3600e3);
    const back = await fetch(`${base}/auth/twitch/callback?code=good-code&state=${state}`, { redirect: 'manual', headers: { cookie: `fc_session=${sid}; fc_conn=${state}` } });
    assert.equal(back.headers.get('location'), `/?connect=ok&provider=twitch#/g/${G}`);
    assert.deepEqual(db.listAccounts(G).map((a) => a.accountName), ['Streamer']);
    assert.deepEqual(calls, [G], 'and the waiting flows were started');
  });

  it('the state is not stored as it is given out (a copy of the database is not enough to finish someone\'s connection)', async () => {
    const { connect } = await startBot();
    const url = connect.begin({ append() {} }, { guildId: G, userId: 'u1', provider: 'twitch' });
    const state = new URL(url).searchParams.get('state');
    const rows = db.db.prepare('SELECT * FROM connect_pending').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state_hash, sha(state));
    assert.ok(!JSON.stringify(rows).includes(state));
  });

  it('a state that ran out while the bot was off is refused', async () => {
    const { connect } = await startBot();
    const state = new URL(connect.begin({ append() {} }, { guildId: G, userId: 'u1', provider: 'twitch' })).searchParams.get('state');
    t += 11 * 60_000;
    const sid = db.createSession('u1', { user: { id: 'u1', name: 'Mia', avatar: null }, guilds: [{ id: G, name: 'g', icon: null }] }, 3600e3);
    const back = await fetch(`${base}/auth/twitch/callback?code=good-code&state=${state}`, { redirect: 'manual', headers: { cookie: `fc_session=${sid}; fc_conn=${state}` } });
    assert.equal(back.headers.get('location'), '/?connect=failed&provider=twitch');
    assert.deepEqual(db.listAccounts(G), []);
  });
});
