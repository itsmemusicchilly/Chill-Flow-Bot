// Run Flow + Called by Another Flow: steps that several flows share.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { availableVariables } from '../shared/catalog.js';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { MAX_CALL_DEPTH } from '../shared/nodes/connect.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeComponent, fakeGuild, fakeUser, node } from './helpers/fakes.js';
import { A, startHarness } from './helpers/harness.js';

let db; let runtime; let guild; let channel; let user; let member;
const install = (graph, name = 'Caller', guildId = guild.id) => { const flow = db.createFlow({ guildId, name, graph }); runtime.loadGuild(guildId); return flow; };
const run = async (commandName = 'cmd', options = []) => {
  const i = fakeCommand({ guild, channel, user, member, commandName, options });
  await runtime.handleInteraction(i);
  return i;
};
const said = (i) => i.calls.filter((c) => ['reply', 'followUp', 'editReply'].includes(c[0])).map((c) => c[1].content);
const logs = () => runtime.logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);
/** A flow that only holds shared steps: a “Called by Another Flow” trigger named `name`, then `nodes`. */
const callee = (name, nodes, edges) => ({ nodes: [node('in', 'trigger.called', { name }), ...nodes], edges });

beforeEach(() => {
  resetLimits();
  db = new Database(':memory:');
  runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'general' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  runtime.attachClient(guild.client);
});

describe('Run Flow', () => {
  it('runs the steps of another flow with the values it passes, waits, and carries on with what they stored', async () => {
    install(callee('give-points', [
      node('m', 'data.math', { mode: 'two', a: '{{user.vars.points}}', op: 'add', b: '{{arg.amount}}', saveAs: 'total', remember: 'none' }),
      node('v', 'data.variable.set', { scope: 'user', name: 'points', operation: 'set', value: '{{var.total}}', valueType: 'number' }),
    ], [edge('in', 'm'), edge('m', 'v')]), 'Shared');
    install(commandFlow(
      [node('c', 'logic.call', { name: 'give-points', args: [{ name: 'amount', value: '{{option.n}}' }] }), node('r', 'action.message.send', { target: 'reply', content: '{{user.name}} now has {{var.total}} (arg is [{{arg.amount}}])' })],
      [edge('t', 'c'), edge('c', 'r')],
    ));
    assert.deepEqual(said(await run('cmd', [{ name: 'n', value: 5 }])), ['mia now has 5 (arg is [])'], 'the passed values are gone again after the call');
    assert.deepEqual(said(await run('cmd', [{ name: 'n', value: 7 }])), ['mia now has 12 (arg is [])']);
    assert.equal(db.getVar(guild.id, 'user', user.id, 'points'), 12);
  });

  it('the called steps can answer the command, and the caller’s next reply becomes a follow-up', async () => {
    install(callee('greet', [node('s', 'action.message.send', { target: 'reply', content: 'hello {{user.name}} from {{arg.who}}' })], [edge('in', 's')]), 'Shared');
    install(commandFlow([node('c', 'logic.call', { name: 'greet', args: [{ name: 'who', value: 'the caller' }] }), node('r', 'action.message.send', { target: 'reply', content: 'done' })], [edge('t', 'c'), edge('c', 'r')]));
    const i = await run();
    assert.deepEqual(i.calls.map((c) => [c[0], c[1].content]), [['reply', 'hello mia from the caller'], ['followUp', 'done']]);
  });

  it('can run steps that live in the same flow', async () => {
    install({
      nodes: [
        node('t', 'trigger.command', { name: 'cmd', description: 'x' }), node('c1', 'logic.call', { name: 'twice' }), node('c2', 'logic.call', { name: 'twice' }),
        node('r', 'action.message.send', { target: 'reply', content: 'n={{var.n}}' }),
        node('in', 'trigger.called', { name: 'twice' }), node('m', 'data.math', { mode: 'two', a: '{{var.n}}', op: 'add', b: '1', saveAs: 'n', remember: 'none' }),
      ],
      edges: [edge('t', 'c1'), edge('c1', 'c2'), edge('c2', 'r'), edge('in', 'm')],
    });
    assert.deepEqual(said(await run()), ['n=2']);
  });

  it('follows On error when a called step fails, and carries on as if nothing happened when that flow handles it itself', async () => {
    install(callee('breaks', [node('x', 'action.member.addRole', { roleId: '999999' })], [edge('in', 'x')]), 'Broken');
    install(callee('copes', [node('x', 'action.member.addRole', { roleId: '999999' }), node('l', 'logic.log', { message: 'handled' })], [edge('in', 'x'), edge('x', 'l', 'error')]), 'Copes');
    const caller = (name) => commandFlow([node('c', 'logic.call', { name }), node('r', 'action.message.send', { target: 'reply', content: 'fine' }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'c'), edge('c', 'r'), edge('c', 'e', 'error')], name);
    install(caller('breaks'), 'A');
    install(caller('copes'), 'B');
    assert.deepEqual(said(await run('breaks')), ['failed: “breaks” ran into a problem (see the lines above in the log).']);
    assert.deepEqual(said(await run('copes')), ['fine']);
  });

  it('an unhandled failure in the called steps, with nothing on the caller’s On error either, tells the user', async () => {
    install(callee('breaks', [node('x', 'action.member.addRole', { roleId: '999999' })], [edge('in', 'x')]), 'Broken');
    install(commandFlow([node('c', 'logic.call', { name: 'breaks' }), node('r', 'action.message.send', { target: 'reply', content: 'never' })], [edge('t', 'c'), edge('c', 'r')]));
    const i = await run();
    assert.deepEqual(said(i).filter((m) => m === 'never'), []);
    assert.ok(logs().some((m) => /error: Give Role: Role “999999” was not found/.test(m)));
    assert.ok(logs().some((m) => /error: Run Flow: “breaks” ran into a problem/.test(m)));
  });

  it('says so when nothing has that name, or the flow that has it is switched off', async () => {
    const shared = install(callee('greet', [node('l', 'logic.log', { message: 'hi' })], [edge('in', 'l')]), 'Shared');
    install(commandFlow([node('c', 'logic.call', { name: '{{option.which}}' }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'c'), edge('c', 'e', 'error')]));
    assert.deepEqual(said(await run('cmd', [{ name: 'which', value: 'nope' }])), ['failed: Nothing to run: no flow that is switched on has a “Called by Another Flow” trigger named “nope”.']);
    assert.deepEqual(said(await run('cmd', [{ name: 'which', value: '' }])), ['failed: Choose the flow to run.']);
    assert.deepEqual(said(await run('cmd', [{ name: 'which', value: 'greet' }])), ['✅ Done.'], 'it ran: nothing failed, and nothing answered the command');
    assert.ok(logs().includes('info: hi'));
    db.updateFlow(guild.id, shared.id, { enabled: false });
    runtime.loadGuild(guild.id);
    assert.match(said(await run('cmd', [{ name: 'which', value: 'greet' }]))[0], /^failed: Nothing to run/);
  });

  it('never reaches another server’s flow', async () => {
    const other = fakeGuild({ id: '999999' });
    db.createFlow({ guildId: other.id, name: 'Theirs', graph: callee('secret', [node('l', 'logic.log', { message: 'LEAK' })], [edge('in', 'l')]) });
    runtime.loadGuild(other.id);
    install(commandFlow([node('c', 'logic.call', { name: 'secret' }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })], [edge('t', 'c'), edge('c', 'e', 'error')]));
    assert.match(said(await run())[0], /^failed: Nothing to run/);
    assert.equal(runtime.logger.recent(other.id).some((l) => l.message === 'LEAK'), false);
  });

  it('a flow that runs itself stops at a fixed depth instead of going on forever', async () => {
    install(callee('again', [node('m', 'data.math', { mode: 'two', a: '{{var.depth}}', op: 'add', b: '1', saveAs: 'depth', remember: 'none' }), node('c', 'logic.call', { name: 'again' })], [edge('in', 'm'), edge('m', 'c')]), 'Loop');
    install(commandFlow([node('c', 'logic.call', { name: 'again' }), node('e', 'action.message.send', { target: 'reply', content: 'stopped at {{var.depth}}' })], [edge('t', 'c'), edge('c', 'e', 'error')]));
    assert.deepEqual(said(await run()), [`stopped at ${MAX_CALL_DEPTH}`]);
    assert.ok(logs().some((m) => m.includes(`more than ${MAX_CALL_DEPTH} deep`)));
  });

  it('counts the called steps towards the run’s step limit', async () => {
    applyLimits({ stepsPerRun: 5 });
    install(callee('long', Array.from({ length: 6 }, (_, i) => node(`l${i}`, 'logic.log', { message: `step ${i}` })), [edge('in', 'l0'), ...Array.from({ length: 5 }, (_, i) => edge(`l${i}`, `l${i + 1}`))]), 'Long');
    install(commandFlow([node('c', 'logic.call', { name: 'long' })], [edge('t', 'c')]));
    await run();
    assert.ok(logs().some((m) => /Stopped after 5 steps/.test(m)));
    assert.equal(logs().some((m) => m.endsWith('step 5')), false);
  });

  it('a button sent by the called steps belongs to that flow and keeps working', async () => {
    const shared = install(callee('panel', [
      node('s', 'action.message.send', { target: 'reply', content: 'pick', buttons: [{ id: 'yes', label: 'Yes', style: 'Primary', emoji: '', url: '', disabled: false, customId: '' }] }),
      node('y', 'action.message.send', { target: 'reply', content: 'you said yes, {{user.name}}' }),
    ], [edge('in', 's'), edge('s', 'y', 'btn_yes')]), 'Shared');
    install(commandFlow([node('c', 'logic.call', { name: 'panel' })], [edge('t', 'c')]));
    const i = await run();
    const id = i.calls[0][1].components[0].toJSON().components[0].custom_id;
    assert.ok(id.includes(shared.id), 'the button names the flow its node is in');
    const press = fakeComponent({ guild, channel, user, member, customId: id });
    await runtime.handleInteraction(press);
    assert.deepEqual(press.calls.map((c) => c[1]?.content), ['you said yes, mia']);
  });

  it('switching off a flow the run is passing through stops the run', async () => {
    const shared = install(callee('slow', [node('w', 'logic.wait', { seconds: 30 }), node('l', 'logic.log', { message: 'AFTER WAIT' })], [edge('in', 'w'), edge('w', 'l')]), 'Slow');
    const caller = install(commandFlow([node('c', 'logic.call', { name: 'slow' }), node('l', 'logic.log', { message: 'BACK IN CALLER' })], [edge('t', 'c'), edge('c', 'l')]));
    for (const off of [shared, caller]) {
      const going = run();
      await new Promise((r) => setTimeout(r, 30));
      db.updateFlow(guild.id, off.id, { enabled: false });
      runtime.loadGuild(guild.id);
      await going;
      assert.equal(logs().some((m) => /AFTER WAIT|BACK IN CALLER/.test(m)), false, `switching off “${off.name}” stops it`);
      db.updateFlow(guild.id, off.id, { enabled: true });
      runtime.loadGuild(guild.id);
    }
  });

  it('two triggers with one name: the older flow answers and the log says so', async () => {
    install(callee('dup', [node('l', 'logic.log', { message: 'FIRST' })], [edge('in', 'l')]), 'One');
    install(callee('dup', [node('l', 'logic.log', { message: 'SECOND' })], [edge('in', 'l')]), 'Two');
    install(commandFlow([node('c', 'logic.call', { name: 'dup' })], [edge('t', 'c')]));
    await run();
    assert.ok(logs().some((m) => m === 'info: FIRST'));
    assert.equal(logs().some((m) => m === 'info: SECOND'), false);
    assert.ok(logs().some((m) => /named “dup” twice; the one in “Two” is ignored \(“One” answers to it\)/.test(m)));
  });

  it('checks the names, and offers {{arg.…}} to the called steps', () => {
    const problems = (type, data) => validateFlow(normalizeGraph({ nodes: [node('t', 'trigger.manual'), node('n', type, data)], edges: type.startsWith('trigger') ? [] : [edge('t', 'n')] })).filter((i) => i.nodeId === 'n' && i.level === 'error').map((i) => i.message);
    assert.ok(problems('trigger.called', { name: '' }).some((m) => /required/.test(m)));
    assert.deepEqual(problems('trigger.called', { name: 'give points!' }), ['The name can only use letters, numbers, - _ and . (max 64).']);
    assert.deepEqual(problems('trigger.called', { name: 'give-points' }), []);
    assert.ok(problems('logic.call', { name: '' }).some((m) => /required/.test(m)));
    assert.ok(problems('logic.call', { name: 'x', args: [{ name: 'bad name', value: '1' }] }).some((m) => /letters, numbers/.test(m)));
    const g = callee('x', [node('l', 'logic.log', { message: 'm' })], [edge('in', 'l')]);
    const paths = availableVariables(g.nodes, g.edges, 'l').map((v) => v.path);
    assert.ok(paths.includes('arg.<name>') && paths.includes('var.<name>'));
  });
});

describe('the list of flows that can be run', () => {
  it('names every “Called by Another Flow” trigger of this server only, and says which are switched off', async () => {
    const h = await startHarness();
    try {
      h.db.createFlow({ guildId: A, name: 'Shared', graph: callee('give-points', [], []), enabled: true });
      h.db.createFlow({ guildId: A, name: 'Old', graph: callee('legacy', [], []), enabled: false });
      h.db.createFlow({ guildId: A, name: 'Copy', graph: callee('give-points', [], []), enabled: true });
      h.db.createFlow({ guildId: '222222', name: 'Theirs', graph: callee('secret', [], []), enabled: true });
      const res = await h.call('GET', `/api/guilds/${A}/callables`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, [{ id: 'give-points', name: 'give-points — in “Shared”' }, { id: 'legacy', name: 'legacy — in “Old” (switched off)' }]);
      assert.equal((await h.call('GET', `/api/guilds/${A}/callables`, { sid: null })).status, 401);
    } finally { await h.close(); }
  });
});
