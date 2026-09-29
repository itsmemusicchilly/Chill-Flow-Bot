// Resolve ids/mentions/names to Discord objects — always through ctx.guild, and re-checked, so a flow can
// never touch another server even if its author pastes a foreign id.
import { FlowError } from './errors.js';

export const SNOWFLAKE = /^\d{5,25}$/;

export function cleanId(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^<(?:#|@&|@!|@)(\d+)>$/);
  return m ? m[1] : s;
}

export async function resolveChannel(ctx, value, { textBased = false, category = false } = {}) {
  const guild = ctx.guild;
  const raw = cleanId(value).replace(/^#/, '');
  let ch;
  if (!raw) {
    ch = ctx.channel;
    if (!ch) throw new FlowError('This flow has no “current channel” — pick a channel in the field, or set one on the trigger.');
  } else if (SNOWFLAKE.test(raw)) {
    ch = guild.channels.cache.get(raw) ?? await guild.channels.fetch(raw).catch(() => null);
  } else {
    ch = guild.channels.cache.find((c) => c.name?.toLowerCase() === raw.toLowerCase());
  }
  if (!ch || ch.guildId !== guild.id) throw new FlowError(`Channel “${raw || 'current'}” was not found in this server.`);
  if (textBased && !ch.isTextBased()) throw new FlowError(`#${ch.name} cannot receive messages.`);
  if (category && ch.type !== 4) throw new FlowError(`#${ch.name} is not a category.`);
  return ch;
}

export async function resolveRole(ctx, value) {
  const guild = ctx.guild;
  const s = String(value ?? '').trim();
  if (!s) throw new FlowError('No role was given.');
  if (/^@?everyone$/i.test(s)) return guild.roles.everyone;
  const raw = cleanId(s).replace(/^@/, '');
  const role = SNOWFLAKE.test(raw)
    ? guild.roles.cache.get(raw) ?? await guild.roles.fetch(raw).catch(() => null)
    : guild.roles.cache.find((r) => r.name.toLowerCase() === raw.toLowerCase());
  if (!role || role.guild?.id !== guild.id) throw new FlowError(`Role “${raw}” was not found in this server.`);
  return role;
}

/** User id (they may not be in the server — used for bans). Blank = the user who triggered the flow. */
export function resolveUserId(ctx, value) {
  const raw = cleanId(value) || ctx.user?.id;
  if (!raw) throw new FlowError('No user: this flow was not started by a person — fill in the user field.');
  if (!SNOWFLAKE.test(raw)) throw new FlowError(`“${raw}” is not a user ID (use a mention or numeric ID).`);
  return raw;
}

export async function resolveMember(ctx, value) {
  const id = resolveUserId(ctx, value);
  const guild = ctx.guild;
  if (ctx.member?.id === id && ctx.member.guild?.id === guild.id && !ctx.member.partial) return ctx.member;
  const member = guild.members.cache.get(id) ?? await guild.members.fetch(id).catch(() => null);
  if (!member) throw new FlowError(`User ${id} is not a member of this server.`);
  return member;
}

export const reasonFor = (ctx, d) => `[${ctx.flow.name}] ${d?.reason || ''}`.trim().slice(0, 500);

export function takeAction(ctx) {
  if (!ctx.services.guard.actions.take(ctx.guild.id)) {
    throw new FlowError('This server is running too many actions at once — slow down (rate limit).');
  }
}

/** Mark bot-caused events before the request so the resulting gateway events can be ignored. */
export async function withSelf(ctx, keys, fn) {
  const cancels = keys.map((k) => ctx.services.selfActions.expect(k));
  try { return await fn(); } catch (err) { cancels.forEach((c) => c()); throw err; }
}
