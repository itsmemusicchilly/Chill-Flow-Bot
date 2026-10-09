// The same operations as server/db.js, stored as documents instead of SQL rows.
// MongoDB, Firestore and Cloudflare D1 each supply a store with get/put/delete/find.
// One bot process talks to the store (a second copy would also fight over the Discord token).
import crypto from 'node:crypto';
import { isCapped, LIMITS } from '../../shared/limits.js';
import { uid } from '../../shared/util.js';
import { FlowError } from '../engine/errors.js';
import { SlugTakenError } from './errors.js';
import { docKey } from './query.js';

const VAR_NAME = /^[A-Za-z_][\w-]{0,31}$/;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const asc = (field) => ({ field, dir: 'asc' });
const desc = (field) => ({ field, dir: 'desc' });

function duplicate(err) {
  return err?.code === 11000 || /UNIQUE/i.test(err?.message || '');
}

export class DocumentDatabase {
  constructor(store) { this.store = store; }

  async close() { await this.store.close?.(); }

  // ---- flows ----------------------------------------------------------------------------------
  async listFlows(guildId) {
    return this.store.find('flows', { eq: { guildId }, order: [asc('createdAt'), asc('id')] });
  }

  async listEnabledFlows(guildId) { return (await this.listFlows(guildId)).filter((flow) => flow.enabled); }

  async guildIdsWithFlows() {
    const rows = await this.store.find('flows', { eq: { enabled: true } });
    return [...new Set(rows.map((row) => row.guildId))];
  }

  async countFlows(guildId) { return (await this.store.find('flows', { eq: { guildId } })).length; }

  async getFlow(guildId, id) { return this.store.get('flows', id, { guildId }); }

  async createFlow({ guildId, name, graph, enabled = true, updatedBy = null }) {
    const now = Date.now();
    const id = uid(8);
    await this.store.put('flows', id, { id, guildId, name, enabled: Boolean(enabled), graph, createdAt: now, updatedAt: now, updatedBy });
    return this.getFlow(guildId, id);
  }

  async updateFlow(guildId, id, patch, updatedBy = null) {
    const cur = await this.getFlow(guildId, id);
    if (!cur) return null;
    const next = {
      ...cur,
      name: 'name' in patch ? patch.name : cur.name,
      enabled: 'enabled' in patch ? Boolean(patch.enabled) : cur.enabled,
      graph: 'graph' in patch ? patch.graph : cur.graph,
      updatedAt: Date.now(),
      updatedBy: updatedBy ?? cur.updatedBy,
    };
    await this.store.put('flows', id, next);
    return this.getFlow(guildId, id);
  }

  async deleteFlow(guildId, id) { return this.store.delete('flows', id, { guildId }); }

  // ---- webhook addresses ----------------------------------------------------------------------
  async webhookFor(guildId, flowId, nodeId) {
    const [row] = await this.store.find('webhooks', { eq: { guildId, flowId, nodeId }, limit: 1 });
    return row ? { token: row.token, createdAt: row.createdAt, lastAt: row.lastAt } : null;
  }

  async ensureWebhook(guildId, flowId, nodeId, { renew = false } = {}) {
    const cur = await this.webhookFor(guildId, flowId, nodeId);
    if (cur && !renew) return { ...cur, created: false };
    if (cur) await this.store.delete('webhooks', cur.token);
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    await this.store.put('webhooks', token, { id: token, token, guildId, flowId, nodeId, createdAt, lastAt: null });
    return { token, createdAt, lastAt: null, created: true };
  }

  async webhookByToken(token) {
    const row = await this.store.get('webhooks', String(token));
    return row ? { guildId: row.guildId, flowId: row.flowId, nodeId: row.nodeId } : null;
  }

  async touchWebhook(token, at = Date.now()) {
    const row = await this.store.get('webhooks', String(token));
    if (row) await this.store.put('webhooks', row.token, { ...row, lastAt: at });
  }

  async pruneWebhooks(guildId, flowId, keepNodeIds) {
    for (const row of await this.store.find('webhooks', { eq: { guildId, flowId } })) {
      if (!keepNodeIds.has(row.nodeId)) await this.store.delete('webhooks', row.token);
    }
  }

  async deleteWebhooksForFlow(guildId, flowId) {
    for (const row of await this.store.find('webhooks', { eq: { guildId, flowId } })) await this.store.delete('webhooks', row.token);
  }

  // ---- watcher state --------------------------------------------------------------------------
  async getWatch(guildId, flowId, nodeId) {
    const row = await this.store.get('watch_state', docKey(flowId, nodeId), { guildId });
    return row ? row.data : null;
  }

  async setWatch(guildId, flowId, nodeId, data) {
    const id = docKey(flowId, nodeId);
    await this.store.put('watch_state', id, { id, guildId, flowId, nodeId, data, updatedAt: Date.now() });
  }

  async pruneWatch(guildId, keep) {
    for (const row of await this.store.find('watch_state', { eq: { guildId } })) {
      if (!keep.has(`${row.flowId}|${row.nodeId}`)) await this.store.delete('watch_state', row.id, { guildId });
    }
  }

  // ---- connected accounts ---------------------------------------------------------------------
  // A server may connect several accounts of one platform; each is a document named after platform + account. Before that was allowed there was
  // one per platform, stored under the platform's name: such a document is still found (and moved to the new name the next time it is saved).
  async #findAccount(guildId, provider, accountId) {
    const id = docKey(provider, accountId);
    const row = await this.store.get('linked_accounts', id, { guildId });
    if (row) return { id, row };
    const old = await this.store.get('linked_accounts', provider, { guildId });
    return old && old.accountId === String(accountId) ? { id: provider, row: old, old: true } : null;
  }

  static #account(row) {
    return {
      guildId: row.guildId, provider: row.provider, accountId: row.accountId, accountName: row.accountName, accountLogin: row.accountLogin ?? '',
      accessSealed: row.accessSealed, refreshSealed: row.refreshSealed, expiresAt: row.expiresAt, scopes: row.scopes, status: row.status,
      connectedBy: row.connectedBy, createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  /** One account with its sealed tokens. Without an `accountId`: the oldest account of that platform that works, or the oldest of all when none does. */
  async getAccount(guildId, provider, accountId = '') {
    if (accountId) {
      const found = await this.#findAccount(guildId, provider, String(accountId));
      return found ? DocumentDatabase.#account(found.row) : null;
    }
    const rows = await this.store.find('linked_accounts', { eq: { guildId, provider } });
    rows.sort((a, b) => (Number(b.status === 'ok') - Number(a.status === 'ok')) || (a.createdAt - b.createdAt) || String(a.accountId).localeCompare(String(b.accountId)));
    return rows[0] ? DocumentDatabase.#account(rows[0]) : null;
  }

  async listAccounts(guildId) {
    const rows = await this.store.find('linked_accounts', { eq: { guildId }, order: [asc('provider'), asc('createdAt'), asc('accountId')] });
    return rows.map((row) => ({
      provider: row.provider, accountId: row.accountId, accountName: row.accountName, accountLogin: row.accountLogin ?? '', status: row.status,
      connectedBy: row.connectedBy, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
  }

  async saveAccount(a, now = Date.now()) {
    const accountId = String(a.accountId);
    const prev = await this.#findAccount(a.guildId, a.provider, accountId);
    const id = docKey(a.provider, accountId);
    await this.store.put('linked_accounts', id, {
      id, guildId: a.guildId, provider: a.provider, accountId, accountName: a.accountName, accountLogin: a.accountLogin ?? '',
      accessSealed: a.accessSealed, refreshSealed: a.refreshSealed, expiresAt: a.expiresAt, scopes: a.scopes ?? '', status: a.status ?? 'ok',
      connectedBy: a.connectedBy ?? prev?.row.connectedBy ?? null, createdAt: prev?.row.createdAt ?? now, updatedAt: now,
    });
    if (prev?.old) await this.store.delete('linked_accounts', prev.id, { guildId: a.guildId });
  }

  async setAccountStatus(guildId, provider, accountId, status, now = Date.now()) {
    const found = await this.#findAccount(guildId, provider, String(accountId));
    if (found) await this.store.put('linked_accounts', found.id, { ...found.row, status, updatedAt: now });
  }

  async deleteAccount(guildId, provider, accountId) {
    const found = await this.#findAccount(guildId, provider, String(accountId));
    if (found) await this.store.delete('linked_accounts', found.id, { guildId });
  }

  async deleteGuildAccounts(guildId) {
    for (const row of await this.store.find('linked_accounts', { eq: { guildId } })) {
      await this.store.delete('linked_accounts', row.id, { guildId });
    }
  }

  // ---- “Connect Twitch / TikTok” in progress (only a hash of the one-time state is kept) -------------
  async putConnectState(hash, { guildId, userId, provider, expiresAt }, max = 500) {
    await this.store.put('connect_pending', hash, { id: hash, guildId, userId, provider, expiresAt });
    const rows = await this.store.find('connect_pending', { order: [desc('expiresAt')] });
    for (const row of rows.slice(max)) await this.store.delete('connect_pending', row.id);
  }

  /** Reads and removes: a state can be used once. */
  async takeConnectState(hash) {
    const row = await this.store.get('connect_pending', String(hash));
    if (!row) return null;
    await this.store.delete('connect_pending', row.id);
    return { guildId: row.guildId, userId: row.userId, provider: row.provider, expiresAt: row.expiresAt };
  }

  async pruneConnectStates(now = Date.now()) {
    for (const row of await this.store.find('connect_pending', { compare: { field: 'expiresAt', op: 'lte', value: now } })) {
      await this.store.delete('connect_pending', row.id);
    }
  }

  // ---- variables ------------------------------------------------------------------------------
  async getVar(guildId, scope, scopeId, name) {
    const row = await this.store.get('vars', docKey(scope, scopeId, name), { guildId });
    return row ? row.value : undefined;
  }

  async setVar(guildId, scope, scopeId, name, value) {
    if (scope !== 'guild' && scope !== 'channel' && scope !== 'user') throw new FlowError(`Unknown variable scope “${scope}”.`);
    if (!VAR_NAME.test(String(name))) throw new FlowError(`“${name}” is not a valid variable name.`);
    const json = JSON.stringify(value);
    if (json === undefined) throw new FlowError('That value cannot be stored.');
    if (isCapped(LIMITS.varValueBytes) && Buffer.byteLength(json) > LIMITS.varValueBytes) throw new FlowError(`Variable values can be at most ${LIMITS.varValueBytes} bytes.`);
    const id = docKey(scope, scopeId, name);
    if (isCapped(LIMITS.varsPerGuild) && !await this.store.get('vars', id, { guildId }) && await this.countVars(guildId) >= LIMITS.varsPerGuild) {
      throw new FlowError(`This server reached the limit of ${LIMITS.varsPerGuild} stored variables.`);
    }
    // Same text SQLite would store, so a value comes back without keys JSON cannot keep.
    await this.store.put('vars', id, { id, guildId, scope, scopeId, name, value: JSON.parse(json) });
  }

  async deleteVar(guildId, scope, scopeId, name) {
    return this.store.delete('vars', docKey(scope, scopeId, name), { guildId });
  }

  async deleteVarsForScope(guildId, scope, scopeId) {
    const rows = await this.store.find('vars', { eq: { guildId, scope, scopeId } });
    for (const row of rows) await this.store.delete('vars', row.id, { guildId });
    return rows.length;
  }

  async countVars(guildId) { return (await this.store.find('vars', { eq: { guildId } })).length; }

  async varsFor(guildId, scope, scopeId) {
    const out = {};
    for (const row of await this.store.find('vars', { eq: { guildId, scope, scopeId } })) out[row.name] = row.value;
    return out;
  }

  async listVars(guildId) {
    const rows = await this.store.find('vars', { eq: { guildId }, order: [asc('scope'), asc('scopeId'), asc('name')], limit: 1000 });
    return rows.map((row) => ({ scope: row.scope, scopeId: row.scopeId, name: row.name, value: row.value }));
  }

  // ---- pages ----------------------------------------------------------------------------------
  async listPages(guildId) { return this.store.find('pages', { eq: { guildId }, order: [asc('createdAt'), asc('id')] }); }
  async countPages(guildId) { return (await this.listPages(guildId)).length; }
  async getPage(guildId, id) { return this.store.get('pages', id, { guildId }); }

  async getPageBySlug(guildId, slug) {
    const [row] = await this.store.find('pages', { eq: { guildId, slug }, limit: 1 });
    return row ?? null;
  }

  async slugTaken(guildId, slug, exceptId = '') {
    const [row] = await this.store.find('pages', { eq: { guildId, slug }, limit: 1 });
    return Boolean(row && row.id !== exceptId);
  }

  async uniqueSlug(guildId, base) {
    const root = String(base).slice(0, 34).replace(/-+$/, '') || 'page';
    for (let n = 1; ; n += 1) {
      const slug = n === 1 ? root : `${root}-${n}`;
      if (!await this.slugTaken(guildId, slug)) return slug;
    }
  }

  async createPage({ guildId, slug, title, theme, blocks, published = false, access = 'public', roleIds = [], updatedBy = null }) {
    if (await this.slugTaken(guildId, slug)) throw new SlugTakenError('That web address is already used by another page.');
    const now = Date.now();
    const id = uid(8);
    const live = published ? { title, theme, blocks, at: now, by: updatedBy } : null;
    try {
      await this.store.put('pages', id, {
        id, guildId, slug, title, published: Boolean(published), theme, blocks, createdAt: now, updatedAt: now, updatedBy, live, access, roleIds,
      });
    } catch (err) {
      if (duplicate(err)) throw new SlugTakenError('That web address is already used by another page.');
      throw err;
    }
    return this.getPage(guildId, id);
  }

  async updatePage(guildId, id, patch, updatedBy = null) {
    const cur = await this.getPage(guildId, id);
    if (!cur) return null;
    const next = { ...cur, updatedAt: Date.now(), updatedBy: updatedBy ?? cur.updatedBy };
    for (const field of ['slug', 'title', 'theme', 'blocks', 'access', 'roleIds']) if (field in patch) next[field] = patch[field];
    if (await this.slugTaken(guildId, next.slug, id)) throw new SlugTakenError('That web address is already used by another page.');
    try { await this.store.put('pages', id, next); } catch (err) {
      if (duplicate(err)) throw new SlugTakenError('That web address is already used by another page.');
      throw err;
    }
    return this.getPage(guildId, id);
  }

  async publishPage(guildId, id, by = null) {
    const cur = await this.getPage(guildId, id);
    if (!cur) return null;
    await this.store.put('pages', id, { ...cur, published: true, live: { title: cur.title, theme: cur.theme, blocks: cur.blocks, at: Date.now(), by } });
    return this.getPage(guildId, id);
  }

  async unpublishPage(guildId, id) {
    const cur = await this.getPage(guildId, id);
    if (!cur) return null;
    await this.store.put('pages', id, { ...cur, published: false, live: null });
    return this.getPage(guildId, id);
  }

  async discardDraft(guildId, id, by = null) {
    const cur = await this.getPage(guildId, id);
    if (!cur?.live) return null;
    await this.store.put('pages', id, {
      ...cur, title: cur.live.title, theme: cur.live.theme, blocks: cur.live.blocks, updatedAt: Date.now(), updatedBy: by ?? cur.updatedBy,
    });
    return this.getPage(guildId, id);
  }

  async deletePage(guildId, id) {
    const existed = Boolean(await this.getPage(guildId, id));
    for (const row of await this.store.find('form_responses', { eq: { guildId, pageId: id } })) {
      await this.store.delete('form_responses', row.id, { guildId });
    }
    await this.store.delete('pages', id, { guildId });
    return existed;
  }

  // ---- form responses -------------------------------------------------------------------------
  async addResponse({ guildId, pageId, blockId, userId, userName, answers }) {
    const id = uid(10);
    await this.store.put('form_responses', id, { id, guildId, pageId, blockId, userId, userName, answers, createdAt: Date.now() });
    return id;
  }

  async countResponsesInGuild(guildId) { return (await this.store.find('form_responses', { eq: { guildId } })).length; }

  async countResponses(guildId, pageId, blockId) {
    return (await this.store.find('form_responses', { eq: { guildId, pageId, blockId } })).length;
  }

  async listResponses(guildId, pageId, blockId, { limit = 50, offset = 0 } = {}) {
    const rows = await this.store.find('form_responses', {
      eq: { guildId, pageId, blockId }, order: [desc('createdAt'), desc('id')],
      limit: Math.min(Math.max(1, limit), 500), offset: Math.max(0, offset),
    });
    return rows.map(presentResponse);
  }

  async allResponses(guildId, pageId, blockId) {
    const rows = await this.store.find('form_responses', {
      eq: { guildId, pageId, blockId }, order: [asc('createdAt'), asc('id')], limit: 100000,
    });
    return rows.map(presentResponse);
  }

  async deleteResponse(guildId, pageId, id) {
    const row = await this.store.get('form_responses', id, { guildId });
    if (!row || row.pageId !== pageId) return false;
    return this.store.delete('form_responses', id, { guildId });
  }

  async lastResponseAt(guildId, pageId, blockId, userId) {
    const [row] = await this.store.find('form_responses', {
      eq: { guildId, pageId, blockId, userId }, order: [desc('createdAt')], limit: 1,
    });
    return row?.createdAt;
  }

  // ---- uploads --------------------------------------------------------------------------------
  async listUploads(guildId) {
    return this.store.find('uploads', { eq: { guildId }, order: [desc('createdAt'), asc('id')] });
  }

  async getUpload(guildId, id) { return this.store.get('uploads', id, { guildId }); }

  async uploadIds(guildId) {
    return new Set((await this.store.find('uploads', { eq: { guildId } })).map((row) => row.id));
  }

  async getUploadByHash(guildId, sha256) {
    const [row] = await this.store.find('uploads', { eq: { guildId, sha256 }, limit: 1 });
    return row ?? null;
  }

  async uploadUsage(guildId) {
    const rows = await this.store.find('uploads', { eq: { guildId } });
    return { count: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0) };
  }

  async addUpload({ guildId, name, bytes, width, height, animated, sha256, createdBy = null }) {
    if (await this.getUploadByHash(guildId, sha256)) {
      const err = new Error('UNIQUE constraint failed: uploads.sha256');
      throw err;
    }
    const id = uid(16);
    try {
      await this.store.put('uploads', id, {
        id, guildId, name, bytes, width, height, animated: Boolean(animated), sha256, createdAt: Date.now(), createdBy,
      });
    } catch (err) {
      if (duplicate(err)) throw new Error('UNIQUE constraint failed: uploads.sha256', { cause: err });
      throw err;
    }
    return this.getUpload(guildId, id);
  }

  async deleteUpload(guildId, id) { return this.store.delete('uploads', id, { guildId }); }

  async uploadUses(guildId) {
    const uses = new Map();
    const note = (text, kind, item) => {
      for (const match of String(text).matchAll(/upload:([a-z0-9]{16})/g)) {
        const entry = uses.get(match[1]) ?? uses.set(match[1], { pages: [], flows: [] }).get(match[1]);
        if (!entry[kind].some((existing) => existing.id === item.id)) entry[kind].push(item);
      }
    };
    const pages = await this.store.find('pages', { eq: { guildId }, order: [asc('title'), asc('id')] });
    for (const page of pages) note(`${JSON.stringify(page.blocks)}${JSON.stringify(page.theme)}`, 'pages', { id: page.id, title: page.title });
    const flows = await this.store.find('flows', { eq: { guildId }, order: [asc('name'), asc('id')] });
    for (const flow of flows) note(JSON.stringify(flow.graph), 'flows', { id: flow.id, name: flow.name });
    return uses;
  }

  // ---- transcripts ----------------------------------------------------------------------------
  async getTranscript(id) { return this.store.get('transcripts', id); }

  async transcriptsBefore(cutoff) {
    return this.store.find('transcripts', { compare: { field: 'createdAt', op: 'lt', value: cutoff }, order: [asc('createdAt'), asc('id')] });
  }

  async addTranscript({ guildId, name, messages, bytes, truncated, now = Date.now() }) {
    const id = uid(32);
    await this.store.put('transcripts', id, { id, guildId, name, messages, bytes, truncated: Boolean(truncated), createdAt: now });
    return this.getTranscript(id);
  }

  async deleteTranscript(id) { return this.store.delete('transcripts', id); }

  // ---- sessions -------------------------------------------------------------------------------
  async createSession(userId, data, ttlMs) {
    const id = crypto.randomBytes(32).toString('hex');
    const stored = sha(id);
    await this.store.put('sessions', stored, { id: stored, userId, data, expiresAt: Date.now() + ttlMs });
    return id;
  }

  async getSession(rawId) {
    if (typeof rawId !== 'string' || rawId.length !== 64) return null;
    const row = await this.store.get('sessions', sha(rawId));
    if (!row) return null;
    if (row.expiresAt < Date.now()) { await this.deleteSession(rawId); return null; }
    return { userId: row.userId, data: row.data, expiresAt: row.expiresAt };
  }

  async deleteSession(rawId) { await this.store.delete('sessions', sha(String(rawId))); }

  async pruneSessions() {
    const stale = await this.store.find('sessions', { compare: { field: 'expiresAt', op: 'lt', value: Date.now() } });
    for (const row of stale) await this.store.delete('sessions', row.id);
  }

  // ---- component state ------------------------------------------------------------------------
  async saveComponentState({ guildId, messageId, channelId = '', vars, data, expiresAt = null, now = Date.now() }) {
    await this.store.put('component_state', messageId, { id: messageId, guildId, messageId, channelId, vars, data, createdAt: now, expiresAt });
  }

  async getComponentState(guildId, messageId, now = Date.now()) {
    const row = await this.store.get('component_state', messageId, { guildId });
    if (!row) return undefined;
    if (row.expiresAt !== null && row.expiresAt <= now) return undefined;
    return { vars: row.vars, data: row.data, at: row.createdAt };
  }

  async deleteComponentState(guildId, messageId) { return this.store.delete('component_state', messageId, { guildId }); }

  async deleteComponentStateForChannel(guildId, channelId) {
    const rows = await this.store.find('component_state', { eq: { guildId, channelId } });
    for (const row of rows) await this.store.delete('component_state', row.id, { guildId });
    return rows.length;
  }

  async pruneComponentState(now = Date.now()) {
    const rows = await this.store.find('component_state', { notNull: ['expiresAt'], compare: { field: 'expiresAt', op: 'lte', value: now } });
    for (const row of rows) await this.store.delete('component_state', row.id, { guildId: row.guildId });
    return rows.length;
  }

  async countComponentState(guildId) { return (await this.store.find('component_state', { eq: { guildId } })).length; }

  // ---- slash-command sync ---------------------------------------------------------------------
  async getSyncHash(guildId) { return (await this.store.get('command_sync', guildId))?.hash; }

  async setSyncHash(guildId, hash) { await this.store.put('command_sync', guildId, { id: guildId, guildId, hash }); }
}

function presentResponse(row) {
  return { id: row.id, pageId: row.pageId, blockId: row.blockId, userId: row.userId, userName: row.userName, answers: row.answers, createdAt: row.createdAt };
}
