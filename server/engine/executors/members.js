import { FlowError } from '../errors.js';
import { reasonFor, resolveMember, resolveRole, resolveUserId, withSelf } from '../resolve.js';
import { roleData } from '../serialize.js';

const key = (ctx, kind, userId, extra = '') => `${kind}:${ctx.guild.id}:${userId}${extra}`;

export const memberExecutors = {
  async 'action.member.addRole'({ ctx, d }) {
    const member = await resolveMember(ctx, d.userId);
    const role = await resolveRole(ctx, d.roleId);
    await withSelf(ctx, [key(ctx, 'roleAdd', member.id, `:${role.id}`)], () => member.roles.add(role, reasonFor(ctx, d)));
  },
  async 'action.member.removeRole'({ ctx, d }) {
    const member = await resolveMember(ctx, d.userId);
    const role = await resolveRole(ctx, d.roleId);
    await withSelf(ctx, [key(ctx, 'roleRemove', member.id, `:${role.id}`)], () => member.roles.remove(role, reasonFor(ctx, d)));
  },
  async 'action.member.toggleRole'({ ctx, d }) {
    let member = await resolveMember(ctx, d.userId);
    const role = await resolveRole(ctx, d.roleId);
    if (role.id === ctx.guild.id) throw new FlowError('The @everyone role cannot be toggled.');
    // The clicker's own member object is fresh from Discord; anyone else may be stale in the cache, so ask again.
    if (member.id !== ctx.user?.id) member = (await ctx.guild.members.fetch({ user: member.id, force: true }).catch(() => null)) ?? member;
    const has = member.roles.cache.has(role.id);
    const kind = has ? 'roleRemove' : 'roleAdd';
    await withSelf(ctx, [key(ctx, kind, member.id, `:${role.id}`)], () => (has
      ? member.roles.remove(role, reasonFor(ctx, d))
      : member.roles.add(role, reasonFor(ctx, d))));
    ctx.data.role = roleData(role);
    ctx.data.toggle = { action: has ? 'removed' : 'added' };
  },
  async 'action.member.kick'({ ctx, d }) {
    const member = await resolveMember(ctx, d.userId);
    await withSelf(ctx, [key(ctx, 'kick', member.id)], () => member.kick(reasonFor(ctx, d)));
  },
  async 'action.member.ban'({ ctx, d }) {
    const id = resolveUserId(ctx, d.userId);
    const days = Math.min(7, Math.max(0, Number(d.deleteMessageDays) || 0));
    await withSelf(ctx, [key(ctx, 'ban', id)], () => ctx.guild.members.ban(id, { reason: reasonFor(ctx, d), deleteMessageSeconds: days * 86400 }));
  },
  async 'action.member.unban'({ ctx, d }) {
    const id = resolveUserId(ctx, d.userId);
    await withSelf(ctx, [key(ctx, 'unban', id)], () => ctx.guild.members.unban(id, reasonFor(ctx, d)));
  },
  async 'action.member.timeout'({ ctx, d }) {
    const minutes = Number(d.minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 40320) throw new FlowError('Timeout minutes must be between 0 and 40320 (28 days).');
    const member = await resolveMember(ctx, d.userId);
    await withSelf(ctx, [key(ctx, 'timeout', member.id)], () => member.timeout(minutes === 0 ? null : minutes * 60000, reasonFor(ctx, d)));
  },
  async 'action.member.nickname'({ ctx, d }) {
    const member = await resolveMember(ctx, d.userId);
    await member.setNickname(d.nickname ? String(d.nickname).slice(0, 32) : null, reasonFor(ctx, d));
  },
};
