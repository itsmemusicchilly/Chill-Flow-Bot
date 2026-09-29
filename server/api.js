import express from 'express';
import { LIMITS } from '../shared/limits.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { FlowError } from './engine/errors.js';
import { RateLimiter } from './engine/rate-limit.js';
import { SNOWFLAKE } from './engine/resolve.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const avatarUrl = (u) => (u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : 'https://cdn.discordapp.com/embed/avatars/0.png');
const iconUrl = (g) => (g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null);

export function createApi({ config, db, runtime, bot, sync, logger, auth }) {
  const router = express.Router();
  const perUser = new RateLimiter(300, 60_000);
  const streams = new Map();

  router.use(auth.attachSession, auth.requireSession, auth.requireOrigin);
  router.use((req, res, next) => (perUser.take(req.session.userId) ? next() : res.status(429).json({ error: 'Slow down a little.' })));

  router.get('/me', (req, res) => {
    const { user, guilds } = req.session.data;
    res.json({
      user: { id: user.id, name: user.name, avatar: avatarUrl(user) },
      guilds: guilds.map((g) => ({
        id: g.id, name: g.name, icon: iconUrl(g), botPresent: bot.hasGuild(g.id), inviteUrl: bot.hasGuild(g.id) ? null : bot.inviteUrl(g.id),
      })),
      meta: {
        intents: config.intents, limits: LIMITS, minPermission: config.minPermission,
        templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })),
      },
    });
  });

  // ---- everything below is scoped to one server the caller may manage --------------------------
  const guildRouter = express.Router({ mergeParams: true });

  guildRouter.use(async (req, res, next) => {
    const { gid } = req.params;
    if (!SNOWFLAKE.test(gid)) throw new HttpError(404, 'Unknown server.');
    if (!req.session.data.guilds.some((g) => g.id === gid)) throw new HttpError(403, 'You cannot manage this server.');
    if (!bot.hasGuild(gid)) throw new HttpError(404, 'The bot is not in this server.');
    if (!(await bot.canManage(gid, req.session.userId))) throw new HttpError(403, `You need the ${config.minPermission === 'ManageGuild' ? 'Manage Server' : 'Administrator'} permission in this server.`);
    next();
  });

  const summary = (f) => ({
    id: f.id, name: f.name, enabled: f.enabled, updatedAt: f.updatedAt, updatedBy: f.updatedBy,
    nodes: f.graph.nodes.length, issues: validateFlow(f.graph, { intents: config.intents }).filter((i) => i.level === 'error').length,
  });
  const full = (f) => ({ ...summary(f), createdAt: f.createdAt, graph: f.graph, issues: validateFlow(f.graph, { intents: config.intents }) });

  function checkedGraph(input) {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'Missing flow graph.');
    const graph = normalizeGraph(input);
    if (JSON.stringify(graph).length > LIMITS.graphBytes) throw new HttpError(413, 'This flow is too large.');
    const issues = validateFlow(graph, { intents: config.intents });
    if (hasStructureErrors(issues)) throw new HttpError(400, 'The flow has structural problems and was not saved.', { issues: issues.filter((i) => i.kind === 'structure') });
    return graph;
  }
  const checkedName = (name) => {
    const n = String(name ?? '').trim().slice(0, 60);
    if (!n) throw new HttpError(400, 'Give the flow a name.');
    return n;
  };
  const actor = (req) => ({ id: req.session.userId, name: req.session.data.user.name });
  async function apply(gid) {
    runtime.loadGuild(gid);
    const s = await sync.sync(gid);
    return { ok: s.ok, count: s.count, error: s.error };
  }
  const getFlow = (req) => {
    const f = db.getFlow(req.params.gid, req.params.fid); // always filtered by guild: no cross-server access
    if (!f) throw new HttpError(404, 'Flow not found.');
    return f;
  };

  guildRouter.get('/', (req, res) => {
    const { gid } = req.params;
    res.json({ ...bot.guildSummary(gid), botPermissions: bot.botPermissions(gid), commandSync: sync.status.get(gid) ?? null, flows: db.countFlows(gid), inviteUrl: bot.inviteUrl(gid) });
  });
  guildRouter.get('/channels', (req, res) => res.json(bot.channels(req.params.gid)));
  guildRouter.get('/roles', (req, res) => res.json(bot.roles(req.params.gid)));

  guildRouter.get('/flows', (req, res) => res.json(db.listFlows(req.params.gid).map(summary)));

  guildRouter.post('/flows', async (req, res) => {
    const { gid } = req.params;
    if (db.countFlows(gid) >= LIMITS.flowsPerGuild) throw new HttpError(409, `A server can have at most ${LIMITS.flowsPerGuild} flows.`);
    let { name, graph } = req.body ?? {};
    if (req.body?.templateId) {
      const t = TEMPLATES.find((x) => x.id === req.body.templateId);
      if (!t) throw new HttpError(400, 'Unknown template.');
      graph = t.build();
      name = name || t.name;
    }
    const flow = db.createFlow({ guildId: gid, name: checkedName(name), graph: checkedGraph(graph ?? { nodes: [], edges: [] }), enabled: false, updatedBy: actor(req) });
    res.status(201).json({ flow: full(flow) });
  });

  guildRouter.get('/flows/:fid', (req, res) => res.json({ flow: full(getFlow(req)) }));

  guildRouter.put('/flows/:fid', async (req, res) => {
    const cur = getFlow(req);
    const patch = {};
    if ('name' in req.body) patch.name = checkedName(req.body.name);
    if ('enabled' in req.body) patch.enabled = Boolean(req.body.enabled);
    if ('graph' in req.body) patch.graph = checkedGraph(req.body.graph);
    const flow = db.updateFlow(req.params.gid, cur.id, patch, actor(req));
    res.json({ flow: full(flow), sync: await apply(req.params.gid) });
  });

  guildRouter.delete('/flows/:fid', async (req, res) => {
    const cur = getFlow(req);
    db.deleteFlow(req.params.gid, cur.id);
    res.json({ ok: true, sync: await apply(req.params.gid) });
  });

  guildRouter.post('/flows/:fid/duplicate', async (req, res) => {
    const { gid } = req.params;
    const cur = getFlow(req);
    if (db.countFlows(gid) >= LIMITS.flowsPerGuild) throw new HttpError(409, `A server can have at most ${LIMITS.flowsPerGuild} flows.`);
    const copy = db.createFlow({ guildId: gid, name: `${cur.name} (copy)`.slice(0, 60), graph: cur.graph, enabled: false, updatedBy: actor(req) });
    res.status(201).json({ flow: full(copy) });
  });

  guildRouter.post('/flows/:fid/run', async (req, res) => {
    const cur = getFlow(req);
    const nodeId = String(req.body?.nodeId ?? '');
    const result = await runtime.runManual(req.params.gid, cur.id, nodeId);
    if (!result.ok) throw new HttpError(400, result.error);
    res.json({ ok: true });
  });

  // ---- variables ----------------------------------------------------------------------------
  guildRouter.get('/variables', (req, res) => res.json(db.listVars(req.params.gid)));
  guildRouter.put('/variables', (req, res) => {
    const { scope, scopeId = '', name, value } = req.body ?? {};
    if (scope !== 'guild' && scope !== 'user') throw new HttpError(400, 'Scope must be guild or user.');
    if (scope === 'user' && !SNOWFLAKE.test(String(scopeId))) throw new HttpError(400, 'A user variable needs a user ID.');
    db.setVar(req.params.gid, scope, scope === 'guild' ? '' : String(scopeId), String(name), value);
    res.json({ ok: true });
  });
  guildRouter.delete('/variables', (req, res) => {
    const { scope, scopeId = '', name } = req.query;
    res.json({ ok: db.deleteVar(req.params.gid, String(scope), String(scopeId), String(name)) });
  });

  // ---- logs ---------------------------------------------------------------------------------
  guildRouter.get('/logs', (req, res) => res.json(logger.recent(req.params.gid, 200)));
  guildRouter.get('/logs/stream', (req, res) => {
    const uid = req.session.userId;
    if ((streams.get(uid) ?? 0) >= 5) throw new HttpError(429, 'Too many open log streams.');
    streams.set(uid, (streams.get(uid) ?? 0) + 1);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const off = logger.subscribe(req.params.gid, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const heartbeat = setInterval(() => res.write(': ♥\n\n'), 25_000);
    req.on('close', () => { off(); clearInterval(heartbeat); streams.set(uid, Math.max(0, (streams.get(uid) ?? 1) - 1)); });
  });

  router.use('/guilds/:gid', guildRouter);
  return router;
}

export { FlowError };
