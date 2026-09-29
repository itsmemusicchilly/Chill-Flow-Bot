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
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL, blocks TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT,
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
`;

const VAR_NAME = /^[A-Za-z_][\w-]{0,31}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const toFlow = (r) => (r ? {
  id: r.id, guildId: r.guild_id, name: r.name, enabled: Boolean(r.enabled), graph: JSON.parse(r.graph),
  createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by ? JSON.parse(r.updated_by) : null,
} : null);

export class SlugTakenError extends Error {}

const toPage = (r) => (r ? {
  id: r.id, guildId: r.guild_id, slug: r.slug, title: r.title, published: Boolean(r.published), theme: JSON.parse(r.theme), blocks: JSON.parse(r.blocks),
  createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by ? JSON.parse(r.updated_by) : null,
} : null);
const toUpload = (r) => (r ? {
  id: r.id, guildId: r.guild_id, name: r.name, bytes: r.bytes, width: r.width, height: r.height, animated: Boolean(r.animated),
  sha256: r.sha256, createdAt: r.created_at, createdBy: r.created_by ? JSON.parse(r.created_by) : null,
} : null);
const toResponse = (r) => ({ id: r.id, pageId: r.page_id, blockId: r.block_id, userId: r.user_id, userName: r.user_name, answers: JSON.parse(r.answers), createdAt: r.created_at });

export class Database {
  constructor(file = ':memory:') {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.q = {};
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

  // ---- variables (scopes: guild, user — never global) -----------------------------------------
  getVar(guildId, scope, scopeId, name) {
    const r = this.#stmt('SELECT value FROM vars WHERE guild_id=? AND scope=? AND scope_id=? AND name=?').get(guildId, scope, scopeId, name);
    return r ? JSON.parse(r.value) : undefined;
  }

  setVar(guildId, scope, scopeId, name, value) {
    if (scope !== 'guild' && scope !== 'user') throw new FlowError(`Unknown variable scope “${scope}”.`);
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

  createPage({ guildId, slug, title, theme, blocks, published = false, updatedBy = null }) {
    const now = Date.now();
    const id = uid(8);
    try {
      this.#stmt('INSERT INTO pages (id, guild_id, slug, title, published, theme, blocks, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, guildId, slug, title, published ? 1 : 0, JSON.stringify(theme), JSON.stringify(blocks), now, now, updatedBy ? JSON.stringify(updatedBy) : null);
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new SlugTakenError('That web address is already used by another page.');
      throw err;
    }
    return this.getPage(guildId, id);
  }

  updatePage(guildId, id, patch, updatedBy = null) {
    const cur = this.getPage(guildId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    try {
      this.#stmt('UPDATE pages SET slug = ?, title = ?, published = ?, theme = ?, blocks = ?, updated_at = ?, updated_by = ? WHERE id = ? AND guild_id = ?')
        .run(next.slug, next.title, next.published ? 1 : 0, JSON.stringify(next.theme), JSON.stringify(next.blocks), Date.now(), JSON.stringify(updatedBy ?? cur.updatedBy), id, guildId);
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new SlugTakenError('That web address is already used by another page.');
      throw err;
    }
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

  // ---- slash-command sync state ---------------------------------------------------------------
  getSyncHash(guildId) { return this.#stmt('SELECT hash FROM command_sync WHERE guild_id = ?').get(guildId)?.hash; }
  setSyncHash(guildId, hash) {
    this.#stmt('INSERT INTO command_sync (guild_id, hash) VALUES (?,?) ON CONFLICT(guild_id) DO UPDATE SET hash = excluded.hash').run(guildId, hash);
  }
}
