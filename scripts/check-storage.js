// Tries the storage you configured, for real:   npm run check-storage   (or: node scripts/check-storage.js [--piece-kb 192])
//
// With MongoDB, Firebase or Cloudflare D1 as the storage, the bot keeps its rows, pictures and saved transcripts in that database. This connects
// with the keys in your .env, writes test files of several sizes, reads each one back and checks it is identical, deletes them, and says what
// worked and how fast. It needs no Discord settings and leaves nothing behind. If the database refuses the default piece size (some services are
// stricter than their documentation suggests), it tries smaller ones and tells you which DB_FILE_PIECE_KB to set.
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { databaseSettings, DEFAULT_PIECE_KB, MIN_PIECE_KB, pieceKbOf } from '../server/config.js';
import { openRemoteDatabase } from '../server/db/remote.js';
import { createDatabaseFiles } from '../server/files.js';

const KB = 1024;
export const TEST_SIZES = [1 * KB, 100 * KB, 192 * KB, 600 * KB, 2 * 1024 * KB];
const label = (bytes) => (bytes >= 1024 * KB ? `${bytes / (1024 * KB)} MB` : `${Math.round(bytes / KB)} KB`);
const ms = (t) => `${Math.round(t)} ms`;
const short = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 300);

const HINTS = {
  mongodb: 'MongoDB: check MONGODB_URI (user, password), and on Atlas that “Network Access” allows this computer’s address.',
  firebase: 'Firebase: check the service account, and that Firestore is created in the project (Native mode) and the account may read and write it.',
  cloudflare: 'Cloudflare D1: check the account id, database id, and that the API token may edit D1.',
};

/** The piece sizes to try, biggest first: the one asked for, then half of it, and so on down to the smallest the bot allows. */
export function piecesToTry(startKb) {
  const out = [];
  for (let kb = startKb; kb >= MIN_PIECE_KB; kb = Math.floor(kb / 2)) out.push(kb);
  if (out.at(-1) !== MIN_PIECE_KB && startKb > MIN_PIECE_KB) out.push(MIN_PIECE_KB);
  return out;
}

/** One full pass with one piece size. Returns `{ ok }`, or `{ ok: false, size, step, error }` for the first thing that went wrong. */
async function pass({ db, kb, runId, sizes, log }) {
  const files = createDatabaseFiles({ db, cacheBytes: 0, chunkBytes: kb * KB }); // no memory: every read really goes to the database
  const guildId = `check-${runId}`;
  const made = [];
  let current = null;
  try {
    for (const size of sizes) {
      const data = crypto.randomBytes(size);
      const id = `file${size}`;
      current = { size, step: 'write' };
      made.push(id);
      let t = performance.now();
      files.write('pictures', guildId, id, data);
      const wrote = performance.now() - t;
      current.step = 'read';
      t = performance.now();
      const back = await files.read('pictures', guildId, id);
      const read = performance.now() - t;
      if (!back) throw new Error('it was written, but could not be read back');
      if (!back.equals(data)) throw new Error('it was read back, but it is different from what was written');
      current.step = 'remove';
      files.remove('pictures', guildId, id);
      if (db.getFileManifest(guildId, 'pictures', id) || await files.read('pictures', guildId, id)) throw new Error('it was removed, but it is still there');
      const pieces = Math.max(1, Math.ceil(size / (kb * KB)));
      log(`  ✓ ${label(size).padStart(6)} file (${pieces} piece${pieces === 1 ? '' : 's'}): write ${ms(wrote)}, read ${ms(read)}, identical, removed`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, ...(current ?? { size: 0, step: 'start' }), error: short(err) };
  } finally {
    for (const id of made) { try { db.deleteFile(guildId, 'pictures', id); } catch { /* nothing more to do */ } }
  }
}

/**
 * @param {{db: object, driver?: string, startKb?: number, sizes?: number[], log?: (line: string) => void}} o   `db` is the open (synchronous) cloud database.
 * @returns {Promise<{ok: boolean, workingKb: number|null, configuredKb: number}>} `ok` only when the piece size asked for works.
 */
export async function checkStorage({ db, driver = '', startKb = DEFAULT_PIECE_KB, sizes = TEST_SIZES, log = console.log }) {
  const runId = crypto.randomBytes(5).toString('hex');
  // plain rows first: if these fail the keys or the network are wrong, which is a different problem from file sizes
  let t = performance.now();
  try {
    db.setVar(`check-${runId}`, 'guild', '', 'ping', { n: 1 });
    if (db.getVar(`check-${runId}`, 'guild', '', 'ping')?.n !== 1) throw new Error('a value was written but not read back');
    db.deleteVarsForScope(`check-${runId}`, 'guild', '');
  } catch (err) {
    log(`  ✗ a small value could not be written and read back: ${short(err)}`);
    if (HINTS[driver]) log(`    ${HINTS[driver]}`);
    return { ok: false, workingKb: null, configuredKb: startKb };
  }
  log(`  ✓ a small value: written, read back, deleted (${ms(performance.now() - t)})`);

  let first = true;
  for (const kb of piecesToTry(startKb)) {
    log(first ? `\nFiles, in pieces of ${kb} KB:` : `\nTrying smaller pieces of ${kb} KB:`);
    const result = await pass({ db, kb, runId, sizes, log });
    if (result.ok) return { ok: first, workingKb: kb, configuredKb: startKb };
    log(`  ✗ a ${label(result.size)} file failed at "${result.step}": ${result.error}`);
    first = false;
  }
  return { ok: false, workingKb: null, configuredKb: startKb };
}

/** What to tell the user about a finished check, and the exit code to end with. */
export function verdict(result, storage) {
  if (result.ok) {
    return { code: 0, text: `All good. Pictures and saved transcripts will be kept in ${storage} in pieces of ${result.configuredKb} KB (the largest single item stored is about ${Math.ceil(result.configuredKb * 4 / 3)} KB). The test files are deleted.` };
  }
  if (result.workingKb) {
    return { code: 1, text: `${storage} refused pieces of ${result.configuredKb} KB but accepts ${result.workingKb} KB.\nAdd this line to .env (or your host's settings) and run the check again:\n\n  DB_FILE_PIECE_KB=${result.workingKb}\n` };
  }
  return { code: 1, text: `${storage} did not accept the test files, even in the smallest pieces. Pictures and saved transcripts cannot be stored there until the problem above is fixed.` };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--piece-kb') out.pieceKb = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    else throw new Error(`I do not know “${argv[i]}”. Use --piece-kb <size in KB> to try a particular piece size.`);
  }
  return out;
}

async function main() {
  try { process.loadEnvFile('.env'); } catch { /* no .env file: use the real environment */ }
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('npm run check-storage [-- --piece-kb 192]\nConnects to the MongoDB / Firebase / Cloudflare D1 database set in .env, stores test files of several sizes, checks them and deletes them.');
    return 0;
  }
  const settings = databaseSettings(process.env);
  if (settings.driver === 'sqlite') {
    console.log('Nothing to check: this bot uses the local database (a file in DATA_DIR), which keeps pictures and transcripts as ordinary files.\nTo check a cloud database, put its keys in .env first (MONGODB_URI, the FIREBASE_… values, or the CLOUDFLARE_… values).');
    return 0;
  }
  const startKb = args.pieceKb ?? pieceKbOf(process.env);
  if (!Number.isInteger(startKb) || startKb < MIN_PIECE_KB) throw new Error(`--piece-kb must be a whole number, ${MIN_PIECE_KB} or more.`);
  console.log(`Checking the storage: ${settings.label}`);
  const began = performance.now();
  let db;
  try { db = openRemoteDatabase(settings); } catch (err) {
    console.log(`  ✗ could not connect: ${short(err)}`);
    console.log(`    ${HINTS[settings.driver]}`);
    return 1;
  }
  console.log(`  ✓ connected (${ms(performance.now() - began)})`);
  try {
    const result = await checkStorage({ db, driver: settings.driver, startKb });
    const { code, text } = verdict(result, settings.label);
    console.log(`\n${text}`);
    return code;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (err) => { console.error(`Check failed: ${err.message}`); process.exit(1); });
}
