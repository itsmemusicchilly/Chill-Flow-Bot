# Flowbot — build a Discord bot with flowcharts

One shared Discord bot whose behaviour **server admins design in a web flowchart editor**. Pick a trigger
(a slash command, someone joining, a reaction…), connect actions (send a message with buttons, give a role, create a
channel, remember a variable…), press **Save** — it is live. No code.

```
 Slash Command /ticket ─▶ Create Channel ─▶ Send Message ──┬─ Next
                                             [🔒 Close]     ├─ 🔒 Close ─▶ Send Message ─▶ Wait 5s ─▶ Delete Channel
                                                            └─ On error
```

* **Multi-server, Discord login.** Admins sign in with Discord and can only edit servers where they are an
  administrator (configurable). Every flow, variable, slash command and log is scoped to one server.
* **Every button is its own path.** A *Send Message* node can carry several buttons and a select menu; each one becomes an
  output you connect to whatever should happen next.
* **49 nodes**: 23 triggers (commands, messages, joins/leaves/kicks/bans/timeouts, role and channel events, reactions,
  voice, schedule, manual) and 26 actions/logic nodes (messages with buttons/menus/forms, member moderation, channels,
  roles, variables, conditions, loops, cooldowns, waits). Full list: [docs/NODES.md](docs/NODES.md).
* **Remembers things**: run, per-server and per-user variables, usable everywhere as `{{templates}}`.
* Live per-server **logs** with the executing node flashing on the canvas, import/export as JSON, starter templates.

> **Status:** the engine, API, security rules and editor are covered by automated tests (89 unit/integration tests plus a
> 20-check browser run against a fake Discord). It has **not** yet been run against the real Discord gateway — see the
> [smoke-test checklist](#smoke-test-against-real-discord) before you rely on it.

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
| `DATA_DIR` | `data` | Where `flowbot.sqlite` lives. Back this up |
| `DASHBOARD_MIN_PERMISSION` | `Administrator` | Or `ManageGuild`. Flows run with the **bot's** permissions, so the default is the safe one |
| `ENABLE_MEMBERS_INTENT` | `false` | Needed by *Member Joined / Left / Kicked / Timed Out* and *Role Given/Removed* triggers |
| `ENABLE_MESSAGE_CONTENT_INTENT` | `false` | Needed by the *Message Received* trigger |

Triggers whose intent is off are greyed out in the palette and never activated (their node shows why).

Development with hot reload: `npm run dev` (server + Vite). Set `BASE_URL=http://localhost:5173` and add
`http://localhost:5173/auth/callback` as a redirect so login and the `Origin` check line up.

## How flows behave

* **Triggers** start a flow; everything connected after them runs in order. When one output goes to several nodes they
  run **top to bottom**, then left to right.
* **Errors**: every action has an **On error** output. Connect it to react (`{{error.message}}`); unconnected, the error
  is logged and that branch ends. Interactions never end with Discord's red “interaction failed”.
* **Slow flows** are fine: after ~2 s the bot defers the reply for you, and the next *Send Message → reply* fills it in.
* **Buttons & menus** are routed by their custom id, so they keep working after restarts. Run variables (`{{var.x}}`) are
  remembered *in memory* per message, so they survive edits but not a restart. `{{original.user.name}}` etc. refer to
  whoever/whatever created the message.
* **Forms (modals)** must be the first thing a command/button does; answers are `{{input.<id>}}`.
* **No feedback loops**: changes the bot makes itself (a role it gave, a channel it created) do not trigger flows unless you
  tick *Also run for changes made by this bot*.
* **Kick vs leave, who banned whom**: read from the audit log — give the bot *View Audit Log* or kicks look like leaves.
* **Slash commands** are registered per server when you save (instant, no global propagation delay).

### Templates

`{{path}}` works in any text field. Add filters with `|`: `{{user.name | upper}}`, `{{option.reason | default:none}}`.

| | |
| --- | --- |
| `user.id .name .displayName .mention .tag .avatar .isBot` | who triggered the flow (or who the event is about) |
| `member.nickname .joinedAt .roleIds .permissions` | their server membership |
| `guild.id .name .memberCount` | the server |
| `channel.id .name .mention .type`, `message.id .content .url .after`, `role.*`, `emoji.*` | event details |
| `option.<name>` | slash-command options |
| `input.<id>`, `select.value`, `original.*` | forms, menus, the message that a button belongs to |
| `var.<name>` | run variable (or something saved by *Save … as variable*) |
| `user.vars.<name>`, `guild.vars.<name>` | remembered per-user / per-server variables |
| `loop.index .item`, `error.message`, `cooldown.remaining`, `now.iso .date .time .timestamp` | misc |
| `executor.*`, `reason`, `timeout.*` | moderator details for kick/ban/timeout triggers |

Filters: `default:x`, `upper`, `lower`, `trim`, `length`, `json`, `round`. Substituted text is never evaluated again, so
member-supplied text cannot inject templates.

## Security model

This is a multi-tenant service: many servers share one bot process, so isolation is enforced in code and covered by tests.

* **Login**: Discord OAuth2 (`identify guilds`) with a one-time `state` cookie. The access token is used once, **revoked and
  never stored**; sessions are random ids (only a hash is kept) in `HttpOnly; SameSite=Lax` cookies.
* **Authorisation**: every server-scoped request re-checks, live through the bot, that you are the owner/Administrator
  (cached ≤ 60 s). Stale sessions cannot keep access after a demotion. Flow lookups are always filtered by server id.
* **CSRF**: state-changing requests must come from `BASE_URL`'s origin; security headers + a strict CSP are sent.
* **Execution isolation**: executors only resolve channels, roles and members through the flow's own server and re-check
  ownership, so pasting a foreign id does nothing. DMs go only to members of that server. Variables are per server
  (there is deliberately no global scope). Logs are per server and never persisted.
* **Safe defaults**: `@everyone`/role pings are off unless a node opts in; audit-log reasons say `[Flow name]`;
  user-supplied regexes run under a hard timeout (a catastrophic pattern cannot freeze the bot).
* **Limits** (per server): 25 flows, 150 nodes/flow, 2000 stored variables (8 KB each), 40 runs / 10 s, 15 concurrent
  runs, 25 Discord actions / 10 s, 500 steps per run, loops ≤ 100 iterations, waits ≤ 5 min.
* Deliberately **not included**: an HTTP-request node (server-side request forgery risk in a shared host).

## Hosting notes

* Put HTTPS in front (Caddy/nginx), set `BASE_URL=https://…` and `TRUST_PROXY=1`. Cookies become `Secure` automatically.
* One process, no sharding — fine up to a couple of thousand servers. The bot caches everything discord.js caches by default.
* Back up `DATA_DIR/flowbot.sqlite`. Deleting a server's flows/variables is up to you (data is kept if the bot is removed).

## Development

```bash
npm test          # 89 unit + API + event tests (fake Discord objects, in-memory SQLite)
npm run build     # production web bundle → dist/
npm run e2e       # browser check against the demo server (CHROMIUM_PATH=/path/to/chrome if needed)
npm run docs      # regenerate docs/NODES.md from the catalog
```

```
shared/   catalog.js (every node: fields, outputs, summaries) · validate.js · templates.js — used by the editor AND server
server/   app/api/auth · db (node:sqlite) · engine/ (runner, templates, executors, responder) · bot/ (events, commands)
web/      React + @xyflow/react editor
test/     node:test suites · e2e/ (Playwright) · helpers/fakes.js
```

Adding a node type = one entry in `shared/catalog.js` + one executor in `server/engine/executors/` (a test fails if a
node has no executor).

## Smoke test against real Discord

Not yet automated — please run through this once on a test server:

- [ ] Login works, the server appears, *Add bot* link opens the right server.
- [ ] `/ticket` template: channel is created privately, the reply is ephemeral, **Close** deletes the channel.
- [ ] A slash command that takes > 3 s still answers (auto-defer).
- [ ] Button role panel: ▶ Run posts the panel; each button gives its own role.
- [ ] Member Joined (with the Members intent) greets and gives a role; Kicked vs Left is told apart (with *View Audit Log*).
- [ ] Reaction Added with message + emoji filter gives a role.
- [ ] A second admin account in *another* server cannot see or edit the first server's flows.
- [ ] Bot restarts: an old button still works; slash commands are not re-registered needlessly.

## Ideas not done yet

HTTP/webhook node with SSRF protection, autocomplete options, sub-commands, embed preview, undo/redo, flow version history,
persisting run variables across restarts, sharding.
