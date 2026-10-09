import { parseLimit } from '../shared/limits.js';

export class ConfigError extends Error {}

/** Every limit is unlimited unless one of these variables caps it (a number, or "unlimited"). */
export const LIMIT_ENV = {
  flowsPerGuild: 'LIMIT_FLOWS_PER_GUILD',
  nodesPerFlow: 'LIMIT_NODES_PER_FLOW',
  edgesPerFlow: 'LIMIT_EDGES_PER_FLOW',
  nodeDataBytes: 'LIMIT_NODE_DATA_BYTES',
  graphBytes: 'LIMIT_GRAPH_BYTES',
  varsPerGuild: 'LIMIT_VARS_PER_GUILD',
  varValueBytes: 'LIMIT_VAR_VALUE_BYTES',
  runsPer10s: 'LIMIT_RUNS_PER_10S',
  concurrentRuns: 'LIMIT_CONCURRENT_RUNS',
  actionsPer10s: 'LIMIT_ACTIONS_PER_10S',
  stepsPerRun: 'LIMIT_STEPS_PER_RUN',
  loopIterations: 'LIMIT_LOOP_ITERATIONS',
  waitSeconds: 'LIMIT_WAIT_SECONDS',
  componentStateDays: 'LIMIT_COMPONENT_STATE_DAYS',
  pagesPerGuild: 'LIMIT_PAGES_PER_GUILD',
  blocksPerPage: 'LIMIT_BLOCKS_PER_PAGE',
  responsesPerGuild: 'LIMIT_RESPONSES_PER_GUILD',
  uploadBytes: 'LIMIT_UPLOAD_BYTES',
  uploadsPerGuild: 'LIMIT_UPLOADS_PER_GUILD',
  storageBytesPerGuild: 'LIMIT_STORAGE_BYTES_PER_GUILD',
  transcriptMessages: 'LIMIT_TRANSCRIPT_MESSAGES',
  feedsPerGuild: 'LIMIT_FEEDS_PER_GUILD',
  webhookBytes: 'LIMIT_WEBHOOK_BYTES',
  webhooksPerMinute: 'LIMIT_WEBHOOKS_PER_MINUTE',
};
const DEFAULT_REQUEST_BYTES = 50 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 ** 3;

function readLimits(env) {
  const limits = {};
  for (const [key, name] of Object.entries(LIMIT_ENV)) {
    const parsed = parseLimit(env[name]);
    if (parsed === undefined) continue;
    if (Number.isNaN(parsed)) throw new ConfigError(`${name} must be a positive whole number or "unlimited" (got "${env[name]}").`);
    limits[key] = parsed;
  }
  let requestBytes = DEFAULT_REQUEST_BYTES;
  const raw = parseLimit(env.LIMIT_REQUEST_BYTES);
  if (Number.isNaN(raw)) throw new ConfigError(`LIMIT_REQUEST_BYTES must be a positive whole number or "unlimited" (got "${env.LIMIT_REQUEST_BYTES}").`);
  if (raw !== undefined) requestBytes = Math.min(Number.isFinite(raw) ? raw : MAX_REQUEST_BYTES, MAX_REQUEST_BYTES); // a physical ceiling always remains
  return { limits, requestBytes };
}

const flag = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

export function loadConfig(env = process.env) {
  const missing = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'].filter((k) => !env[k]);
  if (missing.length) {
    throw new ConfigError(`Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in (see README).`);
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('PORT must be a number between 1 and 65535.');
  const baseUrl = String(env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  try { new URL(baseUrl); } catch { throw new ConfigError('BASE_URL must be a full URL such as https://bot.example.com'); }
  const minPermission = env.DASHBOARD_MIN_PERMISSION || 'Administrator';
  if (!['Administrator', 'ManageGuild'].includes(minPermission)) throw new ConfigError('DASHBOARD_MIN_PERMISSION must be Administrator or ManageGuild.');
  const { limits, requestBytes } = readLimits(env);
  const feedMinMinutes = env.FEED_MIN_INTERVAL_MINUTES === undefined || env.FEED_MIN_INTERVAL_MINUTES === '' ? 5 : Number(env.FEED_MIN_INTERVAL_MINUTES);
  if (!Number.isInteger(feedMinMinutes) || feedMinMinutes < 1) throw new ConfigError('FEED_MIN_INTERVAL_MINUTES must be a whole number of minutes, 1 or more (default 5).');
  const transcriptRetentionDays = env.TRANSCRIPT_RETENTION_DAYS === undefined || String(env.TRANSCRIPT_RETENTION_DAYS).trim() === '' ? 0 : Number(env.TRANSCRIPT_RETENTION_DAYS);
  if (!Number.isInteger(transcriptRetentionDays) || transcriptRetentionDays < 0 || transcriptRetentionDays > 3650) {
    throw new ConfigError('TRANSCRIPT_RETENTION_DAYS must be a whole number of days from 0 to 3650 (0 keeps saved transcripts forever, which is the default).');
  }
  const tokenKey = String(env.TOKEN_ENCRYPTION_KEY ?? '').trim();
  if (tokenKey && tokenKey.length < 16) throw new ConfigError('TOKEN_ENCRYPTION_KEY must be at least 16 characters (a long random string; leave it out to use DISCORD_CLIENT_SECRET instead).');
  const database = readDatabase(env, limits);
  const filePieceKb = pieceKbOf(env);
  return {
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    baseUrl,
    port,
    host: env.HOST || '127.0.0.1',
    dataDir: env.DATA_DIR || 'data',
    trustProxy: env.TRUST_PROXY ? (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : flag(env.TRUST_PROXY)) : false,
    intents: { members: flag(env.ENABLE_MEMBERS_INTENT), messageContent: flag(env.ENABLE_MESSAGE_CONTENT_INTENT) },
    minPermission,
    limits,
    requestBytes,
    feedMinMinutes,
    transcriptRetentionDays,
    // keys for the triggers that use a platform's own API; never sent to the browser (the editor only learns whether each is set)
    integrations: {
      youtube: String(env.YOUTUBE_API_KEY ?? '').trim(),
      twitch: { clientId: String(env.TWITCH_CLIENT_ID ?? '').trim(), clientSecret: String(env.TWITCH_CLIENT_SECRET ?? '').trim() },
      tiktok: { clientKey: String(env.TIKTOK_CLIENT_KEY ?? '').trim(), clientSecret: String(env.TIKTOK_CLIENT_SECRET ?? '').trim() },
    },
    tokenKey,
    sessionTtlMs: 7 * 24 * 3600 * 1000,
    database,
    filePieceKb,
  };
}

const DRIVER_NAMES = new Map([
  ['sqlite', 'sqlite'], ['local', 'sqlite'], ['localdb', 'sqlite'],
  ['mongodb', 'mongodb'], ['mongo', 'mongodb'],
  ['firebase', 'firebase'], ['firestore', 'firebase'],
  ['cloudflare', 'cloudflare'], ['d1', 'cloudflare'],
]);

const DRIVER_LABELS = { sqlite: 'local sqlite', mongodb: 'MongoDB', firebase: 'Firebase', cloudflare: 'Cloudflare D1' };

const filled = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

/** mongodb:// and mongodb+srv:// only. An empty value means "not configured". */
function readMongo(env) {
  const uri = filled(env.MONGODB_URI);
  if (!uri) return null;
  let parsed;
  try { parsed = new URL(uri); } catch { throw new ConfigError('MONGODB_URI must be a mongodb:// or mongodb+srv:// address.'); }
  if (parsed.protocol !== 'mongodb:' && parsed.protocol !== 'mongodb+srv:') {
    throw new ConfigError('MONGODB_URI must start with mongodb:// or mongodb+srv://.');
  }
  return { uri, dbName: filled(env.MONGODB_DB) || 'chillflow' };
}

/** A service-account JSON blob, or the three fields it contains. Partial settings are an error. */
function readFirebase(env) {
  const jsonRaw = filled(env.FIREBASE_SERVICE_ACCOUNT);
  const projectId = filled(env.FIREBASE_PROJECT_ID);
  const clientEmail = filled(env.FIREBASE_CLIENT_EMAIL);
  const privateKeyRaw = filled(env.FIREBASE_PRIVATE_KEY);
  if (!jsonRaw && !projectId && !clientEmail && !privateKeyRaw) return null;
  if (jsonRaw && (projectId || clientEmail || privateKeyRaw)) {
    throw new ConfigError('Set either FIREBASE_SERVICE_ACCOUNT or the three FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY values, not both.');
  }
  const databaseId = filled(env.FIREBASE_DATABASE_ID) || '(default)';
  if (jsonRaw) {
    let parsed;
    try { parsed = JSON.parse(jsonRaw); } catch { throw new ConfigError('FIREBASE_SERVICE_ACCOUNT must be the service-account JSON on one line.'); }
    const privateKey = String(parsed.private_key || '').replace(/\\n/g, '\n');
    if (!parsed.project_id || !parsed.client_email || !privateKey.includes('BEGIN PRIVATE KEY')) {
      throw new ConfigError('FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email, or private_key.');
    }
    return { projectId: String(parsed.project_id), clientEmail: String(parsed.client_email), privateKey, databaseId };
  }
  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new ConfigError('Firebase needs FIREBASE_SERVICE_ACCOUNT, or all three of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.');
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
  if (!privateKey.includes('BEGIN PRIVATE KEY')) throw new ConfigError('FIREBASE_PRIVATE_KEY must be the PEM private key from the service account, with newlines written as \\n.');
  return { projectId, clientEmail, privateKey, databaseId };
}

/** Cloudflare D1, reached over the HTTP API. All three values or none. */
function readCloudflare(env) {
  const accountId = filled(env.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = filled(env.CLOUDFLARE_API_TOKEN);
  const databaseId = filled(env.CLOUDFLARE_D1_DATABASE_ID);
  if (!accountId && !apiToken && !databaseId) return null;
  if (!accountId || !apiToken || !databaseId) {
    throw new ConfigError('Cloudflare D1 needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and CLOUDFLARE_D1_DATABASE_ID. Leave all three unset to use the local database.');
  }
  return { accountId, apiToken, databaseId };
}

/** The database the settings in `env` choose, with its keys (without needing the Discord settings). Throws a ConfigError for a half-filled or ambiguous choice. */
export function databaseSettings(env = process.env) {
  return readDatabase(env, {});
}

/** Just which database that is: `{ driver, label }`. */
export function databaseOf(env = process.env) {
  const { driver, label } = databaseSettings(env);
  return { driver, label };
}

export const DEFAULT_PIECE_KB = 192;
export const MIN_PIECE_KB = 16;
export const MAX_PIECE_KB = 512;

/** DB_FILE_PIECE_KB: how big the pieces are that pictures and transcripts are cut into when they are kept in a cloud database. */
export function pieceKbOf(env = process.env) {
  const raw = filled(env.DB_FILE_PIECE_KB);
  const kb = raw === null ? DEFAULT_PIECE_KB : Number(raw);
  if (!Number.isInteger(kb) || kb < MIN_PIECE_KB || kb > MAX_PIECE_KB) {
    throw new ConfigError(`DB_FILE_PIECE_KB must be a whole number from ${MIN_PIECE_KB} to ${MAX_PIECE_KB} (default ${DEFAULT_PIECE_KB}). Lower it only if \`npm run check-storage\` says your database refuses the default.`);
  }
  return kb;
}

function pack(driver, extra, limits) {
  return { driver, label: DRIVER_LABELS[driver], limits, ...extra };
}

/**
 * No cloud settings (or DB_DRIVER=sqlite) keeps the local SQLite file.
 * One cloud database is used on its own. Two at once is an error unless DB_DRIVER names the one to use.
 */
function readDatabase(env, limits) {
  const raw = filled(env.DB_DRIVER);
  const chosen = raw ? DRIVER_NAMES.get(raw.toLowerCase()) : null;
  if (raw && !chosen) throw new ConfigError(`DB_DRIVER must be sqlite, mongodb, firebase or cloudflare (got "${raw}").`);
  if (chosen === 'sqlite') return pack('sqlite', {}, limits);

  const mongo = readMongo(env);
  const firebase = readFirebase(env);
  const cloudflare = readCloudflare(env);
  if (chosen === 'mongodb') {
    if (!mongo) throw new ConfigError('DB_DRIVER=mongodb needs MONGODB_URI. Leave DB_DRIVER unset to use the local database.');
    return pack('mongodb', mongo, limits);
  }
  if (chosen === 'firebase') {
    if (!firebase) throw new ConfigError('DB_DRIVER=firebase needs FIREBASE_SERVICE_ACCOUNT, or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.');
    return pack('firebase', firebase, limits);
  }
  if (chosen === 'cloudflare') {
    if (!cloudflare) throw new ConfigError('DB_DRIVER=cloudflare needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and CLOUDFLARE_D1_DATABASE_ID.');
    return pack('cloudflare', cloudflare, limits);
  }

  const provided = [mongo && 'mongodb', firebase && 'firebase', cloudflare && 'cloudflare'].filter(Boolean);
  if (provided.length > 1) {
    throw new ConfigError(`More than one database is configured (${provided.join(', ')}). Set DB_DRIVER to the one to use, or remove the others. Leave them all unset to use the local database.`);
  }
  if (mongo) return pack('mongodb', mongo, limits);
  if (firebase) return pack('firebase', firebase, limits);
  if (cloudflare) return pack('cloudflare', cloudflare, limits);
  return pack('sqlite', {}, limits);
}
