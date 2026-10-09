// Connected accounts used to be one per platform per server. A database made by that version is upgraded in place, without losing anyone's connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Database } from '../server/db.js';

const OLD_TABLE = `CREATE TABLE linked_accounts (
  guild_id TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL, account_login TEXT NOT NULL DEFAULT '',
  access_enc TEXT NOT NULL, refresh_enc TEXT NOT NULL, expires_at INTEGER NOT NULL, scopes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok', connected_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, provider)
)`;

describe('upgrading the connected accounts table', () => {
  let dir; let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-migrate-'));
    file = path.join(dir, 'flowbot.sqlite');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function oldDatabase() {
    const raw = new DatabaseSync(file);
    raw.exec(OLD_TABLE);
    const add = raw.prepare('INSERT INTO linked_accounts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    add.run('111', 'twitch', '555', 'Streamer', 'streamer', 'v1.a.b.c', 'v1.d.e.f', 1000, 'moderator:read:followers', 'ok', 'u1', 10, 20);
    add.run('111', 'tiktok', 'tt-1', 'Dancer', '', 'v1.g.h.i', 'v1.j.k.l', 2000, 'user.info.basic user.info.stats', 'expired', 'u2', 11, 21);
    add.run('222', 'twitch', '777', 'Other', 'other', 'v1.m.n.o', 'v1.p.q.r', 3000, '', 'ok', null, 12, 22);
    raw.close();
  }

  it('keeps every connection, exactly as it was', () => {
    oldDatabase();
    const db = new Database(file);
    try {
      assert.deepEqual(db.listAccounts('111').map((r) => [r.provider, r.accountId, r.accountName, r.accountLogin, r.status, r.connectedBy, r.createdAt, r.updatedAt]), [
        ['tiktok', 'tt-1', 'Dancer', '', 'expired', 'u2', 11, 21],
        ['twitch', '555', 'Streamer', 'streamer', 'ok', 'u1', 10, 20],
      ]);
      const row = db.getAccount('111', 'twitch', '555');
      assert.deepEqual([row.accessSealed, row.refreshSealed, row.expiresAt, row.scopes], ['v1.a.b.c', 'v1.d.e.f', 1000, 'moderator:read:followers']);
      assert.equal(db.getAccount('222', 'twitch').connectedBy, null);
    } finally { db.close(); }
  });

  it('then lets a server connect a second account of the same platform', () => {
    oldDatabase();
    const db = new Database(file);
    try {
      const row = db.getAccount('111', 'twitch', '555');
      db.saveAccount({ ...row, accountId: '999', accountName: 'Second', accountLogin: 'second' });
      assert.deepEqual(db.listAccounts('111').filter((r) => r.provider === 'twitch').map((r) => r.accountId), ['555', '999']);
    } finally { db.close(); }
  });

  it('only once: opening it again changes nothing, and a new database is made the new way from the start', () => {
    oldDatabase();
    new Database(file).close();
    const db = new Database(file);
    try { assert.equal(db.listAccounts('111').length, 2); } finally { db.close(); }
    const fresh = new Database(path.join(dir, 'fresh.sqlite'));
    try {
      const pk = fresh.db.prepare('PRAGMA table_info(linked_accounts)').all().filter((c) => c.pk).map((c) => c.name);
      assert.deepEqual(pk, ['guild_id', 'provider', 'account_id']);
    } finally { fresh.close(); }
  });

  it('picks the first account that works when none is named, and falls back to the oldest', () => {
    const db = new Database(':memory:');
    const base = { guildId: '1', provider: 'twitch', accessSealed: 'a', refreshSealed: 'b', expiresAt: 1, scopes: '', connectedBy: 'u' };
    db.saveAccount({ ...base, accountId: 'old-broken', accountName: 'A', status: 'expired' }, 100);
    db.saveAccount({ ...base, accountId: 'newer-ok', accountName: 'B', status: 'ok' }, 200);
    db.saveAccount({ ...base, accountId: 'newest-ok', accountName: 'C', status: 'ok' }, 300);
    assert.equal(db.getAccount('1', 'twitch').accountId, 'newer-ok', 'the oldest one that works');
    db.setAccountStatus('1', 'twitch', 'newer-ok', 'expired');
    db.setAccountStatus('1', 'twitch', 'newest-ok', 'expired');
    assert.equal(db.getAccount('1', 'twitch').accountId, 'old-broken', 'none works: the oldest, so the problem is reported for it');
    assert.equal(db.getAccount('1', 'twitch', 'newest-ok').accountName, 'C');
    assert.equal(db.getAccount('1', 'tiktok'), null);
    db.close();
  });
});
