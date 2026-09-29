import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { AuditLogEvent, ChannelType, Events } from 'discord.js';
import { buildCommandDefs, CommandSync, hashDefs } from '../server/bot/commands.js';
import { wireEvents } from '../server/bot/events.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { Coll, edge, fakeChannel, fakeGuild, fakeUser, node } from './helpers/fakes.js';

let db; let runtime; let client; let guild; let logger; let auditEntries;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function install(nodes, edges, name = 'flow') {
  db.createFlow({ guildId: guild.id, name, graph: { nodes, edges } });
  runtime.loadGuild(guild.id);
}
const logs = () => logger.recent(guild.id).map((l) => l.message);

beforeEach(() => {
  db = new Database(':memory:');
  logger = new Logger({ console: false });
  runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true } });
  client = new EventEmitter();
  client.user = { id: 'BOT', username: 'flowbot' };
  guild = fakeGuild({ id: '111111' });
  auditEntries = [];
  guild.fetchAuditLogs = async ({ type }) => ({ entries: new Coll(auditEntries.filter((e) => e.action === type).map((e, i) => [String(i), e])) });
  runtime.attachClient(client);
  wireEvents({ client, runtime, logger, sync: { sync: async () => ({}) }, auditDelayMs: 0 });
});

const log = (msg) => node('l', 'logic.log', { message: msg });

describe('member events', () => {
  it('member join runs the flow with the member as {{user.*}} and skips bots by default', async () => {
    install([node('t', 'trigger.member.join'), log('welcome {{user.name}} #{{guild.memberCount}}')], [edge('t', 'l')]);
    const human = guild.addMember({ user: fakeUser({ id: '900001', username: 'newbie' }) });
    client.emit(Events.GuildMemberAdd, human);
    const bot = guild.addMember({ user: fakeUser({ id: '900002', username: 'somebot', bot: true }) });
    client.emit(Events.GuildMemberAdd, bot);
    await tick();
    assert.deepEqual(logs().filter((m) => m.startsWith('welcome')), ['welcome newbie #3']);
  });

  it('tells a kick from a voluntary leave and from a ban using the audit log', async () => {
    install([node('t1', 'trigger.member.leave'), node('t2', 'trigger.member.kicked'), node('l1', 'logic.log', { message: 'LEFT {{user.name}}' }), node('l2', 'logic.log', { message: 'KICKED {{user.name}} by {{executor.name}} ({{reason}})' })],
      [edge('t1', 'l1'), edge('t2', 'l2')]);
    const leaver = guild.addMember({ user: fakeUser({ id: '910001', username: 'leaver' }) });
    const kicked = guild.addMember({ user: fakeUser({ id: '910002', username: 'kicked' }) });
    const banned = guild.addMember({ user: fakeUser({ id: '910003', username: 'banned' }) });
    const mod = fakeUser({ id: '990001', username: 'mod' });
    auditEntries.push({ action: AuditLogEvent.MemberKick, target: { id: '910002' }, executor: mod, reason: 'spam', createdTimestamp: Date.now() });
    auditEntries.push({ action: AuditLogEvent.MemberBanAdd, target: { id: '910003' }, executor: mod, reason: 'bad', createdTimestamp: Date.now() });
    for (const m of [leaver, kicked, banned]) client.emit(Events.GuildMemberRemove, m);
    await tick(60);
    const got = logs().filter((m) => /^(LEFT|KICKED)/.test(m)).sort();
    assert.deepEqual(got, ['KICKED kicked by mod (spam)', 'LEFT leaver']);
  });

  it('ignores stale audit entries', async () => {
    install([node('t', 'trigger.member.leave'), log('LEFT')], [edge('t', 'l')]);
    auditEntries.push({ action: AuditLogEvent.MemberKick, target: { id: '910004' }, executor: fakeUser(), createdTimestamp: Date.now() - 60000 });
    client.emit(Events.GuildMemberRemove, guild.addMember({ user: fakeUser({ id: '910004' }) }));
    await tick(40);
    assert.ok(logs().includes('LEFT'));
  });

  it('bans: reports the moderator, and ignores bans made by the bot itself unless asked', async () => {
    install([node('t', 'trigger.member.banned', { ignoreBots: false }), node('l', 'logic.log', { message: 'BAN {{user.name}} by {{executor.name}}' })], [edge('t', 'l')]);
    const target = fakeUser({ id: '920001', username: 'troll' });
    auditEntries.push({ action: AuditLogEvent.MemberBanAdd, target: { id: '920001' }, executor: fakeUser({ id: '990002', username: 'modder' }), reason: 'x', createdTimestamp: Date.now() });
    client.emit(Events.GuildBanAdd, { guild, user: target, reason: null });
    await tick(40);
    assert.ok(logs().includes('BAN troll by modder'));
    runtime.services.selfActions.expect(`ban:${guild.id}:920002`);
    client.emit(Events.GuildBanAdd, { guild, user: fakeUser({ id: '920002', username: 'byBot' }), reason: null });
    await tick(40);
    assert.ok(!logs().some((m) => m.startsWith('BAN byBot')), 'bot-caused bans do not trigger the flow');
  });

  it('a ban does not also count as a leave', async () => {
    install([node('t', 'trigger.member.leave'), log('LEFT')], [edge('t', 'l')]);
    auditEntries.push({ action: AuditLogEvent.MemberBanAdd, target: { id: '930001' }, executor: fakeUser(), createdTimestamp: Date.now() });
    client.emit(Events.GuildMemberRemove, guild.addMember({ user: fakeUser({ id: '930001' }) }));
    await tick(40);
    assert.ok(!logs().includes('LEFT'));
  });

  it('role added / removed fire per role, with an optional role filter', async () => {
    const vip = guild.addRole({ id: '777001', name: 'VIP' });
    const other = guild.addRole({ id: '777002', name: 'Other' });
    install([node('t1', 'trigger.member.roleAdded', { roleId: vip.id }), node('t2', 'trigger.member.roleRemoved'),
      node('l1', 'logic.log', { message: 'ADD {{role.name}} -> {{user.name}}' }), node('l2', 'logic.log', { message: 'REMOVE {{role.name}}' })],
    [edge('t1', 'l1'), edge('t2', 'l2')]);
    const user = fakeUser({ id: '940001', username: 'pat' });
    const before = guild.addMember({ user });
    const after = { ...before, roles: { cache: new Coll([[vip.id, vip], [other.id, other]]) }, communicationDisabledUntilTimestamp: null };
    const old = { ...before, partial: false, roles: { cache: new Coll([[other.id, other]]) }, communicationDisabledUntilTimestamp: null };
    client.emit(Events.GuildMemberUpdate, old, after);
    client.emit(Events.GuildMemberUpdate, after, old);
    await tick(40);
    assert.ok(logs().includes('ADD VIP -> pat'));
    assert.ok(logs().includes('REMOVE VIP'));
    assert.equal(logs().filter((m) => m.startsWith('ADD')).length, 1, 'the filter kept only VIP');
  });

  it('timeouts report duration and moderator', async () => {
    install([node('t', 'trigger.member.timeout'), node('l', 'logic.log', { message: 'TIMEOUT {{user.name}} {{timeout.minutes}}m by {{executor.name}}' })], [edge('t', 'l')]);
    const m = guild.addMember({ user: fakeUser({ id: '950001', username: 'chatty' }) });
    auditEntries.push({ action: AuditLogEvent.MemberUpdate, target: { id: '950001' }, executor: fakeUser({ username: 'sheriff' }), createdTimestamp: Date.now() });
    client.emit(Events.GuildMemberUpdate, { ...m, partial: false, communicationDisabledUntilTimestamp: null, roles: m.roles }, { ...m, communicationDisabledUntilTimestamp: Date.now() + 10 * 60000 + 500, roles: m.roles });
    await tick(40);
    assert.ok(logs().includes('TIMEOUT chatty 11m by sheriff') || logs().includes('TIMEOUT chatty 10m by sheriff'));
  });
});

describe('message, reaction and voice events', () => {
  it('reaction roles: matches message + emoji, resolves partials, gives the role', async () => {
    const role = guild.addRole({ id: '888001', name: 'Gamer' });
    const channel = guild.addChannel({ name: 'roles' });
    install([node('t', 'trigger.reaction.added', { messageId: '5551', emoji: '🎮' }), node('g', 'action.member.addRole', { roleId: role.id })], [edge('t', 'g')]);
    const user = fakeUser({ id: '960001', username: 'gamer1' });
    const member = guild.addMember({ user });
    const message = { id: '5551', guild, channel, channelId: channel.id, url: 'u' };
    let fetched = false;
    const partialReaction = { partial: true, message, emoji: { name: '🎮', id: null, toString: () => '🎮' }, fetch: async () => { fetched = true; return { partial: false, message, emoji: { name: '🎮', id: null, toString: () => '🎮' } }; } };
    client.emit(Events.MessageReactionAdd, partialReaction, { ...user, partial: false });
    await tick(40);
    assert.ok(fetched, 'partial reaction was fetched');
    assert.equal(member.roles.cache.has(role.id), true);
    // wrong emoji / wrong message do nothing
    const wrong = { partial: false, message, emoji: { name: '😀', id: null, toString: () => '😀' } };
    const other = guild.addMember({ user: fakeUser({ id: '960002' }) });
    client.emit(Events.MessageReactionAdd, wrong, other.user);
    client.emit(Events.MessageReactionAdd, { ...wrong, emoji: partialReaction.emoji, message: { ...message, id: '9999' } }, other.user);
    await tick(40);
    assert.equal(other.roles.cache.has(role.id), false);
  });

  it('the bot never reacts to its own messages', async () => {
    const channel = guild.addChannel({ name: 'chat' });
    install([node('t', 'trigger.message.received', { mode: 'any', ignoreBots: false }), log('SAW {{message.content}}')], [edge('t', 'l')]);
    const human = fakeUser({ id: '970001' });
    client.emit(Events.MessageCreate, { guild, channel, channelId: channel.id, author: human, member: guild.addMember({ user: human }), content: 'hello', id: 'm1', url: 'u' });
    client.emit(Events.MessageCreate, { guild, channel, channelId: channel.id, author: { id: 'BOT', bot: true, username: 'flowbot' }, content: 'my own words', id: 'm2', url: 'u' });
    client.emit(Events.MessageCreate, { guild: null, channel, channelId: channel.id, author: human, content: 'dm', id: 'm3' });
    await tick(40);
    assert.deepEqual(logs().filter((m) => m.startsWith('SAW')), ['SAW hello']);
  });

  it('voice: moving channels fires left then joined', async () => {
    install([node('t1', 'trigger.voice.left'), node('t2', 'trigger.voice.joined'), node('l1', 'logic.log', { message: 'LEFT {{channel.name}}' }), node('l2', 'logic.log', { message: 'JOINED {{channel.name}}' })], [edge('t1', 'l1'), edge('t2', 'l2')]);
    const a = fakeChannel(guild, { name: 'lobby', type: ChannelType.GuildVoice });
    const b = fakeChannel(guild, { name: 'games', type: ChannelType.GuildVoice });
    const member = guild.addMember({ user: fakeUser({ id: '980001' }) });
    client.emit(Events.VoiceStateUpdate, { channelId: a.id, channel: a }, { guild, member, channelId: b.id, channel: b });
    client.emit(Events.VoiceStateUpdate, { channelId: b.id, channel: b }, { guild, member, channelId: b.id, channel: b });
    await tick(40);
    assert.deepEqual(logs().filter((m) => /^(LEFT|JOINED)/.test(m)).sort(), ['JOINED games', 'LEFT lobby']);
  });

  it('role and channel updates fire only for real changes, with the old values', async () => {
    install([node('t1', 'trigger.role.updated'), node('t2', 'trigger.channel.updated'), node('l1', 'logic.log', { message: 'ROLE {{oldRole.name}}->{{role.name}}' }), node('l2', 'logic.log', { message: 'CH {{oldChannel.name}}->{{channel.name}}' })], [edge('t1', 'l1'), edge('t2', 'l2')]);
    const perms = { bitfield: 0n };
    const mkRole = (over) => ({ id: '600001', guild, name: 'A', hexColor: '#000000', permissions: perms, hoist: false, mentionable: false, position: 1, ...over });
    client.emit(Events.GuildRoleUpdate, mkRole(), mkRole({ position: 5 }));
    client.emit(Events.GuildRoleUpdate, mkRole(), mkRole({ name: 'B' }));
    const mkCh = (over) => ({ id: '600002', guild, name: 'old', topic: '', parentId: null, nsfw: false, rateLimitPerUser: 0, type: 0, ...over });
    client.emit(Events.ChannelUpdate, mkCh(), mkCh({ rawPosition: 9 }));
    client.emit(Events.ChannelUpdate, mkCh(), mkCh({ name: 'new' }));
    await tick(40);
    assert.deepEqual(logs().filter((m) => /^(ROLE|CH) /.test(m)).sort(), ['CH old->new', 'ROLE A->B']);
  });

  it('channel/role created by the bot are ignored unless includeSelf is on', async () => {
    install([node('t1', 'trigger.channel.created'), node('t2', 'trigger.role.created', { includeSelf: true }), node('l1', 'logic.log', { message: 'CH {{channel.name}}' }), node('l2', 'logic.log', { message: 'ROLE {{role.name}}' })], [edge('t1', 'l1'), edge('t2', 'l2')]);
    runtime.services.selfActions.expect(`channelCreate:${guild.id}`);
    client.emit(Events.ChannelCreate, fakeChannel(guild, { name: 'mine' }));
    client.emit(Events.ChannelCreate, fakeChannel(guild, { name: 'theirs' }));
    runtime.services.selfActions.expect(`roleCreate:${guild.id}`);
    client.emit(Events.GuildRoleCreate, { id: '600003', guild, name: 'made-by-bot', hexColor: '#111111' });
    await tick(40);
    assert.deepEqual(logs().filter((m) => /^(CH|ROLE) /.test(m)).sort(), ['CH theirs', 'ROLE made-by-bot']);
  });
});

describe('slash command registration', () => {
  const trig = (data, flowName = 'f') => ({ flow: { name: flowName }, node: { data } });

  it('builds definitions with required options first and permission bits', () => {
    const { defs, skipped } = buildCommandDefs([
      trig({ name: 'ban', description: 'Ban', permission: 'BanMembers', options: [
        { name: 'reason', description: 'why', type: 'string', required: false },
        { name: 'target', description: 'who', type: 'user', required: true },
        { name: 'bad name!', description: 'x', type: 'string' },
      ] }),
      trig({ name: 'ping', description: 'Ping', options: [] }, 'g'),
      trig({ name: 'ping', description: 'Again', options: [] }, 'h'),
      trig({ name: 'Bad', description: 'x' }),
    ]);
    assert.deepEqual(defs.map((d) => d.name), ['ban', 'ping']);
    assert.deepEqual(defs[0].options.map((o) => [o.name, o.type, o.required]), [['target', 6, true], ['reason', 3, false]]);
    assert.equal(defs[0].default_member_permissions, '4');
    assert.equal(defs[1].default_member_permissions, null);
    assert.equal(skipped.length, 2);
  });

  it('only calls Discord when the definitions changed, and reports failures', async () => {
    install([node('t', 'trigger.command', { name: 'hi', description: 'Say hi' }), log('x')], [edge('t', 'l')]);
    const puts = [];
    let fail = false;
    runtime.attachClient({ rest: { put: async (route, opts) => { if (fail) throw Object.assign(new Error('boom'), { code: 50013 }); puts.push([route, opts.body]); } } });
    const sync = new CommandSync({ db, runtime, logger, config: { clientId: 'cid' } });
    assert.equal((await sync.sync(guild.id)).ok, true);
    assert.equal(puts.length, 1);
    assert.match(puts[0][0], /applications\/cid\/guilds\/111111\/commands/);
    assert.equal(puts[0][1][0].name, 'hi');
    await sync.sync(guild.id);
    assert.equal(puts.length, 1, 'unchanged → no request');
    db.createFlow({ guildId: guild.id, name: 'second', graph: { nodes: [node('t', 'trigger.command', { name: 'bye', description: 'Say bye' })], edges: [] } });
    runtime.loadGuild(guild.id);
    fail = true;
    const res = await sync.sync(guild.id);
    assert.equal(res.ok, false);
    assert.match(res.error, /Missing permissions/);
    fail = false;
    assert.equal((await sync.sync(guild.id)).ok, true);
    assert.equal(puts.length, 2);
    assert.equal(hashDefs([]) === hashDefs([]), true);
  });
});

describe('cleaning up what buttons remembered', () => {
  const remember = (messageId, channelId, guildId = guild.id) => runtime.services.components.remember(messageId, { guild: { id: guildId }, vars: { a: 1 }, data: { user: { id: '1' } } }, { channelId });

  it('forgets a message when it is deleted, a whole channel when it is deleted, and bulk-deleted messages', async () => {
    remember('m1', 'c1'); remember('m2', 'c2'); remember('m3', 'c2'); remember('m4', 'c3'); remember('m5', 'c3');
    assert.equal(db.countComponentState(guild.id), 5);

    client.emit(Events.MessageDelete, { id: 'm1', guildId: guild.id, guild });
    await tick(30);
    assert.equal(runtime.services.components.get(guild.id, 'm1'), undefined);

    client.emit(Events.ChannelDelete, { id: 'c2', guild, type: ChannelType.GuildText });
    await tick(30);
    assert.equal(runtime.services.components.get(guild.id, 'm2'), undefined);
    assert.equal(runtime.services.components.get(guild.id, 'm3'), undefined);

    client.emit(Events.MessageBulkDelete, new Coll([['m4', {}]]), { guildId: guild.id });
    await tick(30);
    assert.equal(runtime.services.components.get(guild.id, 'm4'), undefined);
    assert.ok(runtime.services.components.get(guild.id, 'm5'), 'untouched messages keep their state');
  });

  it('a message deleted in another server does not touch this one', async () => {
    remember('m1', 'c1');
    client.emit(Events.MessageDelete, { id: 'm1', guildId: '999999', guild: { id: '999999' } });
    await tick(30);
    assert.ok(runtime.services.components.get(guild.id, 'm1'));
  });
});
