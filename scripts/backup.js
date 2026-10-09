// Backs up the bot's data while it is running:   npm run backup   (or: node scripts/backup.js [--keep 7] [--out folder])
//
// Each run makes one new folder with a consistent copy of the database (safe to take while the bot is running) plus the uploaded pictures and
// saved transcripts, then deletes the oldest backups beyond the newest N (default 7). Put it on a schedule (cron on Linux/macOS, Task
// Scheduler on Windows) and copy the folder somewhere else now and then — a backup on the same disk does not survive the disk.
//
// The connected Twitch / TikTok accounts' tokens are in the database, sealed with TOKEN_ENCRYPTION_KEY (or DISCORD_CLIENT_SECRET when that is
// not set): a backup restored with a different key shows those accounts as "Connect again". Nothing else is affected.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const STAMP = /^\d{8}-\d{6}$/;
const pad = (n) => String(n).padStart(2, '0');
export const stampOf = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/**
 * @param {{dataDir: string, outDir?: string, keep?: number, now?: Date}} o
 * @returns {{folder: string, removed: string[], copied: string[]}}
 */
export function runBackup({ dataDir, outDir = path.join(dataDir, 'backups'), keep = 7, now = new Date() }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a whole number, 1 or more.');
  const source = path.join(dataDir, 'flowbot.sqlite');
  if (!fs.existsSync(source)) throw new Error(`There is no database at ${source}. Run this where the bot runs (or set DATA_DIR).`);
  const stamp = stampOf(now);
  const folder = path.join(outDir, stamp);
  if (fs.existsSync(folder)) throw new Error(`${folder} already exists (a backup was made this second). Try again in a moment.`);
  fs.mkdirSync(folder, { recursive: true });
  try {
    // VACUUM INTO writes a complete, consistent copy even while the bot is writing; the bot is never stopped or blocked for long
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec(`VACUUM INTO '${path.join(folder, 'flowbot.sqlite').replace(/'/g, "''")}'`);
    } finally { db.close(); }
    const copied = ['flowbot.sqlite'];
    for (const sub of ['uploads', 'transcripts']) {
      const from = path.join(dataDir, sub);
      if (fs.existsSync(from)) { fs.cpSync(from, path.join(folder, sub), { recursive: true }); copied.push(`${sub}/`); }
    }
    // keep only the newest `keep` backups (only folders named like a backup are ever touched)
    const all = fs.readdirSync(outDir, { withFileTypes: true }).filter((e) => e.isDirectory() && STAMP.test(e.name)).map((e) => e.name).sort();
    const removed = all.slice(0, Math.max(0, all.length - keep));
    for (const name of removed) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    return { folder, removed, copied };
  } catch (err) {
    fs.rmSync(folder, { recursive: true, force: true }); // never leave half a backup that looks like a whole one
    throw err;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') out.keep = Number(argv[++i]);
    else if (argv[i] === '--out') out.outDir = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    else throw new Error(`I do not know “${argv[i]}”. Use --keep <how many to keep> and/or --out <folder>.`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile('.env'); } catch { /* no .env file: use the real environment */ }
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('npm run backup [-- --keep 7] [-- --out /path/to/folder]\nBacks up the database, uploaded pictures and saved transcripts of the bot (DATA_DIR) into a new dated folder, and keeps the newest 7.');
    } else {
      const result = runBackup({ dataDir: path.resolve(process.env.DATA_DIR || 'data'), ...(args.keep !== undefined ? { keep: args.keep } : {}), ...(args.outDir ? { outDir: args.outDir } : {}) });
      console.log(`Backup saved: ${result.folder}\n  contains: ${result.copied.join(', ')}`);
      if (result.removed.length) console.log(`  removed ${result.removed.length} older backup${result.removed.length === 1 ? '' : 's'}: ${result.removed.join(', ')}`);
      console.log('Copy it to another disk or computer now and then. Connected Twitch/TikTok accounts need the same TOKEN_ENCRYPTION_KEY (or DISCORD_CLIENT_SECRET) when restored.');
    }
  } catch (err) {
    console.error(`Backup failed: ${err.message}`);
    process.exit(1);
  }
}
