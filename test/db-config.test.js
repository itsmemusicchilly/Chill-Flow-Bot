import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../server/config.js';

const base = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's' };
const pem = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n';

describe('the database setting', () => {
  it('uses the local database when no cloud database is configured', () => {
    const db = loadConfig(base).database;
    assert.equal(db.driver, 'sqlite');
    assert.equal(db.label, 'local sqlite');
    assert.equal(db.uri, undefined);
  });

  it('accepts the local aliases and ignores a cloud setting when sqlite is named', () => {
    assert.equal(loadConfig({ ...base, DB_DRIVER: 'localdb' }).database.driver, 'sqlite');
    assert.equal(loadConfig({ ...base, DB_DRIVER: 'sqlite', MONGODB_URI: 'mongodb://localhost/x' }).database.driver, 'sqlite');
  });

  it('uses MongoDB when only its address is set', () => {
    const db = loadConfig({ ...base, MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/ignored' }).database;
    assert.equal(db.driver, 'mongodb');
    assert.equal(db.dbName, 'chillflow');
    assert.equal(loadConfig({ ...base, DB_DRIVER: 'mongo', MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB: 'bot' }).database.dbName, 'bot');
  });

  it('uses Firebase from a service-account JSON or from the three fields', () => {
    const json = JSON.stringify({ project_id: 'proj', client_email: 'a@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n' });
    const fromJson = loadConfig({ ...base, FIREBASE_SERVICE_ACCOUNT: json }).database;
    assert.equal(fromJson.driver, 'firebase');
    assert.equal(fromJson.projectId, 'proj');
    assert.equal(fromJson.databaseId, '(default)');
    assert.ok(fromJson.privateKey.includes('\n'));
    const fromFields = loadConfig({
      ...base, DB_DRIVER: 'firestore', FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'a@p.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: pem, FIREBASE_DATABASE_ID: 'named',
    }).database;
    assert.equal(fromFields.driver, 'firebase');
    assert.equal(fromFields.databaseId, 'named');
  });

  it('uses Cloudflare D1 when the three values are set', () => {
    const db = loadConfig({ ...base, CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_D1_DATABASE_ID: 'db' }).database;
    assert.equal(db.driver, 'cloudflare');
    assert.equal(db.label, 'Cloudflare D1');
    assert.equal(loadConfig({ ...base, DB_DRIVER: 'd1', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_D1_DATABASE_ID: 'db' }).database.driver, 'cloudflare');
  });

  it('refuses a half-set cloud database, two databases, or an unknown driver', () => {
    assert.throws(() => loadConfig({ ...base, CLOUDFLARE_ACCOUNT_ID: 'acct' }), (e) => e instanceof ConfigError && /all three unset/.test(e.message));
    assert.throws(() => loadConfig({ ...base, FIREBASE_PROJECT_ID: 'p' }), (e) => e instanceof ConfigError && /all three/.test(e.message));
    assert.throws(() => loadConfig({ ...base, MONGODB_URI: 'http://nope' }), /mongodb:\/\//);
    assert.throws(() => loadConfig({ ...base, MONGODB_URI: 'mongodb://localhost/x', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_D1_DATABASE_ID: 'd' }), /More than one database/);
    assert.throws(() => loadConfig({ ...base, DB_DRIVER: 'postgres' }), /DB_DRIVER must be/);
    assert.throws(() => loadConfig({ ...base, DB_DRIVER: 'mongodb' }), /MONGODB_URI/);
  });
});
