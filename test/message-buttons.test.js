// "Change Buttons": add, remove, disable or enable the buttons of a message the bot has already sent.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetLimits } from '../shared/limits.js';
import { getOutputs, isVisible, NODE_TYPES } from '../shared/catalog.js';
import { Database } from '../server/db.js';
import { buildButtonId, buildCustomId } from '../server/engine/custom-id.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeComponent, fakeGuild, fakeUser, node } from './helpers/fakes.js';

let db; let runtime; let guild; let channel; let user; let member;

beforeEach(() => {
  resetLimits();
  db = new Database(':memory:');
  runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'general', id: '500001' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  runtime.attachClient(guild.client);
});

const install = (graph) => {
  const flow = db.createFlow({ guildId: guild.id, name: 'Test flow', graph, enabled: true });
  runtime.loadGuild(guild.id);
  return flow;
};
const slash = (commandName = 'cmd') => fakeCommand({ guild, channel, user, member, commandName, options: [] });
const run = async (i) => { await runtime.handleInteraction(i); return i; };
const click = (customId, messageId) => run(fakeComponent({ guild, channel, user, member, customId, messageId }));

// rows the way Discord's API shapes them
const btn = (label, id, extra = {}) => ({ type: 2, style: 1, label, custom_id: buildButtonId({ id }), ...extra });
const link = (label, url) => ({ type: 2, style: 5, label, url });
const row = (...components) => ({ type: 1, components });
const menu = () => ({ type: 3, custom_id: 'fc:f:n:sel:', placeholder: 'Pick', min_values: 1, max_values: 1, options: [{ label: 'A', value: 'a' }] });
const post = (components, over = {}) => channel.addMessage({ content: 'Hello panel', author: { id: 'BOT', username: 'flowbot', bot: true }, components, ...over });
const layout = (msg) => msg.components.map((r) => r.components.map((c) => c.label ?? '(menu)'));
const edits = () => channel.calls.filter((c) => c[0] === 'messageEdit');
const deletesMade = () => channel.calls.filter((c) => c[0] === 'messageDelete').length;
const oops = () => channel.sent.map((p) => p.content).filter((c) => c.startsWith('oops'));
const logs = () => runtime.logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);

/** A button as the node stores it in its list. */
const item = (label, o = {}) => ({ id: label.toLowerCase().replace(/\W/g, '') || 'x', label, style: 'Primary', emoji: '', url: '', disabled: false, customId: '', ...o });
/** One Change Buttons node after the command; when it fails, the reason is posted to the channel. */
const change = (data, more = { nodes: [], edges: [] }) => install(commandFlow(
  [node('b', 'action.message.buttons', data),
    node('e', 'action.message.send', { target: 'channel', channelId: channel.id, content: 'oops: {{error.message}}' }),
    ...more.nodes],
  [edge('t', 'b'), edge('b', 'e', 'error'), ...more.edges],
));

describe('adding buttons to a message that was already sent', () => {
  it('adds a button and touches nothing else about the message', async () => {
    const msg = post([]);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Close', { style: 'Danger', customId: 'close_ticket' })] });
    await run(slash());
    assert.deepEqual(layout(msg), [['Close']]);
    assert.equal(msg.components[0].components[0].custom_id, 'fcb:close_ticket:');
    assert.equal(msg.components[0].components[0].style, 4);
    assert.equal(msg.content, 'Hello panel');
    assert.deepEqual(Object.keys(edits()[0][2]), ['components'], 'only the buttons are sent — never the text or embeds');
    assert.deepEqual(oops(), []);
  });

  it('fills a row up to five, then starts the next one', async () => {
    const msg = post([row(btn('E1', 'e1'), btn('E2', 'e2'), btn('E3', 'e3'), btn('E4', 'e4'))]);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: ['A', 'B', 'C'].map((l) => item(l, { customId: l.toLowerCase() })) });
    await run(slash());
    assert.deepEqual(layout(msg), [['E1', 'E2', 'E3', 'E4', 'A'], ['B', 'C']]);
  });

  it('keeps a select menu where it is and puts the new buttons in a row of their own', async () => {
    const msg = post([row(btn('Old', 'old')), row(menu())]);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('New', { customId: 'new' })] });
    await run(slash());
    assert.deepEqual(layout(msg), [['Old'], ['(menu)'], ['New']]);
    assert.equal(msg.components[1].components[0].custom_id, 'fc:f:n:sel:');
  });

  it('updates a button that is already there instead of doubling it, so running twice is harmless', async () => {
    const msg = post([row(btn('First', 'first'), btn('Vote', 'vote'))]);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Vote now!', { customId: 'vote', style: 'Success' })] });
    await run(slash());
    assert.deepEqual(layout(msg), [['First', 'Vote now!']], 'same place, new label');
    assert.equal(msg.components[0].components[1].style, 3);
    await run(slash());
    assert.equal(edits().length, 1, 'the second run finds nothing to change and does not edit again');
    assert.deepEqual(oops(), []);
  });

  it('adds links (by address) and does not double them either', async () => {
    const msg = post([]);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Docs', { style: 'Link', url: 'https://example.com/docs' })] });
    await run(slash());
    await run(slash());
    assert.deepEqual(layout(msg), [['Docs']]);
    assert.equal(msg.components[0].components[0].url, 'https://example.com/docs');
    assert.equal(msg.components[0].components[0].custom_id, undefined);
    assert.equal(edits().length, 1);
  });

  it('refuses a link without an address, and tells the flow why', async () => {
    const msg = post([]);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Docs', { style: 'Link', url: 'not a link' })] });
    await run(slash());
    assert.equal(edits().length, 0);
    assert.match(oops()[0], /needs an http\(s\) URL/);
  });

  it('says so when the message has no room, and changes nothing', async () => {
    const full = Array.from({ length: 5 }, (_, r) => row(...Array.from({ length: 5 }, (__, c) => btn(`B${r}${c}`, `b${r}${c}`))));
    const msg = post(full);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('One more', { customId: 'more' })] });
    await run(slash());
    assert.equal(edits().length, 0);
    assert.match(oops()[0], /no room for 1 more button — Discord allows 5 rows of 5/);
    assert.equal(msg.components.length, 5);
  });

  it('a select menu uses up a whole row of the five, even though it holds no buttons', async () => {
    const five = (p) => row(...Array.from({ length: 5 }, (_, k) => btn(`${p}${k}`, `${p.toLowerCase()}${k}`)));
    const msg = post([five('A'), five('B'), five('C'), five('D'), row(menu())]); // only 20 buttons, but every row is taken
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Late', { customId: 'late' })] });
    await run(slash());
    assert.equal(edits().length, 0);
    assert.match(oops()[0], /no room for 1 more button/);
  });

  it('fills in templates, and can limit the added buttons to the person who ran it', async () => {
    const msg = post([]);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, restrictToInvoker: true, buttons: [item('Hi {{user.name}}', { customId: 'greet' })] });
    await run(slash());
    assert.equal(msg.components[0].components[0].label, 'Hi mia');
    assert.equal(msg.components[0].components[0].custom_id, 'fcb:greet:222222');
  });
});

describe('clicks on the buttons that were added', () => {
  it('a button with a Button ID is answered by a Button Clicked trigger, whichever flow added it', async () => {
    const msg = post([]);
    change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Close', { customId: 'close_ticket' })] });
    install({ nodes: [node('h', 'trigger.button.clicked', { customId: 'close_ticket' }), node('r', 'action.message.send', { target: 'reply', content: 'closing for {{user.name}}' })], edges: [edge('h', 'r')] });
    await run(slash());
    const c = await click(msg.components[0].components[0].custom_id, msg.id);
    assert.equal(c.calls[0][1].content, 'closing for mia');
  });

  it('a button without one gets its own output on the node, and its click runs that branch with the variables of the run that added it', async () => {
    const msg = post([]);
    const data = { mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Vote', { id: 'vote' }), item('Docs', { id: 'docs', style: 'Link', url: 'https://example.com' }), item('Kept', { id: 'kept', customId: 'kept_id' })] };
    assert.deepEqual(getOutputs('action.message.buttons', data).map((o) => o.id), ['out', 'btn_vote', 'error'], 'links and Button ID buttons have no output');
    const flow = install(commandFlow(
      [node('v', 'data.variable.set', { scope: 'run', name: 'note', operation: 'set', value: 'hello' }),
        node('b', 'action.message.buttons', data),
        node('r', 'action.message.send', { target: 'reply', content: 'voted {{var.note}} by {{user.name}}' })],
      [edge('t', 'v'), edge('v', 'b'), edge('b', 'r', 'btn_vote')],
    ));
    await run(slash());
    const added = msg.components[0].components.find((c) => c.label === 'Vote');
    assert.equal(added.custom_id, `fc:${flow.id}:b:btn_vote:`);
    const c = await click(added.custom_id, msg.id);
    assert.equal(c.calls[0][1].content, 'voted hello by mia');
  });

  it('never overwrites what the message already remembers from the run that sent it', async () => {
    const msg = post([]);
    runtime.services.components.remember(msg.id, { guild: { id: guild.id }, vars: { note: 'original' }, data: {} }, { channelId: channel.id });
    install(commandFlow([node('b', 'action.message.buttons', { mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Vote', { id: 'vote' })] })], [edge('t', 'b')]));
    await run(slash());
    assert.deepEqual(runtime.services.components.get(guild.id, msg.id).vars, { note: 'original' });
  });

  it('a wired button stops working when its output is gone, like any other', async () => {
    const msg = post([]);
    const flow = change({ mode: 'add', messageFrom: 'id', messageId: msg.id, buttons: [item('Vote', { id: 'vote' })] });
    const c = await click(buildCustomId({ flowId: flow.id, nodeId: 'b', handle: 'btn_gone' }), msg.id);
    assert.equal(c.calls[0][1].content, 'This button is no longer active.');
  });
});

describe('removing, disabling and enabling buttons', () => {
  const panel = () => post([row(btn('Open', 'open_ticket'), btn('Close', 'close_ticket'), link('Docs', 'https://example.com')), row(btn('Solo', 'solo'))]);

  it('removes buttons by Button ID or by label (capital letters do not matter) and drops a row that ends up empty', async () => {
    const msg = panel();
    change({ mode: 'remove', messageFrom: 'id', messageId: msg.id, targets: [{ id: 'a', match: 'open_ticket' }, { id: 'b', match: '  cLoSe ' }, { id: 'c', match: 'solo' }] });
    await run(slash());
    assert.deepEqual(layout(msg), [['Docs']]);
    assert.equal(msg.content, 'Hello panel');
    assert.deepEqual(oops(), []);
  });

  it('removing something that is not there is not an error, but the log says nothing matched', async () => {
    const msg = panel();
    change({ mode: 'remove', messageFrom: 'id', messageId: msg.id, targets: [{ id: 'a', match: 'typo' }] });
    await run(slash());
    assert.equal(edits().length, 0);
    assert.deepEqual(oops(), []);
    assert.ok(logs().some((l) => /^warn: No button on the message matched “typo”/.test(l)), logs().join('\n'));
  });

  it('refuses to remove "nothing" (an empty target) instead of guessing', async () => {
    const msg = panel();
    change({ mode: 'remove', messageFrom: 'id', messageId: msg.id, targets: [{ id: 'a', match: '{{var.missing}}' }] });
    await run(slash());
    assert.equal(edits().length, 0);
    assert.match(oops()[0], /Say which buttons to remove/);
  });

  it('removes every button, and keeps the text', async () => {
    const msg = panel();
    change({ mode: 'clear', messageFrom: 'id', messageId: msg.id });
    await run(slash());
    assert.deepEqual(msg.components, []);
    assert.equal(msg.content, 'Hello panel');
    assert.deepEqual(edits()[0][2].components, []);
  });

  it('will not remove the last button of a message that has nothing else on it (Discord refuses an empty message)', async () => {
    const msg = post([row(btn('Only', 'only'))], { content: '' });
    change({ mode: 'clear', messageFrom: 'id', messageId: msg.id });
    await run(slash());
    assert.equal(edits().length, 0);
    assert.match(oops()[0], /leave the message empty/);
    assert.deepEqual(layout(msg), [['Only']]);
  });

  it('disables chosen buttons (or all of them) and enables them again; repeating does nothing', async () => {
    const msg = panel();
    const disabled = () => msg.components.flatMap((r) => r.components).map((c) => `${c.label}:${c.disabled ? 'off' : 'on'}`);
    change({ mode: 'disable', messageFrom: 'id', messageId: msg.id, targets: [{ id: 'a', match: 'Close' }] });
    await run(slash());
    assert.deepEqual(disabled(), ['Open:on', 'Close:off', 'Docs:on', 'Solo:on']);
    await run(slash());
    assert.equal(edits().length, 1, 'already disabled: no second edit');

    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    change({ mode: 'disable', messageFrom: 'id', messageId: msg.id, targets: [] });
    await run(slash('cmd'));
    assert.deepEqual(disabled(), ['Open:off', 'Close:off', 'Docs:off', 'Solo:off'], 'an empty list means every button');

    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    change({ mode: 'enable', messageFrom: 'id', messageId: msg.id, targets: [{ id: 'a', match: 'solo' }] });
    await run(slash('cmd'));
    assert.deepEqual(disabled(), ['Open:off', 'Close:off', 'Docs:off', 'Solo:on']);
  });

  it('with no message ID it changes the message the button was pressed on', async () => {
    const msg = post([row(btn('Lock', 'lockme'), btn('Other', 'other'))], { id: '700001' });
    install({
      nodes: [node('h', 'trigger.button.clicked', { customId: 'lockme' }), node('b', 'action.message.buttons', { mode: 'disable', messageFrom: 'this', targets: [] })],
      edges: [edge('h', 'b')],
    });
    await click(buildButtonId({ id: 'lockme' }), msg.id);
    assert.deepEqual(msg.components[0].components.map((c) => c.disabled), [true, true]);
  });
});

describe('deleting the message', () => {
  const deletes = () => channel.calls.filter((c) => c[0] === 'messageDelete');

  it('deletes the message with that ID, and nothing else', async () => {
    const msg = post([row(btn('Open', 'open'))]);
    const other = post([row(btn('Keep', 'keep'))]);
    change({ mode: 'delete', messageFrom: 'id', messageId: msg.id });
    await run(slash());
    assert.deepEqual(deletes(), [['messageDelete', msg.id]]);
    assert.equal(await channel.messages.fetch(msg.id), null);
    assert.ok(await channel.messages.fetch(other.id), 'other messages are left alone');
    assert.equal(edits().length, 0);
    assert.deepEqual(oops(), []);
  });

  it('works on a message somebody else posted too, like Delete Message (Discord decides whether the bot may)', async () => {
    const msg = post([], { author: { id: '999999', username: 'someone', bot: false }, content: 'rude words' });
    change({ mode: 'delete', messageFrom: 'id', messageId: msg.id });
    await run(slash());
    assert.deepEqual(deletes(), [['messageDelete', msg.id]]);
    assert.deepEqual(oops(), []);
  });

  it('with no message ID it deletes the message the button was pressed on', async () => {
    const msg = post([row(btn('Dismiss', 'dismiss'))], { id: '700002' });
    install({
      nodes: [node('h', 'trigger.button.clicked', { customId: 'dismiss' }), node('b', 'action.message.buttons', { mode: 'delete', messageFrom: 'this' })],
      edges: [edge('h', 'b')],
    });
    await click(buildButtonId({ id: 'dismiss' }), msg.id);
    assert.equal(await channel.messages.fetch(msg.id), null);
  });

  it('follows the error output when the message is already gone', async () => {
    change({ mode: 'delete', messageFrom: 'id', messageId: '123456789012345678' });
    await run(slash());
    assert.match(oops()[0], /was not found in #general/);
  });

  it('can delete the panel a channel variable remembers', async () => {
    install(commandFlow(
      [node('m', 'action.message.send', { target: 'current_channel', content: 'Vote now', outputVar: 'msg', buttons: [item('Vote', { customId: 'vote' })] }),
        node('v', 'data.variable.set', { scope: 'channel', name: 'panel', operation: 'set', value: '{{var.msg}}' })],
      [edge('t', 'm'), edge('m', 'v')], 'panel',
    ));
    install(commandFlow([node('b', 'action.message.buttons', { mode: 'delete', messageFrom: 'id', messageId: '{{channel.vars.panel}}' })], [edge('t', 'b')], 'close'));
    await run(slash('panel'));
    const msg = [...channel.messages.store.values()].find((m) => m.content === 'Vote now');
    assert.ok(msg);
    await run(slash('close'));
    assert.equal(await channel.messages.fetch(msg.id), null, 'the panel is gone');
  });
});

describe('what it will not touch', () => {
  it('another author’s message', async () => {
    const msg = post([row(btn('Theirs', 'theirs'))], { author: { id: '999999', username: 'someone', bot: false } });
    change({ mode: 'clear', messageFrom: 'id', messageId: msg.id });
    await run(slash());
    assert.equal(edits().length, 0);
    assert.match(oops()[0], /only change the buttons of its own messages/);
  });

  it('a message that does not exist', async () => {
    change({ mode: 'clear', messageFrom: 'id', messageId: '123456789012345678' });
    await run(slash());
    assert.match(oops()[0], /was not found in #general/);
  });
});

describe('choosing the message: this one, or a previous one by its ID', () => {
  const exists = async (id) => (await channel.messages.fetch(id)) !== null;
  const onDismiss = (data) => install({
    nodes: [node('h', 'trigger.button.clicked', { customId: 'dismiss' }), node('b', 'action.message.buttons', data),
      node('e', 'action.message.send', { target: 'channel', channelId: channel.id, content: 'oops: {{error.message}}' })],
    edges: [edge('h', 'b'), edge('b', 'e', 'error')],
  });

  it('“This message” is the one the button was pressed on, and a leftover ID from before is ignored', async () => {
    const pressed = post([row(btn('Dismiss', 'dismiss'))], { id: '700010' });
    const other = post([row(btn('Other', 'other'))], { id: '700011' });
    onDismiss({ mode: 'delete', messageFrom: 'this', messageId: other.id });
    await click(buildButtonId({ id: 'dismiss' }), pressed.id);
    assert.equal(await exists(pressed.id), false, 'the message with the pressed button is deleted');
    assert.equal(await exists(other.id), true, 'the ID typed earlier is not used any more');
  });

  it('“A previous message” deletes that one instead — not the message the button is on', async () => {
    const pressed = post([row(btn('Dismiss', 'dismiss'))], { id: '700012' });
    const earlier = post([row(btn('Old', 'old'))], { id: '700013' });
    onDismiss({ mode: 'delete', messageFrom: 'id', messageId: earlier.id });
    await click(buildButtonId({ id: 'dismiss' }), pressed.id);
    assert.equal(await exists(earlier.id), false);
    assert.equal(await exists(pressed.id), true);
  });

  it('a previous message with an empty ID is an error — it never turns into “this message”', async () => {
    const pressed = post([row(btn('Dismiss', 'dismiss'))], { id: '700014' });
    onDismiss({ mode: 'delete', messageFrom: 'id', messageId: '{{channel.vars.never_saved}}' });
    await click(buildButtonId({ id: 'dismiss' }), pressed.id);
    assert.equal(await exists(pressed.id), true, 'nothing was deleted');
    assert.equal(deletesMade(), 0);
    assert.match(oops()[0], /The message ID is empty/);
  });

  it('“This message” in a flow that did not start from a message says so, and asks for an ID', async () => {
    change({ mode: 'clear', messageFrom: 'this' });
    await run(slash());
    assert.match(oops()[0], /There is no “this message” here.*Choose “A previous message”/);
  });

  it('works for changing buttons as well: this message, or an earlier one by ID', async () => {
    const pressed = post([row(btn('Dismiss', 'dismiss'), btn('Vote', 'vote'))], { id: '700015' });
    const earlier = post([row(btn('Old', 'old'))], { id: '700016' });
    onDismiss({ mode: 'disable', messageFrom: 'this', targets: [{ id: 'a', match: 'vote' }] });
    await click(buildButtonId({ id: 'dismiss' }), pressed.id);
    assert.deepEqual(pressed.components[0].components.map((c) => !!c.disabled), [false, true]);
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    onDismiss({ mode: 'disable', messageFrom: 'id', messageId: earlier.id, targets: [] });
    await click(buildButtonId({ id: 'dismiss' }), pressed.id);
    assert.deepEqual(earlier.components[0].components.map((c) => !!c.disabled), [true]);
  });
});

describe('Change Buttons in the editor', () => {
  const def = NODE_TYPES['action.message.buttons'];

  it('shows only the part that belongs to the chosen mode', () => {
    const shown = (mode, messageFrom = 'this') => def.fields.filter((f) => isVisible(f, { mode, messageFrom })).map((f) => f.key);
    assert.deepEqual(shown('add'), ['messageFrom', 'mode', 'buttons', 'restrictToInvoker']);
    assert.deepEqual(shown('remove'), ['messageFrom', 'mode', 'targets']);
    assert.deepEqual(shown('disable'), ['messageFrom', 'mode', 'targets']);
    assert.deepEqual(shown('clear'), ['messageFrom', 'mode']);
    assert.deepEqual(shown('delete'), ['messageFrom', 'mode']);
    assert.deepEqual(getOutputs('action.message.buttons', { mode: 'delete', buttons: [item('A')] }).map((o) => o.id), ['out', 'error']);
  });

  it('asks for a channel and a message ID only when “A previous message” is chosen, and requires the ID then', () => {
    const shown = (messageFrom) => def.fields.filter((f) => isVisible(f, { mode: 'delete', messageFrom })).map((f) => f.key);
    assert.deepEqual(shown('this'), ['messageFrom', 'mode']);
    assert.deepEqual(shown('id'), ['messageFrom', 'channelId', 'messageId', 'mode']);
    assert.equal(def.fields.find((f) => f.key === 'messageId').required, true);
    assert.deepEqual(def.fields.find((f) => f.key === 'messageFrom').options.map((o) => o.value), ['this', 'id']);
    assert.equal(def.fields.find((f) => f.key === 'messageFrom').default, 'this');
  });

  it('gives each wired button an output only in "add" mode', () => {
    const buttons = [item('A', { id: 'a' }), item('B', { id: 'b', customId: 'b_id' }), item('L', { id: 'l', style: 'Link', url: 'https://example.com' })];
    assert.deepEqual(getOutputs('action.message.buttons', { mode: 'add', buttons }).map((o) => o.id), ['out', 'btn_a', 'error']);
    assert.deepEqual(getOutputs('action.message.buttons', { mode: 'remove', buttons }).map((o) => o.id), ['out', 'error']);
  });

  it('explains what is missing or wrong', () => {
    assert.deepEqual(def.check({ mode: 'add', buttons: [] }), ['Add at least one button.']);
    assert.match(def.check({ mode: 'remove', targets: [] })[0], /Say which buttons to remove/);
    assert.deepEqual(def.check({ mode: 'disable', targets: [] }), [], 'disabling every button needs no list');
    assert.match(def.check({ mode: 'add', buttons: [item('A', { customId: 'bad id' })] })[0], /can only use letters, numbers/);
    assert.match(def.check({ mode: 'add', buttons: [item('A', { id: 'a', customId: 'x' }), item('B', { id: 'b', customId: 'x' })] })[0], /used twice/);
  });

  it('summarises what it does', () => {
    assert.equal(def.summary({ mode: 'add', messageFrom: 'this', buttons: [item('A'), item('B')] }), 'add 2 buttons to this message');
    assert.equal(def.summary({ mode: 'clear', messageFrom: 'id', messageId: '123' }), 'remove all buttons from message 123');
    assert.equal(def.summary({ mode: 'disable', messageFrom: 'this', targets: [] }), 'disable all buttons on this message');
    assert.equal(def.summary({ mode: 'delete', messageFrom: 'this' }), 'delete this message');
    assert.equal(def.summary({ mode: 'delete', messageFrom: 'id', messageId: '{{channel.vars.panel}}' }), 'delete message {{channel.vars.panel}}');
    assert.equal(def.summary({ mode: 'delete', messageFrom: 'id', messageId: '' }), 'delete message (ID needed)');
  });
});

describe('remembering a message, then changing its buttons later', () => {
  it('a message ID kept in a channel variable can be found again by another flow', async () => {
    install(commandFlow(
      [node('m', 'action.message.send', { target: 'current_channel', content: 'Vote now', outputVar: 'msg', buttons: [item('Vote', { customId: 'vote' })] }),
        node('v', 'data.variable.set', { scope: 'channel', name: 'panel', operation: 'set', value: '{{var.msg}}' })],
      [edge('t', 'm'), edge('m', 'v')], 'panel',
    ));
    install(commandFlow(
      [node('b', 'action.message.buttons', { mode: 'disable', messageFrom: 'id', messageId: '{{channel.vars.panel}}', targets: [] })],
      [edge('t', 'b')], 'lock',
    ));
    await run(slash('panel'));
    const msg = [...channel.messages.store.values()].find((m) => m.content === 'Vote now');
    assert.equal(db.getVar(guild.id, 'channel', channel.id, 'panel'), msg.id);
    assert.ok(!msg.components[0].components[0].disabled, 'switched on to begin with');

    await run(slash('lock'));
    assert.equal(msg.components[0].components[0].disabled, true, 'the panel’s button is now switched off');
    assert.equal(msg.content, 'Vote now');
  });
});
