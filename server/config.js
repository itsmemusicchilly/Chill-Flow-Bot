export class ConfigError extends Error {}

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
    sessionTtlMs: 7 * 24 * 3600 * 1000,
  };
}
