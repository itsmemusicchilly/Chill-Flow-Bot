import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { TEMPLATES } from '../shared/templates.js';
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

describe('reusable buttons and persistent panels', () => {
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const rows = (payload) => payload.components.flatMap((r) => r.components.map((c) => c.data));
  const click = (customId, over = {}) => fakeComponent({ guild, channel, user, member, customId, ...over });

  /** A panel posted by the manual trigger and answered by a "Button Clicked" trigger. */
  function installPanel(replyContent = 'hi {{user.name}} id={{button.id}} label={{button.label}}') {
    return install({
      nodes: [
        node('t', 'trigger.manual', { channelId: channel.id }),
        node('p', 'action.message.send', { target: 'current_channel', content: 'Open a ticket', buttons: [{ id: 'open', label: 'Open', style: 'Success', customId: 'open_ticket' }] }),
        node('h', 'trigger.button.clicked', { customId: 'open_ticket' }),
        node('r', 'action.message.send', { target: 'reply', ephemeral: true, content: replyContent }),
      ],
      edges: [edge('t', 'p'), edge('h', 'r')],
    });
  }
  const post = async (flow, triggerId = 't') => {
    const before = channel.sent.length;
    await runtime.runManual(guild.id, flow.id, triggerId);
    await settle();
    assert.equal(channel.sent.length, before + 1, 'the panel was posted');
    return { payload: channel.sent.at(-1), messageId: channel.sentIds.at(-1) };
  };

  it('a Button ID makes an fcb: button with no output of its own, answered by the matching trigger on every copy of the message', async () => {
    const flow = installPanel();
    const first = await post(flow);
    const btn = rows(first.payload)[0];
    assert.equal(btn.custom_id, 'fcb:open_ticket:');
    const a = await run(click(btn.custom_id, { messageId: first.messageId, label: 'Open' }));
    assert.equal(a.calls[0][0], 'reply');
    assert.equal(a.calls[0][1].content, 'hi mia id=open_ticket label=Open');
    assert.ok(a.calls[0][1].flags, 'the reply is ephemeral');

    const second = await post(flow); // reposting the panel anywhere just works
    const b = await run(click(rows(second.payload)[0].custom_id, { messageId: second.messageId, label: 'Open' }));
    assert.equal(b.calls[0][1].content, 'hi mia id=open_ticket label=Open');
  });

  it('gives every click its own variables, even on the same panel message', async () => {
    install({
      nodes: [
        node('t', 'trigger.command', { name: 'panel', description: 'x' }),
        node('m', 'action.message.send', { target: 'reply', content: 'go', buttons: [{ id: 'g', label: 'Go', style: 'Primary', customId: 'go' }] }),
        node('h', 'trigger.button.clicked', { customId: 'go' }),
        node('r', 'action.message.send', { target: 'reply', content: 'seen={{var.seen | default:none}}' }),
        node('v', 'data.variable.set', { scope: 'run', name: 'seen', operation: 'set', value: 'yes' }),
      ],
      edges: [edge('t', 'm'), edge('h', 'r'), edge('r', 'v')],
    });
    const first = await run(slash('panel'));
    const id = rows(first.calls[0][1])[0].custom_id;
    const a = await run(click(id, { messageId: 'm1' }));
    const b = await run(click(id, { messageId: 'm1' }));
    assert.equal(a.calls[0][1].content, 'seen=none');
    assert.equal(b.calls[0][1].content, 'seen=none', 'the first click did not leak its variables into the second');
  });

  it('still knows the original run and its variables after a restart', async () => {
    install({
      nodes: [
        node('t', 'trigger.command', { name: 'panel', description: 'x' }),
        node('v', 'data.variable.set', { scope: 'run', name: 'ticket', operation: 'set', value: 'abc' }),
        node('m', 'action.message.send', { target: 'reply', content: 'go', buttons: [{ id: 'g', label: 'Go', style: 'Primary', customId: 'go' }] }),
        node('h', 'trigger.button.clicked', { customId: 'go' }),
        node('r', 'action.message.send', { target: 'reply', content: '{{original.user.name}}/{{var.ticket}}/{{user.name}}' }),
      ],
      edges: [edge('t', 'v'), edge('v', 'm'), edge('h', 'r')],
    });
    const first = await run(slash('panel'));
    const id = rows(first.calls[0][1])[0].custom_id;

    // "restart": a brand-new runtime on the same database
    runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
    runtime.attachClient(guild.client);
    runtime.loadGuild(guild.id);
    const clicker = fakeUser({ id: '333333', username: 'bob' });
    const after = await run(click(id, { messageId: 'm1', user: clicker, member: guild.addMember({ user: clicker }) }));
    assert.equal(after.calls[0][1].content, 'mia/abc/bob');
  });

  it('keeps the person-only restriction and answers politely when nothing handles the button', async () => {
    install({
      nodes: [
        node('t', 'trigger.command', { name: 'p', description: 'x' }),
        node('m', 'action.message.send', { target: 'reply', content: 'x', restrictToInvoker: true, buttons: [{ id: 'g', label: 'Go', style: 'Primary', customId: 'go' }] }),
        node('h', 'trigger.button.clicked', { customId: 'go' }),
        node('r', 'action.message.send', { target: 'reply', content: 'ok' }),
      ],
      edges: [edge('t', 'm'), edge('h', 'r')],
    });
    const first = await run(slash('p'));
    const id = rows(first.calls[0][1])[0].custom_id;
    assert.equal(id, 'fcb:go:222222');
    const stranger = fakeUser({ id: '444444' });
    const denied = await run(click(id, { user: stranger, member: guild.addMember({ user: stranger }) }));
    assert.match(denied.calls[0][1].content, /Only <@222222> can use this/);
    assert.equal((await run(click(id))).calls[0][1].content, 'ok');

    assert.match((await run(click('fcb:nobody:'))).calls[0][1].content, /no longer active/);
    const dm = fakeComponent({ guild: null, channel, user, member, customId: id });
    assert.match((await run(dm)).calls[0][1].content, /only works inside a server/);
  });

  it('never lets one server\'s button reach another server\'s flow, and stops when the flow is off', async () => {
    const flow = installPanel();
    const otherGuild = fakeGuild({ id: '777777' });
    const ch = otherGuild.addChannel({});
    const u = fakeUser({ id: '888888' });
    const foreign = fakeComponent({ guild: otherGuild, channel: ch, user: u, member: otherGuild.addMember({ user: u }), customId: 'fcb:open_ticket:' });
    assert.match((await run(foreign)).calls[0][1].content, /no longer active/);

    db.updateFlow(guild.id, flow.id, { enabled: false });
    runtime.loadGuild(guild.id);
    assert.match((await run(click('fcb:open_ticket:'))).calls[0][1].content, /no longer active/);
  });

  it('lets only the first flow handle a Button ID and warns about the other', async () => {
    installPanel('first');
    install({
      nodes: [node('h', 'trigger.button.clicked', { customId: 'open_ticket' }), node('r', 'action.message.send', { target: 'reply', content: 'second' })],
      edges: [edge('h', 'r')],
    }, guild.id, 'Copycat');
    const i = await run(click('fcb:open_ticket:'));
    assert.equal(i.calls[0][1].content, 'first');
    assert.ok(logs().some((l) => l.startsWith('warn:') && /open_ticket/.test(l) && /Copycat/.test(l)), logs().join('\n'));
  });

  it('refuses a Button ID that becomes invalid once templates are filled in', async () => {
    install(commandFlow(
      [node('m', 'action.message.send', { target: 'reply', content: 'x', buttons: [{ id: 'g', label: 'Go', style: 'Primary', customId: '{{option.x}}' }] })],
      [edge('t', 'm')],
    ));
    const i = await run(slash('cmd', [{ name: 'x', value: 'fcb:evil id' }]));
    assert.ok(logs().some((l) => l.startsWith('error:') && /Button ID/.test(l)), logs().join('\n'));
    assert.ok(!i.calls.some((c) => c[0] === 'reply' && c[1].components), 'no message with a bad id was sent');
  });

  it('Toggle Role adds, then removes, then adds again — and its own changes do not trigger role events', async () => {
    const role = guild.addRole({ name: 'Gamer' });
    install({
      nodes: [
        node('h', 'trigger.button.clicked', { customId: 'gamer' }),
        node('g', 'action.member.toggleRole', { roleId: role.id, reason: 'panel' }),
        node('r', 'action.message.send', { target: 'reply', ephemeral: true, content: '{{role.name}} {{toggle.action}}' }),
      ],
      edges: [edge('h', 'g'), edge('g', 'r')],
    });
    const said = [];
    for (let n = 0; n < 3; n += 1) said.push((await run(click('fcb:gamer:'))).calls[0][1].content);
    assert.deepEqual(said, ['Gamer added', 'Gamer removed', 'Gamer added']);
    assert.deepEqual(member.calls.map((c) => c[0]), ['roleAdd', 'roleRemove', 'roleAdd']);
    assert.equal(member.calls[0][2], '[Test flow] panel');
    assert.equal(member.roles.cache.has(role.id), true);
    assert.equal(runtime.services.selfActions.consume(`roleAdd:${guild.id}:222222:${role.id}`), true);
  });

  it('the Button role panel template toggles roles from its own buttons', async () => {
    const gamer = guild.addRole({ name: 'Gamer' });
    const t = TEMPLATES.find((x) => x.id === 'role-panel').build();
    t.nodes.find((x) => x.id === 't1').data.channelId = channel.id;
    t.nodes.find((x) => x.id === 'g1').data.roleId = gamer.id;
    const flow = install(t);
    await runtime.runManual(guild.id, flow.id, 't1');
    await settle();
    const gamerBtn = rows(channel.sent.at(-1)).find((c) => c.label === 'Gamer');
    assert.equal((await run(click(gamerBtn.custom_id, { messageId: channel.sentIds.at(-1) }))).calls[0][1].content, 'The **Gamer** role was added ✅');
    assert.equal((await run(click(gamerBtn.custom_id, { messageId: channel.sentIds.at(-1) }))).calls[0][1].content, 'The **Gamer** role was removed ✅');
  });

  it('the Ticket panel template opens one ticket per press window and closes it with the opener remembered', async () => {
    const t = TEMPLATES.find((x) => x.id === 'ticket-panel').build();
    t.nodes.find((x) => x.id === 't1').data.channelId = channel.id;
    t.nodes.find((x) => x.id === 'w1').data.seconds = 0; // do not really wait 5 s
    const logCh = guild.addChannel({ name: 'ticket-log' });
    t.nodes.find((x) => x.id === 'ts1').data.sendChannelId = logCh.id;
    const flow = install(t);
    const panel = await post(flow, 't1');
    const open = rows(panel.payload)[0];
    assert.equal(open.custom_id, 'fcb:open_ticket:');

    const opened = await run(click(open.custom_id, { messageId: panel.messageId }));
    assert.match(opened.calls[0][1].content, /^Your ticket is ready: <#\d+>$/);
    const ticket = guild.channels.cache.find((c) => c.name === 'ticket-mia');
    assert.ok(ticket, 'a private ticket channel was created');

    const again = await run(click(open.custom_id, { messageId: panel.messageId }));
    assert.match(again.calls[0][1].content, /^Please wait \d+ seconds/, 'a second press right away is held back');
    assert.equal([...guild.channels.cache.values()].filter((c) => c.name === 'ticket-mia').length, 1);

    const close = rows(ticket.sent[0]).find((c) => c.label === 'Close ticket');
    assert.match(close.custom_id, /^fc:[a-z0-9]+:s1:btn_close:$/);
    const staff = fakeUser({ id: '555555', username: 'sam' });
    const closed = await run(fakeComponent({ guild, channel: ticket, user: staff, member: guild.addMember({ user: staff }), customId: close.custom_id, messageId: ticket.sentIds[0] }));
    assert.equal(closed.calls[0][1].content, 'Closing this ticket (opened by <@222222>) in 5 seconds…');
    assert.ok(ticket.calls.some((c) => c[0] === 'delete'), 'the ticket channel was deleted');

    // the transcript went to the log channel and to the opener before the channel disappeared
    const file = logCh.sent[0].files[0];
    assert.match(file.name, /^transcript-ticket-mia-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);
    assert.match(file.attachment.toString('utf8'), /opened a ticket\. Someone from the team/);
    assert.match(logCh.sent[0].content, /opened by <@222222>, closed by <@555555>/);
    const dm = member.calls.find((c) => c[0] === 'dm');
    assert.ok(dm, 'the opener got a copy');
    assert.equal(dm[1].files[0].name, file.name);
    // and both files came along, in the log channel and in the DM: the .html first, then the plain-text copy
    assert.deepEqual(logCh.sent[0].files.map((f) => f.name.split('.').pop()), ['html', 'txt']);
    assert.deepEqual(dm[1].files.map((f) => f.name), logCh.sent[0].files.map((f) => f.name));
    assert.match(logCh.sent[0].files[1].attachment.toString('utf8'), /opened a ticket\. Someone from the team/);
  });

  it('the Ticket panel does NOT close when the transcript cannot be saved (no log channel picked)', async () => {
    const t = TEMPLATES.find((x) => x.id === 'ticket-panel').build();
    t.nodes.find((x) => x.id === 't1').data.channelId = channel.id;
    t.nodes.find((x) => x.id === 'w1').data.seconds = 0;
    const flow = install(t); // ts1.sendChannelId is still blank
    const panel = await post(flow, 't1');
    await run(click(rows(panel.payload)[0].custom_id, { messageId: panel.messageId }));
    const ticket = guild.channels.cache.find((c) => c.name === 'ticket-mia');
    const close = rows(ticket.sent[0]).find((c) => c.label === 'Close ticket');
    const closed = await run(fakeComponent({ guild, channel: ticket, user, member, customId: close.custom_id, messageId: ticket.sentIds[0] }));
    assert.match(closed.calls[0][1].content, /transcript could not be saved, so this ticket was \*\*not\*\* closed: Choose the channel to post the transcript in/);
    assert.ok(!ticket.calls.some((c) => c[0] === 'delete'), 'the ticket is still there');
  });

  it('the /ticket template saves a transcript on close too', async () => {
    const t = TEMPLATES.find((x) => x.id === 'ticket').build();
    t.nodes.find((x) => x.id === 'w1').data.seconds = 0;
    const logCh = guild.addChannel({ name: 'ticket-log' });
    t.nodes.find((x) => x.id === 'ts1').data.sendChannelId = logCh.id;
    install(t);
    await run(slash('ticket', [{ name: 'reason', value: 'billing' }]));
    const ticket = guild.channels.cache.find((c) => c.name === 'ticket-mia');
    ticket.addMessage({ content: 'my invoice is wrong', author: { id: '222222', username: 'mia', bot: false } });
    const close = rows(ticket.sent[0]).find((c) => c.label === 'Close ticket');
    const staff = fakeUser({ id: '555555', username: 'sam' });
    const closed = await run(fakeComponent({ guild, channel: ticket, user: staff, member: guild.addMember({ user: staff }), customId: close.custom_id, messageId: ticket.sentIds[0] }));
    assert.equal(closed.calls[0][1].content, 'Closing this ticket in 5 seconds…');
    const html = logCh.sent[0].files[0].attachment.toString('utf8');
    assert.match(html, /my invoice is wrong/);
    assert.match(html, /Reason:<\/b> billing|\*\*Reason:\*\* billing/);
    assert.ok(ticket.calls.some((c) => c[0] === 'delete'));
    assert.ok(member.calls.some((c) => c[0] === 'dm' && c[1].files?.length), 'the opener got the file');
  });
});

describe('Save Transcript', () => {
  let logCh;
  const human = (id = '222222', username = 'mia') => ({ id, username, bot: false });
  const saved = (over = {}) => install(commandFlow([
    node('ts', 'action.channel.transcript', { sendChannelId: logCh.id, delivery: 'files', ...over }),
    node('ok', 'action.message.send', { target: 'reply', content: 'saved={{transcript.messages}} dm={{transcript.dm}} cut={{transcript.truncated}} name={{transcript.name}}' }),
    node('bad', 'action.message.send', { target: 'reply', content: 'FAILED {{error.message}}' }),
  ], [edge('t', 'ts'), edge('ts', 'ok'), edge('ts', 'bad', 'error')]));
  const said = (i) => i.calls.find((c) => c[0] === 'reply' || c[0] === 'editReply')[1].content;
  const html = (ch = logCh) => ch.sent[0].files[0].attachment.toString('utf8');

  beforeEach(() => { logCh = guild.addChannel({ name: 'ticket-log' }); });

  it('records the channel and posts it as an .html file in the log channel', async () => {
    channel.addMessage({ content: 'hello there', author: human() });
    channel.addMessage({ content: 'how can I help?', author: { id: '999', username: 'sam', bot: false } });
    saved({ channelMessage: 'Transcript of #{{channel.name}}' });
    const i = await run(slash());
    assert.match(said(i), /^saved=2 dm=skipped cut=false name=transcript-general-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);
    assert.equal(logCh.sent.length, 1);
    assert.equal(logCh.sent[0].content, 'Transcript of #general');
    assert.deepEqual(logCh.sent[0].allowedMentions, { parse: [] }, 'a transcript never pings anyone');
    assert.match(logCh.sent[0].files[0].name, /\.html$/);
    const out = html();
    assert.ok(out.indexOf('hello there') < out.indexOf('how can I help?'));
    assert.match(out, /Channel: #general/);
    assert.equal(channel.sent.length, 0, 'nothing is posted in the recorded channel itself');
  });

  it('attaches a plain-text (.txt) copy next to the .html, in the same message, with the same messages', async () => {
    channel.addMessage({ content: 'hello there', author: human() });
    channel.addMessage({ content: 'how can I help?', author: { id: '999', username: 'sam', bot: false } });
    saved();
    const i = await run(slash());
    assert.match(said(i), /^saved=2 dm=skipped cut=false name=transcript-general-\d{4}-\d{2}-\d{2}-\d{4}\.html$/, 'the name output stays the .html');
    assert.equal(logCh.sent.length, 1, 'one message carries both files');
    const [page, plain] = logCh.sent[0].files;
    assert.match(page.name, /\.html$/);
    assert.equal(plain.name, page.name.replace(/\.html$/, '.txt'));
    const txt = plain.attachment.toString('utf8');
    assert.match(txt, /^Transcript of #general\n/);
    assert.match(txt, /\| 2 messages\n/);
    assert.match(txt, /^\[[^\]]+ UTC\] mia \(222222\)\n {4}hello there$/m);
    assert.match(txt, /^\[[^\]]+ UTC\] sam \(999\)\n {4}how can I help\?$/m);
    assert.ok(txt.indexOf('hello there') < txt.indexOf('how can I help?'));
    assert.ok(!/<[a-z]/i.test(txt), 'plain text, no markup');
    assert.deepEqual(logCh.sent[0].allowedMentions, { parse: [] });
  });

  it('gives the plain-text name to later nodes as {{transcript.textName}}', async () => {
    install(commandFlow([
      node('ts', 'action.channel.transcript', { sendChannelId: logCh.id, delivery: 'files' }),
      node('ok', 'action.message.send', { target: 'reply', content: 'html={{transcript.name}} txt={{transcript.textName}}' }),
    ], [edge('t', 'ts'), edge('ts', 'ok')]));
    const said2 = said(await run(slash()));
    const [, htmlName, txtName] = said2.match(/^html=(\S+) txt=(\S+)$/);
    assert.equal(txtName, htmlName.replace(/\.html$/, '.txt'));
    assert.equal(logCh.sent[0].files[1].name, txtName);
  });

  it('sends both files in the direct message too', async () => {
    const opener = guild.addMember({ user: fakeUser({ id: '700010', username: 'tess' }) });
    channel.addMessage({ content: 'hi', author: human('700010', 'tess') });
    saved({ sendUserId: opener.id });
    assert.match(said(await run(slash())), /dm=sent/);
    const [, dm] = opener.calls.find((c) => c[0] === 'dm');
    assert.deepEqual(dm.files.map((f) => f.name), logCh.sent[0].files.map((f) => f.name));
    assert.equal(dm.files.length, 2);
    assert.ok(dm.files[1].attachment.equals(logCh.sent[0].files[1].attachment), 'the same plain-text file');
  });

  it('“Leave out the plain-text copy” sends the .html alone and leaves {{transcript.textName}} blank', async () => {
    channel.addMessage({ content: 'hello', author: human() });
    install(commandFlow([
      node('ts', 'action.channel.transcript', { sendChannelId: logCh.id, delivery: 'files', skipText: true }),
      node('ok', 'action.message.send', { target: 'reply', content: 'txt=[{{transcript.textName}}]' }),
    ], [edge('t', 'ts'), edge('ts', 'ok')]));
    assert.equal(said(await run(slash())), 'txt=[]');
    assert.deepEqual(logCh.sent[0].files.map((f) => f.name.split('.').pop()), ['html']);
  });

  it('a Save Transcript node saved before this option existed also gets the .txt', async () => {
    channel.addMessage({ content: 'hello', author: human() });
    saved({ skipText: undefined }); // the field is simply missing from the saved flow
    assert.match(said(await run(slash())), /^saved=1 /);
    assert.deepEqual(logCh.sent[0].files.map((f) => f.name.split('.').pop()), ['html', 'txt']);
  });

  it('the plain-text copy says why message text is missing when the Message Content intent is off', async () => {
    runtime.services.intents = { members: true, messageContent: false };
    channel.addMessage({ content: '', author: human() });
    saved();
    await run(slash());
    const txt = logCh.sent[0].files[1].attachment.toString('utf8');
    assert.match(txt, /^NOTE: Message text is not included/m);
    assert.match(txt, /\[content unavailable\]/);
  });

  it('reads long channels page by page, oldest first, whichever order Discord sends a page in', async () => {
    for (const order of ['desc', 'asc']) {
      channel.messages.store.clear(); channel.messages.fetchCalls.length = 0; logCh.sent.length = 0; channel.messages.order = order;
      for (let n = 0; n < 250; n += 1) channel.addMessage({ content: `msg-${String(n).padStart(3, '0')}`, author: human() });
      const flow = saved();
      const i = await run(slash());
      assert.match(said(i), /^saved=250 /, order);
      assert.equal(channel.messages.fetchCalls.length, 3, `${order}: 100 + 100 + 50`);
      assert.deepEqual(channel.messages.fetchCalls.map((c) => [c.limit, c.cache]), [[100, false], [100, false], [100, false]]);
      assert.equal(channel.messages.fetchCalls[0].after, '0');
      const out = html();
      assert.ok(out.indexOf('msg-000') < out.indexOf('msg-100') && out.indexOf('msg-100') < out.indexOf('msg-249'), `${order}: in order`);
      assert.equal((out.match(/msg-\d{3}/g) || []).length, 250, `${order}: none lost or repeated`);
      db.deleteFlow(guild.id, flow.id);
      runtime.loadGuild(guild.id);
    }
  });

  it('sends a copy to the person by direct message when asked', async () => {
    const opener = guild.addMember({ user: fakeUser({ id: '700001', username: 'olly' }) });
    channel.addMessage({ content: 'hi', author: human('700001', 'olly') });
    saved({ sendUserId: '{{user.id}}', dmMessage: 'Your copy, {{user.name}}' });
    const i = await run(fakeCommand({ guild, channel, user: opener.user, member: opener, commandName: 'cmd' }));
    assert.match(said(i), /dm=sent/);
    const [, dm] = opener.calls.find((c) => c[0] === 'dm');
    assert.equal(dm.content, 'Your copy, olly');
    assert.equal(dm.files[0].name, logCh.sent[0].files[0].name);
    assert.deepEqual(dm.allowedMentions, { parse: [] });
    assert.ok(dm.files[0].attachment.equals(logCh.sent[0].files[0].attachment), 'the same file');
  });

  it('a closed DM does not fail the node: the log copy stands, the run carries on, a warning is logged', async () => {
    const opener = guild.addMember({ user: fakeUser({ id: '700002', username: 'quiet' }) });
    opener.send = async () => { const e = new Error('Cannot send messages to this user'); e.code = 50007; throw e; };
    saved({ sendUserId: opener.id });
    const i = await run(slash());
    assert.match(said(i), /dm=failed/);
    assert.equal(logCh.sent.length, 1);
    assert.ok(logs().some((l) => l.startsWith('warn:') && /direct message/.test(l) && /DMs are closed/.test(l)), logs().join('\n'));
  });

  it('does not DM someone who can no longer see the channel', async () => {
    const opener = guild.addMember({ user: fakeUser({ id: '700003', username: 'gone' }) });
    channel.hidden.add(opener.id);
    saved({ sendUserId: opener.id });
    const i = await run(slash());
    assert.match(said(i), /dm=skipped/);
    assert.ok(!opener.calls.some((c) => c[0] === 'dm'));
    assert.equal(logCh.sent.length, 1);
  });

  it('follows On error, and sends nothing, when there is no usable log channel', async () => {
    const opener = guild.addMember({ user: fakeUser({ id: '700004' }) });
    saved({ sendChannelId: '', sendUserId: opener.id });
    assert.match(said(await run(slash())), /^FAILED Choose the channel to post the transcript in/, 'blank would otherwise mean "this channel"');
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    saved({ sendChannelId: channel.id });
    assert.match(said(await run(slash())), /^FAILED Post the transcript in a different channel/);
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    saved({ sendChannelId: '999999999' });
    assert.match(said(await run(slash())), /^FAILED Channel “999999999” was not found/);
    assert.equal(logCh.sent.length, 0);
    assert.ok(!opener.calls.some((c) => c[0] === 'dm'), 'no DM when the log copy could not be saved');
  });

  it('follows On error when Discord refuses the log post, before any DM is sent', async () => {
    const opener = guild.addMember({ user: fakeUser({ id: '700005' }) });
    logCh.send = async () => { const e = new Error('Missing Permissions'); e.code = 50013; throw e; };
    saved({ sendUserId: opener.id });
    assert.match(said(await run(slash())), /^FAILED Missing permissions/);
    assert.ok(!opener.calls.some((c) => c[0] === 'dm'));
  });

  it('follows On error when the history cannot be read', async () => {
    channel.messages.fetch = async () => { const e = new Error('Missing Access'); e.code = 50001; throw e; };
    saved();
    assert.match(said(await run(slash())), /^FAILED Missing access/);
    assert.equal(logCh.sent.length, 0);
  });

  it('refuses to record the same channel twice at the same time (a double-click on Close)', async () => {
    channel.addMessage({ content: 'x', author: human() });
    const real = channel.messages.fetch.bind(channel.messages);
    let release; const gate = new Promise((r) => { release = r; });
    channel.messages.fetch = async (a) => { await gate; return real(a); };
    saved();
    const first = run(slash());
    await new Promise((r) => setTimeout(r, 20));
    assert.match(said(await run(slash())), /^FAILED A transcript of #general is already being saved/);
    release();
    assert.match(said(await first), /^saved=1/);
    assert.equal(logCh.sent.length, 1, 'only one transcript was posted');
    channel.messages.fetch = real;
    assert.match(said(await run(slash())), /^saved=1/, 'and the channel can be recorded again afterwards');
  });

  it('still delivers without the Message Content intent, with a warning in the log and a banner in the file', async () => {
    runtime.services.intents = { members: true, messageContent: false };
    channel.addMessage({ content: '', author: human() });
    saved();
    assert.match(said(await run(slash())), /^saved=1/);
    assert.ok(logs().some((l) => l.startsWith('warn:') && /Message Content intent is off/.test(l)));
    assert.match(html(), /Message text is not included/);
    assert.match(html(), /\[content unavailable\]/);
  });

  it('honours the operator\'s cap on messages and says the transcript is cut short', async () => {
    applyLimits({ transcriptMessages: 5 });
    for (let n = 0; n < 20; n += 1) channel.addMessage({ content: `m${n}`, author: human() });
    saved();
    assert.match(said(await run(slash())), /^saved=5 dm=skipped cut=true/);
    assert.match(html(), /stops here: the message limit was reached/);
  });

  it('a transcript of an empty channel is still a valid file', async () => {
    saved();
    assert.match(said(await run(slash())), /^saved=0 /);
    assert.match(html(), /There are no messages in this channel/);
  });

  it('stops paging when the flow is switched off mid-way', async () => {
    for (let n = 0; n < 300; n += 1) channel.addMessage({ content: `m${n}`, author: human() });
    const real = channel.messages.fetch.bind(channel.messages);
    channel.messages.fetch = async (a) => { const page = await real(a); for (const ctx of runtime.live) runtime.abortRun(ctx); return page; };
    saved();
    await run(slash());
    assert.equal(logCh.sent.length, 0, 'nothing was posted');
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
