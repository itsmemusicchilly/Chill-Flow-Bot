// Discord gateway events -> flow triggers. Everything is scoped to the guild the event happened in.
import { AuditLogEvent, Events } from 'discord.js';
import { executorData } from '../engine/serialize.js';

const AUDIT_WINDOW_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function wireEvents({ client, runtime, logger, sync, auditDelayMs = 1000 }) {
  const { selfActions, components, db } = runtime.services;
  const warned = new Map();
  const has = (guild, type) => runtime.hasTrigger(guild.id, type);
  const safe = (label, fn) => async (...args) => {
    try { await fn(...args); } catch (err) { logger.log(args[0]?.guild?.id ?? null, 'error', `${label}: ${err.message}`); }
  };

  /** Look up who did something in the audit log (needs "View Audit Log"; degrades gracefully without it). */
  async function findAudit(guild, types, targetId) {
    if (auditDelayMs) await sleep(auditDelayMs);
    try {
      for (const type of types) {
        const logs = await guild.fetchAuditLogs({ type, limit: 6 });
        const entry = logs.entries.find((e) => e.target?.id === targetId && Date.now() - e.createdTimestamp < AUDIT_WINDOW_MS);
        if (entry) return entry;
      }
    } catch {
      const last = warned.get(guild.id) ?? 0;
      if (Date.now() - last > 3600000) {
        warned.set(guild.id, Date.now());
        logger.log(guild.id, 'warn', 'Give the bot the “View Audit Log” permission so it can tell kicks and bans from people leaving, and show who did it.');
      }
    }
    return null;
  }

  client.on(Events.InteractionCreate, (i) => runtime.handleInteraction(i));
  client.on(Events.GuildCreate, (guild) => { sync.sync(guild.id).catch(() => {}); });

  // ---- messages -------------------------------------------------------------------------------
  client.on(Events.MessageCreate, safe('message', async (m) => {
    if (!m.guild || !m.author || !has(m.guild, 'trigger.message.received')) return;
    runtime.fire('trigger.message.received', {
      guild: m.guild, channel: m.channel, user: m.author, member: m.member, message: m,
      info: { content: m.content, channelId: m.channelId, isBot: m.author.bot, byBot: m.author.id === client.user.id },
    });
  }));
  client.on(Events.MessageDelete, safe('messageDelete', async (m) => {
    components.forget(m.guildId ?? m.guild?.id, m.id); // a deleted panel no longer needs its remembered variables
    if (!m.guild || !has(m.guild, 'trigger.message.deleted')) return;
    runtime.fire('trigger.message.deleted', { guild: m.guild, channel: m.channel, user: m.author ?? undefined, message: m, info: { channelId: m.channelId } });
  }));

  client.on(Events.MessageBulkDelete, safe('messageBulkDelete', async (messages, channel) => {
    for (const id of messages.keys()) components.forget(channel?.guildId ?? channel?.guild?.id, id);
  }));

  // ---- members --------------------------------------------------------------------------------
  client.on(Events.GuildMemberAdd, safe('memberJoin', async (m) => {
    runtime.fire('trigger.member.join', { guild: m.guild, user: m.user, member: m, info: { isBot: m.user.bot } });
  }));

  client.on(Events.GuildMemberRemove, safe('memberLeave', async (member) => {
    const { guild, user } = member;
    const wantLeft = has(guild, 'trigger.member.leave');
    const wantKick = has(guild, 'trigger.member.kicked');
    if (!wantLeft && !wantKick) return;
    if (selfActions.peek(`ban:${guild.id}:${user.id}`)) return; // the ban event handles it
    let kind = 'left';
    let entry = null;
    let byBot = false;
    if (selfActions.peek(`kick:${guild.id}:${user.id}`)) { kind = 'kick'; byBot = selfActions.consume(`kick:${guild.id}:${user.id}`); }
    else if ((entry = await findAudit(guild, [AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd], user.id))) {
      kind = entry.action === AuditLogEvent.MemberBanAdd ? 'ban' : 'kick';
    }
    if (kind === 'ban') return;
    const info = { isBot: user.bot, byBot };
    if (kind === 'kick') {
      runtime.fire('trigger.member.kicked', { guild, user, member, data: executorData(byBot ? client.user : entry?.executor, entry?.reason), info });
    } else {
      runtime.fire('trigger.member.leave', { guild, user, member, info });
    }
  }));

  client.on(Events.GuildBanAdd, safe('ban', async (ban) => {
    const { guild, user } = ban;
    if (!has(guild, 'trigger.member.banned')) return;
    const byBot = selfActions.consume(`ban:${guild.id}:${user.id}`);
    const entry = byBot ? null : await findAudit(guild, [AuditLogEvent.MemberBanAdd], user.id);
    runtime.fire('trigger.member.banned', { guild, user, data: executorData(byBot ? client.user : entry?.executor, entry?.reason ?? ban.reason), info: { isBot: user.bot, byBot } });
  }));

  client.on(Events.GuildBanRemove, safe('unban', async (ban) => {
    const { guild, user } = ban;
    if (!has(guild, 'trigger.member.unbanned')) return;
    const byBot = selfActions.consume(`unban:${guild.id}:${user.id}`);
    const entry = byBot ? null : await findAudit(guild, [AuditLogEvent.MemberBanRemove], user.id);
    runtime.fire('trigger.member.unbanned', { guild, user, data: executorData(byBot ? client.user : entry?.executor, entry?.reason), info: { isBot: user.bot, byBot } });
  }));

  client.on(Events.GuildMemberUpdate, safe('memberUpdate', async (oldM, newM) => {
    const { guild, user } = newM;
    if (!oldM.partial) {
      for (const [kind, from, to, type] of [['roleAdd', oldM, newM, 'trigger.member.roleAdded'], ['roleRemove', newM, oldM, 'trigger.member.roleRemoved']]) {
        if (!has(guild, type)) continue;
        for (const role of to.roles.cache.values()) {
          if (from.roles.cache.has(role.id) || role.id === guild.id) continue;
          const byBot = selfActions.consume(`${kind}:${guild.id}:${user.id}:${role.id}`);
          runtime.fire(type, { guild, user, member: newM, role, info: { isBot: user.bot, byBot, roleId: role.id, roleName: role.name } });
        }
      }
      // Boosts. Only with a real "before": a partial old member reads as "not boosting" and would look like a new boost.
      const wasBoosting = Boolean(oldM.premiumSinceTimestamp);
      const isBoosting = Boolean(newM.premiumSinceTimestamp);
      const boostType = isBoosting ? 'trigger.user.boostserver' : 'trigger.user.unboostserver';
      if (wasBoosting !== isBoosting && has(guild, boostType)) {
        const since = isBoosting ? newM.premiumSinceTimestamp : oldM.premiumSinceTimestamp;
        const days = isBoosting ? 0 : Math.max(0, Math.floor((Date.now() - since) / 86400000));
        runtime.fire(boostType, { guild, user, member: newM, data: { boost: { since: new Date(since).toISOString(), days } }, info: { isBot: user.bot } });
      }
    }
    const until = newM.communicationDisabledUntilTimestamp;
    if (has(guild, 'trigger.member.timeout') && until && until > Date.now() && (oldM.partial || oldM.communicationDisabledUntilTimestamp !== until)) {
      const byBot = selfActions.consume(`timeout:${guild.id}:${user.id}`);
      const entry = byBot ? null : await findAudit(guild, [AuditLogEvent.MemberUpdate], user.id);
      runtime.fire('trigger.member.timeout', {
        guild, user, member: newM,
        data: { ...executorData(byBot ? client.user : entry?.executor, entry?.reason), timeout: { until: new Date(until).toISOString(), minutes: Math.ceil((until - Date.now()) / 60000) } },
        info: { isBot: user.bot, byBot },
      });
    }
  }));

  // ---- roles ----------------------------------------------------------------------------------
  client.on(Events.GuildRoleCreate, safe('roleCreate', async (role) => {
    runtime.fire('trigger.role.created', { guild: role.guild, role, info: { byBot: selfActions.consume(`roleCreate:${role.guild.id}`) } });
  }));
  client.on(Events.GuildRoleDelete, safe('roleDelete', async (role) => {
    runtime.fire('trigger.role.deleted', { guild: role.guild, role, info: { byBot: selfActions.consume(`roleDelete:${role.id}`) } });
  }));
  client.on(Events.GuildRoleUpdate, safe('roleUpdate', async (o, n) => {
    if (o.name === n.name && o.hexColor === n.hexColor && o.permissions.bitfield === n.permissions.bitfield && o.hoist === n.hoist && o.mentionable === n.mentionable) return;
    runtime.fire('trigger.role.updated', {
      guild: n.guild, role: n, data: { oldRole: { name: o.name, color: o.hexColor } }, info: { byBot: selfActions.consume(`roleUpdate:${n.id}`) },
    });
  }));

  // ---- channels -------------------------------------------------------------------------------
  client.on(Events.ChannelCreate, safe('channelCreate', async (ch) => {
    if (!ch.guild) return;
    runtime.fire('trigger.channel.created', { guild: ch.guild, channel: ch, info: { byBot: selfActions.consume(`channelCreate:${ch.guild.id}`) } });
  }));
  client.on(Events.ChannelDelete, safe('channelDelete', async (ch) => {
    if (!ch.guild) return;
    components.forgetChannel(ch.guild.id, ch.id); // e.g. a closed ticket: its messages are gone too
    db.deleteVarsForScope(ch.guild.id, 'channel', ch.id); // …and so is what was remembered for the channel
    runtime.fire('trigger.channel.deleted', { guild: ch.guild, channel: ch, info: { byBot: selfActions.consume(`channelDelete:${ch.id}`) } });
  }));
  client.on(Events.ChannelUpdate, safe('channelUpdate', async (o, n) => {
    if (!n.guild) return;
    const changed = ['name', 'topic', 'parentId', 'nsfw', 'rateLimitPerUser'].some((k) => o[k] !== n[k]);
    if (!changed) return;
    runtime.fire('trigger.channel.updated', {
      guild: n.guild, channel: n, data: { oldChannel: { name: o.name ?? '', topic: o.topic ?? '' } }, info: { byBot: selfActions.consume(`channelUpdate:${n.id}`) },
    });
  }));

  // ---- reactions & voice ----------------------------------------------------------------------
  const onReaction = (kind) => safe(`reaction${kind}`, async (reaction, user) => {
    if (reaction.partial) reaction = await reaction.fetch();
    if (user.partial) user = await user.fetch();
    const message = reaction.message;
    const guild = message.guild;
    if (!guild || !has(guild, `trigger.reaction.${kind}`)) return;
    const member = await guild.members.fetch(user.id).catch(() => null);
    const e = reaction.emoji;
    const emoji = { name: e.name ?? '', id: e.id ?? '', display: e.toString() };
    runtime.fire(`trigger.reaction.${kind}`, {
      guild, channel: message.channel, user, member, message, data: { emoji },
      info: { isBot: user.bot, messageId: message.id, channelId: message.channelId, emoji },
    });
  });
  client.on(Events.MessageReactionAdd, onReaction('added'));
  client.on(Events.MessageReactionRemove, onReaction('removed'));

  client.on(Events.VoiceStateUpdate, safe('voice', async (o, n) => {
    if (o.channelId === n.channelId || !n.member) return;
    const { guild, member } = n;
    if (o.channelId && has(guild, 'trigger.voice.left')) {
      runtime.fire('trigger.voice.left', { guild, channel: o.channel, user: member.user, member, info: { isBot: member.user.bot, channelId: o.channelId } });
    }
    if (n.channelId && has(guild, 'trigger.voice.joined')) {
      runtime.fire('trigger.voice.joined', { guild, channel: n.channel, user: member.user, member, info: { isBot: member.user.bot, channelId: n.channelId } });
    }
  }));
}
