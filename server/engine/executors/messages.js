import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { LIMITS } from '../../../shared/limits.js';
import { FlowError } from '../errors.js';
import { buildPayload, parseEmoji } from '../payload.js';
import { newAck, respond } from '../responder.js';
import { cleanId, resolveChannel, resolveMember, SNOWFLAKE } from '../resolve.js';

async function fetchMessage(ctx, channelValue, messageValue) {
  const channel = await resolveChannel(ctx, channelValue, { textBased: true });
  const id = cleanId(messageValue) || ctx.data.message?.id;
  if (!id || !SNOWFLAKE.test(id)) throw new FlowError('No message: give a message ID (for example {{var.msg}}).');
  const message = await channel.messages.fetch(id).catch(() => null);
  if (!message) throw new FlowError(`Message ${id} was not found in #${channel.name}.`);
  return message;
}

async function send({ ctx, d, node }) {
  const payload = buildPayload(ctx, d, node, { replace: d.target === 'update' });
  let sent = null;
  switch (d.target) {
    case 'reply': sent = await respond(ctx, 'reply', payload, d.ephemeral); break;
    case 'update': sent = await respond(ctx, 'update', payload); break;
    case 'current_channel': sent = await (await resolveChannel(ctx, '', { textBased: true })).send(payload); break;
    case 'channel': sent = await (await resolveChannel(ctx, d.channelId, { textBased: true })).send(payload); break;
    case 'dm': {
      const member = await resolveMember(ctx, d.userId); // DMs only ever go to members of this server
      sent = await member.send(payload);
      break;
    }
    default: throw new FlowError(`Unknown target “${d.target}”.`);
  }
  if (d.outputVar && sent?.id) ctx.vars[d.outputVar] = sent.id;
  if (sent?.id && (payload.components?.length)) {
    try {
      ctx.services.components.remember(sent.id, ctx, {
        channelId: sent.channelId ?? ctx.channel?.id ?? '',
        ephemeral: Boolean(d.target === 'reply' && d.ephemeral),
      });
    } catch (err) {
      // The message is already out; losing its remembered variables must not turn a success into an error.
      ctx.services.logger.log(ctx.guild.id, 'warn', `Could not remember the buttons' variables: ${err.message}`, ctx.logMeta);
    }
  }
}

async function edit({ ctx, d, node }) {
  const message = await fetchMessage(ctx, d.channelId, d.messageId);
  if (message.author.id !== ctx.guild.client.user.id) throw new FlowError('The bot can only edit its own messages.');
  await message.edit(buildPayload(ctx, d, node, { components: false, replace: true }));
}

async function remove({ ctx, d }) {
  const message = await fetchMessage(ctx, d.channelId, d.messageId);
  await message.delete();
}

async function react({ ctx, d }) {
  const emoji = parseEmoji(d.emoji);
  if (!emoji) throw new FlowError('Choose an emoji.');
  const message = await fetchMessage(ctx, d.channelId, d.messageId);
  await message.react(typeof emoji === 'string' ? emoji : `${emoji.name}:${emoji.id}`);
}

async function showModal({ ctx, d, node }) {
  const i = ctx.interaction;
  if (!i?.showModal) throw new FlowError('A form can only be shown in response to a command or a button press.');
  if (ctx.ack.state !== null) throw new FlowError('The form must be the first response to the command/button — the flow already answered or took too long.');
  const customId = `fcm:${ctx.runId}:${node.id}`;
  const inputs = (d.inputs || []).slice(0, 5);
  const modal = new ModalBuilder().setCustomId(customId).setTitle(String(d.title || 'Form').slice(0, 45));
  for (const inp of inputs) {
    const t = new TextInputBuilder()
      .setCustomId(`in_${inp.id}`)
      .setLabel(String(inp.label || inp.id).slice(0, 45))
      .setStyle(inp.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(inp.required !== false);
    if (inp.placeholder) t.setPlaceholder(String(inp.placeholder).slice(0, 100));
    const max = Number(inp.maxLength);
    if (Number.isFinite(max) && max > 0) t.setMaxLength(Math.min(4000, max));
    modal.addComponents(new ActionRowBuilder().addComponents(t));
  }
  ctx.ack.state = 'modal';
  await i.showModal(modal);
  let submit;
  try {
    submit = await i.awaitModalSubmit({ time: LIMITS.modalWaitMs, filter: (m) => m.customId === customId && m.user.id === i.user.id });
  } catch {
    throw new FlowError('The form was not submitted in time.');
  }
  ctx.interaction = submit;
  ctx.ack = newAck();
  ctx.armDefer?.();
  ctx.data.input = Object.fromEntries(inputs.map((inp) => [inp.id, submit.fields.getTextInputValue(`in_${inp.id}`)]));
  return 'submit';
}

export const messageExecutors = {
  'action.message.send': send,
  'action.message.edit': edit,
  'action.message.delete': remove,
  'action.message.react': react,
  'action.modal.show': showModal,
};
