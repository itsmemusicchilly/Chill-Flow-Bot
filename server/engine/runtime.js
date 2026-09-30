// The runtime turns Discord events into flow runs. It owns the per-server trigger index and every limit that
// keeps one server from hurting the others (run rate, concurrency, action rate, step count).
import { MessageFlags } from 'discord.js';
import { getOutputs, isTriggerType, NODE_TYPES } from '../../shared/catalog.js';
import { cronMatches, scheduleOf, zonedParts } from '../../shared/cron.js';
import { LIMITS } from '../../shared/limits.js';
import { normalizeGraph, validateFlow } from '../../shared/validate.js';
import { uid } from '../../shared/util.js';
import { ChannelEdits } from './channel-edits.js';
import { ComponentState } from './component-state.js';
import { parseButtonId, parseCustomId } from './custom-id.js';
import { runFlow } from './engine.js';
import { FlowAbort, friendlyError } from './errors.js';
import { RateLimiter, SelfActions } from './rate-limit.js';
import { autoDefer, finalize, newAck } from './responder.js';
import { channelData, guildData, memberData, messageData, roleData, userData } from './serialize.js';
import { matches } from './triggers.js';

export const DEFER_AFTER_MS = 2200;
const MINUTE = 60_000;
const TICK_SLACK_MS = 250; // schedules are checked just AFTER a minute begins, never just before it
const MAX_CATCH_UP = 3; // minutes a stalled event loop may make up; a longer gap (the bot was off) is never replayed
const minuteOf = (ms) => Math.floor(ms / MINUTE) * MINUTE;
const EPHEMERAL = MessageFlags.Ephemeral;

export class Runtime {
  /**
   * @param {{db: import('../db.js').Database, logger: import('../logger.js').Logger, intents?: {members: boolean, messageContent: boolean}, uploads?: {publicUrl: (guildId: string, ref: string) => string},
   *          clock?: {now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (timer: any) => void}}} deps
   *   `clock` is for tests: schedules read the time and set their timer through it.
   */
  constructor({ db, logger, intents = { members: false, messageContent: false }, uploads = null, clock = {} }) {
    this.db = db;
    this.logger = logger;
    this.intents = intents;
    this.client = null;
    this.services = {
      db, logger, uploads, intents,
      selfActions: new SelfActions(),
      channelEdits: new ChannelEdits(),
      cooldowns: new Map(),
      components: new ComponentState({ db }),
      guard: { runs: new RateLimiter(() => LIMITS.runsPer10s, 10000), actions: new RateLimiter(() => LIMITS.actionsPer10s, 10000) },
    };
    this.index = new Map(); // guildId -> { flows, triggers: Map<type, {flow,node}[]>, commands: Map<name, {flow,node}>, buttons: Map<buttonId, {flow,node}> }
    this.flowsById = new Map();
    this.active = new Map();
    this.live = new Set();
    this.clock = { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t), ...clock };
    this.schedules = new Map(); // "guild|flow|node" -> what one Schedule trigger needs to know between ticks
    this.ticker = null; // the one timer that wakes up at the start of each minute while any schedule exists
    this.lastMinute = null; // the last minute whose schedules were looked at
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
    this.clearSchedules(guildId);
    this.services.channelEdits.cancel(guildId);
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

  // ---- schedules ---------------------------------------------------------------------------------
  // One timer serves every Schedule trigger of every server: it wakes at the start of each minute and asks each schedule whether that
  // minute is one of its own. Times of day and cron expressions are read on the wall clock of the zone they name, so they do not depend
  // on when the bot started or when a flow was last saved; "every N …" counts from when the schedule first appeared and keeps counting
  // through saves that do not touch it.
  clearSchedules(guildId) {
    for (const key of this.schedules.keys()) if (key.startsWith(`${guildId}|`)) this.schedules.delete(key);
    if (!this.schedules.size) this.#disarmTicker();
  }

  syncSchedules(guildId) {
    const now = minuteOf(this.clock.now());
    const keep = new Set();
    for (const { flow, node } of this.index.get(guildId)?.triggers.get('trigger.schedule') ?? []) {
      let schedule;
      try { schedule = scheduleOf(node.data); } catch { continue; } // already reported as “not active” by loadGuild
      const key = `${guildId}|${flow.id}|${node.id}`;
      const signature = schedule.mode === 'every' ? `every|${schedule.ms}` : `${schedule.mode}|${schedule.source}|${schedule.tz}`;
      keep.add(key);
      const known = this.schedules.get(key);
      if (known?.signature === signature) { Object.assign(known, { flow, node }); continue; } // unchanged: carry on where it was
      this.schedules.set(key, { key, guildId, flow, node, schedule, signature, due: schedule.mode === 'every' ? now + schedule.ms : 0, lastKey: '' });
    }
    for (const key of [...this.schedules.keys()]) if (key.startsWith(`${guildId}|`) && !keep.has(key)) this.schedules.delete(key);
    if (this.schedules.size) this.#armTicker(); else this.#disarmTicker();
  }

  #armTicker() {
    if (this.ticker) return;
    this.lastMinute = minuteOf(this.clock.now()); // the minute in progress is not run, and nothing before it is replayed
    this.#scheduleTick();
  }

  #disarmTicker() {
    if (this.ticker) this.clock.clearTimer(this.ticker);
    this.ticker = null;
    this.lastMinute = null;
  }

  #scheduleTick() {
    const now = this.clock.now();
    this.ticker = this.clock.setTimer(async () => {
      this.ticker = null;
      try { await this.runScheduleTick(this.clock.now()); } finally { if (this.schedules.size) this.#scheduleTick(); }
    }, MINUTE - (now % MINUTE) + TICK_SLACK_MS);
    this.ticker.unref?.();
  }

  /**
   * Run every schedule that is due in the minutes up to `now` (normally just the minute that has begun). A stalled event loop makes up at
   * most MAX_CATCH_UP minutes, so it never skips a minute but a bot that was off is not answered with a burst of runs.
   * Resolves when the runs have been started (not when they finish).
   */
  async runScheduleTick(now = this.clock.now()) {
    const current = minuteOf(now);
    let minute = this.lastMinute === null ? current : this.lastMinute + MINUTE;
    minute = Math.max(minute, current - (MAX_CATCH_UP - 1) * MINUTE);
    const started = [];
    for (; minute <= current; minute += MINUTE) started.push(...this.#dueAt(minute));
    this.lastMinute = current;
    await Promise.allSettled(started.map((state) => this.#fireSchedule(state)));
  }

  /** The schedules that run in `minute` (a timestamp at the start of a minute). */
  #dueAt(minute) {
    const due = [];
    const clocks = new Map(); // what the wall clock says in each zone, worked out once per minute
    for (const state of this.schedules.values()) {
      try {
        const { schedule } = state;
        if (schedule.mode === 'every') {
          if (minute < state.due) continue;
          state.due += schedule.ms;
          if (state.due <= minute) state.due = minute + schedule.ms; // after a stall, skip the runs that were missed
        } else {
          if (!clocks.has(schedule.tz)) clocks.set(schedule.tz, zonedParts(minute, schedule.tz));
          const parts = clocks.get(schedule.tz);
          // a local minute that happens twice (clocks going back) runs once
          if (parts.key === state.lastKey || !cronMatches(schedule.cron, parts)) continue;
          state.lastKey = parts.key;
        }
        due.push(state);
      } catch (err) {
        this.schedules.delete(state.key);
        this.logger.log(state.guildId, 'warn', `The schedule in “${state.flow.name}” was switched off: ${friendlyError(err)}`, { flowId: state.flow.id, flowName: state.flow.name, nodeId: state.node.id });
      }
    }
    return due;
  }

  async #fireSchedule({ guildId, flow, node }) {
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) return;
    const cid = String(node.data.channelId || '').replace(/\D/g, '');
    const channel = cid ? await guild.channels.fetch(cid).catch(() => null) : null;
    this.start(flow, node, { guild, channel: channel?.guildId === guildId ? channel : null }, { label: 'Schedule' });
  }

  async stop() {
    for (const ctx of this.live) this.abortRun(ctx);
    this.schedules.clear();
    this.#disarmTicker();
    this.services.channelEdits.cancel();
  }
}
