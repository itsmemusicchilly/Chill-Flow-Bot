// Show Form: turns one question of the node into a Discord modal component, and reads its answer back as plain text.
// A question without a `kind` (saved before there were question types) is a text question.
import {
  ChannelSelectMenuBuilder, FileUploadBuilder, LabelBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { FlowError } from './errors.js';

const KINDS = ['text', 'select', 'user', 'role', 'channel', 'file'];
const cut = (v, n) => String(v ?? '').slice(0, n);
const whole = (v, lo, hi, fallback) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };
const blank = (v) => !String(v ?? '').trim();
const name = (q) => `“${q.label || q.id}”`;

export const customIdOf = (q) => `in_${q.id}`;

export function kindOf(q) {
  const kind = q.kind || 'text';
  if (!KINDS.includes(kind)) throw new FlowError(`Question ${name(q)} has an unknown type “${kind}”.`);
  return kind;
}

/** The modal component for one question, with Discord's size limits applied (label 45, help text 100, placeholder 100/150, choices 25). */
export function buildQuestion(q) {
  const kind = kindOf(q);
  const customId = customIdOf(q);
  const required = q.required !== false;
  const label = new LabelBuilder().setLabel(cut(q.label || q.id, 45));
  if (!blank(q.description)) label.setDescription(cut(q.description, 100));

  if (kind === 'text') {
    const input = new TextInputBuilder().setCustomId(customId).setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(required);
    if (!blank(q.placeholder)) input.setPlaceholder(cut(q.placeholder, 100));
    const max = Number(q.maxLength) > 0 ? Math.min(4000, Math.floor(Number(q.maxLength))) : 0;
    if (max) input.setMaxLength(max);
    const min = whole(q.minLength, 0, max || 4000, 0);
    if (min) input.setMinLength(min);
    if (!blank(q.defaultValue)) input.setValue(cut(q.defaultValue, max || 4000));
    return label.setTextInputComponent(input);
  }

  if (kind === 'file') {
    return label.setFileUploadComponent(new FileUploadBuilder().setCustomId(customId).setMinValues(required ? 1 : 0).setMaxValues(whole(q.maxChoices, 1, 10, 1)).setRequired(required));
  }

  const select = {
    select: () => new StringSelectMenuBuilder(), user: () => new UserSelectMenuBuilder(), role: () => new RoleSelectMenuBuilder(), channel: () => new ChannelSelectMenuBuilder(),
  }[kind]().setCustomId(customId).setRequired(required);
  if (!blank(q.placeholder)) select.setPlaceholder(cut(q.placeholder, 150));

  if (kind === 'select') {
    const choices = (Array.isArray(q.options) ? q.options : []).filter((o) => !blank(o?.value)).slice(0, 25);
    if (!choices.length) throw new FlowError(`Question ${name(q)} has no choices to pick from.`);
    const most = whole(q.maxChoices, 1, choices.length, 1);
    let preselect = most; // Discord refuses more pre-selected choices than may be picked
    select.setMinValues(required ? 1 : 0).setMaxValues(most).addOptions(choices.map((o) => ({
      label: cut(o.label || o.value, 100), value: cut(o.value, 100), ...(blank(o.description) ? {} : { description: cut(o.description, 100) }), default: Boolean(o.default) && preselect-- > 0,
    })));
    return label.setStringSelectMenuComponent(select);
  }

  select.setMinValues(required ? 1 : 0).setMaxValues(whole(q.maxChoices, 1, 25, 1));
  return kind === 'user' ? label.setUserSelectMenuComponent(select) : kind === 'role' ? label.setRoleSelectMenuComponent(select) : label.setChannelSelectMenuComponent(select);
}

const ids = (collection) => [...(collection?.keys?.() ?? [])].join(', ');

/**
 * The answer as text: what was typed; the chosen values; the picked IDs; the uploaded files' links — several joined with ", ".
 * A question that was optional and left empty is "".
 */
export function readAnswer(q, fields) {
  const kind = kindOf(q);
  const customId = customIdOf(q);
  try {
    switch (kind) {
      case 'text': return fields.getTextInputValue(customId) ?? '';
      case 'select': return (fields.getStringSelectValues(customId) ?? []).join(', ');
      case 'user': return ids(fields.getSelectedUsers(customId, false));
      case 'role': return ids(fields.getSelectedRoles(customId, false));
      case 'channel': return ids(fields.getSelectedChannels(customId, false));
      default: return [...(fields.getUploadedFiles(customId, false)?.values?.() ?? [])].map((f) => f.url).join(', ');
    }
  } catch (err) {
    if (q.required !== false) throw err; // a required answer that is missing is a real problem; an optional one may simply not have been sent
    return '';
  }
}
