import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { Database } from '../server/db.js';
import { CEILINGS } from '../server/engine/engine.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeChannel, fakeCommand, fakeComponent, fakeGuild, fakeUser, node } from './helpers/fakes.js';

let db; let runtime; let guild; let channel; let user; let member;

function setup(intents) {
  db = new Database(':memory:');
  runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: intents ?? { members: true, messageContent: true } });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'general' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  runtime.attachClient(guild.client);
}
const install = (graph, guildId = guild.id, name = 'Test flow') => {
  const flow = db.createFlow({ guildId, name, graph });
  runtime.loadGuild(guildId);
  return flow;
};
const slash = (commandName = 'cmd', options = []) => fakeCommand({ guild, channel, user, member, commandName, options });
const run = async (i) => { await runtime.handleInteraction(i); return i; };
const logs = () => runtime.logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);

beforeEach(() => { resetLimits(); setup(); });

describe('commands, variables and conditions', () => {
  it('runs a command flow and persists a guild variable across runs', async () => {
    install(commandFlow(
      [
        node('v', 'data.variable.set', { scope: 'guild', name: 'counter', operation: 'add', value: '1' }),
        node('r', 'action.message.send', { target: 'reply', content: 'count={{guild.vars.counter}} hi {{user.name}}' }),
      ],
      [edge('t', 'v'), edge('v', 'r')],
    ));
    const a = await run(slash());
    const b = await run(slash());
    assert.equal(a.calls[0][0], 'reply');
    assert.equal(a.calls[0][1].content, 'count=1 hi mia');
    assert.equal(b.calls[0][1].content, 'count=2 hi mia');
    assert.equal(db.getVar(guild.id, 'guild', '', 'counter'), 2);
  });

  it('exposes slash-command options and branches on a condition', async () => {
    install(commandFlow(
      [
        node('c', 'logic.condition', { match: 'all', conditions: [{ left: '{{option.amount}}', op: 'gt', right: '10' }] }),
        node('big', 'action.message.send', { target: 'reply', content: 'big {{option.amount}}' }),
        node('small', 'action.message.send', { target: 'reply', content: 'small' }),
      ],
      [edge('t', 'c'), edge('c', 'big', 'true'), edge('c', 'small', 'false')],
    ));
    assert.equal((await run(slash('cmd', [{ name: 'amount', value: 50 }]))).calls[0][1].content, 'big 50');
    assert.equal((await run(slash('cmd', [{ name: 'amount', value: 3 }]))).calls[0][1].content, 'small');
  });

  it('per-user variables are isolated per user and per server', async () => {
    install(commandFlow(
      [node('v', 'data.variable.set', { scope: 'user', name: 'coins', operation: 'add', value: '5' }),
        node('r', 'action.message.send', { target: 'reply', content: '{{user.vars.coins}}' })],
      [edge('t', 'v'), edge('v', 'r')],
    ));
    await run(slash());
    const second = await run(slash());
    assert.equal(second.calls[0][1].content, '10');
    assert.equal(db.getVar(guild.id, 'user', '222222', 'coins'), 10);
    assert.equal(db.getVar('999999', 'user', '222222', 'coins'), undefined, 'another server sees nothing');
  });

  it('loops, sets run variables and follows Done afterwards', async () => {
    install(commandFlow(
      [node('l', 'logic.loop', { mode: 'list', items: 'a, b, c' }),
        node('v', 'data.variable.set', { scope: 'run', name: 'acc', operation: 'append', value: '{{loop.item}}' }),
        node('r', 'action.message.send', { target: 'reply', content: 'got {{var.acc}}' })],
      [edge('t', 'l'), edge('l', 'v', 'each'), edge('l', 'r', 'done')],
    ));
    assert.equal((await run(slash())).calls[0][1].content, 'got a, b, c');
  });

  it('cooldown blocks a second run', async () => {
    install(commandFlow(
      [node('cd', 'logic.cooldown', { seconds: 60, scope: 'user' }),
        node('ok', 'action.message.send', { target: 'reply', content: 'ok' }),
        node('no', 'action.message.send', { target: 'reply', content: 'wait {{cooldown.remaining}}s' })],
      [edge('t', 'cd'), edge('cd', 'ok', 'ok'), edge('cd', 'no', 'blocked')],
    ));
    assert.equal((await run(slash())).calls[0][1].content, 'ok');
    assert.match((await run(slash())).calls[0][1].content, /^wait \d+s$/);
  });
});

describe('errors and limits', () => {
  it('follows the error output with {{error.message}}', async () => {
    install(commandFlow(
      [node('g', 'action.member.addRole', { roleId: '31337' }),
        node('r', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })],
      [edge('t', 'g'), edge('g', 'r', 'error')],
    ));
    assert.match((await run(slash())).calls[0][1].content, /failed: Role “31337” was not found/);
  });

  it('an unhandled node error is logged and the user is told', async () => {
    install(commandFlow([node('g', 'action.member.addRole', { roleId: '31337' })], [edge('t', 'g')]));
    const i = await run(slash());
    assert.ok(logs().some((l) => l.startsWith('error: Give Role: Role “31337”')));
    assert.match(i.calls.at(-1)[1].content, /went wrong/);
  });

  it('stops endless loops after the step limit', async () => {
    applyLimits({ stepsPerRun: 500 });
    install(commandFlow(
      [node('a', 'logic.log', { message: 'a' }), node('b', 'logic.log', { message: 'b' })],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
    ));
    await run(slash());
    assert.ok(logs().some((l) => /Stopped after \d+ steps/.test(l)));
  });

  it('cannot reach a channel that belongs to another server', async () => {
    const other = fakeGuild({ id: '555555' });
    const foreign = other.addChannel({ name: 'secret' });
    guild.foreign = new Map([[foreign.id, foreign]]); // simulate fetch returning a foreign channel
    install(commandFlow(
      [node('s', 'action.message.send', { target: 'channel', channelId: foreign.id, content: 'leak' }),
        node('r', 'action.message.send', { target: 'reply', content: '{{error.message}}' })],
      [edge('t', 's'), edge('s', 'r', 'error')],
    ));
    const i = await run(slash());
    assert.deepEqual(foreign.sent, []);
    assert.match(i.calls[0][1].content, /not found in this server/);
  });

  it('cannot delete a foreign channel or give a foreign role', async () => {
    const other = fakeGuild({ id: '555555' });
    const foreign = other.addChannel({ name: 'secret' });
    const foreignRole = other.addRole({ name: 'admin' });
    guild.foreign = new Map([[foreign.id, foreign]]);
    install(commandFlow(
      [node('d', 'action.channel.delete', { channelId: foreign.id }), node('g', 'action.member.addRole', { roleId: foreignRole.id })],
      [edge('t', 'd'), edge('t', 'g')],
    ));
    await run(slash());
    assert.deepEqual(foreign.calls, []);
    assert.deepEqual(member.calls, []);
  });

  it('DMs only reach members of the server', async () => {
    install(commandFlow(
      [node('s', 'action.message.send', { target: 'dm', userId: '987654321', content: 'spam' }),
        node('r', 'action.message.send', { target: 'reply', content: '{{error.message}}' })],
      [edge('t', 's'), edge('s', 'r', 'error')],
    ));
    assert.match((await run(slash())).calls[0][1].content, /not a member of this server/);
  });

  it('throttles a server that starts too many runs', async () => {
    applyLimits({ runsPer10s: 40 });
    install(commandFlow([node('l', 'logic.log', { message: 'x' })], [edge('t', 'l')]));
    let throttled = 0;
    for (let n = 0; n < 60; n += 1) {
      const i = slash();
      await run(i);
      if (i.calls.some((c) => /Too many requests/.test(c[1]?.content ?? ''))) throttled += 1;
    }
    assert.ok(throttled > 0, 'some runs were throttled');
  });

  it('rate-limits mutating actions per server', async () => {
    applyLimits({ actionsPer10s: 25 });
    install(commandFlow(
      [node('l', 'logic.loop', { mode: 'repeat', count: 40 }), node('c', 'action.channel.create', { name: 'x{{loop.index}}' })],
      [edge('t', 'l'), edge('l', 'c', 'each')],
    ));
    await run(slash());
    assert.ok(guild.calls.filter((c) => c[0] === 'channelCreate').length <= 25);
    assert.ok(logs().some((l) => /rate limit/.test(l)));
  });
});

describe('interaction responses', () => {
  it('auto-defers slow flows, then edits the deferred reply', async () => {
    runtime.deferAfterMs = 10;
    install(commandFlow(
      [node('w', 'logic.wait', { seconds: 0.1 }), node('r', 'action.message.send', { target: 'reply', content: 'done' })],
      [edge('t', 'w'), edge('w', 'r')],
    ));
    const i = await run(slash());
    assert.deepEqual(i.calls.map((c) => c[0]), ['deferReply', 'editReply']);
  });

  it('a second reply becomes a follow-up', async () => {
    install(commandFlow(
      [node('a', 'action.message.send', { target: 'reply', content: '1' }), node('b', 'action.message.send', { target: 'reply', content: '2', ephemeral: true })],
      [edge('t', 'a'), edge('a', 'b')],
    ));
    assert.deepEqual((await run(slash())).calls.map((c) => c[0]), ['reply', 'followUp']);
  });

  it('a flow that never answers still gets a quiet acknowledgement', async () => {
    install(commandFlow([node('l', 'logic.log', { message: 'x' })], [edge('t', 'l')]));
    const i = await run(slash());
    assert.equal(i.calls[0][0], 'reply');
    assert.equal(i.calls[0][1].content, '✅ Done.');
  });
});

describe('buttons and select menus', () => {
  const panel = () => install({
    nodes: [
      node('t', 'trigger.command', { name: 'panel', description: 'x' }),
      node('m', 'action.message.send', {
        target: 'reply', content: 'pick', restrictToInvoker: false,
        buttons: [{ id: 'yes', label: 'Yes', style: 'Success' }, { id: 'no', label: 'No', style: 'Danger' }, { id: 'lnk', label: 'Docs', style: 'Link', url: 'https://example.com' }],
        menuEnabled: true, menuOptions: [{ id: 'red', label: 'Red' }, { id: 'blue', label: 'Blue' }],
        outputVar: 'panelMsg',
      }),
      node('setv', 'data.variable.set', { scope: 'run', name: 'token', operation: 'set', value: 'abc' }),
      node('yes', 'action.message.send', { target: 'reply', ephemeral: true, content: 'yes! {{original.user.name}} clicked-by={{user.name}} token={{var.token}}' }),
      node('no', 'action.role.create', { name: 'Nope-{{user.name}}', outputVar: 'r' }),
      node('red', 'action.message.send', { target: 'update', content: 'you chose {{select.value}}' }),
    ],
    edges: [edge('t', 'setv'), edge('setv', 'm'), edge('m', 'yes', 'btn_yes'), edge('m', 'no', 'btn_no'), edge('m', 'red', 'opt_red')],
  });

  const sentComponents = (i) => i.calls[0][1].components.flatMap((r) => r.components.map((c) => c.data));

  it('sends buttons whose ids route back to the right output, and keeps run variables', async () => {
    panel();
    const first = await run(slash('panel'));
    const comps = sentComponents(first);
    const yes = comps.find((c) => c.label === 'Yes');
    assert.match(yes.custom_id, /^fc:[a-z0-9]+:m:btn_yes:$/);
    assert.equal(comps.find((c) => c.label === 'Docs').url, 'https://example.com');
    assert.deepEqual(first.calls[0][1].allowedMentions, { parse: ['users'] }, '@everyone/roles are not pinged by default');

    const clicker = fakeUser({ id: '333333', username: 'bob' });
    const click = fakeComponent({ guild, channel, user: clicker, member: guild.addMember({ user: clicker }), customId: yes.custom_id, messageId: 'm1' });
    await run(click);
    assert.equal(click.calls[0][0], 'reply');
    assert.equal(click.calls[0][1].content, 'yes! mia clicked-by=bob token=abc');
  });

  it('routes a different button to a different action', async () => {
    panel();
    const first = await run(slash('panel'));
    const no = sentComponents(first).find((c) => c.label === 'No');
    await run(fakeComponent({ guild, channel, user, member, customId: no.custom_id, messageId: 'm1' }));
    assert.deepEqual(guild.calls.filter((c) => c[0] === 'roleCreate').map((c) => c[1].name), ['Nope-mia']);
  });

  it('select menus pick the output for the chosen option and can update the message', async () => {
    panel();
    const first = await run(slash('panel'));
    const menu = sentComponents(first).find((c) => c.type === 3); // StringSelect
    assert.match(menu.custom_id, /^fc:[a-z0-9]+:m:sel:$/);
    const pick = fakeComponent({ guild, channel, user, member, customId: menu.custom_id, messageId: 'm1', values: ['red'] });
    await run(pick);
    assert.equal(pick.calls[0][0], 'update');
    assert.equal(pick.calls[0][1].content, 'you chose red');
  });

  it('can restrict buttons to the person who ran the command', async () => {
    install({
      nodes: [node('t', 'trigger.command', { name: 'p', description: 'x' }),
        node('m', 'action.message.send', { target: 'reply', content: 'x', restrictToInvoker: true, buttons: [{ id: 'b', label: 'B', style: 'Primary' }] }),
        node('r', 'action.message.send', { target: 'reply', content: 'clicked' })],
      edges: [edge('t', 'm'), edge('m', 'r', 'btn_b')],
    });
    const first = await run(slash('p'));
    const id = sentComponents(first)[0].custom_id;
    const stranger = fakeUser({ id: '444444' });
    const click = fakeComponent({ guild, channel, user: stranger, member: guild.addMember({ user: stranger }), customId: id });
    await run(click);
    assert.match(click.calls[0][1].content, /Only <@222222> can use this/);
    const own = fakeComponent({ guild, channel, user, member, customId: id });
    await run(own);
    assert.equal(own.calls[0][1].content, 'clicked');
  });

  it('answers politely when the flow behind a button was deleted or disabled', async () => {
    const flow = panel();
    const first = await run(slash('panel'));
    const yes = sentComponents(first).find((c) => c.label === 'Yes');
    db.updateFlow(guild.id, flow.id, { enabled: false });
    runtime.loadGuild(guild.id);
    const click = fakeComponent({ guild, channel, user, member, customId: yes.custom_id });
    await run(click);
    assert.match(click.calls[0][1].content, /no longer active/);
  });

  it('a component id from another server\'s flow is rejected', async () => {
    const flow = panel();
    const first = await run(slash('panel'));
    const yes = sentComponents(first).find((c) => c.label === 'Yes');
    const otherGuild = fakeGuild({ id: '777777' });
    const ch = otherGuild.addChannel({});
    const u = fakeUser({ id: '888888' });
    const click = fakeComponent({ guild: otherGuild, channel: ch, user: u, member: otherGuild.addMember({ user: u }), customId: yes.custom_id });
    await run(click);
    assert.match(click.calls[0][1].content, /no longer active/);
    assert.equal(guild.calls.length, 0);
    assert.ok(flow);
  });
});

describe('actions', () => {
  it('creates a private channel with overwrites and saves its id', async () => {
    guild.addRole({ id: '424242', name: 'Staff' });
    install(commandFlow(
      [node('c', 'action.channel.create', {
        name: 'ticket-{{user.name}}', privateChannel: true, outputVar: 'ticket',
        overwrites: [{ targetType: 'member', targetId: '{{user.id}}', allow: ['ViewChannel', 'SendMessages'], deny: [] },
          { targetType: 'role', targetId: 'Staff', allow: ['ViewChannel'], deny: [] }],
      }),
      node('r', 'action.message.send', { target: 'reply', content: 'made <#{{var.ticket}}>' })],
      [edge('t', 'c'), edge('c', 'r')],
    ));
    const i = await run(slash());
    const [, options] = guild.calls.find((c) => c[0] === 'channelCreate');
    assert.equal(options.name, 'ticket-mia');
    const byId = Object.fromEntries(options.permissionOverwrites.map((o) => [o.id, o]));
    assert.ok(byId['111111'].deny.length, '@everyone loses ViewChannel');
    assert.ok(byId['222222'].allow.length);
    assert.ok(byId['424242'].allow.length, 'role resolved by name');
    assert.ok(byId.BOT.allow.length, 'the bot keeps access');
    assert.match(i.calls[0][1].content, /^made <#\d+>$/);
  });

  it('kick, ban, timeout, nickname and role changes carry an audit reason with the flow name', async () => {
    const role = guild.addRole({ name: 'Member' });
    install(commandFlow(
      [node('a', 'action.member.addRole', { roleId: role.id, reason: 'welcome' }),
        node('b', 'action.member.timeout', { minutes: 5 }),
        node('c', 'action.member.nickname', { nickname: 'Mia!' }),
        node('d', 'action.member.ban', { userId: '123456', deleteMessageDays: 1 })],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
    ), guild.id, 'Moderation');
    await run(slash());
    assert.deepEqual(member.calls[0], ['roleAdd', role.id, '[Moderation] welcome']);
    assert.deepEqual(member.calls[1], ['timeout', 300000, '[Moderation]']);
    assert.equal(member.calls[2][1], 'Mia!');
    assert.deepEqual(guild.calls[0], ['ban', '123456', { reason: '[Moderation]', deleteMessageSeconds: 86400 }]);
  });

  it('marks bot-caused changes so their events are ignored', async () => {
    const role = guild.addRole({ name: 'X' });
    install(commandFlow([node('a', 'action.member.addRole', { roleId: role.id })], [edge('t', 'a')]));
    await run(slash());
    assert.equal(runtime.services.selfActions.consume(`roleAdd:${guild.id}:222222:${role.id}`), true);
    assert.equal(runtime.services.selfActions.consume(`roleAdd:${guild.id}:222222:${role.id}`), false);
  });

  it('the modal node waits for the form and exposes the answers', async () => {
    install(commandFlow(
      [node('m', 'action.modal.show', { title: 'Feedback', inputs: [{ id: 'topic', label: 'Topic', style: 'short', required: true }] }),
        node('r', 'action.message.send', { target: 'reply', content: 'thanks: {{input.topic}}' })],
      [edge('t', 'm'), edge('m', 'r', 'submit')],
    ));
    const i = slash();
    i.showModal = async (modal) => { i.calls.push(['showModal', modal.data.title]); };
    const submit = fakeComponent({ guild, channel, user, member, customId: 'x' });
    submit.isMessageComponent = () => false;
    submit.isModalSubmit = () => true;
    submit.isFromMessage = () => false;
    submit.fields = { getTextInputValue: (id) => (id === 'in_topic' ? 'pizza' : '') };
    i.awaitModalSubmit = async () => submit;
    await run(i);
    assert.equal(i.calls[0][0], 'showModal');
    assert.equal(submit.calls[0][1].content, 'thanks: pizza');
  });

  it('a message trigger filter sets {{message.after}} and ignores bots', async () => {
    install({
      nodes: [node('t', 'trigger.message.received', { mode: 'startsWith', text: '!echo' }),
        node('s', 'action.message.send', { target: 'current_channel', content: 'echo: {{message.after}}' })],
      edges: [edge('t', 's')],
    });
    const msg = { id: 'mm1', content: '!echo hello there', author: user, url: 'u' };
    await runtime.fire('trigger.message.received', { guild, channel, user, member, message: msg, info: { content: msg.content, channelId: channel.id, isBot: false } });
    assert.equal(channel.sent[0].content, 'echo: hello there');
    await runtime.fire('trigger.message.received', { guild, channel, user, member, message: msg, info: { content: msg.content, channelId: channel.id, isBot: true } });
    assert.equal(channel.sent.length, 1, 'bot messages are ignored by default');
    await runtime.fire('trigger.message.received', { guild, channel, user, member, message: { ...msg, content: 'nope' }, info: { content: 'nope', channelId: channel.id } });
    assert.equal(channel.sent.length, 1);
  });

  it('event triggers skip bot-caused events unless includeSelf is on', async () => {
    install({ nodes: [node('t', 'trigger.channel.created'), node('l', 'logic.log', { message: 'created {{channel.name}}' })], edges: [edge('t', 'l')] });
    const ch = fakeChannel(guild, { name: 'new' });
    await runtime.fire('trigger.channel.created', { guild, channel: ch, info: { byBot: true } });
    assert.ok(!logs().some((l) => l.includes('created new')));
    await runtime.fire('trigger.channel.created', { guild, channel: ch, info: { byBot: false } });
    assert.ok(logs().some((l) => l.includes('created new')));
  });

  it('does not activate triggers that need an intent the operator has not enabled', async () => {
    setup({ members: false, messageContent: false });
    install({ nodes: [node('t', 'trigger.member.join'), node('l', 'logic.log', { message: 'hi' })], edges: [edge('t', 'l')] });
    assert.equal(runtime.hasTrigger(guild.id, 'trigger.member.join'), false);
    assert.ok(logs().some((l) => /needs the Server Members intent/.test(l)));
  });

  it('manual triggers only run when active and post to the chosen channel', async () => {
    const flow = install({
      nodes: [node('t', 'trigger.manual', { channelId: channel.id }), node('s', 'action.message.send', { target: 'current_channel', content: 'panel' })],
      edges: [edge('t', 's')],
    });
    const res = await runtime.runManual(guild.id, flow.id, 't');
    assert.equal(res.ok, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(channel.sent[0].content, 'panel');
    assert.equal((await runtime.runManual(guild.id, flow.id, 'nope')).ok, false);
    assert.equal((await runtime.runManual('otherguild', flow.id, 't')).ok, false);
  });
});

describe('unlimited by default', () => {
  const settle = (promise, ms = 5000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('the run did not stop')), ms))]);
  const switchOff = (flow) => { db.updateFlow(guild.id, flow.id, { enabled: false }); runtime.loadGuild(guild.id); };

  it('an endless loop neither freezes the bot nor survives switching the flow off', async () => {
    const flow = install(commandFlow(
      [node('a', 'logic.log', { message: 'a' }), node('b', 'logic.log', { message: 'b' })],
      [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')],
    ));
    const running = run(slash());
    let timerFired = false;
    await new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 50));
    assert.ok(timerFired, 'timers still fire while the loop spins (it yields to the event loop)');
    switchOff(flow);
    await settle(running);
    assert.ok(logs().some((l) => /Stopped 1 running instance\(s\) of “Test flow”/.test(l)));
    assert.ok(logs().some((l) => /was stopped/.test(l)));
    assert.ok(!logs().some((l) => /^error:/.test(l)), 'stopping is not an error');
  });

  it('a huge repeat loop runs lazily and finishes', async () => {
    install(commandFlow(
      [node('l', 'logic.loop', { mode: 'repeat', count: 200000 }), node('r', 'action.message.send', { target: 'reply', content: 'done' })],
      [edge('t', 'l'), edge('l', 'r', 'done')],
    ));
    const started = Date.now();
    const i = await settle(run(slash()), 20000);
    assert.equal(i.calls[0][1].content, 'done');
    assert.ok(Date.now() - started < 15000);
  });

  it('a loop of a billion iterations is never materialised and can be stopped', async () => {
    const flow = install(commandFlow(
      [node('l', 'logic.loop', { mode: 'repeat', count: 1e9 })],
      [edge('t', 'l')],
    ));
    const running = run(slash());
    await new Promise((resolve) => setTimeout(resolve, 100));
    switchOff(flow);
    await settle(running);
  });

  it('a very long wait ends as soon as the flow is switched off', async () => {
    const flow = install(commandFlow(
      [node('w', 'logic.wait', { seconds: 1e9 }), node('r', 'action.message.send', { target: 'reply', content: 'never' })],
      [edge('t', 'w'), edge('w', 'r')],
    ));
    const i = slash();
    const running = run(i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    switchOff(flow);
    await settle(running, 2000);
    assert.ok(!i.calls.some((c) => c[1]?.content === 'never'));
  });

  it('saving an edited flow does not kill runs that are still going', async () => {
    const flow = install(commandFlow(
      [node('w', 'logic.wait', { seconds: 0.15 }), node('r', 'action.message.send', { target: 'reply', content: 'finished' })],
      [edge('t', 'w'), edge('w', 'r')],
    ));
    const i = slash();
    const running = run(i);
    await new Promise((resolve) => setTimeout(resolve, 30));
    db.updateFlow(guild.id, flow.id, { name: 'Renamed' });
    runtime.loadGuild(guild.id);
    await settle(running);
    assert.ok(i.calls.some((c) => c[1]?.content === 'finished'));
  });

  it('fan-out runs top to bottom and finishes each branch before the next (depth-first)', async () => {
    install(commandFlow(
      [node('b', 'logic.log', { message: 'B' }, 0, 300), node('a', 'logic.log', { message: 'A' }, 0, 100), node('a2', 'logic.log', { message: 'A2' }, 300, 100)],
      [edge('t', 'b'), edge('t', 'a'), edge('a', 'a2')],
    ));
    await run(slash());
    assert.deepEqual(logs().filter((l) => /^info: (A|A2|B)$/.test(l)), ['info: A', 'info: A2', 'info: B']);
  });

  it('a branch that fans out and loops back is cut off at the pending-branch ceiling', async () => {
    // a -> b (dead end) and a -> c -> a: every lap leaves one more dead-end branch waiting on the stack.
    const before = CEILINGS.pendingBranches;
    CEILINGS.pendingBranches = 50;
    try {
      install(commandFlow(
        [node('a', 'logic.log', { message: 'a' }, 0, 200), node('b', 'logic.log', { message: 'b' }, 300, 300), node('c', 'logic.log', { message: 'c' }, 300, 100)],
        [edge('t', 'a'), edge('a', 'b'), edge('a', 'c'), edge('c', 'a')],
      ));
      await run(slash());
      assert.ok(logs().some((l) => /^error: .*Too many branches/.test(l)));
    } finally { CEILINGS.pendingBranches = before; }
  });
});
