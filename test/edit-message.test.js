// Edit Message in "full edit mode": the text and the embeds can each be kept, replaced or removed, and one embed can have just some parts changed.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { blankEmbed } from '../shared/embeds.js';
import { resetLimits } from '../shared/limits.js';
import { buildButtonId } from '../server/engine/custom-id.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeComponent, fakeGuild, fakeUser, node } from './helpers/fakes.js';

let db; let runtime; let guild; let channel; let user; let member;
const uploads = { publicUrl: (guildId, ref) => `https://bot.example/i/${guildId}/${ref.slice(7)}` };

beforeEach(() => {
  resetLimits();
  db = new Database(':memory:');
  runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true }, uploads });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'general', id: '500001' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  runtime.attachClient(guild.client);
});

const install = (graph) => {
  db.createFlow({ guildId: guild.id, name: 'Test flow', graph, enabled: true });
  runtime.loadGuild(guild.id);
};
const run = async () => runtime.handleInteraction(fakeCommand({ guild, channel, user, member, commandName: 'cmd', options: [] }));
const click = (customId, messageId) => runtime.handleInteraction(fakeComponent({ guild, channel, user, member, customId, messageId }));
const plain = (x) => JSON.parse(JSON.stringify(x));
const edits = () => channel.calls.filter((c) => c[0] === 'messageEdit');
const oops = () => channel.sent.map((p) => p.content).filter((c) => String(c).startsWith('oops'));

/** An embed as Discord's API holds it, with every part filled in. */
const rich = (o = {}) => ({
  title: 'Old title', description: 'Old body', color: 0x5865f2,
  author: { name: 'Team', url: 'https://x.example/team', icon_url: 'https://x.example/a.png' },
  thumbnail: { url: 'https://x.example/t.png' }, image: { url: 'https://x.example/i.png' },
  footer: { text: 'Old footer', icon_url: 'https://x.example/f.png' },
  fields: [{ name: 'A', value: '1', inline: true }, { name: 'B', value: '2', inline: false }], ...o,
});
const button = { type: 1, components: [{ type: 2, style: 1, label: 'Keep me', custom_id: 'fcb:keep:' }] };
const post = (embeds, over = {}) => channel.addMessage({ content: 'Original text', author: { id: 'BOT', username: 'flowbot', bot: true }, embeds, ...over });

/** Edit Message after the command; when it fails, the reason is posted to the channel. */
const edit = (data, extra = []) => install(commandFlow(
  [node('b', 'action.message.edit', { messageFrom: 'id', ...data }),
    node('e', 'action.message.send', { target: 'channel', channelId: channel.id, content: 'oops: {{error.message}}' }), ...extra],
  [edge('t', 'b'), edge('b', 'e', 'error')],
));
const patch = (msg, patchSet = [], patchRemove = [], more = {}) => edit({ messageId: msg.id, contentMode: 'keep', embedsMode: 'patch', patchSet, patchRemove, ...more });
const set = (part, extra = {}) => ({ id: part, part, text: '', color: '#5865f2', image: '', fields: [], ...extra });

describe('the text', () => {
  it('can be replaced while the embeds stay, and only the text is sent', async () => {
    const msg = post([rich()]);
    edit({ messageId: msg.id, contentMode: 'replace', content: 'New for {{user.name}}', embedsMode: 'keep' });
    await run();
    assert.equal(msg.content, 'New for mia');
    assert.deepEqual(msg.embeds, [rich()]);
    assert.deepEqual(Object.keys(edits()[0][2]).sort(), ['allowedMentions', 'content']);
    assert.deepEqual(oops(), []);
  });

  it('can be removed while the embeds stay', async () => {
    const msg = post([rich()]);
    edit({ messageId: msg.id, contentMode: 'remove', embedsMode: 'keep' });
    await run();
    assert.equal(msg.content, '');
    assert.deepEqual(msg.embeds, [rich()]);
  });

  it('cannot be removed from a message that would be left with nothing — unless it still has buttons', async () => {
    const bare = post([]);
    edit({ messageId: bare.id, contentMode: 'remove', embedsMode: 'keep' });
    await run();
    assert.equal(edits().length, 0);
    assert.match(oops()[0], /would leave the message empty/);
    assert.equal(bare.content, 'Original text');

    channel.sent.length = 0;
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    const withButton = post([], { components: [button] });
    edit({ messageId: withButton.id, contentMode: 'remove', embedsMode: 'keep' });
    await run();
    assert.equal(withButton.content, '');
    assert.deepEqual(oops(), []);
  });

  it('with the text and the embeds both kept, nothing is sent at all', async () => {
    const msg = post([rich()]);
    edit({ messageId: msg.id, contentMode: 'keep', embedsMode: 'keep' });
    await run();
    assert.equal(edits().length, 0);
    assert.deepEqual(oops(), []);
  });
});

describe('the embeds as a whole', () => {
  it('can be removed, and the text stays', async () => {
    const msg = post([rich(), rich({ title: 'Second' })]);
    edit({ messageId: msg.id, contentMode: 'keep', embedsMode: 'remove' });
    await run();
    assert.deepEqual(msg.embeds, []);
    assert.equal(msg.content, 'Original text');
    assert.deepEqual(edits()[0][2].embeds, []);
    assert.ok(!('content' in edits()[0][2]));
  });

  it('can be replaced by any number of new ones', async () => {
    const msg = post([rich()]);
    edit({ messageId: msg.id, contentMode: 'keep', embedsMode: 'replace', embeds: [{ ...blankEmbed(), title: 'N1', authorName: 'Me' }, { ...blankEmbed(), description: 'N2 for {{user.name}}' }] });
    await run();
    assert.equal(msg.embeds.length, 2);
    assert.equal(msg.embeds[0].title, 'N1');
    assert.equal(msg.embeds[0].author.name, 'Me');
    assert.equal(msg.embeds[1].description, 'N2 for mia');
    assert.equal(msg.content, 'Original text');
  });

  it('“replace” with an empty list takes them all off', async () => {
    const msg = post([rich()]);
    edit({ messageId: msg.id, contentMode: 'keep', embedsMode: 'replace', embeds: [] });
    await run();
    assert.deepEqual(msg.embeds, []);
  });
});

describe('changing some parts of one embed', () => {
  it('changes only what is named — the other parts and the text come back exactly as they were', async () => {
    const msg = post([rich()]);
    patch(msg, [set('description', { text: 'New body for {{user.name}}' })]);
    await run();
    assert.deepEqual(plain(msg.embeds), [rich({ description: 'New body for mia' })]);
    assert.equal(msg.content, 'Original text');
    assert.deepEqual(oops(), []);
  });

  it('leaves the other embeds of the message exactly as they were', async () => {
    const other = rich({ title: 'The other one' });
    delete other.fields; // (an empty list of fields is the same as none, and is sent back as none)
    const msg = post([rich(), other]);
    patch(msg, [set('title', { text: 'Changed' })], [], { patchEmbed: 2 });
    await run();
    assert.deepEqual(plain(msg.embeds), [rich(), { ...other, title: 'Changed' }]);
  });

  it('removes parts, then sets the ones listed (so a removed part can be set again)', async () => {
    const msg = post([rich()]);
    patch(msg, [set('authorName', { text: 'New author' })], ['authorName', 'footer', 'image']);
    await run();
    const [e] = plain(msg.embeds);
    assert.deepEqual(e.author, { name: 'New author' }, 'the old author link and icon went with the old author');
    assert.equal(e.footer, undefined);
    assert.equal(e.image, undefined);
    assert.equal(e.title, 'Old title');
    assert.deepEqual(e.thumbnail, { url: 'https://x.example/t.png' });
  });

  it('removes just an icon or just a link, without touching the rest of the author or footer', async () => {
    const msg = post([rich()]);
    patch(msg, [], ['footerIcon', 'authorUrl']);
    await run();
    const [e] = plain(msg.embeds);
    assert.deepEqual(e.footer, { text: 'Old footer' });
    assert.deepEqual(e.author, { name: 'Team', icon_url: 'https://x.example/a.png' });
  });

  it('removes the title together with its link', async () => {
    const msg = post([rich({ url: 'https://x.example/t' })]);
    patch(msg, [], ['title']);
    await run();
    const [e] = plain(msg.embeds);
    assert.equal(e.title, undefined);
    assert.equal(e.url, undefined);
  });

  it('sets a title link, a colour, a time and pictures (an uploaded one becomes its public address)', async () => {
    const msg = post([rich({ image: undefined, thumbnail: undefined })]);
    patch(msg, [set('url', { text: 'https://x.example/new' }), set('color', { color: '#ff0000' }), set('timestamp'), set('image', { image: 'upload:0123456789abcdef' }), set('thumbnail', { image: 'https://x.example/new.png' })]);
    await run();
    const [e] = plain(msg.embeds);
    assert.equal(e.url, 'https://x.example/new');
    assert.equal(e.color, 0xff0000);
    assert.ok(Date.parse(e.timestamp) > 0);
    assert.deepEqual(e.image, { url: 'https://bot.example/i/111111/0123456789abcdef' });
    assert.deepEqual(e.thumbnail, { url: 'https://x.example/new.png' });
  });

  it('sets the author icon and footer icon of an embed that already has an author and a footer', async () => {
    const msg = post([rich({ author: { name: 'Team' }, footer: { text: 'F' } })]);
    patch(msg, [set('authorIcon', { image: 'https://x.example/new-a.png' }), set('footerIcon', { image: 'https://x.example/new-f.png' })]);
    await run();
    const [e] = plain(msg.embeds);
    assert.deepEqual(e.author, { name: 'Team', icon_url: 'https://x.example/new-a.png' });
    assert.deepEqual(e.footer, { text: 'F', icon_url: 'https://x.example/new-f.png' });
  });

  it('replaces all the fields with the new ones, or removes them all', async () => {
    const msg = post([rich()]);
    patch(msg, [set('fields', { fields: [{ name: 'X', value: '{{user.name}}', inline: true }, { name: '', value: 'no name so skipped' }] })]);
    await run();
    assert.deepEqual(plain(msg.embeds)[0].fields, [{ name: 'X', value: 'mia', inline: true }]);

    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    patch(msg, [], ['fields']);
    await run();
    assert.equal(plain(msg.embeds)[0].fields, undefined);
  });

  it('refuses an author icon when there is no author name, and a new value that is empty', async () => {
    const msg = post([rich({ author: undefined })]);
    patch(msg, [set('authorIcon', { image: 'https://x.example/a.png' })]);
    await run();
    assert.match(oops()[0], /author needs a name/);
    assert.equal(edits().length, 0);

    channel.sent.length = 0;
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    patch(msg, [set('title', { text: '{{var.never_set}}' })]);
    await run();
    assert.match(oops()[0], /“Title” has no new value.*Remove these parts/);
    assert.deepEqual(plain(msg.embeds), [plain(rich({ author: undefined }))], 'nothing was changed');
  });

  it('refuses a colour that is not a colour, a link that is not http(s), and a field list with nothing usable', async () => {
    const msg = post([rich()]);
    for (const [change, message] of [
      [set('color', { color: 'blue' }), /not a color like #ff8800/],
      [set('url', { text: 'ftp://x.example' }), /title link must start with http/],
      [set('fields', { fields: [{ name: '', value: '' }] }), /Add at least one field/],
    ]) {
      channel.sent.length = 0;
      for (const f of db.listFlows(guild.id)) db.deleteFlow(guild.id, f.id);
      patch(msg, [change]);
      await run();
      assert.match(oops()[0], message);
    }
    assert.deepEqual(msg.embeds, [rich()]);
  });

  it('drops an embed with nothing left in it, and keeps a footer-only embed visible', async () => {
    const msg = post([{ title: 'T', description: 'D' }]);
    patch(msg, [], ['title', 'description']);
    await run();
    assert.deepEqual(msg.embeds, [], 'nothing left, so the embed is gone (the text stays)');
    assert.equal(msg.content, 'Original text');

    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    const footerOnly = post([{ title: 'T', footer: { text: 'F' } }]);
    patch(footerOnly, [], ['title']);
    await run();
    assert.deepEqual(plain(footerOnly.embeds), [{ footer: { text: 'F' }, description: '​' }]);
  });

  it('counts the embeds one by one: an existing one, one past the end adds a new one, further is an error', async () => {
    const msg = post([rich(), rich({ title: 'Second' })]);
    patch(msg, [set('title', { text: 'Third' }), set('description', { text: 'Brand new' })], [], { patchEmbed: 3 });
    await run();
    assert.deepEqual(msg.embeds.map((e) => e.title), ['Old title', 'Second', 'Third']);
    assert.equal(msg.embeds[2].description, 'Brand new');

    channel.sent.length = 0;
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    patch(msg, [set('title', { text: 'Too far' })], [], { patchEmbed: 5 });
    await run();
    assert.match(oops()[0], /The message has 3 embeds, so there is no embed number 5 to change \(use 4 to add a new one\)/);
    assert.equal(msg.embeds.length, 3);
  });

  it('can add the first embed to a message that has none', async () => {
    const msg = post([]);
    patch(msg, [set('title', { text: 'First!' })]);
    await run();
    assert.deepEqual(msg.embeds.map((e) => e.title), ['First!']);

    channel.sent.length = 0;
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    const none = post([]);
    patch(none, [set('title', { text: 'x' })], [], { patchEmbed: 2 });
    await run();
    assert.match(oops()[0], /The message has no embeds yet. Use embed number 1/);
  });

  it('does not send back the link previews Discord made, and does not count them', async () => {
    const preview = { type: 'link', url: 'https://x.example/page', title: 'A page', provider: { name: 'x' }, thumbnail: { url: 'https://x.example/p.png', proxy_url: 'https://cdn/x', width: 10, height: 10 } };
    const msg = post([preview, rich()]);
    patch(msg, [set('description', { text: 'Changed' })]);
    await run();
    assert.equal(msg.embeds.length, 1, 'the preview is not sent back');
    assert.equal(msg.embeds[0].description, 'Changed');
    assert.equal(msg.embeds[0].title, 'Old title', 'embed number 1 is the first one of ours');
  });

  it('does not send back the internal addresses and sizes Discord adds to pictures', async () => {
    const msg = post([rich({ image: { url: 'https://x.example/i.png', proxy_url: 'https://cdn/i', width: 640, height: 480 }, footer: { text: 'F', proxy_icon_url: 'https://cdn/f' } })]);
    patch(msg, [set('title', { text: 'T' })]);
    await run();
    const [e] = plain(msg.embeds);
    assert.deepEqual(e.image, { url: 'https://x.example/i.png' });
    assert.deepEqual(e.footer, { text: 'F' });
  });
});

describe('what Discord allows, when editing', () => {
  it('at most ten embeds', async () => {
    const msg = post(Array.from({ length: 10 }, (_, i) => rich({ title: `E${i}` })));
    patch(msg, [set('title', { text: 'Eleventh' })], [], { patchEmbed: 11 });
    await run();
    assert.match(oops()[0], /at most 10 embeds \(this one has 11\)/);
    assert.equal(msg.embeds.length, 10);
  });

  it('at most 6000 characters in all of them', async () => {
    const msg = post([{ description: 'a'.repeat(3000) }, { description: 'b'.repeat(2500) }]);
    patch(msg, [set('description', { text: 'c'.repeat(3100) })], [], { patchEmbed: 2 });
    await run();
    assert.match(oops()[0], /add up to 6100 characters, but Discord allows 6000/);
    assert.equal(msg.embeds[1].description.length, 2500);
  });
});

describe('which message', () => {
  it('“This message” is the one a pressed button is on', async () => {
    const msg = post([rich()], { id: '700020', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Dismiss', custom_id: 'fcb:dismiss:' }] }] });
    install({
      nodes: [node('h', 'trigger.button.clicked', { customId: 'dismiss' }), node('b', 'action.message.edit', { messageFrom: 'this', contentMode: 'replace', content: 'Done by {{user.name}}', embedsMode: 'remove' })],
      edges: [edge('h', 'b')],
    });
    await click(buildButtonId({ id: 'dismiss' }), msg.id);
    assert.equal(msg.content, 'Done by mia');
    assert.deepEqual(msg.embeds, []);
    assert.equal(msg.components.length, 1, 'the buttons are never touched');
  });

  it('only the bot’s own messages, and only one that exists, with an ID that is not empty', async () => {
    const theirs = post([rich()], { author: { id: '999999', username: 'someone', bot: false } });
    edit({ messageId: theirs.id, contentMode: 'replace', content: 'mine now', embedsMode: 'keep' });
    await run();
    assert.match(oops()[0], /only edit its own messages/);
    assert.equal(theirs.content, 'Original text');

    channel.sent.length = 0;
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    edit({ messageId: '123456789012345678', contentMode: 'replace', content: 'x', embedsMode: 'keep' });
    await run();
    assert.match(oops()[0], /was not found in #general/);

    channel.sent.length = 0;
    db.deleteFlow(guild.id, db.listFlows(guild.id)[0].id);
    edit({ messageId: '{{var.never_saved}}', contentMode: 'replace', content: 'x', embedsMode: 'keep' });
    await run();
    assert.match(oops()[0], /The message ID is empty/);
    assert.equal(edits().length, 0);
  });
});

describe('an Edit Message saved before it had these choices', () => {
  // no contentMode / embedsMode / messageFrom: exactly the data the old editor wrote
  const legacy = (data) => ({ id: 'b', type: 'action.message.edit', position: { x: 0, y: 0 }, data });
  const legacyFlow = (data) => install(commandFlow([legacy(data)], [edge('t', 'b')]));

  it('still replaces the text and takes the embed off when it had none', async () => {
    const msg = post([rich()]);
    legacyFlow({ messageId: msg.id, content: 'Legacy text', useEmbed: false });
    await run();
    assert.equal(msg.content, 'Legacy text');
    assert.deepEqual(msg.embeds, []);
    assert.equal(msg.components?.length ?? 0, 0);
  });

  it('still replaces the text and the embed when it had one (the old flat keys)', async () => {
    const msg = post([rich()]);
    legacyFlow({ messageId: msg.id, content: 'Legacy text', useEmbed: true, embedTitle: 'Flat', embedDescription: 'D', embedColor: '#ff0000' });
    await run();
    assert.equal(msg.content, 'Legacy text');
    assert.deepEqual(msg.embeds.map((e) => [e.title, e.description, e.color]), [['Flat', 'D', 0xff0000]]);
  });

  it('keeps the buttons, like it always did', async () => {
    const msg = post([], { components: [button] });
    legacyFlow({ messageId: msg.id, content: 'Legacy text', useEmbed: false });
    await run();
    assert.equal(msg.content, 'Legacy text');
    assert.equal(msg.components.length, 1);
  });
});
