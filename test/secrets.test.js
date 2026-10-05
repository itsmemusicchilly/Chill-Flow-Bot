// Sealing the tokens of connected accounts before they reach the database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSealer } from '../server/secrets.js';

describe('sealing secrets', () => {
  const a = createSealer({ key: 'a-long-random-key-for-tests', fallback: 'discord-client-secret' });

  it('opens what it sealed, and the sealed text shows nothing of the original', () => {
    const sealed = a.seal('my-access-token-123', '111|twitch');
    assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(!sealed.includes('my-access-token'));
    assert.equal(a.open(sealed, '111|twitch'), 'my-access-token-123');
  });

  it('seals the same text differently each time', () => {
    assert.notEqual(a.seal('same', 'x'), a.seal('same', 'x'));
  });

  it('does not open for another server or provider (the value cannot be moved to another row)', () => {
    const sealed = a.seal('token', '111|twitch');
    assert.equal(a.open(sealed, '222|twitch'), null);
    assert.equal(a.open(sealed, '111|tiktok'), null);
  });

  it('does not open when it was changed', () => {
    const [v, iv, tag, ct] = a.seal('token', 'x').split('.');
    const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    assert.equal(a.open([v, iv, tag, flip(ct)].join('.'), 'x'), null, 'ciphertext');
    assert.equal(a.open([v, iv, flip(tag), ct].join('.'), 'x'), null, 'tag');
    assert.equal(a.open([v, flip(iv), tag, ct].join('.'), 'x'), null, 'iv');
    assert.equal(a.open([v, iv, tag].join('.'), 'x'), null, 'a part is missing');
    assert.equal(a.open(['v2', iv, tag, ct].join('.'), 'x'), null, 'another version');
  });

  it('does not open with a different key, and junk is simply null — never a crash', () => {
    const sealed = a.seal('token', 'x');
    assert.equal(createSealer({ key: 'another-long-random-key-here' }).open(sealed, 'x'), null);
    for (const junk of ['', 'nonsense', null, undefined, 42, '....', 'v1...']) assert.equal(a.open(junk, 'x'), null, String(junk));
  });

  it('uses the fallback secret when there is no dedicated key — and the two are not interchangeable', () => {
    const viaFallback = createSealer({ fallback: 'discord-client-secret' });
    const sealed = viaFallback.seal('token', 'x');
    assert.equal(createSealer({ key: '', fallback: 'discord-client-secret' }).open(sealed, 'x'), 'token');
    assert.equal(a.open(sealed, 'x'), null, 'a dedicated key replaces the fallback');
    assert.throws(() => createSealer({}), /secret is needed/);
  });

  it('handles any text, including other languages and long values', () => {
    for (const text of ['', 'ünïcödé 🎵 日本語', 'x'.repeat(5000)]) assert.equal(a.open(a.seal(text, 'x'), 'x'), text);
  });
});
