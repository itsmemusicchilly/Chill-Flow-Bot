// `npm run backup`: a consistent copy of the database (while the bot is running), the pictures and the transcripts, and only the newest N kept.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Database } from '../server/db.js';
import { runBackup, stampOf } from '../scripts/backup.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

describe('backing up the data folder', () => {
  let dir; let db;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-backup-'));
    db = new Database(path.join(dir, 'flowbot.sqlite')); // open the whole time, like the running bot
    db.createFlow({ guildId: '111', name: 'Welcome', graph: { nodes: [], edges: [] } });
    db.setVar('111', 'guild', '', 'counter', 41);
    fs.mkdirSync(path.join(dir, 'uploads', '111'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'uploads', '111', 'pic.webp'), 'picture');
    fs.mkdirSync(path.join(dir, 'transcripts'));
    fs.writeFileSync(path.join(dir, 'transcripts', 't1.html'), '<p>hi</p>');
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const at = (n) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));
  const read = (folder, sql) => { const raw = new DatabaseSync(path.join(folder, 'flowbot.sqlite'), { readOnly: true }); try { return raw.prepare(sql).all(); } finally { raw.close(); } };

  it('copies the database, the pictures and the transcripts into a new dated folder', () => {
    const r = runBackup({ dataDir: dir, now: at(5) });
    assert.equal(r.folder, path.join(dir, 'backups', '20261005-120000'));
    assert.deepEqual(r.copied, ['flowbot.sqlite', 'uploads/', 'transcripts/']);
    assert.deepEqual(read(r.folder, 'SELECT name FROM flows').map((x) => x.name), ['Welcome']);
    assert.equal(fs.readFileSync(path.join(r.folder, 'uploads', '111', 'pic.webp'), 'utf8'), 'picture');
    assert.equal(fs.readFileSync(path.join(r.folder, 'transcripts', 't1.html'), 'utf8'), '<p>hi</p>');
  });

  it('includes what the running bot wrote a moment ago (it is not stopped, and nothing is left out of the copy)', () => {
    db.createFlow({ guildId: '111', name: 'Written just now', graph: { nodes: [], edges: [] } });
    const r = runBackup({ dataDir: dir, now: at(5) });
    assert.deepEqual(read(r.folder, 'SELECT name FROM flows ORDER BY name').map((x) => x.name), ['Welcome', 'Written just now']);
    db.createFlow({ guildId: '111', name: 'Afterwards', graph: { nodes: [], edges: [] } }); // the bot goes on working
    assert.equal(db.listFlows('111').length, 3);
  });

  it('works when there are no pictures or transcripts yet', () => {
    fs.rmSync(path.join(dir, 'uploads'), { recursive: true });
    fs.rmSync(path.join(dir, 'transcripts'), { recursive: true });
    assert.deepEqual(runBackup({ dataDir: dir, now: at(5) }).copied, ['flowbot.sqlite']);
  });

  it('keeps the newest N and removes the rest — and never touches a folder that is not a backup', () => {
    fs.mkdirSync(path.join(dir, 'backups', 'my-notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backups', 'readme.txt'), 'mine');
    const removed = [];
    for (const day of [1, 2, 3, 4]) removed.push(...runBackup({ dataDir: dir, keep: 2, now: at(day) }).removed);
    assert.deepEqual(removed, ['20261001-120000', '20261002-120000']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).sort(), ['20261003-120000', '20261004-120000', 'my-notes', 'readme.txt']);
  });

  it('can be told where to put them', () => {
    const out = path.join(dir, 'elsewhere');
    const r = runBackup({ dataDir: dir, outDir: out, now: at(5) });
    assert.equal(r.folder, path.join(out, '20261005-120000'));
    assert.ok(fs.existsSync(path.join(r.folder, 'flowbot.sqlite')));
  });

  it('refuses plainly: no database, a silly --keep, or two backups in the same second — and leaves no half backup behind', () => {
    assert.throws(() => runBackup({ dataDir: path.join(dir, 'nothing-here') }), /There is no database at .*flowbot\.sqlite/);
    for (const keep of [0, -1, 1.5, NaN]) assert.throws(() => runBackup({ dataDir: dir, keep }), /--keep must be a whole number/, String(keep));
    runBackup({ dataDir: dir, now: at(5) });
    assert.throws(() => runBackup({ dataDir: dir, now: at(5) }), /already exists/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), ['20261005-120000']);
  });

  it('a failure half way (the database cannot be read) removes the folder it had started', () => {
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-backup-bad-'));
    try {
      fs.writeFileSync(path.join(bad, 'flowbot.sqlite'), 'this is not a database');
      assert.throws(() => runBackup({ dataDir: bad, now: at(5) }));
      assert.deepEqual(fs.readdirSync(path.join(bad, 'backups')), [], 'no folder that looks like a whole backup');
    } finally { fs.rmSync(bad, { recursive: true, force: true }); }
  });

  it('stamps are in UTC and sort in time order', () => {
    assert.equal(stampOf(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '20260102-030405');
  });
});

describe('npm run backup (the command)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-backup-cli-')); new Database(path.join(dir, 'flowbot.sqlite')).close(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args = [], env = {}) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(ROOT, 'scripts', 'backup.js'), ...args], { cwd: dir, env: { ...process.env, DATA_DIR: dir, ...env }, encoding: 'utf8' });

  it('makes a backup, says where, and exits 0', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Backup saved: .*backups.*\n\s+contains: flowbot\.sqlite/);
    assert.match(r.stdout, /same TOKEN_ENCRYPTION_KEY/);
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  });

  it('understands --keep and --out', () => {
    const out = path.join(dir, 'safe');
    assert.equal(run(['--out', out, '--keep', '3']).status, 0);
    assert.equal(fs.readdirSync(out).length, 1);
  });

  it('explains a mistake and exits 1', () => {
    const wrong = run(['--keeep', '3']);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /Backup failed: I do not know “--keeep”/);
    const empty = run([], { DATA_DIR: path.join(dir, 'nowhere') });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /There is no database/);
  });

  it('prints help', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Backs up the database/);
    assert.equal(fs.existsSync(path.join(dir, 'backups')), false, 'help changes nothing');
  });
});
