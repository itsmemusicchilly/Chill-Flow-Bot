import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { FlowError } from '../errors.js';
import { reasonFor, resolveChannel, resolveMember, resolveRole, withSelf } from '../resolve.js';

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

export const channelExecutors = {
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

