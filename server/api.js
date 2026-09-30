import express from 'express';
import { isCapped, LIMITS, limitsToJSON } from '../shared/limits.js';
import { BLOCK_ID_RE, formsOf, hasPageStructureErrors, hasUnpublishedChanges, normalizePage, validatePage } from '../shared/blocks.js';
import { PAGE_TEMPLATES } from '../shared/page-templates.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { toCsv } from './csv.js';
import { livePage, SlugTakenError } from './db.js';
import { FlowError } from './engine/errors.js';
import { RateLimiter } from './engine/rate-limit.js';
import { available as imagesAvailable, IMAGE_LIMITS } from './images.js';
import { SNOWFLAKE } from './engine/resolve.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const avatarUrl = (u) => (u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : 'https://cdn.discordapp.com/embed/avatars/0.png');
const iconUrl = (g) => (g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null);

export function createApi({ config, db, runtime, bot, sync, logger, auth, uploads }) {
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
        intents: config.intents, limits: limitsToJSON(), minPermission: config.minPermission,
        uploads: { available: imagesAvailable(), publicBase: uploads.publicBase, maxBytes: Math.min(IMAGE_LIMITS.maxInputBytes, isCapped(LIMITS.uploadBytes) ? LIMITS.uploadBytes : Infinity) },
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
    if (isCapped(LIMITS.graphBytes) && JSON.stringify(graph).length > LIMITS.graphBytes) throw new HttpError(413, 'This flow is too large.');
    const issues = validateFlow(graph, { intents: config.intents });
    if (hasStructureErrors(issues)) throw new HttpError(400, 'The flow has structural problems and was not saved.', { issues: issues.filter((i) => i.kind === 'structure') });
    return graph;
  }
  const checkedName = (name) => {
    const n = String(name ?? '').trim().slice(0, 60);
    if (!n) throw new HttpError(400, 'Give the flow a name.');
    return n;
  };
  const flowsFull = (gid) => isCapped(LIMITS.flowsPerGuild) && db.countFlows(gid) >= LIMITS.flowsPerGuild;
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
    if (flowsFull(gid)) throw new HttpError(409, `A server can have at most ${LIMITS.flowsPerGuild} flows.`);
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
    if (patch.graph) db.pruneWebhooks(req.params.gid, cur.id, new Set(flow.graph.nodes.filter((n) => n.type === 'trigger.webhook').map((n) => n.id))); // a removed trigger's address stops working
    res.json({ flow: full(flow), sync: await apply(req.params.gid) });
  });

  guildRouter.delete('/flows/:fid', async (req, res) => {
    const cur = getFlow(req);
    db.deleteFlow(req.params.gid, cur.id);
    db.deleteWebhooksForFlow(req.params.gid, cur.id);
    res.json({ ok: true, sync: await apply(req.params.gid) });
  });

  guildRouter.post('/flows/:fid/duplicate', async (req, res) => {
    const { gid } = req.params;
    const cur = getFlow(req);
    if (flowsFull(gid)) throw new HttpError(409, `A server can have at most ${LIMITS.flowsPerGuild} flows.`);
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

  // The address behind a "Webhook Received" trigger (made on first use; `renew` replaces it and the old one stops working at once).
  guildRouter.post('/flows/:fid/webhook', (req, res) => {
    const cur = getFlow(req);
    const nodeId = String(req.body?.nodeId ?? '');
    const node = cur.graph.nodes.find((n) => n.id === nodeId && n.type === 'trigger.webhook');
    if (!node) throw new HttpError(400, 'Save the flow first: this trigger has not been saved yet.');
    const hook = db.ensureWebhook(req.params.gid, cur.id, nodeId, { renew: req.body?.renew === true });
    res.json({ url: `${config.baseUrl}/hooks/${hook.token}`, lastAt: hook.lastAt, created: hook.created });
  });

  // ---- pages (website builder) --------------------------------------------------------------
  const pagePath = (p) => `/s/${p.guildId}/${p.slug}`;
  // `known` = the ids of this server's pictures and roles, so one that was deleted since it was chosen shows up as an issue
  const knownFor = (gid) => ({ uploads: db.uploadIds(gid), roles: new Set(bot.roles(gid).map((r) => r.id)) });
  // `title`/`blocks`/`theme` are the DRAFT. `published` = a live version exists; `changed` = the draft differs from it.
  const pageSummary = (p, known = knownFor(p.guildId)) => ({
    id: p.id, title: p.title, slug: p.slug, published: p.published, changed: hasUnpublishedChanges(p), access: p.access, roleIds: p.roleIds,
    publishedAt: p.live?.at ?? null, updatedAt: p.updatedAt, updatedBy: p.updatedBy,
    blocks: p.blocks.length, forms: formsOf(p).length, issues: validatePage(p, known).length, path: pagePath(p), url: `${config.baseUrl}${pagePath(p)}`,
  });
  const pageFull = (p, known = knownFor(p.guildId)) => ({ ...pageSummary(p, known), theme: p.theme, createdAt: p.createdAt, publishedBy: p.live?.by ?? null, blocks: p.blocks, issues: validatePage(p, known) });
  const pagesFull = (gid) => isCapped(LIMITS.pagesPerGuild) && db.countPages(gid) >= LIMITS.pagesPerGuild;
  const findPage = (req) => {
    const p = db.getPage(req.params.gid, req.params.pid); // scoped by server: another server's page id is simply a 404
    if (!p) throw new HttpError(404, 'Page not found.');
    return p;
  };
  const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'page';
  const guardSlug = (fn) => { try { return fn(); } catch (err) { if (err instanceof SlugTakenError) throw new HttpError(409, err.message); throw err; } };
  function checkedPage(input) {
    const page = normalizePage(input);
    const issues = validatePage(page);
    if (hasPageStructureErrors(issues)) throw new HttpError(400, 'The page has problems and was not saved.', { issues: issues.filter((i) => i.kind === 'structure') });
    return { page, issues };
  }

  guildRouter.get('/pages', (req, res) => { const known = knownFor(req.params.gid); res.json(db.listPages(req.params.gid).map((p) => pageSummary(p, known))); });

  guildRouter.post('/pages', (req, res) => {
    const { gid } = req.params;
    if (pagesFull(gid)) throw new HttpError(409, `A server can have at most ${LIMITS.pagesPerGuild} pages.`);
    let input = req.body ?? {};
    if (input.templateId) {
      const t = PAGE_TEMPLATES.find((x) => x.id === input.templateId);
      if (!t) throw new HttpError(400, 'Unknown template.');
      input = { ...t.build(), ...(input.title ? { title: String(input.title) } : {}) };
    }
    const draft = normalizePage({ ...input, title: input.title || 'New page' });
    draft.slug = db.uniqueSlug(gid, draft.slug || slugify(draft.title)); // creating never fails on a taken address: it gets a free one
    const { page } = checkedPage(draft);
    const created = guardSlug(() => db.createPage({ guildId: gid, ...page, published: false, updatedBy: actor(req) }));
    res.status(201).json({ page: pageFull(created) });
  });

  guildRouter.get('/pages/:pid', (req, res) => res.json({ page: pageFull(findPage(req)) }));

  // Saving only ever changes the DRAFT (plus the address and the access settings, which apply at once). What visitors see changes
  // only through publish / unpublish / discard below.
  guildRouter.put('/pages/:pid', (req, res) => {
    const cur = findPage(req);
    const body = req.body ?? {};
    const { page } = checkedPage({ title: cur.title, slug: cur.slug, theme: cur.theme, blocks: cur.blocks, access: cur.access, roleIds: cur.roleIds, ...Object.fromEntries(['title', 'slug', 'theme', 'blocks', 'access', 'roleIds'].filter((k) => k in body).map((k) => [k, body[k]])) });
    const updated = guardSlug(() => db.updatePage(req.params.gid, cur.id, page, actor(req)));
    res.json({ page: pageFull(updated) });
  });

  /** Makes the saved draft the live page. Refused while it has real problems (a broken form, a malformed picture…). */
  guildRouter.post('/pages/:pid/publish', (req, res) => {
    const cur = findPage(req);
    const problems = validatePage(cur, knownFor(cur.guildId)).filter((i) => i.level === 'error');
    if (problems.length) throw new HttpError(400, 'This page still has problems, so it was not published.', { issues: problems });
    res.json({ page: pageFull(db.publishPage(req.params.gid, cur.id, actor(req))) });
  });

  guildRouter.post('/pages/:pid/unpublish', (req, res) => {
    const cur = findPage(req);
    res.json({ page: pageFull(db.unpublishPage(req.params.gid, cur.id)) });
  });

  /** Throws the draft away: it becomes a copy of the live page again. */
  guildRouter.post('/pages/:pid/discard', (req, res) => {
    const cur = findPage(req);
    if (!cur.live) throw new HttpError(409, 'This page has not been published, so there is nothing to go back to.');
    res.json({ page: pageFull(db.discardDraft(req.params.gid, cur.id, actor(req))) });
  });

  guildRouter.delete('/pages/:pid', (req, res) => {
    const cur = findPage(req);
    db.deletePage(req.params.gid, cur.id);
    res.json({ ok: true });
  });

  guildRouter.post('/pages/:pid/duplicate', (req, res) => {
    const { gid } = req.params;
    const cur = findPage(req);
    if (pagesFull(gid)) throw new HttpError(409, `A server can have at most ${LIMITS.pagesPerGuild} pages.`);
    const copy = guardSlug(() => db.createPage({ guildId: gid, slug: db.uniqueSlug(gid, `${cur.slug}-copy`), title: `${cur.title} (copy)`.slice(0, 80), theme: cur.theme, blocks: cur.blocks, published: false, access: cur.access, roleIds: cur.roleIds, updatedBy: actor(req) }));
    res.status(201).json({ page: pageFull(copy) });
  });

  /** Every form in every page: the flow trigger's picker and the variable chips read this. */
  guildRouter.get('/forms', (req, res) => {
    res.json(db.listPages(req.params.gid).flatMap((p) => formsOf(p).map((f) => ({
      key: `${p.id}:${f.blockId}`, pageId: p.id, blockId: f.blockId, label: `${p.title} › ${f.title}`, fields: f.fields,
    }))));
  });

  const formParam = (req) => {
    const blockId = String(req.query.form ?? '');
    if (!BLOCK_ID_RE.test(blockId)) throw new HttpError(400, 'Choose a form.');
    return blockId;
  };

  guildRouter.get('/pages/:pid/responses', (req, res) => {
    const page = findPage(req);
    const blockId = formParam(req);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({ total: db.countResponses(page.guildId, page.id, blockId), rows: db.listResponses(page.guildId, page.id, blockId, { limit, offset }) });
  });

  guildRouter.delete('/pages/:pid/responses/:rid', (req, res) => {
    const page = findPage(req);
    if (!db.deleteResponse(page.guildId, page.id, req.params.rid)) throw new HttpError(404, 'Response not found.');
    res.json({ ok: true });
  });

  guildRouter.get('/pages/:pid/responses.csv', (req, res) => {
    const page = findPage(req);
    const blockId = formParam(req);
    const form = (livePage(page) ?? page).blocks.find((b) => b.id === blockId && b.type === 'form'); // the questions visitors actually answered
    const columns = (form?.data.fields || []).map((q) => ({ id: q.id, label: q.label }));
    const rows = db.allResponses(page.guildId, page.id, blockId).map((r) => [new Date(r.createdAt).toISOString(), r.userId, r.userName, ...columns.map((c) => r.answers[c.id] ?? '')]);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="responses-${page.slug}.csv"`, 'Cache-Control': 'no-store' });
    res.send(toCsv(['Submitted at', 'Discord user ID', 'Discord username', ...columns.map((c) => c.label)], rows));
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

  // ---- uploaded images (see server/uploads.js) ------------------------------------------------
  guildRouter.use('/uploads', uploads.api);

  router.use('/guilds/:gid', guildRouter);
  return router;
}

export { FlowError };
