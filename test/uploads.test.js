import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { defaultBlockData } from '../shared/blocks.js';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { FlowError } from '../server/engine/errors.js';
import { cleanName, createUploads, isPublicBase } from '../server/uploads.js';
import { A, B, startHarness } from './helpers/harness.js';
import { assertInert } from './helpers/inert.js';
import { animatedGif, html, jpegWithExif, pngBomb, png, SECRET, svg, truncatedPng } from './helpers/images.js';

let h;
before(async () => { h = await startHarness({ config: { uploadRate: { perUser: 100000, views: 100000 } } }); }); // the rate limits have their own tests below
after(() => h.close());
beforeEach(() => { resetLimits(); h.state.managers = new Set([`${A}:u1`, `${B}:u1`]); });
afterEach(resetLimits);

const call = (...args) => h.call(...args);
const upload = (buf, { gid = A, type = 'image/png', name = 'cat.png', ...rest } = {}) => call('POST', `/api/guilds/${gid}/uploads`, {
  raw: buf, type, ...rest, headers: { 'X-Filename': encodeURIComponent(name), ...rest.headers },
});
const distinct = (n) => Promise.all(Array.from({ length: n }, (_, i) => png(30 + i, 20, { noise: true })));
const ls = (gid = A) => fs.existsSync(path.join(h.uploads.root, gid)) ? fs.readdirSync(path.join(h.uploads.root, gid)) : [];

/** GET without any URL normalisation (fetch() would tidy `..` away and hide what the server sees). */
const rawGet = (target, headers = {}) => new Promise((resolve, reject) => {
  const { port } = new URL(h.base);
  http.get({ host: '127.0.0.1', port, path: target, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

describe('uploading', () => {
  it('stores a re-encoded WebP and describes it', async () => {
    const r = await upload(await png(64, 48));
    assert.equal(r.status, 201);
    const u = r.json.upload;
    assert.match(u.id, /^[a-z0-9]{16}$/);
    assert.equal(u.ref, `upload:${u.id}`);
    assert.equal(u.url, `/i/${A}/${u.id}.webp`);
    assert.deepEqual([u.name, u.width, u.height, u.animated], ['cat.png', 64, 48, false]);
    const file = fs.readFileSync(h.uploads.fileFor(A, u.id));
    assert.equal(file.length, u.bytes);
    assert.equal(file.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.equal(file.subarray(8, 12).toString('latin1'), 'WEBP');
    assert.deepEqual(db().getUpload(A, u.id).createdBy, { id: 'u1', name: 'Mia' });
    assert.ok(h.logger.recent(A, 50).some((e) => e.message === `Image “cat.png” (${u.bytes} B) was uploaded by Mia.`), 'the live log says who uploaded what, in sensible units');
  });

  it('never stores the owner name or GPS position of a photo', async () => {
    const { json: { upload: u } } = await upload(await jpegWithExif(), { type: 'image/jpeg', name: 'photo.jpg' });
    const served = await rawGet(u.url);
    assert.equal(served.status, 200);
    assert.equal(served.body.includes(Buffer.from(SECRET)), false);
    assert.equal(fs.readFileSync(h.uploads.fileFor(A, u.id)).includes(Buffer.from(SECRET)), false);
  });

  it('keeps animations animated', async () => {
    const r = await upload(await animatedGif(), { type: 'image/gif', name: 'party.gif' });
    assert.equal(r.status, 201);
    assert.equal(r.json.upload.animated, true);
  });

  it('the same file twice gives the same image, not a second copy', async () => {
    const buf = await png(31, 17, { noise: true });
    const first = await upload(buf);
    const second = await upload(buf, { name: 'again.png' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.upload.id, first.json.upload.id);
    assert.equal(ls().filter((f) => f === `${first.json.upload.id}.webp`).length, 1);
  });

  it('two servers uploading the same file get separate images', async () => {
    const buf = await png(33, 21, { noise: true });
    const a = (await upload(buf, { gid: A })).json.upload;
    const b = (await upload(buf, { gid: B })).json.upload;
    assert.notEqual(a.id, b.id);
    assert.equal((await rawGet(`/i/${A}/${a.id}.webp`)).status, 200);
    assert.equal((await rawGet(`/i/${B}/${b.id}.webp`)).status, 200);
  });

  it('refuses what is not a picture, whatever it is called', async () => {
    assert.equal((await upload(svg(), { type: 'image/svg+xml', name: 'x.svg' })).status, 415, 'wrong content type');
    assert.equal((await upload(svg(), { type: 'image/png', name: 'x.png' })).status, 415, 'SVG dressed as PNG');
    assert.equal((await upload(html(), { type: 'image/png', name: 'x.png' })).status, 415, 'HTML dressed as PNG');
    assert.equal((await upload(await png(), { type: 'application/octet-stream' })).status, 415, 'no picture content type');
    const empty = await upload(Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /empty/);
    const damaged = await upload(await truncatedPng());
    assert.equal(damaged.status, 422);
    assert.match(damaged.json.error, /could not be read/);
    const bomb = await upload(pngBomb());
    assert.equal(bomb.status, 413);
    assert.match(bomb.json.error, /too many pixels/);
    assert.deepEqual(db().listUploads(A).filter((u) => u.name === 'x.png'), [], 'nothing was stored');
  });

  it('a filename is only a label: sanitised, never a path', async () => {
    const before = ls();
    const r = await upload(await png(35, 22, { noise: true }), { name: '../../etc/passwd\u0000.png' });
    assert.equal(r.status, 201);
    assert.equal(r.json.upload.name, '../../etc/passwd.png');
    const added = ls().filter((f) => !before.includes(f));
    assert.deepEqual(added, [`${r.json.upload.id}.webp`], 'the file is named after its random id');
    assert.equal(fs.existsSync(path.join(h.uploads.root, 'etc')), false);
    const RLO = String.fromCharCode(0x202e), LS = String.fromCharCode(0x2028); // a right-to-left override and a line separator
    assert.equal(cleanName(`a${RLO}exe.png${LS}`), 'aexe.png');
    assert.equal(cleanName('x'.repeat(500)).length, 100);
    assert.equal(cleanName('   '), 'image');
    assert.equal(cleanName('%E0%A4%A'), '%E0%A4%A', 'broken encoding is kept as text');
    assert.equal(cleanName('😀'.repeat(150)).length, 200, 'cut on characters, never in the middle of one');
  });
});

describe('who may upload', () => {
  it('needs a dashboard session, the live admin check and our own origin', async () => {
    const buf = await png(36, 22, { noise: true });
    assert.equal((await upload(buf, { sid: null })).status, 401);
    assert.equal((await upload(buf, { sid: null, visitor: h.visitorSession() })).status, 401, 'a public-page visitor cannot upload');
    assert.equal((await upload(buf, { sid: h.visitorSession() })).status, 401, 'nor with a visitor cookie in the dashboard slot');
    assert.equal((await upload(buf, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await upload(buf, { origin: null })).status, 403);
    h.state.managers.delete(`${A}:u1`);
    assert.equal((await upload(buf)).status, 403, 'no longer an admin');
    assert.equal((await upload(buf, { sid: h.session([B]) })).status, 403, 'not in that server at all');
    assert.equal((await upload(buf, { gid: '99999999' })).status, 403);
    assert.equal(db().listUploads(A).some((u) => u.sha256.length && u.bytes === 0), false);
  });

  it('listing and deleting are per server', async () => {
    const a = (await upload(await png(37, 22, { noise: true }), { gid: A, name: 'only-a.png' })).json.upload;
    const listB = (await call('GET', `/api/guilds/${B}/uploads`)).json;
    assert.equal(listB.uploads.some((u) => u.id === a.id), false);
    assert.equal((await call('DELETE', `/api/guilds/${B}/uploads/${a.id}`)).status, 404, 'B cannot delete A\'s image');
    assert.equal((await rawGet(`/i/${B}/${a.id}.webp`)).status, 404, 'A\'s id does not exist under B');
    assert.equal((await rawGet(`/i/${A}/${a.id}.webp`)).status, 200, 'and A\'s image is untouched');
    assert.ok(fs.existsSync(h.uploads.fileFor(A, a.id)));
    const listA = (await call('GET', `/api/guilds/${A}/uploads`)).json;
    assert.ok(listA.uploads.some((u) => u.id === a.id));
    assert.deepEqual(Object.keys(listA.usage), ['count', 'bytes']);
  });

  it('deleting removes the file and the address; unknown or malformed ids are 404', async () => {
    const u = (await upload(await png(38, 22, { noise: true }))).json.upload;
    const del = await call('DELETE', `/api/guilds/${A}/uploads/${u.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.json.uses, { pages: [], flows: [] });
    assert.equal(fs.existsSync(h.uploads.fileFor(A, u.id)), false);
    assert.equal((await rawGet(u.url)).status, 404);
    assert.equal((await call('DELETE', `/api/guilds/${A}/uploads/${u.id}`)).status, 404, 'already gone');
    for (const bad of ['..', '%2e%2e', 'UPPERCASE0123456', 'short', `${u.id}x`, '..%2f..%2fflowbot.sqlite']) {
      assert.equal((await call('DELETE', `/api/guilds/${A}/uploads/${bad}`)).status, 404, bad);
    }
  });

  it('shows where an image is used, and reports it again when it is deleted', async () => {
    const u = (await upload(await png(39, 22, { noise: true }))).json.upload;
    const page = (await call('POST', `/api/guilds/${A}/pages`, { body: { templateId: 'blank', title: 'Uses image' } })).json.page;
    const blocks = [{ id: 'img1', type: 'image', data: { url: u.ref, alt: '', caption: '', link: '' } }];
    assert.equal((await call('PUT', `/api/guilds/${A}/pages/${page.id}`, { body: { blocks } })).status, 200);
    const flow = await call('POST', `/api/guilds/${A}/flows`, { body: { name: 'Uses image too', graph: { nodes: [{ id: 'n1', type: 'trigger.command', position: { x: 0, y: 0 }, data: { name: 'pic', description: `see ${u.ref}` } }], edges: [] } } });
    assert.equal(flow.status, 201);
    const row = (await call('GET', `/api/guilds/${A}/uploads`)).json.uploads.find((x) => x.id === u.id);
    assert.deepEqual(row.uses.pages, [{ id: page.id, title: 'Uses image' }]);
    assert.deepEqual(row.uses.flows.map((f) => f.name), ['Uses image too']);
    const del = await call('DELETE', `/api/guilds/${A}/uploads/${u.id}`);
    assert.deepEqual(del.json.uses.pages.map((p) => p.id), [page.id]);
    assert.equal(db().uploadUses(B).size, 0, 'another server sees none of it');
  });
});

describe('limits', () => {
  it('LIMIT_UPLOAD_BYTES caps one file', async () => {
    applyLimits({ uploadBytes: 500 });
    const big = await png(200, 200, { noise: true });
    assert.ok(big.length > 500);
    const r = await upload(big);
    assert.equal(r.status, 413);
    assert.match(r.json.error, /too large/);
    resetLimits();
    assert.equal((await upload(big)).status, 201, 'unlimited again');
  });

  it('LIMIT_UPLOADS_PER_GUILD caps the count, per server', async () => {
    const [x, y, z] = await distinct(3);
    const had = db().uploadUsage(A).count;
    applyLimits({ uploadsPerGuild: had + 1 });
    assert.equal((await upload(x)).status, 201);
    const over = await upload(y);
    assert.equal(over.status, 409);
    assert.match(over.json.error, /at most/);
    assert.equal((await upload(z, { gid: B })).status, 201, 'the cap is per server');
  });

  it('LIMIT_STORAGE_BYTES_PER_GUILD caps the total size', async () => {
    const [p] = await distinct(1);
    applyLimits({ storageBytesPerGuild: db().uploadUsage(A).bytes + 10 });
    const r = await upload(p);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /storage is full/);
  });

  it('parallel uploads cannot squeeze past a cap', async () => {
    const files = await distinct(6);
    const start = db().uploadUsage(B);
    applyLimits({ uploadsPerGuild: start.count + 3 });
    const results = await Promise.all(files.map((f) => upload(f, { gid: B })));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal(results.filter((r) => r.status === 409).length, 3);
    assert.equal(db().uploadUsage(B).count, start.count + 3);
    assert.equal(ls(B).length, db().uploadUsage(B).count, 'every row has its file and every file its row');
  });

  it('a duplicate is answered even when the server is full', async () => {
    const buf = await png(41, 23, { noise: true });
    const first = (await upload(buf)).json.upload;
    applyLimits({ uploadsPerGuild: 1 });
    const again = await upload(buf);
    assert.equal(again.status, 200);
    assert.equal(again.json.upload.id, first.id);
  });

  it('limits uploads per person per minute', async () => {
    const strict = await startHarness({ config: { uploadRate: { perUser: 2 } } });
    try {
      const [a, b, c] = await distinct(3);
      const go = (buf) => strict.call('POST', `/api/guilds/${A}/uploads`, { raw: buf, type: 'image/png' });
      assert.equal((await go(a)).status, 201);
      assert.equal((await go(b)).status, 201);
      assert.equal((await go(c)).status, 429);
    } finally { await strict.close(); }
  });

  it('tells the editor what uploads can do', async () => {
    const { json } = await call('GET', '/api/me');
    assert.deepEqual(json.meta.uploads, { available: true, publicBase: false, maxBytes: 32 * 1024 * 1024 });
    applyLimits({ uploadBytes: 1000 });
    assert.equal((await call('GET', '/api/me')).json.meta.uploads.maxBytes, 1000);
    assert.equal((await call('GET', '/api/me')).json.meta.limits.uploadBytes, 1000);
  });
});

describe('serving /i/<server>/<id>.webp', () => {
  let img;
  before(async () => { img = (await upload(await png(50, 40, { noise: true }), { name: 'serve.png' })).json.upload; });

  it('sends only what it should, with headers that keep it inert and cacheable', async () => {
    const r = await rawGet(img.url);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/webp');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.match(r.headers['cache-control'], /public.*max-age=31536000.*immutable/);
    assert.ok(r.headers.etag);
    assert.equal(r.headers['content-disposition'], undefined);
    assert.deepEqual(r.body, fs.readFileSync(h.uploads.fileFor(A, img.id)));
  });

  it('is public: no cookie is needed, none is read and none is set', async () => {
    const anon = await rawGet(img.url);
    const withCookie = await rawGet(img.url, { Cookie: `fc_session=${h.session()}` });
    assert.equal(anon.status, 200);
    assert.equal(withCookie.status, 200);
    assert.equal(anon.headers['set-cookie'], undefined);
    assert.equal(withCookie.headers['set-cookie'], undefined);
  });

  it('answers a matching ETag with 304', async () => {
    const first = await rawGet(img.url);
    const again = await rawGet(img.url, { 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal((await rawGet(img.url, { 'If-None-Match': '"something-else"' })).status, 200);
  });

  it('every wrong address is the same 404: unknown, other server, wrong shape, path tricks', async () => {
    const id = img.id;
    const wrong = [
      `/i/${A}/${'a'.repeat(16)}.webp`, // unknown id
      `/i/${B}/${id}.webp`, // another server's
      `/i/${A}/${id}.png`, `/i/${A}/${id}`, `/i/${A}/${id}.webp.`, `/i/${A}/${id}.WEBP`, // wrong extension
      `/i/${A}/${id.toUpperCase()}.webp`, `/i/${A}/${id.slice(1)}.webp`, `/i/${A}/${id}0.webp`, // wrong id shape
      `/i/${A}/..%2f..%2fflowbot.sqlite`, `/i/${A}/..%2f${A}%2f${id}.webp`, `/i/${A}/%2e%2e%2f${id}.webp`, `/i/..%2f${A}/${id}.webp`,
      `/i/${A}%2f..%2f${A}/${id}.webp`, `/i/${A}/${id}.webp%00`, `/i/${A}/${id}.webp%2f..%2f${id}.webp`, `/i/${A}/.tmp`, `/i/${A}/.tmp%2f${id}.webp`,
      `/i/abc/${id}.webp`, `/i/${'9'.repeat(30)}/${id}.webp`, `/i/${A}/`, `/i/${A}`, '/i/', `/i/${A}/${id}.webp/extra`,
    ];
    for (const p of wrong) {
      const r = await rawGet(p);
      assert.equal(r.status, 404, p);
      assert.equal(r.headers['cache-control'], 'no-store', p);
      assert.equal(r.body.includes('SQLite'), false, p);
    }
  });

  it('file paths are only ever built from valid ids', () => {
    for (const [gid, id] of [['..', 'a'.repeat(16)], [A, '../../x'], [`${A}/..`, 'a'.repeat(16)], [A, `${'a'.repeat(15)}/`], ['', ''], [A, 'A'.repeat(16)]]) {
      assert.throws(() => h.uploads.fileFor(gid, id), /Invalid image/, `${gid} ${id}`);
    }
    assert.ok(h.uploads.fileFor(A, 'a'.repeat(16)).startsWith(h.uploads.root + path.sep));
  });

  it('a row whose file has gone missing is a 404, not a crash', async () => {
    const gone = (await upload(await png(51, 22, { noise: true }))).json.upload;
    fs.rmSync(h.uploads.fileFor(A, gone.id));
    assert.equal((await rawGet(gone.url)).status, 404);
    assert.ok(h.logger.recent(A, 50).some((e) => /missing on disk/.test(e.message)));
  });

  it('is rate-limited per address', async () => {
    const strict = await startHarness({ config: { uploadRate: { views: 3 } } });
    try {
      const u = (await strict.call('POST', `/api/guilds/${A}/uploads`, { raw: await png(), type: 'image/png' })).json.upload;
      const { port } = new URL(strict.base);
      const get = () => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: u.url }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }));
      assert.deepEqual([await get(), await get(), await get(), await get()], [200, 200, 200, 429]);
    } finally { await strict.close(); }
  });

  it('leftovers of an interrupted upload are removed when the server starts', () => {
    const tmp = path.join(h.uploads.root, '.tmp');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'half-written.webp'), 'x');
    createUploads({ config: h.config, db: h.db, logger: h.logger });
    assert.equal(fs.existsSync(path.join(tmp, 'half-written.webp')), false);
  });
});

describe('addresses for messages', () => {
  it('a flow gets an absolute address only for its own server\'s image, and only if Discord can reach it', async () => {
    const own = (await upload(await png(52, 22, { noise: true }), { gid: A })).json.upload;
    const other = (await upload(await png(53, 22, { noise: true }), { gid: B })).json.upload;
    assert.throws(() => h.uploads.publicUrl(A, own.ref), (e) => e instanceof FlowError && /public address/.test(e.message), 'localhost cannot be reached by Discord');

    const pub = await startHarness({ config: { baseUrl: 'https://bot.example.com' } });
    try {
      const mine = (await pub.call('POST', `/api/guilds/${A}/uploads`, { raw: await png(54, 22, { noise: true }), type: 'image/png', origin: 'https://bot.example.com' })).json.upload;
      const theirs = (await pub.call('POST', `/api/guilds/${B}/uploads`, { raw: await png(55, 22, { noise: true }), type: 'image/png', origin: 'https://bot.example.com' })).json.upload;
      assert.equal(pub.uploads.publicUrl(A, mine.ref), `https://bot.example.com/i/${A}/${mine.id}.webp`);
      assert.throws(() => pub.uploads.publicUrl(A, theirs.ref), (e) => e instanceof FlowError && /no longer exists in this server/.test(e.message), 'another server\'s image');
      for (const bad of ['upload:', 'upload:short', `upload:${mine.id}x`, 'upload:../../x', 'https://x.example/a.png', '']) {
        assert.throws(() => pub.uploads.publicUrl(A, bad), (e) => e instanceof FlowError && /not a valid uploaded image/.test(e.message), bad);
      }
    } finally { await pub.close(); }
    assert.ok(own && other);
  });

  it('knows which addresses the outside world can reach', () => {
    for (const ok of ['https://bot.example.com', 'http://bot.example.com:8080', 'https://8.8.8.8', 'https://172.32.0.1', 'https://[2606:4700::1]']) assert.equal(isPublicBase(ok), true, ok);
    for (const no of ['http://localhost:3000', 'http://127.0.0.1', 'http://0.0.0.0', 'http://10.1.2.3', 'http://192.168.1.5', 'http://172.16.0.1', 'http://172.31.255.255', 'http://169.254.1.1', 'http://100.64.0.1',
      'http://bot', 'http://bot.local', 'http://x.localhost', 'http://nas.lan', 'http://[::1]:3000', 'http://[fd00::1]', 'ftp://bot.example.com', 'not a url', '']) assert.equal(isPublicBase(no), false, no);
  });
});

describe('pages using uploaded pictures', () => {
  const imageBlock = (url, id = 'img1') => ({ id, type: 'image', data: { ...defaultBlockData('image'), url, alt: 'A cat' } });
  const heroBlock = (imageUrl) => ({ id: 'hero1', type: 'hero', data: { ...defaultBlockData('hero'), title: 'Hello', imageUrl } });
  const publish = (slug, blocks, guildId = A) => h.db.createPage({ guildId, slug, title: 'Gallery', theme: {}, blocks, published: true });

  it('a public page shows the picture from this site, under the strict page policy', async () => {
    const u = (await upload(await png(56, 22, { noise: true }), { name: 'gallery.png' })).json.upload;
    publish('gallery', [heroBlock(u.ref), imageBlock(u.ref)]);
    const r = await call('GET', `/s/${A}/gallery`, { sid: null });
    assert.equal(r.status, 200);
    const csp = r.res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src 'self' https: data:/);
    assert.doesNotMatch(csp, /script-src|unsafe-eval/);
    assert.ok(r.text.includes(`<img class="hero-bg" src="/i/${A}/${u.id}.webp"`));
    assert.ok(r.text.includes(`<img src="/i/${A}/${u.id}.webp" alt="A cat"`));
    assertInert(r.text);
    const file = await rawGet(`/i/${A}/${u.id}.webp`);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/webp');
  });

  it('a reference to another server\'s picture shows nothing there: the file is only ever found under its own server', async () => {
    const theirs = (await upload(await png(57, 22, { noise: true }), { gid: B })).json.upload;
    const mine = publish('borrowed', [imageBlock(theirs.ref)]);
    const r = await call('GET', `/s/${A}/borrowed`, { sid: null });
    const src = /<img src="([^"]+)"/.exec(r.text)?.[1];
    assert.equal(src, `/i/${A}/${theirs.id}.webp`, 'the address is built from the page\'s own server');
    assert.equal((await rawGet(src)).status, 404);
    const warned = (await call('GET', `/api/guilds/${A}/pages/${mine.id}`)).json.page.issues;
    assert.deepEqual(warned.map((i) => [i.kind, i.level]), [['image', 'warning']]);
  });

  it('the dashboard warns about a picture deleted after it was chosen, without unpublishing the page', async () => {
    const u = (await upload(await png(58, 22, { noise: true }))).json.upload;
    const created = (await call('POST', `/api/guilds/${A}/pages`, { body: { templateId: 'blank', title: 'Warn me' } })).json.page;
    const saved = await call('PUT', `/api/guilds/${A}/pages/${created.id}`, { body: { published: true, blocks: [imageBlock(u.ref)] } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.page.published, true);
    assert.deepEqual(saved.json.page.issues, []);
    assert.equal((await call('DELETE', `/api/guilds/${A}/uploads/${u.id}`)).status, 200);
    const after = (await call('GET', `/api/guilds/${A}/pages/${created.id}`)).json.page;
    assert.equal(after.published, true, 'deleting a picture never takes a page offline');
    assert.deepEqual(after.issues.map((i) => [i.kind, i.level, i.blockId]), [['image', 'warning', 'img1']]);
    assert.equal((await call('GET', `/api/guilds/${A}/pages`)).json.find((p) => p.id === created.id).issues, 1);
  });

  it('a mangled reference is a real problem: the page is saved but switched off', async () => {
    const created = (await call('POST', `/api/guilds/${A}/pages`, { body: { templateId: 'blank', title: 'Mangled' } })).json.page;
    const saved = await call('PUT', `/api/guilds/${A}/pages/${created.id}`, { body: { published: true, blocks: [imageBlock('upload:not-a-real-id')] } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.unpublished, true);
    assert.equal(saved.json.page.published, false);
    assert.match(saved.json.page.issues[0].message, /not a valid uploaded image/);
  });
});

function db() { return h.db; }
