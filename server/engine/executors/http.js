// The HTTP Request block. Flows reach the outside world only through here, and only when the bot operator has switched it on:
// every request goes through the guarded fetcher (https, public addresses only, checked on every connection and every redirect,
// a time limit and a size limit), is counted per server, and its answer comes back as plain, bounded data.
import { HTTP_MAX_HEADERS, HTTP_METHODS } from '../../../shared/nodes/connect.js';
import { parseSafeUrl, SafeFetchError } from '../../net/safe-fetch.js';
import { FlowError } from '../errors.js';
import { cleanText, shapeValue } from '../shape.js';

export const HTTP_MAX_BYTES = 512 * 1024;
export const HTTP_TIMEOUT_MS = 10_000;
const TEXT_MAX = 4000;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Set by the connection itself, or a way to talk to something other than the site in the address.
const FORBIDDEN_HEADERS = /^(host|content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|expect|proxy-.*|x-forwarded-.*|forwarded)$/i;
const BODY_TYPES = { json: 'application/json', form: 'application/x-www-form-urlencoded', text: 'text/plain; charset=utf-8' };

/** Is this website on the operator's list? An empty list allows every public site; `*.example.com` covers example.com and everything under it. */
export function hostAllowed(hostname, allowed = []) {
  if (!allowed.length) return true;
  const host = String(hostname).toLowerCase();
  return allowed.some((rule) => (rule.startsWith('*.') ? host === rule.slice(2) || host.endsWith(rule.slice(1)) : host === rule));
}

function headersOf(d) {
  const headers = {};
  if ((d.headers || []).length > HTTP_MAX_HEADERS) throw new FlowError(`At most ${HTTP_MAX_HEADERS} headers can be sent.`);
  for (const h of d.headers || []) {
    const name = String(h?.name ?? '').trim();
    const value = String(h?.value ?? '').trim();
    if (!name) continue;
    if (!HEADER_NAME.test(name)) throw new FlowError(`“${name.slice(0, 40)}” is not a valid header name.`);
    if (FORBIDDEN_HEADERS.test(name)) throw new FlowError(`The header “${name}” cannot be set.`);
    // a line break in a header value could smuggle in a second header
    if (/[\u0000-\u001F\u007F]/.test(value) || value.length > 4000) throw new FlowError(`The value of the header “${name}” has a line break or is too long.`);
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

export const httpExecutors = {
  async 'action.http.request'({ ctx, d }) {
    const http = ctx.services.http;
    if (!http?.enabled) throw new FlowError('The HTTP Request block is switched off on this bot. The bot operator can switch it on with ENABLE_HTTP_REQUEST=true.');
    const method = String(d.method || 'GET').toUpperCase();
    if (!HTTP_METHODS.includes(method)) throw new FlowError(`Unknown method “${method}”.`);
    let url;
    try { url = parseSafeUrl(d.url); } catch (err) { throw new FlowError(err.message); }
    if (!hostAllowed(url.hostname, http.allowedHosts)) throw new FlowError(`Requests to ${url.hostname} are not allowed on this bot: the operator’s list of websites (HTTP_REQUEST_ALLOWED_HOSTS) does not have it.`);
    const headers = headersOf(d);
    let body;
    if (method !== 'GET' && d.bodyType && d.bodyType !== 'none') {
      if (!BODY_TYPES[d.bodyType]) throw new FlowError(`Unknown kind of content “${d.bodyType}”.`);
      body = String(d.body ?? '');
      if (d.bodyType === 'json') {
        try { JSON.parse(body); } catch { throw new FlowError('“What to send” is not valid JSON once the variables are filled in. Write values as {{name | json}}, without quotes around them.'); }
      }
      headers['content-type'] ??= BODY_TYPES[d.bodyType];
    }
    if (!http.limiter.take(ctx.guild.id)) throw new FlowError('This server is sending too many HTTP requests — wait a minute.');

    let res;
    try {
      res = await http.fetch(url.href, { method, headers, body, maxBytes: HTTP_MAX_BYTES, timeoutMs: HTTP_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof SafeFetchError) throw new FlowError(err.message);
      throw new FlowError(`The site could not be reached (${String(err?.message ?? err).slice(0, 80)}).`);
    }
    const type = String(res.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const raw = res.text ?? '';
    let parsed = {};
    if (/json/.test(type) || /^\s*[[{]/.test(raw)) {
      try { parsed = shapeValue(JSON.parse(raw)); } catch { /* not JSON after all: the text is still there */ }
    }
    // What the site said is only ever data: a {{…}} in it is shown as written, never filled in.
    ctx.data.http = { status: res.status, ok: res.status >= 200 && res.status < 300, text: cleanText(raw, TEXT_MAX), body: parsed, type };
    if (d.failOnError && res.status >= 400) throw new FlowError(`The site answered with an error (status ${res.status}).`);
  },
};
