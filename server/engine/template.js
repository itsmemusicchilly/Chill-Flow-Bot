// {{path.to.value | filter}} rendering. Single pass, so values that come from users are never re-evaluated,
// and lookups only follow own properties so nothing can reach prototypes or functions.
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = Object.prototype.hasOwnProperty;

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

function applyFilter(value, filter, scope) {
  const i = filter.indexOf(':');
  const name = (i === -1 ? filter : filter.slice(0, i)).trim();
  const arg = i === -1 ? '' : filter.slice(i + 1).trim();
  if (name === 'default') return value === undefined || value === null || value === '' ? arg : value;
  if (MATH_FILTERS.has(name)) return applyMath(value, name, arg, scope);
  return FILTERS[name] ? FILTERS[name](value) : value;
}

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
