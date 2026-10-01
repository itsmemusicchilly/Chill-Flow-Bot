// A real Express app + SQLite (in memory) + runtime, with a fake bot and stubbed Discord HTTP, listening on a random port.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import { Database } from '../../server/db.js';
import { Runtime } from '../../server/engine/runtime.js';
import { Logger } from '../../server/logger.js';
import { createTranscripts } from '../../server/transcripts.js';
import { createUploads } from '../../server/uploads.js';
import { fakeGuild, fakeUser } from './fakes.js';

export const ORIGIN = 'http://localhost:3999';
export const A = '111111';
export const B = '222222';
export const STAFF = '333333'; // a role every test server has
export const MEMBERS = '444444'; // and another one

export async function startHarness({ config: over = {}, distDir = '/nonexistent' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-test-')); // uploaded images go here, never into the repo
  const config = {
    token: 't', clientId: 'cid', clientSecret: 'secret', baseUrl: ORIGIN, port: 0, host: '127.0.0.1', dataDir,
    intents: { members: true, messageContent: false }, minPermission: 'Administrator', sessionTtlMs: 3600e3, trustProxy: false, ...over,
  };
  const state = {
    managers: new Set([`${A}:u1`, `${B}:u1`]), members: new Set(), syncCalls: [], discordCalls: [],
    discordGuilds: [], discordUser: { id: 'v1', username: 'visitor', global_name: 'Vee', avatar: null },
  };
  const db = new Database(':memory:');
  const logger = new Logger({ console: false });
  const uploads = createUploads({ config, db, logger });
  const transcripts = createTranscripts({ config, db, logger });
  const runtime = new Runtime({ db, logger, intents: config.intents, uploads, transcripts, integrations: config.integrations, feedMinMinutes: config.feedMinMinutes, ...(over.fetcher ? { fetcher: over.fetcher } : {}) });
  const guilds = { [A]: fakeGuild({ id: A, name: 'Pixel Café' }), [B]: fakeGuild({ id: B, name: 'Dev Sandbox' }) };
  guilds[A].name = 'Pixel Café';
  guilds[B].name = 'Dev Sandbox';
  for (const g of Object.values(guilds)) { g.addRole({ id: STAFF, name: 'Staff' }); g.addRole({ id: MEMBERS, name: 'Members' }); }
  runtime.attachClient(guilds[A].client);
  for (const g of Object.values(guilds)) guilds[A].client.guilds.cache.set(g.id, g);

  const bot = {
    ready: true,
    hasGuild: (id) => id in guilds,
    canManage: async (g, u) => state.managers.has(`${g}:${u}`),
    isMember: async (g, u) => state.members.has(`${g}:${u}`),
    getMember: async (g, u) => (state.members.has(`${g}:${u}`) ? guilds[g].members.cache.get(u) ?? guilds[g].addMember({ user: fakeUser({ id: u, username: 'visitor' }) }) : null),
    guildSummary: (id) => (guilds[id] ? { id, name: guilds[id].name, icon: null, memberCount: 3 } : null),
    botPermissions: () => ['SendMessages'],
    channels: () => [{ id: '1', name: 'general', type: 'GuildText', parentId: null }],
    roles: (g) => [...guilds[g].roles.cache.values()].filter((r) => r.id !== g).map((r) => ({ id: r.id, name: r.name, color: '#fff', managed: false })),
    inviteUrl: (g) => `https://discord.com/oauth2/authorize?client_id=cid${g ? `&guild_id=${g}` : ''}`,
  };
  const sync = { status: new Map(), sync: async (gid) => { state.syncCalls.push(gid); return { ok: true, count: 0 }; } };

  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    state.discordCalls.push([init.method ?? 'GET', u.replace('https://discord.com/api/v10', '')]);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.endsWith('/oauth2/token')) return json({ access_token: 'tok', scope: 'identify' });
    if (u.endsWith('/oauth2/token/revoke')) return json({});
    if (u.endsWith('/users/@me')) return json(state.discordUser);
    if (u.includes('/users/@me/guilds')) return json(state.discordGuilds);
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const app = createApp({ config, db, runtime, bot, sync, logger, fetchImpl, uploads, transcripts, distDir });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const session = (guildIds = [A, B], userId = 'u1') => db.createSession(userId, { user: { id: userId, name: 'Mia', avatar: null }, guilds: guildIds.map((id) => ({ id, name: id, icon: null })) }, 3600e3);
  const visitorSession = (user = { id: 'v1', name: 'Vee', avatar: null }) => db.createSession(user.id, { visitor: true, user }, 3600e3);

  /** JSON API call by default (dashboard cookie); pass `form` for an urlencoded public POST, `visitor` for the visitor cookie. */
  async function call(method, path, { body, form, raw, type = 'image/png', sid = session(), visitor, origin = ORIGIN, headers = {} } = {}) {
    const cookies = [sid && `fc_session=${sid}`, visitor && `fc_visitor=${visitor}`, headers.cookie].filter(Boolean).join('; ');
    const res = await fetch(`${base}${path}`, {
      method, redirect: 'manual',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(raw ? { 'Content-Type': type } : {}),
        ...(cookies ? { Cookie: cookies } : {}), ...(origin ? { Origin: origin } : {}), ...headers, ...(cookies ? { Cookie: cookies } : {}),
      },
      body: raw ?? (body ? JSON.stringify(body) : form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString() : undefined),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, res };
  }

  /** Makes `userId` a member of the server with exactly these roles (what the bot would see). */
  const setRoles = (guildId, userId, roleIds = []) => {
    state.members.add(`${guildId}:${userId}`);
    const g = guilds[guildId];
    const m = g.members.cache.get(userId) ?? g.addMember({ user: fakeUser({ id: userId, username: 'visitor' }) });
    m.roles.cache.clear();
    for (const id of roleIds) m.roles.cache.set(id, g.roles.cache.get(id) ?? { id });
    return m;
  };
  const close = async () => { server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { config, state, db, logger, runtime, guilds, bot, base, call, session, visitorSession, uploads, transcripts, dataDir, setRoles, close };
}
