import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { BUTTON_ID_RE, buttonKey } from '../../shared/catalog.js';
import { embedChars, embedsOf, MAX_EMBED_CHARS, MAX_EMBEDS } from '../../shared/embeds.js';
import { looksLikeUpload } from '../../shared/urls.js';
import { FlowError } from './errors.js';
import { buildButtonId, buildCustomId } from './custom-id.js';

const STYLES = { Primary: ButtonStyle.Primary, Secondary: ButtonStyle.Secondary, Success: ButtonStyle.Success, Danger: ButtonStyle.Danger, Link: ButtonStyle.Link };
const HTTP = /^https?:\/\/\S+$/i;
export const cut = (s, n) => String(s ?? '').slice(0, n);
/** Discord refuses an embed with nothing to show; a zero-width space is invisible but counts. */
export const EMPTY_EMBED_TEXT = '​';

export function parseColor(v) {
  const m = String(v ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : null;
}

/** Unicode emoji, `<:name:id>`, or `name:id`. */
export function parseEmoji(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^<(a?):(\w+):(\d+)>$/) || s.match(/^()(\w+):(\d+)$/);
  return m ? { name: m[2], id: m[3], animated: m[1] === 'a' } : s;
}

/**
 * The address of an embed picture: an http(s) link, or `upload:<id>` — a picture uploaded to *this* server, turned into an
 * absolute address Discord can download. (Templates have already been filled in, so `upload:{{var.pic}}` works too.)
 */
export function embedPicture(ctx, value, label) {
  const v = String(value).trim();
  if (looksLikeUpload(v)) {
    if (!ctx.services.uploads) throw new FlowError('Uploaded images are not available here.');
    return ctx.services.uploads.publicUrl(ctx.guild.id, v);
  }
  if (!HTTP.test(v)) throw new FlowError(`${label} must be an http(s) URL or an uploaded image.`);
  return v;
}

/** A link in an embed (the title or the author): http(s) only. */
export function embedUrl(value, label) {
  const v = String(value).trim();
  if (!HTTP.test(v)) throw new FlowError(`${label} must start with http:// or https://.`);
  return v;
}

/** The embed fields that have both a name and a value, cut to Discord's sizes. */
export const embedFieldsOf = (list) => (list || []).filter((f) => f && f.name && f.value).slice(0, 25).map((f) => ({ name: cut(f.name, 256), value: cut(f.value, 1024), inline: Boolean(f.inline) }));

/** One embed, from the settings of one item of a node's `embeds` list. */
export function buildEmbed(ctx, m) {
  const e = new EmbedBuilder();
  if (m.title) e.setTitle(cut(m.title, 256));
  if (m.title && m.url) e.setURL(embedUrl(m.url, 'The title link'));
  if (m.description) e.setDescription(cut(m.description, 4096));
  const color = parseColor(m.color);
  if (color !== null) e.setColor(color);
  if (m.authorName) {
    const author = { name: cut(m.authorName, 256) };
    if (m.authorIcon) author.iconURL = embedPicture(ctx, m.authorIcon, 'The author icon');
    if (m.authorUrl) author.url = embedUrl(m.authorUrl, 'The author link');
    e.setAuthor(author);
  }
  for (const [key, setter, label] of [['thumbnail', 'setThumbnail', 'Thumbnail'], ['image', 'setImage', 'Image']]) {
    if (m[key]) e[setter](embedPicture(ctx, m[key], label));
  }
  if (m.footer) {
    const footer = { text: cut(m.footer, 2048) };
    if (m.footerIcon) footer.iconURL = embedPicture(ctx, m.footerIcon, 'The footer icon');
    e.setFooter(footer);
  }
  if (m.timestamp) e.setTimestamp();
  const fields = embedFieldsOf(m.fields);
  if (fields.length) e.addFields(fields);
  if (!m.title && !m.description && !fields.length && !m.image && !m.authorName) e.setDescription(EMPTY_EMBED_TEXT);
  return e;
}

/** Discord allows 10 embeds and 6000 characters (title, description, fields, footer text, author name) across all of them. */
export function checkEmbedLimits(embeds) {
  if (embeds.length > MAX_EMBEDS) throw new FlowError(`A message can have at most ${MAX_EMBEDS} embeds (this one has ${embeds.length}).`);
  const chars = embeds.reduce((n, e) => n + embedChars(e.toJSON()), 0);
  if (chars > MAX_EMBED_CHARS) throw new FlowError(`The embeds add up to ${chars} characters, but Discord allows ${MAX_EMBED_CHARS} in one message.`);
}

/** All the embeds a Send/Edit node describes — in the current `embeds` list or the older flat keys. */
export function buildEmbeds(ctx, d) {
  const embeds = embedsOf(d).map((m) => buildEmbed(ctx, m));
  checkEmbedLimits(embeds);
  return embeds;
}

/**
 * One button from its settings: a link, a reusable button (with a Button ID → `fcb:`), or one wired to an output of `node`
 * (`fc:<flow>:<node>:btn_<id>`). `seenKeys` collects the Button IDs already used on the message so a repeat is refused.
 */
export function buildButton(ctx, node, b, { invokerId = '', seenKeys = new Set() } = {}) {
  const style = STYLES[b.style] ?? ButtonStyle.Primary;
  const btn = new ButtonBuilder().setStyle(style).setDisabled(Boolean(b.disabled));
  if (b.label) btn.setLabel(cut(b.label, 80));
  const emoji = parseEmoji(b.emoji);
  if (emoji) btn.setEmoji(emoji);
  if (!b.label && !emoji) btn.setLabel('Button');
  if (style === ButtonStyle.Link) {
    if (!HTTP.test(b.url || '')) throw new FlowError(`Link button “${b.label}” needs an http(s) URL.`);
    btn.setURL(b.url);
  } else if (buttonKey(b)) {
    // Templates are already rendered here, so a member-controlled value could have become the id: check it again.
    const key = buttonKey(b);
    if (!BUTTON_ID_RE.test(key)) throw new FlowError(`Button ID “${cut(key, 40)}” can only use letters, numbers, - _ and . (max 64).`);
    if (seenKeys.has(key)) throw new FlowError(`Button ID “${key}” is used twice in this message.`);
    seenKeys.add(key);
    btn.setCustomId(buildButtonId({ id: key, invokerId }));
  } else {
    btn.setCustomId(buildCustomId({ flowId: ctx.flow.id, nodeId: node.id, handle: `btn_${b.id}`, invokerId }));
  }
  return btn;
}

/**
 * Build the discord.js message payload for a Send/Edit Message node.
 * `replace` makes omitted parts explicit (empty) so editing really replaces the message.
 */
export function buildPayload(ctx, d, node, { components = true, replace = false } = {}) {
  const payload = { allowedMentions: { parse: d.allowEveryone ? ['users', 'roles', 'everyone'] : ['users'] } };
  const content = cut(d.content, 2000);
  if (content) payload.content = content; else if (replace) payload.content = '';
  const embeds = buildEmbeds(ctx, d);
  if (embeds.length) payload.embeds = embeds; else if (replace) payload.embeds = [];

  if (components) {
    const rows = [];
    const invokerId = d.restrictToInvoker ? (ctx.user?.id ?? '') : '';
    const mk = (handle) => buildCustomId({ flowId: ctx.flow.id, nodeId: node.id, handle, invokerId });
    const seenKeys = new Set();
    const buttons = (d.buttons || []).slice(0, 25).map((b) => buildButton(ctx, node, b, { invokerId, seenKeys }));
    const menuRows = d.menuEnabled && (d.menuOptions || []).length ? 1 : 0;
    const maxButtons = (5 - menuRows) * 5;
    if (buttons.length > maxButtons) throw new FlowError(`Too many buttons: Discord allows ${maxButtons} here.`);
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    if (menuRows) {
      const menu = new StringSelectMenuBuilder().setCustomId(mk('sel')).setPlaceholder(cut(d.menuPlaceholder || 'Choose…', 150)).setMinValues(1).setMaxValues(1);
      menu.addOptions(d.menuOptions.slice(0, 25).map((o) => {
        const opt = { label: cut(o.label || 'Option', 100), value: o.id };
        if (o.description) opt.description = cut(o.description, 100);
        const emoji = parseEmoji(o.emoji);
        if (emoji) opt.emoji = emoji;
        return opt;
      }));
      rows.push(new ActionRowBuilder().addComponents(menu));
    }
    if (rows.length) payload.components = rows; else if (replace) payload.components = [];
  }

  if (!payload.content && !payload.embeds?.length && !payload.components?.length) {
    throw new FlowError('The message is empty — add text, an embed or buttons.');
  }
  return payload;
}
