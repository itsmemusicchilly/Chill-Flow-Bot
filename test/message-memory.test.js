import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageMemory } from '../server/engine/message-memory.js';

const HOUR = 60 * 60 * 1000;

function message(over = {}) {
  const guildId = over.guildId ?? 'g1';
  return {
    id: 'm1',
    guildId,
    channelId: 'c1',
    content: 'hello',
    url: '',
    createdTimestamp: 1_700_000_000_000,
    author: { id: 'u1', username: 'ada', globalName: 'Ada', tag: 'ada', bot: false, displayAvatarURL: () => 'https://cdn/a.png' },
    attachments: new Map([['a', { url: 'https://cdn/file.png' }]]),
    channel: { id: 'c1', name: 'general' },
    guild: { id: guildId },
    ...over,
  };
}

describe('message memory', () => {
  it('returns the text, author, link and attachments, then forgets the message', () => {
    const memory = new MessageMemory();
    memory.remember(message());
    const snap = memory.take('g1', 'm1');
    assert.equal(snap.content, 'hello');
    assert.equal(snap.author.id, 'u1');
    assert.equal(snap.author.username, 'ada');
    assert.equal(snap.author.avatar, 'https://cdn/a.png');
    assert.equal(snap.channelName, 'general');
    assert.deepEqual(snap.attachments, ['https://cdn/file.png']);
    assert.equal(snap.url, 'https://discord.com/channels/g1/c1/m1');
    assert.equal(snap.createdAt, new Date(1_700_000_000_000).toISOString());
    assert.equal(memory.take('g1', 'm1'), null);
  });

  it('keeps the same message id in another server', () => {
    const memory = new MessageMemory();
    memory.remember(message({ guildId: 'g1', content: 'one' }));
    memory.remember(message({ guildId: 'g2', content: 'two' }));
    assert.equal(memory.take('g1', 'm1').content, 'one');
    assert.equal(memory.take('g2', 'm1').content, 'two');
  });

  it('drops the oldest message once a server is over its cap', () => {
    const memory = new MessageMemory({ maxPerGuild: 2 });
    memory.remember(message({ id: 'a', content: 'first' }));
    memory.remember(message({ id: 'b', content: 'second' }));
    memory.remember(message({ id: 'c', content: 'third' }));
    assert.equal(memory.take('g1', 'a'), null);
    assert.equal(memory.take('g1', 'b').content, 'second');
    assert.equal(memory.take('g1', 'c').content, 'third');
  });

  it('drops a message once it is older than the limit', () => {
    let now = 1_000;
    const memory = new MessageMemory({ maxAgeMs: HOUR, now: () => now });
    memory.remember(message({ id: 'old' }));
    now += HOUR + 1;
    memory.remember(message({ id: 'new', content: 'fresh' }));
    assert.equal(memory.take('g1', 'old'), null);
    assert.equal(memory.take('g1', 'new').content, 'fresh');
  });

  it('forgets one channel, and a whole server, without touching the rest', () => {
    const memory = new MessageMemory();
    memory.remember(message({ id: 'a', channelId: 'c1', channel: { id: 'c1', name: 'one' } }));
    memory.remember(message({ id: 'b', channelId: 'c2', channel: { id: 'c2', name: 'two' } }));
    memory.remember(message({ id: 'c', guildId: 'g2', content: 'other' }));
    memory.forgetChannel('g1', 'c1');
    assert.equal(memory.take('g1', 'a'), null);
    assert.equal(memory.take('g1', 'b').channelName, 'two');
    memory.clear('g2');
    assert.equal(memory.take('g2', 'c'), null);
  });
});
