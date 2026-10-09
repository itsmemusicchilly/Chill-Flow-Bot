// Recent messages the bot has seen, kept in memory so a delete event (which Discord sends as an id only)
// can still fill {{message.content}}, {{user.id}} and the rest. Nothing here is written to the database.

export const MESSAGE_MEMORY_MAX = 2000;
export const MESSAGE_MEMORY_AGE_MS = 24 * 60 * 60 * 1000;

const messageUrl = (guildId, channelId, messageId) => (
  guildId && channelId && messageId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : ''
);

/** Plain fields worth keeping. A partial Discord message (no id, or no server) is ignored. */
export function snapshotFrom(message) {
  const guildId = message?.guildId ?? message?.guild?.id;
  const id = message?.id;
  if (!guildId || !id) return null;
  const channelId = message.channelId ?? message.channel?.id ?? '';
  const author = message.author;
  const attachments = [];
  const list = message.attachments?.values ? message.attachments.values() : message.attachments;
  if (list) for (const file of list) if (file?.url) attachments.push(file.url);
  let createdAt = '';
  if (typeof message.createdAt?.toISOString === 'function') createdAt = message.createdAt.toISOString();
  else if (message.createdTimestamp) createdAt = new Date(message.createdTimestamp).toISOString();
  return {
    id: String(id),
    guildId: String(guildId),
    channelId: String(channelId),
    channelName: message.channel?.name ?? '',
    content: message.content ?? '',
    url: message.url || messageUrl(guildId, channelId, id),
    createdAt,
    attachments,
    author: author?.id ? {
      id: String(author.id),
      username: author.username ?? '',
      globalName: author.globalName ?? '',
      tag: author.tag ?? author.username ?? '',
      bot: Boolean(author.bot),
      avatar: author.displayAvatarURL?.() ?? '',
    } : null,
  };
}

export class MessageMemory {
  constructor({ maxPerGuild = MESSAGE_MEMORY_MAX, maxAgeMs = MESSAGE_MEMORY_AGE_MS, now = () => Date.now() } = {}) {
    this.maxPerGuild = maxPerGuild;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.guilds = new Map();
  }

  remember(message) {
    const snap = snapshotFrom(message);
    if (!snap) return;
    snap.seenAt = this.now();
    const map = this.#map(snap.guildId);
    map.delete(snap.id); // re-insert so an edit counts as the newest
    map.set(snap.id, snap);
    this.#prune(map);
  }

  /** The snapshot, then it is forgotten. Null when this server never saw it, or it has expired. */
  take(guildId, messageId) {
    const map = this.guilds.get(String(guildId ?? ''));
    if (!map) return null;
    const snap = map.get(String(messageId ?? ''));
    if (snap) map.delete(snap.id);
    if (!snap || snap.seenAt < this.now() - this.maxAgeMs) return null;
    return snap;
  }

  forget(guildId, messageId) {
    this.guilds.get(String(guildId ?? ''))?.delete(String(messageId ?? ''));
  }

  forgetChannel(guildId, channelId) {
    const map = this.guilds.get(String(guildId ?? ''));
    if (!map) return;
    for (const [id, snap] of map) if (snap.channelId === String(channelId)) map.delete(id);
  }

  clear(guildId) { this.guilds.delete(String(guildId ?? '')); }

  #map(guildId) {
    let map = this.guilds.get(guildId);
    if (!map) { map = new Map(); this.guilds.set(guildId, map); }
    return map;
  }

  #prune(map) {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [id, snap] of map) if (snap.seenAt < cutoff) map.delete(id);
    while (map.size > this.maxPerGuild) map.delete(map.keys().next().value);
  }
}
