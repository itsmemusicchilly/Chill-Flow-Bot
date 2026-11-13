// The HTTP Request block: off unless the operator switches it on, and then only through the guarded fetcher.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { applyLimits, resetLimits } from '../shared/limits.js';
import { integrationFlags } from '../shared/platforms.js';
import { normalizeGraph, validateFlow } from '../shared/validate.js';
import { ConfigError, loadConfig } from '../server/config.js';
import { Database } from '../server/db.js';
import { hostAllowed, HTTP_MAX_BYTES } from '../server/engine/executors/http.js';
import { HTTP_REQUESTS_PER_MINUTE_CEILING, Runtime } from '../server/engine/runtime.js';
import { Logger } from '../server/logger.js';
import { safeFetch, SafeFetchError } from '../server/net/safe-fetch.js';
import { commandFlow, edge, fakeCommand, fakeGuild, fakeUser, node } from './helpers/fakes.js';

const ENV = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c', DISCORD_CLIENT_SECRET: 's' };
let db; let runtime; let guild; let channel; let user; let member; let calls; let answer;

function setup(http = { enabled: true, allowedHosts: [] }) {
  db = new Database(':memory:');
  calls = [];
  answer = () => ({ status: 200, text: '{"ok":true}', headers: new Headers({ 'content-type': 'application/json' }) });
  const fetcher = async (url, options = {}) => { calls.push({ url, ...options }); return answer(url, options); };
  runtime = new Runtime({ db, logger: new Logger({ console: false }), intents: { members: true, messageContent: true }, integrations: { http }, fetcher });
  guild = fakeGuild({ id: '111111' });
  channel = guild.addChannel({ name: 'general' });
  user = fakeUser({ id: '222222', username: 'mia "the" great' });
  member = guild.addMember({ user });
  runtime.attachClient(guild.client);
}
const flow = (data, ok = 'ok {{http.status}}') => commandFlow(
  [node('h', 'action.http.request', { url: 'https://api.example.com/v1/things', ...data }), node('r', 'action.message.send', { target: 'reply', content: ok }), node('e', 'action.message.send', { target: 'reply', content: 'failed: {{error.message}}' })],
  [edge('t', 'h'), edge('h', 'r'), edge('h', 'e', 'error')],
);
let n = 0;
/** Installs a flow under its own command and runs it once. */
const run = async (data, ok) => {
  n += 1;
  const g = flow(data, ok);
  g.nodes[0].data.name = `c${n}`;
  db.createFlow({ guildId: guild.id, name: `f${n}`, graph: g });
  runtime.loadGuild(guild.id);
  const i = fakeCommand({ guild, channel, user, member, commandName: `c${n}` });
  await runtime.handleInteraction(i);
  return i.calls.find((c) => c[0] === 'reply')?.[1].content;
};

beforeEach(() => { resetLimits(); setup(); });

describe('HTTP Request: switched off by default', () => {
  it('the setting is off unless the operator says otherwise, and the editor is only told yes or no', () => {
    assert.deepEqual(loadConfig(ENV).integrations.http, { enabled: false, allowedHosts: [] });
    assert.equal(integrationFlags(loadConfig(ENV).integrations).http, false);
    const on = loadConfig({ ...ENV, ENABLE_HTTP_REQUEST: 'true', HTTP_REQUEST_ALLOWED_HOSTS: ' API.Example.com , *.example.org ' });
    assert.deepEqual(on.integrations.http, { enabled: true, allowedHosts: ['api.example.com', '*.example.org'] });
    assert.equal(integrationFlags(on.integrations).http, true);
    for (const bad of ['https://example.com', 'localhost', '*', 'exa mple.com', '10.0.0.1']) {
      assert.throws(() => loadConfig({ ...ENV, HTTP_REQUEST_ALLOWED_HOSTS: bad }), ConfigError, bad);
    }
    assert.equal(loadConfig({ ...ENV, LIMIT_HTTP_REQUESTS_PER_MINUTE: '5' }).limits.httpRequestsPerMinute, 5);
  });

  it('a flow that uses it does nothing and says why', async () => {
    setup({ enabled: false, allowedHosts: [] });
    assert.equal(await run({}), 'failed: The HTTP Request block is switched off on this bot. The bot operator can switch it on with ENABLE_HTTP_REQUEST=true.');
    assert.equal(calls.length, 0);
    setup(undefined);
    runtime = new Runtime({ db, logger: new Logger({ console: false }), fetcher: async () => { calls.push(1); return answer(); } });
    runtime.attachClient(guild.client);
    assert.match(await run({}), /switched off on this bot/);
    assert.equal(calls.length, 0);
  });

  it('the editor marks the block as not set up', () => {
    const graph = normalizeGraph(flow({}));
    const off = validateFlow(graph, { integrations: { http: false } }).filter((i) => i.nodeId === 'h');
    assert.deepEqual(off.map((i) => [i.level, i.kind]), [['error', 'intent']]);
    assert.match(off[0].message, /^This block needs outbound requests switched on \(ENABLE_HTTP_REQUEST=true\)/);
    assert.deepEqual(validateFlow(graph, { integrations: { http: true } }).filter((i) => i.nodeId === 'h'), []);
  });
});

describe('HTTP Request: asking', () => {
  it('sends a GET through the guarded fetcher, with a size and a time limit, and reads a JSON answer', async () => {
    answer = () => ({ status: 200, text: '{"name":"Ada","stats":{"wins":3},"tags":["a","b"]}', headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }) });
    assert.equal(await run({}, '{{http.status}} {{http.ok}} {{http.body.name}} {{http.body.stats.wins}} {{http.body.tags | join:+}} {{http.type}}'), '200 true Ada 3 a+b application/json');
    assert.deepEqual(calls, [{ url: 'https://api.example.com/v1/things', method: 'GET', headers: {}, body: undefined, maxBytes: HTTP_MAX_BYTES, timeoutMs: 10_000 }], 'no list of websites: nothing more is passed');
  });

  it('fills variables into the address, the headers and what it sends', async () => {
    await run({
      method: 'POST', url: 'https://api.example.com/users/{{user.id}}', bodyType: 'json', body: '{"name": {{user.name | json}}, "n": {{guild.memberCount}}}',
      headers: [{ name: 'Authorization', value: 'Bearer abc' }, { name: 'X-Server', value: '{{guild.id}}' }],
    });
    const [call] = calls;
    assert.equal(call.url, 'https://api.example.com/users/222222');
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.headers, { authorization: 'Bearer abc', 'x-server': '111111', 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(call.body), { name: 'mia "the" great', n: 3 }, 'the json filter keeps quotes in a name from breaking the JSON');
  });

  it('sends form fields and plain text with the right content type, and nothing with GET', async () => {
    await run({ method: 'PUT', bodyType: 'form', body: 'a=1&b=two' });
    await run({ method: 'PATCH', bodyType: 'text', body: 'hello', headers: [{ name: 'Content-Type', value: 'text/markdown' }] });
    await run({ method: 'GET', bodyType: 'json', body: '{"ignored":true}' });
    await run({ method: 'DELETE' });
    assert.deepEqual(calls.map((c) => [c.method, c.body, c.headers['content-type']]), [
      ['PUT', 'a=1&b=two', 'application/x-www-form-urlencoded'], ['PATCH', 'hello', 'text/markdown'], ['GET', undefined, undefined], ['DELETE', undefined, undefined],
    ]);
  });

  it('an answer that is not JSON is still there as text; JSON hidden in a text answer is read', async () => {
    answer = () => ({ status: 200, text: 'plain words', headers: new Headers({ 'content-type': 'text/plain' }) });
    assert.equal(await run({}, '[{{http.text}}] [{{http.body.name}}]'), '[plain words] []');
    answer = () => ({ status: 200, text: ' {"name":"Bo"}', headers: new Headers({ 'content-type': 'text/plain' }) });
    assert.equal(await run({}, '[{{http.body.name}}]'), '[Bo]');
    answer = () => ({ status: 200, text: '{broken', headers: new Headers({ 'content-type': 'application/json' }) });
    assert.equal(await run({}, '[{{http.text}}] [{{http.body.name}}]'), '[{broken] []');
  });

  it('follows On error for an error status by default, with the answer still readable — or carries on when told to', async () => {
    answer = () => ({ status: 404, text: '{"error":"no such thing"}', headers: new Headers({ 'content-type': 'application/json' }) });
    assert.equal(await run({}), 'failed: The site answered with an error (status 404).');
    assert.equal(await run({ failOnError: false }, '{{http.status}} {{http.ok}} {{http.body.error}}'), '404 false no such thing');
  });

  it('what a site answers is only ever text: a template in it is never filled in, and it is cut to size', async () => {
    db.setVar(guild.id, 'guild', '', 'secret', 'hunter2');
    answer = () => ({ status: 200, text: JSON.stringify({ a: '{{guild.vars.secret}}', __proto__: { x: 1 }, long: 'x'.repeat(5000), deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }), headers: new Headers({ 'content-type': 'application/json' }) });
    assert.equal(await run({}, '{{http.body.a}} {{http.body.long | length}} [{{http.body.deep.a.b.c.d.e.f.g}}] {{http.text | length}}'), '{{guild.vars.secret}} 2000 [] 4000');
  });
});

describe('HTTP Request: what it refuses', () => {
  it('addresses that are not public https, before anything is sent', async () => {
    for (const [url, why] of [['http://api.example.com/', /https/], ['https://localhost/admin', /./], ['https://10.0.0.5/', /./], ['https://user:pw@example.com/', /./], ['', /./], ['not an address', /./]]) {
      assert.match(await run({ url }), new RegExp(`^failed: .*${why.source}`), url);
    }
    assert.equal(calls.length, 0);
  });

  it('what the real guarded fetcher refuses is refused here too: a name that points at a private address', async () => {
    const lookup = (host, opts, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
    const { createSafeAgent } = await import('../server/net/safe-fetch.js');
    const agent = createSafeAgent({ resolve: lookup });
    runtime.services.http.fetch = (url, options) => safeFetch(url, { ...options, agent });
    assert.equal(await run({ url: 'https://metadata.example.com/latest/meta-data' }), 'failed: That address points to a private or internal network, so it is not allowed.');
    await agent.close();
  });

  it('with a list of websites, a redirect that leaves the list is refused by the real fetcher', async () => {
    setup({ enabled: true, allowedHosts: ['api.example.com'] });
    const hops = [{ status: 302, headers: new Headers({ location: 'https://elsewhere.example/secret' }), body: null }, { status: 200, headers: new Headers(), body: null }];
    let asked = 0;
    runtime.services.http.fetch = (url, options) => safeFetch(url, { ...options, fetchImpl: async () => { asked += 1; return hops.shift(); } });
    assert.equal(await run({ url: 'https://api.example.com/redirect' }), 'failed: The site redirected to elsewhere.example, which is not one of the websites that may be reached, so it was not followed.');
    assert.equal(asked, 1, 'the other website was never asked');
  });

  it('a fetcher problem becomes the node’s error, in plain words', async () => {
    answer = () => { throw new SafeFetchError('The site took too long to answer.', 'ETIMEOUT'); };
    assert.equal(await run({}), 'failed: The site took too long to answer.');
    answer = () => { throw new Error('socket hang up'); };
    assert.equal(await run({}), 'failed: The site could not be reached (socket hang up).');
  });

  it('headers that belong to the connection, or that carry a line break', async () => {
    for (const name of ['Host', 'content-length', 'Transfer-Encoding', 'Proxy-Authorization', 'X-Forwarded-For', 'Connection']) {
      assert.equal(await run({ headers: [{ name, value: 'x' }] }), `failed: The header “${name}” cannot be set.`);
    }
    assert.equal(await run({ headers: [{ name: 'Bad Name', value: 'x' }] }), 'failed: “Bad Name” is not a valid header name.');
    assert.equal(await run({ headers: Array.from({ length: 21 }, (_, i) => ({ name: `X-${i}`, value: '1' })) }), 'failed: At most 20 headers can be sent.');
    db.setVar(guild.id, 'guild', '', 'evil', 'a\r\nX-Injected: 1');
    assert.match(await run({ headers: [{ name: 'X-Thing', value: '{{guild.vars.evil}}' }] }), /^failed: The value of the header “X-Thing” has a line break/);
    assert.equal(calls.length, 0);
  });

  it('JSON that is broken once the variables are in', async () => {
    assert.match(await run({ method: 'POST', bodyType: 'json', body: '{"name": "{{user.name}}"}' }), /^failed: “What to send” is not valid JSON once the variables are filled in/);
    assert.equal(calls.length, 0);
  });

  it('websites that are not on the operator’s list, when there is one', async () => {
    setup({ enabled: true, allowedHosts: ['api.example.com', '*.example.org'] });
    assert.equal(await run({ url: 'https://api.example.com/x' }), 'ok 200');
    assert.equal(await run({ url: 'https://sub.example.org/x' }), 'ok 200');
    assert.equal(await run({ url: 'https://example.org/x' }), 'ok 200');
    assert.match(await run({ url: 'https://evil.example.com/x' }), /^failed: Requests to evil.example.com are not allowed on this bot/);
    assert.match(await run({ url: 'https://notexample.org/x' }), /^failed: Requests to notexample.org are not allowed/);
    assert.equal(calls.length, 3);
    assert.equal(typeof calls[0].allowHost, 'function', 'the fetcher is told the list too, so a redirect cannot lead off it');
    assert.deepEqual([calls[0].allowHost('api.example.com'), calls[0].allowHost('evil.example.com')], [true, false]);
    assert.equal(hostAllowed('anything.example', []), true);
    assert.equal(hostAllowed('API.EXAMPLE.COM', ['api.example.com']), true);
    assert.equal(hostAllowed('xapi.example.com', ['api.example.com']), false);
    assert.equal(hostAllowed('evilexample.org', ['*.example.org']), false);
  });

  it('more than a fixed number of requests a minute per server — fewer if the operator says so', async () => {
    const g = flow({});
    db.createFlow({ guildId: guild.id, name: 'many', graph: g });
    runtime.loadGuild(guild.id);
    const once = async () => { const i = fakeCommand({ guild, channel, user, member, commandName: 'cmd' }); await runtime.handleInteraction(i); return i.calls.find((c) => c[0] === 'reply')[1].content; };
    for (let i = 0; i < HTTP_REQUESTS_PER_MINUTE_CEILING; i += 1) assert.equal(await once(), 'ok 200');
    assert.equal(await once(), 'failed: This server is sending too many HTTP requests — wait a minute.');
    assert.equal(calls.length, HTTP_REQUESTS_PER_MINUTE_CEILING);

    setup();
    applyLimits({ httpRequestsPerMinute: 2 });
    db.createFlow({ guildId: guild.id, name: 'few', graph: g });
    runtime.loadGuild(guild.id);
    assert.deepEqual([await once(), await once(), await once()], ['ok 200', 'ok 200', 'failed: This server is sending too many HTTP requests — wait a minute.']);
  });

  it('checks the address and the JSON while you edit', () => {
    const problems = (data) => validateFlow(normalizeGraph(flow(data)), { integrations: { http: true } }).filter((i) => i.nodeId === 'h').map((i) => i.message);
    assert.deepEqual(problems({ url: 'http://example.com' }), ['The address must start with https://.']);
    assert.deepEqual(problems({ url: '{{var.address}}' }), []);
    assert.ok(problems({ url: '' }).some((m) => /required/.test(m)));
    assert.deepEqual(problems({ method: 'POST', bodyType: 'json', body: '{oops' }), ['“What to send” is not valid JSON.']);
    assert.deepEqual(problems({ method: 'POST', bodyType: 'json', body: '{"a": {{var.x | json}}}' }), []);
    assert.deepEqual(problems({ headers: Array.from({ length: 21 }, (_, i) => ({ name: `X-${i}`, value: '1' })) }), ['At most 20 headers can be sent.']);
  });
});
