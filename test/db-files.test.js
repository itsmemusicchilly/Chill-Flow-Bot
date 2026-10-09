// The file methods of the cloud database on each store the bot can run on, with those stores' real size limits (see helpers/cloud-fakes.js).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { D1Store } from '../server/db/d1-store.js';
import { DocumentDatabase } from '../server/db/document.js';
import { FirestoreStore } from '../server/db/firestore-store.js';
import { MemoryStore } from '../server/db/memory-store.js';
import { chunksOf, CHUNK_BYTES } from '../server/files.js';
import { fakeD1, fakeFirestore, LIMITS } from './helpers/cloud-fakes.js';

const STORES = {
  'the in-memory store': () => ({ db: new DocumentDatabase(new MemoryStore()) }),
  'Cloudflare D1': () => { const fetch = fakeD1(); return { db: new DocumentDatabase(new D1Store({ accountId: 'acct', apiToken: 'tok', databaseId: 'db', fetch })), fetch, limit: LIMITS.d1Row }; },
  'Firestore': () => {
    const fetch = fakeFirestore();
    return { db: new DocumentDatabase(new FirestoreStore({ projectId: 'proj', clientEmail: 'a@proj.iam.gserviceaccount.com', privateKey: 'unused', token: 'test-token', fetch })), fetch, limit: LIMITS.firestoreField };
  },
};

/** Writes a file the way server/files.js does (the pieces, then the manifest) and reads it back the same way, on an asynchronous database. */
async function store(db, g, kind, id, data) {
  const pieces = chunksOf(data);
  for (const [i, piece] of pieces.entries()) await db.putFileChunk(g, kind, id, i, piece);
  await db.putFileManifest(g, kind, id, { bytes: data.length, chunks: pieces.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
}
async function load(db, g, kind, id) {
  const m = await db.getFileManifest(g, kind, id);
  if (!m) return null;
  const parts = [];
  for (let i = 0; i < m.chunks; i += 1) parts.push(Buffer.from(await db.getFileChunk(g, kind, id, i), 'base64'));
  return Buffer.concat(parts);
}

for (const [name, make] of Object.entries(STORES)) {
  describe(`files in ${name}`, () => {
    it('round-trips a picture-sized file and a multi-piece file, byte for byte', async () => {
      const { db } = make();
      const small = crypto.randomBytes(40_000);
      const large = crypto.randomBytes(CHUNK_BYTES * 3 + 123);
      await store(db, 'g1', 'pictures', 'small', small);
      await store(db, 'g1', 'transcripts', 'large', large);
      assert.deepEqual(await load(db, 'g1', 'pictures', 'small'), small);
      assert.deepEqual(await load(db, 'g1', 'transcripts', 'large'), large);
      assert.deepEqual(await db.getFileManifest('g1', 'transcripts', 'large'), { bytes: large.length, chunks: 4, sha256: crypto.createHash('sha256').update(large).digest('hex') });
    });

    it('keeps servers and kinds apart', async () => {
      const { db } = make();
      await store(db, 'g1', 'pictures', 'same', Buffer.from('one'));
      await store(db, 'g2', 'pictures', 'same', Buffer.from('two'));
      await store(db, 'g1', 'transcripts', 'same', Buffer.from('three'));
      assert.equal((await load(db, 'g1', 'pictures', 'same')).toString(), 'one');
      assert.equal((await load(db, 'g2', 'pictures', 'same')).toString(), 'two');
      assert.equal((await load(db, 'g1', 'transcripts', 'same')).toString(), 'three');
      assert.equal(await db.getFileManifest('g3', 'pictures', 'same'), null);
      assert.equal(await db.getFileChunk('g2', 'transcripts', 'same', 0), null);
    });

    it('deletes the manifest first and every piece after, for one file only', async () => {
      const { db } = make();
      await store(db, 'g1', 'pictures', 'gone', crypto.randomBytes(CHUNK_BYTES * 2 + 5));
      await store(db, 'g1', 'pictures', 'kept', crypto.randomBytes(CHUNK_BYTES + 5));
      await db.deleteFile('g1', 'pictures', 'gone');
      assert.equal(await db.getFileManifest('g1', 'pictures', 'gone'), null);
      for (let i = 0; i < 3; i += 1) assert.equal(await db.getFileChunk('g1', 'pictures', 'gone', i), null, `piece ${i}`);
      assert.equal((await load(db, 'g1', 'pictures', 'kept')).length, CHUNK_BYTES + 5);
      await db.deleteFile('g1', 'pictures', 'never-existed'); // nothing to delete is fine
    });

    it('takes the manifest away BEFORE the pieces, so a reader never meets a file that is half deleted', async () => {
      const order = [];
      class SpyStore extends MemoryStore {
        async delete(collection, ...rest) { order.push(collection); return super.delete(collection, ...rest); }
      }
      const db = new DocumentDatabase(new SpyStore());
      await store(db, 'g1', 'pictures', 'x', crypto.randomBytes(CHUNK_BYTES * 2 + 1));
      await db.deleteFile('g1', 'pictures', 'x');
      assert.deepEqual(order, ['file_manifests', 'file_chunks', 'file_chunks', 'file_chunks']);
    });

    it('also cleans up the pieces of a file whose manifest was never written', async () => {
      const { db } = make();
      await db.putFileChunk('g1', 'pictures', 'torn', 0, 'AAAA');
      await db.putFileChunk('g1', 'pictures', 'torn', 1, 'BBBB');
      await db.deleteFile('g1', 'pictures', 'torn');
      assert.equal(await db.getFileChunk('g1', 'pictures', 'torn', 0), null);
      assert.equal(await db.getFileChunk('g1', 'pictures', 'torn', 1), null);
    });

    it('writing again replaces a piece', async () => {
      const { db } = make();
      await db.putFileChunk('g1', 'pictures', 'x', 0, 'OLD=');
      await db.putFileChunk('g1', 'pictures', 'x', 0, 'NEW=');
      assert.equal(await db.getFileChunk('g1', 'pictures', 'x', 0), 'NEW=');
    });
  });
}

describe('what is handed to the stores fits their limits', () => {
  for (const name of ['Cloudflare D1', 'Firestore']) {
    it(`a ${(5).toFixed(0)} MB file on ${name}: no single item is near the limit`, async () => {
      const { db, fetch, limit } = STORES[name]();
      await store(db, 'g1', 'transcripts', 'five', crypto.randomBytes(5 * 1024 * 1024));
      assert.ok(fetch.biggest() < 300_000, `the biggest item was ${fetch.biggest()} bytes`);
      assert.ok(fetch.biggest() < limit / 3);
      assert.equal(fetch.count(), Math.ceil(5 * 1024 * 1024 / CHUNK_BYTES) + 1, 'the pieces and the manifest');
    });

    it(`a piece the size of a whole 2 MB picture would have been refused by ${name} — which is why files are cut up`, async () => {
      const { db } = STORES[name]();
      await assert.rejects(() => db.putFileChunk('g1', 'pictures', 'whole', 0, crypto.randomBytes(2_000_000).toString('base64')));
    });
  }
});
