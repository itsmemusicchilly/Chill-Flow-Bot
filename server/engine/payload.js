import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { BUTTON_ID_RE, buttonKey } from '../../shared/catalog.js';
import { FlowError } from './errors.js';
import { buildButtonId, buildCustomId } from './custom-id.js';

const STYLES = { Primary: ButtonStyle.Primary, Secondary: ButtonStyle.Secondary, Success: ButtonStyle.Success, Danger: ButtonStyle.Danger, Link: ButtonStyle.Link };
const HTTP = /^https?:\/\/\S+$/i;
const cut = (s, n) => String(s ?? '').slice(0, n);

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

function buildEmbed(d) {
  const e = new EmbedBuilder();
  if (d.embedTitle) e.setTitle(cut(d.embedTitle, 256));
  if (d.embedDescription) e.setDescription(cut(d.embedDescription, 4096));
  const color = parseColor(d.embedColor);
  if (color !== null) e.setColor(color);
  for (const [key, setter] of [['embedThumbnail', 'setThumbnail'], ['embedImage', 'setImage']]) {
    if (d[key]) {
      if (!HTTP.test(d[key])) throw new FlowError(`${key === 'embedImage' ? 'Image' : 'Thumbnail'} must be an http(s) URL.`);
      e[setter](d[key]);
    }
  }
  if (d.embedFooter) e.setFooter({ text: cut(d.embedFooter, 2048) });
  if (d.embedTimestamp) e.setTimestamp();
  const fields = (d.embedFields || []).filter((f) => f.name && f.value).slice(0, 25);
  if (fields.length) e.addFields(fields.map((f) => ({ name: cut(f.name, 256), value: cut(f.value, 1024), inline: Boolean(f.inline) })));
  if (!d.embedTitle && !d.embedDescription && !fields.length && !d.embedImage) e.setDescription('​');
  return e;
}

/**
 * Build the discord.js message payload for a Send/Edit Message node.
 * `replace` makes omitted parts explicit (empty) so editing really replaces the message.
 */
export function buildPayload(ctx, d, node, { components = true, replace = false } = {}) {
  const payload = { allowedMentions: { parse: d.allowEveryone ? ['users', 'roles', 'everyone'] : ['users'] } };
  const content = cut(d.content, 2000);
  if (content) payload.content = content; else if (replace) payload.content = '';
  if (d.useEmbed) payload.embeds = [buildEmbed(d)]; else if (replace) payload.embeds = [];

  if (components) {
    const rows = [];
    const invokerId = d.restrictToInvoker ? (ctx.user?.id ?? '') : '';
    const mk = (handle) => buildCustomId({ flowId: ctx.flow.id, nodeId: node.id, handle, invokerId });
    const seenKeys = new Set();
    const buttons = (d.buttons || []).slice(0, 25).map((b) => {
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
        btn.setCustomId(mk(`btn_${b.id}`));
      }
      return btn;
    });
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
