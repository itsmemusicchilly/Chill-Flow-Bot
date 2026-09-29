# Node reference

> Generated from `shared/catalog.js` by `npm run docs` — do not edit by hand.

Text fields accept `{{variables}}` (see the README). Every action also has an **On error** output; connect it to handle
failures, and read `{{error.message}}` there. Fields left blank on channel/role/user pickers usually mean “the one that
triggered this flow”.

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

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

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

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{message.after}}`

### 🗑️ Message Deleted

`trigger.message.deleted` — Runs when a message is deleted. Text and author are only known if the bot had seen the message.

| Field | Type | Notes |
| --- | --- | --- |
| Only in channel (optional) | channel |  |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`

### 👋 Member Joined

`trigger.member.join` — Runs when someone joins the server.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`

### 🚪 Member Left

`trigger.member.leave` — Runs when someone leaves on their own (kicks and bans have their own triggers).

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`

### 🥾 Member Kicked

`trigger.member.kicked` — Runs when someone is kicked. Needs the bot to have “View Audit Log”, otherwise kicks look like leaves.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{executor.id}}`, `{{executor.name}}`, `{{executor.mention}}`, `{{reason}}`

### 🔨 Member Banned

`trigger.member.banned` — Runs when someone is banned.

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{executor.id}}`, `{{executor.name}}`, `{{executor.mention}}`, `{{reason}}`

### 🕊️ Member Unbanned

`trigger.member.unbanned` — Runs when a ban is lifted.

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{executor.id}}`, `{{executor.name}}`, `{{executor.mention}}`, `{{reason}}`

### ⏳ Member Timed Out

`trigger.member.timeout` — Runs when someone is put in timeout.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{timeout.until}}`, `{{timeout.minutes}}`, `{{executor.id}}`, `{{executor.name}}`, `{{executor.mention}}`, `{{reason}}`

### 🎖️ Role Given to Member

`trigger.member.roleAdded` — Runs when a member gains a role.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Only for role (optional) | role |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`

### 📤 Role Removed from Member

`trigger.member.roleRemoved` — Runs when a member loses a role.

> Needs the **Server Members** privileged intent (the bot operator must enable it).

| Field | Type | Notes |
| --- | --- | --- |
| Ignore bots | boolean |  |
| Only for role (optional) | role |  |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`

### 🎭 Role Created

`trigger.role.created` — Runs when a role is created.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`

### #️⃣ Channel Created

`trigger.channel.created` — Runs when a channel is created. Just moving a channel does not count as an update.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🎭 Role Deleted

`trigger.role.deleted` — Runs when a role is deleted.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`

### #️⃣ Channel Deleted

`trigger.channel.deleted` — Runs when a channel is deleted. Just moving a channel does not count as an update.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🎭 Role Updated

`trigger.role.updated` — Runs when a role is updated.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{role.id}}`, `{{role.name}}`, `{{role.mention}}`, `{{role.color}}`, `{{oldRole.name}}`, `{{oldRole.color}}`

### #️⃣ Channel Updated

`trigger.channel.updated` — Runs when a channel is updated. Just moving a channel does not count as an update.

| Field | Type | Notes |
| --- | --- | --- |
| Also run for changes made by this bot | boolean | Off by default so a flow cannot trigger itself in a loop. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{oldChannel.name}}`, `{{oldChannel.topic}}`

### 😀 Reaction Added

`trigger.reaction.added` — Runs when someone adds an emoji reaction. Perfect for reaction roles.

| Field | Type | Notes |
| --- | --- | --- |
| Only on message (optional) | message | Right-click a message → Copy Message ID (Developer Mode). |
| Only for emoji (optional) | text |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{emoji.name}}`, `{{emoji.id}}`, `{{emoji.display}}`

### 😶 Reaction Removed

`trigger.reaction.removed` — Runs when someone removes an emoji reaction. Perfect for reaction roles.

| Field | Type | Notes |
| --- | --- | --- |
| Only on message (optional) | message | Right-click a message → Copy Message ID (Developer Mode). |
| Only for emoji (optional) | text |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`, `{{message.id}}`, `{{message.content}}`, `{{message.url}}`, `{{message.authorId}}`, `{{emoji.name}}`, `{{emoji.id}}`, `{{emoji.display}}`

### 🎙️ Voice Joined

`trigger.voice.joined` — Runs when someone joined a voice channel.

| Field | Type | Notes |
| --- | --- | --- |
| Only channel (optional) | channel |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🎙️ Voice Left

`trigger.voice.left` — Runs when someone left a voice channel.

| Field | Type | Notes |
| --- | --- | --- |
| Only channel (optional) | channel |  |
| Ignore bots | boolean |  |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### ⏰ Schedule

`trigger.schedule` — Runs repeatedly on a timer (at least every minute).

| Field | Type | Notes |
| --- | --- | --- |
| Every | number | required; range 1–… |
| Unit | select | options: minutes, hours, days |
| Channel for context (optional) | channel |  |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### ▶️ Manual (Run button)

`trigger.manual` — Runs when you press ▶ Run in the editor. Great for posting a button panel once.

| Field | Type | Notes |
| --- | --- | --- |
| Channel for context (optional) | channel | Becomes the “current channel” for the flow. |

**Adds variables:** `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{channel.id}}`, `{{channel.name}}`, `{{channel.mention}}`, `{{channel.type}}`, `{{channel.parentId}}`

### 🧾 Form Submitted

`trigger.form.submitted` — Runs when someone submits one of your web page forms (build them in the Pages tab). Each answer is {{form.<question id>}}.

| Field | Type | Notes |
| --- | --- | --- |
| Form | form | required; Only forms on pages of this server are listed. |

**Adds variables:** `{{user.id}}`, `{{user.name}}`, `{{user.displayName}}`, `{{user.mention}}`, `{{user.tag}}`, `{{user.avatar}}`, `{{user.isBot}}`, `{{member.nickname}}`, `{{member.joinedAt}}`, `{{member.roleIds}}`, `{{member.permissions}}`, `{{guild.id}}`, `{{guild.name}}`, `{{guild.memberCount}}`, `{{form.title}}`, `{{form.summary}}`, `{{response.id}}`, `{{page.title}}`, `{{page.url}}`

## Messages

### 💬 Send Message

`action.message.send` — Send text, an embed, buttons and a select menu. Every button becomes its own output.

| Field | Type | Notes |
| --- | --- | --- |
| Send to | select | options: Reply to whatever triggered this, Edit the message the button is on, Post in the same channel, Post in a specific channel, Direct message a member |
| Channel | channel | required; shown when `target` is `channel` |
| Member | user | shown when `target` is `dm` |
| Only visible to the user (ephemeral) | boolean | shown when `target` is `reply`; Works when replying to a command or button. |
| Message text | textarea |  |
| Add an embed | boolean |  |
| Embed title | text | shown when `useEmbed` is `true` |
| Embed description | textarea | shown when `useEmbed` is `true` |
| Embed color | color | shown when `useEmbed` is `true` |
| Thumbnail URL | text | shown when `useEmbed` is `true` |
| Image URL | text | shown when `useEmbed` is `true` |
| Footer | text | shown when `useEmbed` is `true` |
| Show timestamp | boolean | shown when `useEmbed` is `true` |
| Embed fields | list | shown when `useEmbed` is `true`; up to 25 items |
| ↳ Name | text |  |
| ↳ Value | text |  |
| ↳ Inline | boolean |  |
| Buttons | list | up to 25 items |
| ↳ Label | text | required |
| ↳ Style | select | options: Blurple, Grey, Green, Red, Link (opens a URL) |
| ↳ URL | text | required; shown when `style` is `Link` |
| ↳ Emoji (optional) | text |  |
| ↳ Disabled | boolean |  |
| Add a select menu | boolean |  |
| Menu placeholder | text | shown when `menuEnabled` is `true` |
| Menu options | list | shown when `menuEnabled` is `true`; up to 25 items |
| ↳ Label | text | required |
| ↳ Description | text |  |
| ↳ Emoji (optional) | text |  |
| Only the person who triggered this can use the buttons | boolean |  |
| Allow role, @everyone and @here pings | boolean | Off by default so member-supplied text can never mass-ping. Individual users can always be mentioned. |
| Save message ID as variable | text |  |

**Outputs:** Next, On error — plus one per button and menu option

### 📝 Edit Message

`action.message.edit` — Change the text or embed of a message the bot sent.

| Field | Type | Notes |
| --- | --- | --- |
| Channel | channel |  |
| Message ID | message | required |
| New text | textarea |  |
| Add an embed | boolean |  |
| Embed title | text | shown when `useEmbed` is `true` |
| Embed description | textarea | shown when `useEmbed` is `true` |
| Embed color | color | shown when `useEmbed` is `true` |
| Thumbnail URL | text | shown when `useEmbed` is `true` |
| Image URL | text | shown when `useEmbed` is `true` |
| Footer | text | shown when `useEmbed` is `true` |
| Show timestamp | boolean | shown when `useEmbed` is `true` |
| Embed fields | list | shown when `useEmbed` is `true`; up to 25 items |
| ↳ Name | text |  |
| ↳ Value | text |  |
| ↳ Inline | boolean |  |

**Outputs:** Next, On error

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

`action.channel.update` — Rename or reconfigure a channel. Blank fields stay unchanged.

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

`data.variable.set` — Store or change a value. Server and user variables are remembered between runs.

| Field | Type | Notes |
| --- | --- | --- |
| Where to store it | select | options: This run only (temporary), Server (remembered), Per user (remembered) |
| User | user | shown when `scope` is `user` |
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
| Read from | select | options: Server, Per user |
| User | user | shown when `scope` is `user` |
| Variable name | text | required |
| Save as | text | required |
| If missing use | text |  |

**Outputs:** Next, On error

## Logic

### 🔀 Condition (If)

`logic.condition` — Follow the True or False output depending on your checks.

| Field | Type | Notes |
| --- | --- | --- |
| Continue on True when | select | options: ALL checks pass, ANY check passes |
| Checks | list |  |
| ↳ Value | text | required |
| ↳ Check | select | options: equals, does not equal, contains, does not contain, starts with, ends with, is greater than, is at least, is less than, is at most, matches regex, is empty, is not empty |
| ↳ Compare to | text | shown when `op` is not `isEmpty` / `isNotEmpty` |

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

