// DEV ONLY: runs the real dashboard + API against a fake, in-memory Discord so you can try the editor
// without any credentials. Visit /demo-login to be signed in as a demo admin (and /demo-visitor-login?next=/s/<id>/<slug>
// to act as a visitor of a public page).   npm run demo
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType } from 'discord.js';
import express from 'express';
import { createAccounts } from '../server/accounts.js';
import { createApp } from '../server/app.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { createTranscripts } from '../server/transcripts.js';
import { createUploads } from '../server/uploads.js';
import { fakeGuild, fakeUser } from '../test/helpers/fakes.js';
import { pretendProviders } from '../test/helpers/providers.js';

const port = Number(process.env.PORT || 4100);
const baseUrl = `http://127.0.0.1:${port}`;
// uploaded pictures live in a temporary folder that disappears with the demo
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-demo-'));
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, () => { fs.rmSync(dataDir, { recursive: true, force: true }); if (sig !== 'exit') process.exit(0); });
const config = {
  token: 'demo', clientId: '1', clientSecret: 'demo', baseUrl, port, host: '127.0.0.1', trustProxy: false, dataDir,
  intents: { members: true, messageContent: true }, minPermission: 'Administrator', sessionTtlMs: 8 * 3600e3,
  publicRate: { views: 100000, visitor: 1000, ip: 100000 },
  // the demo pretends YouTube and TikTok are set up and Twitch is not, so the editor shows both cases
  integrations: { youtube: 'demo-key', twitch: { clientId: '', clientSecret: '' }, tiktok: { clientKey: 'demo-key', clientSecret: 'demo-secret' } }, feedMinMinutes: 5,
};
const db = new Database(':memory:');
const logger = new Logger({ console: false });
const uploads = createUploads({ config, db, logger });
const transcripts = createTranscripts({ config, db, logger });
// the demo never goes on the internet: whatever a feed trigger wants to read simply cannot be read
const offline = async () => { throw new Error('The demo has no internet connection.'); };
// connected accounts (TikTok here): the approval page is TikTok's, which the demo cannot reach — the browser check plays its part, and what
// the bot asks TikTok for is answered by a pretend TikTok that accepts the code "good-code"
const accounts = createAccounts({ config, db, logger, fetch: pretendProviders().fetch });
const runtime = new Runtime({ db, logger, intents: config.intents, uploads, transcripts, integrations: config.integrations, feedMinMinutes: config.feedMinMinutes, fetcher: offline, accounts });

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
  // demo: everyone who logs in as a visitor counts as a member with the "Member" role (not "Staff"), so members-only forms and
  // pages, and role-gated pages, can be tried
  isMember: async () => true,
  getMember: async (gid, uid) => {
    const g = guilds.get(gid);
    const existing = g.members.cache.get(uid);
    if (existing) return existing;
    const member = g.addMember({ user: fakeUser({ id: uid, username: 'Demo Visitor' }) });
    const role = [...g.roles.cache.values()].find((r) => r.name === 'Member');
    if (role) member.roles.cache.set(role.id, role);
    return member;
  },
};
const sync = { status: new Map(), sync: async (gid) => { const n = runtime.commandsFor(gid).length; const r = { ok: true, count: n, at: Date.now() }; sync.status.set(gid, r); logger.log(gid, 'info', `Slash commands updated (${n}). [demo]`); return r; } };

const inner = createApp({ config, db, runtime, bot, sync, logger, uploads, transcripts, accounts, distDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist') });
const app = express();
app.get('/demo-login', (_req, res) => {
  const sid = db.createSession('42', {
    user: { id: '42', name: 'Demo Admin', avatar: null },
    guilds: [A, B, C].map((id) => ({ id, name: { [A]: 'Pixel Café', [B]: 'Dev Sandbox', [C]: 'Unreleased Server' }[id], icon: null })),
  }, config.sessionTtlMs);
  res.append('Set-Cookie', `fc_session=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  res.redirect('/');
});
// Log in as a public-page visitor (what "Log in with Discord" does on a real page). Only to a safe /s/<id>/<slug> page.
app.get('/demo-visitor-login', (req, res) => {
  const sid = db.createSession('77', { visitor: true, user: { id: '77', name: 'Demo Visitor', avatar: null } }, 24 * 3600e3);
  res.append('Set-Cookie', `fc_visitor=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  const next = String(req.query.next ?? '');
  res.redirect(/^\/s\/\d{5,25}\/[a-z0-9-]{1,40}$/.test(next) ? next : '/');
});
app.use(inner);
http.createServer(app).listen(port, '127.0.0.1', () => console.log(`Demo (fake Discord) on ${baseUrl}/demo-login`));
