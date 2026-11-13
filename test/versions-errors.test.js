// Earlier versions of a flow (kept at every save that changes it), failed runs kept across restarts, and the Flow Failed trigger.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { availableVariables } from '../shared/catalog.js';
import { KEEP, resetLimits } from '../shared/limits.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { DocumentDatabase } from '../server/db/document.js';
import { MemoryStore } from '../server/db/memory-store.js';
import { FAILURE_RUNS_PER_MINUTE, Runtime, SAVED_ERRORS_PER_MINUTE } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';
import { A, B, startHarness } from './helpers/harness.js';

const graphOf = (text) => ({ nodes: [node('t', 'trigger.manual'), node('l', 'logic.log', { message: text })], edges: [edge('t', 'l')] });

describe('earlier versions: storage', () => {
  for (const [name, make] of [['SQLite', () => new Database(':memory:')], ['the cloud-shaped database', () => new DocumentDatabase(new MemoryStore())]]) {
    it(`${name} keeps the newest few per flow, newest first, and only that flow's`, async () => {
      const db = make();
      for (let i = 1; i <= 5; i += 1) await db.addFlowVersion({ guildId: 'g1', flowId: 'f1', name: `v${i}`, graph: graphOf(`v${i}`), savedAt: 1000 + i, savedBy: { id: 'u', name: 'Mia' } }, 3);
      await db.addFlowVersion({ guildId: 'g1', flowId: 'f2', name: 'other flow', graph: graphOf('x'), savedAt: 5 }, 3);
      await db.addFlowVersion({ guildId: 'g2', flowId: 'f1', name: 'other server', graph: graphOf('x'), savedAt: 5 }, 3);
      const list = await db.listFlowVersions('g1', 'f1');
      assert.deepEqual(list.map((v) => [v.name, v.nodes, v.savedAt, v.savedBy?.name]), [['v5', 2, 1005, 'Mia'], ['v4', 2, 1004, 'Mia'], ['v3', 2, 1003, 'Mia']]);
      assert.equal(list[0].graph, undefined, 'the list does not carry the graphs');
      const full = await db.getFlowVersion('g1', 'f1', list[0].id);
      assert.equal(full.graph.nodes[1].data.message, 'v5');
      assert.equal(await db.getFlowVersion('g1', 'f2', list[0].id), null, 'not through another flow');
      assert.equal(await db.getFlowVersion('g2', 'f1', list[0].id), null, 'nor another server');
      assert.equal(await db.getFlowVersion('g1', 'f1', 'nope'), null);
      assert.equal(await db.deleteFlowVersions('g1', 'f1'), 3);
      assert.deepEqual(await db.listFlowVersions('g1', 'f1'), []);
      assert.equal((await db.listFlowVersions('g1', 'f2')).length, 1);
      assert.equal((await db.listFlowVersions('g2', 'f1')).length, 1);
    });

    it(`${name} keeps two versions saved in the same instant in the order they were saved`, async () => {
      const db = make();
      for (const n of ['first', 'second', 'third']) await db.addFlowVersion({ guildId: 'g', flowId: 'f', name: n, graph: graphOf(n), savedAt: 7 });
      assert.deepEqual((await db.listFlowVersions('g', 'f')).map((v) => v.name), ['third', 'second', 'first']);
    });

    it(`${name} keeps the newest failed runs of a server, newest first`, async () => {
      const db = make();
      for (let i = 1; i <= 5; i += 1) await db.addFlowError({ guildId: 'g1', flowId: 'f', flowName: 'Tickets', nodeId: 'n', nodeLabel: 'Give Role', message: `m${i}`, at: 100 + i }, 3);
      await db.addFlowError({ guildId: 'g2', flowId: 'f', flowName: 'Theirs', message: 'secret', at: 1 });
      const list = await db.listFlowErrors('g1');
      assert.deepEqual(list.map((e) => e.message), ['m5', 'm4', 'm3']);
      assert.deepEqual({ ...list[0], id: '' }, { id: '', flowId: 'f', flowName: 'Tickets', nodeId: 'n', nodeLabel: 'Give Role', message: 'm5', at: 105 });
      assert.deepEqual((await db.listFlowErrors('g1', 1)).map((e) => e.message), ['m5']);
      assert.equal(await db.clearFlowErrors('g1'), 3);
      assert.deepEqual(await db.listFlowErrors('g1'), []);
      assert.equal((await db.listFlowErrors('g2')).length, 1, 'another server keeps its own');
    });
  }
});

describe('earlier versions: saving and restoring', () => {
  let h;
  beforeEach(async () => { resetLimits(); h = await startHarness(); });
  afterEach(async () => { await h.close(); });
  const create = async (text = 'one', gid = A) => (await h.call('POST', `/api/guilds/${gid}/flows`, { body: { name: 'Flow', graph: graphOf(text) } })).json.flow;
  const save = (flow, body, gid = A) => h.call('PUT', `/api/guilds/${gid}/flows/${flow.id}`, { body });
  const versions = async (flow, gid = A) => (await h.call('GET', `/api/guilds/${gid}/flows/${flow.id}/versions`)).json;

  it('a save that changes the flow keeps what it looked like before; one that changes nothing does not', async () => {
    const flow = await create('one');
    assert.deepEqual(await versions(flow), { versions: [], keep: KEEP.flowVersions });
    await save(flow, { graph: graphOf('two') });
    await save(flow, { graph: graphOf('two') });
    await save(flow, { enabled: true });
    await save(flow, { name: 'Flow' });
    let list = (await versions(flow)).versions;
    assert.equal(list.length, 1, 'the same graph again, switching it on and the same name are not new versions');
    assert.deepEqual([list[0].name, list[0].nodes, list[0].savedBy.name], ['Flow', 2, 'Mia']);
    await save(flow, { name: 'Renamed' });
    list = (await versions(flow)).versions;
    assert.deepEqual(list.map((v) => v.name), ['Flow', 'Flow'], 'a new name is a change too; the version holds the old one');
    assert.equal(list[0].id === list[1].id, false);
  });

  it('gives back an earlier version with its graph, so the editor can put it on the canvas', async () => {
    const flow = await create('one');
    await save(flow, { graph: graphOf('two') });
    await save(flow, { graph: graphOf('three') });
    const list = (await versions(flow)).versions;
    const texts = [];
    for (const v of list) {
      const got = await h.call('GET', `/api/guilds/${A}/flows/${flow.id}/versions/${v.id}`);
      assert.equal(got.status, 200);
      assert.deepEqual(Object.keys(got.json.version).sort(), ['graph', 'id', 'name', 'savedAt', 'savedBy']);
      texts.push(got.json.version.graph.nodes.find((n) => n.id === 'l').data.message);
    }
    assert.deepEqual(texts, ['two', 'one'], 'newest first');
    assert.equal((await h.call('GET', `/api/guilds/${A}/flows/${flow.id}`)).json.flow.graph.nodes.find((n) => n.id === 'l').data.message, 'three', 'reading a version changes nothing');
    // restoring = saving that graph again: the flow goes back, and what was there becomes a version itself
    const old = (await h.call('GET', `/api/guilds/${A}/flows/${flow.id}/versions/${list[1].id}`)).json.version;
    await save(flow, { name: old.name, graph: old.graph });
    assert.equal((await h.call('GET', `/api/guilds/${A}/flows/${flow.id}`)).json.flow.graph.nodes.find((n) => n.id === 'l').data.message, 'one');
    assert.equal((await versions(flow)).versions.length, 3);
  });

  it('keeps no more than a fixed number, dropping the oldest', async () => {
    const flow = await create('v0');
    for (let i = 1; i <= KEEP.flowVersions + 3; i += 1) await save(flow, { graph: graphOf(`v${i}`) });
    const list = (await versions(flow)).versions;
    assert.equal(list.length, KEEP.flowVersions);
    const newest = (await h.call('GET', `/api/guilds/${A}/flows/${flow.id}/versions/${list[0].id}`)).json.version;
    const oldest = (await h.call('GET', `/api/guilds/${A}/flows/${flow.id}/versions/${list.at(-1).id}`)).json.version;
    assert.deepEqual([newest.graph.nodes[1].data.message, oldest.graph.nodes[1].data.message], [`v${KEEP.flowVersions + 2}`, 'v3']);
  });

  it('a version is only reachable through its own flow and its own server, by someone signed in', async () => {
    const mine = await create('mine');
    await save(mine, { graph: graphOf('mine 2') });
    const other = await create('other');
    const theirs = await create('theirs', B);
    await save(theirs, { graph: graphOf('theirs 2') }, B);
    const [v] = (await versions(mine)).versions;
    assert.equal((await h.call('GET', `/api/guilds/${A}/flows/${other.id}/versions/${v.id}`)).status, 404, 'another flow');
    assert.equal((await h.call('GET', `/api/guilds/${B}/flows/${mine.id}/versions/${v.id}`)).status, 404, 'another server');
    assert.equal((await h.call('GET', `/api/guilds/${B}/flows/${theirs.id}/versions/${v.id}`)).status, 404);
    assert.equal((await h.call('GET', `/api/guilds/${A}/flows/${mine.id}/versions/nope`)).status, 404);
    assert.equal((await h.call('GET', `/api/guilds/${A}/flows/${mine.id}/versions`, { sid: null })).status, 401);
    h.state.managers.delete(`${A}:u1`);
    assert.equal((await h.call('GET', `/api/guilds/${A}/flows/${mine.id}/versions`)).status, 403);
  });

  it('deleting a flow deletes its versions; a copy starts without any', async () => {
    const flow = await create('one');
    await save(flow, { graph: graphOf('two') });
    const copy = (await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/duplicate`)).json.flow;
    assert.deepEqual((await versions(copy)).versions, []);
    await h.call('DELETE', `/api/guilds/${A}/flows/${flow.id}`);
    assert.deepEqual(h.db.listFlowVersions(A, flow.id), []);
  });

  it('works the same on the cloud database', async () => {
    await h.close();
    h = await startHarness({ database: 'memory' });
    const flow = await create('one');
    await save(flow, { graph: graphOf('two') });
    const list = (await versions(flow)).versions;
    assert.equal(list.length, 1);
    assert.equal((await h.call('GET', `/api/guilds/${A}/flows/${flow.id}/versions/${list[0].id}`)).json.version.graph.nodes[1].data.message, 'one');
  });
});

describe('failed runs', () => {
  let db; let runtime; let guild; let channel; let user; let member; let logger;
  const install = (graph, name = 'Flow') => { const flow = db.createFlow({ guildId: guild.id, name, graph }); runtime.loadGuild(guild.id); return flow; };
  const run = async (commandName = 'cmd') => { const i = fakeCommand({ guild, channel, user, member, commandName }); await runtime.handleInteraction(i); return i; };
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const logs = () => logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);
  const broken = (name = 'cmd') => commandFlow([node('x', 'action.member.addRole', { roleId: '999999', _title: 'Starter role' })], [edge('t', 'x')], name);
  const watcher = (data = {}) => ({ nodes: [node('f', 'trigger.flow.failed', data), node('l', 'logic.log', { message: 'ALERT {{failure.flow}} | {{failure.node}} | {{failure.message}} | by {{user.name}} in {{channel.name}}' })], edges: [edge('f', 'l')] });

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

  it('a run that fails is written down, with the flow, the step and why', async () => {
    const flow = install(broken(), 'Welcome');
    await run();
    const saved = db.listFlowErrors(guild.id);
    assert.equal(saved.length, 1);
    assert.deepEqual({ ...saved[0], id: '', at: 0 }, { id: '', at: 0, flowId: flow.id, flowName: 'Welcome', nodeId: 'x', nodeLabel: 'Starter role (Give Role)', message: 'Role “999999” was not found in this server.' });
    assert.ok(Date.now() - saved[0].at < 5000);
  });

  it('an error the flow deals with itself is not a failed run; neither is a run that was stopped', async () => {
    install(commandFlow([node('x', 'action.member.addRole', { roleId: '999999' }), node('l', 'logic.log', { message: 'handled' })], [edge('t', 'x'), edge('x', 'l', 'error')]), 'Handled');
    await run();
    assert.deepEqual(db.listFlowErrors(guild.id), []);
    const slow = db.createFlow({ guildId: guild.id, name: 'Slow', graph: commandFlow([node('w', 'logic.wait', { seconds: 30 })], [edge('t', 'w')], 'slow') });
    runtime.loadGuild(guild.id);
    const going = run('slow');
    await tick();
    db.updateFlow(guild.id, slow.id, { enabled: false });
    runtime.loadGuild(guild.id);
    await going;
    assert.deepEqual(db.listFlowErrors(guild.id), []);
  });

  it('a run cut short by the step limit is written down too', async () => {
    const { applyLimits } = await import('../shared/limits.js');
    applyLimits({ stepsPerRun: 3 });
    install(commandFlow([node('a', 'logic.log', { message: 'a' }), node('b', 'logic.log', { message: 'b' })], [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')]), 'Endless');
    await run();
    const [saved] = db.listFlowErrors(guild.id);
    assert.equal(saved.flowName, 'Endless');
    assert.match(saved.message, /Stopped after 3 steps/);
  });

  it('when Run Flow fails because a step in the called flow did, that step is the one named', async () => {
    const shared = install({ nodes: [node('in', 'trigger.called', { name: 'shared' }), node('x', 'action.member.kick', { userId: '999999' })], edges: [edge('in', 'x')] }, 'Shared steps');
    install(commandFlow([node('c', 'logic.call', { name: 'shared' })], [edge('t', 'c')]), 'Caller');
    await run();
    const saved = db.listFlowErrors(guild.id);
    assert.equal(saved.length, 1, 'one failed run, not one per flow it went through');
    assert.deepEqual([saved[0].flowId, saved[0].flowName, saved[0].nodeLabel], [shared.id, 'Shared steps', 'Kick Member']);
    assert.match(saved[0].message, /not a member of this server/);
  });

  it('…and when the caller deals with it, nothing is written down', async () => {
    install({ nodes: [node('in', 'trigger.called', { name: 'shared' }), node('x', 'action.member.kick', { userId: '999999' })], edges: [edge('in', 'x')] }, 'Shared steps');
    install(commandFlow([node('c', 'logic.call', { name: 'shared' }), node('l', 'logic.log', { message: 'never mind' })], [edge('t', 'c'), edge('c', 'l', 'error')]), 'Caller');
    await run();
    assert.deepEqual(db.listFlowErrors(guild.id), []);
  });

  it('a flow that fails over and over does not become a database write every time', async () => {
    install(broken());
    for (let i = 0; i < SAVED_ERRORS_PER_MINUTE + 10; i += 1) await run();
    assert.equal(db.listFlowErrors(guild.id).length, SAVED_ERRORS_PER_MINUTE);
  });

  it('a database that cannot be written to never breaks the run', async () => {
    install(broken());
    db.addFlowError = () => { throw new Error('disk is full'); };
    const i = await run();
    assert.equal(i.calls.at(-1)[1].content.startsWith('⚠️'), true, 'the person is still told');
    assert.ok(logs().some((m) => m === 'warn: The failed run could not be saved: disk is full'));
  });

  describe('the Flow Failed trigger', () => {
    it('runs with which flow, which step, why, who and where', async () => {
      install(broken(), 'Welcome');
      install(watcher(), 'Alerts');
      await run();
      await tick();
      assert.deepEqual(logs().filter((m) => m.startsWith('info: ALERT')), ['info: ALERT Welcome | Starter role (Give Role) | Role “999999” was not found in this server. | by mia in general']);
    });

    it('can watch one flow only', async () => {
      const a = install(broken('a'), 'Flow A');
      install(broken('b'), 'Flow B');
      install(watcher({ flow: a.id }), 'Alerts');
      await run('a'); await run('b');
      await tick();
      assert.deepEqual(logs().filter((m) => m.startsWith('info: ALERT')).map((m) => m.split(' | ')[0]), ['info: ALERT Flow A']);
    });

    it('a failure inside the alert flow itself does not start it again', async () => {
      install(broken(), 'Welcome');
      install({ nodes: [node('f', 'trigger.flow.failed'), node('l', 'logic.log', { message: 'ALERT' }), node('x', 'action.member.addRole', { roleId: '888888' })], edges: [edge('f', 'l'), edge('l', 'x')] }, 'Alerts');
      await run();
      await tick();
      assert.equal(logs().filter((m) => m === 'info: ALERT').length, 1);
      assert.deepEqual(db.listFlowErrors(guild.id).map((e) => e.flowName).sort(), ['Alerts', 'Welcome'], 'both failures are written down');
    });

    it('starts at most a few times a minute per server', async () => {
      install(broken());
      install(watcher(), 'Alerts');
      for (let i = 0; i < FAILURE_RUNS_PER_MINUTE + 5; i += 1) await run();
      await tick();
      assert.equal(logs().filter((m) => m.startsWith('info: ALERT')).length, FAILURE_RUNS_PER_MINUTE);
    });

    it('does not hear about another server’s failures', async () => {
      const other = fakeGuild({ id: '999999' });
      db.createFlow({ guildId: other.id, name: 'Their alerts', graph: watcher() });
      runtime.loadGuild(other.id);
      install(broken());
      await run();
      await tick();
      assert.equal(runtime.logger.recent(other.id).some((l) => l.message.startsWith('ALERT')), false);
      assert.deepEqual(db.listFlowErrors(other.id), []);
    });

    it('offers its variables, and the Error alerts template is valid and only needs a channel', () => {
      const g = watcher();
      const paths = availableVariables(g.nodes, g.edges, 'l').map((v) => v.path);
      for (const p of ['failure.flow', 'failure.message', 'failure.node', 'failure.time', 'user.mention', 'channel.mention']) assert.ok(paths.includes(p), p);
      const t = TEMPLATES.find((x) => x.id === 'error-alerts');
      const issues = validateFlow(normalizeGraph(t.build()));
      assert.equal(hasStructureErrors(issues), false);
      assert.deepEqual(issues.filter((i) => i.level === 'error').map((i) => i.message), ['“Channel” is required.']);
    });
  });
});

describe('failed runs: the dashboard', () => {
  let h;
  beforeEach(async () => { resetLimits(); h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('lists and deletes the saved errors of one server only', async () => {
    h.db.addFlowError({ guildId: A, flowId: 'f1', flowName: 'Welcome', nodeId: 'n', nodeLabel: 'Give Role', message: 'older', at: 10 });
    h.db.addFlowError({ guildId: A, flowId: 'f1', flowName: 'Welcome', message: 'newer', at: 20 });
    h.db.addFlowError({ guildId: B, flowId: 'f9', flowName: 'Theirs', message: 'not yours', at: 30 });
    const res = await h.call('GET', `/api/guilds/${A}/errors`);
    assert.equal(res.status, 200);
    assert.equal(res.json.keep, KEEP.savedErrors);
    assert.deepEqual(res.json.errors.map((e) => [e.flowName, e.nodeLabel, e.message]), [['Welcome', '', 'newer'], ['Welcome', 'Give Role', 'older']]);
    assert.equal((await h.call('GET', `/api/guilds/${A}/errors`, { sid: null })).status, 401);
    assert.equal((await h.call('DELETE', `/api/guilds/${A}/errors`, { origin: 'https://evil.example' })).status, 403, 'not from another website');
    assert.deepEqual((await h.call('DELETE', `/api/guilds/${A}/errors`)).json, { ok: true, removed: 2 });
    assert.deepEqual((await h.call('GET', `/api/guilds/${A}/errors`)).json.errors, []);
    assert.equal(h.db.listFlowErrors(B).length, 1, 'the other server keeps its own');
  });

  it('they are still there after a restart, which the live log is not', async () => {
    h.db.createFlow({ guildId: A, name: 'Broken', graph: commandFlow([node('x', 'action.member.addRole', { roleId: '999999' })], [edge('t', 'x')]) });
    h.runtime.loadGuild(A);
    const guild = h.guilds[A];
    const user = fakeUser({ id: '222222', username: 'mia' });
    await h.runtime.handleInteraction(fakeCommand({ guild, channel: guild.addChannel({ name: 'general' }), user, member: guild.addMember({ user }), commandName: 'cmd' }));
    const fresh = new Logger({ console: false }); // what a restart leaves of the live log: nothing
    assert.deepEqual(fresh.recent(A), []);
    const { errors } = (await h.call('GET', `/api/guilds/${A}/errors`)).json;
    assert.deepEqual(errors.map((e) => [e.flowName, e.nodeLabel]), [['Broken', 'Give Role']]);
  });
});
