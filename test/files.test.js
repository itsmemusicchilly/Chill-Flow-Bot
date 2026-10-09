// The part that keeps pictures and transcripts in a database (MongoDB, Firebase, Cloudflare D1): cutting a file into pieces, checking it on the way
// back, and remembering recent ones. Here on a small pretend database; the real stores and the whole bot are in db-files.test.js / cloud-files.test.js.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { CHUNK_BYTES, chunksOf, createDatabaseFiles } from '../server/files.js';

/** The file methods of the bot's database, kept in two Maps, counting what is asked of it. */
function pretendDb() {
  const chunks = new Map(); const manifests = new Map();
  const k = (g, kind, id) => `${g}|${kind}|${id}`;
  const db = {
    calls: { chunkReads: 0, manifestReads: 0, chunkWrites: 0, deletes: 0 },
    failOnChunkWrite: null, failOnManifestWrite: false,
    putFileChunk(g, kind, id, i, data) {
      if (db.failOnChunkWrite === i) throw new Error('the database is full');
      db.calls.chunkWrites += 1; chunks.set(`${k(g, kind, id)}|${i}`, data);
    },
    putFileManifest(g, kind, id, m) { if (db.failOnManifestWrite) throw new Error('the database went away'); manifests.set(k(g, kind, id), m); },
    getFileManifest(g, kind, id) { db.calls.manifestReads += 1; return manifests.get(k(g, kind, id)) ?? null; },
    getFileChunk(g, kind, id, i) { db.calls.chunkReads += 1; return chunks.get(`${k(g, kind, id)}|${i}`) ?? null; },
    deleteFile(g, kind, id) {
      db.calls.deletes += 1;
      manifests.delete(k(g, kind, id));
      for (const key of [...chunks.keys()]) if (key.startsWith(`${k(g, kind, id)}|`)) chunks.delete(key);
    },
    chunks, manifests,
  };
  return db;
}
const bytes = (n) => crypto.randomBytes(n);

describe('cutting a file into pieces', () => {
  it('splits at the piece size, never loses a byte, and gives an empty file one empty piece', () => {
    for (const size of [0, 1, 999, 1000, 1001, 2999, 3000, 3001, 12345]) {
      const data = bytes(size);
      const pieces = chunksOf(data, 1000);
      assert.equal(pieces.length, Math.max(1, Math.ceil(size / 1000)), String(size));
      assert.deepEqual(Buffer.concat(pieces.map((p) => Buffer.from(p, 'base64'))), data, String(size));
      assert.ok(pieces.every((p) => Buffer.from(p, 'base64').length <= 1000));
    }
  });

  it('uses pieces small enough for every store: a 25 MB file stays far under 1 MiB per item', () => {
    const pieces = chunksOf(bytes(5 * 1024 * 1024));
    assert.equal(pieces.length, Math.ceil(5 * 1024 * 1024 / CHUNK_BYTES));
    const biggest = Math.max(...pieces.map((p) => p.length));
    assert.ok(biggest <= 262_144, `a piece is ${biggest} characters`);
    assert.ok(biggest + 1000 < 1_048_487, 'with the document around it, under what Firestore allows');
  });
});

describe('keeping files in the database', () => {
  let db; let logs; let files;
  const make = (over = {}) => createDatabaseFiles({ db, logger: { log: (g, level, message) => logs.push(`${level}: ${message}`) }, chunkBytes: 1000, ...over });
  beforeEach(() => { db = pretendDb(); logs = []; files = make(); });

  it('stores a file and gives back exactly what went in, for every size around the piece boundary', async () => {
    for (const size of [0, 1, 999, 1000, 1001, 2000, 2500, 10_000]) {
      const data = bytes(size);
      files.write('pictures', 'g1', `file${size}`, data);
      assert.deepEqual(await files.read('pictures', 'g1', `file${size}`), data, String(size));
    }
  });

  it('keeps servers and kinds apart: the same id in another server, or as a transcript, is another file', async () => {
    files.write('pictures', 'g1', 'same', Buffer.from('picture of g1'));
    files.write('pictures', 'g2', 'same', Buffer.from('picture of g2'));
    files.write('transcripts', 'g1', 'same', Buffer.from('transcript of g1'));
    assert.equal((await files.read('pictures', 'g1', 'same')).toString(), 'picture of g1');
    assert.equal((await files.read('pictures', 'g2', 'same')).toString(), 'picture of g2');
    assert.equal((await files.read('transcripts', 'g1', 'same')).toString(), 'transcript of g1');
    assert.equal(await files.read('transcripts', 'g2', 'same'), null);
    assert.equal(await files.read('pictures', 'g1', 'other'), null);
  });

  it('writes the manifest LAST, so a file that was cut short does not exist — and cleans up what it wrote', async () => {
    db.failOnChunkWrite = 2;
    assert.throws(() => files.write('pictures', 'g1', 'half', bytes(5000)), /the database is full/);
    assert.equal(db.manifests.size, 0, 'no manifest: nothing can see it');
    assert.equal(db.chunks.size, 0, 'and the pieces that did get written were removed');
    assert.equal(await files.read('pictures', 'g1', 'half'), null);
    db.failOnChunkWrite = null;
    db.failOnManifestWrite = true;
    assert.throws(() => files.write('pictures', 'g1', 'nomanifest', bytes(1500)), /went away/);
    assert.equal(db.chunks.size, 0);
  });

  it('even when the clean-up after a failure fails too, the half-written file has no manifest and so is never served', async () => {
    db.failOnChunkWrite = 1;
    db.deleteFile = () => { throw new Error('and now the database is gone'); };
    assert.throws(() => files.write('pictures', 'g1', 'half', bytes(4000)), /the database is full/, 'the first error is the one reported');
    assert.equal(db.manifests.size, 0);
    assert.equal(await files.read('pictures', 'g1', 'half'), null);
  });

  it('does not serve a file that is incomplete or damaged — it says so in the log instead', async () => {
    files.write('pictures', 'g1', 'lost', bytes(3500));
    db.chunks.delete('g1|pictures|lost|2');
    assert.equal(await make().read('pictures', 'g1', 'lost'), null);
    assert.match(logs.at(-1), /warn: A stored picture is incomplete in the database \(piece 3 of 4 is missing\)/);

    files.write('transcripts', 'g1', 'flipped', Buffer.from('<p>hello</p>'.repeat(200)));
    const key = 'g1|transcripts|flipped|1';
    const piece = Buffer.from(db.chunks.get(key), 'base64');
    piece[10] ^= 0xff; // one byte changed: the same length, a different page
    db.chunks.set(key, piece.toString('base64'));
    assert.equal(await make().read('transcripts', 'g1', 'flipped'), null);
    assert.match(logs.at(-1), /warn: A stored transcript in the database does not match its fingerprint/);
  });

  it('remembers recent files, so a page with the same picture many times asks the database once', async () => {
    files.write('pictures', 'g1', 'p', bytes(2500));
    await files.read('pictures', 'g1', 'p');
    const reads = db.calls.chunkReads;
    for (let i = 0; i < 5; i += 1) assert.equal((await files.read('pictures', 'g1', 'p')).length, 2500);
    assert.equal(db.calls.chunkReads, reads, 'no more reads');
  });

  it('asks only once when the same file is wanted by several visitors at the same moment', async () => {
    files.write('pictures', 'g1', 'busy', bytes(4500));
    const all = await Promise.all(Array.from({ length: 10 }, () => files.read('pictures', 'g1', 'busy')));
    assert.equal(db.calls.manifestReads, 1);
    assert.equal(db.calls.chunkReads, 5);
    assert.ok(all.every((b) => b.equals(all[0])));
  });

  it('forgets the oldest when the memory is full, and never remembers one huge file at the expense of the rest', async () => {
    const small = make({ cacheBytes: 4000 });
    for (const id of ['a', 'b', 'c']) small.write('pictures', 'g1', id, bytes(1000));
    await small.read('pictures', 'g1', 'a'); await small.read('pictures', 'g1', 'b'); await small.read('pictures', 'g1', 'c');
    assert.equal(small.cachedBytes(), 3000);
    small.write('pictures', 'g1', 'd', bytes(1000));
    await small.read('pictures', 'g1', 'a'); // a is the most recently used now
    await small.read('pictures', 'g1', 'd'); // 4000 in all
    const before = db.calls.chunkReads;
    small.write('pictures', 'g1', 'e', bytes(1000));
    await small.read('pictures', 'g1', 'e'); // makes room: b (the oldest) goes
    assert.ok(small.cachedBytes() <= 4000);
    await small.read('pictures', 'g1', 'a');
    assert.equal(db.calls.chunkReads, before + 1, 'only e was fetched: a was still remembered');
    await small.read('pictures', 'g1', 'b');
    assert.equal(db.calls.chunkReads, before + 2, 'b had been pushed out and is fetched again');
    small.write('pictures', 'g1', 'huge', bytes(3000)); // more than a quarter of the memory
    await small.read('pictures', 'g1', 'huge');
    const afterHuge = db.calls.chunkReads;
    await small.read('pictures', 'g1', 'huge');
    assert.ok(db.calls.chunkReads > afterHuge, 'not remembered');
  });

  it('forgets a file the moment it is removed or rewritten', async () => {
    files.write('pictures', 'g1', 'x', Buffer.from('first'));
    assert.equal((await files.read('pictures', 'g1', 'x')).toString(), 'first');
    files.write('pictures', 'g1', 'x', Buffer.from('second'));
    assert.equal((await files.read('pictures', 'g1', 'x')).toString(), 'second');
    files.remove('pictures', 'g1', 'x');
    assert.equal(await files.read('pictures', 'g1', 'x'), null);
    assert.equal(files.cachedBytes(), 0);
    assert.equal(db.chunks.size, 0);
    assert.equal(db.manifests.size, 0);
  });

  it('a one-piece file removed or rewritten while it is being read is not remembered as it was', async () => {
    files.write('pictures', 'g1', 'small', Buffer.from('old picture'));
    const reading = files.read('pictures', 'g1', 'small');
    files.remove('pictures', 'g1', 'small');
    await reading;
    assert.equal(files.cachedBytes(), 0, 'removed');
    files.write('pictures', 'g1', 'small', Buffer.from('first'));
    const again = files.read('pictures', 'g1', 'small');
    files.write('pictures', 'g1', 'small', Buffer.from('second, longer'));
    await again;
    assert.equal(files.cachedBytes(), 0, 'rewritten');
    assert.equal((await files.read('pictures', 'g1', 'small')).toString(), 'second, longer');
  });

  it('a read that was still under way when the file was removed does not bring it back', async () => {
    files.write('pictures', 'g1', 'x', bytes(3500));
    const reading = files.read('pictures', 'g1', 'x'); // starts, then waits between pieces
    files.remove('pictures', 'g1', 'x');
    await reading;
    assert.equal(files.cachedBytes(), 0, 'not remembered');
    assert.equal(await files.read('pictures', 'g1', 'x'), null);
  });

  it('hands the event loop back between pieces, so a big file does not freeze the bot', async () => {
    files.write('transcripts', 'g1', 'big', bytes(20_000)); // 20 pieces
    let turns = 0;
    const timer = setInterval(() => { turns += 1; }, 0);
    let spin = true;
    const ticker = (async () => { while (spin) { turns += 1; await new Promise((r) => setImmediate(r)); } })();
    await files.read('transcripts', 'g1', 'big');
    spin = false; clearInterval(timer); await ticker;
    assert.ok(turns >= 15, `other work got ${turns} turns while the file was read`);
  });

  it('writes only a Buffer', () => {
    assert.throws(() => files.write('pictures', 'g1', 'x', 'text'), TypeError);
  });

  it('uses the real piece size unless told otherwise', async () => {
    const real = createDatabaseFiles({ db });
    assert.equal(real.chunkBytes, CHUNK_BYTES);
    real.write('pictures', 'g1', 'two', bytes(CHUNK_BYTES + 1));
    assert.equal(db.manifests.get('g1|pictures|two').chunks, 2);
  });
});
