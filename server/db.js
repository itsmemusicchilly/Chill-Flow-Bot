// SQLite storage (node:sqlite). Every flow/variable row is keyed by guild_id — there is no cross-server data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS } from '../shared/limits.js';
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
`;

const VAR_NAME = /^[A-Za-z_][\w-]{0,31}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const toFlow = (r) => (r ? {
  id: r.id, guildId: r.guild_id, name: r.name, enabled: Boolean(r.enabled), graph: JSON.parse(r.graph),
  createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by ? JSON.parse(r.updated_by) : null,
} : null);

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
    if (Buffer.byteLength(json) > LIMITS.varValueBytes) throw new FlowError(`Variable values can be at most ${LIMITS.varValueBytes} bytes.`);
    const exists = this.#stmt('SELECT 1 FROM vars WHERE guild_id=? AND scope=? AND scope_id=? AND name=?').get(guildId, scope, scopeId, name);
    if (!exists && this.countVars(guildId) >= LIMITS.varsPerGuild) throw new FlowError(`This server reached the limit of ${LIMITS.varsPerGuild} stored variables.`);
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
