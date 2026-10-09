// `npm run check-storage`: the self-test of a cloud database (MongoDB, Firebase, Cloudflare D1), and the DB_FILE_PIECE_KB setting it tunes.
// The real services are never reached here: the check runs against the in-memory cloud database, wrapped to refuse, damage or forget things.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { checkStorage, piecesToTry, TEST_SIZES, verdict } from '../scripts/check-storage.js';
import { ConfigError, DEFAULT_PIECE_KB, loadConfig, pieceKbOf } from '../server/config.js';
import { openRemoteDatabase } from '../server/db/remote.js';
import { filesForConfig } from '../server/files.js';

const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'check-storage.js');
const KB = 1024;
const SMALL = [1 * KB, 100 * KB, 300 * KB]; // enough to need several pieces without making the run slow

describe('the piece sizes to try', () => {
  it('starts with the size asked for and halves down to the smallest allowed', () => {
    assert.deepEqual(piecesToTry(192), [192, 96, 48, 24, 16]);
    assert.deepEqual(piecesToTry(512), [512, 256, 128, 64, 32, 16]);
  });
  it('always ends at the smallest allowed, and never repeats a size', () => {
    assert.deepEqual(piecesToTry(20), [20, 16]);
    assert.deepEqual(piecesToTry(16), [16]);
    assert.deepEqual(piecesToTry(17), [17, 16]);
  });
});

describe('the DB_FILE_PIECE_KB setting', () => {
  const base = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's' };
  it('is 192 KB unless set', () => {
    assert.equal(pieceKbOf({}), DEFAULT_PIECE_KB);
    assert.equal(pieceKbOf({ DB_FILE_PIECE_KB: '  ' }), DEFAULT_PIECE_KB);
    assert.equal(loadConfig(base).filePieceKb, 192);
  });
  it('takes a whole number from 16 to 512', () => {
    assert.equal(pieceKbOf({ DB_FILE_PIECE_KB: '16' }), 16);
    assert.equal(pieceKbOf({ DB_FILE_PIECE_KB: ' 64 ' }), 64);
    assert.equal(pieceKbOf({ DB_FILE_PIECE_KB: '512' }), 512);
    assert.equal(loadConfig({ ...base, DB_FILE_PIECE_KB: '48' }).filePieceKb, 48);
  });
  it('refuses anything else, and says what to do instead', () => {
    for (const bad of ['0', '15', '513', '1.5', 'abc', '-64', '1e2x']) {
      assert.throws(() => pieceKbOf({ DB_FILE_PIECE_KB: bad }), (err) => err instanceof ConfigError && /DB_FILE_PIECE_KB/.test(err.message) && /check-storage/.test(err.message), bad);
      assert.throws(() => loadConfig({ ...base, DB_FILE_PIECE_KB: bad }), ConfigError, bad);
    }
  });
});

describe('how the server uses the setting', () => {
  const settings = (driver, filePieceKb) => ({ database: { driver }, filePieceKb });
  it('keeps no files in the database with the local database', () => {
    assert.equal(filesForConfig({ config: settings('sqlite', 192), db: {} }), null);
  });
  it('cuts files into pieces of that many KB with a cloud database', async () => {
    const db = openRemoteDatabase({ driver: 'memory', limits: {} });
    try {
      for (const kb of [16, 48, 192]) {
        const files = filesForConfig({ config: settings('mongodb', kb), db });
        assert.equal(files.chunkBytes, kb * 1024);
        files.write('pictures', 'g1', `f${kb}`, Buffer.alloc(kb * 1024 * 2 + 1, 7));
        assert.equal(db.getFileManifest('g1', 'pictures', `f${kb}`).chunks, 3);
        assert.equal((await files.read('pictures', 'g1', `f${kb}`)).length, kb * 1024 * 2 + 1);
      }
    } finally { db.close(); }
  });
});

describe('what the check says at the end', () => {
  it('is all good, with the largest item stored, when the piece size asked for works', () => {
    const v = verdict({ ok: true, workingKb: 192, configuredKb: 192 }, 'MongoDB');
    assert.equal(v.code, 0);
    assert.match(v.text, /^All good\./);
    assert.match(v.text, /MongoDB in pieces of 192 KB/);
    assert.match(v.text, /about 256 KB/); // base64 makes a piece a third bigger
    assert.equal(verdict({ ok: true, workingKb: 100, configuredKb: 100 }, 'x').text.match(/about (\d+) KB/)[1], '134');
  });
  it('names the DB_FILE_PIECE_KB to set when only smaller pieces work, and is not a success', () => {
    const v = verdict({ ok: false, workingKb: 24, configuredKb: 192 }, 'Cloudflare D1');
    assert.equal(v.code, 1);
    assert.match(v.text, /Cloudflare D1 refused pieces of 192 KB but accepts 24 KB/);
    assert.match(v.text, /^ {2}DB_FILE_PIECE_KB=24$/m);
  });
  it('says nothing could be stored when no size worked', () => {
    const v = verdict({ ok: false, workingKb: null, configuredKb: 192 }, 'Firebase');
    assert.equal(v.code, 1);
    assert.match(v.text, /Firebase did not accept the test files/);
    assert.doesNotMatch(v.text, /DB_FILE_PIECE_KB=/);
  });
});

describe('checking a database', () => {
  let db;
  before(() => { db = openRemoteDatabase({ driver: 'memory', limits: {} }); });
  after(() => db.close());

  /** The database, with some of its methods replaced; every file piece, manifest and deletion that goes through is written down. */
  function spy(replace = {}) {
    const seen = { chunks: [], manifests: [], deletes: [], sizes: [], vars: [] };
    const wrapped = Object.create(db);
    wrapped.putFileChunk = (g, kind, id, i, data) => {
      seen.chunks.push([g, kind, id, i]);
      seen.sizes.push(data.length);
      return (replace.putFileChunk ?? db.putFileChunk).call(db, g, kind, id, i, data);
    };
    wrapped.putFileManifest = (g, kind, id, m) => { seen.manifests.push([g, kind, id]); return (replace.putFileManifest ?? db.putFileManifest).call(db, g, kind, id, m); };
    wrapped.deleteFile = (g, kind, id) => { seen.deletes.push([g, kind, id]); return (replace.deleteFile ?? db.deleteFile).call(db, g, kind, id); };
    wrapped.setVar = (g, scope, scopeId, name, value) => { seen.vars.push([g, scope, scopeId, name]); return (replace.setVar ?? db.setVar).call(db, g, scope, scopeId, name, value); };
    for (const name of ['getFileChunk', 'getFileManifest', 'getVar', 'putFileManifest']) if (replace[name]) wrapped[name] = replace[name];
    return { db: wrapped, seen };
  }
  const run = async (wrapped, extra = {}) => {
    const lines = [];
    const result = await checkStorage({ db: wrapped, driver: 'mongodb', sizes: SMALL, log: (l) => lines.push(l), ...extra });
    return { result, lines, text: lines.join('\n') };
  };
  /** Every file the check made must be gone, with its pieces: asks the database itself rather than trusting the check's own word. */
  const assertNothingLeft = ({ chunks, manifests, vars }) => {
    assert.ok(vars.length > 0, 'the check never stored its small value');
    for (const [g, scope, scopeId, name] of vars) assert.equal(db.getVar(g, scope, scopeId, name), undefined, `the small value “${name}” is still stored`);
    for (const [g, kind, id, i] of chunks) assert.equal(db.getFileChunk(g, kind, id, i), null, `piece ${i} of ${id} is still stored`);
    for (const [g, kind, id] of manifests) assert.equal(db.getFileManifest(g, kind, id), null, `${id} is still stored`);
  };

  it('passes on a database that keeps everything, and leaves nothing behind', async () => {
    const { db: wrapped, seen } = spy();
    const { result, text } = await run(wrapped);
    assert.deepEqual(result, { ok: true, workingKb: 192, configuredKb: 192 });
    assert.match(text, /a small value: written, read back, deleted/);
    assert.match(text, /Files, in pieces of 192 KB/);
    for (const label of ['1 KB file (1 piece)', '100 KB file (1 piece)', '300 KB file (2 pieces)']) assert.ok(text.includes(label), `missing “${label}” in:\n${text}`);
    assert.equal(seen.manifests.length, SMALL.length);
    assert.equal(seen.chunks.length, 1 + 1 + 2);
    assertNothingLeft(seen);
    assert.doesNotMatch(text, /✗/);
  });

  it('uses the sizes it is given by default: a thousand bytes up to a couple of megabytes', async () => {
    assert.equal(TEST_SIZES[0], 1 * KB);
    assert.ok(TEST_SIZES.at(-1) >= 2 * 1024 * KB);
    assert.ok(TEST_SIZES.some((s) => s > 192 * KB), 'one test file must need more than one piece');
    const { db: wrapped, seen } = spy();
    const { result } = await run(wrapped, { sizes: undefined });
    assert.equal(result.ok, true);
    assert.equal(seen.manifests.length, TEST_SIZES.length);
    assertNothingLeft(seen);
  });

  it('writes the starting piece size it is told to', async () => {
    const { db: wrapped, seen } = spy();
    const { result, text } = await run(wrapped, { startKb: 64 });
    assert.deepEqual(result, { ok: true, workingKb: 64, configuredKb: 64 });
    assert.match(text, /Files, in pieces of 64 KB/);
    assert.ok(Math.max(...seen.sizes) <= Math.ceil(64 * KB * 4 / 3) + 4, 'no piece may be bigger than the size asked for');
    assert.equal(seen.chunks.length, 1 + 2 + 5); // 1 KB, 100 KB, 300 KB in pieces of 64 KB
    assertNothingLeft(seen);
  });

  it('finds the biggest piece the database accepts when it refuses the default, and reports it as a failure', async () => {
    const limit = 40_000; // characters of stored text per piece
    const { db: wrapped, seen } = spy({
      putFileChunk(g, kind, id, i, data) { if (data.length > limit) throw new Error('Request entity too large'); return db.putFileChunk(g, kind, id, i, data); },
    });
    const { result, text } = await run(wrapped);
    assert.deepEqual(result, { ok: false, workingKb: 24, configuredKb: 192 }); // 24 KB → 32,768 characters; 48 KB → 65,536 is over
    assert.match(text, /Files, in pieces of 192 KB:/);
    assert.match(text, /✗ a 100 KB file failed at "write": Request entity too large/);
    for (const kb of [96, 48]) assert.ok(text.includes(`Trying smaller pieces of ${kb} KB:`), `no attempt with ${kb} KB`);
    assert.match(text, /Trying smaller pieces of 24 KB:\n( {2}✓.*\n?)+$/); // the last attempt is the one that worked
    assert.doesNotMatch(text, /smaller pieces of 16 KB/); // it stops at the first that works
    assertNothingLeft(seen); // including the files the refused attempts started
  });

  it('says the same when nothing is accepted at any size', async () => {
    const { db: wrapped, seen } = spy({ putFileChunk() { throw new Error('quota exceeded'); } });
    const { result, text } = await run(wrapped);
    assert.deepEqual(result, { ok: false, workingKb: null, configuredKb: 192 });
    for (const kb of piecesToTry(192)) assert.ok(text.includes(`${kb} KB:`), `no attempt with ${kb} KB`);
    assert.match(text, /a 1 KB file failed at "write": quota exceeded/);
    assertNothingLeft(seen);
  });

  it('stops early, with a hint for the service, when even a small value cannot be saved', async () => {
    const { db: wrapped, seen } = spy({ setVar() { throw new Error('bad auth'); } });
    const { result, text } = await run(wrapped, { driver: 'cloudflare' });
    assert.deepEqual(result, { ok: false, workingKb: null, configuredKb: 192 });
    assert.match(text, /a small value could not be written and read back: bad auth/);
    assert.match(text, /Cloudflare D1: check the account id/);
    assert.equal(seen.chunks.length, 0, 'it must not go on to files when the keys are wrong');
  });

  it('notices a value that was accepted but not kept', async () => {
    const { db: wrapped } = spy({ getVar() { return null; } });
    const { result, text } = await run(wrapped);
    assert.equal(result.ok, false);
    assert.match(text, /a value was written but not read back/);
  });

  it('notices a database that changes what it stores, even when it also rewrites the fingerprint to match', async () => {
    const stored = new Map(); // what the pretend service really keeps of each file: its pieces, altered
    const { db: wrapped, seen } = spy({
      putFileChunk(g, kind, id, i, data) {
        const altered = `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`;
        stored.set(id, [...(stored.get(id) ?? []), altered]);
        return db.putFileChunk(g, kind, id, i, altered);
      },
      putFileManifest(g, kind, id, m) {
        const bytes = Buffer.concat(stored.get(id).map((piece) => Buffer.from(piece, 'base64')));
        return db.putFileManifest(g, kind, id, { ...m, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      },
    });
    const { result, text } = await run(wrapped, { sizes: [5 * KB] });
    assert.equal(result.ok, false);
    assert.match(text, /a 5 KB file failed at "read": it was read back, but it is different from what was written/);
    assertNothingLeft(seen);
  });

  it('notices a file whose pieces were deleted but whose record is still there', async () => {
    const gone = new Set();
    const { db: wrapped, seen } = spy({
      deleteFile(g, kind, id) { gone.add(id); }, // the pieces "go", the manifest stays
      getFileChunk(g, kind, id, i) { return gone.has(id) ? null : db.getFileChunk(g, kind, id, i); },
    });
    const { result, text } = await run(wrapped, { sizes: [5 * KB] });
    assert.equal(result.ok, false);
    assert.match(text, /failed at "remove": it was removed, but it is still there/);
    for (const [g, kind, id] of seen.manifests) db.deleteFile(g, kind, id); // this test's own tidying
  });

  it('notices a file that comes back damaged (the fingerprint no longer matches)', async () => {
    const { db: wrapped, seen } = spy({ getFileChunk(g, kind, id, i) { const piece = db.getFileChunk(g, kind, id, i); return piece && `${piece[0] === 'A' ? 'B' : 'A'}${piece.slice(1)}`; } });
    const { result, text } = await run(wrapped, { sizes: [5 * KB] });
    assert.deepEqual(result, { ok: false, workingKb: null, configuredKb: 192 }); // smaller pieces do not cure damage, so it tries them all and gives up
    assert.match(text, /a 5 KB file failed at "read": it was written, but could not be read back/);
    assertNothingLeft(seen);
  });

  it('notices a file that comes back missing', async () => {
    const { db: wrapped, seen } = spy({ getFileManifest() { return null; } });
    const { result, text } = await run(wrapped, { sizes: [5 * KB] });
    assert.equal(result.ok, false);
    assert.match(text, /failed at "read"/);
    assertNothingLeft(seen);
  });

  it('notices a file that cannot be deleted, and still tries to clean it up', async () => {
    const { db: wrapped, seen } = spy({ deleteFile() { /* the service ignores deletes */ } });
    const { result, text } = await run(wrapped, { sizes: [5 * KB] });
    assert.equal(result.ok, false);
    assert.match(text, /failed at "remove": it was removed, but it is still there/);
    assert.ok(seen.deletes.length >= 2, 'the check itself must try to delete what it made');
    for (const [g, kind, id] of seen.manifests) db.deleteFile(g, kind, id); // this test's own tidying: the pretend service never deleted
  });

  it('keeps a failure in one run from touching another run’s files', async () => {
    const a = spy();
    const b = spy();
    const [one, two] = await Promise.all([run(a.db), run(b.db)]);
    assert.equal(one.result.ok && two.result.ok, true);
    const guilds = new Set([...a.seen.manifests, ...b.seen.manifests].map(([g]) => g));
    assert.equal(guilds.size, 2, 'each run uses its own server id');
    assert.ok([...guilds].every((g) => g.startsWith('check-')), 'test data must be recognisable as such');
  });
});

describe('the command', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-check-')); });
  afterEach(() => { fs.rmSync(path.join(dir, '.env'), { force: true }); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Runs the real command in an empty folder, with only the settings given (nothing from this machine's own .env or environment). */
  function command(args, env = {}) {
    const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', SCRIPT, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, HOME: dir, ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it('explains itself with --help', () => {
    const r = command(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /check-storage/);
  });

  it('says there is nothing to check for the local database, and succeeds', () => {
    const r = command([]);
    assert.equal(r.code, 0);
    assert.match(r.out, /Nothing to check: this bot uses the local database/);
    assert.equal(command([], { DB_DRIVER: 'sqlite', MONGODB_URI: 'mongodb://127.0.0.1:1/' }).code, 0);
  });

  // one run covers both: the settings come from the .env file, and the database they name is not there (the MongoDB driver waits 8 s before it gives up)
  it('reads its settings from a .env file in the folder it runs in, and fails with a hint when that database cannot be reached', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'MONGODB_URI=mongodb://127.0.0.1:1/\n');
    const r = command([]);
    assert.equal(r.code, 1);
    assert.match(r.out, /Checking the storage: MongoDB/);
    assert.match(r.out, /✗ could not connect/);
    assert.match(r.out, /check MONGODB_URI/);
  });

  it('refuses a piece size that is not a whole number of 16 or more, and an unknown option', () => {
    const settings = { MONGODB_URI: 'mongodb://127.0.0.1:1/' };
    for (const bad of ['abc', '8', '1.5']) {
      const r = command(['--piece-kb', bad], settings);
      assert.equal(r.code, 1, bad);
      assert.match(r.err, /--piece-kb must be a whole number/, bad);
    }
    const unknown = command(['--fast'], settings);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /I do not know “--fast”/);
  });

  it('refuses a bad DB_FILE_PIECE_KB the same way the server does', () => {
    const r = command([], { MONGODB_URI: 'mongodb://127.0.0.1:1/', DB_FILE_PIECE_KB: '9000' });
    assert.equal(r.code, 1);
    assert.match(r.err, /DB_FILE_PIECE_KB must be a whole number from 16 to 512/);
  });

  it('refuses a half-filled database choice with the same message as the server', () => {
    const r = command([], { DB_DRIVER: 'cloudflare' });
    assert.equal(r.code, 1);
    assert.match(r.err, /CLOUDFLARE_/);
  });
});
