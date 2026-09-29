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
  pagesPerGuild: 'LIMIT_PAGES_PER_GUILD',
  blocksPerPage: 'LIMIT_BLOCKS_PER_PAGE',
  responsesPerGuild: 'LIMIT_RESPONSES_PER_GUILD',
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
    sessionTtlMs: 7 * 24 * 3600 * 1000,
  };
}
