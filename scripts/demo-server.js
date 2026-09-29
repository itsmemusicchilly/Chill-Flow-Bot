// DEV ONLY: runs the real dashboard + API against a fake, in-memory Discord so you can try the editor
// without any credentials. Visit /demo-login to be signed in as a demo admin.   npm run demo
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType } from 'discord.js';
import express from 'express';
import { createApp } from '../server/app.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { fakeGuild } from '../test/helpers/fakes.js';

const port = Number(process.env.PORT || 4100);
const baseUrl = `http://127.0.0.1:${port}`;
const config = {
  token: 'demo', clientId: '1', clientSecret: 'demo', baseUrl, port, host: '127.0.0.1', trustProxy: false,
  intents: { members: true, messageContent: true }, minPermission: 'Administrator', sessionTtlMs: 8 * 3600e3,
};
const db = new Database(':memory:');
const logger = new Logger({ console: false });
const runtime = new Runtime({ db, logger, intents: config.intents });

const guilds = new Map();
function makeGuild(id, name) {
  const g = fakeGuild({ id, name });
  g.name = name;
  for (const [cname, type] of [['general', ChannelType.GuildText], ['announcements', ChannelType.GuildText], ['support-log', ChannelType.GuildText], ['Tickets', ChannelType.GuildCategory], ['Lounge', ChannelType.GuildVoice]]) {
    const ch = g.addChannel({ name: cname, type });
    const send = ch.send;
    ch.send = async (p) => { logger.log(id, 'info', `Discord ← #${ch.name}: ${p.content ?? '[embed]'}${p.embeds?.length ? ` ${p.embeds[0].data.title ?? ''}` : ''}${p.components?.length ? ' + buttons' : ''}`); return send(p); };
  }
  for (const rname of ['Staff', 'Member', 'Gamer', 'Artist']) g.addRole({ name: rname });
  guilds.set(id, g);
  return g;
}
const A = '100000000000000001'; const B = '100000000000000002'; const C = '100000000000000003';
const first = makeGuild(A, 'Pixel Café');
makeGuild(B, 'Dev Sandbox');
runtime.attachClient(first.client);
for (const g of guilds.values()) g.client.guilds.cache.set(g.id, g);
runtime.attachClient(first.client);

const bot = {
  ready: true,
  hasGuild: (id) => guilds.has(id),
  canManage: async () => true,
  guildSummary: (id) => ({ id, name: guilds.get(id).name, icon: null, memberCount: 42 }),
  botPermissions: () => ['ViewChannel', 'SendMessages', 'ManageRoles', 'ManageChannels'],
  channels: (id) => [...guilds.get(id).channels.cache.values()].map((c) => ({ id: c.id, name: c.name, type: ChannelType[c.type], parentId: null })),
  roles: (id) => [...guilds.get(id).roles.cache.values()].filter((r) => r.id !== id).map((r) => ({ id: r.id, name: r.name, color: '#99aab5', managed: false })),
  inviteUrl: (gid) => `https://discord.com/oauth2/authorize?client_id=1&scope=bot&guild_id=${gid ?? ''}`,
};
const sync = { status: new Map(), sync: async (gid) => { const n = runtime.commandsFor(gid).length; const r = { ok: true, count: n, at: Date.now() }; sync.status.set(gid, r); logger.log(gid, 'info', `Slash commands updated (${n}). [demo]`); return r; } };

const inner = createApp({ config, db, runtime, bot, sync, logger, distDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist') });
const app = express();
app.get('/demo-login', (_req, res) => {
  const sid = db.createSession('42', {
    user: { id: '42', name: 'Demo Admin', avatar: null },
    guilds: [A, B, C].map((id) => ({ id, name: { [A]: 'Pixel Café', [B]: 'Dev Sandbox', [C]: 'Unreleased Server' }[id], icon: null })),
  }, config.sessionTtlMs);
  res.append('Set-Cookie', `fc_session=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  res.redirect('/');
});
app.use(inner);
http.createServer(app).listen(port, '127.0.0.1', () => console.log(`Demo (fake Discord) on ${baseUrl}/demo-login`));
