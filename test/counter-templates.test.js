// The two counter templates, run end to end with real member events: join → maths → rename a channel.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { Events } from 'discord.js';
import { resetLimits } from '../shared/limits.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { wireEvents } from '../server/bot/events.js';
import { Database } from '../server/db.js';
import { ChannelEdits, WINDOW_MS } from '../server/engine/channel-edits.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { fakeGuild, fakeUser } from './helpers/fakes.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('counter templates', () => {
  let db; let runtime; let client; let guild; let counter; let logger; let now; let timers; let n;
  const advance = async (ms) => { now += ms; for (const t of timers.filter((x) => !x.off && x.at <= now)) { t.off = true; await t.fn(); } };
  const edits = () => counter.calls.filter((c) => c[0] === 'edit').map((c) => c[1].name);

  beforeEach(() => {
    resetLimits();
    db = new Database(':memory:');
    logger = new Logger({ console: false });
    runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true } });
    now = 1_000_000; timers = [];
    runtime.services.channelEdits = new ChannelEdits({ now: () => now, setTimer: (fn, ms) => { const t = { fn, at: now + ms, off: false, unref() {} }; timers.push(t); return t; }, clearTimer: (t) => { t.off = true; } });
    client = new EventEmitter();
    client.user = { id: 'BOT', username: 'flowbot' };
    guild = fakeGuild({ id: '111111' });
    counter = guild.addChannel({ name: 'counter' });
    runtime.attachClient(client);
    wireEvents({ client, runtime, logger, sync: { sync: async () => ({}) }, auditDelayMs: 0 });
    guild.fetchAuditLogs = async () => ({ entries: new Map() });
    n = 0;
  });

  const template = (id) => TEMPLATES.find((t) => t.id === id).build();
  const install = (id) => {
    const t = template(id);
    t.nodes.find((x) => x.id === 'u1').data.channelId = counter.id; // the one thing the person using the template picks
    db.createFlow({ guildId: guild.id, name: id, graph: t });
    runtime.loadGuild(guild.id);
  };
  const join = async (over = {}) => {
    n += 1;
    const m = guild.addMember({ user: fakeUser({ id: `9000${n}`, username: `newbie${n}`, ...over }) });
    client.emit(Events.GuildMemberAdd, m);
    await tick();
    return m;
  };
  const leave = async (m) => { client.emit(Events.GuildMemberRemove, m); await tick(40); };

  it('are in the list, valid, and only need a channel picked', () => {
    for (const id of ['member-counter', 'join-counter']) {
      const t = template(id);
      assert.equal(hasStructureErrors(validateFlow(normalizeGraph(t), { intents: { members: true, messageContent: false } })), false, id);
      const problems = validateFlow(normalizeGraph(t), { intents: { members: true, messageContent: false } }).filter((i) => i.level === 'error');
      assert.deepEqual(problems, [], `${id} is ready to switch on`);
    }
    assert.match(TEMPLATES.find((t) => t.id === 'join-counter').description, /Math block/);
  });

  it('the Join counter counts each join in a server variable and puts the total in the channel name', async () => {
    install('join-counter');
    await join();
    assert.equal(db.getVar(guild.id, 'guild', '', 'joins'), 1);
    assert.deepEqual(edits(), ['Joined so far: 1']);
    await join();
    assert.deepEqual(edits(), ['Joined so far: 1', 'Joined so far: 2']);
  });

  it('shows big totals with commas, counting on from what was already remembered', async () => {
    db.setVar(guild.id, 'guild', '', 'joins', 1999);
    install('join-counter');
    await join();
    assert.equal(db.getVar(guild.id, 'guild', '', 'joins'), 2000);
    assert.deepEqual(edits(), ['Joined so far: 2,000']);
  });

  it('a burst of joins keeps counting, never hangs, and the channel settles on the right number', async () => {
    install('join-counter');
    for (let i = 0; i < 8; i += 1) await join();
    assert.equal(db.getVar(guild.id, 'guild', '', 'joins'), 8, 'every join was counted');
    assert.deepEqual(edits(), ['Joined so far: 1', 'Joined so far: 2'], 'only two renames were sent: Discord would refuse the rest');
    await advance(WINDOW_MS + 5000);
    assert.deepEqual(edits(), ['Joined so far: 1', 'Joined so far: 2', 'Joined so far: 8'], 'and one more with the latest total');
    assert.ok(logger.recent(guild.id).some((l) => /held back/.test(l.message)));
  });

  it('bots are not counted by the Join counter', async () => {
    install('join-counter');
    await join({ bot: true });
    assert.equal(db.getVar(guild.id, 'guild', '', 'joins'), undefined);
    assert.deepEqual(edits(), []);
  });

  it('the Member counter follows the real member count on joins and leaves, bots included', async () => {
    install('member-counter');
    guild.memberCount = 1204;
    const first = await join();
    guild.memberCount = 1205;
    await join({ bot: true });
    assert.deepEqual(edits(), ['👥 Members: 1,204', '👥 Members: 1,205'], 'a bot joining changes the count too');
    guild.memberCount = 1204;
    await leave(first);
    assert.equal(edits().length, 2, 'the third change waits for Discord…');
    await advance(WINDOW_MS + 5000);
    assert.deepEqual(edits().at(-1), '👥 Members: 1,204', '…and applies the newest count');
  });
});
