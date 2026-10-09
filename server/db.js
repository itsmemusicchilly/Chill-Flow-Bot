// SQLite storage (node:sqlite). Every flow/variable row is keyed by guild_id — there is no cross-server data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCapped, LIMITS } from '../shared/limits.js';
import { uid } from '../shared/util.js';
import { FlowError } from './engine/errors.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  graph TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT
);
CREATE INDEX IF NOT EXISTS flows_guild ON flows(guild_id);
CREATE TABLE IF NOT EXISTS vars (
  guild_id TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (guild_id, scope, scope_id, name)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS command_sync (guild_id TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS component_state (
  guild_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '',
  vars TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
  PRIMARY KEY (guild_id, message_id)
);
CREATE INDEX IF NOT EXISTS component_state_channel ON component_state(guild_id, channel_id);
CREATE INDEX IF NOT EXISTS component_state_expiry ON component_state(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL, blocks TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT,
  live TEXT, access TEXT NOT NULL DEFAULT 'public', role_ids TEXT NOT NULL DEFAULT '[]',
  UNIQUE (guild_id, slug)
);
CREATE INDEX IF NOT EXISTS pages_guild ON pages(guild_id);
CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, page_id TEXT NOT NULL, block_id TEXT NOT NULL,
  user_id TEXT NOT NULL, user_name TEXT NOT NULL, answers TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS responses_form ON form_responses(guild_id, page_id, block_id, created_at);
CREATE INDEX IF NOT EXISTS responses_user ON form_responses(guild_id, page_id, block_id, user_id);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  animated INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT,
  UNIQUE (guild_id, sha256)
);
CREATE INDEX IF NOT EXISTS uploads_guild ON uploads(guild_id, created_at);
CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, messages INTEGER NOT NULL, bytes INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transcripts_created ON transcripts(created_at);
CREATE TABLE IF NOT EXISTS webhooks (
  token TEXT PRIMARY KEY, guild_id TEXT NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_at INTEGER,
  UNIQUE (guild_id, flow_id, node_id)
);
CREATE TABLE IF NOT EXISTS linked_accounts (
  guild_id TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL, account_login TEXT NOT NULL DEFAULT '',
  access_enc TEXT NOT NULL, refresh_enc TEXT NOT NULL, expires_at INTEGER NOT NULL, scopes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok', connected_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, provider)
);
CREATE TABLE IF NOT EXISTS watch_state (
  guild_id TEXT NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, flow_id, node_id)
);
`;

const VAR_NAME = /^[A-Za-z_][\w-]{0,31}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const toFlow = (r) => (r ? {
  id: r.id, guildId: r.guild_id, name: r.name, enabled: Boolean(r.enabled), graph: JSON.parse(r.graph),
  createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by ? JSON.parse(r.updated_by) : null,
} : null);

import { SlugTakenError } from './db/errors.js';
export { SlugTakenError };

// `title`, `theme` and `blocks` are the DRAFT (what the editor saves). `live` is the snapshot visitors see: null until the page is
// published; `published` is true exactly when there is one. `access`/`roleIds` are not versioned: they apply as soon as they are saved.
const toPage = (r) => (r ? {
  id: r.id, guildId: r.guild_id, slug: r.slug, title: r.title, published: Boolean(r.published), theme: JSON.parse(r.theme), blocks: JSON.parse(r.blocks),
  access: r.access ?? 'public', roleIds: JSON.parse(r.role_ids ?? '[]'), live: r.live ? JSON.parse(r.live) : null,
  createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by ? JSON.parse(r.updated_by) : null,
} : null);

/** The page as visitors get it — the published snapshot in the same shape as a draft — or null when it is not published. */
export const livePage = (p) => (p?.published && p.live ? { ...p, title: p.live.title, theme: p.live.theme, blocks: p.live.blocks } : null);
const toUpload = (r) => (r ? {
  id: r.id, guildId: r.guild_id, name: r.name, bytes: r.bytes, width: r.width, height: r.height, animated: Boolean(r.animated),
  sha256: r.sha256, createdAt: r.created_at, createdBy: r.created_by ? JSON.parse(r.created_by) : null,
} : null);
const toTranscript = (r) => (r ? { id: r.id, guildId: r.guild_id, name: r.name, messages: r.messages, bytes: r.bytes, truncated: Boolean(r.truncated), createdAt: r.created_at } : null);
const toResponse = (r) => ({ id: r.id, pageId: r.page_id, blockId: r.block_id, userId: r.user_id, userName: r.user_name, answers: JSON.parse(r.answers), createdAt: r.created_at });

export class Database {
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.q = {};
    this.#migrate();
  }

  /** Brings a database made by an older version up to date. Safe to run every start: it only adds what is missing. */
  #migrate() {
    const have = new Set(this.db.prepare('PRAGMA table_info(pages)').all().map((c) => c.name));
    for (const [name, ddl] of [['live', 'TEXT'], ['access', "TEXT NOT NULL DEFAULT 'public'"], ['role_ids', "TEXT NOT NULL DEFAULT '[]'"]]) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE pages ADD COLUMN ${name} ${ddl}`);
    }
    // Pages published before drafts existed: what visitors see today becomes their live version, so nothing changes for them.
    const legacy = this.db.prepare('SELECT id, title, theme, blocks, updated_at, updated_by FROM pages WHERE published = 1 AND live IS NULL').all();
    for (const r of legacy) {
      const live = { title: r.title, theme: JSON.parse(r.theme), blocks: JSON.parse(r.blocks), at: r.updated_at, by: r.updated_by ? JSON.parse(r.updated_by) : null };
      this.db.prepare('UPDATE pages SET live = ? WHERE id = ?').run(JSON.stringify(live), r.id);
    }
  }

  #stmt(sql) { return (this.q[sql] ??= this.db.prepare(sql)); }
  close() { this.db.close(); }

  // ---- flows ----------------------------------------------------------------------------------
  listFlows(guildId) {
    return this.#stmt('SELECT * FROM flows WHERE guild_id = ? ORDER BY created_at').all(guildId).map(toFlow);
  }

  listEnabledFlows(guildId) { return this.listFlows(guildId).filter((f) => f.enabled); }

  guildIdsWithFlows() {
    return this.#stmt('SELECT DISTINCT guild_id FROM flows WHERE enabled = 1').all().map((r) => r.guild_id);
  }

  countFlows(guildId) { return this.#stmt('SELECT COUNT(*) AS n FROM flows WHERE guild_id = ?').get(guildId).n; }

  getFlow(guildId, id) { return toFlow(this.#stmt('SELECT * FROM flows WHERE id = ? AND guild_id = ?').get(id, guildId)); }

  createFlow({ guildId, name, graph, enabled = true, updatedBy = null }) {
    const now = Date.now();
    const id = uid(8);
    this.#stmt('INSERT INTO flows (id, guild_id, name, enabled, graph, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, guildId, name, enabled ? 1 : 0, JSON.stringify(graph), now, now, updatedBy ? JSON.stringify(updatedBy) : null);
    return this.getFlow(guildId, id);
  }

  updateFlow(guildId, id, patch, updatedBy = null) {
    const cur = this.getFlow(guildId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.#stmt('UPDATE flows SET name = ?, enabled = ?, graph = ?, updated_at = ?, updated_by = ? WHERE id = ? AND guild_id = ?')
      .run(next.name, next.enabled ? 1 : 0, JSON.stringify(next.graph), Date.now(), updatedBy ? JSON.stringify(updatedBy) : (cur.updatedBy ? JSON.stringify(cur.updatedBy) : null), id, guildId);
    return this.getFlow(guildId, id);
  }

  deleteFlow(guildId, id) {
    return this.#stmt('DELETE FROM flows WHERE id = ? AND guild_id = ?').run(id, guildId).changes > 0;
  }

  // ---- webhook addresses: one secret token per "Webhook Received" trigger, scoped to its server and flow ---------------------
  webhookFor(guildId, flowId, nodeId) {
    const r = this.#stmt('SELECT token, created_at, last_at FROM webhooks WHERE guild_id=? AND flow_id=? AND node_id=?').get(guildId, flowId, nodeId);
    return r ? { token: r.token, createdAt: r.created_at, lastAt: r.last_at } : null;
  }

  /** The trigger's address token; made on first use. `renew` replaces it, so the old address stops working at once. */
  ensureWebhook(guildId, flowId, nodeId, { renew = false } = {}) {
    const cur = this.webhookFor(guildId, flowId, nodeId);
    if (cur && !renew) return { ...cur, created: false };
    if (cur) this.#stmt('DELETE FROM webhooks WHERE token = ?').run(cur.token);
    const token = crypto.randomBytes(32).toString('base64url');
    this.#stmt('INSERT INTO webhooks (token, guild_id, flow_id, node_id, created_at) VALUES (?,?,?,?,?)').run(token, guildId, flowId, nodeId, Date.now());
    return { token, createdAt: Date.now(), lastAt: null, created: true };
  }

  webhookByToken(token) {
    const r = this.#stmt('SELECT guild_id, flow_id, node_id FROM webhooks WHERE token = ?').get(String(token));
    return r ? { guildId: r.guild_id, flowId: r.flow_id, nodeId: r.node_id } : null;
  }

  touchWebhook(token, at = Date.now()) { this.#stmt('UPDATE webhooks SET last_at = ? WHERE token = ?').run(at, String(token)); }

  /** After a flow is saved: addresses of triggers that are gone (deleted, or no longer a webhook trigger) stop working. */
  pruneWebhooks(guildId, flowId, keepNodeIds) {
    for (const r of this.#stmt('SELECT node_id FROM webhooks WHERE guild_id=? AND flow_id=?').all(guildId, flowId)) {
      if (!keepNodeIds.has(r.node_id)) this.#stmt('DELETE FROM webhooks WHERE guild_id=? AND flow_id=? AND node_id=?').run(guildId, flowId, r.node_id);
    }
  }

  deleteWebhooksForFlow(guildId, flowId) { this.#stmt('DELETE FROM webhooks WHERE guild_id=? AND flow_id=?').run(guildId, flowId); }

  // ---- what the feed/platform watchers have already seen (so a restart never announces things twice) ---------
  getWatch(guildId, flowId, nodeId) {
    const r = this.#stmt('SELECT data FROM watch_state WHERE guild_id=? AND flow_id=? AND node_id=?').get(guildId, flowId, nodeId);
    return r ? JSON.parse(r.data) : null;
  }

  setWatch(guildId, flowId, nodeId, data) {
    this.#stmt('INSERT INTO watch_state (guild_id, flow_id, node_id, data, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(guild_id, flow_id, node_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(guildId, flowId, nodeId, JSON.stringify(data), Date.now());
  }

  /** Forget the state of every node of this server that is not in `keep` (a set of "flowId|nodeId"): deleted flows and nodes leave nothing behind. */
  pruneWatch(guildId, keep) {
    const rows = this.#stmt('SELECT flow_id, node_id FROM watch_state WHERE guild_id = ?').all(guildId);
    for (const r of rows) if (!keep.has(`${r.flow_id}|${r.node_id}`)) this.#stmt('DELETE FROM watch_state WHERE guild_id=? AND flow_id=? AND node_id=?').run(guildId, r.flow_id, r.node_id);
  }

  // ---- accounts a server has connected (Twitch, TikTok): the tokens are sealed by server/secrets.js before they get here ---------
  /** One row WITH its sealed tokens (for the accounts service only — never send this to the browser). */
  getAccount(guildId, provider) {
    const r = this.#stmt('SELECT * FROM linked_accounts WHERE guild_id=? AND provider=?').get(guildId, provider);
    return r ? {
      guildId: r.guild_id, provider: r.provider, accountId: r.account_id, accountName: r.account_name, accountLogin: r.account_login, accessSealed: r.access_enc, refreshSealed: r.refresh_enc,
      expiresAt: r.expires_at, scopes: r.scopes, status: r.status, connectedBy: r.connected_by, createdAt: r.created_at, updatedAt: r.updated_at,
    } : null;
  }

  /** What is connected to a server, without any token. */
  listAccounts(guildId) {
    return this.#stmt('SELECT provider, account_id, account_name, status, connected_by, created_at, updated_at FROM linked_accounts WHERE guild_id = ? ORDER BY provider').all(guildId)
      .map((r) => ({ provider: r.provider, accountId: r.account_id, accountName: r.account_name, status: r.status, connectedBy: r.connected_by, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  saveAccount(a, now = Date.now()) {
    this.#stmt(`INSERT INTO linked_accounts (guild_id, provider, account_id, account_name, account_login, access_enc, refresh_enc, expires_at, scopes, status, connected_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(guild_id, provider) DO UPDATE SET account_id = excluded.account_id, account_name = excluded.account_name, account_login = excluded.account_login, access_enc = excluded.access_enc, refresh_enc = excluded.refresh_enc,
        expires_at = excluded.expires_at, scopes = excluded.scopes, status = excluded.status, connected_by = COALESCE(excluded.connected_by, connected_by), updated_at = excluded.updated_at`)
      .run(a.guildId, a.provider, a.accountId, a.accountName, a.accountLogin ?? '', a.accessSealed, a.refreshSealed, a.expiresAt, a.scopes ?? '', a.status ?? 'ok', a.connectedBy ?? null, now, now);
  }

  setAccountStatus(guildId, provider, status, now = Date.now()) {
    this.#stmt('UPDATE linked_accounts SET status = ?, updated_at = ? WHERE guild_id=? AND provider=?').run(status, now, guildId, provider);
  }

  deleteAccount(guildId, provider) { this.#stmt('DELETE FROM linked_accounts WHERE guild_id=? AND provider=?').run(guildId, provider); }

  deleteGuildAccounts(guildId) { this.#stmt('DELETE FROM linked_accounts WHERE guild_id=?').run(guildId); }

  // ---- variables (scopes: guild, channel, user — never global) ---------------------------------
  getVar(guildId, scope, scopeId, name) {
    const r = this.#stmt('SELECT value FROM vars WHERE guild_id=? AND scope=? AND scope_id=? AND name=?').get(guildId, scope, scopeId, name);
    return r ? JSON.parse(r.value) : undefined;
  }

  setVar(guildId, scope, scopeId, name, value) {
    if (scope !== 'guild' && scope !== 'channel' && scope !== 'user') throw new FlowError(`Unknown variable scope “${scope}”.`);
    if (!VAR_NAME.test(String(name))) throw new FlowError(`“${name}” is not a valid variable name.`);
    const json = JSON.stringify(value);
    if (json === undefined) throw new FlowError('That value cannot be stored.');
    if (isCapped(LIMITS.varValueBytes) && Buffer.byteLength(json) > LIMITS.varValueBytes) throw new FlowError(`Variable values can be at most ${LIMITS.varValueBytes} bytes.`);
    if (isCapped(LIMITS.varsPerGuild)) {
      const exists = this.#stmt('SELECT 1 FROM vars WHERE guild_id=? AND scope=? AND scope_id=? AND name=?').get(guildId, scope, scopeId, name);
      if (!exists && this.countVars(guildId) >= LIMITS.varsPerGuild) throw new FlowError(`This server reached the limit of ${LIMITS.varsPerGuild} stored variables.`);
    }
    this.#stmt('INSERT INTO vars (guild_id, scope, scope_id, name, value) VALUES (?,?,?,?,?) ON CONFLICT(guild_id, scope, scope_id, name) DO UPDATE SET value = excluded.value')
      .run(guildId, scope, scopeId, name, json);
  }

  deleteVar(guildId, scope, scopeId, name) {
    return this.#stmt('DELETE FROM vars WHERE guild_id=? AND scope=? AND scope_id=? AND name=?').run(guildId, scope, scopeId, name).changes > 0;
  }

  /** Forgets everything remembered for one channel or user (e.g. the channel was deleted). */
  deleteVarsForScope(guildId, scope, scopeId) {
    return this.#stmt('DELETE FROM vars WHERE guild_id=? AND scope=? AND scope_id=?').run(guildId, scope, scopeId).changes;
  }

  countVars(guildId) { return this.#stmt('SELECT COUNT(*) AS n FROM vars WHERE guild_id = ?').get(guildId).n; }

  varsFor(guildId, scope, scopeId) {
    const out = {};
    for (const r of this.#stmt('SELECT name, value FROM vars WHERE guild_id=? AND scope=? AND scope_id=?').all(guildId, scope, scopeId)) out[r.name] = JSON.parse(r.value);
    return out;
  }

  listVars(guildId) {
    return this.#stmt('SELECT scope, scope_id, name, value FROM vars WHERE guild_id = ? ORDER BY scope, scope_id, name LIMIT 1000')
      .all(guildId).map((r) => ({ scope: r.scope, scopeId: r.scope_id, name: r.name, value: JSON.parse(r.value) }));
  }

  // ---- pages (website builder) — every query is scoped by guild_id -------------------------------
  listPages(guildId) { return this.#stmt('SELECT * FROM pages WHERE guild_id = ? ORDER BY created_at').all(guildId).map(toPage); }
  countPages(guildId) { return this.#stmt('SELECT COUNT(*) AS n FROM pages WHERE guild_id = ?').get(guildId).n; }
  getPage(guildId, id) { return toPage(this.#stmt('SELECT * FROM pages WHERE id = ? AND guild_id = ?').get(id, guildId)); }
  getPageBySlug(guildId, slug) { return toPage(this.#stmt('SELECT * FROM pages WHERE guild_id = ? AND slug = ?').get(guildId, slug)); }
  slugTaken(guildId, slug, exceptId = '') { return Boolean(this.#stmt('SELECT 1 FROM pages WHERE guild_id = ? AND slug = ? AND id != ?').get(guildId, slug, exceptId)); }

  /** A free slug based on `base` (`base`, `base-2`, `base-3`, …). */
  uniqueSlug(guildId, base) {
    const root = String(base).slice(0, 34).replace(/-+$/, '') || 'page';
    for (let n = 1; ; n += 1) {
      const slug = n === 1 ? root : `${root}-${n}`;
      if (!this.slugTaken(guildId, slug)) return slug;
    }
  }

  /** `published: true` creates the page already live with this content (the draft and the live version start out equal). */
  createPage({ guildId, slug, title, theme, blocks, published = false, access = 'public', roleIds = [], updatedBy = null }) {
    const now = Date.now();
    const id = uid(8);
    const live = published ? JSON.stringify({ title, theme, blocks, at: now, by: updatedBy }) : null;
    try {
      this.#stmt('INSERT INTO pages (id, guild_id, slug, title, published, theme, blocks, created_at, updated_at, updated_by, live, access, role_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, guildId, slug, title, published ? 1 : 0, JSON.stringify(theme), JSON.stringify(blocks), now, now, updatedBy ? JSON.stringify(updatedBy) : null, live, access, JSON.stringify(roleIds));
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new SlugTakenError('That web address is already used by another page.');
      throw err;
    }
    return this.getPage(guildId, id);
  }

  /** Saves the DRAFT (and the access settings). Never publishes or unpublishes: see publishPage / unpublishPage. */
  updatePage(guildId, id, patch, updatedBy = null) {
    const cur = this.getPage(guildId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    try {
      this.#stmt('UPDATE pages SET slug = ?, title = ?, theme = ?, blocks = ?, access = ?, role_ids = ?, updated_at = ?, updated_by = ? WHERE id = ? AND guild_id = ?')
        .run(next.slug, next.title, JSON.stringify(next.theme), JSON.stringify(next.blocks), next.access, JSON.stringify(next.roleIds), Date.now(), JSON.stringify(updatedBy ?? cur.updatedBy), id, guildId);
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new SlugTakenError('That web address is already used by another page.');
      throw err;
    }
    return this.getPage(guildId, id);
  }

  /** Makes the current draft the live version (and switches the page on). */
  publishPage(guildId, id, by = null) {
    const cur = this.getPage(guildId, id);
    if (!cur) return null;
    const live = { title: cur.title, theme: cur.theme, blocks: cur.blocks, at: Date.now(), by };
    this.#stmt('UPDATE pages SET published = 1, live = ? WHERE id = ? AND guild_id = ?').run(JSON.stringify(live), id, guildId);
    return this.getPage(guildId, id);
  }

  /** Takes the page offline. The draft is kept; the live snapshot is dropped. */
  unpublishPage(guildId, id) {
    this.#stmt('UPDATE pages SET published = 0, live = NULL WHERE id = ? AND guild_id = ?').run(id, guildId);
    return this.getPage(guildId, id);
  }

  /** Throws the draft away: it becomes a copy of the live version again. Null when the page was never published. */
  discardDraft(guildId, id, by = null) {
    const cur = this.getPage(guildId, id);
    if (!cur?.live) return null;
    this.#stmt('UPDATE pages SET title = ?, theme = ?, blocks = ?, updated_at = ?, updated_by = ? WHERE id = ? AND guild_id = ?')
      .run(cur.live.title, JSON.stringify(cur.live.theme), JSON.stringify(cur.live.blocks), Date.now(), by ? JSON.stringify(by) : (cur.updatedBy ? JSON.stringify(cur.updatedBy) : null), id, guildId);
    return this.getPage(guildId, id);
  }

  /** Deleting a page also erases its responses. */
  deletePage(guildId, id) {
    this.db.exec('BEGIN');
    try {
      this.#stmt('DELETE FROM form_responses WHERE guild_id = ? AND page_id = ?').run(guildId, id);
      const removed = this.#stmt('DELETE FROM pages WHERE id = ? AND guild_id = ?').run(id, guildId).changes > 0;
      this.db.exec('COMMIT');
      return removed;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  // ---- form responses ---------------------------------------------------------------------------
  addResponse({ guildId, pageId, blockId, userId, userName, answers }) {
    const id = uid(10);
    this.#stmt('INSERT INTO form_responses (id, guild_id, page_id, block_id, user_id, user_name, answers, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, guildId, pageId, blockId, userId, userName, JSON.stringify(answers), Date.now());
    return id;
  }

  countResponsesInGuild(guildId) { return this.#stmt('SELECT COUNT(*) AS n FROM form_responses WHERE guild_id = ?').get(guildId).n; }
  countResponses(guildId, pageId, blockId) { return this.#stmt('SELECT COUNT(*) AS n FROM form_responses WHERE guild_id=? AND page_id=? AND block_id=?').get(guildId, pageId, blockId).n; }

  listResponses(guildId, pageId, blockId, { limit = 50, offset = 0 } = {}) {
    return this.#stmt('SELECT * FROM form_responses WHERE guild_id=? AND page_id=? AND block_id=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(guildId, pageId, blockId, Math.min(Math.max(1, limit), 500), Math.max(0, offset)).map(toResponse);
  }

  allResponses(guildId, pageId, blockId) {
    return this.#stmt('SELECT * FROM form_responses WHERE guild_id=? AND page_id=? AND block_id=? ORDER BY created_at, id LIMIT 100000').all(guildId, pageId, blockId).map(toResponse);
  }

  deleteResponse(guildId, pageId, id) { return this.#stmt('DELETE FROM form_responses WHERE id=? AND guild_id=? AND page_id=?').run(id, guildId, pageId).changes > 0; }

  /** When did this person last answer this form? (ms, or undefined) */
  lastResponseAt(guildId, pageId, blockId, userId) {
    return this.#stmt('SELECT MAX(created_at) AS t FROM form_responses WHERE guild_id=? AND page_id=? AND block_id=? AND user_id=?').get(guildId, pageId, blockId, userId)?.t ?? undefined;
  }

  // ---- uploaded images (metadata; the files live in DATA_DIR/uploads) — every query is scoped by guild_id --------------------
  listUploads(guildId) { return this.#stmt('SELECT * FROM uploads WHERE guild_id = ? ORDER BY created_at DESC, id').all(guildId).map(toUpload); }
  getUpload(guildId, id) { return toUpload(this.#stmt('SELECT * FROM uploads WHERE id = ? AND guild_id = ?').get(id, guildId)); }
  uploadIds(guildId) { return new Set(this.#stmt('SELECT id FROM uploads WHERE guild_id = ?').all(guildId).map((r) => r.id)); }
  getUploadByHash(guildId, sha256) { return toUpload(this.#stmt('SELECT * FROM uploads WHERE guild_id = ? AND sha256 = ?').get(guildId, sha256)); }
  uploadUsage(guildId) {
    const r = this.#stmt('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM uploads WHERE guild_id = ?').get(guildId);
    return { count: r.count, bytes: r.bytes };
  }

  addUpload({ guildId, name, bytes, width, height, animated, sha256, createdBy = null }) {
    const id = uid(16);
    this.#stmt('INSERT INTO uploads (id, guild_id, name, bytes, width, height, animated, sha256, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, guildId, name, bytes, width, height, animated ? 1 : 0, sha256, Date.now(), createdBy ? JSON.stringify(createdBy) : null);
    return this.getUpload(guildId, id);
  }

  deleteUpload(guildId, id) { return this.#stmt('DELETE FROM uploads WHERE id = ? AND guild_id = ?').run(id, guildId).changes > 0; }

  // ---- saved transcripts (metadata; the pages live in DATA_DIR/transcripts). The id is the secret in the public link, so it is looked up on its own. ----
  getTranscript(id) { return toTranscript(this.#stmt('SELECT * FROM transcripts WHERE id = ?').get(id)); }
  transcriptsBefore(cutoff) { return this.#stmt('SELECT * FROM transcripts WHERE created_at < ? ORDER BY created_at, id').all(cutoff).map(toTranscript); }

  addTranscript({ guildId, name, messages, bytes, truncated, now = Date.now() }) {
    const id = uid(32);
    this.#stmt('INSERT INTO transcripts (id, guild_id, name, messages, bytes, truncated, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, guildId, name, messages, bytes, truncated ? 1 : 0, now);
    return this.getTranscript(id);
  }

  deleteTranscript(id) { return this.#stmt('DELETE FROM transcripts WHERE id = ?').run(id).changes > 0; }

  /**
   * Where each uploaded image is used in this server: Map(uploadId → { pages: [{id, title}], flows: [{id, name}] }).
   * One pass over the server's pages and flows (not one per image). A reference built by a template is not found.
   */
  uploadUses(guildId) {
    const uses = new Map();
    const note = (text, kind, item) => {
      for (const m of text.matchAll(/upload:([a-z0-9]{16})/g)) {
        const entry = uses.get(m[1]) ?? uses.set(m[1], { pages: [], flows: [] }).get(m[1]);
        if (!entry[kind].some((x) => x.id === item.id)) entry[kind].push(item);
      }
    };
    for (const p of this.#stmt('SELECT id, title, blocks, theme FROM pages WHERE guild_id = ? ORDER BY title').all(guildId)) note(p.blocks + p.theme, 'pages', { id: p.id, title: p.title });
    for (const f of this.#stmt('SELECT id, name, graph FROM flows WHERE guild_id = ? ORDER BY name').all(guildId)) note(f.graph, 'flows', { id: f.id, name: f.name });
    return uses;
  }

  // ---- sessions (only a hash of the id is stored) ---------------------------------------------
  createSession(userId, data, ttlMs) {
    const id = crypto.randomBytes(32).toString('hex');
    this.#stmt('INSERT INTO sessions (id, user_id, data, expires_at) VALUES (?,?,?,?)').run(sha(id), userId, JSON.stringify(data), Date.now() + ttlMs);
    return id;
  }

  getSession(rawId) {
    if (typeof rawId !== 'string' || rawId.length !== 64) return null;
    const r = this.#stmt('SELECT * FROM sessions WHERE id = ?').get(sha(rawId));
    if (!r) return null;
    if (r.expires_at < Date.now()) { this.deleteSession(rawId); return null; }
    return { userId: r.user_id, data: JSON.parse(r.data), expiresAt: r.expires_at };
  }

  deleteSession(rawId) { this.#stmt('DELETE FROM sessions WHERE id = ?').run(sha(String(rawId))); }
  pruneSessions() { this.#stmt('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }

  // ---- component state: what a message with buttons remembers about the run that posted it -----
  // `vars` and `data` are JSON strings (the caller serializes, so every read is an independent copy).
  saveComponentState({ guildId, messageId, channelId = '', vars, data, expiresAt = null, now = Date.now() }) {
    this.#stmt(`INSERT INTO component_state (guild_id, message_id, channel_id, vars, data, created_at, expires_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(guild_id, message_id) DO UPDATE SET channel_id = excluded.channel_id, vars = excluded.vars, data = excluded.data,
        created_at = excluded.created_at, expires_at = excluded.expires_at`)
      .run(guildId, messageId, channelId, vars, data, now, expiresAt);
  }

  /** @returns {{vars: string, data: string, at: number}|undefined} undefined when unknown or expired */
  getComponentState(guildId, messageId, now = Date.now()) {
    const r = this.#stmt('SELECT vars, data, created_at, expires_at FROM component_state WHERE guild_id = ? AND message_id = ?').get(guildId, messageId);
    if (!r) return undefined;
    if (r.expires_at !== null && r.expires_at <= now) return undefined; // expired; pruneComponentState() removes the row later
    return { vars: r.vars, data: r.data, at: r.created_at };
  }

  deleteComponentState(guildId, messageId) {
    return this.#stmt('DELETE FROM component_state WHERE guild_id = ? AND message_id = ?').run(guildId, messageId).changes > 0;
  }

  deleteComponentStateForChannel(guildId, channelId) {
    return this.#stmt('DELETE FROM component_state WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId).changes;
  }

  pruneComponentState(now = Date.now()) {
    return this.#stmt('DELETE FROM component_state WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now).changes;
  }

  countComponentState(guildId) {
    return this.#stmt('SELECT COUNT(*) AS n FROM component_state WHERE guild_id = ?').get(guildId).n;
  }

  // ---- slash-command sync state ---------------------------------------------------------------
  getSyncHash(guildId) { return this.#stmt('SELECT hash FROM command_sync WHERE guild_id = ?').get(guildId)?.hash; }
  setSyncHash(guildId, hash) {
    this.#stmt('INSERT INTO command_sync (guild_id, hash) VALUES (?,?) ON CONFLICT(guild_id) DO UPDATE SET hash = excluded.hash').run(guildId, hash);
  }
}

/** Local SQLite unless a cloud database was configured. The cloud drivers keep this class's synchronous calls. */
export async function openDatabase(config) {
  if (!config.database || config.database.driver === 'sqlite') return new Database(path.join(config.dataDir, 'flowbot.sqlite'));
  const { openRemoteDatabase } = await import('./db/remote.js');
  return openRemoteDatabase(config.database);
}
