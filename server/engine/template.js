// {{path.to.value | filter}} rendering. Single pass, so values that come from users are never re-evaluated,
// and lookups only follow own properties so nothing can reach prototypes or functions.
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = Object.prototype.hasOwnProperty;
/** A lookup that only finds what the table itself holds — never `constructor`, `toString` or `__proto__`. */
const own = (table, key) => (hasOwn.call(table, key) ? table[key] : undefined);

export function getPath(obj, path) {
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').map((p) => p.trim()).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || BLOCKED.has(p) || !hasOwn.call(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function stringify(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(stringify).join(', ');
  try { return JSON.stringify(v).slice(0, 2000); } catch { return ''; }
}

const FILTERS = {
  upper: (v) => stringify(v).toUpperCase(),
  lower: (v) => stringify(v).toLowerCase(),
  trim: (v) => stringify(v).trim(),
  length: (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : stringify(v).length),
  json: (v) => JSON.stringify(v) ?? '',
};

// ---- maths: {{guild.vars.joins | default:0 | add:1 | commas}} ------------------------------------------------------------
// A missing or empty value counts as 0 (like Set Variable's "Add"). Anything that cannot be calculated — text that is not a number,
// dividing by zero, a result that is not a finite number — leaves the value as it was: a template has no error channel (the Math
// block reports problems properly).
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;
const num = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && NUMBER.test(v.trim())) return Number(v);
  return Number.NaN;
};
/** 0.1 + 0.2 should read 0.3, not 0.30000000000000004. */
const tidy = (n) => (Object.is(n, -0) ? 0 : Number(n.toPrecision(12)));
const digits = (arg, fallback) => { const n = Number.parseInt(arg, 10); return Number.isInteger(n) ? Math.min(10, Math.max(0, n)) : fallback; };

const BINARY = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b,
  div: (a, b) => (b === 0 ? Number.NaN : a / b), mod: (a, b) => (b === 0 ? Number.NaN : a % b),
  min: Math.min, max: Math.max,
};
const UNARY = { abs: Math.abs, floor: Math.floor, ceil: Math.ceil };
const COMMAS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });

/** The argument of a maths filter: a number, or the path of a variable (`add:var.bonus`). */
const argument = (arg, scope) => (NUMBER.test(arg) ? Number(arg) : num(getPath(scope, arg)));

function applyMath(value, name, arg, scope) {
  const a = num(value);
  if (Number.isNaN(a)) return value;
  let result;
  if (BINARY[name]) {
    const b = argument(arg, scope);
    if (Number.isNaN(b)) return value;
    result = BINARY[name](a, b);
  } else if (UNARY[name]) {
    result = UNARY[name](a);
  } else if (name === 'round') {
    const d = digits(arg, 0);
    result = Math.round(a * 10 ** d) / 10 ** d;
  } else {
    return name === 'fixed' ? tidy(a).toFixed(digits(arg, 2)) : COMMAS.format(tidy(a)); // fixed:N and commas produce text
  }
  return Number.isFinite(result) ? tidy(result) : value;
}
const MATH_FILTERS = new Set([...Object.keys(BINARY), ...Object.keys(UNARY), 'round', 'fixed', 'commas']);

// ---- text and lists: {{option.reason | truncate:100}}, {{var.winners | random}}, {{member.joinedAt | date:R}} -----------------
/** What comes after the colon, split at commas: `replace:cat,dog`. Quotes keep commas and spaces: `replace:", "," · "`. */
function parseArgs(arg) {
  const out = [];
  let i = 0;
  while (i < arg.length) {
    while (arg[i] === ' ') i += 1;
    const quote = arg[i] === '"' || arg[i] === "'" ? arg[i] : '';
    const close = quote ? arg.indexOf(quote, i + 1) : -1;
    if (close !== -1) {
      out.push(arg.slice(i + 1, close));
      i = arg.indexOf(',', close + 1);
      if (i === -1) break;
      i += 1;
    } else {
      const end = arg.indexOf(',', i);
      out.push(arg.slice(i, end === -1 ? arg.length : end).trim());
      if (end === -1) break;
      i = end + 1;
    }
  }
  return out;
}

/** A value as a list: a list stays one, text is split like the Loop block's list (a JSON array, or one item per line or comma). */
export function toList(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  if (typeof v !== 'string') return [v];
  const t = v.trim();
  if (t.startsWith('[')) {
    try { const arr = JSON.parse(t); if (Array.isArray(arr)) return arr; } catch { /* not JSON: split it as text */ }
  }
  return t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

/** A whole number for `truncate:N` / `at:N`: written out, or the path of a variable (`at:loop.index`). */
const wholeArg = (arg, scope) => { const n = argument(arg, scope); return Number.isFinite(n) ? Math.trunc(n) : Number.NaN; };

/** A moment as Unix seconds: a date, an ISO date (`member.joinedAt`), or a number of seconds or milliseconds. NaN when it is none of those. */
function toSeconds(v) {
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number' || (typeof v === 'string' && NUMBER.test(v.trim()))) {
    const n = Number(v);
    return Math.floor(Math.abs(n) >= 1e11 ? n / 1000 : n); // 13 digits is milliseconds
  }
  if (typeof v !== 'string' || !v.trim()) return Number.NaN;
  return Math.floor(Date.parse(v.trim()) / 1000);
}
// Discord shows <t:seconds:style> in each reader's own time zone and language.
const DATE_STYLES = { t: 't', T: 'T', d: 'd', D: 'D', f: 'f', F: 'F', R: 'R', relative: 'R', time: 't', short: 'f', long: 'F' };

const TEXT_FILTERS = {
  capitalize: (v) => { const s = stringify(v); return s.charAt(0).toUpperCase() + s.slice(1); },
  replace: (v, arg) => { const [from = '', to = ''] = parseArgs(arg); return from === '' ? v : stringify(v).split(from).join(to); },
  truncate: (v, arg, scope) => {
    const max = arg === '' ? 100 : wholeArg(arg, scope);
    const chars = [...stringify(v)]; // by character, so an emoji is never cut in half
    if (!(max >= 1) || chars.length <= max) return v;
    return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
  },
  split: (v, arg) => {
    if (Array.isArray(v)) return v;
    const [sep = ','] = parseArgs(arg);
    return stringify(v).split(sep === '' ? ',' : sep).map((x) => x.trim()).filter(Boolean);
  },
  join: (v, arg) => { const [sep = ', '] = arg === '' ? [] : parseArgs(arg); return toList(v).map(stringify).join(sep); },
  first: (v) => toList(v)[0],
  last: (v) => toList(v).at(-1),
  at: (v, arg, scope) => { const n = wholeArg(arg, scope); return Number.isNaN(n) || n === 0 ? undefined : toList(v).at(n > 0 ? n - 1 : n); }, // 1 = the first, -1 = the last
  random: (v) => { const items = toList(v); return items[Math.floor(Math.random() * items.length)]; },
  date: (v, arg) => {
    const seconds = toSeconds(v);
    if (!Number.isFinite(seconds)) return v;
    if (arg === 'unix') return seconds;
    if (arg === 'iso') return new Date(seconds * 1000).toISOString();
    return `<t:${seconds}:${own(DATE_STYLES, arg) ?? 'f'}>`;
  },
};

function applyFilter(value, filter, scope) {
  const i = filter.indexOf(':');
  const name = (i === -1 ? filter : filter.slice(0, i)).trim();
  const arg = i === -1 ? '' : filter.slice(i + 1).trim();
  if (name === 'default') return value === undefined || value === null || value === '' ? arg : value;
  if (MATH_FILTERS.has(name)) return applyMath(value, name, arg, scope);
  const textFilter = own(TEXT_FILTERS, name);
  if (textFilter) return textFilter(value, arg, scope);
  const plain = own(FILTERS, name);
  return plain ? plain(value) : value; // an unknown filter (or `__proto__`) changes nothing
}

/** Every filter name, for the editor's hints and the docs. */
export const FILTER_NAMES = ['default', ...Object.keys(FILTERS), ...Object.keys(TEXT_FILTERS), ...MATH_FILTERS];

export function renderTemplate(str, scope) {
  if (typeof str !== 'string' || !str.includes('{{')) return str;
  return str.replace(TOKEN, (_m, inner) => {
    const [path, ...filters] = inner.split('|');
    let value = getPath(scope, path.trim());
    for (const f of filters) value = applyFilter(value, f, scope);
    return stringify(value);
  });
}

/** Render every string inside plain data (arrays / objects), leaving other types untouched. */
export function renderDeep(value, scope) {
  if (typeof value === 'string') return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, scope);
    return out;
  }
  return value;
}
