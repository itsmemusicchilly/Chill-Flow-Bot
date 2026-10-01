// Save Transcript: how the transcript reaches Discord — a link to the saved web page, the files, or both — and nodes saved before the choice existed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { defaultsFor, NODE_TYPES } from '../shared/catalog.js';
import { isVisible } from '../shared/fields.js';
import { resetLimits } from '../shared/limits.js';
import { TEMPLATES } from '../shared/templates.js';
import { upgradeNodeData } from '../shared/upgrade.js';
import { normalizeGraph } from '../shared/validate.js';
import { Database } from '../server/db.js';
import { transcriptExecutors } from '../server/engine/executors/transcript.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { createTranscripts } from '../server/transcripts.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

const PUBLIC = 'https://bot.example.com';
const INTENTS = { members: true, messageContent: true };
let db; let logger; let runtime; let store; let dataDir; let guild; let channel; let logCh; let user; let member;

function useRuntime(transcripts) {
  runtime = new Runtime({ db, logger, intents: INTENTS, transcripts });
  runtime.attachClient(guild.client);
}
const storeFor = (over = {}) => createTranscripts({ config: { baseUrl: PUBLIC, dataDir, transcriptRetentionDays: 0, ...over }, db, logger });

beforeEach(() => {
  resetLimits();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowbot-delivery-'));
  db = new Database(':memory:');
  logger = new Logger({ console: false });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'general' });
  logCh = guild.addChannel({ name: 'ticket-log' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  store = storeFor();
  useRuntime(store);
  channel.addMessage({ content: 'hello there', author: { id: '222222', username: 'mia', bot: false } });
});
afterEach(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const install = (over, extra = []) => {
  db.createFlow({
    guildId: guild.id, name: 'Test flow',
    graph: commandFlow([
      node('ts', 'action.channel.transcript', { sendChannelId: logCh.id, ...over }),
      node('ok', 'action.message.send', { target: 'reply', content: 'url=[{{transcript.url}}] expires=[{{transcript.expires}}] dm={{transcript.dm}}' }),
      node('bad', 'action.message.send', { target: 'reply', content: 'FAILED {{error.message}}' }),
      ...extra,
    ], [edge('t', 'ts'), edge('ts', 'ok'), edge('ts', 'bad', 'error')]),
  });
  runtime.loadGuild(guild.id);
};
const run = async () => {
  const i = fakeCommand({ guild, channel, user, member, commandName: 'cmd', options: [] });
  await runtime.handleInteraction(i);
  return i;
};
const said = (i) => i.calls.find((c) => c[0] === 'reply' || c[0] === 'editReply')[1].content;
const logs = () => runtime.logger.recent(guild.id).map((l) => `${l.level}: ${l.message}`);
const button = (payload) => { const row = payload.components?.[0]?.toJSON(); return row && JSON.parse(JSON.stringify(row)).components[0]; }; // as it goes over the wire
const stored = () => db.transcriptsBefore(Infinity);

describe('Save Transcript — as a link', () => {
  it('posts a button that opens the saved page, and no files', async () => {
    install({ delivery: 'link', channelMessage: 'Transcript of #{{channel.name}}' });
    const i = await run();
    assert.match(said(i), /^url=\[https:\/\/bot\.example\.com\/t\/[a-z0-9]{32}\] expires=\[\] dm=skipped$/);
    const [row] = stored();
    const sent = logCh.sent[0];
    assert.equal(logCh.sent.length, 1);
    assert.equal(sent.content, 'Transcript of #general');
    assert.equal(sent.files, undefined, 'no files in link-only mode');
    assert.deepEqual(button(sent), { type: 2, style: 5, label: 'Open transcript', url: `${PUBLIC}/t/${row.id}` });
    assert.deepEqual(sent.allowedMentions, { parse: [] });
    assert.equal(channel.sent.length, 0);
  });

  it('what the link opens is the transcript page itself', async () => {
    install({ delivery: 'link' });
    await run();
    const [row] = stored();
    const page = fs.readFileSync(store.fileFor(guild.id, row.id), 'utf8');
    assert.match(page, /hello there/);
    assert.match(page, /Channel: #general/);
    assert.equal(row.guildId, guild.id);
    assert.equal(row.messages, 1);
  });

  it('puts the same button in the direct message', async () => {
    const opener = guild.addMember({ user: fakeUser({ id: '700010', username: 'tess' }) });
    channel.addMessage({ content: 'hi', author: { id: '700010', username: 'tess', bot: false } });
    install({ delivery: 'link', sendUserId: opener.id, dmMessage: 'Your copy' });
    assert.match(said(await run()), /dm=sent/);
    const [, dm] = opener.calls.find((c) => c[0] === 'dm');
    assert.equal(dm.content, 'Your copy');
    assert.equal(dm.files, undefined);
    assert.equal(button(dm).url, button(logCh.sent[0]).url);
    assert.equal(stored().length, 1, 'one page serves both messages');
  });

  it('works with no text at all: the button alone is the message', async () => {
    install({ delivery: 'link', channelMessage: '' });
    await run();
    assert.equal(logCh.sent[0].content, undefined);
    assert.ok(button(logCh.sent[0]));
  });

  it('tells later nodes when the link stops working (blank when pages are kept forever)', async () => {
    store = storeFor({ transcriptRetentionDays: 30 });
    useRuntime(store);
    install({ delivery: 'link' });
    const i = await run();
    const [row] = stored();
    assert.equal(said(i).match(/expires=\[([^\]]*)\]/)[1], new Date(row.createdAt + 30 * 86_400_000).toISOString());
  });

  it('refuses before reading the channel when nobody could open the link', async () => {
    useRuntime(storeFor({ baseUrl: 'http://localhost:3000' }));
    let fetched = 0;
    const fetch = channel.messages.fetch;
    channel.messages.fetch = (...a) => { fetched += 1; return fetch(...a); };
    install({ delivery: 'link' });
    const i = await run();
    assert.match(said(i), /^FAILED A transcript link needs BASE_URL to be a public address/);
    assert.equal(fetched, 0, 'the channel was not even read');
    assert.equal(logCh.sent.length, 0);
    assert.equal(stored().length, 0);
  });

  it('follows the error output on a bare runtime that has no transcript pages', async () => {
    useRuntime(undefined);
    install({ delivery: 'link' });
    assert.equal(said(await run()), 'FAILED Transcript links are not available here.');
    assert.equal(logCh.sent.length, 0);
  });

  it('removes the saved page again when the message that was to carry the link cannot be posted', async () => {
    logCh.send = async () => { throw new Error('Missing Permissions'); };
    install({ delivery: 'link' });
    assert.match(said(await run()), /^FAILED .*Missing Permissions/);
    assert.equal(stored().length, 0, 'no row');
    assert.deepEqual(fs.existsSync(path.join(store.root, guild.id)) ? fs.readdirSync(path.join(store.root, guild.id)) : [], [], 'and no file');
  });

  it('keeps the page when only the direct message fails — the log channel has the link', async () => {
    const closed = guild.addMember({ user: fakeUser({ id: '700020', username: 'zed' }) });
    closed.send = async () => { throw new Error('Cannot send messages to this user'); };
    install({ delivery: 'link', sendUserId: closed.id });
    assert.match(said(await run()), /dm=failed/);
    assert.equal(stored().length, 1);
    assert.ok(button(logCh.sent[0]));
  });
});

describe('Save Transcript — as files (what it always did)', () => {
  it('attaches the .html and the .txt, with no button and no page saved', async () => {
    install({ delivery: 'files' });
    const i = await run();
    assert.equal(said(i), 'url=[] expires=[] dm=skipped');
    assert.deepEqual(logCh.sent[0].files.map((f) => f.name.split('.').pop()), ['html', 'txt']);
    assert.equal(logCh.sent[0].components, undefined);
    assert.equal(stored().length, 0, 'nothing is stored on the server');
  });

  it('a node saved before there was a choice (no delivery at all) still attaches the files, even where links are possible', async () => {
    install({ delivery: undefined });
    assert.equal(said(await run()), 'url=[] expires=[] dm=skipped');
    assert.deepEqual(logCh.sent[0].files.map((f) => f.name.split('.').pop()), ['html', 'txt']);
    assert.equal(logCh.sent[0].components, undefined);
    assert.equal(stored().length, 0);
  });

  it('treats a missing choice as files even if nothing upgraded the node first — the executor is the last line of defence', async () => {
    const ctx = { guild, channel, data: {}, aborted: false, logMeta: {}, services: { logger, intents: INTENTS, transcripts: store } };
    await transcriptExecutors['action.channel.transcript']({ ctx, d: { channelId: '', sendChannelId: logCh.id, channelMessage: 'x' } });
    assert.deepEqual(logCh.sent[0].files.map((f) => f.name.split('.').pop()), ['html', 'txt']);
    assert.equal(logCh.sent[0].components, undefined);
    assert.equal(stored().length, 0);
    assert.equal(ctx.data.transcript.url, '');
  });

  it('does not need the server to have a transcript store, or a public address', async () => {
    useRuntime(undefined);
    install({ delivery: 'files' });
    assert.match(said(await run()), /^url=\[\]/);
    assert.equal(logCh.sent[0].files.length, 2);
  });

  it('refuses a way of sending it that it does not know', async () => {
    install({ delivery: 'carrier-pigeon' });
    assert.equal(said(await run()), 'FAILED Unknown way to send the transcript: “carrier-pigeon”.');
    assert.equal(logCh.sent.length, 0);
  });
});

describe('Save Transcript — both', () => {
  it('attaches the files and adds the button', async () => {
    install({ delivery: 'both' });
    const i = await run();
    assert.match(said(i), /^url=\[https:\/\/bot\.example\.com\/t\/[a-z0-9]{32}\]/);
    assert.deepEqual(logCh.sent[0].files.map((f) => f.name.split('.').pop()), ['html', 'txt']);
    assert.equal(button(logCh.sent[0]).url, `${PUBLIC}/t/${stored()[0].id}`);
  });

  it('“Leave out the plain-text copy” still applies to the files', async () => {
    install({ delivery: 'both', skipText: true });
    await run();
    assert.deepEqual(logCh.sent[0].files.map((f) => f.name.split('.').pop()), ['html']);
  });

  it('sends just the files, and says why in the log, when the server has no public address — the node still succeeds', async () => {
    useRuntime(storeFor({ baseUrl: 'http://localhost:3000' }));
    install({ delivery: 'both' });
    assert.equal(said(await run()), 'url=[] expires=[] dm=skipped');
    assert.equal(logCh.sent[0].files.length, 2);
    assert.equal(logCh.sent[0].components, undefined);
    assert.ok(logs().some((l) => /^warn: The transcript has no link, so only the files were attached: A transcript link needs BASE_URL/.test(l)), logs().join('\n'));
  });

  it('sends just the files when the page cannot be stored, and on a bare runtime', async () => {
    useRuntime({ publicBase: true, assertPublic() {}, save() { throw new Error('disk exploded'); }, remove() {} });
    install({ delivery: 'both' });
    assert.match(said(await run()), /^url=\[\]/);
    assert.equal(logCh.sent[0].files.length, 2);
    assert.ok(logs().some((l) => /only the files were attached: disk exploded/.test(l)), logs().join('\n'));

    logCh.sent.length = 0;
    useRuntime(undefined);
    runtime.loadGuild(guild.id);
    assert.match(said(await run()), /^url=\[\]/);
    assert.equal(logCh.sent[0].files.length, 2);
  });

  it('still removes the page when the log message cannot be posted', async () => {
    logCh.send = async () => { throw new Error('Missing Permissions'); };
    install({ delivery: 'both' });
    assert.match(said(await run()), /^FAILED/);
    assert.equal(stored().length, 0);
  });
});

describe('Save Transcript — the node, old and new', () => {
  it('a new node starts as a link', () => {
    assert.equal(defaultsFor('action.channel.transcript').delivery, 'link');
  });

  it('a stored node without the choice is rewritten as “files” when saved or opened — once', () => {
    const old = { sendChannelId: '123456', skipText: true };
    const once = upgradeNodeData('action.channel.transcript', old);
    assert.equal(once.delivery, 'files');
    assert.equal(once.skipText, true, 'nothing else changes');
    assert.equal(upgradeNodeData('action.channel.transcript', once), once, 'a second pass returns the very same object');
    assert.equal(old.delivery, undefined, 'the stored object itself is not touched');
    for (const chosen of ['link', 'files', 'both']) {
      const d = { delivery: chosen };
      assert.equal(upgradeNodeData('action.channel.transcript', d), d, chosen);
    }
    assert.equal(upgradeNodeData('action.channel.transcript', null), null);
  });

  it('is applied by normalizeGraph, and still upgrades message nodes there', () => {
    const g = normalizeGraph({ nodes: [
      { id: 'a', type: 'action.channel.transcript', position: { x: 0, y: 0 }, data: { sendChannelId: '123456' } },
      { id: 'b', type: 'action.channel.transcript', position: { x: 0, y: 0 }, data: { sendChannelId: '123456', delivery: 'link' } },
      { id: 'c', type: 'action.message.send', position: { x: 0, y: 0 }, data: { useEmbed: true, embedTitle: 'Hi' } },
    ], edges: [] });
    assert.equal(g.nodes[0].data.delivery, 'files');
    assert.equal(g.nodes[1].data.delivery, 'link');
    assert.equal(g.nodes[2].data.embeds[0].title, 'Hi');
  });

  it('hides “Leave out the plain-text copy” when there are no files', () => {
    const field = NODE_TYPES['action.channel.transcript'].fields.find((f) => f.key === 'skipText');
    assert.equal(isVisible(field, { delivery: 'link' }), false);
    assert.equal(isVisible(field, { delivery: 'files' }), true);
    assert.equal(isVisible(field, { delivery: 'both' }), true);
    assert.equal(isVisible(field, {}), true, 'a node that never chose is a files node');
  });

  it('offers the link and its end time to later nodes', () => {
    const paths = NODE_TYPES['action.channel.transcript'].provides({}).map((p) => p[0]);
    assert.ok(paths.includes('transcript.url') && paths.includes('transcript.expires'));
  });

  it('says how it sends in the node summary', () => {
    const { summary } = NODE_TYPES['action.channel.transcript'];
    assert.equal(summary({ sendChannelId: '1', delivery: 'link' }), '→ 1 · link');
    assert.equal(summary({ sendChannelId: '1', delivery: 'both', sendUserId: '2' }), '→ 1 + DM · link + files');
    assert.equal(summary({ sendChannelId: '1', delivery: 'files' }), '→ 1');
    assert.equal(summary({}), 'choose a log channel');
  });

  it('the ticket templates send both, so they close tickets whether or not the server has a public address', () => {
    const nodes = TEMPLATES.flatMap((t) => t.build().nodes).filter((n) => n.type === 'action.channel.transcript');
    assert.equal(nodes.length, 2);
    for (const n of nodes) assert.equal(n.data.delivery, 'both');
  });
});
