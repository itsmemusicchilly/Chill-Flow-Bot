// Single source of truth for every node type. The editor renders its palette, cards and inspector from
// this file; the server uses it to validate graphs, compute handles and activate triggers.
import { area, bool, color, idField, isVisible, list, multi, num, select, text, VAR_NAME_RE, when, whenNot } from './fields.js';
import { uid } from './util.js';

export { isVisible, VAR_NAME_RE };

export const CATEGORIES = {
  trigger: { label: 'Triggers', color: '#f59e0b', blurb: 'Start a flow' },
  message: { label: 'Messages', color: '#5865f2', blurb: 'Talk to people' },
  member: { label: 'Members', color: '#3ba55d', blurb: 'Roles & moderation' },
  channel: { label: 'Channels', color: '#14b8a6', blurb: 'Manage channels' },
  role: { label: 'Roles', color: '#ec4899', blurb: 'Manage roles' },
  data: { label: 'Variables', color: '#a855f7', blurb: 'Remember things' },
  logic: { label: 'Logic', color: '#f97316', blurb: 'Branch, loop, wait' },
};

// Names must exist in discord.js `PermissionFlagsBits` (checked by a test).
export const CHANNEL_PERMISSIONS = [
  'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'ReadMessageHistory', 'AddReactions', 'AttachFiles',
  'EmbedLinks', 'UseExternalEmojis', 'MentionEveryone', 'ManageMessages', 'ManageChannels', 'ManageRoles',
  'ManageThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'UseApplicationCommands', 'CreateInstantInvite',
  'Connect', 'Speak', 'Stream', 'UseVAD', 'MuteMembers', 'DeafenMembers', 'MoveMembers',
];
export const ROLE_PERMISSIONS = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'KickMembers', 'BanMembers', 'ModerateMembers',
  'ViewAuditLog', 'ManageMessages', 'ManageNicknames', 'ChangeNickname', 'MentionEveryone', 'ManageWebhooks',
  'CreateInstantInvite', 'ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions', 'AttachFiles',
  'EmbedLinks', 'UseExternalEmojis', 'Connect', 'Speak', 'Stream', 'UseVAD', 'MuteMembers', 'DeafenMembers',
  'MoveMembers', 'UseApplicationCommands',
];
export const COMMAND_PERMISSIONS = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'KickMembers', 'BanMembers',
  'ModerateMembers',
];

const OUT = { id: 'out', label: 'Next' };
const ERR = { id: 'error', label: 'On error', kind: 'error' };
const ACTION_OUTS = [OUT, ERR];

const USER = [['user.id', 'User ID'], ['user.name', 'Username'], ['user.displayName', 'Display name'], ['user.mention', 'Mention'], ['user.tag', 'Tag'], ['user.avatar', 'Avatar URL'], ['user.isBot', 'Is a bot']];
const MEMBER = [['member.nickname', 'Nickname'], ['member.joinedAt', 'Joined at'], ['member.roleIds', 'Role IDs'], ['member.permissions', 'Permissions']];
const GUILD = [['guild.id', 'Server ID'], ['guild.name', 'Server name'], ['guild.memberCount', 'Member count']];
const CHANNEL = [['channel.id', 'Channel ID'], ['channel.name', 'Channel name'], ['channel.mention', 'Channel mention'], ['channel.type', 'Channel type'], ['channel.parentId', 'Category ID']];
const MESSAGE = [['message.id', 'Message ID'], ['message.content', 'Message text'], ['message.url', 'Message link'], ['message.authorId', 'Author ID']];
const ROLE = [['role.id', 'Role ID'], ['role.name', 'Role name'], ['role.mention', 'Role mention'], ['role.color', 'Role color']];
const EXECUTOR = [['executor.id', 'Moderator ID'], ['executor.name', 'Moderator name'], ['executor.mention', 'Moderator mention'], ['reason', 'Reason']];

// Trigger-level fields reused by many triggers.
const includeSelf = bool('includeSelf', 'Also run for changes made by this bot', {
  help: 'Off by default so a flow cannot trigger itself in a loop.',
});
const ignoreBots = bool('ignoreBots', 'Ignore bots', { default: true });

// ---------------------------------------------------------------------------------------------------
// message payload fields shared by Send / Edit message
// ---------------------------------------------------------------------------------------------------
const embedFields = () => [
  bool('useEmbed', 'Add an embed'),
  text('embedTitle', 'Embed title', { showIf: when('useEmbed', true) }),
  area('embedDescription', 'Embed description', { showIf: when('useEmbed', true), rows: 4 }),
  color('embedColor', 'Embed color', { showIf: when('useEmbed', true) }),
  text('embedThumbnail', 'Thumbnail URL', { showIf: when('useEmbed', true) }),
  text('embedImage', 'Image URL', { showIf: when('useEmbed', true) }),
  text('embedFooter', 'Footer', { showIf: when('useEmbed', true) }),
  bool('embedTimestamp', 'Show timestamp', { showIf: when('useEmbed', true) }),
  list('embedFields', 'Embed fields', {
    create: () => ({ name: 'Field', value: 'Value', inline: false }),
    label: (i) => i.name,
    fields: [text('name', 'Name'), text('value', 'Value'), bool('inline', 'Inline')],
  }, { max: 25, showIf: when('useEmbed', true) }),
];

const BUTTON_STYLES = [['Primary', 'Blurple'], ['Secondary', 'Grey'], ['Success', 'Green'], ['Danger', 'Red'], ['Link', 'Link (opens a URL)']];

// ---------------------------------------------------------------------------------------------------
// definitions
// ---------------------------------------------------------------------------------------------------
const defs = {};
const def = (type, d) => { defs[type] = { type, ...d }; };
const trigger = (type, d) => def(type, { category: 'trigger', outputs: [OUT], ...d, isTrigger: true });

// ---- triggers -----------------------------------------------------------------------------------
trigger('trigger.command', {
  label: 'Slash Command', icon: '⌨️',
  description: 'Runs when someone uses a /command. Add options to collect input.',
  fields: [
    text('name', 'Command name', { required: true, placeholder: 'ticket', help: 'Lowercase letters, numbers, - and _ (max 32).' }),
    text('description', 'Description', { required: true, default: 'A custom command', placeholder: 'What does it do?' }),
    list('options', 'Options', {
      create: () => ({ name: 'option', description: 'An option', type: 'string', required: false }),
      label: (o) => o.name,
      fields: [
        text('name', 'Name', { required: true }),
        text('description', 'Description', { required: true }),
        select('type', 'Type', [['string', 'Text'], ['integer', 'Whole number'], ['number', 'Decimal number'], ['boolean', 'True / False'], ['user', 'User'], ['channel', 'Channel'], ['role', 'Role'], ['mentionable', 'User or role']]),
        bool('required', 'Required'),
      ],
    }, { max: 25 }),
    select('permission', 'Who can use it', [['', 'Everyone'], ['Administrator', 'Administrators'], ['ManageGuild', 'Manage Server'], ['ManageRoles', 'Manage Roles'], ['ManageChannels', 'Manage Channels'], ['ManageMessages', 'Manage Messages'], ['KickMembers', 'Kick Members'], ['BanMembers', 'Ban Members'], ['ModerateMembers', 'Timeout Members']],
      { help: 'Discord\'s default permission for the command. Server admins can still change it in Integrations.' }),
    bool('deferEphemeral', 'Make the "thinking…" reply private', { help: 'Used when a flow takes longer than ~2 s to answer.' }),
  ],
  provides: (d) => [...USER, ...MEMBER, ...GUILD, ...CHANNEL, ...(d.options || []).filter((o) => o.name).map((o) => [`option.${o.name}`, `Option “${o.name}”`])],
  summary: (d) => `/${d.name || '?'}`,
  check(d) {
    const e = [];
    if (d.name && !/^[a-z0-9_-]{1,32}$/.test(d.name)) e.push('Command name must be 1–32 lowercase letters, numbers, - or _.');
    if (d.description && d.description.length > 100) e.push('Description can be at most 100 characters.');
    const seen = new Set();
    for (const o of d.options || []) {
      if (o.name && !/^[a-z0-9_-]{1,32}$/.test(o.name)) e.push(`Option “${o.name}”: name must be 1–32 lowercase letters, numbers, - or _.`);
      if (o.description && o.description.length > 100) e.push(`Option “${o.name}”: description can be at most 100 characters.`);
      if (seen.has(o.name)) e.push(`Duplicate option name “${o.name}”.`);
      seen.add(o.name);
    }
    return e;
  },
});

trigger('trigger.message.received', {
  label: 'Message Received', icon: '💬', requires: 'messageContent',
  description: 'Runs when someone posts a message that matches your filter (e.g. a !prefix command).',
  fields: [
    select('mode', 'Message', [['any', 'is anything'], ['contains', 'contains'], ['startsWith', 'starts with'], ['equals', 'is exactly'], ['regex', 'matches regex']]),
    text('text', 'Text', { showIf: whenNot('mode', 'any'), required: true, placeholder: '!hello' }),
    bool('caseSensitive', 'Case sensitive', { showIf: whenNot('mode', 'any') }),
    idField('channelId', 'Only in channel (optional)', 'channel'),
    ignoreBots,
  ],
  provides: () => [...USER, ...MEMBER, ...GUILD, ...CHANNEL, ...MESSAGE, ['message.after', 'Text after the matched prefix']],
  summary: (d) => (d.mode === 'any' ? 'any message' : `${d.mode} “${d.text || '?'}”`),
  check(d) {
    if (d.mode === 'regex' && d.text) { try { new RegExp(d.text); } catch { return ['Invalid regular expression.']; } }
    return [];
  },
});
trigger('trigger.message.deleted', {
  label: 'Message Deleted', icon: '🗑️',
  description: 'Runs when a message is deleted. Text and author are only known if the bot had seen the message.',
  fields: [idField('channelId', 'Only in channel (optional)', 'channel')],
  provides: () => [...GUILD, ...CHANNEL, ...MESSAGE, ...USER],
  summary: (d) => (d.channelId ? `in ${d.channelId}` : 'any channel'),
});

const memberTrigger = (type, label, icon, description, extra = {}) => trigger(type, {
  label, icon, description, requires: extra.requires, fields: [ignoreBots, ...(extra.fields || [])],
  provides: () => [...USER, ...MEMBER, ...GUILD, ...(extra.provides || [])], summary: () => '',
});
memberTrigger('trigger.member.join', 'Member Joined', '👋', 'Runs when someone joins the server.', { requires: 'members' });
memberTrigger('trigger.member.leave', 'Member Left', '🚪', 'Runs when someone leaves on their own (kicks and bans have their own triggers).', { requires: 'members', fields: [includeSelf] });
memberTrigger('trigger.member.kicked', 'Member Kicked', '🥾', 'Runs when someone is kicked. Needs the bot to have “View Audit Log”, otherwise kicks look like leaves.', { requires: 'members', provides: EXECUTOR, fields: [includeSelf] });
memberTrigger('trigger.member.banned', 'Member Banned', '🔨', 'Runs when someone is banned.', { provides: EXECUTOR, fields: [includeSelf] });
memberTrigger('trigger.member.unbanned', 'Member Unbanned', '🕊️', 'Runs when a ban is lifted.', { provides: EXECUTOR, fields: [includeSelf] });
memberTrigger('trigger.member.timeout', 'Member Timed Out', '⏳', 'Runs when someone is put in timeout.', {
  requires: 'members', provides: [['timeout.until', 'Timeout ends (ISO)'], ['timeout.minutes', 'Minutes remaining'], ...EXECUTOR], fields: [includeSelf],
});
for (const [type, label, icon] of [['trigger.member.roleAdded', 'Role Given to Member', '🎖️'], ['trigger.member.roleRemoved', 'Role Removed from Member', '📤']]) {
  memberTrigger(type, label, icon, `Runs when a member ${type.endsWith('Added') ? 'gains' : 'loses'} a role.`, {
    requires: 'members', provides: ROLE, fields: [idField('roleId', 'Only for role (optional)', 'role'), includeSelf],
  });
}

for (const verb of ['created', 'deleted', 'updated']) {
  trigger(`trigger.role.${verb}`, {
    label: `Role ${verb[0].toUpperCase()}${verb.slice(1)}`, icon: '🎭',
    description: `Runs when a role is ${verb}.`, fields: [includeSelf],
    provides: () => [...GUILD, ...ROLE, ...(verb === 'updated' ? [['oldRole.name', 'Old role name'], ['oldRole.color', 'Old role color']] : [])],
    summary: () => '',
  });
  trigger(`trigger.channel.${verb}`, {
    label: `Channel ${verb[0].toUpperCase()}${verb.slice(1)}`, icon: '#️⃣',
    description: `Runs when a channel is ${verb}. Just moving a channel does not count as an update.`, fields: [includeSelf],
    provides: () => [...GUILD, ...CHANNEL, ...(verb === 'updated' ? [['oldChannel.name', 'Old channel name'], ['oldChannel.topic', 'Old topic']] : [])],
    summary: () => '',
  });
}
for (const verb of ['added', 'removed']) {
  trigger(`trigger.reaction.${verb}`, {
    label: `Reaction ${verb[0].toUpperCase()}${verb.slice(1)}`, icon: verb === 'added' ? '😀' : '😶',
    description: `Runs when someone ${verb === 'added' ? 'adds' : 'removes'} an emoji reaction. Perfect for reaction roles.`,
    fields: [
      idField('messageId', 'Only on message (optional)', 'message', { help: 'Right-click a message → Copy Message ID (Developer Mode).' }),
      text('emoji', 'Only for emoji (optional)', { placeholder: '👍 or custom emoji name' }),
      ignoreBots,
    ],
    provides: () => [...USER, ...MEMBER, ...GUILD, ...CHANNEL, ...MESSAGE, ['emoji.name', 'Emoji name'], ['emoji.id', 'Emoji ID'], ['emoji.display', 'Emoji']],
    summary: (d) => d.emoji || 'any emoji',
  });
}
for (const verb of ['joined', 'left']) {
  trigger(`trigger.voice.${verb}`, {
    label: `Voice ${verb[0].toUpperCase()}${verb.slice(1)}`, icon: '🎙️',
    description: `Runs when someone ${verb} a voice channel.`,
    fields: [idField('channelId', 'Only channel (optional)', 'channel'), ignoreBots],
    provides: () => [...USER, ...MEMBER, ...GUILD, ...CHANNEL], summary: (d) => (d.channelId ? d.channelId : 'any voice channel'),
  });
}
trigger('trigger.schedule', {
  label: 'Schedule', icon: '⏰', description: 'Runs repeatedly on a timer (at least every minute).',
  fields: [
    num('every', 'Every', { default: 60, min: 1, required: true }),
    select('unit', 'Unit', [['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days']], { default: 'minutes' }),
    idField('channelId', 'Channel for context (optional)', 'channel'),
  ],
  provides: () => [...GUILD, ...CHANNEL], summary: (d) => `every ${d.every || '?'} ${d.unit}`,
  check: (d) => (Number(d.every) >= 1 ? [] : ['Interval must be at least 1.']),
});
trigger('trigger.manual', {
  label: 'Manual (Run button)', icon: '▶️',
  description: 'Runs when you press ▶ Run in the editor. Great for posting a button panel once.',
  fields: [idField('channelId', 'Channel for context (optional)', 'channel', { help: 'Becomes the “current channel” for the flow.' })],
  provides: () => [...GUILD, ...CHANNEL], summary: () => 'press ▶ Run',
});

trigger('trigger.form.submitted', {
  label: 'Form Submitted', icon: '🧾',
  description: 'Runs when someone submits one of your web page forms (build them in the Pages tab). Each answer is {{form.<question id>}}.',
  fields: [idField('form', 'Form', 'form', { required: true, help: 'Only forms on pages of this server are listed.' })],
  provides: () => [...USER, ...MEMBER, ...GUILD, ['form.title', 'Form title'], ['form.summary', 'All answers as text'], ['response.id', 'Response ID'], ['page.title', 'Page title'], ['page.url', 'Page link']],
  summary: (d) => (d.form ? 'a form is submitted' : 'choose a form'),
});

// ---- messages -----------------------------------------------------------------------------------
const TARGETS = [
  ['reply', 'Reply to whatever triggered this'],
  ['update', 'Edit the message the button is on'],
  ['current_channel', 'Post in the same channel'],
  ['channel', 'Post in a specific channel'],
  ['dm', 'Direct message a member'],
];
def('action.message.send', {
  category: 'message', label: 'Send Message', icon: '💬',
  description: 'Send text, an embed, buttons and a select menu. Every button becomes its own output.',
  fields: [
    select('target', 'Send to', TARGETS),
    idField('channelId', 'Channel', 'channel', { showIf: when('target', 'channel'), required: true }),
    idField('userId', 'Member', 'user', { showIf: when('target', 'dm'), placeholder: 'blank = the user who triggered this' }),
    bool('ephemeral', 'Only visible to the user (ephemeral)', { showIf: when('target', 'reply'), help: 'Works when replying to a command or button.' }),
    area('content', 'Message text', { placeholder: 'Hello {{user.mention}}!' }),
    ...embedFields(),
    list('buttons', 'Buttons', {
      create: () => ({ id: uid(6), label: 'Button', style: 'Primary', emoji: '', url: '', disabled: false }),
      label: (b) => b.label,
      fields: [
        text('label', 'Label', { required: true }),
        select('style', 'Style', BUTTON_STYLES),
        text('url', 'URL', { showIf: when('style', 'Link'), required: true }),
        text('emoji', 'Emoji (optional)'),
        bool('disabled', 'Disabled'),
      ],
    }, { max: 25 }),
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
    ...(d.buttons || []).filter((b) => b.style !== 'Link').map((b) => ({ id: `btn_${b.id}`, label: b.label || 'Button', kind: 'button' })),
    ...(d.menuEnabled ? (d.menuOptions || []).map((o) => ({ id: `opt_${o.id}`, label: o.label || 'Option', kind: 'option' })) : []),
    ERR,
  ],
  summary: (d) => `${(TARGETS.find((t) => t[0] === d.target) || [])[1] || ''}${d.content ? ` — ${d.content.slice(0, 40)}` : ''}`,
  check(d) {
    const e = [];
    if (!d.content && !d.useEmbed && !(d.buttons || []).length) e.push('Add message text, an embed or buttons — Discord will not send an empty message.');
    if ((d.buttons || []).length + (d.menuEnabled ? 1 : 0) > 25) e.push('Too many components.');
    if (d.menuEnabled && !(d.menuOptions || []).length) e.push('The select menu needs at least one option.');
    return e;
  },
});
def('action.message.edit', {
  category: 'message', label: 'Edit Message', icon: '📝', description: 'Change the text or embed of a message the bot sent.',
  fields: [
    idField('channelId', 'Channel', 'channel', { placeholder: 'blank = current channel' }),
    idField('messageId', 'Message ID', 'message', { required: true, placeholder: '{{var.msg}}' }),
    area('content', 'New text'),
    ...embedFields(),
  ],
  outputs: ACTION_OUTS, summary: (d) => d.messageId || '',
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
def('action.modal.show', {
  category: 'message', label: 'Show Form (Modal)', icon: '🧾',
  description: 'Pop up a form. Must be the first thing the flow does with a command or button. Answers are {{input.<id>}}.',
  fields: [
    text('title', 'Form title', { required: true, default: 'Tell us more' }),
    list('inputs', 'Inputs', {
      create: () => ({ id: `field_${uid(4)}`, label: 'Your answer', style: 'short', placeholder: '', required: true, maxLength: '' }),
      label: (i) => i.label,
      fields: [
        text('id', 'ID (used as {{input.ID}})', { required: true }),
        text('label', 'Label', { required: true }),
        select('style', 'Size', [['short', 'One line'], ['paragraph', 'Paragraph']]),
        text('placeholder', 'Placeholder'),
        num('maxLength', 'Max length', { min: 1, max: 4000 }),
        bool('required', 'Required'),
      ],
    }, { max: 5 }),
  ],
  outputs: [{ id: 'submit', label: 'Submitted', kind: 'button' }, ERR],
  provides: (d) => (d.inputs || []).filter((i) => i.id).map((i) => [`input.${i.id}`, `Answer: ${i.label}`]),
  summary: (d) => d.title || '',
  check(d) {
    const e = [];
    if (!(d.inputs || []).length) e.push('Add at least one input.');
    const seen = new Set();
    for (const i of d.inputs || []) {
      if (i.id && !/^[A-Za-z_][\w]{0,31}$/.test(i.id)) e.push(`Input ID “${i.id}” must be letters, numbers or _ and not start with a number.`);
      if (seen.has(i.id)) e.push(`Duplicate input ID “${i.id}”.`);
      seen.add(i.id);
    }
    return e;
  },
});

// ---- members ------------------------------------------------------------------------------------
const userField = () => idField('userId', 'Member', 'user', { placeholder: 'blank = the user who triggered this' });
const reasonField = () => text('reason', 'Reason (audit log)');
def('action.member.addRole', {
  category: 'member', label: 'Give Role', icon: '🎖️', description: 'Give a member a role.',
  fields: [userField(), idField('roleId', 'Role', 'role', { required: true }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => d.roleId || '',
});
def('action.member.removeRole', {
  category: 'member', label: 'Remove Role', icon: '📤', description: 'Take a role away from a member.',
  fields: [userField(), idField('roleId', 'Role', 'role', { required: true }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => d.roleId || '',
});
def('action.member.kick', {
  category: 'member', label: 'Kick Member', icon: '🥾', description: 'Kick a member from the server.',
  fields: [userField(), reasonField()], outputs: ACTION_OUTS, summary: (d) => d.userId || 'triggering user',
});
def('action.member.ban', {
  category: 'member', label: 'Ban Member', icon: '🔨', description: 'Ban a member from the server.',
  fields: [userField(), reasonField(), num('deleteMessageDays', 'Delete their messages from the last … days', { min: 0, max: 7, default: 0 })],
  outputs: ACTION_OUTS, summary: (d) => d.userId || 'triggering user',
});
def('action.member.unban', {
  category: 'member', label: 'Unban User', icon: '🕊️', description: 'Lift a ban.',
  fields: [idField('userId', 'User ID', 'user', { required: true }), reasonField()], outputs: ACTION_OUTS, summary: (d) => d.userId || '',
});
def('action.member.timeout', {
  category: 'member', label: 'Timeout Member', icon: '⏳', description: 'Mute a member for a while. 0 minutes removes a timeout.',
  fields: [userField(), num('minutes', 'Minutes', { default: 10, min: 0, max: 40320, required: true }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => `${d.minutes ?? '?'} min`,
});
def('action.member.nickname', {
  category: 'member', label: 'Set Nickname', icon: '🏷️', description: 'Change a member\'s nickname. Leave blank to reset it.',
  fields: [userField(), text('nickname', 'Nickname', { placeholder: 'blank = reset' }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => d.nickname || 'reset',
});

// ---- channels -----------------------------------------------------------------------------------
const overwriteList = () => list('overwrites', 'Permission overrides', {
  create: () => ({ targetType: 'role', targetId: '@everyone', allow: [], deny: [] }),
  label: (o) => `${o.targetType}: ${o.targetId}`,
  fields: [
    select('targetType', 'Applies to', [['role', 'A role'], ['member', 'A member']]),
    text('targetId', 'Role / member ID', { required: true, placeholder: '@everyone, a role ID, or {{user.id}}' }),
    multi('allow', 'Allow', CHANNEL_PERMISSIONS),
    multi('deny', 'Deny', CHANNEL_PERMISSIONS),
  ],
});
const CHANNEL_TYPES = [['text', 'Text'], ['voice', 'Voice'], ['category', 'Category'], ['announcement', 'Announcement'], ['stage', 'Stage'], ['forum', 'Forum']];
def('action.channel.create', {
  category: 'channel', label: 'Create Channel', icon: '➕', description: 'Create a channel. Save its ID to use it later in the flow.',
  fields: [
    text('name', 'Name', { required: true, placeholder: 'ticket-{{user.name}}' }),
    select('type', 'Type', CHANNEL_TYPES),
    idField('parentId', 'Category', 'category', { showIf: whenNot('type', 'category') }),
    text('topic', 'Topic', { showIf: when('type', 'text', 'announcement', 'forum') }),
    bool('nsfw', 'Age-restricted', { showIf: when('type', 'text', 'announcement', 'forum', 'voice') }),
    num('slowmode', 'Slowmode (seconds)', { showIf: when('type', 'text', 'forum'), min: 0, max: 21600 }),
    num('userLimit', 'User limit', { showIf: when('type', 'voice', 'stage'), min: 0, max: 99 }),
    bool('privateChannel', 'Hide from @everyone', { help: 'Then add overrides below to let specific people in.' }),
    overwriteList(),
    text('outputVar', 'Save channel ID as variable', { placeholder: 'channel', pattern: 'var' }),
  ],
  outputs: ACTION_OUTS, summary: (d) => `${d.type} “${d.name || '?'}”`,
});
def('action.channel.delete', {
  category: 'channel', label: 'Delete Channel', icon: '🗑️', description: 'Delete a channel. Blank = the channel where this happened.',
  fields: [idField('channelId', 'Channel', 'channel', { placeholder: 'blank = current channel' }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => d.channelId || 'current channel',
});
def('action.channel.update', {
  category: 'channel', label: 'Update Channel', icon: '🛠️', description: 'Rename or reconfigure a channel. Blank fields stay unchanged.',
  fields: [
    idField('channelId', 'Channel', 'channel', { placeholder: 'blank = current channel' }),
    text('name', 'New name'), text('topic', 'New topic'),
    idField('parentId', 'Move to category', 'category'),
    num('slowmode', 'Slowmode (seconds)', { min: 0, max: 21600 }),
    select('nsfw', 'Age-restricted', [['', 'Unchanged'], ['yes', 'Yes'], ['no', 'No']]),
    overwriteList(),
  ],
  outputs: ACTION_OUTS, summary: (d) => d.channelId || 'current channel',
});

// ---- roles --------------------------------------------------------------------------------------
def('action.role.create', {
  category: 'role', label: 'Create Role', icon: '➕', description: 'Create a new role.',
  fields: [
    text('name', 'Name', { required: true }), color('color', 'Color', { default: '#99aab5' }),
    bool('hoist', 'Show separately in the member list'), bool('mentionable', 'Anyone can @mention it'),
    multi('permissions', 'Permissions', ROLE_PERMISSIONS),
    text('outputVar', 'Save role ID as variable', { placeholder: 'role', pattern: 'var' }),
  ],
  outputs: ACTION_OUTS, summary: (d) => d.name || '',
});
def('action.role.delete', {
  category: 'role', label: 'Delete Role', icon: '🗑️', description: 'Delete a role.',
  fields: [idField('roleId', 'Role', 'role', { required: true }), reasonField()], outputs: ACTION_OUTS, summary: (d) => d.roleId || '',
});
def('action.role.update', {
  category: 'role', label: 'Update Role', icon: '🛠️', description: 'Rename or recolor a role. Blank fields stay unchanged.',
  fields: [
    idField('roleId', 'Role', 'role', { required: true }), text('name', 'New name'),
    text('color', 'New color', { placeholder: '#ff0000' }),
    select('hoist', 'Show separately', [['', 'Unchanged'], ['yes', 'Yes'], ['no', 'No']]),
    select('mentionable', 'Mentionable', [['', 'Unchanged'], ['yes', 'Yes'], ['no', 'No']]),
  ],
  outputs: ACTION_OUTS, summary: (d) => d.roleId || '',
  check: (d) => (d.color && !/^#[0-9a-fA-F]{6}$/.test(d.color) && !/\{\{/.test(d.color) ? ['Color must look like #ff8800.'] : []),
});

// ---- variables ----------------------------------------------------------------------------------
const VAR_NAME = { pattern: 'var' };
def('data.variable.set', {
  category: 'data', label: 'Set Variable', icon: '📦', description: 'Store or change a value. Server and user variables are remembered between runs.',
  fields: [
    select('scope', 'Where to store it', [['run', 'This run only (temporary)'], ['guild', 'Server (remembered)'], ['user', 'Per user (remembered)']]),
    idField('targetId', 'User', 'user', { showIf: when('scope', 'user'), placeholder: 'blank = the user who triggered this' }),
    text('name', 'Variable name', { required: true, placeholder: 'coins', ...VAR_NAME }),
    select('operation', 'Operation', [['set', 'Set to'], ['add', 'Add'], ['subtract', 'Subtract'], ['multiply', 'Multiply by'], ['divide', 'Divide by'], ['append', 'Append to list'], ['expr', 'Calculate expression'], ['random', 'Random whole number'], ['delete', 'Delete']]),
    text('value', 'Value', { showIf: whenNot('operation', 'random', 'delete'), placeholder: 'e.g. 1 or {{option.name}}' }),
    select('valueType', 'Treat value as', [['text', 'Text'], ['number', 'Number'], ['boolean', 'True / False'], ['json', 'JSON']], { showIf: when('operation', 'set') }),
    num('min', 'Minimum', { showIf: when('operation', 'random'), default: 1 }),
    num('max', 'Maximum', { showIf: when('operation', 'random'), default: 6 }),
  ],
  outputs: ACTION_OUTS,
  summary: (d) => `${d.scope}.${d.name || '?'} ${d.operation}${d.value !== '' && d.value !== undefined && !['delete', 'random'].includes(d.operation) ? ` ${d.value}` : ''}`,
});
def('data.variable.get', {
  category: 'data', label: 'Get Variable', icon: '🔎', description: 'Read a remembered variable into this run as {{var.<name>}}.',
  fields: [
    select('scope', 'Read from', [['guild', 'Server'], ['user', 'Per user']]),
    idField('targetId', 'User', 'user', { showIf: when('scope', 'user'), placeholder: 'blank = the user who triggered this' }),
    text('name', 'Variable name', { required: true, ...VAR_NAME }),
    text('saveAs', 'Save as', { required: true, placeholder: 'coins', ...VAR_NAME }),
    text('default', 'If missing use', { placeholder: '0' }),
  ],
  outputs: ACTION_OUTS, summary: (d) => `${d.scope}.${d.name || '?'} → ${d.saveAs || '?'}`,
});

// ---- logic --------------------------------------------------------------------------------------
const COND_OPS = [['equals', 'equals'], ['notEquals', 'does not equal'], ['contains', 'contains'], ['notContains', 'does not contain'], ['startsWith', 'starts with'], ['endsWith', 'ends with'], ['gt', 'is greater than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'], ['matches', 'matches regex'], ['isEmpty', 'is empty'], ['isNotEmpty', 'is not empty']];
def('logic.condition', {
  category: 'logic', label: 'Condition (If)', icon: '🔀', description: 'Follow the True or False output depending on your checks.',
  fields: [
    select('match', 'Continue on True when', [['all', 'ALL checks pass'], ['any', 'ANY check passes']]),
    list('conditions', 'Checks', {
      create: () => ({ left: '{{user.name}}', op: 'equals', right: '' }),
      label: (c) => `${c.left} ${c.op} ${c.right ?? ''}`,
      fields: [
        text('left', 'Value', { required: true, placeholder: '{{option.amount}}' }),
        select('op', 'Check', COND_OPS),
        text('right', 'Compare to', { showIf: whenNot('op', 'isEmpty', 'isNotEmpty') }),
      ],
    }),
  ],
  outputs: [{ id: 'true', label: 'True', kind: 'true' }, { id: 'false', label: 'False', kind: 'false' }],
  summary: (d) => (d.conditions || []).map((c) => `${c.left} ${c.op} ${c.right ?? ''}`).join(d.match === 'any' ? ' OR ' : ' AND ').slice(0, 60),
  check: (d) => ((d.conditions || []).length ? [] : ['Add at least one check.']),
});
def('logic.random', {
  category: 'logic', label: 'Random Chance', icon: '🎲', description: 'Follow True with the given probability, otherwise False.',
  fields: [num('chance', 'Chance of True (%)', { default: 50, min: 0, max: 100, required: true })],
  outputs: [{ id: 'true', label: 'True', kind: 'true' }, { id: 'false', label: 'False', kind: 'false' }], summary: (d) => `${d.chance}%`,
});
def('logic.loop', {
  category: 'logic', label: 'Loop', icon: '🔁', description: 'Run the “Each” branch several times, then continue with “Done”. Uses {{loop.index}} and {{loop.item}}.',
  fields: [
    select('mode', 'Loop', [['repeat', 'A number of times'], ['list', 'Over a list']]),
    num('count', 'Times', { showIf: when('mode', 'repeat'), default: 3, min: 1 }),
    area('items', 'List', { showIf: when('mode', 'list'), placeholder: 'One per line, comma-separated, or a JSON array', rows: 3 }),
  ],
  outputs: [{ id: 'each', label: 'Each', kind: 'branch' }, { id: 'done', label: 'Done' }],
  provides: () => [['loop.index', 'Loop index (from 1)'], ['loop.item', 'Current item'], ['loop.count', 'Total iterations']],
  summary: (d) => (d.mode === 'repeat' ? `${d.count}×` : 'over list'),
});
def('logic.cooldown', {
  category: 'logic', label: 'Cooldown', icon: '🧊', description: 'Let a flow run only once per time window. Blocked runs follow the Blocked output.',
  fields: [
    num('seconds', 'Seconds', { default: 30, min: 1, required: true }),
    select('scope', 'Per', [['user', 'User'], ['channel', 'Channel'], ['guild', 'Server']]),
    text('key', 'Shared name (optional)', { help: 'Nodes with the same name share one cooldown.' }),
  ],
  outputs: [{ id: 'ok', label: 'Allowed', kind: 'true' }, { id: 'blocked', label: 'Blocked', kind: 'false' }],
  provides: () => [['cooldown.remaining', 'Seconds left (when blocked)']], summary: (d) => `${d.seconds}s per ${d.scope}`,
});
def('logic.wait', {
  category: 'logic', label: 'Wait', icon: '⌛', description: 'Pause the flow for a while. Switching the flow off stops it.',
  fields: [num('seconds', 'Seconds', { default: 5, min: 0, required: true })], outputs: [OUT], summary: (d) => `${d.seconds}s`,
});
def('logic.log', {
  category: 'logic', label: 'Log', icon: '📋', description: 'Write a line to the Logs panel — handy for debugging.',
  fields: [select('level', 'Level', [['info', 'Info'], ['warn', 'Warning']]), area('message', 'Message', { required: true, rows: 2 })],
  outputs: [OUT], summary: (d) => (d.message || '').slice(0, 40),
});

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------
export const NODE_TYPES = defs;
export const NODE_LIST = Object.values(defs);
export const isTriggerType = (type) => Boolean(defs[type]?.isTrigger);

export function getOutputs(type, data = {}) {
  const d = defs[type];
  if (!d) return [];
  return typeof d.outputs === 'function' ? d.outputs(data || {}) : d.outputs;
}

export function defaultsFor(type) {
  const d = defs[type];
  const out = {};
  for (const f of d?.fields || []) out[f.key] = structuredClone(f.default);
  return out;
}

/** Template variables a node can use, found by walking the graph backwards to its triggers. */
/** `extra.forms` (from GET /forms) lets a Form Submitted trigger list its own questions as {{form.<id>}}. */
export function availableVariables(nodes, edges, nodeId, extra = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of edges) { if (!incoming.has(e.target)) incoming.set(e.target, []); incoming.get(e.target).push(e); }
  const out = new Map();
  const add = (path, label) => { if (!out.has(path)) out.set(path, label); };
  for (const [p, l] of [...GUILD, ['now.iso', 'Current time (ISO)'], ['now.date', 'Current date'], ['now.time', 'Current time'], ['now.timestamp', 'Unix timestamp (s)']]) add(p, l);
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  let fromComponent = false;
  let fromError = false;
  while (queue.length) {
    const id = queue.shift();
    for (const e of incoming.get(id) || []) {
      const src = byId.get(e.source);
      if (!src) continue;
      const h = e.sourceHandle || 'out';
      if (h.startsWith('btn_') || h.startsWith('opt_')) fromComponent = true;
      if (h === 'error') fromError = true;
      if (seen.has(src.id)) continue;
      seen.add(src.id);
      queue.push(src.id);
      const d = defs[src.type];
      if (!d) continue;
      if (d.provides) for (const [p, l] of d.provides(src.data || {})) add(p, l);
      if (src.type === 'trigger.form.submitted') {
        for (const f of (extra.forms || []).find((x) => x.key === src.data?.form)?.fields || []) add(`form.${f.id}`, `Answer: ${f.label}`);
      }
      const sd = src.data || {};
      if (sd.outputVar) add(`var.${sd.outputVar}`, `Saved by “${d.label}”`);
      if (src.type === 'data.variable.set' && sd.scope === 'run' && sd.name) add(`var.${sd.name}`, 'Run variable');
      if (src.type === 'data.variable.get' && sd.saveAs) add(`var.${sd.saveAs}`, 'Loaded variable');
      if (src.type === 'action.message.send' && sd.menuEnabled) { add('select.value', 'Selected menu option'); }
    }
  }
  add('user.vars.<name>', 'Remembered per-user variable');
  add('guild.vars.<name>', 'Remembered server variable');
  if (fromComponent) {
    for (const [p, l] of [['original.user.name', 'Original user name'], ['original.user.id', 'Original user ID'], ['original.user.mention', 'Original user mention'], ['original.channel.id', 'Original channel ID'], ['original.option.<name>', 'Original command option']]) add(p, l);
  }
  if (fromError) { add('error.message', 'Error message'); }
  return [...out].map(([path, label]) => ({ path, label }));
}
