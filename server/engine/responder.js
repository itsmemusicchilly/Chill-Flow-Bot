// Everything about answering a Discord interaction exactly once, in the right way.
// ack.state: null | 'replied' | 'deferred' | 'deferredUpdate' | 'updated' | 'modal'
import { MessageFlags } from 'discord.js';
import { FlowError } from './errors.js';

export const newAck = () => ({ state: null, firstDone: false, pending: null });

const isComponent = (i) => Boolean(i?.isMessageComponent?.());
const canUpdate = (i) => isComponent(i) || Boolean(i?.isModalSubmit?.() && i.isFromMessage?.());

function respondPlain(ctx, payload) {
  if (ctx.message?.reply) return ctx.message.reply(payload);
  if (ctx.channel?.send) return ctx.channel.send(payload);
  throw new FlowError('There is nothing to reply to here — send to a specific channel instead.');
}

/**
 * @param {'reply'|'update'} kind
 * @returns the sent Message when Discord gives us one, otherwise null
 */
export async function respond(ctx, kind, payload, ephemeral = false) {
  const i = ctx.interaction;
  if (!i) return respondPlain(ctx, payload);
  await ctx.ack.pending;
  const ack = ctx.ack;
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined;

  if (kind === 'update' && canUpdate(i)) {
    if (ack.state === null) { ack.state = 'updated'; await i.update(payload); return i.message; }
    if (ack.state === 'deferredUpdate') return i.editReply(payload);
    return i.message.edit(payload);
  }
  if (ack.state === null) {
    ack.state = 'replied';
    const res = await i.reply({ ...payload, flags, withResponse: true });
    return res?.resource?.message ?? null;
  }
  if (ack.state === 'deferred' && !ack.firstDone) { ack.firstDone = true; return i.editReply(payload); }
  return i.followUp({ ...payload, flags });
}

/** Discord gives us 3 s to answer; if the flow is still busy, buy time. */
export async function autoDefer(ctx) {
  const i = ctx.interaction;
  const ack = ctx.ack;
  if (!i || ack.state !== null) return;
  let p;
  if (isComponent(i)) { ack.state = 'deferredUpdate'; p = i.deferUpdate(); }
  else { ack.state = 'deferred'; p = i.deferReply({ flags: ctx.deferEphemeral ? MessageFlags.Ephemeral : undefined }); }
  ack.pending = p.catch((err) => ctx.services.logger.log(ctx.guild.id, 'warn', `Could not defer the interaction: ${err.message}`, ctx.logMeta));
  await ack.pending;
  ack.pending = null;
}

/** Never leave a user staring at “thinking…” or “This interaction failed”. */
export async function finalize(ctx, { failed = false } = {}) {
  const i = ctx.interaction;
  if (!i) return;
  const message = failed ? '⚠️ Something went wrong while running this. The server admins can see details in the flow logs.' : '✅ Done.';
  try {
    await ctx.ack.pending;
    const ack = ctx.ack;
    if (ack.state === null) {
      if (isComponent(i) && !failed) { ack.state = 'deferredUpdate'; await i.deferUpdate(); }
      else { ack.state = 'replied'; await i.reply({ content: message, flags: MessageFlags.Ephemeral }); }
    } else if (ack.state === 'deferred' && !ack.firstDone) {
      ack.firstDone = true;
      await i.editReply({ content: message });
    } else if (failed && ack.state !== 'modal') {
      await i.followUp({ content: message, flags: MessageFlags.Ephemeral });
    }
  } catch { /* the interaction token expired; nothing more we can do */ }
}
