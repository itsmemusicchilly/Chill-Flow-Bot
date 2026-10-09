// What the dashboard tells the person when they come back from “Connect Twitch / TikTok”: only words the dashboard itself owns.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONNECT_FAILURES, connectFailureText, connectResultFrom } from '../shared/platforms.js';
import { AccountError } from '../server/accounts/common.js';

describe('coming back from connecting an account', () => {
  it('says it worked, or that the approval was cancelled, with the platform\'s name', () => {
    assert.deepEqual(connectResultFrom('?connect=ok&provider=twitch'), { result: 'ok', message: 'Twitch connected.', error: false });
    assert.deepEqual(connectResultFrom('?connect=ok&provider=tiktok'), { result: 'ok', message: 'TikTok connected.', error: false });
    assert.deepEqual(connectResultFrom('?connect=denied&provider=tiktok'), { result: 'denied', message: 'TikTok was not connected: the approval was cancelled.', error: true });
  });

  it('explains each kind of failure in its own words', () => {
    for (const code of Object.keys(CONNECT_FAILURES)) {
      const r = connectResultFrom(`?connect=failed&provider=twitch&reason=${code}`);
      assert.equal(r.error, true);
      assert.equal(r.message, connectFailureText(code, 'Twitch'));
      assert.ok(r.message.includes('Twitch') && !r.message.includes('{label}'), r.message);
    }
    assert.match(connectResultFrom('?connect=failed&provider=tiktok&reason=scope').message, /TikTok did not give the permission to read the follower count/);
  });

  it('never shows words that came from the address: a made-up link cannot put its own message on the screen', () => {
    const text = 'Your session expired - log in again at https://evil.example';
    for (const reason of [text, encodeURIComponent(text), '__proto__', 'constructor', 'toString', '<img src=x onerror=alert(1)>', '', 'scope ']) {
      const r = connectResultFrom(`?connect=failed&provider=twitch&reason=${encodeURIComponent(reason)}`);
      assert.equal(r.message, 'Twitch could not be connected. Try again.', JSON.stringify(reason));
    }
    assert.equal(connectResultFrom(`?connect=failed&provider=twitch&reason=${encodeURIComponent(text)}`).message.includes('evil'), false);
    assert.equal(connectResultFrom('?connect=denied&provider=twitch&reason=hello').message.includes('hello'), false);
    assert.equal(connectResultFrom('?connect=ok&provider=twitch&reason=hello').message, 'Twitch connected.');
  });

  it('does not take a made-up platform name as text either', () => {
    assert.equal(connectResultFrom('?connect=ok&provider=evil.example').message, 'The account connected.');
    assert.equal(connectResultFrom('?connect=failed&provider=__proto__').message, 'The account could not be connected. Try again.');
    assert.equal(connectResultFrom('?connect=ok').message, 'The account connected.');
  });

  it('anything else (a word that is not a result, no result at all) is a failure, or nothing', () => {
    assert.equal(connectResultFrom(''), null);
    assert.equal(connectResultFrom('?login=denied'), null);
    assert.equal(connectResultFrom('?connect=maybe&provider=twitch').result, 'failed');
  });

  it('every problem the account code can report has words, and an unknown one falls back to the plain sentence', () => {
    assert.deepEqual(Object.keys(CONNECT_FAILURES).sort(), ['approval', 'keys', 'other', 'platform', 'scope', 'unavailable']);
    assert.equal(new AccountError('x').code, 'other', 'by default');
    assert.equal(connectFailureText('nonsense', 'TikTok'), 'TikTok could not be connected. Try again.');
    assert.equal(connectFailureText(undefined, 'TikTok'), 'TikTok could not be connected. Try again.');
  });
});
