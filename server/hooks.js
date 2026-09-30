// POST /hooks/<token> — the address behind a "Webhook Received" trigger. Anything can call it (Zapier, IFTTT, Make, StreamElements, GitHub …);
// knowing the token is the permission, and it can be replaced from the editor at any time.
//
// It is public and unauthenticated, so it is the most exposed door in the app and is kept small and strict:
//   - it is mounted BEFORE the dashboard's JSON parser and reads at most a few KB itself (physical ceiling 256 KB, or LIMIT_WEBHOOK_BYTES);
//   - the method, token and rate limits are checked before a single byte of the body is read;
//   - what the caller sends is reshaped into plain data (depth, key count, string length and array length capped, `__proto__` and friends
//     dropped) and is only ever DATA: a template inside it is never evaluated, and pings stay off unless a node opts in;
//   - it answers at once and the flow runs in the background; nothing about the flow's result is returned.
import express from 'express';
import { LIMITS } from '../shared/limits.js';
import { RateLimiter } from './engine/rate-limit.js';

export const MAX_BODY_BYTES = 256 * 1024; // whatever the operator allows, never more than this
export const DEFAULT_BODY_BYTES = 64 * 1024;
const MAX_DEPTH = 6;
const MAX_KEYS = 200;
const MAX_ITEMS = 50;
const MAX_STRING = 2000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SKIP = new Set(['__proto__', 'constructor', 'prototype']);
const UNSAFE = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F${String.fromCharCode(0x2028, 0x2029)}\\u202A-\\u202E\\u2066-\\u2069]`, 'g');

const cleanText = (s) => String(s).replace(UNSAFE, '').slice(0, MAX_STRING);

/** Reshape anything a caller sent into plain, bounded data: only strings, finite numbers, booleans, arrays and plain objects survive. */
export function shapeValue(v, budget = { keys: 0 }, depth = 0) {
  switch (typeof v) {
    case 'string': return cleanText(v);
    case 'number': return Number.isFinite(v) ? v : '';
    case 'boolean': return v;
    case 'object': {
      if (v === null || depth >= MAX_DEPTH) return '';
      if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => shapeValue(x, budget, depth + 1));
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (SKIP.has(k) || k.length > 64 || budget.keys >= MAX_KEYS) continue;
        budget.keys += 1;
        out[k] = shapeValue(x, budget, depth + 1);
      }
      return out;
    }
    default: return '';
  }
}

/** What a flow gets as `{{webhook.*}}`. */
export function shapePayload(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const raw = req.body;
  const body = raw === undefined || (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !Object.keys(raw).length) ? {} : shapeValue(raw);
  const text = typeof raw === 'string' ? cleanText(raw) : Object.keys(body).length || Array.isArray(body) ? cleanText(JSON.stringify(body)) : '';
  const query = {};
  let n = 0;
  for (const [k, v] of new URL(req.originalUrl, 'http://localhost').searchParams) { if (n >= 50) break; if (!SKIP.has(k) && k.length <= 64) { query[k] = cleanText(v); n += 1; } }
  return { body: typeof body === 'string' ? {} : body, text, query, method: req.method, contentType: type };
}

function parseBody(req, res, limit) {
  const parsers = [
    express.json({ limit, strict: false, type: ['application/json', 'application/*+json'] }),
    express.urlencoded({ extended: false, limit, parameterLimit: 200, type: 'application/x-www-form-urlencoded' }),
    express.text({ limit, type: 'text/*' }),
  ];
  return new Promise((resolve, reject) => {
    const next = (i) => (i === parsers.length ? resolve() : parsers[i](req, res, (err) => (err ? reject(err) : next(i + 1))));
    next(0);
  });
}

export function createHooks({ db, runtime, now = () => Date.now() }) {
  const router = express.Router();
  const perIp = new RateLimiter(3000, 60_000); // physical ceilings; the operator can tighten the per-address one with LIMIT_WEBHOOKS_PER_MINUTE
  const perToken = new RateLimiter(() => Math.min(600, LIMITS.webhooksPerMinute), 60_000);
  const wrong = new RateLimiter(60, 60_000); // guessing addresses
  const lastTouch = new Map();

  router.all('/:token', async (req, res, next) => {
    try {
      res.set({ 'Cache-Control': 'no-store', Allow: 'POST' });
      const reply = (status, error) => res.status(status).json(error ? { error } : { ok: true });
      if (!perIp.take(req.ip)) return reply(429, 'Too many requests.');
      if (req.method !== 'POST') return reply(405, 'Send a POST request.');
      const { token } = req.params;
      const hook = TOKEN.test(token) ? db.webhookByToken(token) : null;
      if (!hook) return wrong.take(req.ip) ? reply(404, 'Not found.') : reply(429, 'Too many requests.');
      if (!perToken.take(token)) { res.set('Retry-After', '60'); return reply(429, 'Too many requests.'); }

      const empty = req.headers['content-length'] === '0'; // a bare ping with nothing in it is fine, whatever its content type says
      if (!empty && req.is(['json', 'application/*+json', 'urlencoded', 'text/*']) === false) return reply(415, 'Send JSON, form fields or plain text.');
      const limit = Math.min(MAX_BODY_BYTES, Number.isFinite(LIMITS.webhookBytes) ? LIMITS.webhookBytes : DEFAULT_BODY_BYTES);
      await parseBody(req, res, limit); // too big → 413, malformed JSON → 400 (the app's error handler)

      const result = await runtime.fireWebhook(hook.guildId, hook.flowId, hook.nodeId, shapePayload(req));
      if (!result.ok) {
        if (result.reason === 'busy') { res.set('Retry-After', '10'); return reply(429, 'Too many runs right now; try again in a moment.'); }
        if (result.reason === 'offline') return reply(503, 'The bot is not connected right now.');
        return reply(409, 'That flow is switched off, or its trigger is not active.');
      }
      const t = now();
      if (t - (lastTouch.get(token) ?? 0) > 30_000) { lastTouch.set(token, t); db.touchWebhook(token, t); if (lastTouch.size > 5000) lastTouch.clear(); }
      return reply(202);
    } catch (err) { return next(err); }
  });
  return { router };
}
