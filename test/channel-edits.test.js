// Discord allows ~2 channel name/topic changes per 10 minutes. Extra ones are held: nothing hangs, the newest value wins.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetLimits } from '../shared/limits.js';
import { Database } from '../server/db.js';
import { ChannelEdits, PER_WINDOW, WINDOW_MS } from '../server/engine/channel-edits.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

/** A clock and a set of timers we control. */
function fakeTime() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const timer = { fn, at: t + ms, off: false, unref() {} }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.off = true; },
    async advance(ms) {
      t += ms;
      for (const timer of timers.filter((x) => !x.off && x.at <= t)) { timer.off = true; await timer.fn(); }
    },
    waiting: () => timers.filter((x) => !x.off).length,
  };
}

describe('ChannelEdits', () => {
  let time; let gate; let done;
  const ask = (patch, channel = 'c1', guild = 'g1') => gate.request(guild, channel, patch, async (p) => { done.push({ channel, ...p }); }, (err) => { if (err) done.push({ failed: err.message }); });
  beforeEach(() => { time = fakeTime(); gate = new ChannelEdits(time); done = []; });

  it('lets the first changes through at once', () => {
    assert.equal(PER_WINDOW, 2);
    assert.equal(ask({ name: 'one' }), null);
    assert.equal(ask({ name: 'two' }), null);
    assert.equal(time.waiting(), 0, 'nothing is scheduled while there is budget');
  });

  it('holds the third, tells when it will be made, and makes it exactly once with the newest value', async () => {
    ask({ name: 'one' }); ask({ name: 'two' });
    const held = ask({ name: 'three' });
    assert.ok(held.at > time.now() + WINDOW_MS - 1, 'after the window has passed');
    assert.equal(time.waiting(), 1);
    assert.equal(ask({ name: 'four' }).at, held.at, 'a newer request does not move the time');
    ask({ name: 'five' });
    assert.equal(time.waiting(), 1, 'still one timer');
    assert.deepEqual(done, [], 'nothing was made yet');
    await time.advance(WINDOW_MS - 1000);
    assert.deepEqual(done, [], 'not before Discord allows it');
    await time.advance(5000);
    assert.deepEqual(done, [{ channel: 'c1', name: 'five' }], 'one change, with the newest name');
    assert.equal(time.waiting(), 0);
  });

  it('name and topic share the budget, and a held change keeps both newest values', async () => {
    ask({ name: 'a' }); ask({ topic: 'b' });
    ask({ name: 'c' });
    ask({ topic: 'd' });
    ask({ name: 'e' });
    await time.advance(WINDOW_MS + 5000);
    assert.deepEqual(done, [{ channel: 'c1', name: 'e', topic: 'd' }]);
  });

  it('counts the held change once it is made: one slot is free again, and after that it waits again', async () => {
    ask({ name: 'a' }); ask({ name: 'b' }); ask({ name: 'c' });
    await time.advance(WINDOW_MS + 2000); // the first two have aged out; the held one is made and takes one slot
    assert.equal(done.length, 1);
    assert.equal(ask({ name: 'd' }), null, 'one slot is free');
    const next = ask({ name: 'e' });
    assert.ok(next, 'and now the budget is used up again');
    assert.ok(next.wait > 0 && next.wait <= WINDOW_MS + 1000);
    await time.advance(WINDOW_MS + 2000);
    assert.equal(done.at(-1).name, 'e');
  });

  it('gets its budget back as changes age out', async () => {
    ask({ name: 'a' });
    await time.advance(5 * 60_000);
    ask({ name: 'b' });
    await time.advance(5 * 60_000 + 1000); // the first one is now more than 10 minutes old
    assert.equal(ask({ name: 'c' }), null);
  });

  it('keeps every channel and server on its own budget', () => {
    ask({ name: 'a' }); ask({ name: 'b' });
    assert.notEqual(ask({ name: 'c' }), null, 'this channel is used up');
    assert.equal(ask({ name: 'x' }, 'c2'), null, 'another channel is not');
    assert.equal(ask({ name: 'y' }, 'c1', 'g2'), null, 'nor is the same channel id in another server');
  });

  it('reports how a held change ended, and a failure does not break anything', async () => {
    gate.request('g1', 'c9', { name: 'a' }, async () => {}); gate.request('g1', 'c9', { name: 'b' }, async () => {});
    const outcomes = [];
    gate.request('g1', 'c9', { name: 'c' }, async () => { throw new Error('Missing Access'); }, (err) => outcomes.push(err?.message ?? 'ok'));
    await time.advance(WINDOW_MS + 2000);
    assert.deepEqual(outcomes, ['Missing Access']);
  });

  it('forgets what is waiting when a server is unloaded (or everything at shutdown)', async () => {
    ask({ name: 'a' }); ask({ name: 'b' }); ask({ name: 'c' });
    ask({ name: 'a' }, 'c2', 'g2'); ask({ name: 'b' }, 'c2', 'g2'); ask({ name: 'c' }, 'c2', 'g2');
    assert.equal(time.waiting(), 2);
    gate.cancel('g1');
    assert.equal(time.waiting(), 1);
    await time.advance(WINDOW_MS + 5000);
    assert.deepEqual(done.map((d) => d.channel), ['c2'], 'only the other server\'s change was made');
    ask({ name: 'a' }); ask({ name: 'b' }); ask({ name: 'c' });
    gate.cancel();
    assert.equal(time.waiting(), 0);
  });
});

describe('renaming a channel from a flow', () => {
  let db; let runtime; let guild; let channel; let user; let member; let time; let selfMarks;
  beforeEach(() => {
    resetLimits();
    db = new Database(':memory:');
    runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true } });
    time = fakeTime();
    runtime.services.channelEdits = new ChannelEdits(time);
    guild = fakeGuild({ id: '111111' });
    channel = guild.addChannel({ name: 'counter' });
    user = fakeUser({ id: '222222', username: 'mia' });
    member = guild.addMember({ user });
    runtime.attachClient(guild.client);
    selfMarks = () => runtime.services.selfActions.peek(`channelUpdate:${channel.id}`);
  });

  /** /go → count one more → rename #counter → reply "done". */
  const install = (updateData = {}) => {
    db.createFlow({
      guildId: guild.id, name: 'Counter',
      graph: commandFlow(
        [node('v', 'data.variable.set', { scope: 'guild', name: 'n', operation: 'add', value: '1' }),
          node('u', 'action.channel.update', { channelId: channel.id, name: 'Members: {{guild.vars.n}}', ...updateData }),
          node('r', 'action.message.send', { target: 'reply', content: 'done' })],
        [edge('t', 'v'), edge('v', 'u'), edge('u', 'r')], 'go',
      ),
    });
    runtime.loadGuild(guild.id);
  };
  const go = async () => {
    const i = fakeCommand({ guild, channel, user, member, commandName: 'go' });
    await runtime.handleInteraction(i);
    return i;
  };
  const edits = () => channel.calls.filter((c) => c[0] === 'edit').map((c) => c[1]);
  const logs = () => runtime.logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);

  it('the first two members rename the channel at once, exactly as before', async () => {
    install();
    assert.equal((await go()).calls.at(-1)[1].content, 'done');
    assert.equal((await go()).calls.at(-1)[1].content, 'done');
    assert.deepEqual(edits().map((e) => e.name), ['Members: 1', 'Members: 2']);
    assert.equal(logs().some((l) => /held back/.test(l)), false);
  });

  it('a burst of joins does not hang: every run finishes, and the channel ends up with the newest count', async () => {
    install();
    for (let i = 0; i < 6; i += 1) assert.equal((await go()).calls.at(-1)[1].content, 'done', `run ${i + 1} finished`);
    assert.deepEqual(edits().map((e) => e.name), ['Members: 1', 'Members: 2'], 'only two changes were sent so far');
    assert.equal(db.getVar(guild.id, 'guild', '', 'n'), 6, 'the counting itself never stops');
    assert.ok(logs().some((l) => /info: Discord allows only two name\/topic changes per channel every 10 minutes, so this change to #counter is held back; the newest one is applied in about 10 minutes/.test(l)));
    await time.advance(WINDOW_MS + 5000);
    assert.deepEqual(edits().map((e) => e.name), ['Members: 1', 'Members: 2', 'Members: 6'], 'one more change, with the newest count');
    assert.ok(logs().some((l) => /info: The held change to #counter was made/.test(l)));
  });

  it('marks the bot\'s own change when it is really sent, so it never reads as someone else\'s', async () => {
    install();
    for (let i = 0; i < 3; i += 1) await go();
    runtime.services.selfActions.map.clear(); // forget the marks of the two immediate changes
    assert.equal(selfMarks(), false, 'a held change has not been sent, so nothing is marked yet');
    await time.advance(WINDOW_MS + 5000);
    assert.equal(selfMarks(), true, 'marked at the moment it is sent');
  });

  it('other settings are never held back', async () => {
    install({ name: '', slowmode: 30 });
    for (let i = 0; i < 4; i += 1) await go();
    assert.equal(edits().length, 4);
    assert.ok(edits().every((e) => e.rateLimitPerUser === 30));
  });

  it('when only some of a change is limited, the rest goes at once', async () => {
    install();
    await go(); await go();
    const flow = db.listFlows(guild.id)[0];
    db.updateFlow(guild.id, flow.id, { graph: { ...flow.graph, nodes: flow.graph.nodes.map((n) => (n.id === 'u' ? { ...n, data: { ...n.data, slowmode: 5 } } : n)) } });
    runtime.loadGuild(guild.id);
    await go();
    const third = edits()[2];
    assert.deepEqual(third, { rateLimitPerUser: 5, reason: third.reason }, 'the slowmode was set, the name is being held');
  });

  it('a held change that cannot be made is written to the server\'s log', async () => {
    install();
    for (let i = 0; i < 3; i += 1) await go();
    channel.edit = async () => { throw new Error('Missing Permissions'); };
    await time.advance(WINDOW_MS + 5000);
    assert.ok(logs().some((l) => /warn: The held change to #counter could not be made: Missing Permissions/.test(l)));
  });

  it('unloading the server drops what is waiting', async () => {
    install();
    for (let i = 0; i < 3; i += 1) await go();
    runtime.unloadGuild(guild.id);
    await time.advance(WINDOW_MS + 5000);
    assert.equal(edits().length, 2);
  });
});
