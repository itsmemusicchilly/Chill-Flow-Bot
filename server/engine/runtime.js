// The runtime turns Discord events into flow runs. It owns the per-server trigger index and every limit that
// keeps one server from hurting the others (run rate, concurrency, action rate, step count).
import { MessageFlags } from 'discord.js';
import { getOutputs, isTriggerType, NODE_TYPES } from '../../shared/catalog.js';
import { LIMITS } from '../../shared/limits.js';
import { normalizeGraph, validateFlow } from '../../shared/validate.js';
import { uid } from '../../shared/util.js';
import { ComponentState } from './component-state.js';
import { parseButtonId, parseCustomId } from './custom-id.js';
import { runFlow } from './engine.js';
import { FlowAbort, friendlyError } from './errors.js';
import { RateLimiter, SelfActions } from './rate-limit.js';
import { autoDefer, finalize, newAck } from './responder.js';
import { channelData, guildData, memberData, messageData, roleData, userData } from './serialize.js';
import { matches } from './triggers.js';

export const DEFER_AFTER_MS = 2200;
const EPHEMERAL = MessageFlags.Ephemeral;

export class Runtime {
  /** @param {{db: import('../db.js').Database, logger: import('../logger.js').Logger, intents?: {members: boolean, messageContent: boolean}, uploads?: {publicUrl: (guildId: string, ref: string) => string}}} deps */
  constructor({ db, logger, intents = { members: false, messageContent: false }, uploads = null }) {
    this.db = db;
    this.logger = logger;
    this.intents = intents;
    this.client = null;
    this.services = {
      db, logger, uploads, intents,
      selfActions: new SelfActions(),
      cooldowns: new Map(),
      components: new ComponentState({ db }),
      guard: { runs: new RateLimiter(() => LIMITS.runsPer10s, 10000), actions: new RateLimiter(() => LIMITS.actionsPer10s, 10000) },
    };
    this.index = new Map(); // guildId -> { flows, triggers: Map<type, {flow,node}[]>, commands: Map<name, {flow,node}>, buttons: Map<buttonId, {flow,node}> }
    this.flowsById = new Map();
    this.active = new Map();
    this.live = new Set();
    this.timers = new Map();
    this.deferAfterMs = DEFER_AFTER_MS;
  }

  attachClient(client) { this.client = client; }

  // ---- index ------------------------------------------------------------------------------------
  loadGuild(guildId) {
    for (const id of this.index.get(guildId)?.flows.keys() ?? []) this.flowsById.delete(id);
    const entry = { flows: new Map(), triggers: new Map(), commands: new Map(), buttons: new Map() };
    for (const flow of this.db.listEnabledFlows(guildId)) {
      const graph = normalizeGraph(flow.graph);
      const active = { ...flow, graph };
      const issues = validateFlow(graph, { intents: this.intents });
      entry.flows.set(flow.id, active);
      this.flowsById.set(flow.id, active);
      for (const node of graph.nodes) {
        if (!isTriggerType(node.type)) continue;
        const def = NODE_TYPES[node.type];
        const blocking = issues.find((i) => i.nodeId === node.id && i.level === 'error');
        if (blocking) {
          this.logger.log(guildId, 'warn', `“${def.label}” in “${flow.name}” is not active: ${blocking.message}`, { flowId: flow.id, flowName: flow.name, nodeId: node.id });
          continue;
        }
        if (node.type === 'trigger.command') {
          if (entry.commands.has(node.data.name)) {
            this.logger.log(guildId, 'warn', `Command /${node.data.name} is defined twice; “${flow.name}” is ignored for it.`, { flowId: flow.id, flowName: flow.name, nodeId: node.id });
            continue;
          }
          entry.commands.set(node.data.name, { flow: active, node });
        }
        if (node.type === 'trigger.button.clicked') {
          // A press can only be answered once, so a Button ID has exactly one handler: the first flow (oldest) wins.
          const buttonId = String(node.data.customId ?? '').trim();
          const first = entry.buttons.get(buttonId);
          if (first) {
            this.logger.log(guildId, 'warn', `Button ID “${buttonId}” is handled twice; “${flow.name}” is ignored for it (“${first.flow.name}” handles it).`, { flowId: flow.id, flowName: flow.name, nodeId: node.id });
            continue;
          }
          entry.buttons.set(buttonId, { flow: active, node });
        }
        if (!entry.triggers.has(node.type)) entry.triggers.set(node.type, []);
        entry.triggers.get(node.type).push({ flow: active, node });
      }
    }
    this.index.set(guildId, entry);
    this.#stopRemovedRuns(guildId, entry);
    this.syncSchedules(guildId);
    return entry;
  }

  /** Switching a flow off (or deleting it) stops its runs that are still going, e.g. an endless loop or a long wait. */
  #stopRemovedRuns(guildId, entry) {
    const stopped = new Map();
    for (const ctx of this.live) {
      if (ctx.guild.id !== guildId || entry.flows.has(ctx.flow.id) || ctx.aborted) continue;
      this.abortRun(ctx);
      stopped.set(ctx.flow.name, (stopped.get(ctx.flow.name) ?? 0) + 1);
    }
    for (const [name, n] of stopped) this.logger.log(guildId, 'info', `Stopped ${n} running instance(s) of “${name}” because it was switched off or deleted.`);
  }

  abortRun(ctx) {
    ctx.aborted = true;
    ctx.abortController.abort();
  }

  loadAll() { for (const gid of this.db.guildIdsWithFlows()) this.loadGuild(gid); }

  unloadGuild(guildId) {
    for (const id of this.index.get(guildId)?.flows.keys() ?? []) this.flowsById.delete(id);
    this.index.delete(guildId);
    this.#stopRemovedRuns(guildId, { flows: new Map() });
    this.clearTimers(guildId);
  }

  hasTrigger(guildId, type) { return Boolean(this.index.get(guildId)?.triggers.get(type)?.length); }
  commandsFor(guildId) { return [...(this.index.get(guildId)?.commands.values() ?? [])]; }

  // ---- starting runs ----------------------------------------------------------------------------
  createContext(flow, base) {
    const { guild, channel, user, member, message, role, interaction, data = {} } = base;
    const runId = uid(8);
    const templateData = {
      guild: guildData(guild),
      ...(user ? { user: userData(user, member) } : {}),
      ...(member ? { member: memberData(member) } : {}),
      ...(channel ? { channel: channelData(channel) } : {}),
      ...(message ? { message: messageData(message) } : {}),
      ...(role ? { role: roleData(role) } : {}),
    };
    // extra data (option, emoji, executor, message.after …) is merged into, not over, the base objects
    for (const [k, v] of Object.entries(data)) {
      const plain = v && typeof v === 'object' && !Array.isArray(v);
      templateData[k] = plain && templateData[k] && typeof templateData[k] === 'object' ? { ...templateData[k], ...v } : v;
    }
    const ctx = {
      runId, flow, guild, channel, user, member, message, interaction,
      services: this.services,
      data: templateData,
      vars: base.vars ?? {},
      loop: null, error: null, steps: 0, failed: false, aborted: false, abortController: new AbortController(),
      ack: newAck(),
      deferEphemeral: Boolean(base.deferEphemeral),
      deferTimer: null,
      logMeta: { flowId: flow.id, flowName: flow.name, runId },
    };
    ctx.armDefer = () => {
      clearTimeout(ctx.deferTimer);
      if (ctx.interaction) ctx.deferTimer = setTimeout(() => autoDefer(ctx), this.deferAfterMs);
    };
    return ctx;
  }

  /** @returns {Promise<void>|null} null when throttled */
  start(flow, triggerNode, base, { handle = 'out', label = 'Triggered' } = {}) {
    const gid = base.guild.id;
    if (!this.services.guard.runs.take(gid)) {
      this.logger.log(gid, 'warn', `“${flow.name}” was throttled: too many runs in a short time.`, { flowId: flow.id, flowName: flow.name });
      return null;
    }
    const running = this.active.get(gid) ?? 0;
    if (running >= LIMITS.concurrentRuns) {
      this.logger.log(gid, 'warn', `“${flow.name}” was skipped: ${LIMITS.concurrentRuns} runs are already in progress.`, { flowId: flow.id, flowName: flow.name });
      return null;
    }
    this.active.set(gid, running + 1);
    const ctx = this.createContext(flow, base);
    this.live.add(ctx);
    return this.#execute(flow, triggerNode, handle, ctx, label).finally(() => {
      this.live.delete(ctx);
      const n = (this.active.get(gid) ?? 1) - 1;
      if (n <= 0) this.active.delete(gid); else this.active.set(gid, n);
    });
  }

  async #execute(flow, triggerNode, handle, ctx, label) {
    const gid = ctx.guild.id;
    const started = Date.now();
    this.logger.log(gid, 'info', `▶ ${flow.name}: ${label}`, { ...ctx.logMeta, nodeId: triggerNode.id });
    ctx.armDefer();
    try {
      await runFlow(flow, triggerNode.id, handle, ctx);
    } catch (err) {
      if (err instanceof FlowAbort && ctx.aborted) {
        this.logger.log(gid, 'info', `■ ${flow.name} was stopped.`, ctx.logMeta);
      } else {
        ctx.failed = true;
        this.logger.log(gid, 'error', `${flow.name}: ${friendlyError(err)}`, ctx.logMeta);
      }
    } finally {
      clearTimeout(ctx.deferTimer);
      await finalize(ctx, { failed: ctx.failed });
      this.logger.log(gid, 'debug', `■ ${flow.name} finished in ${Date.now() - started} ms`, ctx.logMeta);
    }
  }

  /** Fire every active trigger of `type` in `guild`; resolves when those runs finish. `info` feeds the filters. */
  fire(type, { guild, info = {}, label, ...base }) {
    const list = this.index.get(guild.id)?.triggers.get(type);
    if (!list?.length) return Promise.resolve();
    const runs = [];
    for (const { flow, node } of list) {
      const m = matches(type, node.data, info);
      if (!m) continue;
      const data = { ...(base.data || {}) };
      for (const [k, v] of Object.entries(m.data || {})) data[k] = { ...(data[k] || {}), ...v };
      const run = this.start(flow, node, { ...base, guild, data }, { label: label ?? NODE_TYPES[type].label });
      if (run) runs.push(run);
    }
    return Promise.all(runs);
  }

  /** A visitor submitted a web form: start every active "Form Submitted" flow bound to it. */
  fireForm({ guildId, user, member = null, page, formBlock, answers, summary, responseId, pageUrl }) {
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) return Promise.resolve();
    return this.fire('trigger.form.submitted', {
      guild, user, member: member ?? undefined,
      data: { form: { ...answers, title: formBlock.data.title, summary }, page: { title: page.title, url: pageUrl }, response: { id: responseId } },
      info: { formKey: `${page.id}:${formBlock.id}`, isBot: false },
      label: `Form “${formBlock.data.title}” submitted by ${user.username}`,
    });
  }

  // ---- interactions -----------------------------------------------------------------------------
  async handleInteraction(interaction) {
    try {
      if (interaction.isChatInputCommand()) await this.#handleCommand(interaction);
      else if (interaction.isMessageComponent()) await this.#handleComponent(interaction);
    } catch (err) {
      this.logger.log(interaction.guildId, 'error', `Interaction failed: ${friendlyError(err)}`);
    }
  }

  async #memberAndChannel(guild, interaction) {
    const member = interaction.member?.roles?.cache ? interaction.member : await guild.members.fetch(interaction.user.id).catch(() => null);
    const channel = interaction.channel ?? await guild.channels.fetch(interaction.channelId).catch(() => null);
    return { member, channel };
  }

  async #handleCommand(interaction) {
    const guild = interaction.guild;
    if (!guild) return;
    const cmd = this.index.get(guild.id)?.commands.get(interaction.commandName);
    if (!cmd) {
      await interaction.reply({ content: 'This command is not set up (any more).', flags: EPHEMERAL }).catch(() => {});
      return;
    }
    const option = {};
    for (const o of interaction.options.data) option[o.name] = o.value ?? '';
    const { member, channel } = await this.#memberAndChannel(guild, interaction);
    const started = this.start(cmd.flow, cmd.node, {
      guild, channel, member, user: interaction.user, interaction, data: { option }, deferEphemeral: cmd.node.data.deferEphemeral,
    }, { label: `/${interaction.commandName} by ${interaction.user.username}` });
    if (started) await started;
    else await interaction.reply({ content: 'Too many requests right now — try again in a moment.', flags: EPHEMERAL }).catch(() => {});
  }

  #stale(interaction, content) {
    return interaction.reply({ content, flags: EPHEMERAL, allowedMentions: { parse: [] } }).catch(() => {});
  }

  async #handleComponent(interaction) {
    const button = parseButtonId(interaction.customId);
    if (button) return this.#handleButton(interaction, button);
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;
    const stale = (content) => this.#stale(interaction, content);
    const flow = this.flowsById.get(parsed.flowId);
    if (!flow || (interaction.guildId && flow.guildId !== interaction.guildId)) return stale('This button is no longer active.');
    const node = flow.graph.nodes.find((n) => n.id === parsed.nodeId && n.type === 'action.message.send');
    if (!node) return stale('This button is no longer active.');
    const isMenu = parsed.handle === 'sel';
    const handle = isMenu ? `opt_${interaction.values?.[0]}` : parsed.handle;
    if (!getOutputs(node.type, node.data).some((o) => o.id === handle)) return stale('This button is no longer active.');
    if (parsed.invokerId && parsed.invokerId !== interaction.user.id) return stale(`Only <@${parsed.invokerId}> can use this.`);
    const guild = interaction.guild ?? this.client?.guilds.cache.get(flow.guildId);
    if (!guild) return stale('This button is no longer active.');

    const snap = this.services.components.get(flow.guildId, interaction.message?.id);
    const { member, channel } = await this.#memberAndChannel(guild, interaction);
    const data = {};
    if (snap) data.original = snap.data;
    if (isMenu) data.select = { value: interaction.values?.[0] ?? '', values: interaction.values ?? [] };
    const started = this.start(flow, node, {
      guild, channel, member, user: interaction.user, message: interaction.message, interaction, data, vars: snap?.vars ?? {},
    }, { handle, label: `${isMenu ? 'menu' : 'button'} used by ${interaction.user.username}` });
    if (started) await started;
    else await stale('Too many requests right now — try again in a moment.');
  }

  /** A reusable button (`fcb:<id>`): found by its Button ID in this server, whichever message or flow posted it. */
  async #handleButton(interaction, { id, invokerId }) {
    const guildId = interaction.guildId;
    if (!guildId) return this.#stale(interaction, 'This button only works inside a server.');
    const handler = this.index.get(guildId)?.buttons.get(id); // only this server's flows can answer this server's buttons
    if (!handler) return this.#stale(interaction, 'This button is no longer active.');
    if (invokerId && invokerId !== interaction.user.id) return this.#stale(interaction, `Only <@${invokerId}> can use this.`);
    const guild = interaction.guild ?? this.client?.guilds.cache.get(guildId);
    if (!guild) return this.#stale(interaction, 'This button is no longer active.');

    const snap = this.services.components.get(guildId, interaction.message?.id);
    const { member, channel } = await this.#memberAndChannel(guild, interaction);
    const data = { button: { id, label: interaction.component?.label ?? '' } };
    if (snap) data.original = snap.data;
    const started = this.start(handler.flow, handler.node, {
      guild, channel, member, user: interaction.user, message: interaction.message, interaction, data, vars: snap?.vars ?? {},
    }, { label: `button “${id}” used by ${interaction.user.username}` });
    if (started) await started;
    else await this.#stale(interaction, 'Too many requests right now — try again in a moment.');
  }

  // ---- manual + scheduled runs ------------------------------------------------------------------
  async runManual(guildId, flowId, nodeId) {
    const entry = this.index.get(guildId);
    const t = entry?.triggers.get('trigger.manual')?.find((x) => x.flow.id === flowId && x.node.id === nodeId);
    if (!t) return { ok: false, error: 'That trigger is not active. Enable the flow, save it and fix any errors on the trigger.' };
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) return { ok: false, error: 'The bot is not connected to this server right now.' };
    const channel = t.node.data.channelId ? await guild.channels.fetch(String(t.node.data.channelId).replace(/\D/g, '')).catch(() => null) : null;
    if (channel && channel.guildId !== guildId) return { ok: false, error: 'That channel is not in this server.' };
    const started = this.start(t.flow, t.node, { guild, channel }, { label: 'Run pressed in the editor' });
    return started ? { ok: true } : { ok: false, error: 'Too many runs right now — try again in a moment.' };
  }

  clearTimers(guildId) {
    for (const [key, timer] of this.timers) if (key.startsWith(`${guildId}|`)) { clearInterval(timer); this.timers.delete(key); }
  }

  syncSchedules(guildId) {
    this.clearTimers(guildId);
    const list = this.index.get(guildId)?.triggers.get('trigger.schedule') ?? [];
    for (const { flow, node } of list) {
      const unit = { minutes: 60000, hours: 3600000, days: 86400000 }[node.data.unit] ?? 60000;
      const ms = Math.max(60000, Math.min(2 ** 31 - 1, Number(node.data.every) * unit));
      const timer = setInterval(async () => {
        const guild = this.client?.guilds.cache.get(guildId);
        if (!guild) return;
        const cid = String(node.data.channelId || '').replace(/\D/g, '');
        const channel = cid ? await guild.channels.fetch(cid).catch(() => null) : null;
        this.start(flow, node, { guild, channel: channel?.guildId === guildId ? channel : null }, { label: 'Schedule' });
      }, ms);
      timer.unref?.();
      this.timers.set(`${guildId}|${flow.id}|${node.id}`, timer);
    }
  }

  async stop() {
    for (const ctx of this.live) this.abortRun(ctx);
    for (const key of this.timers.keys()) clearInterval(this.timers.get(key));
    this.timers.clear();
  }
}
