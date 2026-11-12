// Reshaping data that came from outside (a webhook call, a website's answer) into plain, bounded data a flow can read as {{…}}.
// Only strings, finite numbers, booleans, arrays and plain objects survive; depth, key count, list length and string length are capped,
// and `__proto__` and friends are dropped. What comes out is only ever DATA: a template inside it is never evaluated.
const MAX_DEPTH = 6;
const MAX_KEYS = 200;
const MAX_ITEMS = 50;
const MAX_STRING = 2000;
const SKIP = new Set(['__proto__', 'constructor', 'prototype']);
const UNSAFE = new RegExp(`[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F${String.fromCharCode(0x2028, 0x2029)}\\u202A-\\u202E\\u2066-\\u2069]`, 'g');

export const cleanText = (s, max = MAX_STRING) => String(s).replace(UNSAFE, '').slice(0, max);

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
