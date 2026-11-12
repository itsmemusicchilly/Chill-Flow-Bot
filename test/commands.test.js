// Slash commands beyond the basics: sub-commands, choice lists, suggestions while typing (autocomplete) and right-click commands.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { availableVariables } from '../shared/catalog.js';
import { commandKey, menuKey, parseChoices, suggestChoices, typedChoice } from '../shared/commands.js';
import { resetLimits } from '../shared/limits.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { buildCommandDefs, CommandSync } from '../server/bot/commands.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { edge, fakeAutocomplete, fakeCommand, fakeGuild, fakeMenu, fakeUser, node } from './helpers/fakes.js';

let db; let runtime; let guild; let channel; let user; let member; let logger;
const install = (graph, name = 'flow') => { const flow = db.createFlow({ guildId: guild.id, name, graph }); runtime.loadGuild(guild.id); return flow; };
const logs = () => logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);
const said = (i) => i.calls.filter((c) => c[0] === 'reply').map((c) => c[1].content);
/** A flow that is one Slash Command trigger answering with `reply`. */
const command = (data, reply = 'ok') => ({
  nodes: [node('t', 'trigger.command', { description: 'test', ...data }), node('r', 'action.message.send', { target: 'reply', content: reply })],
  edges: [edge('t', 'r')],
});
const SUB = 1;

beforeEach(() => {
  resetLimits();
  db = new Database(':memory:');
  logger = new Logger({ console: false });
  runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true } });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'general' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  runtime.attachClient(guild.client);
});

describe('sub-commands', () => {
  const use = async (commandName, sub, options = []) => {
    const i = fakeCommand({ guild, channel, user, member, commandName, options: sub ? [{ name: sub, type: SUB, options }] : options });
    await runtime.handleInteraction(i);
    return i;
  };

  it('several triggers with one command name and different sub-commands each run their own flow, with their own options', async () => {
    install(command({ name: 'ticket', sub: 'open', options: [{ name: 'reason', description: 'why', type: 'string' }] }, 'opened: {{option.reason}}'), 'Open');
    install(command({ name: 'ticket', sub: 'close' }, 'closed by {{user.name}}'), 'Close');
    assert.deepEqual(said(await use('ticket', 'open', [{ name: 'reason', value: 'help me' }])), ['opened: help me']);
    assert.deepEqual(said(await use('ticket', 'close')), ['closed by mia']);
    assert.ok(logs().some((m) => m.includes('/ticket open by mia')));
  });

  it('are registered with Discord as ONE command', () => {
    install(command({ name: 'ticket', sub: 'open', description: 'Open a ticket', options: [{ name: 'reason', description: 'why', type: 'string', required: true }] }), 'Open');
    install(command({ name: 'ticket', sub: 'close', description: 'Close it' }), 'Close');
    install(command({ name: 'ping', description: 'Ping' }), 'Ping');
    const { defs, skipped } = buildCommandDefs(runtime.commandsFor(guild.id));
    assert.deepEqual(skipped, []);
    assert.deepEqual(defs, [
      { name: 'ticket', description: 'Open a ticket', type: 1, default_member_permissions: null, options: [
        { type: SUB, name: 'open', description: 'Open a ticket', options: [{ type: 3, name: 'reason', description: 'why', required: true }] },
        { type: SUB, name: 'close', description: 'Close it', options: [] },
      ] },
      { name: 'ping', description: 'Ping', type: 1, options: [], default_member_permissions: null },
    ]);
  });

  it('a command cannot have sub-commands and also be used on its own: the older flow decides, and the log says why', async () => {
    install(command({ name: 'ticket', sub: 'open' }, 'opened'), 'Open');
    install(command({ name: 'ticket' }, 'plain'), 'Plain');
    install(command({ name: 'solo' }, 'solo'), 'Solo');
    install(command({ name: 'solo', sub: 'extra' }, 'extra'), 'Extra');
    assert.deepEqual(said(await use('ticket', 'open')), ['opened']);
    assert.deepEqual(said(await use('ticket')), ['This command is not set up (any more).']);
    assert.deepEqual(said(await use('solo')), ['solo']);
    assert.deepEqual(said(await use('solo', 'extra')), ['This command is not set up (any more).']);
    assert.ok(logs().some((m) => /Command \/ticket is ignored: \/ticket already has sub-commands/.test(m)));
    assert.ok(logs().some((m) => /Command \/solo extra is ignored: \/solo is already a command on its own/.test(m)));
    assert.deepEqual(buildCommandDefs(runtime.commandsFor(guild.id)).defs.map((d) => [d.name, d.options.map((o) => o.name)]), [['ticket', ['open']], ['solo', []]]);
  });

  it('the same sub-command twice: the older flow answers', async () => {
    install(command({ name: 'ticket', sub: 'open' }, 'first'), 'One');
    install(command({ name: 'ticket', sub: 'open' }, 'second'), 'Two');
    assert.deepEqual(said(await use('ticket', 'open')), ['first']);
    assert.ok(logs().some((m) => /Command \/ticket open is defined twice; “Two” is ignored/.test(m)));
  });

  it('sub-commands share one permission setting: if they differ, every permission is needed, so nothing opens up by accident', () => {
    const trig = (data, flow = 'f') => ({ flow: { name: flow }, node: { type: 'trigger.command', data: { description: 'd', ...data } } });
    const one = (list) => buildCommandDefs(list).defs[0].default_member_permissions;
    assert.equal(one([trig({ name: 'mod', sub: 'help', permission: '' }), trig({ name: 'mod', sub: 'ban', permission: 'BanMembers' })]), '4');
    assert.equal(one([trig({ name: 'mod', sub: 'kick', permission: 'KickMembers' }), trig({ name: 'mod', sub: 'ban', permission: 'BanMembers' })]), '6', 'both bits');
    assert.equal(one([trig({ name: 'mod', sub: 'a' }), trig({ name: 'mod', sub: 'b' })]), null);
  });

  it('refuses what Discord would refuse, and says which one', () => {
    const trig = (data, flow = 'f') => ({ flow: { name: flow }, node: { type: 'trigger.command', data: { description: 'd', ...data } } });
    const { defs, skipped } = buildCommandDefs([
      trig({ name: 'a', sub: 'one' }), trig({ name: 'a', sub: 'one' }, 'dup'), trig({ name: 'a', sub: 'Bad Sub' }, 'bad'), trig({ name: 'a' }, 'plain'),
      ...Array.from({ length: 26 }, (_, i) => trig({ name: 'many', sub: `s${i}` }, `m${i}`)),
    ]);
    assert.deepEqual(defs.map((d) => [d.name, d.options.length]), [['a', 1], ['many', 25]]);
    assert.deepEqual(skipped.map((s) => [s.name, s.reason]), [
      ['a one', 'duplicate sub-command'], ['a Bad Sub', 'invalid sub-command name'], ['a', 'a command that has sub-commands cannot also be used on its own'],
      ['many s25', 'Discord allows at most 25 sub-commands'],
    ]);
  });

  it('the editor checks the sub-command name and shows it on the node', () => {
    const problems = (data) => validateFlow(normalizeGraph(command({ name: 'ticket', ...data }))).filter((i) => i.nodeId === 't' && i.level === 'error').map((i) => i.message);
    assert.deepEqual(problems({ sub: 'open' }), []);
    assert.deepEqual(problems({ sub: 'Open Ticket' }), ['Sub-command must be 1–32 lowercase letters, numbers, - or _.']);
    assert.equal(commandKey('ticket', 'open'), 'ticket open');
    assert.equal(commandKey('ticket', ''), 'ticket');
  });

  it('a command saved before sub-commands existed still works', async () => {
    const graph = command({ name: 'old' }, 'still here');
    delete graph.nodes[0].data.sub;
    for (const o of graph.nodes[0].data.options) { delete o.choiceMode; delete o.choices; delete o.choicesVar; }
    install(graph);
    assert.deepEqual(said(await use('old')), ['still here']);
    assert.deepEqual(validateFlow(normalizeGraph(graph)).filter((i) => i.level === 'error'), []);
  });
});

describe('choices and suggestions', () => {
  it('reads a list: one per line, “Label = value” or just a label', () => {
    assert.deepEqual(parseChoices('Red\n Green = g \n\nBlue=b\nRed = again\n = nothing\nNo value ='), [{ name: 'Red', value: 'Red' }, { name: 'Green', value: 'g' }, { name: 'Blue', value: 'b' }]);
    assert.deepEqual(parseChoices(''), []);
    assert.deepEqual(parseChoices(undefined), []);
    assert.equal(parseChoices('x'.repeat(150))[0].name.length, 100, 'cut to what Discord allows');
    assert.deepEqual(parseChoices('a = b = c'), [{ name: 'a', value: 'b = c' }]);
  });

  it('a number option needs numbers as values', () => {
    assert.deepEqual(typedChoice({ name: 'Ten', value: '10' }, 'integer'), { name: 'Ten', value: 10 });
    assert.deepEqual(typedChoice({ name: 'Half', value: '0.5' }, 'number'), { name: 'Half', value: 0.5 });
    assert.equal(typedChoice({ name: 'Half', value: '0.5' }, 'integer'), null);
    assert.equal(typedChoice({ name: 'Ten', value: 'ten' }, 'number'), null);
    assert.deepEqual(typedChoice({ name: 'Ten', value: '10' }, 'string'), { name: 'Ten', value: '10' });
  });

  it('a fixed list is registered as choices; suggestions switch autocomplete on', () => {
    const trig = (options) => ({ flow: { name: 'f' }, node: { type: 'trigger.command', data: { name: 'c', description: 'd', options } } });
    const [def] = buildCommandDefs([trig([
      { name: 'colour', description: 'x', type: 'string', choiceMode: 'choices', choices: 'Red\nGreen = g' },
      { name: 'amount', description: 'x', type: 'integer', choiceMode: 'choices', choices: 'Ten = 10\nBad = nope' },
      { name: 'item', description: 'x', type: 'string', choiceMode: 'suggest', choices: 'Sword', choicesVar: 'items' },
      { name: 'who', description: 'x', type: 'user', choiceMode: 'choices', choices: 'ignored' },
      { name: 'free', description: 'x', type: 'string', choiceMode: '' },
      { name: 'empty', description: 'x', type: 'string', choiceMode: 'choices', choices: '' },
    ])]).defs;
    const by = Object.fromEntries(def.options.map((o) => [o.name, o]));
    assert.deepEqual(by.colour.choices, [{ name: 'Red', value: 'Red' }, { name: 'Green', value: 'g' }]);
    assert.deepEqual(by.amount.choices, [{ name: 'Ten', value: 10 }], 'a value that is not a number is left out');
    assert.equal(by.item.autocomplete, true);
    assert.equal(by.item.choices, undefined);
    for (const name of ['who', 'free', 'empty']) assert.deepEqual([by[name].choices, by[name].autocomplete], [undefined, undefined], name);
  });

  it('suggests what starts with the typed text first, then what contains it; capital letters do not matter', () => {
    const list = parseChoices('Apple\nPineapple\nGrape\nApricot = apr\nBanana');
    assert.deepEqual(suggestChoices(list, 'ap').map((c) => c.name), ['Apple', 'Apricot', 'Pineapple', 'Grape']);
    assert.deepEqual(suggestChoices(list, 'APR').map((c) => c.value), ['apr']);
    assert.deepEqual(suggestChoices(list, '').length, 5);
    assert.deepEqual(suggestChoices(list, 'zzz'), []);
    assert.equal(suggestChoices(parseChoices(Array.from({ length: 60 }, (_, i) => `Item ${i}`).join('\n')), 'item').length, 25, 'never more than Discord shows');
    assert.deepEqual(suggestChoices(parseChoices('One = 1\nTwo = 2\nBad = x'), '', 'integer'), [{ name: 'One', value: 1 }, { name: 'Two', value: 2 }]);
  });

  const typing = async (commandName, options) => {
    const i = fakeAutocomplete({ guild, channel, user, member, commandName, options });
    await runtime.handleInteraction(i);
    assert.equal(i.calls.length, 1, 'answered exactly once');
    return i.calls[0][1];
  };
  const shop = (extra = {}) => command({ name: 'buy', options: [{ name: 'item', description: 'what', type: 'string', choiceMode: 'suggest', choices: 'Sword\nShield = shield-1', choicesVar: 'items', ...extra }] });

  it('answers while someone types, from the list in the node and from the server variable it names', async () => {
    install(shop());
    db.setVar(guild.id, 'guild', '', 'items', ['Potion', 'Sword', 'Super potion']);
    assert.deepEqual(await typing('buy', [{ name: 'item', value: 's', focused: true }]), [{ name: 'Sword', value: 'Sword' }, { name: 'Shield', value: 'shield-1' }, { name: 'Super potion', value: 'Super potion' }]);
    assert.deepEqual(await typing('buy', [{ name: 'item', value: 'pot', focused: true }]), [{ name: 'Potion', value: 'Potion' }, { name: 'Super potion', value: 'Super potion' }]);
    db.setVar(guild.id, 'guild', '', 'items', ['Potion', 'Elixir']);
    assert.deepEqual(await typing('buy', [{ name: 'item', value: 'eli', focused: true }]), [{ name: 'Elixir', value: 'Elixir' }], 'it follows the variable as it changes');
    assert.deepEqual((await typing('buy', [{ name: 'item', value: 'el', focused: true }])).map((c) => c.name), ['Elixir', 'Shield'], 'what starts with the text comes before what only contains it');
  });

  it('the variable can be plain text with one item per line or comma, and no flow runs for a suggestion', async () => {
    install(shop({ choices: '' }));
    db.setVar(guild.id, 'guild', '', 'items', 'Bow, Arrow\nQuiver');
    assert.deepEqual((await typing('buy', [{ name: 'item', value: '', focused: true }])).map((c) => c.name), ['Bow', 'Arrow', 'Quiver']);
    assert.equal(logs().some((m) => m.includes('▶')), false);
  });

  it('works inside a sub-command, and only for the option being typed', async () => {
    install(command({ name: 'shop', sub: 'buy', options: [{ name: 'item', description: 'what', type: 'string', choiceMode: 'suggest', choices: 'Sword\nShield' }, { name: 'note', description: 'n', type: 'string' }] }));
    assert.deepEqual(await typing('shop', [{ name: 'buy', type: SUB, options: [{ name: 'item', value: 'sh', focused: true }] }]), [{ name: 'Shield', value: 'Shield' }]);
    assert.deepEqual(await typing('shop', [{ name: 'buy', type: SUB, options: [{ name: 'item', value: 'Sword' }, { name: 'note', value: 'x', focused: true }] }]), []);
  });

  it('answers with nothing — never an error — for an unknown command, another server’s list, or a broken lookup', async () => {
    install(shop());
    assert.deepEqual(await typing('nope', [{ name: 'item', value: 's', focused: true }]), []);
    db.setVar('999999', 'guild', '', 'items', ['Secret']);
    assert.deepEqual((await typing('buy', [{ name: 'item', value: 'sec', focused: true }])), [], 'only this server’s variable is read');
    runtime.db.getVar = () => { throw new Error('database is away'); };
    assert.deepEqual(await typing('buy', [{ name: 'item', value: 's', focused: true }]), []);
    assert.ok(logs().some((m) => /warn: Could not suggest values for \/buy: database is away/.test(m)));
  });

  it('the editor says what is missing', () => {
    const problems = (option) => validateFlow(normalizeGraph(command({ name: 'c', options: [{ name: 'o', description: 'd', type: 'string', required: false, ...option }] }))).filter((i) => i.nodeId === 't' && i.level === 'error').map((i) => i.message);
    assert.deepEqual(problems({ choiceMode: 'choices', choices: '' }), ['Option “o”: write the list to pick from, one per line.']);
    assert.deepEqual(problems({ choiceMode: 'choices', choices: 'a\nb' }), []);
    assert.deepEqual(problems({ choiceMode: 'choices', choices: Array.from({ length: 26 }, (_, i) => `c${i}`).join('\n') }), ['Option “o”: Discord shows at most 25 choices — use “Typed, with suggestions” for a longer list.']);
    assert.deepEqual(problems({ choiceMode: 'suggest', choices: '', choicesVar: '' }), ['Option “o”: write a list to suggest from, or name a server variable that holds one.']);
    assert.deepEqual(problems({ choiceMode: 'suggest', choices: '', choicesVar: 'items' }), []);
    assert.deepEqual(problems({ type: 'integer', choiceMode: 'choices', choices: 'Ten = 10\nLots = many' }), ['Option “o”: “many” is not a whole number, which this option needs as the value.']);
    assert.deepEqual(problems({ type: 'user', choiceMode: 'choices', choices: '' }), [], 'a member picker has no list');
  });
});

describe('right-click commands', () => {
  const menu = (data, reply) => ({ nodes: [node('t', 'trigger.contextMenu', data), node('r', 'action.message.send', { target: 'reply', content: reply })], edges: [edge('t', 'r')] });
  const bo = () => { const u = fakeUser({ id: '333333', username: 'bo' }); const m = guild.addMember({ user: u }); m.displayName = 'Bo the Great'; return { user: u, member: m }; };

  it('on a member: runs with who used it and who it was used on', async () => {
    install(menu({ kind: 'user', name: 'Give a cookie' }, '{{user.name}} gives {{target.mention}} ({{target.displayName}}, {{target.name}}, bot={{target.isBot}}) a cookie'));
    const t = bo();
    const i = fakeMenu({ guild, channel, user, member, commandName: 'Give a cookie', targetUser: t.user, targetMember: t.member });
    await runtime.handleInteraction(i);
    assert.deepEqual(said(i), ['mia gives <@333333> (Bo the Great, bo, bot=false) a cookie']);
    assert.ok(logs().some((m) => m.includes('“Give a cookie” used by mia')));
  });

  it('on a message: that message is “the triggering message”, and its author is the target', async () => {
    install({
      nodes: [node('t', 'trigger.contextMenu', { kind: 'message', name: 'Pin this' }), node('p', 'action.message.pin', {}), node('r', 'action.message.send', { target: 'reply', content: 'Pinned “{{message.content}}” by {{target.name}} ({{message.id}})' })],
      edges: [edge('t', 'p'), edge('p', 'r')],
    });
    const t = bo();
    const message = channel.addMessage({ id: '70001', content: 'important news', author: t.user, member: t.member });
    const i = fakeMenu({ guild, channel, user, member, commandName: 'Pin this', targetMessage: message });
    await runtime.handleInteraction(i);
    assert.deepEqual(said(i), ['Pinned “important news” by bo (70001)']);
    assert.equal(message.pinned, true);
  });

  it('a member command and a message command may share a name; an unknown one is answered politely', async () => {
    install(menu({ kind: 'user', name: 'Report' }, 'reported member'), 'A');
    install(menu({ kind: 'message', name: 'Report' }, 'reported message'), 'B');
    const t = bo();
    const onUser = fakeMenu({ guild, channel, user, member, commandName: 'Report', targetUser: t.user, targetMember: t.member });
    const onMessage = fakeMenu({ guild, channel, user, member, commandName: 'Report', targetMessage: channel.addMessage({ author: t.user }) });
    const unknown = fakeMenu({ guild, channel, user, member, commandName: 'Gone', targetUser: t.user });
    for (const i of [onUser, onMessage, unknown]) await runtime.handleInteraction(i);
    assert.deepEqual([said(onUser), said(onMessage), said(unknown)], [['reported member'], ['reported message'], ['This command is not set up (any more).']]);
    assert.equal(menuKey('user', ' Report '), 'user|Report');
  });

  it('are registered next to the slash commands, with their kind and permission, and never more than Discord allows', () => {
    install(command({ name: 'ping' }), 'Ping');
    install(menu({ kind: 'user', name: 'Warn', permission: 'ModerateMembers' }, 'x'), 'Warn');
    install(menu({ kind: 'message', name: 'Report message' }, 'x'), 'Report');
    install(menu({ kind: 'user', name: 'Warn' }, 'x'), 'Again');
    for (let n = 0; n < 5; n += 1) install(menu({ kind: 'user', name: `Extra ${n}` }, 'x'), `E${n}`);
    const { defs, skipped } = buildCommandDefs(runtime.commandsFor(guild.id));
    assert.deepEqual(defs.map((d) => [d.name, d.type]), [['ping', 1], ['Warn', 2], ['Extra 0', 2], ['Extra 1', 2], ['Extra 2', 2], ['Extra 3', 2], ['Report message', 3]]);
    assert.equal(defs[1].default_member_permissions, String(1n << 40n));
    assert.equal(defs[1].description, undefined, 'a right-click command has no description');
    assert.deepEqual(skipped.map((s) => [s.name, s.reason]), [['Extra 4', 'Discord allows at most 5 right-click commands on a member']]);
    assert.ok(logs().some((m) => /right-click command “Warn” is defined twice; “Again” is ignored/.test(m)));
  });

  it('a save registers them with Discord and says what was left out', async () => {
    install(menu({ kind: 'message', name: 'Report message' }, 'x'));
    install(menu({ kind: 'message', name: 'x'.repeat(40) }, 'x'), 'Long');
    const puts = [];
    runtime.attachClient({ rest: { put: async (route, opts) => { puts.push(opts.body); } } });
    const sync = new CommandSync({ db, runtime, logger, config: { clientId: 'cid' } });
    const res = await sync.sync(guild.id);
    assert.equal(res.ok, true);
    assert.deepEqual(puts[0], [{ name: 'Report message', type: 3, default_member_permissions: null }]);
    assert.ok(logs().some((m) => /“Right-Click Command” in “Long” is not active: The name can be at most 32 characters/.test(m)), 'a name Discord would refuse never gets that far');
    const direct = buildCommandDefs([{ flow: { name: 'Long' }, node: { type: 'trigger.contextMenu', data: { kind: 'message', name: 'x'.repeat(40) } } }]);
    assert.deepEqual(direct, { defs: [], skipped: [{ flow: 'Long', name: 'x'.repeat(40), reason: 'its name must be 1 to 32 characters', menu: true }] });
  });

  it('offers {{target.*}} to the next nodes — and {{message.*}} only on a message', () => {
    const paths = (kind) => { const g = menu({ kind, name: 'X' }, 'x'); return availableVariables(g.nodes, g.edges, 'r').map((v) => v.path); };
    assert.ok(paths('user').includes('target.mention') && !paths('user').includes('message.content'));
    assert.ok(paths('message').includes('target.mention') && paths('message').includes('message.content'));
    const problems = (data) => validateFlow(normalizeGraph(menu(data, 'x'))).filter((i) => i.nodeId === 't' && i.level === 'error').map((i) => i.message);
    assert.ok(problems({ kind: 'user', name: '' }).some((m) => /required/.test(m)));
    assert.deepEqual(problems({ kind: 'user', name: 'x'.repeat(33) }), ['The name can be at most 32 characters.']);
    assert.deepEqual(problems({ kind: 'user', name: 'Give a Cookie 🍪' }), []);
  });
});
