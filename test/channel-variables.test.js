// Variables remembered per channel: next to "Server" and "Per user", for things like a counter or a panel message that belongs to one channel.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetLimits } from '../shared/limits.js';
import { availableVariables, isVisible, NODE_TYPES } from '../shared/catalog.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let db; let runtime; let guild; let general; let other; let user; let member;

beforeEach(() => {
  resetLimits();
  db = new Database(':memory:');
  runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
  guild = fakeGuild({ id: '111111' });
  general = guild.addChannel({ name: 'general', id: '500001' });
  other = guild.addChannel({ name: 'other', id: '500002' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  runtime.attachClient(guild.client);
});

const install = (graph) => {
  const flow = db.createFlow({ guildId: guild.id, name: 'Test flow', graph, enabled: true });
  runtime.loadGuild(guild.id);
  return flow;
};
const slashIn = (channel) => fakeCommand({ guild, channel, user, member, commandName: 'cmd', options: [] });
const run = async (i) => { await runtime.handleInteraction(i); return i; };
const say = (i) => i.calls[0][1].content;

describe('channel variables', () => {
  it('are remembered per channel: each channel counts on its own', async () => {
    install(commandFlow(
      [node('v', 'data.variable.set', { scope: 'channel', name: 'n', operation: 'add', value: '1' }),
        node('r', 'action.message.send', { target: 'reply', content: 'here {{channel.vars.n}}' })],
      [edge('t', 'v'), edge('v', 'r')],
    ));
    assert.equal(say(await run(slashIn(general))), 'here 1');
    assert.equal(say(await run(slashIn(general))), 'here 2');
    assert.equal(say(await run(slashIn(other))), 'here 1', 'another channel starts from nothing');
    assert.equal(db.getVar(guild.id, 'channel', general.id, 'n'), 2);
    assert.equal(db.getVar(guild.id, 'channel', other.id, 'n'), 1);
    assert.equal(db.getVar('999999', 'channel', general.id, 'n'), undefined, 'another server sees nothing');
    assert.equal(db.getVar(guild.id, 'guild', '', 'n'), undefined, 'and it is not a server variable');
  });

  it('can be set for a channel other than the one where it happened, given as an ID or a #mention', async () => {
    install(commandFlow(
      [node('a', 'data.variable.set', { scope: 'channel', targetChannelId: other.id, name: 'a', operation: 'set', value: 'by id' }),
        node('b', 'data.variable.set', { scope: 'channel', targetChannelId: `<#${other.id}>`, name: 'b', operation: 'set', value: 'by mention' })],
      [edge('t', 'a'), edge('a', 'b')],
    ));
    await run(slashIn(general));
    assert.deepEqual(db.varsFor(guild.id, 'channel', other.id), { a: 'by id', b: 'by mention' });
    assert.deepEqual(db.varsFor(guild.id, 'channel', general.id), {});
  });

  it('are read with Get Variable (with a fallback) and by Math when it remembers its result', async () => {
    install(commandFlow(
      [node('m', 'data.math', { mode: 'two', a: '{{channel.vars.total | default:0}}', op: 'add', b: '5', saveAs: 'total', round: 'none', remember: 'channel' }),
        node('g', 'data.variable.get', { scope: 'channel', name: 'total', saveAs: 'seen', default: '0' }),
        node('x', 'data.variable.get', { scope: 'channel', name: 'missing', saveAs: 'nope', default: 'none yet' }),
        node('r', 'action.message.send', { target: 'reply', content: '{{var.seen}} / {{var.nope}}' })],
      [edge('t', 'm'), edge('m', 'g'), edge('g', 'x'), edge('x', 'r')],
    ));
    assert.equal(say(await run(slashIn(general))), '5 / none yet');
    assert.equal(say(await run(slashIn(general))), '10 / none yet');
    assert.equal(say(await run(slashIn(other))), '5 / none yet');
  });

  it('end on the error output when the run has no channel and none was filled in', async () => {
    const flow = install({
      nodes: [
        node('t', 'trigger.manual', {}),
        node('v', 'data.variable.set', { scope: 'channel', name: 'n', operation: 'set', value: '1' }),
        node('e', 'action.message.send', { target: 'channel', channelId: general.id, content: 'oops: {{error.message}}' }),
      ],
      edges: [edge('t', 'v'), edge('v', 'e', 'error')],
    });
    assert.deepEqual(await runtime.runManual(guild.id, flow.id, 't'), { ok: true });
    await settle();
    assert.equal(general.sent.length, 1);
    assert.match(general.sent[0].content, /^oops: No channel for this per-channel variable/);
    assert.deepEqual(db.listVars(guild.id), []);
  });

  it('refuse a Channel field that is not a channel ID', async () => {
    const flow = install({
      nodes: [
        node('t', 'trigger.manual', {}),
        node('v', 'data.variable.set', { scope: 'channel', targetChannelId: 'general', name: 'n', operation: 'set', value: '1' }),
        node('e', 'action.message.send', { target: 'channel', channelId: general.id, content: 'oops: {{error.message}}' }),
      ],
      edges: [edge('t', 'v'), edge('v', 'e', 'error')],
    });
    await runtime.runManual(guild.id, flow.id, 't');
    await settle();
    assert.match(general.sent[0]?.content ?? '', /No channel for this per-channel variable/);
    assert.deepEqual(db.listVars(guild.id), []);
  });
});

describe('channel variables in the database', () => {
  it('accept the channel scope and still refuse unknown scopes', () => {
    db.setVar('A', 'channel', '500001', 'x', 1);
    db.setVar('A', 'user', '500001', 'x', 2); // same id, different scope: separate variables
    assert.equal(db.getVar('A', 'channel', '500001', 'x'), 1);
    assert.equal(db.getVar('A', 'user', '500001', 'x'), 2);
    assert.throws(() => db.setVar('A', 'global', '', 'x', 1), /scope/);
  });

  it('forget one channel’s variables without touching anything else', () => {
    db.setVar('A', 'channel', '1', 'x', 1);
    db.setVar('A', 'channel', '1', 'y', 1);
    db.setVar('A', 'channel', '2', 'x', 1);
    db.setVar('A', 'user', '1', 'x', 1);
    db.setVar('A', 'guild', '', 'x', 1);
    db.setVar('B', 'channel', '1', 'x', 1);
    assert.equal(db.deleteVarsForScope('A', 'channel', '1'), 2);
    assert.deepEqual(db.listVars('A').map((v) => `${v.scope}:${v.scopeId}:${v.name}`), ['channel:2:x', 'guild::x', 'user:1:x']);
    assert.equal(db.getVar('B', 'channel', '1', 'x'), 1, 'another server keeps its own');
  });
});

describe('channel variables in the editor', () => {
  it('offer the Channel scope, its channel field only when chosen, and the {{channel.vars.*}} hint', () => {
    for (const [type, key] of [['data.variable.set', 'scope'], ['data.variable.get', 'scope'], ['data.math', 'remember']]) {
      const def = NODE_TYPES[type];
      assert.ok(def.fields.find((f) => f.key === key).options.some((o) => o.value === 'channel'), `${type} offers Channel`);
      const target = def.fields.find((f) => f.key === 'targetChannelId');
      assert.ok(target, `${type} has a Channel field`);
      assert.equal(isVisible(target, { [key]: 'channel' }), true);
      assert.equal(isVisible(target, { [key]: 'guild' }), false);
    }
    const nodes = [node('t', 'trigger.command', { name: 'cmd', description: 'x' }), node('r', 'action.message.send', { target: 'reply', content: 'x' })];
    assert.ok(availableVariables(nodes, [edge('t', 'r')], 'r').some((v) => v.path === 'channel.vars.<name>'));
  });
});
