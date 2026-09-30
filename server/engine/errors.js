/** An error whose message is safe and useful to show to a server admin. */
export class FlowError extends Error {
  constructor(message) { super(message); this.name = 'FlowError'; }
}

/** Raised to abort a whole run (step limit, shutdown) instead of following the error handle. */
export class FlowAbort extends Error {
  constructor(message) { super(message); this.name = 'FlowAbort'; }
}

const DISCORD_HINTS = {
  50013: 'Missing permissions — give the bot that permission and keep its role above the roles/members it manages.',
  50001: 'Missing access — the bot cannot see that channel or resource.',
  50007: 'Cannot send a DM to this user (their DMs are closed).',
  10003: 'Unknown channel.',
  10007: 'Unknown member — they are not in this server.',
  10008: 'Unknown message.',
  10011: 'Unknown role.',
  10013: 'Unknown user.',
  30005: 'Maximum number of roles reached.',
  30013: 'Maximum number of channels reached.',
  50035: 'Discord rejected a value (check lengths, colors and URLs).',
  40005: 'The file is too big for Discord to accept.',
};

/** Turn any thrown value into a short message for logs and `{{error.message}}`. */
export function friendlyError(err) {
  if (err instanceof FlowError || err instanceof FlowAbort) return err.message;
  const code = err?.code;
  if (typeof code === 'number' && DISCORD_HINTS[code]) {
    const detail = code === 50035 && err.message ? ` (${String(err.message).split('\n')[0].slice(0, 200)})` : '';
    return `${DISCORD_HINTS[code]}${detail}`;
  }
  return String(err?.message || err).slice(0, 300);
}
