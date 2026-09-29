// Tiny field DSL shared by node definitions (catalog.js) and page blocks (blocks.js), plus the one field checker
// both editors use. Fields are plain data: the inspector renders them, validation reads them.
import { isBlank } from './util.js';

export const pairs = (arr) => arr.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: x }));
export const text = (key, label, o = {}) => ({ type: 'text', key, label, default: '', ...o });
export const area = (key, label, o = {}) => ({ type: 'textarea', key, label, default: '', ...o });
export const num = (key, label, o = {}) => ({ type: 'number', key, label, default: '', ...o });
export const bool = (key, label, o = {}) => ({ type: 'boolean', key, label, default: false, ...o });
export const color = (key, label, o = {}) => ({ type: 'color', key, label, default: '#5865f2', ...o });
export const select = (key, label, options, o = {}) => {
  const opts = pairs(options);
  return { type: 'select', key, label, options: opts, default: opts[0].value, ...o };
};
export const multi = (key, label, options, o = {}) => ({ type: 'multiselect', key, label, options: pairs(options), default: [], ...o });
export const idField = (key, label, kind, o = {}) => ({ type: 'id', kind, key, label, default: '', ...o });
// Lists are unlimited unless Discord (or the page format) itself caps them: then the definition passes an explicit `max`.
export const list = (key, label, item, o = {}) => ({ type: 'list', key, label, item, default: [], max: Infinity, ...o });
export const when = (key, ...values) => ({ key, in: values });
export const whenNot = (key, ...values) => ({ key, notIn: values });

export function isVisible(field, data) {
  const s = field.showIf;
  if (!s) return true;
  const v = data?.[s.key];
  if (s.in) return s.in.includes(v);
  if (s.notIn) return !s.notIn.includes(v);
  return true;
}

export const VAR_NAME_RE = /^[A-Za-z_][\w-]{0,31}$/;

export function defaultsForFields(fields) {
  const out = {};
  for (const f of fields || []) out[f.key] = structuredClone(f.default);
  return out;
}

const isTemplate = (v) => typeof v === 'string' && v.includes('{{');
const toNumber = (v) => (typeof v === 'number' ? v : Number(v));

/** Report problems with the values of visible fields (required, ranges, options, list sizes) through `push(message)`. */
export function checkFields(fields, data, prefix, push) {
  for (const f of fields) {
    if (!isVisible(f, data)) continue;
    const v = data[f.key];
    const name = `${prefix}“${f.label}”`;
    if (f.type === 'list') {
      const items = Array.isArray(v) ? v : [];
      if (items.length > (f.max ?? Infinity)) push(`${name}: at most ${f.max} items.`);
      items.forEach((item, i) => checkFields(f.item.fields, item || {}, `${prefix}${f.label} #${i + 1} · `, push));
      continue;
    }
    if (f.required && (f.type === 'multiselect' ? !(v || []).length : isBlank(v))) { push(`${name} is required.`); continue; }
    if (isBlank(v)) continue;
    if (f.type === 'text' && f.pattern === 'var' && !isTemplate(v) && !VAR_NAME_RE.test(v)) {
      push(`${name} must be letters, numbers, - or _ (max 32) and not start with a number.`);
    }
    if (f.type === 'number' && !isTemplate(v)) {
      const n = toNumber(v);
      if (!Number.isFinite(n)) push(`${name} must be a number.`);
      else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
        push(`${name} must be between ${f.min ?? '−∞'} and ${f.max ?? '∞'}.`);
      }
    }
    if (f.type === 'select' && !f.options.some((o) => o.value === v)) push(`${name} has an invalid value.`);
  }
}
