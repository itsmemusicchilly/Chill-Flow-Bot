// Regexes come from server admins and run against text from anyone, so a catastrophic pattern could freeze
// the whole shared bot. Every match runs inside a vm with a hard timeout.
import vm from 'node:vm';

const sandbox = vm.createContext({ re: null, s: '' });
const script = new vm.Script('re.test(s)');
const cache = new Map();

export const MAX_PATTERN = 200;
export const MAX_INPUT = 2000;
export const REGEX_TIMEOUT_MS = 40;

function compile(pattern, flags) {
  const key = `${flags}/${pattern}`;
  let re = cache.get(key);
  if (!re) {
    re = new RegExp(pattern, flags);
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, re);
  }
  return re;
}

/** @returns {boolean} false for invalid, too long or too slow patterns (never throws). */
export function safeRegexTest(pattern, input, flags = 'i') {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN) return false;
  try {
    sandbox.re = compile(pattern, flags);
    sandbox.s = String(input).slice(0, MAX_INPUT);
    return Boolean(script.runInContext(sandbox, { timeout: REGEX_TIMEOUT_MS }));
  } catch {
    return false;
  } finally {
    sandbox.re = null;
    sandbox.s = '';
  }
}
