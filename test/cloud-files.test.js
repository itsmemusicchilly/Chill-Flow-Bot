// Pictures and saved transcripts when the bot's storage is MongoDB, Firebase or Cloudflare D1: the whole bot on the cloud database bridge (the real
// worker thread, with an in-memory store), where nothing may be written to the disk — the way it runs on a host whose disk is wiped on every restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { FlowError } from '../server/engine/errors.js';
import { createTranscripts } from '../server/transcripts.js';
import { A, B, startHarness } from './helpers/harness.js';
import { png } from './helpers/images.js';

const PUBLIC = 'https://bot.example.com';
const doc = (over = {}) => ({ buffer: Buffer.from('<!doctype html><title>Ticket</title><p>hello</p>'), name: 'transcript-ticket.html', messages: 3, bytes: 48, truncated: false, ...over });
const upload = (h, buf, name = 'cat.png', gid = A) => h.call('POST', `/api/guilds/${gid}/uploads`, { raw: buf, type: 'image/png', headers: { 'X-Filename': encodeURIComponent(name) } });
/** A public GET with the body kept as bytes (the harness's call() reads it as text). */
const get = async (h, target, headers = {}) => {
  const res = await fetch(`${h.base}${target}`, { headers, redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
};
const nothingOnDisk = (h) => {
  for (const sub of ['uploads', 'transcripts']) {
    const dir = path.join(h.dataDir, sub);
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n !== '.tmp') : [], [], `${sub}/ on the disk`);
  }
};

describe('pictures kept in the database', () => {
  let h;
  beforeEach(async () => { resetLimits(); h = await startHarness({ database: 'memory', config: { uploadRate: { perUser: 1000, views: 100000 } } }); });
  afterEach(async () => { resetLimits(); await h.close(); });

  it('uploads, and serves the picture back with the same headers as from a disk — writing nothing to the disk', async () => {
    const r = await upload(h, await png(64, 48));
    assert.equal(r.status, 201, r.text);
    const u = r.json.upload;
    const got = await get(h, `/i/${A}/${u.id}.webp`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/webp');
    assert.equal(got.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.match(got.headers.get('etag'), /^"[0-9a-f]{32}"$/);
    const body = got.body;
    assert.equal(body.subarray(0, 4).toString(), 'RIFF');
    assert.equal(body.subarray(8, 12).toString(), 'WEBP');
    assert.equal(body.length, u.bytes);
    nothingOnDisk(h);
  });

  it('serves exactly the bytes a disk would have (a multi-piece picture comes back identical)', async () => {
    const input = await png(120, 90, { noise: true });
    const disk = await startHarness({ config: { uploadRate: { perUser: 1000, views: 100000 } } });
    let onDisk;
    try {
      const d = await upload(disk, input);
      onDisk = (await get(disk, `/i/${A}/${d.json.upload.id}.webp`)).body;
    } finally { await disk.close(); }
    await h.close();
    h = await startHarness({ database: 'memory', filesOptions: { chunkBytes: 512 }, config: { uploadRate: { perUser: 1000, views: 100000 } } }); // many tiny pieces
    const r = await upload(h, input);
    const fromDb = (await get(h, `/i/${A}/${r.json.upload.id}.webp`)).body;
    assert.ok(onDisk.length > 2000, 'big enough to need several pieces');
    assert.ok(fromDb.equals(onDisk));
    assert.ok(h.db.getFileManifest(A, 'pictures', r.json.upload.id).chunks > 3);
  });

  it('answers a repeat visit with a 304 without going to the database', async () => {
    const u = (await upload(h, await png(40, 40))).json.upload;
    const first = await get(h, `/i/${A}/${u.id}.webp`);
    const again = await get(h, `/i/${A}/${u.id}.webp`, { 'If-None-Match': first.headers.get('etag') });
    assert.equal(again.status, 304);
  });

  it('is only ever this server\'s: another server\'s address, a made-up id and a deleted picture are the same 404', async () => {
    const u = (await upload(h, await png(40, 40))).json.upload;
    assert.equal((await h.call('GET', `/i/${B}/${u.id}.webp`, { sid: null, origin: null })).status, 404);
    assert.equal((await h.call('GET', `/i/${A}/${'a'.repeat(16)}.webp`, { sid: null, origin: null })).status, 404);
    await h.call('GET', `/i/${A}/${u.id}.webp`, { sid: null, origin: null }); // now it is remembered in memory
    const gone = await h.call('DELETE', `/api/guilds/${A}/uploads/${u.id}`);
    assert.equal(gone.status, 200);
    assert.equal((await h.call('GET', `/i/${A}/${u.id}.webp`, { sid: null, origin: null })).status, 404);
    assert.equal(h.db.getFileManifest(A, 'pictures', u.id), null, 'and its pieces are gone from the database');
    assert.equal(h.files.cachedBytes(), 0);
  });

  it('the same picture twice is kept once', async () => {
    const input = await png(33, 22);
    const a = await upload(h, input);
    const b = await upload(h, input, 'again.png');
    assert.equal(b.json.duplicate, true);
    assert.equal(b.json.upload.id, a.json.upload.id);
    assert.equal(h.db.listUploads(A).length, 1);
  });

  it('says so, and leaves nothing behind, when the database refuses the picture', async () => {
    h.db.putFileChunk = () => { throw new Error('quota exceeded for project secret-project-123'); };
    const r = await upload(h, await png(40, 40));
    assert.equal(r.status, 507);
    assert.match(r.json.error, /The database did not accept the picture/);
    assert.ok(!r.text.includes('secret-project-123'), 'the database\'s own message stays in the log');
    assert.equal(h.db.listUploads(A).length, 0, 'no row without its file');
    assert.ok(h.logger.recent(A, 10).some((l) => l.level === 'error' && /quota exceeded/.test(l.message)));
  });

  it('keeps the limits: pictures per server, and the space they take', async () => {
    applyLimits({ uploadsPerGuild: 1 });
    assert.equal((await upload(h, await png(30, 30, { noise: true }))).status, 201);
    const second = await upload(h, await png(31, 30, { noise: true }));
    assert.equal(second.status, 409);
    assert.match(second.json.error, /at most 1 uploaded images/);
    assert.equal(h.db.listUploads(A).length, 1);
  });

  it('tells the log, and shows a plain 404, when a stored picture has lost a piece', async () => {
    await h.close();
    h = await startHarness({ database: 'memory', filesOptions: { chunkBytes: 300 }, config: { uploadRate: { perUser: 1000, views: 100000 } } });
    const u = (await upload(h, await png(80, 60, { noise: true }))).json.upload;
    const m = h.db.getFileManifest(A, 'pictures', u.id);
    assert.ok(m.chunks > 2);
    h.db.putFileManifest(A, 'pictures', u.id, { ...m, chunks: m.chunks + 2 }); // as if pieces had been lost
    const r = await h.call('GET', `/i/${A}/${u.id}.webp`, { sid: null, origin: null });
    assert.equal(r.status, 404);
    assert.equal(r.res.headers.get('cache-control'), 'no-store');
    assert.ok(h.logger.recent(A, 10).some((l) => l.level === 'warn' && /incomplete in the database/.test(l.message)));
  });

  it('the picture library lists them like any others, and the rest of the bot works on this database', async () => {
    await upload(h, await png(40, 40));
    const list = await h.call('GET', `/api/guilds/${A}/uploads`);
    assert.equal(list.json.uploads.length, 1);
    assert.equal(list.json.usage.count, 1);
    assert.equal((await h.call('GET', '/api/me')).status, 200);
  });
});

describe('saved transcripts kept in the database', () => {
  let h; let t; let store;
  beforeEach(async () => {
    resetLimits();
    h = await startHarness({ database: 'memory' });
    t = Date.UTC(2026, 0, 1);
    store = (days = 0) => createTranscripts({ config: { baseUrl: PUBLIC, dataDir: h.dataDir, transcriptRetentionDays: days }, db: h.db, logger: h.logger, now: () => t, files: h.files });
  });
  afterEach(async () => { resetLimits(); await h.close(); });

  it('saves a page, opens it at its link with the usual protections — and writes nothing to the disk', async () => {
    const saved = store(30).save(A, doc()); // (saved with a public BASE_URL; the test app's own address is localhost, which could not be linked to)
    assert.match(saved.id, /^[a-z0-9]{32}$/);
    assert.equal(saved.url, `${PUBLIC}/t/${saved.id}`);
    assert.equal(saved.expiresAt, new Date(t + 30 * 86_400_000).toISOString());
    const page = await h.call('GET', `/t/${saved.id}`, { sid: null, origin: null });
    assert.equal(page.status, 200);
    assert.equal(page.text, doc().buffer.toString());
    assert.match(page.res.headers.get('content-type'), /^text\/html/);
    assert.match(page.res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(page.res.headers.get('cache-control'), 'private, no-store');
    assert.equal(page.res.headers.get('x-robots-tag'), 'noindex, nofollow');
    nothingOnDisk(h);
  });

  it('keeps a big page (many pieces) whole', async () => {
    const big = Buffer.from(`<!doctype html><body>${'<p>a line of a long ticket</p>'.repeat(30_000)}</body>`);
    assert.ok(big.length > 800_000);
    const saved = store().save(A, doc({ buffer: big, bytes: big.length }));
    assert.ok(h.db.getFileManifest(A, 'transcripts', saved.id).chunks >= 5);
    const page = await h.call('GET', `/t/${saved.id}`, { sid: null, origin: null });
    assert.equal(page.status, 200);
    assert.ok(Buffer.from(page.text).equals(big));
  });

  it('shows the same "not available" page for a wrong id, a removed transcript and an expired one', async () => {
    await h.close();
    h = await startHarness({ database: 'memory', config: { transcriptRetentionDays: 1 } });
    const unavailable = (r) => r.status === 404 && /This transcript isn't available/.test(r.text);
    const saver = (now) => createTranscripts({ config: { baseUrl: PUBLIC, dataDir: h.dataDir, transcriptRetentionDays: 1 }, db: h.db, logger: h.logger, now, files: h.files });
    const fresh = saver(() => Date.now()).save(A, doc());
    const stale = saver(() => Date.now() - 3 * 86_400_000).save(A, doc());
    assert.equal((await h.call('GET', `/t/${fresh.id}`, { sid: null, origin: null })).status, 200);
    assert.ok(unavailable(await h.call('GET', `/t/${'z'.repeat(32)}`, { sid: null, origin: null })), 'a wrong id');
    assert.ok(unavailable(await h.call('GET', `/t/${stale.id}`, { sid: null, origin: null })), 'past its day: refused even before the clean-up has run');
    assert.equal(saver(() => Date.now()).remove(fresh.id), true);
    assert.ok(unavailable(await h.call('GET', `/t/${fresh.id}`, { sid: null, origin: null })), 'removed');
    assert.equal(h.db.getFileManifest(A, 'transcripts', fresh.id), null, 'the stored pages are gone too');
  });

  it('the clean-up deletes what is past its time, from the database, and keeps the rest', () => {
    const s = store(7);
    const old = s.save(A, doc());
    t += 5 * 86_400_000;
    const young = s.save(B, doc());
    t += 3 * 86_400_000; // the first is 8 days old, the second 3
    assert.equal(s.prune(), 1);
    assert.equal(h.db.getTranscript(old.id), null);
    assert.equal(h.db.getFileManifest(A, 'transcripts', old.id), null);
    assert.ok(h.db.getTranscript(young.id));
    assert.ok(h.db.getFileManifest(B, 'transcripts', young.id));
  });

  it('refuses plainly, and leaves no row behind, when the database will not take the page', () => {
    h.db.putFileChunk = () => { throw new Error('the connection to cluster0.secret.example.net was reset'); };
    const s = store();
    assert.throws(() => s.save(A, doc()), (e) => e instanceof FlowError && /The database did not accept the transcript/.test(e.message) && !/secret/.test(e.message));
    assert.deepEqual(h.db.transcriptsBefore(Number.MAX_SAFE_INTEGER), [], 'no row without its page');
    assert.ok(h.logger.recent(A, 10).some((l) => l.level === 'error' && /cluster0/.test(l.message)));
  });

  it('a page that has lost a piece is the "not available" page, and the log says why', async () => {
    const saved = store().save(A, doc());
    const m = h.db.getFileManifest(A, 'transcripts', saved.id);
    h.db.putFileManifest(A, 'transcripts', saved.id, { ...m, chunks: 3 });
    const r = await h.call('GET', `/t/${saved.id}`, { sid: null, origin: null });
    assert.equal(r.status, 404);
    assert.ok(h.logger.recent(A, 10).some((l) => l.level === 'warn' && /missing in the database/.test(l.message)));
  });
});
