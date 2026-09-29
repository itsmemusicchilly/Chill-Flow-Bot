import { PermissionFlagsBits } from 'discord.js';
import { FlowError } from '../errors.js';
import { parseColor } from '../payload.js';
import { reasonFor, resolveRole, withSelf } from '../resolve.js';

const yesNo = (v) => (v === 'yes' ? true : v === 'no' ? false : undefined);

export const roleExecutors = {
  async 'action.role.create'({ ctx, d }) {
    if (!String(d.name || '').trim()) throw new FlowError('The role name is empty.');
    const perms = (Array.isArray(d.permissions) ? d.permissions : []).filter((p) => p in PermissionFlagsBits).map((p) => PermissionFlagsBits[p]);
    const role = await withSelf(ctx, [`roleCreate:${ctx.guild.id}`], () => ctx.guild.roles.create({
      name: String(d.name).slice(0, 100),
      color: parseColor(d.color) ?? undefined,
      hoist: Boolean(d.hoist),
      mentionable: Boolean(d.mentionable),
      permissions: perms,
      reason: reasonFor(ctx, d),
    }));
    if (d.outputVar) ctx.vars[d.outputVar] = role.id;
  },

  async 'action.role.delete'({ ctx, d }) {
    const role = await resolveRole(ctx, d.roleId);
    if (role.id === ctx.guild.id) throw new FlowError('The @everyone role cannot be deleted.');
    await withSelf(ctx, [`roleDelete:${role.id}`], () => role.delete(reasonFor(ctx, d)));
  },

  async 'action.role.update'({ ctx, d }) {
    const role = await resolveRole(ctx, d.roleId);
    const edit = {};
    if (d.name) edit.name = String(d.name).slice(0, 100);
    if (d.color) {
      const c = parseColor(d.color);
      if (c === null) throw new FlowError('Color must look like #ff8800.');
      edit.color = c;
    }
    if (yesNo(d.hoist) !== undefined) edit.hoist = yesNo(d.hoist);
    if (yesNo(d.mentionable) !== undefined) edit.mentionable = yesNo(d.mentionable);
    if (!Object.keys(edit).length) return;
    await withSelf(ctx, [`roleUpdate:${role.id}`], () => role.edit({ ...edit, reason: reasonFor(ctx, d) }));
  },
};
