// Building embeds for Send Message: every part, several embeds, Discord's limits, and nodes saved in the older flat shape.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { blankEmbed } from '../shared/embeds.js';
import { resetLimits } from '../shared/limits.js';
import { upgradeMessageData } from '../shared/embeds.js';
import { Database } from '../server/db.js';
import { buildEmbeds, buildPayload } from '../server/engine/payload.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

const UPLOAD = 'upload:0123456789abcdef';
const ctx = {
  guild: { id: '111111' }, flow: { id: 'f' },
  services: { uploads: { publicUrl: (guildId, ref) => `https://bot.example/i/${guildId}/${ref.slice(7)}` } },
};
const embed = (o = {}) => ({ ...blankEmbed(), ...o });
const json = (d) => buildEmbeds(ctx, d).map((e) => e.toJSON());

describe('building an embed', () => {
  it('uses every part: title and its link, description, colour, author, pictures, footer and its icon, time, fields', () => {
    const [e] = json({ embeds: [embed({
      title: 'T', url: 'https://x.example/t', description: 'D', color: '#ff8800',
      authorName: 'Team', authorIcon: 'https://x.example/a.png', authorUrl: 'https://x.example/team',
      thumbnail: 'https://x.example/th.png', image: UPLOAD, footer: 'F', footerIcon: 'https://x.example/f.png', timestamp: true,
      fields: [{ name: 'A', value: '1', inline: true }, { name: 'B', value: '2' }],
    })] });
    assert.equal(e.title, 'T');
    assert.equal(e.url, 'https://x.example/t');
    assert.equal(e.description, 'D');
    assert.equal(e.color, 0xff8800);
    assert.deepEqual(e.author, { name: 'Team', icon_url: 'https://x.example/a.png', url: 'https://x.example/team' });
    assert.deepEqual(e.thumbnail, { url: 'https://x.example/th.png' });
    assert.deepEqual(e.image, { url: 'https://bot.example/i/111111/0123456789abcdef' }, 'an uploaded picture becomes its public address');
    assert.deepEqual(e.footer, { text: 'F', icon_url: 'https://x.example/f.png' });
    assert.ok(Date.parse(e.timestamp) > 0);
    assert.deepEqual(e.fields, [{ name: 'A', value: '1', inline: true }, { name: 'B', value: '2', inline: false }]);
  });

  it('builds several embeds in order', () => {
    const list = json({ embeds: [embed({ title: 'One' }), embed({ description: 'Two' }), embed({ authorName: 'Three' })] });
    assert.deepEqual(list.map((e) => e.title ?? e.description ?? e.author.name), ['One', 'Two', 'Three']);
  });

  it('a title link needs a title; an author icon and link need an author name — otherwise they are left out', () => {
    const [a] = json({ embeds: [embed({ description: 'D', url: 'https://x.example/t' })] });
    assert.equal(a.url, undefined);
    const [b] = json({ embeds: [embed({ description: 'D', authorIcon: 'https://x.example/a.png', authorUrl: 'https://x.example/team' })] });
    assert.equal(b.author, undefined);
  });

  it('gives an embed with nothing to show an invisible body, but not one that has an author or a picture', () => {
    assert.equal(json({ embeds: [embed({ footer: 'only a footer' })] })[0].description, '​');
    assert.equal(json({ embeds: [embed()] })[0].description, '​');
    assert.equal(json({ embeds: [embed({ authorName: 'Someone' })] })[0].description, undefined);
    assert.equal(json({ embeds: [embed({ image: 'https://x.example/i.png' })] })[0].description, undefined);
  });

  it('refuses a link or picture that is not http(s) (or an upload), and says which one', () => {
    assert.throws(() => json({ embeds: [embed({ title: 'T', url: 'ftp://x.example' })] }), /The title link must start with http/);
    assert.throws(() => json({ embeds: [embed({ authorName: 'A', authorUrl: 'javascript:alert(1)' })] }), /The author link must start with http/);
    assert.throws(() => json({ embeds: [embed({ authorName: 'A', authorIcon: 'nope' })] }), /The author icon must be an http\(s\) URL or an uploaded image/);
    assert.throws(() => json({ embeds: [embed({ footer: 'F', footerIcon: 'nope' })] }), /The footer icon must be an http\(s\) URL or an uploaded image/);
    assert.throws(() => json({ embeds: [embed({ image: 'data:image/png;base64,AAAA' })] }), /Image must be an http\(s\) URL/);
  });
});

describe('what Discord allows in a message', () => {
  it('at most ten embeds', () => {
    assert.equal(json({ embeds: Array.from({ length: 10 }, (_, i) => embed({ title: `E${i}` })) }).length, 10);
    assert.throws(() => json({ embeds: Array.from({ length: 11 }, () => embed({ title: 'x' })) }), /at most 10 embeds \(this one has 11\)/);
  });

  it('at most 6000 characters in all of them together, counting title, description, fields, footer and author name', () => {
    const big = (n) => embed({ description: 'x'.repeat(n) });
    assert.equal(json({ embeds: [big(2000), big(2000), big(2000)] }).length, 3, 'exactly 6000 is fine');
    assert.throws(() => json({ embeds: [big(2500), big(2500), big(2500)] }), /add up to 7500 characters, but Discord allows 6000/);
    const parts = (description) => embed({ title: 't'.repeat(200), description: 'd'.repeat(description), authorName: 'a'.repeat(200), footer: 'f'.repeat(1000), fields: [{ name: 'n'.repeat(200), value: 'v'.repeat(1400) }] });
    // title 200 + author 200 + footer 1000 + field name 200 + field value 1024 (its own limit) = 2624, so a description of 3376 makes exactly 6000
    assert.equal(json({ embeds: [parts(3376)] }).length, 1, 'exactly 6000 is fine');
    assert.throws(() => json({ embeds: [parts(3377)] }), /add up to 6001 characters/, 'one more character is too many');
  });

  it('cuts a part that is too long for its place, as before', () => {
    const [e] = json({ embeds: [embed({ title: 't'.repeat(400), description: 'd'.repeat(5000) })] });
    assert.equal(e.title.length, 256);
    assert.equal(e.description.length, 4096);
  });
});

describe('nodes saved with the older flat keys', () => {
  const old = {
    useEmbed: true, embedTitle: 'Hello', embedDescription: 'Body', embedColor: '#ff8800', embedThumbnail: 'https://x.example/t.png',
    embedImage: UPLOAD, embedFooter: 'Foot', embedFields: [{ name: 'A', value: '1', inline: true }],
  };

  it('build exactly the embed they always did', () => {
    const [e] = json(old);
    assert.equal(e.title, 'Hello');
    assert.equal(e.description, 'Body');
    assert.equal(e.color, 0xff8800);
    assert.deepEqual(e.thumbnail, { url: 'https://x.example/t.png' });
    assert.deepEqual(e.image, { url: 'https://bot.example/i/111111/0123456789abcdef' });
    assert.deepEqual(JSON.parse(JSON.stringify(e.footer)), { text: 'Foot' });
    assert.deepEqual(e.fields, [{ name: 'A', value: '1', inline: true }]);
    assert.equal(buildEmbeds(ctx, { useEmbed: false, embedTitle: 'hidden' }).length, 0, 'the old switch still means “no embed”');
  });

  it('give the same message before and after they are upgraded', () => {
    const d = { target: 'reply', content: 'hi', ...old };
    const before = buildPayload(ctx, d, { id: 'm' });
    const after = buildPayload(ctx, upgradeMessageData('action.message.send', d), { id: 'm' });
    assert.deepEqual(after.embeds.map((e) => e.toJSON()), before.embeds.map((e) => e.toJSON()));
    assert.equal(after.content, before.content);
  });
});

describe('Send Message with several embeds, running', () => {
  let db; let runtime; let guild; let channel; let user; let member;
  beforeEach(() => {
    resetLimits();
    db = new Database(':memory:');
    runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true }, uploads: ctx.services.uploads });
    guild = fakeGuild({ id: '111111' });
    channel = guild.addChannel({ name: 'general', id: '500001' });
    user = fakeUser({ id: '222222', username: 'mia' });
    member = guild.addMember({ user });
    runtime.attachClient(guild.client);
  });
  const run = async (graph) => {
    db.createFlow({ guildId: guild.id, name: 'f', graph, enabled: true });
    runtime.loadGuild(guild.id);
    const i = fakeCommand({ guild, channel, user, member, commandName: 'cmd', options: [] });
    await runtime.handleInteraction(i);
    return i;
  };

  it('posts every embed, with templates filled in', async () => {
    const i = await run(commandFlow([node('m', 'action.message.send', {
      target: 'reply',
      embeds: [
        embed({ title: 'Hi {{user.name}}', authorName: '{{guild.name}}', footer: 'F', footerIcon: 'https://x.example/f.png' }),
        embed({ description: 'Second', color: '#3ba55d', fields: [{ name: 'Who', value: '{{user.name}}' }] }),
      ],
    })], [edge('t', 'm')]));
    const embeds = i.calls[0][1].embeds.map((e) => e.data);
    assert.equal(embeds.length, 2);
    assert.equal(embeds[0].title, 'Hi mia');
    assert.equal(embeds[0].author.name, 'Guild 111111');
    assert.deepEqual(embeds[0].footer, { text: 'F', icon_url: 'https://x.example/f.png' });
    assert.equal(embeds[1].description, 'Second');
    assert.deepEqual(embeds[1].fields, [{ name: 'Who', value: 'mia', inline: false }]);
  });

  it('{{guild.icon}} puts the server picture in the author icon, footer icon, thumbnail and image', async () => {
    guild.iconURL = ({ size }) => `https://cdn.example/icons/111111/abc.png?size=${size}`;
    const icon = 'https://cdn.example/icons/111111/abc.png?size=256';
    const i = await run(commandFlow([node('m', 'action.message.send', {
      target: 'reply',
      embeds: [embed({ authorName: '{{guild.name}}', authorIcon: '{{guild.icon}}', footer: 'F', footerIcon: '{{guild.icon}}', thumbnail: '{{guild.icon}}', image: '{{guild.icon}}' })],
    })], [edge('t', 'm')]));
    const [e] = i.calls[0][1].embeds.map((x) => x.data);
    assert.equal(e.author.icon_url, icon);
    assert.equal(e.footer.icon_url, icon);
    assert.equal(e.thumbnail.url, icon);
    assert.equal(e.image.url, icon);
  });

  it('a server without an icon leaves the picture out instead of failing the message', async () => {
    guild.iconURL = () => null;
    const i = await run(commandFlow([node('m', 'action.message.send', {
      target: 'reply',
      embeds: [embed({ title: 'Hi', authorName: '{{guild.name}}', authorIcon: '{{guild.icon}}', thumbnail: '{{guild.icon}}' })],
    })], [edge('t', 'm')]));
    const [e] = i.calls[0][1].embeds.map((x) => x.data);
    assert.equal(e.author.name, 'Guild 111111');
    assert.equal(e.author.icon_url, undefined);
    assert.equal(e.thumbnail, undefined);
  });

  it('follows the error output, with the reason, when a link is bad', async () => {
    const i = await run(commandFlow([
      node('m', 'action.message.send', { target: 'reply', embeds: [embed({ title: 'T', url: 'ftp://nope' })] }),
      node('e', 'action.message.send', { target: 'reply', content: 'oops: {{error.message}}' }),
    ], [edge('t', 'm'), edge('m', 'e', 'error')]));
    assert.equal(i.calls[0][1].content, 'oops: The title link must start with http:// or https://.');
  });
});
