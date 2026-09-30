import { AttachmentBuilder, MessageType, PermissionFlagsBits } from 'discord.js';
import { isCapped, LIMITS } from '../../../shared/limits.js';
import { createTranscript } from '../../transcript.js';
import { FlowAbort, FlowError, friendlyError } from '../errors.js';
import { cleanId, resolveChannel, resolveMember } from '../resolve.js';
import { yieldToEventLoop } from '../yield.js';

const PAGE = 100; // Discord's maximum per request
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const items = (c) => [...(c?.values?.() ?? [])];
const running = new Set(); // "guild:channel" being recorded right now, so a double-click cannot record (and post) twice

/** A discord.js message as the plain record the transcript builder understands. */
function toRecord(m) {
  return {
    id: m.id,
    at: m.createdTimestamp ?? Date.parse(m.createdAt),
    edited: Boolean(m.editedTimestamp),
    author: {
      id: m.author?.id ?? '',
      name: m.member?.displayName ?? m.author?.globalName ?? m.author?.username ?? 'Unknown',
      username: m.author?.username ?? '',
      bot: Boolean(m.author?.bot),
    },
    content: m.cleanContent ?? m.content ?? '',
    attachments: items(m.attachments).map((a) => ({ name: a.name, size: a.size, type: a.contentType, url: a.url })),
    embeds: items({ values: () => m.embeds ?? [] }).map((e) => ({
      title: e.title, description: e.description, footer: e.footer?.text, fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value })),
    })),
    stickers: items(m.stickers).map((s) => s.name),
    replyTo: m.reference?.messageId ?? '',
    system: m.system ? (MessageType[m.type] ?? 'system') : '',
  };
}

const text = (s) => String(s ?? '').slice(0, 2000);

export const transcriptExecutors = {
  async 'action.channel.transcript'({ ctx, d }) {
    if (!cleanId(d.sendChannelId)) throw new FlowError('Choose the channel to post the transcript in.'); // blank would mean "here", i.e. the channel about to be deleted
    const source = await resolveChannel(ctx, d.channelId, { textBased: true });
    const target = await resolveChannel(ctx, d.sendChannelId, { textBased: true });
    if (target.id === source.id) throw new FlowError('Post the transcript in a different channel than the one being recorded — that channel is usually deleted afterwards.');

    const key = `${ctx.guild.id}:${source.id}`;
    if (running.has(key)) throw new FlowError(`A transcript of #${source.name} is already being saved.`);
    running.add(key);
    try {
      const log = (level, message) => ctx.services.logger.log(ctx.guild.id, level, message, ctx.logMeta);
      const textVisible = ctx.services.intents?.messageContent !== false;
      if (!textVisible) log('warn', `The Message Content intent is off, so the transcript of #${source.name} shows who wrote when, but not what.`);

      const doc = createTranscript({
        guildName: ctx.guild.name, channelName: source.name, channelId: source.id, textVisible,
        maxMessages: isCapped(LIMITS.transcriptMessages) ? LIMITS.transcriptMessages : Infinity,
      });
      // Oldest first: ask for the messages after the newest one seen so far. Sorting by id makes the order of each page irrelevant.
      let after = '0';
      for (;;) {
        if (ctx.aborted) throw new FlowAbort('The flow was stopped.');
        const batch = items(await source.messages.fetch({ limit: PAGE, after, cache: false })).sort(byId);
        if (!batch.length) break;
        const more = doc.add(batch.map(toRecord));
        const last = batch[batch.length - 1].id;
        if (!more || batch.length < PAGE || BigInt(last) <= BigInt(after)) break;
        after = last;
        await yieldToEventLoop();
      }
      const result = doc.finish();
      const file = () => new AttachmentBuilder(result.buffer, { name: result.name });

      // The log channel is the record of truth: if this fails the node fails and (in the templates) the ticket stays open.
      await target.send({ content: text(d.channelMessage) || undefined, files: [file()], allowedMentions: { parse: [] } });

      // The person's copy is a courtesy: never fail the node because of it.
      let dm = 'skipped';
      if (cleanId(d.sendUserId)) {
        try {
          const member = await resolveMember(ctx, d.sendUserId);
          const allowed = source.permissionsFor?.(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
          if (!allowed) {
            log('warn', `Did not send the transcript to ${member.displayName ?? member.id}: they can no longer see #${source.name}.`);
          } else {
            await member.send({ content: text(d.dmMessage) || undefined, files: [file()], allowedMentions: { parse: [] } });
            dm = 'sent';
          }
        } catch (err) {
          dm = 'failed';
          log('warn', `Could not send the transcript by direct message: ${friendlyError(err)}`);
        }
      }
      ctx.data.transcript = { messages: result.messages, name: result.name, bytes: result.bytes, truncated: result.truncated, dm };
    } finally {
      running.delete(key);
    }
  },
};
