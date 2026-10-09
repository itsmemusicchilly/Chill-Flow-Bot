# Setup guide

How to run Chill Flow Bot on your own machine or server. Pick the section that matches where you want it to live:

| I want to run it on… | Go to | Stays on 24/7? |
| --- | --- | --- |
| a Windows PC | [Windows](#windows) | only while the PC is on |
| a Linux machine | [Linux](#linux) | yes |
| a Mac | [macOS](#macos) | only while the Mac is on |
| a Raspberry Pi | [Raspberry Pi](#raspberry-pi) | yes (cheap and quiet) |
| a home-lab NAS (Synology, QNAP, Unraid, TrueNAS, OpenMediaVault…) | [Home-lab NAS](#home-lab-nas-docker) | yes |
| a rented server (VPS) | [VPS](#vps-ubuntu--debian) | yes (recommended for most people) |
| Render | [Render](#render) | yes, on a paid instance with a disk |
| Vercel | [Vercel](#vercel) | no |
| Heroku | [Heroku](#heroku) | read the warning first |
| a game panel such as Pterodactyl | [Pterodactyl](#pterodactyl-and-other-game-panels) | yes |

> **What was tested.** The steps for Linux were run from a fresh copy of the project (install, build, start, health check), and the Dockerfile's steps were run the same way by hand
> (the image itself could not be built where this guide was written, because there was no Docker engine). The other platforms follow each platform's standard procedure but were **not run on that platform**.
> The Render steps follow Render's docs for web services, persistent disks, the free tier and the Node.js version. The Vercel section follows Vercel's own note that an always-on Discord bot does not fit Vercel. Neither was deployed from this project.
> If a step does not match what you see, the [common problems](#common-problems) table at the end is the place to look first.

---

## Before you start (every platform)

### 1. Create the Discord application

1. Open <https://discord.com/developers/applications> → **New Application**.
2. **General Information** → copy the **Application ID** (this is `DISCORD_CLIENT_ID`).
3. **Bot** → **Reset Token** → copy it (`DISCORD_TOKEN`). Treat it like a password; never share it or put it in a screenshot.
4. **OAuth2** → copy the **Client Secret** (`DISCORD_CLIENT_SECRET`), then under **Redirects** add `BASE_URL/auth/callback`, where `BASE_URL` is the address you will type in the browser
   (for a test on the same computer: `http://localhost:3000/auth/callback`; for a real server: `https://bot.example.com/auth/callback`). It must match exactly, including `http`/`https` and no trailing slash.
5. **Bot** → **Privileged Gateway Intents**: switch on **Server Members** and/or **Message Content** only if you want the triggers that need them, and set `ENABLE_MEMBERS_INTENT=true` / `ENABLE_MESSAGE_CONTENT_INTENT=true` in your `.env` to match (the README's *Configuration* table says which triggers need which).

### 2. The settings you will fill in

Every platform below ends up with the same settings, either in a file called **`.env`** (copy of `.env.example`) or, on hosts that have them, as "environment variables" / "startup variables".

| Setting | What to put | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | the bot token | required |
| `DISCORD_CLIENT_ID` | the Application ID | required |
| `DISCORD_CLIENT_SECRET` | the Client Secret | required |
| `BASE_URL` | the address people type to open the dashboard, e.g. `https://bot.example.com` | no trailing slash. Must be a **public** address if you want transcript links or uploaded pictures in messages to work |
| `PORT` | `3000` (default) | the port the dashboard listens on |
| `HOST` | `127.0.0.1` (default) = only this machine; `0.0.0.0` = reachable from other machines | **must be `0.0.0.0`** inside Docker, Render, Heroku and game panels |
| `TRUST_PROXY` | `1` when a reverse proxy (Caddy, nginx, a NAS's proxy) sits in front | lets the app see the real visitor address and use secure cookies |
| `YOUTUBE_API_KEY`, `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`, `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | keys from those platforms | optional: only for the YouTube / Twitch / TikTok triggers. For Twitch and TikTok *follower* counters, also add `BASE_URL/auth/twitch/callback` / `BASE_URL/auth/tiktok/callback` as redirect addresses in their developer consoles (TikTok needs `https`). See the README's *Counting subscribers and followers* |
| `TOKEN_ENCRYPTION_KEY` | a long random string | optional: seals the tokens of connected Twitch/TikTok accounts. Left out, `DISCORD_CLIENT_SECRET` is used |
| `DATA_DIR` | `data` (default) | where the database, uploaded pictures and saved transcripts live. **Keep it on a disk that survives restarts, and back it up** |

The program reads `.env` by itself when it starts, so you never *have* to set real environment variables. That matters on hosts that don't let you.

### 3. Four rules that fix most problems

* **Node.js 22.13 or newer** is required (check with `node -v`). Older versions fail with an error about `node:sqlite`.
* `npm run build` must be run once after you download the project (and after every update). Without it the dashboard says *"The web UI has not been built yet"*.
* The address in the browser, `BASE_URL` and the Discord redirect must all agree.
* Only the three secrets are required. Everything else has a sensible default.

### 4. After it is running (every platform)

1. Open `BASE_URL` in a browser → **Log in with Discord**.
2. Pick a server → **Add bot** (opens Discord; choose the server and accept the permissions) → back in the dashboard press **refresh**.
3. **+ New flow** → try the *Support tickets* template, fill the highlighted fields, switch it **On**.

---

## Windows

**You need:** Node.js 22 or newer (LTS is fine) and Git.

1. Install them. In PowerShell:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```
   (or use the installers from <https://nodejs.org> and <https://git-scm.com>). Close and reopen PowerShell, then check `node -v`.
2. Get the project and install it:
   ```powershell
   git clone https://github.com/itsmemusicchilly/Chill-Flow-Bot.git
   cd Chill-Flow-Bot
   npm ci
   npm run build
   ```
3. Create your settings file and open it in Notepad:
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
   Fill in the three secrets. For use on this PC only, leave `BASE_URL=http://localhost:3000`.
4. Start it:
   ```powershell
   npm start
   ```
   Open <http://localhost:3000>. If Windows Defender Firewall asks, allow **private networks** only. Leave the window open: closing it stops the bot.

**Keeping it running without a window** (it still only runs while the PC is on and logged in to the service):

* **NSSM** (simplest): install from <https://nssm.cc>, then in an *Administrator* PowerShell:
  ```powershell
  nssm install ChillFlowBot "C:\Program Files\nodejs\node.exe" "server\index.js"
  nssm set ChillFlowBot AppDirectory "C:\path\to\Chill-Flow-Bot"
  nssm start ChillFlowBot
  ```
  `AppDirectory` matters: that is where the program finds `.env` and the `data` folder.
* Or **Task Scheduler** → *Create Task* → trigger *At startup* → action *Start a program*: program `node`, arguments `server\index.js`, *Start in* the project folder; tick *Run whether user is logged on or not*.

**Update:** `git pull`, `npm ci`, `npm run build`, restart (stop and start the service/task).

A Windows PC is fine for trying things out. For a bot that should always be online, use a Pi, a NAS or a VPS.

---

## Linux

**You need:** Node.js 22+, Git. This is written for Debian/Ubuntu; other distributions work the same way with their own package manager.

1. Install Node.js 22 (NodeSource):
   ```bash
   sudo apt update && sudo apt install -y curl git ca-certificates
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   node -v     # v22.x or newer
   ```
   (Or use [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`. With nvm, use the full path of `node` in the service file below, e.g. `which node`.)
2. Get it, install, build:
   ```bash
   git clone https://github.com/itsmemusicchilly/Chill-Flow-Bot.git
   cd Chill-Flow-Bot
   npm ci
   npm run build
   cp .env.example .env
   nano .env            # fill in the three secrets, and BASE_URL
   npm start            # try it; stop with Ctrl+C
   ```
3. **Keep it running with systemd.** Create a service file (adjust the user and folder):
   ```bash
   sudo nano /etc/systemd/system/flowbot.service
   ```
   ```ini
   [Unit]
   Description=Chill Flow Bot
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=youruser
   WorkingDirectory=/home/youruser/Chill-Flow-Bot
   ExecStart=/usr/bin/node server/index.js
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now flowbot
   systemctl status flowbot          # should say "active (running)"
   journalctl -u flowbot -f          # live log; Ctrl+C to leave
   ```
   `WorkingDirectory` is where `.env` and `data/` are found. To reach the dashboard from other computers, set `HOST=0.0.0.0` in `.env` (and see [VPS](#vps-ubuntu--debian) for putting HTTPS in front).
4. **Update:**
   ```bash
   cd ~/Chill-Flow-Bot && git pull && npm ci && npm run build && sudo systemctl restart flowbot
   ```

---

## macOS

**You need:** [Homebrew](https://brew.sh), then Node.js and Git.

```bash
brew install node git
node -v                  # 22.13 or newer
git clone https://github.com/itsmemusicchilly/Chill-Flow-Bot.git
cd Chill-Flow-Bot
npm ci
npm run build
cp .env.example .env
open -e .env             # fill in the three secrets
npm start                # → http://localhost:3000
```

**Keep it running (starts when you log in):** create `~/Library/LaunchAgents/com.chillflowbot.plist`, changing the three paths (find your node with `which node`; Apple Silicon is `/opt/homebrew/bin/node`, Intel is `/usr/local/bin/node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chillflowbot</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/node</string><string>server/index.js</string></array>
  <key>WorkingDirectory</key><string>/Users/you/Chill-Flow-Bot</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Chill-Flow-Bot/flowbot.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Chill-Flow-Bot/flowbot.log</string>
</dict>
</plist>
```
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chillflowbot.plist
launchctl list | grep chillflowbot       # it is running
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.chillflowbot.plist   # to stop it
```
The Mac must be awake and logged in: for an always-on bot, a Pi, NAS or VPS is the better home. **Update:** `git pull && npm ci && npm run build`, then `bootout` and `bootstrap` again.

---

## Raspberry Pi

A Pi 3 or newer with **64-bit Raspberry Pi OS** (Bookworm or newer) is plenty for a few servers. Use a decent SD card or, better, a USB SSD: the database is written to often.

1. Update and install Node.js 22 exactly as in [Linux](#linux) (NodeSource supports 64-bit ARM; `node -v` must show 22.13+). The picture library (`sharp`) ships a ready-made ARM64 build, so nothing needs compiling.
2. Clone, `npm ci`, `npm run build`, create `.env`, then follow the **systemd** steps from [Linux](#linux) (the user is usually `pi` or the name you chose; the folder `/home/<user>/Chill-Flow-Bot`).
3. **Low on memory (1 GB or less)?** The one heavy step is `npm run build`. Either add some swap first
   ```bash
   sudo dphys-swapfile swapoff && sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile && sudo dphys-swapfile setup && sudo dphys-swapfile swapon
   ```
   or build on a bigger computer (`npm ci && npm run build`) and copy the finished `dist/` folder to the Pi (`scp -r dist pi@raspberrypi.local:~/Chill-Flow-Bot/`). After that the Pi only has to *run* it.
4. **From outside your home:** your router does not let the internet in by default. Either forward ports 80 and 443 to the Pi and put [Caddy](#vps-ubuntu--debian) in front, or use a tunnel that needs no open ports (see [No public address at home](#no-public-address-at-home)).
5. Pictures and transcripts live in `~/Chill-Flow-Bot/data/`: back that folder up (copy it to another machine now and then).

---

## Home-lab NAS (Docker)

Every NAS that can run Docker can run the bot: Synology (Container Manager), QNAP (Container Station), Unraid, TrueNAS SCALE, OpenMediaVault (Docker/Compose plugin), and also any PC or VPS with Docker. The project comes with a `Dockerfile` and a `docker-compose.yml`.

1. Put the project folder on the NAS (clone it over SSH, or download the ZIP from GitHub and extract it, e.g. to `/volume1/docker/flowbot` on a Synology).
2. In that folder create `.env` from `.env.example` and fill in the three secrets and `BASE_URL`. **You do not need to set `HOST`, `PORT` or `DATA_DIR`: the compose file sets them.**
3. Start it (over SSH, or with your NAS's *Project/Compose* screen pointed at this folder):
   ```bash
   docker compose up -d --build
   docker compose logs -f           # watch it start; Ctrl+C leaves the log
   ```
   The dashboard is now on `http://<nas-address>:3000`. To use another port, change the **left** number in `ports:` (`"8080:3000"`), and make `BASE_URL` and the Discord redirect match.
4. **Data:** the compose file keeps the database, pictures and transcripts in a Docker volume called `flowbot-data`. If you would rather have a plain folder you can see and back up, replace the volume line with a folder, e.g. `- /volume1/docker/flowbot-data:/data`. The container runs as user `node` (id 1000), so that folder must be writable by it (`sudo chown -R 1000:1000 /volume1/docker/flowbot-data`; on Synology you can instead add `user: "1026:100"` under the service, with your own user and group ids).
5. **HTTPS from outside:** use the NAS's own reverse proxy (Synology: *Control Panel → Login Portal → Advanced → Reverse Proxy*; or Nginx Proxy Manager, Traefik, Caddy) to send `https://bot.yourdomain.com` to `http://localhost:3000`, then set `TRUST_PROXY=1` and `BASE_URL=https://bot.yourdomain.com` in `.env` and run `docker compose up -d` again. No domain or open ports? See [No public address at home](#no-public-address-at-home).
6. **Update:** `git pull` (or replace the files), then `docker compose up -d --build`. The data volume is untouched.
7. **Back up** the `flowbot-data` volume or your data folder (stop the container first for a clean copy: `docker compose stop`, copy, `docker compose start`).

Unraid and TrueNAS: use their *Docker Compose* app/plugin with the same two files; the settings are the same.

---

## VPS (Ubuntu / Debian)

The best home for a bot that must always be online: a small server (1 GB of memory is enough) with a domain name. This walks through a fresh Ubuntu 22.04/24.04 or Debian 12 server.

1. **Point a domain at it.** In your DNS provider add an **A record** (for example `bot.example.com` → the server's IP address). Wait a few minutes.
2. **Log in and make a normal user** (do not run the bot as root):
   ```bash
   ssh root@your.server.ip
   apt update && apt install -y sudo      # some minimal Debian images do not have sudo
   adduser flowbot && usermod -aG sudo flowbot
   su - flowbot
   ```
3. **Firewall** (only SSH and the web ports; the bot itself stays private on port 3000):
   ```bash
   sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
   ```
4. **Install the bot** exactly as in [Linux](#linux) steps 1–2 (Node 22, clone, `npm ci`, `npm run build`, `cp .env.example .env`). In `.env` set:
   ```ini
   DISCORD_TOKEN=…
   DISCORD_CLIENT_ID=…
   DISCORD_CLIENT_SECRET=…
   BASE_URL=https://bot.example.com
   TRUST_PROXY=1
   ```
   Leave `HOST` alone (`127.0.0.1`): only the web server on the same machine talks to the bot. Add `https://bot.example.com/auth/callback` as a Redirect in the Discord portal.
5. **Keep it running** with the systemd service from [Linux](#linux) step 3.
6. **HTTPS with Caddy** (it gets and renews the certificate by itself):
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   ```
   Put this in `/etc/caddy/Caddyfile` (replace everything in it), then `sudo systemctl reload caddy`:
   ```
   bot.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   *Prefer nginx?* `sudo apt install -y nginx certbot python3-certbot-nginx`, add a `server { server_name bot.example.com; location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; } }` block, then `sudo certbot --nginx -d bot.example.com`.
7. Open `https://bot.example.com`, log in, add the bot (see *After it is running* above).
8. **Update:** `cd ~/Chill-Flow-Bot && git pull && npm ci && npm run build && sudo systemctl restart flowbot`.
9. **Back up** the `data/` folder (database, pictures, transcripts). A simple nightly copy: stop, copy, start (`sudo systemctl stop flowbot && cp -a ~/Chill-Flow-Bot/data /backup/flowbot-$(date +%F) && sudo systemctl start flowbot`), ideally to another machine. Your provider's server snapshots work too.

---

## Heroku

> **Read this first.** Heroku's disk is **temporary**: it is wiped every time the app restarts, is redeployed, or at least once a day. The bot keeps its flows, variables, uploaded pictures and saved transcripts in files on disk, so on Heroku **you would lose them regularly**. Use Heroku only to try the editor out. For a real bot use a [VPS](#vps-ubuntu--debian), [Render](#render) (a paid instance with a disk), a [NAS/Docker host](#home-lab-nas-docker), a Pi, or a [panel with persistent storage](#pterodactyl-and-other-game-panels).
> Also, free-tier and Eco dynos **go to sleep** when nobody visits the web page, which takes the bot offline. You need at least a *Basic* dyno for the bot to stay connected.

If you still want to try it:

1. Install the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) and log in (`heroku login`).
2. From the project folder:
   ```bash
   heroku create my-flowbot
   heroku config:set \
     DISCORD_TOKEN=… DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… \
     BASE_URL=https://my-flowbot.herokuapp.com HOST=0.0.0.0 TRUST_PROXY=1
   git push heroku master
   heroku ps:scale web=1
   heroku logs --tail
   ```
   (`git push heroku main` if your branch is called `main`.) The included `Procfile` starts the bot; Heroku supplies `PORT` by itself, and runs `npm run build` for you because the project has a `build` script.
3. Add `https://my-flowbot.herokuapp.com/auth/callback` as a Redirect in the Discord portal.
4. There is no `.env` on Heroku (it is not part of the Git repository), so every setting goes in `heroku config:set`.

---

## Render

Render runs the bot as one web service: a public `https://….onrender.com` address, and, on a paid instance, a disk that keeps the database, pictures and transcripts.

> **Read this first.** A **free** Render web service sleeps after 15 minutes with nobody opening the site, and it cannot keep a disk. The bot's own connection to Discord does not count as a visitor, so the bot goes offline in Discord and the next start has an empty `DATA_DIR` (flows and pictures are gone). Use a **paid** instance — the smallest is enough for one bot — and attach a persistent disk. Keep it at **one** instance: a second copy would log in with the same token and fight the first, and a disk can only be attached to one instance.

1. Sign up at <https://dashboard.render.com> and click **New → Web Service**.
2. Connect `https://github.com/itsmemusicchilly/Chill-Flow-Bot`. Use your Git provider if the repo is yours, or **Public Git Repository** if you are deploying the public repo. Branch: `master`.
3. Fill in the form:
   * **Language:** Node
   * **Build Command:** `npm ci && npm run build`
   * **Start Command:** `npm start`
   * **Instance type:** a paid instance, not Free
4. Open **Advanced**:
   * **Health Check Path:** `/healthz`
   * **Disk:** mount path `/var/data`, size 1 GB to start. You can make the disk larger later; you cannot make it smaller. Only files under this path survive a deploy or a restart.
   * **Environment variables.** Render has no `.env` file (that file is not in the Git repository). Add these keys:

   ```ini
   NODE_VERSION=22.22.0
   HOST=0.0.0.0
   DATA_DIR=/var/data
   TRUST_PROXY=1
   BASE_URL=https://YOUR-SERVICE.onrender.com
   DISCORD_TOKEN=your-bot-token
   DISCORD_CLIENT_ID=your-application-id
   DISCORD_CLIENT_SECRET=your-client-secret
   ```

   Use the `onrender.com` address Render shows for this service, with no trailing slash. Leave `PORT` unset: Render sets it (it defaults to `10000`) and the program reads that value.

   `NODE_VERSION` matters. The project needs Node **22.13 or newer** because it uses `node:sqlite`. `package.json` says `>=22.13`, and Render reads a range with no upper limit as "the newest Node there is", which can be a later major version. `22.22.0` stays on Node 22.
5. Click **Create Web Service** and watch the deploy log. You want a line `Dashboard: https://…` and no error. Then open that address.
6. In the Discord portal, add `https://YOUR-SERVICE.onrender.com/auth/callback` as a Redirect. For Twitch or TikTok follower counters, also add `…/auth/twitch/callback` and `…/auth/tiktok/callback` (TikTok requires `https`, which this address already is).
7. Log in and add the bot (see *After it is running* above).

**Your own domain.** On the service, open **Settings → Custom Domains** and add it. Then set `BASE_URL` to `https://bot.example.com` (no trailing slash), update the Discord redirect to match, and save the variables with **Save and deploy**.

**Updates.** A repo connected through your Git provider deploys on every push to `master`. A **Public Git Repository** connection does not: use **Manual Deploy**. A service with a disk stops the old copy before the new one starts, so the bot is offline for a few seconds on each deploy. The disk is kept.

**Backups.** Render snapshots the disk once a day and keeps those snapshots for at least seven days. Restore from the service's **Disk** page; a restore replaces the whole disk. The files that matter, and that must be copied together, are `flowbot.sqlite`, `uploads/` and `transcripts/`, all under `/var/data`.

**Using the included Dockerfile instead.** Set **Language** to Docker and leave the build and start commands empty so the `Dockerfile` is used. It already runs `npm start` and sets `HOST=0.0.0.0` and `DATA_DIR=/data`. Mount the disk at `/data`. Still set the three Discord secrets, `BASE_URL` and `TRUST_PROXY=1`. Do not set `PORT`, `HOST`, `DATA_DIR` or `NODE_VERSION` (the image is Node 22). The image runs as user `node`. If the log says it cannot write `/data`, use the Node steps above.

---

## Vercel

> **This bot cannot run on Vercel.** Vercel starts a function when a request arrives, then stops it. Chill Flow Bot is one program that has to stay running: it holds a live connection to Discord, checks feeds and schedules on a timer, and stores flows, uploaded pictures and transcripts as files in `DATA_DIR`. Vercel does not keep that process running, and it does not keep those files. The dashboard is the same program, so it cannot be split off and hosted on Vercel by itself.
>
> Vercel's own guidance for an always-on Discord bot is to use a host that stays up. Use [Render](#render) (a paid instance with a disk), a [VPS](#vps-ubuntu--debian), a [NAS](#home-lab-nas-docker), or a [Raspberry Pi](#raspberry-pi).

---

## Pterodactyl and other game panels

Game-server panels (Pterodactyl, Pelican, and the hosts built on them) can run the bot because it is a plain Node.js program. Hosts differ in what they let you change, so this section is organised by **what your panel offers**. You do not need to add a new egg: the stock **Node.js** ("Generic Node.js") egg is enough.

### What you need from the panel

* A **Node.js egg**, and a **Node version of 22.13 or newer**. Look on the *Startup* tab for a *Docker image* dropdown and pick the Node **22** (or newer) image (typically named like `nodejs_22`). If the highest option is 18 or 20, the bot **will not start**: ask the host to add a newer image, or choose another host.
* **One network port** (the *Network* tab / *Allocation*). Note the number, e.g. `25565`: that is your `PORT`.
* **Persistent storage.** On a panel the server's files persist, so the database, pictures and transcripts are safe (back them up from the *Backups* tab, which is the folder `data/`).

### Step 1 — get the files onto the server

Choose what your egg or panel allows:

* **Egg with a Git address** (variables like *Git Repo Address*, *Branch*): set the address to `https://github.com/itsmemusicchilly/Chill-Flow-Bot.git`, branch `master`, and turn on *auto update* if it is offered. Then go to step 2 option **A** or **B**.
* **No Git, upload instead:** on your own computer download the project (GitHub → *Code → Download ZIP*) and extract it. Upload the contents with the panel's **File Manager**, or with **SFTP** (the SFTP address and user are on the panel's *Settings* tab; use a client such as WinSCP or FileZilla). Do not upload `node_modules`.

### Step 2 — the web page has to be built

The project's web page is built once with `npm run build`, which creates a folder called `dist/`. Many generic eggs only run `npm install` and `node <main file>`, which does **not** build it. You have three options:

* **A. You can edit the startup command** (a *Startup Command* box on the Startup tab): set it to
  ```
  npm install && npm run build && npm start
  ```
  After the first successful start you can shorten it to just `npm start`.
* **B. You can only set a "main file" (and the egg runs `npm install` itself):** build `dist/` on your own computer and upload it:
  ```bash
  npm ci
  npm run build
  ```
  Then upload the `dist` folder into the server's files (next to `server/`, `package.json`…). Set the main file to `server/index.js`. Do the same again after each update.
* **C. Your panel has a *console* you can type into, but no startup edits:** stop the server, use the panel's console/terminal if it offers one to run `npm install` and `npm run build` once, and keep the main file as `server/index.js`.

Without `dist/` the dashboard shows *"The web UI has not been built yet"* (everything else works).

### Step 3 — the settings

The program reads a file named **`.env`** itself, so this works even when the panel lets you set nothing:

* **If the panel has editable environment/startup variables** (for example a *Custom environment variables* box or one box per variable): add `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `HOST=0.0.0.0`, `PORT=<your allocated port>` and `BASE_URL`. If you can edit the startup command, you can also make the port automatic: `PORT={{SERVER_PORT}} HOST=0.0.0.0 npm start`.
* **If the panel offers no variables at all:** in the File Manager choose **New File**, name it exactly `.env` (turn on *show hidden files* if you cannot see it afterwards), and paste:
  ```ini
  DISCORD_TOKEN=your-bot-token
  DISCORD_CLIENT_ID=your-application-id
  DISCORD_CLIENT_SECRET=your-client-secret
  HOST=0.0.0.0
  PORT=25565
  BASE_URL=http://your-server-address:25565
  ```
  (use *your* allocated port, not 25565).

`HOST=0.0.0.0` is the line people forget: without it the dashboard only listens inside the container and the panel's port leads nowhere.

### Step 4 — the address (`BASE_URL`) and Discord

* Many panels give you only `IP:port`, so `BASE_URL` is `http://IP:port`, and the Discord redirect is `http://IP:port/auth/callback`. That works for the dashboard. Discord may refuse a plain-`http` redirect for a non-local address; if it does, put a domain with HTTPS in front (a sub-domain the host provides, your own domain pointing at the panel's proxy, or a free tunnel, see [No public address at home](#no-public-address-at-home)) and use that as `BASE_URL`.
* **Transcript links and uploaded pictures in messages** need a **public** `BASE_URL`, because Discord's servers (and your members) must reach it. On a private address a *Save Transcript* node set to "Both" just attaches the files, one set to "A link" reports an error, and uploaded pictures cannot be shown in messages.

### Step 5 — start it

Press **Start** and watch the console. You want to see `Dashboard: http://…` and no red error. Then open `BASE_URL` in a browser.

### If something is missing on your panel

| Your panel lacks… | Do this |
| --- | --- |
| a Node 22 image | Ask the host for one; or run it on a VPS/Pi/NAS instead |
| an editable startup command | Build `dist/` on your PC and upload it (option B above) |
| editable variables | Use the `.env` file |
| a place to type a Git address | Upload the files (ZIP → extract → File Manager or SFTP) |
| auto-update | Update by hand: upload the new files (keep `.env` and `data/`), rebuild `dist/`, restart |
| the ability to run `npm install` | Ask the host to enable it, or choose another host. Do **not** upload `node_modules` from your own computer: it contains files built for your computer's system, not the server's |

---

## No public address at home

A home network (Pi, NAS, PC) usually has no address that Discord and your members can reach. You only need one if you want to use the dashboard from outside your home, link transcripts, or show uploaded pictures in messages. Options:

* **Port forwarding + a domain:** forward ports 80 and 443 on your router to the machine running Caddy, and point a domain at your home IP (a dynamic-DNS service helps if the IP changes). Some internet providers share one address between many customers; then forwarding cannot work.
* **A tunnel** (no open ports): for example Cloudflare Tunnel (`cloudflared`) or Tailscale Funnel give you an `https://…` address that forwards to `http://localhost:3000`. Set `BASE_URL` to that address and add it to the Discord redirects.
* **Keep it private:** if only you use the dashboard from inside your home network, `BASE_URL=http://<machine-ip>:3000` with `HOST=0.0.0.0` is enough. The bot works fine; only the public-link features above are limited.

---

## Common problems

| What you see | Cause and fix |
| --- | --- |
| `Missing required environment variable(s): DISCORD_TOKEN…` | The `.env` file is missing, in the wrong folder (it must sit next to `package.json`, and the program must be started from that folder), or a value is empty. |
| *"The web UI has not been built yet. Run `npm run build`…"* | Run `npm run build` (or upload `dist/`) and restart. |
| Login ends on a Discord page saying **invalid redirect_uri** | The Redirect in the Discord portal is not exactly `BASE_URL/auth/callback`. Check `http` vs `https`, the port and the trailing slash. |
| Works on the machine itself, not from another device | `HOST` is still `127.0.0.1`: set `HOST=0.0.0.0`, check the firewall and (in Docker/panels) the published port. |
| `An invalid token was provided` / bot never comes online | A wrong or old `DISCORD_TOKEN`: *Reset Token* in the portal and paste the new one. |
| `Used disallowed intents` | You turned on `ENABLE_MEMBERS_INTENT` / `ENABLE_MESSAGE_CONTENT_INTENT` without switching the same intent on in the Developer Portal → Bot. |
| `EADDRINUSE` (address already in use) | Another program uses that port: change `PORT` (and `BASE_URL` / the Discord redirect / the Docker port mapping to match). |
| `No such built-in module: node:sqlite` or a `SyntaxError` on start | Node is older than 22.13. Update Node (`node -v`). |
| You are logged out all the time behind a proxy | Set `TRUST_PROXY=1` and make sure the proxy passes `X-Forwarded-Proto` (Caddy does this automatically). |
| Transcript links or uploaded pictures do not work | `BASE_URL` is not a public address (it is `localhost`, a private IP, or has no dot). Use your real domain. |
| Everything was reset after a restart | `DATA_DIR` is on a disk that is wiped (Heroku, a free Render service, Vercel, or a container without a volume). Put it on persistent storage. |

---

## Checklist

- [ ] `node -v` shows 22.13 or newer.
- [ ] `.env` has the three secrets and the right `BASE_URL`; the Discord redirect matches it.
- [ ] `npm run build` has been run (a `dist/` folder exists).
- [ ] The dashboard opens, **Log in with Discord** works, and your server appears.
- [ ] **Add bot** worked, the bot shows as online in your server, and the *Support tickets* template does what it should.
- [ ] The `data/` folder (or the Docker volume) is somewhere that survives restarts, and you know how to back it up.
- [ ] It starts again by itself after a reboot (systemd, launchd, NSSM, `restart: unless-stopped`, or your panel's auto-start).

---

*made by itsmemusicchilly*
