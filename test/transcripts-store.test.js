// Saved transcripts: the store (file + row, retention, clean-up), the public page /t/<id>, and the TRANSCRIPT_RETENTION_DAYS setting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../server/config.js';
import { Database } from '../server/db.js';
import { FlowError } from '../server/engine/errors.js';
import { Logger } from '../server/logger.js';
import { createTranscripts } from '../server/transcripts.js';
import { A, B, startHarness } from './helpers/harness.js';

const DAY = 86_400_000;
const PUBLIC = 'https://bot.example.com';
const doc = (over = {}) => ({ buffer: Buffer.from('<!doctype html><title>Ticket</title><p>hello</p>'), name: 'transcript-ticket.html', messages: 3, bytes: 48, truncated: false, ...over });

/** A store of its own, on its own folder, with a clock the test moves. */
function standalone(config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-transcripts-'));
  const db = new Database(':memory:');
  const logger = new Logger({ console: false });
  const clock = { t: Date.UTC(2026, 0, 1) };
  const store = createTranscripts({ config: { baseUrl: PUBLIC, dataDir, ...config }, db, logger, now: () => clock.t });
  return { store, db, logger, clock, dataDir, logs: (g = A) => logger.recent(g).map((l) => `${l.level}: ${l.message}`), done: () => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

describe('saving a transcript', () => {
  let s;
  afterEach(() => s?.done());

  it('keeps the page as a file and a row, and gives back the public link', () => {
    s = standalone({ transcriptRetentionDays: 30 });
    const saved = s.store.save(A, doc());
    assert.match(saved.id, /^[a-z0-9]{32}$/);
    assert.equal(saved.url, `${PUBLIC}/t/${saved.id}`);
    assert.equal(saved.expiresAt, new Date(s.clock.t + 30 * DAY).toISOString());
    assert.deepEqual(fs.readFileSync(s.store.fileFor(A, saved.id)), doc().buffer);
    assert.deepEqual(s.db.getTranscript(saved.id), { id: saved.id, guildId: A, name: 'transcript-ticket.html', messages: 3, bytes: 48, truncated: false, createdAt: s.clock.t });
  });

  it('has no end date when nothing is deleted (the default)', () => {
    s = standalone();
    assert.equal(s.store.save(A, doc()).expiresAt, '');
  });

  it('two transcripts never share an id', () => {
    s = standalone();
    const ids = new Set(Array.from({ length: 50 }, () => s.store.save(A, doc()).id));
    assert.equal(ids.size, 50);
  });

  it('refuses a link nobody outside this machine could open, and leaves nothing behind', () => {
    for (const baseUrl of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.1.5']) {
      s = standalone({ baseUrl });
      assert.throws(() => s.store.save(A, doc()), (e) => e instanceof FlowError && /BASE_URL/.test(e.message), baseUrl);
      assert.equal(s.db.transcriptsBefore(Infinity).length, 0);
      s.done();
    }
    s = null;
  });

  it('leaves no row and no stray file when the page cannot be stored', () => {
    s = standalone();
    assert.throws(() => s.store.save('not-a-server-id', doc()));
    assert.equal(s.db.transcriptsBefore(Infinity).length, 0, 'no row without its file');
    assert.deepEqual(fs.readdirSync(path.join(s.store.root, '.tmp')), [], 'the temporary file is gone');
  });

  it('remove() deletes the file and the row, and says no to anything else', () => {
    s = standalone();
    const saved = s.store.save(A, doc());
    assert.equal(s.store.remove(saved.id), true);
    assert.equal(s.db.getTranscript(saved.id), null);
    assert.equal(fs.existsSync(s.store.fileFor(A, saved.id)), false);
    assert.equal(s.store.remove(saved.id), false, 'already gone');
    assert.equal(s.store.remove('../../etc/passwd'), false);
    assert.equal(s.store.remove(undefined), false);
  });
});

describe('keeping transcripts for a number of days', () => {
  let s;
  afterEach(() => s?.done());

  it('prune() deletes what is older than the setting — file and row — and keeps the rest', () => {
    s = standalone({ transcriptRetentionDays: 30 });
    const old = s.store.save(A, doc());
    s.clock.t += 20 * DAY;
    const young = s.store.save(B, doc());
    s.clock.t += 11 * DAY; // old is now 31 days, young is 11
    assert.equal(s.store.prune(), 1);
    assert.equal(s.db.getTranscript(old.id), null);
    assert.equal(fs.existsSync(s.store.fileFor(A, old.id)), false);
    assert.ok(s.db.getTranscript(young.id));
    assert.equal(fs.existsSync(s.store.fileFor(B, young.id)), true);
    assert.ok(s.logs(A).some((l) => /Deleted 1 saved transcript older than 30 days/.test(l)), s.logs(A).join('\n'));
    assert.equal(s.logs(B).length, 0, 'the other server is not told about it');
    assert.equal(s.store.prune(), 0, 'and a second sweep finds nothing');
  });

  it('is exact: still there on the last day, gone the moment it is older', () => {
    s = standalone({ transcriptRetentionDays: 1 });
    const t = s.store.save(A, doc());
    s.clock.t += DAY;
    assert.equal(s.store.prune(), 0, 'exactly one day old is still kept');
    s.clock.t += 1;
    assert.equal(s.store.prune(), 1);
    assert.equal(s.db.getTranscript(t.id), null);
  });

  it('0 keeps everything, however old', () => {
    s = standalone({ transcriptRetentionDays: 0 });
    const t = s.store.save(A, doc());
    s.clock.t += 5000 * DAY;
    assert.equal(s.store.prune(), 0);
    assert.ok(s.db.getTranscript(t.id));
    assert.equal(fs.existsSync(s.store.fileFor(A, t.id)), true);
  });

  it('a changed setting applies to transcripts that are already stored', () => {
    s = standalone({ transcriptRetentionDays: 0 });
    const t = s.store.save(A, doc());
    s.clock.t += 40 * DAY;
    assert.equal(s.store.prune(), 0);
    const stricter = createTranscripts({ config: { baseUrl: PUBLIC, dataDir: path.dirname(s.store.root), transcriptRetentionDays: 30 }, db: s.db, logger: s.logger, now: () => s.clock.t });
    assert.equal(stricter.prune(), 1);
    assert.equal(s.db.getTranscript(t.id), null);
  });

  it('a page that cannot be deleted keeps its row, so the next sweep tries again', () => {
    s = standalone({ transcriptRetentionDays: 1 });
    const t = s.store.save(A, doc());
    const file = s.store.fileFor(A, t.id);
    fs.rmSync(file);
    fs.mkdirSync(file); // a folder where the file was: removing it without "recursive" fails
    fs.writeFileSync(path.join(file, 'x'), 'x');
    s.clock.t += 2 * DAY;
    assert.equal(s.store.prune(), 0);
    assert.ok(s.db.getTranscript(t.id), 'the row stays');
    assert.ok(s.logs(A).some((l) => /^warn: Could not delete the saved transcript/.test(l)), s.logs(A).join('\n'));
    fs.rmSync(file, { recursive: true });
    assert.equal(s.store.prune(), 1, 'and once it can be deleted, it goes');
  });

  it('a page whose file was already deleted by hand is still cleared away', () => {
    s = standalone({ transcriptRetentionDays: 1 });
    const t = s.store.save(A, doc());
    fs.rmSync(s.store.fileFor(A, t.id));
    s.clock.t += 2 * DAY;
    assert.equal(s.store.prune(), 1);
    assert.equal(s.db.getTranscript(t.id), null);
  });
});

describe('TRANSCRIPT_RETENTION_DAYS', () => {
  const base = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's' };

  it('keeps transcripts forever unless told otherwise', () => {
    assert.equal(loadConfig(base).transcriptRetentionDays, 0);
    assert.equal(loadConfig({ ...base, TRANSCRIPT_RETENTION_DAYS: '' }).transcriptRetentionDays, 0);
    assert.equal(loadConfig({ ...base, TRANSCRIPT_RETENTION_DAYS: '  ' }).transcriptRetentionDays, 0);
  });

  it('takes a whole number of days', () => {
    assert.equal(loadConfig({ ...base, TRANSCRIPT_RETENTION_DAYS: '30' }).transcriptRetentionDays, 30);
    assert.equal(loadConfig({ ...base, TRANSCRIPT_RETENTION_DAYS: '0' }).transcriptRetentionDays, 0);
    assert.equal(loadConfig({ ...base, TRANSCRIPT_RETENTION_DAYS: '3650' }).transcriptRetentionDays, 3650);
  });

  it('refuses anything else, naming the setting', () => {
    for (const bad of ['-1', '1.5', 'abc', '3651', 'forever', '1e2x']) {
      assert.throws(() => loadConfig({ ...base, TRANSCRIPT_RETENTION_DAYS: bad }), (e) => e instanceof ConfigError && /TRANSCRIPT_RETENTION_DAYS/.test(e.message), bad);
    }
  });
});

describe('the page /t/<id>', () => {
  let h; let dist;
  const rawGet = (target, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const { port } = new URL(h.base);
    http.request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
    }).on('error', reject).end();
  });
  /** A transcript that is `ageDays` old, as the store would have left it. */
  const saveAged = (ageDays, guildId = A) => {
    const row = h.db.addTranscript({ guildId, name: 'old.html', messages: 1, bytes: 10, truncated: false, now: Date.now() - ageDays * DAY });
    const file = h.transcripts.fileFor(guildId, row.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, doc().buffer);
    return row;
  };

  before(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>the dashboard</title>');
    h = await startHarness({ config: { baseUrl: PUBLIC, transcriptRetentionDays: 30, transcriptRate: { views: 100000 } }, distDir: dist });
  });
  after(() => { h.close(); fs.rmSync(dist, { recursive: true, force: true }); });

  it('shows the stored page to anyone with the link — no login — with headers that keep it inert', async () => {
    const saved = h.transcripts.save(A, doc());
    const r = await rawGet(`/t/${saved.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, doc().buffer);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox");
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(r.headers['cache-control'], 'private, no-store');
    assert.equal(r.headers['set-cookie'], undefined);
    const withCookie = await rawGet(`/t/${saved.id}`, { Cookie: `fc_session=${h.session()}` });
    assert.equal(withCookie.status, 200, 'a cookie changes nothing');
    assert.equal(withCookie.headers['set-cookie'], undefined);
    assert.deepEqual((await rawGet(`/t/${saved.id}/`)).body, doc().buffer, 'a slash added by a chat app after the link still opens it');
  });

  it('every wrong address is the same friendly page: unknown, wrong shape, path tricks', async () => {
    const saved = h.transcripts.save(A, doc());
    const wrong = [
      `/t/${'a'.repeat(32)}`, `/t/${saved.id.slice(1)}`, `/t/${saved.id}0`, `/t/${saved.id.toUpperCase()}`, `/t/${saved.id}.html`,
      `/t/${saved.id}/extra`, `/t/..%2f${saved.id}`, `/t/..%2f..%2fflowbot.sqlite`, `/t/%2e%2e%2f${saved.id}`, `/t/${saved.id}%00`, `/t/${A}/${saved.id}`, '/t/', '/t',
    ];
    const first = await rawGet(wrong[0]);
    assert.equal(first.status, 404);
    for (const p of wrong) {
      const r = await rawGet(p);
      assert.equal(r.status, 404, p);
      assert.equal(r.text, first.text, `${p} must look like every other miss`);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', p);
      assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow', p);
      assert.match(r.headers['content-security-policy'], /default-src 'none'/, p);
    }
    assert.match(first.text, /This transcript isn't available/);
    assert.ok(!first.text.includes('the dashboard'), 'never the dashboard');
    assert.ok(!first.text.includes(saved.id));
  });

  it('is not turned into the dashboard by its fallback page, for any method', async () => {
    const saved = h.transcripts.save(A, doc());
    for (const method of ['GET', 'POST', 'DELETE']) {
      const r = await rawGet(`/t/${'b'.repeat(32)}`, {}, method);
      assert.equal(r.status, 404, method);
      assert.ok(!r.text.includes('the dashboard'), method);
    }
    assert.equal((await rawGet(`/t/${saved.id}`, {}, 'POST')).status, 404, 'there is nothing to post to');
    assert.equal((await rawGet('/')).text.includes('the dashboard'), true, 'while the dashboard itself still works');
  });

  it('refuses a transcript past its time even before the hourly clean-up has run, and looks like any miss', async () => {
    const stale = saveAged(31);
    const fresh = saveAged(29);
    const gone = await rawGet(`/t/${stale.id}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.text, (await rawGet(`/t/${'c'.repeat(32)}`)).text);
    assert.equal((await rawGet(`/t/${fresh.id}`)).status, 200);
    assert.ok(h.db.getTranscript(stale.id), 'still stored: the page was refused, not swept');
    assert.equal(h.transcripts.prune(), 1);
    assert.equal(h.db.getTranscript(stale.id), null);
    assert.equal((await rawGet(`/t/${stale.id}`)).status, 404, 'and the same after it is swept');
    assert.equal((await rawGet(`/t/${fresh.id}`)).status, 200);
  });

  it('says the same 404 when the file went missing, and tells the server log', async () => {
    const row = saveAged(1);
    fs.rmSync(h.transcripts.fileFor(A, row.id));
    const r = await rawGet(`/t/${row.id}`);
    assert.equal(r.status, 404);
    assert.match(r.text, /This transcript isn't available/);
    assert.ok(h.logger.recent(A).some((l) => l.level === 'warn' && /missing on disk/.test(l.message)));
  });

  it('answers only the id it is given: another server\'s transcript is not reachable by guessing', async () => {
    const mine = h.transcripts.save(A, doc({ buffer: Buffer.from('<p>server A</p>') }));
    const theirs = h.transcripts.save(B, doc({ buffer: Buffer.from('<p>server B</p>') }));
    assert.equal((await rawGet(`/t/${mine.id}`)).text, '<p>server A</p>');
    assert.equal((await rawGet(`/t/${theirs.id}`)).text, '<p>server B</p>');
    assert.notEqual(mine.id, theirs.id);
  });
});

describe('the page /t/<id>: rate limit', () => {
  it('slows down someone who keeps asking', async () => {
    const h = await startHarness({ config: { baseUrl: PUBLIC, transcriptRate: { views: 3 } } });
    try {
      const get = () => fetch(`${h.base}/t/${'d'.repeat(32)}`);
      assert.deepEqual([(await get()).status, (await get()).status, (await get()).status], [404, 404, 404]);
      const limited = await get();
      assert.equal(limited.status, 429);
      assert.match(await limited.text(), /Too many requests/);
    } finally { await h.close(); }
  });
});
