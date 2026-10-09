// Where pictures and saved transcripts live when the bot has no disk it can rely on (MongoDB, Firebase or Cloudflare D1 as the storage): in that same
// database, split into small pieces. With the local database they stay ordinary files (see uploads.js and transcripts.js), and none of this is used.
//
// - A file is cut into pieces of CHUNK_BYTES, written first; a manifest with the size and a fingerprint is written last. A file that was only
//   half written has no manifest, so it does not exist, and one whose pieces do not add up to its fingerprint is treated as missing, never served.
// - Writing and deleting are rare (an upload, a closed ticket) and simply wait for the database, like every other call the bot makes to it.
// - Reading happens whenever someone opens a page: it hands the event loop back between pieces, and keeps recent files in memory (they never
//   change under their id), so a page with many pictures does not go to the database for each one every time.
import crypto from 'node:crypto';

/** Raw bytes per piece: about 256 KiB once stored as text, under the item limit of every store the bot can use. */
export const CHUNK_BYTES = 192 * 1024;

/** The pieces a file is stored as: base64 text, at most `chunkBytes` of the file in each (a file that is empty is one empty piece). */
export function chunksOf(buffer, chunkBytes = CHUNK_BYTES) {
  const count = Math.max(1, Math.ceil(buffer.length / chunkBytes));
  return Array.from({ length: count }, (_, i) => buffer.subarray(i * chunkBytes, (i + 1) * chunkBytes).toString('base64'));
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const breathe = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {{db: object, logger?: object, cacheBytes?: number, chunkBytes?: number}} deps
 *   `db` is the bot's (synchronous) database with the file methods of server/db/document.js.
 */
export function createDatabaseFiles({ db, logger = null, cacheBytes = 32 * 1024 * 1024, chunkBytes = CHUNK_BYTES }) {
  const cache = new Map(); // "kind/server/id" → Buffer, oldest first
  let cached = 0;
  const loading = new Map(); // the same file asked for twice at once is fetched once
  const stale = new Set(); // keys whose file was written or removed while a read of it was still in progress: that read must not be remembered
  const keyOf = (kind, guildId, id) => `${kind}/${guildId}/${id}`;
  const warn = (guildId, message) => { try { logger?.log(guildId, 'warn', message); } catch { /* logging must never break a request */ } };

  function forget(key) {
    const old = cache.get(key);
    if (old) { cached -= old.length; cache.delete(key); }
  }

  /** The file is being written or removed: drop what is remembered, and make any read still in progress forget its answer. */
  function invalidate(key) {
    forget(key);
    if (loading.has(key)) stale.add(key);
  }

  function remember(key, buffer) {
    forget(key);
    if (buffer.length > cacheBytes / 4) return; // one big file should not push everything else out
    while (cached + buffer.length > cacheBytes && cache.size) forget(cache.keys().next().value);
    cache.set(key, buffer);
    cached += buffer.length;
  }

  /** Stores `buffer` as the file `id` of `kind` ('pictures' or 'transcripts') in a server. Throws when the database refuses; nothing is left behind then. */
  function write(kind, guildId, id, buffer) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('A file is written from a Buffer.');
    const pieces = chunksOf(buffer, chunkBytes);
    invalidate(keyOf(kind, guildId, id));
    try {
      pieces.forEach((piece, i) => db.putFileChunk(guildId, kind, id, i, piece));
      db.putFileManifest(guildId, kind, id, { bytes: buffer.length, chunks: pieces.length, sha256: sha256(buffer) });
    } catch (err) {
      try { db.deleteFile(guildId, kind, id); } catch { /* the original error is the one worth reporting */ }
      throw err;
    }
  }

  async function load(kind, guildId, id) {
    const manifest = db.getFileManifest(guildId, kind, id);
    if (!manifest) return null;
    const parts = [];
    for (let i = 0; i < manifest.chunks; i += 1) {
      const part = db.getFileChunk(guildId, kind, id, i);
      if (typeof part !== 'string') { warn(guildId, `A stored ${kind === 'pictures' ? 'picture' : 'transcript'} is incomplete in the database (piece ${i + 1} of ${manifest.chunks} is missing).`); return null; }
      parts.push(Buffer.from(part, 'base64'));
      if (i + 1 < manifest.chunks) await breathe();
    }
    const buffer = Buffer.concat(parts);
    if (buffer.length !== manifest.bytes || sha256(buffer) !== manifest.sha256) {
      warn(guildId, `A stored ${kind === 'pictures' ? 'picture' : 'transcript'} in the database does not match its fingerprint, so it is not served.`);
      return null;
    }
    return buffer;
  }

  /** The file, or null when there is none (or it is damaged). */
  async function read(kind, guildId, id) {
    const key = keyOf(kind, guildId, id);
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; } // most recently used goes to the back
    if (loading.has(key)) return loading.get(key);
    const pending = load(kind, guildId, id)
      .then((buffer) => { if (buffer && !stale.has(key)) remember(key, buffer); return buffer; })
      .finally(() => { loading.delete(key); stale.delete(key); });
    loading.set(key, pending);
    return pending;
  }

  /** Deletes a file and its pieces. */
  function remove(kind, guildId, id) {
    invalidate(keyOf(kind, guildId, id));
    db.deleteFile(guildId, kind, id);
  }

  return { write, read, remove, chunkBytes, cachedBytes: () => cached };
}
