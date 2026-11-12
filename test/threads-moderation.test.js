// Threads and forum posts, and the moderation blocks: Message Edited, Pin Message, Delete Messages (bulk), Voice: Move or Disconnect.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { ChannelType, Events } from 'discord.js';
import { availableVariables } from '../shared/catalog.js';
import { resetLimits } from '../shared/limits.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { wireEvents } from '../server/bot/events.js';
import { Database } from '../server/db.js';
import { ChannelEdits } from '../server/engine/channel-edits.js';
import { friendlyError } from '../server/engine/errors.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

let db; let runtime; let client; let guild; let channel; let user; let member; let logger;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const logs = () => logger.recent(guild.id).map((l) => l.message);
const install = (graph, name = 'flow') => { const flow = db.createFlow({ guildId: guild.id, name, graph }); runtime.loadGuild(guild.id); return flow; };
/** A /cmd flow: the node under test, then a reply that says “ok …” or “failed: …”. */
const action = (type, data, ok = 'ok') => commandFlow(
  [node('a', type, data), node('r', 'action.message.send', { target: 'reply', content: ok }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })],
  [edge('t', 'a'), edge('a', 'r'), edge('a', 'e', 'error')],
);
const run = async (over = {}) => {
  const i = fakeCommand({ guild, channel, user, member, commandName: 'cmd', ...over });
  await runtime.handleInteraction(i);
  return i.calls.find((c) => c[0] === 'reply')?.[1].content;
};

beforeEach(() => {
  resetLimits();
  db = new Database(':memory:');
  logger = new Logger({ console: false });
  runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true } });
  client = new EventEmitter();
  client.user = { id: 'BOT', username: 'flowbot' };
  guild = fakeGuild({ id: '111111' });
  client.guilds = guild.client.guilds;
  channel = guild.addChannel({ name: 'general' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  runtime.attachClient(client);
  wireEvents({ client, runtime, logger, sync: { sync: async () => ({}) }, auditDelayMs: 0 });
});

describe('Create Thread', () => {
  it('starts a thread in the current channel, posts the first message and hands its ID on', async () => {
    install(action('action.thread.create', { name: 'Help for {{user.name}}', content: 'Hi {{user.mention}}', outputVar: 'thread', reason: 'support' }, 'ok {{var.thread}} {{thread.mention}} {{thread.name}}'));
    const said = await run();
    const [, options] = channel.calls.find((c) => c[0] === 'threadCreate');
    assert.deepEqual(options, { name: 'Help for mia', autoArchiveDuration: 1440, reason: '[flow] support', type: ChannelType.PublicThread });
    const thread = guild.channels.cache.find((c) => c.parentId === channel.id);
    assert.equal(said, `ok ${thread.id} <#${thread.id}> Help for mia`);
    assert.deepEqual(thread.sent.map((m) => m.content), ['Hi <@222222>']);
  });

  it('makes it private, hides it after the time chosen, and adds a member of this server', async () => {
    const friend = guild.addMember({ user: fakeUser({ id: '333333', username: 'bo' }) });
    install(action('action.thread.create', { name: 'Private', privateThread: true, autoArchive: '10080', addUserId: `<@${friend.id}>` }));
    assert.equal(await run(), 'ok');
    const [, options] = channel.calls.find((c) => c[0] === 'threadCreate');
    assert.equal(options.type, ChannelType.PrivateThread);
    assert.equal(options.autoArchiveDuration, 10080);
    const thread = guild.channels.cache.find((c) => c.parentId === channel.id);
    assert.deepEqual(thread.calls.filter((c) => c[0] === 'threadMemberAdd'), [['threadMemberAdd', '333333', '[flow]']]);
    assert.equal(thread.sent.length, 0, 'no first message unless one is written');
  });

  it('refuses to add someone who is not in this server, before anything is created', async () => {
    install(action('action.thread.create', { name: 'Private', addUserId: '999999' }));
    assert.match(await run(), /^failed: User 999999 is not a member/);
    assert.equal(channel.calls.some((c) => c[0] === 'threadCreate'), false);
  });

  it('starts a thread on a message: the one that started the flow, or one named by its ID', async () => {
    const first = channel.addMessage({ id: '70001', content: 'question' });
    install(action('action.thread.create', { name: 'Answers', from: 'message', messageId: first.id, content: 'Reply here' }));
    assert.equal(await run(), 'ok');
    const [, id, options] = channel.calls.find((c) => c[0] === 'startThread');
    assert.equal(id, '70001');
    assert.deepEqual(options, { name: 'Answers', autoArchiveDuration: 1440, reason: '[flow]' });
    assert.deepEqual(guild.channels.cache.find((c) => c.parentId === channel.id).sent.map((m) => m.content), ['Reply here']);
  });

  it('“On a message” with no ID uses the triggering message, and says so when there is none', async () => {
    install({ nodes: [node('t', 'trigger.message.received', { mode: 'any' }), node('a', 'action.thread.create', { name: 'About {{message.content}}', from: 'message' })], edges: [edge('t', 'a')] });
    const msg = channel.addMessage({ id: '70002', content: 'cats', author: user });
    client.emit(Events.MessageCreate, Object.assign(msg, { guild, channelId: channel.id, member }));
    await tick(40);
    assert.deepEqual(channel.calls.find((c) => c[0] === 'startThread').slice(1, 3), ['70002', { name: 'About cats', autoArchiveDuration: 1440, reason: '[flow]' }]);

    db.createFlow({ guildId: guild.id, name: 'cmd', graph: action('action.thread.create', { name: 'x', from: 'message' }) });
    runtime.loadGuild(guild.id);
    assert.match(await run(), /^failed: No message to start the thread on/);
    assert.match(await run({ commandName: 'cmd' }), /^failed/);
  });

  it('a missing message is an error, not a thread somewhere else', async () => {
    install(action('action.thread.create', { name: 'x', from: 'message', messageId: '123456' }));
    assert.equal(await run(), 'failed: Message 123456 was not found in #general.');
  });

  it('makes a forum post with its first message, and refuses an empty one', async () => {
    const forum = guild.addChannel({ name: 'ideas', type: ChannelType.GuildForum });
    install(action('action.thread.create', { channelId: forum.id, name: 'Idea: {{user.name}}', content: 'Let us talk', from: 'message', privateThread: true }));
    assert.equal(await run(), 'ok');
    const [, options] = forum.calls.find((c) => c[0] === 'threadCreate');
    assert.deepEqual(options, { name: 'Idea: mia', autoArchiveDuration: 1440, reason: '[flow]', message: { content: 'Let us talk' } }, 'a forum post is always on its own and never private');
    const post = guild.channels.cache.find((c) => c.parentId === forum.id);
    assert.deepEqual(post.sent.map((m) => m.content), ['Let us talk'], 'the first message is sent once, with the post');

    db.createFlow({ guildId: guild.id, name: 'empty', graph: commandFlow([node('a', 'action.thread.create', { channelId: forum.id, name: 'x' }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'a'), edge('a', 'e', 'error')], 'empty') });
    runtime.loadGuild(guild.id);
    assert.match(await run({ commandName: 'empty' }), /^failed: A forum post needs a first message/);
  });

  it('cannot be started in another server’s channel, in a voice channel, or with an empty name', async () => {
    const other = fakeGuild({ id: '999999' });
    const foreign = other.addChannel({ name: 'theirs' });
    guild.foreign = new Map([[foreign.id, foreign]]);
    install(action('action.thread.create', { channelId: foreign.id, name: 'x' }));
    assert.match(await run(), /^failed: Channel .* was not found in this server/);
    assert.equal(foreign.calls.length, 0);

    const voice = guild.addChannel({ name: 'lobby', type: ChannelType.GuildVoice });
    voice.threads = undefined;
    db.createFlow({ guildId: guild.id, name: 'v', graph: commandFlow([node('a', 'action.thread.create', { channelId: voice.id, name: 'x' }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'a'), edge('a', 'e', 'error')], 'v') });
    db.createFlow({ guildId: guild.id, name: 'n', graph: commandFlow([node('a', 'action.thread.create', { name: '{{var.nothing}}' }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'a'), edge('a', 'e', 'error')], 'n') });
    runtime.loadGuild(guild.id);
    assert.equal(await run({ commandName: 'v' }), 'failed: #lobby cannot have threads.');
    assert.equal(await run({ commandName: 'n' }), 'failed: The thread name is empty.');
  });

  it('a thread the bot made does not run “Thread Created” unless asked to', async () => {
    install(action('action.thread.create', { name: 'mine' }));
    db.createFlow({ guildId: guild.id, name: 'watch', graph: { nodes: [node('t', 'trigger.thread.created'), node('l', 'logic.log', { message: 'SAW {{channel.name}}' })], edges: [edge('t', 'l')] } });
    db.createFlow({ guildId: guild.id, name: 'watch all', graph: { nodes: [node('t', 'trigger.thread.created', { includeSelf: true }), node('l', 'logic.log', { message: 'ALSO {{channel.name}}' })], edges: [edge('t', 'l')] } });
    runtime.loadGuild(guild.id);
    await run();
    const thread = guild.channels.cache.find((c) => c.parentId === channel.id);
    client.emit(Events.ThreadCreate, thread, true); // what Discord sends back for the thread the bot just made
    await tick(40);
    assert.deepEqual(logs().filter((m) => /^(SAW|ALSO) /.test(m)), ['ALSO mine']);
  });
});

describe('Update Thread', () => {
  let thread;
  beforeEach(() => { thread = guild.addChannel({ name: 'old name', type: ChannelType.PublicThread, parentId: channel.id }); });
  const edits = () => thread.calls.filter((c) => c[0] === 'edit').map((c) => c[1]);

  it('renames, locks and adds a member in one go', async () => {
    const friend = guild.addMember({ user: fakeUser({ id: '333333' }) });
    install(action('action.thread.update', { channelId: thread.id, name: 'Solved: {{user.name}}', locked: 'yes', addUserId: friend.id, reason: 'done' }));
    assert.equal(await run(), 'ok');
    assert.deepEqual(edits(), [{ locked: true, name: 'Solved: mia', reason: '[flow] done' }]);
    assert.deepEqual(thread.calls.filter((c) => c[0] === 'threadMemberAdd'), [['threadMemberAdd', '333333', '[flow] done']]);
  });

  it('blank = the thread the flow is running in', async () => {
    install(action('action.thread.update', { locked: 'no' }));
    assert.equal(await run({ channel: thread }), 'ok');
    assert.deepEqual(edits(), [{ locked: false, reason: '[flow]' }]);
  });

  it('reopens first and closes last, so the other changes can be made', async () => {
    install(action('action.thread.update', { channelId: thread.id, archived: 'no', name: 'again', removeUserId: '<@444444>' }));
    assert.equal(await run(), 'ok');
    assert.deepEqual(edits(), [{ archived: false, name: 'again', reason: '[flow]' }]);
    assert.deepEqual(thread.calls.filter((c) => c[0] === 'threadMemberRemove'), [['threadMemberRemove', '444444', '[flow]']]);

    thread.calls.length = 0;
    db.createFlow({ guildId: guild.id, name: 'close', graph: commandFlow([node('a', 'action.thread.update', { channelId: thread.id, archived: 'yes', locked: 'yes' })], [edge('t', 'a')], 'close') });
    runtime.loadGuild(guild.id);
    await run({ commandName: 'close' });
    assert.deepEqual(edits(), [{ locked: true, reason: '[close]' }, { archived: true, reason: '[close]' }]);
  });

  it('holds a third rename within ten minutes instead of making the run wait, and sets the newest name later', async () => {
    let now = 1_000_000; const timers = [];
    runtime.services.channelEdits = new ChannelEdits({ now: () => now, setTimer: (fn, ms) => { const t = { fn, at: now + ms, unref() {} }; timers.push(t); return t; }, clearTimer: () => {} });
    install(commandFlow([node('a', 'action.thread.update', { channelId: thread.id, name: 'name {{option.n}}' }), node('r', 'action.message.send', { target: 'reply', content: 'ok' })], [edge('t', 'a'), edge('a', 'r')]));
    for (const n of [1, 2, 3, 4]) assert.equal(await run({ options: [{ name: 'n', value: n }] }), 'ok', 'the run never waits');
    assert.deepEqual(edits().map((e) => e.name), ['name 1', 'name 2']);
    assert.ok(logs().some((m) => /only two name changes per thread every 10 minutes/.test(m)));
    now = timers[0].at; await timers[0].fn();
    assert.deepEqual(edits().map((e) => e.name), ['name 1', 'name 2', 'name 4'], 'only the newest held name is set');
  });

  it('says so when the channel is not a thread, and when a member is not one', async () => {
    install(action('action.thread.update', { channelId: channel.id, locked: 'yes' }));
    assert.equal(await run(), 'failed: #general is not a thread.');
    db.createFlow({ guildId: guild.id, name: 'x', graph: commandFlow([node('a', 'action.thread.update', { channelId: thread.id, removeUserId: 'bob' }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'a'), edge('a', 'e', 'error')], 'x') });
    runtime.loadGuild(guild.id);
    assert.match(await run({ commandName: 'x' }), /^failed: “bob” is not a user ID/);
    assert.equal(edits().length, 0);
  });

  it('needs something to change', () => {
    const problems = (data) => validateFlow(normalizeGraph(commandFlow([node('a', 'action.thread.update', data)], [edge('t', 'a')]))).filter((i) => i.nodeId === 'a' && i.level === 'error').map((i) => i.message);
    assert.deepEqual(problems({}), ['Nothing to change: fill in at least one field.']);
    assert.deepEqual(problems({ archived: 'yes' }), []);
  });
});

describe('Thread Created', () => {
  const thread = (over = {}) => guild.addChannel({ name: 'new thread', type: ChannelType.PublicThread, parentId: channel.id, ownerId: user.id, ...over });
  const watch = (data = {}) => install({ nodes: [node('t', 'trigger.thread.created', data), node('l', 'logic.log', { message: 'THREAD {{channel.name}} in {{channel.parentId}} by {{user.name}} type {{channel.type}}' })], edges: [edge('t', 'l')] });

  it('runs with the thread as the channel and whoever started it as the user', async () => {
    watch();
    client.emit(Events.ThreadCreate, thread(), true);
    await tick(40);
    assert.deepEqual(logs().filter((m) => m.startsWith('THREAD')), [`THREAD new thread in ${channel.id} by mia type GuildPublicThread`]);
  });

  it('does not run when the bot was only added to a thread that already existed', async () => {
    watch();
    client.emit(Events.ThreadCreate, thread(), false);
    await tick(40);
    assert.deepEqual(logs().filter((m) => m.startsWith('THREAD')), []);
  });

  it('can be limited to one channel or forum', async () => {
    const forum = guild.addChannel({ name: 'ideas', type: ChannelType.GuildForum });
    watch({ channelId: forum.id });
    client.emit(Events.ThreadCreate, thread(), true);
    client.emit(Events.ThreadCreate, thread({ name: 'a post', parentId: forum.id }), true);
    await tick(40);
    assert.deepEqual(logs().filter((m) => m.startsWith('THREAD')), [`THREAD a post in ${forum.id} by mia type GuildPublicThread`]);
  });

  it('still runs when the person who started it cannot be found', async () => {
    watch();
    client.emit(Events.ThreadCreate, thread({ ownerId: '987654' }), true);
    await tick(40);
    assert.deepEqual(logs().filter((m) => m.startsWith('THREAD')), [`THREAD new thread in ${channel.id} by  type GuildPublicThread`]);
  });

  it('a deleted thread takes what was remembered for it along', async () => {
    const t = thread();
    db.setVar(guild.id, 'channel', t.id, 'count', 3);
    db.setVar(guild.id, 'channel', channel.id, 'count', 5);
    client.emit(Events.ThreadDelete, t);
    await tick();
    assert.equal(db.getVar(guild.id, 'channel', t.id, 'count'), undefined);
    assert.equal(db.getVar(guild.id, 'channel', channel.id, 'count'), 5);
  });
});

describe('Message Edited', () => {
  const watch = (data = {}) => install({ nodes: [node('t', 'trigger.message.edited', data), node('l', 'logic.log', { message: 'EDIT [{{message.before}}] -> [{{message.content}}] by {{user.name}} in {{channel.name}}' })], edges: [edge('t', 'l')] });
  const edits = () => logs().filter((m) => m.startsWith('EDIT'));
  const msg = (over = {}) => ({ id: '80001', guild, guildId: guild.id, channel, channelId: channel.id, author: user, member, content: 'new text', editedTimestamp: 2000, url: 'u', ...over });

  it('runs with the text before and after', async () => {
    watch();
    client.emit(Events.MessageUpdate, msg({ content: 'old text', editedTimestamp: null }), msg());
    await tick(40);
    assert.deepEqual(edits(), ['EDIT [old text] -> [new text] by mia in general']);
  });

  it('a link preview appearing under a message is not an edit', async () => {
    watch();
    client.emit(Events.MessageUpdate, msg({ editedTimestamp: null }), msg({ editedTimestamp: null }));
    client.emit(Events.MessageUpdate, msg({ editedTimestamp: 2000 }), msg({ editedTimestamp: 2000 }));
    await tick(40);
    assert.deepEqual(edits(), []);
  });

  it('remembers what the bot saw, so the old text is known even when Discord sends only the new one', async () => {
    watch();
    client.emit(Events.MessageCreate, msg({ content: 'first words', editedTimestamp: null }));
    client.emit(Events.MessageUpdate, { id: '80001', partial: true }, msg({ content: 'second words' }));
    client.emit(Events.MessageUpdate, { id: '80001', partial: true }, msg({ content: 'third words', editedTimestamp: 3000 }));
    await tick(40);
    assert.deepEqual(edits(), ['EDIT [first words] -> [second words] by mia in general', 'EDIT [second words] -> [third words] by mia in general']);
  });

  it('a message the bot never saw still runs, with a blank “before”', async () => {
    watch();
    client.emit(Events.MessageUpdate, { id: '80001', partial: true }, msg());
    await tick(40);
    assert.deepEqual(edits(), ['EDIT [] -> [new text] by mia in general']);
  });

  it('never runs for the bot’s own edits, skips bots by default, and can be limited to a channel', async () => {
    const other = guild.addChannel({ name: 'other' });
    watch({ channelId: other.id });
    db.createFlow({ guildId: guild.id, name: 'bots too', graph: { nodes: [node('t', 'trigger.message.edited', { ignoreBots: false }), node('l', 'logic.log', { message: 'ANY {{user.name}}' })], edges: [edge('t', 'l')] } });
    runtime.loadGuild(guild.id);
    const robot = fakeUser({ id: '555555', username: 'robot', bot: true });
    client.emit(Events.MessageUpdate, msg({ editedTimestamp: null }), msg());
    client.emit(Events.MessageUpdate, msg({ editedTimestamp: null }), msg({ channel: other, channelId: other.id }));
    client.emit(Events.MessageUpdate, msg({ editedTimestamp: null }), msg({ author: robot, channel: other, channelId: other.id }));
    client.emit(Events.MessageUpdate, msg({ editedTimestamp: null }), msg({ author: { id: 'BOT', username: 'flowbot', bot: true } }));
    await tick(40);
    assert.deepEqual(edits(), ['EDIT [new text] -> [new text] by mia in other']);
    assert.deepEqual(logs().filter((m) => m.startsWith('ANY')).sort(), ['ANY mia', 'ANY mia', 'ANY robot']);
  });

  it('fetches a message Discord sent only in part, and gives up quietly when it cannot', async () => {
    watch();
    client.emit(Events.MessageUpdate, { id: '80001', partial: true }, { id: '80001', guild, partial: true, editedTimestamp: 2000, fetch: async () => msg({ content: 'fetched' }) });
    client.emit(Events.MessageUpdate, { id: '80002', partial: true }, { id: '80002', guild, partial: true, editedTimestamp: 2000, fetch: async () => { throw new Error('gone'); } });
    await tick(40);
    assert.deepEqual(edits(), ['EDIT [] -> [fetched] by mia in general']);
  });

  it('keeps recent messages in memory only while a flow needs them', async () => {
    client.emit(Events.MessageCreate, msg({ editedTimestamp: null }));
    assert.equal(runtime.services.messageMemory.peek(guild.id, '80001'), null, 'nothing is remembered without a flow');
    const flow = watch();
    client.emit(Events.MessageCreate, msg({ editedTimestamp: null }));
    assert.equal(runtime.services.messageMemory.peek(guild.id, '80001').content, 'new text');
    db.updateFlow(guild.id, flow.id, { enabled: false });
    runtime.loadGuild(guild.id);
    assert.equal(runtime.services.messageMemory.peek(guild.id, '80001'), null, 'and it is forgotten when the flow is switched off');
  });

  it('warns, without blocking, when the Message Content intent is off', () => {
    const graph = normalizeGraph({ nodes: [node('t', 'trigger.message.edited'), node('l', 'logic.log', { message: 'x' })], edges: [edge('t', 'l')] });
    const issues = validateFlow(graph, { intents: { members: false, messageContent: false } }).filter((i) => i.nodeId === 't');
    assert.deepEqual(issues.map((i) => i.level), ['warning']);
    assert.match(issues[0].message, /Message Content/);
    assert.ok(availableVariables(graph.nodes, graph.edges, 'l').some((v) => v.path === 'message.before'));
  });
});

describe('Pin Message', () => {
  it('pins and unpins a message by its ID, with the reason', async () => {
    const m = channel.addMessage({ id: '81001', content: 'rules' });
    install(action('action.message.pin', { messageId: m.id, reason: 'keep' }));
    assert.equal(await run(), 'ok');
    assert.deepEqual(channel.calls.filter((c) => c[0] === 'pin'), [['pin', '81001', '[flow] keep']]);
    assert.equal(m.pinned, true);

    db.createFlow({ guildId: guild.id, name: 'un', graph: commandFlow([node('a', 'action.message.pin', { mode: 'unpin', messageId: m.id })], [edge('t', 'a')], 'un') });
    runtime.loadGuild(guild.id);
    await run({ commandName: 'un' });
    assert.deepEqual(channel.calls.filter((c) => c[0] === 'unpin'), [['unpin', '81001', '[un]']]);
    assert.equal(m.pinned, false);
  });

  it('blank = the message that started the flow; no message at all is an error', async () => {
    install({ nodes: [node('t', 'trigger.message.received', { mode: 'startsWith', text: '!pin' }), node('a', 'action.message.pin', {})], edges: [edge('t', 'a')] });
    const m = channel.addMessage({ id: '81002', content: '!pin this', author: user });
    client.emit(Events.MessageCreate, Object.assign(m, { guild, channelId: channel.id, member }));
    await tick(40);
    assert.equal(m.pinned, true);

    db.createFlow({ guildId: guild.id, name: 'cmd', graph: action('action.message.pin', {}) });
    runtime.loadGuild(guild.id);
    assert.match(await run(), /^failed: No message/);
  });

  it('explains Discord’s refusals in plain words', () => {
    assert.match(friendlyError({ code: 30003, message: 'x' }), /maximum number of pinned messages/);
    assert.match(friendlyError({ code: 40032, message: 'x' }), /not in a voice channel/);
    assert.match(friendlyError({ code: 50083, message: 'x' }), /closed \(archived\)/);
    assert.match(friendlyError({ code: 160004, message: 'x' }), /already has a thread/);
  });
});

describe('Delete Messages (bulk)', () => {
  const fill = (n = 6) => Array.from({ length: n }, (_, i) => channel.addMessage({ id: String(90001 + i), content: `m${i}`, author: i % 2 ? user : { id: '333333', username: 'bo', bot: false } }));
  const left = () => [...channel.messages.store.keys()];

  it('deletes the last N messages and says how many', async () => {
    fill();
    install(action('action.message.purge', { count: 4 }, 'deleted {{purge.count}}'));
    assert.equal(await run(), 'deleted 4');
    assert.deepEqual(channel.calls.find((c) => c[0] === 'bulkDelete').slice(1), [['90006', '90005', '90004', '90003'], true]);
    assert.deepEqual(left(), ['90001', '90002']);
  });

  it('only one member’s messages, out of the ones it looked at', async () => {
    fill();
    install(action('action.message.purge', { count: 5, userId: `<@${user.id}>` }, 'deleted {{purge.count}}'));
    assert.equal(await run(), 'deleted 3');
    assert.deepEqual(left(), ['90001', '90003', '90005']);
  });

  it('keeps pinned messages unless told otherwise, and leaves messages older than 14 days alone', async () => {
    const [a, b] = fill(4);
    a.pinned = true;
    b.createdTimestamp = Date.now() - 15 * 86400000;
    install(action('action.message.purge', { count: 100 }, 'deleted {{purge.count}}'));
    assert.equal(await run(), 'deleted 2');
    assert.deepEqual(left(), ['90001', '90002']);

    db.createFlow({ guildId: guild.id, name: 'all', graph: commandFlow([node('a', 'action.message.purge', { count: 100, keepPinned: false }), node('r', 'action.message.send', { target: 'reply', content: 'deleted {{purge.count}}' })], [edge('t', 'a'), edge('a', 'r')], 'all') });
    runtime.loadGuild(guild.id);
    assert.equal(await run({ commandName: 'all' }), 'deleted 1', 'one message is deleted on its own (bulk delete needs two)');
    assert.deepEqual(left(), ['90002']);
    assert.equal(channel.calls.filter((c) => c[0] === 'bulkDelete').length, 1);
  });

  it('nothing to delete is not an error', async () => {
    install(action('action.message.purge', { count: 10 }, 'deleted {{purge.count}}'));
    assert.equal(await run(), 'deleted 0');
    assert.equal(channel.calls.some((c) => c[0] === 'bulkDelete'), false);
  });

  it('refuses a count that is not 1–100, a name instead of an ID, and another server’s channel', async () => {
    fill();
    const other = fakeGuild({ id: '999999' });
    const foreign = other.addChannel({ name: 'theirs' });
    foreign.addMessage({ id: '95001' });
    guild.foreign = new Map([[foreign.id, foreign]]);
    const cases = [[{ count: 500 }, /between 1 and 100/], [{ count: '{{var.nothing}}' }, /between 1 and 100/], [{ count: 5, userId: 'bob' }, /not a user ID/], [{ count: 5, channelId: foreign.id }, /was not found in this server/]];
    for (const [i, [data]] of cases.entries()) db.createFlow({ guildId: guild.id, name: `c${i}`, graph: commandFlow([node('a', 'action.message.purge', data), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'a'), edge('a', 'e', 'error')], `c${i}`) });
    runtime.loadGuild(guild.id);
    for (const [i, [, expected]] of cases.entries()) assert.match(await run({ commandName: `c${i}` }), expected);
    assert.equal(left().length, 6);
    assert.equal(foreign.messages.store.size, 1);
  });
});

describe('Voice: Move or Disconnect', () => {
  let lobby; let games;
  beforeEach(() => {
    lobby = guild.addChannel({ name: 'lobby', type: ChannelType.GuildVoice });
    games = guild.addChannel({ name: 'games', type: ChannelType.GuildVoice });
    member.voice.channelId = lobby.id;
  });

  it('moves the member who started the flow', async () => {
    install(action('action.member.voice', { mode: 'move', channelId: games.id, reason: 'event' }));
    assert.equal(await run(), 'ok');
    assert.deepEqual(member.calls, [['voiceMove', games.id, '[flow] event']]);
  });

  it('disconnects, mutes and unmutes someone else', async () => {
    const bo = guild.addMember({ user: fakeUser({ id: '333333' }) });
    bo.voice.channelId = lobby.id;
    for (const mode of ['disconnect', 'mute', 'unmute']) db.createFlow({ guildId: guild.id, name: mode, graph: commandFlow([node('a', 'action.member.voice', { mode, userId: bo.id })], [edge('t', 'a')], mode) });
    runtime.loadGuild(guild.id);
    await run({ commandName: 'mute' }); await run({ commandName: 'unmute' }); await run({ commandName: 'disconnect' });
    assert.deepEqual(bo.calls, [['voiceMute', true, '[mute]'], ['voiceMute', false, '[unmute]'], ['voiceDisconnect', '[disconnect]']]);
    assert.deepEqual(member.calls, []);
  });

  it('follows On error when they are not in voice, the target is not a voice channel, or no channel is chosen', async () => {
    const cases = [[{ mode: 'move', channelId: channel.id }, 'failed: #general is not a voice channel.'], [{ mode: 'move', channelId: '' }, 'failed: Choose the voice channel to move them to.']];
    for (const [i, [data]] of cases.entries()) db.createFlow({ guildId: guild.id, name: `c${i}`, graph: commandFlow([node('a', 'action.member.voice', data), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'a'), edge('a', 'e', 'error')], `c${i}`) });
    runtime.loadGuild(guild.id);
    for (const [i, [, expected]] of cases.entries()) assert.equal(await run({ commandName: `c${i}` }), expected);
    member.voice.channelId = null;
    db.createFlow({ guildId: guild.id, name: 'cmd', graph: action('action.member.voice', { mode: 'disconnect' }) });
    runtime.loadGuild(guild.id);
    assert.equal(await run(), 'failed: That member is not in a voice channel.');
    assert.deepEqual(member.calls, []);
  });

  it('cannot move anyone into another server’s channel', async () => {
    const other = fakeGuild({ id: '999999' });
    const foreign = other.addChannel({ name: 'theirs', type: ChannelType.GuildVoice });
    guild.foreign = new Map([[foreign.id, foreign]]);
    install(action('action.member.voice', { mode: 'move', channelId: foreign.id }));
    assert.match(await run(), /^failed: Channel .* was not found in this server/);
    assert.deepEqual(member.calls, []);
  });
});
