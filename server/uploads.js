// Uploaded pictures: the admin-only API (mounted inside the per-server router) and the public file route /i/<serverId>/<id>.webp.
//
// Everything stored here went through server/images.js, so it is a WebP that we encoded ourselves. Files live in
// DATA_DIR/uploads/<serverId>/<id>.webp; the database row is what makes an image exist, and every lookup is scoped by server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { isCapped, LIMITS } from '../shared/limits.js';
import { GUILD_ID_RE, UPLOAD_ID_RE, uploadIdOf, uploadPath, uploadRef } from '../shared/urls.js';
import { uid } from '../shared/util.js';
import { HttpError } from './api.js';
import { FlowError } from './engine/errors.js';
import { RateLimiter } from './engine/rate-limit.js';
import { IMAGE_LIMITS, ImageError, processImage } from './images.js';

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const FILE_RE = /^([a-z0-9]{16})\.webp$/;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mb = (n) => `${Math.round((n / 1048576) * 10) / 10} MB`;

const hidden = (ch) => {
  const c = ch.codePointAt(0);
  return c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069); // control, line-separator and bidi-override characters
};

/** The label shown in the image library. Never used in a path or a header: only printable text, at most 100 characters. */
export function cleanName(header) {
  let s = String(header ?? '');
  try { s = decodeURIComponent(s); } catch { /* not encoded: use as is */ }
  s = Array.from(s).filter((ch) => !hidden(ch)).join('').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 100).join('') || 'image';
}

/** Can Discord reach this address? Localhost, private ranges and one-word hosts cannot be fetched from outside. */
export function isPublicBase(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|test)$/.test(host)) return false;
  if (host.includes(':')) return !(host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe80:/.test(host)); // IPv6
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  return host.includes('.');
}

export function createUploads({ config, db, logger }) {
  const root = path.resolve(config.dataDir ?? 'data', 'uploads');
  const tmpDir = path.join(root, '.tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true }); // leftovers of an upload that was interrupted by a restart (folders are made on first use)

  const rate = { perUser: 30, views: 1200, ...config.uploadRate }; // `uploadRate` exists only so tests can tune this
  const uploadsByUser = new RateLimiter(rate.perUser, 60_000);
  const views = new RateLimiter(rate.views, 60_000);
  const publicBase = isPublicBase(config.baseUrl);

  /** Built only from ids that already matched their patterns; the prefix check is a second, independent guard. */
  function fileFor(guildId, id) {
    if (!GUILD_ID_RE.test(guildId) || !UPLOAD_ID_RE.test(id)) throw new Error('Invalid image id.');
    const file = path.resolve(root, guildId, `${id}.webp`);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Invalid image path.');
    return file;
  }

  const present = (u) => ({
    id: u.id, name: u.name, bytes: u.bytes, width: u.width, height: u.height, animated: u.animated, createdAt: u.createdAt,
    ref: uploadRef(u.id), url: uploadPath(u.guildId, u.id),
  });

  /** A reason this server may not add `addBytes` more, or null. Cheap, so it runs before *and* right after processing. */
  function capProblem(guildId, addBytes = 0) {
    const use = db.uploadUsage(guildId);
    if (isCapped(LIMITS.uploadsPerGuild) && use.count >= LIMITS.uploadsPerGuild) return `A server can have at most ${LIMITS.uploadsPerGuild} uploaded images. Delete one first.`;
    if (isCapped(LIMITS.storageBytesPerGuild) && use.bytes + addBytes > LIMITS.storageBytesPerGuild) return `This server's image storage is full (${mb(LIMITS.storageBytesPerGuild)}). Delete some images first.`;
    return null;
  }

  const maxBytes = () => Math.min(IMAGE_LIMITS.maxInputBytes, isCapped(LIMITS.uploadBytes) ? LIMITS.uploadBytes : Infinity);

  // ---- dashboard API: /api/guilds/:gid/uploads (the caller is already a checked admin of :gid) ---------------------------
  const api = express.Router({ mergeParams: true });

  api.get('/', (req, res) => {
    const { gid } = req.params;
    const uses = db.uploadUses(gid);
    res.json({
      uploads: db.listUploads(gid).map((u) => ({ ...present(u), uses: uses.get(u.id) ?? { pages: [], flows: [] } })),
      usage: db.uploadUsage(gid),
    });
  });

  const readBody = (req, res, next) => express.raw({ type: TYPES, limit: maxBytes() })(req, res, (err) => {
    if (err?.type === 'entity.too.large') return next(new HttpError(413, `That file is too large (the most this server takes is ${mb(maxBytes())}).`));
    return next(err);
  });

  // Rate-limited before the body is read, so a flood of big uploads cannot even make the server read them.
  const throttle = (req, _res, next) => (uploadsByUser.take(req.session.userId) ? next() : next(new HttpError(429, 'You are uploading too fast. Wait a moment and try again.')));

  api.post('/', throttle, readBody, async (req, res) => {
    const { gid } = req.params;
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Choose a PNG, JPEG, WebP or GIF picture.');
    const input = req.body;
    const hash = sha256(input);

    const again = db.getUploadByHash(gid, hash); // the same file twice: reuse the first copy
    if (again) return res.json({ upload: present(again), duplicate: true });
    const full = capProblem(gid);
    if (full) throw new HttpError(409, full);

    let image;
    try { image = await processImage(input); } catch (err) {
      if (err instanceof ImageError) throw new HttpError(err.status, err.message);
      throw err;
    }

    // The heavy part is done. From here the checks, the rename and the insert follow each other without a pause, so two
    // uploads cannot both squeeze under a cap, and no image exists without both its file and its row.
    const tmp = path.join(tmpDir, `${uid(16)}.webp`);
    try {
      await fs.promises.mkdir(tmpDir, { recursive: true });
      await fs.promises.writeFile(tmp, image.data, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'ENOSPC') throw new HttpError(507, 'The server is out of disk space.');
      throw err;
    }
    let row;
    let dest;
    try {
      const raced = db.getUploadByHash(gid, hash);
      if (raced) { fs.rmSync(tmp, { force: true }); return res.json({ upload: present(raced), duplicate: true }); }
      const problem = capProblem(gid, image.data.length);
      if (problem) throw new HttpError(409, problem);
      row = db.addUpload({
        guildId: gid, name: cleanName(req.headers['x-filename']), bytes: image.data.length, width: image.width, height: image.height,
        animated: image.animated, sha256: hash, createdBy: { id: req.session.userId, name: req.session.data.user.name },
      });
      dest = fileFor(gid, row.id);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(tmp, dest);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      if (row) db.deleteUpload(gid, row.id);
      if (err.code === 'ENOSPC') throw new HttpError(507, 'The server is out of disk space.');
      throw err;
    }
    logger.log(gid, 'info', `Image “${row.name}” (${mb(row.bytes)}) was uploaded by ${req.session.data.user.name}.`);
    return res.status(201).json({ upload: present(row) });
  });

  api.delete('/:id', (req, res) => {
    const { gid, id } = req.params;
    const row = UPLOAD_ID_RE.test(id) ? db.getUpload(gid, id) : null; // filtered by server: another server's id is simply not found
    if (!row) throw new HttpError(404, 'Image not found.');
    const uses = db.uploadUses(gid).get(id) ?? { pages: [], flows: [] };
    db.deleteUpload(gid, id);
    fs.rmSync(fileFor(gid, id), { force: true });
    logger.log(gid, 'info', `Image “${row.name}” was deleted by ${req.session.data.user.name}.`);
    res.json({ ok: true, uses });
  });

  // ---- public files: /i/<serverId>/<id>.webp — no cookies, no session, read-only ----------------------------------------
  const files = express.Router();
  const send404 = (res) => res.status(404).set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }).send('Not found.');

  files.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin', // pages, Discord and other sites are meant to show these
    });
    next();
  });

  files.get('/:gid/:file', (req, res, next) => {
    if (!views.take(req.ip)) return res.status(429).set('Cache-Control', 'no-store').type('text/plain').send('Too many requests. Please slow down.');
    const { gid } = req.params;
    const id = FILE_RE.exec(req.params.file)?.[1];
    const row = id && GUILD_ID_RE.test(gid) ? db.getUpload(gid, id) : null; // unknown, deleted and other-server ids look the same
    if (!row) return send404(res);

    // The bytes behind an id never change, so browsers and Discord's proxy may keep them for a year.
    const etag = `"${row.sha256.slice(0, 32)}"`;
    res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag, 'Content-Type': 'image/webp' });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.sendFile(`${gid}/${id}.webp`, { root, dotfiles: 'deny', etag: false, lastModified: false, cacheControl: false, headers: {} }, (err) => {
      if (!err) return undefined;
      if (err.code === 'ENOENT') { logger.log(gid, 'warn', `The file of image “${row.name}” is missing on disk.`); return send404(res); }
      return res.headersSent ? undefined : next(err);
    });
  });
  files.use((_req, res) => send404(res)); // anything else under /i (a bare folder, another method, …) is the same 404

  /**
   * What a flow puts into a message embed for `upload:<id>`: an absolute address Discord can download. Fails with a
   * message the flow's author can act on. Only this server's own images resolve.
   */
  function publicUrl(guildId, value) {
    const id = uploadIdOf(value);
    if (!id) throw new FlowError(`“${String(value).slice(0, 40)}” is not a valid uploaded image. Pick one again, or use an https link.`);
    if (!db.getUpload(guildId, id)) throw new FlowError('That uploaded image no longer exists in this server. Pick another one.');
    if (!publicBase) throw new FlowError('Uploaded images can only be shown in messages when BASE_URL is a public address (for example https://bot.example.com), because Discord has to download the picture.');
    return `${config.baseUrl}${uploadPath(guildId, id)}`;
  }

  return { api, files, publicUrl, publicBase, root, fileFor };
}
