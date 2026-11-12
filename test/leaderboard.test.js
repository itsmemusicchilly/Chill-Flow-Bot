// The Leaderboard node: ranks members by a per-user variable, on SQLite and on the cloud-shaped database alike.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { availableVariables, defaultsFor } from '../shared/catalog.js';
import { resetLimits } from '../shared/limits.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { DocumentDatabase } from '../server/db/document.js';
import { MemoryStore } from '../server/db/memory-store.js';
import { rankRows } from '../server/db/rank.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

describe('ranking a variable', () => {
  const rows = [{ id: '300', value: 5 }, { id: '100', value: 20 }, { id: '200', value: '20' }, { id: '400', value: 'lots' }, { id: '500', value: [1] }, { id: '600', value: true }, { id: '700', value: -3.5 }];

  it('orders by value, highest first, and ranks only numbers', () => {
    const board = rankRows(rows);
    assert.deepEqual(board.entries.map((e) => [e.rank, e.id, e.value]), [[1, '100', 20], [2, '200', 20], [3, '300', 5], [4, '700', -3.5]]);
    assert.equal(board.total, 4, 'text, lists and true are not ranked');
  });

  it('equal values always come out in the same order (the older id first)', () => {
    assert.deepEqual(rankRows([{ id: '1000', value: 1 }, { id: '999', value: 1 }, { id: '20', value: 1 }]).entries.map((e) => e.id), ['20', '999', '1000']);
  });

  it('lowest first, a limit, and one member’s own place', () => {
    assert.deepEqual(rankRows(rows, { descending: false, limit: 2 }).entries.map((e) => e.id), ['700', '300']);
    const mine = rankRows(rows, { limit: 1, id: '300' });
    assert.equal(mine.entries.length, 1);
    assert.equal(mine.rank, 3, 'their place is known even when they are not in the top');
    assert.equal(mine.value, 5);
    assert.equal(mine.total, 4);
    assert.deepEqual([rankRows(rows, { id: '400' }).rank, rankRows(rows, { id: '400' }).value], [null, null], 'someone without a number has no place');
    assert.equal(rankRows(rows, { id: 'nobody' }).rank, null);
    assert.deepEqual(rankRows([]), { entries: [], total: 0, rank: null, value: null });
  });

  for (const [name, make] of [['SQLite', () => new Database(':memory:')], ['the cloud-shaped database', () => new DocumentDatabase(new MemoryStore())]]) {
    it(`${name} ranks one variable of one server`, async () => {
      const db = make();
      await db.setVar('g1', 'user', '100', 'points', 7);
      await db.setVar('g1', 'user', '200', 'points', 12);
      await db.setVar('g1', 'user', '300', 'points', '9');
      await db.setVar('g1', 'user', '300', 'coins', 999);
      await db.setVar('g1', 'channel', '200', 'points', 500);
      await db.setVar('g1', 'guild', '', 'points', 500);
      await db.setVar('g2', 'user', '900', 'points', 1000);
      const board = await db.rankVars('g1', 'user', 'points', { limit: 2, id: '100' });
      assert.deepEqual(board.entries, [{ rank: 1, id: '200', value: 12 }, { rank: 2, id: '300', value: 9 }]);
      assert.deepEqual([board.total, board.rank, board.value], [3, 3, 7], 'other variables, other scopes and other servers are left out');
      assert.deepEqual(await db.rankVars('g3', 'user', 'points'), { entries: [], total: 0, rank: null, value: null });
    });
  }
});

describe('the Leaderboard node', () => {
  let db; let runtime; let guild; let channel; let user; let member;
  const install = (graph) => { db.createFlow({ guildId: guild.id, name: 'Board', graph }); runtime.loadGuild(guild.id); };
  const run = async (commandName = 'cmd', as = { user, member }) => {
    const i = fakeCommand({ guild, channel, user: as.user, member: as.member, commandName });
    await runtime.handleInteraction(i);
    return i;
  };
  const said = (i) => i.calls.find((c) => c[0] === 'reply')?.[1].content;
  const board = (data, reply) => commandFlow(
    [node('b', 'data.leaderboard', { name: 'points', ...data }), node('r', 'action.message.send', { target: 'reply', content: reply }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })],
    [edge('t', 'b'), edge('b', 'r'), edge('b', 'e', 'error')],
  );

  beforeEach(() => {
    resetLimits();
    db = new Database(':memory:');
    runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
    guild = fakeGuild({ id: '111111' });
    channel = guild.addChannel({ name: 'general' });
    user = fakeUser({ id: '222222', username: 'mia' });
    member = guild.addMember({ user });
    runtime.attachClient(guild.client);
    guild.addMember({ user: fakeUser({ id: '333333', username: 'bo' }) }).displayName = 'Bo the Great';
    db.setVar(guild.id, 'user', '222222', 'points', 1500);
    db.setVar(guild.id, 'user', '333333', 'points', 2750);
    db.setVar(guild.id, 'user', '444444', 'points', 40); // someone who left the server
  });

  it('lists the top places with the default line, and the totals', async () => {
    install(board({}, '{{leaderboard.text}}\n{{leaderboard.count}} of {{leaderboard.total}}'));
    assert.equal(said(await run()), '**1.** <@333333> — 2,750\n**2.** <@222222> — 1,500\n**3.** <@444444> — 40\n3 of 3');
  });

  it('fills in your own line for every place: rank, name, id, value — with filters', async () => {
    install(board({ format: '#{{entry.rank}} {{entry.name | upper}} ({{entry.id}}): {{entry.value | div:1000 | fixed:1}}k — asked by {{user.name}}' }, '{{leaderboard.text}}'));
    assert.equal(said(await run()), '#1 BO THE GREAT (333333): 2.8k — asked by mia\n#2 MIA (222222): 1.5k — asked by mia\n#3 UNKNOWN MEMBER (444444): 0.0k — asked by mia');
  });

  it('respects how many places and the order', async () => {
    install(board({ limit: 2, order: 'asc' }, '{{leaderboard.text}}'));
    assert.equal(said(await run()), '**1.** <@444444> — 40\n**2.** <@222222> — 1,500');
  });

  it('never lists more than 25 places, and an empty count means 10', async () => {
    for (let i = 0; i < 40; i += 1) db.setVar(guild.id, 'user', String(5_000_000 + i), 'points', i);
    install(board({ limit: 500 }, '{{leaderboard.count}}'));
    assert.equal(said(await run()), '25');
  });

  it('says where the person who asked stands, and who is first', async () => {
    install(board({ limit: 1 }, 'You are #{{leaderboard.rank}} with {{leaderboard.value | commas}}. First: {{leaderboard.top.mention}} ({{leaderboard.top.value}})'));
    assert.equal(said(await run()), 'You are #2 with 1,500. First: <@333333> (2750)');
  });

  it('looks up someone else when a member is filled in, and leaves the place blank for someone with no value', async () => {
    install(board({ targetId: '<@444444>' }, 'place {{leaderboard.rank}} value {{leaderboard.value}}'));
    assert.equal(said(await run()), 'place 3 value 40');
    const newbie = fakeUser({ id: '555555', username: 'newbie' });
    db.createFlow({ guildId: guild.id, name: 'Mine', graph: commandFlow([node('b', 'data.leaderboard', { name: 'points' }), node('r', 'action.message.send', { target: 'reply', content: 'place [{{leaderboard.rank | default:none}}]' })], [edge('t', 'b'), edge('b', 'r')], 'mine') });
    runtime.loadGuild(guild.id);
    assert.equal(said(await run('mine', { user: newbie, member: guild.addMember({ user: newbie }) })), 'place [none]');
  });

  it('shows the “nobody yet” text when nobody has a number', async () => {
    install(board({ name: 'gems' }, '{{leaderboard.text}} ({{leaderboard.count}}/{{leaderboard.total}}) first=[{{leaderboard.top.mention}}]'));
    assert.equal(said(await run()), 'Nobody is on the board yet. (0/0) first=[]');
  });

  it('ranks only this server', async () => {
    db.setVar('999999', 'user', '888888', 'points', 1_000_000);
    install(board({ limit: 1 }, '{{leaderboard.top.id}}'));
    assert.equal(said(await run()), '333333');
  });

  it('a member’s name is never read as a template', async () => {
    guild.members.cache.get('333333').displayName = '{{guild.vars.secret}}';
    db.setVar(guild.id, 'guild', '', 'secret', 'hunter2');
    install(board({ limit: 1, format: '{{entry.name}}' }, '{{leaderboard.text}}'));
    assert.equal(said(await run()), '{{guild.vars.secret}}');
  });

  it('follows On error when the count is not a number', async () => {
    install(board({ limit: 'many' }, 'ok'));
    assert.match(said(await run()), /^failed: .*not a number/);
  });

  it('offers its variables to the nodes after it, and needs a variable name', () => {
    const g = board({}, 'x');
    const paths = availableVariables(g.nodes, g.edges, 'r').map((v) => v.path);
    for (const p of ['leaderboard.text', 'leaderboard.rank', 'leaderboard.value', 'leaderboard.total', 'leaderboard.top.mention']) assert.ok(paths.includes(p), p);
    const problems = (data) => validateFlow(normalizeGraph(commandFlow([node('b', 'data.leaderboard', data)], [edge('t', 'b')]))).filter((i) => i.nodeId === 'b').map((i) => i.message);
    assert.deepEqual(problems({ name: 'points' }), []);
    assert.ok(problems({ name: '' }).some((m) => /required/.test(m)));
    assert.ok(problems({ name: 'my points' }).some((m) => /letters, numbers/.test(m)));
    assert.ok(problems({ name: 'points', limit: 99 }).some((m) => /between 1 and 25/.test(m)));
    assert.equal(defaultsFor('data.leaderboard').limit, 10);
  });
});

describe('the “Levels and leaderboard” template', () => {
  it('is valid and uses the leaderboard for /rank and /leaderboard', () => {
    const t = TEMPLATES.find((x) => x.id === 'levels');
    const graph = normalizeGraph(t.build());
    const issues = validateFlow(graph, { intents: { members: true, messageContent: true } });
    assert.equal(hasStructureErrors(issues), false);
    assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
    assert.equal(graph.nodes.filter((n) => n.type === 'data.leaderboard').length, 2);
    assert.match(t.description, /Message Content/);
  });

  it('gives XP once a minute, announces a new level once, and answers /rank and /leaderboard', async () => {
    resetLimits();
    const db = new Database(':memory:');
    const runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
    const guild = fakeGuild({ id: '111111' });
    const channel = guild.addChannel({ name: 'general' });
    const user = fakeUser({ id: '222222', username: 'mia' });
    const member = guild.addMember({ user });
    runtime.attachClient(guild.client);
    db.createFlow({ guildId: guild.id, name: 'Levels', graph: TEMPLATES.find((x) => x.id === 'levels').build() });
    runtime.loadGuild(guild.id);
    const chat = () => runtime.fire('trigger.message.received', { guild, channel, user, member, message: { id: '1', content: 'hi', author: user }, info: { content: 'hi', channelId: channel.id, isBot: false } });

    db.setVar(guild.id, 'user', user.id, 'xp', 80);
    await chat();
    assert.equal(db.getVar(guild.id, 'user', user.id, 'xp'), 95);
    assert.equal(channel.sent.length, 0, 'no new level yet');
    await chat();
    assert.equal(db.getVar(guild.id, 'user', user.id, 'xp'), 95, 'a second message within the minute earns nothing');

    runtime.services.cooldowns.clear(); // a minute later
    await chat();
    assert.equal(db.getVar(guild.id, 'user', user.id, 'xp'), 110);
    assert.equal(db.getVar(guild.id, 'user', user.id, 'level'), 1);
    assert.deepEqual(channel.sent.map((m) => m.content), ['🎉 <@222222> reached **level 1**!']);
    runtime.services.cooldowns.clear();
    await chat();
    assert.equal(channel.sent.length, 1, 'the same level is not announced twice');

    db.setVar(guild.id, 'user', '333333', 'xp', 5000);
    const ask = async (commandName) => { const i = fakeCommand({ guild, channel, user, member, commandName }); await runtime.handleInteraction(i); return i.calls.find((c) => c[0] === 'reply')[1].embeds[0].data; };
    assert.equal((await ask('rank')).description, 'Level **1** · **125** XP\nPlace **#2** of 2');
    assert.equal((await ask('leaderboard')).description, '**1.** <@333333> — 5,000 XP\n**2.** <@222222> — 125 XP');
  });
});
