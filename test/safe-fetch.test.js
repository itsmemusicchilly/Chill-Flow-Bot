// The guarded fetcher: what it refuses (private networks, odd addresses, tricks) and what it lets through.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SafeFetchError, createGuardedLookup, createSafeAgent, isPublicAddress, parseSafeUrl, safeFetch } from '../server/net/safe-fetch.js';

const PUBLIC = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '11.0.0.1', '169.253.0.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.0', '198.17.255.255', '198.20.0.0',
  '2606:4700:4700::1111', '2001:4860:4860::8888', '2600::1', '2a00:1450:4001::200e'];
const PRIVATE = ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.255.255.254', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1',
  '192.168.0.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '100.64.0.1', '100.127.255.255', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2002:7f00:1::', '3fff::1',
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '::ffff:169.254.169.254', '::ffff:c0a8:0101', '64:ff9b::7f00:1', '64:ff9b::a00:1', '::127.0.0.1', '0:0:0:0:0:ffff:7f00:1',
  'fe80::1%eth0', '999.1.1.1', '1.2.3', '1.2.3.4.5', 'localhost', 'abc', '', ' ', undefined, null, 5];

describe('which addresses count as public', () => {
  it('lets real internet addresses through', () => { for (const ip of PUBLIC) assert.equal(isPublicAddress(ip), true, ip); });
  it('refuses private, loopback, link-local, cloud-metadata, reserved and multicast addresses, and every disguise of them', () => {
    for (const ip of PRIVATE) assert.equal(isPublicAddress(ip), false, String(ip));
  });
  it('an IPv4 address inside an IPv6 one is judged as the IPv4 address', () => {
    assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
    assert.equal(isPublicAddress('::ffff:0808:0808'), true);
    assert.equal(isPublicAddress('64:ff9b::808:808'), true);
    assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
  });
});

describe('the address a person types', () => {
  it('accepts an ordinary https address and returns it as a URL', () => {
    assert.equal(parseSafeUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UC123').href, 'https://www.youtube.com/feeds/videos.xml?channel_id=UC123');
    assert.equal(parseSafeUrl('  https://example.com/  ').hostname, 'example.com');
    assert.equal(parseSafeUrl('https://mastodon.social/@someone.rss').pathname, '/@someone.rss');
    assert.equal(parseSafeUrl('https://sub.domain.example.co.uk/a/b?x=1#y').hostname, 'sub.domain.example.co.uk');
  });

  it('refuses everything else, and says why', () => {
    const bad = [
      ['', /Enter an address/], ['   ', /Enter an address/], ['not a url', /not a valid address/], ['example.com/feed', /not a valid address/],
      ['http://example.com/feed', /Only https/], ['ftp://example.com/x', /Only https/], ['file:///etc/passwd', /Only https/], ['javascript:alert(1)', /Only https/],
      ['https://user:pw@example.com/', /user name or password/], ['https://user@example.com/', /user name or password/],
      ['https://example.com:8443/feed', /standard https port/], ['https://example.com:443/feed', /standard https port|^$/],
      ['https://127.0.0.1/', /raw IP/], ['https://10.0.0.5/feed', /raw IP/], ['https://[::1]/', /raw IP/], ['https://[::ffff:7f00:1]/', /raw IP/],
      ['https://2130706433/', /raw IP/], ['https://0x7f.1/', /raw IP/], ['https://0177.0.0.1/', /raw IP/], ['https://169.254.169.254/latest/meta-data/', /raw IP/],
      ['https://localhost/', /not a public website name/], ['https://app.localhost/', /not a public website name/], ['https://printer.local/', /not a public website name/],
      ['https://intranet/', /not a public website name/], ['https://metadata.google.internal/', /not a public website name/], ['https://router.lan/', /not a public website name/],
      ['https://nas.home.arpa/', /not a public website name/], [`https://example.com/${'a'.repeat(2100)}`, /too long/],
    ];
    for (const [input, message] of bad) {
      if (input === 'https://example.com:443/feed') continue; // the URL parser drops the default port, so this is simply fine
      assert.throws(() => parseSafeUrl(input), (e) => e instanceof SafeFetchError && message.test(e.message), input.slice(0, 60));
    }
    assert.equal(parseSafeUrl('https://example.com:443/feed').href, 'https://example.com/feed');
  });
});

describe('the guarded lookup (runs for every connection)', () => {
  const resolverOf = (answer) => (host, opts, cb) => cb(answer instanceof Error ? answer : null, answer instanceof Error ? undefined : answer);
  const ask = (lookup, options = {}) => new Promise((resolve) => lookup('feed.example', options, (...args) => resolve(args)));

  it('passes a public answer through, in either of the shapes net.connect asks for', async () => {
    const lookup = createGuardedLookup(resolverOf([{ address: '93.184.216.34', family: 4 }]));
    assert.deepEqual(await ask(lookup, { all: true }), [null, [{ address: '93.184.216.34', family: 4 }]]);
    assert.deepEqual(await ask(lookup, { all: false }), [null, '93.184.216.34', 4]);
  });

  it('refuses when the name points at a private address', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fe80::1']) {
      const [err] = await ask(createGuardedLookup(resolverOf([{ address, family: address.includes(':') ? 6 : 4 }])), { all: true });
      assert.ok(err instanceof SafeFetchError && err.code === 'EBLOCKED', address);
      assert.match(err.message, /private or internal network/);
    }
  });

  it('refuses when ANY of several answers is private (a mixed answer is how rebinding is smuggled in)', async () => {
    const lookup = createGuardedLookup(resolverOf([{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.10', family: 4 }]));
    const [err] = await ask(lookup, { all: true });
    assert.equal(err?.code, 'EBLOCKED');
  });

  it('checks again for every connection: a name that turns private later is refused then', async () => {
    let calls = 0;
    const lookup = createGuardedLookup((host, opts, cb) => { calls += 1; cb(null, [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]); });
    assert.equal((await ask(lookup, { all: true }))[0], null);
    assert.equal((await ask(lookup, { all: true }))[0]?.code, 'EBLOCKED');
  });

  it('an empty answer and a failed lookup are not "public"', async () => {
    assert.equal((await ask(createGuardedLookup(resolverOf([])), { all: true }))[0]?.code, 'EBLOCKED');
    const boom = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    assert.equal((await ask(createGuardedLookup(resolverOf(boom)), { all: true }))[0], boom);
  });
});

describe('a real connection attempt through the guarded agent', () => {
  it('never reaches a name that resolves to this machine or the private network', async () => {
    for (const address of ['127.0.0.1', '::ffff:127.0.0.1', '10.0.0.7', '169.254.169.254']) {
      const agent = createSafeAgent({ resolve: (h, o, cb) => cb(null, [{ address, family: address.includes(':') ? 6 : 4 }]) });
      await assert.rejects(safeFetch('https://looks-innocent.example/feed.xml', { agent, timeoutMs: 3000 }), (e) => e instanceof SafeFetchError && e.code === 'EBLOCKED' && /private or internal network/.test(e.message), address);
      await agent.close();
    }
  });

  it('a name that does not exist is reported plainly', async () => {
    const agent = createSafeAgent({ resolve: (h, o, cb) => cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })) });
    await assert.rejects(safeFetch('https://no-such-site.example/', { agent, timeoutMs: 3000 }), (e) => e.code === 'ENOTFOUND' && /could not be found/.test(e.message));
    await agent.close();
  });

  it('refuses a bad address before any connection is made', async () => {
    let touched = false;
    const fetchImpl = async () => { touched = true; throw new Error('should not be called'); };
    for (const url of ['http://example.com/', 'https://127.0.0.1/', 'https://localhost/x', 'https://user:pw@example.com/']) {
      await assert.rejects(safeFetch(url, { fetchImpl }), SafeFetchError, url);
    }
    assert.equal(touched, false);
  });
});

describe('the exchange (with a pretend network)', () => {
  const reply = (status, body = '', headers = {}) => ({
    status,
    headers: new Headers(headers),
    body: body === null ? null : new ReadableStream({ start(c) { c.enqueue(typeof body === 'string' ? new TextEncoder().encode(body) : body); c.close(); } }),
  });
  const script = (...steps) => { const seen = []; const fn = async (url, init) => { seen.push({ url, init }); const step = steps.shift(); return typeof step === 'function' ? step(url, init) : step; }; fn.seen = seen; return fn; };

  it('returns what the site says, and sends our name, the wanted type and no redirects of its own', async () => {
    const fetchImpl = script(reply(200, '<rss/>', { 'content-type': 'application/rss+xml', etag: '"abc"' }));
    const res = await safeFetch('https://example.com/feed.xml', { fetchImpl, headers: { accept: 'application/rss+xml', 'if-none-match': '"abc"' } });
    assert.deepEqual([res.status, res.text, res.headers.get('etag')], [200, '<rss/>', '"abc"']);
    const { init } = fetchImpl.seen[0];
    assert.match(init.headers['user-agent'], /^ChillFlowBot\//);
    assert.equal(init.headers.accept, 'application/rss+xml');
    assert.equal(init.headers['if-none-match'], '"abc"');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.dispatcher && init.signal);
  });

  it('hands back a 304 or an error status for the caller to decide about', async () => {
    assert.equal((await safeFetch('https://example.com/a', { fetchImpl: script(reply(304, null)) })).status, 304);
    assert.equal((await safeFetch('https://example.com/a', { fetchImpl: script(reply(404, 'nope')) })).status, 404);
    assert.equal((await safeFetch('https://example.com/a', { fetchImpl: script(reply(500, 'oops')) })).status, 500);
  });

  it('follows redirects by hand, checking every hop, and reports where it ended up', async () => {
    const fetchImpl = script(reply(301, null, { location: 'https://www.example.com/new' }), reply(302, null, { location: '/final' }), reply(200, 'ok'));
    const res = await safeFetch('https://example.com/old', { fetchImpl });
    assert.equal(res.url, 'https://www.example.com/final');
    assert.deepEqual(fetchImpl.seen.map((s) => s.url), ['https://example.com/old', 'https://www.example.com/new', 'https://www.example.com/final']);
  });

  it('a redirect can never leave https, reach a raw or private address, or go round in circles', async () => {
    for (const location of ['http://example.com/x', 'https://127.0.0.1/admin', 'https://169.254.169.254/latest/meta-data/', 'https://localhost:9000/', 'ftp://example.com/', 'https://user:pw@example.com/']) {
      await assert.rejects(safeFetch('https://example.com/a', { fetchImpl: script(reply(302, null, { location })) }), (e) => e.code === 'EREDIRECT' && /not allowed/.test(e.message), location);
    }
    const loop = () => reply(302, null, { location: 'https://example.com/again' });
    await assert.rejects(safeFetch('https://example.com/a', { fetchImpl: script(loop, loop, loop, loop, loop) }), (e) => e.code === 'EREDIRECT' && /too many times/.test(e.message));
    await assert.rejects(safeFetch('https://example.com/a', { fetchImpl: script(reply(302, null)) }), /without saying where/);
  });

  it('stops reading a body that is too big — by its label, and by what actually arrives', async () => {
    await assert.rejects(safeFetch('https://example.com/a', { maxBytes: 1000, fetchImpl: script(reply(200, 'x', { 'content-length': '5000' })) }), (e) => e.code === 'ETOOBIG');
    const endless = () => ({
      status: 200, headers: new Headers(),
      body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(400)); }, cancel() { endless.cancelled = true; } }),
    });
    await assert.rejects(safeFetch('https://example.com/a', { maxBytes: 1000, fetchImpl: script(endless) }), (e) => e.code === 'ETOOBIG' && /bigger than/.test(e.message));
    const big = await safeFetch('https://example.com/a', { maxBytes: 1000, fetchImpl: script(reply(200, 'y'.repeat(1000))) });
    assert.equal(big.body.length, 1000, 'exactly the limit is fine');
  });

  it('gives up on a site that is too slow, whether it never answers or never finishes', async () => {
    const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    await assert.rejects(safeFetch('https://example.com/a', { timeoutMs: 40, fetchImpl: script(hang) }), (e) => e.code === 'ETIMEOUT' && /too long/.test(e.message));
    const drip = () => ({ status: 200, headers: new Headers(), body: new ReadableStream({ pull: () => new Promise(() => {}) }) });
    await assert.rejects(safeFetch('https://example.com/a', { timeoutMs: 40, fetchImpl: script(drip) }), (e) => e.code === 'ETIMEOUT');
  });

  it('turns network failures into plain sentences', async () => {
    const fails = (code, message = 'fetch failed') => () => { throw Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) }); };
    await assert.rejects(safeFetch('https://example.com/a', { fetchImpl: fails('ECONNREFUSED') }), /did not accept the connection/);
    await assert.rejects(safeFetch('https://example.com/a', { fetchImpl: fails('ENOTFOUND') }), /could not be found/);
    await assert.rejects(safeFetch('https://example.com/a', { fetchImpl: fails('DEPTH_ZERO_SELF_SIGNED_CERT') }), /certificate is not valid/);
    await assert.rejects(safeFetch('https://example.com/a', { fetchImpl: fails('EWEIRD') }), /could not be reached/);
  });
});
