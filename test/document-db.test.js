import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocumentDatabase } from '../server/db/document.js';
import { SlugTakenError } from '../server/db/errors.js';
import { D1Store } from '../server/db/d1-store.js';
import { FirestoreStore } from '../server/db/firestore-store.js';
import { MemoryStore } from '../server/db/memory-store.js';
import { FlowError } from '../server/engine/errors.js';
import { applyLimits, resetLimits } from '../shared/limits.js';

async function exercise(db) {
  const flow = await db.createFlow({ guildId: 'g1', name: 'Tickets', graph: { nodes: [{ id: 'n1', type: 'trigger.webhook' }], edges: [] } });
  assert.equal(flow.enabled, true);
  assert.equal((await db.getFlow('g2', flow.id)), null);
  assert.deepEqual(await db.guildIdsWithFlows(), ['g1']);
  const off = await db.updateFlow('g1', flow.id, { enabled: false });
  assert.equal(off.enabled, false);
  assert.deepEqual(await db.guildIdsWithFlows(), []);

  await db.setVar('g1', 'guild', '', 'score', { n: 3 });
  assert.deepEqual(await db.getVar('g1', 'guild', '', 'score'), { n: 3 });
  assert.equal(await db.getVar('g1', 'guild', '', 'missing'), undefined);
  await assert.rejects(() => db.setVar('g1', 'nope', '', 'a', 1), (err) => err instanceof FlowError);
  assert.equal(await db.deleteVarsForScope('g1', 'guild', ''), 1);

  const page = await db.createPage({ guildId: 'g1', slug: 'help', title: 'Help', theme: { color: '#000' }, blocks: [{ text: 'upload:abcdefghijklmnop' }] });
  await assert.rejects(
    () => db.createPage({ guildId: 'g1', slug: 'help', title: 'Other', theme: {}, blocks: [] }),
    (err) => err instanceof SlugTakenError,
  );
  assert.equal(await db.uniqueSlug('g1', 'help'), 'help-2');
  const responseId = await db.addResponse({ guildId: 'g1', pageId: page.id, blockId: 'form', userId: 'u', userName: 'Ada', answers: { q: 'yes' } });
  assert.equal(await db.lastResponseAt('g1', page.id, 'form', 'u') > 0, true);
  assert.equal((await db.listResponses('g1', page.id, 'form'))[0].id, responseId);
  assert.equal(await db.deletePage('g1', page.id), true);
  assert.equal(await db.countResponses('g1', page.id, 'form'), 0);
  assert.equal(await db.getPageBySlug('g1', 'help'), null);

  const session = await db.createSession('user', { ok: true }, 60_000);
  assert.equal((await db.getSession(session)).data.ok, true);
  assert.equal(await db.getSession('nope'), null);
  await db.deleteSession(session);
  assert.equal(await db.getSession(session), null);

  const hook = await db.ensureWebhook('g1', flow.id, 'n1');
  assert.deepEqual(await db.webhookByToken(hook.token), { guildId: 'g1', flowId: flow.id, nodeId: 'n1' });
  const renewed = await db.ensureWebhook('g1', flow.id, 'n1', { renew: true });
  assert.notEqual(renewed.token, hook.token);
  assert.equal(await db.webhookByToken(hook.token), null);
  await db.pruneWebhooks('g1', flow.id, new Set());
  assert.equal(await db.webhookByToken(renewed.token), null);

  await db.setWatch('g1', flow.id, 'n1', { seen: [1] });
  assert.deepEqual(await db.getWatch('g1', flow.id, 'n1'), { seen: [1] });
  await db.pruneWatch('g1', new Set());
  assert.equal(await db.getWatch('g1', flow.id, 'n1'), null);

  await db.saveAccount({ guildId: 'g1', provider: 'twitch', accountId: '9', accountName: 'Ada', accessSealed: 'a', refreshSealed: 'r', expiresAt: 5, connectedBy: 'owner' });
  await db.saveAccount({ guildId: 'g1', provider: 'twitch', accountId: '9', accountName: 'Ada', accessSealed: 'b', refreshSealed: 'r', expiresAt: 6 });
  assert.equal((await db.getAccount('g1', 'twitch')).connectedBy, 'owner');
  assert.equal((await db.listAccounts('g1'))[0].accountName, 'Ada');
  assert.equal((await db.getAccount('g1', 'twitch')).accessSealed, 'b');

  await db.saveComponentState({ guildId: 'g1', messageId: 'm1', vars: '{"a":1}', data: '{}', expiresAt: 50, now: 10 });
  assert.equal(await db.getComponentState('g1', 'm1', 100), undefined);
  assert.equal(await db.pruneComponentState(100), 1);
  assert.equal(await db.countComponentState('g1'), 0);

  const upload = await db.addUpload({ guildId: 'g1', name: 'pic', bytes: 4, width: 1, height: 1, animated: false, sha256: 'abc', createdBy: null });
  await assert.rejects(
    () => db.addUpload({ guildId: 'g1', name: 'again', bytes: 4, width: 1, height: 1, animated: false, sha256: 'abc' }),
    /UNIQUE/,
  );
  const uses = await db.uploadUses('g1');
  assert.equal(uses instanceof Map, true);
  assert.equal((await db.uploadIds('g1')).has(upload.id), true);
  const transcript = await db.addTranscript({ guildId: 'g1', name: 'ticket', messages: 2, bytes: 10, truncated: false, now: 20 });
  assert.equal((await db.transcriptsBefore(21)).some((row) => row.id === transcript.id), true);
  assert.equal(await db.deleteTranscript(transcript.id), true);
  await db.setSyncHash('g1', 'hash');
  assert.equal(await db.getSyncHash('g1'), 'hash');
  assert.equal(await db.deleteFlow('g1', flow.id), true);
}

describe('a cloud-shaped database', () => {
  it('keeps each server’s data on the in-memory store', async () => { await exercise(new DocumentDatabase(new MemoryStore())); });

  it('keeps each server’s data on Cloudflare D1’s document table', async () => {
    await exercise(new DocumentDatabase(new D1Store({ accountId: 'acct', apiToken: 'tok', databaseId: 'db', fetch: fakeD1() })));
  });

  it('keeps each server’s data in Firestore', async () => {
    await exercise(new DocumentDatabase(new FirestoreStore({
      projectId: 'proj', clientEmail: 'a@proj.iam.gserviceaccount.com', privateKey: 'unused', token: 'test-token', fetch: fakeFirestore(),
    })));
  });

  it('enforces the variable cap', async () => {
    applyLimits({ varsPerGuild: 1 });
    try {
      const db = new DocumentDatabase(new MemoryStore());
      await db.setVar('g', 'guild', '', 'a', 1);
      await assert.rejects(() => db.setVar('g', 'channel', '1', 'b', 2), /limit of 1/);
      await db.setVar('g', 'guild', '', 'a', 3);
      assert.equal(await db.getVar('g', 'guild', '', 'a'), 3);
    } finally { resetLimits(); }
  });
});

function ok(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Speaks just enough of the D1 HTTP API for the statements this project sends. */
function fakeD1() {
  const rows = new Map();
  return async (_url, opts) => {
    const { sql, params } = JSON.parse(opts.body);
    const compact = sql.replace(/\s+/g, ' ').trim();
    const key = `${params?.[0]}\0${params?.[1]}`;
    if (compact.startsWith('CREATE')) return ok({ success: true, result: [{ results: [] }] });
    if (compact.startsWith('INSERT')) {
      rows.set(key, { collection: params[0], guild_id: params[2], doc: params[3] });
      return ok({ success: true, result: [{ results: [], meta: { changes: 1 } }] });
    }
    if (compact.startsWith('DELETE')) {
      rows.delete(key);
      return ok({ success: true, result: [{ results: [], meta: { changes: 1 } }] });
    }
    if (compact.startsWith('SELECT 1')) {
      return ok({ success: true, result: [{ results: rows.has(key) ? [{ n: 1 }] : [] }] });
    }
    if (compact.startsWith('SELECT doc FROM docs WHERE collection = ? AND id = ?')) {
      const row = rows.get(key);
      return ok({ success: true, result: [{ results: row ? [{ doc: row.doc }] : [] }] });
    }
    const wanted = [...rows.values()].filter((row) => row.collection === params[0] && (params.length < 2 || row.guild_id === params[1]));
    if (!compact.startsWith('SELECT doc')) throw new Error(`unexpected SQL: ${compact}`);
    return ok({ success: true, result: [{ results: wanted.map((row) => ({ doc: row.doc })) }] });
  };
}

/** Speaks just enough of the Firestore REST API to store and list JSON documents. */
function fakeFirestore() {
  const docs = new Map();
  const pathOf = (url) => {
    const text = String(url);
    const base = text.split('/documents/')[1] || '';
    return base.split('?')[0];
  };
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const text = String(url);
    if (text.endsWith(':runQuery')) {
      const { structuredQuery } = JSON.parse(opts.body);
      const collection = structuredQuery.from[0].collectionId;
      const documents = [...docs.entries()]
        .filter(([path]) => path.split('/').includes(collection))
        .map(([path, json]) => ({ name: path, fields: { json: { stringValue: json } } }));
      return ok(documents.map((document) => ({ document })));
    }
    const path = decodeURIComponent(pathOf(url));
    if (method === 'PATCH') {
      docs.set(path, JSON.parse(opts.body).fields.json.stringValue);
      return ok({});
    }
    if (method === 'DELETE') {
      if (!docs.has(path)) return ok({}, 404);
      docs.delete(path);
      return ok({});
    }
    if (text.includes('pageSize=')) {
      const documents = [...docs.entries()]
        .filter(([key]) => key.startsWith(`${path}/`))
        .map(([key, json]) => ({ name: key, fields: { json: { stringValue: json } } }));
      return ok({ documents });
    }
    if (!docs.has(path)) return ok({}, 404);
    return ok({ name: path, fields: { json: { stringValue: docs.get(path) } } });
  };
}
