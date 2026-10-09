// Shared filter/sort for the cloud stores. Mongo, Firestore and D1 all end up as a list of plain documents;
// this applies the same comparisons the SQLite queries use, so the three stores agree.

const OPS = {
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
};

/** Collections whose documents belong to one server and are stored under that server. */
export const GUILD_SCOPED = new Set([
  'flows', 'vars', 'pages', 'form_responses', 'uploads', 'component_state', 'linked_accounts', 'watch_state', 'file_manifests', 'file_chunks',
]);

/** A key that cannot collide across servers. The unit separator does not appear in the ids we mint. */
export function storageId(collection, id, guildId) {
  if (!GUILD_SCOPED.has(collection)) return String(id);
  if (guildId === undefined || guildId === null || guildId === '') throw new Error(`Missing server id for ${collection}.`);
  return `${guildId}\u001f${id}`;
}

/** An unambiguous id for a composite key (scope + channel + name, and so on). */
export function docKey(...parts) {
  return Buffer.from(JSON.stringify(parts.map((part) => (part === null || part === undefined ? '' : String(part))))).toString('base64url');
}

export function applyQuery(docs, query = {}) {
  let rows = docs.filter((doc) => {
    for (const [key, value] of Object.entries(query.eq || {})) if (doc[key] !== value) return false;
    if (query.neq && doc[query.neq.field] === query.neq.value) return false;
    if (query.notNull) for (const field of query.notNull) if (doc[field] === null || doc[field] === undefined) return false;
    if (query.compare) {
      const op = OPS[query.compare.op];
      if (!op) throw new Error(`Unknown comparison “${query.compare.op}”.`);
      if (!op(doc[query.compare.field], query.compare.value)) return false;
    }
    return true;
  });
  if (query.order?.length) {
    const order = query.order;
    rows.sort((a, b) => {
      for (const { field, dir } of order) {
        if (a[field] < b[field]) return dir === 'desc' ? 1 : -1;
        if (a[field] > b[field]) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  }
  if (query.offset) rows = rows.slice(query.offset);
  if (query.limit !== undefined) rows = rows.slice(0, query.limit);
  return rows;
}
