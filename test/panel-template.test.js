// The "Panel that comes back if it is deleted" starter flow: Manual → post + remember the message ID in a channel variable,
// and Message Deleted → if it was that message, post it again and remember the new one.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { Events } from 'discord.js';
import { resetLimits } from '../shared/limits.js';
import { TEMPLATES } from '../shared/templates.js';
import { hasStructureErrors, normalizeGraph, validateFlow } from '../shared/validate.js';
import { wireEvents } from '../server/bot/events.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { fakeGuild } from './helpers/fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const template = () => TEMPLATES.find((t) => t.id === 'panel-comes-back');
let db; let logger; let runtime; let client; let guild; let channel; let elsewhere; let flow;

beforeEach(() => {
  resetLimits();
  db = new Database(':memory:');
  logger = new Logger({ console: false });
  runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true } });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'info', id: '500001' });
  elsewhere = guild.addChannel({ name: 'chat', id: '500002' });
  client = new EventEmitter();
  client.user = { id: 'BOT', username: 'flowbot' };
  client.guilds = guild.client.guilds;
  runtime.attachClient(client);
  wireEvents({ client, runtime, logger, sync: { sync: async () => ({}) }, auditDelayMs: 0 });
});

/** Uses the template the way a person would: picks the channel in the Manual trigger, saves, switches on. */
const install = () => {
  const graph = template().build();
  graph.nodes.find((x) => x.id === 't1').data.channelId = channel.id;
  flow = db.createFlow({ guildId: guild.id, name: 'Panel', graph, enabled: true });
  runtime.loadGuild(guild.id);
};
const pressRun = async () => { assert.deepEqual(await runtime.runManual(guild.id, flow.id, 't1'), { ok: true }); await tick(); };
const panelId = (ch = channel) => db.getVar(guild.id, 'channel', ch.id, 'panel');
const panels = (ch = channel) => [...ch.messages.store.values()].filter((m) => m.embeds[0]?.title === '📌 Info');
/** Deletes a message the way Discord does: it disappears, and the gateway says so (for a message the bot had not cached, with no author). */
const deleted = async (id, ch = channel) => {
  await ch.messages.store.get(id)?.delete();
  client.emit(Events.MessageDelete, { id, guildId: guild.id, guild, channel: ch, channelId: ch.id });
  await tick();
};
const problems = () => logger.recent(guild.id).filter((l) => l.level === 'error').map((l) => l.message);

describe('the panel that comes back starter flow', () => {
  it('is offered, described, and has nothing left to fix once the channel is picked', () => {
    const t = template();
    assert.ok(t.name.length > 3 && t.description.length > 60);
    assert.match(t.description, /Manual trigger/);
    const graph = t.build();
    assert.equal(hasStructureErrors(validateFlow(normalizeGraph(graph))), false, 'it can be saved as it is');
    graph.nodes.find((x) => x.id === 't1').data.channelId = channel.id;
    const errors = validateFlow(normalizeGraph(graph), { intents: { members: true, messageContent: true } }).filter((i) => i.level === 'error');
    assert.deepEqual(errors, []);
  });

  it('▶ Run posts the panel and remembers its message for that channel only', async () => {
    install();
    await pressRun();
    assert.equal(panels().length, 1);
    assert.equal(panelId(), panels()[0].id);
    assert.equal(panelId(elsewhere), undefined);
    assert.deepEqual(problems(), []);
  });

  it('posts the panel again when it is deleted, and remembers the new message', async () => {
    install();
    await pressRun();
    const first = panelId();
    await deleted(first);
    assert.equal(panels().length, 1, 'one panel again, not two');
    assert.notEqual(panelId(), first, 'the new message is the one remembered');
    assert.equal(panelId(), panels()[0].id);
    const second = panelId();
    await deleted(second);
    assert.equal(panels().length, 1, 'and again the next time');
    assert.notEqual(panelId(), second);
    assert.equal(panelId(), panels()[0].id);
    assert.deepEqual(problems(), []);
  });

  it('ignores every other deleted message, in this channel and elsewhere', async () => {
    install();
    await pressRun();
    const before = panelId();
    const chatter = channel.addMessage({ content: 'just chatting' });
    await deleted(chatter.id);
    await deleted(before, elsewhere); // the same ID in another channel is not this panel
    assert.equal(panels().length, 1);
    assert.equal(panelId(), before, 'nothing was reposted');
    assert.equal(panels(elsewhere).length, 0);
    assert.deepEqual(problems(), []);
  });

  it('does nothing before a panel has ever been posted', async () => {
    install();
    const stray = channel.addMessage({ content: 'hello' });
    await deleted(stray.id);
    assert.equal(panels().length, 0);
    assert.deepEqual(db.listVars(guild.id), []);
    assert.deepEqual(problems(), []);
  });
});
