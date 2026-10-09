import { applyQuery, storageId } from './query.js';

/** An in-process store used by tests and by the memory driver. Each `get` returns its own copy. */
export class MemoryStore {
  constructor() { this.cols = new Map(); }

  #col(name) { return this.cols.get(name) ?? this.cols.set(name, new Map()).get(name); }

  async get(collection, id, { guildId } = {}) {
    const doc = this.#col(collection).get(storageId(collection, id, guildId));
    return doc ? structuredClone(doc) : null;
  }

  async put(collection, id, doc) {
    this.#col(collection).set(storageId(collection, id, doc.guildId), structuredClone({ ...doc, id }));
  }

  async delete(collection, id, { guildId } = {}) {
    return this.#col(collection).delete(storageId(collection, id, guildId));
  }

  async find(collection, query = {}) {
    return applyQuery([...this.#col(collection).values()].map((doc) => structuredClone(doc)), query);
  }

  async close() {}
}
