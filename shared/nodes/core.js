// The pieces every node definition is made from: titles, categories, permission lists, variable lists, the shared embed/message helpers, and the registry that the other files in this folder add to.
import { area, bool, color, image, isVisible, list, text, VAR_NAME_RE } from '../fields.js';
import { blankEmbed, MAX_EMBEDS } from '../embeds.js';

export { isVisible, VAR_NAME_RE };
/**
 * An optional title people who edit a flow can give a node, shown on the node in the editor. It is only ever read by the editor: the engine
 * and Discord never see it. It lives in the node's data under a key no node field uses (the form node has its own `title`).
 */
export const TITLE_KEY = '_title';
export const TITLE_MAX = 60;
// control characters, line/paragraph separators and bidi overrides: a title is one plain line
const TITLE_UNSAFE = new RegExp(`[\\u0000-\\u001F\\u007F-\\u009F${String.fromCharCode(0x2028, 0x2029)}\\u202A-\\u202E\\u2066-\\u2069]`, 'g');
export function nodeTitle(data) {
  const v = data?.[TITLE_KEY];
  return typeof v === 'string' ? v.replace(TITLE_UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : '';
}
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
/** A reusable button's public id. Lives in the Discord custom_id (`fcb:<id>`), so it must stay short and colon-free. */
export const BUTTON_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** The reusable id of a button ('' when it is a normal button wired to its own output, or a Link button). */
export const buttonKey = (b) => (b && b.style !== 'Link' ? String(b.customId ?? '').trim() : '');
export const OUT = { id: 'out', label: 'Next' };
export const ERR = { id: 'error', label: 'On error', kind: 'error' };
export const ACTION_OUTS = [OUT, ERR];
export const USER = [['user.id', 'User ID'], ['user.name', 'Username'], ['user.displayName', 'Display name'], ['user.mention', 'Mention'], ['user.tag', 'Tag'], ['user.avatar', 'Avatar URL'], ['user.isBot', 'Is a bot']];
export const MEMBER = [['member.nickname', 'Nickname'], ['member.joinedAt', 'Joined at'], ['member.roleIds', 'Role IDs'], ['member.permissions', 'Permissions'], ['member.boostingSince', 'Boosting since (ISO, blank if not boosting)']];
export const GUILD = [['guild.id', 'Server ID'], ['guild.name', 'Server name'], ['guild.icon', 'Server icon URL (blank if none)'], ['guild.memberCount', 'Member count'], ['guild.boostCount', 'Server boosts'], ['guild.boostTier', 'Server boost level (0-3)']];
export const CHANNEL = [['channel.id', 'Channel ID'], ['channel.name', 'Channel name'], ['channel.mention', 'Channel mention'], ['channel.type', 'Channel type'], ['channel.parentId', 'Category ID']];
export const MESSAGE = [['message.id', 'Message ID'], ['message.content', 'Message text'], ['message.url', 'Message link'], ['message.authorId', 'Author ID']];
export const ROLE = [['role.id', 'Role ID'], ['role.name', 'Role name'], ['role.mention', 'Role mention'], ['role.color', 'Role color']];
export const EXECUTOR = [['executor.id', 'Moderator ID'], ['executor.name', 'Moderator name'], ['executor.mention', 'Moderator mention'], ['reason', 'Reason']];
// Trigger-level fields reused by many triggers.
export const includeSelf = bool('includeSelf', 'Also run for changes made by this bot', {
  help: 'Off by default so a flow cannot trigger itself in a loop.',
});
export const ignoreBots = bool('ignoreBots', 'Ignore bots', { default: true });
// ---------------------------------------------------------------------------------------------------
// message payload fields shared by Send / Edit message
// ---------------------------------------------------------------------------------------------------
export const PICTURE_HELP = 'An https link, {{a variable}}, or a picture you uploaded.';
export const embedFieldList = (o = {}) => list('fields', 'Fields', {
  create: () => ({ name: 'Field', value: 'Value', inline: false }),
  label: (i) => i.name,
  fields: [text('name', 'Name'), text('value', 'Value'), bool('inline', 'Inline')],
}, { max: 25, ...o });
/** Every part of one embed. */
const embedItemFields = () => [
  text('title', 'Title'),
  text('url', 'Title link', { placeholder: 'https://…', help: 'Makes the title a link. Needs a title.' }),
  area('description', 'Description', { rows: 4 }),
  color('color', 'Color'),
  text('authorName', 'Author name', { help: 'A small line above the title. Needed for the author icon and link to show.' }),
  image('authorIcon', 'Author icon', { help: PICTURE_HELP }),
  text('authorUrl', 'Author link', { placeholder: 'https://…' }),
  image('thumbnail', 'Thumbnail', { help: PICTURE_HELP }),
  image('image', 'Image', { help: PICTURE_HELP }),
  text('footer', 'Footer text'),
  image('footerIcon', 'Footer icon', { help: `${PICTURE_HELP} Needs footer text.` }),
  bool('timestamp', 'Show timestamp'),
  embedFieldList(),
];
/** The embeds of a message: up to 10, each with every part. Shared by Send Message and Edit Message. */
export const embedsList = (o = {}) => list('embeds', 'Embeds', {
  create: blankEmbed,
  label: (m) => m.title || String(m.description || '').slice(0, 30) || 'Embed',
  fields: embedItemFields(),
}, { max: MAX_EMBEDS, help: `Up to ${MAX_EMBEDS} embeds per message, and 6000 characters in all.`, ...o });
const HTTP_LINK = /^https?:\/\/\S+$/i;
/** Problems with the embeds of a node (the ones that would only show up as a Discord error when the flow runs). */
export function embedErrors(embeds) {
  const e = [];
  if (embeds.length > MAX_EMBEDS) e.push(`A message can have at most ${MAX_EMBEDS} embeds.`);
  embeds.forEach((m, i) => {
    const at = embeds.length > 1 ? `Embed ${i + 1}: ` : '';
    if ((m.authorIcon || m.authorUrl) && !m.authorName) e.push(`${at}the author needs a name for its icon or link to show.`);
    if (m.footerIcon && !m.footer) e.push(`${at}the footer icon needs footer text.`);
    for (const [key, what] of [['url', 'title link'], ['authorUrl', 'author link']]) {
      if (m[key] && !/\{\{/.test(m[key]) && !HTTP_LINK.test(m[key])) e.push(`${at}the ${what} must start with http:// or https://.`);
    }
  });
  return e;
}
export const MESSAGE_FROM = [['this', 'This message (the one that started the flow)'], ['id', 'A previous message (by its ID)']];
export const BUTTON_STYLES = [['Primary', 'Blurple'], ['Secondary', 'Grey'], ['Success', 'Green'], ['Danger', 'Red'], ['Link', 'Link (opens a URL)']];
// ---------------------------------------------------------------------------------------------------
// definitions
// ---------------------------------------------------------------------------------------------------
export const defs = {};
export const def = (type, d) => { defs[type] = { type, ...d }; };
export const trigger = (type, d) => def(type, { category: 'trigger', outputs: [OUT], ...d, isTrigger: true });
export const reasonField = () => text('reason', 'Reason (audit log)');
