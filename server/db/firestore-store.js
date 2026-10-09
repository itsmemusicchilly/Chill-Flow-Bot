// Firestore over its REST API, signed in with the service-account key. No extra package.
// One record is one JSON string, so numbers and nested flow graphs survive the round trip.
// Server data lives under guilds/<server>/<collection>, which needs no composite index.
import crypto from 'node:crypto';
import { applyQuery, GUILD_SCOPED } from './query.js';

const MAX_BYTES = 1_000_000;

const b64url = (value) => Buffer.from(value).toString('base64url');

export class FirestoreStore {
  /** @param {{ projectId: string, clientEmail: string, privateKey: string, databaseId?: string, fetch?: typeof fetch, token?: string }} cfg `token` skips the sign-in, for tests. */
  constructor({ projectId, clientEmail, privateKey, databaseId = '(default)', fetch = globalThis.fetch, token = null }) {
    this.projectId = projectId;
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
    this.databaseId = databaseId;
    this.fetch = fetch;
    this.cached = token ? { value: token, until: Date.now() + 3_600_000 } : null;
  }

  static async connect(cfg) {
    const store = new FirestoreStore(cfg);
    const res = await store.#request('GET', store.#url('meta/startup'));
    if (res.status !== 200 && res.status !== 404) {
      const body = await res.json().catch(() => ({}));
      const detail = body.error?.message ? `: ${body.error.message}` : '';
      throw new Error(`Firebase refused the connection (${res.status}${detail}). Check the service account and that Firestore is turned on.`);
    }
    return store;
  }

  #root() {
    const databaseId = this.databaseId === '(default)' ? '(default)' : encodeURIComponent(this.databaseId);
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/databases/${databaseId}/documents`;
  }

  #url(path) { return `${this.#root()}/${path}`; }

  #docPath(collection, id, guildId) {
    const name = encodeURIComponent(id);
    if (!GUILD_SCOPED.has(collection)) return `${collection}/${name}`;
    if (!guildId) throw new Error(`Missing server id for ${collection}.`);
    return `guilds/${encodeURIComponent(guildId)}/${collection}/${name}`;
  }

  async #token() {
    if (this.cached && this.cached.until > Date.now() + 60_000) return this.cached.value;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({
      iss: this.clientEmail,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }));
    const unsigned = `${header}.${claim}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.privateKey);
    const assertion = `${unsigned}.${b64url(signature)}`;
    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`Firebase refused the sign-in (${res.status}${body.error_description ? `: ${body.error_description}` : ''}).`);
    this.cached = { value: body.access_token, until: Date.now() + (body.expires_in || 3600) * 1000 };
    return body.access_token;
  }

  async #request(method, url, body) {
    const token = await this.#token();
    return this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async get(collection, id, { guildId } = {}) {
    const res = await this.#request('GET', this.#url(this.#docPath(collection, id, guildId)));
    if (res.status === 404) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw firebaseError('read', res.status, body);
    return readDoc(body);
  }

  async put(collection, id, doc) {
    const json = JSON.stringify({ ...doc, id });
    if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('That value is too large for Firebase (1 MB per record).');
    const res = await this.#request('PATCH', this.#url(this.#docPath(collection, id, doc.guildId)), {
      fields: { json: { stringValue: json } },
    });
    if (!res.ok) throw firebaseError('write', res.status, await res.json().catch(() => ({})));
  }

  async delete(collection, id, { guildId } = {}) {
    const res = await this.#request('DELETE', this.#url(this.#docPath(collection, id, guildId)));
    if (res.status === 404) return false;
    if (!res.ok) throw firebaseError('delete', res.status, await res.json().catch(() => ({})));
    return true;
  }

  async find(collection, query = {}) {
    const guildId = query.eq?.guildId;
    if (GUILD_SCOPED.has(collection) && guildId) {
      return applyQuery(await this.#list(this.#url(`guilds/${encodeURIComponent(guildId)}/${collection}`)), query);
    }
    if (GUILD_SCOPED.has(collection)) return applyQuery(await this.#listGroup(collection), query);
    return applyQuery(await this.#list(this.#url(collection)), query);
  }

  async #list(url) {
    const docs = [];
    let pageToken = '';
    do {
      const page = new URL(url);
      page.searchParams.set('pageSize', '300');
      if (pageToken) page.searchParams.set('pageToken', pageToken);
      const res = await this.#request('GET', page);
      if (res.status === 404) return docs;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw firebaseError('list', res.status, body);
      for (const doc of body.documents || []) {
        const parsed = readDoc(doc);
        if (parsed) docs.push(parsed);
      }
      pageToken = body.nextPageToken || '';
    } while (pageToken);
    return docs;
  }

  /** Every server's copy of one collection. Ordered by document name so each page continues after the last. */
  async #listGroup(collection) {
    const docs = [];
    let after = '';
    for (;;) {
      const structuredQuery = {
        from: [{ collectionId: collection, allDescendants: true }],
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: 300,
      };
      if (after) structuredQuery.startAfter = { values: [{ referenceValue: after }], before: false };
      const res = await this.#request('POST', `${this.#root()}:runQuery`, { structuredQuery });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw firebaseError('list', res.status, body && !Array.isArray(body) ? body : {});
      const page = (Array.isArray(body) ? body : []).map((row) => row.document).filter(Boolean);
      for (const doc of page) {
        const parsed = readDoc(doc);
        if (parsed) docs.push(parsed);
      }
      const last = page.at(-1)?.name || '';
      if (page.length < 300 || !last || last === after) break;
      after = last;
    }
    return docs;
  }

  async close() {}
}

function readDoc(doc) {
  const raw = doc?.fields?.json?.stringValue;
  return raw ? JSON.parse(raw) : null;
}

function firebaseError(action, status, body) {
  const detail = body?.error?.message ? `: ${body.error.message}` : '';
  return new Error(`Firebase ${action} failed (${status}${detail}).`);
}
