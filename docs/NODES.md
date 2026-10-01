# Node reference

> Generated from `shared/catalog.js` by `npm run docs` — do not edit by hand.

Text fields accept `{{variables}}` (see the README). Every action also has an **On error** output; connect it to handle
failures, and read `{{error.message}}` there. Fields left blank on channel/role/user pickers usually mean “the one that
triggered this flow”.

Every node can also have an optional **Title** (the box at the top of its settings). It is shown on the node in the editor, so people who edit the flow can
tell nodes apart; it is never sent to Discord.

## Triggers

### ⌨️ Slash Command

`trigger.command` — Runs when someone uses a /command. Add options to collect input.

| Field | Type | Notes |
| --- | --- | --- |
| Command name | text | required; Lowercase letters, numbers, - and _ (max 32). |
| Description | text | required |
| Options | list | up to 25 items |
| ↳ Name | text | required |
| ↳ Description | text | required |
| ↳ Type | select | options: Text, Whole number, Decimal number, True / False, User, Channel, Role, User or role |
| ↳ Required | boolean |  |
| Who can use it | select | options: Everyone, Administrators, Manage Server, Manage Roles, Manage Channels, Manage Messages, Kick Members, Ban Members, Timeout Members; Discord's default permission for the command. Server admins can still change it in Integrations. |
| Make the "thinking…" reply private | boolean | Used when a flow takes longer than ~2 s to answer. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🔘 Button Clicked

`trigger.button.clicked` — Runs when someone presses a button that has this Button ID — on any message, from any flow. Keeps working after restarts, so it is ideal for ticket and role panels.

| Field | Type | Notes |
| --- | --- | --- |
| Button ID | text | required; Give a button in a Send Message node the same “Button ID”. Letters, numbers, - _ and . (max 64). Use each ID in only one flow. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{button.id}}`, `{{button.label}}`

### 💬 Message Received

`trigger.message.received` — Runs when someone posts a message that matches your filter (e.g. a !prefix command).

> Needs the **Message Content** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Message | select | options: is anything, contains, starts with, is exactly, matches regex |
| Text | text | required; shown when `mode` is not `any` |
| Case sensitive | boolean | shown when `mode` is not `any` |
| Only in channel (optional) | channel |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{message.after}}`

### 🗑️ Message Deleted

`trigger.message.deleted` — Runs when a message is deleted. Text and author are only known if the bot had seen the message.

| Field | Type | Notes |
| --- | --- | --- |
| Only in channel (optional) | channel |  |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`

### 👋 Member Joined

`trigger.member.join` — Runs when someone joins the server.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`

### 🚪 Member Left

`trigger.member.leave` — Runs when someone leaves on their own (kicks and bans have their own triggers).

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`

### 🥾 Member Kicked

`trigger.member.kicked` — Runs when someone is kicked. Needs the bot to have “View Audit Log”, otherwise kicks look like leaves.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{executor.id}}`, `{{executor.name}}`, `{{executor.mention}}`, `{{reason}}`

### 🔨 Member Banned

`trigger.member.banned` — Runs when someone is banned.

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{executor.id}}`, `{{executor.name}}`, `{{executor.mention}}`, `{{reason}}`

### 🕊️ Member Unbanned

`trigger.member.unbanned` — Runs when a ban is lifted.

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{executor.id}}`, `{{executor.name}}`, `{{executor.mention}}`, `{{reason}}`

### ⏳ Member Timed Out

`trigger.member.timeout` — Runs when someone is put in timeout.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{timeout.until}}`, `{{timeout.minutes}}`, `{{executor.id}}`, `{{executor.name}}`, `{{executor.mention}}`, `{{reason}}`

### 🎖️ Role Given to Member

`trigger.member.roleAdded` — Runs when a member gains a role.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Only for role (optional) | role |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`

### 📤 Role Removed from Member

`trigger.member.roleRemoved` — Runs when a member loses a role.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Only for role (optional) | role |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`

### 🚀 Member Boosted Server

`trigger.user.boostserver` — Runs when a member starts boosting the server. Extra boosts from someone who already boosts do not count.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{boost.since}}`, `{{boost.days}}`

### 💔 Member Stopped Boosting

`trigger.user.unboostserver` — Runs when a member stops boosting the server altogether (all of their boosts ended).

> Needs the **Server Members** privileged intent (the bot operator must enable it).

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{boost.since}}`, `{{boost.days}}`

### 🎭 Role Created

`trigger.role.created` — Runs when a role is created.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`

### #️⃣ Channel Created

`trigger.channel.created` — Runs when a channel is created. Just moving a channel does not count as an update.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🎭 Role Deleted

`trigger.role.deleted` — Runs when a role is deleted.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`

### #️⃣ Channel Deleted

`trigger.channel.deleted` — Runs when a channel is deleted. Just moving a channel does not count as an update.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🎭 Role Updated

`trigger.role.updated` — Runs when a role is updated.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`, `{{oldRole.name}}`, `{{oldRole.color}}`

### #️⃣ Channel Updated

`trigger.channel.updated` — Runs when a channel is updated. Just moving a channel does not count as an update.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{oldChannel.name}}`, `{{oldChannel.topic}}`

### 😀 Reaction Added

`trigger.reaction.added` — Runs when someone adds an emoji reaction. Perfect for reaction roles.

| Field | Type | Notes |
| --- | --- | --- |
| Only on message (optional) | message | Right-click a message → Copy Message ID (Developer Mode). |
| Only for emoji (optional) | text |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{emoji.name}}`, `{{emoji.id}}`, `{{emoji.display}}`

### 😶 Reaction Removed

`trigger.reaction.removed` — Runs when someone removes an emoji reaction. Perfect for reaction roles.

| Field | Type | Notes |
| --- | --- | --- |
| Only on message (optional) | message | Right-click a message → Copy Message ID (Developer Mode). |
| Only for emoji (optional) | text |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{emoji.name}}`, `{{emoji.id}}`, `{{emoji.display}}`

### 🎙️ Voice Joined

`trigger.voice.joined` — Runs when someone joined a voice channel.

| Field | Type | Notes |
| --- | --- | --- |
| Only channel (optional) | channel |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🎙️ Voice Left

`trigger.voice.left` — Runs when someone left a voice channel.

| Field | Type | Notes |
| --- | --- | --- |
| Only channel (optional) | channel |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### ⏰ Schedule

`trigger.schedule` — Runs on a timer: every so many minutes, hours or days; at a set time of day (optionally only on some weekdays); or on a cron schedule. Set times and cron use the time zone you pick.

| Field | Type | Notes |
| --- | --- | --- |
| Run | select | options: Every … minutes, hours or days, At a set time of day, On a cron schedule |
| Every | number | required; shown when `mode` is not `time` / `cron`; range 1–… |
| Unit | select | shown when `mode` is not `time` / `cron`; options: minutes, hours, days |
| Time | text | shown when `mode` is `time`; On a 24-hour clock, for example 09:30 or 18:00. |
| Only on these days | multiselect | shown when `mode` is `time`; options: Mon, Tue, Wed, Thu, Fri, Sat, Sun; Leave them all off to run every day. |
| Cron expression | text | shown when `mode` is `cron`; Five fields: minute, hour, day of month, month, day of week. For example 0 9 * * 1-5 is 09:00 on weekdays, */15 * * * * is every 15 minutes, 0 0 1 * * is midnight on the 1st. Also @hourly, @daily, @weekly, @monthly. |
| Time zone | select | shown when `mode` is `time` / `cron`; options: a long list, chosen from the drop-down; The clock the time above is read on. Runs missed while the bot was off are not made up. |
| Channel for context (optional) | channel |  |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 📰 New Feed Item

`trigger.feed.item` — Runs when a feed gets a new post: a YouTube channel’s new video, a subreddit, a Bluesky or Mastodon account, a blog, GitHub releases. The bot looks every few minutes; posts that are already there when you switch the flow on are not announced.

| Field | Type | Notes |
| --- | --- | --- |
| Where | select | options: Any feed address, YouTube channel, Reddit subreddit, Bluesky account |
| Feed address | text | shown when `source` is `url`; A public https address of an RSS, Atom or JSON feed. Mastodon: https://server/@name.rss · GitHub releases: https://github.com/owner/repo/releases.atom · most blogs: /feed or /rss.xml |
| YouTube channel ID | text | shown when `source` is `youtube`; It starts with UC and has 24 characters. In YouTube: your channel → About → Share → Copy channel ID. (A link with /channel/UC… in it works too.) |
| Subreddit | text | shown when `source` is `reddit`; The name, without r/. |
| Bluesky handle | text | shown when `source` is `bluesky` |
| Check every (minutes) | number | required; range 5–…; At least 5. The bot operator may set a longer minimum. |
| Channel for context (optional) | channel |  |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{feed.title}}`, `{{feed.link}}`, `{{feed.author}}`, `{{feed.summary}}`, `{{feed.published}}`, `{{feed.image}}`, `{{feed.id}}`, `{{feed.name}}`

### 🔔 Webhook Received

`trigger.webhook` — Runs when something calls this trigger’s secret web address. Tools like Zapier, IFTTT, Make, StreamElements or GitHub can call it — that is how to react to a new X, TikTok, Instagram or Facebook post, or a Twitch follower. Save the flow to get the address.

| Field | Type | Notes |
| --- | --- | --- |
| Channel for context (optional) | channel |  |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{webhook.text}}`, `{{webhook.body.name}}`, `{{webhook.query.name}}`, `{{webhook.method}}`, `{{webhook.contentType}}`

### ▶️ YouTube Subscribers

`trigger.youtube.subscribers` — Runs each time a YouTube channel’s subscriber count passes the next round number (every 100, every 1,000 …). YouTube rounds public counts to three significant figures and a channel can hide its count, so pick a step much bigger than the rounding. Needs the bot operator’s YouTube API key.

> Needs a YouTube API key (YOUTUBE_API_KEY) — the bot operator must set it up (see `.env.example`).

| Field | Type | Notes |
| --- | --- | --- |
| YouTube channel ID | text | required; It starts with UC and has 24 characters. In YouTube: your channel → About → Share → Copy channel ID. (A link with /channel/UC… in it works too.) |
| Announce every … subscribers | number | required; range 1–…; A milestone is announced once, the first time the count reaches it. When you switch the flow on, the current count is only noted. |
| Check every (minutes) | number | required; range 15–…; At least 15: YouTube gives the bot a daily allowance that every server shares. |
| Channel for context (optional) | channel |  |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{youtube.subscribers}}`, `{{youtube.milestone}}`, `{{youtube.previous}}`, `{{youtube.channelTitle}}`, `{{youtube.channelId}}`, `{{youtube.url}}`

### 🟣 Twitch Channel Live

`trigger.twitch.live` — Runs when a Twitch channel starts a new broadcast. A broadcast that is already running when you switch the flow on is not announced. (Followers cannot be watched from outside — use the Webhook trigger with StreamElements, Streamlabs or Zapier.) Needs the bot operator’s Twitch application.

> Needs a Twitch application (TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET) — the bot operator must set it up (see `.env.example`).

| Field | Type | Notes |
| --- | --- | --- |
| Twitch channel | text | required; The channel name, or a twitch.tv link. |
| Check every (minutes) | number | required; range 1–… |
| Channel for context (optional) | channel |  |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{twitch.user}}`, `{{twitch.login}}`, `{{twitch.title}}`, `{{twitch.game}}`, `{{twitch.viewers}}`, `{{twitch.url}}`, `{{twitch.thumbnail}}`, `{{twitch.started}}`, `{{twitch.id}}`

### ▶️ Manual (Run button)

`trigger.manual` — Runs when you press ▶ Run in the editor. Great for posting a button panel once.

| Field | Type | Notes |
| --- | --- | --- |
| Channel for context (optional) | channel | Becomes the “current channel” for the flow. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🧾 Form Submitted

`trigger.form.submitted` — Runs when someone submits one of your web page forms (build them in the Pages tab). Each answer is {{form.<question id>}}.

| Field | Type | Notes |
| --- | --- | --- |
| Form | form | required; Only forms on pages of this server are listed. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{member.boostingSince}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.icon}}`, `{{guild.memberCount}}`, `{{guild.boostCount}}`, `{{guild.boostTier}}`, `{{form.title}}`, `{{form.summary}}`, `{{response.id}}`, `{{page.title}}`, `{{page.url}}`

## Messages

### 💬 Send Message

`action.message.send` — Send text, embeds (up to 10, with author, links and icons), buttons and a select menu. Every button becomes its own output.

| Field | Type | Notes |
| --- | --- | --- |
| Send to | select | options: Reply to whatever triggered this, Edit the message the button is on, Post in the same channel, Post in a specific channel, Direct message a member |
| Channel | channel | required; shown when `target` is `channel` |
| Member | user | shown when `target` is `dm` |
| Only visible to the user (ephemeral) | boolean | shown when `target` is `reply`; Works when replying to a command or button. |
| Message text | textarea |  |
| Embeds | list | up to 10 items; Up to 10 embeds per message, and 6000 characters in all. |
| ↳ Title | text |  |
| ↳ Title link | text | Makes the title a link. Needs a title. |
| ↳ Description | textarea |  |
| ↳ Color | color |  |
| ↳ Author name | text | A small line above the title. Needed for the author icon and link to show. |
| ↳ Author icon | image | An https link, {{a variable}}, or a picture you uploaded. |
| ↳ Author link | text |  |
| ↳ Thumbnail | image | An https link, {{a variable}}, or a picture you uploaded. |
| ↳ Image | image | An https link, {{a variable}}, or a picture you uploaded. |
| ↳ Footer text | text |  |
| ↳ Footer icon | image | An https link, {{a variable}}, or a picture you uploaded. Needs footer text. |
| ↳ Show timestamp | boolean |  |
| ↳ Fields | list | up to 25 items |
| ↳ ↳ Name | text |  |
| ↳ ↳ Value | text |  |
| ↳ ↳ Inline | boolean |  |
| Buttons | list | up to 25 items |
| ↳ Label | text | required |
| ↳ Style | select | options: Blurple, Grey, Green, Red, Link (opens a URL) |
| ↳ URL | text | required; shown when `style` is `Link` |
| ↳ Emoji (optional) | text |  |
| ↳ Disabled | boolean |  |
| ↳ Button ID (optional) | text | shown when `style` is not `Link`; Makes this a reusable button: it is handled by a “Button Clicked” trigger with the same ID instead of its own output here, and keeps working on every copy of the message. Adding an ID removes this button's output connection. |
| Add a select menu | boolean |  |
| Menu placeholder | text | shown when `menuEnabled` is `true` |
| Menu options | list | shown when `menuEnabled` is `true`; up to 25 items |
| ↳ Label | text | required |
| ↳ Description | text |  |
| ↳ Emoji (optional) | text |  |
| Only the person who triggered this can use the buttons | boolean |  |
| Allow role, @everyone and @here pings | boolean | Off by default so member-supplied text can never mass-ping. Individual users can always be mentioned. |
| Save message ID as variable | text |  |

**Outputs:** Next, On error — plus one per button and menu option (a button with a Button ID has no output: a “Button Clicked” trigger handles it instead)

### 📝 Edit Message

`action.message.edit` — Change a message the bot already sent. For the text and for the embeds you can keep them, replace them or remove them — and for the embeds you can also change just some parts of one embed and leave the rest as it is. Choose “This message” (the one that started the flow, such as the message a pressed button is on) or “A previous message” and give its ID. Only the bot's own messages can be edited, not “only visible to you” replies.

| Field | Type | Notes |
| --- | --- | --- |
| Which message | select | options: This message (the one that started the flow), A previous message (by its ID) |
| Channel | channel | shown when `messageFrom` is `id` |
| Message ID | message | required; shown when `messageFrom` is `id`; The ID of a message sent earlier. Use a variable that holds it — for example the one you gave “Save message ID as variable” in Send Message, or one stored with Set Variable. |
| Message text | select | options: Keep as it is, Replace with…, Remove the text |
| New text | textarea | shown when `contentMode` is `replace` |
| Embeds | select | options: Keep as they are, Change some parts of one embed, Replace all embeds, Remove all embeds |
| Which embed (1 = the first) | number | shown when `embedsMode` is `patch`; range 1–10; One past the last embed adds a new one. |
| Set these parts | list | shown when `embedsMode` is `patch`; Only the parts you list here change. “Timestamp” sets the time to now. |
| ↳ Part | select | options: Title, Title link, Description, Color, Author name, Author icon, Author link, Thumbnail, Image, Footer text, Footer icon, Timestamp, Fields |
| ↳ New value | textarea | shown when `part` is `title` / `url` / `description` / `authorName` / `authorUrl` / `footer` |
| ↳ New color | color | shown when `part` is `color` |
| ↳ New picture | image | shown when `part` is `authorIcon` / `thumbnail` / `image` / `footerIcon`; An https link, {{a variable}}, or a picture you uploaded. |
| ↳ Fields | list | shown when `part` is `fields`; up to 25 items; These replace all the fields the embed has now. |
| ↳ ↳ Name | text |  |
| ↳ ↳ Value | text |  |
| ↳ ↳ Inline | boolean |  |
| Remove these parts | multiselect | shown when `embedsMode` is `patch`; options: Title, Title link, Description, Color, Author name, Author icon, Author link, Thumbnail, Image, Footer text, Footer icon, Timestamp, Fields; Taken off first, then the parts above are set. “Author name” removes the whole author and “Footer text” the whole footer. |
| Embeds | list | shown when `embedsMode` is `replace`; up to 10 items; Up to 10 embeds per message, and 6000 characters in all. |
| ↳ Title | text |  |
| ↳ Title link | text | Makes the title a link. Needs a title. |
| ↳ Description | textarea |  |
| ↳ Color | color |  |
| ↳ Author name | text | A small line above the title. Needed for the author icon and link to show. |
| ↳ Author icon | image | An https link, {{a variable}}, or a picture you uploaded. |
| ↳ Author link | text |  |
| ↳ Thumbnail | image | An https link, {{a variable}}, or a picture you uploaded. |
| ↳ Image | image | An https link, {{a variable}}, or a picture you uploaded. |
| ↳ Footer text | text |  |
| ↳ Footer icon | image | An https link, {{a variable}}, or a picture you uploaded. Needs footer text. |
| ↳ Show timestamp | boolean |  |
| ↳ Fields | list | up to 25 items |
| ↳ ↳ Name | text |  |
| ↳ ↳ Value | text |  |
| ↳ ↳ Inline | boolean |  |

**Outputs:** Next, On error

### 🔘 Change Buttons

`action.message.buttons` — Add, remove, disable or enable the buttons of a message the bot already sent, without touching its text — or delete the message. Choose “This message” (the one that started the flow, such as the message a pressed button is on) or “A previous message” and give its ID. Buttons can only be changed on the bot's own messages, and neither works on “only visible to you” replies.

| Field | Type | Notes |
| --- | --- | --- |
| Which message | select | options: This message (the one that started the flow), A previous message (by its ID) |
| Channel | channel | shown when `messageFrom` is `id` |
| Message ID | message | required; shown when `messageFrom` is `id`; The ID of a message sent earlier. Use a variable that holds it — for example the one you gave “Save message ID as variable” in Send Message, or one stored with Set Variable. |
| What to do | select | options: Add or update buttons, Remove specific buttons, Remove all buttons, Disable buttons, Enable buttons, Delete the message |
| Buttons | list | shown when `mode` is `add`; up to 25 items |
| ↳ Label | text | required |
| ↳ Style | select | options: Blurple, Grey, Green, Red, Link (opens a URL) |
| ↳ URL | text | required; shown when `style` is `Link` |
| ↳ Emoji (optional) | text |  |
| ↳ Disabled | boolean |  |
| ↳ Button ID (optional) | text | shown when `style` is not `Link`; Makes this a reusable button: it is handled by a “Button Clicked” trigger with the same ID instead of its own output here, and keeps working on every copy of the message. Adding an ID removes this button's output connection. |
| Which buttons | list | shown when `mode` is `remove` / `disable` / `enable`; A button matches by its Button ID, or by its label (capital letters do not matter). To disable or enable every button, leave this empty. |
| ↳ Button ID or label | text | required |
| Only the person who triggered this can use the added buttons | boolean | shown when `mode` is `add` |

**Outputs:** Next, On error — plus one per added button when adding (a button with a Button ID has no output: a “Button Clicked” trigger handles it instead)

### 🗑️ Delete Message

`action.message.delete` — Delete a message. Leave the ID blank to delete the message that triggered the flow.

| Field | Type | Notes |
| --- | --- | --- |
| Channel | channel |  |
| Message ID | message |  |

**Outputs:** Next, On error

### 👍 Add Reaction

`action.message.react` — React to a message with an emoji.

| Field | Type | Notes |
| --- | --- | --- |
| Channel | channel |  |
| Message ID | message |  |
| Emoji | text | required |

**Outputs:** Next, On error

### 🧾 Show Form (Modal)

`action.modal.show` — Pop up a form. Must be the first thing the flow does with a command or button. Answers are {{input.<id>}}.

| Field | Type | Notes |
| --- | --- | --- |
| Form title | text | required |
| Inputs | list | up to 5 items |
| ↳ ID (used as {{input.ID}}) | text | required |
| ↳ Label | text | required |
| ↳ Size | select | options: One line, Paragraph |
| ↳ Placeholder | text |  |
| ↳ Max length | number | range 1–4000 |
| ↳ Required | boolean |  |

**Outputs:** Submitted, On error

## Members

### 🎖️ Give Role

`action.member.addRole` — Give a member a role.

| Field | Type | Notes |
| --- | --- | --- |
| Member | user |  |
| Role | role | required |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

### 📤 Remove Role

`action.member.removeRole` — Take a role away from a member.

| Field | Type | Notes |
| --- | --- | --- |
| Member | user |  |
| Role | role | required |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

### 🔁 Toggle Role

`action.member.toggleRole` — Give the role if the member does not have it, take it away if they do. Perfect for role panels: one button per role. Use {{toggle.action}} (added / removed) in your reply.

| Field | Type | Notes |
| --- | --- | --- |
| Member | user |  |
| Role | role | required |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

**Adds variables:** `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`, `{{toggle.action}}`

### 🥾 Kick Member

`action.member.kick` — Kick a member from the server.

| Field | Type | Notes |
| --- | --- | --- |
| Member | user |  |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

### 🔨 Ban Member

`action.member.ban` — Ban a member from the server.

| Field | Type | Notes |
| --- | --- | --- |
| Member | user |  |
| Reason (audit log) | text |  |
| Delete their messages from the last … days | number | range 0–7 |

**Outputs:** Next, On error

### 🕊️ Unban User

`action.member.unban` — Lift a ban.

| Field | Type | Notes |
| --- | --- | --- |
| User ID | user | required |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

### ⏳ Timeout Member

`action.member.timeout` — Mute a member for a while. 0 minutes removes a timeout.

| Field | Type | Notes |
| --- | --- | --- |
| Member | user |  |
| Minutes | number | required; range 0–40320 |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

### 🏷️ Set Nickname

`action.member.nickname` — Change a member's nickname. Leave blank to reset it.

| Field | Type | Notes |
| --- | --- | --- |
| Member | user |  |
| Nickname | text |  |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

## Channels

### ➕ Create Channel

`action.channel.create` — Create a channel. Save its ID to use it later in the flow.

| Field | Type | Notes |
| --- | --- | --- |
| Name | text | required |
| Type | select | options: Text, Voice, Category, Announcement, Stage, Forum |
| Category | category | shown when `type` is not `category` |
| Topic | text | shown when `type` is `text` / `announcement` / `forum` |
| Age-restricted | boolean | shown when `type` is `text` / `announcement` / `forum` / `voice` |
| Slowmode (seconds) | number | shown when `type` is `text` / `forum`; range 0–21600 |
| User limit | number | shown when `type` is `voice` / `stage`; range 0–99 |
| Hide from @everyone | boolean | Then add overrides below to let specific people in. |
| Permission overrides | list |  |
| ↳ Applies to | select | options: A role, A member |
| ↳ Role / member ID | text | required |
| ↳ Allow | multiselect | options: ViewChannel, SendMessages, SendMessagesInThreads, ReadMessageHistory, AddReactions, AttachFiles, EmbedLinks, UseExternalEmojis, MentionEveryone, ManageMessages, ManageChannels, ManageRoles, ManageThreads, CreatePublicThreads, CreatePrivateThreads, UseApplicationCommands, CreateInstantInvite, Connect, Speak, Stream, UseVAD, MuteMembers, DeafenMembers, MoveMembers |
| ↳ Deny | multiselect | options: ViewChannel, SendMessages, SendMessagesInThreads, ReadMessageHistory, AddReactions, AttachFiles, EmbedLinks, UseExternalEmojis, MentionEveryone, ManageMessages, ManageChannels, ManageRoles, ManageThreads, CreatePublicThreads, CreatePrivateThreads, UseApplicationCommands, CreateInstantInvite, Connect, Speak, Stream, UseVAD, MuteMembers, DeafenMembers, MoveMembers |
| Save channel ID as variable | text |  |

**Outputs:** Next, On error

### 🗑️ Delete Channel

`action.channel.delete` — Delete a channel. Blank = the channel where this happened.

| Field | Type | Notes |
| --- | --- | --- |
| Channel | channel |  |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

### 🛠️ Update Channel

`action.channel.update` — Rename or reconfigure a channel. Blank fields stay unchanged. Discord allows only two name/topic changes per channel every 10 minutes: extra ones are held and only the newest is applied when Discord allows.

| Field | Type | Notes |
| --- | --- | --- |
| Channel | channel |  |
| New name | text |  |
| New topic | text |  |
| Move to category | category |  |
| Slowmode (seconds) | number | range 0–21600 |
| Age-restricted | select | options: Unchanged, Yes, No |
| Permission overrides | list |  |
| ↳ Applies to | select | options: A role, A member |
| ↳ Role / member ID | text | required |
| ↳ Allow | multiselect | options: ViewChannel, SendMessages, SendMessagesInThreads, ReadMessageHistory, AddReactions, AttachFiles, EmbedLinks, UseExternalEmojis, MentionEveryone, ManageMessages, ManageChannels, ManageRoles, ManageThreads, CreatePublicThreads, CreatePrivateThreads, UseApplicationCommands, CreateInstantInvite, Connect, Speak, Stream, UseVAD, MuteMembers, DeafenMembers, MoveMembers |
| ↳ Deny | multiselect | options: ViewChannel, SendMessages, SendMessagesInThreads, ReadMessageHistory, AddReactions, AttachFiles, EmbedLinks, UseExternalEmojis, MentionEveryone, ManageMessages, ManageChannels, ManageRoles, ManageThreads, CreatePublicThreads, CreatePrivateThreads, UseApplicationCommands, CreateInstantInvite, Connect, Speak, Stream, UseVAD, MuteMembers, DeafenMembers, MoveMembers |

**Outputs:** Next, On error

### 📄 Save Transcript

`action.channel.transcript` — Record everything said in a channel (for example a ticket that is being closed), post it in a log channel and optionally send it to someone by direct message — as a link to a web page the bot's server keeps, as an .html file (plus a plain .txt copy), or both. If it cannot be saved, follow On error and keep the channel.

> Works best with the **Message Content** privileged intent — without the Message Content intent Discord hides other people's message text, so the transcript can only show who wrote when (plus the bot's own messages). Ask the bot operator to enable it.

| Field | Type | Notes |
| --- | --- | --- |
| Channel to record | channel |  |
| Post the transcript in | channel | required; For example your staff log. The bot needs Send Messages (and Attach Files, if the files are sent) there. Do not use the channel being recorded. |
| How to send the transcript | select | options: A link to a web page (kept on the bot's server), Files attached to the message (.html and .txt), Both: the link and the files; A link opens the transcript as a web page for anyone who has it, until the server deletes it (TRANSCRIPT_RETENTION_DAYS in the .env file; by default it is kept forever). It is sent as an “Open transcript” button and needs a public BASE_URL. “Both” sends just the files when the server has no public address. |
| Message with the transcript (log channel) | textarea |  |
| Also send it to (direct message) | user | Optional. If their DMs are closed, or they can no longer see the channel, the DM is skipped and the flow carries on. |
| Message with the transcript (direct message) | textarea | shown when `sendUserId` is not `` |
| Leave out the plain-text (.txt) copy | boolean | shown when `delivery` is not `link`; By default a .txt file with the same messages is attached next to the .html one, in the log channel and in the direct message. It is easy to search, copy and read on a phone. |

**Outputs:** Next, On error

**Adds variables:** `{{transcript.messages}}`, `{{transcript.name}}`, `{{transcript.textName}}`, `{{transcript.bytes}}`, `{{transcript.truncated}}`, `{{transcript.dm}}`, `{{transcript.url}}`, `{{transcript.expires}}`

## Roles

### ➕ Create Role

`action.role.create` — Create a new role.

| Field | Type | Notes |
| --- | --- | --- |
| Name | text | required |
| Color | color |  |
| Show separately in the member list | boolean |  |
| Anyone can @mention it | boolean |  |
| Permissions | multiselect | options: Administrator, ManageGuild, ManageRoles, ManageChannels, KickMembers, BanMembers, ModerateMembers, ViewAuditLog, ManageMessages, ManageNicknames, ChangeNickname, MentionEveryone, ManageWebhooks, CreateInstantInvite, ViewChannel, SendMessages, ReadMessageHistory, AddReactions, AttachFiles, EmbedLinks, UseExternalEmojis, Connect, Speak, Stream, UseVAD, MuteMembers, DeafenMembers, MoveMembers, UseApplicationCommands |
| Save role ID as variable | text |  |

**Outputs:** Next, On error

### 🗑️ Delete Role

`action.role.delete` — Delete a role.

| Field | Type | Notes |
| --- | --- | --- |
| Role | role | required |
| Reason (audit log) | text |  |

**Outputs:** Next, On error

### 🛠️ Update Role

`action.role.update` — Rename or recolor a role. Blank fields stay unchanged.

| Field | Type | Notes |
| --- | --- | --- |
| Role | role | required |
| New name | text |  |
| New color | text |  |
| Show separately | select | options: Unchanged, Yes, No |
| Mentionable | select | options: Unchanged, Yes, No |

**Outputs:** Next, On error

## Variables

### 📦 Set Variable

`data.variable.set` — Store or change a value. Server, channel and user variables are remembered between runs.

| Field | Type | Notes |
| --- | --- | --- |
| Where to store it | select | options: This run only (temporary), Server (remembered), Channel (remembered), Per user (remembered) |
| User | user | shown when `scope` is `user` |
| Channel | channel | shown when `scope` is `channel` |
| Variable name | text | required |
| Operation | select | options: Set to, Add, Subtract, Multiply by, Divide by, Append to list, Calculate expression, Random whole number, Delete |
| Value | text | shown when `operation` is not `random` / `delete` |
| Treat value as | select | shown when `operation` is `set`; options: Text, Number, True / False, JSON |
| Minimum | number | shown when `operation` is `random` |
| Maximum | number | shown when `operation` is `random` |

**Outputs:** Next, On error

### 🔎 Get Variable

`data.variable.get` — Read a remembered variable into this run as {{var.<name>}}.

| Field | Type | Notes |
| --- | --- | --- |
| Read from | select | options: Server, Channel, Per user |
| User | user | shown when `scope` is `user` |
| Channel | channel | shown when `scope` is `channel` |
| Variable name | text | required |
| Save as | text | required |
| If missing use | text |  |

**Outputs:** Next, On error

### 🧮 Math

`data.math` — Calculate a number from any values — variables, the member count, an option… — and use it in the next nodes as {{var.<name>}}. Tick “Also remember it” to keep it as a server, channel or per-user variable. To just change a remembered number, Set Variable is quicker.

| Field | Type | Notes |
| --- | --- | --- |
| How | select | options: Two values, Formula |
| First value | text | required; shown when `mode` is `two` |
| Operation | select | shown when `mode` is `two`; options: +  Add, −  Subtract, ×  Multiply, ÷  Divide, Remainder after dividing, To the power of, The smaller of the two, The larger of the two |
| Second value | text | required; shown when `mode` is `two` |
| Formula | text | required; shown when `mode` is `formula`; Use + - * / % ^, brackets and round(), floor(), ceil(), abs(), sqrt(), min(), max(). An empty variable breaks a formula: write {{var.x \| default:0}}. |
| Round the result | select | options: Do not round, To a whole number, To 1 decimal, To 2 decimals |
| Save result as | text | required; Use it in the next nodes as {{var.total}}. |
| Also remember it | select | options: No — only for this run, Yes, as a server variable, Yes, as a channel variable, Yes, as a per-user variable; Remembered under the same name. |
| User | user | shown when `remember` is `user` |
| Channel | channel | shown when `remember` is `channel` |

**Outputs:** Next, On error

## Logic

### 🔀 Condition (If)

`logic.condition` — Follow the True or False output depending on your checks — compare values, or check whether someone has a role.

| Field | Type | Notes |
| --- | --- | --- |
| Continue on True when | select | options: ALL checks pass, ANY check passes |
| Checks | list |  |
| ↳ Value | text | required; shown when `op` is not `hasRole` / `lacksRole` |
| ↳ Check | select | options: equals, does not equal, contains, does not contain, starts with, ends with, is greater than, is at least, is less than, is at most, matches regex, is empty, is not empty, has the role, does not have the role |
| ↳ Compare to | text | shown when `op` is not `isEmpty` / `isNotEmpty` / `hasRole` / `lacksRole` |
| ↳ Role | role | required; shown when `op` is `hasRole` / `lacksRole`; Pick a role, or use a variable such as {{option.role}}. If the role no longer exists, the check counts as “no”. |
| ↳ Member | user | shown when `op` is `hasRole` / `lacksRole`; Optional: check someone else, for example {{option.member}}. Someone who is not in the server does not have the role. |

**Outputs:** True, False

### 🎲 Random Chance

`logic.random` — Follow True with the given probability, otherwise False.

| Field | Type | Notes |
| --- | --- | --- |
| Chance of True (%) | number | required; range 0–100 |

**Outputs:** True, False

### 🔁 Loop

`logic.loop` — Run the “Each” branch several times, then continue with “Done”. Uses {{loop.index}} and {{loop.item}}.

| Field | Type | Notes |
| --- | --- | --- |
| Loop | select | options: A number of times, Over a list |
| Times | number | shown when `mode` is `repeat`; range 1–… |
| List | textarea | shown when `mode` is `list` |

**Outputs:** Each, Done

**Adds variables:** `{{loop.index}}`, `{{loop.item}}`, `{{loop.count}}`

### 🧊 Cooldown

`logic.cooldown` — Let a flow run only once per time window. Blocked runs follow the Blocked output.

| Field | Type | Notes |
| --- | --- | --- |
| Seconds | number | required; range 1–… |
| Per | select | options: User, Channel, Server |
| Shared name (optional) | text | Nodes with the same name share one cooldown. |

**Outputs:** Allowed, Blocked

**Adds variables:** `{{cooldown.remaining}}`

### ⌛ Wait

`logic.wait` — Pause the flow for a while. Switching the flow off stops it.

| Field | Type | Notes |
| --- | --- | --- |
| Seconds | number | required; range 0–… |

**Outputs:** Next

### 📋 Log

`logic.log` — Write a line to the Logs panel — handy for debugging.

| Field | Type | Notes |
| --- | --- | --- |
| Level | select | options: Info, Warning |
| Message | textarea | required |

**Outputs:** Next

