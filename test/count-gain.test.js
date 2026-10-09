// What the count watchers (YouTube subscribers, Twitch followers, TikTok followers) share: when a changed count should run a flow.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countData, evaluateCount } from '../server/feeds/count-gain.js';

const step = (state, count, mode = 'gain') => evaluateCount(state, count, { mode, noun: 'followers', name: 'Test' });
/** Feeds a series of looks through, as the watcher does (state is passed along), and returns what ran. */
function play(counts, mode) {
  let state = null;
  const ran = [];
  for (const c of counts) { const r = step(state, c, mode); state = r.state; ran.push(...r.fire); }
  return { ran, state };
}

describe('when a count changed', () => {
  it('the first look only remembers the count, and says what it is watching', () => {
    const r = step(null, 1234);
    assert.deepEqual(r.fire, []);
    assert.equal(r.state.baselined, true);
    assert.equal(r.state.count, 1234);
    assert.match(r.log[0].message, /Now watching Test: 1,234 followers\. It will run each time the count goes up\./);
  });

  it('runs once per look when the count rises, with how many were gained', () => {
    const { ran } = play([100, 100, 103, 103, 104], 'gain');
    assert.deepEqual(ran, [
      { count: 103, previous: 100, change: 3, gained: 3 },
      { count: 104, previous: 103, change: 1, gained: 1 },
    ]);
  });

  it('does not run for a count that did not move, or that went down — but remembers the lower count', () => {
    const { ran, state } = play([100, 90, 90], 'gain');
    assert.deepEqual(ran, []);
    assert.equal(state.count, 90);
  });

  it('a count that fell and then rises again is announced again (they really are new)', () => {
    const { ran } = play([100, 90, 95], 'gain');
    assert.deepEqual(ran, [{ count: 95, previous: 90, change: 5, gained: 5 }]);
  });

  it('“change” mode (for counters) runs once on the first look, so the counter is right at once', () => {
    const r = step(null, 500, 'change');
    assert.deepEqual(r.fire, [{ count: 500, previous: 500, change: 0, gained: 0 }]);
  });

  it('“change” mode runs on every change, up or down, and tells them apart', () => {
    const { ran } = play([100, 100, 105, 101, 101], 'change');
    assert.deepEqual(ran, [
      { count: 100, previous: 100, change: 0, gained: 0 },
      { count: 105, previous: 100, change: 5, gained: 5 },
      { count: 101, previous: 105, change: -4, gained: 0 },
    ]);
  });

  it('a switch from “gain” to “change” mode keeps what it knows (no second first look)', () => {
    let r = step(null, 10, 'gain');
    r = step(r.state, 12, 'change');
    assert.deepEqual(r.fire, [{ count: 12, previous: 10, change: 2, gained: 2 }]);
  });

  it('a count that belongs to a different account starts over instead of announcing a jump', () => {
    const at = (state, count, owner, mode = 'gain') => evaluateCount(state, count, { mode, noun: 'followers', name: 'Test', owner });
    let r = at(null, 100, 'A');
    assert.equal(r.state.owner, 'A');
    r = at(r.state, 103, 'A');
    assert.deepEqual(r.fire.map((f) => f.gained), [3]);
    const other = at(r.state, 5000, 'B');
    assert.deepEqual(other.fire, [], 'the other account\'s total is not “+4,897”');
    assert.equal(other.state.owner, 'B');
    assert.equal(other.state.count, 5000);
    assert.match(other.log[0].message, /Now watching/);
    assert.deepEqual(at(other.state, 5002, 'B').fire.map((f) => f.gained), [2]);
    assert.deepEqual(at(r.state, 5000, 'B', 'change').fire, [{ count: 5000, previous: 5000, change: 0, gained: 0 }], 'a counter shows the new account straight away');
  });

  it('state saved before accounts had owners adopts the owner without starting over', () => {
    const old = { baselined: true, count: 100 };
    const r = evaluateCount(old, 104, { mode: 'gain', noun: 'followers', name: 'Test', owner: 'A' });
    assert.deepEqual(r.fire.map((f) => f.gained), [4]);
    assert.equal(r.state.owner, 'A');
  });

  it('a count it cannot read changes nothing', () => {
    const state = { baselined: true, count: 7 };
    for (const bad of [NaN, undefined, null, Infinity]) assert.deepEqual(step(state, bad), { state, fire: [], log: [] }, String(bad));
  });

  it('an unchanged count returns the very same state (nothing to save)', () => {
    const state = { baselined: true, count: 7 };
    assert.equal(step(state, 7).state, state);
  });

  it('keeps extra things the watcher remembers (the YouTube “hidden” note)', () => {
    const r = step({ baselined: true, count: 7, hiddenNoted: true }, 9);
    assert.equal(r.state.hiddenNoted, true);
    assert.equal(r.state.count, 9);
  });

  it('shapes the variables of a run: the count under its own name, plus gained, change and previous', () => {
    assert.deepEqual(countData('followers', { count: 105, previous: 100, change: 5, gained: 5 }), { followers: 105, gained: 5, change: 5, previous: 100 });
  });
});
