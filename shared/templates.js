// Starter flows shown in "New flow → from template". Ids are fixed so button handles line up.
import { defaultsFor } from './catalog.js';

const n = (id, type, x, y, data = {}) => ({ id, type, position: { x, y }, data: { ...defaultsFor(type), ...data } });
const e = (source, target, sourceHandle = 'out') => ({ id: `${source}:${sourceHandle}>${target}`, source, sourceHandle, target, targetHandle: 'in' });

export const TEMPLATES = [
  {
    id: 'welcome',
    name: 'Welcome new members',
    description: 'Greets people in a channel and gives them a starter role. Needs the Server Members intent.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.member.join', 0, 60),
        n('m1', 'action.message.send', 340, 0, {
          target: 'channel', useEmbed: true, embedTitle: 'Welcome!', embedColor: '#3ba55d',
          embedDescription: 'Hey {{user.mention}}, welcome to **{{guild.name}}**! You are member #{{guild.memberCount}}.',
        }),
        n('r1', 'action.member.addRole', 700, 40, { reason: 'Welcome flow' }),
      ],
      edges: [e('t1', 'm1'), e('m1', 'r1')],
    }),
  },
  {
    id: 'ticket',
    name: 'Support tickets',
    description: '/ticket opens a private channel with a Close button. Closing saves a transcript (.html) in a log channel — pick it in “Save Transcript” — and sends a copy to whoever opened the ticket. Add your staff role in the “Create Channel” overrides.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.command', 0, 120, {
          name: 'ticket', description: 'Open a support ticket',
          options: [{ name: 'reason', description: 'What do you need help with?', type: 'string', required: false }],
        }),
        n('c1', 'action.channel.create', 320, 60, {
          name: 'ticket-{{user.name}}', privateChannel: true, outputVar: 'ticket',
          overwrites: [{ targetType: 'member', targetId: '{{user.id}}', allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'], deny: [] }],
        }),
        n('r1', 'action.message.send', 640, 60, { target: 'reply', ephemeral: true, content: 'Your ticket is ready: <#{{var.ticket}}>' }),
        n('s1', 'action.message.send', 960, 60, {
          target: 'channel', channelId: '{{var.ticket}}', useEmbed: true, embedTitle: '🎫 Ticket', embedColor: '#5865f2',
          embedDescription: '{{user.mention}} opened a ticket.\n**Reason:** {{option.reason | default:No reason given}}',
          buttons: [{ id: 'close', label: 'Close ticket', style: 'Danger', emoji: '🔒', url: '', disabled: false }],
        }),
        n('r2', 'action.message.send', 1600, 200, { target: 'reply', content: 'Closing this ticket in 5 seconds…' }),
        n('w1', 'logic.wait', 1920, 200, { seconds: 5 }),
        n('d1', 'action.channel.delete', 2240, 200, { reason: 'Ticket closed' }),
        n('ts1', 'action.channel.transcript', 1280, 200, {
          sendUserId: '{{original.user.id}}',
          channelMessage: '📄 Transcript of #{{channel.name}} — opened by {{original.user.mention}}, closed by {{user.mention}}. Open the .html file in a browser, or the .txt one in any text editor.',
          dmMessage: 'Here is a copy of your conversation in {{guild.name}}. Download the files: open the .html one in your browser, or the .txt one in any text editor.',
        }),
        n('ke1', 'action.message.send', 1600, 460, { target: 'reply', ephemeral: true, content: 'The transcript could not be saved, so this ticket was **not** closed: {{error.message}}' }),
      ],
      edges: [
        e('t1', 'c1'), e('c1', 'r1'), e('r1', 's1'), e('s1', 'ts1', 'btn_close'), e('ts1', 'r2'), e('ts1', 'ke1', 'error'),
        e('r2', 'w1'), e('w1', 'd1'),
      ],
    }),
  },
  {
    id: 'ticket-panel',
    name: 'Ticket panel (Open button)',
    description: 'Press ▶ Run once to post an “Open a ticket” button. Each press opens a private channel with a Close button, and the panel keeps working after restarts. Closing saves a transcript (.html) in a log channel — pick it in “Save Transcript” — and sends a copy to whoever opened the ticket. Add your staff role in the “Create Channel” overrides.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.manual', 0, 100),
        n('p1', 'action.message.send', 320, 60, {
          target: 'current_channel', useEmbed: true, embedTitle: '🎫 Need help?', embedColor: '#5865f2',
          embedDescription: 'Press the button below to open a private support ticket.',
          buttons: [{ id: 'open', label: 'Open a ticket', style: 'Success', emoji: '🎫', url: '', disabled: false, customId: 'open_ticket' }],
        }),
        n('t2', 'trigger.button.clicked', 0, 460, { customId: 'open_ticket' }),
        n('k1', 'logic.cooldown', 320, 460, { seconds: 60, scope: 'user' }),
        n('b1', 'action.message.send', 640, 700, { target: 'reply', ephemeral: true, content: 'Please wait {{cooldown.remaining}} seconds before opening another ticket.' }),
        n('c1', 'action.channel.create', 640, 400, {
          name: 'ticket-{{user.name}}', privateChannel: true, outputVar: 'ticket',
          overwrites: [{ targetType: 'member', targetId: '{{user.id}}', allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'], deny: [] }],
        }),
        n('r1', 'action.message.send', 960, 400, { target: 'reply', ephemeral: true, content: 'Your ticket is ready: <#{{var.ticket}}>' }),
        n('s1', 'action.message.send', 1280, 400, {
          target: 'channel', channelId: '{{var.ticket}}', useEmbed: true, embedTitle: '🎫 Ticket', embedColor: '#5865f2',
          embedDescription: '{{user.mention}} opened a ticket. Someone from the team will be with you soon.',
          buttons: [{ id: 'close', label: 'Close ticket', style: 'Danger', emoji: '🔒', url: '', disabled: false, customId: '' }],
        }),
        n('r2', 'action.message.send', 1920, 540, { target: 'reply', content: 'Closing this ticket (opened by {{original.user.mention}}) in 5 seconds…' }),
        n('w1', 'logic.wait', 2240, 540, { seconds: 5 }),
        n('d1', 'action.channel.delete', 2560, 540, { reason: 'Ticket closed' }),
        n('ts1', 'action.channel.transcript', 1600, 540, {
          sendUserId: '{{original.user.id}}',
          channelMessage: '📄 Transcript of #{{channel.name}} — opened by {{original.user.mention}}, closed by {{user.mention}}. Open the .html file in a browser, or the .txt one in any text editor.',
          dmMessage: 'Here is a copy of your conversation in {{guild.name}}. Download the files: open the .html one in your browser, or the .txt one in any text editor.',
        }),
        n('ke1', 'action.message.send', 1920, 800, { target: 'reply', ephemeral: true, content: 'The transcript could not be saved, so this ticket was **not** closed: {{error.message}}' }),
      ],
      edges: [
        e('t1', 'p1'), e('t2', 'k1'), e('k1', 'c1', 'ok'), e('k1', 'b1', 'blocked'), e('c1', 'r1'), e('r1', 's1'),
        e('s1', 'ts1', 'btn_close'), e('ts1', 'r2'), e('ts1', 'ke1', 'error'), e('r2', 'w1'), e('w1', 'd1'),
      ],
    }),
  },
  {
    id: 'role-panel',
    name: 'Button role panel',
    description: 'Press ▶ Run on the trigger to post a panel; each button toggles a different role on and off. Pick the roles in the Toggle Role nodes and set a channel on the trigger.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.manual', 0, 140),
        n('m1', 'action.message.send', 340, 100, {
          target: 'current_channel', useEmbed: true, embedTitle: 'Pick your roles', embedDescription: 'Press a button to get a role.',
          buttons: [
            { id: 'b1', label: 'Gamer', style: 'Primary', emoji: '🎮', url: '', disabled: false },
            { id: 'b2', label: 'Artist', style: 'Secondary', emoji: '🎨', url: '', disabled: false },
          ],
        }),
        n('g1', 'action.member.toggleRole', 760, 20, { reason: 'Role panel' }),
        n('g2', 'action.member.toggleRole', 760, 300, { reason: 'Role panel' }),
        n('a1', 'action.message.send', 1120, 20, { target: 'reply', ephemeral: true, content: 'The **{{role.name}}** role was {{toggle.action}} ✅' }),
        n('a2', 'action.message.send', 1120, 300, { target: 'reply', ephemeral: true, content: 'The **{{role.name}}** role was {{toggle.action}} ✅' }),
      ],
      edges: [e('t1', 'm1'), e('m1', 'g1', 'btn_b1'), e('m1', 'g2', 'btn_b2'), e('g1', 'a1'), e('g2', 'a2')],
    }),
  },
  {
    id: 'counter',
    name: 'Server counter',
    description: 'A tiny example of remembered variables: /count adds one and shows the total.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.command', 0, 60, { name: 'count', description: 'Add one to the server counter' }),
        n('v1', 'data.variable.set', 340, 40, { scope: 'guild', name: 'counter', operation: 'add', value: '1' }),
        n('m1', 'action.message.send', 700, 40, { target: 'reply', content: 'The counter is now **{{guild.vars.counter}}**.' }),
      ],
      edges: [e('t1', 'v1'), e('v1', 'm1')],
    }),
  },
  {
    id: 'member-counter',
    name: 'Member counter channel',
    description: 'Keeps a channel named “👥 Members: 1,234” up to date as people join and leave. Pick the channel in the last node. Needs the Server Members intent.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.member.join', 0, 0, { ignoreBots: false }), // the member count includes bots, so a bot joining changes it too
        n('t2', 'trigger.member.leave', 0, 140, { ignoreBots: false }),
        n('u1', 'action.channel.update', 340, 60, { name: '👥 Members: {{guild.memberCount | commas}}', reason: 'Member counter' }),
      ],
      edges: [e('t1', 'u1'), e('t2', 'u1')],
    }),
  },
  {
    id: 'join-counter',
    name: 'Join counter (with maths)',
    description: 'Counts joins in a server variable with the Math block and shows the total in a channel name. Pick the channel in the last node. Needs the Server Members intent.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.member.join', 0, 60),
        n('c1', 'data.math', 340, 40, { mode: 'two', a: '{{guild.vars.joins}}', op: 'add', b: '1', saveAs: 'joins', remember: 'guild' }),
        n('u1', 'action.channel.update', 700, 40, { name: 'Joined so far: {{var.joins | commas}}', reason: 'Join counter' }),
      ],
      edges: [e('t1', 'c1'), e('c1', 'u1')],
    }),
  },
  {
    id: 'youtube-upload',
    name: 'YouTube upload announcer',
    description: 'Posts a link in a channel whenever a YouTube channel uploads a video (Discord shows the video player). Paste the YouTube channel ID (starts with UC…) in the trigger and pick the channel in the last node. Videos that are already up are not announced.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.feed.item', 0, 60, { source: 'youtube', minutes: 15 }),
        n('m1', 'action.message.send', 340, 40, { target: 'channel', content: '📺 **{{feed.name}}** uploaded a new video!\n{{feed.link}}' }),
      ],
      edges: [e('t1', 'm1')],
    }),
  },
  {
    id: 'post-announcer',
    name: 'Post announcer (Reddit, Bluesky, Mastodon, blogs)',
    description: 'Posts an embed for each new post of a subreddit, a Bluesky account or any blog/feed. Choose where to look in the trigger (Mastodon: “Any feed address” with https://server/@name.rss) and pick the channel in the last node.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.feed.item', 0, 60, { source: 'reddit', minutes: 15 }),
        n('m1', 'action.message.send', 340, 40, {
          target: 'channel', useEmbed: true, embedTitle: '{{feed.title | default:New post}}', embedColor: '#5865f2', embedImage: '{{feed.image}}',
          embedDescription: '{{feed.summary}}\n\n[Open the post]({{feed.link}})', embedFooter: '{{feed.name}}', embedTimestamp: true,
        }),
      ],
      edges: [e('t1', 'm1')],
    }),
  },
  {
    id: 'twitch-live',
    name: 'Twitch live alert',
    description: 'Announces when a Twitch channel goes live, with the title and game. Type the channel name in the trigger and pick the channel in the last node. Needs the bot operator to have set up a Twitch application.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.twitch.live', 0, 60, { minutes: 2 }),
        n('m1', 'action.message.send', 340, 40, { target: 'channel', content: '🔴 **{{twitch.user}}** is live: **{{twitch.title}}**\nPlaying {{twitch.game | default:something fun}}\n{{twitch.url}}' }),
      ],
      edges: [e('t1', 'm1')],
    }),
  },
  {
    id: 'youtube-milestone',
    name: 'YouTube subscriber milestone',
    description: 'Celebrates each time a YouTube channel passes the next round number of subscribers (every 1,000 by default). YouTube rounds public counts, so keep the step large. Needs the bot operator to have a YouTube API key.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.youtube.subscribers', 0, 60, { step: 1000, minutes: 60 }),
        n('m1', 'action.message.send', 340, 40, {
          target: 'channel', useEmbed: true, embedTitle: '🎉 {{youtube.milestone | commas}} subscribers!', embedColor: '#ff0000',
          embedDescription: '**{{youtube.channelTitle}}** just passed **{{youtube.milestone | commas}}** subscribers. Thank you all!\n{{youtube.url}}',
        }),
      ],
      edges: [e('t1', 'm1')],
    }),
  },
  {
    id: 'webhook-alert',
    name: 'Webhook alert (Zapier, IFTTT, StreamElements…)',
    description: 'Posts whatever another tool sends: a new X / TikTok / Instagram / Facebook post, a Twitch follower, a sale. Save the flow, copy the secret address from the trigger into the tool, and have it send JSON like {"title":"…","message":"…","url":"…"}. Pick the channel in the last node.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.webhook', 0, 60),
        n('m1', 'action.message.send', 340, 40, {
          target: 'channel', useEmbed: true, embedTitle: '{{webhook.body.title | default:New alert}}', embedColor: '#f59e0b',
          embedDescription: '{{webhook.body.message}}\n{{webhook.body.url}}', embedTimestamp: true,
        }),
      ],
      edges: [e('t1', 'm1')],
    }),
  },
  {
    id: 'mod-log',
    name: 'Ban log',
    description: 'Posts an embed in a log channel whenever someone is banned.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.member.banned', 0, 60, { ignoreBots: false }),
        n('m1', 'action.message.send', 340, 40, {
          target: 'channel', useEmbed: true, embedTitle: '🔨 Member banned', embedColor: '#ed4245', embedTimestamp: true,
          embedDescription: '**{{user.name}}** (`{{user.id}}`) was banned by {{executor.mention | default:someone}}.\nReason: {{reason | default:none given}}',
        }),
      ],
      edges: [e('t1', 'm1')],
    }),
  },
];
