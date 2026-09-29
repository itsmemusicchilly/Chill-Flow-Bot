// Uploaded pictures in message embeds: a flow may only ever use its own server's pictures, and only when Discord can fetch them.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetLimits } from '../shared/limits.js';
import { uid } from '../shared/util.js';
import { Database } from '../server/db.js';
import { Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { createUploads } from '../server/uploads.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

const PUBLIC = 'https://bot.example.com';
let db; let runtime; let guild; let channel; let user; let member;

function setup(baseUrl = PUBLIC, withUploads = true) {
  db = new Database(':memory:');
  const logger = new Logger({ console: false });
  const uploads = withUploads ? createUploads({ config: { baseUrl, dataDir: 'unused' }, db, logger }) : null;
  runtime = new Runtime({ db, logger, intents: { members: true, messageContent: true }, uploads });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'general' });
  user = fakeUser({ id: '222222', username: 'mia' });
  member = guild.addMember({ user });
  runtime.attachClient(guild.client);
}
const picture = (guildId = guild.id) => db.addUpload({ guildId, name: 'a.png', bytes: 10, width: 4, height: 4, animated: false, sha256: uid(32) });
const install = (graph) => { db.createFlow({ guildId: guild.id, name: 'Test flow', graph }); runtime.loadGuild(guild.id); };
const run = async () => {
  const i = fakeCommand({ guild, channel, user, member, commandName: 'cmd' });
  await runtime.handleInteraction(i);
  return i;
};
/** A /cmd flow that replies with an embed carrying these embed fields; on failure it replies with the error text. */
const embedFlow = (fields) => install(commandFlow(
  [node('s', 'action.message.send', { target: 'reply', useEmbed: true, embedTitle: 'Look', ...fields }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })],
  [edge('t', 's'), edge('s', 'e', 'error')],
));
const sentEmbed = (i) => i.calls[0][1].embeds?.[0]?.data;
const failure = (i) => i.calls[0][1].content;

beforeEach(() => { resetLimits(); setup(); });

describe('uploaded pictures in message embeds', () => {
  it('become absolute addresses on the public BASE_URL', async () => {
    const a = picture();
    const b = picture();
    embedFlow({ embedImage: `upload:${a.id}`, embedThumbnail: `upload:${b.id}` });
    const embed = sentEmbed(await run());
    assert.equal(embed.image.url, `${PUBLIC}/i/111111/${a.id}.webp`);
    assert.equal(embed.thumbnail.url, `${PUBLIC}/i/111111/${b.id}.webp`);
  });

  it('still take plain links, and a reference built from a variable', async () => {
    const a = picture();
    db.setVar(guild.id, 'guild', '', 'pic', a.id);
    embedFlow({ embedImage: 'https://cdn.example/a.png', embedThumbnail: 'upload:{{guild.vars.pic}}' });
    const embed = sentEmbed(await run());
    assert.equal(embed.image.url, 'https://cdn.example/a.png');
    assert.equal(embed.thumbnail.url, `${PUBLIC}/i/111111/${a.id}.webp`);
  });

  it('cannot use another server\'s picture', async () => {
    const theirs = picture('222222222');
    embedFlow({ embedImage: `upload:${theirs.id}` });
    assert.match(failure(await run()), /failed: That uploaded image no longer exists in this server/);
  });

  it('cannot use a deleted picture', async () => {
    const a = picture();
    embedFlow({ embedImage: `upload:${a.id}` });
    db.deleteUpload(guild.id, a.id);
    assert.match(failure(await run()), /no longer exists/);
  });

  it('say what is wrong with a mangled reference or a bad link', async () => {
    embedFlow({ embedImage: 'upload:nonsense' });
    assert.match(failure(await run()), /not a valid uploaded image/);
    setup();
    embedFlow({ embedThumbnail: 'javascript:alert(1)' });
    assert.match(failure(await run()), /Thumbnail must be an http\(s\) URL or an uploaded image/);
    setup();
    embedFlow({ embedImage: 'upload:{{guild.vars.missing}}' });
    assert.match(failure(await run()), /not a valid uploaded image/, 'an empty variable leaves nothing valid behind');
  });

  it('explain themselves when Discord could not download from BASE_URL', async () => {
    for (const base of ['http://localhost:3000', 'http://192.168.1.20:3000', 'http://mybot']) {
      setup(base);
      embedFlow({ embedImage: `upload:${picture().id}` });
      assert.match(failure(await run()), /BASE_URL is a public address/, base);
    }
  });

  it('fail clearly when the server has no upload support at all', async () => {
    setup(PUBLIC, false);
    embedFlow({ embedImage: 'upload:aaaaaaaaaaaaaaaa' });
    assert.match(failure(await run()), /not available/);
  });
});
