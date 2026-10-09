// Saved transcripts: the web page a Save Transcript node can link to (public route /t/<id>), and how long the server keeps it.
//
// The page is the same standalone HTML the node can attach as a file. It lives in DATA_DIR/transcripts/<serverId>/<id>.html — or, when the bot's
// storage is MongoDB, Firebase or Cloudflare D1 (no lasting disk), in that database (`files`, see server/files.js); the
// database row is what makes a transcript exist. The id in the link is the only secret, so a miss never says why: a wrong id, a
// deleted transcript and an expired one all get the same page.
//
// Keeping: TRANSCRIPT_RETENTION_DAYS (0 = forever). It is measured from when the transcript was saved, at the moment of asking, so
// changing the setting later applies to transcripts that are already stored, and a page past its time is refused even before the
// hourly clean-up has removed it.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { GUILD_ID_RE, TRANSCRIPT_ID_RE, transcriptPath } from '../shared/urls.js';
import { uid } from '../shared/util.js';
import { FlowError } from './engine/errors.js';
import { RateLimiter } from './engine/rate-limit.js';
import { isPublicBase } from './uploads.js';

const DAY_MS = 86_400_000;
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

const MISSING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Transcript not available</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f3f5;color:#2e3338;font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;margin:1rem;padding:1.5rem 1.75rem;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
h1{margin:0 0 .5rem;font-size:1.25rem}p{margin:0;color:#4f5660}
@media (prefers-color-scheme:dark){body{background:#1e1f22;color:#f2f3f5}main{background:#2b2d31}p{color:#b5bac1}}</style></head>
<body><main><h1>This transcript isn't available</h1><p>The link may be wrong, or the transcript may have been deleted or may have expired.</p></main></body></html>
`;

export function createTranscripts({ config, db, logger, now = () => Date.now(), files: kept = null }) {
  const root = path.resolve(config.dataDir ?? 'data', 'transcripts');
  const tmpDir = path.join(root, '.tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true }); // leftovers of a save that was interrupted by a restart (folders are made on first use)

  const retentionDays = config.transcriptRetentionDays ?? 0;
  const retentionMs = retentionDays * DAY_MS;
  const publicBase = isPublicBase(config.baseUrl);
  const views = new RateLimiter({ views: 600, ...config.transcriptRate }.views, 60_000); // `transcriptRate` exists only so tests can tune this

  /** Built only from ids that already matched their patterns; the prefix check is a second, independent guard. */
  function fileFor(guildId, id) {
    if (!GUILD_ID_RE.test(guildId) || !TRANSCRIPT_ID_RE.test(id)) throw new Error('Invalid transcript id.');
    const file = path.resolve(root, guildId, `${id}.html`);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Invalid transcript path.');
    return file;
  }

  const expired = (row) => retentionMs > 0 && row.createdAt < now() - retentionMs;
  const expiresAt = (row) => (retentionMs > 0 ? new Date(row.createdAt + retentionMs).toISOString() : '');

  /** Fails with a message the flow's author can act on when people outside this machine could not open a link anyway. */
  function assertPublic() {
    if (!publicBase) throw new FlowError('A transcript link needs BASE_URL to be a public address (for example https://bot.example.com): people outside this machine could not open it.');
  }

  /** Stores the finished transcript (`doc` is what createTranscript().finish() returns) and gives back its public address. */
  function save(guildId, doc) {
    assertPublic();
    if (kept) {
      let stored;
      try {
        stored = db.addTranscript({ guildId, name: doc.name, messages: doc.messages, bytes: doc.bytes, truncated: doc.truncated, now: now() });
        kept.write('transcripts', guildId, stored.id, doc.buffer);
      } catch (err) { // no transcript exists without both its page and its row
        if (stored) db.deleteTranscript(stored.id);
        logger.log(guildId, 'error', `A transcript could not be stored in the database: ${err.message}`);
        throw new FlowError('The database did not accept the transcript (it may be full or unreachable), so no link was made. See the server log.');
      }
      return { id: stored.id, url: `${config.baseUrl}${transcriptPath(stored.id)}`, createdAt: stored.createdAt, expiresAt: expiresAt(stored) };
    }
    const tmp = path.join(tmpDir, `${uid(16)}.html`);
    fs.mkdirSync(tmpDir, { recursive: true });
    let row;
    try {
      fs.writeFileSync(tmp, doc.buffer, { flag: 'wx' });
      row = db.addTranscript({ guildId, name: doc.name, messages: doc.messages, bytes: doc.bytes, truncated: doc.truncated, now: now() });
      const dest = fileFor(guildId, row.id);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(tmp, dest);
    } catch (err) { // no transcript exists without both its file and its row
      fs.rmSync(tmp, { force: true });
      if (row) db.deleteTranscript(row.id);
      if (err.code === 'ENOSPC') throw new FlowError('The server is out of disk space, so the transcript could not be saved for a link.');
      throw err;
    }
    return { id: row.id, url: `${config.baseUrl}${transcriptPath(row.id)}`, createdAt: row.createdAt, expiresAt: expiresAt(row) };
  }

  /** Deletes one transcript (file first, then the row). Used to undo a save when the message that was to carry the link failed. */
  function remove(id) {
    const row = TRANSCRIPT_ID_RE.test(String(id)) ? db.getTranscript(id) : null;
    if (!row) return false;
    if (kept) kept.remove('transcripts', row.guildId, row.id);
    else fs.rmSync(fileFor(row.guildId, row.id), { force: true });
    return db.deleteTranscript(row.id);
  }

  /** Deletes what is past its retention time. The file goes first, so a file that cannot be deleted keeps its row and is tried again next time. */
  function prune() {
    if (retentionMs <= 0) return 0;
    const gone = new Map();
    for (const row of db.transcriptsBefore(now() - retentionMs)) {
      try {
        if (kept) kept.remove('transcripts', row.guildId, row.id);
        else fs.rmSync(fileFor(row.guildId, row.id), { force: true });
        db.deleteTranscript(row.id);
        gone.set(row.guildId, (gone.get(row.guildId) ?? 0) + 1);
      } catch (err) {
        logger.log(row.guildId, 'warn', `Could not delete the saved transcript “${row.name}”: ${err.message}`);
      }
    }
    for (const [guildId, n] of gone) logger.log(guildId, 'info', `Deleted ${n} saved transcript${n === 1 ? '' : 's'} older than ${retentionDays} day${retentionDays === 1 ? '' : 's'}.`);
    return [...gone.values()].reduce((a, b) => a + b, 0);
  }

  // ---- public page: /t/<id> — no cookies, no session, read-only ------------------------------------------------------------
  const files = express.Router();
  const missing = (res) => res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(MISSING_PAGE);

  files.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store',
    });
    next();
  });

  files.get('/:id', (req, res, next) => {
    if (!views.take(req.ip)) return res.status(429).type('text').send('Too many requests. Please slow down.');
    const { id } = req.params;
    const row = TRANSCRIPT_ID_RE.test(id) ? db.getTranscript(id) : null;
    if (!row || expired(row)) return missing(res);
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (kept) {
      return kept.read('transcripts', row.guildId, row.id).then((page) => {
        if (!page) { logger.log(row.guildId, 'warn', `The page of the saved transcript “${row.name}” is missing in the database.`); return missing(res); }
        return res.send(page);
      }, next);
    }
    return res.sendFile(`${row.guildId}/${row.id}.html`, { root, dotfiles: 'deny', etag: false, lastModified: false, cacheControl: false, headers: {} }, (err) => {
      if (!err) return undefined;
      if (err.code === 'ENOENT') { logger.log(row.guildId, 'warn', `The page of the saved transcript “${row.name}” is missing on disk.`); return missing(res); }
      return res.headersSent ? undefined : next(err);
    });
  });
  files.use((_req, res) => missing(res)); // anything else under /t (a bare folder, another method, …) is the same page

  return { files, save, remove, prune, assertPublic, publicBase, retentionDays, root, fileFor };
}
