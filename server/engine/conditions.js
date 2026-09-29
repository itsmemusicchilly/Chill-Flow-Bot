import { safeRegexTest } from './safe-regex.js';

const isNumeric = (s) => typeof s === 'string' && s.trim() !== '' && Number.isFinite(Number(s));
const lc = (s) => String(s ?? '').toLowerCase();

/** Compare two already-rendered strings. String checks ignore case; numbers compare numerically. */
export function evalCondition(op, left, right) {
  const l = String(left ?? '');
  const r = String(right ?? '');
  switch (op) {
    case 'equals': return isNumeric(l) && isNumeric(r) ? Number(l) === Number(r) : lc(l) === lc(r);
    case 'notEquals': return !evalCondition('equals', l, r);
    case 'contains': return lc(l).includes(lc(r));
    case 'notContains': return !lc(l).includes(lc(r));
    case 'startsWith': return lc(l).startsWith(lc(r));
    case 'endsWith': return lc(l).endsWith(lc(r));
    case 'gt': return isNumeric(l) && isNumeric(r) && Number(l) > Number(r);
    case 'gte': return isNumeric(l) && isNumeric(r) && Number(l) >= Number(r);
    case 'lt': return isNumeric(l) && isNumeric(r) && Number(l) < Number(r);
    case 'lte': return isNumeric(l) && isNumeric(r) && Number(l) <= Number(r);
    case 'matches': return safeRegexTest(r, l);
    case 'isEmpty': return l.trim() === '';
    case 'isNotEmpty': return l.trim() !== '';
    default: return false;
  }
}

export function evalConditions(match, conditions) {
  const results = (conditions || []).map((c) => evalCondition(c.op, c.left, c.right));
  if (!results.length) return false;
  return match === 'any' ? results.some(Boolean) : results.every(Boolean);
}
