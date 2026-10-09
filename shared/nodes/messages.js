// Messages: send, edit, delete and react to messages, change a sent message's buttons, and show the pop-up form.
import { area, bool, color, idField, image, list, multi, num, select, text, when, whenNot } from '../fields.js';
import { uid } from '../util.js';
import { EMBED_PARTS, embedsOf, MAX_EMBEDS } from '../embeds.js';
import { ACTION_OUTS, BUTTON_ID_RE, BUTTON_STYLES, buttonKey, def, embedErrors, embedFieldList, embedsList, ERR, MESSAGE_FROM, OUT, PICTURE_HELP } from './core.js';

// ---- messages -----------------------------------------------------------------------------------
const TARGETS = [
  ['reply', 'Reply to whatever triggered this'],
  ['update', 'Edit the message the button is on'],
  ['current_channel', 'Post in the same channel'],
  ['channel', 'Post in a specific channel'],
  ['dm', 'Direct message a member'],
];
/** The list of buttons a message can carry — the same for Send Message and Change Buttons, so they can not drift apart. */
const buttonList = (o = {}) => list('buttons', 'Buttons', {
  create: () => ({ id: uid(6), label: 'Button', style: 'Primary', emoji: '', url: '', disabled: false, customId: '' }),
  label: (b) => b.label,
  fields: [
    text('label', 'Label', { required: true }),
    select('style', 'Style', BUTTON_STYLES),
    text('url', 'URL', { showIf: when('style', 'Link'), required: true }),
    text('emoji', 'Emoji (optional)'),
    bool('disabled', 'Disabled'),
    text('customId', 'Button ID (optional)', {
      showIf: whenNot('style', 'Link'), placeholder: 'open_ticket',
      help: 'Makes this a reusable button: it is handled by a “Button Clicked” trigger with the same ID instead of its own output here, and keeps working on every copy of the message. Adding an ID removes this button\'s output connection.',
    }),
  ],
}, { max: 25, ...o });
/** Problems with the Button IDs in a list of buttons: characters Discord would not accept, and IDs used twice. */
function buttonIdErrors(buttons) {
  const e = [];
  const seen = new Set();
  for (const b of buttons || []) {
    const key = buttonKey(b);
    if (!key) continue;
    if (!/\{\{/.test(key) && !BUTTON_ID_RE.test(key)) e.push(`Button ID “${key}” can only use letters, numbers, - _ and . (max 64).`);
    if (seen.has(key)) e.push(`Button ID “${key}” is used twice in this message — Discord needs them to be unique.`);
    seen.add(key);
  }
  return e;
}
def('action.message.send', {
  category: 'message', label: 'Send Message', icon: '💬',
  description: 'Send text, embeds (up to 10, with author, links and icons), buttons and a select menu. Every button becomes its own output.',
  fields: [
    select('target', 'Send to', TARGETS),
    idField('channelId', 'Channel', 'channel', { showIf: when('target', 'channel'), required: true }),
    idField('userId', 'Member', 'user', { showIf: when('target', 'dm'), placeholder: 'blank = the user who triggered this' }),
    bool('ephemeral', 'Only visible to the user (ephemeral)', { showIf: when('target', 'reply'), help: 'Works when replying to a command or button.' }),
    area('content', 'Message text', { placeholder: 'Hello {{user.mention}}!' }),
    embedsList(),
    buttonList(),
    bool('menuEnabled', 'Add a select menu'),
    text('menuPlaceholder', 'Menu placeholder', { showIf: when('menuEnabled', true), default: 'Choose…' }),
    list('menuOptions', 'Menu options', {
      create: () => ({ id: uid(6), label: 'Option', description: '', emoji: '' }),
      label: (o) => o.label,
      fields: [text('label', 'Label', { required: true }), text('description', 'Description'), text('emoji', 'Emoji (optional)')],
    }, { max: 25, showIf: when('menuEnabled', true) }),
    bool('restrictToInvoker', 'Only the person who triggered this can use the buttons'),
    bool('allowEveryone', 'Allow role, @everyone and @here pings', { help: 'Off by default so member-supplied text can never mass-ping. Individual users can always be mentioned.' }),
    text('outputVar', 'Save message ID as variable', { placeholder: 'msg', pattern: 'var' }),
  ],
  outputs: (d) => [
    OUT,
    ...(d.buttons || []).filter((b) => b.style !== 'Link' && !buttonKey(b)).map((b) => ({ id: `btn_${b.id}`, label: b.label || 'Button', kind: 'button' })),
    ...(d.menuEnabled ? (d.menuOptions || []).map((o) => ({ id: `opt_${o.id}`, label: o.label || 'Option', kind: 'option' })) : []),
    ERR,
  ],
  summary: (d) => `${(TARGETS.find((t) => t[0] === d.target) || [])[1] || ''}${d.content ? ` — ${d.content.slice(0, 40)}` : ''}`,
  check(d) {
    const e = [];
    if (!d.content && !embedsOf(d).length && !(d.buttons || []).length) e.push('Add message text, an embed or buttons — Discord will not send an empty message.');
    e.push(...embedErrors(embedsOf(d)));
    if ((d.buttons || []).length + (d.menuEnabled ? 1 : 0) > 25) e.push('Too many components.');
    if (d.menuEnabled && !(d.menuOptions || []).length) e.push('The select menu needs at least one option.');
    e.push(...buttonIdErrors(d.buttons));
    if ((d.buttons || []).some((b) => buttonKey(b)) && d.target === 'dm') e.push('Buttons with a Button ID only work inside a server, not in direct messages.');
    return e;
  },
});
const TEXT_MODES = [['keep', 'Keep as it is'], ['replace', 'Replace with…'], ['remove', 'Remove the text']];
const EMBED_MODES = [['keep', 'Keep as they are'], ['patch', 'Change some parts of one embed'], ['replace', 'Replace all embeds'], ['remove', 'Remove all embeds']];
const TEXT_PARTS = ['title', 'url', 'description', 'authorName', 'authorUrl', 'footer'];
const PICTURE_PARTS = ['authorIcon', 'thumbnail', 'image', 'footerIcon'];
const partLabel = (key) => (EMBED_PARTS.find(([k]) => k === key) || [])[1] || 'Part';
def('action.message.edit', {
  category: 'message', label: 'Edit Message', icon: '📝',
  description: 'Change a message the bot already sent. For the text and for the embeds you can keep them, replace them or remove them — and for the embeds you can also change just some parts of one embed and leave the rest as it is. Choose “This message” (the one that started the flow, such as the message a pressed button is on) or “A previous message” and give its ID. Only the bot\'s own messages can be edited, not “only visible to you” replies.',
  fields: [
    select('messageFrom', 'Which message', MESSAGE_FROM),
    idField('channelId', 'Channel', 'channel', { showIf: when('messageFrom', 'id'), placeholder: 'blank = current channel' }),
    idField('messageId', 'Message ID', 'message', {
      showIf: when('messageFrom', 'id'), required: true, placeholder: '{{var.msg}} or {{channel.vars.panel}}',
      help: 'The ID of a message sent earlier. Use a variable that holds it — for example the one you gave “Save message ID as variable” in Send Message, or one stored with Set Variable.',
    }),
    select('contentMode', 'Message text', TEXT_MODES),
    area('content', 'New text', { showIf: when('contentMode', 'replace') }),
    select('embedsMode', 'Embeds', EMBED_MODES),
    num('patchEmbed', 'Which embed (1 = the first)', { showIf: when('embedsMode', 'patch'), default: 1, min: 1, max: MAX_EMBEDS, help: 'One past the last embed adds a new one.' }),
    list('patchSet', 'Set these parts', {
      create: () => ({ id: uid(6), part: 'description', text: '', color: '#5865f2', image: '', fields: [] }),
      label: (p) => `${partLabel(p.part)}${p.text ? `: ${String(p.text).slice(0, 24)}` : ''}`,
      fields: [
        select('part', 'Part', EMBED_PARTS),
        area('text', 'New value', { rows: 3, showIf: when('part', ...TEXT_PARTS) }),
        color('color', 'New color', { showIf: when('part', 'color') }),
        image('image', 'New picture', { showIf: when('part', ...PICTURE_PARTS), help: PICTURE_HELP }),
        embedFieldList({ showIf: when('part', 'fields'), help: 'These replace all the fields the embed has now.' }),
      ],
    }, { showIf: when('embedsMode', 'patch'), help: 'Only the parts you list here change. “Timestamp” sets the time to now.' }),
    multi('patchRemove', 'Remove these parts', EMBED_PARTS, {
      showIf: when('embedsMode', 'patch'),
      help: 'Taken off first, then the parts above are set. “Author name” removes the whole author and “Footer text” the whole footer.',
    }),
    embedsList({ showIf: when('embedsMode', 'replace') }),
  ],
  outputs: ACTION_OUTS,
  summary: (d) => {
    const text = { replace: 'replace text', remove: 'remove text' }[d.contentMode];
    const embeds = { patch: 'change an embed', replace: 'replace embeds', remove: 'remove embeds' }[d.embedsMode];
    return `${[text, embeds].filter(Boolean).join(', ') || 'nothing to change'} — ${d.messageFrom === 'id' ? (d.messageId || '(ID needed)') : 'this message'}`;
  },
  check(d) {
    const e = [];
    if (d.contentMode === 'keep' && d.embedsMode === 'keep') e.push('Nothing to change: choose to change the text or the embeds.');
    if (d.embedsMode === 'patch' && !(d.patchSet || []).length && !(d.patchRemove || []).length) e.push('Choose the parts of the embed to set or remove.');
    if (d.embedsMode === 'replace') e.push(...embedErrors(embedsOf(d)));
    return e;
  },
});
const BUTTON_MODES = [['add', 'Add or update buttons'], ['remove', 'Remove specific buttons'], ['clear', 'Remove all buttons'], ['disable', 'Disable buttons'], ['enable', 'Enable buttons'], ['delete', 'Delete the message']];
def('action.message.buttons', {
  category: 'message', label: 'Change Buttons', icon: '🔘',
  description: 'Add, remove, disable or enable the buttons of a message the bot already sent, without touching its text — or delete the message. Choose “This message” (the one that started the flow, such as the message a pressed button is on) or “A previous message” and give its ID. Buttons can only be changed on the bot\'s own messages, and neither works on “only visible to you” replies.',
  fields: [
    select('messageFrom', 'Which message', MESSAGE_FROM),
    idField('channelId', 'Channel', 'channel', { showIf: when('messageFrom', 'id'), placeholder: 'blank = current channel' }),
    idField('messageId', 'Message ID', 'message', {
      showIf: when('messageFrom', 'id'), required: true, placeholder: '{{var.msg}} or {{channel.vars.panel}}',
      help: 'The ID of a message sent earlier. Use a variable that holds it — for example the one you gave “Save message ID as variable” in Send Message, or one stored with Set Variable.',
    }),
    select('mode', 'What to do', BUTTON_MODES),
    buttonList({ showIf: when('mode', 'add') }),
    list('targets', 'Which buttons', {
      create: () => ({ id: uid(6), match: '' }),
      label: (t) => t.match,
      fields: [text('match', 'Button ID or label', { required: true, placeholder: 'open_ticket or Close' })],
    }, { showIf: when('mode', 'remove', 'disable', 'enable'), help: 'A button matches by its Button ID, or by its label (capital letters do not matter). To disable or enable every button, leave this empty.' }),
    bool('restrictToInvoker', 'Only the person who triggered this can use the added buttons', { showIf: when('mode', 'add') }),
  ],
  outputs: (d) => [
    OUT,
    ...(d.mode === 'add' ? (d.buttons || []).filter((b) => b.style !== 'Link' && !buttonKey(b)).map((b) => ({ id: `btn_${b.id}`, label: b.label || 'Button', kind: 'button' })) : []),
    ERR,
  ],
  summary: (d) => {
    const n = ((d.mode === 'add' ? d.buttons : d.targets) || []).length;
    const what = {
      add: `add ${n} button${n === 1 ? '' : 's'} to`, remove: `remove ${n} button${n === 1 ? '' : 's'} from`, clear: 'remove all buttons from',
      disable: n ? `disable ${n} on` : 'disable all buttons on', enable: n ? `enable ${n} on` : 'enable all buttons on', delete: 'delete',
    }[d.mode] || '';
    return `${what} ${d.messageFrom === 'id' ? `message ${d.messageId || '(ID needed)'}` : 'this message'}`.trim();
  },
  check(d) {
    const e = [];
    if (d.mode === 'add') {
      if (!(d.buttons || []).length) e.push('Add at least one button.');
      e.push(...buttonIdErrors(d.buttons));
    }
    if (d.mode === 'remove' && !(d.targets || []).length) e.push('Say which buttons to remove (a Button ID or a label), or choose “Remove all buttons”.');
    return e;
  },
});
def('action.message.delete', {
  category: 'message', label: 'Delete Message', icon: '🗑️', description: 'Delete a message. Leave the ID blank to delete the message that triggered the flow.',
  fields: [idField('channelId', 'Channel', 'channel', { placeholder: 'blank = current channel' }), idField('messageId', 'Message ID', 'message', { placeholder: 'blank = the triggering message' })],
  outputs: ACTION_OUTS, summary: (d) => d.messageId || 'triggering message',
});
def('action.message.react', {
  category: 'message', label: 'Add Reaction', icon: '👍', description: 'React to a message with an emoji.',
  fields: [
    idField('channelId', 'Channel', 'channel', { placeholder: 'blank = current channel' }),
    idField('messageId', 'Message ID', 'message', { placeholder: 'blank = the triggering message' }),
    text('emoji', 'Emoji', { required: true, placeholder: '👍 or name:id for custom emoji' }),
  ],
  outputs: ACTION_OUTS, summary: (d) => d.emoji || '',
});
// Show Form: one question per item. A question saved before there were question types has no `kind`, and is a text question.
const FORM_KINDS = [['text', 'Text'], ['select', 'Dropdown (pick from your list)'], ['user', 'Member picker'], ['role', 'Role picker'], ['channel', 'Channel picker'], ['file', 'File upload']];
const FORM_PICKERS = ['select', 'user', 'role', 'channel', 'file'];
const FORM_ANSWERS = { select: 'chosen value(s)', user: 'picked member ID(s)', role: 'picked role ID(s)', channel: 'picked channel ID(s)', file: 'uploaded file link(s)' };
const MAX_FORM_FILES = 10;
const formNumber = (v) => (v === '' || v === null || v === undefined || String(v).includes('{{') ? null : Number(v));
def('action.modal.show', {
  category: 'message', label: 'Show Form (Modal)', icon: '🧾',
  description: 'Pop up a form of up to 5 questions — text, a dropdown, a member / role / channel picker or a file upload. Must be the first thing the flow does with a command or button. Answers are {{input.<id>}}.',
  fields: [
    text('title', 'Form title', { required: true, default: 'Tell us more' }),
    list('inputs', 'Inputs', {
      create: () => ({ id: `field_${uid(4)}`, label: 'Your answer', kind: 'text', description: '', style: 'short', placeholder: '', defaultValue: '', minLength: '', maxLength: '', options: [], maxChoices: 1, required: true }),
      label: (i) => i.label,
      fields: [
        text('id', 'ID (used as {{input.ID}})', { required: true }),
        text('label', 'Label', { required: true }),
        select('kind', 'Question type', FORM_KINDS, { help: 'A dropdown gives {{input.ID}} the chosen value; the pickers give the picked ID; a file upload gives the file\'s link (Discord\'s own links stop working after a while). Several picks are joined with a comma and a space.' }),
        text('description', 'Help text under the label', { placeholder: 'optional, up to 100 characters' }),
        select('style', 'Size', [['short', 'One line'], ['paragraph', 'Paragraph']], { showIf: whenNot('kind', ...FORM_PICKERS) }),
        text('placeholder', 'Placeholder', { showIf: whenNot('kind', 'file') }),
        text('defaultValue', 'Pre-filled text', { showIf: whenNot('kind', ...FORM_PICKERS), help: 'Shown in the box when the form opens. You can use {{variables}}.' }),
        num('minLength', 'Min length', { showIf: whenNot('kind', ...FORM_PICKERS), min: 0, max: 4000 }),
        num('maxLength', 'Max length', { showIf: whenNot('kind', ...FORM_PICKERS), min: 1, max: 4000 }),
        list('options', 'Choices', {
          create: () => ({ label: 'Choice', value: `choice_${uid(3)}`, description: '', default: false }),
          label: (o) => o.label,
          fields: [
            text('label', 'Label shown', { required: true }),
            text('value', 'Value (what {{input.ID}} becomes)', { required: true }),
            text('description', 'Small description'),
            bool('default', 'Pre-selected'),
          ],
        }, { max: 25, showIf: when('kind', 'select') }),
        num('maxChoices', 'How many (at most)', { default: 1, showIf: when('kind', ...FORM_PICKERS), min: 1, max: 25, help: '1 = just one. More lets people pick several (files: up to 10).' }),
        bool('required', 'Required'),
      ],
    }, { max: 5 }),
  ],
  outputs: [{ id: 'submit', label: 'Submitted', kind: 'button' }, ERR],
  provides: (d) => (d.inputs || []).filter((i) => i.id).map((i) => [`input.${i.id}`, `Answer: ${i.label}${FORM_ANSWERS[i.kind] ? ` (${FORM_ANSWERS[i.kind]})` : ''}`]),
  summary: (d) => d.title || '',
  check(d) {
    const e = [];
    if (!(d.inputs || []).length) e.push('Add at least one input.');
    const seen = new Set();
    for (const i of d.inputs || []) {
      const name = `“${i.label || i.id}”`;
      if (i.id && !/^[A-Za-z_][\w]{0,31}$/.test(i.id)) e.push(`Input ID “${i.id}” must be letters, numbers or _ and not start with a number.`);
      if (seen.has(i.id)) e.push(`Duplicate input ID “${i.id}”.`);
      seen.add(i.id);
      const kind = i.kind || 'text';
      if (!FORM_KINDS.some(([k]) => k === kind)) { e.push(`Question ${name} has an unknown type.`); continue; }
      const most = formNumber(i.maxChoices);
      if (kind === 'text') {
        const [lo, hi] = [formNumber(i.minLength), formNumber(i.maxLength)];
        if (lo !== null && hi !== null && lo > hi) e.push(`Question ${name}: the minimum length cannot be more than the maximum.`);
      }
      if (kind === 'file' && most !== null && most > MAX_FORM_FILES) e.push(`Question ${name}: at most ${MAX_FORM_FILES} files.`);
      if (kind !== 'select') continue;
      const options = Array.isArray(i.options) ? i.options : [];
      if (!options.length) e.push(`Question ${name} needs at least one choice.`);
      const values = new Set();
      options.forEach((o, n) => {
        const value = String(o?.value ?? '').trim();
        if (value && values.has(value)) e.push(`Question ${name}: choice #${n + 1} repeats the value “${value}”.`);
        values.add(value);
      });
      if (most !== null && options.length && most > options.length) e.push(`Question ${name}: “How many” (${most}) is more than the number of choices (${options.length}).`);
    }
    return e;
  },
});
