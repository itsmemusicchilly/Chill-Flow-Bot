import { applyQuery, GUILD_SCOPED, storageId } from './query.js';

/** MongoDB (including Atlas). The document `_id` is namespaced by server, so two servers can reuse an id. */
export class MongoStore {
  constructor(client, db) { this.client = client; this.db = db; }

  static async connect({ uri, dbName }) {
    let MongoClient;
    try { ({ MongoClient } = await import('mongodb')); } catch {
      throw new Error('MongoDB support needs the mongodb package. Run npm install in the project and start again.');
    }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db(dbName);
    await db.command({ ping: 1 });
    for (const name of GUILD_SCOPED) await db.collection(name).createIndex({ guildId: 1 });
    await db.collection('pages').createIndex({ guildId: 1, slug: 1 }, { unique: true });
    await db.collection('uploads').createIndex({ guildId: 1, sha256: 1 }, { unique: true });
    await db.collection('sessions').createIndex({ expiresAt: 1 });
    return new MongoStore(client, db);
  }

  async get(collection, id, { guildId } = {}) {
    const doc = await this.db.collection(collection).findOne({ _id: storageId(collection, id, guildId) });
    return doc ? strip(doc) : null;
  }

  async put(collection, id, doc) {
    const _id = storageId(collection, id, doc.guildId);
    await this.db.collection(collection).replaceOne({ _id }, { ...doc, id, _id }, { upsert: true });
  }

  async delete(collection, id, { guildId } = {}) {
    const result = await this.db.collection(collection).deleteOne({ _id: storageId(collection, id, guildId) });
    return result.deletedCount > 0;
  }

  async find(collection, query = {}) {
    const filter = query.eq?.guildId && GUILD_SCOPED.has(collection) ? { guildId: query.eq.guildId } : {};
    const docs = await this.db.collection(collection).find(filter).toArray();
    return applyQuery(docs.map(strip), query);
  }

  async close() { await this.client.close(); }
}

function strip(doc) {
  const { _id, ...rest } = doc;
  return rest;
}
