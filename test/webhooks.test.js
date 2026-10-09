// "Webhook Received": a secret address anyone can POST to, and the flow that runs when they do — through the real Express app.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { shapeValue } from '../server/hooks.js';
import { A, B, startHarness } from './helpers/harness.js';
import { edge, node } from './helpers/fakes.js';

describe('webhook addresses and calls', () => {
  let h; let channel; let flow;
  const hook = (over = {}) => ({ sid: null, origin: null, ...over }); // a public call: no dashboard login, no Origin
  const said = () => channel.sent.map((p) => p.content);
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  /** Saves a flow "Webhook Received → say `content`" in server A and returns the address (path) of its trigger. */
  const setup = async ({ content = 'got: {{webhook.body.title}} / {{webhook.text}} / {{webhook.query.q}}', enabled = true, extra = [] } = {}) => {
    channel = h.guilds[A].addChannel({ name: 'alerts' });
    flow = h.db.createFlow({
      guildId: A, name: 'Alerts', enabled,
      graph: { nodes: [node('w', 'trigger.webhook', {}), node('m', 'action.message.send', { target: 'channel', channelId: channel.id, content }), ...extra], edges: [edge('w', 'm')] },
    });
    h.runtime.loadGuild(A);
    const made = await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/webhook`, { body: { nodeId: 'w' } });
    assert.equal(made.status, 200, made.text);
    return { url: made.json.url, path: new URL(made.json.url).pathname, made };
  };

  beforeEach(async () => { resetLimits(); h = await startHarness(); });
  afterEach(async () => { resetLimits(); await h.close(); });

  describe('the address', () => {
    it('is made on first use, is the same every time after, and looks like a random 256-bit secret', async () => {
      const { url, made } = await setup();
      assert.match(url, new RegExp(`^${h.config.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/hooks/[A-Za-z0-9_-]{43}$`));
      assert.equal(made.json.created, true);
      const again = await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/webhook`, { body: { nodeId: 'w' } });
      assert.deepEqual([again.json.url, again.json.created], [url, false]);
      const second = await (async () => { const f = h.db.createFlow({ guildId: A, name: 'Other', graph: { nodes: [node('w', 'trigger.webhook', {})], edges: [] } }); return h.call('POST', `/api/guilds/${A}/flows/${f.id}/webhook`, { body: { nodeId: 'w' } }); })();
      assert.notEqual(second.json.url, url, 'every trigger has its own');
    });

    it('is only handed out for a saved webhook trigger of a flow the caller manages', async () => {
      await setup();
      for (const body of [{ nodeId: 'nope' }, { nodeId: 'm' }, {}, { nodeId: 5 }]) {
        const r = await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/webhook`, { body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.json.error, /Save the flow first/);
      }
      assert.equal((await h.call('POST', `/api/guilds/${A}/flows/nosuchflow/webhook`, { body: { nodeId: 'w' } })).status, 404);
      const onlyB = h.session([B]);
      assert.equal((await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/webhook`, { body: { nodeId: 'w' }, sid: onlyB })).status, 403, 'someone who cannot manage the server');
      assert.equal((await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/webhook`, { body: { nodeId: 'w' }, sid: null })).status, 401, 'nobody logged in');
      assert.equal((await h.call('POST', `/api/guilds/${B}/flows/${flow.id}/webhook`, { body: { nodeId: 'w' } })).status, 404, 'a flow id from another server is simply not there');
    });

    it('can be replaced: the old address stops working at once and the new one works', async () => {
      const { path, url } = await setup();
      assert.equal((await h.call('POST', path, hook({ body: { title: 'one' } }))).status, 202);
      const renewed = await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/webhook`, { body: { nodeId: 'w', renew: true } });
      assert.notEqual(renewed.json.url, url);
      assert.equal(renewed.json.created, true);
      assert.equal((await h.call('POST', path, hook({ body: { title: 'old' } }))).status, 404);
      assert.equal((await h.call('POST', new URL(renewed.json.url).pathname, hook({ body: { title: 'new' } }))).status, 202);
      await settle();
      assert.deepEqual(said().map((m) => m.split(' / ')[0]), ['got: one', 'got: new']);
    });

    it('stops working when the trigger is removed, the flow is deleted — and a copy of the flow gets none of its own', async () => {
      const { path } = await setup();
      const copy = await h.call('POST', `/api/guilds/${A}/flows/${flow.id}/duplicate`);
      assert.equal(copy.status, 201);
      assert.equal(h.db.webhookFor(A, copy.json.flow.id, 'w'), null, 'a copy (or an imported flow) does not inherit the secret');
      // removing the trigger from the flow
      const nodes = flow.graph.nodes.filter((n) => n.id !== 'w');
      const saved = await h.call('PUT', `/api/guilds/${A}/flows/${flow.id}`, { body: { graph: { nodes, edges: [] } } });
      assert.equal(saved.status, 200, saved.text);
      assert.equal((await h.call('POST', path, hook({ body: {} }))).status, 404);
      // deleting a flow
      const { path: path2 } = await (async () => { const f = h.db.createFlow({ guildId: A, name: 'Second', enabled: true, graph: { nodes: [node('w', 'trigger.webhook', {})], edges: [] } }); const r = await h.call('POST', `/api/guilds/${A}/flows/${f.id}/webhook`, { body: { nodeId: 'w' } }); return { path: new URL(r.json.url).pathname, id: f.id }; })();
      const gone = h.db.listFlows(A).find((f) => f.name === 'Second');
      assert.equal((await h.call('DELETE', `/api/guilds/${A}/flows/${gone.id}`)).status, 200);
      assert.equal((await h.call('POST', path2, hook({ body: {} }))).status, 404);
    });
  });

  describe('a call', () => {
    it('with JSON starts the flow with the fields as {{webhook.*}}, and answers at once', async () => {
      const { path } = await setup();
      const r = await h.call('POST', `${path}?q=from-query`, hook({ body: { title: 'New follower: Sam', extra: { deep: [1, 2] } } }));
      assert.equal(r.status, 202);
      assert.deepEqual(r.json, { ok: true });
      assert.equal(r.res.headers.get('cache-control'), 'no-store');
      await settle();
      assert.equal(said().length, 1);
      assert.match(said()[0], /^got: New follower: Sam \/ \{"title":"New follower: Sam","extra":\{"deep":\[1,2\]\}\} \/ from-query$/);
    });

    it('with form fields, plain text, or nothing at all', async () => {
      const { path } = await setup();
      assert.equal((await h.call('POST', path, hook({ form: { title: 'From a form' } }))).status, 202);
      assert.equal((await h.call('POST', path, hook({ raw: 'just some text', type: 'text/plain' }))).status, 202);
      assert.equal((await h.call('POST', path, hook())).status, 202, 'no body');
      await settle(60);
      const got = said().sort();
      assert.equal(got.length, 3);
      assert.ok(got.some((m) => m.startsWith('got: From a form /')));
      assert.ok(got.some((m) => m.startsWith('got:  / just some text /')));
      assert.ok(got.some((m) => m === 'got:  /  / '), 'nothing sent, nothing shown');
    });

    it('reaches nested fields and list items by their path', async () => {
      const { path } = await setup({ content: '{{webhook.body.user.name}} / {{webhook.body.tags.1}} / {{webhook.body.user.missing | default:none}}' });
      assert.equal((await h.call('POST', path, hook({ body: { user: { name: 'Sam' }, tags: ['a', 'b'] } }))).status, 202);
      await settle(60);
      assert.deepEqual(said(), ['Sam / b / none']);
    });

    it('needs no login, no Origin and no cookie — it is the address that is the permission', async () => {
      const { path } = await setup();
      assert.equal((await h.call('POST', path, hook({ body: { title: 'x' }, origin: 'https://evil.example' }))).status, 202);
    });

    it('records when it was last used', async () => {
      const { path } = await setup();
      assert.equal(h.db.webhookFor(A, flow.id, 'w').lastAt, null);
      await h.call('POST', path, hook({ body: {} }));
      assert.ok(h.db.webhookFor(A, flow.id, 'w').lastAt > 0);
    });

    it('runs in the background: the answer does not wait for a slow flow', async () => {
      const { path } = await setup({ extra: [node('s', 'logic.wait', { seconds: 0.4 }), node('d', 'action.message.send', { target: 'channel', channelId: null, content: 'late' })] });
      channel = h.guilds[A].channels.cache.values().next().value;
      const g = h.db.getFlow(A, flow.id);
      const slow = { ...g.graph, nodes: g.graph.nodes.map((n) => (n.id === 'd' ? { ...n, data: { ...n.data, channelId: channel.id } } : n)), edges: [edge('w', 's'), edge('s', 'd')] };
      h.db.updateFlow(A, flow.id, { graph: slow });
      h.runtime.loadGuild(A);
      const started = Date.now();
      assert.equal((await h.call('POST', path, hook({ body: {} }))).status, 202);
      assert.ok(Date.now() - started < 300, 'answered before the wait was over');
      assert.deepEqual(said(), []);
      await settle(600);
      assert.deepEqual(said(), ['late']);
    });

    it('what is sent is only data: templates and mentions inside it are not evaluated, and nothing is polluted', async () => {
      const { path } = await setup({ content: '{{webhook.body.title}}' });
      const evil = '{"title":"{{guild.name}} @everyone {{constructor}}","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"a":{"__proto__":{"polluted":"yes"}}}';
      const r = await h.call('POST', path, hook({ raw: evil, type: 'application/json' }));
      assert.equal(r.status, 202);
      await settle();
      assert.deepEqual(said(), ['{{guild.name}} @everyone {{constructor}}'], 'shown as written');
      assert.ok(!(channel.sent[0].allowedMentions?.parse ?? []).includes('everyone'), 'and it pings nobody');
      assert.equal({}.polluted, undefined, 'the shared prototype was not touched');
      assert.equal(Object.prototype.polluted, undefined);
    });
  });

  describe('what it refuses', () => {
    it('a wrong or malformed address, and anything that is not a POST', async () => {
      const { path } = await setup();
      assert.equal((await h.call('POST', `/hooks/${'x'.repeat(43)}`, hook({ body: {} }))).status, 404);
      assert.equal((await h.call('POST', '/hooks/short', hook({ body: {} }))).status, 404);
      assert.equal((await h.call('POST', `/hooks/${'../'.repeat(15)}`, hook({ body: {} }))).status, 404);
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
        const r = await h.call(method, path, hook());
        assert.equal(r.status, 405, method);
        assert.equal(r.res.headers.get('allow'), 'POST');
      }
      assert.equal((await h.call('GET', '/hooks/', hook())).status, 404, 'no listing of addresses');
    });

    it('a flow that is switched off, and a bot that is not connected', async () => {
      const { path } = await setup({ enabled: false });
      const off = await h.call('POST', path, hook({ body: {} }));
      assert.equal(off.status, 409);
      assert.match(off.json.error, /switched off/);
      h.db.updateFlow(A, flow.id, { enabled: true });
      h.runtime.loadGuild(A);
      assert.equal((await h.call('POST', path, hook({ body: {} }))).status, 202);
      h.runtime.attachClient(null);
      assert.equal((await h.call('POST', path, hook({ body: {} }))).status, 503);
    });

    it('a body that is too big — the default is small, the operator can make it smaller, and there is a ceiling nobody can lift', async () => {
      const { path } = await setup();
      const pad = (n) => JSON.stringify({ title: 'x'.repeat(n) });
      assert.equal((await h.call('POST', path, hook({ raw: pad(1000), type: 'application/json' }))).status, 202);
      assert.equal((await h.call('POST', path, hook({ raw: pad(70 * 1024), type: 'application/json' }))).status, 413, 'more than the default 64 KB');
      applyLimits({ webhookBytes: 500 });
      assert.equal((await h.call('POST', path, hook({ raw: pad(1000), type: 'application/json' }))).status, 413, 'the operator\'s smaller limit');
      applyLimits({ webhookBytes: 'unlimited' });
      assert.equal((await h.call('POST', path, hook({ raw: pad(300 * 1024), type: 'application/json' }))).status, 413, 'never more than 256 KB');
    });

    it('data it cannot read: other content types, and JSON that is not JSON', async () => {
      const { path } = await setup();
      for (const type of ['application/xml', 'multipart/form-data; boundary=x', 'application/octet-stream', 'image/png']) {
        assert.equal((await h.call('POST', path, hook({ raw: 'data', type }))).status, 415, type);
      }
      const bad = await h.call('POST', path, hook({ raw: '{not json', type: 'application/json' }));
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, 'Invalid JSON.');
      assert.equal(said().length, 0, 'none of it started a run');
    });

    it('too many calls: the operator can set a per-address limit, and guessing addresses is stopped', async () => {
      const { path } = await setup();
      applyLimits({ webhooksPerMinute: 3 });
      const codes = [];
      for (let i = 0; i < 5; i += 1) codes.push((await h.call('POST', path, hook({ body: {} }))).status);
      assert.deepEqual(codes, [202, 202, 202, 429, 429]);
      const blocked = await h.call('POST', path, hook({ body: {} }));
      assert.equal(blocked.res.headers.get('retry-after'), '60');
      resetLimits();
      // trying random addresses: the first 60 a minute are "not found", then it is refused outright
      const guesses = [];
      for (let i = 0; i < 70; i += 1) guesses.push((await h.call('POST', `/hooks/${String(i).padStart(43, 'a')}`, hook({ body: {} }))).status);
      assert.equal(guesses.filter((s) => s === 404).length, 60);
      assert.ok(guesses.slice(60).every((s) => s === 429));
    });

    it('a burst of runs beyond what the server allows: told to try again, not silently dropped', async () => {
      const { path } = await setup();
      applyLimits({ runsPer10s: 1 });
      const codes = [(await h.call('POST', path, hook({ body: {} }))).status, (await h.call('POST', path, hook({ body: {} }))).status];
      assert.deepEqual(codes, [202, 429]);
    });
  });
});

describe('shaping what a caller sends', () => {
  it('keeps strings, finite numbers, booleans, arrays and plain objects, and nothing else', () => {
    assert.deepEqual(shapeValue({ s: 'a', n: 1.5, b: true, list: [1, 'x', null], o: { k: 'v' } }), { s: 'a', n: 1.5, b: true, list: [1, 'x', ''], o: { k: 'v' } });
    assert.equal(shapeValue(undefined), '');
    assert.equal(shapeValue(() => 1), '');
    assert.equal(shapeValue(Symbol('x')), '');
    assert.equal(shapeValue(NaN), '');
    assert.equal(shapeValue(Infinity), '');
    assert.equal(shapeValue(10n), '');
  });

  it('never lets a dangerous key through, at any depth', () => {
    const out = shapeValue(JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"prototype":3,"ok":{"__proto__":{"z":1},"fine":"yes"}}'));
    assert.deepEqual(out, { ok: { fine: 'yes' } });
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal({}.x, undefined);
  });

  it('bounds depth, key count, list length and text length', () => {
    let deep = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = { d: deep };
    let out = shapeValue(deep); let depth = 0;
    while (typeof out === 'object') { out = out.d; depth += 1; }
    assert.ok(depth <= 6, `depth ${depth}`);
    const wide = shapeValue(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])));
    assert.equal(Object.keys(wide).length, 200);
    assert.equal(shapeValue(Array.from({ length: 500 }, (_, i) => i)).length, 50);
    assert.equal(shapeValue('x'.repeat(5000)).length, 2000);
    assert.equal(Object.keys(shapeValue({ ['k'.repeat(65)]: 1, ok: 2 })).join(), 'ok', 'a key longer than 64 characters is dropped');
  });

  it('strips control characters and bidi overrides from text', () => {
    assert.equal(shapeValue(`a${String.fromCharCode(0, 7, 0x202e, 0x2066)}b\n\tc`), 'ab\n\tc');
  });
});
