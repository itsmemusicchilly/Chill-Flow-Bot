// Remembers the run that sent a message with buttons, so a later click can read its variables ({{var.*}}, {{original.*}}).
//
// - Stored as JSON, and every get() parses a fresh copy: each click owns its state, so two people pressing the same
//   panel button at the same time can never see (or change) each other's variables.
// - With a database the state survives restarts. Without one (unit tests, the demo server) it is kept in memory.
// - Retention with a database: ephemeral messages vanish when the person reloads, so they expire after a day; every
//   other message keeps its state until it is deleted (see forget/forgetChannel) or the operator sets
//   LIMIT_COMPONENT_STATE_DAYS. Expiry is checked on read, so it never depends on pruning having run.
import { isCapped, LIMITS } from '../../shared/limits.js';

const DAY_MS = 24 * 3600 * 1000;
export const EPHEMERAL_STATE_MS = DAY_MS;

export class ComponentState {
  /** @param {{db?: import('../db.js').Database|null, max?: number, ttlMs?: number}} [options] max/ttlMs only apply without a db */
  constructor({ db = null, max = 5000, ttlMs = 14 * DAY_MS } = {}) {
    this.db = db;
    this.max = max;
    this.ttl = ttlMs;
    this.map = new Map();
  }

  /**
   * @param {string} messageId
   * @param {object} ctx the run that sent the message
   * @param {{channelId?: string, ephemeral?: boolean}} [opts]
   */
  remember(messageId, ctx, { channelId = '', ephemeral = false } = {}) {
    const { original, ...data } = ctx.data; // only one level of "original"
    const vars = JSON.stringify(ctx.vars ?? {});
    const json = JSON.stringify(data);
    const guildId = ctx.guild.id;
    const now = Date.now();

    if (this.db) {
      let expiresAt = null;
      if (ephemeral) expiresAt = now + EPHEMERAL_STATE_MS;
      else if (isCapped(LIMITS.componentStateDays)) expiresAt = now + LIMITS.componentStateDays * DAY_MS;
      this.db.saveComponentState({ guildId, messageId, channelId, vars, data: json, expiresAt, now });
      return;
    }
    const key = `${guildId}:${messageId}`;
    this.map.delete(key);
    this.map.set(key, { vars, data: json, at: now, channelId, expiresAt: now + (ephemeral ? EPHEMERAL_STATE_MS : this.ttl) });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  /** @returns {{vars: object, data: object, at: number}|undefined} a private copy, or undefined when unknown or expired */
  get(guildId, messageId) {
    if (!guildId || !messageId) return undefined;
    let raw;
    if (this.db) {
      raw = this.db.getComponentState(guildId, messageId);
    } else {
      const key = `${guildId}:${messageId}`;
      raw = this.map.get(key);
      if (raw && raw.expiresAt <= Date.now()) { this.map.delete(key); raw = undefined; }
    }
    if (!raw) return undefined;
    try {
      return { vars: JSON.parse(raw.vars), data: JSON.parse(raw.data), at: raw.at };
    } catch {
      return undefined; // a damaged row behaves like "nothing remembered"
    }
  }

  forget(guildId, messageId) {
    if (!guildId || !messageId) return;
    if (this.db) this.db.deleteComponentState(guildId, messageId);
    else this.map.delete(`${guildId}:${messageId}`);
  }

  /** Forget every message of a channel (it was deleted, e.g. a closed ticket). */
  forgetChannel(guildId, channelId) {
    if (!guildId || !channelId) return;
    if (this.db) { this.db.deleteComponentStateForChannel(guildId, channelId); return; }
    for (const [key, e] of this.map) if (key.startsWith(`${guildId}:`) && e.channelId === channelId) this.map.delete(key);
  }
}
