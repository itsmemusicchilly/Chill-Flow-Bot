// Single source of truth for every node type. The editor renders its palette, cards and inspector from
// this file; the server uses it to validate graphs, compute handles and activate triggers.
import { CronError, nextRuns, scheduleOf, timeZoneNames, WEEKDAYS } from './cron.js';
import { DEFAULT_FEED_MINUTES, FEED_SOURCES, FeedSettingError, MIN_FEED_MINUTES, feedUrlOf, parsePublicHttpsUrl } from './feeds.js';
import { DEFAULT_TWITCH_MINUTES, DEFAULT_YOUTUBE_MINUTES, MIN_TWITCH_MINUTES, MIN_YOUTUBE_MINUTES, twitchSettings, youtubeSettings } from './platforms.js';
import { area, bool, color, idField, image, isVisible, list, multi, num, select, text, VAR_NAME_RE, when, whenNot } from './fields.js';
import { uid } from './util.js';

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

const OUT = { id: 'out', label: 'Next' };
const ERR = { id: 'error', label: 'On error', kind: 'error' };
const ACTION_OUTS = [OUT, ERR];

const USER = [['user.id', 'User ID'], ['user.name', 'Username'], ['user.displayName', 'Display name'], ['user.mention', 'Mention'], ['user.tag', 'Tag'], ['user.avatar', 'Avatar URL'], ['user.isBot', 'Is a bot']];
const MEMBER = [['member.nickname', 'Nickname'], ['member.joinedAt', 'Joined at'], ['member.roleIds', 'Role IDs'], ['member.permissions', 'Permissions'], ['member.boostingSince', 'Boosting since (ISO, blank if not boosting)']];
const GUILD = [['guild.id', 'Server ID'], ['guild.name', 'Server name'], ['guild.memberCount', 'Member count'], ['guild.boostCount', 'Server boosts'], ['guild.boostTier', 'Server boost level (0-3)']];
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
  image('embedThumbnail', 'Thumbnail', { showIf: when('useEmbed', true), help: 'An https link, {{a variable}}, or a picture you uploaded.' }),
  image('embedImage', 'Image', { showIf: when('useEmbed', true), help: 'An https link, {{a variable}}, or a picture you uploaded.' }),
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

trigger('trigger.button.clicked', {
  label: 'Button Clicked', icon: '🔘',
  description: 'Runs when someone presses a button that has this Button ID — on any message, from any flow. Keeps working after restarts, so it is ideal for ticket and role panels.',
  fields: [
    text('customId', 'Button ID', {
      required: true, placeholder: 'open_ticket',
      help: 'Give a button in a Send Message node the same “Button ID”. Letters, numbers, - _ and . (max 64). Use each ID in only one flow.',
    }),
  ],
  provides: () => [...USER, ...MEMBER, ...GUILD, ...CHANNEL, ...MESSAGE, ['button.id', 'Button ID'], ['button.label', 'Button label']],
  summary: (d) => d.customId || '?',
  check(d) {
    const id = String(d.customId ?? '').trim();
    return id && !BUTTON_ID_RE.test(id) ? ['Button ID can only use letters, numbers, - _ and . (max 64).'] : [];
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

// Boosts: "started" = the member had no boost and now has one; "stopped" = all of their boosts ended. Extra boosts by
// someone who already boosts change nothing (Discord keeps the first boost date), so they do not count. Bots cannot boost.
for (const [type, label, icon, description] of [
  ['trigger.user.boostserver', 'Member Boosted Server', '🚀', 'Runs when a member starts boosting the server. Extra boosts from someone who already boosts do not count.'],
  ['trigger.user.unboostserver', 'Member Stopped Boosting', '💔', 'Runs when a member stops boosting the server altogether (all of their boosts ended).'],
]) {
  trigger(type, {
    label, icon, description, requires: 'members', fields: [],
    provides: () => [...USER, ...MEMBER, ...GUILD, ['boost.since', 'When they started boosting (ISO)'], ['boost.days', 'Days they boosted (when they stop)']],
    summary: () => '',
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
const EVERY_ONLY = whenNot('mode', 'time', 'cron');
const dayList = (d) => {
  const chosen = WEEKDAYS.filter(([v]) => (d.days || []).includes(v)).map(([, label]) => label);
  return chosen.length && chosen.length < 7 ? chosen.join(', ') : 'daily';
};
trigger('trigger.schedule', {
  label: 'Schedule', icon: '⏰',
  description: 'Runs on a timer: every so many minutes, hours or days; at a set time of day (optionally only on some weekdays); or on a cron schedule. Set times and cron use the time zone you pick.',
  fields: [
    select('mode', 'Run', [['every', 'Every … minutes, hours or days'], ['time', 'At a set time of day'], ['cron', 'On a cron schedule']], { default: 'every' }),
    num('every', 'Every', { default: 60, min: 1, required: true, showIf: EVERY_ONLY }),
    select('unit', 'Unit', [['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days']], { default: 'minutes', showIf: EVERY_ONLY }),
    text('time', 'Time', { default: '09:00', placeholder: '09:00', showIf: when('mode', 'time'), help: 'On a 24-hour clock, for example 09:30 or 18:00.' }),
    multi('days', 'Only on these days', WEEKDAYS, { showIf: when('mode', 'time'), help: 'Leave them all off to run every day.' }),
    text('cron', 'Cron expression', {
      default: '0 9 * * 1-5', placeholder: '0 9 * * 1-5', showIf: when('mode', 'cron'),
      help: 'Five fields: minute, hour, day of month, month, day of week. For example 0 9 * * 1-5 is 09:00 on weekdays, */15 * * * * is every 15 minutes, 0 0 1 * * is midnight on the 1st. Also @hourly, @daily, @weekly, @monthly.',
    }),
    select('timezone', 'Time zone', timeZoneNames(), { default: 'UTC', open: true, showIf: when('mode', 'time', 'cron'), help: 'The clock the time above is read on. Runs missed while the bot was off are not made up.' }),
    idField('channelId', 'Channel for context (optional)', 'channel'),
  ],
  preview: 'schedule', previewAfter: 'timezone',
  provides: () => [...GUILD, ...CHANNEL],
  summary: (d) => {
    if (d.mode === 'time') return `${dayList(d)} at ${d.time || '?'} (${d.timezone || 'UTC'})`;
    if (d.mode === 'cron') return `cron ${d.cron || '?'} (${d.timezone || 'UTC'})`;
    return `every ${d.every || '?'} ${d.unit}`;
  },
  check: (d) => {
    try {
      const s = scheduleOf(d);
      if (s.cron && !nextRuns(s.cron, s.tz, Date.now(), 1).length) return ['This schedule never runs: it asks for a date that does not exist, such as 31 February.'];
      return [];
    } catch (e) {
      if (e instanceof CronError) return [e.message];
      throw e;
    }
  },
});
// ---- things that happen on other platforms ------------------------------------------------------------------------------------
const feedLabel = (d) => {
  if (d.source === 'youtube') return d.channel ? `YouTube ${String(d.channel).slice(-24)}` : '';
  if (d.source === 'reddit') return d.subreddit ? `r/${String(d.subreddit).replace(/^\/?r\//, '')}` : '';
  if (d.source === 'bluesky') return d.handle ? `Bluesky ${d.handle}` : '';
  try { const u = new URL(String(d.url ?? '').trim()); return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 50); } catch { return ''; }
};
trigger('trigger.feed.item', {
  label: 'New Feed Item', icon: '📰',
  description: 'Runs when a feed gets a new post: a YouTube channel’s new video, a subreddit, a Bluesky or Mastodon account, a blog, GitHub releases. The bot looks every few minutes; posts that are already there when you switch the flow on are not announced.',
  fields: [
    select('source', 'Where', FEED_SOURCES, { default: 'youtube' }),
    text('url', 'Feed address', {
      showIf: when('source', 'url'), placeholder: 'https://blog.example.com/feed.xml',
      help: 'A public https address of an RSS, Atom or JSON feed. Mastodon: https://server/@name.rss · GitHub releases: https://github.com/owner/repo/releases.atom · most blogs: /feed or /rss.xml',
    }),
    text('channel', 'YouTube channel ID', { showIf: when('source', 'youtube'), placeholder: 'UC…', help: 'It starts with UC and has 24 characters. In YouTube: your channel → About → Share → Copy channel ID. (A link with /channel/UC… in it works too.)' }),
    text('subreddit', 'Subreddit', { showIf: when('source', 'reddit'), placeholder: 'gaming', help: 'The name, without r/.' }),
    text('handle', 'Bluesky handle', { showIf: when('source', 'bluesky'), placeholder: 'name.bsky.social' }),
    num('minutes', 'Check every (minutes)', { default: DEFAULT_FEED_MINUTES, min: MIN_FEED_MINUTES, required: true, help: `At least ${MIN_FEED_MINUTES}. The bot operator may set a longer minimum.` }),
    idField('channelId', 'Channel for context (optional)', 'channel'),
  ],
  preview: 'feed', previewAfter: 'minutes',
  provides: () => [
    ...GUILD, ...CHANNEL,
    ['feed.title', 'Post title (blank for Mastodon and Bluesky posts: use the text)'], ['feed.link', 'Link to the post'], ['feed.author', 'Author'], ['feed.summary', 'Text of the post (plain, shortened)'], ['feed.published', 'When it was published (ISO date)'],
    ['feed.image', 'Picture address (https; may be blank)'], ['feed.id', 'The post’s unique id'], ['feed.name', 'Name of the feed or channel'],
  ],
  summary: (d) => feedLabel(d) || 'choose a feed',
  check: (d) => {
    try { parsePublicHttpsUrl(feedUrlOf(d)); return []; } catch (e) { if (e instanceof FeedSettingError) return [e.message]; throw e; }
  },
});
trigger('trigger.webhook', {
  label: 'Webhook Received', icon: '🔔',
  description: 'Runs when something calls this trigger’s secret web address. Tools like Zapier, IFTTT, Make, StreamElements or GitHub can call it — that is how to react to a new X, TikTok or Instagram post, or a Twitch follower. Save the flow to get the address.',
  fields: [idField('channelId', 'Channel for context (optional)', 'channel')],
  preview: 'webhook', previewAfter: 'channelId',
  provides: () => [
    ...GUILD, ...CHANNEL,
    ['webhook.text', 'Everything that was sent, as text'], ['webhook.body.name', 'One field of the JSON or form that was sent (replace “name” with the field’s name)'],
    ['webhook.query.name', 'One ?name=value from the address (replace “name”)'], ['webhook.method', 'The request method (always POST)'], ['webhook.contentType', 'The kind of data that was sent'],
  ],
  summary: () => 'secret web address',
});
trigger('trigger.youtube.subscribers', {
  label: 'YouTube Subscribers', icon: '▶️', needs: 'youtube',
  description: 'Runs each time a YouTube channel’s subscriber count passes the next round number (every 100, every 1,000 …). YouTube rounds public counts to three significant figures and a channel can hide its count, so pick a step much bigger than the rounding. Needs the bot operator’s YouTube API key.',
  fields: [
    text('channel', 'YouTube channel ID', { required: true, placeholder: 'UC…', help: 'It starts with UC and has 24 characters. In YouTube: your channel → About → Share → Copy channel ID. (A link with /channel/UC… in it works too.)' }),
    num('step', 'Announce every … subscribers', { default: 1000, min: 1, required: true, help: 'A milestone is announced once, the first time the count reaches it. When you switch the flow on, the current count is only noted.' }),
    num('minutes', 'Check every (minutes)', { default: DEFAULT_YOUTUBE_MINUTES, min: MIN_YOUTUBE_MINUTES, required: true, help: `At least ${MIN_YOUTUBE_MINUTES}: YouTube gives the bot a daily allowance that every server shares.` }),
    idField('channelId', 'Channel for context (optional)', 'channel'),
  ],
  provides: () => [
    ...GUILD, ...CHANNEL,
    ['youtube.subscribers', 'Subscribers now'], ['youtube.milestone', 'The milestone that was reached (e.g. 10000)'], ['youtube.previous', 'Subscribers at the last check'],
    ['youtube.channelTitle', 'Channel name'], ['youtube.channelId', 'Channel ID'], ['youtube.url', 'Link to the channel'],
  ],
  summary: (d) => (d.channel ? `${String(d.channel).slice(-24)} · every ${d.step || '?'}` : 'choose a channel'),
  check: (d) => {
    if (!String(d.channel ?? '').trim()) return []; // “required” already says so
    try { youtubeSettings(d); return []; } catch (e) { if (e instanceof FeedSettingError) return [e.message]; throw e; }
  },
});
trigger('trigger.twitch.live', {
  label: 'Twitch Channel Live', icon: '🟣', needs: 'twitch',
  description: 'Runs when a Twitch channel starts a new broadcast. A broadcast that is already running when you switch the flow on is not announced. (Followers cannot be watched from outside — use the Webhook trigger with StreamElements, Streamlabs or Zapier.) Needs the bot operator’s Twitch application.',
  fields: [
    text('login', 'Twitch channel', { required: true, placeholder: 'shroud', help: 'The channel name, or a twitch.tv link.' }),
    num('minutes', 'Check every (minutes)', { default: DEFAULT_TWITCH_MINUTES, min: MIN_TWITCH_MINUTES, required: true }),
    idField('channelId', 'Channel for context (optional)', 'channel'),
  ],
  provides: () => [
    ...GUILD, ...CHANNEL,
    ['twitch.user', 'Streamer name'], ['twitch.login', 'Channel name (lowercase)'], ['twitch.title', 'Stream title'], ['twitch.game', 'Game or category'], ['twitch.viewers', 'Viewers right now'],
    ['twitch.url', 'Link to the channel'], ['twitch.thumbnail', 'Preview picture address (https)'], ['twitch.started', 'When the broadcast started (ISO date)'], ['twitch.id', 'Broadcast id'],
  ],
  summary: (d) => (d.login ? String(d.login).replace(/^@/, '').slice(0, 40) : 'choose a channel'),
  check: (d) => {
    if (!String(d.login ?? '').trim()) return [];
    try { twitchSettings(d); return []; } catch (e) { if (e instanceof FeedSettingError) return [e.message]; throw e; }
  },
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
    ...(d.buttons || []).filter((b) => b.style !== 'Link' && !buttonKey(b)).map((b) => ({ id: `btn_${b.id}`, label: b.label || 'Button', kind: 'button' })),
    ...(d.menuEnabled ? (d.menuOptions || []).map((o) => ({ id: `opt_${o.id}`, label: o.label || 'Option', kind: 'option' })) : []),
    ERR,
  ],
  summary: (d) => `${(TARGETS.find((t) => t[0] === d.target) || [])[1] || ''}${d.content ? ` — ${d.content.slice(0, 40)}` : ''}`,
  check(d) {
    const e = [];
    if (!d.content && !d.useEmbed && !(d.buttons || []).length) e.push('Add message text, an embed or buttons — Discord will not send an empty message.');
    if ((d.buttons || []).length + (d.menuEnabled ? 1 : 0) > 25) e.push('Too many components.');
    if (d.menuEnabled && !(d.menuOptions || []).length) e.push('The select menu needs at least one option.');
    const seen = new Set();
    for (const b of d.buttons || []) {
      const key = buttonKey(b);
      if (!key) continue;
      if (!/\{\{/.test(key) && !BUTTON_ID_RE.test(key)) e.push(`Button ID “${key}” can only use letters, numbers, - _ and . (max 64).`);
      if (seen.has(key)) e.push(`Button ID “${key}” is used twice in this message — Discord needs them to be unique.`);
      seen.add(key);
    }
    if (seen.size && d.target === 'dm') e.push('Buttons with a Button ID only work inside a server, not in direct messages.');
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
def('action.member.toggleRole', {
  category: 'member', label: 'Toggle Role', icon: '🔁',
  description: 'Give the role if the member does not have it, take it away if they do. Perfect for role panels: one button per role. Use {{toggle.action}} (added / removed) in your reply.',
  fields: [userField(), idField('roleId', 'Role', 'role', { required: true }), reasonField()],
  outputs: ACTION_OUTS,
  provides: () => [...ROLE, ['toggle.action', 'Whether the role was “added” or “removed”']],
  summary: (d) => d.roleId || '',
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
  category: 'channel', label: 'Update Channel', icon: '🛠️', description: 'Rename or reconfigure a channel. Blank fields stay unchanged. Discord allows only two name/topic changes per channel every 10 minutes: extra ones are held and only the newest is applied when Discord allows.',
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
def('action.channel.transcript', {
  category: 'channel', label: 'Save Transcript', icon: '📄',
  description: 'Record everything said in a channel (for example a ticket that is being closed) as an .html file (plus a plain .txt copy), post it in a log channel and optionally send it to someone by direct message. If it cannot be saved, follow On error and keep the channel.',
  fields: [
    idField('channelId', 'Channel to record', 'channel', { placeholder: 'blank = current channel' }),
    idField('sendChannelId', 'Post the transcript in', 'channel', {
      required: true, help: 'For example your staff log. The bot needs Send Messages and Attach Files there. Do not use the channel being recorded.',
    }),
    area('channelMessage', 'Message with the file (log channel)', { default: '📄 Transcript of #{{channel.name}}', rows: 2 }),
    idField('sendUserId', 'Also send it to (direct message)', 'user', {
      placeholder: '{{original.user.id}} = whoever opened the ticket',
      help: 'Optional. If their DMs are closed, or they can no longer see the channel, the DM is skipped and the flow carries on.',
    }),
    area('dmMessage', 'Message with the file (direct message)', {
      showIf: whenNot('sendUserId', ''), rows: 2,
      default: 'Here is a copy of your conversation in {{guild.name}}. Download the files: open the .html one in your browser, or the .txt one in any text editor.',
    }),
    bool('skipText', 'Leave out the plain-text (.txt) copy', {
      help: 'By default a .txt file with the same messages is attached next to the .html one, in the log channel and in the direct message. It is easy to search, copy and read on a phone.',
    }),
  ],
  outputs: ACTION_OUTS,
  provides: () => [
    ['transcript.messages', 'Messages in the transcript'], ['transcript.name', 'Transcript file name (.html)'], ['transcript.textName', 'Plain-text file name (.txt, blank if left out)'], ['transcript.bytes', 'File size (bytes, .html)'],
    ['transcript.truncated', 'true if the transcript was cut short'], ['transcript.dm', 'Direct message: sent, failed or skipped'],
  ],
  wants: 'messageContent',
  wantsNote: 'without the Message Content intent Discord hides other people\'s message text, so the transcript can only show who wrote when (plus the bot\'s own messages). Ask the bot operator to enable it.',
  summary: (d) => (d.sendChannelId ? `→ ${d.sendChannelId}${d.sendUserId ? ' + DM' : ''}` : 'choose a log channel'),
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

// Maths: Set Variable *changes a remembered number*; Math *calculates a new value from any values* (other variables, the member
// count, an option…) and hands it on as {{var.<name>}}, optionally remembering it as well.
const MATH_OPS = [['add', '+  Add'], ['sub', '−  Subtract'], ['mul', '×  Multiply'], ['div', '÷  Divide'], ['mod', 'Remainder after dividing'], ['pow', 'To the power of'], ['min', 'The smaller of the two'], ['max', 'The larger of the two']];
const MATH_SYMBOLS = { add: '+', sub: '−', mul: '×', div: '÷', mod: 'mod', pow: '^', min: 'min', max: 'max' };
def('data.math', {
  category: 'data', label: 'Math', icon: '🧮',
  description: 'Calculate a number from any values — variables, the member count, an option… — and use it in the next nodes as {{var.<name>}}. Tick “Also remember it” to keep it as a server or per-user variable. To just change a remembered number, Set Variable is quicker.',
  fields: [
    select('mode', 'How', [['two', 'Two values'], ['formula', 'Formula']]),
    text('a', 'First value', { showIf: when('mode', 'two'), required: true, placeholder: '{{guild.vars.joins}}' }),
    select('op', 'Operation', MATH_OPS, { showIf: when('mode', 'two') }),
    text('b', 'Second value', { showIf: when('mode', 'two'), required: true, placeholder: '1' }),
    text('formula', 'Formula', {
      showIf: when('mode', 'formula'), required: true, placeholder: '({{var.a}} + {{var.b}}) * 2',
      help: 'Use + - * / % ^, brackets and round(), floor(), ceil(), abs(), sqrt(), min(), max(). An empty variable breaks a formula: write {{var.x | default:0}}.',
    }),
    select('round', 'Round the result', [['none', 'Do not round'], ['0', 'To a whole number'], ['1', 'To 1 decimal'], ['2', 'To 2 decimals']]),
    text('saveAs', 'Save result as', { required: true, placeholder: 'total', help: 'Use it in the next nodes as {{var.total}}.', ...VAR_NAME }),
    select('remember', 'Also remember it', [['none', 'No — only for this run'], ['guild', 'Yes, as a server variable'], ['user', 'Yes, as a per-user variable']], { help: 'Remembered under the same name.' }),
    idField('targetId', 'User', 'user', { showIf: when('remember', 'user'), placeholder: 'blank = the user who triggered this' }),
  ],
  outputs: ACTION_OUTS,
  summary: (d) => `${d.mode === 'formula' ? d.formula || '?' : `${d.a || '?'} ${MATH_SYMBOLS[d.op] ?? '?'} ${d.b || '?'}`} → ${d.saveAs || '?'}`,
});

// ---- logic --------------------------------------------------------------------------------------
const ROLE_OPS = ['hasRole', 'lacksRole'];
const COND_OPS = [['equals', 'equals'], ['notEquals', 'does not equal'], ['contains', 'contains'], ['notContains', 'does not contain'], ['startsWith', 'starts with'], ['endsWith', 'ends with'], ['gt', 'is greater than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'], ['matches', 'matches regex'], ['isEmpty', 'is empty'], ['isNotEmpty', 'is not empty'], ['hasRole', 'has the role'], ['lacksRole', 'does not have the role']];
/** One check as words. `names.role(id)` (when the editor can supply it) turns a role id into its name. */
const conditionText = (c, names) => {
  if (ROLE_OPS.includes(c.op)) return `${c.op === 'hasRole' ? 'has' : 'lacks'} role ${(names?.role?.(c.roleId) ?? c.roleId) || '?'}${c.memberId ? ` (${c.memberId})` : ''}`;
  return `${c.left} ${c.op} ${c.right ?? ''}`;
};
def('logic.condition', {
  category: 'logic', label: 'Condition (If)', icon: '🔀', description: 'Follow the True or False output depending on your checks — compare values, or check whether someone has a role.',
  fields: [
    select('match', 'Continue on True when', [['all', 'ALL checks pass'], ['any', 'ANY check passes']]),
    list('conditions', 'Checks', {
      create: () => ({ left: '{{user.name}}', op: 'equals', right: '', roleId: '', memberId: '' }),
      label: (c, names) => conditionText(c, names),
      fields: [
        text('left', 'Value', { required: true, placeholder: '{{option.amount}}', showIf: whenNot('op', ...ROLE_OPS) }),
        select('op', 'Check', COND_OPS),
        text('right', 'Compare to', { showIf: whenNot('op', 'isEmpty', 'isNotEmpty', ...ROLE_OPS) }),
        idField('roleId', 'Role', 'role', {
          required: true, showIf: when('op', ...ROLE_OPS),
          help: 'Pick a role, or use a variable such as {{option.role}}. If the role no longer exists, the check counts as “no”.',
        }),
        idField('memberId', 'Member', 'user', {
          showIf: when('op', ...ROLE_OPS), placeholder: 'blank = whoever triggered this',
          help: 'Optional: check someone else, for example {{option.member}}. Someone who is not in the server does not have the role.',
        }),
      ],
    }),
  ],
  outputs: [{ id: 'true', label: 'True', kind: 'true' }, { id: 'false', label: 'False', kind: 'false' }],
  summary: (d, names) => (d.conditions || []).map((c) => conditionText(c, names)).join(d.match === 'any' ? ' OR ' : ' AND ').slice(0, 60),
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
      if (h.startsWith('btn_') || h.startsWith('opt_') || src.type === 'trigger.button.clicked') fromComponent = true;
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
      if (src.type === 'data.math' && sd.saveAs) add(`var.${sd.saveAs}`, 'Math result');
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
