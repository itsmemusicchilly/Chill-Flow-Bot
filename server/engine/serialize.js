// Discord objects → plain, template-friendly data. Only harmless, public fields are exposed.
import { ChannelType } from 'discord.js';

export function userData(user, member) {
  if (!user) return undefined;
  return {
    id: user.id,
    name: user.username ?? '',
    displayName: member?.displayName ?? user.globalName ?? user.username ?? '',
    tag: user.tag ?? user.username ?? '',
    mention: `<@${user.id}>`,
    avatar: user.displayAvatarURL?.() ?? '',
    isBot: Boolean(user.bot),
    createdAt: user.createdAt?.toISOString?.() ?? '',
  };
}

export function memberData(m) {
  if (!m) return undefined;
  return {
    nickname: m.nickname ?? '',
    joinedAt: m.joinedAt?.toISOString?.() ?? '',
    roleIds: m.roles?.cache ? [...m.roles.cache.keys()].filter((id) => id !== m.guild?.id) : [],
    permissions: m.permissions?.toArray?.() ?? [],
  };
}

export const guildData = (g) => ({ id: g.id, name: g.name ?? '', memberCount: g.memberCount ?? 0 });

export function channelData(c) {
  if (!c) return undefined;
  return { id: c.id, name: c.name ?? '', mention: `<#${c.id}>`, type: ChannelType[c.type] ?? String(c.type ?? ''), parentId: c.parentId ?? '', topic: c.topic ?? '' };
}

export function messageData(m) {
  if (!m) return undefined;
  return { id: m.id, content: m.content ?? '', url: m.url ?? '', authorId: m.author?.id ?? '' };
}

export const roleData = (r) => (r ? { id: r.id, name: r.name ?? '', mention: `<@&${r.id}>`, color: r.hexColor ?? '' } : undefined);

export function executorData(user, reason) {
  return { executor: user ? { id: user.id, name: user.username ?? '', mention: `<@${user.id}>` } : undefined, reason: reason ?? '' };
}

export function nowInfo(date = new Date()) {
  const iso = date.toISOString();
  return { iso, date: iso.slice(0, 10), time: iso.slice(11, 19), timestamp: Math.floor(date.getTime() / 1000) };
}
