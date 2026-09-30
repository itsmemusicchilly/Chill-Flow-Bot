// Minimal stand-ins for discord.js objects, just enough for the executors and runtime.
import { ChannelType } from 'discord.js';
import { defaultsFor } from '../../shared/catalog.js';

export class Coll extends Map {
  find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
}

let seq = 1000;
const nextId = () => String(++seq * 1000 + 7);

export function fakeUser(over = {}) {
  const id = over.id ?? nextId();
  return { id, username: over.username ?? `user${id.slice(0, 3)}`, bot: false, globalName: null, displayAvatarURL: () => 'https://cdn/avatar.png', ...over };
}

export function fakeGuild(over = {}) {
  const id = over.id ?? nextId();
  const guild = {
    id, name: over.name ?? `Guild ${id}`, memberCount: 3, calls: [],
    client: { user: { id: 'BOT' }, guilds: { cache: new Coll() } },
    channels: { cache: new Coll() }, roles: { cache: new Coll() }, members: { cache: new Coll() },
  };
  guild.roles.everyone = { id, name: '@everyone', guild };
  guild.roles.cache.set(id, guild.roles.everyone);
  guild.members.me = { id: 'BOT', permissions: { has: () => true } };

  guild.addChannel = (o = {}) => {
    const ch = fakeChannel(guild, o);
    guild.channels.cache.set(ch.id, ch);
    return ch;
  };
  guild.addRole = (o = {}) => {
    const role = { id: o.id ?? nextId(), name: o.name ?? 'Role', guild, hexColor: '#000000', calls: [],
      async delete(reason) { role.calls.push(['delete', reason]); guild.roles.cache.delete(role.id); },
      async edit(p) { role.calls.push(['edit', p]); } };
    guild.roles.cache.set(role.id, role);
    return role;
  };
  guild.addMember = (o = {}) => {
    const user = o.user ?? fakeUser();
    const member = { id: user.id, user, guild, displayName: user.username, nickname: null, calls: [], partial: false,
      roles: { cache: new Coll(),
        async add(r, reason) { member.calls.push(['roleAdd', r.id, reason]); member.roles.cache.set(r.id, r); },
        async remove(r, reason) { member.calls.push(['roleRemove', r.id, reason]); member.roles.cache.delete(r.id); } },
      async kick(reason) { member.calls.push(['kick', reason]); },
      async timeout(ms, reason) { member.calls.push(['timeout', ms, reason]); },
      async setNickname(n, reason) { member.calls.push(['nick', n, reason]); },
      async send(p) { member.calls.push(['dm', p]); return { id: 'dm1' }; },
      permissions: { toArray: () => [], has: () => false } };
    guild.members.cache.set(member.id, member);
    return member;
  };
  guild.channels.fetch = async (cid) => guild.channels.cache.get(cid) ?? guild.foreign?.get(cid) ?? null;
  guild.roles.fetch = async (rid) => guild.roles.cache.get(rid) ?? null;
  guild.members.fetch = async (arg) => guild.members.cache.get(typeof arg === 'object' ? arg.user : arg) ?? null; // like discord.js: an id, or { user, force }
  guild.channels.create = async (options) => { guild.calls.push(['channelCreate', options]); return guild.addChannel({ name: options.name, type: options.type }); };
  guild.roles.create = async (options) => { guild.calls.push(['roleCreate', options]); return guild.addRole({ name: options.name }); };
  guild.members.ban = async (uid, options) => { guild.calls.push(['ban', uid, options]); };
  guild.members.unban = async (uid, reason) => { guild.calls.push(['unban', uid, reason]); };
  guild.client.guilds.cache.set(id, guild);
  return guild;
}

export function fakeChannel(guild, o = {}) {
  const ch = {
    id: o.id ?? nextId(), name: o.name ?? 'general', guild, guildId: guild.id, type: o.type ?? ChannelType.GuildText, parentId: null, topic: '',
    sent: [], sentIds: [], calls: [],
    // fetch(id) → one message; fetch({ limit, after, before }) → a page, like Discord: `after` gives the OLDEST `limit` messages
    // after that id, anything else the NEWEST `limit`. `order` sets the order inside the page ('desc' = newest first, as Discord sends it).
    messages: {
      store: new Map(), fetchCalls: [], order: 'desc',
      async fetch(arg) {
        if (typeof arg !== 'object' || arg === null) return ch.messages.store.get(arg) ?? null;
        ch.messages.fetchCalls.push(arg);
        let list = [...ch.messages.store.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        if (arg.after !== undefined) list = list.filter((m) => BigInt(m.id) > BigInt(arg.after));
        if (arg.before !== undefined) list = list.filter((m) => BigInt(m.id) < BigInt(arg.before));
        const limit = arg.limit ?? 50;
        list = arg.after !== undefined ? list.slice(0, limit) : list.slice(-limit);
        if (ch.messages.order === 'desc') list.reverse();
        return new Coll(list.map((m) => [m.id, m]));
      },
    },
    isTextBased: () => [0, 5, 2, 13].includes(ch.type) === true && ch.type !== 2 && ch.type !== 13,
    // what the bot posts is also part of the channel's history
    async send(p) {
      const m = { id: nextId(), ...p };
      ch.sent.push(p); ch.sentIds.push(m.id);
      ch.addMessage({ id: m.id, content: p.content ?? '', author: { id: 'BOT', username: 'flowbot', bot: true }, embeds: (p.embeds ?? []).map((e) => e.data ?? e) });
      return m;
    },
    addMessage(o = {}) {
      const id = o.id ?? nextId();
      const list = (x) => new Coll((x ?? []).map((v, i) => [String(i), v]));
      const msg = {
        id, channel: ch, createdTimestamp: o.at ?? Date.now(), editedTimestamp: o.editedTimestamp ?? null,
        content: o.content ?? '', cleanContent: o.cleanContent ?? o.content ?? '',
        author: o.author ?? { id: '222222', username: 'mia', bot: false }, member: o.member,
        attachments: list(o.attachments), embeds: o.embeds ?? [], stickers: list(o.stickers), reference: o.reference ?? null,
        system: o.system ?? false, type: o.type ?? 0,
      };
      ch.messages.store.set(id, msg);
      return msg;
    },
    // who can see this channel: everyone unless a test lists `hidden` ids
    hidden: new Set(),
    permissionsFor: (who) => ({ has: () => !ch.hidden.has(who?.id) }),
    async delete(reason) { ch.calls.push(['delete', reason]); guild.channels.cache.delete(ch.id); },
    async edit(p) { ch.calls.push(['edit', p]); },
    permissionOverwrites: { async edit(t, perms, opt) { ch.calls.push(['overwrite', t.id, perms, opt]); } },
  };
  return ch;
}

const baseInteraction = (guild, channel, user, member) => ({
  guild, guildId: guild?.id, channel, channelId: channel?.id, user, member, calls: [],
  isChatInputCommand: () => false, isMessageComponent: () => false, isModalSubmit: () => false,
});

export function fakeCommand({ guild, channel, user, member, commandName, options = [] }) {
  const i = { ...baseInteraction(guild, channel, user, member), commandName, options: { data: options }, isChatInputCommand: () => true };
  i.reply = async (p) => { i.calls.push(['reply', p]); return { resource: { message: { id: `m${i.calls.length}` } } }; };
  i.deferReply = async (p) => { i.calls.push(['deferReply', p]); };
  i.editReply = async (p) => { i.calls.push(['editReply', p]); return { id: 'edited' }; };
  i.followUp = async (p) => { i.calls.push(['followUp', p]); return { id: 'follow' }; };
  return i;
}

export function fakeComponent({ guild, channel, user, member, customId, messageId = 'MSG1', values, label = '' }) {
  const i = { ...baseInteraction(guild, channel, user, member), customId, values, component: { label }, isMessageComponent: () => true,
    message: { id: messageId, edit: async (p) => { i.calls.push(['messageEdit', p]); } } };
  i.reply = async (p) => { i.calls.push(['reply', p]); return { resource: { message: { id: `m${i.calls.length}` } } }; };
  i.update = async (p) => { i.calls.push(['update', p]); };
  i.deferUpdate = async () => { i.calls.push(['deferUpdate']); };
  i.deferReply = async (p) => { i.calls.push(['deferReply', p]); };
  i.editReply = async (p) => { i.calls.push(['editReply', p]); return { id: 'edited' }; };
  i.followUp = async (p) => { i.calls.push(['followUp', p]); return { id: 'follow' }; };
  return i;
}

// ---- graph builders ----------------------------------------------------------------------------
export const node = (id, type, data = {}, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { ...defaultsFor(type), ...data } });
export const edge = (source, target, sourceHandle = 'out') => ({ id: `${source}:${sourceHandle}>${target}`, source, sourceHandle, target, targetHandle: 'in' });
export const commandFlow = (nodes, edges, name = 'cmd') => ({
  nodes: [node('t', 'trigger.command', { name, description: 'test' }), ...nodes],
  edges,
});
