// Every policy limit defaults to UNLIMITED (Infinity). The bot operator can cap any of them with a LIMIT_* variable
// (see server/config.js); the editor receives the effective values from /api/me so both sides agree.
//
// Not limits, but physical ceilings that always remain: Discord's own API rules, process memory, the HTTP body
// ceiling (LIMIT_REQUEST_BYTES), setTimeout's ~24.8 day maximum, and modalWaitMs (Discord interaction tokens live 15 min).

export const LIMIT_KEYS = [
  'flowsPerGuild', 'nodesPerFlow', 'edgesPerFlow', 'nodeDataBytes', 'graphBytes', 'varsPerGuild', 'varValueBytes',
  'runsPer10s', 'concurrentRuns', 'actionsPer10s', 'stepsPerRun', 'loopIterations', 'waitSeconds',
];

/** The live limits object. Mutated in place by applyLimits(), so every importer always sees current values. */
export const LIMITS = { ...Object.fromEntries(LIMIT_KEYS.map((k) => [k, Infinity])), modalWaitMs: 10 * 60 * 1000 };

const UNLIMITED = new Set(['unlimited', 'off', 'none', 'infinity', 'inf', 'no', '0']);

/**
 * Turn a number / string / null into a limit.
 * @returns {number|undefined} Infinity (unlimited), a positive integer, `undefined` (not set) or NaN (invalid)
 */
export function parseLimit(value) {
  if (value === undefined) return undefined;
  if (value === null) return Infinity;
  if (typeof value === 'number') {
    if (Number.isNaN(value) || value < 0) return Number.NaN;
    return value === 0 || !Number.isFinite(value) ? Infinity : Math.floor(value);
  }
  const s = String(value).trim().toLowerCase();
  if (s === '') return undefined;
  if (UNLIMITED.has(s)) return Infinity;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

/** Apply overrides (unknown keys are ignored). Throws on an invalid value. */
export function applyLimits(overrides = {}) {
  for (const key of LIMIT_KEYS) {
    if (!(key in overrides)) continue;
    const parsed = parseLimit(overrides[key]);
    if (parsed === undefined) continue;
    if (Number.isNaN(parsed)) throw new Error(`Invalid value for limit "${key}": ${overrides[key]}`);
    LIMITS[key] = parsed;
  }
  return LIMITS;
}

export function resetLimits() {
  for (const key of LIMIT_KEYS) LIMITS[key] = Infinity;
}

/** JSON cannot carry Infinity, so unlimited travels as null. */
export function limitsToJSON() {
  return { ...Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number.isFinite(LIMITS[k]) ? LIMITS[k] : null])), modalWaitMs: LIMITS.modalWaitMs };
}

export const isCapped = (v) => Number.isFinite(v);
