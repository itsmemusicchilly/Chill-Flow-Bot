// Slash commands and right-click commands are registered per server (guild-scoped): instant, and never visible to other servers.
import crypto from 'node:crypto';
import { PermissionFlagsBits, Routes } from 'discord.js';
import { CHOICE_TYPES, COMMAND_NAME_RE, commandKey, MAX_CHOICES, MAX_MENU_COMMANDS, parseChoices, subOf, typedChoice } from '../../shared/commands.js';
import { friendlyError } from '../engine/errors.js';

export const OPTION_TYPES = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, role: 8, mentionable: 9, number: 10 };
const SUB_COMMAND = 1;
const MENU_TYPES = { user: 2, message: 3 };
const MAX_SUBS = 25;

const permissionBits = (name) => (name && PermissionFlagsBits[name] ? PermissionFlagsBits[name] : 0n);

/** The options of one command (or one sub-command), in the shape Discord wants. */
function optionsOf(d) {
  return (d.options || [])
    .filter((o) => COMMAND_NAME_RE.test(o.name || '') && o.description && OPTION_TYPES[o.type])
    .slice(0, 25)
    .map((o) => {
      const out = { type: OPTION_TYPES[o.type], name: o.name, description: o.description.slice(0, 100), required: Boolean(o.required) };
      if (!CHOICE_TYPES.includes(o.type)) return out;
      if (o.choiceMode === 'choices') {
        const choices = parseChoices(o.choices).map((c) => typedChoice(c, o.type)).filter(Boolean).slice(0, MAX_CHOICES);
        if (choices.length) out.choices = choices;
      } else if (o.choiceMode === 'suggest') out.autocomplete = true; // the runtime answers while the person types
      return out;
    })
    .sort((a, b) => Number(b.required) - Number(a.required)); // Discord wants required options first
}

/**
 * What to register with Discord for one server.
 * Slash Command triggers that share a name and each have a sub-command become ONE command with sub-commands; a command cannot have
 * sub-commands and also be used on its own. Right-click commands (on a member, on a message) are registered next to them.
 * @param {{flow: {name: string}, node: {type?: string, data: object}}[]} triggers
 */
export function buildCommandDefs(triggers) {
  const defs = [];
  const skipped = [];
  const groups = new Map(); // command name -> { sub: boolean, items: trigger[] }, in the order they were first seen
  const menus = { user: new Map(), message: new Map() };
  for (const t of triggers) {
    const { flow, node } = t;
    const d = node.data;
    if (node.type === 'trigger.contextMenu') {
      const kind = d.kind === 'message' ? 'message' : 'user';
      const name = String(d.name ?? '').trim();
      const skip = (reason) => skipped.push({ flow: flow.name, name, reason, menu: true });
      if (!name || name.length > 32) skip('its name must be 1 to 32 characters');
      else if (menus[kind].has(name)) skip('duplicate right-click command name');
      else if (menus[kind].size >= MAX_MENU_COMMANDS) skip(`Discord allows at most ${MAX_MENU_COMMANDS} right-click commands on a ${kind === 'message' ? 'message' : 'member'}`);
      else menus[kind].set(name, t);
      continue;
    }
    const sub = subOf(d);
    const name = commandKey(d.name, sub);
    const skip = (reason) => skipped.push({ flow: flow.name, name, reason });
    if (!COMMAND_NAME_RE.test(d.name || '') || !d.description || d.description.length > 100) { skip('invalid name or description'); continue; }
    if (sub && !COMMAND_NAME_RE.test(sub)) { skip('invalid sub-command name'); continue; }
    const group = groups.get(d.name);
    if (!group) {
      if (groups.size >= 100) { skip('Discord allows at most 100 commands'); continue; }
      groups.set(d.name, { sub: Boolean(sub), items: [t] });
    } else if (group.sub !== Boolean(sub)) skip('a command that has sub-commands cannot also be used on its own');
    else if (!sub) skip('duplicate command name');
    else if (group.items.some((x) => subOf(x.node.data) === sub)) skip('duplicate sub-command');
    else if (group.items.length >= MAX_SUBS) skip(`Discord allows at most ${MAX_SUBS} sub-commands`);
    else group.items.push(t);
  }
  for (const [name, group] of groups) {
    const first = group.items[0].node.data;
    // Discord has ONE permission setting per command. Sub-commands that ask for different ones all get every one of them: a sub-command
    // meant for moderators must never end up open to everyone because another one was.
    const bits = group.items.reduce((all, t) => all | permissionBits(t.node.data.permission), 0n);
    defs.push({
      name, description: first.description, type: 1,
      options: group.sub
        ? group.items.map((t) => ({ type: SUB_COMMAND, name: subOf(t.node.data), description: t.node.data.description, options: optionsOf(t.node.data) }))
        : optionsOf(first),
      default_member_permissions: bits ? bits.toString() : null,
    });
  }
  for (const kind of ['user', 'message']) {
    for (const [name, t] of menus[kind]) {
      const bits = permissionBits(t.node.data.permission);
      defs.push({ name, type: MENU_TYPES[kind], default_member_permissions: bits ? bits.toString() : null });
    }
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
    for (const s of skipped) this.logger.log(guildId, 'warn', `${s.menu ? `Right-click command “${s.name}”` : `Command /${s.name}`} (${s.flow}) was not registered: ${s.reason}.`);
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
