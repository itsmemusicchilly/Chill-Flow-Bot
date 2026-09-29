// Slash commands are registered per server (guild-scoped): instant, and never visible to other servers.
import crypto from 'node:crypto';
import { PermissionFlagsBits, Routes } from 'discord.js';
import { friendlyError } from '../engine/errors.js';

export const OPTION_TYPES = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8, mentionable: 9, number: 10 };
const NAME = /^[a-z0-9_-]{1,32}$/;

/** @param {{flow: {name: string}, node: {data: object}}[]} triggers */
export function buildCommandDefs(triggers) {
  const defs = [];
  const skipped = [];
  const seen = new Set();
  for (const { flow, node } of triggers) {
    const d = node.data;
    if (!NAME.test(d.name || '') || !d.description || d.description.length > 100) { skipped.push({ flow: flow.name, name: d.name, reason: 'invalid name or description' }); continue; }
    if (seen.has(d.name)) { skipped.push({ flow: flow.name, name: d.name, reason: 'duplicate command name' }); continue; }
    if (defs.length >= 100) { skipped.push({ flow: flow.name, name: d.name, reason: 'Discord allows at most 100 commands' }); continue; }
    const options = (d.options || [])
      .filter((o) => NAME.test(o.name || '') && o.description && OPTION_TYPES[o.type])
      .slice(0, 25)
      .map((o) => ({ type: OPTION_TYPES[o.type], name: o.name, description: o.description.slice(0, 100), required: Boolean(o.required) }))
      .sort((a, b) => Number(b.required) - Number(a.required)); // Discord wants required options first
    seen.add(d.name);
    defs.push({
      name: d.name, description: d.description, type: 1, options,
      default_member_permissions: d.permission && PermissionFlagsBits[d.permission] ? PermissionFlagsBits[d.permission].toString() : null,
    });
  }
  return { defs, skipped };
}

export const hashDefs = (defs) => crypto.createHash('sha256').update(JSON.stringify(defs)).digest('hex');

export class CommandSync {
  constructor({ db, runtime, logger, config }) {
    this.db = db; this.runtime = runtime; this.logger = logger; this.config = config;
    this.status = new Map(); // guildId -> { ok, at, count, error?, skipped }
    this.chains = new Map();
  }

  /** Serialised per server so quick successive saves cannot race each other. */
  sync(guildId, opts) {
    const prev = this.chains.get(guildId) ?? Promise.resolve();
    const next = prev.then(() => this.#run(guildId, opts), () => this.#run(guildId, opts));
    this.chains.set(guildId, next);
    return next.finally(() => { if (this.chains.get(guildId) === next) this.chains.delete(guildId); });
  }

  async #run(guildId, { force = false } = {}) {
    const rest = this.runtime.client?.rest;
    const { defs, skipped } = buildCommandDefs(this.runtime.commandsFor(guildId));
    for (const s of skipped) this.logger.log(guildId, 'warn', `Command /${s.name} (${s.flow}) was not registered: ${s.reason}.`);
    const hash = hashDefs(defs);
    const known = this.db.getSyncHash(guildId);
    if (!force && known === hash) return this.#remember(guildId, { ok: true, count: defs.length, skipped });
    if (known === undefined && !defs.length) { this.db.setSyncHash(guildId, hash); return this.#remember(guildId, { ok: true, count: 0, skipped }); }
    if (!rest) return this.#remember(guildId, { ok: false, count: 0, skipped, error: 'The bot is not connected yet.' });
    try {
      await rest.put(Routes.applicationGuildCommands(this.config.clientId, guildId), { body: defs });
      this.db.setSyncHash(guildId, hash);
      this.logger.log(guildId, 'info', `Slash commands updated (${defs.length}).`);
      return this.#remember(guildId, { ok: true, count: defs.length, skipped });
    } catch (err) {
      const error = friendlyError(err);
      this.logger.log(guildId, 'warn', `Could not update slash commands: ${error}`);
      return this.#remember(guildId, { ok: false, count: 0, skipped, error });
    }
  }

  #remember(guildId, result) {
    const full = { ...result, at: Date.now() };
    this.status.set(guildId, full);
    return full;
  }
}
