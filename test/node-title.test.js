// The optional title of a node: for people who edit the flow, never sent to Discord.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NODE_TYPES, TITLE_KEY, TITLE_MAX, defaultsFor, nodeTitle } from '../shared/catalog.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

const withTitle = (title, extra = {}) => normalizeGraph({ nodes: [{ id: 'n1', type: 'action.message.send', position: { x: 0, y: 0 }, data: { ...defaultsFor('action.message.send'), content: 'hi', ...extra, [TITLE_KEY]: title } }], edges: [] }).nodes[0].data;

describe('node title', () => {
  it('is stored under a key that no node field uses', () => {
    assert.equal(TITLE_KEY, '_title');
    for (const d of Object.values(NODE_TYPES)) assert.ok(!d.fields.some((f) => f.key === TITLE_KEY), `${d.type} has a field called ${TITLE_KEY}`);
    assert.ok(NODE_TYPES['action.modal.show'].fields.some((f) => f.key === 'title'), 'the form node has its own "title", which is why this one is different');
  });

  it('is tidied when a flow is saved: one line, trimmed, at most 60 characters', () => {
    assert.equal(withTitle('  Is staff?  ')[TITLE_KEY], 'Is staff?');
    assert.equal(withTitle('two\nlines\tand   spaces')[TITLE_KEY], 'two lines and spaces');
    assert.equal(withTitle('x'.repeat(200))[TITLE_KEY].length, TITLE_MAX);
    assert.equal(withTitle(`ok ${String.fromCharCode(0, 7)} ${String.fromCharCode(0x202e)} bidi ${String.fromCharCode(0x2066)} gone`)[TITLE_KEY], 'ok bidi gone');
    assert.equal(withTitle(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`)[TITLE_KEY], 'a b c');
  });

  it('is not stored at all when it is empty or not text', () => {
    for (const empty of ['', '   ', '\n\t', null, undefined, 5, {}, ['x']]) assert.ok(!(TITLE_KEY in withTitle(empty)), JSON.stringify(empty));
    assert.ok(!(TITLE_KEY in normalizeGraph({ nodes: [{ id: 'a', type: 'x', data: { a: 1 } }] }).nodes[0].data), 'and a node without one gets none');
  });

  it('leaves the rest of the node alone', () => {
    const d = withTitle('Greeting', { content: 'Hello {{user.name}}', target: 'channel' });
    assert.equal(d.content, 'Hello {{user.name}}');
    assert.equal(d.target, 'channel');
  });

  it('is not a problem for validation, and a long one is cut rather than refused', () => {
    const g = normalizeGraph({ nodes: [{ id: 'n1', type: 'trigger.manual', data: { ...defaultsFor('trigger.manual'), [TITLE_KEY]: 'y'.repeat(500) } }], edges: [] });
    assert.deepEqual(validateFlow(g, { intents: { members: true, messageContent: true } }).filter((i) => i.level === 'error'), []);
    assert.equal(nodeTitle(g.nodes[0].data).length, TITLE_MAX);
  });

  it('reading it is safe for any data', () => {
    for (const data of [undefined, null, {}, { _title: 3 }, { _title: null }, 'text']) assert.equal(nodeTitle(data), '');
  });

  it('a node that has its own "title" field (the form) keeps it, separate from this one', () => {
    const formNode = Object.values(NODE_TYPES).find((d) => d.fields.some((f) => f.key === 'title'));
    const d = normalizeGraph({ nodes: [{ id: 'f', type: formNode.type, data: { ...defaultsFor(formNode.type), title: 'Tell us more', [TITLE_KEY]: 'My form' } }] }).nodes[0].data;
    assert.equal(d.title, 'Tell us more');
    assert.equal(d[TITLE_KEY], 'My form');
  });

  describe('when a flow runs', () => {
    it('never reaches Discord, and changes nothing about what the flow does', async () => {
      const db = new Database(':memory:');
      const runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
      const guild = fakeGuild({ id: '111111111111111111' });
      const channel = guild.addChannel({ name: 'general' });
      const user = fakeUser({ id: '222222222222222222', username: 'mia' });
      const member = guild.addMember({ user });
      runtime.attachClient(guild.client);
      const secret = 'Secret note for admins';
      const flow = commandFlow([
        { ...node('c', 'logic.condition', { match: 'all', conditions: [{ left: '{{user.name}}', op: 'equals', right: 'mia', roleId: '', memberId: '' }] }), data: { ...node('c', 'logic.condition', { match: 'all', conditions: [{ left: '{{user.name}}', op: 'equals', right: 'mia', roleId: '', memberId: '' }] }).data, [TITLE_KEY]: secret } },
        { ...node('y', 'action.message.send', { target: 'channel', channelId: channel.id, content: 'hello {{user.name}}' }), data: { ...node('y', 'action.message.send', { target: 'channel', channelId: channel.id, content: 'hello {{user.name}}' }).data, [TITLE_KEY]: secret } },
      ], [edge('t', 'c'), edge('c', 'y', 'true')], 'go');
      db.createFlow({ guildId: guild.id, name: 'Titled', graph: normalizeGraph(flow) });
      runtime.loadGuild(guild.id);
      const i = fakeCommand({ guild, channel, user, member, commandName: 'go' });
      await runtime.handleInteraction(i);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(channel.sent.map((p) => p.content), ['hello mia']);
      assert.ok(!JSON.stringify([channel.sent, i.calls]).includes(secret), 'the title is nowhere in what was sent');
    });
  });
});
