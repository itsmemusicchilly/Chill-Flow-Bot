import { ActionRowBuilder, ButtonBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { LIMITS } from '../../../shared/limits.js';
import { parseButtonId } from '../custom-id.js';
import { FlowError } from '../errors.js';
import { buildButton, buildPayload, parseEmoji } from '../payload.js';
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

const isButton = (c) => c instanceof ButtonBuilder;
/** A button's Button ID (`fcb:<id>`), or null for a link or a button wired to an output. */
const buttonIdOf = (c) => parseButtonId(c.data.custom_id ?? '')?.id ?? null;
/** What makes two buttons "the same one" when adding: the Button ID, the full id of a wired button, or the link address. */
function identity(c) {
  const cid = c.data.custom_id;
  if (cid) { const b = parseButtonId(cid); return b ? `id:${b.id}` : `cid:${cid}`; }
  return c.data.url ? `url:${c.data.url}` : null;
}
const matchesTarget = (c, target) => target !== '' && (buttonIdOf(c) === target || String(c.data.label ?? '').trim().toLowerCase() === target.toLowerCase());

async function changeButtons({ ctx, d, node }) {
  const message = await fetchMessage(ctx, d.channelId, d.messageId);
  if (message.author.id !== ctx.guild.client.user.id) throw new FlowError('The bot can only change the buttons of its own messages.');
  const log = (level, text) => ctx.services.logger.log(ctx.guild.id, level, text, ctx.logMeta);
  let rows = (message.components || []).map((r) => ActionRowBuilder.from(r));
  const before = JSON.stringify(rows.map((r) => r.toJSON()));
  const targets = (d.targets || []).map((t) => String(t.match ?? '').trim()).filter(Boolean);
  const named = () => targets.map((t) => `“${t}”`).join(', ');
  let added = [];

  switch (d.mode) {
    case 'clear':
      rows = [];
      break;
    case 'remove': {
      if (!targets.length) throw new FlowError('Say which buttons to remove (a Button ID or a label), or choose “Remove all buttons”.');
      let hit = 0;
      for (const row of rows) {
        row.setComponents(row.components.filter((c) => {
          const gone = isButton(c) && targets.some((t) => matchesTarget(c, t));
          if (gone) hit += 1;
          return !gone;
        }));
      }
      rows = rows.filter((r) => r.components.length);
      if (!hit) log('warn', `No button on the message matched ${named()}, so nothing was removed.`);
      break;
    }
    case 'disable':
    case 'enable': {
      let hit = 0;
      for (const row of rows) {
        for (const c of row.components) {
          if (!isButton(c) || (targets.length && !targets.some((t) => matchesTarget(c, t)))) continue;
          hit += 1;
          c.setDisabled(d.mode === 'disable');
        }
      }
      if (!hit) log('warn', `No button on the message${targets.length ? ` matched ${named()}` : ''}, so nothing was ${d.mode}d.`);
      break;
    }
    case 'add': {
      const invokerId = d.restrictToInvoker ? (ctx.user?.id ?? '') : '';
      const seenKeys = new Set();
      const fresh = (d.buttons || []).slice(0, 25).map((b) => buildButton(ctx, node, b, { invokerId, seenKeys }));
      if (!fresh.length) throw new FlowError('Add at least one button.');
      // A button that is already on the message is updated where it stands, so running this twice never doubles it (Discord refuses two with one id).
      const appended = [];
      for (const btn of fresh) {
        const key = identity(btn);
        let replaced = false;
        for (const row of rows) {
          const i = key ? row.components.findIndex((c) => isButton(c) && identity(c) === key) : -1;
          if (i >= 0) { row.components[i] = btn; replaced = true; break; }
        }
        if (!replaced) appended.push(btn);
      }
      let noRoom = 0;
      for (const btn of appended) {
        const last = rows.at(-1);
        if (last && last.components.length < 5 && last.components.every(isButton)) last.addComponents(btn);
        else if (rows.length < 5) rows.push(new ActionRowBuilder().addComponents(btn));
        else noRoom += 1;
      }
      if (noRoom) throw new FlowError(`The message has no room for ${noRoom} more button${noRoom === 1 ? '' : 's'} — Discord allows 5 rows of 5 buttons, and a select menu takes a whole row.`);
      added = fresh;
      break;
    }
    default: throw new FlowError(`Unknown mode “${d.mode}”.`);
  }

  if (JSON.stringify(rows.map((r) => r.toJSON())) === before) return; // already the way it should be
  if (!rows.length && !message.content && !message.embeds?.length && !message.attachments?.size) {
    throw new FlowError('Removing the last button would leave the message empty, which Discord does not allow.');
  }
  await message.edit({ components: rows });

  // A click on a button wired to this node runs with the variables of this run — unless the message already remembers the run that sent it.
  const wired = added.some((b) => String(b.data.custom_id ?? '').startsWith('fc:'));
  if (wired && !ctx.services.components.get(ctx.guild.id, message.id)) {
    try {
      ctx.services.components.remember(message.id, ctx, { channelId: message.channelId ?? ctx.channel?.id ?? '' });
    } catch (err) {
      log('warn', `Could not remember the buttons' variables: ${err.message}`);
    }
  }
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
  'action.message.buttons': changeButtons,
  'action.message.delete': remove,
  'action.message.react': react,
  'action.modal.show': showModal,
};
