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
  round: (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : v),
};

function applyFilter(value, filter) {
  const i = filter.indexOf(':');
  const name = (i === -1 ? filter : filter.slice(0, i)).trim();
  const arg = i === -1 ? '' : filter.slice(i + 1).trim();
  if (name === 'default') return value === undefined || value === null || value === '' ? arg : value;
  return FILTERS[name] ? FILTERS[name](value) : value;
}

export function renderTemplate(str, scope) {
  if (typeof str !== 'string' || !str.includes('{{')) return str;
  return str.replace(TOKEN, (_m, inner) => {
    const [path, ...filters] = inner.split('|');
    let value = getPath(scope, path.trim());
    for (const f of filters) value = applyFilter(value, f);
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
