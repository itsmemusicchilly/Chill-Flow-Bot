import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits, PermissionsBitField, Partials } from 'discord.js';
import { wireEvents } from './events.js';

const INVITE_PERMISSIONS = [
  'ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory', 'AddReactions', 'AttachFiles', 'UseExternalEmojis',
  'ManageChannels', 'ManageRoles', 'ManageMessages', 'ManageNicknames', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog',
];
const LISTED_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum]);
const PERM_CACHE_MS = 60_000;

export class BotManager {
  constructor({ config, runtime, logger, sync }) {
    this.config = config; this.runtime = runtime; this.logger = logger; this.sync = sync;
    this.client = null;
    this.ready = false;
    this.permCache = new Map();
  }

  async start() {
    const { intents } = this.config;
    const flags = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates];
    if (intents.members) flags.push(GatewayIntentBits.GuildMembers);
    if (intents.messageContent) flags.push(GatewayIntentBits.MessageContent);
    this.client = new Client({
      intents: flags,
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
      allowedMentions: { parse: ['users'] },
    });
    this.runtime.attachClient(this.client);
    wireEvents({ client: this.client, runtime: this.runtime, logger: this.logger, sync: this.sync });
    this.client.once(Events.ClientReady, async (c) => {
      this.ready = true;
      this.logger.log(null, 'info', `Bot online as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
      this.runtime.loadAll();
      for (const guild of c.guilds.cache.values()) { await this.sync.sync(guild.id).catch(() => {}); }
    });
    this.client.on(Events.Error, (err) => this.logger.log(null, 'error', `Discord client error: ${err.message}`));
    await this.client.login(this.config.token);
  }

  async stop() { await this.runtime.stop(); await this.client?.destroy(); this.ready = false; }

  // ---- what the web API needs -------------------------------------------------------------------
  hasGuild(id) { return Boolean(this.client?.guilds.cache.has(id)); }
  #guild(id) { return this.client?.guilds.cache.get(id); }

  /** Live check (cached briefly): is this person allowed to edit this server's flows? */
  async canManage(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const hit = this.permCache.get(key);
    if (hit && Date.now() - hit.at < PERM_CACHE_MS) return hit.ok;
    const guild = this.#guild(guildId);
    let ok = false;
    if (guild) {
      if (guild.ownerId === userId) ok = true;
      else {
        const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
        if (member) {
          ok = member.permissions.has(PermissionFlagsBits.Administrator)
            || (this.config.minPermission === 'ManageGuild' && member.permissions.has(PermissionFlagsBits.ManageGuild));
        }
      }
    }
    if (this.permCache.size > 5000) this.permCache.clear();
    this.permCache.set(key, { ok, at: Date.now() });
    return ok;
  }

  guildSummary(id) {
    const g = this.#guild(id);
    if (!g) return null;
    return { id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) ?? null, memberCount: g.memberCount };
  }

  botPermissions(id) { return this.#guild(id)?.members.me?.permissions.toArray() ?? []; }

  channels(id) {
    const g = this.#guild(id);
    if (!g) return [];
    return [...g.channels.cache.values()]
      .filter((c) => LISTED_CHANNEL_TYPES.has(c.type))
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
      .map((c) => ({ id: c.id, name: c.name, type: ChannelType[c.type], parentId: c.parentId ?? null }));
  }

  roles(id) {
    const g = this.#guild(id);
    if (!g) return [];
    return [...g.roles.cache.values()].filter((r) => r.id !== g.id).sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, managed: r.managed }));
  }

  inviteUrl(guildId) {
    const perms = new PermissionsBitField(INVITE_PERMISSIONS.map((p) => PermissionFlagsBits[p])).bitfield.toString();
    const u = new URL('https://discord.com/oauth2/authorize');
    u.searchParams.set('client_id', this.config.clientId);
    u.searchParams.set('scope', 'bot applications.commands');
    u.searchParams.set('permissions', perms);
    if (guildId) { u.searchParams.set('guild_id', guildId); u.searchParams.set('disable_guild_select', 'true'); }
    return u.toString();
  }
}
