// Pretend Cloudflare D1 and Firestore (just enough of their HTTP APIs), shared by the tests of the cloud database.
//
// The real services refuse items past a size. These refuse them too — Firestore: a string field stops just under 1 MiB; D1: a row stops at 2 MB —
// and remember the biggest item they were handed (`fetch.biggest()`), so a test can prove that what the bot stores fits.
export const LIMITS = { firestoreField: 1_048_487, d1Row: 2_000_000 };

function ok(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Speaks just enough of the D1 HTTP API for the statements this project sends. */
export function fakeD1() {
  const rows = new Map();
  let biggest = 0;
  const fetch = async (_url, opts) => {
    const { sql, params } = JSON.parse(opts.body);
    const compact = sql.replace(/\s+/g, ' ').trim();
    const key = `${params?.[0]}\0${params?.[1]}`;
    if (compact.startsWith('CREATE')) return ok({ success: true, result: [{ results: [] }] });
    if (compact.startsWith('INSERT')) {
      const size = Buffer.byteLength(String(params[3]));
      biggest = Math.max(biggest, size);
      if (size > LIMITS.d1Row) return ok({ success: false, errors: [{ message: 'string or blob too big' }] }, 400);
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
  fetch.biggest = () => biggest;
  fetch.count = () => rows.size;
  return fetch;
}

/** Speaks just enough of the Firestore REST API to store and list JSON documents. */
export function fakeFirestore() {
  const docs = new Map();
  let biggest = 0;
  const pathOf = (url) => {
    const text = String(url);
    const base = text.split('/documents/')[1] || '';
    return base.split('?')[0];
  };
  const fetch = async (url, opts = {}) => {
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
      const json = JSON.parse(opts.body).fields.json.stringValue;
      const size = Buffer.byteLength(json);
      biggest = Math.max(biggest, size);
      if (size > LIMITS.firestoreField) return ok({ error: { message: 'The value of property "json" is longer than 1048487 bytes.' } }, 400);
      docs.set(path, json);
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
  fetch.biggest = () => biggest;
  fetch.count = () => docs.size;
  return fetch;
}
