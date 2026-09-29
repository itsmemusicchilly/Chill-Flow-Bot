import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { Database } from '../server/db.js';
import { ComponentState, EPHEMERAL_STATE_MS } from '../server/engine/component-state.js';

const DAY = 24 * 3600 * 1000;
const run = (guildId = 'g1', extra = {}) => ({ guild: { id: guildId }, vars: { ticket: '42', nested: { a: 1 } }, data: { user: { id: 'u1' }, original: { user: { id: 'old' } }, ...extra } });
const expiryOf = (db, guildId, messageId) => db.db.prepare('SELECT expires_at FROM component_state WHERE guild_id = ? AND message_id = ?').get(guildId, messageId)?.expires_at;

beforeEach(() => resetLimits());

// The same behaviour must hold with and without a database, so run every test against both.
for (const [label, make] of [['in memory', () => new ComponentState()], ['in the database', () => new ComponentState({ db: new Database(':memory:') })]]) {
  describe(`component state ${label}`, () => {
    let state;
    beforeEach(() => { state = make(); });

    it('hands out an independent copy on every read', () => {
      state.remember('m1', run());
      const a = state.get('g1', 'm1');
      a.vars.ticket = 'changed';
      a.vars.nested.a = 99;
      a.data.user.id = 'someone-else';
      const b = state.get('g1', 'm1');
      assert.deepEqual(b.vars, { ticket: '42', nested: { a: 1 } });
      assert.equal(b.data.user.id, 'u1');
    });

    it('keeps only one level of "original"', () => {
      state.remember('m1', run());
      assert.equal(state.get('g1', 'm1').data.original, undefined);
    });

    it('is scoped to the server', () => {
      state.remember('m1', run('g1'));
      assert.equal(state.get('g2', 'm1'), undefined);
      assert.ok(state.get('g1', 'm1'));
    });

    it('forgets one message, or every message of a channel', () => {
      state.remember('m1', run(), { channelId: 'c1' });
      state.remember('m2', run(), { channelId: 'c2' });
      state.remember('m3', run(), { channelId: 'c2' });
      state.remember('m4', run('g2'), { channelId: 'c2' });
      state.forget('g1', 'm1');
      assert.equal(state.get('g1', 'm1'), undefined);
      state.forgetChannel('g1', 'c2');
      assert.equal(state.get('g1', 'm2'), undefined);
      assert.equal(state.get('g1', 'm3'), undefined);
      assert.ok(state.get('g2', 'm4'), 'another server\'s message is untouched');
    });

    it('overwrites the state when the same message is remembered again', () => {
      state.remember('m1', run());
      const second = run(); second.vars = { ticket: 'new' };
      state.remember('m1', second);
      assert.equal(state.get('g1', 'm1').vars.ticket, 'new');
    });

    it('ignores missing ids instead of throwing', () => {
      assert.equal(state.get(undefined, 'm1'), undefined);
      assert.equal(state.get('g1', undefined), undefined);
      assert.doesNotThrow(() => { state.forget(undefined, undefined); state.forgetChannel('g1', ''); });
    });
  });
}

describe('component state persistence', () => {
  it('survives a "restart": a new ComponentState on the same database still finds it', () => {
    const db = new Database(':memory:');
    new ComponentState({ db }).remember('m1', run(), { channelId: 'c1' });
    const after = new ComponentState({ db }).get('g1', 'm1');
    assert.deepEqual(after.vars, { ticket: '42', nested: { a: 1 } });
    assert.equal(after.data.user.id, 'u1');
  });

  it('keeps panels for ever by default, expires ephemeral messages after a day, and honours the operator cap', () => {
    const db = new Database(':memory:');
    const state = new ComponentState({ db });
    const t0 = Date.now();
    state.remember('panel', run());
    state.remember('secret', run(), { ephemeral: true });
    assert.equal(expiryOf(db, 'g1', 'panel'), null, 'no expiry by default');
    const eph = expiryOf(db, 'g1', 'secret');
    assert.ok(eph >= t0 + EPHEMERAL_STATE_MS && eph <= Date.now() + EPHEMERAL_STATE_MS);

    applyLimits({ componentStateDays: 2 });
    state.remember('capped', run());
    const cap = expiryOf(db, 'g1', 'capped');
    assert.ok(cap >= t0 + 2 * DAY && cap <= Date.now() + 2 * DAY);
  });

  it('expires on read and is removed by pruning', () => {
    const db = new Database(':memory:');
    db.saveComponentState({ guildId: 'g1', messageId: 'a', vars: '{}', data: '{}', expiresAt: 100, now: 50 });
    db.saveComponentState({ guildId: 'g1', messageId: 'b', vars: '{}', data: '{}', expiresAt: null, now: 50 });
    assert.ok(db.getComponentState('g1', 'a', 99));
    assert.equal(db.getComponentState('g1', 'a', 100), undefined, 'expired rows are never returned, even before pruning');
    assert.equal(db.countComponentState('g1'), 2);
    assert.equal(db.pruneComponentState(100), 1);
    assert.equal(db.countComponentState('g1'), 1);
    assert.ok(db.getComponentState('g1', 'b', 1e15), 'rows without an expiry stay');
  });

  it('a damaged row behaves like "nothing remembered"', () => {
    const db = new Database(':memory:');
    db.saveComponentState({ guildId: 'g1', messageId: 'a', vars: '{not json', data: '{}' });
    assert.equal(new ComponentState({ db }).get('g1', 'a'), undefined);
  });

  it('the in-memory fallback still evicts the oldest entry beyond its maximum', () => {
    const state = new ComponentState({ max: 2 });
    state.remember('m1', run()); state.remember('m2', run()); state.remember('m3', run());
    assert.equal(state.get('g1', 'm1'), undefined);
    assert.ok(state.get('g1', 'm2') && state.get('g1', 'm3'));
  });
});
