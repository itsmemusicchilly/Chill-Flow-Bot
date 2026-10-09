import { applyLimits } from '../shared/limits.js';
import { createAccounts } from './accounts.js';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Runtime } from './engine/runtime.js';
import { warmUp } from './images.js';
import { safeFetch } from './net/safe-fetch.js';
import { Logger } from './logger.js';
import { createTranscripts } from './transcripts.js';
import { createUploads } from './uploads.js';
import { createApp } from './app.js';
import { CommandSync } from './bot/commands.js';
import { BotManager } from './bot/manager.js';

try { process.loadEnvFile('.env'); } catch { /* no .env file: use the real environment */ }

let config;
try { config = loadConfig(); } catch (err) {
  if (err instanceof ConfigError) { console.error(`\n${err.message}\n`); process.exit(1); }
  throw err;
}

applyLimits(config.limits);

const logger = new Logger();
let db;
try { db = await openDatabase(config); } catch (err) {
  console.error(`\nCould not open the database: ${err.message}\n`);
  process.exit(1);
}
console.log(`Database: ${config.database.label}`);
const uploads = createUploads({ config, db, logger });
const transcripts = createTranscripts({ config, db, logger });
warmUp(); // load the image library now, so the first upload is not slow (and a missing binary shows up in the log at start)
const accounts = createAccounts({ config, db, fetch: safeFetch, logger });
const runtime = new Runtime({ db, logger, intents: config.intents, uploads, transcripts, integrations: config.integrations, feedMinMinutes: config.feedMinMinutes, accounts });
const sync = new CommandSync({ db, runtime, logger, config });
const bot = new BotManager({ config, runtime, logger, sync, accounts });
const app = createApp({ config, db, runtime, bot, sync, logger, uploads, transcripts, accounts });

const server = app.listen(config.port, config.host, () => {
  console.log(`Dashboard: ${config.baseUrl}  (listening on ${config.host}:${config.port})`);
});

bot.start().catch((err) => {
  const hint = /disallowed intents/i.test(err.message)
    ? '\nEnable “Server Members Intent” / “Message Content Intent” in the Discord Developer Portal → Bot, or turn the matching ENABLE_*_INTENT variable off.'
    : '';
  console.error(`\nCould not log the bot in: ${err.message}${hint}\n`);
  process.exit(1);
});

const housekeeping = () => {
  db.pruneSessions();
  db.pruneComponentState();
  db.pruneConnectStates();
  try { transcripts.prune(); } catch (err) { logger.log(null, 'error', `Clearing out old saved transcripts failed: ${err?.message || err}`); }
};
housekeeping();
setInterval(housekeeping, 3600_000).unref();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('Shutting down…');
  server.close();
  await bot.stop().catch(() => {});
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => logger.log(null, 'error', `Unhandled rejection: ${err?.stack || err}`));
