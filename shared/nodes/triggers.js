// Triggers: what starts a flow (commands, buttons, server events, schedules, other platforms, counts, forms).
import { bool, idField, list, multi, num, select, text, when, whenNot } from '../fields.js';
import { CronError, nextRuns, scheduleOf, timeZoneNames, WEEKDAYS } from '../cron.js';
import { DEFAULT_FEED_MINUTES, FEED_SOURCES, FeedSettingError, feedUrlOf, MIN_FEED_MINUTES, parsePublicHttpsUrl } from '../feeds.js';
import { accountOf, COUNT_MODES, countSettings, DEFAULT_TIKTOK_MINUTES, DEFAULT_TWITCH_FOLLOWER_MINUTES, DEFAULT_TWITCH_MINUTES, DEFAULT_YOUTUBE_COUNT_MINUTES, DEFAULT_YOUTUBE_MINUTES, MIN_TIKTOK_MINUTES, MIN_TWITCH_FOLLOWER_MINUTES, MIN_TWITCH_MINUTES, MIN_YOUTUBE_MINUTES, twitchSettings, youtubeCountSettings, youtubeSettings } from '../platforms.js';
import { BUTTON_ID_RE, CHANNEL, EXECUTOR, GUILD, ignoreBots, includeSelf, MEMBER, MESSAGE, ROLE, trigger, USER } from './core.js';

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
  description: 'Runs when a message is deleted. The text, author and attachments are filled in when the bot has seen the message (it remembers recent messages while this flow is on). The text needs the Message Content intent.',
  fields: [idField('channelId', 'Only in channel (optional)', 'channel')],
  provides: () => [...GUILD, ...CHANNEL, ...MESSAGE, ...USER,
    ['message.createdAt', 'When it was posted (ISO)'],
    ['message.attachments', 'Attachment links, one per line'],
    ['message.attachmentCount', 'Number of attachments']],
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
  description: 'Runs when something calls this trigger’s secret web address. Tools like Zapier, IFTTT, Make, StreamElements or GitHub can call it — that is how to react to a new X, TikTok, Instagram or Facebook post, or a Twitch follower. Save the flow to get the address.',
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
  description: 'Runs when a Twitch channel starts a new broadcast. A broadcast that is already running when you switch the flow on is not announced. (For followers use “Twitch Followers”.) Needs the bot operator’s Twitch application.',
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
// ---- counts: subscribers and followers ----------------------------------------------------------------------------------------------
const COUNT_FIELDS = (min, def, accountKind) => [
  ...(accountKind ? [idField('account', 'Account', accountKind, { placeholder: 'blank = the first connected account', help: 'Which connected account to count, when this server has connected more than one (top bar → Accounts).' })] : []),
  select('fire', 'Run', COUNT_MODES, { default: 'gain', help: '“Each time it goes up” suits a thank-you message. “Every time it changes” also runs when the count drops and once when you switch the flow on, so a counter channel is right straight away.' }),
  num('minutes', 'Check every (minutes)', { default: def, min, required: true }),
  idField('channelId', 'Channel for context (optional)', 'channel'),
];
const COUNT_VARS = (ns, noun) => [
  [`${ns}.${noun}`, 'The count now'], [`${ns}.gained`, 'How many were gained since the last check (0 if it went down)'], [`${ns}.change`, 'The change since the last check (negative if it went down)'], [`${ns}.previous`, 'The count at the last check'],
];
const countCheck = (settings) => (d) => {
  try { settings(d); return []; } catch (e) { if (e instanceof FeedSettingError) return [e.message]; throw e; }
};
trigger('trigger.youtube.gained', {
  label: 'YouTube Subscribers Gained', icon: '📈', needs: 'youtube',
  description: 'Runs when a YouTube channel gets new subscribers (or, for a counter, whenever its count changes). YouTube rounds public counts to three significant figures once a channel has more than 1,000, so a big channel moves in small jumps rather than one by one. The count that is already there when you switch the flow on is only noted. Needs the bot operator’s YouTube API key.',
  fields: [
    text('channel', 'YouTube channel ID', { required: true, placeholder: 'UC…', help: 'It starts with UC and has 24 characters. In YouTube: your channel → About → Share → Copy channel ID. (A link with /channel/UC… in it works too.)' }),
    ...COUNT_FIELDS(MIN_YOUTUBE_MINUTES, DEFAULT_YOUTUBE_COUNT_MINUTES),
  ],
  provides: () => [
    ...GUILD, ...CHANNEL,
    ['youtube.subscribers', 'Subscribers now'], ['youtube.gained', 'How many were gained since the last check (0 if it went down)'], ['youtube.change', 'The change since the last check (negative if it went down)'], ['youtube.previous', 'Subscribers at the last check'],
    ['youtube.channelTitle', 'Channel name'], ['youtube.channelId', 'Channel ID'], ['youtube.url', 'Link to the channel'],
  ],
  summary: (d) => (d.channel ? `${String(d.channel).slice(-24)} · ${d.fire === 'change' ? 'every change' : 'each gain'}` : 'choose a channel'),
  check: (d) => (String(d.channel ?? '').trim() ? countCheck(youtubeCountSettings)(d) : []),
});
trigger('trigger.twitch.followers', {
  label: 'Twitch Followers', icon: '💜', needs: 'twitch', connect: 'twitch',
  description: 'Runs when a Twitch channel connected to this server gets new followers (or, for a counter, whenever its follower count changes). Connect the channel once under “Accounts” in the top bar: the streamer approves it on Twitch. You get the number gained since the last check, not one run per follower. The count that is there when you switch the flow on is only noted. Needs the bot operator’s Twitch application.',
  fields: COUNT_FIELDS(MIN_TWITCH_FOLLOWER_MINUTES, DEFAULT_TWITCH_FOLLOWER_MINUTES, 'twitch-account'),
  provides: () => [
    ...GUILD, ...CHANNEL,
    ...COUNT_VARS('twitch', 'followers'),
    ['twitch.name', 'Streamer name'], ['twitch.login', 'Channel name (lowercase)'], ['twitch.url', 'Link to the channel'],
    ['twitch.latest', 'Name of the newest follower (when several arrive between two checks, only the newest)'],
  ],
  summary: (d) => (d.fire === 'change' ? 'every change' : 'each gain'),
  check: countCheck((d) => { accountOf(d); return countSettings(d, { min: MIN_TWITCH_FOLLOWER_MINUTES }); }),
});
trigger('trigger.tiktok.followers', {
  label: 'TikTok Followers', icon: '🎵', needs: 'tiktok', connect: 'tiktok',
  description: 'Runs when a TikTok account connected to this server gets new followers (or, for a counter, whenever its follower count changes). Connect the account once under “Accounts” in the top bar: the creator approves it on TikTok. You get the number gained since the last check, not one run per follower. The count that is there when you switch the flow on is only noted. Needs the bot operator’s TikTok developer app.',
  fields: COUNT_FIELDS(MIN_TIKTOK_MINUTES, DEFAULT_TIKTOK_MINUTES, 'tiktok-account'),
  provides: () => [
    ...GUILD, ...CHANNEL,
    ...COUNT_VARS('tiktok', 'followers'),
    ['tiktok.name', 'Account name'],
  ],
  summary: (d) => (d.fire === 'change' ? 'every change' : 'each gain'),
  check: countCheck((d) => { accountOf(d); return countSettings(d, { min: MIN_TIKTOK_MINUTES }); }),
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
