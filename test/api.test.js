import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { applyLimits, LIMITS, resetLimits } from '../shared/limits.js';
import { createApp } from '../server/app.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeGuild, node } from './helpers/fakes.js';

const A = '111111'; const B = '222222'; const C = '333333';
const ORIGIN = 'http://localhost:3999';
const config = { token: 't', clientId: 'cid', clientSecret: 'secret', baseUrl: ORIGIN, port: 0, host: '127.0.0.1', intents: { members: true, messageContent: false }, minPermission: 'Administrator', sessionTtlMs: 3600e3, trustProxy: false };

let db; let runtime; let logger; let server; let base; let guildA; let syncCalls; let managers; let discordCalls; let discordGuilds;

const bot = {
  ready: true,
  hasGuild: (id) => [A, B].includes(id),
  canManage: async (g, u) => managers.has(`${g}:${u}`),
  guildSummary: (id) => ({ id, name: `Guild ${id}`, icon: null, memberCount: 3 }),
  botPermissions: () => ['SendMessages'],
  channels: () => [{ id: '1', name: 'general', type: 'GuildText', parentId: null }],
  roles: () => [{ id: '2', name: 'Staff', color: '#fff', managed: false }],
  inviteUrl: (g) => `https://discord.com/oauth2/authorize?client_id=cid${g ? `&guild_id=${g}` : ''}`,
};
const sync = { status: new Map(), sync: async (gid) => { syncCalls.push(gid); return { ok: true, count: 0 }; } };

const stubFetch = async (url, init = {}) => {
  const u = String(url);
  discordCalls.push([init.method ?? 'GET', u.replace('https://discord.com/api/v10', '')]);
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.endsWith('/oauth2/token')) return json({ access_token: 'tok', scope: 'identify guilds' });
  if (u.endsWith('/oauth2/token/revoke')) return json({});
  if (u.endsWith('/users/@me')) return json({ id: 'u1', username: 'mia', global_name: 'Mia', avatar: null });
  if (u.includes('/users/@me/guilds')) return json(discordGuilds);
  return { ok: false, status: 404, json: async () => ({}) };
};

before(async () => {
  db = new Database(':memory:');
  logger = new Logger({ console: false });
  runtime = new Runtime({ db, logger, intents: config.intents });
  guildA = fakeGuild({ id: A });
  runtime.attachClient(guildA.client);
  const app = createApp({ config, db, runtime, bot, sync, logger, fetchImpl: stubFetch, distDir: '/nonexistent' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });
beforeEach(() => {
  resetLimits();
  syncCalls = []; discordCalls = []; managers = new Set([`${A}:u1`, `${B}:u1`]);
  discordGuilds = [
    { id: A, name: 'A', owner: false, permissions: '8' },
    { id: C, name: 'C', owner: false, permissions: '32' },
    { id: '444444', name: 'D', owner: true, permissions: '0' },
    { id: '555555', name: 'E', owner: false, permissions: '0' },
  ];
});

const session = (guilds = [A, B]) => db.createSession('u1', { user: { id: 'u1', name: 'Mia', avatar: null }, guilds: guilds.map((id) => ({ id, name: id, icon: null })) }, 3600e3);
async function call(method, path, { body, sid = session(), origin = ORIGIN, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method, redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(sid ? { Cookie: `fc_session=${sid}` } : {}), ...(origin ? { Origin: origin } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, res };
}
const graph = () => commandFlow([node('r', 'action.message.send', { target: 'reply', content: 'hi' })], [edge('t', 'r')], 'hello');

describe('authentication', () => {
  it('requires a session', async () => {
    assert.equal((await call('GET', '/api/me', { sid: null })).status, 401);
    assert.equal((await call('GET', '/api/me', { sid: 'a'.repeat(64) })).status, 401);
    assert.equal((await call('GET', `/api/guilds/${A}/flows`, { sid: null })).status, 401);
  });

  it('login redirects to Discord with a state that is also set as a cookie', async () => {
    const { status, res } = await call('GET', '/auth/login', { sid: null });
    assert.equal(status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(loc.searchParams.get('scope'), 'identify guilds');
    assert.equal(loc.searchParams.get('redirect_uri'), `${ORIGIN}/auth/callback`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('fc_state='));
    assert.ok(cookie.includes(loc.searchParams.get('state')));
    assert.match(cookie, /HttpOnly/);
  });

  it('callback rejects a missing or mismatched state and never calls Discord', async () => {
    for (const cookie of [undefined, 'fc_state=other']) {
      const r = await fetch(`${base}/auth/callback?code=abc&state=expected`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/?login=failed');
    }
    assert.equal(discordCalls.length, 0);
  });

  it('callback creates a session with only the servers the user can manage, and revokes the token', async () => {
    const r = await fetch(`${base}/auth/callback?code=abc&state=s3cret`, { redirect: 'manual', headers: { Cookie: 'fc_state=s3cret' } });
    assert.equal(r.headers.get('location'), '/');
    const setCookie = r.headers.getSetCookie().find((c) => c.startsWith('fc_session='));
    const sid = setCookie.split(';')[0].split('=')[1];
    assert.match(setCookie, /HttpOnly; SameSite=Lax/);
    const me = await call('GET', '/api/me', { sid });
    assert.deepEqual(me.json.guilds.map((g) => g.id).sort(), [A, '444444'].sort(), 'admin + owner only');
    assert.equal(me.json.guilds.find((g) => g.id === A).botPresent, true);
    assert.match(me.json.guilds.find((g) => g.id === '444444').inviteUrl, /guild_id=444444/);
    assert.ok(discordCalls.some(([m, p]) => m === 'POST' && p === '/oauth2/token/revoke'), 'token revoked');
    const stored = JSON.stringify(db.db.prepare('SELECT * FROM sessions').all());
    assert.ok(!stored.includes('"tok"') && !stored.includes('access_token'), 'the OAuth token is not stored');
  });

  it('logout deletes the session', async () => {
    const sid = session();
    assert.equal((await call('POST', '/auth/logout', { sid })).status, 200);
    assert.equal((await call('GET', '/api/me', { sid })).status, 401);
  });
});

describe('authorisation and tenant isolation', () => {
  it('blocks servers you cannot manage', async () => {
    assert.equal((await call('GET', `/api/guilds/${C}/flows`, { sid: session([A, B]) })).status, 403, 'not in your session');
    managers.delete(`${B}:u1`);
    assert.equal((await call('GET', `/api/guilds/${B}/flows`)).status, 403, 'live permission check says no');
    assert.equal((await call('GET', `/api/guilds/${A}/flows`)).status, 200);
    assert.equal((await call('GET', `/api/guilds/${C}/flows`, { sid: session([A, B, C]) })).status, 404, 'bot is not in that server');
    assert.equal((await call('GET', '/api/guilds/abc/flows')).status, 404);
  });

  it('a flow id from one server cannot be read, changed, run or deleted through another', async () => {
    const created = await call('POST', `/api/guilds/${A}/flows`, { body: { name: 'mine', graph: graph() } });
    assert.equal(created.status, 201);
    const id = created.json.flow.id;
    for (const [m, p, body] of [['GET', ''], ['PUT', '', { name: 'pwned' }], ['DELETE', ''], ['POST', '/duplicate'], ['POST', '/run', { nodeId: 't' }]]) {
      const r = await call(m, `/api/guilds/${B}/flows/${id}${p}`, { body });
      assert.equal(r.status, 404, `${m} ${p}`);
    }
    assert.equal(db.getFlow(A, id).name, 'mine');
    assert.deepEqual((await call('GET', `/api/guilds/${B}/flows`)).json, []);
  });

  it('variables and logs are per server', async () => {
    db.setVar(A, 'guild', '', 'secret', 'A-only');
    logger.log(A, 'info', 'A-log');
    logger.log(B, 'info', 'B-log');
    assert.deepEqual((await call('GET', `/api/guilds/${B}/variables`)).json, []);
    assert.equal((await call('GET', `/api/guilds/${A}/variables`)).json[0].value, 'A-only');
    assert.deepEqual((await call('GET', `/api/guilds/${B}/logs`)).json.map((l) => l.message), ['B-log']);
  });

  it('channel variables can be listed, set and removed, and need a real channel ID', async () => {
    const put = (body) => call('PUT', `/api/guilds/${A}/variables`, { body });
    assert.equal((await put({ scope: 'channel', scopeId: '500001', name: 'panel', value: '123456789012345678' })).status, 200);
    assert.equal(db.getVar(A, 'channel', '500001', 'panel'), '123456789012345678');
    const channelRows = async () => (await call('GET', `/api/guilds/${A}/variables`)).json.filter((v) => v.scope === 'channel');
    assert.deepEqual(await channelRows(), [{ scope: 'channel', scopeId: '500001', name: 'panel', value: '123456789012345678' }]);
    assert.equal((await put({ scope: 'channel', name: 'panel', value: 1 })).status, 400, 'a channel variable needs a channel');
    assert.equal((await put({ scope: 'channel', scopeId: 'general', name: 'panel', value: 1 })).status, 400);
    assert.equal((await put({ scope: 'global', name: 'panel', value: 1 })).status, 400);
    assert.deepEqual((await call('GET', `/api/guilds/${B}/variables`)).json.filter((v) => v.scope === 'channel'), [], 'another server sees nothing');
    const gone = await call('DELETE', `/api/guilds/${A}/variables?${new URLSearchParams({ scope: 'channel', scopeId: '500001', name: 'panel' })}`);
    assert.equal(gone.status, 200);
    assert.deepEqual(await channelRows(), []);
  });

  it('rejects cross-site and header-less state-changing requests', async () => {
    const body = { name: 'x', graph: graph() };
    assert.equal((await call('POST', `/api/guilds/${A}/flows`, { body, origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('POST', `/api/guilds/${A}/flows`, { body, origin: null })).status, 403);
    assert.equal((await call('POST', `/api/guilds/${A}/flows`, { body, origin: null, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 201);
    assert.equal((await call('GET', `/api/guilds/${A}/flows`, { origin: 'https://evil.example' })).status, 200, 'reads are not state-changing');
  });

  it('sends security headers', async () => {
    const { res } = await call('GET', '/healthz', { sid: null });
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('flows', () => {
  it('creates from a template (disabled), saves, applies and syncs commands', async () => {
    const created = await call('POST', `/api/guilds/${A}/flows`, { body: { templateId: 'counter' } });
    assert.equal(created.status, 201);
    const flow = created.json.flow;
    assert.equal(flow.enabled, false);
    assert.equal(flow.graph.nodes.length, 3);
    assert.equal(runtime.commandsFor(A).length, 0, 'disabled flows are not active');
    const saved = await call('PUT', `/api/guilds/${A}/flows/${flow.id}`, { body: { enabled: true } });
    assert.equal(saved.status, 200);
    assert.deepEqual(runtime.commandsFor(A).map((c) => c.node.data.name), ['count']);
    assert.deepEqual(syncCalls, [A]);
    assert.equal(saved.json.flow.updatedBy.name, 'Mia');
  });

  it('rejects structurally broken graphs without saving them', async () => {
    const bad = { nodes: [node('t', 'trigger.manual')], edges: [edge('t', 'ghost')] };
    const r = await call('POST', `/api/guilds/${A}/flows`, { body: { name: 'bad', graph: bad } });
    assert.equal(r.status, 400);
    assert.ok(r.json.issues.length);
    assert.equal((await call('POST', `/api/guilds/${A}/flows`, { body: { name: '  ', graph: graph() } })).status, 400);
    assert.equal((await call('POST', `/api/guilds/${A}/flows`, { body: { templateId: 'nope' } })).status, 400);
  });

  it('accepts flows with unfinished fields (as warnings) and reports them', async () => {
    const g = { nodes: [node('t', 'trigger.manual'), node('a', 'action.member.addRole', {})], edges: [edge('t', 'a')] };
    const r = await call('POST', `/api/guilds/${A}/flows`, { body: { name: 'wip', graph: g } });
    assert.equal(r.status, 201);
    assert.ok(r.json.flow.issues.some((i) => /Role/.test(i.message)));
  });

  it('enforces size limits', async () => {
    applyLimits({ nodesPerFlow: 150, nodeDataBytes: 24 * 1024, flowsPerGuild: 25 }); // opt-in caps (default is unlimited)
    const many = { nodes: Array.from({ length: LIMITS.nodesPerFlow + 1 }, (_, i) => node(`n${i}`, 'logic.log', { message: 'x' })), edges: [] };
    assert.equal((await call('POST', `/api/guilds/${A}/flows`, { body: { name: 'big', graph: many } })).status, 400);
    const huge = { nodes: [node('t', 'trigger.manual', { channelId: 'x'.repeat(30 * 1024) })], edges: [] };
    assert.equal((await call('POST', `/api/guilds/${A}/flows`, { body: { name: 'huge', graph: huge } })).status, 400);
    for (let i = db.countFlows(B); i < LIMITS.flowsPerGuild; i += 1) db.createFlow({ guildId: B, name: `f${i}`, graph: { nodes: [], edges: [] } });
    assert.equal((await call('POST', `/api/guilds/${B}/flows`, { body: { name: 'one too many', graph: graph() } })).status, 409);
  });

  it('has no policy limits by default, and reports the effective limits to the editor', async () => {
    for (let n = 0; n < 30; n += 1) {
      assert.equal((await call('POST', `/api/guilds/${B}/flows`, { body: { name: `bulk ${n}`, graph: graph() } })).status, 201);
    }
    assert.ok(db.countFlows(B) >= 30, 'more flows than the old cap of 25');
    const many = { nodes: Array.from({ length: 300 }, (_, i) => node(`n${i}`, 'logic.log', { message: 'x' })), edges: [] };
    assert.equal((await call('POST', `/api/guilds/${B}/flows`, { body: { name: '300 nodes', graph: many } })).status, 201);
    const heavy = { nodes: [node('t', 'trigger.manual', { channelId: 'x'.repeat(200 * 1024) })], edges: [] };
    assert.equal((await call('POST', `/api/guilds/${B}/flows`, { body: { name: 'heavy node', graph: heavy } })).status, 201);
    const unlimited = (await call('GET', '/api/me')).json.meta.limits;
    assert.equal(unlimited.flowsPerGuild, null, 'unlimited travels as null');
    assert.equal(unlimited.nodesPerFlow, null);
    applyLimits({ flowsPerGuild: 7 });
    assert.equal((await call('GET', '/api/me')).json.meta.limits.flowsPerGuild, 7);
    assert.equal((await call('POST', `/api/guilds/${B}/flows`, { body: { name: 'over the new cap', graph: graph() } })).status, 409);
  });

  it('deleting a flow removes its commands', async () => {
    const created = (await call('POST', `/api/guilds/${A}/flows`, { body: { name: 'cmd', graph: graph() } })).json.flow;
    await call('PUT', `/api/guilds/${A}/flows/${created.id}`, { body: { enabled: true } });
    assert.equal(runtime.commandsFor(A).some((c) => c.flow.id === created.id), true);
    assert.equal((await call('DELETE', `/api/guilds/${A}/flows/${created.id}`)).status, 200);
    assert.equal(runtime.commandsFor(A).some((c) => c.flow.id === created.id), false);
  });

  it('manual run works only for active manual triggers', async () => {
    const ch = guildA.addChannel({ name: 'panel' });
    const g = { nodes: [node('t', 'trigger.manual', { channelId: ch.id }), node('s', 'action.message.send', { target: 'current_channel', content: 'hello panel' })], edges: [edge('t', 's')] };
    const flow = (await call('POST', `/api/guilds/${A}/flows`, { body: { name: 'panel', graph: g } })).json.flow;
    assert.equal((await call('POST', `/api/guilds/${A}/flows/${flow.id}/run`, { body: { nodeId: 't' } })).status, 400, 'disabled');
    await call('PUT', `/api/guilds/${A}/flows/${flow.id}`, { body: { enabled: true } });
    assert.equal((await call('POST', `/api/guilds/${A}/flows/${flow.id}/run`, { body: { nodeId: 't' } })).status, 200);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ch.sent[0].content, 'hello panel');
  });

  it('variables can be set, listed and deleted with validation', async () => {
    assert.equal((await call('PUT', `/api/guilds/${A}/variables`, { body: { scope: 'global', name: 'x', value: 1 } })).status, 400);
    assert.equal((await call('PUT', `/api/guilds/${A}/variables`, { body: { scope: 'user', scopeId: 'nope', name: 'x', value: 1 } })).status, 400);
    assert.equal((await call('PUT', `/api/guilds/${A}/variables`, { body: { scope: 'guild', name: 'motd', value: 'hello' } })).status, 200);
    assert.ok((await call('GET', `/api/guilds/${A}/variables`)).json.some((v) => v.name === 'motd'));
    assert.equal((await call('DELETE', `/api/guilds/${A}/variables?scope=guild&name=motd`)).json.ok, true);
  });

  it('serves channel and role pickers and guild info', async () => {
    assert.equal((await call('GET', `/api/guilds/${A}/channels`)).json[0].name, 'general');
    assert.equal((await call('GET', `/api/guilds/${A}/roles`)).json[0].name, 'Staff');
    const info = (await call('GET', `/api/guilds/${A}`)).json;
    assert.equal(info.id, A);
    assert.match(info.inviteUrl, /guild_id/);
  });
});

describe('static fallback', () => {
  it('explains when the UI has not been built', async () => {
    const r = await call('GET', '/', { sid: null });
    assert.equal(r.status, 503);
    assert.match(r.text, /npm run build/);
    assert.equal((await call('GET', '/api/nope')).status, 404);
  });
});
