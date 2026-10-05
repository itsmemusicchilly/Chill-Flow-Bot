// The settings and server events around connected accounts: the .env keys, and what happens to a server's accounts when the bot leaves it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { Events } from 'discord.js';
import { createAccounts } from '../server/accounts.js';
import { wireEvents } from '../server/bot/events.js';
import { ConfigError, loadConfig } from '../server/config.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { node, edge, fakeGuild } from './helpers/fakes.js';
import { pretendProviders } from './helpers/providers.js';

describe('the settings for connected accounts', () => {
  const base = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's' };

  it('TikTok\'s keys are read (and trimmed) like the other platforms\', and are off by default', () => {
    assert.deepEqual(loadConfig(base).integrations.tiktok, { clientKey: '', clientSecret: '' });
    const set = loadConfig({ ...base, TIKTOK_CLIENT_KEY: ' key ', TIKTOK_CLIENT_SECRET: ' secret ' }).integrations;
    assert.deepEqual(set.tiktok, { clientKey: 'key', clientSecret: 'secret' });
  });

  it('the token key is optional, trimmed, and must be long enough to mean something', () => {
    assert.equal(loadConfig(base).tokenKey, '');
    assert.equal(loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: '  ' }).tokenKey, '');
    assert.equal(loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: ' a-long-random-secret-1234 ' }).tokenKey, 'a-long-random-secret-1234');
    assert.throws(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'short' }), (e) => e instanceof ConfigError && /TOKEN_ENCRYPTION_KEY must be at least 16 characters/.test(e.message));
  });

  it('never lets a key reach the browser: the editor is told yes or no', async () => {
    const { startHarness } = await import('./helpers/harness.js');
    const h = await startHarness({ config: { integrations: { youtube: '', twitch: { clientId: '', clientSecret: '' }, tiktok: { clientKey: 'SECRET-TT-KEY', clientSecret: 'SECRET-TT-SECRET' } }, tokenKey: 'SECRET-TOKEN-KEY-1234' } });
    try {
      const me = await h.call('GET', '/api/me');
      assert.deepEqual(me.json.meta.integrations, { youtube: false, twitch: false, tiktok: true });
      for (const secret of ['SECRET-TT-KEY', 'SECRET-TT-SECRET', 'SECRET-TOKEN-KEY-1234']) assert.ok(!me.text.includes(secret), `${secret} leaked`);
    } finally { await h.close(); }
  });
});

describe('a server the bot leaves, and joins again', () => {
  let db; let runtime; let client; let guild; let accounts; let net; let logger;
  const KEYS = { youtube: '', twitch: { clientId: 'id', clientSecret: 'secret' }, tiktok: { clientKey: 'k', clientSecret: 's' } };
  const CONFIG = { baseUrl: 'https://bot.example.com', clientSecret: 'discord', tokenKey: '', integrations: KEYS };
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    db = new Database(':memory:');
    logger = new Logger({ console: false });
    net = pretendProviders();
    accounts = createAccounts({ config: CONFIG, db, fetch: net.fetch, logger });
    runtime = new Runtime({ db, logger, integrations: KEYS, accounts, fetcher: net.fetch });
    client = new EventEmitter();
    client.user = { id: 'BOT', username: 'flowbot' };
    guild = fakeGuild({ id: '111111111111111111' });
    runtime.attachClient(client);
    wireEvents({ client, runtime, logger, sync: { sync: async () => ({}) }, accounts, auditDelayMs: 0 });
  });

  it('forgets the connected accounts of that server — and only that server\'s — and tells the platforms', async () => {
    await accounts.complete(guild.id, 'twitch', 'u1', 'good-code');
    await accounts.complete(guild.id, 'tiktok', 'u1', 'good-code');
    await accounts.complete('222222222222222222', 'twitch', 'u1', 'good-code');
    net.calls.length = 0;
    client.emit(Events.GuildDelete, guild);
    await tick();
    assert.deepEqual(db.listAccounts(guild.id), []);
    assert.equal(db.listAccounts('222222222222222222').length, 1);
    assert.ok(net.calls.some((c) => c.path === '/oauth2/revoke') && net.calls.some((c) => c.path === '/v2/oauth/revoke/'));
  });

  it('stops running that server\'s flows, and brings them back when the bot is added again', async () => {
    db.createFlow({ guildId: guild.id, name: 'Hi', graph: { nodes: [node('t', 'trigger.manual', {}), node('m', 'action.message.send', { target: 'channel', content: 'x' })], edges: [edge('t', 'm')] } });
    runtime.loadGuild(guild.id);
    assert.equal(runtime.hasTrigger(guild.id, 'trigger.manual'), true);
    client.emit(Events.GuildDelete, guild);
    await tick();
    assert.equal(runtime.hasTrigger(guild.id, 'trigger.manual'), false, 'nothing runs for a server the bot is not in');
    client.emit(Events.GuildCreate, guild);
    await tick();
    assert.equal(runtime.hasTrigger(guild.id, 'trigger.manual'), true, 'added again: the flows are back');
  });

  it('a failure while clearing is logged, never thrown at Discord', async () => {
    db.deleteGuildAccounts = () => { throw new Error('disk is full'); };
    await accounts.complete(guild.id, 'twitch', 'u1', 'good-code');
    const lines = []; // a line that belongs to no server is not kept in a server's log: watch what is written instead
    const write = logger.log.bind(logger);
    logger.log = (g, level, message, meta) => { lines.push([g, level, message]); return write(g, level, message, meta); };
    client.emit(Events.GuildDelete, guild);
    await tick();
    assert.ok(lines.some(([g, level, m]) => g === null && level === 'warn' && /Could not clear the connected accounts.*disk is full/.test(m)), JSON.stringify(lines));
  });
});
