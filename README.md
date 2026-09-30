# Chill Flow Bot — build a Discord bot with flowcharts

One shared Discord bot whose behaviour **server admins design in a web flowchart editor**. Pick a trigger
(a slash command, someone joining, a reaction…), connect actions (send a message with buttons, give a role, create a
channel, remember a variable…), press **Save** — it is live. No code.

```
 Slash Command /ticket ─▶ Create Channel ─▶ Send Message ──┬─ Next
                                             [🔒 Close]     ├─ 🔒 Close ─▶ Send Message ─▶ Wait 5s ─▶ Delete Channel
                                                            └─ On error
```

* **Website builder.** Publish small pages — a landing page, rules, an application form — from blocks (hero, text, images,
  buttons, lists, **forms**). Visitors log in with Discord to fill a form; a **Form Submitted** flow can react, and responses are
  saved for you to review and export (see [Pages & forms](#pages--forms)).
* **Upload pictures** instead of hunting for an image host: pick them for page images and Discord embeds (see [Pictures](#pictures)).
* **Multi-server, Discord login.** Admins sign in with Discord and can only edit servers where they are an
  administrator (configurable). Every flow, variable, slash command and log is scoped to one server.
* **Every button is its own path.** A *Send Message* node can carry several buttons and a select menu; each one becomes an
  output you connect to whatever should happen next.
* **Reusable panels.** Give a button a *Button ID* and handle it with a **Button Clicked** trigger instead: it works on any
  copy of the message, from any flow, survives restarts, and **Toggle Role** turns a button into a one-press role switch.
  Ready-made *Ticket panel* and *Button role panel* templates show how.
* **Change a message later.** *Change Buttons* adds, removes, disables or enables the buttons of a message the bot already sent — for example switch a
  vote off when it ends — or deletes the message, and a variable remembered **per channel** can hold that message's ID until you need it.
* **Alerts from other platforms.** Run a flow when a YouTube channel uploads, a subreddit / Bluesky / Mastodon account / blog posts, a Twitch
  channel goes live, a channel passes a subscriber milestone — or when *any* tool (Zapier, IFTTT, StreamElements…) calls a secret address, which is
  how X, TikTok, Instagram and Facebook posts or Twitch followers reach the bot (see [Alerts from other platforms](#alerts-from-other-platforms)).
* **61 nodes**: 31 triggers (commands, buttons, messages, joins/leaves/kicks/bans/timeouts, server boosts, role and channel events,
  reactions, voice, schedule, new feed item, webhook, YouTube subscribers, Twitch live, manual, form submitted) and 30 actions/logic nodes (messages with buttons/menus/forms, changing the buttons of a sent message, member moderation,
  channels and ticket transcripts, roles, variables and maths, conditions, loops, cooldowns, waits). Full lists: [docs/NODES.md](docs/NODES.md) · [docs/BLOCKS.md](docs/BLOCKS.md).
* **Remembers things**: run, per-server, per-channel and per-user variables, usable everywhere as `{{templates}}` — with maths built in
  (see [Remembered variables](#remembered-variables) and [Doing maths](#doing-maths)).
* **No limits by default** — any number of flows, nodes, variables, loop iterations and runs (see [Limits](#limits)).
* Live per-server **logs** with the executing node flashing on the canvas, import/export as JSON, starter templates.

> **Status:** the engine, API, security rules and editor are covered by automated tests (712 unit/integration tests plus a
> 162-check browser run against a fake Discord). It has **not** yet been run against the real Discord gateway — see the
> [smoke-test checklist](#smoke-test-against-real-discord) before you rely on it. The alert triggers (feeds, YouTube, Twitch, webhooks) were tested against a pretend network and fake accounts,
> not the real platforms; the same checklist covers them.

## Quick start

Requires **Node 22.13+** (uses the built-in `node:sqlite`; no native dependencies).

1. **Create the application** at <https://discord.com/developers/applications> → *New Application*.
   * *General Information* → copy **Application ID** → `DISCORD_CLIENT_ID`.
   * *Bot* → **Reset Token** → `DISCORD_TOKEN`.
   * *OAuth2* → copy **Client Secret** → `DISCORD_CLIENT_SECRET`; under *Redirects* add `BASE_URL/auth/callback`
     (for local use: `http://localhost:3000/auth/callback`).
   * *Bot* → *Privileged Gateway Intents*: switch on **Server Members** and/or **Message Content** only if you want the
     triggers that need them (see below), and set the matching `ENABLE_*_INTENT` variable.
2. **Configure and run**
   ```bash
   cp .env.example .env      # fill in the three secrets
   npm install
   npm run build
   npm start                 # → http://localhost:3000
   ```
3. Open the dashboard, **Log in with Discord**, and use **Add bot** next to your server (the link requests a sensible
   permission set: manage channels/roles/messages/nicknames, kick/ban/timeout, view audit log, embeds, reactions).
4. Open the server → **+ New flow** → try the *Support tickets* template, fill the highlighted fields, switch it **On**.

Try the editor without any Discord credentials: `npm run demo` (then open <http://localhost:4100/demo-login>). It runs the
real dashboard and API against a fake in-memory Discord — useful for development only.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token (required) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | — | OAuth application (required) |
| `BASE_URL` | `http://localhost:PORT` | Public URL of the dashboard. Also used for the redirect URI and the CSRF `Origin` check |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address. Use `HOST=0.0.0.0` only behind HTTPS |
| `TRUST_PROXY` | off | Number of reverse proxies in front (or `true`) so client IPs and `https` are detected correctly |
| `DATA_DIR` | `data` | Where `flowbot.sqlite` and the `uploads/` folder (uploaded pictures) live. Back both up |
| `DASHBOARD_MIN_PERMISSION` | `Administrator` | Or `ManageGuild`. Flows run with the **bot's** permissions, so the default is the safe one |
| `ENABLE_MEMBERS_INTENT` | `false` | Needed by *Member Joined / Left / Kicked / Timed Out*, *Member Boosted Server / Stopped Boosting* and *Role Given/Removed* triggers |
| `ENABLE_MESSAGE_CONTENT_INTENT` | `false` | Needed by the *Message Received* trigger. Optional for *Save Transcript*: without it Discord hides what other people wrote, so a transcript lists who wrote when, but not what |

| `FEED_MIN_INTERVAL_MINUTES` | `5` | The shortest time a *New Feed Item* trigger may wait between looks at a feed (whole minutes, at least 1) |
| `YOUTUBE_API_KEY` | — | Optional. A YouTube Data API v3 key, for the *YouTube Subscribers* trigger |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | — | Optional. A free Twitch developer application, for the *Twitch Channel Live* trigger |
| `LIMIT_*` | unlimited | Optional caps, see [Limits](#limits) |

Triggers whose intent is off — or whose platform key is missing — are greyed out in the palette and never activated (their node shows why). Keys are only ever read by the server; the editor is told yes or no, never the key.

### Limits

**There are no limits by default**: as many flows, nodes and connections, stored variables, runs per second, actions,
loop iterations, steps per run and as long a wait as you like. On a private bot that is what you want. If you host this for
*other people*, cap only what you need with environment variables — each takes a number or `unlimited`:

| Variable | Caps |
| --- | --- |
| `LIMIT_FLOWS_PER_GUILD` · `LIMIT_NODES_PER_FLOW` · `LIMIT_EDGES_PER_FLOW` | flows per server, nodes and connections per flow |
| `LIMIT_NODE_DATA_BYTES` · `LIMIT_GRAPH_BYTES` | size of one node's settings / of a whole flow |
| `LIMIT_VARS_PER_GUILD` · `LIMIT_VAR_VALUE_BYTES` | remembered variables per server / size of one value |
| `LIMIT_RUNS_PER_10S` · `LIMIT_CONCURRENT_RUNS` · `LIMIT_ACTIONS_PER_10S` | flow starts, simultaneous runs and Discord actions per server |
| `LIMIT_STEPS_PER_RUN` · `LIMIT_LOOP_ITERATIONS` · `LIMIT_WAIT_SECONDS` | nodes executed per run, loop length, longest single wait |
| `LIMIT_TRANSCRIPT_MESSAGES` | most messages one ticket transcript records (default: all, up to the file-size ceiling below) |
| `LIMIT_COMPONENT_STATE_DAYS` | how long a message's remembered button data is kept (default: until the message or its channel is deleted; ephemeral replies always expire after a day) |
| `LIMIT_PAGES_PER_GUILD` · `LIMIT_BLOCKS_PER_PAGE` · `LIMIT_RESPONSES_PER_GUILD` | pages per server, blocks per page, stored form responses per server |
| `LIMIT_UPLOAD_BYTES` · `LIMIT_UPLOADS_PER_GUILD` · `LIMIT_STORAGE_BYTES_PER_GUILD` | size of one uploaded picture, pictures per server, total picture storage per server |
| `LIMIT_FEEDS_PER_GUILD` | feeds and Twitch/YouTube channels one server may watch |
| `LIMIT_WEBHOOK_BYTES` · `LIMIT_WEBHOOKS_PER_MINUTE` | one webhook call's size (default 64 KB) / calls per minute to one address |
| `LIMIT_REQUEST_BYTES` | HTTP request body (default 50 MB; always has a ceiling, max 1 GB) |

`.env.example` contains a commented **public-host preset** with sensible caps.

**What cannot be unlimited** — these are physical or Discord's own rules, not ours: 25 buttons / menu options / embed fields,
10 embeds and 6000 embed characters per message, 25 options per slash command, 5 form inputs, 2000 characters per message, 8 MB per ticket transcript (its `.html` and `.txt` together; Discord's upload limit), 100 slash commands per server,
memory and CPU, `setTimeout`'s maximum (~24.8 days), the form wait (10 min: Discord's interaction tokens expire), and the
login/API/public-site rate limits that protect the site itself (10 form submissions per minute per visitor, 60 per IP, 600 page views
per IP; a form answer is at most 10 000 characters and a public request 256 KB; an uploaded picture is at most 32 MB and 64 megapixels
and 30 uploads per minute per person; a webhook call is at most 256 KB and one address takes at most 600 calls a minute; a feed answer is
read for at most 10 seconds and 1 MB; at most 5 new posts are announced per look).

**How it stays safe without a step cap:** a run that loops forever uses constant memory and yields to the event loop, so the
bot keeps answering everyone else (measured: 650k steps in 4 s, worst stall 7 ms). **To stop a runaway flow, switch it Off
(or delete it)** — its running instances stop within milliseconds, even in the middle of a long wait. A graph that fans out
*and* loops back is cut off at one million waiting branches.

> Trade-off: with no caps, one server can slow the shared bot for the others. Fine for your own servers; if you open
> the dashboard to strangers, set caps.

Development with hot reload: `npm run dev` (server + Vite). Set `BASE_URL=http://localhost:5173` and add
`http://localhost:5173/auth/callback` as a redirect so login and the `Origin` check line up.

## How flows behave

* **Triggers** start a flow; everything connected after them runs in order. When one output goes to several nodes they
  run **top to bottom**, then left to right.
* **Connecting** is a toggle: drag from an output to a node to connect them, drag the **same** connection again to disconnect
  them (or select a connection and press Delete). Two different outputs of one node may still lead to the same node.
* **Errors**: every action has an **On error** output. Connect it to react (`{{error.message}}`); unconnected, the error
  is logged and that branch ends. Interactions never end with Discord's red “interaction failed”.
* **Slow flows** are fine: after ~2 s the bot defers the reply for you, and the next *Send Message → reply* fills it in.
* **Buttons & menus** are routed by their custom id, so they keep working after restarts. What the run that posted a message
  knew — its run variables (`{{var.x}}`) and `{{original.user.name}}` etc. (whoever/whatever created the message) — is stored
  in the database, so it survives restarts too. **Every press gets its own private copy**: one person's press can never
  change what the next person sees. If you want something to carry over between presses, use a server, channel or user variable.
* **Forms (modals)** must be the first thing a command/button does; answers are `{{input.<id>}}`.
* **No feedback loops**: changes the bot makes itself (a role it gave, a channel it created) do not trigger flows unless you
  tick *Also run for changes made by this bot*.
* **Kick vs leave, who banned whom**: read from the audit log — give the bot *View Audit Log* or kicks look like leaves.
* **Slash commands** are registered per server when you save (instant, no global propagation delay).

### Reusable panels (tickets, role menus)

A normal button is wired to an output of the *Send Message* node that posted it. To make a button reusable, open the button
in the node and fill **Button ID** (for example `open_ticket`), then add a **Button Clicked** trigger with the same ID:

* The button keeps working on **every copy** of the message, after restarts, and even if you duplicate or rebuild the flow —
  its Discord id is `fcb:open_ticket`, which does not mention any flow or node.
* **One handler per ID.** A press can only be answered once, so if two flows use the same ID the oldest wins and the log
  says so. Buttons with an ID only work inside servers (not in DMs), and adding an ID to a button that is already posted
  makes that old message stop working until you post it again.
* Inside the flow `{{button.id}}`, `{{button.label}}`, `{{user.*}}` (whoever pressed) and `{{original.*}}` (whoever posted the
  message) are available. **Toggle Role** gives the role, or takes it away if the member already has it (`{{toggle.action}}`
  says which).
* Panels are posted by a **Manual** trigger (press ▶ Run once). Start from the **Ticket panel** or **Button role panel**
  template. In the ticket template a cooldown stops double-clicks from opening two tickets.

### Embeds, and editing a message that was already sent

**Send Message** and **Edit Message** share one embed editor. A message can carry up to **10 embeds** (6000 characters in all — the flow says so if you go over), and each embed has:
a **title** and a **title link**, a **description**, a **colour**, an **author** (name, icon, link), a **thumbnail** and an **image**, a **footer** (text, icon), a **timestamp**, and up to 25 **fields**.
Pictures are an https link, a `{{variable}}`, or a picture you uploaded. An author icon or link needs an author name, a footer icon needs footer text, and a title link needs a title.
Flows saved with the older single embed are converted to the new list when you open or save them; they keep working either way.

**Edit Message** is a full edit mode for a message the bot already sent. For the **text** and for the **embeds** you choose what happens — **Keep as it is**, **Replace**, or **Remove** —
so a flow can change one thing and leave the rest exactly as it was. Choose the message with **Which message**: **This message** (the one that started the flow, for example the message a pressed button is on)
or **A previous message** by its ID (see the recipe below). The buttons are never touched — use **Change Buttons** for those.

| Embeds | What it does |
| --- | --- |
| **Keep as they are** | Nothing changes. |
| **Change some parts of one embed** | Pick **which embed** (1 = the first). **Remove these parts** are taken off first, then **Set these parts** are changed; every part you do not name stays exactly as it was, and so do the message's other embeds. Naming an embed one past the last adds a new one. |
| **Replace all embeds** | The embeds you build here replace the ones on the message. |
| **Remove all embeds** | Takes them all off. |

* **Removing** “Author name” removes the whole author; “Footer text” the whole footer; “Title” its link too. An embed with nothing left in it disappears.
* **Setting** a part to an empty value (for example a variable that was never filled in) is an error, never a silent removal. “Fields” replaces all the fields the embed has.
* Link previews Discord adds under a link in the text are not embeds you can edit; they are left out of the numbering and come back by themselves if the text still has the link.
* Only the bot's **own** messages can be edited, and not “only visible to you” replies. An edit that would leave the message with no text, no embed and no buttons is refused.

### Changing the buttons of a message that was already sent

The **Change Buttons** node (*Messages*) edits **only the buttons** of a message the bot posted earlier — its text and embeds are never touched.
Pick what to do:

| Mode | What it does |
| --- | --- |
| **Add or update buttons** | Adds the buttons you list (same settings as in *Send Message*). A button that is already on the message — same Button ID, or same link address — is **updated where it stands**, so running the flow twice never doubles it. |
| **Remove specific buttons** | Removes the buttons you name. A name matches a button's **Button ID**, or else its **label** (capital letters do not matter). |
| **Remove all buttons** | Takes every button off. |
| **Disable / Enable buttons** | Greys the named buttons out (or switches them back on). An empty list means **every** button — handy for “the vote is over”. |
| **Delete the message** | Deletes the message — this one, or a previous one by its ID — like the **Delete Message** node. Unlike the button modes it also works on a message somebody else posted, as long as the bot has *Manage Messages* there. |

* **Which message?** Every mode starts with this choice:
  * **This message** — the one that started the flow: the message a pressed button is on, or the message someone just posted. It needs a flow that
    started from a message or a button; otherwise the node follows its **On error** output and says so.
  * **A previous message (by its ID)** — fill in the **Message ID** (and its **Channel**, if it is not the current one). To reach an earlier message, save its ID when you
    send it (*Send Message* → **Save message ID as variable**), keep it with **Set Variable** (scope *Channel*), and use `{{channel.vars.panel}}` as the Message ID in
    another flow.
  * An **empty ID is an error** — it never quietly turns into “this message”, so a delete can not hit the wrong message when a variable was not saved yet.
* **Clicks on added buttons** work both ways, like in *Send Message*: fill **Button ID** and answer it with a **Button Clicked** trigger, or leave the ID empty and
  connect the button's own output on this node. A button wired to an output stops working if that output goes away (you edit or delete the node); a Button ID does not.
* **Limits.** The button modes work only on the bot's **own** messages, and nothing here works on “only visible to you” replies. Discord allows **5 rows of 5 buttons**, and a select menu takes a whole row;
  if there is no room the node follows its **On error** output. It will not remove the last button of a message that has no text or embed (Discord refuses an empty message).
  Naming a button that is not there is not an error — the log says nothing matched.

**Recipe: a panel that comes back if it is deleted** (the *Panel that comes back if it is deleted* template). Pick a channel in the **Manual** trigger and press ▶ Run once:
the bot posts the panel and stores its message ID in the channel variable `panel`. A second branch starts with **Message Deleted** and checks
`{{message.id}}` equals `{{channel.vars.panel}}`; when it does, it posts the panel again and stores the new ID. Any other deleted message is ignored, and it keeps working after a restart.
Change the text in both *Send Message* nodes (keep them the same), and add buttons there if you like.

### Ticket transcripts

The **Save Transcript** node records everything said in a channel — the person, the time, the text, embeds, attachments (as
links), stickers, replies — and saves it as an `.html` file **and a plain `.txt` copy** of the same messages. It posts both files in
one message in a **log channel** you choose and can also **DM a copy** to someone (in a ticket: `{{original.user.id}}`, the person
who opened it). Tick **Leave out the plain-text (.txt) copy** on the node if you only want the `.html`; flows saved before the `.txt`
existed get it too. The *Support tickets* and
*Ticket panel* templates run it when **Close** is pressed; pick the log channel in that node.

* **The ticket only closes if the transcript was saved.** If the log channel is missing or Discord refuses the post, the flow
  follows **On error** (the templates say why and leave the ticket open). A DM that cannot be delivered — closed DMs, or the
  person can no longer see the channel — never blocks anything; it is skipped with a warning in the logs
  (`{{transcript.dm}}` is `sent`, `failed` or `skipped`).
* **Message Content intent.** Without `ENABLE_MESSAGE_CONTENT_INTENT` Discord returns *empty text* for other people's messages.
  The node still works, but the file says so in a banner and the editor shows a warning on the node.
* **What the files are:** the `.html` is one self-contained page — no scripts, no pictures, everything escaped — so it is safe to
  open; Discord does not preview it, so download it and open it in a browser. The `.txt` is plain text (UTF-8): a heading, then one
  entry per message — `[2026-09-30 14:03:22 UTC] mia (222…)` followed by the message, indented — easy to search, copy, diff or read on
  a phone. Every line of a message is indented, so nobody can type a line that passes for a different person's message. Attachment links are Discord's own and **expire** (and vanish with
  the channel), so the transcript records that a file was shared, not its content.
* **Size:** transcripts stop at 8 MB (Discord's upload limit) **for the two files together** — both stop at the same message, so a
  `.txt` costs a little room in very long conversations — or at `LIMIT_TRANSCRIPT_MESSAGES`. They keep the *start* of the
  conversation, and say where they stop (`{{transcript.truncated}}`). Long channels are read 100 messages at a time.

### Checking roles

The **Condition (If)** node can ask whether someone has a role. Add a check, set **Check** to *has the role* (or *does not have the role*) and pick
the role from the list. The **True** output means yes, **False** means no.

* **Whose role?** Whoever started the flow — or fill in **Member** to look at someone else, for example `{{option.member}}`. A flow that no person
  started (a *Schedule* or *Manual* trigger) has nobody to look at, so it needs a Member; without one the run stops and the log says why.
* **Combine them** with the node's *ALL* / *ANY* switch: “has Staff **or** Mod” is two role checks with ANY. Role checks and text checks mix freely.
* **The role can be a variable** (`{{option.role}}`); everyone has `@everyone`.
* **It stays shut when in doubt.** Someone who is not in the server does not have the role, and a role that was deleted counts as “no” (the log warns
  about it), so a gate built on it never opens by accident.
* **It is always current.** The roles are read when the check runs. The person who used the command or button arrives with their current roles; anyone
  else is asked for from Discord each time, so a stale copy is never trusted.

### Titles

Every node has an optional **Title** (the first box in its settings). It is shown on the node in the editor — with what kind of node it is underneath —
and in the list of problems, so people who edit the flow can tell nodes apart (“Is staff?”, “Welcome message”). It is only for the editor: it is never sent
to Discord and does not change what the flow does.

### Server boosts

**Member Boosted Server** and **Member Stopped Boosting** start a flow when someone starts, or completely stops, boosting the
server (both need `ENABLE_MEMBERS_INTENT`). Handy for a thank-you message: *"Thanks {{user.mention}}! We now have
{{guild.boostCount}} boosts (level {{guild.boostTier}})."*

* Extra boosts from someone who already boosts do not count — Discord keeps the date of the first one — and *stopped* means all of
  that person's boosts ended (`{{boost.days}}` is how long they boosted).
* Discord only reports the change together with another change on the member (in practice the “Server Booster” role), so if an admin
  deleted that role some boosts may go unnoticed. Members the bot has not loaded yet are ignored rather than guessed at.

### Schedules

The **Schedule** trigger has three modes. The editor shows the **next five runs** under the settings, so you can see what you asked for
before you switch the flow on.

| Mode | Use it for |
| --- | --- |
| **Every … minutes, hours or days** | “every 30 minutes”. Counted from when the schedule was switched on; it keeps counting when you save *other* flows, and starts again if you change the schedule itself or the bot restarts. Any length up to 10 years. |
| **At a set time of day** | “every day at 09:00”, “Mondays and Fridays at 18:30”. A time on a 24-hour clock and the weekdays you want (none ticked = every day). |
| **On a cron schedule** | anything else — see below. |

**Time zones.** A set time or cron schedule is read on the clock of the **Time zone** you pick (a new one starts on your browser's zone; `UTC`
is always available). Old and new names of a zone both work (`Asia/Kolkata` and `Asia/Calcutta`).

**Cron** is five fields — `minute hour day-of-month month day-of-week`:

| Write | It runs |
| --- | --- |
| `*/15 * * * *` | every 15 minutes, on the quarter hours |
| `0 9 * * 1-5` | 09:00 on weekdays (`MON-FRI` works too) |
| `30 18 * * FRI` | 18:30 on Fridays |
| `0 0 1 * *` | midnight on the 1st of every month |
| `0 12 1,15 * *` | noon on the 1st and the 15th |
| `@hourly` `@daily` `@weekly` `@monthly` `@yearly` | shortcuts |

Fields take `*`, lists (`1,15`), ranges (`1-5`), steps (`*/10`, `10-40/5`), and month/day names (`JAN`, `MON`); `7` also means Sunday.
As in classic cron, when you restrict **both** the day of the month and the day of the week, a day counts if **either** matches
(`0 12 13 * FRI` = every 13th *and* every Friday). No seconds, and no `L`, `W` or `#`.

* The bot looks once at the start of every minute, so a run starts within a moment of it. Minutes are the smallest step.
* **Runs missed while the bot was off are not made up**, and a restart never fires a burst. Set-time and cron schedules simply carry on
  with the clock; “every …” counts again from the restart.
* **Clocks changing.** A time that does not exist that day (02:30 when the clocks jump forward) is skipped that day; a time that happens
  twice (clocks going back) runs once.
* A schedule that cannot work — a cron expression that does not parse, an unknown time zone, a date that never exists like 31 February —
  is shown as a problem on the node and does not run (the server's log says why).

### Alerts from other platforms

Three ways in, from “nothing to set up” to “needs a key from the bot operator”. Pick the trigger, say what to watch, save, switch the flow on.

| Platform | You can react to | Use | Needs |
| --- | --- | --- | --- |
| **YouTube** | a new video | *New Feed Item* → YouTube (paste the channel ID, `UC…`) | nothing |
| **YouTube** | subscriber milestones | *YouTube Subscribers* | operator's `YOUTUBE_API_KEY` |
| **Twitch** | a channel goes live | *Twitch Channel Live* | operator's Twitch application |
| **Reddit** | a new post in a subreddit | *New Feed Item* → Reddit | nothing |
| **Bluesky** | a new post by an account | *New Feed Item* → Bluesky | nothing |
| **Mastodon** | a new post by an account | *New Feed Item* → Any feed address, `https://server/@name.rss` | nothing |
| **Blogs, podcasts, GitHub releases…** | a new entry | *New Feed Item* → Any feed address (`…/releases.atom` on GitHub) | nothing |
| **X, TikTok, Instagram, Facebook** | a new post | *Webhook Received*, called by a tool that can watch them | the tool (Zapier, IFTTT, Make…) — **not the bot** |
| **Twitch followers** and any other “someone followed / subscribed” | the event | *Webhook Received*, called by StreamElements, Streamlabs or Zapier | the tool |

**Seen against the real internet** (a check from the machine this was built on, not a promise): Bluesky, Mastodon, GitHub releases, blog and Hacker News feeds were read and parsed correctly,
but YouTube's feed address answered *404* for channels that certainly exist, and Reddit's was blocked by that machine's network policy. YouTube is known to refuse feed requests from some hosting
providers now and then; if your log says a YouTube feed “was not found” for a channel ID you are sure of, that is the likely reason — the bot keeps trying with a growing pause, and the Webhook
trigger (fed by Zapier or similar) is the fallback. Mastodon and Bluesky posts have **no title** — use `{{feed.summary}}` (the starter flow does).

What is **not** possible, and why, so you are not surprised: X, TikTok, Instagram and Facebook publish no free public feed (a Facebook Page's posts are only handed to an app with the Page owner's own permission), and Twitch only tells an app
about a channel's followers with a token the *streamer* grants — so the bot cannot watch those by itself. What such a tool can offer changes over time; the
bot only promises the address it gives you. YouTube **rounds** public subscriber counts to three significant figures once a channel has more than 1,000
and a channel may hide its count, so choose a step much bigger than the rounding (every 100 for a small channel, every 10,000 for a big one).

**New Feed Item** reads RSS, Atom and JSON Feed from any **public https address** and gives the flow `{{feed.title}}`, `{{feed.link}}`, `{{feed.author}}`,
`{{feed.summary}}` (plain text), `{{feed.published}}`, `{{feed.image}}`, `{{feed.id}}` and `{{feed.name}}`. The editor shows the exact address it will read.

* **The first look only remembers what is there.** Posts that already exist when you switch the flow on are not announced. After that each new post is announced
  **once**, oldest first, even across restarts, and a post that appeared while the bot was off is announced when it is back (if the feed still lists it).
  **Switching a flow off forgets what it had seen** — when you switch it on again it starts fresh, so posts made while it was off are not announced.
* **Looks every N minutes** (at least 5; the operator can raise that). One request per address however many servers watch it. **At most 5** new posts are
  announced per look; if a burst is bigger the newest five are announced and the log says how many were left out.
* **A feed that cannot be read** (moved, down, not a feed, too big) is written to the server's log **once**, then the bot waits longer each time (5 minutes, up to 6 hours)
  and logs again when it works. Changing the address starts fresh.
* Text from a feed is only ever *text*: `{{…}}` in a title is shown as written, and `@everyone` in it pings nobody.

**Webhook Received** gives the trigger a **secret address** (`https://your-bot/hooks/<43 characters>`), shown in the inspector after the first save, with **Copy** and
**Generate a new address** (the old one stops working at once). Anything that can send an HTTP `POST` can start the flow:

```
curl -X POST https://your-bot.example/hooks/<the address> -H 'Content-Type: application/json' -d '{"title":"New post","message":"Hello","url":"https://example.com/1"}'
```

The flow gets `{{webhook.body.title}}` (any field of the JSON or form, `{{webhook.body.user.name}}` for nested ones), `{{webhook.text}}` (everything as text),
`{{webhook.query.name}}` (a `?name=value` on the address), `{{webhook.method}}` and `{{webhook.contentType}}`. The bot answers `202` at once and runs the flow afterwards;
`404` is an unknown address, `405` any method but POST, `413` too big, `415` an unsupported content type (JSON, form or text are accepted), `429` too many calls, `409` the flow is off.
**Treat the address like a password**: whoever has it can start that flow (they cannot do anything else). A copied or imported flow gets its own new address, never the original's.

Five starter flows are in **New flow → from template**: *YouTube upload announcer*, *Post announcer*, *Twitch live alert*, *YouTube subscriber milestone* and *Webhook alert*.

### Templates

`{{path}}` works in any text field. Add filters with `|`: `{{user.name | upper}}`, `{{option.reason | default:none}}`.

| | |
| --- | --- |
| `user.id .name .displayName .mention .tag .avatar .isBot` | who triggered the flow (or who the event is about) |
| `member.nickname .joinedAt .roleIds .permissions .boostingSince` | their server membership |
| `guild.id .name .memberCount .boostCount .boostTier` | the server |
| `channel.id .name .mention .type`, `message.id .content .url .after`, `role.*`, `emoji.*` | event details |
| `option.<name>` | slash-command options |
| `input.<id>`, `select.value`, `original.*` | forms, menus, the message that a button belongs to |
| `button.id`, `button.label`, `toggle.action` | the button that was pressed (*Button Clicked*), and whether *Toggle Role* added or removed the role |
| `boost.since`, `boost.days` | *Member Boosted / Stopped Boosting*: when they started, and for how many days they boosted |
| `transcript.messages .name .textName .bytes .truncated .dm` | after *Save Transcript* (`name` is the `.html` file, `textName` the `.txt`, blank if left out) |
| `var.<name>` | run variable (or something saved by *Save … as variable*) |
| `user.vars.<name>`, `channel.vars.<name>`, `guild.vars.<name>` | remembered per-user / per-channel / per-server variables (`channel` is where the run happened) |
| `loop.index .item`, `error.message`, `cooldown.remaining`, `now.iso .date .time .timestamp` | misc |
| `executor.*`, `reason`, `timeout.*` | moderator details for kick/ban/timeout triggers |
| `feed.title .link .author .summary .published .image .id .name` | *New Feed Item*: the new post (`title` is blank for Mastodon and Bluesky posts) |
| `webhook.text .body.<field> .query.<name> .method .contentType` | *Webhook Received*: what was sent |
| `youtube.subscribers .milestone .previous .channelTitle .channelId .url` | *YouTube Subscribers* |
| `twitch.user .login .title .game .viewers .url .thumbnail .started .id` | *Twitch Channel Live* |

Filters: `default:x`, `upper`, `lower`, `trim`, `length`, `json`, plus the maths filters below. Filters chain left to right.
Substituted text is never evaluated again, so member-supplied text cannot inject templates.

### Remembered variables

**Set Variable**, **Get Variable** and the **Math** block's *Also remember it* can keep a value between runs in three places:

| Scope | One value for… | Read it as | Typical use |
| --- | --- | --- | --- |
| **Server** | the whole server | `{{guild.vars.<name>}}` | a global counter, a setting |
| **Channel** | each channel | `{{channel.vars.<name>}}` | a counter per ticket channel, the ID of the panel message that lives in that channel |
| **Per user** | each member | `{{user.vars.<name>}}` | coins, points, a streak |

* The **Channel** field of the node is optional: blank means **the channel where the run happened**. A run that has no channel (a schedule, webhook or feed alert
  without a channel picked, a member joining…) needs the field filled in, otherwise the node follows its **On error** output.
* **Get Variable** can read another channel's or member's value by filling the same field.
* A channel's variables are **forgotten when the channel is deleted**. The **Remembered variables** dialog in the editor lists, edits and deletes all of them; the
  variable limits (`LIMIT_VARS_PER_GUILD`, `LIMIT_VAR_VALUE_BYTES`) count every scope together.

### Doing maths

Three tools, from smallest to biggest — pick the one that fits:

| You want to… | Use |
| --- | --- |
| change a number you already **store** (add one to a counter, subtract points) | **Set Variable** → *Add* / *Subtract* / *Multiply* / *Divide* / *Calculate expression* |
| **calculate a new value** from any values and use it in the next nodes (optionally remember it) | the **Math** block (*Variables* category) |
| show a calculated number **inside text** without adding a node | maths filters in `{{ … }}` |

**Maths filters** (any text field): `add:N`, `sub:N`, `mul:N`, `div:N`, `mod:N`, `min:N`, `max:N`, `abs`, `floor`, `ceil`,
`round` / `round:2`, `fixed:2` (keeps trailing zeros: `3.50`) and `commas` (`1234567` → `1,234,567`). The number after the colon
can be a number **or a variable** (`add:var.bonus`, `mul:guild.vars.rate`).

```
Joined so far: {{guild.vars.joins | default:0 | add:1 | commas}}
Price with tax: {{var.price | mul:1.2 | fixed:2}}
```

* An **empty or missing** value counts as `0`, so the first time works without any set-up. Text that is not a number, dividing by
  zero, or a result that is not a finite number leaves the value **as it was** (a text field has nowhere to show an error). Use the
  **Math** block when you want to be told.
* Results are tidied to 12 significant digits, so `0.1 + 0.2` shows `0.3`.

**The Math block** has two modes. *Two values*: a first value, an operation (`+ − × ÷`, remainder, power, smaller, larger) and a
second value. *Formula*: one line such as `({{var.score}} + 10) * 2` (`+ - * / % ^`, brackets, `round floor ceil abs sqrt min max`).
Either way the answer is available to the next nodes as `{{var.<name>}}` (the name you give under **Save result as**), can be
rounded, and — with **Also remember it** — is saved as a server, channel or per-user variable under the same name. A blank value counts as
`0`; a real problem (text, ÷ 0, a broken formula) follows the block's **On error** output.

**Recipes** (both are in the *New flow* templates — pick the channel, switch on):

* **Member counter** — *Member Joined* and *Member Left* → *Update Channel* named `👥 Members: {{guild.memberCount | commas}}`
  (needs the Server Members intent).
* **Join counter** — *Member Joined* → **Math** (`{{guild.vars.joins}}` + 1, remembered as the server variable `joins`) →
  *Update Channel* named `Joined so far: {{var.joins | commas}}`.

**Renaming a channel has a Discord limit.** Discord only allows about **two name/topic changes per channel every 10 minutes**.
The bot counts its own changes: the first two are made at once, and while the limit is used up the *newest* name is held and made
**once** when Discord allows it (the log says *"…is held back; the newest one is applied in about N minutes"* and later
*"The held change … was made"*). Runs never hang, the counter never runs behind, and the channel always ends with the latest
number. Held changes are forgotten if the bot restarts or is removed from the server. Other channel settings (slowmode, parent,
NSFW, permissions) are never held back.

## Using it on a phone

The dashboard, the flow editor and the page builder work on a phone (and the public pages you publish always did).

* **Menu.** ☰ opens the list of flows, pages and nodes as a drawer; picking something closes it. Variables, Pictures, logs and Log out are under ⋯.
* **Flows.** The canvas gets the whole screen and starts at the first trigger, at a readable size — drag to pan, pinch to zoom. Tap a node to edit it in a
  sheet from the bottom (✕ closes it), tap a **Nodes** entry to add one, and drag from one dot to another to connect (the dots are bigger on touch screens).
  Dragging a node off the palette is a desktop nicety; tapping works everywhere.
* **Pages.** Three tabs at the bottom — **Blocks**, **Preview**, **Settings**. Tapping a block opens its settings.
* Fields are 16 px, so iOS does not zoom the page in when you type. Logs start hidden on a phone.
* Building a big flow is still easier on a larger screen; the phone layout is for checking, tweaking and switching things on and off.

## Pages & forms

Open the **Pages** tab → **+ New page** (start from *Landing page*, *Staff application form*, *Contact form*, *Rules & verification*
or blank). Add blocks from the left, arrange them with ↑ ↓, edit them on the right, and watch the **live preview** — it is rendered by
exactly the same code as the public page. Press **Publish** and share the link:
`https://your-site/s/<serverId>/<address>`. Pages start as drafts. Block reference: [docs/BLOCKS.md](docs/BLOCKS.md).

**Draft and live.** **Save** only saves your *draft* — visitors keep seeing the last **published** version until you press **Publish
changes** (which saves first if you have unsaved edits). The status chip says where you are: *Draft*, *Published*, or *Changes not live*
(also shown as an amber dot in the page list). **Discard changes** (under **More**) goes back to the published version, **Unpublish**
takes the page offline and keeps your draft. Publishing is refused while the page has real problems (for example a form with no questions).
The address and *who can open the page* are not versioned: they apply as soon as you save. Responses and the CSV use the questions
visitors actually answered (the published form). Pages made before drafts existed keep serving exactly what they served, because the
database upgrade turns their current content into the published version.

**Link previews.** When a page link is pasted into Discord it shows a card: title, description, picture and an edge in your accent colour.
It works with no setup (the description comes from your hero subtitle or first text, the picture from your hero or the server icon); under
**Page settings → Link preview** you can write a description and choose a preview picture, with a small mock of the card. Pictures need a public
`BASE_URL`, and Discord may keep showing an old preview for a while.

**Who can open a page.** Under **Page settings → Who can open this page**: *anyone with the link* (default), *members of this server*, or
*members with one of these roles* (any one is enough). Visitors log in with Discord as for forms; membership and roles are checked live through the
bot (cached up to a minute, so a new role can take that long to count). The rule also covers the page's forms and thank-you page. It **fails closed**:
an empty role list, a deleted role or a failed lookup all refuse. Refusals show no page title, content or link-preview tags, so pasting the link
reveals nothing. Note that **pictures on a gated page can still be opened by their direct link** (they are shared with Discord messages).

**Forms.** A *Form* block has questions (short/long answer, number, dropdown, radio buttons, checkboxes, a single “I agree” box,
date), each optionally required with min/max. Options per form: only members of the server may submit (checked live through the
bot), one response per person, a wait between responses, save responses (or not), and what happens afterwards — a thank-you message
or a redirect to another address. Visitors **must log in with Discord** (we only ask for their identity, not their server list).

**Reacting to a submission.** In a flow use the **Form Submitted** trigger and pick the form. The answers are `{{form.<question id>}}`,
`{{form.summary}}` is every answer as text, and `{{user.*}}`/`{{member.*}}` describe the person who submitted:

```
Form Submitted ─▶ Send Message (to #staff-applications): "New application from {{user.mention}}\n{{form.summary}}" ─▶ Give Role
```

**Responses.** The editor's **Responses** button lists what people sent (delete any entry) and downloads a **CSV**. If “Save
responses” is off, no answers are stored — only, when “one response per person” or a wait is on, a receipt (who and when) so those
rules still work. Deleting a page erases its responses.

### Pictures

Any image field — a page's hero background and image blocks, and the **Image** / **Thumbnail** of a *Send Message* embed — has a
**Choose…** button that opens the server's picture library (also reachable from **Pictures** in the top bar). Upload one or several
pictures with the button or by dropping files (PNG, JPEG, WebP or GIF). Every upload is **re-encoded on the server**: the real format is
checked (SVG and HTML are refused whatever they are called), photo metadata such as GPS location is removed, rotation is applied,
big pictures are shrunk to at most 2400 px and everything is stored as WebP (animated GIFs stay animated). The library shows each
picture's size and **where it is used**, and asks before deleting one that is in use (a page then shows nothing in that spot and the
editor flags it; a message node fails with a clear error).

Pictures are public by address — anyone who has the link can open it — because pages and Discord must be able to load them:
`https://your-site/i/<serverId>/<id>.webp`. The id is 16 random characters and only that server's pictures resolve under its id.
In **messages**, Discord downloads the picture from your site, so `BASE_URL` must be a public address (not `localhost`); pages work anywhere.
Pictures belong to one server: a flow exported to another server keeps its `upload:` reference but the picture must be uploaded there
again (the node then reports it clearly). Optional caps: `LIMIT_UPLOAD_BYTES`, `LIMIT_UPLOADS_PER_GUILD`, `LIMIT_STORAGE_BYTES_PER_GUILD`. Uploads need the `sharp` image
library (installed with `npm install`; if it cannot load on your platform, only uploads are disabled).

**Safe by construction.** Pages are data, never HTML: everything is escaped, links must be `https` and images are uploaded pictures or `https`, there is **no
JavaScript on public pages** (and the CSP forbids it), every page carries a footer saying it was made by the server’s admins and
not Discord, forms show what data is shared, and there is deliberately no password field. Submissions need a Discord login, a
per-form CSRF token, a same-origin request, and are rate limited (10 per minute per visitor, 60 per IP). Visitor logins are a separate
kind of session that can never reach the dashboard API.

## Security model

This is a multi-tenant service: many servers share one bot process, so isolation is enforced in code and covered by tests.

* **Login**: Discord OAuth2 (`identify guilds`) with a one-time `state` cookie. The access token is used once, **revoked and
  never stored**; sessions are random ids (only a hash is kept) in `HttpOnly; SameSite=Lax` cookies.
* **Authorisation**: every server-scoped request re-checks, live through the bot, that you are the owner/Administrator
  (cached ≤ 60 s). Stale sessions cannot keep access after a demotion. Flow lookups are always filtered by server id.
* **CSRF**: state-changing requests must come from `BASE_URL`'s origin; security headers + a strict CSP are sent (scripts only from
  this site; the dashboard allows `https:` images so the page preview can show the pictures you add — public pages themselves allow no script at all
  and load images only from this site or over `https`).
* **Execution isolation**: executors only resolve channels, roles and members through the flow's own server and re-check
  ownership, so pasting a foreign id does nothing. DMs go only to members of that server. Variables are per server
  (server, channel or user *within* a server; there is deliberately no global scope). Logs are per server and never persisted.
* **Public pages** (the only unauthenticated surface): rendered from structured data with everything escaped and URLs validated
  (`javascript:`/`data:`/credential-carrying links refused), served with a no-script CSP, `X-Frame-Options: DENY` and
  `Referrer-Policy: same-origin`; unpublished, unknown and other-server pages are indistinguishable 404s; “check, then insert” for
  one-per-person rules is atomic so simultaneous submissions cannot both pass; CSV exports defuse spreadsheet formulas.
* **Gated pages** (members / roles): one check guards the page, its form submission and the thank-you page; anything unexpected refuses; refusals
  and login prompts carry no title, content or preview tags and are `noindex`/`no-store`. Not gated: pictures, which stay reachable by link.
* **Uploaded pictures**: never served as sent — decoded, stripped of metadata and re-encoded as WebP by the server (only pixels we
  encoded reach a visitor; no SVG, no polyglot files), refused from their header when they declare an absurd size, at most two decoded
  at once. Files are named by random id, never by the uploaded name; paths are built only from validated ids; each picture is looked up
  by `(id, server)`, so another server's id is a 404. Served with `nosniff`, a sandboxing CSP and no cookies. Caps are race-free.
  As with any host that lets people upload images: you are the operator, so cap uploads (`LIMIT_*`) if you host for strangers.
* **Safe defaults**: `@everyone`/role pings are off unless a node opts in; audit-log reasons say `[Flow name]`;
  user-supplied regexes run under a hard timeout (a catastrophic pattern cannot freeze the bot).
* **Limits**: none by default — see [Limits](#limits) for the caps you can turn on (recommended when hosting for others).
  The login and dashboard-API rate limits are always on.
* **Outbound requests** (feeds, YouTube, Twitch) go through **one guarded fetcher** that flows can never call directly — there is still deliberately **no HTTP-request node**.
  Only `https` on the standard port, no user names or passwords in the address, no raw IP addresses or local names. The name is resolved by the fetcher itself and
  the connection is refused if *any* answer is a private, loopback, link-local (`169.254.169.254`), shared, multicast or reserved address — IPv4 and IPv6, including mapped and
  NAT64/6to4/Teredo forms — checked on **every** connection, so a name that changes its answer later (DNS rebinding) is caught. Redirects are followed by hand (3 at most), each
  hop judged again; 10 s per request; the answer is cut off at 1 MB counted after decompression. Feeds are read by a small parser that never expands entities or DTDs, so
  “billion laughs” and XXE files are inert. Feed text is plain text, feed links must be http(s) and pictures https.
* **Webhooks** (the only other unauthenticated way in): a 256-bit random address per trigger (its own table, never in the flow, never exported or copied), compared only by lookup;
  its own small body limit, JSON/form/text only, rate limits per address and per IP (with a stricter one for wrong guesses), the payload is reshaped to plain data (depth, key count
  and string length capped, `__proto__` dropped) and treated as text, never as a template.

## Hosting notes

* Put HTTPS in front (Caddy/nginx), set `BASE_URL=https://…` and `TRUST_PROXY=1`. Cookies become `Secure` automatically.
* One process, no sharding — fine up to a couple of thousand servers. The bot caches everything discord.js caches by default.
* Back up `DATA_DIR/flowbot.sqlite` **and** `DATA_DIR/uploads/` together (a database row without its file shows a missing picture).
  Deleting a server's flows/variables is up to you (data is kept if the bot is removed).

## Development

```bash
npm test          # 657 unit + API + event + button/transcript + public-page + upload + draft/live + access + maths + counter + cron/schedule + role-check/title + guarded-fetch/feed/webhook/platform-alert tests (fake Discord objects, in-memory SQLite, a fake clock, a pretend network)
npm run build     # production web bundle → dist/
npm run e2e       # browser check against the demo server (CHROMIUM_PATH=/path/to/chrome if needed)
npm run docs      # regenerate docs/NODES.md from the catalog
```

```
shared/   catalog.js (every node) · blocks.js (page blocks) · forms.js · render-page.js · page-meta.js (link previews) · validate.js · templates — used by the editor AND server
server/   app/api/auth/public (the /s pages) · hooks (the /hooks webhook addresses) · uploads + images (the /i pictures) · db (node:sqlite) · engine/ (runner, templates, executors, responder, watchers) · net/ (the guarded fetcher) · feeds/ (feed parser, YouTube, Twitch) · bot/ (events, commands)
web/      React + @xyflow/react editor
test/     node:test suites · e2e/ (Playwright) · helpers/fakes.js
```

Adding a node type = one entry in `shared/catalog.js` + one executor in `server/engine/executors/` (a test fails if a
node has no executor).

## Smoke test against real Discord

Not yet automated — please run through this once on a test server:

- [ ] Login works, the server appears, *Add bot* link opens the right server.
- [ ] `/ticket` template: channel is created privately, the reply is ephemeral, **Close** saves a transcript and deletes the channel.
- [ ] A slash command that takes > 3 s still answers (auto-defer).
- [ ] Button role panel: ▶ Run posts the panel; each button toggles its own role (press three times: added, removed, added).
- [ ] Ticket panel: ▶ Run posts the panel; pressing **Open a ticket** twice quickly gives one private channel, one private
      reply and one “please wait” message; **Close ticket** mentions the person who opened it and deletes the channel.
- [ ] Transcript: with a log channel picked, **Close** posts an `.html` and a `.txt` file there and DMs the opener both; open the `.html` in a browser and the `.txt` in a text editor
      (with `ENABLE_MESSAGE_CONTENT_INTENT` on they show the text; off, they say the text is hidden). Check the `.txt` on a phone too, and
      that Discord accepts both files in the DM. With the opener's DMs closed the ticket still
      closes; with no log channel the ticket stays open and says why.
- [ ] Boosts: boost the server with a test account → *Member Boosted Server* fires once (not again for a second boost); remove the boost
      → *Member Stopped Boosting* fires. Check it still fires for a member who was not cached (restart the bot first).
- [ ] Schedules: set *At a set time of day* two minutes ahead in your own time zone — the log shows one “▶ … Schedule” run in that minute
      and none after it; restart the bot and it does not run again. A cron schedule of `*/5 * * * *` runs on the clock (10:05, 10:10 …), and saving
      other flows does not delay an “Every 1 hour” schedule.
- [ ] On a real phone (iOS Safari and Android Chrome): log in, open a flow from ☰, pan and zoom, tap a node and edit a field (the page must not zoom), connect two
      nodes by dragging, add one from **Nodes**, save; open the page builder, switch the three tabs, publish; open a published page and its link preview.
- [ ] Role check: a *Condition* with “has the role” follows True for a member with the role and False without it; give and take the role and run again
      (it must notice at once); with Member set to someone else it looks at them; delete the role and it says “no” and the log warns.
- [ ] Feeds (needs the real internet): a *New Feed Item* on a YouTube channel ID, a subreddit and a Bluesky handle each log “Now watching …” within a minute and announce nothing;
      upload / post something and, within the interval, the flow posts it exactly once; restart the bot and it is not posted again. Point one at a wrong address and the log says why,
      once. An `http://` or `https://localhost/` address is refused in the editor.
- [ ] Webhook: save a *Webhook Received* flow, copy its address, `curl -X POST` it with JSON → `202` and the message appears; *Generate a new address* → the old one answers `404`.
      Call it from Zapier/IFTTT/StreamElements once with a real X / TikTok / Instagram / Facebook / follower event and check which fields you can use.
- [ ] YouTube Subscribers with a real key: the log says the current count; a wrong key says the operator's key was refused (and never prints it). Twitch Channel Live with a real
      application: go live on a test channel → one announcement; stay live → none; end and start again → one more. With no key set the nodes show “not set up”.
- [ ] Two accounts press the same panel button at the same time: each only sees their own variables.
- [ ] Change Buttons on a real message: post a panel with *Send Message* (save its ID), then run a flow with *Change Buttons* — *Add* a button with a Button ID and press it (a
      *Button Clicked* flow answers), *Add* one without an ID wired to an output and press it, *Disable* one (it greys out and cannot be pressed), *Enable* it again, *Remove* it by label,
      *Remove all buttons* (text stays), *Delete the message* (also on a message someone else posted, with *Manage Messages*). Check a message with a select menu keeps its menu, and that with **This message** a pressed button can change or delete its own message, while **A previous message** with a stored ID reaches an earlier one (and an empty ID is refused).
- [ ] *Panel that comes back if it is deleted* template: pick a channel in the Manual trigger, switch on, ▶ Run → the panel appears; delete it → it reappears within a second or two;
      restart the bot, delete it again → it still reappears; delete some other message → nothing happens.
- [ ] Embeds: *Send Message* with two embeds — one with an author (name, icon, link), a title link and a footer icon — and check Discord shows both, with the icons and links working.
      Then *Edit Message* on that message (“A previous message”): change **only** the description of embed 1 (everything else, embed 2 and the text stay), remove the footer, add a third embed,
      replace the text only, remove all embeds; and “This message” from a button press. Try an edit that would leave the message empty — it must be refused, not sent.
- [ ] Channel variables: with *Set Variable* (scope *Channel*) count something in two channels — each counts on its own; delete one channel and its variables disappear from the
      *Remembered variables* dialog.
- [ ] Counters: switch on the *Member counter* template, pick a channel, then have several people join/leave within a few minutes —
      the first two renames appear at once, the log says the next is held back, and about ten minutes later the name settles on the
      correct member count. Repeat with the *Join counter* (server variable `joins`); check `{{guild.memberCount}}` is right at the
      moment of a real join, and that a held rename never triggers a *Channel Updated* flow.
- [ ] Use one Button ID in two flows: the log warns that the newer flow is ignored for it.
- [ ] Member Joined (with the Members intent) greets and gives a role; Kicked vs Left is told apart (with *View Audit Log*).
- [ ] Reaction Added with message + emoji filter gives a role.
- [ ] A second admin account in *another* server cannot see or edit the first server's flows.
- [ ] Link preview: paste a published page's link into a Discord channel — the card shows the title, description and picture (needs a public `BASE_URL`).
- [ ] Draft vs live: edit a published page and save — the public page must not change until you press Publish changes.
- [ ] Gated pages: set a page to a role; a member with the role opens it, a member without it is refused, a non-member and a logged-out visitor are asked to log in / refused.
- [ ] Pages: publish a page with a form; open it in a private window — **Log in with Discord** works on your real domain and returns
      you to the page; a member can submit; a non-member of a members-only form is told why; the Form Submitted flow reacts.
- [ ] A form with “redirect to another address” lands on that address; the response and its CSV appear in the dashboard.
- [ ] Pictures: upload a photo taken with a phone (it comes out upright, without location data); pick it for a page and open the
      public page in a private window; on your real domain, use an uploaded picture in a *Send Message* embed and check Discord shows it.
- [ ] `DATA_DIR/uploads/` is part of your backup; restoring the database and the folder together brings the pictures back.
- [ ] Bot restarts: an old button still works and still knows who opened its ticket (`{{original.user.mention}}`); slash commands are not re-registered needlessly.
- [ ] Build a flow that loops forever (two Log nodes pointing at each other), run it, confirm other commands still answer,
      then switch the flow Off and confirm it stops.

## Ideas not done yet

Page columns/nesting, picture cropping and alt-text suggestions, custom domains, page analytics, email/webhook notifications for forms, an outbound HTTP/webhook node, watching X/TikTok/Instagram/Facebook/Twitch followers directly (needs each account's own consent), autocomplete options, sub-commands, embed preview, undo/redo, flow version history,
sharding.
