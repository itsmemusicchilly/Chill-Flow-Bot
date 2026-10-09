// Cloudflare D1 over the HTTP SQL API. Rows hold the same JSON documents as the other cloud stores.
import { applyQuery, GUILD_SCOPED, storageId } from './query.js';

const MAX_BYTES = 1_000_000;

export class D1Store {
  constructor({ accountId, apiToken, databaseId, fetch = globalThis.fetch }) {
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.databaseId = databaseId;
    this.fetch = fetch;
  }

  static async connect(cfg) {
    const store = new D1Store(cfg);
    await store.query(`CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      guild_id TEXT NOT NULL DEFAULT '',
      doc TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    )`);
    await store.query('CREATE INDEX IF NOT EXISTS docs_guild ON docs (collection, guild_id)');
    return store;
  }

  async query(sql, params = []) {
    const res = await this.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sql, params }),
      },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const message = Array.isArray(body.errors) ? body.errors.map((err) => err.message).filter(Boolean).join('; ') : '';
      throw new Error(message ? `Cloudflare D1 refused the query: ${message}` : `Cloudflare D1 refused the query (${res.status}).`);
    }
    return body.result?.[0] ?? { results: [], meta: {} };
  }

  async get(collection, id, { guildId } = {}) {
    const result = await this.query('SELECT doc FROM docs WHERE collection = ? AND id = ?', [collection, storageId(collection, id, guildId)]);
    const raw = result.results?.[0]?.doc;
    return raw ? JSON.parse(raw) : null;
  }

  async put(collection, id, doc) {
    const json = JSON.stringify({ ...doc, id });
    if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('That value is too large for Cloudflare D1 (1 MB per record).');
    const key = storageId(collection, id, doc.guildId);
    const guildId = GUILD_SCOPED.has(collection) ? String(doc.guildId) : '';
    await this.query(
      `INSERT INTO docs (collection, id, guild_id, doc) VALUES (?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET guild_id = excluded.guild_id, doc = excluded.doc`,
      [collection, key, guildId, json],
    );
  }

  async delete(collection, id, { guildId } = {}) {
    const key = storageId(collection, id, guildId);
    const existing = await this.query('SELECT 1 AS n FROM docs WHERE collection = ? AND id = ?', [collection, key]);
    if (!existing.results?.length) return false;
    await this.query('DELETE FROM docs WHERE collection = ? AND id = ?', [collection, key]);
    return true;
  }

  async find(collection, query = {}) {
    const params = [collection];
    let sql = 'SELECT doc FROM docs WHERE collection = ?';
    if (query.eq?.guildId && GUILD_SCOPED.has(collection)) {
      sql += ' AND guild_id = ?';
      params.push(String(query.eq.guildId));
    }
    const result = await this.query(sql, params);
    return applyQuery((result.results || []).map((row) => JSON.parse(row.doc)), query);
  }

  async close() {}
}
