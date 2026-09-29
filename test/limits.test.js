import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { NODE_LIST } from '../shared/catalog.js';
import { applyLimits, isCapped, LIMIT_KEYS, LIMITS, limitsToJSON, parseLimit, resetLimits } from '../shared/limits.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { ConfigError, LIMIT_ENV, loadConfig } from '../server/config.js';
import { clampDelayMs } from '../server/engine/executors/logic.js';
import { RateLimiter } from '../server/engine/rate-limit.js';
import { node } from './helpers/fakes.js';

afterEach(resetLimits);

describe('limits', () => {
  it('every policy limit is unlimited by default', () => {
    for (const key of LIMIT_KEYS) assert.equal(LIMITS[key], Infinity, key);
    assert.ok(LIMIT_KEYS.every((k) => k in LIMIT_ENV), 'every limit has an environment variable');
    assert.ok(Object.values(limitsToJSON()).slice(0, -1).every((v) => v === null));
  });

  it('parses numbers, words and junk', () => {
    assert.equal(parseLimit(undefined), undefined);
    assert.equal(parseLimit(''), undefined);
    assert.equal(parseLimit(null), Infinity);
    assert.equal(parseLimit(0), Infinity);
    assert.equal(parseLimit('0'), Infinity);
    assert.equal(parseLimit(' Unlimited '), Infinity);
    assert.equal(parseLimit('off'), Infinity);
    assert.equal(parseLimit(' 15 '), 15);
    assert.equal(parseLimit(12.7), 12);
    assert.ok(Number.isNaN(parseLimit(-1)));
    assert.ok(Number.isNaN(parseLimit('lots')));
    assert.ok(Number.isNaN(parseLimit('1e3')));
  });

  it('applyLimits caps selected limits, ignores unknown keys and rejects junk', () => {
    applyLimits({ nodesPerFlow: 10, notALimit: 3, stepsPerRun: 'unlimited' });
    assert.equal(LIMITS.nodesPerFlow, 10);
    assert.equal(LIMITS.stepsPerRun, Infinity);
    assert.equal('notALimit' in LIMITS, false);
    assert.throws(() => applyLimits({ flowsPerGuild: 'many' }), /flowsPerGuild/);
    assert.equal(isCapped(LIMITS.nodesPerFlow), true);
    assert.equal(isCapped(LIMITS.flowsPerGuild), false);
  });

  it('effective limits survive the JSON round trip to the editor', () => {
    applyLimits({ flowsPerGuild: 25, waitSeconds: 300 });
    const wire = JSON.parse(JSON.stringify(limitsToJSON()));
    assert.equal(wire.flowsPerGuild, 25);
    assert.equal(wire.nodesPerFlow, null);
    resetLimits();
    applyLimits(wire);
    assert.equal(LIMITS.flowsPerGuild, 25);
    assert.equal(LIMITS.waitSeconds, 300);
    assert.equal(LIMITS.nodesPerFlow, Infinity);
  });
});

describe('configuration from the environment', () => {
  const base = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's' };

  it('leaves everything unlimited unless a variable says otherwise', () => {
    const c = loadConfig(base);
    assert.deepEqual(c.limits, {});
    assert.equal(c.requestBytes, 50 * 1024 * 1024);
  });

  it('reads LIMIT_* variables', () => {
    const c = loadConfig({ ...base, LIMIT_FLOWS_PER_GUILD: '50', LIMIT_STEPS_PER_RUN: 'unlimited', LIMIT_WAIT_SECONDS: '300', LIMIT_RUNS_PER_10S: '40' });
    assert.deepEqual(c.limits, { flowsPerGuild: 50, stepsPerRun: Infinity, waitSeconds: 300, runsPer10s: 40 });
  });

  it('rejects garbage with the variable name in the message', () => {
    assert.throws(() => loadConfig({ ...base, LIMIT_NODES_PER_FLOW: 'lots' }), (e) => e instanceof ConfigError && /LIMIT_NODES_PER_FLOW/.test(e.message));
    assert.throws(() => loadConfig({ ...base, LIMIT_REQUEST_BYTES: '-5' }), /LIMIT_REQUEST_BYTES/);
  });

  it('the request body always keeps a physical ceiling', () => {
    assert.equal(loadConfig({ ...base, LIMIT_REQUEST_BYTES: '2048' }).requestBytes, 2048);
    assert.equal(loadConfig({ ...base, LIMIT_REQUEST_BYTES: 'unlimited' }).requestBytes, 1024 ** 3);
    assert.equal(loadConfig({ ...base, LIMIT_REQUEST_BYTES: '99999999999' }).requestBytes, 1024 ** 3, 'even an explicit huge number is clamped');
  });
});

describe('limit mechanics', () => {
  it('a rate limiter with no limit records nothing', () => {
    const rl = new RateLimiter(Infinity, 1000);
    for (let i = 0; i < 1000; i += 1) assert.ok(rl.take('g'));
    assert.equal(rl.hits.size, 0);
  });

  it('a rate limiter can read its limit live', () => {
    let t = 0;
    let cap = 1;
    const rl = new RateLimiter(() => cap, 1000, () => t);
    assert.ok(rl.take('g'));
    assert.ok(!rl.take('g'));
    cap = 3;
    assert.ok(rl.take('g'));
    cap = Infinity;
    assert.ok(rl.take('g') && rl.take('g'));
  });

  it('wait delays stay inside what a timer can hold, and inside the operator cap', () => {
    assert.equal(clampDelayMs(5), 5000);
    assert.equal(clampDelayMs(-3), 0);
    assert.equal(clampDelayMs(1e12), 2 ** 31 - 1, 'would overflow setTimeout and fire immediately');
    applyLimits({ waitSeconds: 300 });
    assert.equal(clampDelayMs(1000), 300000);
    assert.equal(clampDelayMs(10), 10000);
  });

  it('only Discord\'s own list caps remain in the catalog', () => {
    const capped = {};
    for (const d of NODE_LIST) for (const f of d.fields) if (f.type === 'list' && Number.isFinite(f.max)) capped[`${d.type}.${f.key}`] = f.max;
    assert.deepEqual(capped, {
      'trigger.command.options': 25,
      'action.message.send.embedFields': 25,
      'action.message.send.buttons': 25,
      'action.message.send.menuOptions': 25,
      'action.message.edit.embedFields': 25,
      'action.modal.show.inputs': 5,
    });
  });

  it('an If node with dozens of checks and a channel with dozens of overrides validate fine', () => {
    const checks = Array.from({ length: 40 }, (_, i) => ({ left: `{{var.a${i}}}`, op: 'equals', right: '1' }));
    const overwrites = Array.from({ length: 40 }, (_, i) => ({ targetType: 'role', targetId: `role${i}`, allow: [], deny: [] }));
    const graph = normalizeGraph({ nodes: [node('t', 'trigger.manual'), node('c', 'logic.condition', { conditions: checks }), node('k', 'action.channel.create', { name: 'x', overwrites })], edges: [] });
    const issues = validateFlow(graph, { intents: { members: true, messageContent: true } });
    assert.ok(!issues.some((i) => /at most/.test(i.message)), JSON.stringify(issues.filter((i) => /at most/.test(i.message))));
  });

  it('caps still work when an operator sets them', () => {
    applyLimits({ nodesPerFlow: 2, edgesPerFlow: 0 });
    const graph = normalizeGraph({ nodes: [node('a', 'logic.log', { message: 'x' }), node('b', 'logic.log', { message: 'x' }), node('c', 'logic.log', { message: 'x' })], edges: [] });
    const issues = validateFlow(graph);
    assert.ok(issues.some((i) => i.kind === 'structure' && /at most 2 nodes/.test(i.message)));
  });
});
