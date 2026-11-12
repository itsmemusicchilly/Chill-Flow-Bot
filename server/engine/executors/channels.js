import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { FlowError } from '../errors.js';
import { cleanId, reasonFor, resolveChannel, resolveMember, resolveRole, SNOWFLAKE, withSelf } from '../resolve.js';

const TYPES = {
  text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement, stage: ChannelType.GuildStageVoice, forum: ChannelType.GuildForum,
};
const BOT_PRIVATE_ACCESS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks', 'ManageChannels'];

const permList = (names) => (Array.isArray(names) ? names : []).filter((n) => n in PermissionFlagsBits);
const int = (v) => (v === '' || v === undefined || v === null ? undefined : Math.trunc(Number(v)));

/** Resolve the flow's overwrite list into discord.js overwrite objects, merged per target id. */
async function buildOverwrites(ctx, d) {
  const merged = new Map();
  const put = (id, type, allow, deny) => {
    const cur = merged.get(id) || { id, type, allow: new Set(), deny: new Set() };
    for (const a of allow) { cur.allow.add(a); cur.deny.delete(a); }
    for (const x of deny) { cur.deny.add(x); cur.allow.delete(x); }
    merged.set(id, cur);
  };
  if (d.privateChannel) {
    put(ctx.guild.roles.everyone.id, OverwriteType.Role, [], ['ViewChannel']);
    const me = ctx.guild.members.me;
    // keep the bot able to use the channel it is creating (only permissions it actually has)
    if (me) put(me.id, OverwriteType.Member, BOT_PRIVATE_ACCESS.filter((p) => me.permissions.has(PermissionFlagsBits[p])), []);
  }
  for (const o of d.overwrites || []) {
    if (o.targetType === 'member') {
      const m = await resolveMember(ctx, o.targetId);
      put(m.id, OverwriteType.Member, permList(o.allow), permList(o.deny));
    } else {
      const r = await resolveRole(ctx, o.targetId);
      put(r.id, OverwriteType.Role, permList(o.allow), permList(o.deny));
    }
  }
  return [...merged.values()].map((o) => ({
    id: o.id, type: o.type,
    allow: [...o.allow].map((p) => PermissionFlagsBits[p]),
    deny: [...o.deny].map((p) => PermissionFlagsBits[p]),
  }));
}

const THREAD_TYPES = new Set([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
const FORUM_TYPES = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);
const ARCHIVE_MINUTES = [60, 1440, 4320, 10080];

export const channelExecutors = {
  /** A thread in a channel, a thread on a message, or a post in a forum (which is a thread with a first message). */
  async 'action.thread.create'({ ctx, d }) {
    const name = String(d.name || '').trim();
    if (!name) throw new FlowError('The thread name is empty.');
    const content = String(d.content ?? '').trim().slice(0, 2000);
    const base = { name: name.slice(0, 100), autoArchiveDuration: ARCHIVE_MINUTES.includes(Number(d.autoArchive)) ? Number(d.autoArchive) : 1440, reason: reasonFor(ctx, d) };
    const parent = await resolveChannel(ctx, d.channelId);
    const forum = FORUM_TYPES.has(parent.type);
    let create;
    if (forum) {
      if (!content) throw new FlowError('A forum post needs a first message — Discord does not allow an empty one.');
      create = () => parent.threads.create({ ...base, message: { content } });
    } else if (d.from === 'message') {
      const id = cleanId(d.messageId) || ctx.data.message?.id;
      if (!id || !SNOWFLAKE.test(id)) throw new FlowError('No message to start the thread on: give a message ID (for example {{var.msg}}).');
      const message = typeof parent.messages?.fetch === 'function' ? await parent.messages.fetch(id).catch(() => null) : null;
      if (!message) throw new FlowError(`Message ${id} was not found in #${parent.name}.`);
      create = () => message.startThread(base);
    } else {
      if (typeof parent.threads?.create !== 'function') throw new FlowError(`#${parent.name} cannot have threads.`);
      create = () => parent.threads.create({ ...base, type: d.privateThread ? ChannelType.PrivateThread : ChannelType.PublicThread });
    }
    const invited = String(d.addUserId ?? '').trim() ? await resolveMember(ctx, d.addUserId) : null; // only members of this server
    const thread = await withSelf(ctx, [`threadCreate:${ctx.guild.id}`], create);
    ctx.data.thread = { id: thread.id, mention: `<#${thread.id}>`, name: thread.name ?? base.name };
    if (d.outputVar) ctx.vars[d.outputVar] = thread.id;
    if (content && !forum) await thread.send({ content });
    if (invited) await thread.members.add(invited.id, base.reason);
  },

  async 'action.thread.update'({ ctx, d }) {
    const thread = await resolveChannel(ctx, d.channelId);
    if (!THREAD_TYPES.has(thread.type)) throw new FlowError(`#${thread.name} is not a thread.`);
    const reason = reasonFor(ctx, d);
    const added = String(d.addUserId ?? '').trim() ? await resolveMember(ctx, d.addUserId) : null;
    const removedId = String(d.removeUserId ?? '').trim() ? cleanId(d.removeUserId) : '';
    if (removedId && !SNOWFLAKE.test(removedId)) throw new FlowError(`“${removedId}” is not a user ID (use a mention or numeric ID).`);
    const edit = {};
    if (d.archived === 'no') edit.archived = false; // a closed thread must be reopened before anything else can change
    if (d.locked) edit.locked = d.locked === 'yes';
    if (d.name) {
      // A thread's name has the same limit as a channel's: two changes every 10 minutes. Past that the newest name is held, never the run.
      const name = String(d.name).slice(0, 100);
      const log = (level, message) => ctx.services.logger.log(ctx.guild.id, level, message, ctx.logMeta);
      const held = ctx.services.channelEdits.request(ctx.guild.id, thread.id, { name }, (patch) => thread.edit({ ...patch, reason }), (err) => {
        if (err) log('warn', `The held new name of the thread could not be set: ${err.message}`);
        else log('info', 'The held new name of the thread was set.');
      });
      if (!held) edit.name = name;
      else log('info', `Discord allows only two name changes per thread every 10 minutes, so this one is held back; the newest name is set in about ${Math.max(1, Math.round(held.wait / 60_000))} minute(s).`);
    }
    if (Object.keys(edit).length) await thread.edit({ ...edit, reason });
    if (added) await thread.members.add(added.id, reason);
    if (removedId) await thread.members.remove(removedId, reason);
    if (d.archived === 'yes') await thread.edit({ archived: true, reason }); // last: nothing can be changed once it is closed
  },

  async 'action.channel.create'({ ctx, d }) {
    const type = TYPES[d.type];
    if (type === undefined) throw new FlowError(`Unknown channel type “${d.type}”.`);
    if (!String(d.name || '').trim()) throw new FlowError('The channel name is empty.');
    const options = { name: String(d.name).slice(0, 100), type, reason: reasonFor(ctx, d) };
    if (d.parentId && d.type !== 'category') options.parent = (await resolveChannel(ctx, d.parentId, { category: true })).id;
    if (d.topic && ['text', 'announcement', 'forum'].includes(d.type)) options.topic = String(d.topic).slice(0, 1024);
    if (d.nsfw && d.type !== 'category' && d.type !== 'stage') options.nsfw = true;
    if (['text', 'forum'].includes(d.type) && int(d.slowmode) !== undefined) options.rateLimitPerUser = Math.min(21600, Math.max(0, int(d.slowmode)));
    if (['voice', 'stage'].includes(d.type) && int(d.userLimit) !== undefined) options.userLimit = Math.min(99, Math.max(0, int(d.userLimit)));
    const overwrites = await buildOverwrites(ctx, d);
    if (overwrites.length) options.permissionOverwrites = overwrites;
    const channel = await withSelf(ctx, [`channelCreate:${ctx.guild.id}`], () => ctx.guild.channels.create(options));
    if (d.outputVar) ctx.vars[d.outputVar] = channel.id;
  },

  async 'action.channel.delete'({ ctx, d }) {
    const channel = await resolveChannel(ctx, d.channelId);
    await withSelf(ctx, [`channelDelete:${channel.id}`], () => channel.delete(reasonFor(ctx, d)));
  },

  async 'action.channel.update'({ ctx, d }) {
    const channel = await resolveChannel(ctx, d.channelId);
    const edit = {};
    if (d.name) edit.name = String(d.name).slice(0, 100);
    if (d.topic) edit.topic = String(d.topic).slice(0, 1024);
    if (d.parentId) edit.parent = (await resolveChannel(ctx, d.parentId, { category: true })).id;
    if (int(d.slowmode) !== undefined) edit.rateLimitPerUser = Math.min(21600, Math.max(0, int(d.slowmode)));
    if (d.nsfw) edit.nsfw = d.nsfw === 'yes';
    const reason = reasonFor(ctx, d);
    // The self-action mark is made when a change is really sent, so a held change never expires its mark while it waits.
    const apply = (patch) => withSelf(ctx, [`channelUpdate:${channel.id}`], () => channel.edit({ ...patch, reason }));
    // Discord only allows ~2 name/topic changes per channel every 10 minutes: past that the newest one is held (see channel-edits.js)
    // instead of making this run wait. Other settings (category, slowmode, age restriction) are not limited and go at once.
    const limited = {};
    for (const key of ['name', 'topic']) if (key in edit) { limited[key] = edit[key]; delete edit[key]; }
    if (Object.keys(limited).length) {
      const label = channel.name ? `#${channel.name}` : 'the channel';
      const held = ctx.services.channelEdits.request(ctx.guild.id, channel.id, limited, apply, (err) => {
        if (err) ctx.services.logger.log(ctx.guild.id, 'warn', `The held change to ${label} could not be made: ${err.message}`, ctx.logMeta);
        else ctx.services.logger.log(ctx.guild.id, 'info', `The held change to ${label} was made.`, ctx.logMeta);
      });
      if (!held) Object.assign(edit, limited);
      else {
        const minutes = Math.max(1, Math.round(held.wait / 60_000));
        ctx.services.logger.log(ctx.guild.id, 'info', `Discord allows only two name/topic changes per channel every 10 minutes, so this change to ${label} is held back; the newest one is applied in about ${minutes} minute${minutes === 1 ? '' : 's'}.`, ctx.logMeta);
      }
    }
    if (Object.keys(edit).length) await apply(edit);
    for (const o of d.overwrites || []) {
      const target = o.targetType === 'member' ? await resolveMember(ctx, o.targetId) : await resolveRole(ctx, o.targetId);
      const perms = {};
      for (const p of permList(o.allow)) perms[p] = true;
      for (const p of permList(o.deny)) perms[p] = false;
      await withSelf(ctx, [`channelUpdate:${channel.id}`], () => channel.permissionOverwrites.edit(target, perms, { reason }));
    }
  },
};

