// "Does this person have this role?" as a check in the Condition (If) node.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { NODE_TYPES } from '../shared/catalog.js';
import { resetLimits } from '../shared/limits.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

describe('role check', () => {
  let db; let runtime; let guild; let channel; let staff; let user; let member;
  const logs = () => runtime.logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);

  beforeEach(() => {
    resetLimits();
    db = new Database(':memory:');
    runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
    guild = fakeGuild({ id: '111111111111111111' });
    channel = guild.addChannel({ name: 'general' });
    staff = guild.addRole({ id: '424242424242424242', name: 'Staff' });
    user = fakeUser({ id: '222222222222222222', username: 'mia' });
    member = guild.addMember({ user });
    runtime.attachClient(guild.client);
  });

  /** /go → Condition (with these checks) → reply "yes" on True, "no" on False. */
  const install = (conditions, match = 'all') => {
    for (const f of db.listFlows(guild.id)) db.deleteFlow(guild.id, f.id); // one /go at a time: the first flow to define a command wins
    db.createFlow({
      guildId: guild.id, name: 'Gate',
      graph: commandFlow(
        [node('c', 'logic.condition', { match, conditions: conditions.map((c) => ({ left: '', op: 'equals', right: '', roleId: '', memberId: '', ...c })) }),
          node('y', 'action.message.send', { target: 'reply', content: 'yes' }),
          node('n', 'action.message.send', { target: 'reply', content: 'no' })],
        [edge('t', 'c'), edge('c', 'y', 'true'), edge('c', 'n', 'false')], 'go',
      ),
    });
    runtime.loadGuild(guild.id);
  };
  const go = async (who = { user, member }) => {
    const i = fakeCommand({ guild, channel, commandName: 'go', ...who });
    await runtime.handleInteraction(i);
    return i.calls.find((c) => c[0] === 'reply' || c[0] === 'editReply')?.[1].content;
  };
  const give = (m, role) => m.roles.cache.set(role.id, role);
  const has = { op: 'hasRole', roleId: '424242424242424242' };

  it('follows True for someone who has the role, and False for someone who does not', async () => {
    install([has]);
    assert.equal(await go(), 'no');
    give(member, staff);
    assert.equal(await go(), 'yes');
  });

  it('“does not have the role” is the other way round', async () => {
    install([{ ...has, op: 'lacksRole' }]);
    assert.equal(await go(), 'yes');
    give(member, staff);
    assert.equal(await go(), 'no');
  });

  it('reads the roles at the moment it runs, not when the flow was saved', async () => {
    install([has]);
    assert.equal(await go(), 'no');
    give(member, staff);
    assert.equal(await go(), 'yes');
    member.roles.cache.delete(staff.id);
    assert.equal(await go(), 'no');
  });

  it('everyone has @everyone', async () => {
    install([{ op: 'hasRole', roleId: '@everyone' }]);
    assert.equal(await go(), 'yes');
    install([{ op: 'hasRole', roleId: guild.id }]);
    assert.equal(await go(), 'yes', 'by its id too');
  });

  it('the role can come from a variable', async () => {
    install([{ op: 'hasRole', roleId: '{{guild.id}}' }]);
    assert.equal(await go(), 'yes');
  });

  it('a role that no longer exists counts as “no” (so a gate stays shut) and is written to the log', async () => {
    install([{ op: 'hasRole', roleId: '999999999999999999' }]);
    assert.equal(await go(), 'no');
    assert.ok(logs().some((l) => /^warn: A role check could not find its role, so it counts as “no”: Role “999999999999999999” was not found/.test(l)), logs().join('\n'));
    install([{ op: 'lacksRole', roleId: '999999999999999999' }]);
    assert.equal(await go(), 'yes', '“does not have” a role that is gone is true');
  });

  it('ANY / ALL work with role checks, mixed with text checks', async () => {
    const mod = guild.addRole({ id: '535353535353535353', name: 'Mod' });
    const either = [has, { op: 'hasRole', roleId: mod.id }];
    install(either, 'any');
    assert.equal(await go(), 'no');
    give(member, mod);
    assert.equal(await go(), 'yes', 'one of the two is enough');
    install(either, 'all');
    assert.equal(await go(), 'no', 'both are needed');
    give(member, staff);
    assert.equal(await go(), 'yes');
    install([has, { left: '{{user.name}}', op: 'equals', right: 'someone-else' }], 'all');
    assert.equal(await go(), 'no', 'the text check fails');
    install([has, { left: '{{user.name}}', op: 'equals', right: 'mia' }], 'all');
    assert.equal(await go(), 'yes');
  });

  describe('checking someone other than whoever started the flow', () => {
    let boss;
    beforeEach(() => { boss = guild.addMember({ user: fakeUser({ id: '333333333333333333', username: 'boss' }) }); give(boss, staff); });

    it('asks about the person named in Member', async () => {
      install([{ ...has, memberId: boss.id }]);
      assert.equal(await go(), 'yes', 'boss has the role even though mia does not');
      install([{ ...has, memberId: '{{user.id}}' }]);
      assert.equal(await go(), 'no', 'a variable works as well: mia does not');
    });

    it('asks Discord again instead of trusting a stored copy', async () => {
      const asked = [];
      const real = guild.members.fetch;
      guild.members.fetch = async (arg) => { asked.push(arg); return real(arg); };
      install([{ ...has, memberId: boss.id }]);
      await go();
      assert.deepEqual(asked, [{ user: boss.id, force: true }]);
      asked.length = 0;
      install([has]);
      await go();
      assert.deepEqual(asked, [], 'whoever started the flow arrived with fresh roles: no extra request');
    });

    it('someone who is not in the server does not have the role', async () => {
      install([{ ...has, memberId: '444444444444444444' }]);
      assert.equal(await go(), 'no');
      install([{ op: 'lacksRole', roleId: staff.id, memberId: '444444444444444444' }]);
      assert.equal(await go(), 'yes');
    });
  });

  it('a flow that no person started (a schedule) must say whose role to look at', async () => {
    const flow = db.createFlow({
      guildId: guild.id, name: 'Manual',
      graph: {
        nodes: [node('m', 'trigger.manual', { channelId: channel.id }), node('c', 'logic.condition', { match: 'all', conditions: [{ left: '', op: 'hasRole', right: '', roleId: staff.id, memberId: '' }] }), node('y', 'action.message.send', { target: 'channel', channelId: channel.id, content: 'yes' })],
        edges: [edge('m', 'c'), edge('c', 'y', 'true')],
      },
    });
    runtime.loadGuild(guild.id);
    assert.deepEqual(await runtime.runManual(guild.id, flow.id, 'm'), { ok: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(channel.sent, [], 'nothing was sent');
    assert.ok(logs().some((l) => /^error: .*not started by a person/.test(l)), logs().join('\n'));
  });

  describe('in the editor', () => {
    const problems = (check) => validateFlow(normalizeGraph({ nodes: [node('c', 'logic.condition', { match: 'all', conditions: [{ left: '', op: 'equals', right: '', roleId: '', memberId: '', ...check }] })], edges: [] }), { intents: { members: true, messageContent: true } })
      .filter((i) => i.nodeId === 'c' && i.level === 'error').map((i) => i.message);

    it('a role check needs a role, but not a value to compare', () => {
      assert.deepEqual(problems({ op: 'hasRole', roleId: staff.id }), []);
      assert.match(problems({ op: 'hasRole' })[0], /“Role” is required/);
      assert.match(problems({ op: 'lacksRole' })[0], /“Role” is required/);
    });

    it('a text check still needs its value, and no longer asks for a role', () => {
      assert.deepEqual(problems({ op: 'equals', left: 'a', right: 'b' }), []);
      assert.match(problems({ op: 'equals', left: '' })[0], /“Value” is required/);
    });

    it('the node says what it checks, with the role\'s name when the editor knows it', () => {
      const d = { match: 'all', conditions: [{ ...has, left: '', right: '', memberId: '' }, { left: '{{user.name}}', op: 'equals', right: 'mia' }] };
      const { summary } = NODE_TYPES['logic.condition'];
      assert.equal(summary(d), `has role ${staff.id} AND {{user.name}} equals mia`.slice(0, 60));
      assert.equal(summary(d, { role: (id) => (id === staff.id ? 'Staff' : undefined) }), 'has role Staff AND {{user.name}} equals mia');
      assert.equal(summary({ match: 'any', conditions: [{ op: 'lacksRole', roleId: '', memberId: '' }] }), 'lacks role ?');
    });
  });
});
