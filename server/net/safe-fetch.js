// The ONLY way this server fetches an address that a person typed in (a feed, later a platform API). Flows never fetch anything themselves.
//
// Why so careful: on a shared host, "fetch this address for me" is how an attacker reaches things only the server can reach — its own
// admin ports, cloud metadata (169.254.169.254), other machines on the private network. So:
//   - https only, on the standard port, no user:password in the address, a real website name (no raw IP, no "localhost");
//   - the name is resolved by OUR lookup, and if ANY answer is not a public address the connection is refused; the connection then uses
//     the very address we checked, so a name that answers "public" once and "private" the next time cannot get through (DNS rebinding);
//   - redirects are followed by hand, each hop checked again; a redirect can never leave https or reach a private address;
//   - the whole exchange has a time limit and the body a size limit, counted AFTER decompression (a small download that unpacks to
//     gigabytes is cut off too).
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { FeedSettingError, parsePublicHttpsUrl } from '../../shared/feeds.js';

/** A problem with an address or an answer, worded so it can be shown as it is. */
export class SafeFetchError extends Error {
  constructor(message, code = 'EFETCH') { super(message); this.code = code; }
}

export const DEFAULTS = { maxBytes: 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3, userAgent: 'ChillFlowBot/1.0 (+https://github.com/itsmemusicchilly/Chill-Flow-Bot)' };

// ---- which addresses count as "public" ---------------------------------------------------------------------------------------
function v4Bytes(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((n) => n <= 255) ? b : null;
}

function v6Bytes(input) {
  let s = input.toLowerCase();
  if (s.includes('%')) return null; // a zone id ("fe80::1%eth0") is a local address by definition
  let tail = [];
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) {
    const v4 = v4Bytes(dotted[1]);
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, -dotted[1].length) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

const V4_PRIVATE = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4], // 240/4 also holds 255.255.255.255
];
function inV4(b, [base, bits]) {
  let left = bits;
  for (let i = 0; i < 4 && left > 0; i += 1, left -= 8) {
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((b[i] & mask) !== (base[i] & mask)) return false;
  }
  return true;
}
const isPublicV4 = (b) => !V4_PRIVATE.some((r) => inV4(b, r));

function isPublicV6(b) {
  const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicV4(b.slice(12)); // ::ffff:a.b.c.d — an IPv4 address in disguise
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isPublicV4(b.slice(12)); // 64:ff9b::/96 (NAT64)
  if ((b[0] & 0xe0) !== 0x20) return false; // only global unicast (2000::/3) can be public: ::1, fc00::/7, fe80::/10, ff00::/8, ::/… are all out
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] < 0x02) return false; // 2001::/23: Teredo and other special purposes
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x02) return false; // 2002::/16 (6to4) carries an IPv4 address inside
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return false; // 3fff::/20 documentation
  return true;
}

/** Is this text an IP address that anyone on the internet can reach (not private, loopback, link-local, reserved, multicast …)? */
export function isPublicAddress(ip) {
  const s = String(ip ?? '');
  if (net.isIPv4(s)) { const b = v4Bytes(s); return Boolean(b) && isPublicV4(b); }
  if (net.isIPv6(s)) { const b = v6Bytes(s); return Boolean(b) && isPublicV6(b); }
  return false;
}

// ---- the guarded lookup used for every connection -----------------------------------------------------------------------------
/**
 * A `lookup` for net.connect: resolves the name and refuses when ANY answer is not public. Pass the real resolver, or a fake one in tests.
 * Called for every connection, so a name cannot be public when we check it and private when we connect.
 */
export function createGuardedLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'function' ? {} : options ?? {};
    const done = typeof options === 'function' ? options : callback;
    resolve(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
      if (err) return done(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }];
      if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
        return done(new SafeFetchError('That address points to a private or internal network, so it is not allowed.', 'EBLOCKED'));
      }
      return opts.all ? done(null, list) : done(null, list[0].address, list[0].family);
    });
  };
}

export function createSafeAgent({ resolve } = {}) {
  return new Agent({ connect: { lookup: createGuardedLookup(resolve) }, headersTimeout: DEFAULTS.timeoutMs, bodyTimeout: DEFAULTS.timeoutMs });
}
let sharedAgent = null;
const defaultAgent = () => (sharedAgent ??= createSafeAgent());

// ---- the address itself -------------------------------------------------------------------------------------------------------
/** Checks an address a person typed and returns it as a URL, or throws a SafeFetchError that says what is wrong. (The rules are shared with the editor.) */
export function parseSafeUrl(input) {
  try { return parsePublicHttpsUrl(input); } catch (err) {
    if (err instanceof FeedSettingError) throw new SafeFetchError(err.message, 'EBADURL');
    throw err;
  }
}

// ---- the request ---------------------------------------------------------------------------------------------------------------
const REDIRECT = new Set([301, 302, 303, 307, 308]);

async function readLimited(res, maxBytes, controller) {
  const tooBig = () => { const err = new SafeFetchError(`That answer is bigger than ${Math.round(maxBytes / 1024)} KB, so it was not read.`, 'ETOOBIG'); controller.abort(err); return err; };
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  if (!res.body) return Buffer.alloc(0);
  const read = async () => {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw tooBig();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  };
  // The time limit must end the read even if the body never produces another byte (or the HTTP library does not notice the abort).
  const { signal } = controller;
  const timedOut = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  timedOut.catch(() => {});
  return Promise.race([read(), timedOut]);
}

const friendly = (err) => {
  if (err instanceof SafeFetchError) return err;
  const code = err?.cause?.code ?? err?.code;
  if (code === 'EBLOCKED' || err?.cause instanceof SafeFetchError) return err.cause instanceof SafeFetchError ? err.cause : new SafeFetchError('That address points to a private or internal network, so it is not allowed.', 'EBLOCKED');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT/.test(String(code))) return new SafeFetchError('The site took too long to answer.', 'ETIMEOUT');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new SafeFetchError('That website name could not be found.', 'ENOTFOUND');
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return new SafeFetchError('The site did not accept the connection.', 'ECONN');
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(code))) return new SafeFetchError('The site’s security certificate is not valid.', 'ETLS');
  return new SafeFetchError(`The site could not be reached (${String(err?.message ?? err).slice(0, 80)}).`, 'EFETCH');
};

/**
 * GET (or POST) an https address safely.
 * @returns {Promise<{status: number, url: string, headers: Headers, body: Buffer, text: string}>} any status the site answers with (the caller decides what a 304 or 404 means)
 * @throws {SafeFetchError} for anything that is not allowed, too big, too slow or unreachable
 */
export async function safeFetch(address, { method = 'GET', headers = {}, body, maxBytes = DEFAULTS.maxBytes, timeoutMs = DEFAULTS.timeoutMs, maxRedirects = DEFAULTS.maxRedirects, agent = defaultAgent(), fetchImpl = undiciFetch, userAgent = DEFAULTS.userAgent } = {}) {
  let url = parseSafeUrl(address);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The site took too long to answer.', 'TimeoutError')), timeoutMs);
  try {
    for (let hop = 0; ; hop += 1) {
      let res;
      try {
        res = await fetchImpl(url.href, { method, headers: { 'user-agent': userAgent, accept: '*/*', ...headers }, body, redirect: 'manual', dispatcher: agent, signal: controller.signal });
      } catch (err) { throw friendly(err); }
      if (REDIRECT.has(res.status)) {
        const where = res.headers.get('location');
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        if (!where) throw new SafeFetchError('The site redirected without saying where to.', 'EREDIRECT');
        if (hop >= maxRedirects) throw new SafeFetchError('The address redirects too many times.', 'EREDIRECT');
        try { url = parseSafeUrl(new URL(where, url).href); } catch (err) {
          throw new SafeFetchError(`The address redirects somewhere that is not allowed: ${err.message}`, 'EREDIRECT');
        }
        continue;
      }
      let bytes;
      try { bytes = await readLimited(res, maxBytes, controller); } catch (err) { throw friendly(err); }
      return { status: res.status, url: url.href, headers: res.headers, body: bytes, text: bytes.toString('utf8') };
    }
  } finally { clearTimeout(timer); }
}
